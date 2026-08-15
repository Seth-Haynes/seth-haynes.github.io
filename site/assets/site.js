const navButton = document.querySelector(".nav-toggle");
const navigation = document.querySelector(".site-nav");

if (navButton && navigation) {
  navButton.addEventListener("click", () => {
    const open = navButton.getAttribute("aria-expanded") !== "true";
    navButton.setAttribute("aria-expanded", String(open));
    navigation.classList.toggle("is-open", open);
  });
}

const photoEntry = document.querySelector(".photo-entry");
if (photoEntry) {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    const destination = event.key === "ArrowLeft" ? photoEntry.dataset.newerHref : event.key === "ArrowRight" ? photoEntry.dataset.olderHref : "";
    if (destination) window.location.assign(destination);
  });
}

const filterForm = document.querySelector("#archive-filter");
const results = document.querySelector("#search-results");
const resultCount = document.querySelector("#result-count");

function optionValues(photos, key) {
  const values = photos.flatMap((photo) => Array.isArray(photo[key]) ? photo[key] : [photo[key]]).filter(Boolean);
  return [...new Set(values)].sort((a, b) => key === "year" ? Number(b) - Number(a) : a.localeCompare(b));
}

function createCard(photo) {
  const article = document.createElement("article");
  article.className = "photo-card";
  const imageLink = document.createElement("a");
  imageLink.className = "photo-card__image";
  imageLink.href = photo.href;
  imageLink.setAttribute("aria-label", `View ${photo.title}`);
  const image = document.createElement("img");
  image.src = photo.image.src;
  image.alt = photo.alt;
  image.width = photo.image.width;
  image.height = photo.image.height;
  image.loading = "lazy";
  image.decoding = "async";
  imageLink.append(image);

  const caption = document.createElement("div");
  caption.className = "photo-card__caption";
  const heading = document.createElement("h3");
  const titleLink = document.createElement("a");
  titleLink.href = photo.href;
  titleLink.textContent = photo.title;
  heading.append(titleLink);
  const details = document.createElement("p");
  details.textContent = [photo.location, photo.shortDate].filter(Boolean).join(" / ");
  caption.append(heading, details);
  article.append(imageLink, caption);
  return article;
}

if (filterForm && results && resultCount) {
  fetch(document.body.dataset.catalogUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`Archive request failed (${response.status})`);
      return response.json();
    })
    .then(({ photos }) => {
      const params = new URLSearchParams(window.location.search);
      for (const select of filterForm.querySelectorAll("select")) {
        for (const value of optionValues(photos, select.name)) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          select.append(option);
        }
        select.value = params.get(select.name) ?? "";
      }
      filterForm.elements.q.value = params.get("q") ?? "";

      const applyFilters = () => {
        const form = new FormData(filterForm);
        const filters = Object.fromEntries(form.entries());
        const query = String(filters.q ?? "").trim().toLowerCase();
        const matches = photos.filter((photo) => {
          if (query && !photo.searchText.includes(query)) return false;
          if (filters.year && photo.year !== filters.year) return false;
          if (filters.tag && !photo.tags.includes(filters.tag)) return false;
          if (filters.location && photo.location !== filters.location) return false;
          if (filters.camera && photo.camera !== filters.camera) return false;
          if (filters.lens && photo.lens !== filters.lens) return false;
          if (filters.filmStock && photo.filmStock !== filters.filmStock) return false;
          return true;
        });

        results.replaceChildren(...matches.map(createCard));
        resultCount.textContent = `${matches.length} ${matches.length === 1 ? "photograph" : "photographs"}`;
        const nextParams = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value) nextParams.set(key, value);
        const suffix = nextParams.size ? `?${nextParams}` : window.location.pathname;
        history.replaceState(null, "", nextParams.size ? suffix : window.location.pathname);
      };

      filterForm.addEventListener("input", applyFilters);
      filterForm.addEventListener("change", applyFilters);
      filterForm.addEventListener("reset", () => requestAnimationFrame(applyFilters));
      applyFilters();
    })
    .catch((error) => {
      resultCount.textContent = "The archive could not be loaded.";
      console.error(error);
    });
}
