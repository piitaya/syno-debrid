import type { ProviderAccount } from '../../shared/types.js';
import type { AppError } from '../errors.js';

export interface AddedTorrent {
  id: string;
  name: string | null;
}

export interface DebridStatus {
  state: 'queued' | 'downloading' | 'processing' | 'ready' | 'error';
  name: string | null;
  size: number | null;
  /** Between 0 and 1. */
  progress: number | null;
  /** Bytes per second. */
  speed: number | null;
  seeders: number | null;
  /** Raw status reported by the service. */
  detail: string | null;
  error?: AppError;
}

export interface DebridFile {
  /** Path inside the torrent, relative to its root folder, with `/` separators. */
  path: string;
  size: number;
  /** Provider reference used to get the direct link (hoster link, file id…). */
  ref: string;
}

export interface DebridContent {
  /** Torrent name (root folder name for multi-file torrents). */
  name: string;
  /** Whether the torrent has a root folder (multi-file torrent). */
  multiFile: boolean;
  files: DebridFile[];
}

export interface DebridProvider {
  account(): Promise<ProviderAccount>;
  addMagnet(magnet: string): Promise<AddedTorrent>;
  addTorrent(data: Uint8Array, fileName: string): Promise<AddedTorrent>;
  status(id: string): Promise<DebridStatus>;
  /** Files of a ready torrent. */
  files(id: string): Promise<DebridContent>;
  /** Direct HTTPS download URL of a file. */
  unlock(file: DebridFile): Promise<string>;
  delete(id: string): Promise<void>;
}
