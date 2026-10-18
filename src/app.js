import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import * as DB from './db.js';
import { settings, saveSettings, applySettings, HL_COLORS, HL_NAMES } from './settings.js';
import { parseDoc, FORMATS, ext, epubMeta, extractPdfTexts, pdfTextSections, esc } from './parse.js';
import { FlowView, PdfPageView, pdfOutline } from './views.js';
import { anchorsFromRange } from './anchors.js';
import { onUpdateStatus, getUpdateStatus, checkForUpdate, applyNow } from './updater.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const native = Capacitor.isNativePlatform();
const MAX_LOADED = 8;
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const svg = (p) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const I = {
  book: svg('<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5c-.8 0-1.5-.7-1.5-1.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  list: svg('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  marker: svg('<path d="m9 11 4 4M4 20l4-1 11-11-3-3L5 16z"/>'),
  type: svg('<path d="M4 18 9 6l5 12M6 14h6M15 18l3-8 3 8M16 16h4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  note: svg('<path d="M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  split: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  sliders: svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
  share: svg('<path d="M12 4v12M8 8l4-4 4 4M5 14v5h14v-5"/>'),
};
const PALETTE = ['#F5C25B', '#7FB7A4', '#E8836B', '#B9A6E8', '#8FB8E8', '#E8C0A0'];
const FMT = { pdf: 'PDF', docx: 'WORD', epub: 'EPUB', txt: 'TXT' };
const TAGS = { estudio: 'Estudio', lectura: 'Lectura' };
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const wide = () => innerWidth >= 900;

const S = {
  books: [], hl: new Map(), views: new Map(), tabs: [], panes: [], focus: 0, split: false,
  screen: 'library', libTab: 'books', folders: [], lib: { folder: 'all', tag: 'all', fmt: 'all', q: '' }, panel: null, hlFilter: null,
  pending: null, hlLoaded: new Set(), texts: new Map(), textP: new Map(), saveT: {}, barTouched: false,
};
const bookById = (id) => S.books.find((b) => b.id === id);
const hlList = (id) => { if (!S.hl.has(id)) S.hl.set(id, []); return S.hl.get(id); };
const activeView = () => S.views.get(S.panes[S.focus]);
const viewMode = (v) => (v.kind === 'pdf' ? 'page' : v.paged ? 'text' : 'flow');

// ---------- utilidades de interfaz ----------
let toastT;
function toast(msg, opt = {}) {
  const t = $('#toast');
  t.replaceChildren(msg);
  if (opt.action) t.append(h('button', { onclick: () => { opt.action.fn(); t.classList.remove('show'); } }, opt.action.label));
  t.classList.add('show');
  clearTimeout(toastT);
  if (!opt.sticky) toastT = setTimeout(() => t.classList.remove('show'), opt.ms || 3200);
}
function loading(on, txt = '') {
  $('#loading').hidden = !on;
  $('#loadtxt').textContent = txt;
}
function modal(build) {
  return new Promise((res) => {
    const m = $('#modal');
    const box = h('div', { class: 'box' });
    m.replaceChildren(box);
    m.hidden = false;
    const close = (v) => { m.hidden = true; m.replaceChildren(); S.closeModal = null; res(v); };
    S.closeModal = () => close(null);
    m.onclick = (e) => { if (e.target === m) close(null); };
    build(box, close);
  });
}
const askText = (title, init = '', multi = false, ph = '') => modal((box, close) => {
  const f = h(multi ? 'textarea' : 'input', { placeholder: ph });
  f.value = init;
  box.append(h('h3', {}, title), f, h('div', { class: 'acts' },
    h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancelar'),
    h('button', { class: 'btn', onclick: () => close(f.value) }, 'Guardar')));
  setTimeout(() => f.focus(), 60);
  if (!multi) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(f.value); });
});
const choose = (title, opts) => modal((box, close) => {
  box.append(h('h3', {}, title));
  opts.forEach((o) => box.append(h('button', { class: 'big' + (o.danger ? ' dg' : ''), onclick: () => close(o.value) },
    o.label, o.sub ? h('small', {}, o.sub) : null)));
  box.append(h('div', { class: 'acts' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancelar')));
});

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = h('textarea'); ta.value = t; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copiado');
}
async function saveText(name, text, mime = 'text/markdown') {
  if (native) {
    try {
      await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
      await Share.share({ title: name, url: uri, dialogTitle: 'Guardar o compartir' });
      return;
    } catch (e) { if (String(e).includes('cancel')) return; console.warn(e); }
  }
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- PDF ----------
async function openPdf(blob) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    isEvalSupported: false,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', location.href).href,
    cMapUrl: new URL('pdfjs/cmaps/', location.href).href,
    cMapPacked: true,
  });
  task.onPassword = async (update, reason) => {
    const p = await askText(reason === 2 ? 'Contraseña incorrecta' : 'Este PDF tiene contraseña', '', false, 'Contraseña');
    if (p == null) task.destroy(); else update(p);
  };
  return task.promise;
}
async function pdfCover(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 260 / base.width });
  const cv = h('canvas');
  cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  page.cleanup();
  return cv.toDataURL('image/jpeg', 0.72);
}
function pdfTexts(book, pdf) {
  if (S.texts.has(book.id)) return Promise.resolve(S.texts.get(book.id));
  if (S.textP.has(book.id)) return S.textP.get(book.id);
  const p = (async () => {
    let t = await DB.getTexts(book.id);
    if (!t) {
      toast('Preparando el texto del PDF…', { sticky: true });
      t = await extractPdfTexts(pdf, (f) => toast(`Preparando el texto del PDF… ${Math.round(f * 100)} %`, { sticky: true }));
      await DB.putTexts(book.id, t);
      $('#toast').classList.remove('show');
    }
    S.texts.set(book.id, t);
    return t;
  })().finally(() => S.textP.delete(book.id));
  S.textP.set(book.id, p);
  return p;
}

// ---------- subrayados ----------
async function loadHl(id) {
  if (S.hlLoaded.has(id)) return;
  S.hl.set(id, await DB.hlOf(id));
  S.hlLoaded.add(id);
}
function copyAnchors(p) { return p.anchors.map((a) => a.text).join('\n'); }

