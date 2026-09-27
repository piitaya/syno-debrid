import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

/**
 * A JSON document persisted to disk. Writes are debounced and atomic (temp file + rename) and
 * the file is only readable by its owner, as it may contain secrets.
 */
export class JsonFile<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string,
    fallback: () => T,
  ) {
    this.data = this.read(fallback);
  }

  private read(fallback: () => T): T {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      log.warn(`Unreadable JSON in ${this.path}, moved to ${backup}`);
      renameSync(this.path, backup);
      return fallback();
    }
  }

  /** Schedules a write of the current data. */
  save(): void {
    this.timer ??= setTimeout(() => {
      try {
        this.flush();
      } catch (error) {
        log.error(`Failed to write ${this.path}`, error);
      }
    }, 100);
  }

  /** Writes the current data now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

/**
 * The key that encrypts the stored DSM password: `secret.key` in the data folder, created on the
 * first start and only readable by its owner.
 */
export function loadSecretKey(dir: string): Buffer {
  const path = join(dir, 'secret.key');
  try {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
    log.warn(`Invalid key in ${path}: a new one is made, the DSM password must be entered again`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 });
  return key;
}
