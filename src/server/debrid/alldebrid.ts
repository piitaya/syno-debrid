import type { ErrorCode, ProviderAccount } from '../../shared/types.js';
import { AppError } from '../errors.js';
import { log, redact } from '../logger.js';
import type {
  AddedTorrent,
  DebridContent,
  DebridFile,
  DebridProvider,
  DebridStatus,
} from './types.js';

/*
 * AllDebrid API v4 (docs.alldebrid.com). Errors usually come back with HTTP 200 and
 * `{ status: "error", error: { code, message } }`; `magnet/status` only exists in v4.1.
 */

interface Envelope<T> {
  status?: 'success' | 'error';
  data?: T;
  error?: { code: string; message?: string };
}

interface ItemError {
  error?: { code: string; message?: string };
}

interface MagnetStatus {
  id: number | string;
  filename?: string;
  size?: number;
  status?: string;
  statusCode: number;
  downloaded?: number;
  uploaded?: number;
  seeders?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
}

interface TreeNode {
  n: string;
  s?: number;
  l?: string;
  e?: TreeNode[];
}

const ERRORS: Record<string, ErrorCode> = {
  AUTH_MISSING_APIKEY: 'provider_auth',
  AUTH_BAD_APIKEY: 'provider_auth',
  AUTH_USER_BANNED: 'provider_auth',
  // New IP / location: the account owner must approve it from the e-mail AllDebrid sent.
  AUTH_BLOCKED: 'provider_auth',
  MUST_BE_PREMIUM: 'provider_premium',
  MAGNET_MUST_BE_PREMIUM: 'provider_premium',
  FREE_TRIAL_LIMIT_REACHED: 'provider_premium',
  MAGNET_INVALID_URI: 'magnet_invalid',
  MAGNET_NO_URI: 'magnet_invalid',
  MAGNET_INVALID_FILE: 'torrent_invalid',
  MAGNET_FILE_UPLOAD_FAILED: 'torrent_invalid',
  MAGNET_TOO_LARGE: 'torrent_too_big',
  MAGNET_TOO_MANY_ACTIVE: 'provider_rate_limited',
  MAGNET_TOO_MANY: 'provider_rate_limited',
  MAGNET_PROCESSING_COOLDOWN: 'provider_rate_limited',
  MAGNET_INVALID_ID: 'not_found',
  MAINTENANCE: 'provider_unreachable',
  LINK_HOST_UNAVAILABLE: 'provider_unreachable',
  // Datacenter / VPN IPs are refused.
  NO_SERVER: 'provider_error',
  MAGNET_NO_SERVER: 'provider_error',
};

/** statusCode 5 and above are errors. */
const STATUS_ERRORS: Record<number, ErrorCode> = {
  7: 'torrent_dead',
  8: 'torrent_too_big',
  11: 'torrent_dead',
  14: 'torrent_dead',
  15: 'torrent_dead',
};

