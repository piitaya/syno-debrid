import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, type StoredAccount } from '../src/server/account.js';
import { createApp } from '../src/server/app.js';
import { createProvider, Providers } from '../src/server/debrid/index.js';
import { loadEnv } from '../src/server/env.js';
import { EventHub } from '../src/server/events.js';
import { JobManager, type JobsFile } from '../src/server/jobs.js';
import { NasConnection } from '../src/server/nas-connection.js';
import { SynologyClient } from '../src/server/nas/synology.js';
import { RateLimiter } from '../src/server/rate-limit.js';
import { Sessions, type SessionMap } from '../src/server/sessions.js';
import { defaultSettings, Settings, type StoredSettings } from '../src/server/settings.js';
import { JsonFile } from '../src/server/storage.js';
import type { AddJobsResponse, AppSettings, JobView } from '../src/shared/types.js';
import { makeTorrent } from './helpers.js';
import { createMockServer } from './mocks/server.js';
import { listen } from './serve.js';

const mock = createMockServer({ speed: 4 * 1024 * 1024 * 1024 });
let server: Awaited<ReturnType<typeof listen>>;
let app: ReturnType<typeof createApp>;
let jobs: JobManager;
let accountFile: JsonFile<StoredAccount | null>;

/** The app, on a new data folder, with these environment variables. */
function build(variables: Record<string, string> = {}, loginAttempts = 20) {
  const dir = mkdtempSync(join(tmpdir(), 'dds-api-'));
  const env = loadEnv({
    ALLDEBRID_API_URL: `${server.url}/alldebrid`,
    DATA_DIR: dir,
    ...variables,
  });
  const settings = new Settings(
    new JsonFile<StoredSettings>(join(dir, 's.json'), defaultSettings),
    env,
  );
  const accountFile = new JsonFile<StoredAccount | null>(join(dir, 'a.json'), () => null);
  const account = new Account(accountFile);
  const sessions = new Sessions(
    new JsonFile<SessionMap>(join(dir, 'x.json'), () => ({})),
    86_400_000,
  );
  const events = new EventHub();
  const providers = new Providers(settings, env);
  const nas = new NasConnection(
    settings,
    randomBytes(32),
    (url, insecureTls) => new SynologyClient({ baseUrl: url, insecureTls }),
  );
  const jobs = new JobManager({
    file: new JsonFile<JobsFile>(join(dir, 'j.json'), () => ({ jobs: [] })),
    nas,
    events,
    provider: (id) => providers.get(id),
    options: () => ({ createSubfolder: settings.createSubfolder, deleteFromDebrid: false }),
  });
  const app = createApp({
    env,
    settings,
    account,
    sessions,
    nas,
    jobs,
    events,
    provider: (id) => providers.get(id),
    providerWithKey: (id, key) => createProvider(id, key, env),
    loginLimiter: new RateLimiter(loginAttempts, 60_000),
    nasLoginLimiter: new RateLimiter(20, 60_000),
  });
  return { app, jobs, accountFile };
}

beforeAll(async () => {
  server = await listen(mock.app);
  ({ app, jobs, accountFile } = build());
});
afterAll(() => server.close());

