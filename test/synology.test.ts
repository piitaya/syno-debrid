import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/server/errors.js';
import { SynologyClient, toTask } from '../src/server/nas/synology.js';
import { NasSessionError } from '../src/server/nas/types.js';
import { createMockDsm } from './mocks/synology.js';
import { listen } from './serve.js';

const dsm = createMockDsm({
  users: {
    admin: { password: 'secret pass' },
    bob: { password: 'bob', otp: '123456' },
    eve: { password: 'eve', fileStation: false },
  },
  folders: ['/video', '/video/Séries', '/music'],
});
let server: Awaited<ReturnType<typeof listen>>;
let client: SynologyClient;

beforeAll(async () => {
  server = await listen(dsm.app);
  client = new SynologyClient(server.url, false);
});
afterAll(() => server.close());

const errorCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : String(error);
  }
  return 'no error';
};

describe('SynologyClient', () => {
  it('logs in (passwords with spaces)', async () => {
    const result = await client.login({ account: 'admin', password: 'secret pass' });
    expect(result.sid).toMatch(/^sid-/);
    await client.checkSession(result.sid);
    await client.checkFileStation(result.sid);
  });

  it('tells an account without File Station', async () => {
    const { sid } = await client.login({ account: 'eve', password: 'eve' });
    expect(await errorCode(client.checkFileStation(sid))).toBe('file_station_denied');
  });

  it('asks for Download Station when it is not there', async () => {
    const login = () => client.login({ account: 'admin', password: 'secret pass' });
    dsm.state.downloadStation = false;
    try {
      expect(await errorCode(login())).toBe('download_station_unavailable');
    } finally {
      dsm.state.downloadStation = true;
    }
    // Installed since: the next login sees it, without restarting the app.
    expect((await login()).sid).toBeTruthy();
  });

  it('maps login errors', async () => {
    expect(await errorCode(client.login({ account: 'admin', password: 'nope' }))).toBe(
      'invalid_credentials',
    );
    expect(await errorCode(client.login({ account: 'bob', password: 'bob' }))).toBe('otp_required');
    expect(
      await errorCode(client.login({ account: 'bob', password: 'bob', otpCode: '000000' })),
    ).toBe('otp_invalid');
  });

  it('remembers 2FA devices', async () => {
    const first = await client.login({ account: 'bob', password: 'bob', otpCode: '123456' });
    expect(first.deviceId).toBeTruthy();
    const second = await client.login({
      account: 'bob',
      password: 'bob',
      deviceId: first.deviceId!,
    });
    expect(second.sid).toBeTruthy();
  });

  it('browses and creates folders with accents and spaces', async () => {
    const { sid } = await client.login({ account: 'admin', password: 'secret pass' });
    expect(await client.listShares(sid)).toEqual([
      { name: 'music', path: 'music' },
      { name: 'video', path: 'video' },
    ]);
    await client.createFolders(sid, [
      'video/Séries/Mon Show S01/Subs',
      'video/Séries/Mon Show S01',
    ]);
    expect(await client.listFolders(sid, 'video/Séries')).toEqual([
      { name: 'Mon Show S01', path: 'video/Séries/Mon Show S01' },
    ]);
    expect(await client.listFolders(sid, 'video/Séries/Mon Show S01')).toEqual([
      { name: 'Subs', path: 'video/Séries/Mon Show S01/Subs' },
    ]);
  });

  it('creates, lists and deletes download tasks', async () => {
    const { sid } = await client.login({ account: 'admin', password: 'secret pass' });
    const create = (url: string) => client.createDownloadTask(sid, url, 'video/Séries');
    const first = await create('https://cdn.example/a,b.mkv?size=100');
    const second = await create('https://cdn.example/c.mkv?size=100');
    expect([first, second].every((id) => id?.startsWith('dbid_'))).toBe(true);

    const tasks = await client.listTasks(sid);
    expect(tasks.map((task) => task.id).sort()).toEqual([first, second].sort());
    expect(tasks.find((task) => task.id === first)!.uri).toContain('a%2Cb.mkv');

    await client.deleteTasks(sid, [first!]);
    expect((await client.listTasks(sid)).map((task) => task.id)).toEqual([second]);
  });

  it('reports a missing destination', async () => {
    const { sid } = await client.login({ account: 'admin', password: 'secret pass' });
    expect(await errorCode(client.createDownloadTask(sid, 'https://x/y.mkv', 'video/Nope'))).toBe(
      'destination_missing',
    );
  });

  it('detects expired sessions', async () => {
    const { sid } = await client.login({ account: 'admin', password: 'secret pass' });
    dsm.expireSessions();
    await expect(client.checkSession(sid)).rejects.toBeInstanceOf(NasSessionError);
    await expect(client.listShares(sid)).rejects.toBeInstanceOf(NasSessionError);
  });
});

describe('toTask', () => {
  it('reads legacy tasks', () => {
    expect(
      toTask({
        id: 'dbid_1',
        status: 'error',
        size: '100',
        status_extra: { error_detail: 'broken_link' },
        additional: { transfer: { size_downloaded: '10', speed_download: 0 } },
      }),
    ).toMatchObject({
      id: 'dbid_1',
      status: 'error',
      error: 'broken_link',
      size: 100,
      downloaded: 10,
    });
  });
});
