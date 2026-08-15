import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadManifest } from "../scripts/publisher/manifest.mjs";
import { runPublisher } from "../scripts/publisher/publish.mjs";
import { discoverSources } from "../scripts/publisher/sources.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-images-"));
const repository = path.join(fixtureRoot, "Portfolio");
const mastersDir = path.join(fixtureRoot, "Masters");
const outputDir = path.join(repository, "photos");
const cacheDir = path.join(repository, ".cache", "publisher");

function makeConfig(longEdge = 120) {
  return {
    image: {
      longEdge,
      jpegQuality: 84,
      mozjpeg: true,
      stripMetadata: true,
      neverUpscale: true,
      sourceExtensions: [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"],
    },
    watch: { concurrency: 2 },
    paths: { rootDir: repository, mastersDir, outputDir, cacheDir },
  };
}

async function makeImage(filePath, width, height, background, format = "png", orientation = null) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let pipeline = sharp({ create: { width, height, channels: 3, background } });
  if (format === "jpeg") pipeline = pipeline.jpeg();
  else if (format === "tiff") pipeline = pipeline.tiff();
  else pipeline = pipeline.png();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  await pipeline.toFile(filePath);
}

function resultFor(report, source) {
  return report.results.find((result) => result.source === source);
}

try {
  const largeSource = path.join(mastersDir, "2026", "Arkansas", "large.png");
  const smallSource = path.join(mastersDir, "2026", "Arkansas", "small.tif");
  const orientedSource = path.join(mastersDir, "2026", "Maine", "oriented.jpg");
  await makeImage(largeSource, 300, 100, "#224466");
  await makeImage(smallSource, 60, 30, "#886644", "tiff");
  await makeImage(orientedSource, 100, 40, "#446622", "jpeg", 6);
  const masterBefore = await readFile(largeSource);

  const first = await runPublisher({ config: makeConfig() });
  assert.equal(first.failed, 0);
  assert.equal(first.published, 3);
  assert.equal(first.total, 3);
  assert.equal(resultFor(first, "2026/Arkansas/large.png").status, "published");

  const largeOutput = path.join(outputDir, "2026", "Arkansas", "large.jpg");
  const smallOutput = path.join(outputDir, "2026", "Arkansas", "small.jpg");
  const orientedOutput = path.join(outputDir, "2026", "Maine", "oriented.jpg");
  const largeMetadata = await sharp(largeOutput).metadata();
  const smallMetadata = await sharp(smallOutput).metadata();
  const orientedMetadata = await sharp(orientedOutput).metadata();
  assert.deepEqual([largeMetadata.width, largeMetadata.height], [120, 40]);
  assert.deepEqual([smallMetadata.width, smallMetadata.height], [60, 30], "small masters must not be enlarged");
  assert.deepEqual([orientedMetadata.width, orientedMetadata.height], [40, 100], "EXIF orientation must be applied");
  assert.equal(largeMetadata.exif, undefined, "generated JPEG metadata should be stripped");
  assert.deepEqual(await readFile(largeSource), masterBefore, "publishing must not modify masters");

  const firstOutputTime = (await stat(largeOutput)).mtimeMs;
  const second = await runPublisher({ config: makeConfig() });
  assert.equal(second.unchanged, 3);
  assert.equal((await stat(largeOutput)).mtimeMs, firstOutputTime, "cache hits must not rewrite output files");

  const future = new Date(Date.now() + 2000);
  await utimes(largeSource, future, future);
  const touched = await runPublisher({ config: makeConfig() });
  assert.equal(resultFor(touched, "2026/Arkansas/large.png").reason, "source-hash");
  assert.equal((await stat(largeOutput)).mtimeMs, firstOutputTime, "timestamp-only changes must not rewrite output files");

  await makeImage(largeSource, 300, 100, "#993322");
  const changed = await runPublisher({ config: makeConfig() });
  assert.equal(resultFor(changed, "2026/Arkansas/large.png").status, "published");
  const changedOutput = await readFile(largeOutput);

  const smallerSettings = makeConfig(80);
  const resized = await runPublisher({ config: smallerSettings });
  assert.equal(resized.failed, 0);
  assert.deepEqual(
    [(await sharp(largeOutput).metadata()).width, (await sharp(orientedOutput).metadata()).height],
    [80, 80],
    "changing the configured long edge must invalidate affected outputs",
  );

  const timesBeforeRebuild = await Promise.all([largeOutput, smallOutput, orientedOutput].map(async (file) => (await stat(file)).mtimeMs));
  const rebuilt = await runPublisher({ config: smallerSettings, rebuild: true });
  assert.equal(rebuilt.failed, 0);
  assert.equal(rebuilt.unchanged, 3, "deterministic rebuilds should not replace identical files");
  assert.deepEqual(
    await Promise.all([largeOutput, smallOutput, orientedOutput].map(async (file) => (await stat(file)).mtimeMs)),
    timesBeforeRebuild,
  );

  const goodMaster = await readFile(largeSource);
  const goodOutput = await readFile(largeOutput);
  await writeFile(largeSource, "not an image", "utf8");
  const failed = await runPublisher({ config: smallerSettings });
  assert.equal(resultFor(failed, "2026/Arkansas/large.png").status, "failed");
  assert.deepEqual(await readFile(largeOutput), goodOutput, "a failed conversion must preserve the last good output");
  await writeFile(largeSource, goodMaster);
  await runPublisher({ config: smallerSettings });

  const transferTiff = path.join(mastersDir, "2026", "Transfer", "frame.tif");
  const transferPng = path.join(mastersDir, "2026", "Transfer", "frame.png");
  await makeImage(transferTiff, 100, 50, "#264466", "tiff");
  const transferFirst = await runPublisher({ config: smallerSettings });
  assert.equal(resultFor(transferFirst, "2026/Transfer/frame.tif").status, "published");
  await rm(transferTiff);
  await makeImage(transferPng, 100, 50, "#884422");
  const transferred = await runPublisher({ config: smallerSettings });
  assert.equal(resultFor(transferred, "2026/Transfer/frame.png").status, "published");
  const transferredManifest = await loadManifest(cacheDir);
  assert.equal(transferredManifest.get("2026/Transfer/frame.tif"), null);
  assert.ok(transferredManifest.get("2026/Transfer/frame.png"), "a format change should transfer output ownership");

  const unmanagedSource = path.join(mastersDir, "2026", "Unmanaged", "frame.png");
  const unmanagedOutput = path.join(outputDir, "2026", "Unmanaged", "frame.jpg");
  await makeImage(unmanagedSource, 100, 50, "#123456");
  await makeImage(unmanagedOutput, 50, 25, "#654321", "jpeg");
  const unmanagedBefore = await readFile(unmanagedOutput);
  const unmanaged = await runPublisher({ config: smallerSettings });
  assert.match(resultFor(unmanaged, "2026/Unmanaged/frame.png").error.message, /Refusing to replace unmanaged output/);
  assert.deepEqual(await readFile(unmanagedOutput), unmanagedBefore);

  const collisionDirectory = path.join(mastersDir, "2026", "Collision");
  await makeImage(path.join(collisionDirectory, "same.png"), 20, 20, "#111111");
  await makeImage(path.join(collisionDirectory, "same.tif"), 20, 20, "#222222", "tiff");
  await assert.rejects(discoverSources(smallerSettings), /Publisher output collision/);

  assert.notDeepEqual(await readFile(largeOutput), changedOutput, "a settings change should produce the newly sized output");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Verified incremental image publishing, output safety, and deterministic rebuilds.");
