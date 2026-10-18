// Después de `vite build`: deja dist/ listo para el APK y para Render.
//  - Crea dist/update/lumen-<versión>.zip (sin el modelo) y dist/update/version.json,
//    que es lo que la app instalada descarga para actualizarse sola.
//
// version.json: { version, url, checksum, notes, force? }
//  - La app solo instala versiones MAYORES que la suya.
//  - FORCE=1 agrega "force": true: la app instala esta versión aunque sea menor que la
//    que tiene (para volver atrás a una versión buena tras publicar una con problemas).
//    Ej.: cambiar package.json a la versión buena, `set FORCE=1&& npm run build`, subir a Render.
//    Quitar el force en la siguiente publicación normal.
//  - Las versiones que fallaron al arrancar en un teléfono quedan en localStorage
//    'percha.badVersions' y ese teléfono no las vuelve a bajar (publicar con otro número).
//
// Nota: dist/update/ es solo para Render (los teléfonos lo bajan de ahí). No debe ir dentro
// del APK: `cap sync` copia todo dist/, así que el paso nativo debe excluir dist/update.
import { readdir, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import pkg from '../package.json' with { type: 'json' };

const DIST = new URL('../dist/', import.meta.url);
const notes = process.env.NOTES || '';
const force = ['1', 'true', 'yes'].includes(String(process.env.FORCE || '').trim().toLowerCase());


async function collect(dirUrl, prefix = '') {
  const out = {};
  for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (rel === 'bg-data' || rel === 'update') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
    if (entry.isDirectory()) Object.assign(out, await collect(url, rel + '/'));
    else out[rel] = new Uint8Array(await readFile(url));
  }
  return out;
}

const files = await collect(DIST);
const zip = zipSync(files, { level: 9 });
const name = `lumen-${pkg.version}.zip`;
await mkdir(new URL('update/', DIST), { recursive: true });
await writeFile(new URL(`update/${name}`, DIST), zip);
// Capgo exige el SHA-256 del zip para aceptar la descarga.
const checksum = createHash('sha256').update(zip).digest('hex');
await writeFile(new URL('update/version.json', DIST), JSON.stringify({ version: pkg.version, url: name, checksum, notes, ...(force ? { force: true } : {}) }, null, 2));
const size = (await stat(new URL(`update/${name}`, DIST))).size;
console.log(`update ${pkg.version}${force ? ' (FORCE: permite bajar de versión)' : ''}: ${name} (${(size / 1024).toFixed(0)} KB, ${Object.keys(files).length} archivos)`);
