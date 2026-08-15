import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./files.mjs";

function metadataError(metadataPath, message, cause = null) {
  const error = new Error(`Could not update publisher metadata ${metadataPath}: ${message}`);
  if (cause?.code) error.code = cause.code;
  return error;
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s|\uFEFF/.test(source[index])) index += 1;
  return index;
}

function parseStringNode(source, start) {
  if (source[start] !== '"') throw new Error(`Expected a string at character ${start}`);
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === '"') {
      const end = index + 1;
      return { type: "string", start, end, value: JSON.parse(source.slice(start, end)) };
    }
    index += 1;
  }
  throw new Error(`Unterminated string at character ${start}`);
}

function parseValueNode(source, start) {
  const index = skipWhitespace(source, start);
  if (source[index] === "{") return parseObjectNode(source, index);
  if (source[index] === "[") return parseArrayNode(source, index);
  if (source[index] === '"') return parseStringNode(source, index);

  let end = index;
  while (end < source.length && !/[\s,\]}]/.test(source[end])) end += 1;
  if (end === index) throw new Error(`Expected a value at character ${index}`);
  return { type: "primitive", start: index, end };
}

function parseArrayNode(source, start) {
  const values = [];
  let index = skipWhitespace(source, start + 1);
  if (source[index] === "]") return { type: "array", start, end: index + 1, values };

  while (index < source.length) {
    const value = parseValueNode(source, index);
    values.push(value);
    index = skipWhitespace(source, value.end);
    if (source[index] === "]") return { type: "array", start, end: index + 1, values };
    if (source[index] !== ",") throw new Error(`Expected a comma at character ${index}`);
    index = skipWhitespace(source, index + 1);
  }
  throw new Error(`Unterminated array at character ${start}`);
}

function parseObjectNode(source, start) {
  const properties = [];
  let index = skipWhitespace(source, start + 1);
  if (source[index] === "}") return { type: "object", start, end: index + 1, properties };

  while (index < source.length) {
    const key = parseStringNode(source, index);
    index = skipWhitespace(source, key.end);
    if (source[index] !== ":") throw new Error(`Expected a colon at character ${index}`);
    const value = parseValueNode(source, index + 1);
    properties.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value });
    index = skipWhitespace(source, value.end);
    if (source[index] === "}") return { type: "object", start, end: index + 1, properties };
    if (source[index] !== ",") throw new Error(`Expected a comma at character ${index}`);
    index = skipWhitespace(source, index + 1);
  }
  throw new Error(`Unterminated object at character ${start}`);
}

function parseMetadataSource(source, metadataPath) {
  let value;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw metadataError(metadataPath, error.message);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw metadataError(metadataPath, "the root value must be an object");
  }

  try {
    const root = parseValueNode(source, 0);
    if (root.type !== "object") throw new Error("the root value must be an object");
    return { value, root };
  } catch (error) {
    throw metadataError(metadataPath, error.message);
  }
}

function lineIndentAt(source, index) {
  const lineStart = Math.max(source.lastIndexOf("\n", index - 1) + 1, 0);
  const prefix = source.slice(lineStart, index);
  return /^[\t ]*$/.test(prefix) ? prefix : null;
}

function formattingFor(source, root, imagesProperty = null) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const rootIndent = lineIndentAt(source, root.start) ?? "";
  const firstRootIndent = root.properties[0] ? lineIndentAt(source, root.properties[0].keyStart) : null;
  const indentUnit = firstRootIndent?.startsWith(rootIndent) && firstRootIndent.length > rootIndent.length
    ? firstRootIndent.slice(rootIndent.length)
    : "  ";
  const propertyIndent = imagesProperty ? lineIndentAt(source, imagesProperty.keyStart) : firstRootIndent;
  const imagesIndent = propertyIndent ?? `${rootIndent}${indentUnit}`;
  const firstImageIndent = imagesProperty?.value.properties[0]
    ? lineIndentAt(source, imagesProperty.value.properties[0].keyStart)
    : null;
  const entryIndent = firstImageIndent ?? `${imagesIndent}${indentUnit}`;
  return {
    newline,
    rootIndent,
    indentUnit,
    imagesIndent,
    entryIndent,
    fieldIndent: `${entryIndent}${indentUnit}`,
  };
}