async function createHl(color, note = '') {
  const p = S.pending;
  if (!p || p.kind !== 'new') return;
  const book = p.view.book;
  const list = hlList(book.id);
  for (const a of p.anchors) {
    for (const o of list.slice()) if (o.sec === a.sec && o.s >= a.s && o.e <= a.e) await removeHlRec(book.id, o, p.view);
    const rec = { id: DB.uid(), bookId: book.id, ...a, color, note, ts: Date.now() };
    list.push(rec);
    await DB.putHl(rec);
    p.view.addHl(rec);
  }
  saveSettings({ color });
  getSelection().removeAllRanges();
  hideBar();
  renderBar();
  if (S.panel === 'hl') renderPanel();
}
async function removeHlRec(bookId, rec, view) {
  view?.rmHl(rec.id);
  const l = hlList(bookId);
  l.splice(l.indexOf(rec), 1);
  await DB.delHl(rec.id);
}
function findHl(id) {
  for (const [bookId, l] of S.hl) { const r = l.find((x) => x.id === id); if (r) return { rec: r, bookId }; }
  return null;
}

// ---------- barra flotante de selección ----------
let selT, hideT;
function showBar(rect, mode, cur) {
  const bar = $('#selbar');
  bar.innerHTML = HL_COLORS.map((c, i) => `<button class="c${i === cur ? ' cur' : ''}" data-c="${i}" style="background:${c}" aria-label="${HL_NAMES[i]}"></button>`).join('')
    + `<span class="sep"></span><button class="a" data-a="note">${I.note}Nota</button><button class="a" data-a="copy" aria-label="Copiar">${I.copy}</button>`
    + (mode === 'edit' ? `<button class="a" data-a="del" aria-label="Quitar subrayado">${I.trash}</button>` : '');
  bar.style.visibility = 'hidden';
  bar.hidden = false;
  const w = bar.offsetWidth, hh = bar.offsetHeight;
  let x = rect.left + rect.width / 2 - w / 2;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  let y = rect.bottom + 14;
  if (y + hh > innerHeight - 20) y = Math.max(rect.top - hh - 14, 8);
  bar.style.left = x + 'px';
  bar.style.top = y + 'px';
  bar.style.visibility = '';
}
function hideBar() { $('#selbar').hidden = true; S.barTouched = false; if (S.pending?.kind === 'new') S.pending = null; }

function viewOfNode(n) {
  const el = n && (n.nodeType === 1 ? n : n.parentElement);
  const v = el?.closest?.('.view');
  return v ? S.views.get(v.dataset.id) : null;
}
function onSelection() {
  const sel = getSelection();
  const v = sel.rangeCount && !sel.isCollapsed ? viewOfNode(sel.anchorNode) : null;
  if (!v || !viewOfNode(sel.focusNode)) {
    if (!S.barTouched && S.pending?.kind === 'new') { clearTimeout(hideT); hideT = setTimeout(() => { if (!S.barTouched) hideBar(); }, 500); }
    return;
  }
  clearTimeout(hideT);
  const range = sel.getRangeAt(0);
  const anchors = anchorsFromRange(range, v.roots());
  if (!anchors.length) return;
  S.pending = { kind: 'new', view: v, anchors };
  if (settings.auto) { createHl(settings.color); return; }
  showBar(range.getBoundingClientRect(), 'new', settings.color);
}
function editHl(id, markEl) {
  const f = findHl(id);
  if (!f) return;
  S.pending = { kind: 'edit', id };
  showBar(markEl.getBoundingClientRect(), 'edit', f.rec.color);
}
async function setNote(rec, view) {
  const n = await askText('Nota', rec.note || '', true, 'Escribe tu nota…');
  if (n == null) return;
  rec.note = n.trim();
  await DB.putHl(rec);
  view?.styleHl(rec);
  if (S.panel === 'hl') renderPanel();
}
async function onBarClick(e) {
  const b = e.target.closest('button');
  const p = S.pending;
  if (!b || !p) return;
  if (b.dataset.c !== undefined) {
    const c = +b.dataset.c;
    if (p.kind === 'new') await createHl(c);
    else {
      const f = findHl(p.id);
      f.rec.color = c; await DB.putHl(f.rec); activeOrAny(f.bookId)?.styleHl(f.rec); saveSettings({ color: c }); hideBar(); if (S.panel === 'hl') renderPanel();
    }
  } else if (b.dataset.a === 'note') {
    if (p.kind === 'new') {
      const n = await askText('Nota', '', true, 'Escribe tu nota…');
      if (n != null) await createHl(settings.color, n.trim()); else hideBar();
    } else { const f = findHl(p.id); hideBar(); await setNote(f.rec, activeOrAny(f.bookId)); }
  } else if (b.dataset.a === 'copy') {
    copyText(p.kind === 'new' ? copyAnchors(p) : findHl(p.id).rec.text);
    getSelection().removeAllRanges(); hideBar();
  } else if (b.dataset.a === 'del') {
    const f = findHl(p.id);
    hideBar();
    await removeHlRec(f.bookId, f.rec, activeOrAny(f.bookId));
    renderBar();
    if (S.panel === 'hl') renderPanel();
  }
}
const activeOrAny = (bookId) => S.views.get(bookId);

