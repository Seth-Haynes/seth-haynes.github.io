import { escapeHtml, formatDate, formatShortDate, slugify } from "./utils.mjs";

const e = escapeHtml;

function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function createRenderer({ config, photos, groups, url, absolute }) {
  const homeFeatured = photos.filter((photo) => photo.featured).slice(0, config.homepage.featuredLimit);
  const featured = homeFeatured.length ? homeFeatured : photos.slice(0, config.homepage.featuredLimit);

  const photoRoute = (photo) => url(photo.route);
  const groupRoute = (kind, name) => url(`/${kind}/${slugify(name)}/`);
  const srcset = (items) => items.map((item) => `${url(`/${item.path}`)} ${item.width}w`).join(", ");

  function picture(photo, { loading = "lazy", sizes = "(min-width: 72rem) 33vw, (min-width: 46rem) 50vw, 100vw", className = "" } = {}) {
    const fallback = photo.fallback;
    return `<picture class="${e(className)}">
      ${photo.renditions.avif ? `<source type="image/avif" srcset="${srcset(photo.renditions.avif)}" sizes="${e(sizes)}">` : ""}
      ${photo.renditions.webp ? `<source type="image/webp" srcset="${srcset(photo.renditions.webp)}" sizes="${e(sizes)}">` : ""}
      <img src="${url(`/${fallback.path}`)}" srcset="${srcset(photo.renditions.jpeg ?? [fallback])}" sizes="${e(sizes)}" width="${fallback.width}" height="${fallback.height}" alt="${e(photo.alt)}" loading="${loading}" decoding="async">
    </picture>`;
  }

  function photoCard(photo, { priority = false, featuredCard = false, routeForPhoto = photoRoute } = {}) {
    const href = routeForPhoto(photo);
    return `<article class="photo-card photo-card--${e(photo.orientation)}${featuredCard ? " photo-card--featured" : ""}">
      <a class="photo-card__image" href="${href}" aria-label="View ${e(photo.title)}">
        ${picture(photo, { loading: priority ? "eager" : "lazy", className: `ratio-${photo.orientation}` })}
      </a>
      <div class="photo-card__caption">
        <h3><a href="${href}">${e(photo.title)}</a></h3>
        <p>${[photo.location, formatShortDate(photo.date)].filter(Boolean).map(e).join(" <span aria-hidden=\"true\">/</span> ")}</p>
      </div>
    </article>`;
  }

  function photoGrid(items, options = {}) {
    if (!items.length) return `<p class="empty-state">Nothing has been filed here yet.</p>`;
    return `<div class="photo-grid">${items.map((photo, index) => photoCard(photo, {
      priority: index < (options.priorityCount ?? 0),
      routeForPhoto: options.routeForPhoto ?? photoRoute,
    })).join("")}</div>`;
  }

  function navigation(active = "") {
    const links = [
      ["portfolio", "Portfolio", "/all/"],
      ["collections", "Collections", "/collections/"],
      ["browse", "Browse", "/browse/"],
      ["about", "About", "/about/"],
      ["contact", "Contact", "/contact/"],
    ];
    return `<header class="site-header">
      <a class="wordmark" href="${url("/")}" aria-label="${e(config.site.name)}, photographs, home">
        <img
          class="wordmark__logo"
          src="${url("/assets/logo.svg")}"
          alt=""
          width="48"
          height="48"
        >
        <span class="wordmark__text">
          <span class="wordmark__name">${e(config.site.name)}.</span>
          <span class="wordmark__divider" aria-hidden="true">-</span>
          <span class="wordmark__descriptor">Photographs</span>
        </span>
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
      <nav id="site-nav" class="site-nav" aria-label="Primary">
        ${links.map(([key, label, href]) => `<a href="${url(href)}"${active === key ? " aria-current=\"page\"" : ""}>${label}</a>`).join("")}
      </nav>
    </header>`;
  }

  function layout({ title, description = config.site.description, active = "", path = "/", canonicalPath = path, ogPath = "/og.jpg", content, bodyClass = "", extraHead = "" }) {
    const fullTitle = title === config.site.name ? config.site.title : `${title} | ${config.site.name}`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#11171a">
  <title>${e(fullTitle)}</title>
  <meta name="description" content="${e(description)}">
  <link rel="canonical" href="${e(absolute(canonicalPath))}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${e(fullTitle)}">
  <meta property="og:description" content="${e(description)}">
  <meta property="og:url" content="${e(absolute(canonicalPath))}">
  <meta property="og:image" content="${e(absolute(ogPath))}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="${url("/assets/favicon.svg")}" type="image/svg+xml">
  <link rel="stylesheet" href="${url("/assets/site.css")}">
  ${extraHead}
</head>
<body class="${e(bodyClass)}" data-catalog-url="${url("/data/catalog.json")}">
  <a class="skip-link" href="#content">Skip to content</a>
  <div class="site-shell">
    ${navigation(active)}
    <main id="content">${content}</main>
    <footer class="site-footer">
      <p>Photographs and notes by ${e(config.site.name)}.</p>
      <p><a href="${url("/contact/")}">Contact</a> <span aria-hidden="true">/</span> <a href="${url("/search/")}">Search the archive</a></p>
    </footer>
  </div>
  <script src="${url("/assets/site.js")}" defer></script>
</body>
</html>\n`;
  }

  function indexPage() {
    const collectionCount = groups.collections.length;
    const latestDate = photos[0]?.date;
    return layout({
      title: config.site.name,
      path: "/",
      bodyClass: "home",
      content: `<section class="home-intro" aria-labelledby="home-heading">
        <p class="eyebrow">Field notes / ${e(config.site.region)}</p>
        <h1 id="home-heading">Here's what I've been looking at lately.</h1>
        <p>${e(config.homepage.introduction)}</p>
        <dl class="archive-status" aria-label="Archive summary">
          <div><dt>Photographs</dt><dd>${photos.length}</dd></div>
          <div><dt>Collections</dt><dd>${collectionCount}</dd></div>
          <div><dt>Latest entry</dt><dd>${latestDate ? e(formatShortDate(latestDate)) : "|"}</dd></div>
        </dl>
      </section>
      <section class="featured-strip" aria-label="Newest featured photographs">
        ${featured.map((photo, index) => photoCard(photo, { priority: true, featuredCard: index === 0 })).join("")}
      </section>
      <section class="section-block section-block--ruled" aria-labelledby="recent-heading">
        <div class="section-heading"><div><p class="eyebrow">Recent work</p><h2 id="recent-heading">The latest entries</h2></div><a class="text-link" href="${url("/recent/")}">View recent photographs</a></div>
        ${photoGrid(photos.slice(0, config.homepage.recentLimit))}
      </section>
      <section class="directory-callout" aria-labelledby="find-heading">
        <div><p class="eyebrow">Ways into the archive</p><h2 id="find-heading">Filed by what I remember.</h2></div>
        <nav aria-label="Browse the archive"><a href="${url("/collections/")}">Collections</a><a href="${url("/years/")}">Years</a><a href="${url("/locations/")}">Locations</a><a href="${url("/tags/")}">Subjects</a><a href="${url("/search/")}">Search</a></nav>
      </section>`,
    });
  }

  function galleryPage({ title, intro, items, active = "portfolio", path, routeForPhoto }) {
    return layout({
      title,
      description: intro,
      active,
      path,
      content: `<header class="page-heading"><p class="eyebrow">Archive / ${items.length} ${items.length === 1 ? "photograph" : "photographs"}</p><h1>${e(title)}</h1><p>${e(intro)}</p></header>${photoGrid(items, { priorityCount: 2, routeForPhoto })}`,
    });
  }

  function groupIndexPage({ title, intro, kind, entries, active = "browse" }) {
    return layout({
      title,
      description: intro,
      active,
      path: `/${kind}/`,
      content: `<header class="page-heading"><p class="eyebrow">Archive directory</p><h1>${e(title)}</h1><p>${e(intro)}</p></header>
        <div class="index-list">${entries.map(({ name, items }) => `<a href="${groupRoute(kind.slice(0, -1), name)}"><span>${e(name)}</span><small>${items.length} ${items.length === 1 ? "photograph" : "photographs"}</small></a>`).join("")}</div>`,
    });
  }

  function browsePage() {
    const rows = [
      ["Recent photographs", "Newest first, across the whole archive.", "/recent/", photos.length],
      ["All photographs", "The complete index.", "/all/", photos.length],
      ["Collections", "Work that belongs together. A photograph may appear in more than one.", "/collections/", groups.collections.length],
      ["Years", "A chronological filing cabinet.", "/years/", groups.years.length],
      ["Locations", "Towns, roads, rivers, and other named places.", "/locations/", groups.locations.length],
      ["Subjects", "Buildings, weather, signs, infrastructure, and other details.", "/tags/", groups.tags.length],
    ];
    return layout({
      title: "Browse",
      active: "browse",
      path: "/browse/",
      content: `<header class="page-heading"><p class="eyebrow">Archive</p><h1>Browse the photographs.</h1><p>There are a few useful ways to find a place again.</p></header>
        <div class="browse-list">${rows.map(([name, note, href, count]) => `<a href="${url(href)}"><span><strong>${e(name)}</strong><small>${e(note)}</small></span><b>${count}</b></a>`).join("")}</div>
        <p class="search-prompt"><a class="button-link" href="${url("/search/")}">Filter the full archive</a></p>`,
    });
  }

  function chooseCollectionCovers(entries) {
    const usedPhotoIds = new Set();
    const coverByCollectionIndex = new Map();

    const choices = entries.map((entry, index) => {
      const featuredPhotos = entry.items.filter((photo) => photo.featured);
      return {
        index,
        candidates: featuredPhotos.length ? featuredPhotos : entry.items,
      };
    });

    // Assign collections with the fewest choices first. This leaves more
    // unused options for collections that share several featured photographs.
    choices.sort((a, b) => a.candidates.length - b.candidates.length || a.index - b.index);

    for (const choice of choices) {
      const unusedCandidates = choice.candidates.filter((photo) => !usedPhotoIds.has(photo.id));
      const pool = unusedCandidates.length ? unusedCandidates : choice.candidates;
      const cover = pool[Math.floor(Math.random() * pool.length)];
      if (!cover) continue;
      coverByCollectionIndex.set(choice.index, cover);
      usedPhotoIds.add(cover.id);
    }

    return entries.map((entry, index) => ({
      ...entry,
      cover: coverByCollectionIndex.get(index) ?? entry.items[0],
    }));
  }

  function collectionsPage() {
    const collectionsWithCovers = chooseCollectionCovers(groups.collections);
    return layout({
      title: "Collections",
      active: "collections",
      path: "/collections/",
      content: `<header class="page-heading"><p class="eyebrow">Collections</p><h1>Work that belongs together.</h1><p>A photograph can be filed in several collections. No duplicate files are needed.</p></header>
      <div class="collection-index">${collectionsWithCovers.map(({ name, items, cover }, index) => {
        const description = config.collectionDescriptions[name] || `A working collection of ${items.length} ${items.length === 1 ? "photograph" : "photographs"}.`;
        return `<article><a class="collection-cover" href="${groupRoute("collection", name)}">${picture(cover, { loading: index < 2 ? "eager" : "lazy", sizes: "(min-width: 56rem) 50vw, 100vw" })}</a><div><p class="eyebrow">${items.length} ${items.length === 1 ? "entry" : "entries"}</p><h2><a href="${groupRoute("collection", name)}">${e(name)}</a></h2><p>${e(description)}</p></div></article>`;
      }).join("")}</div>`,
    });
  }

  function metadataList(photo) {
    const entries = [
      ["Date", formatDate(photo.date)], ["Location", photo.location], ["Camera", photo.camera], ["Lens", photo.lens], ["Film stock", photo.filmStock],
      ["Focal length", photo.focalLength], ["Aperture", photo.aperture], ["Shutter", photo.shutterSpeed], ["ISO", photo.iso],
    ].filter(([, value]) => value);
    if (!entries.length) return "";
    return `<dl class="photo-metadata">${entries.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>`;
  }

  function photoPage(photo, {
    path = photo.route,
    canonicalPath = photo.route,
    alias = false,
    sequenceItems = photos,
    routeForPhoto = photoRoute,
  } = {}) {
    const sequenceIndex = sequenceItems.findIndex((item) => item.id === photo.id);
    const newer = sequenceIndex > 0 ? sequenceItems[sequenceIndex - 1] : null;
    const older = sequenceIndex >= 0 ? sequenceItems[sequenceIndex + 1] ?? null : null;
    const details = photo.description ? `<p class="photo-description">${e(photo.description)}</p>` : "";
    const tags = photo.tags.map((tag) => `<a href="${groupRoute("tag", tag)}">${e(tag)}</a>`).join("");
    const collections = photo.collections.map((name) => `<a href="${groupRoute("collection", name)}">${e(name)}</a>`).join("");
    const credit = photo.credit?.name ? `<p class="photo-credit">Image: ${photo.credit.url ? `<a href="${e(photo.credit.url)}" rel="noopener noreferrer">${e(photo.credit.name)}</a>` : e(photo.credit.name)}</p>` : "";
    const schema = {
      "@context": "https://schema.org", "@type": "Photograph", name: photo.title, description: photo.description || photo.alt,
      contentUrl: absolute(`/${photo.fallback.path}`), thumbnailUrl: absolute(`/${photo.ogPath}`), dateCreated: photo.date,
      url: absolute(canonicalPath), creator: { "@type": "Person", name: config.site.name }, ...(photo.location ? { contentLocation: photo.location } : {}),
    };
    return layout({
      title: photo.title,
      description: photo.description || photo.alt,
      path,
      canonicalPath,
      ogPath: `/${photo.ogPath}`,
      bodyClass: "photo-page",
      extraHead: `${alias ? '<meta name="robots" content="noindex,follow">' : ""}<meta property="og:type" content="article"><script type="application/ld+json">${jsonForScript(schema)}</script>`,
      content: `<article class="photo-entry" data-newer-href="${newer ? routeForPhoto(newer) : ""}" data-older-href="${older ? routeForPhoto(older) : ""}">
        <header class="photo-entry__heading"><p class="eyebrow">${e(formatShortDate(photo.date))}${photo.location ? ` / ${e(photo.location)}` : ""}</p><h1>${e(photo.title)}</h1>${details}</header>
        <div class="photo-entry__image">${picture(photo, { loading: "eager", sizes: "min(94vw, 100rem)" })}</div>
        <div class="photo-entry__record"><div>${metadataList(photo)}${credit}</div><div class="filing-notes">${collections ? `<p><span>Collections</span>${collections}</p>` : ""}${tags ? `<p><span>Subjects</span>${tags}</p>` : ""}</div></div>
        <nav class="photo-sequence" aria-label="Photograph sequence">
          ${newer ? `<a rel="prev" href="${routeForPhoto(newer)}"><small>Newer</small><span>${e(newer.title)}</span></a>` : `<span></span>`}
          ${older ? `<a rel="next" href="${routeForPhoto(older)}"><small>Older</small><span>${e(older.title)}</span></a>` : `<span></span>`}
        </nav>
        <p class="key-hint">Use the left and right arrow keys to move through the archive.</p>
      </article>`,
    });
  }

  function searchPage() {
    return layout({
      title: "Search",
      active: "browse",
      path: "/search/",
      content: `<header class="page-heading"><p class="eyebrow">Full archive</p><h1>Find a photograph.</h1><p>Filter the records by what was photographed or what was used.</p></header>
      <form class="filter-form" id="archive-filter" role="search">
        <label class="filter-query"><span>Words</span><input type="search" name="q" autocomplete="off" placeholder="Title, description, or place"></label>
        ${[["year", "Year"], ["tag", "Subject"], ["location", "Location"], ["camera", "Camera"], ["lens", "Lens"], ["filmStock", "Film stock"]].map(([name, label]) => `<label><span>${label}</span><select name="${name}"><option value="">All</option></select></label>`).join("")}
        <button type="reset">Clear filters</button>
      </form>
      <div class="filter-summary" aria-live="polite"><p id="result-count">Loading the archive…</p></div>
      <div class="photo-grid" id="search-results"></div>
      <noscript><p class="empty-state">Search needs JavaScript. The <a href="${url("/all/")}">complete archive</a> is available without it.</p></noscript>`,
    });
  }

  function aboutPage() {
    return layout({
      title: "About",
      active: "about",
      path: "/about/",
      content: `<article class="text-page"><header><p class="eyebrow">About</p><h1>${e(config.about.heading)}</h1><p class="lede">${e(config.about.intro)}</p></header>${config.about.paragraphs.map((paragraph) => `<p>${e(paragraph)}</p>`).join("")}<aside><p>This site is also a record. Dates, locations, and camera details stay with the pictures because that is how I remember the places.</p></aside></article>`,
    });
  }

  function contactPage() {
    return layout({
      title: "Contact",
      active: "contact",
      path: "/contact/",
      content: `<article class="text-page contact-page"><header><p class="eyebrow">Contact</p><h1>Say hello.</h1><p class="lede">For prints, assignments, or a note about a place I photographed.</p></header><dl><div><dt>Email</dt><dd><a href="mailto:${e(config.contact.email)}">${e(config.contact.email)}</a></dd></div><div><dt>Instagram</dt><dd><a href="${e(config.contact.instagramUrl)}" rel="me noopener noreferrer">@${e(config.contact.instagramHandle)}</a></dd></div></dl></article>`,
    });
  }

  function notFoundPage() {
    return layout({
      title: "Page not found",
      path: "/404.html",
      content: `<article class="text-page"><header><p class="eyebrow">404</p><h1>That page is not in the archive.</h1><p class="lede">The photograph may have moved, or the address may be incomplete.</p></header><p><a class="button-link" href="${url("/all/")}">Open all photographs</a></p></article>`,
    });
  }

  function searchCard(photo) {
    const fallback = photo.fallback;
    return `<article class="photo-card"><a class="photo-card__image" href="${photoRoute(photo)}"><img src="${url(`/${fallback.path}`)}" width="${fallback.width}" height="${fallback.height}" alt="${e(photo.alt)}" loading="lazy" decoding="async"></a><div class="photo-card__caption"><h3><a href="${photoRoute(photo)}">${e(photo.title)}</a></h3><p>${[photo.location, formatShortDate(photo.date)].filter(Boolean).map(e).join(" / ")}</p></div></article>`;
  }

  return {
    indexPage,
    galleryPage,
    groupIndexPage,
    browsePage,
    collectionsPage,
    photoPage,
    searchPage,
    aboutPage,
    contactPage,
    notFoundPage,
    searchCard,
  };
}