function separatorForObject(source, objectNode, fallback) {
  if (objectNode.properties.length >= 2) {
    const previous = objectNode.properties.at(-2);
    const last = objectNode.properties.at(-1);
    const separator = source.slice(previous.value.end, last.keyStart);
    const comma = separator.indexOf(",");
    if (comma >= 0 && /^\s*$/.test(separator.slice(comma + 1))) return separator.slice(comma + 1);
  }
  if (objectNode.properties.length === 1) {
    const separator = source.slice(objectNode.start + 1, objectNode.properties[0].keyStart);
    if (separator && /^\s*$/.test(separator)) return separator;
  }
  return fallback;
}

function insertObjectProperty(source, objectNode, propertyText, propertyIndent, objectIndent, newline) {
  if (objectNode.properties.length) {
    const last = objectNode.properties.at(-1);
    const separator = separatorForObject(source, objectNode, `${newline}${propertyIndent}`);
    return `${source.slice(0, last.value.end)},${separator}${propertyText}${source.slice(last.value.end)}`;
  }

  const close = objectNode.end - 1;
  return `${source.slice(0, objectNode.start + 1)}${newline}${propertyIndent}${propertyText}${newline}${objectIndent}${source.slice(close)}`;
}

function metadataEntry(filename, format) {
  const key = JSON.stringify(filename);
  return [
    `${key}: {`,
    `${format.fieldIndent}"title": "",`,
    `${format.fieldIndent}"description": "",`,
    `${format.fieldIndent}"alt": "",`,
    `${format.fieldIndent}"tags": [],`,
    `${format.fieldIndent}"featured": false`,
    `${format.entryIndent}}`,
  ].join(format.newline);
}

function imagesProperty(filename, format) {
  return [
    `"images": {`,
    `${format.entryIndent}${metadataEntry(filename, format)}`,
    `${format.imagesIndent}}`,
  ].join(format.newline);
}

function insertMetadataEntry(source, filename, metadataPath) {
  const parsed = parseMetadataSource(source, metadataPath);
  const imagesProperties = parsed.root.properties.filter((property) => property.key === "images");
  if (imagesProperties.length > 1) {
    throw metadataError(metadataPath, 'duplicate "images" properties are not supported');
  }
  const imagesPropertyNode = imagesProperties[0];
  if (imagesPropertyNode && imagesPropertyNode.value.type !== "object") {
    throw metadataError(metadataPath, '"images" must be an object');
  }

  const targetKey = filename.toLocaleLowerCase("en-US");
  const imageProperties = imagesPropertyNode?.value.properties ?? [];
  const exactMatches = imageProperties.filter(
    (property) => property.key.toLocaleLowerCase("en-US") === targetKey,
  );
  if (exactMatches.length > 1) {
    throw metadataError(metadataPath, `duplicate image entries match ${filename}`);
  }
  if (exactMatches.length === 1) {
    return { source, added: false, renamed: false, existingFilename: exactMatches[0].key };
  }

  const targetStem = path.posix.basename(filename, path.posix.extname(filename)).toLocaleLowerCase("en-US");
  const sourceExtensions = new Set([".jpeg", ".png", ".tif", ".tiff", ".webp"]);
  const legacyMatches = imageProperties.filter((property) => {
    const rawExtension = path.posix.extname(property.key);
    const extension = rawExtension.toLocaleLowerCase("en-US");
    const stem = path.posix.basename(property.key, rawExtension).toLocaleLowerCase("en-US");
    return sourceExtensions.has(extension) && stem === targetStem;
  });
  if (legacyMatches.length > 1) {
    throw metadataError(metadataPath, `multiple source-format entries match ${filename}`);
  }
  if (legacyMatches.length === 1) {
    const legacy = legacyMatches[0];
    return {
      source: `${source.slice(0, legacy.keyStart)}${JSON.stringify(filename)}${source.slice(legacy.keyEnd)}`,
      added: false,
      renamed: true,
      renamedFrom: legacy.key,
    };
  }

  const format = formattingFor(source, parsed.root, imagesPropertyNode);
  if (imagesPropertyNode) {
    return {
      source: insertObjectProperty(
        source,
        imagesPropertyNode.value,
        metadataEntry(filename, format),
        format.entryIndent,
        format.imagesIndent,
        format.newline,
      ),
      added: true,
      renamed: false,
    };
  }

  return {
    source: insertObjectProperty(
      source,
      parsed.root,
      imagesProperty(filename, format),
      format.imagesIndent,
      format.rootIndent,
      format.newline,
    ),
    added: true,
    renamed: false,
  };
}

