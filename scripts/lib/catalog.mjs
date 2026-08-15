import path from "node:path";
import exifr from "exifr";
import sharp from "sharp";
import { IMAGE_EXTENSIONS, humanizeFilename, readJson, runPool, slugify, sortNewest, unique, walk } from "./utils.mjs";

const EXIF_FIELDS = [
  "Make",
  "Model",
  "LensModel",
  "LensInfo",
  "DateTimeOriginal",
  "CreateDate",
  "FocalLength",
  "FNumber",
  "ExposureTime",
  "ISO",
];

const asNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function formatCamera(make, model) {
  const cleanMake = String(make ?? "").trim();
  const cleanModel = String(model ?? "").trim();
  if (!cleanModel) return cleanMake;
  if (!cleanMake || cleanModel.toLowerCase().includes(cleanMake.toLowerCase())) return cleanModel;
  return `${cleanMake} ${cleanModel}`;
}

function formatFocalLength(value) {
  const number = asNumber(value);
  return number ? `${Number.isInteger(number) ? number : number.toFixed(1)} mm` : "";
}

function formatAperture(value) {
  const number = asNumber(value);
  return number ? `f/${Number.isInteger(number) ? number : number.toFixed(1)}` : "";
}

function formatShutter(value) {
  const number = asNumber(value);
  if (!number) return "";
  if (number >= 1) return `${Number.isInteger(number) ? number : number.toFixed(1)} s`;
  return `1/${Math.max(1, Math.round(1 / number))} s`;
}

function formatIso(value) {
  const number = asNumber(value);
  return number ? `ISO ${Math.round(number)}` : "";
}

export function normalizeDate(value, folderYear) {
  const fallback = /^\d{4}$/.test(folderYear) ? folderYear : "1970";
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);

  const text = String(value ?? "").trim();
  if (/^\d{4}$/.test(text)) return text;
  if (/^\d{4}-\d{2}$/.test(text)) return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(text) ? text : fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T12:00:00Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text) return text;
    return fallback;
  }

  if (text) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  }
  return fallback;
}

function mergeMetadata(folderMetadata, imageMetadata) {
  const { images: _images, tags: folderTags = [], collections: folderCollections = [], ...defaults } = folderMetadata;
  return {
    ...defaults,
    ...imageMetadata,
    tags: unique([...folderTags, ...(imageMetadata.tags ?? [])]),
    collections: unique([...folderCollections, ...(imageMetadata.collections ?? [])]),
  };
}

export async function loadCatalog({ photosDir }) {
  const files = (await walk(photosDir))
    .filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort();

  const countsByFolder = new Map();
  for (const filePath of files) {
    const directory = path.dirname(filePath);
    countsByFolder.set(directory, (countsByFolder.get(directory) ?? 0) + 1);
  }

  const directories = [...countsByFolder.keys()];
  const metadataEntries = await runPool(directories, 16, async (directory) => [directory, await readJson(path.join(directory, "metadata.json"), {})]);
  const metadataCache = new Map(metadataEntries);
  const warnings = [];

  const photos = (await runPool(files, 12, async (sourcePath) => {
    const relative = path.relative(photosDir, sourcePath).replaceAll("\\", "/");
    const segments = relative.split("/");
    if (segments.length < 3 || !/^\d{4}$/.test(segments[0])) {
      warnings.push(`Ignored ${relative}; expected photos/<year>/<folder>/<image>.`);
      return null;
    }

    const directory = path.dirname(sourcePath);
    const folderMetadata = metadataCache.get(directory);
    const filename = path.basename(sourcePath);
    const imageMetadata =
      Object.entries(folderMetadata.images ?? {}).find(
        ([name]) => name.toLowerCase() === filename.toLowerCase()
      )?.[1] ?? {};
    const metadata = mergeMetadata(folderMetadata, imageMetadata);

    let exif = {};
    try {
      exif = await exifr.parse(sourcePath, EXIF_FIELDS) ?? {};
    } catch (error) {
      warnings.push(`Could not read EXIF from ${relative}: ${error.message}`);
    }

    const imageInfo = await sharp(sourcePath).metadata();
    const id = segments.map((segment, index) => index === segments.length - 1 ? slugify(path.basename(segment, path.extname(segment))) : slugify(segment)).join("--");
    const multipleInFolder = (countsByFolder.get(directory) ?? 0) > 1;
    const fallbackTitle = humanizeFilename(filename);
    const title = imageMetadata.title || (multipleInFolder && folderMetadata.title ? `${folderMetadata.title} | ${fallbackTitle}` : folderMetadata.title) || fallbackTitle;
    const camera = metadata.camera || formatCamera(exif.Make, exif.Model);
    const lens = metadata.lens || exif.LensModel || (Array.isArray(exif.LensInfo) ? exif.LensInfo.join("–") : exif.LensInfo) || "";
    const date = normalizeDate(metadata.date || exif.DateTimeOriginal || exif.CreateDate, segments[0]);
    const description = String(metadata.description ?? "").trim();
    const location = String(metadata.location ?? "").trim();

    if (!metadata.date && !exif.DateTimeOriginal && !exif.CreateDate) warnings.push(`${relative} has no capture date; using ${date}.`);
    if (!metadata.title && !folderMetadata.title) warnings.push(`${relative} has no title; using the file name.`);

    return {
      id,
      sourcePath,
      sourceRelative: relative,
      filename,
      sourceFolderSlug: segments.slice(1, -1).map(slugify).join("/"),
      title: String(title),
      description,
      location,
      date,
      year: date.slice(0, 4),
      camera: String(camera ?? "").trim(),
      lens: String(lens ?? "").trim(),
      filmStock: String(metadata.filmStock ?? metadata.film ?? "").trim(),
      focalLength: String(metadata.focalLength || formatFocalLength(exif.FocalLength)).trim(),
      aperture: String(metadata.aperture || formatAperture(exif.FNumber)).trim(),
      shutterSpeed: String(metadata.shutterSpeed || formatShutter(exif.ExposureTime)).trim(),
      iso: String(metadata.iso ? `ISO ${metadata.iso}` : formatIso(exif.ISO)).trim(),
      tags: metadata.tags,
      collections: metadata.collections,
      featured: Boolean(metadata.featured),
      alt: String(metadata.alt || description || `${title}${location ? ` in ${location}` : ""}`).trim(),
      credit: metadata.credit && typeof metadata.credit === "object" ? metadata.credit : null,
      sourceWidth: imageInfo.autoOrient?.width ?? imageInfo.width,
      sourceHeight: imageInfo.autoOrient?.height ?? imageInfo.height,
      orientation: (imageInfo.autoOrient?.height ?? imageInfo.height) > (imageInfo.autoOrient?.width ?? imageInfo.width) ? "portrait" : "landscape",
    };
  })).filter(Boolean);

  const ordered = sortNewest(photos);
  ordered.forEach((photo, index) => {
    photo.newerId = ordered[index - 1]?.id ?? null;
    photo.olderId = ordered[index + 1]?.id ?? null;
  });

  return { photos: ordered, warnings };
}
