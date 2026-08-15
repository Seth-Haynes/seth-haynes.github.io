# Publisher quick guide

## Normal use

1. Add images to the correct collection in `C:\Users\Seth\Desktop\Masters`.
2. Edit that collection's `metadata.json` file in Masters.
3. Wait for the publisher to finish.

That is all. The publisher starts when you sign in to Windows. It creates the matching collection folder under `photos`, publishes the JPEGs, copies the Masters metadata, and rebuilds the site.

```text
Masters\2026\Collection\frame.JPG
Masters\2026\Collection\metadata.json

photos\2026\Collection\frame.jpg
photos\2026\Collection\metadata.json
```

Always edit the metadata file in Masters. The copy under `photos` is generated and can be replaced.

## If publishing does not start

Check `.cache\publisher\watcher.log` in the portfolio folder.

Start the background publisher again if needed:

```powershell
pnpm.cmd run publisher:start
```

Only one copy can run at a time.

## Remove outputs with missing masters

Inspect first. This command changes nothing:

```powershell
pnpm.cmd run publish:prune
```

If every candidate is correct:

```powershell
pnpm.cmd run publish:prune:apply
```

Do not apply cleanup when the Masters folder is unavailable.
