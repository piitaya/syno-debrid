/** Builds bencoded data, to craft .torrent files in tests. */
export function bencode(value: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const write = (text: string) => parts.push(encoder.encode(text));

  const encode = (item: unknown): void => {
    if (typeof item === 'number') {
      write(`i${Math.trunc(item)}e`);
    } else if (typeof item === 'string') {
      const bytes = encoder.encode(item);
      write(`${bytes.length}:`);
      parts.push(bytes);
    } else if (item instanceof Uint8Array) {
      write(`${item.length}:`);
      parts.push(item);
    } else if (Array.isArray(item)) {
      write('l');
      item.forEach(encode);
      write('e');
    } else if (item && typeof item === 'object') {
      write('d');
      for (const key of Object.keys(item).sort()) {
        encode(key);
        encode((item as Record<string, unknown>)[key]);
      }
      write('e');
    } else {
      throw new Error(`Cannot bencode ${String(item)}`);
    }
  };
  encode(value);

  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function makeTorrent(name: string, files?: { path: string[]; length: number }[]) {
  const info = files
    ? { name, 'piece length': 16384, pieces: 'x'.repeat(20), files }
    : { name, 'piece length': 16384, pieces: 'x'.repeat(20), length: 1234 };
  return bencode({ announce: 'udp://tracker.example:1337', info });
}
