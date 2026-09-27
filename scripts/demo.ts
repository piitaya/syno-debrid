// Runs the whole app against the fake NAS and debrid services, with sample settings and
// downloads, for UI work: web app with hot reload, API server, mocks.
//
//   npm run demo                    → http://localhost:5173 (sign in with demo / demo1234)
//   DEMO_PORT=5300 npm run demo     → web on 5300, API on 5301, mocks on 5302
//   DEMO_SEED=0 npm run demo        → first start: no account, no sample downloads
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createMockServer } from '../test/mocks/server.js';

const webPort = Number(process.env.DEMO_PORT ?? 5173);
const apiPort = webPort + 1;
const mockPort = webPort + 2;
const mockUrl = `http://127.0.0.1:${mockPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;

const mock = createMockServer({ speed: 5 * 1024 * 1024 });
serve({ fetch: mock.app.fetch, port: mockPort, hostname: '127.0.0.1' });

const dataDir = mkdtempSync(join(tmpdir(), 'dds-demo-'));
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    apiKeys: { alldebrid: 'demo' },
    defaultProvider: 'alldebrid',
    categories: [
      { id: 'films', name: 'Films', icon: 'movie', destination: 'video/Films' },
      { id: 'series', name: 'Séries', icon: 'tv', destination: 'video/Séries' },
      { id: 'kids', name: 'Enfants', icon: 'kids', destination: 'video/Enfants' },
      { id: 'music', name: 'Musique', icon: 'music', destination: 'music' },
    ],
    defaultCategoryId: 'films',
    createSubfolder: true,
    deleteFromDebrid: false,
  }),
);

const api = spawn('npx', ['tsx', 'src/server/index.ts'], {
  env: {
    ...process.env,
    PORT: String(apiPort),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    ALLDEBRID_API_URL: `${mockUrl}/alldebrid`,
    LOG_LEVEL: 'warn',
  },
  stdio: 'inherit',
});

const web = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname,
  server: { port: webPort, strictPort: true, proxy: { '^/api/': { target: apiUrl } } },
});
await web.listen();

async function waitForApi(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${apiUrl}/api/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('API server did not start');
}

async function seed(): Promise<void> {
  // As done in the app: the account, then Download Station on the fake NAS.
  const setup = await fetch(`${apiUrl}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dds' },
    body: JSON.stringify({ username: 'demo', password: 'demo1234' }),
  });
  const cookie = setup.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await fetch(`${apiUrl}/api/nas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dds', Cookie: cookie },
    body: JSON.stringify({ url: mockUrl, account: 'syno-debrid', password: 'syno-debrid' }),
  });
  const hash = (n: number) => n.toString(16).padStart(40, '0');
  const samples: [string, string][] = [
    ['Elephants.Dream.2006.720p.mkv', 'films'],
    ['Big.Buck.Bunny.2008.1080p.mkv', 'films'],
    ['Sintel.S01.1080p.WEB', 'series'],
    ['Tears.of.Steel.2012.1080p.slow', 'films'],
    ['Cosmos.Laundromat.2015.dead', 'kids'],
  ];
  for (const [index, [name, categoryId]] of samples.entries()) {
    await fetch(`${apiUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dds', Cookie: cookie },
      body: JSON.stringify({
        magnets: [`magnet:?xt=urn:btih:${hash(index + 1)}&dn=${name}`],
        provider: 'alldebrid',
        categoryId,
      }),
    });
  }
}

await waitForApi();
const seeded = process.env.DEMO_SEED !== '0';
if (seeded) await seed();
console.log(
  seeded
    ? `\n  Demo: http://localhost:${webPort}  (demo / demo1234)\n`
    : `\n  Demo: http://localhost:${webPort}  (fake NAS: ${mockUrl}, syno-debrid / syno-debrid)\n`,
);

const stop = () => {
  api.kill('SIGTERM');
  void web.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
