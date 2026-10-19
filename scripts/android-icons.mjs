// Genera los íconos y la pantalla de arranque de Android a partir de la marca de Lumen.
import sharp from 'sharp';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const p = (u) => fileURLToPath(u);
const RES = new URL('../android/app/src/main/res/', import.meta.url);
const BG = '#0A0D18';
const mark = (scale, stroke = 1.6) => `<g transform="translate(256 256) scale(${scale}) translate(-12 -10.5)" fill="none" stroke="#F4B740" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5c-2.2-1.6-5-2-8-1.2v10.6c3-.8 5.8-.4 8 1.2 2.2-1.6 5-2 8-1.2V7.3c-3-.8-5.8-.4-8 1.2zM12 8.5v10.6"/><path d="M12 1.8l.7 1.6 1.6.7-1.6.7L12 6.4l-.7-1.6-1.6-.7 1.6-.7z" fill="#F4B740" stroke="none"/></g>`;
const full = Buffer.from(await readFile(new URL('../public/icon.svg', import.meta.url)));
const round = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="${BG}"/>${mark(13)}</svg>`);
// Primer plano adaptativo: la zona segura es el 66 % central.
const fg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark(10.4, 1.7)}</svg>`);

for (const [d, k] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
  const dir = new URL(`mipmap-${d}/`, RES);
  await sharp(full, { density: 300 }).resize(48 * k, 48 * k).png().toFile(p(new URL('ic_launcher.png', dir)));
  await sharp(round, { density: 300 }).resize(48 * k, 48 * k).png().toFile(p(new URL('ic_launcher_round.png', dir)));
  await sharp(fg, { density: 300 }).resize(108 * k, 108 * k).png().toFile(p(new URL('ic_launcher_foreground.png', dir)));
}
await writeFile(new URL('values/ic_launcher_background.xml', RES), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`);

for (const name of await readdir(RES)) {
  if (!name.startsWith('drawable')) continue;
  const file = p(new URL(`${name}/splash.png`, RES));
  let meta;
  try { meta = await sharp(file).metadata(); } catch { continue; }
  const s = Math.round(Math.min(meta.width, meta.height) * 0.24);
  const icon = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark(15)}</svg>`), { density: 300 }).resize(s, s).png().toBuffer();
  const out = await sharp({ create: { width: meta.width, height: meta.height, channels: 4, background: BG } }).composite([{ input: icon, gravity: 'center' }]).png().toBuffer();
  await writeFile(file, out);
}
console.log('íconos listos');
