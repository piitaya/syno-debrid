/**
 * Minimal .torrent (bencode) reader, shared by the browser (preview before upload) and the
 * server (validation). Only what the app needs: name, files and total size.
 */

type BValue = number | Uint8Array | BValue[] | BDict;
interface BDict {
  [key: string]: BValue;
}

export interface TorrentFileEntry {
  path: string;
  size: number;
}

export interface TorrentMeta {
  name: string;
  totalSize: number;
  files: TorrentFileEntry[];
}

export class TorrentParseError extends Error {}

const decoder = new TextDecoder();
const MAX_DEPTH = 64;

class Reader {
  pos = 0;

  constructor(private readonly data: Uint8Array) {}

  private byte(): number {
    const value = this.data[this.pos];
    if (value === undefined) throw new TorrentParseError('Unexpected end of data');
    return value;
  }

  private readUntil(terminator: number): string {
    const end = this.data.indexOf(terminator, this.pos);
    if (end === -1) throw new TorrentParseError('Unterminated value');
    const text = decoder.decode(this.data.subarray(this.pos, end));
    this.pos = end + 1;
    return text;
  }

  read(depth = 0): BValue {
    if (depth > MAX_DEPTH) throw new TorrentParseError('Nesting too deep');
    const type = this.byte();

    // Integer: i<digits>e
    if (type === 0x69) {
      this.pos++;
      const text = this.readUntil(0x65);
      if (!/^-?\d+$/.test(text)) throw new TorrentParseError('Invalid integer');
      return Number(text);
    }
    // List: l<values>e
    if (type === 0x6c) {
      this.pos++;
      const list: BValue[] = [];
      while (this.byte() !== 0x65) list.push(this.read(depth + 1));
      this.pos++;
      return list;
    }
    // Dictionary: d<key><value>e
    if (type === 0x64) {
      this.pos++;
      const dict: BDict = Object.create(null) as BDict;
      while (this.byte() !== 0x65) {
        const key = decoder.decode(this.readBytes());
        dict[key] = this.read(depth + 1);
      }
      this.pos++;
      return dict;
    }
    // Byte string: <length>:<bytes>
    if (type >= 0x30 && type <= 0x39) return this.readBytes();

    throw new TorrentParseError('Invalid bencode data');
  }

  private readBytes(): Uint8Array {
    const lengthText = this.readUntil(0x3a);
    if (!/^\d+$/.test(lengthText)) throw new TorrentParseError('Invalid string length');
    const length = Number(lengthText);
    const end = this.pos + length;
    if (end > this.data.length) throw new TorrentParseError('String exceeds data');
    const bytes = this.data.subarray(this.pos, end);
    this.pos = end;
    return bytes;
  }
}

const isDict = (value: BValue | undefined): value is BDict =>
  typeof value === 'object' && !(value instanceof Uint8Array) && !Array.isArray(value);

const text = (value: BValue | undefined): string | null =>
  value instanceof Uint8Array ? decoder.decode(value) : null;

/** Walks a BitTorrent v2 `file tree`. */
function walkFileTree(tree: BDict, prefix: string[], files: TorrentFileEntry[]): void {
  for (const [name, node] of Object.entries(tree)) {
    if (!isDict(node)) continue;
    const leaf = node[''];
    if (isDict(leaf) && typeof leaf['length'] === 'number') {
      files.push({ path: [...prefix, name].join('/'), size: leaf['length'] });
    } else {
      walkFileTree(node, [...prefix, name], files);
    }
  }
}

export function parseTorrent(data: Uint8Array): TorrentMeta {
  const reader = new Reader(data);
  const root = reader.read();
  if (!isDict(root)) throw new TorrentParseError('Not a torrent file');
  const info = root['info'];
  if (!isDict(info)) throw new TorrentParseError('Missing info dictionary');

  const name = text(info['name.utf-8']) ?? text(info['name']);
  if (!name) throw new TorrentParseError('Missing torrent name');

  const files: TorrentFileEntry[] = [];
  const fileList = info['files'];
  const fileTree = info['file tree'];
  if (Array.isArray(fileList)) {
    for (const entry of fileList) {
      if (!isDict(entry) || typeof entry['length'] !== 'number') continue;
      const pathValue = entry['path.utf-8'] ?? entry['path'];
      const parts = Array.isArray(pathValue) ? pathValue.map((part) => text(part) ?? '') : [];
      files.push({ path: parts.join('/'), size: entry['length'] });
    }
  } else if (isDict(fileTree)) {
    walkFileTree(fileTree, [], files);
  } else if (typeof info['length'] === 'number') {
    files.push({ path: name, size: info['length'] });
  }
  if (files.length === 0) throw new TorrentParseError('Torrent has no files');

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  return { name, totalSize, files };
}
