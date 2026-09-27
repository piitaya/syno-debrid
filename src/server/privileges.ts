import { chownSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

function chownRecursive(path: string, uid: number, gid: number): void {
  chownSync(path, uid, gid);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) chownRecursive(child, uid, gid);
    else chownSync(child, uid, gid);
  }
}

/**
 * Like linuxserver.io images: when started as root, give the data folder to PUID:PGID (your
 * NAS user) and keep running as that user. Does nothing when not root (e.g. `user:` is set).
 */
export function dropPrivileges(dataDir: string, source: NodeJS.ProcessEnv = process.env): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const uid = Number.parseInt(source.PUID ?? '', 10);
  const gid = Number.parseInt(source.PGID ?? '', 10);
  if (Number.isNaN(uid) || Number.isNaN(gid) || uid === 0) return;

  try {
    chownRecursive(dataDir, uid, gid);
  } catch (error) {
    log.warn(`Could not give ${dataDir} to ${uid}:${gid}`, (error as Error).message);
  }
  process.setgroups?.([gid]);
  process.setgid?.(gid);
  process.setuid?.(uid);
  log.info(`Running as ${uid}:${gid}`);
}
