import fs from 'node:fs/promises';
import path from 'node:path';
import { LockedError } from './errors.js';
import { log } from './logger.js';

// Chromium refuses to open one profile from two processes. This lock turns
// that into a clean wait/exit instead of a cryptic browser error, and lets
// cron-driven `run` and `keepalive` take turns.

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export async function acquireLock(lockFile, { waitMs = 0, pollMs = 2000 } = {}) {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      await fs.writeFile(lockFile, String(process.pid), { flag: 'wx' });
      return async () => {
        await fs.rm(lockFile, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const owner = Number((await fs.readFile(lockFile, 'utf8').catch(() => '')).trim());
    if (!owner || !pidAlive(owner)) {
      log.warn(`Removing stale lock ${lockFile} (pid ${owner || '?'})`);
      await fs.rm(lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockedError(`Browser profile is in use by pid ${owner} (lock ${lockFile})`);
    }
    if (!announced) {
      log.info(`Profile busy (pid ${owner}); waiting up to ${Math.round(waitMs / 1000)}s`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
