import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../src/server/events.js';
import { JobManager, type JobsFile } from '../src/server/jobs.js';
import { NasConnection } from '../src/server/nas-connection.js';
import { defaultSettings, Settings, type StoredSettings } from '../src/server/settings.js';
import { JsonFile } from '../src/server/storage.js';
import { FakeProvider } from './mocks/fake-provider.js';
import { createMockDsm } from './mocks/synology.js';
import { listen } from './serve.js';

let clock = 1_000_000;
const dsm = createMockDsm({
  users: { paul: { password: 'pw' } },
  speed: 1000,
  now: () => clock,
});
let server: Awaited<ReturnType<typeof listen>>;

beforeAll(async () => {
  server = await listen(dsm.app);
});
afterAll(() => server.close());

function setup(options = { createSubfolder: true, deleteFromDebrid: false }) {
  const dir = mkdtempSync(join(tmpdir(), 'dds-'));
  const settings = new Settings(
    new JsonFile<StoredSettings>(join(dir, 'settings.json'), defaultSettings),
  );
  const nas = new NasConnection(settings, randomBytes(32));
  const provider = new FakeProvider();
  const jobs = new JobManager({
    file: new JsonFile<JobsFile>(join(dir, 'jobs.json'), () => ({ jobs: [] })),
    nas,
    events: new EventHub(),
    provider: () => provider,
    options: () => options,
  });
  /** A download of the next torrent of the fake debrid service. */
  const add = async () =>
    jobs.create({
      provider: 'alldebrid',
      debridId: (await provider.addMagnet()).id,
      name: 'x',
      category,
    });
  return { jobs, nas, provider, add };
}

/** Sets up Download Station with the NAS account. */
const connect = (nas: NasConnection, password = 'pw') =>
  nas.configure({ url: server.url, account: 'paul', password, insecureTls: false });

const logins = () => dsm.state.logins;

const category = { name: 'Séries', icon: 'tv' as const, destination: 'video/Séries' };

async function run(jobs: JobManager, times = 1) {
  for (let i = 0; i < times; i++) {
    for (const job of jobs.list()) job.nextCheckAt = 0;
    await jobs.tick();
  }
}

