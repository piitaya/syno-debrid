import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type {
  AppSettings,
  JobView,
  SessionInfo,
  SessionStatus,
  SetupRequest,
} from '../shared/types.js';
import { api } from './api.js';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

/** Application state shared by every component. */
class Store extends EventTarget {
  ready = false;
  session: SessionInfo | null = null;
  /** Why there is no session: it ended, or the app has no account yet (first start). */
  signedOutReason: SessionStatus['reason'] | null = null;
  settings: AppSettings | null = null;
  jobs: JobView[] = [];
  /** The first list of downloads has arrived (until then, an empty list means nothing). */
  jobsLoaded = false;
  /** False while the live connection to the server is down. */
  online = true;
  toasts: Toast[] = [];

  private events: EventSource | null = null;
  private toastId = 0;
  private checkingSession = false;

  constructor() {
    super();
    window.addEventListener('dds-unauthorized', () => this.checkSession());
    // Back to the foreground: the session may have ended, the live connection dropped.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.session) return;
      this.checkSession();
      if (!this.events || this.events.readyState === EventSource.CLOSED) this.connectEvents();
    });
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  async init(): Promise<void> {
    try {
      const status = await api.session();
      this.session = status.session;
      this.signedOutReason = status.reason ?? null;
      if (status.session) await this.afterLogin();
    } catch {
      // Server out of reach (being restarted…): tries again instead of asking to sign in.
      this.session = null;
      this.online = false;
      this.changed();
      setTimeout(() => void this.init(), 3000);
      return;
    }
    this.ready = true;
    this.online = true;
    this.changed();
  }

  async login(username: string, password: string): Promise<void> {
    const status = await api.login({ username, password });
    if (status.session) await this.signedIn(status.session);
    // The account was reset meanwhile.
    else this.reset(status.reason ?? null);
  }

  /** First start: creates the account, then signs in. */
  async setup(request: SetupRequest): Promise<void> {
    const status = await api.setup(request);
    if (status.session) await this.signedIn(status.session);
  }

  async logout(): Promise<void> {
    await api.logout().catch(() => undefined);
    this.reset(null);
  }

  private async signedIn(session: SessionInfo): Promise<void> {
    this.session = session;
    this.signedOutReason = null;
    await this.afterLogin();
    this.changed();
  }

  private async afterLogin(): Promise<void> {
    this.settings = await api.settings();
    this.connectEvents();
  }

  private reset(reason: SessionStatus['reason'] | null): void {
    this.events?.close();
    this.events = null;
    this.session = null;
    this.settings = null;
    this.jobs = [];
    this.jobsLoaded = false;
    this.signedOutReason = reason;
    this.changed();
  }

  /**
   * Signs out only if the server says the session is over (a request was refused, the live
   * connection closed…). A server being restarted or out of reach only means offline.
   */
  private checkSession(): void {
    if (!this.session || this.checkingSession) return;
    this.checkingSession = true;
    api
      .session()
      .then((status) => {
        if (!status.session) this.reset(status.reason ?? 'unauthorized');
      })
      .catch(() => undefined)
      .finally(() => {
        this.checkingSession = false;
      });
  }

  private connectEvents(): void {
    this.events?.close();
    const source = new EventSource('api/events');
    this.events = source;

    source.addEventListener('open', () => {
      this.online = true;
      this.changed();
    });
    source.addEventListener('snapshot', (event) => {
      this.jobs = (JSON.parse((event as MessageEvent<string>).data) as { jobs: JobView[] }).jobs;
      this.jobsLoaded = true;
      this.changed();
    });
    source.addEventListener('job', (event) => {
      this.upsertJob(JSON.parse((event as MessageEvent<string>).data) as JobView);
    });
    source.addEventListener('job-removed', (event) => {
      const { id } = JSON.parse((event as MessageEvent<string>).data) as { id: string };
      this.jobs = this.jobs.filter((job) => job.id !== id);
      this.changed();
    });
    source.addEventListener('error', () => {
      if (this.events !== source) return;
      this.online = false;
      this.changed();
      // EventSource retries by itself, unless the server answered with an error (e.g. 401).
      if (source.readyState === EventSource.CLOSED) {
        this.checkSession();
        setTimeout(() => {
          if (this.events === source && this.session) this.connectEvents();
        }, 5000);
      }
    });
  }

  upsertJob(job: JobView): void {
    const index = this.jobs.findIndex((item) => item.id === job.id);
    if (index === -1) this.jobs = [job, ...this.jobs];
    else this.jobs = this.jobs.map((item) => (item.id === job.id ? job : item));
    this.changed();
  }

  removeJobs(ids: string[]): void {
    this.jobs = this.jobs.filter((job) => !ids.includes(job.id));
    this.changed();
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
    this.changed();
  }

  toast(message: string, kind: Toast['kind'] = 'info'): void {
    const toast = { id: ++this.toastId, message, kind };
    this.toasts = [...this.toasts, toast];
    this.changed();
    setTimeout(() => this.dismissToast(toast.id), kind === 'error' ? 6000 : 3500);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
    this.changed();
  }
}

export const store = new Store();

/** Re-renders a Lit element whenever the store changes. */
export class StoreController implements ReactiveController {
  private readonly onChange = () => this.host.requestUpdate();

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    store.addEventListener('change', this.onChange);
  }

  hostDisconnected(): void {
    store.removeEventListener('change', this.onChange);
  }
}
