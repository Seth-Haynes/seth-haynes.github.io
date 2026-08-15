import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import sharp from "sharp";

const FINGERPRINT_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function hashValue(value) {
  const serialized = JSON.stringify(stableValue(value));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export async function readFileStamp(filePath) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`Publisher source is not a file: ${filePath}`);
  return {
    sourceSize: details.size,
    sourceModified: Math.trunc(details.mtimeMs),
  };
}

export function imageSettingsHash(imageConfig) {
  return hashValue({
    fingerprintVersion: FINGERPRINT_VERSION,
    outputFormat: "jpeg",
    sharpVersion: sharp.versions.sharp,
    vipsVersion: sharp.versions.vips,
    longEdge: imageConfig.longEdge,
    jpegQuality: imageConfig.jpegQuality,
    mozjpeg: imageConfig.mozjpeg,
    stripMetadata: imageConfig.stripMetadata,
    neverUpscale: imageConfig.neverUpscale,
  });
}
