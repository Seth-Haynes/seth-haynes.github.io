import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT || process.argv[2] || 4173);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

async function resolveRequest(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = path.resolve(root, `.${decoded}`);
  if (!candidate.startsWith(root)) return null;
  try {
    const details = await stat(candidate);
    if (details.isDirectory()) return path.join(candidate, "index.html");
    return candidate;
  } catch {
    const htmlCandidate = `${candidate}.html`;
    try { await access(htmlCandidate); return htmlCandidate; } catch { return path.join(root, "404.html"); }
  }
}

createServer(async (request, response) => {
  const filePath = await resolveRequest(request.url || "/");
  if (!filePath) { response.writeHead(403); response.end("Forbidden"); return; }
  let status = filePath.endsWith("404.html") ? 404 : 200;
  try {
    const details = await stat(filePath);
    response.writeHead(status, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Content-Length": details.size, "Cache-Control": filePath.includes(`${path.sep}media${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache" });
    createReadStream(filePath).pipe(response);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`Portfolio preview: http://127.0.0.1:${port}`));
