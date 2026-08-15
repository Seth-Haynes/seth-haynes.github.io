# Metadata reference

The publisher creates an entry for each new JPEG. See [PUBLISHER.md](PUBLISHER.md) for the complete publishing workflow.

The build scans `photos/<year>/<folder>/` recursively. Each image becomes one photo record and one dedicated page.

## One image in a folder

```json
{
  "title": "Former CVS",
  "description": "An empty storefront reflecting the Walgreens across the street.",
  "location": "Benton, Arkansas",
  "date": "2026-08-02",
  "camera": "Nikon D5100",
  "lens": "AF-S DX NIKKOR 18-55mm",
  "filmStock": "Kodak Portra 400",
  "tags": ["architecture", "night", "storefront", "urban"],
  "collections": ["Downtown Benton", "Night Photography", "Vacant Buildings"],
  "featured": true,
  "alt": "Empty former CVS storefront reflecting the store across the street"
}
```

## Several images in a folder

Top-level fields are defaults. Add only the fields that change for each file:

```json
{
  "location": "Benton, Arkansas",
  "date": "2026-08-02",
  "camera": "Nikon D5100",
  "filmStock": "Kodak Portra 400",
  "tags": ["architecture", "courthouse"],
  "collections": ["Small Town Arkansas", "Downtown Benton"],
  "images": {
    "DSC_0213.jpg": {
      "title": "Benton Courthouse, East Side",
      "description": "The east entrance after the offices closed.",
      "featured": true
    },
    "DSC_0214.jpg": {
      "title": "Storefront Next Door",
      "description": "The empty storefront beside the courthouse.",
      "tags": ["storefront", "vacant"],
      "collections": ["Downtown Benton", "Vacant Buildings"]
    }
  }
}
```

Folder tags and collections are combined with per-image values. A photograph can belong to any number of collections without being copied.

Top-level camera and film-stock fields apply to every image in the folder. Put either field inside an image entry when one frame is different.

## Date precision

Use only the precision you actually know:

- `2026-06-14` displays as `June 14, 2026`.
- `2026-06` displays as `June 2026`.
- `2026` displays as `2026`.

Month-only and year-only dates remain that way in the generated catalog. The build does not invent a day. They still sort newest first alongside full dates.

## Supported fields

- `title`
- `description`
- `location`
- `date` in `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` format
- `alt`
- `featured`
- `tags`
- `collections`
- `camera`
- `lens`
- `filmStock`
- `focalLength`
- `aperture`
- `shutterSpeed`
- `iso`
- `credit.name` and `credit.url`
- `images` for per-file overrides

EXIF fills camera, lens, capture date, focal length, aperture, shutter speed, and ISO when those fields are not supplied. Metadata always takes priority.

## Photograph addresses

The primary address uses the year, source folder, and photograph title:

`/photo/2026/new-york-city/city-upon-a-hill/`

Each collection also creates an alternate address using its collection name:

`/photo/2026/summer-2026/city-upon-a-hill/`

Alternate pages identify the source-folder address as canonical. The earlier filename-based address remains available, so existing links do not break. Because the title is part of the address, changing a title changes its primary address on the next build. If two photographs would receive the same address, the build adds the source filename to keep both pages distinct.
