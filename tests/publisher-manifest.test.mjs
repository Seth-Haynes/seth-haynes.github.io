import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../scripts/publisher/files.mjs";
import { hashFile, hashValue, imageSettingsHash, readFileStamp } from "../scripts/publisher/fingerprint.mjs";
import { loadManifest, MANIFEST_VERSION } from "../scripts/publisher/manifest.mjs";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-manifest-"));
const cacheDir = path.join(fixtureRoot, ".cache", "publisher");
const sourcePath = path.join(fixtureRoot, "Masters", "2026", "Test", "frame.tif");

const entry = {
  source: "2026/Test/frame.tif",
  sourceSize: 12,
  sourceModified: 123456789,
  sourceHash: `sha256:${"1".repeat(64)}`,
  settingsHash: `sha256:${"2".repeat(64)}`,
  output: "2026/Test/frame.jpg",
  outputHash: `sha256:${"3".repeat(64)}`,
};

try {
  const empty = await loadManifest(cacheDir);
  assert.equal(empty.size, 0);
  assert.equal(empty.dirty, false);
  assert.equal(await empty.save(), false, "an unchanged empty manifest should not be written");

  assert.equal(empty.set(entry), true);
  assert.equal(empty.set({ ...entry }), false, "an identical entry should not dirty the manifest");
  assert.equal(empty.dirty, true);
  assert.deepEqual(empty.get("2026/Test/frame.tif"), entry);
  assert.equal(await empty.save(), true);
  assert.equal(empty.dirty, false);
  assert.equal(await empty.save(), false, "an unchanged manifest should not be rewritten");

  const manifestPath = path.join(cacheDir, "manifest.json");
  const saved = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(saved.version, MANIFEST_VERSION);
  assert.deepEqual(saved.entries, [entry]);
  assert.deepEqual((await readdir(cacheDir)).sort(), ["manifest.json"]);

  const reloaded = await loadManifest(cacheDir);
  assert.equal(reloaded.size, 1);
  assert.deepEqual(reloaded.get(entry.source), entry);
  const retrieved = reloaded.get(entry.source);
  retrieved.output = "changed.jpg";
  assert.equal(reloaded.get(entry.source).output, entry.output, "callers must not mutate stored entries indirectly");

  assert.equal(reloaded.set({ ...entry, sourceSize: 13 }), true);
  const firstSave = reloaded.save();
  reloaded.set({ ...entry, sourceSize: 14 });
  const secondSave = reloaded.save();
  await Promise.all([firstSave, secondSave]);
  assert.equal((await loadManifest(cacheDir)).get(entry.source).sourceSize, 14, "queued saves should retain the latest revision");

  assert.equal(reloaded.delete(entry.source), true);
  assert.equal(reloaded.delete(entry.source), false);
  await reloaded.save();
  assert.equal((await loadManifest(cacheDir)).size, 0);

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "master bytes", "utf8");
  const fileHash = await hashFile(sourcePath);
  assert.match(fileHash, SHA256_PATTERN);
  assert.equal(fileHash, await hashFile(sourcePath), "unchanged files should have stable hashes");
  assert.deepEqual(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
  const stamp = await readFileStamp(sourcePath);
  assert.equal(stamp.sourceSize, 12);
  assert.equal(Number.isInteger(stamp.sourceModified), true);

  const settings = {
    longEdge: 2200,
    jpegQuality: 84,
    mozjpeg: true,
    stripMetadata: true,
    neverUpscale: true,
    sourceExtensions: [".jpg", ".tif"],
  };
  assert.equal(
    imageSettingsHash(settings),
    imageSettingsHash({ ...settings, sourceExtensions: [".png"] }),
    "source discovery settings should not invalidate generated image bytes",
  );
  assert.notEqual(imageSettingsHash(settings), imageSettingsHash({ ...settings, longEdge: 1800 }));

  const atomicPath = path.join(fixtureRoot, "atomic", "value.txt");
  await atomicWriteFile(atomicPath, "first");
  await atomicWriteFile(atomicPath, "second");
  assert.equal(await readFile(atomicPath, "utf8"), "second");
  assert.deepEqual(await readdir(path.dirname(atomicPath)), ["value.txt"]);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, "manifest.json"), "{ invalid", "utf8");
  await assert.rejects(loadManifest(cacheDir), /Could not parse publisher manifest/);

  await writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify({ version: 999, entries: [] }), "utf8");
  await assert.rejects(loadManifest(cacheDir), /version 999; expected 1/);

  await writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify({ version: 1, entries: [{ ...entry, output: "../outside.jpg" }] }), "utf8");
  await assert.rejects(loadManifest(cacheDir), /must not leave its configured directory/);

  await writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify({
    version: 1,
    entries: [entry, { ...entry, source: "2026/Test/other.tif" }],
  }), "utf8");
  await assert.rejects(loadManifest(cacheDir), /duplicate output path/);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Verified publisher manifest persistence, fingerprints, and atomic writes.");
