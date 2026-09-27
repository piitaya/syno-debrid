import type { ProviderId } from '../../shared/types.js';
import type { Env } from '../env.js';
import { AppError } from '../errors.js';
import type { Settings } from '../settings.js';
import { AllDebrid } from './alldebrid.js';
import type { DebridProvider } from './types.js';

/** The client of a debrid service, with this API key. */
export function createProvider(id: ProviderId, apiKey: string, env: Env): DebridProvider {
  return new AllDebrid(apiKey, env.providerUrls[id]);
}

/** The client of a debrid service, with its saved API key. */
export function configuredProvider(id: ProviderId, settings: Settings, env: Env): DebridProvider {
  const key = settings.apiKey(id);
  if (!key) throw new AppError('provider_not_configured');
  return createProvider(id, key, env);
}
