import { randomUUID } from 'node:crypto';
import {
  ACTIVE_JOB_STATUSES,
  type CategoryIcon,
  type ErrorInfo,
  type JobFileStatus,
  type JobStatus,
  type JobView,
  type ProviderId,
} from '../shared/types.js';
import type { DebridProvider } from './debrid/types.js';
import { AppError, toErrorInfo } from './errors.js';
import type { EventHub } from './events.js';
import { log } from './logger.js';
import { NasLoginError, type NasConnection } from './nas-connection.js';
import { NasSessionError, type DsTask } from './nas/types.js';
import { basename, dirname, isPlainName, joinPath, planDownload } from './paths.js';
import type { JsonFile } from './storage.js';

export interface JobFile {
  /** Relative to the category folder. */
  path: string;
  size: number;
  ref: string;
  /** Direct link handed to Download Station. */
  url: string | null;
  taskId: string | null;
  status: JobFileStatus;
  downloaded: number;
  speed: number;
  error: string | null;
}

export interface Job {
  id: string;
  provider: ProviderId;
  debridId: string;
  name: string;
  categoryName: string;
  categoryIcon: CategoryIcon;
  /** Category folder (Download Station path). */
  destination: string;
  /** Folder created for this torrent inside the category folder, if any. */
  folder: string | null;
  status: JobStatus;
  /** Step to resume from when retrying a failed job. */
  phase: 'debrid' | 'sending' | 'downloading';
  size: number | null;
  progress: number | null;
  speed: number | null;
  seeders: number | null;
  detail: string | null;
  error: ErrorInfo | null;
  files: JobFile[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  nextCheckAt: number;
  /** Consecutive transient failures. */
  failures: number;
}

export interface JobsFile {
  jobs: Job[];
}

export interface NewJob {
  provider: ProviderId;
  debridId: string;
  name: string;
  category: { name: string; icon: CategoryIcon; destination: string };
}

export interface JobDeps {
  file: JsonFile<JobsFile>;
  nas: NasConnection;
  events: EventHub;
  provider: (id: ProviderId) => DebridProvider;
  options: () => { createSubfolder: boolean; deleteFromDebrid: boolean };
}

const TICK_MS = 1000;
const MAX_FAILURES = 30;
const MAX_JOBS = 300;
const FINISHED_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Errors worth retrying later (network hiccups, rate limits, busy services). */
const TRANSIENT_CODES = new Set([
  'provider_unreachable',
  'provider_rate_limited',
  'nas_unreachable',
]);

const isActive = (job: Job) => ACTIVE_JOB_STATUSES.includes(job.status);

function fileStatusFromTask(task: DsTask): JobFileStatus {
  switch (task.status) {
    case 'finished':
    case 'seeding':
      return 'completed';
    case 'error':
      return 'error';
    case 'waiting':
    case 'filehosting_waiting':
      return 'queued';
    default:
      return 'downloading';
  }
}

export class JobManager {
  private timer: NodeJS.Timeout | null = null;
  private readonly busy = new Set<string>();

  constructor(private readonly deps: JobDeps) {
    this.prune();
  }

  private get jobs(): Job[] {
    return this.deps.file.data.jobs;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): Job[] {
    return this.jobs;
  }

  get(id: string): Job {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new AppError('not_found');
    return job;
  }

