import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(moduleDir, "..", "..");

export const DEFAULT_PUBLISHER_CONFIG = Object.freeze({
  mastersDir: "../Masters",
  outputDir: "photos",
  cacheDir: ".cache/publisher",
  image: Object.freeze({
    longEdge: 2200,
    jpegQuality: 84,
    mozjpeg: true,
    stripMetadata: true,
    neverUpscale: true,
    sourceExtensions: Object.freeze([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]),
  }),
  watch: Object.freeze({
    stabilityMs: 2500,
    pollIntervalMs: 250,
    buildAfterPublish: true,
    buildDebounceMs: 3000,
    concurrency: 2,
    retryAttempts: 5,
    retryDelayMs: 500,
  }),
  safety: Object.freeze({
    allowMastersInsideRepository: false,
    deleteOrphans: false,
  }),
});

const TOP_LEVEL_KEYS = new Set(["mastersDir", "outputDir", "cacheDir", "image", "watch", "safety"]);
const IMAGE_KEYS = new Set(Object.keys(DEFAULT_PUBLISHER_CONFIG.image));
const WATCH_KEYS = new Set(Object.keys(DEFAULT_PUBLISHER_CONFIG.watch));
const SAFETY_KEYS = new Set(Object.keys(DEFAULT_PUBLISHER_CONFIG.safety));

