/**
 * Static file serving for the single-container deployment: the sync
 * server serves the built web app, so the whole product is one process,
 * one port, one data directory.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export function serveStatic(dir: string, urlPath: string, response: ServerResponse): boolean {
  let path = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  if (path.includes("..")) return false;
  if (path === "/") path = "/index.html";
  let file = normalize(join(dir, path));
  if (!file.startsWith(normalize(dir))) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: the app routes by query params, so unknown paths
    // get the shell.
    file = join(dir, "index.html");
    if (!existsSync(file)) return false;
  }
  const ext = extname(file);
  const hashed = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(file); // vite content hashes
  response.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(response);
  return true;
}
