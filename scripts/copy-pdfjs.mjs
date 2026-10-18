// Copia las fuentes estándar y cmaps de pdf.js a public/pdfjs (los PDF los necesitan; así funcionan sin conexión).
import { cp, mkdir } from 'node:fs/promises';
const src = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const dst = new URL('../public/pdfjs/', import.meta.url);
await mkdir(dst, { recursive: true });
for (const d of ['standard_fonts', 'cmaps']) await cp(new URL(d + '/', src), new URL(d + '/', dst), { recursive: true });
console.log('pdfjs: fuentes y cmaps listos');
