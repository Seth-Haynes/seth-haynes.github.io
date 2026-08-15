import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { hashFile } from "../scripts/publisher/fingerprint.mjs";
import { loadManifest } from "../scripts/publisher/manifest.mjs";
import { applyPrunePlan, createPrunePlan } from "../scripts/publisher/prune.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-prune-"));
const repository = path.join(fixtureRoot, "Portfolio");
const mastersDir = path.join(fixtureRoot, "Masters");
const outputDir = path.join(repository, "photos");
const cacheDir = path.join(repository, ".cache", "publisher");
const folder = "2026/Prune";
const config = { paths: { rootDir: repository, mastersDir, outputDir, cacheDir } };
const fixedHash = `sha256:${"1".repeat(64)}`;

async function makeJpeg(relativePath, background) {
  const target = path.join(outputDir, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await sharp({ create: { width: 40, height: 20, channels: 3, background } }).jpeg().toFile(target);
  return target;
}

async function makeEntry(name, outputHash) {
  return {
    source: `${folder}/${name}.tif`,
    sourceSize: 100,
    sourceModified: 1000,
    sourceHash: fixedHash,
    settingsHash: fixedHash,
    output: `${folder}/${name}.jpg`,
    outputHash,
  };
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), (error) => error.code === "ENOENT");
}

try {
  await mkdir(path.join(mastersDir, ...folder.split("/")), { recursive: true });
  const liveSource = path.join(mastersDir, ...folder.split("/"), "live.tif");
  const restoredSource = path.join(mastersDir, ...folder.split("/"), "restored.tif");
  await writeFile(liveSource, "live master", "utf8");

  const liveOutput = await makeJpeg(`${folder}/live.jpg`, "#112233");
  const orphanOutput = await makeJpeg(`${folder}/orphan.jpg`, "#334455");
  const modifiedOutput = await makeJpeg(`${folder}/modified.jpg`, "#556677");
  const restoredOutput = await makeJpeg(`${folder}/restored.jpg`, "#778899");
  const unsafeOutput = path.join(outputDir, ...folder.split("/"), "unsafe.jpg");
  await mkdir(unsafeOutput, { recursive: true });
  await writeFile(path.join(unsafeOutput, "keep.txt"), "keep", "utf8");

  const manifest = await loadManifest(cacheDir);
  manifest.set(await makeEntry("live", await hashFile(liveOutput)));
  manifest.set(await makeEntry("orphan", await hashFile(orphanOutput)));
  manifest.set(await makeEntry("modified", await hashFile(modifiedOutput)));
  manifest.set(await makeEntry("restored", await hashFile(restoredOutput)));
  manifest.set(await makeEntry("missing", fixedHash));
  manifest.set(await makeEntry("unsafe", fixedHash));
  await manifest.save();

  await makeJpeg(`${folder}/modified.jpg`, "#aa4422");
  const metadataPath = path.join(outputDir, ...folder.split("/"), "metadata.json");
  const unrelatedPath = path.join(outputDir, ...folder.split("/"), "notes.txt");
  await writeFile(metadataPath, "{\"images\":{}}\n", "utf8");
  await writeFile(unrelatedPath, "unrelated", "utf8");
  const manifestBefore = await readFile(path.join(cacheDir, "manifest.json"), "utf8");

  const plan = await createPrunePlan(config);
  assert.equal(plan.live, 1);
  assert.equal(plan.removable, 2);
  assert.equal(plan.manifestOnly, 1);
  assert.equal(plan.protected, 2);
  assert.equal(await readFile(path.join(cacheDir, "manifest.json"), "utf8"), manifestBefore, "dry run must not edit the manifest");
  await access(orphanOutput);

  await writeFile(restoredSource, "restored master", "utf8");
  const report = await applyPrunePlan(config, plan);
  assert.equal(report.removed, 1);
  assert.equal(report.manifestCleaned, 1);
  assert.equal(report.retained, 3);

  await assertMissing(orphanOutput);
  await access(liveOutput);
  await access(modifiedOutput);
  await access(restoredOutput);
  assert.equal(await readFile(path.join(unsafeOutput, "keep.txt"), "utf8"), "keep");
  assert.equal(await readFile(metadataPath, "utf8"), "{\"images\":{}}\n");
  assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated");

  const prunedManifest = await loadManifest(cacheDir);
  assert.equal(prunedManifest.size, 4);
  assert.ok(prunedManifest.has(`${folder}/live.tif`));
  assert.ok(prunedManifest.has(`${folder}/modified.tif`));
  assert.ok(prunedManifest.has(`${folder}/restored.tif`));
  assert.ok(prunedManifest.has(`${folder}/unsafe.tif`));
  assert.equal(prunedManifest.has(`${folder}/orphan.tif`), false);
  assert.equal(prunedManifest.has(`${folder}/missing.tif`), false);

  const offlineOutput = await makeJpeg(`${folder}/offline.jpg`, "#225588");
  prunedManifest.set(await makeEntry("offline", await hashFile(offlineOutput)));
  await prunedManifest.save();
  const offlinePlan = await createPrunePlan(config);
  const offlineMasters = path.join(fixtureRoot, "Masters-offline");
  await rename(mastersDir, offlineMasters);
  try {
    await assert.rejects(applyPrunePlan(config, offlinePlan), /Masters directory is unavailable/);
    await access(offlineOutput);
  } finally {
    await rename(offlineMasters, mastersDir);
  }

  await assert.rejects(
    createPrunePlan({ paths: { ...config.paths, mastersDir: path.join(fixtureRoot, "Unavailable") } }),
    /Masters directory is unavailable/,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Verified dry-run orphan inspection, hash checks, and conservative cleanup.");
