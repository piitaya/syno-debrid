import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { parseMagnet } from '../../src/shared/magnet.js';
import { parseTorrent } from '../../src/shared/torrent.js';

/*
 * Fake AllDebrid API (same shapes as the real one), with simulated downloads. The torrent name drives the behaviour:
 *  - "dead"          → the service fails to fetch it
 *  - "slow"          → takes 45 seconds at the debrid service
 *  - "S01" / "pack"  → a season pack (4 episodes + subtitles)
 *  - "2160p"/"1080p" → bigger files
 */

export interface MockTorrent {
  id: string;
  hash: string;
  name: string;
  files: { path: string; size: number }[];
  multiFile: boolean;
  createdAt: number;
  /** Milliseconds before the torrent is ready. */
  duration: number;
  dead: boolean;
  deleted: boolean;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function sizeFor(name: string): number {
  if (/2160p|4k/i.test(name)) return Math.round(7.8 * GB);
  if (/1080p/i.test(name)) return Math.round(2.4 * GB);
  return 350 * MB;
}

function contentFor(name: string): Pick<MockTorrent, 'files' | 'multiFile'> {
  if (/\bS\d{2}\b|S\d{2}(?!E)|pack/i.test(name)) {
    const show = name.replace(/\.(S\d{2}).*/i, '');
    const files = [1, 2, 3, 4].map((n) => ({
      path: `${show}.S01E0${n}.1080p.WEB.mkv`,
      size: Math.round(1.1 * GB) + n * 7 * MB,
    }));
    files.push({ path: 'Subs/English.srt', size: 48_000 });
    return { files, multiFile: true };
  }
  const file = /\.(mkv|mp4|avi|iso)$/i.test(name) ? name : `${name}.mkv`;
  return { files: [{ path: file, size: sizeFor(name) }], multiFile: false };
}

export function createMockDebrid(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const torrents = new Map<string, MockTorrent>();
  let counter = 1000;

  const add = (name: string, hash: string, files?: MockTorrent['files'], multiFile?: boolean) => {
    const id = String(++counter);
    const content = files ? { files, multiFile: multiFile ?? files.length > 1 } : contentFor(name);
    const torrent: MockTorrent = {
      id,
      hash,
      name,
      ...content,
      createdAt: now(),
      duration: /slow/i.test(name) ? 45_000 : 1500,
      dead: /dead/i.test(name),
      deleted: false,
    };
    torrents.set(id, torrent);
    return torrent;
  };

  const fromMagnet = (magnet: string) => {
    const info = parseMagnet(magnet);
    if (!info) return null;
    return add(info.name ?? `noname-${info.hash.slice(0, 8)}`, info.hash);
  };

  const fromTorrentFile = async (file: File) => {
    const data = new Uint8Array(await file.arrayBuffer());
    const meta = parseTorrent(data);
    const hash = createHash('sha1').update(data).digest('hex');
    const multiFile = meta.files.length > 1 || meta.files[0]?.path !== meta.name;
    return add(meta.name, hash, meta.files, multiFile);
  };

  const progress = (torrent: MockTorrent) =>
    Math.min(1, (now() - torrent.createdAt) / Math.max(1, torrent.duration));
  /** Fetching metadata: the first half second. */
  const starting = (torrent: MockTorrent) => now() - torrent.createdAt < 500;
  const totalSize = (torrent: MockTorrent) => torrent.files.reduce((sum, f) => sum + f.size, 0);
  const origin = (c: Context) => new URL(c.req.url).origin;
  const fileName = (path: string) => path.split('/').pop()!;
  const directLink = (c: Context, torrent: MockTorrent, index: number) => {
    const file = torrent.files[index]!;
    return `${origin(c)}/cdn/${torrent.id}/${encodeURIComponent(fileName(file.path))}?size=${file.size}`;
  };
  const bearer = (c: Context) => c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const live = (id: string | undefined) => {
    const torrent = id ? torrents.get(id) : undefined;
    return torrent && !torrent.deleted ? torrent : null;
  };

  const app = new Hono().basePath('/alldebrid');
  const adOk = (c: Context, data: unknown) => c.json({ status: 'success', data });
  const adError = (c: Context, code: string, message = code) =>
    c.json({ status: 'error', error: { code, message } });

  app.use('*', async (c, next) => {
    if (bearer(c) === 'bad') return adError(c, 'AUTH_BAD_APIKEY', 'The auth apikey is invalid');
    await next();
  });
  app.post('/v4/user', (c) =>
    adOk(c, {
      user: {
        username: 'demo-alldebrid',
        isPremium: true,
        premiumUntil: Math.floor(now() / 1000) + 142 * 86400,
      },
    }),
  );
  app.post('/v4/magnet/upload', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const values = [body['magnets[]']].flat().filter((v): v is string => typeof v === 'string');
    return adOk(c, {
      magnets: values.map((magnet) => {
        const torrent = fromMagnet(magnet);
        if (!torrent)
          return { magnet, error: { code: 'MAGNET_INVALID_URI', message: 'Magnet is not valid' } };
        return {
          magnet,
          hash: torrent.hash,
          name: torrent.name,
          size: totalSize(torrent),
          ready: false,
          id: Number(torrent.id),
        };
      }),
    });
  });
  app.post('/v4/magnet/upload/file', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const files = [body['files[]']].flat().filter((v): v is File => v instanceof File);
    const results = [];
    for (const file of files) {
      try {
        const torrent = await fromTorrentFile(file);
        results.push({
          file: file.name,
          name: torrent.name,
          size: totalSize(torrent),
          hash: torrent.hash,
          ready: false,
          id: Number(torrent.id),
        });
      } catch {
        results.push({
          file: file.name,
          error: { code: 'MAGNET_INVALID_FILE', message: 'File is not a valid torrent' },
        });
      }
    }
    return adOk(c, { files: results });
  });
  app.post('/v4.1/magnet/status', async (c) => {
    const body = await c.req.parseBody();
    const torrent = live(String(body.id));
    if (!torrent) return adError(c, 'MAGNET_INVALID_ID');
    const size = totalSize(torrent);
    const p = progress(torrent);
    const base = {
      id: Number(torrent.id),
      filename: torrent.name,
      size,
      hash: torrent.hash,
      seeders: 0,
    };
    if (torrent.dead && p >= 0.5)
      return adOk(c, {
        magnets: { ...base, status: 'File not available - no peer', statusCode: 15 },
      });
    if (p >= 1)
      return adOk(c, {
        magnets: { ...base, status: 'Ready', statusCode: 4, nbLinks: torrent.files.length },
      });
    if (starting(torrent))
      return adOk(c, { magnets: { ...base, status: 'In Queue', statusCode: 0 } });
    return adOk(c, {
      magnets: {
        ...base,
        status: 'Downloading',
        statusCode: 1,
        downloaded: Math.floor(size * p),
        seeders: 23,
        downloadSpeed: 14 * MB,
      },
    });
  });
  app.post('/v4/magnet/files', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const ids = [body['id[]']].flat().map(String);
    return adOk(c, {
      magnets: ids.map((id) => {
        const torrent = live(id);
        if (!torrent) return { id, error: { code: 'MAGNET_INVALID_ID', message: 'Invalid id' } };
        // Tree nodes: { n, s, l } for files, { n, e } for folders.
        const root: { n: string; e?: unknown[] }[] = [];
        torrent.files.forEach((file, index) => {
          const parts = file.path.split('/');
          let level = root as { n: string; e?: unknown[] }[];
          for (const part of parts.slice(0, -1)) {
            let folder = level.find((node) => node.n === part && node.e);
            if (!folder) {
              folder = { n: part, e: [] };
              level.push(folder);
            }
            level = folder.e as { n: string; e?: unknown[] }[];
          }
          level.push({
            n: parts.at(-1)!,
            s: file.size,
            l: `https://alldebrid.com/f/${torrent.id}-${index}`,
          } as never);
        });
        return { id, files: torrent.multiFile ? [{ n: torrent.name, e: root }] : root };
      }),
    });
  });
  app.post('/v4/link/unlock', async (c) => {
    const body = await c.req.parseBody();
    const match = /\/f\/(\d+)-(\d+)$/.exec(String(body.link));
    const torrent = match ? live(match[1]) : null;
    if (!match || !torrent) return adError(c, 'LINK_DOWN');
    const file = torrent.files[Number(match[2])]!;
    return adOk(c, {
      link: directLink(c, torrent, Number(match[2])),
      filename: fileName(file.path),
      filesize: file.size,
    });
  });
  app.post('/v4/magnet/delete', async (c) => {
    const body = await c.req.parseBody();
    const torrent = live(String(body.id));
    if (!torrent) return adError(c, 'MAGNET_INVALID_ID');
    torrent.deleted = true;
    return adOk(c, { message: 'Magnet was successfully deleted' });
  });
  return { app, torrents };
}
