#!/usr/bin/env node
/**
 * Gera os recursos de marca do app a partir das fontes em
 * `apps/mobile/assets/brand/` (ícone e logo entregues pelo proprietário).
 *
 *   node scripts/brand-assets.mjs
 *
 * Saídas (todas PNG, determinísticas a partir das fontes):
 *   assets/icon.png            1024×1024, cantos preenchidos com o azul da borda
 *                              (a fonte tem cantos arredondados brancos; iOS e
 *                              launchers aplicam a própria máscara)
 *   assets/adaptive-icon.png   1024×1024 RGBA, arte a 72% centrada (zona segura
 *                              do ícone adaptativo do Android é 66%)
 *   assets/splash-icon.png     logo recortado, 1200 px de largura, fundo transparente
 *   assets/logo.png            logo recortado, 720 px de largura (≈240 dp @3x)
 *   assets/favicon.png         48×48 (web)
 *
 * Imprime as cores amostradas para `app.json` (fundo do ícone adaptativo).
 * Nada aqui é segredo; o script existe para o resultado ser reproduzível.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = resolve(root, "apps/mobile/assets/brand");
const outDir = resolve(root, "apps/mobile/assets");
const ICON_SRC = resolve(brandDir, "icon-source.png");
const LOGO_SRC = resolve(brandDir, "logo-source.png");
const SIZE = 1024;

function formatJson(value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  return text.replace(
    /\{\n\s+"width": (\d+),\n\s+"height": (\d+),\n\s+"aspect": ([\d.]+)\n\s+\}/,
    '{ "width": $1, "height": $2, "aspect": $3 }',
  );
}

function hex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** Lê o pixel (x, y) de um buffer RGBA. */
function pixel(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

function isNearWhite([r, g, b]) {
  return r > 235 && g > 235 && b > 235;
}

/**
 * Ícone 1024 com alpha e cantos brancos transparentes. O raio do canto é
 * medido na própria imagem (primeiro pixel não branco da primeira linha).
 */
async function iconWithTransparentCorners() {
  // 1ª passada: a fonte tem uma margem branca ao redor do quadrado arredondado.
  // Mede a margem na linha do meio e recorta o quadrado antes de tudo.
  const probe = await sharp(ICON_SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pw = probe.info.width;
  const midY = Math.floor(probe.info.height / 2);
  let margin = 0;
  while (margin < pw / 2 && isNearWhite(pixel(probe.data, pw, margin, midY))) margin += 1;
  // Recua um pouco mais para descartar o halo branco de antisserrilhagem da borda.
  const fullBox = Math.min(pw, probe.info.height) - 2 * margin;
  const extra = Math.round(fullBox * 0.008);
  const inset = margin + extra;
  const box = fullBox - 2 * extra;

  const { data, info } = await sharp(ICON_SRC)
    .extract({ left: inset, top: inset, width: box, height: box })
    .resize(SIZE, SIZE, { fit: "cover" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;

  // Na linha 0 (já recuada `d` px da borda real) o trecho branco mede x0; o raio
  // verdadeiro sai da geometria do círculo: x0 = R - sqrt(2Rd - d^2) → R = x0 + d + sqrt(2·x0·d).
  let x0 = 0;
  while (x0 < w / 2 && isNearWhite(pixel(data, w, x0, 0))) x0 += 1;
  const d = (extra * SIZE) / box;
  const trueRadius = x0 + d + Math.sqrt(2 * x0 * d);
  // O arco é cortado com um círculo um pouco MENOR que o real, com o mesmo centro:
  // remove uniformemente o halo de antisserrilhagem ao longo de todo o arco, como o
  // recuo `extra` faz nas bordas retas.
  const center = trueRadius - d; // centro do arco nas coordenadas da imagem recuada
  const radius = trueRadius - d * 1.1; // raio de corte

  const corners = [
    [center, center],
    [w - 1 - center, center],
    [center, w - 1 - center],
    [w - 1 - center, w - 1 - center],
  ];
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inCornerBox = (x < center || x > w - 1 - center) && (y < center || y > w - 1 - center);
      if (!inCornerBox) continue;
      const [cx, cy] = corners.find(
        ([px, py]) => Math.abs(px - x) <= center + 1 && Math.abs(py - y) <= center + 1,
      );
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > radius) {
        data[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
  const edgeBlue = pixel(data, w, 2, Math.floor(w / 2)).slice(0, 3);
  const midBlue = pixel(data, w, Math.floor(w * 0.08), Math.floor(w * 0.5)).slice(0, 3);
  return { data, width: w, radius, margin, edgeBlue, midBlue };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const icon = await iconWithTransparentCorners();
  const rgba = { raw: { width: icon.width, height: icon.width, channels: 4 } };

  // icon.png — cantos preenchidos com o azul da borda (fundo sólido, sem alpha).
  const iconPng = await sharp(icon.data, rgba).png().toBuffer();
  await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: icon.edgeBlue[0], g: icon.edgeBlue[1], b: icon.edgeBlue[2] },
    },
  })
    .composite([{ input: iconPng }])
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, "icon.png"));

  // adaptive-icon.png — arte a 72% sobre transparente.
  const inner = Math.round(SIZE * 0.72);
  const scaled = await sharp(icon.data, rgba).resize(inner, inner).png().toBuffer();
  await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: scaled, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, "adaptive-icon.png"));

  // favicon.png
  await sharp(iconPng).resize(48, 48).png().toFile(resolve(outDir, "favicon.png"));

  // Logo: recorta a margem transparente e gera duas larguras.
  const trimmed = await sharp(LOGO_SRC).ensureAlpha().trim({ threshold: 8 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  await sharp(trimmed)
    .resize({ width: 1200 })
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, "splash-icon.png"));
  await sharp(trimmed)
    .resize({ width: 720 })
    .png({ compressionLevel: 9 })
    .toFile(resolve(outDir, "logo.png"));

  const summary = {
    sourceWhiteMarginPx: icon.margin,
    iconCornerRadiusPx: Math.round(icon.radius),
    adaptiveIconBackgroundColor: hex(icon.midBlue),
    iconEdgeColor: hex(icon.edgeBlue),
    logoTrimmed: {
      width: meta.width,
      height: meta.height,
      aspect: +(meta.width / meta.height).toFixed(4),
    },
    outputs: ["icon.png", "adaptive-icon.png", "splash-icon.png", "logo.png", "favicon.png"],
  };
  // Mesmo formato que o Prettier produz para este JSON (objeto curto em uma linha).
  await writeFile(resolve(brandDir, "generated.json"), formatJson(summary));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
