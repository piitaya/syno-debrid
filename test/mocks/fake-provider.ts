import { AppError } from '../../src/server/errors.js';
import type {
  AddedTorrent,
  DebridContent,
  DebridFile,
  DebridProvider,
  DebridStatus,
} from '../../src/server/debrid/types.js';
import type { ProviderAccount } from '../../src/shared/types.js';

interface FakeTorrent {
  content: DebridContent;
  /** Number of status polls before the torrent is ready. */
  pollsLeft: number;
  dead: boolean;
  deleted: boolean;
}

/** In-memory debrid service for job manager tests. */
export class FakeProvider implements DebridProvider {
  readonly torrents = new Map<string, FakeTorrent>();
  nextContent: DebridContent = {
    name: 'Show.S01',
    multiFile: true,
    files: [
      { path: 'Show.S01E01.mkv', size: 1000, ref: 'l1' },
      { path: 'Show.S01E02.mkv', size: 2000, ref: 'l2' },
    ],
  };
  nextPolls = 0;
  nextDead = false;
  private counter = 0;

  async account(): Promise<ProviderAccount> {
    return { username: 'fake', premium: true, premiumUntil: null };
  }

  private add(): AddedTorrent {
    const id = String(++this.counter);
    this.torrents.set(id, {
      content: this.nextContent,
      pollsLeft: this.nextPolls,
      dead: this.nextDead,
      deleted: false,
    });
    return { id, name: this.nextContent.name };
  }

  async addMagnet(): Promise<AddedTorrent> {
    return this.add();
  }

  async addTorrent(): Promise<AddedTorrent> {
    return this.add();
  }

  async status(id: string): Promise<DebridStatus> {
    const torrent = this.torrents.get(id);
    if (!torrent) throw new AppError('not_found');
    const base = { name: torrent.content.name, size: 3000, speed: null, seeders: null };
    if (torrent.dead) {
      return {
        ...base,
        state: 'error',
        progress: null,
        detail: 'dead',
        error: new AppError('torrent_dead'),
      };
    }
    if (torrent.pollsLeft > 0) {
      torrent.pollsLeft--;
      return {
        ...base,
        state: 'downloading',
        progress: 0.5,
        speed: 1000,
        seeders: 12,
        detail: 'downloading',
      };
    }
    return { ...base, state: 'ready', progress: 1, detail: 'ready' };
  }

  async files(id: string): Promise<DebridContent> {
    return this.torrents.get(id)!.content;
  }

  async unlock(file: DebridFile): Promise<string> {
    return `https://cdn.example/dl/${file.ref}/${encodeURIComponent(file.path.split('/').pop()!)}?size=${file.size}`;
  }

  async delete(id: string): Promise<void> {
    const torrent = this.torrents.get(id);
    if (torrent) torrent.deleted = true;
  }
}
