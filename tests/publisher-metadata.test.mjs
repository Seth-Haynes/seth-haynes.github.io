import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ensureMetadataEntries } from "../scripts/publisher/metadata.mjs";
import { runPublisher } from "../scripts/publisher/publish.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-metadata-"));

try {
  const existingPath = path.join(fixtureRoot, "existing", "metadata.json");
  const existingSource = [
    "{",
    '    "location": "Benton, Arkansas",',
    '    "date": "2026-08",',
    "",
    '    "images": {',
    '        "OLD.JPG": {',
    '            "title": "Keep this title",',
    '            "description": "Keep this description",',
    '            "alt": "Keep this alt text",',
    '            "tags": ["existing"],',
    '            "featured": true',
    "        }",
    "    }",
    "}",
    "",
  ].join("\r\n");
  await mkdir(path.dirname(existingPath), { recursive: true });
  await writeFile(existingPath, existingSource, "utf8");

  const updated = await ensureMetadataEntries(existingPath, ["old.jpg", "NEW.jpg"]);
  assert.deepEqual(updated.added, ["NEW.jpg"]);
  const updatedSource = await readFile(existingPath, "utf8");
  assert.ok(updatedSource.startsWith(existingSource.slice(0, existingSource.indexOf("        }\r\n    }"))));
  assert.match(updatedSource, /"OLD\.JPG": \{[\s\S]*"title": "Keep this title"/);
  assert.match(updatedSource, /"NEW\.jpg": \{\r\n            "title": "",/);
  assert.equal(updatedSource.includes("\n") && !updatedSource.replaceAll("\r\n", "").includes("\n"), true, "CRLF formatting must be preserved");

  const unchangedSource = await readFile(existingPath);
  const unchanged = await ensureMetadataEntries(existingPath, ["NEW.JPG", "old.jpg"]);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(await readFile(existingPath), unchangedSource, "existing entries must remain byte-for-byte unchanged");

  const legacyPath = path.join(fixtureRoot, "legacy", "metadata.json");
  const legacySource = '{\n  "images": {\n    "RAW_FRAME.TIF": {\n      "title": "Finished title",\n      "description": "Finished description",\n      "alt": "Finished alt text",\n      "tags": ["finished"],\n      "featured": true\n    }\n  }\n}\n';
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, legacySource, "utf8");
  const legacy = await ensureMetadataEntries(legacyPath, ["raw_frame.jpg"]);
  assert.deepEqual(legacy.added, []);
  assert.deepEqual(legacy.renamed, [{ from: "RAW_FRAME.TIF", to: "raw_frame.jpg" }]);
  const renamedLegacySource = await readFile(legacyPath, "utf8");
  assert.equal(renamedLegacySource, legacySource.replace('"RAW_FRAME.TIF"', '"raw_frame.jpg"'));
  assert.deepEqual(JSON.parse(renamedLegacySource).images, {
    "raw_frame.jpg": {
      title: "Finished title",
      description: "Finished description",
      alt: "Finished alt text",
      tags: ["finished"],
      featured: true,
    },
  });

  const defaultsPath = path.join(fixtureRoot, "defaults", "metadata.json");
  const defaultsSource = '{\n  "location": "Boston, Massachusetts",\n  "date": "2026-06"\n}\n';
  await mkdir(path.dirname(defaultsPath), { recursive: true });
  await writeFile(defaultsPath, defaultsSource, "utf8");
  await ensureMetadataEntries(defaultsPath, ["frame.jpg"]);
  const withImages = await readFile(defaultsPath, "utf8");
  assert.ok(withImages.startsWith('{\n  "location": "Boston, Massachusetts",\n  "date": "2026-06",'));
  assert.deepEqual(JSON.parse(withImages), {
    location: "Boston, Massachusetts",
    date: "2026-06",
    images: {
      "frame.jpg": { title: "", description: "", alt: "", tags: [], featured: false },
    },
  });

  const newPath = path.join(fixtureRoot, "new", "metadata.json");
  const created = await ensureMetadataEntries(newPath, ["second.jpg", "first.jpg"]);
  assert.equal(created.created, true);
  assert.deepEqual(created.added, ["first.jpg", "second.jpg"]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(newPath, "utf8")).images), ["first.jpg", "second.jpg"]);

  const emptyImagesPath = path.join(fixtureRoot, "empty-images", "metadata.json");
  await mkdir(path.dirname(emptyImagesPath), { recursive: true });
  await writeFile(emptyImagesPath, '{\n  "images": {}\n}\n', "utf8");
  await ensureMetadataEntries(emptyImagesPath, ["frame.jpg"]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(emptyImagesPath, "utf8")).images), ["frame.jpg"]);

  const invalidPath = path.join(fixtureRoot, "invalid", "metadata.json");
  await mkdir(path.dirname(invalidPath), { recursive: true });
  await writeFile(invalidPath, "{ invalid metadata", "utf8");
  const invalidBefore = await readFile(invalidPath);
  await assert.rejects(ensureMetadataEntries(invalidPath, ["frame.jpg"]), /Could not update publisher metadata/);
  assert.deepEqual(await readFile(invalidPath), invalidBefore, "invalid metadata must never be replaced");

  const repository = path.join(fixtureRoot, "Portfolio");
  const mastersDir = path.join(fixtureRoot, "Masters");
  const outputDir = path.join(repository, "photos");
  const cacheDir = path.join(repository, ".cache", "publisher");
  const masterPath = path.join(mastersDir, "2026", "Integration", "master.tif");
  const secondMasterPath = path.join(mastersDir, "2026", "Integration", "second.tif");
  const sourceMetadataPath = path.join(mastersDir, "2026", "Integration", "metadata.json");
  const outputMetadataPath = path.join(outputDir, "2026", "Integration", "metadata.json");
  await mkdir(path.dirname(masterPath), { recursive: true });
  await sharp({ create: { width: 160, height: 80, channels: 3, background: "#334455" } }).tiff().toFile(masterPath);
  await sharp({ create: { width: 120, height: 60, channels: 3, background: "#446677" } }).tiff().toFile(secondMasterPath);
  await writeFile(sourceMetadataPath, JSON.stringify({
    location: "Benton, Arkansas",
    images: {
      "master.jpg": {
        title: "Master title",
        description: "Master description",
        alt: "Master alt text",
        tags: ["finished"],
        featured: true,
      },
    },
  }, null, 2), "utf8");
  const config = {
    image: {
      longEdge: 100,
      jpegQuality: 84,
      mozjpeg: true,
      stripMetadata: true,
      neverUpscale: true,
      sourceExtensions: [".tif"],
    },
    watch: { concurrency: 2 },
    paths: { rootDir: repository, mastersDir, outputDir, cacheDir },
  };
  const report = await runPublisher({ config });
  assert.equal(report.failed, 0);
  assert.equal(report.metadata.updates.length, 1);
  const synchronizedSource = await readFile(sourceMetadataPath, "utf8");
  const synchronizedMetadata = JSON.parse(synchronizedSource);
  assert.equal(synchronizedMetadata.images["master.jpg"].title, "Master title");
  assert.deepEqual(synchronizedMetadata.images["second.jpg"], {
    title: "",
    description: "",
    alt: "",
    tags: [],
    featured: false,
  });
  assert.equal(await readFile(outputMetadataPath, "utf8"), synchronizedSource, "published metadata must mirror Masters");

  await writeFile(outputMetadataPath, synchronizedSource.replace("Master title", "Output-only edit"), "utf8");
  const resynchronized = await runPublisher({ config });
  assert.equal(resynchronized.failed, 0);
  assert.equal(JSON.parse(await readFile(outputMetadataPath, "utf8")).images["master.jpg"].title, "Master title");

  const invalidMaster = path.join(mastersDir, "2026", "Invalid Metadata", "frame.tif");
  const invalidMasterMetadata = path.join(mastersDir, "2026", "Invalid Metadata", "metadata.json");
  const invalidOutputMetadata = path.join(outputDir, "2026", "Invalid Metadata", "metadata.json");
  await mkdir(path.dirname(invalidMaster), { recursive: true });
  await mkdir(path.dirname(invalidOutputMetadata), { recursive: true });
  await sharp({ create: { width: 80, height: 80, channels: 3, background: "#553344" } }).tiff().toFile(invalidMaster);
  await writeFile(invalidMasterMetadata, "{ invalid metadata", "utf8");
  await writeFile(invalidOutputMetadata, '{\n  "images": {\n    "frame.jpg": { "title": "Last good metadata" }\n  }\n}\n', "utf8");
  const invalidMetadataBefore = await readFile(invalidOutputMetadata);
  const invalidMasterBefore = await readFile(invalidMasterMetadata);
  const failedReport = await runPublisher({ config });
  const failedResult = failedReport.results.find((result) => result.source === "2026/Invalid Metadata/frame.tif");
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.phase, "metadata");
  assert.deepEqual(await readFile(invalidOutputMetadata), invalidMetadataBefore);
  assert.deepEqual(await readFile(invalidMasterMetadata), invalidMasterBefore);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Verified format-preserving publisher metadata updates and image integration.");
