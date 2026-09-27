import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ErrorCode, NasUpdate } from '../shared/types.js';
import { AppError, toErrorInfo } from './errors.js';
import { log } from './logger.js';
import { SynologyClient } from './nas/synology.js';
import { NasSessionError } from './nas/types.js';
import type { Settings, StoredNas } from './settings.js';

/** What it takes to log in to DSM again. */
interface Credentials {
  password: string;
  /** "Remembered device" token: no 2FA code needed. */
  deviceId: string | null;
}

/** DSM refused the stored login: only new settings fix it (another password, 2FA…). */
const REFUSED: ReadonlySet<ErrorCode> = new Set([
  'invalid_credentials',
  'otp_required',
  'otp_invalid',
  'otp_setup_required',
  'account_disabled',
  'password_expired',
  'no_permission',
]);

/** A NAS out of reach is tried again after this delay, not at every call. */
const RETRY_MS = 60_000;

/**
 * Download Station cannot be used until its settings are fixed: DSM refused the stored login
 * (code: what DSM said), or there are no settings yet (`nas_not_configured`).
 */
export class NasLoginError extends AppError {
  constructor(code: ErrorCode, message?: string) {
    super(code, message);
    this.name = 'NasLoginError';
  }
}

/** `192.168.1.10:5000/` → `http://192.168.1.10:5000`; null when it is not an address. */
export function normalizeNasUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The app's connection to Download Station: one DSM account, set up from the app. Its password
 * is kept, encrypted, to log in again whenever DSM drops the session (after 7 days, or when it
 * restarts), so that downloads carry on without anyone.
 */
export class NasConnection {
  private client: SynologyClient | null = null;
  /** Settings the client and the session belong to. */
  private current: StoredNas | null = null;
  private sid: string | null = null;
  private loggingIn: Promise<string> | null = null;
  /** Last failed login: a NasLoginError until the settings change, others for RETRY_MS. */
  private failure: { error: AppError; at: number } | null = null;

  constructor(
    private readonly settings: Settings,
    /** AES-256 key (32 bytes) for the stored password. */
    private readonly key: Buffer,
  ) {}

  /** Runs a NAS call with the DSM session. When DSM dropped it, logs in again and retries once. */
  async run<T>(call: (client: SynologyClient, sid: string) => Promise<T>): Promise<T> {
    const sid = await this.session();
    const client = this.client!;
    try {
      return await call(client, sid);
    } catch (error) {
      if (!(error instanceof NasSessionError)) throw error;
      if (this.sid === error.sid) this.sid = null;
      return call(this.client!, await this.session());
    }
  }

  /** The DSM session id, logging in when there is none. */
  async session(): Promise<string> {
    this.sync();
    if (this.sid) return this.sid;
    this.loggingIn ??= this.logIn().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  /** Checks that Download Station answers, logging in again if need be (Settings, keep-alive). */
  async test(): Promise<void> {
    // Asked for: a NAS that was out of reach is tried again at once.
    if (this.failure && !(this.failure.error instanceof NasLoginError)) this.failure = null;
    await this.run((client, sid) => client.checkSession(sid));
  }

  /** Keeps the session alive, and logs in again after a NAS restart. Never throws. */
  async keepAlive(): Promise<void> {
    if (!this.settings.nas) return;
    await this.test().catch(() => undefined);
  }

  /**
   * Tries a new connection (a DSM login, then File Station), and keeps it when it works.
   * Throws the AppError of what failed.
   */
  async configure(update: NasUpdate): Promise<void> {
    const client = new SynologyClient(update.url, update.insecureTls);
    const previous = this.settings.nas;
    // The same account on the same NAS is still a trusted device: no new 2FA code needed.
    const trusted =
      !update.otp && previous?.url === update.url && previous.account === update.account
        ? (this.open(previous.credentials)?.deviceId ?? undefined)
        : undefined;
    const result = await client.login({
      account: update.account,
      password: update.password,
      otpCode: update.otp,
      deviceId: trusted,
    });
    try {
      await client.checkFileStation(result.sid);
    } catch (error) {
      await client.logout(result.sid).catch(() => undefined);
      throw error;
    }

    const stored: StoredNas = {
      url: update.url,
      insecureTls: update.insecureTls,
      account: update.account,
      credentials: this.seal({
        password: update.password,
        deviceId: result.deviceId ?? trusted ?? null,
      }),
    };
    const old = this.client && this.sid ? { client: this.client, sid: this.sid } : null;
    this.settings.setNas(stored);
    this.client = client;
    this.current = stored;
    this.sid = result.sid;
    this.failure = null;
    if (old) void old.client.logout(old.sid).catch(() => undefined);
    log.info(`Download Station: ${update.url}, account "${update.account}"`);
  }

  /** Follows the settings: another NAS or account means another client and session. */
  private sync(): void {
    const nas = this.settings.nas;
    if (!nas) throw new NasLoginError('nas_not_configured');
    if (nas === this.current) return;
    this.current = nas;
    this.client = new SynologyClient(nas.url, nas.insecureTls);
    this.sid = null;
    this.failure = null;
  }

  private async logIn(): Promise<string> {
    const nas = this.current!;
    const client = this.client!;
    const failure = this.failure;
    if (failure && (failure.error instanceof NasLoginError || Date.now() - failure.at < RETRY_MS)) {
      throw failure.error;
    }
    const credentials = this.open(nas.credentials);
    try {
      // Unreadable (data folder copied without its key…): the password has to be entered again.
      if (!credentials) throw new AppError('invalid_credentials', 'Stored password unreadable');
      const { sid } = await client.login({
        account: nas.account,
        password: credentials.password,
        deviceId: credentials.deviceId ?? undefined,
      });
      // Set up again meanwhile: this session belongs to the old settings.
      if (nas !== this.current) {
        void client.logout(sid).catch(() => undefined);
        return this.sid ?? this.logIn();
      }
      this.sid = sid;
      this.failure = null;
      log.info(`Logged in to DSM as "${nas.account}"`);
      return sid;
    } catch (caught) {
      let error = caught instanceof AppError ? caught : new AppError('nas_error', String(caught));
      if (REFUSED.has(error.code)) {
        // Trying again would only count as failed logins for DSM (which then blocks the IP).
        error = new NasLoginError(error.code, error.message);
        log.warn(`DSM refused the login of "${nas.account}" (${error.code}): check Settings`);
      } else {
        log.warn(`Could not log in to DSM`, toErrorInfo(error));
      }
      if (nas === this.current) this.failure = { error, at: Date.now() };
      throw error;
    }
  }

  /** Encrypts the login for storage (AES-256-GCM). */
  private seal(credentials: Credentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
  }

  private open(sealed: string): Credentials | null {
    try {
      const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv!);
      decipher.setAuthTag(tag!);
      return JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString());
    } catch {
      return null;
    }
  }
}
