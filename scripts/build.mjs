import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./lib/catalog.mjs";
import { processImages } from "./lib/images.mjs";
import { createRenderer } from "./lib/render.mjs";
import { assignPhotoRoutes } from "./lib/routes.mjs";
import { createUrlHelpers, escapeXml, formatShortDate, groupBy, readJson, slugify, sortedGroups, writeText } from "./lib/utils.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const photosDir = path.join(rootDir, "photos");
const siteDir = path.join(rootDir, "site");
const distDir = path.join(rootDir, "dist");
const cacheDir = path.join(rootDir, ".cache");
const config = await readJson(path.join(rootDir, "site.config.json"));
const helpers = createUrlHelpers(config);

await mkdir(distDir, { recursive: true });
for (const entry of await readdir(distDir, { withFileTypes: true })) {
  if (entry.name !== "media") await rm(path.join(distDir, entry.name), { recursive: true, force: true });
}

const { photos: rawPhotos, warnings } = await loadCatalog({ photosDir });
if (!rawPhotos.length) throw new Error("No photographs found. Add an image under photos/<year>/<folder>/ and build again.");
const photos = await processImages({ photos: rawPhotos, config, distDir, cacheDir });
assignPhotoRoutes(photos);

const groups = {
  years: sortedGroups(groupBy(photos, (photo) => photo.year), "year"),
  tags: sortedGroups(groupBy(photos, (photo) => photo.tags), "name"),
  locations: sortedGroups(groupBy(photos, (photo) => photo.location), "name"),
  collections: sortedGroups(groupBy(photos, (photo) => photo.collections), "name"),
};
const collectionByName = new Map(groups.collections.map((entry) => [entry.name, entry]));
const render = createRenderer({ config, photos, groups, ...helpers });
const collectionRouteFor = (name) => (photo) => helpers.url(photo.collectionRoutes?.[name] ?? photo.route);

function routeFile(route) {
  if (route.endsWith(".html")) return path.join(distDir, route.replace(/^\/+/, ""));
  const clean = route.replace(/^\/+|\/+$/g, "");
  return path.join(distDir, clean, "index.html");
}

const pages = [];
async function writePage(route, html, { includeInSitemap = true } = {}) {
  await writeText(routeFile(route), html);
  if (includeInSitemap) pages.push(route);
}

await cp(path.join(siteDir, "assets"), path.join(distDir, "assets"), { recursive: true });
await writeText(path.join(distDir, ".nojekyll"), "");

await writePage("/", render.indexPage());
await writePage("/recent/", render.galleryPage({
  title: "Recent photographs",
  intro: "The newest entries, in the order they were made.",
  items: photos.slice(0, 60),
  path: "/recent/",
}));
await writePage("/all/", render.galleryPage({
  title: "All photographs",
  intro: "The complete archive, newest first.",
  items: photos,
  path: "/all/",
}));
await writePage("/browse/", render.browsePage());
await writePage("/search/", render.searchPage());
await writePage("/collections/", render.collectionsPage());
await writePage("/years/", render.groupIndexPage({ title: "By year", intro: "A chronological index of the archive.", kind: "years", entries: groups.years }));
await writePage("/tags/", render.groupIndexPage({ title: "By subject", intro: "Buildings, weather, infrastructure, signs, and other recurring details.", kind: "tags", entries: groups.tags }));
await writePage("/locations/", render.groupIndexPage({ title: "By location", intro: "Places named in the photograph records.", kind: "locations", entries: groups.locations }));
await writePage("/about/", render.aboutPage());
await writePage("/contact/", render.contactPage());
await writePage("/404.html", render.notFoundPage());

