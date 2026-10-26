// Traspaso completo entre dispositivos (por ejemplo de la laptop a la tablet): una carpeta con tus documentos tal cual
// y un archivo «lumen-traspaso.json» con todo lo demás (carpetas, subrayados, marcadores, progreso, tarjetas Feynman).
// Aquí está la lógica pura (sin pantalla ni base de datos) para poder probarla.
export const MANIFIESTO = 'lumen-traspaso.json';
export const CARPETA_EXPORT = 'Lumen traspaso';

export const limpiarNombre = (n) => String(n ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'documento';

// Nombre de archivo de cada libro dentro de la carpeta exportada: único (dos documentos pueden llamarse igual en carpetas distintas).
export function nombresArchivo(books) {
  const vistos = new Map();
  return new Map(books.map((b) => {
    const base = limpiarNombre(b.name);
    const clave = base.toLowerCase();
    const n = (vistos.get(clave) || 0) + 1;
    vistos.set(clave, n);
    return [b.id, n === 1 ? base : base.replace(/(\.[^.]*)?$/, ` (${n})$1`)];
  }));
}

export function armarManifiesto({ books, folders, hl, fey, stats }, nombres, ahora = Date.now()) {
  return {
    app: 'lumen', tipo: 'traspaso', v: 2, at: ahora,
    folders: folders || [], hl: hl || [], fey: fey || [], stats: stats || null,
    books: books.map((b) => ({ ...b, archivo: nombres.get(b.id) })),
  };
}

export function leerManifiesto(texto) {
  let o;
  try { o = JSON.parse(texto); } catch { throw new Error('el archivo del traspaso no se puede leer'); }
  if (o?.app !== 'lumen' || o.tipo !== 'traspaso' || !Array.isArray(o.books)) throw new Error('ese archivo no es un traspaso de Lumen');
  if (o.v > 2) throw new Error('el traspaso viene de una versión más nueva: actualiza Lumen');
  return { ...o, folders: o.folders || [], hl: o.hl || [], fey: o.fey || [] };
}

// Une cada libro del traspaso con el archivo elegido: por el nombre dentro de la carpeta exportada y el tamaño (con respaldo por el nombre original).
export function emparejar(manifiesto, archivos) {
  const lista = [...archivos];
  const usado = new Set();
  const buscar = (nombre, size) => lista.findIndex((f, i) => !usado.has(i) && f.name.toLowerCase() === String(nombre).toLowerCase() && (size == null || f.size === size));
  const pares = [], faltan = [];
  for (const libro of manifiesto.books) {
    let i = buscar(libro.archivo, libro.size);
    if (i < 0) i = buscar(libro.name, libro.size);
    if (i < 0) { faltan.push(libro); continue; }
    usado.add(i);
    pares.push({ libro, archivo: lista[i] });
  }
  return { pares, faltan, sobran: lista.filter((_, i) => !usado.has(i)) };
}

// Carpetas del traspaso: las que ya existen aquí (mismo nombre) se reutilizan; el resto se crea. Devuelve el mapa id de la copia → id de aquí.
export function mapearCarpetas(deLaCopia, locales, nuevoId) {
  const mapa = new Map(), nuevas = [];
  for (const f of deLaCopia) {
    const igual = locales.find((x) => x.name.trim().toLowerCase() === f.name.trim().toLowerCase());
    if (igual) mapa.set(f.id, igual.id);
    else { const n = { ...f, id: nuevoId() }; nuevas.push(n); mapa.set(f.id, n.id); }
  }
  return { mapa, nuevas };
}

// Lo que se copia al libro nuevo (no se pisa lo que se calcula al subirlo: id, tamaño, portada, páginas).
const CAMPOS = ['title', 'author', 'tag', 'progress', 'pos', 'mode', 'marks', 'zoom', 'done', 'added', 'lastRead'];
export function datosDelLibro(libro, mapaCarpetas) {
  const o = {};
  for (const k of CAMPOS) if (libro[k] !== undefined) o[k] = libro[k];
  o.folder = libro.folder ? mapaCarpetas.get(libro.folder) || null : null;
  return o;
}
