import { spawn } from "node:child_process";
import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublisherConfig } from "./config.mjs";

export async function startBackgroundPublisher(options = {}) {
  const config = options.config ?? await loadPublisherConfig({
    rootDir: options.rootDir,
    configPath: options.configPath,
  });
  await mkdir(config.paths.cacheDir, { recursive: true });
  const logPath = path.join(config.paths.cacheDir, "watcher.log");
  const watcherPath = fileURLToPath(new URL("watch.mjs", import.meta.url));
  await appendFile(logPath, `\n[${new Date().toISOString()}] Starting publisher watcher.\n`, "utf8");
  const logHandle = await open(logPath, "a");

  let child;
  try {
    child = spawn(process.execPath, [watcherPath], {
      cwd: config.paths.rootDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode !== null) {
      throw new Error(`Publisher watcher exited with code ${child.exitCode}. See ${logPath}`);
    }
    child.unref();
  } finally {
    await logHandle.close();
  }

  return { processId: child.pid, logPath };
}

async function main() {
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log("Usage: pnpm.cmd run publisher:start");
    return;
  }
  if (arguments_.length) throw new Error(`Unknown background publisher option: ${arguments_[0]}`);
  const result = await startBackgroundPublisher();
  console.log(`Publisher watcher started as process ${result.processId}.`);
  console.log(`Log: ${result.logPath}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
