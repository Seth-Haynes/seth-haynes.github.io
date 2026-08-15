import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadCatalog, normalizeDate } from "../scripts/lib/catalog.mjs";
import { assignPhotoRoutes } from "../scripts/lib/routes.mjs";
import { formatDate, formatShortDate, slugify } from "../scripts/lib/utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(path.join(root, "site.config.json"), "utf8")
);

const expectedImageFormats = config.images.formats.map((format) =>
  format === "jpeg" ? "jpg" : format
);
const dist = path.join(root, "dist");
const basePath = String(process.env.SITE_BASE_PATH || "").replace(/^\/+|\/+$/g, "");
const catalog = JSON.parse(await readFile(path.join(dist, "data", "catalog.json"), "utf8"));

const forbiddenEmDashForms = [
  String.fromCodePoint(0x2014),
  ["&", "mdash"].join(""),
  ["&#", "8212"].join(""),
  ["&#x", "2014"].join(""),
  ["\\", "u2014"].join(""),
  String.fromCodePoint(0x00e2, 0x20ac, 0x201d),
];

function assertNoEmDash(content, label) {
  const lowerContent = content.toLowerCase();
  for (const form of forbiddenEmDashForms) {
    assert.equal(lowerContent.includes(form.toLowerCase()), false, `${label} contains an em dash`);
  }
}