// ---------- biblioteca ----------
function coverHtml(b, withMore) {
  const col = PALETTE[hash(b.title) % PALETTE.length];
  const inner = b.cover ? `<img src="${b.cover}" alt="">` : `<div class="t" style="background:${col}">${esc(b.title)}</div>`;
  return `<div class="cover">${inner}<i class="tg" style="background:var(--c-${b.tag})"></i><span class="fmt">${FMT[b.format]}</span></div>`
    + (withMore ? `<span class="more" data-more="${b.id}" role="button" aria-label="Opciones">⋯</span>` : '');
}
function renderLibrary() {
  const hr = new Date().getHours();
  $('#hello').textContent = hr < 6 ? 'Buenas noches' : hr < 12 ? 'Buenos días' : hr < 20 ? 'Buenas tardes' : 'Buenas noches';
  $('#libBooks').hidden = S.libTab !== 'books';
  $('#hlAll').hidden = S.libTab !== 'hls';
  document.querySelectorAll('#libnav button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.libTab));
  if (S.libTab === 'hls') return renderAllHl();
  const { tag, fmt, q, folder } = S.lib;
  const last = [...S.books].filter((b) => b.lastRead).sort((a, b) => b.lastRead - a.lastRead)[0];
  const cont = $('#cont');
  cont.replaceChildren();
  if (last && !q) {
    cont.append(h('button', { class: 'cont', onclick: () => openBook(last.id), html:
      `<div class="cover" style="width:92px;flex:none">${last.cover ? `<img src="${last.cover}" alt="">` : `<div class="t" style="background:${PALETTE[hash(last.title) % PALETTE.length]}">${esc(last.title)}</div>`}</div>
       <div class="meta"><div><div class="eyebrow">Continuar leyendo</div><h3>${esc(last.title)}</h3>
       <div class="sub">${TAGS[last.tag]} · ${FMT[last.format]} · ${(S.hl.get(last.id) || []).length ? (S.hl.get(last.id).length + ' subrayados') : ''}</div></div>
       <div><div class="bar"><i style="width:${Math.round(last.progress * 100)}%"></i></div><div class="sub" style="margin-top:6px">${Math.round(last.progress * 100)} %</div></div></div>` }));
  }
  const chip = (label, on, fn) => h('button', { class: 'chip' + (on ? ' on' : ''), onclick: fn }, label);
  const cnt = (id) => S.books.filter((b) => (id === 'none' ? !b.folder : b.folder === id)).length;
  const unfiled = cnt('none');
  $('#folderChips').replaceChildren(
    chip('Todas', folder === 'all', () => { S.lib.folder = 'all'; renderLibrary(); }),
    ...S.folders.map((f) => chip(`${f.name} · ${cnt(f.id)}`, folder === f.id, () => { S.lib.folder = f.id; renderLibrary(); })),
    ...(S.folders.length && unfiled ? [chip(`Sin carpeta · ${unfiled}`, folder === 'none', () => { S.lib.folder = 'none'; renderLibrary(); })] : []),
    h('button', { class: 'chip add', onclick: () => newFolder(true) }, '+ Carpeta'));
  const cur = S.folders.find((f) => f.id === folder);
  $('#folderHead').replaceChildren(...(cur ? [h('div', { class: 'fhead' }, h('div', {}, h('b', {}, cur.name), h('span', { class: 'sub' }, ` · ${cnt(cur.id)} documentos`)),
    h('div', { style: 'display:flex;gap:8px' }, h('button', { class: 'btn ghost', onclick: () => renameFolder(cur) }, 'Renombrar'), h('button', { class: 'btn ghost', onclick: () => deleteFolder(cur) }, 'Eliminar')))] : []));
  $('#tagChips').replaceChildren(
    chip('Todos', tag === 'all', () => { S.lib.tag = 'all'; renderLibrary(); }),
    chip('Estudio', tag === 'estudio', () => { S.lib.tag = 'estudio'; renderLibrary(); }),
    chip('Lectura', tag === 'lectura', () => { S.lib.tag = 'lectura'; renderLibrary(); }));
  $('#fmtChips').replaceChildren(...[['all', 'Todo'], ['pdf', 'PDF'], ['docx', 'Word'], ['epub', 'EPUB'], ['txt', 'Texto']]
    .map(([k, l]) => chip(l, fmt === k, () => { S.lib.fmt = k; renderLibrary(); })));
  const fq = q.toLowerCase();
  const list = S.books.filter((b) => (folder === 'all' || (folder === 'none' ? !b.folder : b.folder === folder)) && (tag === 'all' || b.tag === tag) && (fmt === 'all' || b.format === fmt)
    && (!fq || (b.title + ' ' + b.author).toLowerCase().includes(fq)))
    .sort((a, b) => (b.lastRead || b.added) - (a.lastRead || a.added));
  const grid = $('#grid');
  if (!list.length) {
    grid.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1', html: S.books.length
      ? '<b>Nada por aquí</b>Prueba con otro filtro o búsqueda.'
      : '<b>Tu biblioteca está vacía</b>Toca “Añadir libro” y elige tus PDF, Word o EPUB.<br>En laptop también puedes arrastrarlos a esta ventana.' }));
    return;
  }
  grid.replaceChildren(...list.map((b) => h('div', { class: 'card', 'data-id': b.id, html:
    `<button style="display:block;width:100%;text-align:left" data-open="${b.id}">${coverHtml(b)}<div class="nm">${esc(b.title)}</div>
     <div class="pc">${b.lastRead ? Math.round(b.progress * 100) + ' %' : 'Nuevo'} · ${S.folders.find((f) => f.id === b.folder)?.name || TAGS[b.tag]}</div></button>
     <span class="more" data-more="${b.id}" role="button" aria-label="Opciones">⋯</span>` })));
}
async function renderAllHl() {
  const all = await DB.allHl();
  const box = $('#hlAll');
  if (!all.length) { box.innerHTML = '<div class="empty"><b>Aún no hay subrayados</b>Abre un libro, selecciona texto y elige un color.</div>'; return; }
  box.replaceChildren();
  const byBook = new Map();
  all.forEach((x) => { if (!byBook.has(x.bookId)) byBook.set(x.bookId, []); byBook.get(x.bookId).push(x); });
  for (const [bid, list] of byBook) {
    const b = bookById(bid);
    if (!b) continue;
    box.append(h('div', { class: 'grp' }, b.title));
    list.sort((a, c) => a.sec - c.sec || a.s - c.s).forEach((x) => box.append(hlItem(x, b, () => openAt(bid, x))));
  }
}

async function openAt(bookId, rec) {
  await openBook(bookId);
  const v = S.views.get(bookId);
  setTimeout(() => v?.gotoHl(rec), 350);
}

