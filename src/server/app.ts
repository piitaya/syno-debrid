import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { extractMagnets } from '../shared/magnet.js';
import { parseTorrent, TorrentParseError } from '../shared/torrent.js';
import {
  isProviderId,
  type AddJobResult,
  type AddJobsResponse,
  type ErrorCode,
  type FolderListing,
  type NasSaveResult,
  type Outcome,
  type ProviderTestResult,
  type SessionInfo,
  type SessionStatus,
} from '../shared/types.js';
import { parseNewPassword, parseUsername, type Account } from './account.js';
import { configuredProvider, createProvider } from './debrid/index.js';
import type { Env } from './env.js';
import { AppError, HttpError, toErrorInfo } from './errors.js';
import type { EventHub } from './events.js';
import type { JobManager } from './jobs.js';
import { log } from './logger.js';
import { NasLoginError, normalizeNasUrl, type NasConnection } from './nas-connection.js';
import { joinPath, sanitizeSegment } from './paths.js';
import type { RateLimiter } from './rate-limit.js';
import type { Sessions } from './sessions.js';
import { normalizeDestination, type Settings } from './settings.js';

export interface AppDeps {
  env: Env;
  settings: Settings;
  account: Account;
  sessions: Sessions;
  nas: NasConnection;
  jobs: JobManager;
  events: EventHub;
  /** Failed sign-ins and password checks, per client IP. */
  loginLimiter: RateLimiter;
  /**
   * Failed DSM logins when setting up Download Station, from anywhere: DSM blocks the
   * container's IP after 10 of them in 5 minutes.
   */
  nasLoginLimiter: RateLimiter;
}

type Vars = { token: string };
type Ctx = Context<{ Variables: Vars }>;

const SESSION_COOKIE = 'dds_session';
const MAX_TORRENT_SIZE = 10 * 1024 * 1024;

/** Status of the errors the routes let through (the others are HttpErrors, or 502). */
const STATUS_BY_CODE: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  not_found: 404,
  provider_not_configured: 400,
  nas_session_expired: 503,
  download_station_unavailable: 503,
};

/** DSM logins that DSM counts as failed (toward blocking the IP). */
const FAILED_NAS_LOGINS: ReadonlySet<ErrorCode> = new Set(['invalid_credentials', 'otp_invalid']);

