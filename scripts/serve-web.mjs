#!/usr/bin/env node
/**
 * Servidor estático mínimo para revisar `apps/web` localmente.
 *
 * Existe só para desenvolvimento: em produção o site é servido pelo Cloudflare
 * Pages. Sem dependências, para não adicionar pacote ao repositório por causa
 * de uma pré-visualização.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const PORT = Number(process.env.PORT ?? 4321);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const file = resolve(ROOT, relative);

  // `resolve` já normaliza `..`; o prefixo impede sair da pasta do site.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    const notFound = await readFile(join(ROOT, "404.html")).catch(() => "404");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(notFound);
  }
}).listen(PORT, () => console.log(`Site em http://localhost:${PORT}`));
