import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWriteFile(filePath, content) {
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  const temporaryPath = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, destination);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