  create(input: NewJob): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      provider: input.provider,
      debridId: input.debridId,
      name: input.name,
      categoryName: input.category.name,
      categoryIcon: input.category.icon,
      destination: input.category.destination,
      folder: null,
      status: 'debrid',
      phase: 'debrid',
      size: null,
      progress: null,
      speed: null,
      seeders: null,
      detail: null,
      error: null,
      files: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      nextCheckAt: now,
      failures: 0,
    };
    this.jobs.unshift(job);
    this.prune();
    this.changed(job);
    return job;
  }

  retry(id: string): Job {
    const job = this.get(id);
    if (job.status !== 'error') return job;
    job.error = null;
    job.failures = 0;
    job.finishedAt = null;
    if (job.phase === 'downloading') {
      // Failed files get a fresh link: debrid links may have expired.
      const failed = job.files.filter((file) => file.status === 'error');
      const ids = failed.map((file) => file.taskId).filter((taskId): taskId is string => !!taskId);
      if (ids.length) {
        this.deps.nas.run((client, sid) => client.deleteTasks(sid, ids)).catch(() => undefined);
      }
      for (const file of failed) {
        Object.assign(file, {
          url: null,
          taskId: null,
          status: 'pending',
          downloaded: 0,
          speed: 0,
          error: null,
        });
      }
      job.phase = 'sending';
    }
    job.status = job.phase;
    job.nextCheckAt = Date.now();
    this.changed(job);
    return job;
  }

  /** Removes a job. With `cancel`, also stops it on the debrid service and Download Station. */
  async remove(id: string, cancel: boolean): Promise<void> {
    const job = this.get(id);
    this.deps.file.data.jobs = this.jobs.filter((item) => item !== job);
    this.deps.file.save();
    this.deps.events.emit('job-removed', { id });

    if (!cancel) return;
    const running = job.files
      .filter((file) => file.taskId && file.status !== 'completed')
      .map((file) => file.taskId!);
    if (running.length) {
      await this.deps.nas
        .run((client, sid) => client.deleteTasks(sid, running))
        .catch((error: unknown) =>
          log.warn(`Could not delete Download Station tasks`, toErrorInfo(error)),
        );
    }
    await this.deleteFromDebrid(job);
  }

  /** Removes completed and cancelled jobs (failed ones stay, to be retried or removed). */
  clearFinished(): void {
    const removed = this.jobs.filter(
      (job) => job.status === 'completed' || job.status === 'cancelled',
    );
    if (!removed.length) return;
    this.deps.file.data.jobs = this.jobs.filter((job) => !removed.includes(job));
    this.deps.file.save();
    for (const job of removed) this.deps.events.emit('job-removed', { id: job.id });
  }

  /** Runs the waiting jobs now, e.g. once Download Station is set up again. */
  resume(): void {
    for (const job of this.jobs) {
      if (isActive(job)) job.nextCheckAt = Date.now();
    }
  }

  toView(job: Job): JobView {
    return {
      id: job.id,
      name: job.name,
      provider: job.provider,
      categoryName: job.categoryName,
      categoryIcon: job.categoryIcon,
      destination: joinPath(job.destination, job.folder),
      status: job.status,
      size: job.size,
      progress: job.progress,
      speed: job.speed,
      seeders: job.seeders,
      detail: job.detail,
      error: job.error,
      files: job.files.map((file) => ({
        // Relative to `destination`, which already includes the torrent folder.
        path:
          job.folder && file.path.startsWith(`${job.folder}/`)
            ? file.path.slice(job.folder.length + 1)
            : file.path,
        size: file.size,
        status: file.status,
        progress: file.size > 0 ? Math.min(1, file.downloaded / file.size) : null,
      })),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
    };
  }

  private changed(job: Job): void {
    // Removed while being processed: do not bring it back in the web app.
    if (!this.jobs.includes(job)) return;
    job.updatedAt = Date.now();
    this.deps.file.save();
    this.deps.events.emit('job', this.toView(job));
  }

  private prune(): void {
    const now = Date.now();
    let count = 0;
    const kept = this.jobs.filter((job) => {
      if (isActive(job)) return true;
      if (job.finishedAt && now - job.finishedAt > FINISHED_RETENTION_MS) return false;
      return ++count <= MAX_JOBS;
    });
    if (kept.length !== this.jobs.length) {
      this.deps.file.data.jobs = kept;
      this.deps.file.save();
    }
  }

  /**
   * Runs the jobs that are due. Jobs still being processed (a long pack being sent) are
   * skipped, so they never hold the others back. Resolves once the started jobs are done.
   */
  async tick(): Promise<void> {
    const now = Date.now();
    const due = this.jobs.filter(
      (job) => isActive(job) && job.nextCheckAt <= now && !this.busy.has(job.id),
    );
    await Promise.all(due.map((job) => this.process(job)));
  }

  private async process(job: Job): Promise<void> {
    this.busy.add(job.id);
    try {
      if (job.status === 'debrid') await this.checkDebrid(job);
      if (job.status === 'sending' || job.status === 'waiting_nas') await this.send(job);
      else if (job.status === 'downloading') await this.checkDownloads(job);
      job.failures = 0;
    } catch (error) {
      this.handleError(job, error);
    } finally {
      this.busy.delete(job.id);
    }
  }

  private handleError(job: Job, error: unknown): void {
    if (error instanceof NasLoginError) {
      // Waits for Download Station's settings to be fixed. Meanwhile, Download Station goes on
      // with the files it already has.
      if (job.status === 'sending') {
        job.status = 'waiting_nas';
        this.changed(job);
      }
      job.nextCheckAt = Date.now() + 30_000;
      return;
    }
    if (error instanceof NasSessionError) {
      // DSM dropped the new session too: tried again in a moment.
      job.nextCheckAt = Date.now() + 5000;
      return;
    }
    const info = toErrorInfo(error);
    const transient = !(error instanceof AppError) || TRANSIENT_CODES.has(info.code);
    job.failures++;
    if (transient && job.failures < MAX_FAILURES) {
      log.warn(`Job "${job.name}": ${info.code} (${info.message ?? ''}), retrying`);
      job.nextCheckAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(job.failures, 5));
      return;
    }
    log.warn(`Job "${job.name}" failed: ${info.code} ${info.message ?? ''}`);
    this.fail(job, info);
  }

  private fail(job: Job, error: ErrorInfo): void {
    job.phase =
      job.status === 'debrid' ? 'debrid' : job.status === 'downloading' ? 'downloading' : 'sending';
    job.status = 'error';
    job.error = error;
    job.speed = null;
    job.finishedAt = Date.now();
    this.changed(job);
  }

  /** Polls faster when someone is looking at the app. */
  private delay(idle: number, watched: number): number {
    return this.deps.events.isWatching() ? watched : idle;
  }

  private async checkDebrid(job: Job): Promise<void> {
    const status = await this.deps.provider(job.provider).status(job.debridId);
    if (status.name) job.name = status.name;
    if (status.size) job.size = status.size;
    job.progress = status.progress;
    job.speed = status.speed;
    job.seeders = status.seeders;
    job.detail = status.detail;

    if (status.state === 'error') {
      this.fail(job, (status.error ?? new AppError('torrent_failed')).toInfo());
      return;
    }
    if (status.state === 'ready') {
      job.status = 'sending';
      job.progress = null;
      job.speed = null;
      job.seeders = null;
      job.detail = null;
      this.changed(job);
      return;
    }
    const age = Date.now() - job.createdAt;
    const idle = age < 120_000 ? 3000 : age < 600_000 ? 10_000 : 30_000;
    job.nextCheckAt = Date.now() + this.delay(idle, Math.min(idle, 4000));
    this.changed(job);
  }

  private async send(job: Job): Promise<void> {
    const nas = this.deps.nas;
    // Links are only unlocked once Download Station can take them.
    await nas.session();
    if (job.status === 'waiting_nas') {
      job.status = 'sending';
      this.changed(job);
    }

    const provider = this.deps.provider(job.provider);
    if (job.files.length === 0) {
      const content = await provider.files(job.debridId);
      const plan = planDownload(content, this.deps.options().createSubfolder);
      job.folder = plan.folder;
      job.files = plan.files.map((file) => ({
        ...file,
        url: null,
        taskId: null,
        status: 'pending',
        downloaded: 0,
        speed: 0,
        error: null,
      }));
      job.size = job.files.reduce((sum, file) => sum + file.size, 0) || job.size;
      this.changed(job);
    }

    const pending = job.files.filter((file) => file.status === 'pending');
    const folderOf = (file: JobFile) => joinPath(job.destination, dirname(file.path));
    const folders = [...new Set(pending.map(folderOf))].filter((f) => f !== job.destination);
    if (folders.length) await nas.run((client, sid) => client.createFolders(sid, folders));

    // One file at a time: links are generated just before Download Station gets them, and
    // what was already sent is kept if something fails halfway.
    for (const file of pending) {
      // Cancelled meanwhile.
      if (!this.jobs.includes(job)) return;
      const url = await provider.unlock({ path: file.path, size: file.size, ref: file.ref });
      const taskId = await nas.run((client, sid) =>
        client.createDownloadTask(sid, url, folderOf(file)),
      );
      file.url = url;
      file.taskId = taskId;
      file.status = 'queued';
      this.changed(job);
    }

    job.status = 'downloading';
    job.phase = 'downloading';
    job.progress = 0;
    job.nextCheckAt = Date.now() + 2000;
    this.changed(job);
  }

  private async checkDownloads(job: Job): Promise<void> {
    const tasks = await this.deps.nas.run((client, sid) => client.listTasks(sid));
    const byId = new Map(tasks.map((task) => [task.id, task]));

    for (const file of job.files) {
      // Download Station did not return the task id: found by URL.
      if (!file.taskId && file.url && file.status !== 'completed') {
        file.taskId = tasks.find((task) => task.uri === file.url)?.id ?? null;
      }
      const task = file.taskId ? byId.get(file.taskId) : undefined;
      if (!task) {
        // Removed from Download Station (by hand or by its auto-clean).
        if (file.status !== 'completed') file.status = 'removed';
        file.speed = 0;
        continue;
      }
      const wasCompleted = file.status === 'completed';
      file.status = fileStatusFromTask(task);
      if (file.status === 'completed' && !wasCompleted) await this.fixFileName(job, file, task);
      file.downloaded = file.status === 'completed' ? file.size || task.size : task.downloaded;
      file.speed = file.status === 'downloading' ? task.speed : 0;
      file.error = task.error;
    }

    const total = job.files.reduce((sum, file) => sum + file.size, 0);
    const downloaded = job.files.reduce(
      (sum, file) => sum + (file.status === 'completed' ? file.size : file.downloaded),
      0,
    );
    job.progress = total > 0 ? Math.min(1, downloaded / total) : null;
    job.speed = job.files.reduce((sum, file) => sum + file.speed, 0);

    const pending = job.files.some((file) =>
      ['queued', 'downloading', 'pending'].includes(file.status),
    );
    const failed = job.files.filter((file) => file.status === 'error');
    if (!pending) {
      if (failed.length) {
        const message = [...new Set(failed.map((file) => file.error).filter(Boolean))].join(', ');
        this.fail(job, { code: 'download_failed', ...(message ? { message } : {}) });
        return;
      }
      const allRemoved = job.files.every((file) => file.status === 'removed');
      job.status = allRemoved ? 'cancelled' : 'completed';
      if (allRemoved) job.error = { code: 'task_removed' };
      job.speed = null;
      job.finishedAt = Date.now();
      this.changed(job);
      if (!allRemoved && this.deps.options().deleteFromDebrid) await this.deleteFromDebrid(job);
      return;
    }

    job.nextCheckAt = Date.now() + this.delay(20_000, 2500);
    this.changed(job);
  }

  /** Gives the file its expected name when Download Station picked another one. */
  private async fixFileName(job: Job, file: JobFile, task: DsTask): Promise<void> {
    const expected = basename(file.path);
    if (!task.title || task.title === expected) return;
    // The name comes from Download Station: a path in it would point outside the folder.
    if (!isPlainName(task.title)) {
      log.warn(`Not renaming "${task.title}": not a plain file name`);
      return;
    }
    const path = joinPath(job.destination, dirname(file.path), task.title);
    try {
      await this.deps.nas.run((client, sid) => client.rename(sid, path, expected));
    } catch (error) {
      log.warn(`Could not rename "${task.title}" to "${expected}"`, toErrorInfo(error));
    }
  }

  private async deleteFromDebrid(job: Job): Promise<void> {
    try {
      await this.deps.provider(job.provider).delete(job.debridId);
    } catch (error) {
      log.warn(`Could not delete "${job.name}" from ${job.provider}`, toErrorInfo(error));
    }
  }
}
