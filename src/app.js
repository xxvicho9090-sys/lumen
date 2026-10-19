import { Capacitor, SystemBars, registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import * as DB from './db.js';
import { settings, saveSettings, applySettings, HL_COLORS, HL_NAMES } from './settings.js';
import { parseDoc, FORMATS, ext, epubMeta, extractPdfTexts, pdfTextSections, esc, fold } from './parse.js';
import { FlowView, PdfPageView, pdfOutline } from './views.js';
import { anchorsFromRange } from './anchors.js';
import { onUpdateStatus, getUpdateStatus, checkForUpdate, applyNow } from './updater.js';
import { I, LOGO } from './icons.js';

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
const PALETTE = ['#E9B96E', '#C9D3F5', '#F0B5C0', '#A8DCC4', '#B5C7F2', '#E6C9A8'];
const FMT = { pdf: 'PDF', docx: 'WORD', epub: 'EPUB', txt: 'TXT' };
const TAGS = { estudio: 'Estudio', lectura: 'Lectura' };
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const wide = () => innerWidth >= 900;

const S = {
  books: [], hl: new Map(), views: new Map(), tabs: [], panes: [], focus: 0, split: false,
  screen: 'library', libTab: 'books', folders: [], lib: { folder: 'all', tag: 'all', fmt: 'all', q: '' }, panel: null, hlFilter: null,
  sel: new Set(), selMode: false, pending: null, mirror: null, stats: { days: {}, books: {} }, timer: null, tts: null, fey: [], pomoCycle: 0, hlLoaded: new Set(), texts: new Map(), textP: new Map(), saveT: {}, barTouched: false,
};
// ---------- instalar en laptop / almacenamiento / copia espejo ----------
let deferredInstall = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function installUi() {
  const b = document.getElementById('installBtn');
  if (b) b.hidden = !(deferredInstall && !native && !standalone());
  if (S.panel === 'cfg') renderPanel();
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; installUi(); });
addEventListener('appinstalled', () => { deferredInstall = null; installUi(); toast('Lumen instalada: ábrela desde el menú Inicio o el escritorio'); });
async function doInstall() {
  if (!deferredInstall) { toast('En el menú del navegador (⋮) elige “Instalar Lumen”', { ms: 5000 }); return; }
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  installUi();
}
async function storageInfo() {
  const r = { persisted: null, usage: null, quota: null };
  try {
    r.persisted = await navigator.storage.persisted();
    const e = await navigator.storage.estimate();
    r.usage = e.usage; r.quota = e.quota;
  } catch { /* sin API */ }
  return r;
}
const sizeLabel = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');

let mirrorT;
const scheduleMirror = () => { if (native) { clearTimeout(mirrorT); mirrorT = setTimeout(writeMirror, 4000); } };
async function backupData() {
  return { app: 'lumen', v: 1, at: Date.now(), folders: S.folders, fey: S.fey, hl: await DB.allHl(),
    books: S.books.map(({ id, title, name, size, format, tag, folder, progress, pos, mode, marks, zoom, done }) => ({ id, title, name, size, format, tag, folder, progress, pos, mode, marks, zoom, done })) };
}
// Copia espejo fuera de la base del WebView: si esta se borrara, los subrayados y carpetas se recuperan.
async function writeMirror() {
  if (!S.books.length) return;
  try { await Filesystem.writeFile({ path: 'backup/lumen.json', data: JSON.stringify(await backupData()), directory: Directory.Data, encoding: Encoding.UTF8, recursive: true }); } catch (e) { console.warn('espejo', e); }
}
async function readMirror() {
  try { return JSON.parse((await Filesystem.readFile({ path: 'backup/lumen.json', directory: Directory.Data, encoding: Encoding.UTF8 })).data); } catch { return null; }
}
async function applyMirror(book) {
  const m = S.mirror;
  const mb = m?.books.find((x) => x.name === book.name && x.size === book.size);
  if (!mb) return 0;
  if (mb.folder && S.folders.some((f) => f.id === mb.folder)) book.folder = mb.folder;
  book.tag = mb.tag || book.tag; book.title = mb.title || book.title; book.pos = mb.pos || null; book.progress = mb.progress || 0; book.mode = mb.mode;
  book.marks = mb.marks || []; book.zoom = mb.zoom; book.done = mb.done;
  if (mb.pos) book.lastRead = 1;
  let n = 0;
  for (const x of m.hl) if (x.bookId === mb.id) { await DB.putHl({ ...x, bookId: book.id }); n++; }
  let nf = 0;
  for (const c of m.fey || []) if (c.bookId === mb.id && !S.fey.some((x) => x.id === c.id)) { S.fey.push({ ...c, bookId: book.id }); nf++; }
  if (nf) await saveFey();
  return n;
}

// ---------- pantalla completa / concentración ----------
async function setFocus(on) {
  on = !!on && S.screen === 'reader';
  if (on === !!S.focusMode) return;
  S.focusMode = on;
  document.body.classList.toggle('focus', on);
  renderFocusDocs();
  if (on) { closePanel(); hideBar(); }
  try {
    if (native) await (on ? SystemBars.hide() : SystemBars.show());
    else if (on) await document.documentElement.requestFullscreen?.();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch { /* el navegador no permite pantalla completa */ }
  if (on) toast('Modo concentración · toca ⤡ arriba a la derecha para salir', { ms: 3500 });
  requestAnimationFrame(() => S.views.forEach((v) => v.relayout?.()));
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.focusMode && !native) setFocus(false); });

// ---------- zoom con los dedos / Ctrl+rueda ----------
let hudT;
function hud(text) {
  const e = $('#zoomHud');
  e.textContent = text;
  e.classList.add('show');
  clearTimeout(hudT);
  hudT = setTimeout(() => e.classList.remove('show'), 800);
}
function attachPinch(view) {
  const el = view.el;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  let st = null;
  const rel = (x, y) => { const r = el.getBoundingClientRect(); return [x - r.left, y - r.top]; };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const [cx, cy] = rel((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
    st = { d0: dist(e.touches), cx, cy, s: 1, base: view.zoomValue() };
    view.pinchStart(st);
    getSelection().removeAllRanges();
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!st || e.touches.length !== 2) return;
    st.s = dist(e.touches) / st.d0;
    view.pinchMove(st);
  }, { passive: true });
  const end = () => { if (st) { const s = st; st = null; view.pinchEnd(s); S.lastPinch = Date.now(); } };
  el.addEventListener('touchend', (e) => { if (st && e.touches.length < 2) end(); });
  el.addEventListener('touchcancel', end);
  // Laptop: Ctrl + rueda o pellizco en el trackpad.
  let wz = null;
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!wz) { const [cx, cy] = rel(e.clientX, e.clientY); wz = { cx, cy, s: 1, base: view.zoomValue() }; view.pinchStart(wz); }
    wz.s *= Math.abs(e.deltaY) >= 50 ? (e.deltaY < 0 ? 1.15 : 1 / 1.15) : Math.exp(-e.deltaY * 0.01);
    view.pinchMove(wz);
    clearTimeout(wz.t);
    wz.t = setTimeout(() => { const s = wz; wz = null; view.pinchEnd(s); }, 220);
  }, { passive: false });
}

// El dock se esconde al avanzar en el texto y reaparece al retroceder o al tocar el centro de la pantalla.
function setDock(away) {
  const bar = $('#bar');
  if (!bar) return;
  bar.classList.toggle('away', !!away);
  if (away) { $('#morePop').hidden = true; $('#moreBtn').setAttribute('aria-expanded', 'false'); }
}
const dockLastY = new WeakMap();
function dockOnScroll(e) {
  const el = e.target;
  if (!el.classList?.contains('view') || S.panel || S.focusMode) return;
  const y = el.scrollTop;
  const prev = dockLastY.get(el);
  if (prev === undefined) { dockLastY.set(el, y); return; }
  const d = y - prev;
  if (Math.abs(d) < 10) return;
  dockLastY.set(el, y);
  setDock(d > 0 && y > 80);
}

// Ocultar o mostrar la barra inferior (progreso y herramientas) para leer sin distracciones.
function setBarHidden(hide) {
  saveSettings({ barHidden: !!hide });
  document.body.classList.toggle('nobar', settings.barHidden);
  $('#barShow').hidden = !(settings.barHidden && S.screen === 'reader');
  if (settings.barHidden && S.panel) closePanel();
  if (settings.barHidden) toast('Barra oculta · toca la flecha abajo a la derecha o pulsa B para mostrarla', { ms: 3500 });
  requestAnimationFrame(() => S.views.forEach((v) => v.relayout?.()));
  if (S.panel === 'cfg') renderPanel();
}

// Primera vez: qué hace Lumen, en cuatro líneas.
function showWelcome() {
  modal((box, close) => {
    const row = (icon, t, d) => h('div', {}, h('span', { html: icon }), h('p', { style: 'margin:0' }, h('b', {}, t), h('span', {}, d)));
    box.append(h('div', { class: 'eyebrow', style: 'margin-bottom:10px' }, 'Bienvenido a Lumen'),
      h('h3', {}, 'Tu lugar para leer y estudiar'),
      h('div', { class: 'welcome-list' },
        row(I.marker, 'Subrayado que no se mueve', 'Queda pegado a las letras, aunque cambies el tamaño o el zoom.'),
        row(I.folder, 'Una carpeta por ramo', 'Sube varios PDF, Word o EPUB a la vez y ordénalos como quieras.'),
        row(I.bulb, 'Pomodoro y método Feynman', 'Bloques de enfoque y una pausa para explicar con tus palabras lo aprendido.'),
        row(I.offline, 'Funciona sin conexión', 'Tus documentos y marcas se guardan en este dispositivo.')),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(true) }, 'Empezar')));
  }).then(() => saveSettings({ welcomed: true }));
}

// Documentos abiertos dentro del modo pantalla completa.
function renderFocusDocs() {
  const n = S.tabs.filter(bookById).length;
  const btn = $('#focusDocs');
  if (!btn) return;
  btn.hidden = !(S.focusMode && n > 1);
  $('#fdCount').textContent = n;
  if (btn.hidden) $('#focusList').hidden = true;
  else if (!$('#focusList').hidden) fillFocusList();
}
function fillFocusList() {
  const cur = S.panes[S.focus];
  $('#focusList').replaceChildren(...S.tabs.map((id) => {
    const b = bookById(id);
    if (!b) return null;
    return h('div', { class: 'fl' + (id === cur ? ' on' : '') },
      h('button', { class: 'fl-t', onclick: () => { $('#focusList').hidden = true; openBook(id); } },
        h('i', { class: 'dot', style: `background:var(--c-${b.tag})` }), h('span', {}, b.title), h('small', {}, `${Math.round((b.progress || 0) * 100)} %`)),
      h('button', { class: 'fl-x', 'aria-label': 'Cerrar documento', onclick: (e) => { e.stopPropagation(); closeTab(id); } }, '×'));
  }));
}
function toggleFocusList() {
  const l = $('#focusList');
  l.hidden = !l.hidden;
  if (!l.hidden) fillFocusList();
}
function switchTab(dir) {
  const ids = S.tabs.filter(bookById);
  if (ids.length < 2) return;
  const i = Math.max(ids.indexOf(S.panes[S.focus]), 0);
  openBook(ids[(i + dir + ids.length) % ids.length]);
}

// Zoom por pasos (botones y teclado), útil sobre todo en pantalla completa.
function stepZoom(dir, reset) {
  const v = activeView();
  if (!v) return;
  const r = v.el.getBoundingClientRect();
  const st = { cx: r.width / 2, cy: r.height / 2, s: 1, base: v.zoomValue() };
  if (reset) st.s = v.kind === 'pdf' ? 1 / st.base : 19 / st.base;
  else st.s = v.kind === 'pdf' ? (dir > 0 ? 1.2 : 1 / 1.2) : (st.base + 2 * dir) / st.base;
  v.pinchStart(st);
  v.pinchMove(st);
  v.pinchEnd(st);
}

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
async function deleteWithUndo(bookId, recs, view) {
  for (const r of recs) await removeHlRec(bookId, r, view);
  renderBar();
  if (S.panel === 'hl') renderPanel();
  if (S.screen !== 'reader' && S.libTab === 'hls') renderAllHl();
  toast(recs.length > 1 ? `${recs.length} subrayados borrados` : 'Subrayado borrado', { ms: 7000, action: { label: 'Deshacer', fn: async () => {
    for (const r of recs) { hlList(bookId).push(r); await DB.putHl(r); view?.addHl(r); }
    renderBar();
    if (S.panel === 'hl') renderPanel();
    if (S.screen !== 'reader' && S.libTab === 'hls') renderAllHl();
  } } });
}
const overlapping = (bookId, anchors) => hlList(bookId).filter((o) => anchors.some((a) => a.sec === o.sec && o.s < a.e && o.e > a.s));
function findHl(id) {
  for (const [bookId, l] of S.hl) { const r = l.find((x) => x.id === id); if (r) return { rec: r, bookId }; }
  return null;
}

// ---------- barra flotante de selección ----------
let selT, hideT;
function showBar(rect, mode, cur, canErase) {
  const bar = $('#selbar');
  bar.innerHTML = HL_COLORS.map((c, i) => `<button class="c${i === cur ? ' cur' : ''}" data-c="${i}" style="background:${c}" aria-label="${HL_NAMES[i]}"></button>`).join('')
    + `<span class="sep"></span><button class="a" data-a="note">${I.note}Nota</button><button class="a" data-a="copy" aria-label="Copiar">${I.copy}</button>`
    + (mode === 'edit' ? `<button class="a" data-a="del" aria-label="Quitar subrayado">${I.trash}Borrar</button>` : '')
    + (mode === 'new' && canErase ? `<button class="a" data-a="erase" aria-label="Borrar subrayados de la selección">${I.trash}Borrar</button>` : '');
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
  const hits = overlapping(v.book.id, anchors);
  S.pending = { kind: 'new', view: v, anchors, hits };
  if (settings.auto && !hits.length) { createHl(settings.color); return; }
  showBar(range.getBoundingClientRect(), 'new', settings.color, hits.length > 0);
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
    await deleteWithUndo(f.bookId, [f.rec], activeOrAny(f.bookId));
  } else if (b.dataset.a === 'erase') {
    const hits = p.hits || [];
    const view = p.view;
    getSelection().removeAllRanges();
    hideBar();
    if (hits.length) await deleteWithUndo(view.book.id, hits, view);
  }
}
const activeOrAny = (bookId) => S.views.get(bookId);

