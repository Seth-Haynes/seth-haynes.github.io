import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { loadPublisherConfig } from "./config.mjs";
import { loadManifest } from "./manifest.mjs";
import { publishSources, runPublisher } from "./publish.mjs";
import { discoverSources, sourceFromPath } from "./sources.mjs";
import { acquireWatcherLock } from "./watch-lock.mjs";
import { BuildScheduler, publishBatchWithRetries, WatchBatchQueue } from "./watch-utils.mjs";

function relativeMasterPath(config, filePath) {
  return path.relative(config.paths.mastersDir, filePath).split(path.sep).join("/");
}

function logResult(result, logger) {
  if (result.status === "failed") logger.error(`Failed    ${result.source}: ${result.error.message}`);
  else logger.log(`${result.status === "published" ? "Published" : "Unchanged"} ${result.source}`);
}

function defaultBuildRunner(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(config.paths.rootDir, "scripts", "build.mjs")], {
      cwd: config.paths.rootDir,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Site build failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function isMetadataPath(filePath) {
  return path.basename(filePath).toLocaleLowerCase("en-US") === "metadata.json";
}

function ignoredPath(config, watchedPath, details) {
  const relative = path.relative(config.paths.mastersDir, watchedPath);
  if (relative && relative.split(path.sep).some((segment) => segment.startsWith(".") || segment.startsWith("~"))) return true;
  if (isMetadataPath(watchedPath)) return false;
  return Boolean(details?.isFile() && !config.image.sourceExtensions.includes(path.extname(watchedPath).toLocaleLowerCase("en-US")));
}

export async function startPublisherWatcher(options = {}) {
  const config = options.config ?? await loadPublisherConfig({
    rootDir: options.rootDir,
    configPath: options.configPath,
  });
  const releaseLock = options.singleInstance === false
    ? async () => {}
    : await acquireWatcherLock(config.paths.cacheDir);
  const logger = options.logger ?? console;
  const buildRunner = options.buildRunner ?? (() => defaultBuildRunner(config));
  const scheduler = new BuildScheduler({
    delayMs: config.watch.buildDebounceMs,
    run: async () => {
      logger.log("Building site...");
      await buildRunner();
      logger.log("Site build complete.");
    },
    onError: (error) => logger.error(`Site build failed: ${error.message}`),
  });

  let manifest;
  let initializationError = null;
  let releaseInitialization;
  const initialization = new Promise((resolve) => { releaseInitialization = resolve; });

  const processBatch = async (filePaths) => {
    await initialization;
    if (initializationError) throw initializationError;
    const metadataPaths = filePaths.filter(isMetadataPath);
    let sources;
    if (metadataPaths.length) {
      sources = await discoverSources(config);
    } else {
      sources = [];
      for (const filePath of filePaths) {
        try {
          const source = await sourceFromPath(config, filePath);
          if (source) sources.push(source);
        } catch (error) {
          logger.error(`Failed    ${relativeMasterPath(config, filePath)}: ${error.message}`);
        }
      }
    }
    if (!sources.length) return;

    const batch = await publishBatchWithRetries(
      sources,
      (pending) => publishSources({ config, manifest, sources: pending }),
      {
        retryAttempts: config.watch.retryAttempts,
        retryDelayMs: config.watch.retryDelayMs,
        onRetry: (result, attempt) => logger.log(`Retrying  ${result.source} (${attempt}/${config.watch.retryAttempts})`),
      },
    );
    if (metadataPaths.length) {
      const loggedErrors = new Set();
      for (const result of batch.results.filter((item) => item.status === "failed")) {
        if (loggedErrors.has(result.error.message)) continue;
        loggedErrors.add(result.error.message);
        logger.error(`Failed    metadata.json: ${result.error.message}`);
      }
      if (!loggedErrors.size) {
        for (const metadataPath of metadataPaths) logger.log(`Metadata   ${relativeMasterPath(config, metadataPath)}`);
      }
    } else {
      for (const result of batch.results) logResult(result, logger);
    }
    if (batch.changed && config.watch.buildAfterPublish) scheduler.request();
  };

  const queue = new WatchBatchQueue(processBatch, (error) => logger.error(`Publisher watcher failed: ${error.message}`));
  const watcher = chokidar.watch(config.paths.mastersDir, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: config.watch.stabilityMs,
      pollInterval: config.watch.pollIntervalMs,
    },
    ignored: (watchedPath, details) => ignoredPath(config, watchedPath, details),
  });
  watcher.on("add", (filePath) => queue.enqueue(filePath));
  watcher.on("change", (filePath) => queue.enqueue(filePath));
  watcher.on("unlink", (filePath) => logger.log(`Retained   ${relativeMasterPath(config, filePath)}`));
  watcher.on("error", (error) => logger.error(`Watcher error: ${error.message}`));

  let startupError;
  try {
    await new Promise((resolve) => watcher.once("ready", resolve));
    if (options.initialPublish !== false) {
      const initial = await runPublisher({ config });
      logger.log(`Initial scan: ${initial.published} published, ${initial.unchanged} unchanged, ${initial.failed} failed.`);
      for (const result of initial.results.filter((result) => result.status === "failed")) logResult(result, logger);
      if (initial.changed && config.watch.buildAfterPublish) scheduler.request();
    }
    manifest = await loadManifest(config.paths.cacheDir);
  } catch (error) {
    initializationError = error;
    startupError = error;
  } finally {
    releaseInitialization();
  }
  if (startupError) {
    await watcher.close();
    await queue.close();
    await scheduler.close({ flush: false });
    await releaseLock();
    throw startupError;
  }

  let closePromise;
  return {
    config,
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          await watcher.close();
          await queue.close();
          await scheduler.close({ flush: true });
          await releaseLock();
        })();
      }
      await closePromise;
    },
  };
}

async function main() {
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log("Usage: pnpm.cmd watch");
    return;
  }
  if (arguments_.length) throw new Error(`Unknown watcher option: ${arguments_[0]}`);
  const controller = await startPublisherWatcher();
  console.log(`Watching ${controller.config.paths.mastersDir}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    console.log("Stopping publisher watcher...");
    await controller.close();
  };
  const handleSignal = () => {
    void close().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
