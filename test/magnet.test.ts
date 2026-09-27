import { describe, expect, it } from 'vitest';
import { extractMagnets, parseMagnet } from '../src/shared/magnet.js';

const HASH = 'c9e15763f722f23e98a29decdfae341b98d53056';

describe('parseMagnet', () => {
  it('parses a magnet with name and trackers', () => {
    const uri = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker`;
    expect(parseMagnet(uri)).toEqual({ uri, hash: HASH, name: 'Big Buck Bunny' });
  });

  it('decodes base32 info-hashes', () => {
    const magnet = parseMagnet('magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW');
    expect(magnet?.hash).toBe(HASH);
  });

  it('accepts HTML-escaped ampersands', () => {
    const magnet = parseMagnet(`magnet:?xt=urn:btih:${HASH}&amp;dn=Name`);
    expect(magnet?.name).toBe('Name');
  });

  it('rejects anything that is not a BitTorrent magnet', () => {
    expect(parseMagnet('https://example.com/file.torrent')).toBeNull();
    expect(parseMagnet('magnet:?xt=urn:ed2k:1234')).toBeNull();
    expect(parseMagnet('magnet:?dn=nohash')).toBeNull();
  });
});

describe('extractMagnets', () => {
  it('splits text, dedupes and reports invalid tokens', () => {
    const text = [
      `magnet:?xt=urn:btih:${HASH}&dn=One`,
      `magnet:?xt=urn:btih:${HASH}&dn=Duplicate`,
      'b'.repeat(40),
      'hello',
    ].join('\n   ');
    const { magnets, invalid } = extractMagnets(text);
    expect(magnets.map((m) => m.name)).toEqual(['One', null]);
    expect(magnets[1]?.uri).toBe(`magnet:?xt=urn:btih:${'b'.repeat(40)}`);
    expect(extractMagnets(HASH.toUpperCase()).magnets[0]?.uri).toBe(`magnet:?xt=urn:btih:${HASH}`);
    expect(invalid).toEqual(['hello']);
  });
});
