// Runs the whole app against the fake NAS and debrid services, with sample settings and
// downloads: the web app and the API server, both reloaded when their code changes.
//
//   npm run demo                    → http://localhost:5173 (sign in with demo / demo1234)
//   DEMO_PORT=5300 npm run demo     → web on 5300, API on 5301, mocks on 5302
//   DEMO_SEED=0 npm run demo        → first start: no account, no sample downloads
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { createMockServer } from '../test/mocks/server.js';
import { sampleDataDir, serverEnv, waitForServer } from './sample.js';

const webPort = Number(process.env.DEMO_PORT ?? 5173);
const apiPort = webPort + 1;
const mockPort = webPort + 2;
const mockUrl = `http://127.0.0.1:${mockPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;

const mock = createMockServer({ speed: 5 * 1024 * 1024 });
serve({ fetch: mock.app.fetch, port: mockPort, hostname: '127.0.0.1' });

// The server restarts when its code changes.
const api = spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server/index.ts'], {
  env: serverEnv(apiPort, sampleDataDir(), mockUrl),
  stdio: 'inherit',
});

const web = await createServer({
  configFile: new URL('../vite.config.ts', import.meta.url).pathname,
  server: { port: webPort, strictPort: true, proxy: { '^/api/': { target: apiUrl } } },
});
await web.listen();

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
    const form = new FormData();
    form.set('provider', 'alldebrid');
    form.set('categoryId', categoryId);
    form.set('magnets', `magnet:?xt=urn:btih:${hash(index + 1)}&dn=${name}`);
    await fetch(`${apiUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'dds', Cookie: cookie },
      body: form,
    });
  }
}

await waitForServer(apiUrl);
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
