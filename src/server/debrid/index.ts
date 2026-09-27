import type { ProviderId } from '../../shared/types.js';
import type { Env } from '../env.js';
import { AppError } from '../errors.js';
import type { Settings } from '../settings.js';
import { AllDebrid } from './alldebrid.js';
import type { DebridProvider } from './types.js';

export function createProvider(id: ProviderId, apiKey: string, env: Env): DebridProvider {
  const baseUrl = env.providerUrls[id];
  switch (id) {
    case 'alldebrid':
      return new AllDebrid(apiKey, baseUrl);
  }
}

/** Provider instances built from the current API keys. */
export class Providers {
  private readonly cache = new Map<ProviderId, { key: string; provider: DebridProvider }>();

  constructor(
    private readonly settings: Settings,
    private readonly env: Env,
  ) {}

  get(id: ProviderId): DebridProvider {
    const key = this.settings.apiKey(id);
    if (!key) throw new AppError('provider_not_configured');
    const cached = this.cache.get(id);
    if (cached?.key === key) return cached.provider;
    const provider = createProvider(id, key, this.env);
    this.cache.set(id, { key, provider });
    return provider;
  }
}
