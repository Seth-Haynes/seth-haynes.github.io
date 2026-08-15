# Photo content

This folder is the source of the site. Website code lives elsewhere.

Add photographs in folders such as:

```text
photos/
  2026/
    benton-courthouse/
      DSC_0213.jpg
      DSC_0214.jpg
      metadata.json
```

The build accepts `.jpg`, `.jpeg`, `.png`, and `.webp` files. JPEG is recommended for camera originals.

`metadata.json` can describe one image, provide defaults for every image in the folder, or include an `images` object with per-file overrides. See `METADATA.md` in the project root.