// ---------- importar ----------
async function onFiles(files) {
  const ok = [...files].filter((f) => FORMATS[ext(f.name)]);
  if (!ok.length) { toast('Formatos admitidos: PDF, Word (.docx), EPUB y texto'); return; }
  const inFolder = S.folders.some((f) => f.id === S.lib.folder) ? S.lib.folder : null;
  let tag = S.lib.tag !== 'all' ? S.lib.tag : inFolder ? 'estudio' : null;
  if (!tag) {
    tag = await choose(ok.length > 1 ? `¿Dónde van estos ${ok.length} documentos?` : '¿Dónde va este documento?', [
      { label: 'Estudio', sub: 'Apuntes, guías, material para aprender', value: 'estudio' },
      { label: 'Lectura', sub: 'Libros para leer con calma', value: 'lectura' }]);
    if (!tag) return;
  }
  DB.persist();
  let last = null;
  for (let i = 0; i < ok.length; i++) {
    toast(`Añadiendo ${i + 1} de ${ok.length}…`, { sticky: true });
    last = (await addFile(ok[i], tag, inFolder)) || last;
  }
  toast(ok.length > 1 ? `${ok.length} documentos añadidos` : 'Documento añadido');
  S.libTab = 'books';
  renderLibrary();
  if (ok.length === 1 && last) openBook(last.id);
}
async function addFile(file, tag, folder = null) {
  const format = FORMATS[ext(file.name)];
  const dupe = S.books.find((b) => b.name === file.name && b.size === file.size);
  if (dupe) { toast('Ese documento ya estaba en tu biblioteca'); return dupe; }
  const id = DB.uid();
  const book = { id, name: file.name, title: file.name.replace(/\.[^.]+$/, ''), author: '', format, tag, folder, size: file.size, added: Date.now(), lastRead: 0, progress: 0, pos: null, cover: null, pages: 0 };
  try {
    if (format === 'pdf') {
      const pdf = await openPdf(file);
      book.pages = pdf.numPages;
      const meta = await pdf.getMetadata().catch(() => null);
      const t = meta?.info?.Title;
      if (t && t.trim().length > 2 && !/^(untitled|microsoft word)/i.test(t.trim())) book.title = t.trim();
      book.author = meta?.info?.Author || '';
      book.cover = await pdfCover(pdf).catch(() => null);
      pdf.destroy();
    } else if (format === 'epub') {
      const m = await epubMeta(file);
      if (m.title) book.title = m.title;
      book.author = m.author;
    }
    await DB.putBlob(id, file);
    await DB.putBook(book);
  } catch (e) {
    console.warn(e);
    toast(`No se pudo leer “${file.name}”`);
    return null;
  }
  S.books.push(book);
  return book;
}

