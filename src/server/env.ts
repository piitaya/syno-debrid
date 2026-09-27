import { resolve } from 'node:path';
import { PROVIDER_IDS, type ProviderId } from '../shared/types.js';

export interface Env {
  port: number;
  host: string;
  dataDir: string;
  webRoot: string;
  version: string;
  /** `none`: no sign-in, a reverse proxy authenticates every request (Authelia…). */
  auth: 'password' | 'none';
  sessionTtlDays: number;
  /** Trust `X-Forwarded-*` headers set by a reverse proxy. */
  trustProxy: boolean;
  /** API keys set through the environment (they take precedence over the UI settings). */
  providerKeys: Partial<Record<ProviderId, string>>;
  /** Base URLs of the debrid APIs (overridable for tests). */
  providerUrls: Record<ProviderId, string>;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const providerKeys: Partial<Record<ProviderId, string>> = {};
  for (const id of PROVIDER_IDS) {
    const key = source[`${id.toUpperCase()}_API_KEY`]?.trim();
    if (key) providerKeys[id] = key;
  }
  const logLevel = source.LOG_LEVEL?.trim().toLowerCase();

  return {
    port: int(source.PORT, 8080, 1, 65535),
    host: source.HOST?.trim() || '0.0.0.0',
    dataDir: resolve(source.DATA_DIR?.trim() || './data'),
    webRoot: resolve('dist/web'),
    version:
      typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : (source.npm_package_version ?? 'dev'),
    auth: source.AUTH?.trim().toLowerCase() === 'none' ? 'none' : 'password',
    sessionTtlDays: int(source.SESSION_TTL_DAYS, 30, 1, 365),
    trustProxy: source.TRUST_PROXY?.trim().toLowerCase() === 'true',
    providerKeys,
    providerUrls: {
      alldebrid: trimSlash(source.ALLDEBRID_API_URL?.trim() || 'https://api.alldebrid.com'),
    },
    logLevel:
      logLevel === 'debug' || logLevel === 'warn' || logLevel === 'error' ? logLevel : 'info',
  };
}