const ownedTextExtensions = new Set([".mjs", ".js", ".json", ".md", ".html", ".css", ".svg", ".yml", ".yaml", ".txt", ".xml", ".ps1"]);
async function collectOwnedTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectOwnedTextFiles(full));
    else if (entry.isFile() && ownedTextExtensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

const ownedTextFiles = [
  ...await collectOwnedTextFiles(path.join(root, "scripts")),
  ...await collectOwnedTextFiles(path.join(root, "site")),
  ...await collectOwnedTextFiles(path.join(root, "tests")),
  ...await collectOwnedTextFiles(path.join(root, "photos")),
  ...["METADATA.md", "PUBLISHER-QUICK-GUIDE.md", "PUBLISHER.md", "README.md", "package.json", "publisher.config.json", "site.config.json"].map((name) => path.join(root, name)),
];
for (const file of ownedTextFiles) assertNoEmDash(await readFile(file, "utf8"), file);

const routeFixtures = [
  { id: "a", year: "2026", sourceFolderSlug: "new-york-city", title: "City Upon a Hill", filename: "frame-01.jpg", collections: ["New York City", "Summer 2026"] },
  { id: "b", year: "2026", sourceFolderSlug: "new-york-city", title: "City Upon a Hill", filename: "frame-02.jpg", collections: ["Summer 2026"] },
];
assignPhotoRoutes(routeFixtures);
assert.equal(routeFixtures[0].route, "/photo/2026/new-york-city/city-upon-a-hill/");
assert.equal(routeFixtures[0].collectionRoutes["New York City"], routeFixtures[0].route);
assert.equal(routeFixtures[0].collectionRoutes["Summer 2026"], "/photo/2026/summer-2026/city-upon-a-hill/");
assert.ok(routeFixtures[0].aliasRoutes.includes("/photo/2026/summer-2026/city-upon-a-hill/"));
assert.ok(routeFixtures[0].aliasRoutes.includes("/photo/a/"));
assert.notEqual(routeFixtures[1].route, routeFixtures[0].route, "matching titles must receive distinct canonical routes");

assert.equal(normalizeDate("2026-06", "2026"), "2026-06", "month-only dates should retain their precision");
assert.equal(normalizeDate("2026", "2026"), "2026", "year-only dates should retain their precision");
assert.equal(normalizeDate("2026-02-30", "2026"), "2026", "invalid full dates should fall back to the folder year");
assert.equal(formatDate("2026-06"), "June 2026");
assert.equal(formatShortDate("2026-06"), "Jun 2026");

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-metadata-"));
try {
  const fixtureFolder = path.join(fixtureRoot, "2026", "test-roll");
  await mkdir(fixtureFolder, { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#202a30" } }).jpeg().toFile(path.join(fixtureFolder, "frame-01.jpg"));
  await writeFile(path.join(fixtureFolder, "metadata.json"), JSON.stringify({
    title: "Test frame",
    date: "2026-06",
    film: "Kodak Portra 400",
  }), "utf8");
  const fixtureCatalog = await loadCatalog({ photosDir: fixtureRoot });
  assert.equal(fixtureCatalog.photos[0].date, "2026-06");
  assert.equal(fixtureCatalog.photos[0].filmStock, "Kodak Portra 400");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

assert.ok(catalog.photos.length > 0, "catalog should contain photographs");
assert.equal("sourcePath" in catalog.photos[0], false, "public catalog must not expose local source paths");
assert.equal("filmStock" in catalog.photos[0], true, "public catalog should include film-stock metadata");

function publicRouteFile(publicRoute) {
  let publicPath = publicRoute.split(/[?#]/)[0].replace(/^\/+/, "");
  if (basePath && publicPath.startsWith(`${basePath}/`)) publicPath = publicPath.slice(basePath.length + 1);
  return path.join(dist, publicPath, "index.html");
}

function canonicalPathFromHtml(html, label) {
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  assert.ok(canonical, `${label} should contain a canonical link`);
  return new URL(canonical, "https://local.invalid").pathname;
}

function publicPathname(publicUrl) {
  return new URL(publicUrl, "https://local.invalid").pathname;
}

const homepage = await readFile(path.join(dist, "index.html"), "utf8");
assert.match(homepage, /Here's what I've been looking at lately\.|Here’s what I’ve been looking at lately\./);
assert.doesNotMatch(homepage, /Jules/i);
assert.match(homepage, /Seth Haynes/);
const featuredSection = homepage.match(/<section class="featured-strip"[\s\S]*?<\/section>/)?.[0] ?? "";
const expectedFeatured = catalog.photos.filter((photo) => photo.featured).slice(0, config.homepage.featuredLimit);
assert.equal(expectedFeatured.length > 0, true, "fixture archive should include featured photographs");
for (const photo of expectedFeatured) {
  assert.ok(featuredSection.includes(`href="${photo.href}"`), `${photo.title} should appear in the homepage featured work`);
}

const collectionNames = [...new Set(catalog.photos.flatMap((photo) => photo.collections))].sort();
const collectionsIndex = await readFile(path.join(dist, "collections", "index.html"), "utf8");
for (const collectionName of collectionNames) {
  assert.ok(collectionsIndex.includes(`>${collectionName}</a></h2>`), `${collectionName} should appear on the collections page`);
  await access(path.join(dist, "collection", slugify(collectionName), "index.html"));
}

const quietBend = catalog.photos.find((photo) => photo.title === "Quiet Bend");
assert.ok(quietBend, "Quiet Bend should exist in the archive");
const summerQuietBend = "/photo/2026/summer-2026/quiet-bend/";
const riversideQuietBend = "/photo/2026/riverside-grocery/quiet-bend/";
assert.ok(quietBend.aliases.some((alias) => publicPathname(alias) === summerQuietBend), "Quiet Bend should have a Summer 2026 route");
assert.equal(publicPathname(quietBend.href), riversideQuietBend);
const summerGallery = await readFile(path.join(dist, "collection", "summer-2026", "index.html"), "utf8");
assert.ok(summerGallery.includes(`href="${basePath ? `/${basePath}` : ""}${summerQuietBend}"`), "Summer 2026 should link to its own Quiet Bend route");
const summerPhotoPage = await readFile(path.join(dist, "photo", "2026", "summer-2026", "quiet-bend", "index.html"), "utf8");
for (const contextHref of [...summerPhotoPage.matchAll(/data-(?:newer|older)-href="([^"]+)"/g)].map((match) => match[1]).filter(Boolean)) {
  assert.ok(publicPathname(contextHref).startsWith("/photo/2026/summer-2026/"), "Summer 2026 photo navigation should stay in Summer 2026");
}
const riversidePhotoPage = await readFile(path.join(dist, "photo", "2026", "riverside-grocery", "quiet-bend", "index.html"), "utf8");
for (const contextHref of [...riversidePhotoPage.matchAll(/data-(?:newer|older)-href="([^"]+)"/g)].map((match) => match[1]).filter(Boolean)) {
  assert.ok(publicPathname(contextHref).startsWith("/photo/2026/riverside-grocery/"), "Riverside Grocery photo navigation should stay in Riverside Grocery");
}

const search = await readFile(path.join(dist, "search", "index.html"), "utf8");
for (const field of ["year", "tag", "location", "camera", "lens", "filmStock"]) assert.match(search, new RegExp(`name="${field}"`));

for (const photo of catalog.photos) {
  assert.ok(photo.alt, `${photo.id} should have alt text`);
  assert.match(photo.href, /\/photo\/\d{4}\/.+\/.+\/$/, `${photo.id} should use the title-based route convention`);
  const publicImagePath = photo.image.src.replace(/^\/+/, "");
  const imagePath = basePath && publicImagePath.startsWith(`${basePath}/`) ? publicImagePath.slice(basePath.length + 1) : publicImagePath;
  await access(path.join(dist, imagePath));
  const page = await readFile(publicRouteFile(photo.href), "utf8");
  assert.match(page, /loading="eager"/);
  assert.match(page, /application\/ld\+json/);
  assert.equal(canonicalPathFromHtml(page, photo.id), publicPathname(photo.href));
  assert.ok(page.match(/<title>([^<]+)<\/title>/)?.[1].endsWith(` | ${config.site.name}`), `${photo.id} should use a pipe-separated page title`);
  for (const alias of photo.aliases) {
    const aliasPage = await readFile(publicRouteFile(alias), "utf8");
    assert.match(aliasPage, /<meta name="robots" content="noindex,follow">/);
    assert.equal(canonicalPathFromHtml(aliasPage, alias), publicPathname(photo.href));
  }
  for (const format of expectedImageFormats) {
    const mediaFiles = await readdir(path.join(dist, "media", photo.id));
    assert.ok(mediaFiles.some((name) => name.endsWith(`.${format}`)), `${photo.id} should have ${format} output`);
  }
}

async function collectHtml(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "media") files.push(...await collectHtml(full));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

for (const file of await collectHtml(dist)) {
  const html = await readFile(file, "utf8");
  assertNoEmDash(html, file);
  assert.match(html, /<html lang="en">/, `${file} should declare language`);
  assert.doesNotMatch(html, /<img(?![^>]*\balt=)[^>]*>/i, `${file} contains an image without alt text`);
  const references = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  for (const reference of references) {
    if (/^(?:https?:|mailto:|tel:|data:|#)/.test(reference)) continue;
    let publicPath = reference.split(/[?#]/)[0].replace(/^\/+/, "");
    if (basePath && publicPath.startsWith(`${basePath}/`)) publicPath = publicPath.slice(basePath.length + 1);
    else if (basePath && publicPath === basePath) publicPath = "";
    const target = reference.endsWith("/") || !path.extname(publicPath) ? path.join(dist, publicPath, "index.html") : path.join(dist, publicPath);
    await access(target).catch(() => assert.fail(`${file} links to missing local file ${reference}`));
  }
}

console.log(`Verified ${catalog.photos.length} photographs, responsive image outputs, archive filters, canonical title routes, and aliases.`);
