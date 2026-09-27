import { Agent, fetch } from 'undici';
import type { ErrorCode, FolderEntry } from '../../shared/types.js';
import { AppError } from '../errors.js';
import { log, redact } from '../logger.js';
import { basename, dirname, splitPath } from '../paths.js';
import { NasSessionError, type DsTask, type LoginParams, type LoginResult } from './types.js';

/*
 * Synology DSM Web API client (DSM 7, Download Station 4, File Station).
 *
 * - Every call is a POST with `_sid` (no cookie, no SynoToken needed).
 * - APIs flagged `requestFormat: JSON` (DownloadStation2.*, FileStation.*) take JSON-encoded
 *   values; legacy ones (DownloadStation/task.cgi) take raw, comma-separated values.
 * - Download Station paths have no leading slash (`video/Films`), File Station ones do.
 */

interface ApiInfoEntry {
  path: string;
  minVersion: number;
  maxVersion: number;
}

interface SynoResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: unknown };
}

type Params = Record<string, string | number | boolean>;

interface RawTask {
  id: string;
  title?: string;
  status: string;
  size?: number | string;
  status_extra?: { error_detail?: string } | null;
  additional?: {
    detail?: { uri?: string };
    transfer?: { size_downloaded?: number | string; speed_download?: number | string };
  };
}

const APIS = [
  'SYNO.API.Auth',
  'SYNO.DownloadStation.Info',
  'SYNO.DownloadStation.Task',
  'SYNO.DownloadStation2.Task',
  'SYNO.FileStation.List',
  'SYNO.FileStation.CreateFolder',
  'SYNO.FileStation.Rename',
];

/** Codes meaning "log in again" on every API. */
const SESSION_ERRORS = new Set([106, 107, 119, 150]);
/** Legacy task.cgi / info.cgi answer 105 to an unknown session. */
const LEGACY_SESSION_ERRORS = new Set([105]);
/** Codes meaning the account may not use Download Station / File Station. */
const PERMISSION_ERRORS = new Set([105, 160, 402]);

/** TLS errors of a certificate DSM made itself (or for another name). */
const CERTIFICATE_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const AUTH_ERRORS: Record<number, ErrorCode> = {
  400: 'invalid_credentials',
  401: 'account_disabled',
  402: 'no_permission',
  403: 'otp_required',
  404: 'otp_invalid',
  406: 'otp_setup_required',
  407: 'ip_blocked',
  408: 'password_expired',
  409: 'password_expired',
  410: 'password_expired',
};

const COMMON_MESSAGES: Record<number, string> = {
  100: 'Unknown error',
  101: 'Invalid parameter',
  102: 'API does not exist',
  103: 'Method does not exist',
  104: 'Version not supported',
  105: 'Permission denied',
  108: 'Upload failed',
  109: 'Network unstable or system busy',
  110: 'Network unstable or system busy',
  111: 'Network unstable or system busy',
  114: 'Missing parameters',
  117: 'Network unstable or system busy',
  118: 'Network unstable or system busy',
  120: 'Invalid parameter',
  160: 'Insufficient application privilege',
};

const TASK_MESSAGES: Record<number, string> = {
  400: 'File upload failed',
  401: 'Max number of tasks reached',
  402: 'Destination denied',
  403: 'Destination does not exist',
  404: 'Invalid task id',
  405: 'Invalid task action',
  406: 'No default destination',
  407: 'Set destination failed',
  408: 'File does not exist',
};

const FILE_MESSAGES: Record<number, string> = {
  400: 'Invalid parameter',
  401: 'Unknown error',
  402: 'System is too busy',
  403: 'Invalid user',
  407: 'Operation not permitted',
  408: 'No such file or directory',
  411: 'Read-only file system',
  414: 'File already exists',
  415: 'Disk quota exceeded',
  416: 'No space left on device',
  418: 'Illegal name or path',
  419: 'Illegal file name',
  1100: 'Failed to create the folder',
  1101: 'Too many folders',
};

const toNumber = (value: unknown): number => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
};

const toFileStationPath = (path: string) => `/${splitPath(path).join('/')}`;
const fromFileStationPath = (path: string) => splitPath(path).join('/');

