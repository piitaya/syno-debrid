import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProvider } from '../src/server/debrid/index.js';
import type { DebridProvider } from '../src/server/debrid/types.js';
import { loadEnv } from '../src/server/env.js';
import { AppError } from '../src/server/errors.js';
import { PROVIDER_IDS, type ProviderId } from '../src/shared/types.js';
import { makeTorrent } from './helpers.js';
import { createMockDebrid } from './mocks/debrid.js';
import { listen } from './serve.js';

let clock = 1_000_000_000_000;
const mock = createMockDebrid({ now: () => clock });
let server: Awaited<ReturnType<typeof listen>>;
let providers: (key?: string) => Record<ProviderId, DebridProvider>;

beforeAll(async () => {
  server = await listen(mock.app);
  const env = loadEnv({ ALLDEBRID_API_URL: `${server.url}/alldebrid` });
  providers = (key = 'good') =>
    Object.fromEntries(PROVIDER_IDS.map((id) => [id, createProvider(id, key, env)])) as Record<
      ProviderId,
      DebridProvider
    >;
});
afterAll(() => server.close());

let hashes = 0;
const nextHash = () => (++hashes).toString(16).padStart(40, '0');
const magnet = (name: string, hash = nextHash()) =>
  `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;

/** Polls until the torrent is ready. */
async function waitReady(provider: DebridProvider, id: string) {
  let status = await provider.status(id);
  for (let i = 0; i < 5 && status.state !== 'ready' && status.state !== 'error'; i++) {
    clock += 60_000;
    status = await provider.status(status.id ?? id);
  }
  return status;
}

describe.each(PROVIDER_IDS)('%s', (id) => {
  it('reads the account', async () => {
    const account = await providers()[id].account();
    expect(account.username).toMatch(/demo/);
    expect(account.premium).toBe(true);
    expect(account.premiumUntil).toBeGreaterThan(clock);
  });

  it('rejects a bad API key', async () => {
    await expect(providers('bad')[id].account()).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('downloads a season pack: status, files with paths, direct links, delete', async () => {
    const provider = providers()[id];
    const hash = nextHash();
    const added = await provider.addMagnet(magnet('Sintel.S01.1080p.WEB', hash), hash);
    expect(added.id).toBeTruthy();

    const first = await provider.status(added.id);
    expect(['queued', 'downloading']).toContain(first.state);

    clock += 30_000;
    const status = await waitReady(provider, added.id);
    expect(status.state).toBe('ready');

    const content = await provider.files(added.id);
    expect(content.multiFile).toBe(true);
    expect(content.name).toBe('Sintel.S01.1080p.WEB');
    const paths = content.files.map((file) => file.path);
    expect(paths).toContain('Sintel.S01E01.1080p.WEB.mkv');
    expect(paths).toContain('Subs/English.srt');

    const url = await provider.unlock(added.id, content.files[0]!);
    expect(url).toMatch(new RegExp(`^${server.url}/cdn/${id}/`));

    await provider.delete(added.id);
    expect(mock.torrents.get(added.id)?.deleted).toBe(true);
  });

  it('uploads a .torrent file', async () => {
    const provider = providers()[id];
    const data = makeTorrent('Big.Buck.Bunny.mkv');
    const added = await provider.addTorrent(data, 'bbb.torrent', null);
    const status = await waitReady(provider, added.id);
    expect(status.state).toBe('ready');
    const content = await provider.files(added.id);
    expect(content).toMatchObject({ multiFile: false, files: [{ path: 'Big.Buck.Bunny.mkv' }] });
  });

  it('reports dead torrents', async () => {
    const provider = providers()[id];
    const added = await provider.addMagnet(magnet('Cosmos.dead'), null);
    const status = await waitReady(provider, added.id);
    expect(status.state).toBe('error');
    expect(status.error).toBeInstanceOf(AppError);
    expect(['torrent_dead', 'torrent_failed']).toContain(status.error!.code);
  });
});

describe('alldebrid specifics', () => {
  it('maps invalid magnets', async () => {
    await expect(
      providers().alldebrid.addMagnet('magnet:?xt=urn:btih:zz', null),
    ).rejects.toMatchObject({
      code: 'magnet_invalid',
    });
  });
});