// ---------- abrir / pestañas / paneles de pantalla ----------
async function openBook(id) {
  const book = bookById(id);
  if (!book) return;
  if (!S.views.has(id)) {
    loading(true, `Abriendo “${book.title}”…`);
    try {
      const blob = await DB.getBlob(id);
      if (!blob) throw new Error('No se encontró el archivo guardado');
      await loadHl(id);
      let view;
      if (book.format === 'pdf') {
        const pdf = await openPdf(blob);
        const mode = book.mode || settings.pdfMode;
        if (mode === 'text') {
          const texts = await pdfTexts(book, pdf);
          if (texts.every((p) => !p.length)) { toast('Este PDF es una imagen (sin texto): se muestra la página original'); view = await PdfPageView.create(appApi, book, pdf); }
          else {
            view = new FlowView(appApi, book, { sections: pdfTextSections(texts), toc: await pdfOutline(pdf) }, { labels: true });
            pdf.destroy();
          }
        } else view = await PdfPageView.create(appApi, book, pdf);
      } else view = new FlowView(appApi, book, await parseDoc(book, blob));
      view.el.dataset.id = id;
      view.el.classList.add('off');
      $('#views').append(view.el);
      view.applyAll();
      S.views.set(id, view);
      evictViews(id);
    } catch (e) {
      console.warn(e);
      toast(`No se pudo abrir: ${e?.message || e}`);
      loading(false);
      return;
    }
    loading(false);
  }
  const v = S.views.get(id);
  v.lastUse = Date.now();
  book.lastRead = Date.now();
  DB.putBook(book);
  showInPane(id);
  requestAnimationFrame(() => restorePos(v, book));
}
function restorePos(v, book) {
  const p = book.pos;
  if (!p) return;
  if (p.m === viewMode(v)) v.setPos(p); else if (p.page != null) v.setPos({ page: p.page });
}
function evictViews(keep) {
  while (S.views.size > MAX_LOADED) {
    let victim = null;
    for (const [id, v] of S.views) if (id !== keep && !S.panes.includes(id) && (!victim || v.lastUse < victim.v.lastUse)) victim = { id, v };
    if (!victim) return;
    victim.v.destroy();
    S.views.delete(victim.id);
  }
}
function showInPane(id) {
  if (!S.tabs.includes(id)) S.tabs.push(id);
  if (S.split && S.panes.length === 2) {
    const other = 1 - S.focus;
    if (S.panes[other] === id) S.panes[other] = S.panes[S.focus];
    S.panes[S.focus] = id;
  } else { S.panes = [id]; S.focus = 0; }
  S.screen = 'reader';
  layout();
  saveSession();
}
function layout() {
  if (innerWidth < 1100 && S.split) { S.split = false; S.panes = S.panes.slice(0, 1); S.focus = 0; }
  const reader = S.screen === 'reader';
  $('#library').hidden = reader;
  $('#viewer').hidden = !reader;
  $('#fab').hidden = reader;
  $('#libnav').hidden = reader;
  $('#bar').hidden = !reader;
  const two = S.panes.length === 2;
  S.views.forEach((v, id) => {
    const idx = S.panes.indexOf(id);
    if (!reader || idx < 0) { v.el.classList.add('off'); v.suspend(); return; }
    v.el.classList.remove('off');
    v.el.style.left = two && idx === 1 ? '50%' : '0';
    v.el.style.right = two && idx === 0 ? '50%' : '0';
    v.el.classList.toggle('paneedge', two && idx === 1);
    v.resume();
  });
  renderTabs();
  renderBar();
}
function goLibrary() {
  S.screen = 'library';
  closePanel();
  hideBar();
  layout();
  renderLibrary();
  saveSession();
}
function renderTabs() {
  $('#homeBtn').classList.toggle('on', S.screen === 'library');
  $('#splitBtn').classList.toggle('on', S.split);
  const box = $('#tabs');
  box.replaceChildren(...S.tabs.map((id) => {
    const b = bookById(id);
    if (!b) return null;
    const vis = S.screen === 'reader' && S.panes.includes(id);
    const foc = S.screen === 'reader' && S.panes[S.focus] === id;
    return h('button', { class: 'tab' + (vis ? ' vis' : '') + (foc ? ' focus' : ''), role: 'tab', title: b.title, onclick: () => openBook(id) },
      h('i', { class: 'dot', style: `background:var(--c-${b.tag})` }),
      h('span', {}, b.title),
      h('span', { class: 'x', role: 'button', 'aria-label': 'Cerrar', onclick: (e) => { e.stopPropagation(); closeTab(id); } }, '×'));
  }));
  box.querySelector('.focus')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
function closeTab(id) {
  const v = S.views.get(id);
  if (v) { flushProgress(v.book); v.destroy(); S.views.delete(id); }
  const i = S.tabs.indexOf(id);
  S.tabs = S.tabs.filter((x) => x !== id);
  if (S.panes.includes(id)) {
    const rest = S.tabs.filter((x) => !S.panes.includes(x));
    if (S.split && S.panes.length === 2) {
      const keep = S.panes.find((x) => x !== id);
      S.split = false; S.panes = [keep]; S.focus = 0;
    } else {
      const next = S.tabs[Math.min(i, S.tabs.length - 1)] ?? rest[0];
      if (next) { openBook(next); return; }
      S.panes = [];
      S.screen = 'library';
      renderLibrary();
    }
  }
  closePanel();
  layout();
  saveSession();
}
function toggleSplit() {
  if (S.screen !== 'reader') return;
  if (S.split) { S.split = false; S.panes = [S.panes[S.focus]]; S.focus = 0; layout(); saveSession(); return; }
  if (innerWidth < 1100) { toast('La vista dividida necesita una pantalla más ancha'); return; }
  const cur = S.panes[0];
  const other = S.tabs.filter((x) => x !== cur).sort((a, b) => (S.views.get(b)?.lastUse || 0) - (S.views.get(a)?.lastUse || 0))[0];
  if (!other) { toast('Abre otro documento para verlos lado a lado'); return; }
  S.split = true;
  S.panes = [cur, other];
  S.focus = 0;
  openBook(other).then(() => { S.panes = [cur, other]; S.split = true; layout(); });
}
async function saveSession() {
  await DB.kvSet('session', { tabs: S.tabs, panes: S.panes, focus: S.focus, split: S.split, screen: S.screen });
}

// ---------- progreso ----------
let rafBar;
function onScroll(view) {
  const book = view.book;
  book.pos = { ...view.getPos(), m: viewMode(view) };
  book.progress = view.kind === 'pdf' || view.paged ? view.ratio_ !== undefined ? view.ratio() : view.page() / Math.max(view.secs.length - 1, 1) : view.ratio();
  book.lastRead = Date.now();
  clearTimeout(S.saveT[book.id]);
  S.saveT[book.id] = setTimeout(() => DB.putBook(book), 1200);
  if (view === activeView() && !rafBar) rafBar = requestAnimationFrame(() => { rafBar = 0; renderBar(); });
}
function flushProgress(book) { clearTimeout(S.saveT[book.id]); DB.putBook(book); }
function renderBar() {
  const v = activeView();
  if (!v || S.screen !== 'reader') return;
  const seek = $('#seek');
  if (document.activeElement !== seek) seek.value = Math.round((v.kind === 'pdf' || v.paged ? v.page() / Math.max((v.pgs?.length || v.secs.length) - 1, 1) : v.ratio()) * 1000);
  $('#plabel').textContent = v.label();
  const n = hlList(v.book.id).length;
  $('#hlN').textContent = n ? `Subrayados · ${n}` : 'Subrayados';
  $('#markBtn').classList.toggle('on', settings.auto);
}

// ---------- paneles laterales / hojas ----------
function openPanel(name) {
  if (S.panel === name) return closePanel();
  S.panel = name;
  renderPanel();
  $('#panel').classList.add('open');
  $('#backdrop').hidden = false;
  $('#bar').querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === name));
}
function closePanel() {
  S.panel = null;
  $('#panel').classList.remove('open');
  $('#backdrop').hidden = true;
  $('#bar').querySelectorAll('[data-p]').forEach((b) => b.classList.remove('on'));
}
function renderPanel() {
  const box = $('#panelBody');
  const v = activeView();
  const name = S.panel;
  if (name === 'toc') {
    const toc = v?.toc || [];
    box.replaceChildren(h('div', { class: 'ph' }, h('h2', {}, 'Contenido')),
      ...(toc.length ? toc.map((it) => h('button', { class: 'li', style: `padding-left:${it.depth * 16}px`, onclick: () => { v.gotoToc(it); if (!wide()) closePanel(); } }, it.title))
        : [h('div', { class: 'sub' }, 'Este documento no trae índice. Usa la barra de progreso o la búsqueda.')]));
  } else if (name === 'hl') {
    if (!v) return;
    const all = hlList(v.book.id).slice().sort((a, b) => a.sec - b.sec || a.s - b.s);
    const list = S.hlFilter === null ? all : all.filter((x) => x.color === S.hlFilter);
    const chips = h('div', { class: 'chips' }, h('button', { class: 'chip' + (S.hlFilter === null ? ' on' : ''), onclick: () => { S.hlFilter = null; renderPanel(); } }, 'Todos'),
      ...HL_COLORS.map((c, i) => h('button', { class: 'chip' + (S.hlFilter === i ? ' on' : ''), onclick: () => { S.hlFilter = i; renderPanel(); } }, h('i', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:6px` }), HL_NAMES[i])));
    box.replaceChildren(
      h('div', { class: 'ph' }, h('h2', {}, `Subrayados · ${all.length}`),
        h('button', { class: 'btn ghost', onclick: () => exportHl(v.book) }, 'Exportar')),
      chips,
      ...(list.length ? list.map((x) => hlItem(x, v.book, () => { v.gotoHl(x); if (!wide()) closePanel(); }, v))
        : [h('div', { class: 'sub' }, 'Selecciona texto en el documento y elige un color para subrayar. El subrayado queda fijo sobre las letras.')]));
  } else if (name === 'search') {
    const input = h('input', { class: 'sbox', type: 'search', placeholder: 'Buscar en este documento', 'aria-label': 'Buscar' });
    const res = h('div');
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { res.replaceChildren(); return; }
        res.replaceChildren(h('div', { class: 'sub' }, 'Buscando…'));
        const r = await v.search(q);
        res.replaceChildren(...(r.length ? [h('div', { class: 'sub' }, `${r.length}${r.length >= 200 ? '+' : ''} resultados`), ...r.map((x) => h('button', { class: 'li', onclick: () => { x.go(); if (!wide()) closePanel(); } }, x.snippet, x.label ? h('small', {}, x.label) : null))]
          : [h('div', { class: 'sub' }, 'Sin resultados')]));
      }, 350);
    });
    box.replaceChildren(h('div', { class: 'ph' }, h('h2', {}, 'Buscar')), input, res);
    setTimeout(() => input.focus(), 150);
  } else if (name === 'cfg') renderCfg(box, v);
}
function locLabel(book, rec) {
  const v = S.views.get(book.id);
  if (book.format === 'pdf') return `Pág. ${rec.sec + 1}`;
  const t = v?.data?.sections?.[rec.sec]?.title;
  if (t) return t;
  return (v?.secs?.length || 2) > 1 ? `Parte ${rec.sec + 1}` : '';
}
function hlItem(x, book, go, view) {
  return h('div', { class: 'hli' },
    h('i', { class: 'sw', style: `background:${HL_COLORS[x.color]}` }),
    h('button', { class: 'tx', onclick: go }, x.text,
      x.note ? h('div', { class: 'nt' }, x.note) : null,
      h('div', { class: 'meta' }, [locLabel(book, x), HL_NAMES[x.color]].filter(Boolean).join(' · '))),
    h('div', { class: 'acts' },
      h('button', { 'aria-label': 'Nota', html: I.note, onclick: () => setNote(x, S.views.get(book.id)).then(() => S.libTab === 'hls' && renderAllHl()) }),
      h('button', { 'aria-label': 'Quitar', html: I.trash, onclick: async () => { await removeHlRec(book.id, x, S.views.get(book.id)); renderBar(); if (S.screen === 'reader') renderPanel(); else renderAllHl(); } })));
}
function exportHl(book) {
  const list = hlList(book.id).slice().sort((a, b) => a.sec - b.sec || a.s - b.s);
  if (!list.length) { toast('No hay subrayados que exportar'); return; }
  const md = `# ${book.title}\n${book.author ? `_${book.author}_\n` : ''}\n## Subrayados\n\n` + list.map((x) =>
    `> ${x.text}\n\n— ${[locLabel(book, x), HL_NAMES[x.color]].filter(Boolean).join(' · ')}${x.note ? `\n\n**Nota:** ${x.note}` : ''}\n`).join('\n');
  saveText(`${book.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 60)} - subrayados.md`, md);
}

function renderCfg(box, v) {
  const seg = (items, cur, set) => h('div', { class: 'seg' }, ...items.map(([k, l]) => h('button', { class: cur === k ? 'on' : '', onclick: () => set(k) }, l)));
  const apply = (patch) => {
    const flows = [...S.views.values()].filter((x) => x.kind === 'flow');
    const rs = flows.map((x) => x.ratio());
    saveSettings(patch);
    flows.forEach((x, i) => x.seek(rs[i]));
    if ('pdfZoom' in patch) S.views.forEach((x) => x.kind === 'pdf' && x.relayout());
    renderCfg(box, activeView());
  };
  const themes = { papel: ['Papel', '#F6F1E7', '#1F1B16'], sepia: ['Sepia', '#E9D9B8', '#3B2D16'], noche: ['Noche', '#14110D', '#E6DDCB'], oled: ['OLED', '#000', '#D8D2C4'] };
  const slider = (min, max, step, val, fn) => { const r = h('input', { type: 'range', min, max, step }); r.value = val; r.addEventListener('input', () => fn(+r.value)); return r; };
  const kids = [h('div', { class: 'ph' }, h('h2', {}, 'Ajustes'))];
  kids.push(h('div', { class: 'lbl' }, 'Tema'),
    h('div', { class: 'themes' }, ...Object.entries(themes).map(([k, [l, bg, fg]]) => h('button', { class: 'th' + (settings.theme === k ? ' on' : ''), style: `background:${bg};color:${fg}`, onclick: () => apply({ theme: k }) }, l))));
  kids.push(h('div', { class: 'lbl' }, 'Tamaño de letra', h('b', {}, settings.size + ' px')),
    slider(14, 34, 1, settings.size, (n) => { saveSettings({ size: n }); $('#panelBody .lbl b').textContent = n + ' px'; }));
  kids.push(h('div', { class: 'lbl' }, 'Tipografía'), seg([['serif', 'Serif'], ['sans', 'Sans'], ['dislexia', 'Legible']], settings.font, (k) => apply({ font: k })));
  kids.push(h('div', { class: 'lbl' }, 'Interlineado'), slider(1.3, 2.2, 0.05, settings.lh, (n) => saveSettings({ lh: n })));
  kids.push(h('div', { class: 'lbl' }, 'Ancho del texto'), seg([['estrecho', 'Estrecho'], ['medio', 'Medio'], ['ancho', 'Ancho']], settings.width, (k) => apply({ width: k })));
  if (v?.book.format === 'pdf') {
    const mode = v.kind === 'pdf' ? 'page' : 'text';
    kids.push(h('div', { class: 'lbl' }, 'PDF'),
      seg([['page', 'Página original'], ['text', 'Texto cómodo']], mode, (k) => setPdfMode(v.book, k)));
    if (v.kind === 'pdf') {
      const zl = h('b', {}, Math.round(settings.pdfZoom * 100) + ' %');
      kids.push(h('div', { class: 'lbl' }, 'Zoom de página', zl),
        slider(0.6, 2.5, 0.1, settings.pdfZoom, (n) => { zl.textContent = Math.round(n * 100) + ' %'; clearTimeout(S.zt); S.zt = setTimeout(() => apply({ pdfZoom: n }), 250); }));
    }
  }
  const toggle = (on, fn) => h('button', { class: 'toggle' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), onclick: fn });
  kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Marcador automático'), h('div', { class: 'sub' }, 'Al seleccionar texto se subraya solo con el color elegido')),
    toggle(settings.auto, () => apply({ auto: !settings.auto }))));
  kids.push(h('div', { class: 'lbl' }, 'Color del marcador'), h('div', { class: 'seg' }, ...HL_COLORS.map((c, i) =>
    h('button', { class: settings.color === i ? 'on' : '', 'aria-label': HL_NAMES[i], onclick: () => apply({ color: i }) }, h('i', { style: `display:block;height:18px;border-radius:9px;background:${c}` })))));
  const st = getUpdateStatus();
  const txt = { idle: 'Sin revisar', checking: 'Buscando…', latest: 'Estás al día', downloading: `Descargando ${st.version || ''}…`, ready: `La versión ${st.version} está lista`, offline: 'No se pudo conectar al servidor' }[st.state] || '';
  kids.push(h('div', { class: 'lbl' }, 'Aplicación'),
    h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Actualización'), h('div', { class: 'sub', id: 'updtxt' }, native ? `Versión ${__APP_VERSION__} · ${txt}` : `Versión ${__APP_VERSION__} · se actualiza al recargar`)),
      native ? h('button', { class: 'btn', onclick: () => (st.state === 'ready' ? applyNow() : checkForUpdate()) }, st.state === 'ready' ? 'Actualizar ahora' : 'Revisar')
        : h('button', { class: 'btn', onclick: () => location.reload() }, 'Recargar')),
    h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Copia de subrayados'), h('div', { class: 'sub' }, 'Pasa tus marcas y progreso entre celular y laptop')),
      h('div', { style: 'display:flex;gap:8px' }, h('button', { class: 'btn ghost', onclick: exportBackup }, 'Exportar'), h('button', { class: 'btn ghost', onclick: () => $('#bk').click() }, 'Importar'))));
  box.replaceChildren(...kids);
}
async function setPdfMode(book, mode) {
  const old = S.views.get(book.id);
  const page = old?.page?.() ?? 0;
  book.mode = mode;
  await DB.putBook(book);
  if (old) { old.destroy(); S.views.delete(book.id); }
  closePanel();
  book.pos = { page, m: mode === 'text' ? 'text' : 'page' };
  await openBook(book.id);
}

