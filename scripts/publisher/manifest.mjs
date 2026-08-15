import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./files.mjs";

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = "manifest.json";

const ENTRY_KEYS = new Set([
  "source",
  "sourceSize",
  "sourceModified",
  "sourceHash",
  "settingsHash",
  "output",
  "outputHash",
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function manifestError(message) {
  return new Error(`Invalid publisher manifest: ${message}`);
}

function normalizeManifestPath(value, field) {
  if (typeof value !== "string" || !value.trim()) throw manifestError(`${field} must be a non-empty relative path`);
  const input = value.trim().replaceAll("\\", "/");
  if (path.posix.isAbsolute(input) || /^[a-z]:\//i.test(input)) {
    throw manifestError(`${field} must be relative`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw manifestError(`${field} must not leave its configured directory`);
  }
  return normalized;
}

function readNonNegativeNumber(value, field, { integer = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw manifestError(`${field} must be a non-negative ${integer ? "integer" : "number"}`);
  }
  return value;
}

function readHash(value, field) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw manifestError(`${field} must be a SHA-256 fingerprint`);
  }
  return value;
}

export function validateManifestEntry(value, label = "entry") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw manifestError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ENTRY_KEYS.has(key)) throw manifestError(`${label}.${key} is not recognized`);
  }
  for (const key of ENTRY_KEYS) {
    if (!(key in value)) throw manifestError(`${label}.${key} is required`);
  }

  return {
    source: normalizeManifestPath(value.source, `${label}.source`),
    sourceSize: readNonNegativeNumber(value.sourceSize, `${label}.sourceSize`, { integer: true }),
    sourceModified: readNonNegativeNumber(value.sourceModified, `${label}.sourceModified`),
    sourceHash: readHash(value.sourceHash, `${label}.sourceHash`),
    settingsHash: readHash(value.settingsHash, `${label}.settingsHash`),
    output: normalizeManifestPath(value.output, `${label}.output`),
    outputHash: readHash(value.outputHash, `${label}.outputHash`),
  };
}

function entryKey(source) {
  const normalized = normalizeManifestPath(source, "source");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function outputKey(output) {
  return normalizeManifestPath(output, "output").toLocaleLowerCase("en-US");
}

function cloneEntry(entry) {
  return { ...entry };
}

function equalEntries(left, right) {
  return ENTRY_KEYS.size === Object.keys(left).length
    && [...ENTRY_KEYS].every((key) => left[key] === right[key]);
}

function parseManifest(source, manifestPath) {
  let value;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not parse publisher manifest ${manifestPath}: ${error.message}`);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw manifestError("root must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "version" && key !== "entries") throw manifestError(`${key} is not recognized`);
  }
  if (value.version !== MANIFEST_VERSION) {
    throw manifestError(`version ${value.version ?? "is missing"}; expected ${MANIFEST_VERSION}`);
  }
  if (!Array.isArray(value.entries)) throw manifestError("entries must be an array");
  return value.entries.map((entry, index) => validateManifestEntry(entry, `entries.${index}`));
}

export class ManifestStore {
  #entries = new Map();
  #revision = 0;
  #savedRevision = 0;
  #writeQueue = Promise.resolve();

  constructor(manifestPath, entries = []) {
    this.path = path.resolve(manifestPath);
    const outputs = new Set();
    for (const value of entries) {
      const entry = validateManifestEntry(value);
      const key = entryKey(entry.source);
      if (this.#entries.has(key)) throw manifestError(`duplicate source path ${entry.source}`);
      const ownedOutput = outputKey(entry.output);
      if (outputs.has(ownedOutput)) throw manifestError(`duplicate output path ${entry.output}`);
      this.#entries.set(key, entry);
      outputs.add(ownedOutput);
    }
  }

  get size() {
    return this.#entries.size;
  }

  get dirty() {
    return this.#revision > this.#savedRevision;
  }

  get(source) {
    const entry = this.#entries.get(entryKey(source));
    return entry ? cloneEntry(entry) : null;
  }

  has(source) {
    return this.#entries.has(entryKey(source));
  }

  getByOutput(output) {
    const key = outputKey(output);
    const entry = [...this.#entries.values()].find((candidate) => outputKey(candidate.output) === key);
    return entry ? cloneEntry(entry) : null;
  }

  list() {
    return [...this.#entries.values()]
      .sort((left, right) => left.source.localeCompare(right.source, "en-US"))
      .map(cloneEntry);
  }

  set(value) {
    const entry = validateManifestEntry(value);
    const key = entryKey(entry.source);
    const previous = this.#entries.get(key);
    if (previous && equalEntries(previous, entry)) return false;
    const ownedOutput = outputKey(entry.output);
    for (const [candidateKey, candidate] of this.#entries) {
      if (candidateKey !== key && outputKey(candidate.output) === ownedOutput) {
        throw manifestError(`duplicate output path ${entry.output}`);
      }
    }
    this.#entries.set(key, entry);
    this.#revision += 1;
    return true;
  }

  delete(source) {
    const deleted = this.#entries.delete(entryKey(source));
    if (deleted) this.#revision += 1;
    return deleted;
  }

  async save() {
    const revision = this.#revision;
    if (revision <= this.#savedRevision) return false;
    const snapshot = {
      version: MANIFEST_VERSION,
      entries: this.list(),
    };

    const write = this.#writeQueue
      .catch(() => {})
      .then(() => atomicWriteJson(this.path, snapshot));
    this.#writeQueue = write;
    await write;
    this.#savedRevision = Math.max(this.#savedRevision, revision);
    return true;
  }
}

export async function loadManifest(cacheDir) {
  const manifestPath = path.join(path.resolve(cacheDir), MANIFEST_FILENAME);
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new ManifestStore(manifestPath);
    throw new Error(`Could not read publisher manifest ${manifestPath}: ${error.message}`);
  }
  return new ManifestStore(manifestPath, parseManifest(source, manifestPath));
}
