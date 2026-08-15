import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

const LOCK_FILENAME = "watcher.lock";

function watcherLockError(message) {
  return new Error(`Could not start publisher watcher: ${message}`);
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLock(lockPath) {
  let value;
  try {
    value = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw watcherLockError(`the lock file is unreadable: ${lockPath}`);
  }
  if (!Number.isInteger(value?.processId) || value.processId <= 0) {
    throw watcherLockError(`the lock file is invalid: ${lockPath}`);
  }
  return value;
}

export async function acquireWatcherLock(cacheDir) {
  const lockPath = path.join(cacheDir, LOCK_FILENAME);
  await mkdir(cacheDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      const value = {
        processId: process.pid,
        startedAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        try {
          const current = await readLock(lockPath);
          if (current.processId === process.pid) await rm(lockPath, { force: true });
        } catch (error) {
          if (!String(error.message).includes("unreadable")) throw error;
        }
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      const current = await readLock(lockPath);
      if (processIsRunning(current.processId)) {
        throw watcherLockError(`another copy is already running as process ${current.processId}`);
      }
      await rm(lockPath, { force: true });
    }
  }

  throw watcherLockError(`could not claim the lock file: ${lockPath}`);
}
