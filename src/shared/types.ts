/** API contract shared by the server and the web app. */

export const PROVIDER_IDS = ['alldebrid'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDERS: Record<ProviderId, { name: string; apiKeyUrl: string }> = {
  alldebrid: { name: 'AllDebrid', apiKeyUrl: 'https://alldebrid.com/apikeys/' },
};

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);

export const CATEGORY_ICONS = [
  'movie',
  'tv',
  'anime',
  'kids',
  'documentary',
  'music',
  'book',
  'game',
  'app',
  'sport',
  'star',
  'download',
  'folder',
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

export interface Category {
  id: string;
  name: string;
  icon: CategoryIcon;
  /** Download Station destination: shared folder + sub path, without leading slash (`video/Films`). */
  destination: string;
}

export interface ProviderState {
  id: ProviderId;
  configured: boolean;
}

/** Connection to Download Station: the DSM account the downloads are made with. */
export interface NasSettings {
  /** DSM address as seen from the container (`http://192.168.1.10:5000`). */
  url: string;
  account: string;
  /** Accept a self-signed certificate (HTTPS). */
  insecureTls: boolean;
}

/** New connection to Download Station: it is tested (a DSM login) before being saved. */
export interface NasUpdate extends NasSettings {
  password: string;
  /** 2FA code, when DSM asks for it (once: the app then is a trusted device). */
  otp?: string;
}

export interface AppSettings {
  /** Null until Download Station is set up. */
  nas: NasSettings | null;
  providers: ProviderState[];
  categories: Category[];
  /** Put multi-file torrents in their own folder (like a BitTorrent client does). */
  createSubfolder: boolean;
  /** Remove the torrent from the debrid account once Download Station has finished. */
  deleteFromDebrid: boolean;
}

export interface SettingsUpdate {
  categories?: Category[];
  createSubfolder?: boolean;
  deleteFromDebrid?: boolean;
  /** New API keys; `null` removes the stored key. */
  apiKeys?: Partial<Record<ProviderId, string | null>>;
}

export interface SessionInfo {
  /** Null when the app has no sign-in (AUTH=none: a reverse proxy authenticates). */
  username: string | null;
  version: string;
}

/**
 * Answer of GET /api/session and POST /api/login. Being signed out is an answer and not an
 * error: the browser does not report it as a failed request.
 */
export interface SessionStatus {
  session: SessionInfo | null;
  /** Why there is no session: it ended, or the app has no account yet (first start). */
  reason?: 'unauthorized' | 'setup_required';
}

/** First start: the app's account. */
export interface SetupRequest {
  username: string;
  password: string;
}

/** Shortest password of the app's account. */
export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordChange {
  current: string;
  password: string;
}

/**
 * Answer of an action whose failure is an expected outcome (a refused API key or DSM login, a
 * wrong password), not an HTTP error.
 */
export type Outcome<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: ErrorInfo };

export interface ProviderAccount {
  username: string;
  premium: boolean;
  /** Epoch milliseconds, when known. */
  premiumUntil: number | null;
}

/** POST /api/providers/:id/test */
export type ProviderTestResult = Outcome<{ account: ProviderAccount }>;

/** PUT /api/nas */
export type NasSaveResult = Outcome<{ settings: AppSettings }>;

export interface FolderEntry {
  name: string;
  /** Download Station path format (`video/Films`). */
  path: string;
}

export interface FolderListing {
  /** Listed folder, or null for the list of shared folders. */
  path: string | null;
  /** False when the folder does not exist on the NAS (then it has no subfolders). */
  exists: boolean;
  folders: FolderEntry[];
}

export type ErrorCode =
  // App account
  | 'unauthorized'
  | 'invalid_credentials'
  | 'wrong_password'
  | 'weak_password'
  | 'too_many_attempts'
  // DSM login
  | 'otp_required'
  | 'otp_invalid'
  | 'otp_setup_required'
  | 'no_permission'
  | 'file_station_denied'
  | 'account_disabled'
  | 'password_expired'
  | 'ip_blocked'
  // NAS
  | 'nas_not_configured'
  | 'nas_login_failed'
  | 'nas_session_expired'
  | 'nas_unreachable'
  | 'nas_certificate'
  | 'nas_error'
  | 'download_station_unavailable'
  // Generic
  | 'forbidden'
  | 'invalid_request'
  | 'not_found'
  | 'internal'
  // Debrid
  | 'provider_not_configured'
  | 'provider_auth'
  | 'provider_premium'
  | 'provider_rate_limited'
  | 'provider_unreachable'
  | 'provider_error'
  | 'magnet_invalid'
  | 'torrent_invalid'
  | 'torrent_dead'
  | 'torrent_too_big'
  | 'torrent_failed'
  // Download Station
  | 'category_missing'
  | 'destination_denied'
  | 'destination_missing'
  | 'folder_failed'
  | 'download_failed'
  | 'task_removed';

export interface ErrorInfo {
  code: ErrorCode;
  /** Raw message from the NAS or the debrid service, for details. */
  message?: string;
}

export type JobStatus =
  /** The debrid service is fetching the torrent. */
  | 'debrid'
  /** Links are being unlocked and sent to Download Station. */
  | 'sending'
  /** Download Station refuses the stored login: waits for its settings to be fixed. */
  | 'waiting_nas'
  /** Download Station is downloading the files. */
  | 'downloading'
  | 'completed'
  | 'error'
  | 'cancelled';

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  'debrid',
  'sending',
  'waiting_nas',
  'downloading',
];

export type JobFileStatus =
  'pending' | 'queued' | 'downloading' | 'completed' | 'error' | 'removed';

export interface JobFileView {
  path: string;
  size: number;
  status: JobFileStatus;
  progress: number | null;
}

export interface JobView {
  id: string;
  name: string;
  provider: ProviderId;
  categoryName: string | null;
  categoryIcon: CategoryIcon | null;
  destination: string;
  status: JobStatus;
  size: number | null;
  /** Progress of the current phase, between 0 and 1. */
  progress: number | null;
  /** Bytes per second. */
  speed: number | null;
  seeders: number | null;
  /** Raw status label from the debrid service (queued, downloading…). */
  detail: string | null;
  error: ErrorInfo | null;
  files: JobFileView[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type AddJobResult =
  { ok: true; job: JobView } | { ok: false; input: string; error: ErrorInfo };

export interface AddJobsResponse {
  results: AddJobResult[];
}

/** Server-sent events emitted on `/api/events`. */
export interface ServerEvents {
  snapshot: { jobs: JobView[] };
  job: JobView;
  'job-removed': { id: string };
}
