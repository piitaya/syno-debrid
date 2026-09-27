/**
 * Counts failed attempts per key (client IP, or '*' for all) in a sliding window. Protects the
 * sign-in form, and the NAS itself: DSM auto-block would ban the container's IP.
 */
export class RateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string): number[] {
    const since = Date.now() - this.windowMs;
    const list = (this.attempts.get(key) ?? []).filter((time) => time > since);
    if (list.length) this.attempts.set(key, list);
    else this.attempts.delete(key);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    this.attempts.set(key, [...this.recent(key), Date.now()]);
  }

  /**
   * Counts an attempt before its outcome is known, so that attempts made in parallel count too.
   * False when the limit is reached (nothing is counted then).
   */
  attempt(key: string): boolean {
    if (this.isBlocked(key)) return false;
    this.fail(key);
    return true;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