// ---------- copia de seguridad ----------
async function exportBackup() {
  const hl = await DB.allHl();
  const data = { app: 'lumen', v: 1, books: S.books.map(({ id, title, name, size, format, tag, progress, pos, mode }) => ({ id, title, name, size, format, tag, progress, pos, mode })), hl };
  saveText('lumen-copia.json', JSON.stringify(data), 'application/json');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'lumen') throw new Error('no es una copia de Lumen');
    const map = new Map();
    for (const b of data.books) {
      const local = S.books.find((x) => (x.name === b.name && x.size === b.size) || x.title === b.title);
      if (local) { map.set(b.id, local.id); if (!local.lastRead) { local.progress = b.progress || 0; local.pos = b.pos || null; local.lastRead = b.pos ? 1 : 0; await DB.putBook(local); } }
    }
    let added = 0, skipped = 0;
    const have = new Set((await DB.allHl()).map((x) => x.id));
    for (const x of data.hl) {
      const bid = map.get(x.bookId);
      if (!bid) { skipped++; continue; }
      if (have.has(x.id)) continue;
      const rec = { ...x, bookId: bid };
      await DB.putHl(rec);
      if (S.hl.has(bid)) S.hl.get(bid).push(rec);
      added++;
    }
    for (const bid of map.values()) { const v = S.views.get(bid); if (v) { S.hl.delete(bid); S.hlLoaded.delete(bid); await loadHl(bid); v.applyAll(); } }
    toast(`${added} subrayados importados${skipped ? ` · ${skipped} sin su documento (súbelo primero)` : ''}`, { ms: 5000 });
    renderLibrary();
  } catch (e) { toast('No se pudo leer la copia: ' + e.message); }
}

