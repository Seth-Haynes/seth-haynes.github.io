import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPublisherConfig } from "../scripts/publisher/config.mjs";

async function writeConfig(rootDir, value) {
  const configPath = path.join(rootDir, "publisher.config.json");
  await writeFile(configPath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return configPath;
}

const fixtureParent = await mkdtemp(path.join(os.tmpdir(), "portfolio-publisher-config-"));
const rootDir = path.join(fixtureParent, "Portfolio");
await mkdir(path.join(rootDir, "photos"), { recursive: true });

try {
  const configPath = await writeConfig(rootDir, {
    mastersDir: "../Masters",
    outputDir: "photos",
    image: {
      longEdge: 1800,
      sourceExtensions: [".JPG", ".jpg", ".TIF"],
    },
    watch: {
      buildAfterPublish: false,
    },
  });

  const config = await loadPublisherConfig({ rootDir, configPath });
  assert.equal(config.image.longEdge, 1800);
  assert.equal(config.image.jpegQuality, 84, "omitted settings should receive defaults");
  assert.deepEqual(config.image.sourceExtensions, [".jpg", ".tif"]);
  assert.equal(config.watch.buildAfterPublish, false);
  assert.equal(config.watch.concurrency, 2);
  assert.equal(config.paths.rootDir, path.resolve(rootDir));
  assert.equal(config.paths.mastersDir, path.resolve(fixtureParent, "Masters"));
  assert.equal(config.paths.outputDir, path.resolve(rootDir, "photos"));
  assert.equal(config.paths.cacheDir, path.resolve(rootDir, ".cache", "publisher"));

  await writeConfig(rootDir, { mastersDir: "Masters", outputDir: "photos" });
  await assert.rejects(
    loadPublisherConfig({ rootDir }),
    /mastersDir.*outside the repository/,
  );

  await writeConfig(rootDir, { mastersDir: "../Masters", outputDir: "../Published" });
  await assert.rejects(
    loadPublisherConfig({ rootDir }),
    /outputDir.*inside the repository/,
  );

  await writeConfig(rootDir, { mastersDir: "../Masters", image: { jpegQuality: 101 } });
  await assert.rejects(
    loadPublisherConfig({ rootDir }),
    /image\.jpegQuality.*between 1 and 100/,
  );

  await writeConfig(rootDir, { mastersDir: "../Masters", image: { jpegQualty: 84 } });
  await assert.rejects(
    loadPublisherConfig({ rootDir }),
    /image\.jpegQualty.*not a recognized setting/,
  );

  await writeConfig(rootDir, "{ invalid json");
  await assert.rejects(
    loadPublisherConfig({ rootDir }),
    /Could not parse publisher configuration/,
  );
} finally {
  await rm(fixtureParent, { recursive: true, force: true });
}

console.log("Verified publisher configuration defaults, validation, and path safety.");
