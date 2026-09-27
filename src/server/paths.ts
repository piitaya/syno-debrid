import type { DebridContent } from './debrid/types.js';

// Characters rejected by DSM / SMB clients, plus control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"|?*]/g;
const MAX_SEGMENT = 200;

/** Makes a name safe to use as a single NAS folder or file name. */
export function sanitizeSegment(name: string): string {
  let clean = name.replace(/[/\\]/g, ' ').replace(FORBIDDEN, '').replace(/\s+/g, ' ').trim();
  // Trailing dots and spaces are not allowed on Windows shares.
  clean = clean.replace(/[. ]+$/, '');
  if (clean.length > MAX_SEGMENT) clean = clean.slice(0, MAX_SEGMENT).trim();
  return clean === '' || clean === '.' || clean === '..' ? '_' : clean;
}

/**
 * A single file or folder name taken as is: no separator, not `.` or `..`, no control character.
 * Unlike `sanitizeSegment`, it keeps names valid on the NAS (`?`, `:`…) unchanged.
 */
export function isPlainName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !!name.trim() && name !== '.' && name !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(name);
}

export function splitPath(path: string): string[] {
  return path
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function joinPath(...parts: (string | null | undefined)[]): string {
  return parts.flatMap((part) => (part ? splitPath(part) : [])).join('/');
}

export function dirname(path: string): string {
  const parts = splitPath(path);
  return parts.slice(0, -1).join('/');
}

export function basename(path: string): string {
  return splitPath(path).at(-1) ?? '';
}

export interface PlannedFile {
  /** Path relative to the category folder, including the torrent folder when there is one. */
  path: string;
  size: number;
  ref: string;
}

export interface DownloadPlan {
  /** Folder created for the torrent (relative to the category folder), if any. */
  folder: string | null;
  files: PlannedFile[];
}

/**
 * Decides where each file of a torrent goes, relative to the category folder. Mirrors a
 * BitTorrent client: a multi-file torrent gets its own folder, a single file lands directly.
 */
export function planDownload(content: DebridContent, createSubfolder: boolean): DownloadPlan {
  const folder = content.multiFile && createSubfolder ? sanitizeSegment(content.name) : null;
  const used = new Set<string>();

  const files = content.files.map((file) => {
    const segments = splitPath(file.path).map(sanitizeSegment);
    const original = joinPath(
      folder,
      ...(segments.length ? segments : [sanitizeSegment(content.name)]),
    );
    let path = original;
    // Two files can end up with the same name once sanitized: keep both.
    for (let n = 2; used.has(path.toLowerCase()); n++) {
      const name = basename(original);
      const dot = name.lastIndexOf('.');
      const renamed =
        dot > 0 ? `${name.slice(0, dot).trimEnd()} (${n})${name.slice(dot)}` : `${name} (${n})`;
      path = joinPath(dirname(original), renamed);
    }
    used.add(path.toLowerCase());
    return { path, size: file.size, ref: file.ref };
  });

  return { folder, files };
}
