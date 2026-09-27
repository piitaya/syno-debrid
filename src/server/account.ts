import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { MIN_PASSWORD_LENGTH } from '../shared/types.js';
import { HttpError } from './errors.js';
import type { JsonFile } from './storage.js';

/** The app's own account: a single one, created on the first start (see /api/setup). */
export interface StoredAccount {
  username: string;
  /** `scrypt$N$r$p$salt$hash`, salt and hash in base64. */
  passwordHash: string;
}

const MAX_PASSWORD_LENGTH = 256;
const MAX_USERNAME_LENGTH = 64;

const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Memory needed: 128 × N × r bytes (32 MB), above Node's default limit.
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join(
    '$',
  );
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The username as typed, trimmed; throws when it cannot be one. */
export function parseUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!username || username.length > MAX_USERNAME_LENGTH || CONTROL_CHARACTERS.test(username)) {
    throw new HttpError(400, 'invalid_request', 'username');
  }
  return username;
}

/** A new password; throws when it is too short (or absurdly long). */
export function parseNewPassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, 'weak_password');
  if (password.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'invalid_request');
  return password;
}

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The account that signs in to the app. Deleting `account.json` (then restarting) resets it: the
 * app asks for a new one.
 */
export class Account {
  constructor(private readonly file: JsonFile<StoredAccount | null>) {}

  get exists(): boolean {
    return this.file.data !== null;
  }

  get username(): string | null {
    return this.file.data?.username ?? null;
  }

  async create(username: string, password: string): Promise<void> {
    if (this.file.data) throw new HttpError(403, 'forbidden');
    this.write({ username, passwordHash: await hashPassword(password) });
  }

  /** Whether the username and password are the account's; a wrong username takes as long. */
  async check(username: string, password: string): Promise<boolean> {
    return (await this.checkPassword(password)) && sameUser(username, this.username ?? '');
  }

  async checkPassword(password: string): Promise<boolean> {
    return !!this.file.data && verifyPassword(password, this.file.data.passwordHash);
  }

  async setPassword(password: string): Promise<void> {
    if (!this.file.data) throw new HttpError(401, 'unauthorized');
    this.write({ ...this.file.data, passwordHash: await hashPassword(password) });
  }

  private write(account: StoredAccount): void {
    this.file.data = account;
    // Written at once: nothing left to write on shutdown, when account.json may have been
    // deleted to reset the account.
    this.file.flush();
  }
}
