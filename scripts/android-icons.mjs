// Genera los íconos y la pantalla de arranque de Android a partir de public/icon.svg.
import sharp from 'sharp';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const p = (u) => fileURLToPath(u);
const RES = new URL('../android/app/src/main/res/', import.meta.url);
const BG = '#14110D';
const book = (stroke = '#F5C25B') =>
  `<path d="M256 120c-46-30-104-34-150-16v260c46-18 104-14 150 16 46-30 104-34 150-16V104c-46-18-104-14-150 16z" fill="none" stroke="${stroke}" stroke-width="24" stroke-linejoin="round"/><path d="M256 120v260" stroke="${stroke}" stroke-width="24"/><rect x="150" y="196" width="76" height="22" rx="11" fill="${stroke}" opacity=".55"/>`;
const full = Buffer.from(await readFile(new URL('../public/icon.svg', import.meta.url)));
const round = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="${BG}"/>${book()}</svg>`);
const fg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(256 256) scale(.62) translate(-256 -250)">${book()}</g></svg>`);

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
  const s = Math.round(Math.min(meta.width, meta.height) * 0.26);
  const icon = await sharp(full, { density: 300 }).resize(s, s).png().toBuffer();
  const out = await sharp({ create: { width: meta.width, height: meta.height, channels: 4, background: BG } }).composite([{ input: icon, gravity: 'center' }]).png().toBuffer();
  await writeFile(file, out);
}
console.log('íconos listos');