const toError = (error: { code: string; message?: string }) =>
  new AppError(
    ERRORS[error.code] ?? 'provider_error',
    `${error.code}: ${error.message ?? ''}`.trim(),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const AGENT = 'syno-debrid';
const TIMEOUT_MS = 30_000;

export class AllDebrid implements DebridProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  private async call<T>(path: string, body?: URLSearchParams | FormData): Promise<T> {
    const url = `${this.baseUrl}/${path}?agent=${AGENT}`;
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': AGENT },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // A reply cut short is a network error too.
      text = await response.text();
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      log.debug(`Request failed: ${redact(url)}`, cause ?? error);
      throw new AppError('provider_unreachable', cause?.message ?? (error as Error).message);
    }
    log.debug(`POST ${redact(url)} → ${response.status}`);
    let data: Envelope<T> | null = null;
    try {
      data = JSON.parse(text) as Envelope<T>;
    } catch {
      // Not JSON (empty, an error page): the status says what happened.
    }
    if (data?.status === 'success' && data.data !== undefined) return data.data;
    if (data?.error) throw toError(data.error);
    const { status } = response;
    // The throttle answers 503 with an empty body.
    if (status === 503) throw new AppError('provider_rate_limited', 'HTTP 503');
    if (status === 401 || status === 403) throw new AppError('provider_auth');
    if (status === 429) throw new AppError('provider_rate_limited');
    if (status >= 500) throw new AppError('provider_unreachable', `HTTP ${status}`);
    throw new AppError('provider_error', `HTTP ${status}`);
  }

  async account(): Promise<ProviderAccount> {
    const { user } = await this.call<{
      user: { username: string; isPremium: boolean; premiumUntil?: number | string };
    }>('v4/user');
    const until = Number(user.premiumUntil ?? 0);
    return {
      username: user.username,
      premium: !!user.isPremium,
      premiumUntil: user.isPremium && until > 0 ? until * 1000 : null,
    };
  }

  private added(
    item: (ItemError & { id?: number | string; name?: string }) | undefined,
  ): AddedTorrent {
    if (!item) throw new AppError('provider_error', 'Empty response');
    if (item.error) throw toError(item.error);
    if (item.id === undefined) throw new AppError('provider_error', 'Missing magnet id');
    return { id: String(item.id), name: item.name && item.name !== 'noname' ? item.name : null };
  }

  async addMagnet(magnet: string): Promise<AddedTorrent> {
    const body = new URLSearchParams();
    body.append('magnets[]', magnet);
    const { magnets } = await this.call<{
      magnets: (ItemError & { id?: number; name?: string })[];
    }>('v4/magnet/upload', body);
    return this.added(magnets[0]);
  }

  async addTorrent(data: Uint8Array, fileName: string): Promise<AddedTorrent> {
    const form = new FormData();
    form.append('files[]', new Blob([data], { type: 'application/x-bittorrent' }), fileName);
    const { files } = await this.call<{ files: (ItemError & { id?: number; name?: string })[] }>(
      'v4/magnet/upload/file',
      form,
    );
    return this.added(files[0]);
  }

  private async magnet(id: string): Promise<MagnetStatus> {
    const { magnets } = await this.call<{ magnets: MagnetStatus | MagnetStatus[] }>(
      'v4.1/magnet/status',
      new URLSearchParams({ id }),
    );
    const magnet = Array.isArray(magnets) ? magnets[0] : magnets;
    if (!magnet) throw new AppError('not_found');
    return magnet;
  }

  async status(id: string): Promise<DebridStatus> {
    const magnet = await this.magnet(id);
    const code = magnet.statusCode;
    const size = magnet.size || null;
    const base = {
      name: magnet.filename && magnet.filename !== 'noname' ? magnet.filename : null,
      size,
      detail: magnet.status ?? null,
      seeders: magnet.seeders ?? null,
    };
    if (code === 4) return { ...base, state: 'ready', progress: 1, speed: null, seeders: null };
    if (code >= 5) {
      return {
        ...base,
        state: 'error',
        progress: null,
        speed: null,
        error: new AppError(STATUS_ERRORS[code] ?? 'torrent_failed', magnet.status),
      };
    }
    if (code === 0)
      return { ...base, state: 'queued', progress: null, speed: null, detail: 'queued' };
    if (code === 1) {
      return {
        ...base,
        state: 'downloading',
        progress: size ? (magnet.downloaded ?? 0) / size : null,
        speed: magnet.downloadSpeed ?? null,
      };
    }
    // 2: compressing / moving, 3: uploading to AllDebrid's storage.
    return {
      ...base,
      state: 'processing',
      progress: code === 3 && size ? (magnet.uploaded ?? 0) / size : null,
      speed: code === 3 ? (magnet.uploadSpeed ?? null) : null,
      seeders: null,
    };
  }

  async files(id: string): Promise<DebridContent> {
    const body = new URLSearchParams();
    body.append('id[]', id);
    const { magnets } = await this.call<{ magnets: (ItemError & { files?: TreeNode[] })[] }>(
      'v4/magnet/files',
      body,
    );
    const entry = magnets[0];
    if (entry?.error) throw toError(entry.error);
    const tree = entry?.files ?? [];

    const walk = (nodes: TreeNode[], prefix: string[]): DebridFile[] =>
      nodes.flatMap((node) =>
        node.e
          ? walk(node.e, [...prefix, node.n])
          : node.l
            ? [{ path: [...prefix, node.n].join('/'), size: node.s ?? 0, ref: node.l }]
            : [],
      );

    // A single top-level folder is the torrent's root folder.
    const root = tree.length === 1 ? tree[0] : undefined;
    if (root?.e) return { name: root.n, multiFile: true, files: walk(root.e, []) };
    if (root) return { name: root.n, multiFile: false, files: walk(tree, []) };
    const name = (await this.magnet(id)).filename ?? id;
    return { name, multiFile: true, files: walk(tree, []) };
  }

  async unlock(file: DebridFile): Promise<string> {
    const data = await this.call<{ link?: string; delayed?: number }>(
      'v4/link/unlock',
      new URLSearchParams({ link: file.ref }),
    );
    if (data.link) return data.link;
    if (!data.delayed) throw new AppError('provider_error', 'No link returned');

    // Some links are generated asynchronously.
    for (let attempt = 0; attempt < 24; attempt++) {
      await sleep(5000);
      const delayed = await this.call<{ status: number; link?: string }>(
        'v4/link/delayed',
        new URLSearchParams({ id: String(data.delayed) }),
      );
      if (delayed.status === 2 && delayed.link) return delayed.link;
      if (delayed.status === 3) throw new AppError('provider_error', 'Link generation failed');
    }
    throw new AppError('provider_unreachable', 'Link generation timed out');
  }

  async delete(id: string): Promise<void> {
    await this.call('v4/magnet/delete', new URLSearchParams({ id }));
  }
}