// ---------- carpetas ----------
const saveFolders = () => DB.kvSet('folders', S.folders);
async function newFolder(select) {
  const n = await askText('Nueva carpeta', '', false, 'Ej.: Derecho Civil');
  if (!n || !n.trim()) return null;
  const f = { id: DB.uid(), name: n.trim().slice(0, 40) };
  S.folders.push(f);
  await saveFolders();
  if (select) S.lib.folder = f.id;
  renderLibrary();
  return f;
}
async function renameFolder(f) {
  const n = await askText('Nombre de la carpeta', f.name);
  if (!n || !n.trim()) return;
  f.name = n.trim().slice(0, 40);
  await saveFolders();
  renderLibrary();
}
async function deleteFolder(f) {
  const ok = await choose(`¿Eliminar la carpeta “${f.name}”?`, [{ label: 'Sí, eliminar carpeta', sub: 'Los documentos NO se borran: quedan sin carpeta', value: true, danger: true }]);
  if (!ok) return;
  for (const b of S.books) if (b.folder === f.id) { b.folder = null; await DB.putBook(b); }
  S.folders = S.folders.filter((x) => x.id !== f.id);
  await saveFolders();
  S.lib.folder = 'all';
  renderLibrary();
}

// ---------- menú de documento ----------
async function bookMenu(id) {
  const b = bookById(id);
  const act = await choose(b.title, [
    { label: 'Abrir', value: 'open' },
    { label: `Mover a ${b.tag === 'estudio' ? 'Lectura' : 'Estudio'}`, sub: `Ahora está en ${TAGS[b.tag]}`, value: 'tag' },
    { label: 'Mover a carpeta…', sub: S.folders.find((f) => f.id === b.folder)?.name || 'Sin carpeta', value: 'folder' },
    { label: 'Cambiar nombre', value: 'rename' },
    { label: 'Exportar subrayados', value: 'export' },
    { label: 'Eliminar de la biblioteca', sub: 'Borra el archivo y sus subrayados', value: 'del', danger: true }]);
  if (act === 'open') openBook(id);
  else if (act === 'tag') { b.tag = b.tag === 'estudio' ? 'lectura' : 'estudio'; await DB.putBook(b); renderLibrary(); renderTabs(); }
  else if (act === 'folder') {
    const opts = [...S.folders.map((f) => ({ label: f.name, value: f.id })), { label: 'Nueva carpeta…', value: '__new' }, ...(b.folder ? [{ label: 'Sacar de la carpeta', value: '__none' }] : [])];
    const t = await choose('Mover a carpeta', opts);
    if (t === '__new') { const f = await newFolder(false); if (f) b.folder = f.id; }
    else if (t === '__none') b.folder = null;
    else if (t) b.folder = t;
    if (t) { await DB.putBook(b); renderLibrary(); }
  }
  else if (act === 'rename') { const n = await askText('Nombre', b.title); if (n && n.trim()) { b.title = n.trim(); await DB.putBook(b); renderLibrary(); renderTabs(); } }
  else if (act === 'export') { await loadHl(id); exportHl(b); }
  else if (act === 'del') {
    const ok = await choose(`¿Eliminar “${b.title}”?`, [{ label: 'Sí, eliminar', sub: 'No se puede deshacer', value: true, danger: true }]);
    if (!ok) return;
    if (S.tabs.includes(id)) closeTab(id);
    await DB.delBook(id);
    S.books = S.books.filter((x) => x.id !== id);
    S.hl.delete(id); S.hlLoaded.delete(id); S.texts.delete(id);
    renderLibrary();
    toast('Documento eliminado');
  }
}

