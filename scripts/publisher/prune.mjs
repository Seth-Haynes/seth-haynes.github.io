import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublisherConfig } from "./config.mjs";
import { hashFile } from "./fingerprint.mjs";
import { loadManifest } from "./manifest.mjs";

function relativeSegments(relativePath) {
  return relativePath.split("/");
}

async function assertMastersAvailable(mastersDir) {
  let details;
  try {
    details = await lstat(mastersDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Refusing to inspect orphans because the Masters directory is unavailable: ${mastersDir}`);
    }
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Refusing to inspect orphans because the Masters path is not a regular directory: ${mastersDir}`);
  }
}

async function sourceIsMissing(mastersDir, relativeSource) {
  await assertMastersAvailable(mastersDir);
  let current = mastersDir;
  const segments = relativeSegments(relativeSource);

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    if (details.isSymbolicLink()) return false;
    if (index < segments.length - 1 && !details.isDirectory()) return false;
  }
  return false;
}

function fileSignature(details) {
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
}

async function inspectOutput(outputDir, relativeOutput) {
  let root;
  try {
    root = await lstat(outputDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, path: path.join(outputDir, ...relativeSegments(relativeOutput)) };
    }
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(`output root is not a regular directory: ${outputDir}`);
  }

  const segments = relativeSegments(relativeOutput);
  let current = outputDir;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { exists: false, path: path.join(outputDir, ...segments) };
      }
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error(`path contains a symbolic link: ${current}`);
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new Error(`output parent is not a directory: ${current}`);
    }
    if (index === segments.length - 1 && !details.isFile()) {
      throw new Error(`output is not a regular file: ${current}`);
    }
    if (index === segments.length - 1) {
      return { exists: true, path: current, signature: fileSignature(details) };
    }
  }

  throw new Error(`output path is invalid: ${relativeOutput}`);
}

async function inspectOwnedOutput(outputDir, entry) {
  const before = await inspectOutput(outputDir, entry.output);
  if (!before.exists) return before;

  const outputHash = await hashFile(before.path);
  const after = await inspectOutput(outputDir, entry.output);
  if (!after.exists || before.signature !== after.signature) {
    throw new Error("output changed while it was inspected");
  }
  return { ...after, outputHash };
}

function protectedAction(entry, reason) {
  return { action: "protected", entry, reason };
}

export async function createPrunePlan(config) {
  await assertMastersAvailable(config.paths.mastersDir);
  const manifest = await loadManifest(config.paths.cacheDir);
  const actions = [];
  let live = 0;

  for (const entry of manifest.list()) {
    if (!await sourceIsMissing(config.paths.mastersDir, entry.source)) {
      live += 1;
      continue;
    }

    let output;
    try {
      output = await inspectOwnedOutput(config.paths.outputDir, entry);
    } catch (error) {
      actions.push(protectedAction(entry, error.message));
      continue;
    }

    if (!output.exists) {
      actions.push({ action: "manifest-only", entry, reason: "output is already missing" });
    } else if (output.outputHash !== entry.outputHash) {
      actions.push(protectedAction(entry, "output has been modified"));
    } else {
      actions.push({ action: "remove", entry, reason: "source is missing and output hash matches" });
    }
  }

  return {
    manifest,
    live,
    actions,
    removable: actions.filter((item) => item.action === "remove").length,
    manifestOnly: actions.filter((item) => item.action === "manifest-only").length,
    protected: actions.filter((item) => item.action === "protected").length,
  };
}

export async function applyPrunePlan(config, plan) {
  await assertMastersAvailable(config.paths.mastersDir);
  const results = [];

  for (const candidate of plan.actions) {
    if (candidate.action === "protected") {
      results.push({ status: "retained", entry: candidate.entry, reason: candidate.reason });
      continue;
    }

    const { entry } = candidate;
    if (!await sourceIsMissing(config.paths.mastersDir, entry.source)) {
      results.push({ status: "retained", entry, reason: "source was restored" });
      continue;
    }

    let output;
    try {
      output = await inspectOwnedOutput(config.paths.outputDir, entry);
    } catch (error) {
      results.push({ status: "retained", entry, reason: error.message });
      continue;
    }

    if (output.exists && output.outputHash !== entry.outputHash) {
      results.push({ status: "retained", entry, reason: "output has been modified" });
      continue;
    }

    if (!await sourceIsMissing(config.paths.mastersDir, entry.source)) {
      results.push({ status: "retained", entry, reason: "source was restored" });
      continue;
    }

    if (output.exists) await unlink(output.path);
    plan.manifest.delete(entry.source);
    results.push({
      status: output.exists ? "removed" : "manifest-cleaned",
      entry,
      reason: output.exists ? "owned output removed" : "missing output removed from manifest",
    });
  }

  await plan.manifest.save();
  return {
    results,
    removed: results.filter((result) => result.status === "removed").length,
    manifestCleaned: results.filter((result) => result.status === "manifest-cleaned").length,
    retained: results.filter((result) => result.status === "retained").length,
  };
}

function parseArguments(arguments_) {
  const options = { apply: false, help: false };
  for (const argument of arguments_) {
    if (argument === "--") continue;
    if (argument === "--apply") options.apply = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown prune option: ${argument}`);
  }
  return options;
}

function printPlan(plan) {
  for (const item of plan.actions) {
    const label = item.action === "remove" ? "Candidate" : item.action === "manifest-only" ? "Cache only" : "Retained ";
    console.log(`${label} ${item.entry.output}: ${item.reason}`);
  }
  console.log(
    `Orphan inspection finished: ${plan.removable} removable, ${plan.manifestOnly} cache-only, ${plan.protected} retained, ${plan.live} live.`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: pnpm.cmd run publish:prune\n       pnpm.cmd run publish:prune:apply");
    return;
  }

  const config = await loadPublisherConfig();
  const plan = await createPrunePlan(config);
  printPlan(plan);
  if (!options.apply) {
    if (plan.removable || plan.manifestOnly) console.log("No files changed. Run pnpm.cmd run publish:prune:apply to apply this plan.");
    return;
  }

  const report = await applyPrunePlan(config, plan);
  for (const result of report.results) {
    const label = result.status === "removed" ? "Removed  " : result.status === "manifest-cleaned" ? "Cleaned  " : "Retained ";
    console.log(`${label}${result.entry.output}: ${result.reason}`);
  }
  console.log(`Orphan cleanup finished: ${report.removed} removed, ${report.manifestCleaned} cache-only, ${report.retained} retained.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