for (const { name, items } of groups.years) {
  await writePage(`/year/${slugify(name)}/`, render.galleryPage({ title: name, intro: `${items.length} ${items.length === 1 ? "photograph" : "photographs"} made in ${name}.`, items, path: `/year/${slugify(name)}/` }));
}
for (const { name, items } of groups.tags) {
  await writePage(`/tag/${slugify(name)}/`, render.galleryPage({ title: name, intro: `Photographs filed under “${name}.”`, items, path: `/tag/${slugify(name)}/` }));
}
for (const { name, items } of groups.locations) {
  await writePage(`/location/${slugify(name)}/`, render.galleryPage({ title: name, intro: `Photographs made in and around ${name}.`, items, path: `/location/${slugify(name)}/` }));
}
for (const { name, items } of groups.collections) {
  const routeForPhoto = collectionRouteFor(name);
  await writePage(`/collection/${slugify(name)}/`, render.galleryPage({
    title: name,
    intro: config.collectionDescriptions[name] || `A working collection of ${items.length} ${items.length === 1 ? "photograph" : "photographs"}.`,
    items,
    active: "collections",
    path: `/collection/${slugify(name)}/`,
    routeForPhoto,
  }));

  for (const photo of items) {
    const collectionPhotoRoute = photo.collectionRoutes?.[name];
    if (!collectionPhotoRoute || collectionPhotoRoute === photo.route) continue;
    await writePage(collectionPhotoRoute, render.photoPage(photo, {
      path: collectionPhotoRoute,
      canonicalPath: photo.route,
      alias: true,
      sequenceItems: items,
      routeForPhoto,
    }), { includeInSitemap: false });
  }
}
for (const photo of photos) {
  const sourceCollection = photo.collections
    .map((name) => collectionByName.get(name))
    .find((entry) => entry && slugify(entry.name) === photo.sourceFolderSlug);
  await writePage(photo.route, render.photoPage(photo, sourceCollection ? {
    sequenceItems: sourceCollection.items,
    routeForPhoto: collectionRouteFor(sourceCollection.name),
  } : {}));

  if (photo.legacyRoute && photo.legacyRoute !== photo.route) {
    await writePage(photo.legacyRoute, render.photoPage(photo, {
      path: photo.legacyRoute,
      canonicalPath: photo.route,
      alias: true,
    }), { includeInSitemap: false });
  }
}

const publicCatalog = {
  generatedAt: new Date().toISOString(),
  count: photos.length,
  photos: photos.map((photo) => ({
    id: photo.id,
    title: photo.title,
    description: photo.description,
    location: photo.location,
    date: photo.date,
    shortDate: formatShortDate(photo.date),
    year: photo.year,
    camera: photo.camera,
    lens: photo.lens,
    filmStock: photo.filmStock,
    focalLength: photo.focalLength,
    aperture: photo.aperture,
    shutterSpeed: photo.shutterSpeed,
    iso: photo.iso,
    tags: photo.tags,
    collections: photo.collections,
    featured: photo.featured,
    alt: photo.alt,
    href: helpers.url(photo.route),
    aliases: photo.aliasRoutes.map((route) => helpers.url(route)),
    image: { src: helpers.url(`/${photo.fallback.path}`), width: photo.fallback.width, height: photo.fallback.height },
    searchText: [photo.title, photo.description, photo.location, photo.camera, photo.lens, photo.filmStock, ...photo.tags, ...photo.collections].join(" ").toLowerCase(),
  })),
};
await writeText(path.join(distDir, "data", "catalog.json"), `${JSON.stringify(publicCatalog, null, 2)}\n`);

if (helpers.siteUrl) {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((route) => `  <url><loc>${escapeXml(helpers.absolute(route))}</loc></url>`).join("\n")}\n</urlset>\n`;
  await writeText(path.join(distDir, "sitemap.xml"), sitemap);
  await writeText(path.join(distDir, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${helpers.absolute("/sitemap.xml")}\n`);
}

for (const warning of warnings) console.warn(`Warning: ${warning}`);
if (!helpers.siteUrl) console.warn("Warning: site.siteUrl is empty; set SITE_URL during deployment for absolute sharing links and a sitemap.");
console.log(`Built ${photos.length} photographs into ${pages.length} pages.`);
console.log(`Output: ${distDir}`);
