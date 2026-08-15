import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { hashFile } from "../scripts/publisher/fingerprint.mjs";
import { startPublisherWatcher } from "../scripts/publisher/watch.mjs";
import { BuildScheduler, publishBatchWithRetries, WatchBatchQueue } from "../scripts/publisher/watch-utils.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await wait(40);
  }
  assert.fail("Timed out waiting for watcher output");
}

const batches = [];
const queue = new WatchBatchQueue(async (paths) => { batches.push(paths); });
queue.enqueue("B.tif");
queue.enqueue("b.tif");
queue.enqueue("A.tif");
await queue.idle();
await queue.close();
assert.deepEqual(batches, [["A.tif", "b.tif"]], "queued events should be deduplicated without losing order");

let builds = 0;
const scheduler = new BuildScheduler({ delayMs: 20, run: async () => { builds += 1; } });
scheduler.request();
scheduler.request();
await scheduler.close({ flush: true });
assert.equal(builds, 1, "several changes should produce one debounced build");

const retrySource = { source: "2026/Test/retry.tif", output: "2026/Test/retry.jpg" };
let attempts = 0;
const retried = await publishBatchWithRetries([retrySource], async () => {
  attempts += 1;
  const error = new Error("temporarily locked");
  error.code = "EBUSY";
  return attempts === 1
    ? { changed: false, results: [{ ...retrySource, status: "failed", error }] }
    : { changed: true, results: [{ ...retrySource, status: "published" }] };
}, { retryAttempts: 2, retryDelayMs: 1 });
assert.equal(attempts, 2);
assert.equal(retried.results[0].status, "published");
assert.equal(retried.changed, true);

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-watch-"));
const repository = path.join(fixtureRoot, "Portfolio");
const mastersDir = path.join(fixtureRoot, "Masters");
const outputDir = path.join(repository, "photos");
const cacheDir = path.join(repository, ".cache", "publisher");
const masterPath = path.join(mastersDir, "2026", "Watcher", "frame.tif");
const outputPath = path.join(outputDir, "2026", "Watcher", "frame.jpg");
const metadataPath = path.join(outputDir, "2026", "Watcher", "metadata.json");
const masterMetadataPath = path.join(mastersDir, "2026", "Watcher", "metadata.json");
const initialMasterPath = path.join(mastersDir, "2026", "Watcher", "initial.tif");
const initialOutputPath = path.join(outputDir, "2026", "Watcher", "initial.jpg");
await mkdir(path.dirname(masterPath), { recursive: true });
await sharp({ create: { width: 120, height: 60, channels: 3, background: "#223344" } }).tiff().toFile(initialMasterPath);

const config = {
  image: {
    longEdge: 100,
    jpegQuality: 84,
    mozjpeg: true,
    stripMetadata: true,
    neverUpscale: true,
    sourceExtensions: [".tif"],
  },
  watch: {
    stabilityMs: 100,
    pollIntervalMs: 25,
    buildAfterPublish: false,
    buildDebounceMs: 20,
    concurrency: 2,
    retryAttempts: 2,
    retryDelayMs: 10,
  },
  paths: { rootDir: repository, mastersDir, outputDir, cacheDir },
};
const logger = { log() {}, error() {} };
let controller;
try {
  controller = await startPublisherWatcher({ config, logger });
  await assert.rejects(
    startPublisherWatcher({ config, logger, initialPublish: false }),
    /another copy is already running/,
  );
  await access(initialOutputPath);
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#334455" } }).tiff().toFile(masterPath);
  await waitFor(async () => {
    await access(outputPath);
    await access(metadataPath);
    return true;
  });
  assert.deepEqual([(await sharp(outputPath).metadata()).width, (await sharp(outputPath).metadata()).height], [100, 50]);
  assert.ok(JSON.parse(await readFile(metadataPath, "utf8")).images["frame.jpg"]);

  await writeFile(masterMetadataPath, `${JSON.stringify({
    location: "Watcher fixture",
    images: {
      "frame.jpg": {
        title: "Metadata from Masters",
        description: "Synchronized by the watcher.",
        alt: "A watcher test frame",
        tags: ["watcher"],
        featured: false,
      },
    },
  }, null, 2)}\n`, "utf8");
  await waitFor(async () => JSON.parse(await readFile(metadataPath, "utf8")).images["frame.jpg"].title === "Metadata from Masters");
  assert.equal(JSON.parse(await readFile(masterMetadataPath, "utf8")).images["initial.jpg"].title, "");

  const firstHash = await hashFile(outputPath);
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#883322" } }).tiff().toFile(masterPath);
  await waitFor(async () => await hashFile(outputPath) !== firstHash);

  await rm(masterPath);
  await wait(250);
  await access(outputPath);
} finally {
  if (controller) await controller.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Verified watcher batching, retries, file stability, and incremental publishing.");
