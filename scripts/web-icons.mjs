// Íconos PNG para instalar la web como app (laptop/celular) a partir de la marca de Lumen.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = (n) => fileURLToPath(new URL(`../public/${n}`, import.meta.url));
const svg = await readFile(new URL('../public/icon.svg', import.meta.url));
for (const [n, s] of [['icon-180.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await sharp(svg, { density: 400 }).resize(s, s).png().toFile(out(n));
}
// Maskable: fondo a sangre y marca dentro de la zona segura (80 %).
const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0A0D18"/><g transform="translate(256 256) scale(12) translate(-12 -10.5)" fill="none" stroke="#F4B740" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5c-2.2-1.6-5-2-8-1.2v10.6c3-.8 5.8-.4 8 1.2 2.2-1.6 5-2 8-1.2V7.3c-3-.8-5.8-.4-8 1.2zM12 8.5v10.6"/><path d="M12 1.8l.7 1.6 1.6.7-1.6.7L12 6.4l-.7-1.6-1.6-.7 1.6-.7z" fill="#F4B740" stroke="none"/></g></svg>');
await sharp(mask, { density: 400 }).resize(512, 512).png().toFile(out('icon-maskable-512.png'));
console.log('web icons ok');
