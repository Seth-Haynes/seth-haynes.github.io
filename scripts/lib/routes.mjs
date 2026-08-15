import { slugify, unique } from "./utils.mjs";

function titleRoute(photo, filingSlug) {
  return `/photo/${slugify(photo.year)}/${filingSlug}/${slugify(photo.title)}/`;
}

function addSuffix(route, suffix) {
  return route.replace(/\/$/, `-${suffix}/`);
}

function claimRoute(baseRoute, photo, claimedRoutes) {
  const existingId = claimedRoutes.get(baseRoute);
  if (!existingId || existingId === photo.id) {
    claimedRoutes.set(baseRoute, photo.id);
    return baseRoute;
  }

  const filenameSlug = slugify(photo.filename.replace(/\.[^.]+$/, ""));
  let candidate = addSuffix(baseRoute, filenameSlug);
  let number = 2;
  while (claimedRoutes.has(candidate) && claimedRoutes.get(candidate) !== photo.id) {
    candidate = addSuffix(baseRoute, `${filenameSlug}-${number++}`);
  }
  claimedRoutes.set(candidate, photo.id);
  return candidate;
}

export function assignPhotoRoutes(photos) {
  const claimedRoutes = new Map();

  // Canonical routes are reserved before aliases so aliases can never displace
  // a photograph from its source-folder address.
  for (const photo of photos) {
    const sourceFolderSlug = photo.sourceFolderSlug || "archive";
    photo.route = claimRoute(titleRoute(photo, sourceFolderSlug), photo, claimedRoutes);
  }

  for (const photo of photos) {
    const aliases = [];
    photo.collectionRoutes = {};
    for (const collection of unique(photo.collections)) {
      const alias = claimRoute(titleRoute(photo, slugify(collection)), photo, claimedRoutes);
      photo.collectionRoutes[collection] = alias;
      if (alias !== photo.route) aliases.push(alias);
    }

    // Keep every filename-based URL working after the convention change.
    const legacyRoute = claimRoute(`/photo/${photo.id}/`, photo, claimedRoutes);
    photo.legacyRoute = legacyRoute;
    if (legacyRoute !== photo.route) aliases.push(legacyRoute);
    photo.aliasRoutes = unique(aliases);
  }

  return photos;
}
