#!/usr/bin/env node
/**
 * Servidor estático mínimo para revisar `apps/web` localmente.
 *
 * Existe só para desenvolvimento: em produção o site é servido pelo Cloudflare
 * Pages. Sem dependências, para não adicionar pacote ao repositório por causa
 * de uma pré-visualização.
 *
 * Segurança: o caminho pedido **nunca** vira caminho de arquivo. A lista de
 * arquivos é montada uma vez, a partir do disco, e a requisição só consulta um
 * mapa. Assim não existe travessia de diretório para proteger — nem por `..`,
 * nem por caminho absoluto, nem por symlink apontando para fora. A primeira
 * versão fazia `resolve()` sobre a URL e barrava o que escapasse com
 * `startsWith`, o que o CodeQL apontou (js/path-injection, severidade alta):
 * a checagem funcionava para o caso óbvio, mas proteger é pior que não
 * precisar de proteção.
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const PORT = Number(process.env.PORT ?? 4321);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/** Mapa "/caminho/na/url" → caminho absoluto, montado do disco no boot. */
async function indexSite(dir) {
  const files = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath ?? entry.path, entry.name);
    const url = "/" + relative(ROOT, absolute).split(sep).join(posix.sep);
    files.set(url, absolute);
  }
  return files;
}

const site = await indexSite(ROOT);

createServer(async (req, res) => {
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  const key = requested === "/" ? "/index.html" : requested;
  const file = site.get(key);

  if (!file) {
    const notFound = site.get("/404.html");
    const body = notFound ? await readFile(notFound) : "404";
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(body);
    return;
  }

  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}).listen(PORT, () => {
  console.log(`Site em http://localhost:${PORT} (${site.size} arquivos)`);
});
