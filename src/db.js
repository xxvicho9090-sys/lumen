import { openDB } from 'idb';

let _db;
const db = () => (_db ??= openDB('lumen', 1, {
  upgrade(d) {
    d.createObjectStore('books', { keyPath: 'id' });
    d.createObjectStore('blobs');
    d.createObjectStore('hl', { keyPath: 'id' }).createIndex('book', 'bookId');
    d.createObjectStore('texts');
    d.createObjectStore('kv');
  },
}));

let hook = () => {};
export const onWrite = (f) => { hook = f; };
const w = async (r) => { hook(); return r; };
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const allBooks = async () => (await db()).getAll('books');
export const putBook = async (b) => w(await (await db()).put('books', b));
export const getBlob = async (id) => (await db()).get('blobs', id);
export const putBlob = async (id, blob) => (await db()).put('blobs', blob, id);
export const hlOf = async (bookId) => (await db()).getAllFromIndex('hl', 'book', bookId);
export const allHl = async () => (await db()).getAll('hl');
export const putHl = async (h) => w(await (await db()).put('hl', h));
export const delHl = async (id) => w(await (await db()).delete('hl', id));
export const getTexts = async (id) => (await db()).get('texts', id);
export const putTexts = async (id, t) => (await db()).put('texts', t, id);
export const kvGet = async (k) => (await db()).get('kv', k);
export const kvSet = async (k, v) => w(await (await db()).put('kv', v, k));

export async function delBook(id) {
  const d = await db();
  const tx = d.transaction(['books', 'blobs', 'texts', 'hl'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('blobs').delete(id);
  tx.objectStore('texts').delete(id);
  let c = await tx.objectStore('hl').index('book').openCursor(id);
  while (c) { c.delete(); c = await c.continue(); }
  await tx.done;
  hook();
}

export const persist = () => navigator.storage?.persist?.().catch(() => {});
