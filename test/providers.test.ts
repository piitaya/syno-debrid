import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllDebrid } from '../src/server/debrid/alldebrid.js';
import { AppError } from '../src/server/errors.js';
import { makeTorrent } from './helpers.js';
import { createMockDebrid } from './mocks/debrid.js';
import { listen } from './serve.js';

let clock = 1_000_000_000_000;
const mock = createMockDebrid({ now: () => clock });
let server: Awaited<ReturnType<typeof listen>>;
let allDebrid: (key?: string) => AllDebrid;

beforeAll(async () => {
  server = await listen(mock.app);
  allDebrid = (key = 'good') => new AllDebrid(key, `${server.url}/alldebrid`);
});
afterAll(() => server.close());

let hashes = 0;
const magnet = (name: string) =>
  `magnet:?xt=urn:btih:${(++hashes).toString(16).padStart(40, '0')}&dn=${encodeURIComponent(name)}`;

/** Polls until the torrent is ready. */
async function waitReady(id: string) {
  let status = await allDebrid().status(id);
  for (let i = 0; i < 5 && status.state !== 'ready' && status.state !== 'error'; i++) {
    clock += 60_000;
    status = await allDebrid().status(id);
  }
  return status;
}

describe('AllDebrid', () => {
  it('reads the account', async () => {
    const account = await allDebrid().account();
    expect(account).toMatchObject({ username: 'demo-alldebrid', premium: true });
    expect(account.premiumUntil).toBeGreaterThan(clock);
  });

  it('rejects a bad API key', async () => {
    await expect(allDebrid('bad').account()).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('downloads a season pack: status, files with paths, direct links, delete', async () => {
    const provider = allDebrid();
    const added = await provider.addMagnet(magnet('Sintel.S01.1080p.WEB'));
    expect(added.id).toBeTruthy();
    expect((await provider.status(added.id)).state).toBe('queued');

    clock += 30_000;
    expect((await waitReady(added.id)).state).toBe('ready');

    const content = await provider.files(added.id);
    expect(content.multiFile).toBe(true);
    expect(content.name).toBe('Sintel.S01.1080p.WEB');
    const paths = content.files.map((file) => file.path);
    expect(paths).toContain('Sintel.S01E01.1080p.WEB.mkv');
    expect(paths).toContain('Subs/English.srt');

    const url = await provider.unlock(content.files[0]!);
    expect(url).toMatch(new RegExp(`^${server.url}/cdn/`));

    await provider.delete(added.id);
    expect(mock.torrents.get(added.id)?.deleted).toBe(true);
  });

  it('uploads a .torrent file', async () => {
    const added = await allDebrid().addTorrent(makeTorrent('Big.Buck.Bunny.mkv'), 'bbb.torrent');
    expect((await waitReady(added.id)).state).toBe('ready');
    const content = await allDebrid().files(added.id);
    expect(content).toMatchObject({ multiFile: false, files: [{ path: 'Big.Buck.Bunny.mkv' }] });
  });

  it('reports dead torrents', async () => {
    const added = await allDebrid().addMagnet(magnet('Cosmos.dead'));
    const status = await waitReady(added.id);
    expect(status.state).toBe('error');
    expect(status.error).toBeInstanceOf(AppError);
    expect(status.error!.code).toBe('torrent_dead');
  });

  it('maps invalid magnets', async () => {
    await expect(allDebrid().addMagnet('magnet:?xt=urn:btih:zz')).rejects.toMatchObject({
      code: 'magnet_invalid',
    });
  });
});
