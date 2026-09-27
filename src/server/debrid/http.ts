import { AppError } from '../errors.js';
import { log, redact } from '../logger.js';

export const USER_AGENT = 'syno-debrid';
const TIMEOUT_MS = 30_000;

export interface HttpResult<T> {
  status: number;
  data: T | null;
  text: string;
}

/** fetch() with a timeout, JSON parsing and network errors mapped to `provider_unreachable`. */
export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<HttpResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as Error & { cause?: Error }).cause;
    log.debug(`Request failed: ${redact(url)}`, cause ?? error);
    throw new AppError('provider_unreachable', cause?.message ?? (error as Error).message);
  }
  const text = await response.text();
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  log.debug(`${init.method ?? 'GET'} ${redact(url)} → ${response.status}`);
  return { status: response.status, data, text };
}

/** Maps generic HTTP statuses to error codes. */
export function httpError(status: number, message?: string): AppError {
  if (status === 401 || status === 403) return new AppError('provider_auth', message);
  if (status === 429) return new AppError('provider_rate_limited', message);
  if (status >= 500) return new AppError('provider_unreachable', message ?? `HTTP ${status}`);
  return new AppError('provider_error', message ?? `HTTP ${status}`);
}
