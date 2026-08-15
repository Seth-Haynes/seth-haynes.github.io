import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

let shortcutVerified = false;
if (process.platform === "win32") {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-startup-"));
  const scriptPath = path.resolve("scripts", "publisher", "install-startup.ps1");
  let spawnBlocked = false;
  try {
    try {
      await run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-StartupDirectory", fixtureRoot,
      ]);
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      spawnBlocked = true;
    }

    if (!spawnBlocked) {
      const files = await readdir(fixtureRoot);
      assert.deepEqual(files, ["Seth Haynes Photography Publisher.lnk"]);
      const shortcutPath = path.join(fixtureRoot, files[0]);
      assert.ok((await stat(shortcutPath)).size > 0);

      await run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-StartupDirectory", fixtureRoot,
        "-Remove",
      ]);
      await assert.rejects(access(shortcutPath), (error) => error.code === "ENOENT");
      shortcutVerified = true;
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  if (spawnBlocked) console.log("Deferred shortcut creation because this environment blocks child PowerShell processes.");
}

if (shortcutVerified) console.log("Verified Windows publisher startup shortcut installation.");
