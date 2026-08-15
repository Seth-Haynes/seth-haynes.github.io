import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { escapeXml, fileStamp, readJson, runPool, writeText } from "./utils.mjs";

const OUTPUT_FORMATS = {
  avif: (pipeline, quality) => pipeline.avif({ quality, effort: 3 }),
  webp: (pipeline, quality) => pipeline.webp({ quality, effort: 5 }),
  jpeg: (pipeline, quality) => pipeline.jpeg({ quality, mozjpeg: true }),
};

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sourceWidths(photo, configuredWidths) {
  const sourceWidth =
    Number(photo.sourceWidth) || Math.max(...configuredWidths);

  const maximumWidth = Math.min(
    sourceWidth,
    Math.max(...configuredWidths)
  );

  const widths = [
    ...new Set(
      configuredWidths
        .map(Number)
        .filter((width) => width > 0 && width <= maximumWidth)
    ),
  ];

  if (!widths.includes(maximumWidth)) {
    widths.push(maximumWidth);
  }

  return widths.sort((a, b) => a - b);
}

function dimensions(photo, width) {
  const ratio = photo.sourceWidth && photo.sourceHeight ? photo.sourceHeight / photo.sourceWidth : 2 / 3;
  return { width, height: Math.max(1, Math.round(width * ratio)) };
}

function wrapTitle(value, maxCharacters = 34) {
  const words = String(value).trim().split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || `${current} ${word}`.length <= maxCharacters) lines[lines.length - 1] = current ? `${current} ${word}` : word;
    else if (lines.length < 2) lines.push(word);
    else {
      lines[1] = `${lines[1]} ${word}`;
    }
  }
  if (lines[1]?.length > maxCharacters + 8) lines[1] = `${lines[1].slice(0, maxCharacters + 5).trim()}...`;
  return lines;
}

function socialCardOverlay(photo, config) {
  const titleLines = wrapTitle(photo.title).map((line, index) =>
    `<text x="72" y="${438 + index * 66}" class="title">${escapeXml(line)}</text>`,
  ).join("");
  const details = [photo.location, photo.date.slice(0, 4)].filter(Boolean).join(" / ");
  return Buffer.from(`
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <style>
        .name { fill: #e9ecec; font: 600 23px Arial, sans-serif; letter-spacing: 4px; }
        .title { fill: #f4f4f1; font: 600 54px Arial, sans-serif; }
        .details { fill: #c5ced2; font: 400 25px Arial, sans-serif; letter-spacing: .6px; }
      </style>
      <rect width="1200" height="630" fill="rgba(12,16,19,.16)"/>
      <rect x="0" y="345" width="1200" height="285" fill="rgba(9,13,16,.78)"/>
      <rect x="72" y="70" width="42" height="4" fill="#7894a2"/>
      <text x="132" y="84" class="name">${escapeXml(config.site.name.toUpperCase())}</text>
      ${titleLines}
      <text x="74" y="585" class="details">${escapeXml(details)}</text>
    </svg>
  `);
}

function photoOutputRecord(photo, widths, formats, preserveOriginals) {
  const renditions = {};
  for (const format of formats) {
    renditions[format] = widths.map((width) => ({
      ...dimensions(photo, width),
      path: `media/${photo.id}/image-${width}.${format === "jpeg" ? "jpg" : format}`,
    }));
  }
  return {
    ...photo,
    renditions,
    fallback: renditions.jpeg?.at(-1) ?? renditions.webp?.at(-1) ?? renditions.avif?.at(-1),
    ogPath: `media/${photo.id}/og.jpg`,
    originalPath: preserveOriginals ? `media/${photo.id}/original${path.extname(photo.sourcePath).toLowerCase()}` : null,
  };
}

export async function processImages({ photos, config, distDir, cacheDir }) {
  const imageConfig = config.images;
  const formats = imageConfig.formats.filter((format) => OUTPUT_FORMATS[format]);
  if (!formats.length) throw new Error("At least one supported image format is required.");
  if (!formats.includes("jpeg")) formats.push("jpeg");

  const mediaDir = path.join(distDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const cachePath = path.join(cacheDir, "images.json");
  const previousCache = await readJson(cachePath, {});
  const nextCache = {};

  const processed = await runPool(photos, Math.min(8, Math.max(2, Number(config.build?.imageConcurrency) || 4)), async (photo) => {
    const widths = sourceWidths(photo, imageConfig.widths);
    const record = photoOutputRecord(photo, widths, formats, imageConfig.preserveOriginals);
    const outputDir = path.join(mediaDir, photo.id);
    const stamp = await fileStamp(photo.sourcePath);
    const cacheKey = JSON.stringify({
      stamp,
      widths,
      formats,
      quality: imageConfig.quality,
      preserveOriginals: imageConfig.preserveOriginals,
      social: [photo.title, photo.location, photo.date, config.site.name],
    });
    const expected = [
      ...Object.values(record.renditions).flat().map((item) => path.join(distDir, item.path)),
      path.join(distDir, record.ogPath),
      ...(record.originalPath ? [path.join(distDir, record.originalPath)] : []),
    ];
    const cacheHit = previousCache[photo.id] === cacheKey && (await Promise.all(expected.map(exists))).every(Boolean);
    nextCache[photo.id] = cacheKey;
    if (cacheHit) return record;

    await mkdir(outputDir, { recursive: true });
    for (const [format, items] of Object.entries(record.renditions)) {
      for (const item of items) {
        const pipeline = sharp(photo.sourcePath).rotate().resize({ width: item.width, withoutEnlargement: true });
        await OUTPUT_FORMATS[format](pipeline, imageConfig.quality[format] ?? 80).toFile(path.join(distDir, item.path));
      }
    }

    await sharp(photo.sourcePath)
      .rotate()
      .resize(1200, 630, { fit: "cover", position: "attention" })
      .modulate({ brightness: 0.76, saturation: 0.82 })
      .composite([{ input: socialCardOverlay(photo, config) }])
      .jpeg({ quality: 84, mozjpeg: true })
      .toFile(path.join(distDir, record.ogPath));

    if (record.originalPath) await copyFile(photo.sourcePath, path.join(distDir, record.originalPath));
    return record;
  });

  const liveIds = new Set(processed.map((photo) => photo.id));
  for (const entry of await readdir(mediaDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !liveIds.has(entry.name)) await rm(path.join(mediaDir, entry.name), { recursive: true, force: true });
  }
  await writeText(cachePath, `${JSON.stringify(nextCache, null, 2)}\n`);

  const homepagePhoto = processed.find((photo) => photo.featured) ?? processed[0];
  if (homepagePhoto) await copyFile(path.join(distDir, homepagePhoto.ogPath), path.join(distDir, "og.jpg"));
  return processed;
}
