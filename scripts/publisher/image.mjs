import sharp from "sharp";
import { hashBytes } from "./fingerprint.mjs";

export async function renderRepositoryJpeg(sourcePath, imageConfig) {
  let pipeline = sharp(sourcePath, { failOn: "error", sequentialRead: true })
    .rotate()
    .resize({
      width: imageConfig.longEdge,
      height: imageConfig.longEdge,
      fit: "inside",
      withoutEnlargement: imageConfig.neverUpscale,
    });

  if (!imageConfig.stripMetadata) pipeline = pipeline.keepMetadata();
  const buffer = await pipeline
    .jpeg({
      quality: imageConfig.jpegQuality,
      mozjpeg: imageConfig.mozjpeg,
    })
    .toBuffer();

  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  if (metadata.format !== "jpeg" || !metadata.width || !metadata.height) {
    throw new Error(`Publisher generated an invalid JPEG for ${sourcePath}`);
  }
  if (Math.max(metadata.width, metadata.height) > imageConfig.longEdge) {
    throw new Error(`Publisher generated an oversized JPEG for ${sourcePath}`);
  }

  return {
    buffer,
    outputHash: hashBytes(buffer),
    width: metadata.width,
    height: metadata.height,
  };
}