function newMetadataSource(filename) {
  const format = {
    newline: "\n",
    rootIndent: "",
    indentUnit: "  ",
    imagesIndent: "  ",
    entryIndent: "    ",
    fieldIndent: "      ",
  };
  return `{\n  ${imagesProperty(filename, format)}\n}\n`;
}

function validateFilename(filename, metadataPath) {
  if (
    typeof filename !== "string"
    || !filename.trim()
    || filename !== path.basename(filename)
    || path.extname(filename).toLocaleLowerCase("en-US") !== ".jpg"
  ) {
    throw metadataError(metadataPath, `invalid published filename ${filename}`);
  }
  return filename;
}

export async function ensureMetadataEntries(metadataPath, filenames) {
  const uniqueFilenames = [...new Map(
    filenames.map((filename) => {
      const valid = validateFilename(filename, metadataPath);
      return [valid.toLocaleLowerCase("en-US"), valid];
    }),
  ).values()].sort((left, right) => left.localeCompare(right, "en-US"));

  let source;
  let created = false;
  try {
    source = await readFile(metadataPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw metadataError(metadataPath, error.message, error);
    created = true;
  }

  const added = [];
  const renamed = [];
  let nextSource = source;
  for (const filename of uniqueFilenames) {
    if (created && nextSource === undefined) {
      nextSource = newMetadataSource(filename);
      added.push(filename);
      continue;
    }
    const result = insertMetadataEntry(nextSource, filename, metadataPath);
    nextSource = result.source;
    if (result.added) added.push(filename);
    if (result.renamed) renamed.push({ from: result.renamedFrom, to: filename });
  }

  if (added.length || renamed.length) await atomicWriteFile(metadataPath, nextSource);
  return {
    metadataPath,
    created: created && added.length > 0,
    changed: added.length > 0 || renamed.length > 0,
    added,
    renamed,
  };
}

export async function synchronizeMetadataEntries(sourceMetadataPath, outputMetadataPath, filenames) {
  const sourceUpdate = await ensureMetadataEntries(sourceMetadataPath, filenames);
  let source;
  try {
    source = await readFile(sourceMetadataPath, "utf8");
  } catch (error) {
    throw metadataError(sourceMetadataPath, error.message, error);
  }

  let output;
  try {
    output = await readFile(outputMetadataPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw metadataError(outputMetadataPath, error.message, error);
  }

  const copied = output !== source;
  if (copied) await atomicWriteFile(outputMetadataPath, source);
  return {
    ...sourceUpdate,
    metadataPath: outputMetadataPath,
    sourceMetadataPath,
    sourceChanged: sourceUpdate.changed,
    outputCreated: output === undefined,
    copied,
    changed: sourceUpdate.changed || copied,
  };
}

export async function updatePublishedMetadata(mastersDir, outputDir, results) {
  const groups = new Map();
  for (const result of results) {
    if (result.status === "failed") continue;
    const folder = path.posix.dirname(result.output);
    const key = folder.toLocaleLowerCase("en-US");
    if (!groups.has(key)) groups.set(key, { folder, results: [] });
    groups.get(key).results.push(result);
  }

  const updates = [];
  const failures = [];
  for (const group of groups.values()) {
    const relativeFolder = group.folder.split("/");
    const sourceMetadataPath = path.join(mastersDir, ...relativeFolder, "metadata.json");
    const outputMetadataPath = path.join(outputDir, ...relativeFolder, "metadata.json");
    try {
      updates.push(await synchronizeMetadataEntries(
        sourceMetadataPath,
        outputMetadataPath,
        group.results.map((result) => path.posix.basename(result.output)),
      ));
    } catch (error) {
      failures.push({ folder: group.folder, results: group.results, error });
    }
  }
  return { updates, failures };
}