/** Recycle bins (#recycle), metadata (@eaDir) and dot folders. */
const isHiddenFolder = (name: string) => /^[#@.]/.test(name);

/** DSM does not decode `+` as a space: always use %20. */
function encodeForm(params: Params): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export function toTask(raw: RawTask): DsTask {
  return {
    id: raw.id,
    status: raw.status,
    size: toNumber(raw.size),
    downloaded: toNumber(raw.additional?.transfer?.size_downloaded),
    speed: toNumber(raw.additional?.transfer?.speed_download),
    error: raw.status === 'error' ? raw.status_extra?.error_detail || 'unknown' : null,
    uri: raw.additional?.detail?.uri ?? null,
    title: raw.title ?? null,
  };
}

export class SynologyApiError extends AppError {
  constructor(
    readonly api: string,
    readonly synoCode: number,
    message: string,
  ) {
    super('nas_error', `${message} (${api}, code ${synoCode})`);
    this.name = 'SynologyApiError';
  }
}

const TIMEOUT_MS = 20_000;

export class SynologyClient {
  private readonly dispatcher: Agent;
  private apiInfo: Promise<Record<string, ApiInfoEntry>> | null = null;

  constructor(
    private readonly baseUrl: string,
    insecureTls: boolean,
  ) {
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: !insecureTls } });
  }

  private async post<T>(path: string, params: Params): Promise<SynoResponse<T>> {
    const url = `${this.baseUrl}/webapi/${path}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: encodeForm(params),
        dispatcher: this.dispatcher,
        // A redirect (HTTP → HTTPS) would turn the POST into a GET.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as Error & { cause?: Error & { code?: string } }).cause;
      const message = cause?.message ?? (error as Error).message;
      log.warn(`NAS unreachable (${url}): ${message}`);
      if (cause?.code && CERTIFICATE_ERRORS.has(cause.code)) {
        throw new AppError('nas_certificate', message);
      }
      throw new AppError('nas_unreachable', message);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '?';
      throw new AppError('nas_error', `The NAS address redirects to ${location}: use that one`);
    }
    if (!response.ok) throw new AppError('nas_error', `HTTP ${response.status} on ${path}`);
    try {
      return (await response.json()) as SynoResponse<T>;
    } catch {
      throw new AppError('nas_error', `Unexpected response from ${url} (not DSM?)`);
    }
  }

  private infos(): Promise<Record<string, ApiInfoEntry>> {
    this.apiInfo ??= this.post<Record<string, ApiInfoEntry>>('query.cgi', {
      api: 'SYNO.API.Info',
      version: 1,
      method: 'query',
      query: APIS.join(','),
    })
      .then((response) => {
        if (!response.success || !response.data) {
          throw new AppError('nas_error', 'SYNO.API.Info query failed');
        }
        return response.data;
      })
      .catch((error: unknown) => {
        this.apiInfo = null;
        throw error;
      });
    return this.apiInfo;
  }

  /** Calls a DSM API method with the highest supported version up to `maxVersion`. */
  private async call<T>(
    api: string,
    method: string,
    params: Params,
    options: { sid?: string; maxVersion?: number; messages?: Record<number, string> } = {},
  ): Promise<T> {
    const info = (await this.infos())[api];
    if (!info) {
      const code = api.includes('DownloadStation') ? 'download_station_unavailable' : 'nas_error';
      throw new AppError(code, `${api} is not available on this NAS`);
    }
    const version = Math.max(
      info.minVersion,
      Math.min(info.maxVersion, options.maxVersion ?? info.maxVersion),
    );
    const response = await this.post<T>(info.path, {
      api,
      version,
      method,
      ...params,
      ...(options.sid ? { _sid: options.sid } : {}),
    });
    if (response.success) return (response.data ?? {}) as T;

    const code = response.error?.code ?? 100;
    const legacy = info.path.startsWith('DownloadStation/');
    if (options.sid && (SESSION_ERRORS.has(code) || (legacy && LEGACY_SESSION_ERRORS.has(code)))) {
      throw new NasSessionError(options.sid);
    }
    const message = options.messages?.[code] ?? COMMON_MESSAGES[code] ?? `Error ${code}`;
    log.debug(redact(`${api}.${method} failed: ${code} ${message}`), response.error?.errors ?? '');
    throw new SynologyApiError(api, code, message);
  }

  async login(params: LoginParams): Promise<LoginResult> {
    // Read the NAS's APIs again: Download Station may have been installed or updated since.
    this.apiInfo = null;
    const request: Params = {
      account: params.account,
      passwd: params.password,
      session: 'DownloadStation',
      format: 'sid',
      device_name: 'Syno Debrid',
    };
    if (params.otpCode) {
      request.otp_code = params.otpCode;
      // "Remember this device": the next logins will not need a code.
      request.enable_device_token = 'yes';
    } else if (params.deviceId) {
      request.device_id = params.deviceId;
    }

    let data: { sid?: string; did?: string; device_id?: string };
    try {
      data = await this.call('SYNO.API.Auth', 'login', request, { maxVersion: 6 });
    } catch (error) {
      const code = error instanceof SynologyApiError ? AUTH_ERRORS[error.synoCode] : undefined;
      if (code) throw new AppError(code, (error as Error).message);
      throw error;
    }
    if (!data.sid) throw new AppError('nas_error', 'Login succeeded without a session id');

    // Make sure the account may use Download Station.
    try {
      await this.checkSession(data.sid);
    } catch (error) {
      await this.logout(data.sid).catch(() => undefined);
      if (
        error instanceof NasSessionError ||
        (error instanceof SynologyApiError && PERMISSION_ERRORS.has(error.synoCode))
      ) {
        throw new AppError('no_permission');
      }
      throw error;
    }
    return { sid: data.sid, deviceId: data.did || data.device_id || null };
  }

  /** Makes sure the account may use File Station (folders, renaming), right after a login. */
  async checkFileStation(sid: string): Promise<void> {
    try {
      await this.listShares(sid);
    } catch (error) {
      if (error instanceof SynologyApiError && PERMISSION_ERRORS.has(error.synoCode)) {
        throw new AppError('file_station_denied', error.message);
      }
      throw error;
    }
  }

  async logout(sid: string): Promise<void> {
    await this.call(
      'SYNO.API.Auth',
      'logout',
      { session: 'DownloadStation' },
      { sid, maxVersion: 6 },
    );
  }

  /** Throws NasSessionError when the session is no longer valid. */
  async checkSession(sid: string): Promise<void> {
    await this.call('SYNO.DownloadStation.Info', 'getinfo', {}, { sid, maxVersion: 1 });
  }

  async createFolders(sid: string, paths: string[]): Promise<void> {
    // Shared folders themselves cannot be created; only what is below them.
    const unique = [...new Set(paths.map((path) => splitPath(path).join('/')))].filter(
      (path) => splitPath(path).length > 1,
    );
    if (!unique.length) return;
    try {
      await this.call(
        'SYNO.FileStation.CreateFolder',
        'create',
        {
          folder_path: JSON.stringify(unique.map((path) => toFileStationPath(dirname(path)))),
          name: JSON.stringify(unique.map((path) => basename(path))),
          force_parent: true,
        },
        { sid, maxVersion: 2, messages: FILE_MESSAGES },
      );
    } catch (error) {
      if (error instanceof SynologyApiError) {
        const denied = PERMISSION_ERRORS.has(error.synoCode) || error.synoCode === 407;
        throw new AppError(denied ? 'destination_denied' : 'folder_failed', error.message);
      }
      throw error;
    }
  }

  async listShares(sid: string): Promise<FolderEntry[]> {
    const data = await this.call<{ shares?: { name: string; path: string }[] }>(
      'SYNO.FileStation.List',
      'list_share',
      {
        onlywritable: true,
        sort_by: JSON.stringify('name'),
        sort_direction: JSON.stringify('asc'),
      },
      { sid, maxVersion: 2, messages: FILE_MESSAGES },
    );
    return (data.shares ?? [])
      .filter((share) => !isHiddenFolder(share.name))
      .map((share) => ({ name: share.name, path: fromFileStationPath(share.path) }));
  }

  async listFolders(sid: string, path: string): Promise<FolderEntry[]> {
    let data: { files?: { name: string; path: string; isdir?: boolean }[] };
    try {
      data = await this.call(
        'SYNO.FileStation.List',
        'list',
        {
          folder_path: JSON.stringify(toFileStationPath(path)),
          filetype: JSON.stringify('dir'),
          sort_by: JSON.stringify('name'),
          sort_direction: JSON.stringify('asc'),
        },
        { sid, maxVersion: 2, messages: FILE_MESSAGES },
      );
    } catch (error) {
      // Lets the web app tell a mistyped folder from other errors.
      if (error instanceof SynologyApiError && error.synoCode === 408) {
        throw new AppError('destination_missing', error.message);
      }
      throw error;
    }
    return (data.files ?? [])
      .filter((file) => file.isdir !== false && !isHiddenFolder(file.name))
      .map((file) => ({ name: file.name, path: fromFileStationPath(file.path) }));
  }

  async rename(sid: string, path: string, name: string): Promise<void> {
    await this.call(
      'SYNO.FileStation.Rename',
      'rename',
      {
        path: JSON.stringify([toFileStationPath(path)]),
        name: JSON.stringify([name]),
      },
      { sid, maxVersion: 2, messages: FILE_MESSAGES },
    );
  }

  /** Returns the id of the new task (null when Download Station does not say it). */
  async createDownloadTask(sid: string, url: string, destination: string): Promise<string | null> {
    try {
      const data = await this.call<{ task_id?: string[] }>(
        'SYNO.DownloadStation2.Task',
        'create',
        {
          type: JSON.stringify('url'),
          // Commas separate URLs in some Download Station code paths.
          url: JSON.stringify([url.replace(/,/g, '%2C')]),
          destination: JSON.stringify(splitPath(destination).join('/')),
          create_list: false,
        },
        { sid, maxVersion: 2, messages: TASK_MESSAGES },
      );
      return data.task_id?.[0] ?? null;
    } catch (error) {
      if (error instanceof SynologyApiError) {
        if (error.synoCode === 402) throw new AppError('destination_denied', error.message);
        if (error.synoCode === 403) throw new AppError('destination_missing', error.message);
      }
      throw error;
    }
  }

  /** All the tasks: listing is sturdier than getinfo, which fails when one id is gone. */
  async listTasks(sid: string): Promise<DsTask[]> {
    const data = await this.call<{ tasks?: RawTask[] }>(
      'SYNO.DownloadStation.Task',
      'list',
      { additional: 'detail,transfer', offset: 0, limit: -1 },
      { sid, maxVersion: 1, messages: TASK_MESSAGES },
    );
    return (data.tasks ?? []).map(toTask);
  }

  async deleteTasks(sid: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.call(
      'SYNO.DownloadStation.Task',
      'delete',
      { id: ids.join(','), force_complete: false },
      { sid, maxVersion: 1, messages: TASK_MESSAGES },
    );
  }
}
