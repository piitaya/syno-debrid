import { Hono } from 'hono';
import { createMockDebrid } from './debrid.js';
import { createMockDsm } from './synology.js';

/** Fake NAS and fake AllDebrid on a single app, for the tests, the demo and the screenshots. */
export function createMockServer(options: { speed?: number } = {}) {
  const dsm = createMockDsm({
    users: {
      // The dedicated account the README recommends.
      'syno-debrid': { password: 'syno-debrid' },
      secure: { password: 'secure', otp: '123456' },
      paul: { password: 'paul' },
    },
    folders: ['/video/Films', '/video/Séries', '/video/Enfants', '/music', '/downloads', '/photo'],
    speed: options.speed,
  });
  const app = new Hono();
  app.route('/', createMockDebrid().app);
  app.route('/', dsm.app);
  return { app, dsm };
}
