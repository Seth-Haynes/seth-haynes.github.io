import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

export async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function walk(directory) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else found.push(fullPath);
    }
  }
  await visit(directory);
  return found;
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeXml(value = "") {
  return escapeHtml(value);
}

export function slugify(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

export function humanizeFilename(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function cleanBasePath(value = "") {
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function createUrlHelpers(config) {
  const basePath = cleanBasePath(process.env.SITE_BASE_PATH ?? config.site.basePath);
  const siteUrl = String(process.env.SITE_URL ?? config.site.siteUrl ?? "").replace(/\/+$/, "");
  const url = (pathname = "/") => {
    const clean = `/${String(pathname).replace(/^\/+/, "")}`;
    return `${basePath}${clean}` || "/";
  };
  const absolute = (pathname = "/") => siteUrl ? `${siteUrl}${url(pathname)}` : url(pathname);
  return { basePath, siteUrl, url, absolute };
}

export function unique(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

export function groupBy(items, getValues) {
  const groups = new Map();
  for (const item of items) {
    const values = Array.isArray(getValues(item)) ? getValues(item) : [getValues(item)];
    for (const value of values.filter(Boolean)) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(item);
    }
  }
  return groups;
}

export function sortedGroups(groups, order = "name") {
  const entries = [...groups.entries()].map(([name, items]) => ({ name, items }));
  if (order === "count") return entries.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  if (order === "year") return entries.sort((a, b) => Number(b.name) - Number(a.name));
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatDate(value) {
  if (!value) return "Date not recorded";
  const text = String(value);
  if (/^\d{4}$/.test(text)) return text;
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(text);
  if (monthOnly) {
    const date = new Date(`${text}-01T12:00:00Z`);
    if (Number.isNaN(date.valueOf())) return text;
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" }).format(date);
  }
  const date = new Date(`${text.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
}

export function formatShortDate(value) {
  if (!value) return "Undated";
  const text = String(value);
  if (/^\d{4}$/.test(text)) return text;
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(text);
  if (monthOnly) {
    const date = new Date(`${text}-01T12:00:00Z`);
    if (Number.isNaN(date.valueOf())) return text;
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", timeZone: "UTC" }).format(date);
  }
  const date = new Date(`${text.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function sortNewest(items) {
  return [...items].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export async function fileStamp(filePath) {
  const details = await stat(filePath);
  return `${details.size}:${Math.floor(details.mtimeMs)}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
