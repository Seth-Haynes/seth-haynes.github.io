# Photography publisher

For routine use, see [PUBLISHER-QUICK-GUIDE.md](PUBLISHER-QUICK-GUIDE.md).

The publisher converts master images into portfolio JPEGs. Masters is the source of truth for images and `metadata.json`. The publisher copies the metadata into the matching portfolio folder and keeps a local cache inside the repository.

## Folder layout

The default layout is:

```text
C:\Users\Seth\Desktop\Masters\2026\Collection\frame.tif
C:\Users\Seth\Desktop\Masters\2026\Collection\metadata.json
C:\Users\Seth\Desktop\Portfolio-Clean\photos\2026\Collection\frame.jpg
C:\Users\Seth\Desktop\Portfolio-Clean\photos\2026\Collection\metadata.json
```

Match the year and collection folders used by the portfolio. Keep master filenames unique within each folder. Do not put the master archive in the repository.

## First setup

1. Install Node.js 20.19 or newer.
2. Open a terminal in the repository folder.
3. Run `pnpm.cmd install`.
4. Review `publisher.config.json`.
5. Run `pnpm.cmd run publisher:startup:install`.
6. Run `pnpm.cmd run publisher:start` once for the current Windows session.

## Daily workflow

1. Export or copy new master images into the Masters folder.
2. Keep the same year and collection folder structure used by the portfolio.
3. Edit `metadata.json` in the Masters collection folder.
4. Let the background publisher finish.

The watcher starts when you sign in to Windows. It waits for each file to stabilize, publishes changed images, synchronizes Masters metadata, and rebuilds the site. It retries temporary file-lock errors. Removing a master does not automatically remove its portfolio JPEG.

## Commands

- `pnpm.cmd run publish` publishes new and changed masters.
- `pnpm.cmd run publish:rebuild` checks every master against the current image settings.
- `pnpm.cmd watch` watches the Masters folder and rebuilds after publishing.
- `pnpm.cmd run publisher:start` starts the watcher in the background.
- `pnpm.cmd run publisher:startup:install` starts the watcher automatically at Windows sign-in.
- `pnpm.cmd run publisher:startup:remove` removes automatic startup.
- `pnpm.cmd run publish:prune` reports orphaned publisher outputs. It changes nothing.
- `pnpm.cmd run publish:prune:apply` removes verified orphaned outputs and their cache entries.
- `pnpm.cmd test` builds and verifies the complete site and publisher.

## Metadata

The publisher creates or extends `metadata.json` in each Masters collection folder. It copies that file into the matching output folder. Existing field values and formatting are retained. A new entry includes an empty title, description, and `alt` value.

Always edit the Masters copy. The output copy is generated and can be replaced during the next synchronization.

Edit these fields before publishing the website:

- `title`
- `description`
- `alt`
- `tags`
- `collections`
- `featured`

See [METADATA.md](METADATA.md) for every supported field.

## Orphan cleanup

Run the inspection first:

```powershell
pnpm.cmd run publish:prune
```

Review every `Candidate`, `Cache only`, and `Retained` line. Apply the plan only when the list is correct:

```powershell
pnpm.cmd run publish:prune:apply
```

Cleanup uses the local manifest as its ownership record. It removes a JPEG only when its master is missing and its current SHA-256 hash matches the publisher record. It retains modified outputs, unsafe paths, symlinks, directories, metadata, and unrelated files. It refuses to start when the entire Masters folder is unavailable.

The `deleteOrphans` configuration value remains false because regular publishing and watching never delete orphaned output. The explicit apply command is the only cleanup path.

## Image settings

Edit `publisher.config.json` to change the long edge, JPEG quality, supported master formats, watcher timing, or folder locations. A change to an image encoding setting invalidates the related cache entries. A Sharp or libvips upgrade also invalidates them.

The default image rules are:

- JPEG output
- 2200-pixel long edge
- no enlargement of small masters
- automatic EXIF orientation
- stripped output metadata
- unchanged master files

## Safety behavior

- Master image files are never edited.
- Masters metadata can be created or extended with new image entries.
- Output metadata always follows the Masters copy.
- New images are written atomically.
- A failed conversion retains the last good JPEG.
- An unmanaged JPEG is never overwritten.
- A changed publisher JPEG is never deleted by cleanup.
- The cache is local and excluded from Git.
- Common TIFF and Affinity Photo master files are excluded from Git.
- A single-instance lock prevents duplicate background watchers.
- Background activity is recorded in `.cache/publisher/watcher.log`.
