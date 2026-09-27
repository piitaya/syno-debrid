import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

interface Fetchable {
  fetch: (request: Request) => Response | Promise<Response>;
}

/** Serves a Hono app on a random local port. */
export async function listen(app: Fetchable): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
      (info: AddressInfo) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      },
    );
  });
}
