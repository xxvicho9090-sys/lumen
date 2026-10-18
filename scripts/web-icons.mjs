// Íconos PNG para instalar la web como app (laptop/celular) a partir de public/icon.svg.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = (n) => fileURLToPath(new URL(`../public/${n}`, import.meta.url));
const svg = await readFile(new URL('../public/icon.svg', import.meta.url));
for (const [n, s] of [['icon-180.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await sharp(svg, { density: 400 }).resize(s, s).png().toFile(out(n));
}
// Maskable: fondo a sangre y dibujo dentro de la zona segura (80 %).
const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#14110D"/><g transform="translate(256 256) scale(.7) translate(-256 -250)"><path d="M256 120c-46-30-104-34-150-16v260c46-18 104-14 150 16 46-30 104-34 150-16V104c-46-18-104-14-150 16z" fill="none" stroke="#F5C25B" stroke-width="24" stroke-linejoin="round"/><path d="M256 120v260" stroke="#F5C25B" stroke-width="24"/><rect x="150" y="196" width="76" height="22" rx="11" fill="#F5C25B" opacity=".55"/></g></svg>`);
await sharp(mask, { density: 400 }).resize(512, 512).png().toFile(out('icon-maskable-512.png'));
console.log('web icons ok');
