import { Hono } from 'hono';

/*
 * A fake Synology DSM (DSM 7 + Download Station 4 + File Station), enough to run the app
 * end-to-end in tests, local development and screenshots.
 */

export interface MockUser {
  password: string;
  /** When set, logging in requires this 2FA code. */
  otp?: string;
  /** False: File Station is denied to the account. */
  fileStation?: boolean;
}

export interface MockTask {
  id: string;
  uri: string;
  destination: string;
  size: number;
  createdAt: number;
  /** Bytes per second. */
  speed: number;
  deleted: boolean;
  fail?: string;
}

export interface MockDsmOptions {
  users: Record<string, MockUser>;
  folders?: string[];
  /** Download speed of simulated tasks, bytes per second. */
  speed?: number;
  now?: () => number;
}

const API_INFO = {
  'SYNO.API.Auth': { maxVersion: 7, minVersion: 1, path: 'entry.cgi' },
  'SYNO.DownloadStation.Info': { maxVersion: 2, minVersion: 1, path: 'DownloadStation/info.cgi' },
  'SYNO.DownloadStation.Task': { maxVersion: 3, minVersion: 1, path: 'DownloadStation/task.cgi' },
  'SYNO.DownloadStation2.Task': { maxVersion: 2, minVersion: 1, path: 'entry.cgi' },
  'SYNO.FileStation.List': { maxVersion: 2, minVersion: 1, path: 'entry.cgi' },
  'SYNO.FileStation.CreateFolder': { maxVersion: 2, minVersion: 1, path: 'entry.cgi' },
  'SYNO.FileStation.Rename': { maxVersion: 2, minVersion: 1, path: 'entry.cgi' },
};

/** Parses a JSON-encoded parameter, falling back to the raw string (like DSM seems to do). */
function jsonParam<T>(value: string | undefined): T | string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value;
  }
}

