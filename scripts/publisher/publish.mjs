import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublisherConfig } from "./config.mjs";
import { atomicWriteFile } from "./files.mjs";
import { hashFile, imageSettingsHash, readFileStamp } from "./fingerprint.mjs";
import { renderRepositoryJpeg } from "./image.mjs";
import { loadManifest } from "./manifest.mjs";
import { updatePublishedMetadata } from "./metadata.mjs";
import { discoverSources } from "./sources.mjs";
import { runPool } from "../lib/utils.mjs";

function sameManifestPath(left, right) {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertSourceUnchanged(sourcePath, expectedStamp) {
  const currentStamp = await readFileStamp(sourcePath);
  if (
    currentStamp.sourceSize !== expectedStamp.sourceSize
    || currentStamp.sourceModified !== expectedStamp.sourceModified
  ) {
    throw new Error(`Source changed while it was being published: ${sourcePath}`);
  }
}

async function inspectOutput(outputRoot, relativeOutput) {
  const segments = relativeOutput.split("/");
  let current = outputRoot;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false, path: path.join(outputRoot, ...segments) };
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error(`Refusing to publish through a symbolic link: ${current}`);
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new Error(`Publisher output parent is not a directory: ${current}`);
    }
    if (index === segments.length - 1 && !details.isFile()) {
      throw new Error(`Publisher output is not a regular file: ${current}`);
    }
  }

  return { exists: true, path: current };
}

async function publishSource({ config, manifest, source, rebuild }) {
  const settingsHash = imageSettingsHash(config.image);
  const outputState = await inspectOutput(config.paths.outputDir, source.output);
  const previous = manifest.get(source.source);
  const owner = manifest.getByOutput(source.output);
  let transferredOwner = null;
  if (owner && !sameManifestPath(owner.source, source.source)) {
    const ownerSourcePath = path.join(config.paths.mastersDir, ...owner.source.split("/"));
    if (await pathExists(ownerSourcePath)) {
      throw new Error(`Refusing to reuse publisher-owned output ${source.output}; it belongs to ${owner.source}`);
    }
    transferredOwner = owner;
  }

  const stamp = await readFileStamp(source.sourcePath);
  if (
    !rebuild
    && previous
    && previous.sourceSize === stamp.sourceSize
    && previous.sourceModified === stamp.sourceModified
    && previous.settingsHash === settingsHash
    && sameManifestPath(previous.output, source.output)
    && outputState.exists
  ) {
    return { status: "unchanged", source: source.source, output: source.output, reason: "cache" };
  }

  const sourceHash = await hashFile(source.sourcePath);
  await assertSourceUnchanged(source.sourcePath, stamp);
  if (
    !rebuild
    && previous
    && previous.sourceHash === sourceHash
    && previous.settingsHash === settingsHash
    && sameManifestPath(previous.output, source.output)
    && outputState.exists
  ) {
    manifest.set({ ...previous, ...stamp });
    return { status: "unchanged", source: source.source, output: source.output, reason: "source-hash" };
  }

  const generated = await renderRepositoryJpeg(source.sourcePath, config.image);
  await assertSourceUnchanged(source.sourcePath, stamp);
  const existingHash = outputState.exists ? await hashFile(outputState.path) : null;
  if (transferredOwner && outputState.exists && existingHash !== transferredOwner.outputHash) {
    throw new Error(`Refusing to replace modified publisher output during ownership transfer: ${source.output}`);
  }
  if (outputState.exists && !owner && existingHash !== generated.outputHash) {
    throw new Error(`Refusing to replace unmanaged output: ${source.output}`);
  }

  const changed = existingHash !== generated.outputHash;
  if (changed) await atomicWriteFile(outputState.path, generated.buffer);

  if (transferredOwner) manifest.delete(transferredOwner.source);
  manifest.set({
    source: source.source,
    ...stamp,
    sourceHash,
    settingsHash,
    output: source.output,
    outputHash: generated.outputHash,
  });

  return {
    status: changed ? "published" : "unchanged",
    source: source.source,
    output: source.output,
    reason: changed ? "generated" : "output-hash",
    width: generated.width,
    height: generated.height,
  };
}

export async function runPublisher(options = {}) {
  const config = options.config ?? await loadPublisherConfig({
    rootDir: options.rootDir,
    configPath: options.configPath,
  });
  const sources = await discoverSources(config);
  return publishSources({ config, sources, rebuild: options.rebuild === true });
}

export async function publishSources(options) {
  const { config, sources } = options;
  const manifest = options.manifest ?? await loadManifest(config.paths.cacheDir);
  const concurrency = Math.min(16, Math.max(1, Number(config.watch?.concurrency) || 2));
  const results = await runPool(sources, concurrency, async (source) => {
    try {
      return await publishSource({ config, manifest, source, rebuild: options.rebuild === true });
    } catch (error) {
      return {
        status: "failed",
        source: source.source,
        output: source.output,
        error,
      };
    }
  });
  const imageChanged = results.some((result) => result.status === "published");
  await manifest.save();

  const metadata = await updatePublishedMetadata(config.paths.mastersDir, config.paths.outputDir, results);
  for (const failure of metadata.failures) {
    for (const result of failure.results) {
      result.imageStatus = result.status;
      result.status = "failed";
      result.phase = "metadata";
      result.error = failure.error;
    }
  }

  const report = {
    results,
    metadata,
    total: results.length,
    published: results.filter((result) => result.status === "published").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    failed: results.filter((result) => result.status === "failed").length,
    changed: imageChanged || metadata.updates.some((update) => update.changed),
  };
  return report;
}

function parseArguments(arguments_) {
  const options = { rebuild: false, help: false };
  for (const argument of arguments_) {
    if (argument === "--") continue;
    if (argument === "--rebuild") options.rebuild = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown publisher option: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: pnpm.cmd run publish\n       pnpm.cmd run publish:rebuild");
    return;
  }
  const report = await runPublisher(options);
  for (const result of report.results) {
    if (result.status === "failed") console.error(`Failed    ${result.source}: ${result.error.message}`);
    else console.log(`${result.status === "published" ? "Published" : "Unchanged"} ${result.source}`);
  }
  console.log(`Publisher finished: ${report.published} published, ${report.unchanged} unchanged, ${report.failed} failed.`);
  if (report.failed) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
