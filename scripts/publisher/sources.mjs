import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

function toManifestPath(value) {
  return value.split(path.sep).join("/");
}

export function sourceOutputPath(relativeSource) {
  const extension = path.posix.extname(relativeSource);
  return `${relativeSource.slice(0, -extension.length)}.jpg`;
}

function shouldIgnore(entry) {
  return entry.name.startsWith(".") || entry.name.startsWith("~");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sourceRecord(root, sourcePath) {
  const source = toManifestPath(path.relative(root, sourcePath));
  return { source, sourcePath, output: sourceOutputPath(source) };
}

function assertNoOutputCollisions(sources) {
  const outputs = new Map();
  for (const source of sources) {
    const key = source.output.toLocaleLowerCase("en-US");
    const conflict = outputs.get(key);
    if (conflict) {
      throw new Error(`Publisher output collision: ${conflict.source} and ${source.source} both map to ${source.output}`);
    }
    outputs.set(key, source);
  }
}

export async function discoverSources(config) {
  const root = config.paths.mastersDir;
  const allowedExtensions = new Set(config.image.sourceExtensions);
  const sources = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && directory === root) {
        throw new Error(`Masters directory not found: ${root}`);
      }
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      if (shouldIgnore(entry) || entry.isSymbolicLink()) continue;
      const sourcePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath);
        continue;
      }
      if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      sources.push(sourceRecord(root, sourcePath));
    }
  }

  await visit(root);
  sources.sort((left, right) => left.source.localeCompare(right.source, "en-US"));

  assertNoOutputCollisions(sources);

  return sources;
}

export async function sourceFromPath(config, filePath) {
  const root = config.paths.mastersDir;
  const sourcePath = path.resolve(filePath);
  if (!isInside(root, sourcePath)) return null;
  const relativeSegments = path.relative(root, sourcePath).split(path.sep);
  if (relativeSegments.some((segment) => segment.startsWith(".") || segment.startsWith("~"))) return null;
  if (!config.image.sourceExtensions.includes(path.extname(sourcePath).toLocaleLowerCase("en-US"))) return null;

  let details;
  try {
    details = await lstat(sourcePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) return null;

  const source = sourceRecord(root, sourcePath);
  const siblings = [];
  for (const entry of await readdir(path.dirname(sourcePath), { withFileTypes: true })) {
    if (shouldIgnore(entry) || entry.isSymbolicLink() || !entry.isFile()) continue;
    if (!config.image.sourceExtensions.includes(path.extname(entry.name).toLocaleLowerCase("en-US"))) continue;
    siblings.push(sourceRecord(root, path.join(path.dirname(sourcePath), entry.name)));
  }
  assertNoOutputCollisions(siblings);
  return source;
}