export function createMockDsm(options: MockDsmOptions) {
  const now = options.now ?? Date.now;
  const { users } = options;
  const speed = options.speed ?? 40 * 1024 * 1024;
  /** Folders by lowercase path (DSM paths ignore case), with their own case. */
  const folders = new Map<string, string>();
  const sessions = new Map<string, string>();
  const tasks = new Map<string, MockTask>();
  const devices = new Map<string, string>();
  let nextTask = 1;
  let nextSid = 1;
  let nextDevice = 1;
  const state = {
    /** False: Download Station is not installed (its APIs are not listed). */
    downloadStation: true,
    logins: 0,
    renamed: [] as string[],
  };

  const addFolder = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const sub = `/${parts.slice(0, i).join('/')}`;
      if (!folders.has(sub.toLowerCase())) folders.set(sub.toLowerCase(), sub);
    }
  };
  for (const path of options.folders ?? ['/video/Films', '/video/Séries', '/music', '/downloads']) {
    addFolder(path);
  }

  const taskView = (task: MockTask) => {
    const elapsed = Math.max(0, (now() - task.createdAt) / 1000 - 0.5);
    const downloaded = Math.min(task.size, Math.floor(elapsed * task.speed));
    const done = downloaded >= task.size;
    const status = task.fail
      ? 'error'
      : done
        ? 'finished'
        : elapsed > 0
          ? 'downloading'
          : 'waiting';
    return {
      id: task.id,
      type: 'https',
      title: decodeURIComponent(task.uri.split('/').pop()?.split('?')[0] ?? 'file'),
      size: String(task.size),
      status,
      status_extra: task.fail ? { error_detail: task.fail } : null,
      additional: {
        detail: {
          destination: task.destination,
          uri: task.uri,
          create_time: Math.floor(task.createdAt / 1000),
        },
        transfer: {
          size_downloaded: String(downloaded),
          speed_download: done || task.fail ? 0 : task.speed,
        },
      },
    };
  };

  const app = new Hono();
  const fail = (code: number, extra: Record<string, unknown> = {}) => ({
    success: false,
    error: { code, ...extra },
  });

  app.post('/webapi/query.cgi', (c) =>
    c.json({
      success: true,
      data: Object.fromEntries(
        Object.entries(API_INFO).filter(
          ([api]) => state.downloadStation || !api.includes('DownloadStation'),
        ),
      ),
    }),
  );

  app.post('/webapi/*', async (c) => {
    const params = (await c.req.parseBody()) as Record<string, string>;
    const { api, method } = params;
    const sid = params._sid;
    const username = sid ? sessions.get(sid) : undefined;
    const legacy = c.req.path.includes('/DownloadStation/');

    if (api === 'SYNO.API.Auth') {
      if (method === 'logout') {
        if (sid) sessions.delete(sid);
        return c.json({ success: true });
      }
      state.logins++;
      const account = (params.account ?? '').toLowerCase();
      const user = users[account];
      if (!user || user.password !== params.passwd) return c.json(fail(400));
      let did: string | undefined;
      if (user.otp) {
        const trusted = params.device_id && devices.get(params.device_id) === account;
        if (!trusted) {
          if (!params.otp_code) return c.json(fail(403));
          if (params.otp_code !== user.otp) return c.json(fail(404));
          if (params.enable_device_token === 'yes') {
            did = `device-${nextDevice++}`;
            devices.set(did, account);
          }
        }
      }
      const newSid = `sid-${nextSid++}-${Math.random().toString(36).slice(2)}`;
      sessions.set(newSid, account);
      return c.json({
        success: true,
        data: { sid: newSid, did: did ?? '', is_portal_port: false },
      });
    }

    if (!username) return c.json(fail(legacy ? 105 : 119));
    const user = users[username]!;
    if (api.startsWith('SYNO.FileStation') && user.fileStation === false) return c.json(fail(160));

    if (api === 'SYNO.DownloadStation.Info') {
      return c.json({ success: true, data: { version: 4000, version_string: '4.0.0' } });
    }

    if (api === 'SYNO.DownloadStation2.Task' && method === 'create') {
      const destination = jsonParam<string>(params.destination);
      const urls = jsonParam<string[]>(params.url);
      if (
        jsonParam(params.type) !== 'url' ||
        typeof destination !== 'string' ||
        !Array.isArray(urls)
      ) {
        return c.json(fail(120));
      }
      if (!folders.has(`/${destination}`.toLowerCase())) return c.json(fail(403));
      const ids = urls.map((uri) => {
        const id = `dbid_${nextTask++}`;
        const size = Number(
          new URL(uri.replace(/%2C/g, ',')).searchParams.get('size') ?? 700 * 1024 * 1024,
        );
        tasks.set(id, { id, uri, destination, size, createdAt: now(), speed, deleted: false });
        return id;
      });
      return c.json({ success: true, data: { list_id: [], task_id: ids } });
    }

    if (api === 'SYNO.DownloadStation.Task' && method === 'list') {
      const list = [...tasks.values()].filter((task) => !task.deleted).map(taskView);
      return c.json({ success: true, data: { tasks: list, offset: 0, total: list.length } });
    }

    if (api === 'SYNO.DownloadStation.Task' && method === 'delete') {
      const ids = (params.id ?? '').split(',');
      for (const id of ids) {
        const task = tasks.get(id);
        if (task) task.deleted = true;
      }
      return c.json({ success: true, data: ids.map((id) => ({ error: 0, id })) });
    }

    if (api === 'SYNO.FileStation.List' && method === 'list_share') {
      const shares = [...folders.values()]
        .filter((path) => path.split('/').length === 2)
        .sort()
        .map((path) => ({ isdir: true, name: path.slice(1), path }));
      return c.json({ success: true, data: { shares, offset: 0, total: shares.length } });
    }

    if (api === 'SYNO.FileStation.List' && method === 'list') {
      const parent = String(jsonParam<string>(params.folder_path) ?? '').toLowerCase();
      if (!folders.has(parent)) return c.json(fail(408));
      const depth = parent.split('/').length + 1;
      const files = [...folders.values()]
        .filter(
          (path) => path.toLowerCase().startsWith(`${parent}/`) && path.split('/').length === depth,
        )
        .sort()
        .map((path) => ({ isdir: true, name: path.split('/').pop(), path }));
      return c.json({ success: true, data: { files, offset: 0, total: files.length } });
    }

    if (api === 'SYNO.FileStation.Rename') {
      const paths = jsonParam<string[]>(params.path);
      const names = jsonParam<string[]>(params.name);
      if (!Array.isArray(paths) || !Array.isArray(names)) return c.json(fail(401));
      state.renamed.push(...paths.map((path, index) => `${path} -> ${names[index]}`));
      return c.json({ success: true, data: { files: [] } });
    }

    if (api === 'SYNO.FileStation.CreateFolder') {
      const parents = jsonParam<string[]>(params.folder_path);
      const names = jsonParam<string[]>(params.name);
      if (!Array.isArray(parents) || !Array.isArray(names) || parents.length !== names.length) {
        return c.json(fail(401));
      }
      const created = parents.map((parent, index) => {
        const path = `${parent}/${names[index]}`;
        const share = `/${path.split('/').filter(Boolean)[0]}`.toLowerCase();
        if (!folders.has(share)) return null;
        addFolder(path);
        return { isdir: true, name: names[index], path };
      });
      if (created.includes(null)) return c.json(fail(1100, { errors: [{ code: 408 }] }));
      return c.json({ success: true, data: { folders: created } });
    }

    return c.json(fail(103));
  });

  return {
    app,
    state,
    /** Accounts, e.g. to change a password. */
    users,
    tasks,
    folders,
    /** Expires every session, like a DSM reboot. */
    expireSessions: () => sessions.clear(),
  };
}