function configurationError(field, message) {
  return new Error(`Invalid publisher configuration at "${field}": ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, field) {
  if (!isPlainObject(value)) throw configurationError(field, "must be an object");
}

function assertKnownKeys(value, allowedKeys, field) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw configurationError(`${field}.${key}`, "is not a recognized setting");
  }
}

function readString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw configurationError(field, "must be a non-empty string");
  }
  return value.trim();
}

function readBoolean(value, field) {
  if (typeof value !== "boolean") throw configurationError(field, "must be true or false");
  return value;
}

function readInteger(value, field, { minimum, maximum = Number.MAX_SAFE_INTEGER }) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw configurationError(field, `must be an integer ${range}`);
  }
  return value;
}

function readExtensions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw configurationError("image.sourceExtensions", "must be a non-empty array");
  }

  const extensions = value.map((extension, index) => {
    if (typeof extension !== "string") {
      throw configurationError(`image.sourceExtensions.${index}`, "must be a file extension");
    }
    const normalized = extension.trim().toLowerCase();
    if (!/^\.[a-z0-9]+$/.test(normalized)) {
      throw configurationError(`image.sourceExtensions.${index}`, "must start with a dot and contain only letters or numbers");
    }
    return normalized;
  });

  return [...new Set(extensions)];
}

function mergeAndValidate(raw) {
  assertObject(raw, "publisher.config.json");
  assertKnownKeys(raw, TOP_LEVEL_KEYS, "publisher.config.json");

  const image = raw.image ?? {};
  const watch = raw.watch ?? {};
  const safety = raw.safety ?? {};
  assertObject(image, "image");
  assertObject(watch, "watch");
  assertObject(safety, "safety");
  assertKnownKeys(image, IMAGE_KEYS, "image");
  assertKnownKeys(watch, WATCH_KEYS, "watch");
  assertKnownKeys(safety, SAFETY_KEYS, "safety");

  return {
    mastersDir: readString(raw.mastersDir ?? DEFAULT_PUBLISHER_CONFIG.mastersDir, "mastersDir"),
    outputDir: readString(raw.outputDir ?? DEFAULT_PUBLISHER_CONFIG.outputDir, "outputDir"),
    cacheDir: readString(raw.cacheDir ?? DEFAULT_PUBLISHER_CONFIG.cacheDir, "cacheDir"),
    image: {
      longEdge: readInteger(image.longEdge ?? DEFAULT_PUBLISHER_CONFIG.image.longEdge, "image.longEdge", { minimum: 1 }),
      jpegQuality: readInteger(image.jpegQuality ?? DEFAULT_PUBLISHER_CONFIG.image.jpegQuality, "image.jpegQuality", { minimum: 1, maximum: 100 }),
      mozjpeg: readBoolean(image.mozjpeg ?? DEFAULT_PUBLISHER_CONFIG.image.mozjpeg, "image.mozjpeg"),
      stripMetadata: readBoolean(image.stripMetadata ?? DEFAULT_PUBLISHER_CONFIG.image.stripMetadata, "image.stripMetadata"),
      neverUpscale: readBoolean(image.neverUpscale ?? DEFAULT_PUBLISHER_CONFIG.image.neverUpscale, "image.neverUpscale"),
      sourceExtensions: readExtensions(image.sourceExtensions ?? DEFAULT_PUBLISHER_CONFIG.image.sourceExtensions),
    },
    watch: {
      stabilityMs: readInteger(watch.stabilityMs ?? DEFAULT_PUBLISHER_CONFIG.watch.stabilityMs, "watch.stabilityMs", { minimum: 0 }),
      pollIntervalMs: readInteger(watch.pollIntervalMs ?? DEFAULT_PUBLISHER_CONFIG.watch.pollIntervalMs, "watch.pollIntervalMs", { minimum: 25 }),
      buildAfterPublish: readBoolean(watch.buildAfterPublish ?? DEFAULT_PUBLISHER_CONFIG.watch.buildAfterPublish, "watch.buildAfterPublish"),
      buildDebounceMs: readInteger(watch.buildDebounceMs ?? DEFAULT_PUBLISHER_CONFIG.watch.buildDebounceMs, "watch.buildDebounceMs", { minimum: 0 }),
      concurrency: readInteger(watch.concurrency ?? DEFAULT_PUBLISHER_CONFIG.watch.concurrency, "watch.concurrency", { minimum: 1, maximum: 16 }),
      retryAttempts: readInteger(watch.retryAttempts ?? DEFAULT_PUBLISHER_CONFIG.watch.retryAttempts, "watch.retryAttempts", { minimum: 0, maximum: 100 }),
      retryDelayMs: readInteger(watch.retryDelayMs ?? DEFAULT_PUBLISHER_CONFIG.watch.retryDelayMs, "watch.retryDelayMs", { minimum: 0 }),
    },
    safety: {
      allowMastersInsideRepository: readBoolean(
        safety.allowMastersInsideRepository ?? DEFAULT_PUBLISHER_CONFIG.safety.allowMastersInsideRepository,
        "safety.allowMastersInsideRepository",
      ),
      deleteOrphans: readBoolean(safety.deleteOrphans ?? DEFAULT_PUBLISHER_CONFIG.safety.deleteOrphans, "safety.deleteOrphans"),
    },
  };
}

async function resolveThroughExistingAncestor(targetPath) {
  let current = path.resolve(targetPath);
  const missingSegments = [];

  while (true) {
    try {
      const existing = await realpath(current);
      return path.resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function samePath(left, right) {
  return path.relative(left, right) === "";
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathsOverlap(left, right) {
  return samePath(left, right) || isInside(left, right) || isInside(right, left);
}

async function resolveAndValidatePaths(config, rootDir, configPath) {
  const repository = await resolveThroughExistingAncestor(rootDir);
  const mastersDir = await resolveThroughExistingAncestor(path.resolve(repository, config.mastersDir));
  const outputDir = await resolveThroughExistingAncestor(path.resolve(repository, config.outputDir));
  const cacheDir = await resolveThroughExistingAncestor(path.resolve(repository, config.cacheDir));

  if (!isInside(repository, outputDir)) {
    throw configurationError("outputDir", "must resolve to a directory inside the repository");
  }
  if (!isInside(repository, cacheDir)) {
    throw configurationError("cacheDir", "must resolve to a directory inside the repository");
  }
  if (!config.safety.allowMastersInsideRepository && (samePath(repository, mastersDir) || isInside(repository, mastersDir))) {
    throw configurationError("mastersDir", "must resolve outside the repository");
  }
  if (pathsOverlap(mastersDir, outputDir)) {
    throw configurationError("mastersDir", "must not overlap outputDir");
  }
  if (pathsOverlap(outputDir, cacheDir)) {
    throw configurationError("cacheDir", "must not overlap outputDir");
  }

  return {
    rootDir: repository,
    configPath: path.resolve(configPath),
    mastersDir,
    outputDir,
    cacheDir,
  };
}

export async function loadPublisherConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? defaultRootDir);
  const configPath = path.resolve(options.configPath ?? path.join(rootDir, "publisher.config.json"));
  let source;

  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Publisher configuration not found: ${configPath}`);
    throw new Error(`Could not read publisher configuration ${configPath}: ${error.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not parse publisher configuration ${configPath}: ${error.message}`);
  }

  const config = mergeAndValidate(raw);
  const paths = await resolveAndValidatePaths(config, rootDir, configPath);
  return { ...config, paths };
}
