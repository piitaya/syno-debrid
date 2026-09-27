import { describe, expect, it } from 'vitest';
import { parseTorrent, TorrentParseError } from '../src/shared/torrent.js';
import { bencode, makeTorrent } from './helpers.js';

describe('parseTorrent', () => {
  it('reads a single-file torrent', () => {
    const meta = parseTorrent(makeTorrent('Movie.2024.mkv'));
    expect(meta.name).toBe('Movie.2024.mkv');
    expect(meta.files).toEqual([{ path: 'Movie.2024.mkv', size: 1234 }]);
    expect(meta.totalSize).toBe(1234);
  });

  it('reads a multi-file torrent', () => {
    const meta = parseTorrent(
      makeTorrent('Show.S01', [
        { path: ['Show.S01E01.mkv'], length: 100 },
        { path: ['Subs', 'en.srt'], length: 5 },
      ]),
    );
    expect(meta.files).toEqual([
      { path: 'Show.S01E01.mkv', size: 100 },
      { path: 'Subs/en.srt', size: 5 },
    ]);
    expect(meta.totalSize).toBe(105);
  });

  it('reads a v2 file tree', () => {
    const data = bencode({
      info: {
        name: 'Album',
        'meta version': 2,
        'piece length': 16384,
        'file tree': {
          '01.flac': { '': { length: 10, 'pieces root': 'x'.repeat(32) } },
          Covers: { 'front.jpg': { '': { length: 3 } } },
        },
      },
    });
    expect(parseTorrent(data).files).toEqual([
      { path: '01.flac', size: 10 },
      { path: 'Covers/front.jpg', size: 3 },
    ]);
  });

  it('rejects invalid data', () => {
    expect(() => parseTorrent(new TextEncoder().encode('<html>'))).toThrow(TorrentParseError);
    expect(() => parseTorrent(bencode({ foo: 1 }))).toThrow(TorrentParseError);
    expect(() => parseTorrent(new TextEncoder().encode('d4:infod'))).toThrow(TorrentParseError);
  });
});
