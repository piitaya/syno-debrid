import { describe, expect, it } from 'vitest';
import { isPlainName, joinPath, planDownload, sanitizeSegment } from '../src/server/paths.js';

describe('sanitizeSegment', () => {
  it('removes characters NAS shares reject', () => {
    expect(sanitizeSegment('Movie: The "Sequel" <2024>?')).toBe('Movie The Sequel 2024');
    expect(sanitizeSegment('a/b\\c')).toBe('a b c');
    expect(sanitizeSegment('trailing dots...')).toBe('trailing dots');
    expect(sanitizeSegment('..')).toBe('_');
  });
});

describe('isPlainName', () => {
  it('accepts a single name as is, and nothing that could leave its folder', () => {
    expect(isPlainName('Show.S01E01.mkv')).toBe(true);
    expect(isPlainName('dl?id=1: part "2"')).toBe(true);
    for (const name of ['', ' ', '.', '..', '../secret', 'a/b', 'a\\b', 'a\u0000b']) {
      expect(isPlainName(name)).toBe(false);
    }
  });
});

describe('planDownload', () => {
  const files = [
    { path: 'Show.S01E01.mkv', size: 10, ref: 'a' },
    { path: 'Subs/en.srt', size: 1, ref: 'b' },
  ];

  it('puts multi-file torrents in their own folder', () => {
    const plan = planDownload({ name: 'Show: S01', multiFile: true, files }, true);
    expect(plan.folder).toBe('Show S01');
    expect(plan.files.map((file) => file.path)).toEqual([
      'Show S01/Show.S01E01.mkv',
      'Show S01/Subs/en.srt',
    ]);
  });

  it('can skip the torrent folder', () => {
    const plan = planDownload({ name: 'Show', multiFile: true, files }, false);
    expect(plan.folder).toBeNull();
    expect(plan.files.map((file) => file.path)).toEqual(['Show.S01E01.mkv', 'Subs/en.srt']);
  });

  it('keeps a single file at the top', () => {
    const plan = planDownload(
      { name: 'Movie.mkv', multiFile: false, files: [{ path: 'Movie.mkv', size: 1, ref: 'x' }] },
      true,
    );
    expect(plan).toEqual({ folder: null, files: [{ path: 'Movie.mkv', size: 1, ref: 'x' }] });
  });

  it('never produces two identical paths', () => {
    const plan = planDownload(
      {
        name: 'Pack',
        multiFile: true,
        files: [
          { path: 'a?.txt', size: 1, ref: '1' },
          { path: 'a*.txt', size: 1, ref: '2' },
          { path: 'a|.txt', size: 1, ref: '3' },
        ],
      },
      true,
    );
    expect(plan.files.map((file) => file.path)).toEqual([
      'Pack/a.txt',
      'Pack/a (2).txt',
      'Pack/a (3).txt',
    ]);
  });

  it('joins paths', () => {
    expect(joinPath('video/', '/Films', null, 'a//b')).toBe('video/Films/a/b');
  });
});