const appApi = { hls: (id) => S.hl.get(id) || [], onScroll, editHl, pdfTexts };

// ---------- arranque ----------
export async function start() {
  applySettings();
  $('#app').innerHTML = `
<div id="shell">
  <header id="top">
    <button class="ib" id="homeBtn" aria-label="Biblioteca">${I.book}</button>
    <div id="tabs" role="tablist"></div>
    <button class="ib split-only" id="splitBtn" aria-label="Dividir pantalla">${I.split}</button>
    <button class="ib" id="cfgBtn" aria-label="Ajustes">${I.sliders}</button>
  </header>
  <div id="body">
    <main id="main">
      <section id="library">
        <div class="lib-head"><div><div class="hello" id="hello"></div><h1 class="brand">Lumen</h1></div>
          <input id="q" type="search" placeholder="Buscar en la biblioteca" aria-label="Buscar en la biblioteca"></div>
        <div id="libBooks"><div id="cont"></div><div class="chips" id="folderChips"></div><div id="folderHead"></div><div class="chips" id="tagChips"></div><div class="chips" id="fmtChips"></div><div id="grid"></div></div>
        <div id="hlAll" hidden></div>
      </section>
      <section id="viewer" hidden><div id="views"></div></section>
      <button id="fab">${I.plus} Añadir libro</button>
      <div id="loading" hidden><div><div class="spin"></div><span id="loadtxt"></span></div></div>
    </main>
    <aside id="panel" aria-label="Panel"><div class="grab"></div><div id="panelBody"></div></aside>
  </div>
  <footer id="bar" hidden>
    <div class="row"><input id="seek" type="range" min="0" max="1000" aria-label="Posición en el documento"><span id="plabel"></span></div>
    <div class="tools">
      <button data-p="toc">${I.list}Contenido</button>
      <button data-p="hl">${I.marker}<span id="hlN">Subrayados</span></button>
      <button data-p="search">${I.search}Buscar</button>
      <button id="markBtn" aria-label="Marcador automático">${I.marker}Marcador</button>
      <button data-p="cfg">${I.type}Ajustes</button>
    </div>
  </footer>
  <nav id="libnav"><button data-t="books" class="on">Biblioteca</button><button data-t="hls">Subrayados</button></nav>
</div>
<input type="file" id="file" multiple hidden accept=".pdf,.docx,.epub,.txt,.md,.html,.htm,application/pdf">
<input type="file" id="bk" hidden accept=".json,application/json">
<div id="backdrop" hidden></div><div id="selbar" hidden></div><div id="toast" role="status"></div><div id="modal" hidden></div>`;

  S.books = await DB.allBooks();
  S.folders = (await DB.kvGet('folders').catch(() => null)) || [];
  const ses = await DB.kvGet('session').catch(() => null);

  $('#homeBtn').onclick = goLibrary;
  $('#cfgBtn').onclick = () => openPanel('cfg');
  $('#splitBtn').onclick = toggleSplit;
  $('#fab').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; onFiles(f); };
  $('#bk').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
  $('#q').oninput = (e) => { S.lib.q = e.target.value.trim(); renderLibrary(); $('#q').focus(); };
  $('#libnav').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.libTab = b.dataset.t; renderLibrary(); } };
  $('#backdrop').onclick = closePanel;
  $('#grid').onclick = (e) => {
    const m = e.target.closest('[data-more]');
    if (m) { bookMenu(m.dataset.more); return; }
    const o = e.target.closest('[data-open]');
    if (o) openBook(o.dataset.open);
  };
  $('#bar').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.p) openPanel(b.dataset.p);
    else if (b.id === 'markBtn') { saveSettings({ auto: !settings.auto }); toast(settings.auto ? 'Marcador automático activado' : 'Marcador automático apagado'); renderBar(); }
  };
  $('#seek').oninput = (e) => { const v = activeView(); if (v) v.seek(e.target.value / 1000); };
  $('#selbar').addEventListener('pointerdown', () => { S.barTouched = true; clearTimeout(hideT); });
  $('#selbar').addEventListener('click', onBarClick);
  $('#views').addEventListener('pointerdown', (e) => {
    const id = e.target.closest('.view')?.dataset.id;
    const i = S.panes.indexOf(id);
    if (i >= 0 && i !== S.focus) { S.focus = i; renderTabs(); renderBar(); if (S.panel) renderPanel(); }
    if (!$('#selbar').hidden && !e.target.closest('mark.hl')) hideBar();
  });
  document.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(onSelection, 320); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (S.closeModal) S.closeModal(); else if (S.panel) closePanel(); else hideBar(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.screen === 'reader') { e.preventDefault(); S.panel = null; openPanel('search'); }
  });
  addEventListener('resize', () => { if (innerWidth < 1100 && S.split) { layout(); } });
  addEventListener('beforeunload', () => S.views.forEach((v) => flushProgress(v.book)));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') S.views.forEach((v) => flushProgress(v.book)); });
  // Arrastrar archivos (laptop)
  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dropping'); if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files); });

  onUpdateStatus((s) => {
    if (S.panel === 'cfg') renderPanel();
    if (s.state === 'ready') toast(`Hay una versión nueva (${s.version})`, { sticky: true, action: { label: 'Actualizar ahora', fn: applyNow } });
  });

  if (native) {
    CapApp.addListener('backButton', () => {
      if (S.closeModal) S.closeModal();
      else if (!$('#selbar').hidden) hideBar();
      else if (S.panel) closePanel();
      else if (S.screen === 'reader') goLibrary();
      else if (S.libTab !== 'books') { S.libTab = 'books'; renderLibrary(); }
      else CapApp.minimizeApp();
    });
  } else if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Restaurar pestañas (se cargan al tocarlas, para no gastar memoria al abrir).
  S.tabs = (ses?.tabs || []).filter((id) => bookById(id));
  renderLibrary();
  renderTabs();
  if (ses?.screen === 'reader' && ses.panes?.length) {
    const ids = ses.panes.filter((id) => bookById(id));
    if (ids.length) {
      await openBook(ids[0]);
      if (ids[1] && innerWidth >= 1100) { S.split = true; S.panes = [ids[0], ids[1]]; await openBook(ids[1]); S.panes = [ids[0], ids[1]]; S.split = true; S.focus = Math.min(ses.focus || 0, 1); layout(); }
    }
  }
  return true;
}