describe('JobManager', () => {
  beforeEach(() => {
    clock += 100_000;
  });

  it('takes a torrent from the debrid service to Download Station', async () => {
    const { jobs, nas, provider, add } = setup();
    await connect(nas);
    provider.nextPolls = 1;
    const job = await add();

    await run(jobs);
    expect(job.status).toBe('debrid');
    expect(job.progress).toBe(0.5);
    expect(job.seeders).toBe(12);

    await run(jobs);
    expect(job.status).toBe('downloading');
    expect(job.folder).toBe('Show.S01');
    expect(job.files.map((file) => file.taskId)).toEqual([
      expect.stringMatching(/^dbid_/),
      expect.stringMatching(/^dbid_/),
    ]);
    expect(dsm.folders.has('/video/séries/show.s01')).toBe(true);
    const created = [...dsm.tasks.values()].filter((task) =>
      job.files.some((f) => f.taskId === task.id),
    );
    expect(created.every((task) => task.destination === 'video/Séries/Show.S01')).toBe(true);

    clock += 1500; // ~half of the second file
    await run(jobs);
    expect(job.status).toBe('downloading');
    expect(job.files[0]!.status).toBe('completed');
    expect(job.progress).toBeGreaterThan(0.3);
    expect(job.progress).toBeLessThan(1);

    clock += 5000;
    await run(jobs);
    expect(job.status).toBe('completed');
    expect(job.progress).toBe(1);
    expect(jobs.toView(job).destination).toBe('video/Séries/Show.S01');
  });

  it('fails when the debrid service reports a dead torrent', async () => {
    const { jobs, provider, add } = setup();
    provider.nextDead = true;
    const job = await add();
    await run(jobs);
    expect(job.status).toBe('error');
    expect(job.error?.code).toBe('torrent_dead');
  });

  it('waits for Download Station to be set up, then goes on', async () => {
    const { jobs, nas, provider, add } = setup();
    provider.nextContent = {
      name: 'Movie.mkv',
      multiFile: false,
      files: [{ path: 'Movie.mkv', size: 10, ref: 'm' }],
    };
    const job = await add();
    await run(jobs);
    expect(job.status).toBe('waiting_nas');

    await connect(nas);
    jobs.resume();
    await jobs.tick();
    expect(job.status).toBe('downloading');
    expect(job.folder).toBeNull();
    expect(dsm.tasks.get(job.files[0]!.taskId!)?.destination).toBe('video/Séries');
  });

  it('logs in to DSM again when it drops the session', async () => {
    const { jobs, nas, add } = setup();
    await connect(nas);
    const job = await add();
    // DSM drops its sessions (after 7 days, or a reboot): the download goes on by itself.
    const before = logins();
    dsm.expireSessions();
    await run(jobs);
    expect(job.status).toBe('downloading');
    expect(logins() - before).toBe(1);
  });

  it('waits when DSM refuses the stored password, without trying it again', async () => {
    const { jobs, nas, add } = setup();
    await connect(nas);
    dsm.users.paul!.password = 'changed';
    try {
      dsm.expireSessions();
      const job = await add();
      const before = logins();
      await run(jobs, 3);
      expect(job.status).toBe('waiting_nas');
      // Failed logins get the IP blocked by DSM: the refused password is tried once.
      expect(logins() - before).toBe(1);

      // The new password, entered in Settings: the download goes on.
      await connect(nas, 'changed');
      jobs.resume();
      await jobs.tick();
      expect(job.status).toBe('downloading');
    } finally {
      dsm.users.paul!.password = 'pw';
    }
  });

  it('retries failed downloads with fresh links', async () => {
    const { jobs, nas, provider, add } = setup({ createSubfolder: true, deleteFromDebrid: true });
    await connect(nas);
    const job = await add();
    await run(jobs);
    const [first, second] = job.files;
    dsm.tasks.get(first!.taskId!)!.fail = 'broken_link';
    clock += 10_000;
    await run(jobs);
    expect(job.status).toBe('error');
    expect(job.error).toEqual({ code: 'download_failed', message: 'broken_link' });

    const oldTask = first!.taskId;
    jobs.retry(job.id);
    expect(job.status).toBe('sending');
    await run(jobs);
    expect(job.status).toBe('downloading');
    expect(first!.taskId).not.toBe(oldTask);
    expect(second!.status).toBe('completed');

    clock += 10_000;
    await run(jobs);
    expect(job.status).toBe('completed');
    // deleteFromDebrid: cleaned up once downloaded.
    expect(provider.torrents.get(job.debridId)?.deleted).toBe(true);
  });

  it('cancels a job on Download Station and the debrid service', async () => {
    const { jobs, nas, provider, add } = setup();
    await connect(nas);
    const job = await add();
    await run(jobs);
    const taskIds = job.files.map((file) => file.taskId!);
    await jobs.remove(job.id, true);
    expect(jobs.list()).not.toContain(job);
    expect(taskIds.every((id) => dsm.tasks.get(id)?.deleted)).toBe(true);
    expect(provider.torrents.get(job.debridId)?.deleted).toBe(true);
  });

  it('renames a downloaded file only from a plain file name', async () => {
    const { jobs, nas, provider, add } = setup();
    await connect(nas);
    // Links that do not end with the file name: Download Station names the files after them.
    const titles: Record<string, string> = { l1: 'dl?id=1', l2: '../../photo/secret.jpg' };
    provider.unlock = async (file) =>
      `https://cdn.example/${encodeURIComponent(titles[file.ref]!)}?size=${file.size}`;
    const renamed = dsm.state.renamed.length;
    const job = await add();

    await run(jobs, 2);
    clock += 10_000;
    await run(jobs);
    expect(job.status).toBe('completed');
    // The second name holds a path: that file is left as it is.
    expect(dsm.state.renamed.slice(renamed)).toEqual([
      '/video/Séries/Show.S01/dl?id=1 -> Show.S01E01.mkv',
    ]);
  });

  it('clears finished jobs but keeps failed ones', async () => {
    const { jobs, provider, add } = setup();
    provider.nextDead = true;
    const failed = await add();
    await run(jobs);
    expect(failed.status).toBe('error');
    const done = jobs.create({
      provider: 'alldebrid',
      debridId: 'y',
      name: 'y',
      category,
    });
    done.status = 'completed';
    jobs.clearFinished();
    expect(jobs.list()).toEqual([failed]);
  });
});