// ---------- biblioteca ----------
function coverHtml(b, withMore) {
  const col = PALETTE[hash(b.title) % PALETTE.length];
  const inner = b.cover ? `<img src="${b.cover}" alt="">` : `<div class="t" style="background:${col}">${esc(b.title)}</div>`;
  const pr = Math.round((b.progress || 0) * 100);
  return `<div class="cover">${inner}<i class="tg" style="background:var(--c-${b.tag})"></i><span class="fmt">${FMT[b.format]}</span>${pr > 1 ? `<i class="cprog"><b style="width:${pr}%"></b></i>` : ''}</div>`
    + (withMore ? `<span class="more" data-more="${b.id}" role="button" aria-label="Opciones">⋯</span>` : '');
}
// Colores de las carpetas (ramos)
const FCOL = ['#F0A24B', '#E5707E', '#8B7CF0', '#4FB3BF', '#5CB88A', '#D977C5', '#6FA0F5', '#B4A58A'];
const folderColor = (f) => f.color || FCOL[Math.max(S.folders.indexOf(f), 0) % FCOL.length];
const booksIn = (id) => S.books.filter((b) => (id === 'none' ? !b.folder : b.folder === id));
const avgProg = (books) => (books.length ? Math.round(books.reduce((a, b) => a + (b.progress || 0), 0) / books.length * 100) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function ago(ts) {
  if (!ts || ts < 10) return '';
  const d = Math.floor((Date.now() - ts) / 864e5);
  return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : d < 30 ? `hace ${d} días` : fmtDay(ts);
}
const pageHead = (title, sub) => h('div', { class: 'page-head' }, h('h2', {}, title), sub ? h('div', { class: 'sub' }, sub) : null);
const EMPTY_SVG = '<svg viewBox="0 0 160 120" width="150" height="112" aria-hidden="true"><path d="M20 52V30a8 8 0 0 1 8-8h32l10 12h62a8 8 0 0 1 8 8v60a8 8 0 0 1-8 8H28a8 8 0 0 1-8-8z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" opacity=".55"/><path d="M80 62v32M64 78h32" stroke="var(--acc)" stroke-width="5" stroke-linecap="round"/></svg>';
const emptyState = (title, text, cta, fn) => h('div', { class: 'empty2', style: 'grid-column:1/-1' }, h('div', { html: EMPTY_SVG }), h('b', {}, title), h('p', {}, text), cta ? h('button', { class: 'btn', onclick: fn }, cta) : null);

// Carpetas: crear / editar con nombre y color
function folderEdit(f) {
  return modal((box, close) => {
    let color = f ? folderColor(f) : FCOL[S.folders.length % FCOL.length];
    const inp = h('input', { placeholder: 'Ej.: Derecho Civil', maxlength: 40 });
    inp.value = f?.name || '';
    const sw = h('div', { class: 'swatches' });
    const paint = () => sw.replaceChildren(...FCOL.map((c) => h('button', { class: 'sw' + (c === color ? ' on' : ''), style: `background:${c}`, 'aria-label': 'Color de la carpeta', onclick: () => { color = c; paint(); } })));
    paint();
    const ok = () => { if (inp.value.trim()) close({ name: inp.value.trim().slice(0, 40), color }); else inp.focus(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    box.append(h('h3', {}, f ? 'Editar carpeta' : 'Nueva carpeta'), inp, h('div', { class: 'lbl' }, 'Color'), sw,
      h('div', { class: 'acts' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancelar'), h('button', { class: 'btn', onclick: ok }, 'Guardar')));
    setTimeout(() => inp.focus(), 80);
  });
}
async function folderMenu(f) {
  const act = await choose(f.name, [{ label: 'Editar nombre y color', value: 'edit' }, { label: 'Eliminar carpeta', sub: 'Los documentos no se borran: quedan sin carpeta', value: 'del', danger: true }]);
  if (act === 'edit') renameFolder(f); else if (act === 'del') deleteFolder(f);
}

function renderSide() {
  const side = $('#libSide');
  const due = S.fey.filter((c) => c.due <= Date.now()).length;
  const onBooks = S.libTab === 'books';
  const toBooks = (folder) => { S.libTab = 'books'; S.lib.folder = folder; S.lib.q = ''; $('#q').value = ''; renderLibrary(); $('#libMain').scrollTop = 0; };
  const item = (icon, label, on, fn, badge) => h('button', { class: 'side-i' + (on ? ' on' : ''), onclick: fn },
    h('span', { class: 'si-ic', html: icon }), h('span', { class: 'si-t' }, label), badge ? h('span', { class: 'si-b' }, String(badge)) : null);
  const fol = (id, name, color, n) => h('button', { class: 'side-f' + (onBooks && S.lib.folder === id && !S.lib.q ? ' on' : ''), 'data-folder': id, onclick: () => toBooks(id) },
    h('i', { class: 'dot', style: `background:${color}` }), h('span', { class: 'si-t' }, name), h('span', { class: 'si-n' }, String(n)));
  const un = booksIn('none').length;
  side.replaceChildren(
    h('div', { class: 'side-brand' }, h('span', { html: LOGO, style: 'display:grid' }), 'Lumen'),
    item(I.book, 'Biblioteca', onBooks && S.lib.folder === 'all' && !S.lib.q, () => toBooks('all'), S.books.length || ''),
    item(I.marker, 'Subrayados', S.libTab === 'hls', () => { S.libTab = 'hls'; renderLibrary(); $('#libMain').scrollTop = 0; }),
    item(I.bulb, 'Feynman', S.libTab === 'fey', () => { S.libTab = 'fey'; renderLibrary(); $('#libMain').scrollTop = 0; }, due || ''),
    h('div', { class: 'side-sec' }, 'Ramos'),
    ...S.folders.map((f) => fol(f.id, f.name, folderColor(f), booksIn(f.id).length)),
    un && S.folders.length ? fol('none', 'Sin carpeta', 'var(--mut)', un) : null,
    h('button', { class: 'side-add', onclick: () => newFolder(true) }, '+ Nueva carpeta'));
}

function renderFolderGrid() {
  const grid = $('#grid');
  const card = (id, name, books, color) => {
    const covers = books.filter((b) => b.cover).slice(0, 3);
    const last = Math.max(0, ...books.map((b) => b.lastRead || 0));
    return h('button', { class: 'fold', 'data-folder': id, style: `--fc:${color}`, html:
      `<div class="fshape"><i class="ftab"></i><div class="fcov">${covers.map((c) => `<img src="${c.cover}" alt="">`).join('')}${covers.length ? '' : `<span class="fempty">${books.length ? 'Sin portada' : 'Vacía'}</span>`}</div></div>
       <div class="fmeta"><div class="fn">${esc(name)}</div><div class="pc">${plural(books.length, 'documento', 'documentos')}${ago(last) ? ' · ' + ago(last) : ''}</div><div class="bar mini"><i style="width:${avgProg(books)}%"></i></div></div>` });
  };
  const cards = S.folders.map((f) => card(f.id, f.name, booksIn(f.id), folderColor(f)));
  const un = booksIn('none');
  if (un.length) cards.push(card('none', 'Sin carpeta', un, 'var(--mut)'));
  if (!S.folders.length && !S.books.length) {
    grid.replaceChildren(emptyState('Crea tu primera carpeta', 'Una por cada ramo. Luego añade tus PDF, Word o EPUB, varios a la vez. En laptop puedes arrastrar archivos o una carpeta entera a esta ventana.', 'Nueva carpeta', () => newFolder(true)));
    return;
  }
  cards.push(h('button', { class: 'fold add', onclick: () => newFolder(true), html: '<div class="fshape"><i class="ftab"></i><div class="plus">+</div></div><div class="fmeta"><div class="fn">Nueva carpeta</div><div class="pc">Un ramo, un curso…</div></div>' }));
  grid.replaceChildren(...cards);
}

const SORTS = {
  recent: (a, b) => (b.lastRead || b.added) - (a.lastRead || a.added),
  title: (a, b) => a.title.localeCompare(b.title, 'es'),
  progress: (a, b) => (b.progress || 0) - (a.progress || 0),
  added: (a, b) => b.added - a.added,
};
const dragAttr = () => (matchMedia('(pointer: fine)').matches ? 'true' : 'false');
function docCard(b) {
  const f = S.folders.find((x) => x.id === b.folder);
  const pr = Math.round((b.progress || 0) * 100);
  return h('div', { class: 'card' + (S.sel.has(b.id) ? ' sel' : ''), draggable: dragAttr(), 'data-id': b.id, html:
    `<button class="cardbtn" data-open="${b.id}">${coverHtml(b)}<div class="nm">${esc(b.title)}</div>
     <div class="pc">${b.done ? '✓ Terminado' : b.lastRead > 1 ? pr + ' %' : 'Nuevo'} · ${esc(f?.name || TAGS[b.tag])}</div></button>
     <span class="more" data-more="${b.id}" role="button" aria-label="Opciones">⋯</span><i class="ck" aria-hidden="true">✓</i>` });
}
function docRow(b) {
  const pr = Math.round((b.progress || 0) * 100);
  const meta = [FMT[b.format], b.pages ? plural(b.pages, 'pág.', 'págs.') : '', TAGS[b.tag], ago(b.lastRead)].filter(Boolean).join(' · ');
  return h('div', { class: 'card row' + (S.sel.has(b.id) ? ' sel' : ''), draggable: dragAttr(), 'data-id': b.id, html:
    `<button class="rowbtn" data-open="${b.id}"><span class="rthumb">${coverHtml(b)}</span><span class="rbody"><span class="rtt">${esc(b.title)}</span><span class="rm">${esc(meta)}</span><span class="bar"><i style="width:${pr}%"></i></span></span><span class="rp">${b.done ? '✓' : b.lastRead > 1 ? pr + ' %' : 'Nuevo'}</span></button>
     <span class="more" data-more="${b.id}" role="button" aria-label="Opciones">⋯</span><i class="ck" aria-hidden="true">✓</i>` });
}

// Panel de inicio: continuar leyendo + resumen del día
function renderDash() {
  const last = [...S.books].filter((b) => b.lastRead > 1).sort((a, b) => b.lastRead - a.lastRead)[0];
  const cont = $('#cont');
  cont.replaceChildren();
  if (last) {
    const f = S.folders.find((x) => x.id === last.folder);
    const pr = Math.round((last.progress || 0) * 100);
    const n = (S.hl.get(last.id) || []).length;
    cont.append(h('button', { class: 'cont2', onclick: () => openBook(last.id), html:
      `<div class="cover">${last.cover ? `<img src="${last.cover}" alt="">` : `<div class="t" style="background:${PALETTE[hash(last.title) % PALETTE.length]}">${esc(last.title)}</div>`}</div>
       <div class="c2-body"><div class="eyebrow">Continuar leyendo</div><h3>${esc(last.title)}</h3>
       <div class="sub">${esc([f?.name || TAGS[last.tag], FMT[last.format], n ? plural(n, 'subrayado', 'subrayados') : '', ago(last.lastRead)].filter(Boolean).join(' · '))}</div>
       <div class="c2-prog"><div class="bar"><i style="width:${pr}%"></i></div><span>${pr} %</span></div></div><span class="c2-go">Retomar ›</span>` }));
  }
  renderStats();
}

function renderLibrary() {
  const hr = new Date().getHours();
  $('#hello').textContent = hr < 6 ? 'Buenas noches' : hr < 12 ? 'Buenos días' : hr < 20 ? 'Buenas tardes' : 'Buenas noches';
  $('#libBooks').hidden = S.libTab !== 'books';
  $('#hlAll').hidden = S.libTab !== 'hls';
  $('#feyAll').hidden = S.libTab !== 'fey';
  document.querySelectorAll('#libnav button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.libTab));
  $('#libnav [data-t="fey"]').dataset.badge = S.fey.some((c) => c.due <= Date.now()) ? '1' : '';
  $('#pageTitle').textContent = S.libTab === 'hls' ? 'Subrayados' : S.libTab === 'fey' ? 'Feynman' : innerWidth >= 900 ? 'Biblioteca' : 'Lumen';
  $('#hello').hidden = !(S.libTab === 'books' && S.lib.folder === 'all' && !S.lib.q);
  renderSide();
  if (S.libTab === 'hls') return renderAllHl();
  if (S.libTab === 'fey') return renderFeyAll();
  const { tag, fmt, q, folder } = S.lib;
  const root = folder === 'all' && !q;
  if (root && S.selMode) { S.selMode = false; S.sel.clear(); updateSelBar(); }
  $('#dash').hidden = !(root && S.books.length);
  if (root) renderDash(); else { $('#cont').replaceChildren(); $('#stats').replaceChildren(); }
  const head = $('#folderHead'), tb = $('#toolbar'), grid = $('#grid');
  grid.classList.toggle('fgrid', root);
  grid.classList.toggle('lgrid', !root && settings.view === 'list');
  if (root) {
    const nf = S.folders.length;
    head.replaceChildren(h('div', { class: 'sec-h' }, h('h2', {}, 'Mis ramos'), h('span', { class: 'sub' }, nf ? `${plural(nf, 'carpeta', 'carpetas')} · ${plural(S.books.length, 'documento', 'documentos')}` : '')));
    tb.replaceChildren();
    renderFolderGrid();
    return;
  }
  const cur = S.folders.find((f) => f.id === folder);
  const scope = q ? S.books : booksIn(folder);
  const toRoot = () => { S.lib.folder = 'all'; S.lib.q = ''; $('#q').value = ''; renderLibrary(); $('#libMain').scrollTop = 0; };
  head.replaceChildren(h('div', { class: 'fv-head' },
    h('button', { class: 'back', onclick: toRoot, html: `${I.chevronL}<span>Biblioteca</span>` }),
    h('div', { class: 'fv-title' }, q ? null : h('i', { class: 'dot', style: `background:${cur ? folderColor(cur) : 'var(--mut)'}` }), h('h2', {}, q ? `Resultados para “${q}”` : cur ? cur.name : 'Sin carpeta')),
    h('div', { class: 'sub fv-sub' }, q ? '' : `${plural(scope.length, 'documento', 'documentos')} · ${avgProg(scope)} % de avance promedio`),
    cur && !q ? h('button', { class: 'ib', 'aria-label': 'Opciones de la carpeta', html: I.more, onclick: () => folderMenu(cur) }) : null));
  const seg = h('div', { class: 'seg2', role: 'tablist' }, ...[['all', 'Todos'], ['estudio', 'Estudio'], ['lectura', 'Lectura']].map(([k, l]) => h('button', { class: tag === k ? 'on' : '', onclick: () => { S.lib.tag = k; renderLibrary(); } }, l)));
  const sel = (label, opts, val, fn) => { const x = h('select', { 'aria-label': label, onchange: (e) => fn(e.target.value) }, ...opts.map(([k, l]) => h('option', { value: k }, l))); x.value = val; return x; };
  const fmtSel = sel('Formato', [['all', 'Todos los formatos'], ['pdf', 'PDF'], ['docx', 'Word'], ['epub', 'EPUB'], ['txt', 'Texto']], fmt, (v) => { S.lib.fmt = v; renderLibrary(); });
  const sortSel = sel('Ordenar', [['recent', 'Recientes'], ['title', 'Título A–Z'], ['progress', 'Más avanzados'], ['added', 'Añadidos']], settings.sort, (v) => { saveSettings({ sort: v }); renderLibrary(); });
  const vt = h('div', { class: 'vt' },
    h('button', { class: settings.view !== 'list' ? 'on' : '', 'aria-label': 'Ver en cuadrícula', html: I.grid, onclick: () => { saveSettings({ view: 'grid' }); renderLibrary(); } }),
    h('button', { class: settings.view === 'list' ? 'on' : '', 'aria-label': 'Ver en lista', html: I.rows, onclick: () => { saveSettings({ view: 'list' }); renderLibrary(); } }));
  const selBtn = h('button', { class: 'chip' + (S.selMode ? ' on' : ''), onclick: toggleSelMode }, S.selMode ? '✓ Seleccionando' : 'Seleccionar');
  tb.replaceChildren(h('div', { class: 'tb' }, seg, h('div', { class: 'tb-r' }, fmtSel, sortSel, vt, selBtn)));
  const fq = q.toLowerCase();
  const list = S.books.filter((b) => (folder === 'all' || (folder === 'none' ? !b.folder : b.folder === folder)) && (tag === 'all' || b.tag === tag) && (fmt === 'all' || b.format === fmt)
    && (!fq || (b.title + ' ' + b.author).toLowerCase().includes(fq)))
    .sort(SORTS[settings.sort] || SORTS.recent);
  if (!list.length) {
    grid.replaceChildren(scope.length ? emptyState('Nada con esos filtros', 'Prueba con otro tipo, formato o búsqueda.', 'Quitar filtros', () => { S.lib.tag = 'all'; S.lib.fmt = 'all'; renderLibrary(); })
      : q ? emptyState('Sin resultados', 'No hay documentos con ese nombre.', null)
      : emptyState('Esta carpeta está vacía', 'Añade documentos aquí: puedes elegir varios a la vez o arrastrarlos desde tu computador.', 'Añadir documentos', () => $('#fab').click()));
    return;
  }
  grid.replaceChildren(...list.map((b) => (settings.view === 'list' ? docRow(b) : docCard(b))));
}
async function renderAllHl() {
  const all = await DB.allHl();
  const box = $('#hlAll');
  if (!all.length) { box.innerHTML = '<div class="empty"><b>Aún no hay subrayados</b>Abre un libro, selecciona texto y elige un color.</div>'; return; }
  box.replaceChildren(pageHead('Subrayados', plural(all.length, 'subrayado guardado', 'subrayados guardados')));
  const byBook = new Map();
  all.forEach((x) => { if (!byBook.has(x.bookId)) byBook.set(x.bookId, []); byBook.get(x.bookId).push(x); });
  for (const [bid, list] of byBook) {
    const b = bookById(bid);
    if (!b) continue;
    box.append(h('div', { class: 'grp' }, h('span', {}, b.title), h('button', { class: 'chip', onclick: () => review(b, list) }, 'Repasar')));
    list.sort((a, c) => a.sec - c.sec || a.s - c.s).forEach((x) => box.append(hlItem(x, b, () => openAt(bid, x))));
  }
}

async function openAt(bookId, rec) {
  await openBook(bookId);
  const v = S.views.get(bookId);
  setTimeout(() => v?.gotoHl(rec), 350);
}

// ---------- importar ----------
async function onFiles(files, presetFolder) {
  const ok = [...files].filter((f) => FORMATS[ext(f.name)]);
  if (!ok.length) { toast('Formatos admitidos: PDF, Word (.docx), EPUB y texto'); return; }
  if (!ok.some((f) => !S.books.some((b) => b.name === f.name && b.size === f.size))) {
    const d = S.books.find((b) => b.name === ok[0].name && b.size === ok[0].size);
    toast('Ya estaba en tu biblioteca');
    openBook(d.id);
    return;
  }
  let inFolder = presetFolder === '__none' ? null : presetFolder || (S.folders.some((f) => f.id === S.lib.folder) ? S.lib.folder : null);
  if (!presetFolder && !inFolder && S.lib.folder === 'all' && S.folders.length) {
    const t = await choose(ok.length > 1 ? `¿En qué carpeta van estos ${ok.length} documentos?` : '¿En qué carpeta va este documento?',
      [...S.folders.map((f) => ({ label: f.name, value: f.id })), { label: 'Nueva carpeta…', value: '__new' }, { label: 'Sin carpeta', value: '__none' }]);
    if (!t) return;
    if (t === '__new') { const f = await newFolder(false); if (!f) return; inFolder = f.id; } else if (t !== '__none') inFolder = t;
  }
  let tag = S.lib.tag !== 'all' ? S.lib.tag : inFolder ? 'estudio' : null;
  if (!tag) {
    tag = await choose(ok.length > 1 ? `¿Dónde van estos ${ok.length} documentos?` : '¿Dónde va este documento?', [
      { label: 'Estudio', sub: 'Apuntes, guías, material para aprender', value: 'estudio' },
      { label: 'Lectura', sub: 'Libros para leer con calma', value: 'lectura' }]);
    if (!tag) return;
  }
  DB.persist();
  let last = null, added = 0, dup = 0, failed = 0;
  for (let i = 0; i < ok.length; i++) {
    toast(ok.length > 1 ? `Añadiendo ${i + 1} de ${ok.length} · ${ok[i].name}` : `Añadiendo ${ok[i].name}…`, { sticky: true });
    const r = await addFile(ok[i], tag, inFolder);
    if (r === 'dupe') dup++; else if (r) { added++; last = r; } else failed++;
    if (ok.length > 1 && i % 3 === 2) renderLibrary();
  }
  const parts = [`${added} ${added === 1 ? 'documento añadido' : 'documentos añadidos'}`];
  if (dup) parts.push(`${dup} ya estaban`);
  if (failed) parts.push(`${failed} con error`);
  toast(parts.join(' · '), { ms: 5000 });
  S.libTab = 'books';
  renderLibrary();
  if (ok.length === 1 && last) openBook(last.id);
}
// Carpeta entera del computador: se crea (o reutiliza) un ramo con su nombre y se suben todos sus documentos.
async function onDir(files) {
  const list = [...files].filter((f) => FORMATS[ext(f.name)]);
  if (!list.length) { toast('Esa carpeta no tiene PDF, Word, EPUB ni texto'); return; }
  const name = (list[0].webkitRelativePath || '').split('/')[0] || 'Carpeta nueva';
  let f = S.folders.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!f) { f = { id: DB.uid(), name: name.slice(0, 40) }; S.folders.push(f); await saveFolders(); }
  S.lib.folder = 'all';
  await onFiles(list, f.id);
  S.lib.folder = f.id;
  renderLibrary();
}

async function addFile(file, tag, folder = null) {
  const format = FORMATS[ext(file.name)];
  const dupe = S.books.find((b) => b.name === file.name && b.size === file.size);
  if (dupe) return 'dupe';
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
    const rec = await applyMirror(book);
    if (rec) toast(`Recuperé ${rec} subrayados de este documento`);
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
      attachPinch(view);
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
  if (S.tts && (S.screen !== 'reader' || !S.panes.includes(S.tts.view.book.id))) stopTts();
  if (S.screen !== 'reader') setFocus(false);
  if (innerWidth < 1100 && S.split) { S.split = false; S.panes = S.panes.slice(0, 1); S.focus = 0; }
  const reader = S.screen === 'reader';
  $('#library').hidden = reader;
  $('#viewer').hidden = !reader;
  $('#fab').hidden = reader;
  $('#libnav').hidden = reader;
  $('#bar').hidden = !reader;
  $('#barShow').hidden = !(reader && settings.barHidden);
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
  setFocus(false);
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
  renderFocusDocs();
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
  lastAct = Date.now();
  if (view._st) return;
  // El trabajo de seguimiento (posición, progreso, barra) se hace como máximo ~7 veces por segundo, no en cada cuadro del scroll.
  view._st = setTimeout(() => { view._st = 0; scrollWork(view); }, 140);
}
function scrollWork(view) {
  const book = view.book;
  book.pos = { ...view.getPos(), m: viewMode(view) };
  book.progress = view.kind === 'pdf' || view.paged ? view.ratio_ !== undefined ? view.ratio() : view.page() / Math.max(view.secs.length - 1, 1) : view.ratio();
  book.lastRead = Date.now();
  lastAct = Date.now();
  track(view);
  if (book.progress >= 0.985 && !book.done) { book.done = true; toast(`¡Terminaste “${book.title}”!`, { ms: 4000 }); }
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
  seek.style.setProperty('--pos', (seek.value / 10) + '%');
  $('#plabel').textContent = v.label();
  $('#moreBtn').classList.toggle('on', !!S.timer || !!S.tts || settings.auto);
  const n = hlList(v.book.id).length;
  $('#hlN').parentElement.dataset.n = n || '';
  $('#markBtn').classList.toggle('on', settings.auto);
  $('#bmBtn').classList.toggle('on', !!currentMark(v));
}

// ---------- paneles laterales / hojas ----------
function openPanel(name) {
  if (S.panel === name) return closePanel();
  setDock(false);
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
    const marks = (v?.book.marks || []).slice().sort((a, b) => (a.pos.page ?? a.pos.ratio ?? 0) - (b.pos.page ?? b.pos.ratio ?? 0));
    const kids = [h('div', { class: 'ph' }, h('h2', {}, 'Contenido'))];
    if (v?.paged) {
      const n = v.pgs?.length || v.secs.length;
      const inp = h('input', { class: 'sbox', type: 'number', min: 1, max: n, inputmode: 'numeric', placeholder: `Ir a la página (1–${n})`, 'aria-label': 'Número de página' });
      const go = () => { const p = Math.min(Math.max(parseInt(inp.value, 10) || 0, 1), n); if (inp.value) { v.gotoPage(p - 1); setTimeout(renderBar, 60); if (!wide()) closePanel(); } };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      kids.push(h('div', { class: 'goto' }, inp, h('button', { class: 'btn', onclick: go }, 'Ir')));
    }
    kids.push(h('div', { class: 'lbl' }, `Marcadores${marks.length ? ' · ' + marks.length : ''}`));
    if (marks.length) marks.forEach((m) => kids.push(h('div', { class: 'mk' },
      h('button', { class: 'li', onclick: () => { gotoMark(v, m); setTimeout(renderBar, 60); if (!wide()) closePanel(); } }, m.label, m.snippet ? h('small', {}, m.snippet) : null),
      h('button', { class: 'ib', 'aria-label': 'Quitar marcador', html: I.trash, onclick: async () => { v.book.marks = v.book.marks.filter((x) => x !== m); await DB.putBook(v.book); renderPanel(); renderBar(); } }))));
    else kids.push(h('div', { class: 'sub' }, 'Toca el ícono de marcador junto a la barra de progreso para guardar la página.'));
    kids.push(h('div', { class: 'lbl' }, 'Índice'));
    if (toc.length) toc.forEach((it) => kids.push(h('button', { class: 'li', style: `padding-left:${it.depth * 16}px`, onclick: () => { v.gotoToc(it); if (!wide()) closePanel(); } }, it.title)));
    else kids.push(h('div', { class: 'sub' }, 'Este documento no trae índice. Usa “Ir a la página”, la barra de progreso o la búsqueda.'));
    box.replaceChildren(...kids);
  } else if (name === 'hl') {
    if (!v) return;
    const all = hlList(v.book.id).slice().sort((a, b) => a.sec - b.sec || a.s - b.s);
    const list = S.hlFilter === null ? all : all.filter((x) => x.color === S.hlFilter);
    const chips = h('div', { class: 'chips' }, h('button', { class: 'chip' + (S.hlFilter === null ? ' on' : ''), onclick: () => { S.hlFilter = null; renderPanel(); } }, 'Todos'),
      ...HL_COLORS.map((c, i) => h('button', { class: 'chip' + (S.hlFilter === i ? ' on' : ''), onclick: () => { S.hlFilter = i; renderPanel(); } }, h('i', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:6px` }), HL_NAMES[i])));
    box.replaceChildren(
      h('div', { class: 'ph' }, h('h2', {}, `Subrayados · ${all.length}`),
        h('div', { style: 'display:flex;gap:8px' },
          all.length ? h('button', { class: 'btn', onclick: () => review(v.book, all) }, 'Repasar') : null,
          all.length ? h('button', { class: 'btn ghost', onclick: async () => {
            const ok = await choose(`¿Borrar los ${all.length} subrayados de este documento?`, [{ label: 'Sí, borrar todos', sub: 'Podrás deshacerlo justo después', value: true, danger: true }]);
            if (ok) deleteWithUndo(v.book.id, all.slice(), v);
          } }, 'Borrar todo') : null,
          h('button', { class: 'btn ghost', onclick: () => exportHl(v.book) }, 'Exportar'))),
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
      h('button', { 'aria-label': 'Quitar', html: I.trash, onclick: () => deleteWithUndo(book.id, [x], S.views.get(book.id)) })));
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
  const themes = { noche: ['Noche', '#0A0D18', '#EBEDF7'], dia: ['Día', '#F4F6FA', '#0F1B2D'], papel: ['Papel', '#F6F1E7', '#2A2118'], sepia: ['Sepia', '#E9D9B8', '#3B2D16'], oled: ['OLED', '#000', '#D8D2C4'], auto: ['Automático', 'linear-gradient(135deg,#F4F6FA 50%,#0A0D18 50%)', '#6F7694'] };
  const slider = (min, max, step, val, fn) => { const r = h('input', { type: 'range', min, max, step }); r.value = val; r.addEventListener('input', () => fn(+r.value)); return r; };
  const kids = [h('div', { class: 'ph' }, h('h2', {}, 'Ajustes'))];
  kids.push(h('div', { class: 'lbl' }, 'Tema'),
    h('div', { class: 'themes' }, ...Object.entries(themes).map(([k, [l, bg, fg]]) => h('button', { class: 'th' + (settings.theme === k ? ' on' : ''), onclick: () => apply({ theme: k }) },
      h('i', { style: `background:${bg};color:${fg}${k === 'oled' || k === 'noche' ? ';box-shadow:inset 0 0 0 1px rgba(173,186,255,.2)' : ''}` }, 'Aa lectura'), l))));
  kids.push(h('div', { class: 'lbl' }, 'Tamaño de letra', h('b', {}, settings.size + ' px')),
    slider(12, 44, 1, settings.size, (n) => { saveSettings({ size: n }); $('#panelBody .lbl b').textContent = n + ' px'; }));
  kids.push(h('div', { class: 'lbl' }, 'Tipografía'), seg([['serif', 'Newsreader'], ['literata', 'Literata'], ['sans', 'Geist'], ['dislexia', 'Legible']], settings.font, (k) => apply({ font: k })));
  kids.push(h('div', { class: 'lbl' }, 'Interlineado'), slider(1.3, 2.2, 0.05, settings.lh, (n) => saveSettings({ lh: n })));
  kids.push(h('div', { class: 'lbl' }, 'Ancho del texto'), seg([['estrecho', 'Estrecho'], ['medio', 'Medio'], ['ancho', 'Ancho']], settings.width, (k) => apply({ width: k })));
  if (v?.book.format === 'pdf') {
    const mode = v.kind === 'pdf' ? 'page' : 'text';
    kids.push(h('div', { class: 'lbl' }, 'PDF'),
      seg([['page', 'Página original'], ['text', 'Texto cómodo']], mode, (k) => setPdfMode(v.book, k)));
    if (v.kind === 'pdf') {
      const zl = h('b', {}, Math.round((v.book.zoom ?? settings.pdfZoom) * 100) + ' %');
      kids.push(h('div', { class: 'lbl' }, 'Zoom de página', zl),
        slider(0.5, 4, 0.1, v.book.zoom ?? settings.pdfZoom, (n) => { zl.textContent = Math.round(n * 100) + ' %'; clearTimeout(S.zt); S.zt = setTimeout(() => { v.book.zoom = n; DB.putBook(v.book); v.relayout(); }, 250); }));
    }
  }
  const toggle = (on, fn) => h('button', { class: 'toggle' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), onclick: fn });
  kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Marcador automático'), h('div', { class: 'sub' }, 'Al seleccionar texto se subraya solo con el color elegido')),
    toggle(settings.auto, () => apply({ auto: !settings.auto }))));
  kids.push(h('div', { class: 'lbl' }, 'Color del marcador'), h('div', { class: 'seg' }, ...HL_COLORS.map((c, i) =>
    h('button', { class: settings.color === i ? 'on' : '', 'aria-label': HL_NAMES[i], onclick: () => apply({ color: i }) }, h('i', { style: `display:block;height:18px;border-radius:9px;background:${c}` })))));
  kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Mostrar barra inferior'), h('div', { class: 'sub' }, 'Progreso y herramientas. También con el botón ⌄ de la barra o la tecla B')),
    toggle(!settings.barHidden, () => setBarHidden(!settings.barHidden))));
  kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Pomodoro y Feynman'), h('div', { class: 'sub' }, `${pc().w} min de enfoque · ${pc().s} de descanso · pausa Feynman ${settings.feynman ? 'activada' : 'apagada'}`)),
    h('button', { class: 'btn ghost', onclick: pomoConfig }, 'Configurar')));
  kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Voz de lectura'), h('div', { class: 'sub' }, settings.ttsVoiceLabel || 'Automática · varias en español latino')),
    h('button', { class: 'btn ghost', onclick: voicePicker }, 'Elegir voz')));
  kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Pasar página tocando los bordes'), h('div', { class: 'sub' }, 'Toca el borde izquierdo o derecho para retroceder o avanzar. En laptop: flechas ← → o espacio')),
    toggle(settings.tapTurn, () => apply({ tapTurn: !settings.tapTurn }))));
  const gl = h('b', {}, settings.goal + ' min');
  kids.push(h('div', { class: 'lbl' }, 'Meta diaria de lectura', gl), slider(10, 180, 5, settings.goal, (n) => { gl.textContent = n + ' min'; saveSettings({ goal: n }); }));
  kids.push(h('div', { class: 'lbl' }, 'Datos'));
  const stRow = h('div', { class: 'row2' }, h('div', { class: 'sub' }, 'Revisando almacenamiento…'));
  kids.push(stRow);
  storageInfo().then((si) => {
    const use = si.usage != null ? ` · usando ${sizeLabel(si.usage)}` : '';
    const msg = native ? 'Tus documentos, subrayados y carpetas se guardan en el teléfono y siguen ahí al cerrar la app, con copia espejo automática.'
      : si.persisted ? 'Protegido: el navegador no borrará tus datos por su cuenta.' : 'Aún sin proteger: instala la app o pulsa “Proteger” para que el navegador no borre tus datos.';
    stRow.replaceChildren(h('div', {}, h('div', {}, native || si.persisted ? 'Almacenamiento protegido ✓' : 'Almacenamiento'), h('div', { class: 'sub' }, msg + use)),
      !native && !si.persisted ? h('button', { class: 'btn', onclick: async () => { await DB.persist(); renderPanel(); } }, 'Proteger') : null);
  });
  if (!native && !standalone()) kids.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Instalar en esta laptop'), h('div', { class: 'sub' }, 'Se abre como programa propio, sin entrar a la página')),
    h('button', { class: 'btn', onclick: doInstall }, 'Instalar')));
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
  saveText('lumen-copia.json', JSON.stringify(await backupData()), 'application/json');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'lumen') throw new Error('no es una copia de Lumen');
    const map = new Map();
    for (const b of data.books) {
      const local = S.books.find((x) => (x.name === b.name && x.size === b.size) || x.title === b.title);
      if (local) { map.set(b.id, local.id); if (b.marks?.length && !local.marks?.length) { local.marks = b.marks; await DB.putBook(local); } if (!local.lastRead) { local.progress = b.progress || 0; local.pos = b.pos || null; local.lastRead = b.pos ? 1 : 0; await DB.putBook(local); } }
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
    for (const c of data.fey || []) { const bid = map.get(c.bookId); if (bid && !S.fey.some((x) => x.id === c.id)) S.fey.push({ ...c, bookId: bid }); }
    saveFey();
    for (const bid of map.values()) { const v = S.views.get(bid); if (v) { S.hl.delete(bid); S.hlLoaded.delete(bid); await loadHl(bid); v.applyAll(); } }
    toast(`${added} subrayados importados${skipped ? ` · ${skipped} sin su documento (súbelo primero)` : ''}`, { ms: 5000 });
    renderLibrary();
  } catch (e) { toast('No se pudo leer la copia: ' + e.message); }
}

// ---------- selección múltiple y mover documentos ----------
function updateSelBar() {
  $('#selActions').hidden = !S.selMode;
  $('#selCount').textContent = `${S.sel.size} ${S.sel.size === 1 ? 'seleccionado' : 'seleccionados'}`;
  $('#fab').classList.toggle('lift', S.selMode);
}
function toggleSelMode() { if (S.selMode) endSel(); else { S.selMode = true; S.sel.clear(); updateSelBar(); renderLibrary(); } }
function endSel() { S.selMode = false; S.sel.clear(); updateSelBar(); renderLibrary(); }
function toggleSel(id) {
  if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  document.querySelector(`#grid .card[data-id="${id}"]`)?.classList.toggle('sel', S.sel.has(id));
  updateSelBar();
}
async function moveBooks(ids, fid) {
  const target = fid === 'none' || fid === '__none' ? null : fid;
  const prev = ids.map((id) => [id, bookById(id)?.folder || null]);
  for (const id of ids) { const b = bookById(id); if (b) { b.folder = target; await DB.putBook(b); } }
  const name = target ? S.folders.find((f) => f.id === target)?.name : 'Sin carpeta';
  S.selMode = false; S.sel.clear();
  hideDropStrip(); updateSelBar(); renderLibrary();
  toast(`${ids.length} ${ids.length === 1 ? 'documento movido' : 'documentos movidos'} a “${name}”`, { ms: 6000, action: { label: 'Deshacer', fn: async () => {
    for (const [id, f] of prev) { const b = bookById(id); if (b) { b.folder = f; await DB.putBook(b); } }
    renderLibrary();
  } } });
}
async function pickFolder(title) {
  const t = await choose(title, [...S.folders.map((f) => ({ label: f.name, value: f.id })), { label: 'Nueva carpeta…', value: '__new' }, { label: 'Sin carpeta', value: '__none' }]);
  if (t === '__new') { const f = await newFolder(false); return f ? f.id : null; }
  return t;
}
async function deleteBooks(ids) {
  const ok = await choose(`¿Eliminar ${ids.length} ${ids.length === 1 ? 'documento' : 'documentos'}?`, [{ label: 'Sí, eliminar', sub: 'Borra los archivos y sus subrayados. No se puede deshacer', value: true, danger: true }]);
  if (!ok) return;
  for (const id of ids) {
    if (S.tabs.includes(id)) closeTab(id);
    await DB.delBook(id);
    S.books = S.books.filter((x) => x.id !== id);
    S.hl.delete(id); S.hlLoaded.delete(id); S.texts.delete(id);
  }
  endSel();
  toast('Documentos eliminados');
}
function showDropStrip() {
  const strip = $('#dropStrip');
  const cur = S.lib.folder;
  const targets = [...S.folders.map((f) => ({ id: f.id, name: f.name })), { id: 'none', name: 'Sin carpeta' }].filter((t) => t.id !== cur);
  strip.replaceChildren(h('span', { class: 'sub' }, 'Suelta en:'), ...targets.map((t) => h('div', { class: 'dz', 'data-dropfolder': t.id }, t.name)));
  strip.hidden = false;
}
function hideDropStrip() { $('#dropStrip').hidden = true; }

// ---------- carpetas ----------
const saveFolders = () => DB.kvSet('folders', S.folders);
async function newFolder(select) {
  const r = await folderEdit(null);
  if (!r) return null;
  const f = { id: DB.uid(), name: r.name, color: r.color };
  S.folders.push(f);
  await saveFolders();
  if (select) { S.libTab = 'books'; S.lib.folder = f.id; S.lib.q = ''; const q = $('#q'); if (q) q.value = ''; }
  renderLibrary();
  return f;
}
async function renameFolder(f) {
  const r = await folderEdit(f);
  if (!r) return;
  f.name = r.name;
  f.color = r.color;
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
    { label: 'Abrir', sub: S.stats.books[id] ? `Llevas ${fmtMin(S.stats.books[id])} leyendo` : null, value: 'open' },
    { label: b.done ? 'Marcar como no terminado' : 'Marcar como terminado', value: 'done' },
    { label: `Mover a ${b.tag === 'estudio' ? 'Lectura' : 'Estudio'}`, sub: `Ahora está en ${TAGS[b.tag]}`, value: 'tag' },
    { label: 'Mover a carpeta…', sub: S.folders.find((f) => f.id === b.folder)?.name || 'Sin carpeta', value: 'folder' },
    { label: 'Cambiar nombre', value: 'rename' },
    { label: 'Exportar subrayados', value: 'export' },
    { label: 'Eliminar de la biblioteca', sub: 'Borra el archivo y sus subrayados', value: 'del', danger: true }]);
  if (act === 'open') openBook(id);
  else if (act === 'done') { b.done = !b.done; await DB.putBook(b); renderLibrary(); }
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

// ---------- marcadores de página ----------
function currentMark(v) {
  const marks = v.book.marks || [];
  if (v.paged) { const p = v.page(); return marks.find((m) => m.pos.page === p); }
  const r = v.ratio();
  return marks.find((m) => m.pos.ratio != null && Math.abs(m.pos.ratio - r) < 0.01);
}
function firstText(v) {
  if (v.kind !== 'flow') return '';
  const top = v.el.getBoundingClientRect().top;
  const b = [...v.el.querySelectorAll('.doc p, .doc li, .doc h1, .doc h2, .doc h3')].find((e) => e.getBoundingClientRect().bottom > top + 8 && e.textContent.trim());
  return b ? b.textContent.trim().replace(/\s+/g, ' ').slice(0, 90) : '';
}
async function toggleBookmark() {
  const v = activeView();
  if (!v) return;
  const b = v.book;
  b.marks ||= [];
  const cur = currentMark(v);
  if (cur) { b.marks = b.marks.filter((m) => m !== cur); toast('Marcador quitado'); }
  else { b.marks.push({ id: DB.uid(), pos: { ...v.getPos(), m: viewMode(v) }, label: v.label(), snippet: firstText(v), ts: Date.now() }); toast('Página marcada · está en Contenido'); }
  await DB.putBook(b);
  renderBar();
  if (S.panel === 'toc') renderPanel();
}
function gotoMark(v, m) {
  if (m.pos.m === viewMode(v)) v.setPos(m.pos);
  else if (m.pos.page != null) v.setPos({ page: m.pos.page });
  else v.seek(m.pos.ratio || 0);
}
function turnPage(v, dir) {
  if (!v) return;
  v.el.scrollBy({ top: dir * (v.el.clientHeight - 56), behavior: 'smooth' });
  lastAct = Date.now();
}

// ---------- estadísticas de lectura ----------
let lastAct = Date.now();
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtMin = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
function streak() {
  const days = S.stats.days;
  const d = new Date();
  let n = 0;
  if (!(days[dayKey(d)] >= 60)) d.setDate(d.getDate() - 1);
  while (days[dayKey(d)] >= 60) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function weekSecs() {
  let s = 0;
  const d = new Date();
  for (let i = 0; i < 7; i++) { s += S.stats.days[dayKey(d)] || 0; d.setDate(d.getDate() - 1); }
  return s;
}
// Cuenta tiempo solo si se está leyendo de verdad (hubo actividad en los últimos 2 minutos o la voz está leyendo).
function statsTick() {
  if (S.screen !== 'reader' || document.visibilityState !== 'visible') return;
  if (Date.now() - lastAct > 120000 && !S.tts?.playing) return;
  const k = dayKey();
  const before = S.stats.days[k] || 0;
  S.stats.days[k] = before + 30;
  const id = S.panes[S.focus];
  if (id) S.stats.books[id] = (S.stats.books[id] || 0) + 30;
  DB.kvSet('stats', S.stats);
  const goal = settings.goal * 60;
  if (before < goal && S.stats.days[k] >= goal) toast(`¡Meta cumplida! Hoy leíste ${settings.goal} min`, { ms: 5000 });
}
function renderStats() {
  const box = $('#stats');
  if (!S.books.length) { box.replaceChildren(); return; }
  const today = S.stats.days[dayKey()] || 0;
  const goal = settings.goal * 60;
  const st = streak();
  const due = S.fey.filter((c) => c.due <= Date.now()).length;
  const pomos = (S.stats.pomos || {})[dayKey()] || 0;
  box.innerHTML = `<div class="today"><div class="t-top"><div class="ring" style="--p:${Math.min(today / goal, 1) * 100}"><span>${Math.round(today / 60)}</span></div>
    <div><div class="eyebrow">Hoy</div><div class="t-main"><b>${fmtMin(today)}</b> de ${settings.goal} min</div><div class="sub">Esta semana: ${fmtMin(weekSecs())}</div></div></div>
    <div class="t-tiles"><div class="tile"><b>${st}</b><span>${st === 1 ? 'día' : 'días'} de racha</span></div><div class="tile"><b>${pomos}</b><span>${pomos === 1 ? 'pomodoro' : 'pomodoros'}</span></div>
    <button class="tile${due ? ' hot' : ''}" data-gofey><b>${due}</b><span>por repasar</span></button></div></div>`;
  box.querySelector('[data-gofey]').onclick = () => { S.libTab = 'fey'; renderLibrary(); $('#libMain').scrollTop = 0; };
}

// ---------- Pomodoro + método Feynman ----------
const PHASE = { work: 'Enfoque', short: 'Descanso', long: 'Descanso largo' };
const pc = () => ({ w: settings.pomoWork || 25, s: settings.pomoShort || 5, l: settings.pomoLong || 15, n: settings.pomoEvery || 4 });

// Qué parte del documento se leyó durante el bloque (para la pausa Feynman).
function track(view) {
  const t = (view.trk ||= { top: Infinity, bottom: -1, p0: Infinity, p1: -1 });
  if (view.kind === 'flow') { const top = view.el.scrollTop; t.top = Math.min(t.top, top); t.bottom = Math.max(t.bottom, top + view.el.clientHeight); }
  if (view.paged || view.kind === 'pdf') { const p = view.page(); t.p0 = Math.min(t.p0, p); t.p1 = Math.max(t.p1, p); }
}
function startTrack(view) {
  if (!view) return;
  view.trk = null;
  view.trkPos = { ...view.getPos(), m: viewMode(view) };
  track(view);
}
async function captureRead(v) {
  if (!v.trk) track(v);
  const t = v.trk;
  let text = '', label = '';
  if (v.kind === 'pdf') {
    const texts = await pdfTexts(v.book, v.pdf);
    const a = Math.min(t.p0, t.p1), b = Math.max(t.p0, t.p1);
    text = texts.slice(a, b + 1).map((p) => p.join(' ')).join('\n');
    label = a === b ? `pág. ${a + 1}` : `págs. ${a + 1}–${b + 1}`;
  } else {
    const base = v.el.scrollTop - v.el.getBoundingClientRect().top;
    const parts = [];
    for (const el of v.el.querySelectorAll('.doc p, .doc li, .doc h1, .doc h2, .doc h3, .doc blockquote')) {
      const r = el.getBoundingClientRect();
      const top = r.top + base;
      if (top + r.height < t.top || top > t.bottom) continue;
      const tx = el.textContent.trim();
      if (tx) parts.push(tx);
    }
    text = parts.join('\n');
    const sh = v.el.scrollHeight || 1;
    label = v.paged ? (t.p0 === t.p1 ? `pág. ${t.p0 + 1}` : `págs. ${t.p0 + 1}–${t.p1 + 1}`) : `${Math.round(t.top / sh * 100)}–${Math.round(Math.min(t.bottom, sh) / sh * 100)} %`;
  }
  return { text: text.slice(0, 12000), label, pos: v.trkPos || null };
}

const STOP = new Set(('para como pero sobre entre cuando desde hasta durante porque también donde quien cada tiene tienen puede pueden debe deben forma tipo parte esto estos estas estar según segun sido solo sólo mismo misma mismos otras otros otra además ademas cual cuales cuyo cuya aquel aquella aquellos desde hacia contra ante bajo tras través hecho hechos hace hacer manera cuando entonces luego donde siempre nunca todos todas todo toda mucho muchos poco pocos algún alguna algunos algunas ningún ninguna serán sería serian será están estaba estaban fueron fuera esté ellos ellas nosotros vosotros usted ustedes artículo articulo').split(' ').map((w) => fold(w)));
const WORD = /[A-Za-zÁÉÍÓÚÑÜáéíóúñü]{5,}/g;
function keyTerms(text, hlTexts) {
  const score = new Map();
  const add = (w, n) => {
    const f = fold(w);
    if (STOP.has(f) || /(ian|aban|ando|iendo|mente|aron|ieron|aria|eria|amos|emos)$/.test(f)) return;
    const cur = score.get(f);
    score.set(f, { w: cur?.w || w.toLowerCase(), n: (cur?.n || 0) + n });
  };
  for (const w of text.match(WORD) || []) add(w, 1);
  for (const t of hlTexts) for (const w of t.match(WORD) || []) add(w, 3);
  return [...score.values()].filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10).map((x) => x.w);
}
const stemOf = (w) => { const f = fold(w); return f.slice(0, Math.min(6, f.length)); };
function coverage(terms, explanation) {
  const toks = (explanation.match(/[A-Za-zÁÉÍÓÚÑÜáéíóúñü]{4,}/g) || []).map(fold);
  return terms.map((t) => ({ t, ok: toks.some((x) => x.startsWith(stemOf(t))) }));
}
const SRS_DAYS = [1, 3, 7, 14, 30, 60];
const saveFey = () => DB.kvSet('fey', S.fey);

async function openFeynman(opts = {}) {
  const v = opts.cap ? null : activeView();
  const book = opts.book || v?.book;
  let cap = opts.cap;
  if (!cap) {
    if (!v) { toast('Abre un documento para hacer la pausa Feynman'); return null; }
    cap = await captureRead(v);
    if (cap.text.replace(/\s/g, '').length < 120) {
      toast(opts.auto ? 'Casi no leíste en este bloque: sigue con el descanso' : 'Lee un poco más y vuelve a intentarlo: aún no hay texto suficiente', { ms: 4000 });
      return null;
    }
  }
  const norm = cap.text.replace(/\s+/g, ' ');
  const hlTexts = hlList(book.id).filter((x) => norm.includes(x.text.slice(0, 25))).map((x) => x.text);
  const terms = keyTerms(norm, hlTexts);
  const prev = opts.card;
  return modal((box, close) => {
    box.classList.add('fey');
    const gaps = new Set(prev?.gaps || []);
    let analyzed = false;
    const ta = h('textarea', { class: 'fe-ta', placeholder: 'Con mis palabras: ¿qué es, cómo funciona y por qué importa? Sin mirar el texto…' });
    ta.value = prev?.text || '';
    const analogy = h('textarea', { class: 'fe-ta small', placeholder: 'Una analogía o ejemplo cotidiano que lo haga obvio (opcional)…' });
    analogy.value = prev?.analogy || '';
    const an = h('div', { class: 'fe-an' });
    an.hidden = true;
    const gapIn = h('input', { class: 'sbox', placeholder: 'Agregar otra laguna y Enter' });
    const paint = () => {
      const cov = coverage(terms, ta.value);
      const ok = cov.filter((x) => x.ok).length;
      an.replaceChildren(
        h('div', { class: 'fe-sum2' }, terms.length ? `Tu explicación cubre ${ok} de ${cov.length} conceptos clave del bloque.` : 'No encontré conceptos repetidos en este bloque; revisa tú mismo contra el texto.'),
        h('div', { class: 'chips' }, ...cov.map((x) => h('button', { class: 'chip ' + (x.ok ? 'fe-ok' : 'fe-miss') + (gaps.has(x.t) ? ' on' : ''), title: 'Tocar para marcar o quitar como laguna', onclick: () => { if (gaps.has(x.t)) gaps.delete(x.t); else gaps.add(x.t); paint(); } }, `${x.ok ? '✓' : '✗'} ${x.t}`))),
        h('div', { class: 'lbl' }, `Lagunas por reforzar · ${gaps.size}`),
        h('div', { class: 'chips' }, ...[...gaps].map((g) => h('button', { class: 'chip fe-gap', onclick: () => { gaps.delete(g); paint(); } }, `${g} ×`))),
        gapIn,
        h('details', { class: 'fe-src' }, h('summary', {}, `Ver lo que leíste (${cap.label})`), h('p', {}, norm.slice(0, 2500) + (norm.length > 2500 ? '…' : ''))));
    };
    gapIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && gapIn.value.trim()) { gaps.add(gapIn.value.trim()); gapIn.value = ''; paint(); gapIn.focus(); } });
    const compare = () => {
      if (ta.value.trim().length < 15) { toast('Escribe primero tu explicación (aunque sea corta)'); return false; }
      if (!analyzed) for (const x of coverage(terms, ta.value)) if (!x.ok) gaps.add(x.t);
      analyzed = true;
      an.hidden = false;
      paint();
      return true;
    };
    const save = async (reread) => {
      if (!analyzed && !compare()) return;
      const total = terms.length, covered = coverage(terms, ta.value).filter((x) => x.ok).length;
      const card = prev || { id: DB.uid(), bookId: book.id, ts: Date.now(), label: cap.label, pos: cap.pos, excerpt: norm.slice(0, 3000), level: 0 };
      Object.assign(card, { text: ta.value.trim(), analogy: analogy.value.trim(), gaps: [...gaps], terms, covered, total, last: Date.now(), due: Date.now() + 864e5, fixed: (prev?.fixed || []).filter((g) => gaps.has(g)) });
      if (!prev) S.fey.push(card);
      await saveFey();
      if (v) { v.trk = null; }
      close('saved');
      toast(gaps.size ? `Tarjeta guardada · ${gaps.size} ${gaps.size === 1 ? 'laguna' : 'lagunas'} para repasar` : '¡Lo explicaste completo! Tarjeta guardada', { ms: 4500 });
      if (S.libTab === 'fey') renderFeyAll();
      if (reread && cap.pos && v) { gotoMark(v, { pos: cap.pos }); setTimeout(renderBar, 80); }
    };
    if (prev) { analyzed = true; an.hidden = false; paint(); }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    const mic = SR ? h('button', { class: 'chip', onclick: () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'es-419'; rec.continuous = true; rec.interimResults = false;
      rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + e.results[i][0].transcript.trim() + ' '; };
      rec.onend = () => { rec = null; mic.classList.remove('on'); mic.textContent = '🎙 Dictar'; };
      rec.onerror = () => toast('No se pudo usar el micrófono');
      mic.classList.add('on'); mic.textContent = '■ Detener';
      rec.start();
    } }, '🎙 Dictar') : null;
    box.append(
      h('h3', {}, opts.card ? 'Reexplicar' : opts.auto ? 'Pausa Feynman' : 'Explícalo con tus palabras'),
      h('div', { class: 'sub fe-intro' }, `${book.title} · ${cap.label}. Aparta el texto: explícaselo a alguien de 10 años, sin jerga. Donde te trabes, ahí está la laguna.`),
      ta,
      h('div', { class: 'fe-row' }, mic, h('button', { class: 'btn ghost', onclick: compare }, 'Comparar con el texto')),
      an,
      h('div', { class: 'lbl' }, 'Analogía'),
      analogy,
      h('div', { class: 'acts' },
        h('button', { class: 'btn ghost', onclick: () => { rec?.stop(); close('skip'); } }, opts.auto ? 'Saltar al descanso' : 'Cancelar'),
        cap.pos && v ? h('button', { class: 'btn ghost', onclick: () => save(true) }, 'Guardar y releer') : null,
        h('button', { class: 'btn', onclick: () => save(false) }, opts.auto ? 'Guardar y descansar' : 'Guardar')));
    setTimeout(() => ta.focus(), 100);
  });
}

function pomoConfig() {
  modal((box, close) => {
    const num = (label, key, min, max) => {
      const i = h('input', { type: 'number', min, max, inputmode: 'numeric' });
      i.value = settings[key];
      i.onchange = () => { saveSettings({ [key]: Math.min(max, Math.max(min, parseInt(i.value, 10) || settings[key])) }); i.value = settings[key]; };
      return h('label', { class: 'cfg-n' }, h('span', {}, label), i);
    };
    const tg = (label, sub, key) => {
      const b = h('button', { class: 'toggle' + (settings[key] ? ' on' : ''), role: 'switch', onclick: () => { saveSettings({ [key]: !settings[key] }); b.classList.toggle('on', settings[key]); } });
      return h('div', { class: 'row2' }, h('div', {}, h('div', {}, label), h('div', { class: 'sub' }, sub)), b);
    };
    box.append(h('h3', {}, 'Pomodoro y Feynman'),
      num('Enfoque (minutos)', 'pomoWork', 5, 120), num('Descanso corto (minutos)', 'pomoShort', 1, 30),
      num('Descanso largo (minutos)', 'pomoLong', 5, 60), num('Descanso largo cada (pomodoros)', 'pomoEvery', 2, 8),
      tg('Pausa Feynman al terminar cada bloque', 'Explicas con tus palabras antes de descansar', 'feynman'),
      tg('Empezar el siguiente pomodoro solo', 'Sin tocar nada al terminar el descanso', 'pomoAuto'),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Listo')));
  });
}

function timerMenu() {
  if (S.timer) {
    const t = S.timer;
    choose(`${PHASE[t.phase]} en curso`, [
      t.phase === 'work' ? { label: 'Terminar el bloque y hacer Feynman', sub: 'Explica lo que llevas leído', value: 'finish' } : { label: 'Saltar el descanso', value: 'skip' },
      { label: 'Detener todo', value: 'stop', danger: true }]).then((x) => {
      if (x === 'finish') endWork(); else if (x === 'skip') endBreak(true); else if (x === 'stop') { stopTimer(); S.pomoCycle = 0; }
    });
    return;
  }
  const c = pc();
  choose('Estudiar', [
    { label: `Pomodoro ${c.w} + ${c.s} min`, sub: settings.feynman ? 'Enfoque, pausa Feynman y descanso, en ciclo' : 'Enfoque y descanso, en ciclo', value: 'pomo' },
    { label: 'Un solo bloque…', sub: 'Sin ciclo: 15, 25, 45 o 60 min', value: 'single' },
    { label: 'Pausa Feynman ahora', sub: 'Explica con tus palabras lo que acabas de leer', value: 'fey' },
    { label: 'Configurar Pomodoro y Feynman', value: 'cfg' }]).then(async (x) => {
    if (x === 'pomo') { S.pomoCycle = 0; startWork(c.w, false); }
    else if (x === 'single') { const m = await choose('Duración del bloque', [15, 25, 45, 60].map((m) => ({ label: `${m} minutos`, value: m }))); if (m) startWork(m, true); }
    else if (x === 'fey') openFeynman();
    else if (x === 'cfg') pomoConfig();
  });
}
function startWork(min, single) {
  S.pomoCycle = single ? 0 : (S.pomoCycle || 0) + 1;
  S.timer = { phase: 'work', end: Date.now() + min * 60000, min, single };
  startTrack(activeView());
  clearInterval(S.timerI);
  S.timerI = setInterval(timerTick, 1000);
  timerTick();
  toast(single ? `Bloque de ${min} min en marcha` : `Pomodoro ${S.pomoCycle} · ${min} min de enfoque`);
}
function stopTimer() { clearInterval(S.timerI); S.timer = null; timerTick(); }
async function endWork() {
  const t = S.timer;
  if (!t) return;
  stopTimer();
  chime();
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  S.stats.pomos ||= {};
  const k = dayKey();
  S.stats.pomos[k] = (S.stats.pomos[k] || 0) + 1;
  DB.kvSet('stats', S.stats);
  if (S.screen === 'library') renderLibrary();
  if (settings.feynman) await openFeynman({ auto: true });
  if (t.single) { toast(`¡${t.min} minutos cumplidos!`, { ms: 4000 }); return; }
  startBreak();
}
function startBreak() {
  const c = pc();
  const long = S.pomoCycle % c.n === 0;
  const min = long ? c.l : c.s;
  S.timer = { phase: long ? 'long' : 'short', end: Date.now() + min * 60000, min };
  clearInterval(S.timerI);
  S.timerI = setInterval(timerTick, 1000);
  timerTick();
  toast(`${long ? 'Descanso largo' : 'Descanso'} de ${min} min: levántate, camina, toma agua`, { ms: 5000 });
}
function endBreak(skip) {
  stopTimer();
  if (!skip) { chime(); navigator.vibrate?.([200, 100, 200]); }
  if (settings.pomoAuto || skip) startWork(pc().w, false);
  else toast('Descanso terminado', { sticky: true, action: { label: `Empezar pomodoro ${S.pomoCycle + 1}`, fn: () => startWork(pc().w, false) } });
}
function timerTick() {
  const t = S.timer;
  const txt = $('#timerTxt'), chip = $('#focusTimer'), btn = $('#timerBtn');
  btn.classList.toggle('on', !!t);
  btn.classList.toggle('brk', !!t && t.phase !== 'work');
  if (!t) { txt.textContent = 'Tiempo'; chip.hidden = true; return; }
  const left = Math.max(0, t.end - Date.now());
  const s = Math.ceil(left / 1000);
  const lab = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  txt.textContent = lab;
  chip.textContent = `${t.phase === 'work' ? '' : PHASE[t.phase] + ' '}${lab}`;
  chip.hidden = false;
  chip.classList.toggle('brk', t.phase !== 'work');
  if (left <= 0) { if (t.phase === 'work') endWork(); else endBreak(false); }
}
function chime() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((d, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = [660, 880, 990][i];
      g.gain.setValueAtTime(0.0001, ac.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d + 0.6);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + d);
      o.stop(ac.currentTime + d + 0.65);
    });
  } catch { /* sin audio */ }
}

// ---------- tarjetas Feynman (repaso espaciado) ----------
const fmtDay = (ts) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
function feyCard(c) {
  const b = bookById(c.bookId);
  const due = c.due <= Date.now();
  const txt = h('div', { class: 'fc-text' }, c.text);
  txt.onclick = () => txt.classList.toggle('open');
  const fixed = new Set(c.fixed || []);
  return h('div', { class: 'fcard' + (due ? ' due' : '') },
    h('div', { class: 'fc-head' }, h('b', {}, b ? b.title : 'Documento eliminado'), h('span', { class: 'sub' }, `${c.label} · ${fmtDay(c.ts)}`), due ? h('span', { class: 'fc-badge' }, 'Repasar hoy') : h('span', { class: 'sub' }, `próximo ${fmtDay(c.due)}`)),
    txt,
    c.analogy ? h('div', { class: 'fc-an' }, '≈ ' + c.analogy) : null,
    c.gaps?.length ? h('div', { class: 'chips' }, ...c.gaps.map((g) => h('button', { class: 'chip fe-gap' + (fixed.has(g) ? ' fixed' : ''), title: 'Tocar si ya lo dominas', onclick: async () => { if (fixed.has(g)) fixed.delete(g); else fixed.add(g); c.fixed = [...fixed]; await saveFey(); renderFeyAll(); } }, g))) : h('div', { class: 'sub' }, 'Sin lagunas'),
    h('div', { class: 'fc-acts' },
      b && c.pos ? h('button', { class: 'btn ghost', onclick: async () => { await openBook(b.id); const v = S.views.get(b.id); if (v) gotoMark(v, { pos: c.pos }); } }, 'Releer') : null,
      b ? h('button', { class: 'btn ghost', onclick: () => openFeynman({ cap: { text: c.excerpt, label: c.label, pos: c.pos }, book: b, card: c }).then(() => renderFeyAll()) }, 'Reexplicar') : null,
      h('button', { class: 'btn', onclick: async () => { c.level = Math.min((c.level || 0) + 1, SRS_DAYS.length - 1); c.due = Date.now() + SRS_DAYS[c.level] * 864e5; await saveFey(); renderFeyAll(); toast(`Bien: lo repasas de nuevo en ${SRS_DAYS[c.level]} días`); } }, 'Lo sé'),
      h('button', { class: 'btn ghost', onclick: async () => { c.level = 0; c.due = Date.now() + 864e5; await saveFey(); renderFeyAll(); toast('Anotado: mañana lo repasas otra vez'); } }, 'Me cuesta'),
      h('button', { class: 'ib', 'aria-label': 'Borrar tarjeta', html: I.trash, onclick: async () => { if (await choose('¿Borrar esta tarjeta?', [{ label: 'Sí, borrar', value: true, danger: true }])) { S.fey = S.fey.filter((x) => x !== c); await saveFey(); renderFeyAll(); } } })));
}
function renderFeyAll() {
  const box = $('#feyAll');
  const cards = S.fey.slice().sort((a, b) => a.due - b.due);
  if (!cards.length) {
    box.innerHTML = '<div class="empty"><b>Aún no hay tarjetas Feynman</b>Al terminar un bloque Pomodoro (o con el botón Feynman mientras lees) explicas con tus palabras lo que aprendiste. Aquí quedan tus explicaciones y lagunas para repasarlas.</div>';
    return;
  }
  const dueN = cards.filter((c) => c.due <= Date.now()).length;
  box.replaceChildren(
    pageHead('Tarjetas Feynman', 'Tus explicaciones con repaso espaciado'),
    h('div', { class: 'fe-top' }, h('b', {}, dueN ? `${dueN} ${dueN === 1 ? 'tarjeta' : 'tarjetas'} para repasar hoy` : 'Todo al día'), h('span', { class: 'sub' }, `${cards.length} en total · ${S.fey.reduce((a, c) => a + (c.gaps || []).filter((g) => !(c.fixed || []).includes(g)).length, 0)} lagunas abiertas`)),
    ...cards.map(feyCard));
}

// ---------- repaso de subrayados (tarjetas) ----------
function review(book, list) {
  if (!list.length) { toast('No hay subrayados para repasar'); return; }
  const order = list.slice();
  let i = 0, quiz = false;
  modal((box, close) => {
    box.classList.add('review');
    box.tabIndex = -1;
    const draw = () => {
      const x = order[i];
      const quote = h('div', { class: 'rv-q' + (quiz ? ' hidden' : '') }, x.text);
      box.replaceChildren(
        h('div', { class: 'rv-top' }, h('span', { class: 'sub' }, [`${i + 1} de ${order.length}`, locLabel(book, x)].filter(Boolean).join(' · ')),
          h('div', { style: 'display:flex;gap:8px' },
            h('button', { class: 'chip' + (quiz ? ' on' : ''), onclick: () => { quiz = !quiz; draw(); } }, 'Modo pregunta'),
            h('button', { class: 'chip', onclick: () => { order.sort(() => Math.random() - 0.5); i = 0; draw(); } }, 'Mezclar'))),
        h('button', { class: 'rv-card', style: `--c:${HL_COLORS[x.color]}`, onclick: () => quote.classList.remove('hidden') },
          quiz ? h('div', { class: 'rv-hint' }, x.note ? `Pista: ${x.note}` : 'Intenta recordarlo y toca la tarjeta para verlo') : null,
          quote,
          !quiz && x.note ? h('div', { class: 'nt' }, x.note) : null),
        h('div', { class: 'acts' },
          h('button', { class: 'btn ghost', onclick: () => { if (i > 0) { i--; draw(); } } }, 'Anterior'),
          h('button', { class: 'btn ghost', onclick: () => { close(null); openAt(book.id, x); } }, 'Ir al texto'),
          h('button', { class: 'btn', onclick: () => { if (i < order.length - 1) { i++; draw(); } else close(null); } }, i < order.length - 1 ? 'Siguiente' : 'Terminar')));
      box.focus();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && i < order.length - 1) { i++; draw(); }
      else if (e.key === 'ArrowLeft' && i > 0) { i--; draw(); }
      else if (e.key === ' ') { e.preventDefault(); box.querySelector('.rv-q')?.classList.remove('hidden'); }
    });
    draw();
  });
}

