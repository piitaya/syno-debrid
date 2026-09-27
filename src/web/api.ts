import type {
  AddJobsResponse,
  AppSettings,
  ErrorInfo,
  FolderEntry,
  FolderListing,
  JobView,
  NasSaveResult,
  NasUpdate,
  Outcome,
  PasswordChange,
  ProviderId,
  ProviderTestResult,
  SessionStatus,
  SettingsUpdate,
  SetupRequest,
} from '../shared/types.js';

export class ApiError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message ?? info.code);
  }
}

/** What went wrong with a request (`internal` when the server could not say). */
export const errorInfo = (error: unknown): ErrorInfo =>
  error instanceof ApiError ? error.info : { code: 'internal' };

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

// Relative URLs so the app also works behind a reverse proxy sub-path.
async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'dds' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`api/${path}`, { method, headers, body: payload });
  } catch (error) {
    throw new ApiError({ code: 'internal', message: (error as Error).message });
  }

  // An empty body (204) reads as null.
  const data = (await response.json().catch(() => null)) as { error?: ErrorInfo } | null;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('dds-unauthorized'));
    throw new ApiError(data?.error ?? { code: 'internal', message: `HTTP ${response.status}` });
  }
  return data as T;
}

export const api = {
  session: () => request<SessionStatus>('GET', 'session'),
  setup: (body: SetupRequest) => request<SessionStatus>('POST', 'setup', body),
  login: (body: { username: string; password: string }) =>
    request<SessionStatus>('POST', 'login', body),
  logout: () => request<void>('POST', 'logout'),
  changePassword: (body: PasswordChange) => request<Outcome>('POST', 'account/password', body),

  testNas: () => request<Outcome>('POST', 'nas/test'),
  saveNas: (body: NasUpdate) => request<NasSaveResult>('PUT', 'nas', body),

  settings: () => request<AppSettings>('GET', 'settings'),
  updateSettings: (patch: SettingsUpdate) => request<AppSettings>('PUT', 'settings', patch),
  testProvider: (id: ProviderId, apiKey?: string) =>
    request<ProviderTestResult>('POST', `providers/${id}/test`, { apiKey }),

  folders: (path?: string) =>
    request<FolderListing>('GET', path ? `folders?path=${encodeURIComponent(path)}` : 'folders'),
  createFolder: (path: string, name: string) =>
    request<FolderEntry>('POST', 'folders', { path, name }),

  addJobs: (form: FormData) => request<AddJobsResponse>('POST', 'jobs', form),
  retryJob: (id: string) => request<JobView>('POST', `jobs/${encodeURIComponent(id)}/retry`),
  deleteJob: (id: string, cancel: boolean) =>
    request<void>('DELETE', `jobs/${encodeURIComponent(id)}${cancel ? '?cancel=1' : ''}`),
  clearJobs: () => request<void>('POST', 'jobs/clear'),
};
