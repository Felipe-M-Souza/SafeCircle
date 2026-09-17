#!/usr/bin/env node
/**
 * Confere a zona `softechconsulting.com.br` contra o retrato guardado.
 *
 * Existe por causa de um risco específico da migração do DNS para a
 * Cloudflare: o escaneamento automático dela não copia a zona inteira. Na
 * migração real ele trouxe 16 dos 28 registros, deixando de fora os `MX`, o
 * `SPF`, o `DMARC` e as chaves `DKIM`. Publicar assim não dá erro em lugar
 * nenhum — o domínio simplesmente para de receber e-mail, e o que ele envia
 * passa a cair em spam.
 *
 * Por isso a verificação compara nome por nome, e não "o site abriu".
 *
 * O retrato em `docs/release/dns-softechconsulting.json` foi tirado dos
 * servidores autoritativos do HostGator antes da troca de nameservers. Nada
 * ali é segredo: é o DNS público do domínio.
 *
 * Uso:
 *   node scripts/check-dns.mjs            # consulta 8.8.8.8
 *   node scripts/check-dns.mjs 1.1.1.1    # consulta outro resolvedor
 *
 * Sai com código 1 se algum registro estiver ausente ou diferente.
 */
import { Resolver } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETRATO = join(RAIZ, "docs", "release", "dns-softechconsulting.json");

/** Cada tipo consulta de um jeito e normaliza para uma lista de strings. */
const CONSULTAS = {
  A: async (r, nome) => (await r.resolve4(nome)).sort(),
  CNAME: async (r, nome) => await r.resolveCname(nome),
  MX: async (r, nome) => (await r.resolveMx(nome)).map((m) => `${m.priority} ${m.exchange}`).sort(),
  TXT: async (r, nome) => (await r.resolveTxt(nome)).map((c) => c.join("")).sort(),
  SRV: async (r, nome) =>
    (await r.resolveSrv(nome)).map((s) => `${s.priority} ${s.weight} ${s.port} ${s.name}`).sort(),
};

const retrato = JSON.parse(await readFile(RETRATO, "utf8"));
const resolvedor = new Resolver();
resolvedor.setServers([process.argv[2] ?? "8.8.8.8"]);

const nomeCompleto = (nome) => (nome === "@" ? retrato.zone : `${nome}.${retrato.zone}`);

const falhas = [];

for (const esperado of retrato.registros) {
  const alvo = nomeCompleto(esperado.nome);
  const rotulo = `${esperado.tipo.padEnd(5)} ${esperado.nome}`;

  let obtido;
  try {
    obtido = await CONSULTAS[esperado.tipo](resolvedor, alvo);
  } catch (erro) {
    falhas.push({ rotulo, motivo: `não respondeu (${erro.code ?? erro.message})` });
    console.log(`AUSENTE  ${rotulo}`);
    continue;
  }

  // Comparação exata: um DKIM com um caractere a menos falha silenciosamente
  // na entrega, então "parecido" não serve.
  const igual = JSON.stringify(obtido) === JSON.stringify(esperado.valor);
  if (igual) {
    console.log(`ok       ${rotulo}`);
  } else {
    falhas.push({
      rotulo,
      motivo: `esperado ${JSON.stringify(esperado.valor)}, veio ${JSON.stringify(obtido)}`,
    });
    console.log(`DIFERE   ${rotulo}`);
  }
}

console.log(
  `\n${retrato.registros.length - falhas.length} de ${retrato.registros.length} conferem ` +
    `(retrato de ${retrato.geradoEm}).`,
);

if (falhas.length > 0) {
  console.log("\nProblemas:");
  for (const f of falhas) console.log(`  ${f.rotulo}: ${f.motivo}`);
  process.exitCode = 1;
}
