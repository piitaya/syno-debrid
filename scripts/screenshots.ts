// Takes the README screenshots: runs the built app against the fake NAS and debrid services.
// Usage: npm run build && npm run screenshots
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { createMockServer } from '../test/mocks/server.js';
import { sampleDataDir, serverEnv, waitForServer } from './sample.js';

const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const PORT = 8099;
const APP = `http://127.0.0.1:${PORT}`;
/** The fake NAS, on DSM's port. */
const NAS = 'http://127.0.0.1:5000';
/** The app's account. */
const ACCOUNT = { username: 'paul', password: 'syno-debrid' };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const mock = createMockServer({ speed: 40 * 1024 * 1024 });
const mockServer = serve({ fetch: mock.app.fetch, port: 5000, hostname: '127.0.0.1' });

const server = spawn('node', ['dist/server/index.js'], {
  env: serverEnv(PORT, sampleDataDir(), NAS),
  stdio: 'inherit',
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stable fake info-hash for a name. */
function fakeHash(name: string): string {
  let value = 0;
  for (const char of name) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value.toString(16).padStart(8, '0').repeat(5);
}

const iphone: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  locale: 'fr-FR',
};
const desktop: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  locale: 'fr-FR',
};

async function open(browser: Browser, options: BrowserContextOptions, scheme: 'light' | 'dark') {
  const context = await browser.newContext({ ...options, colorScheme: scheme });
  return { context, page: await context.newPage() };
}

async function login(page: Page): Promise<void> {
  await page.goto(APP);
  await page.getByPlaceholder(/utilisateur/).fill(ACCOUNT.username);
  await page.getByPlaceholder('Mot de passe').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('button', { name: 'Ajouter un téléchargement' }).first().waitFor();
}

async function shot(page: Page, name: string): Promise<void> {
  // No hover highlight left where the last click happened.
  await page.mouse.move(0, 0);
  await sleep(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`✓ ${name}.png`);
}

try {
  await waitForServer(APP);
  // A browser installed by Playwright, or the one CHROMIUM_PATH points to.
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

  // First start: the account, then Download Station from Settings.
  {
    const { context, page } = await open(browser, iphone, 'light');
    await page.goto(APP);
    await page.getByPlaceholder(/utilisateur/).fill(ACCOUNT.username);
    await page.getByPlaceholder('Mot de passe', { exact: true }).fill(ACCOUNT.password);
    await page.getByPlaceholder('Confirmer le mot de passe').fill(ACCOUNT.password);
    await page.getByRole('button', { name: 'Créer le compte' }).click();
    await page.getByRole('link', { name: /Connecter Download Station/ }).click();
    await page.getByRole('button', { name: /Download Station/ }).click();
    const sheet = page.locator('dds-nas-sheet');
    await sheet.locator('#url').fill('http://192.168.1.10:5000');
    await sheet.locator('#account').fill('syno-debrid');
    await sheet.locator('#password').fill('syno-debrid');
    await sheet.locator('#password').blur();
    await shot(page, 'iphone-nas-light');
    await sheet.locator('#url').fill(NAS);
    await sheet.getByRole('button', { name: 'Connecter' }).click();
    await page.getByText('Connexion enregistrée').waitFor();
    await context.close();
  }

  // Login screen.
  {
    const { context, page } = await open(browser, iphone, 'light');
    await page.goto(APP);
    await page.getByRole('button', { name: 'Se connecter' }).waitFor();
    await shot(page, 'iphone-login-light');
    await context.close();
  }

  // Sample downloads, added through the API like the app does.
  {
    const { context, page } = await open(browser, iphone, 'light');
    await login(page);
    const add = async (name: string, categoryId: string) => {
      const response = await page.request.post(`${APP}/api/jobs`, {
        headers: { 'X-Requested-With': 'dds' },
        multipart: {
          magnets: `magnet:?xt=urn:btih:${fakeHash(name)}&dn=${name}`,
          provider: 'alldebrid',
          categoryId,
        },
      });
      if (!response.ok()) throw new Error(await response.text());
    };
    await add('Elephants.Dream.2006.720p.mkv', 'films');
    await add('Cosmos.Laundromat.2015.1080p.dead', 'kids');
    await sleep(9000);
    await add('Sintel.S01.1080p.WEB-DL', 'series');
    await add('Tears.of.Steel.2012.2160p.slow', 'films');
    await add('Big.Buck.Bunny.2008.1080p.mkv', 'films');
    await sleep(9000);
    await context.close();
  }

  for (const scheme of ['light', 'dark'] as const) {
    const { context, page } = await open(browser, iphone, scheme);
    await login(page);
    await shot(page, `iphone-downloads-${scheme}`);

    if (scheme === 'light') {
      await page.getByRole('button', { name: 'Ajouter un téléchargement' }).first().click();
      await page
        .locator('dds-add-sheet textarea')
        .fill(
          `magnet:?xt=urn:btih:${fakeHash('agent')}&dn=Agent.327.Operation.Barbershop.2017.2160p.mkv`,
        );
      await page.getByRole('radio', { name: /Séries/ }).click();
      await shot(page, 'iphone-add-light');
      await page.keyboard.press('Escape');

      await page.goto(`${APP}/#/settings`);
      await page.getByText('Services debrid').waitFor();
      await sleep(1000);
      await shot(page, 'iphone-settings-light');
    } else {
      await page.locator('dds-download-row').filter({ hasText: 'Sintel' }).click();
      await sleep(400);
      await shot(page, 'iphone-details-dark');
    }
    await context.close();
  }

  for (const scheme of ['light', 'dark'] as const) {
    const { context, page } = await open(browser, desktop, scheme);
    await login(page);
    await shot(page, `desktop-downloads-${scheme}`);
    if (scheme === 'light') {
      await page.goto(`${APP}/#/settings`);
      await page.getByRole('button', { name: /Ajouter une destination/ }).click();
      await page.getByPlaceholder('Films, Séries…').fill('Documentaires');
      await page.getByRole('button', { name: 'Parcourir' }).click();
      await page.getByRole('button', { name: /^video/ }).click();
      await page
        .getByRole('button', { name: /Séries/ })
        .last()
        .waitFor();
      await shot(page, 'desktop-folder-picker');
    }
    await context.close();
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
  mockServer.close();
}