// ---------- lectura en voz alta ----------
const Tts = registerPlugin('LumenTts');
const Incoming = registerPlugin('LumenIncoming');
const ttsNative = () => native && Capacitor.isPluginAvailable('LumenTts');
function splitChunks(t) {
  if (t.length <= 1200) return [t];
  const out = [];
  let cur = '';
  for (const s of t.match(/[^.!?;:]+[.!?;:]*\s*/g) || [t]) {
    if ((cur + s).length > 1200 && cur) { out.push(cur); cur = ''; }
    cur += s;
  }
  if (cur) out.push(cur);
  return out;
}
async function ttsItems(v) {
  const items = [];
  if (v.kind === 'flow') {
    const top = v.el.getBoundingClientRect().top + 8;
    const blocks = [...v.el.querySelectorAll('.doc p, .doc li, .doc h1, .doc h2, .doc h3, .doc h4, .doc blockquote, .doc td')]
      .filter((b) => !b.querySelector('p,li,h1,h2,h3,h4') && b.textContent.trim().length > 1);
    let start = blocks.findIndex((b) => b.getBoundingClientRect().bottom > top);
    if (start < 0) start = 0;
    for (const b of blocks.slice(start)) for (const c of splitChunks(b.textContent.replace(/\s+/g, ' ').trim())) items.push({ text: c, el: b });
  } else {
    const texts = await pdfTexts(v.book, v.pdf);
    for (let p = v.page(); p < texts.length; p++) for (const para of texts[p]) for (const c of splitChunks(para)) items.push({ text: c, page: p });
  }
  return items;
}
// ---------- voces en español (latino primero) ----------
const CC = { MX: 'México', US: 'Estados Unidos (latino)', AR: 'Argentina', CO: 'Colombia', CL: 'Chile', PE: 'Perú', VE: 'Venezuela', BO: 'Bolivia', EC: 'Ecuador', UY: 'Uruguay', PY: 'Paraguay', CR: 'Costa Rica', GT: 'Guatemala', PA: 'Panamá', DO: 'Rep. Dominicana', CU: 'Cuba', HN: 'Honduras', NI: 'Nicaragua', SV: 'El Salvador', PR: 'Puerto Rico', '419': 'Latinoamérica', ES: 'España' };
const CC_ORDER = ['MX', 'US', '419', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'GT', 'PA', 'DO', 'CU', 'HN', 'NI', 'SV', 'PR', 'ES'];
const ccOf = (v) => ((v.lang || '').replace('_', '-').split('-')[1] || '').toUpperCase();
async function listVoices() {
  let vs = [];
  if (ttsNative()) { try { vs = (await Tts.getVoices()).voices || []; } catch { vs = []; } }
  else if ('speechSynthesis' in window) {
    const read = () => speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, network: !v.localService }));
    vs = read();
    if (!vs.length) { await new Promise((r) => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 900); }); vs = read(); }
  }
  vs = vs.filter((v) => /^es/i.test((v.lang || '').replace('_', '-')));
  vs.sort((a, b) => (CC_ORDER.indexOf(ccOf(a)) + 1 || 99) - (CC_ORDER.indexOf(ccOf(b)) + 1 || 99) || a.name.localeCompare(b.name));
  const seen = {};
  for (const v of vs) {
    const cc = ccOf(v);
    seen[cc] = (seen[cc] || 0) + 1;
    const web = !/^[a-z]{2,3}[-_]/i.test(v.name);
    const nm = web ? v.name.replace(/^(Microsoft|Google)\s+/i, '').split(' - ')[0].replace(/\s*Online.*$/i, '').trim() : '';
    const country = CC[cc] || 'Español';
    v.title = nm && !/^espa/i.test(nm) ? nm : `${country} · voz ${seen[cc]}`;
    v.sub = [country, v.network ? 'necesita internet' : 'sin conexión', /natural|neural|online/i.test(v.name) || (v.quality || 0) >= 400 ? 'alta calidad' : ''].filter(Boolean).join(' · ');
  }
  return vs;
}
async function voicePicker() {
  const wasPlaying = S.tts?.playing;
  if (S.tts) { S.tts.playing = false; ttsEngineStop(); }
  const vs = await listVoices();
  await modal((box, close) => {
    box.classList.add('voices');
    const draw = () => {
      const items = vs.map((v) => h('button', { class: 'vo' + (settings.ttsVoice === v.name ? ' on' : ''), onclick: async () => {
        saveSettings({ ttsVoice: v.name, ttsVoiceLabel: v.title });
        draw();
        ttsEngineStop();
        try { await speakChunk('Hola, así suena esta voz de lectura.', settings.ttsRate || 1); } catch { toast('No se pudo probar esa voz'); }
      } }, h('span', {}, v.title), h('small', {}, v.sub)));
      box.replaceChildren(
        h('h3', {}, 'Voz de lectura'),
        h('div', { class: 'sub', style: 'margin-bottom:10px' }, vs.length ? 'Toca una voz para escucharla y elegirla. Van primero las de español latino.' : 'Este dispositivo no tiene voces en español instaladas.'),
        h('div', { class: 'vlist' }, h('button', { class: 'vo' + (!settings.ttsVoice ? ' on' : ''), onclick: () => { saveSettings({ ttsVoice: '', ttsVoiceLabel: '' }); draw(); } }, h('span', {}, 'Automática'), h('small', {}, 'La que tenga el dispositivo por defecto')), ...items),
        h('div', { class: 'acts' },
          native ? h('button', { class: 'btn ghost', onclick: () => Tts.openSettings().catch(() => toast('No se pudieron abrir los ajustes de voz')) }, 'Instalar más voces…') : null,
          h('button', { class: 'btn', onclick: () => close(null) }, 'Listo')));
    };
    draw();
  });
  ttsEngineStop();
  if (S.tts && wasPlaying) { S.tts.playing = true; ttsLoop(); }
  if (S.panel === 'cfg') renderPanel();
}
function speakChunk(text, rate) {
  const voice = settings.ttsVoice;
  if (ttsNative()) return Tts.speak({ text, rate, lang: 'es-US', voice });
  return new Promise((res, rej) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-MX';
    u.rate = rate;
    const vs = speechSynthesis.getVoices().filter((x) => x.lang?.toLowerCase().startsWith('es'));
    const pick = vs.find((x) => x.name === voice)
      || vs.filter((x) => !/-ES$/i.test(x.lang.replace('_', '-'))).find((x) => /google|natural|online/i.test(x.name))
      || vs.find((x) => !/-ES$/i.test(x.lang.replace('_', '-'))) || vs[0];
    if (pick) { u.voice = pick; u.lang = pick.lang; }
    u.onend = () => res({});
    u.onerror = (e) => (['interrupted', 'canceled'].includes(e.error) ? res({ stopped: true }) : rej(new Error(e.error)));
    speechSynthesis.speak(u);
  });
}
function ttsEngineStop() {
  if (ttsNative()) Tts.stop().catch(() => {});
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
}
async function toggleTts() {
  if (S.tts) { stopTts(); return; }
  if (native && !Capacitor.isPluginAvailable('LumenTts')) { toast('Para leer en voz alta instala el APK 1.4.0 (esta parte no llega por actualización automática)', { ms: 6000 }); return; }
  if (!native && !('speechSynthesis' in window)) { toast('Este navegador no puede leer en voz alta'); return; }
  const v = activeView();
  if (!v) return;
  const items = await ttsItems(v);
  if (!items.length) { toast('No encontré texto para leer aquí'); return; }
  S.tts = { view: v, items, i: 0, playing: true, rate: settings.ttsRate || 1 };
  renderTtsBar();
  ttsLoop();
}
async function ttsLoop() {
  const t = S.tts;
  while (t && t === S.tts && t.playing && t.i < t.items.length) {
    const it = t.items[t.i];
    ttsMark(t, it);
    let r;
    try { r = await speakChunk(it.text, t.rate); } catch (e) {
      console.warn(e);
      toast('No se pudo leer en voz alta: ' + (e?.message || 'el teléfono no tiene motor de voz'));
      stopTts();
      return;
    }
    if (r?.stopped || t !== S.tts || !t.playing) return;
    t.i++;
    lastAct = Date.now();
  }
  if (t && t === S.tts && t.i >= t.items.length) { stopTts(); toast('Lectura terminada'); }
}
function ttsMark(t, it) {
  document.querySelectorAll('.tts-on').forEach((e) => e.classList.remove('tts-on'));
  const v = t.view;
  if (it.el) {
    it.el.classList.add('tts-on');
    const r = it.el.getBoundingClientRect(), er = v.el.getBoundingClientRect();
    if (r.top < er.top || r.bottom > er.bottom) v.scrollToEl(it.el, true);
  } else if (it.page != null && v.page() !== it.page) v.gotoPage(it.page);
  $('#ttsLabel').textContent = it.page != null ? `Leyendo · pág. ${it.page + 1}` : 'Leyendo en voz alta';
}
function ttsPause() {
  const t = S.tts;
  if (!t) return;
  if (t.playing) { t.playing = false; ttsEngineStop(); } else { t.playing = true; ttsLoop(); }
  renderTtsBar();
}
function ttsRate() {
  const t = S.tts;
  if (!t) return;
  const rates = [0.8, 1, 1.25, 1.5, 1.75, 2];
  t.rate = rates[(rates.indexOf(t.rate) + 1) % rates.length] || 1;
  saveSettings({ ttsRate: t.rate });
  renderTtsBar();
  if (t.playing) {
    t.playing = false;
    ttsEngineStop();
    setTimeout(() => { if (S.tts === t) { t.playing = true; ttsLoop(); } }, 200);
  }
}
function stopTts() {
  const t = S.tts;
  S.tts = null;
  if (t) ttsEngineStop();
  document.querySelectorAll('.tts-on').forEach((e) => e.classList.remove('tts-on'));
  renderTtsBar();
}
function renderTtsBar() {
  const t = S.tts;
  $('#ttsBar').hidden = !t;
  $('#ttsBtn').classList.toggle('on', !!t);
  if (!t) return;
  $('#ttsPlay').innerHTML = t.playing ? I.pause : I.play;
  $('#ttsSpeed').textContent = `${t.rate}×`;
}