/** Body of a new Download Station connection; throws when a field is missing. */
function parseNasUpdate(value: unknown) {
  const body = (value ?? {}) as Record<string, unknown>;
  const url = typeof body.url === 'string' ? normalizeNasUrl(body.url) : null;
  const account = typeof body.account === 'string' ? body.account.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const otp = typeof body.otp === 'string' ? body.otp.replace(/\s/g, '') : '';
  if (!url || !account || !password) throw new HttpError(400, 'invalid_request');
  return {
    url,
    account,
    password,
    insecureTls: body.insecureTls === true,
    ...(otp ? { otp } : {}),
  };
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const { env, settings, account, sessions, nas, jobs, events } = deps;
  /** AUTH=none: a reverse proxy authenticates every request, the app asks for nothing. */
  const signIn = env.auth === 'password';

  const app = new Hono<{ Variables: Vars }>();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
      // Keep referrers out of the debrid sites opened from the settings.
      referrerPolicy: 'no-referrer',
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.toInfo() }, error.status);
    if (error instanceof NasLoginError) {
      // What DSM said shows in Settings → Download Station.
      const code = error.code === 'nas_not_configured' ? error.code : 'nas_login_failed';
      return c.json({ error: { code } }, 503);
    }
    if (error instanceof AppError) {
      return c.json({ error: error.toInfo() }, STATUS_BY_CODE[error.code] ?? 502);
    }
    log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, error);
    return c.json({ error: { code: 'internal' } }, 500);
  });

  const isHttps = (c: Ctx) =>
    new URL(c.req.url).protocol === 'https:' ||
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';

  const clientIp = (c: Ctx): string => {
    if (env.trustProxy) {
      // The proxy adds the address it sees at the end: the ones before come from the client.
      const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const sessionInfo = (): SessionInfo => ({
    username: signIn ? (account.username ?? '') : null,
    version: env.version,
  });

  /** Routes of the app's account, when it has one. */
  const requireSignIn: MiddlewareHandler<{ Variables: Vars }> = async (_c, next) => {
    if (!signIn) throw new HttpError(404, 'not_found');
    await next();
  };

  /** Signs this browser in. */
  const startSession = (c: Ctx): void => {
    setSessionCookie(c, sessions.create());
  };

  /** Also sent again each time the app opens: the browser keeps it as long as the session. */
  const setSessionCookie = (c: Ctx, token: string): void => {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c),
      path: '/',
      maxAge: env.sessionTtlDays * 24 * 3600,
    });
  };

  const body = async (c: Ctx) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  let settingUp = false;

  const api = new Hono<{ Variables: Vars }>();

  // Mutating requests must come from the app itself (a cross-site form cannot set this header).
  api.use('*', async (c, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.req.header('x-requested-with') !== 'dds'
    ) {
      throw new HttpError(403, 'forbidden', 'Missing X-Requested-With header');
    }
    await next();
  });

  // Requests are small JSON documents, except for the .torrent files of POST /jobs.
  const smallBody = bodyLimit({
    maxSize: 64 * 1024,
    onError: () => {
      throw new HttpError(413, 'invalid_request', 'Request too large');
    },
  });
  api.use('*', (c, next) =>
    c.req.method === 'POST' && c.req.path === '/api/jobs' ? next() : smallBody(c, next),
  );

  const requireSession: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    if (!signIn) return next();
    const token = getCookie(c, SESSION_COOKIE);
    // No account (first start, or reset): no session counts.
    if (!token || !account.exists || !sessions.isValid(token)) {
      throw new HttpError(401, 'unauthorized');
    }
    c.set('token', token);
    await next();
  };

  api.get('/health', (c) => c.json({ status: 'ok', version: env.version }));

  // Being signed out is an answer, not an error (see SessionStatus).
  api.get('/session', (c) => {
    if (!signIn) return c.json({ session: sessionInfo() } satisfies SessionStatus);
    if (!account.exists) {
      return c.json({ session: null, reason: 'setup_required' } satisfies SessionStatus);
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ session: null } satisfies SessionStatus);
    if (!sessions.isValid(token)) {
      // A cookie left by a session that is over: said once, then forgotten.
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ session: null, reason: 'unauthorized' } satisfies SessionStatus);
    }
    setSessionCookie(c, token);
    return c.json({ session: sessionInfo() } satisfies SessionStatus);
  });

  /** First start (or after account.json was deleted): creates the account. */
  api.post('/setup', requireSignIn, async (c) => {
    if (account.exists || settingUp) throw new HttpError(403, 'forbidden');
    const input = await body(c);
    const username = parseUsername(input.username);
    const password = parseNewPassword(input.password);
    settingUp = true;
    try {
      await account.create(username, password);
    } finally {
      settingUp = false;
    }
    // Sessions of a previous account are over.
    sessions.clear();
    startSession(c);
    log.info(`Account "${username}" created`);
    return c.json({ session: sessionInfo() } satisfies SessionStatus);
  });

  api.post('/login', requireSignIn, async (c) => {
    if (!account.exists) {
      return c.json({ session: null, reason: 'setup_required' } satisfies SessionStatus);
    }
    const input = await body(c);
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!username || !password) throw new HttpError(400, 'invalid_request');

    const ip = clientIp(c);
    if (!deps.loginLimiter.attempt(ip)) throw new HttpError(429, 'too_many_attempts');
    if (!(await account.check(username, password))) {
      log.warn(`Failed sign-in from ${ip}`);
      throw new HttpError(401, 'invalid_credentials');
    }
    deps.loginLimiter.reset(ip);
    startSession(c);
    return c.json({ session: sessionInfo() } satisfies SessionStatus);
  });

  api.post('/logout', requireSignIn, requireSession, (c) => {
    sessions.delete(c.get('token'));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  api.post('/account/password', requireSignIn, requireSession, async (c) => {
    const input = await body(c);
    const password = parseNewPassword(input.password);
    const ip = clientIp(c);
    if (!deps.loginLimiter.attempt(ip)) throw new HttpError(429, 'too_many_attempts');
    if (!(await account.checkPassword(typeof input.current === 'string' ? input.current : ''))) {
      return c.json({ ok: false, error: { code: 'wrong_password' } } satisfies Outcome);
    }
    deps.loginLimiter.reset(ip);
    await account.setPassword(password);
    // Every other device is signed out; this one gets a new session.
    sessions.clear();
    startSession(c);
    log.info('Password changed');
    return c.json({ ok: true } satisfies Outcome);
  });

  api.get('/settings', requireSession, (c) => c.json(settings.toPublic()));

  api.put('/settings', requireSession, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_request');
    return c.json(settings.update(body));
  });

  // Checks the connection to Download Station (logging in again if need be).
  api.post('/nas/test', requireSession, async (c) => {
    try {
      await nas.test();
      return c.json({ ok: true } satisfies Outcome);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return c.json({ ok: false, error: error.toInfo() } satisfies Outcome);
    }
  });

  // A new connection is tried before it is saved. DSM refusing it is an expected outcome, not
  // an error; failed logins are counted, as DSM counts them.
  api.put('/nas', requireSession, async (c) => {
    const update = parseNasUpdate(await body(c));
    if (deps.nasLoginLimiter.isBlocked('*')) throw new HttpError(429, 'too_many_attempts');
    try {
      await nas.configure(update);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (FAILED_NAS_LOGINS.has(error.code)) deps.nasLoginLimiter.fail('*');
      return c.json({ ok: false, error: error.toInfo() } satisfies NasSaveResult);
    }
    // Downloads waiting for Download Station go on.
    jobs.resume();
    return c.json({ ok: true, settings: settings.toPublic() } satisfies NasSaveResult);
  });

  api.post('/providers/:id/test', requireSession, async (c) => {
    const id = c.req.param('id');
    if (!isProviderId(id)) throw new HttpError(404, 'not_found');
    const input = await body(c);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    // A refused key (or a service out of reach) is what the test found, not a failed request.
    let result: ProviderTestResult;
    try {
      const provider = apiKey
        ? createProvider(id, apiKey, env)
        : configuredProvider(id, settings, env);
      result = { ok: true, account: await provider.account() };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result = { ok: false, error: error.toInfo() };
    }
    return c.json(result);
  });

  api.get('/folders', requireSession, async (c) => {
    const raw = c.req.query('path');
    const path = raw ? normalizeDestination(raw) : null;
    if (raw && !path) throw new HttpError(400, 'invalid_request');
    try {
      const folders = await nas.run((client, sid) =>
        path ? client.listFolders(sid, path) : client.listShares(sid),
      );
      return c.json({ path, exists: true, folders } satisfies FolderListing);
    } catch (error) {
      // A folder that does not exist is an answer: the app offers to create it.
      if (!(error instanceof AppError) || error.code !== 'destination_missing') throw error;
      return c.json({ path, exists: false, folders: [] } satisfies FolderListing);
    }
  });

  api.post('/folders', requireSession, async (c) => {
    const input = await body(c);
    const parent = typeof input.path === 'string' ? normalizeDestination(input.path) : null;
    const name = typeof input.name === 'string' ? sanitizeSegment(input.name) : '';
    if (!parent || !name) throw new HttpError(400, 'invalid_request');
    const path = joinPath(parent, name);
    await nas.run((client, sid) => client.createFolders(sid, [path]));
    return c.json({ name, path });
  });

  api.post(
    '/jobs',
    requireSession,
    bodyLimit({
      maxSize: 25 * 1024 * 1024,
      onError: () => {
        throw new HttpError(413, 'torrent_invalid', 'Request too large');
      },
    }),
    async (c) => {
      const form = await c.req.parseBody({ all: true });
      const values = (key: string) => {
        const value = form[key];
        return value === undefined ? [] : Array.isArray(value) ? value : [value];
      };
      const providerId = form.provider;
      if (!isProviderId(providerId)) throw new HttpError(400, 'invalid_request', 'provider');
      const provider = configuredProvider(providerId, settings, env);
      const category =
        typeof form.categoryId === 'string' ? settings.category(form.categoryId) : null;
      if (!category) throw new HttpError(400, 'category_missing');
      const magnetInputs = values('magnets').filter((v): v is string => typeof v === 'string');
      const torrentFiles = values('torrents').filter((v): v is File => v instanceof File);
      if (!magnetInputs.length && !torrentFiles.length) {
        throw new HttpError(400, 'invalid_request', 'Nothing to add');
      }

      const results: AddJobResult[] = [];
      const addJob = (debridId: string, name: string) =>
        jobs.toView(jobs.create({ provider: providerId, debridId, name, category }));

      for (const input of magnetInputs) {
        const { magnets, invalid } = extractMagnets(input);
        for (const token of invalid) {
          results.push({ ok: false, input: token, error: { code: 'magnet_invalid' } });
        }
        for (const magnet of magnets) {
          try {
            const added = await provider.addMagnet(magnet.uri);
            const name = magnet.name ?? added.name ?? magnet.hash;
            results.push({ ok: true, job: addJob(added.id, name) });
          } catch (error) {
            results.push({ ok: false, input: magnet.uri, error: toErrorInfo(error) });
          }
        }
      }

      for (const file of torrentFiles) {
        try {
          if (file.size > MAX_TORRENT_SIZE) throw new AppError('torrent_invalid', 'File too large');
          const data = new Uint8Array(await file.arrayBuffer());
          let name: string;
          try {
            name = parseTorrent(data).name;
          } catch (error) {
            if (error instanceof TorrentParseError) throw new AppError('torrent_invalid');
            throw error;
          }
          const added = await provider.addTorrent(data, file.name || `${name}.torrent`);
          results.push({ ok: true, job: addJob(added.id, added.name ?? name) });
        } catch (error) {
          results.push({ ok: false, input: file.name, error: toErrorInfo(error) });
        }
      }

      const added = results.filter((result) => result.ok).length;
      if (added) log.info(`Added ${added} torrent(s) to ${providerId}`);
      return c.json({ results } satisfies AddJobsResponse);
    },
  );

  api.post('/jobs/clear', requireSession, (c) => {
    jobs.clearFinished();
    return c.body(null, 204);
  });

  api.post('/jobs/:id/retry', requireSession, (c) => {
    const job = jobs.retry(c.req.param('id'));
    return c.json(jobs.toView(job));
  });

  api.delete('/jobs/:id', requireSession, async (c) => {
    await jobs.remove(c.req.param('id'), c.req.query('cancel') === '1');
    return c.body(null, 204);
  });

  api.get('/events', requireSession, (c) => {
    // Tell reverse proxies (nginx on DSM) not to buffer the stream.
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (!closed) void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      send('snapshot', { jobs: jobs.list().map((job) => jobs.toView(job)) });
      const unsubscribe = events.subscribe(send);
      const ping = setInterval(() => {
        if (!closed) void stream.write(': ping\n\n');
      }, 20_000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          closed = true;
          unsubscribe();
          clearInterval(ping);
          resolve();
        });
      });
    });
  });

  api.all('*', () => {
    throw new HttpError(404, 'not_found');
  });

  app.route('/api', api);

  // Web app: hashed assets are immutable, everything else must be revalidated.
  app.use(
    '/*',
    serveStatic({
      root: env.webRoot,
      // The app's pages (see src/web/components/app.ts) are all the same document.
      rewriteRequestPath: (path) => (path === '/settings' ? '/index.html' : path),
      onFound: (path, c) => {
        c.header(
          'Cache-Control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );

  return app;
}