/** A tiny cookie-keeping client. */
function client(target?: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>();
  return async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const init: RequestInit = {
      method,
      headers: {
        'X-Requested-With': 'dds',
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body !== undefined && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    };
    const response = await (target ?? app).request(`http://app.test/api/${path}`, init);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, ...value] = pair!.split('=');
      jar.set(name!, value.join('='));
    }
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, jar };
  };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) {
    for (const job of jobs.list()) job.nextCheckAt = 0;
    await jobs.tick();
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/** DSM login of the mock NAS used by the app (2FA: code 123456). */
const nasLogin = () => ({
  url: server.url,
  account: 'secure',
  password: 'secure',
  insecureTls: false,
});
let password = 'first password';

/** A client signed in to the app. */
async function signedIn() {
  const api = client();
  expect((await api('POST', 'login', { username: 'paul', password })).status).toBe(200);
  return api;
}

const dsmLogins = () => mock.dsm.state.calls.filter((call) => call === 'SYNO.API.Auth.login');

describe('HTTP API', () => {
  it('asks for the setup on the first start', async () => {
    const api = client();
    // Being signed out is an answer (not a failed request in the browser).
    expect(await api('GET', 'session')).toMatchObject({
      status: 200,
      data: { session: null, reason: 'setup_required' },
    });
    expect((await api('POST', 'login', { username: 'paul', password: 'x' })).data).toEqual({
      session: null,
      reason: 'setup_required',
    });
    expect((await api('GET', 'settings')).status).toBe(401);
    expect((await api('GET', 'health')).data).toMatchObject({ status: 'ok' });
    const noHeader = await app.request('http://app.test/api/setup', {
      method: 'POST',
      body: JSON.stringify({ username: 'paul', password }),
    });
    expect(noHeader.status).toBe(403);
  });

  it('creates the account, then Download Station is connected from Settings', async () => {
    const api = client();
    const setup = (body: object) => api('POST', 'setup', { username: 'Paul', password, ...body });

    expect(await setup({ password: 'short' })).toMatchObject({
      status: 400,
      data: { error: { code: 'weak_password' } },
    });
    expect((await setup({})).data).toMatchObject({ session: { username: 'Paul' } });
    expect((await api('GET', 'session')).data.session.username).toBe('Paul');
    // Only once.
    expect((await setup({})).status).toBe(403);

    // Download Station: listed as missing on the downloads screen until it is connected.
    expect((await api('GET', 'settings')).data.nas).toBeNull();
    expect((await api('GET', 'folders')).data.error.code).toBe('nas_not_configured');
    // What DSM says is an answer.
    expect(await api('PUT', 'nas', { ...nasLogin(), password: 'nope' })).toMatchObject({
      status: 200,
      data: { ok: false, error: { code: 'invalid_credentials' } },
    });
    expect((await api('PUT', 'nas', nasLogin())).data).toMatchObject({
      ok: false,
      error: { code: 'otp_required' },
    });
    const saved = await api('PUT', 'nas', { ...nasLogin(), otp: '123 456' });
    expect(saved.data.settings.nas).toEqual({
      url: server.url,
      account: 'secure',
      insecureTls: false,
    });
    expect((await api('GET', 'folders')).status).toBe(200);
  });

  it('signs in and out with the account', async () => {
    const api = client();
    const wrong = await api('POST', 'login', { username: 'paul', password: 'nope' });
    expect(wrong).toMatchObject({ status: 401, data: { error: { code: 'invalid_credentials' } } });
    expect((await api('POST', 'login', { username: 'marie', password })).status).toBe(401);

    expect((await api('POST', 'login', { username: 'PAUL', password })).data).toMatchObject({
      session: { username: 'Paul' },
    });
    await api('POST', 'logout');
    expect((await api('GET', 'session')).data).toEqual({ session: null });
  });

  it('keeps the session cookie as long as the app is opened', async () => {
    const api = await signedIn();
    const token = (await api('GET', 'health')).jar.get('dds_session');
    // The app asks for the session each time it opens: the cookie gets its full life again.
    const opened = await app.request('http://app.test/api/session', {
      headers: { Cookie: `dds_session=${token}` },
    });
    const cookie = opened.headers.getSetCookie().find((c) => c.startsWith('dds_session='));
    expect(cookie).toContain(`dds_session=${token}`);
    expect(cookie).toContain(`Max-Age=${30 * 24 * 3600}`);
  });

  it('says when a session is over, once', async () => {
    const api = client();
    const ended = await api('GET', 'session', undefined, { Cookie: 'dds_session=forgotten' });
    expect(ended.data).toEqual({ session: null, reason: 'unauthorized' });
    // The cookie is cleared: the next visit is a plain signed-out one.
    expect(ended.jar.get('dds_session')).toBe('');
  });

  it('changes the password and signs out the other devices', async () => {
    const phone = await signedIn();
    const laptop = await signedIn();
    expect(
      (await phone('POST', 'account/password', { current: 'nope', password: 'new password' })).data,
    ).toEqual({ ok: false, error: { code: 'wrong_password' } });
    expect(
      (await phone('POST', 'account/password', { current: password, password: 'new' })).data.error
        .code,
    ).toBe('weak_password');

    const changed = await phone('POST', 'account/password', {
      current: password,
      password: 'new password',
    });
    expect(changed.data).toEqual({ ok: true });
    password = 'new password';
    expect((await phone('GET', 'settings')).status).toBe(200);
    expect((await laptop('GET', 'settings')).status).toBe(401);
    await signedIn();
  });

  it('takes a magnet and a .torrent file to Download Station', async () => {
    const api = await signedIn();

    // Settings: an API key, a category picked from the NAS folders.
    const shares = await api('GET', 'folders');
    expect(shares.data.folders.map((f: { name: string }) => f.name)).toContain('video');
    const sub = await api('GET', `folders?path=${encodeURIComponent('video')}`);
    expect(sub.data.exists).toBe(true);
    expect(sub.data.folders).toContainEqual({ name: 'Séries', path: 'video/Séries' });
    // A folder that does not exist is an answer, so that the app can offer to create it.
    const missing = await api('GET', `folders?path=${encodeURIComponent('video/Filmz')}`);
    expect(missing).toMatchObject({
      status: 200,
      data: { path: 'video/Filmz', exists: false, folders: [] },
    });
    const test = await api('POST', 'providers/alldebrid/test', { apiKey: 'new-key' });
    expect(test.data).toMatchObject({ ok: true, account: { username: 'demo-alldebrid' } });
    // So is a refused key.
    const refused = await api('POST', 'providers/alldebrid/test', { apiKey: 'bad' });
    expect(refused).toMatchObject({
      status: 200,
      data: { ok: false, error: { code: 'provider_auth' } },
    });
    const saved = await api('PUT', 'settings', {
      apiKeys: { alldebrid: 'new-key' },
      categories: [
        { name: 'Séries', icon: 'tv', destination: '/video/Séries/' },
        { name: 'Films', icon: 'movie', destination: 'video/Films' },
      ],
    });
    const settings = saved.data as AppSettings;
    expect(settings.categories.map((c) => c.destination)).toEqual(['video/Séries', 'video/Films']);
    expect(settings.providers).toEqual([{ id: 'alldebrid', configured: true, fromEnv: false }]);
    const [series, films] = settings.categories;

    const added = await api('POST', 'jobs', {
      magnets: ['magnet:?xt=urn:btih:' + '1'.repeat(40) + '&dn=Sintel.S01.1080p.WEB\nnot-a-magnet'],
      provider: 'alldebrid',
      categoryId: series!.id,
    });
    const results = (added.data as AddJobsResponse).results;
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(results[0]).toMatchObject({ input: 'not-a-magnet', error: { code: 'magnet_invalid' } });

    const form = new FormData();
    form.set('provider', 'alldebrid');
    form.set('categoryId', films!.id);
    form.append('torrents', new Blob([makeTorrent('Big.Buck.Bunny.mkv')]), 'bbb.torrent');
    form.append('torrents', new Blob(['not a torrent']), 'oops.torrent');
    const upload = (await api('POST', 'jobs', form)).data as AddJobsResponse;
    expect(upload.results.map((r) => r.ok)).toEqual([true, false]);

    await waitFor(() => jobs.list().every((job) => job.status === 'completed'));
    const list = (await api('GET', 'jobs')).data.jobs as JobView[];
    const pack = list.find((job) => job.name.startsWith('Sintel'))!;
    const movie = list.find((job) => job.name.startsWith('Big.Buck'))!;
    expect(pack).toMatchObject({
      status: 'completed',
      destination: 'video/Séries/Sintel.S01.1080p.WEB',
      progress: 1,
    });
    expect(pack.files).toHaveLength(5);
    expect(movie).toMatchObject({ status: 'completed', destination: 'video/Films' });

    expect((await api('POST', 'jobs/clear')).status).toBe(204);
    expect((await api('GET', 'jobs')).data.jobs).toEqual([]);
  });

  it('keeps the Download Station login going', async () => {
    const api = await signedIn();
    // DSM drops its sessions after 7 days: the app logs in again, as a trusted device (2FA).
    const before = dsmLogins().length;
    mock.dsm.expireSessions();
    expect((await api('GET', 'folders')).status).toBe(200);
    expect(dsmLogins().length - before).toBe(1);
    expect((await api('POST', 'nas/test')).data).toEqual({ ok: true });
  });

  it('stops at the first login DSM refuses, until Download Station is set up again', async () => {
    const api = await signedIn();
    mock.dsm.users.secure!.password = 'changed';
    try {
      const before = dsmLogins().length;
      mock.dsm.expireSessions();
      expect(await api('GET', 'folders')).toMatchObject({
        status: 503,
        data: { error: { code: 'nas_login_failed' } },
      });
      // What DSM said, for Settings.
      expect((await api('POST', 'nas/test')).data).toMatchObject({
        ok: false,
        error: { code: 'invalid_credentials' },
      });
      // Failed logins get the container's IP blocked by DSM: the refused one is not tried again.
      expect(dsmLogins().length - before).toBe(1);
      // The app stays usable.
      expect((await api('GET', 'settings')).status).toBe(200);

      // The new password, entered in Settings. Still a trusted device: no 2FA code.
      expect(await api('PUT', 'nas', { ...nasLogin(), password: 'nope' })).toMatchObject({
        status: 200,
        data: { ok: false, error: { code: 'invalid_credentials' } },
      });
      const saved = await api('PUT', 'nas', { ...nasLogin(), password: 'changed' });
      expect(saved.data).toMatchObject({ ok: true, settings: { nas: { account: 'secure' } } });
      expect((await api('GET', 'folders')).status).toBe(200);
    } finally {
      mock.dsm.users.secure!.password = 'secure';
    }
  });

  it('checks a new Download Station login before saving it', async () => {
    const api = await signedIn();
    expect((await api('PUT', 'nas', { url: server.url, account: 'paul' })).status).toBe(400);
    mock.dsm.users.paul!.fileStation = false;
    try {
      expect(
        (await api('PUT', 'nas', { url: server.url, account: 'paul', password: 'paul' })).data,
      ).toMatchObject({ ok: false, error: { code: 'file_station_denied' } });
    } finally {
      delete mock.dsm.users.paul!.fileStation;
    }
    // Nothing changed.
    expect((await api('GET', 'settings')).data.nas.account).toBe('secure');
    const saved = await api('PUT', 'nas', {
      url: `${server.url}/`,
      account: 'paul',
      password: 'paul',
    });
    expect(saved.data.settings.nas).toEqual({
      url: server.url,
      account: 'paul',
      insecureTls: false,
    });
  });

  it('starts over once the account is reset', async () => {
    const api = await signedIn();
    const other = await signedIn();
    // account.json deleted, then the container restarted.
    accountFile.data = null;
    expect((await api('GET', 'settings')).status).toBe(401);
    expect((await api('GET', 'session')).data).toEqual({
      session: null,
      reason: 'setup_required',
    });
    const setup = await api('POST', 'setup', { username: 'someone', password: 'another password' });
    expect(setup.data).toMatchObject({ session: { username: 'someone' } });
    expect((await client()('POST', 'login', { username: 'paul', password })).status).toBe(401);
    // The devices of the previous account are signed out; the settings stay.
    expect((await other('GET', 'settings')).status).toBe(401);
    expect((await api('GET', 'settings')).data.nas.account).toBe('paul');
  });
});

describe('Environment', () => {
  it('takes an API key from the environment, read-only in the app', async () => {
    const api = client(build({ ALLDEBRID_API_KEY: 'good', AUTH: 'none' }).app);
    const saved = await api('PUT', 'settings', { apiKeys: { alldebrid: 'ignored' } });
    expect((saved.data as AppSettings).providers).toEqual([
      { id: 'alldebrid', configured: true, fromEnv: true },
    ]);
    expect((await api('POST', 'providers/alldebrid/test')).data).toMatchObject({ ok: true });
  });
});

describe('AUTH=none', () => {
  it('lets a reverse proxy authenticate', async () => {
    const built = build({ AUTH: 'none' });
    const api = client(built.app);
    expect((await api('GET', 'session')).data).toMatchObject({ session: { username: null } });
    expect((await api('GET', 'settings')).status).toBe(200);
    expect((await api('POST', 'login', { username: 'paul', password: 'x' })).status).toBe(404);
    expect((await api('POST', 'setup', { username: 'paul', password: 'long enough' })).status).toBe(
      404,
    );
    // Download Station is set up from Settings.
    expect((await api('GET', 'folders')).data.error.code).toBe('nas_not_configured');
    const saved = await api('PUT', 'nas', {
      url: server.url,
      account: 'syno-debrid',
      password: 'syno-debrid',
    });
    expect(saved.data).toMatchObject({ ok: true });
    expect((await api('GET', 'folders')).status).toBe(200);
  });
});

describe('Sign-in limit', () => {
  const wrong = { username: 'paul', password: 'not the password' };

  it('counts attempts made in parallel', async () => {
    const { app: target } = build({}, 3);
    await client(target)('POST', 'setup', { username: 'paul', password: 'long enough' });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => client(target)('POST', 'login', wrong)),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  it('keeps to the address the reverse proxy saw', async () => {
    const { app: target } = build({ TRUST_PROXY: 'true' }, 3);
    await client(target)('POST', 'setup', { username: 'paul', password: 'long enough' });
    // The first addresses come from the client: made up, one per attempt.
    const statuses: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const headers = { 'X-Forwarded-For': `10.0.0.${n}, 203.0.113.7` };
      statuses.push((await client(target)('POST', 'login', wrong, headers)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});
