import { createHash, randomBytes } from 'node:crypto';
import type { JsonFile } from './storage.js';

/** Hash of a cookie token → when its session ends (epoch milliseconds). */
export type SessionMap = Record<string, number>;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** A session in use is extended at most this often: each extension is a write. */
const TOUCH_INTERVAL = 60 * 60 * 1000;

/** Browser sessions. The cookie holds a random token; only its hash is stored on disk. */
export class Sessions {
  constructor(
    private readonly file: JsonFile<SessionMap>,
    private readonly ttlMs: number,
  ) {
    const now = Date.now();
    for (const [key, expiresAt] of Object.entries(file.data)) {
      if (!(typeof expiresAt === 'number' && expiresAt > now)) delete file.data[key];
    }
    file.save();
  }

  /** Starts a session; returns the token for the cookie. */
  create(): string {
    const token = randomBytes(32).toString('base64url');
    this.file.data[hashToken(token)] = Date.now() + this.ttlMs;
    this.file.save();
    return token;
  }

  /** Whether the token belongs to a session, which is then extended (sliding expiration). */
  isValid(token: string): boolean {
    const key = hashToken(token);
    const expiresAt = this.file.data[key];
    if (expiresAt === undefined) return false;
    const now = Date.now();
    if (expiresAt <= now) {
      delete this.file.data[key];
      this.file.save();
      return false;
    }
    if (now + this.ttlMs - expiresAt > TOUCH_INTERVAL) {
      this.file.data[key] = now + this.ttlMs;
      this.file.save();
    }
    return true;
  }

  delete(token: string): void {
    delete this.file.data[hashToken(token)];
    this.file.save();
  }

  /** Signs out every device (new account, new password). */
  clear(): void {
    this.file.data = {};
    this.file.save();
  }
}