// ---------- documentos que llegan desde otras apps (Android) ----------
async function takeIncoming() {
  if (!native || !Capacitor.isPluginAvailable('LumenIncoming')) return;
  try {
    const { files } = await Incoming.take();
    if (!files?.length) return;
    const list = [];
    for (const f of files) {
      const b = await (await fetch(Capacitor.convertFileSrc(f.uri))).blob();
      list.push(new File([b], f.name, { type: f.mime || b.type }));
    }
    Incoming.clear().catch(() => {});
    if (S.screen === 'reader') goLibrary();
    await onFiles(list);
  } catch (e) {
    console.warn('incoming', e);
    toast('No se pudo abrir el documento compartido');
  }
}

const appApi = { hls: (id) => S.hl.get(id) || [], onScroll, editHl, pdfTexts, hud, saveBook: (b) => DB.putBook(b) };

// ---------- arranque ----------
export async function start() {
  applySettings();
  document.body.classList.toggle('nobar', !!settings.barHidden);
  $('#app').innerHTML = `
<div id="shell">
  <header id="top">
    <button class="ib" id="homeBtn" aria-label="Biblioteca">${LOGO}</button>
    <div id="tabs" role="tablist"></div>
    <button class="ib split-only" id="splitBtn" aria-label="Dividir pantalla">${I.split}</button>
    <button class="btn" id="installBtn" hidden>${I.download}<span>Instalar app</span></button>
    <button class="ib" id="cfgBtn" aria-label="Ajustes">${I.sliders}</button>
  </header>
  <div id="body">
    <main id="main">
      <section id="library">
        <div class="lib-shell">
          <aside id="libSide" aria-label="Navegación de la biblioteca"></aside>
          <div class="lib-main" id="libMain"><div class="lib-wrap">
            <header class="lib-head">
              <div class="lib-title"><div class="hello" id="hello"></div><h1 class="brand" id="pageTitle">Lumen</h1></div>
              <label class="lib-search">${I.search}<input id="q" type="search" placeholder="Buscar documentos…" aria-label="Buscar en la biblioteca"></label>
              <button id="addBtn" class="btn">${I.plus}<span>Añadir</span></button>
            </header>
            <div id="libBooks">
              <div id="dash"><div id="cont"></div><div id="stats"></div></div>
              <div id="folderHead"></div>
              <div id="toolbar"></div>
              <div id="grid"></div>
            </div>
            <div id="hlAll" hidden></div>
            <div id="feyAll" hidden></div>
          </div></div>
        </div>
      </section>
      <section id="viewer" hidden><div id="views"></div></section>
      <button id="fab">${I.plus} Añadir documentos</button>
      <button id="exitFocus" aria-label="Salir de pantalla completa">${I.expand}</button>
      <button id="focusDocs" aria-label="Documentos abiertos" hidden>${I.book}<b id="fdCount"></b></button>
      <div id="focusList" hidden></div>
      <div id="zoomCtl" aria-label="Zoom"><button id="zOut" class="ib" aria-label="Alejar">−</button><button id="zReset" class="ib" aria-label="Zoom normal">1:1</button><button id="zIn" class="ib" aria-label="Acercar">+</button></div>
      <div id="zoomHud" role="status"></div>
      <button id="barShow" aria-label="Mostrar barra inferior" hidden>${I.chevron}</button>
      <div id="focusTimer" hidden></div>
      <div id="selActions" hidden><span id="selCount"></span><button id="selMove" class="btn">Mover</button><button id="selAll" class="btn ghost">Todo</button><button id="selDel" class="btn ghost">Eliminar</button><button id="selCancel" class="btn ghost">Cancelar</button></div>
      <div id="dropStrip" hidden></div>
      <div id="ttsBar" hidden><button id="ttsPlay" class="ib" aria-label="Pausar o seguir"></button><button id="ttsStop" class="ib" aria-label="Detener lectura">${I.stop}</button><button id="ttsSpeed" class="chip" aria-label="Velocidad de lectura"></button><button id="ttsVoice" class="chip" aria-label="Elegir voz">Voz</button><span id="ttsLabel"></span></div>
      <div id="loading" hidden><div><div class="spin"></div><span id="loadtxt"></span></div></div>
    </main>
    <aside id="panel" aria-label="Panel"><div class="grab"></div><button class="ib" id="panelClose" aria-label="Cerrar panel">${I.close}</button><div id="panelBody"></div></aside>
  </div>
  <footer id="bar" hidden>
    <div class="row"><input id="seek" type="range" min="0" max="1000" aria-label="Posición en el documento"><span id="plabel"></span><button class="ib" id="bmBtn" aria-label="Marcar esta página">${I.bookmark}</button></div>
    <div class="tools">
      <button data-p="toc" aria-label="Índice">${I.list}Índice</button>
      <button data-p="hl" aria-label="Subrayados">${I.marker}<span id="hlN">Marcas</span></button>
      <button data-p="search" aria-label="Buscar">${I.search}Buscar</button>
      <button id="feyBtn" aria-label="Pausa Feynman">${I.bulb}Feynman</button>
      <button data-p="cfg" aria-label="Ajustes de texto">${I.type}Texto</button>
      <button id="moreBtn" aria-haspopup="true" aria-expanded="false" aria-label="Más opciones">${I.more}Más</button>
    </div>
    <div id="morePop" hidden>
      <button id="markBtn">${I.marker}Subrayar al seleccionar</button>
      <button id="ttsBtn">${I.voice}Leer en voz alta</button>
      <button id="timerBtn">${I.timer}<span id="timerTxt">Tiempo</span></button>
      <button id="focusBtn">${I.expand}Pantalla completa</button>
      <button id="barHide">${I.chevron}Ocultar barra</button>
    </div>
  </footer>
  <nav id="libnav"><button data-t="books" class="on">${I.book}<span>Biblioteca</span></button><button data-t="hls">${I.marker}<span>Subrayados</span></button><button data-t="fey">${I.bulb}<span>Feynman</span></button></nav>
</div>
<input type="file" id="file" multiple hidden accept=".pdf,.docx,.epub,.txt,.md,.html,.htm,application/pdf">
<input type="file" id="bk" hidden accept=".json,application/json">
<input type="file" id="dir" hidden webkitdirectory multiple>
<div id="backdrop" hidden></div><div id="selbar" hidden></div><div id="toast" role="status"></div><div id="modal" hidden></div>`;

  S.books = await DB.allBooks();
  S.folders = (await DB.kvGet('folders').catch(() => null)) || [];
  S.stats = (await DB.kvGet('stats').catch(() => null)) || { days: {}, books: {} };
  S.fey = (await DB.kvGet('fey').catch(() => null)) || [];
  setInterval(statsTick, 30000);
  DB.persist();
  DB.onWrite(scheduleMirror);
  if (native && !S.books.length) {
    S.mirror = await readMirror();
    if (S.mirror?.books?.length) {
      if (!S.folders.length && S.mirror.folders?.length) { S.folders = S.mirror.folders; DB.kvSet('folders', S.folders); }
      setTimeout(() => toast('Encontré la copia de tus subrayados y carpetas: vuelve a añadir tus documentos y se recuperan solos', { ms: 7000 }), 800);
    }
  }
  const ses = await DB.kvGet('session').catch(() => null);

  $('#homeBtn').onclick = goLibrary;
  $('#cfgBtn').onclick = () => openPanel('cfg');
  $('#splitBtn').onclick = toggleSplit;
  $('#installBtn').onclick = doInstall;
  addEventListener('lumen-theme', () => S.views.forEach((v) => v.kind === 'pdf' && v.relayout?.(true)));
  $('#barHide').onclick = () => setBarHidden(true);
  $('#panelClose').onclick = closePanel;
  $('#views').addEventListener('scroll', dockOnScroll, true);
  $('#barShow').onclick = () => setBarHidden(false);
  $('#exitFocus').onclick = () => setFocus(false);
  $('#focusDocs').onclick = (e) => { e.stopPropagation(); toggleFocusList(); };
  document.addEventListener('click', (e) => { const l = $('#focusList'); if (!l.hidden && !e.target.closest('#focusList, #focusDocs')) l.hidden = true; });
  $('#zIn').onclick = () => stepZoom(1);
  $('#zOut').onclick = () => stepZoom(-1);
  $('#zReset').onclick = () => stepZoom(0, true);
  installUi();
  $('#fab').onclick = async () => {
    if (native) { $('#file').click(); return; }
    const t = await choose('Añadir documentos', [
      { label: 'Elegir archivos', sub: 'Puedes seleccionar varios a la vez (Ctrl o Shift)', value: 'files' },
      { label: 'Subir una carpeta entera', sub: 'Se crea un ramo con su nombre y se suben todos sus documentos', value: 'dir' }]);
    if (t === 'files') $('#file').click(); else if (t === 'dir') $('#dir').click();
  };
  $('#addBtn').onclick = () => $('#fab').click();
  $('#dir').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; onDir(f); };
  $('#file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; onFiles(f); };
  $('#bk').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
  $('#q').oninput = (e) => { S.lib.q = e.target.value.trim(); renderLibrary(); $('#q').focus(); };
  $('#libnav').onclick = (e) => { const b = e.target.closest('button'); if (b) { if (b.dataset.t === 'books') S.lib.folder = 'all'; S.libTab = b.dataset.t; renderLibrary(); } };
  $('#backdrop').onclick = closePanel;
  $('#grid').onclick = (e) => {
    if (S.lpFired) { S.lpFired = false; return; }
    if (S.selMode) { const c = e.target.closest('.card'); if (c) toggleSel(c.dataset.id); return; }
    const fo = e.target.closest('[data-folder]');
    if (fo) { S.lib.folder = fo.dataset.folder; renderLibrary(); $('#libMain').scrollTop = 0; return; }
    const m = e.target.closest('[data-more]');
    if (m) { bookMenu(m.dataset.more); return; }
    const o = e.target.closest('[data-open]');
    if (o) openBook(o.dataset.open);
  };
  // Mantener presionado un documento activa la selección múltiple.
  let lpT;
  $('#grid').addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.card');
    S.lpFired = false;
    clearTimeout(lpT);
    if (!c || S.selMode || e.target.closest('[data-more]') || e.pointerType === 'mouse') return;
    lpT = setTimeout(() => { S.lpFired = true; S.selMode = true; S.sel.add(c.dataset.id); navigator.vibrate?.(15); updateSelBar(); renderLibrary(); }, 500);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => $('#grid').addEventListener(t, () => clearTimeout(lpT)));
  $('#selMove').onclick = async () => { if (!S.sel.size) { toast('Marca primero uno o más documentos'); return; } const f = await pickFolder(`Mover ${S.sel.size} ${S.sel.size === 1 ? 'documento' : 'documentos'} a…`); if (f) moveBooks([...S.sel], f); };
  $('#selDel').onclick = () => { if (!S.sel.size) { toast('Marca primero uno o más documentos'); return; } deleteBooks([...S.sel]); };
  $('#selAll').onclick = () => { document.querySelectorAll('#grid .card').forEach((c) => S.sel.add(c.dataset.id)); renderLibrary(); updateSelBar(); };
  $('#selCancel').onclick = endSel;
  // Arrastrar documentos (laptop) hacia una carpeta destino.
  $('#grid').addEventListener('dragstart', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    const ids = S.selMode && S.sel.has(c.dataset.id) ? [...S.sel] : [c.dataset.id];
    e.dataTransfer.setData('text/lumen-books', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    showDropStrip();
  });
  $('#grid').addEventListener('dragend', hideDropStrip);
  // Soltar documentos (arrastre interno) sobre una carpeta de la barra lateral.
  const side = $('#libSide');
  side.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('text/lumen-books')) return;
    const t = e.target.closest('.side-f');
    if (!t) return;
    e.preventDefault();
    side.querySelectorAll('.side-f').forEach((x) => x.classList.toggle('over', x === t));
  });
  side.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !side.contains(e.relatedTarget)) side.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
  side.addEventListener('drop', (e) => {
    const t = e.target.closest('.side-f');
    if (!t || !e.dataTransfer?.types?.includes('text/lumen-books')) return;
    e.preventDefault(); e.stopPropagation();
    side.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    let ids = [];
    try { ids = JSON.parse(e.dataTransfer.getData('text/lumen-books')); } catch { /* no es un documento */ }
    if (ids.length) moveBooks(ids, t.dataset.folder);
  });
  const strip = $('#dropStrip');
  strip.addEventListener('dragover', (e) => { e.preventDefault(); strip.querySelectorAll('.dz').forEach((x) => x.classList.toggle('over', x === e.target.closest('.dz'))); });
  strip.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    const dz = e.target.closest('.dz');
    let ids = [];
    try { ids = JSON.parse(e.dataTransfer.getData('text/lumen-books')); } catch { /* no es un documento */ }
    if (dz && ids.length) moveBooks(ids, dz.dataset.dropfolder); else hideDropStrip();
  });
  $('#bar').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'moreBtn') { const p = $('#morePop'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); return; }
    if (b.closest('#morePop')) { $('#morePop').hidden = true; $('#moreBtn').setAttribute('aria-expanded', 'false'); }
    if (b.dataset.p) openPanel(b.dataset.p);
    else if (b.id === 'focusBtn') setFocus(true);
    else if (b.id === 'bmBtn') toggleBookmark();
    else if (b.id === 'ttsBtn') toggleTts();
    else if (b.id === 'timerBtn') timerMenu();
    else if (b.id === 'feyBtn') openFeynman();
    else if (b.id === 'markBtn') { saveSettings({ auto: !settings.auto }); toast(settings.auto ? 'Marcador automático activado' : 'Marcador automático apagado'); renderBar(); }
  };
  $('#seek').oninput = (e) => { e.target.style.setProperty('--pos', (e.target.value / 10) + '%'); const v = activeView(); if (v) v.seek(e.target.value / 1000); };
  $('#ttsPlay').onclick = ttsPause;
  $('#ttsStop').onclick = stopTts;
  $('#ttsSpeed').onclick = ttsRate;
  $('#ttsVoice').onclick = voicePicker;
  // Tocar los bordes pasa a la pantalla siguiente o anterior.
  $('#views').addEventListener('click', (e) => {
    const skip = S.skipTap;
    S.skipTap = false;
    if (skip || !getSelection().isCollapsed || Date.now() - (S.lastPinch || 0) < 500) return;
    const vEl = e.target.closest('.view');
    if (!vEl || e.target.closest('mark.hl, a, button')) return;
    const r = vEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (settings.tapTurn && x < 0.18) turnPage(S.views.get(vEl.dataset.id), -1);
    else if (settings.tapTurn && x > 0.82) turnPage(S.views.get(vEl.dataset.id), 1);
    else if (matchMedia('(pointer: coarse)').matches) setDock(!$('#bar').classList.contains('away'));
  });
  $('#selbar').addEventListener('pointerdown', () => { S.barTouched = true; clearTimeout(hideT); });
  $('#selbar').addEventListener('click', onBarClick);
  $('#views').addEventListener('pointerdown', (e) => {
    const id = e.target.closest('.view')?.dataset.id;
    const i = S.panes.indexOf(id);
    if (i >= 0 && i !== S.focus) { S.focus = i; renderTabs(); renderBar(); if (S.panel) renderPanel(); }
    lastAct = Date.now();
    S.skipTap = !$('#selbar').hidden;
    if (!$('#selbar').hidden && !e.target.closest('mark.hl')) hideBar();
  });
  document.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(onSelection, 320); });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') { if (S.closeModal) S.closeModal(); else if (S.panel) closePanel(); else if (S.selMode) endSel(); else if (S.focusMode) setFocus(false); else hideBar(); }
    else if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && S.screen === 'reader' && !S.closeModal) setBarHidden(!settings.barHidden);
    else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && S.screen === 'reader' && !S.closeModal) setFocus(!S.focusMode);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.screen === 'reader') { e.preventDefault(); S.panel = null; openPanel('search'); }
    else if (!typing && S.screen === 'reader' && !S.closeModal && (e.key === '[' || e.key === ']' || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')))) {
      e.preventDefault();
      switchTab(e.key === '[' || e.key === 'ArrowLeft' ? -1 : 1);
    }
    else if (!typing && S.screen === 'reader' && !S.closeModal && ['+', '=', '-', '_', '0'].includes(e.key) && !e.altKey) {
      e.preventDefault();
      if (e.key === '0') stepZoom(0, true); else stepZoom(e.key === '-' || e.key === '_' ? -1 : 1);
    }
    else if (!typing && S.screen === 'reader' && !S.closeModal && ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', ' '].includes(e.key)) {
      e.preventDefault();
      turnPage(activeView(), e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey) ? -1 : 1);
    }
  });
  addEventListener('resize', () => {
    if (innerWidth < 1100 && S.split) layout();
    if (S.screen === 'library') { clearTimeout(S.rzT); S.rzT = setTimeout(renderLibrary, 150); }
  });
  addEventListener('beforeunload', () => S.views.forEach((v) => flushProgress(v.book)));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') S.views.forEach((v) => flushProgress(v.book)); });
  // Arrastrar archivos (laptop)
  addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!e.dataTransfer?.types?.includes('Files')) return;
    document.body.classList.add('dropping');
    document.querySelectorAll('.drophover').forEach((x) => x.classList.remove('drophover'));
    e.target.closest?.('.fold[data-folder], .side-f[data-folder]')?.classList.add('drophover');
  });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) { document.body.classList.remove('dropping'); document.querySelectorAll('.drophover').forEach((x) => x.classList.remove('drophover')); } });
  addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    document.querySelectorAll('.drophover').forEach((x) => x.classList.remove('drophover'));
    if (e.dataTransfer?.types?.includes('text/lumen-books')) return;
    const tgt = e.target.closest?.('.fold[data-folder], .side-f[data-folder]');
    const preset = tgt ? (tgt.dataset.folder === 'none' ? '__none' : tgt.dataset.folder) : null;
    const items = [...(e.dataTransfer?.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const dirs = items.filter((x) => x.isDirectory);
    if (dirs.length) {
      const walk = (en) => new Promise((res) => {
        if (en.isFile) { en.file((f) => res([f]), () => res([])); return; }
        const out = [];
        const rd = en.createReader();
        const next = () => rd.readEntries(async (ents) => {
          if (!ents.length) { res(out.flat()); return; }
          for (const x of ents) out.push(await walk(x));
          next();
        }, () => res(out.flat()));
        next();
      });
      for (const d of dirs) {
        const files = (await walk(d)).filter((f) => FORMATS[ext(f.name)]);
        if (!files.length) continue;
        let f = S.folders.find((x) => x.name.toLowerCase() === d.name.toLowerCase());
        if (!f) { f = { id: DB.uid(), name: d.name.slice(0, 40) }; S.folders.push(f); await saveFolders(); }
        await onFiles(files, f.id);
      }
      const loose = [...e.dataTransfer.files].filter((f, i) => !items[i]?.isDirectory);
      if (loose.length) onFiles(loose, preset);
      return;
    }
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files, preset);
  });

  onUpdateStatus((s) => {
    if (S.panel === 'cfg') renderPanel();
    if (s.state === 'ready') toast(`Hay una versión nueva (${s.version})`, { sticky: true, action: { label: 'Actualizar ahora', fn: applyNow } });
  });

  if (native) {
    CapApp.addListener('backButton', () => {
      if (S.closeModal) S.closeModal();
      else if (S.focusMode) setFocus(false);
      else if (S.selMode) endSel();
      else if (!$('#selbar').hidden) hideBar();
      else if (S.panel) closePanel();
      else if (S.screen === 'reader') goLibrary();
      else if (S.libTab === 'books' && S.lib.folder !== 'all' && !S.lib.q) { S.lib.folder = 'all'; renderLibrary(); }
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
  if (native && Capacitor.isPluginAvailable('LumenIncoming')) {
    Incoming.addListener('files', takeIncoming);
    CapApp.addListener('resume', takeIncoming);
    takeIncoming();
  }
  if (!S.books.length && !settings.welcomed) setTimeout(showWelcome, 500);
  return true;
}
