// Shared by the demo and the screenshots: the app against the fake NAS and AllDebrid.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A data folder with an AllDebrid key (for the fake service) and a few destinations. */
export function sampleDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syno-debrid-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      apiKeys: { alldebrid: 'demo' },
      categories: [
        { id: 'films', name: 'Films', icon: 'movie', destination: 'video/Films' },
        { id: 'series', name: 'Séries', icon: 'tv', destination: 'video/Séries' },
        { id: 'kids', name: 'Enfants', icon: 'kids', destination: 'video/Enfants' },
        { id: 'music', name: 'Musique', icon: 'music', destination: 'music' },
      ],
    }),
  );
  return dir;
}

/** Environment of the app's server, using the fake AllDebrid of `mockUrl`. */
export const serverEnv = (port: number, dataDir: string, mockUrl: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  ALLDEBRID_API_URL: `${mockUrl}/alldebrid`,
  LOG_LEVEL: 'warn',
});

/** Resolves once the app's server answers. */
export async function waitForServer(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server did not start');
}
