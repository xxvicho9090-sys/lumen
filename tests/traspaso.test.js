import test from 'node:test';
import assert from 'node:assert/strict';
import { nombresArchivo, armarManifiesto, leerManifiesto, emparejar, mapearCarpetas, datosDelLibro, limpiarNombre } from '../src/traspaso.js';

const libro = (id, name, size, extra = {}) => ({ id, name, size, title: name.replace(/\.[^.]+$/, ''), format: 'pdf', ...extra });

test('los nombres de archivo exportados son únicos y limpios', () => {
  const n = nombresArchivo([libro('a', 'Apuntes.pdf', 1), libro('b', 'Apuntes.pdf', 2), libro('c', 'Otro: uno?.pdf', 3), libro('d', 'apuntes.PDF', 4)]);
  assert.equal(n.get('a'), 'Apuntes.pdf');
  assert.equal(n.get('b'), 'Apuntes (2).pdf');
  assert.equal(n.get('c'), 'Otro_ uno_.pdf');
  assert.equal(n.get('d'), 'apuntes (3).PDF');
  assert.equal(limpiarNombre('   '), 'documento');
});

test('el manifiesto se arma y se lee de vuelta', () => {
  const books = [libro('a', 'A.pdf', 10, { folder: 'f1', progress: 0.4, marks: [{ id: 1 }] })];
  const m = armarManifiesto({ books, folders: [{ id: 'f1', name: 'Civil' }], hl: [{ id: 'h1', bookId: 'a' }], fey: [], stats: { days: {} } }, nombresArchivo(books), 123);
  assert.equal(m.books[0].archivo, 'A.pdf');
  const l = leerManifiesto(JSON.stringify(m));
  assert.equal(l.books.length, 1);
  assert.equal(l.hl.length, 1);
});

test('rechaza lo que no es un traspaso', () => {
  assert.throws(() => leerManifiesto('no json'), /no se puede leer/);
  assert.throws(() => leerManifiesto(JSON.stringify({ app: 'lumen', v: 1, books: [], hl: [] })), /no es un traspaso/);
  assert.throws(() => leerManifiesto(JSON.stringify({ app: 'lumen', tipo: 'traspaso', v: 9, books: [] })), /más nueva/);
});

test('empareja cada libro con su archivo por nombre y tamaño, y avisa lo que falta', () => {
  const m = { books: [{ ...libro('a', 'A.pdf', 10), archivo: 'A.pdf' }, { ...libro('b', 'A.pdf', 20), archivo: 'A (2).pdf' }, { ...libro('c', 'C.pdf', 30), archivo: 'C.pdf' }] };
  const f = (name, size) => ({ name, size });
  const r = emparejar(m, [f('A (2).pdf', 20), f('A.pdf', 10), f('extra.pdf', 5)]);
  assert.deepEqual(r.pares.map((p) => p.libro.id), ['a', 'b']);
  assert.deepEqual(r.faltan.map((l) => l.id), ['c']);
  assert.deepEqual(r.sobran.map((x) => x.name), ['extra.pdf']);
});

test('si cambió el nombre del archivo, se respalda con el nombre original y el tamaño', () => {
  const m = { books: [{ ...libro('a', 'Original.pdf', 10), archivo: 'Otro nombre.pdf' }] };
  const r = emparejar(m, [{ name: 'original.pdf', size: 10 }]);
  assert.equal(r.pares.length, 1);
});

test('las carpetas con el mismo nombre se reutilizan y las demás se crean', () => {
  let n = 0;
  const { mapa, nuevas } = mapearCarpetas([{ id: 'x', name: 'Civil', color: 1 }, { id: 'y', name: 'Laboral' }], [{ id: 'L1', name: ' civil ' }], () => 'N' + ++n);
  assert.equal(mapa.get('x'), 'L1');
  assert.equal(mapa.get('y'), 'N1');
  assert.deepEqual(nuevas.map((f) => [f.id, f.name]), [['N1', 'Laboral']]);
});

test('al libro nuevo se le copia lo tuyo, con la carpeta de este dispositivo', () => {
  const d = datosDelLibro({ id: 'a', size: 9, title: 'Mi título', tag: 'estudio', progress: 0.5, pos: { page: 3 }, marks: [1], done: true, folder: 'x', cover: 'IGNORAR' }, new Map([['x', 'L1']]));
  assert.deepEqual(d, { title: 'Mi título', tag: 'estudio', progress: 0.5, pos: { page: 3 }, marks: [1], done: true, folder: 'L1' });
  assert.equal(datosDelLibro({ folder: 'zz' }, new Map()).folder, null);
});
