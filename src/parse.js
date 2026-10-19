import mammoth from 'mammoth/mammoth.browser.min.js';
import { unzipSync, strFromU8 } from 'fflate';

export const ext = (name) => (name.split('.').pop() || '').toLowerCase();
export const FORMATS = { pdf: 'pdf', docx: 'docx', epub: 'epub', txt: 'txt', md: 'txt', html: 'txt', htm: 'txt' };
export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fold = (s) => {
  const f = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return f.length === s.length ? f : s.toLowerCase();
};

// Deja solo contenido de lectura: sin scripts, estilos propios ni manejadores.
export function clean(root) {
  root.querySelectorAll('script,style,link,meta,iframe,object,embed,form,base,title,video,audio').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const k = a.name.toLowerCase();
      if (k.startsWith('on') || k === 'style' || k === 'srcset' || k === 'class') n.removeAttribute(a.name);
      else if ((k === 'href' || k === 'src' || k === 'xlink:href') && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
  });
  return root;
}

// Reparte los bloques de nivel superior en secciones de tamaño razonable.
function chunk(body, per = 250) {
  const kids = [...body.children];
  const sections = [];
  const toc = [];
  for (let i = 0; i < Math.max(kids.length, 1); i += per) {
    const wrap = document.createElement('div');
    kids.slice(i, i + per).forEach((k) => wrap.append(k));
    const sec = sections.length;
    wrap.querySelectorAll('h1,h2,h3').forEach((hd) => {
      const t = hd.textContent.trim();
      if (!t) return;
      hd.dataset.toc = String(toc.length);
      toc.push({ title: t.slice(0, 120), depth: +hd.tagName[1] - 1, sec, toc: toc.length });
    });
    sections.push({ html: wrap.innerHTML });
  }
  return { sections, toc };
}

async function docx(blob) {
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  const d = new DOMParser().parseFromString(value, 'text/html');
  return { kind: 'flow', ...chunk(clean(d.body)) };
}

function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => `<strong>${a || b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function mdToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let para = [], list = null, i = 0;
  const flushP = () => { if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.t}>` + list.items.map((x) => `<li>${mdInline(x)}</li>`).join('') + `</${list.t}>`); list = null; } };
  while (i < lines.length) {
    const ln = lines[i];
    let m;
    if (/^```/.test(ln)) {
      flushP(); flushL();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
    } else if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) { flushP(); flushL(); out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flushP(); flushL(); out.push('<hr>'); }
    else if ((m = ln.match(/^\s*[-*+]\s+(.*)$/))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); }
    else if ((m = ln.match(/^>\s?(.*)$/))) { flushP(); flushL(); out.push('<blockquote>' + mdInline(m[1]) + '</blockquote>'); }
    else if (!ln.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(ln.trim()); }
    i++;
  }
  flushP(); flushL();
  return out.join('');
}

function plain(text, name) {
  text = text.replace(/\r\n?/g, '\n');
  if (/\.md$/i.test(name)) {
    const d = new DOMParser().parseFromString(mdToHtml(text), 'text/html');
    return { kind: 'flow', ...chunk(clean(d.body)) };
  }
  const paras = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ')) : text.split('\n');
  const html = paras.map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
  const d = new DOMParser().parseFromString(html, 'text/html');
  return { kind: 'flow', ...chunk(d.body) };
}

async function textual(blob, name) {
  const text = await blob.text();
  if (/\.html?$/i.test(name)) {
    const d = new DOMParser().parseFromString(text, 'text/html');
    return { kind: 'flow', ...chunk(clean(d.body)) };
  }
  return plain(text, name);
}

// ---------- EPUB ----------
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
const norm = (base, rel) => {
  try { return decodeURIComponent(new URL(rel, 'http://h/' + base).pathname.slice(1)); } catch { return rel; }
};
const xml = (s) => new DOMParser().parseFromString(s, 'text/xml');

export async function epubMeta(blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), { filter: (f) => /container\.xml$|\.opf$/i.test(f.name) });
  const c = xml(strFromU8(files['META-INF/container.xml']));
  const opf = xml(strFromU8(files[c.querySelector('rootfile').getAttribute('full-path')]));
  const g = (t) => opf.getElementsByTagName(t)[0]?.textContent?.trim() || '';
  return { title: g('dc:title'), author: g('dc:creator') };
}

async function epub(blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const txt = (n) => strFromU8(files[n]);
  const c = xml(txt('META-INF/container.xml'));
  const opfPath = c.querySelector('rootfile').getAttribute('full-path');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = xml(txt(opfPath));
  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach((i) => {
    manifest[i.getAttribute('id')] = { href: norm(dir, i.getAttribute('href')), type: i.getAttribute('media-type') || '', props: i.getAttribute('properties') || '' };
  });
  let spine = [...opf.querySelectorAll('spine > itemref')].map((r) => manifest[r.getAttribute('idref')]).filter((m) => m && files[m.href] && /html|xml/.test(m.type));
  if (spine.some((m) => !m.props.includes('nav'))) spine = spine.filter((m) => !m.props.includes('nav'));
  const urls = [];
  const cache = {};
  const blobUrl = (path) => {
    if (!files[path]) return null;
    if (!cache[path]) {
      cache[path] = URL.createObjectURL(new Blob([files[path]], { type: MIME[ext(path)] || 'application/octet-stream' }));
      urls.push(cache[path]);
    }
    return cache[path];
  };
  const sections = [];
  const pathToSec = {};
  for (const item of spine) {
    const d = new DOMParser().parseFromString(txt(item.href), 'text/html');
    const body = clean(d.body);
    const base = item.href.slice(0, item.href.lastIndexOf('/') + 1);
    body.querySelectorAll('img').forEach((im) => {
      const u = blobUrl(norm(base, im.getAttribute('src') || ''));
      if (u) im.setAttribute('src', u); else im.remove();
    });
    body.querySelectorAll('image').forEach((im) => {
      const k = im.getAttribute('xlink:href') ? 'xlink:href' : 'href';
      const u = blobUrl(norm(base, im.getAttribute(k) || ''));
      if (u) im.setAttribute(k, u);
    });
    const head = body.querySelector('h1,h2,h3');
    pathToSec[item.href] = sections.length;
    sections.push({ html: body.innerHTML, path: item.href, title: head?.textContent.trim().slice(0, 120) || '', empty: !body.textContent.trim() && !body.querySelector('img,svg') });
  }
  // Tabla de contenidos: nav (EPUB3) o NCX (EPUB2); si no hay, un título por capítulo.
  let toc = [];
  const navItem = Object.values(manifest).find((m) => m.props.includes('nav'));
  const ncxItem = Object.values(manifest).find((m) => m.type.includes('dtbncx'));
  const secOf = (href, baseDir) => {
    const [p, frag] = href.split('#');
    const s = pathToSec[norm(baseDir, p)];
    return s === undefined ? null : { sec: s, frag: frag || null };
  };
  try {
    if (navItem && files[navItem.href]) {
      const nd = new DOMParser().parseFromString(txt(navItem.href), 'text/html');
      const nav = nd.querySelector('nav[epub\\:type="toc"], nav[role="doc-toc"], nav') || nd.body;
      const bd = navItem.href.slice(0, navItem.href.lastIndexOf('/') + 1);
      nav.querySelectorAll('a[href]').forEach((a) => {
        const r = secOf(a.getAttribute('href'), bd);
        let depth = 0;
        for (let p = a.parentElement; p && p !== nav; p = p.parentElement) if (p.tagName === 'OL' || p.tagName === 'UL') depth++;
        if (r && a.textContent.trim()) toc.push({ title: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 120), depth: Math.max(depth - 1, 0), ...r });
      });
    } else if (ncxItem && files[ncxItem.href]) {
      const nx = xml(txt(ncxItem.href));
      const bd = ncxItem.href.slice(0, ncxItem.href.lastIndexOf('/') + 1);
      nx.querySelectorAll('navPoint').forEach((np) => {
        const r = secOf(np.querySelector('content')?.getAttribute('src') || '', bd);
        let depth = 0;
        for (let p = np.parentElement; p; p = p.parentElement) if (p.tagName === 'navPoint') depth++;
        const t = np.querySelector('navLabel > text')?.textContent.trim();
        if (r && t) toc.push({ title: t.slice(0, 120), depth, ...r });
      });
    }
  } catch { toc = []; }
  if (!toc.length) sections.forEach((s, i) => { if (!s.empty) toc.push({ title: s.title || `Sección ${i + 1}`, depth: 0, sec: i, frag: null }); });
  return { kind: 'flow', sections, toc, urls, pathToSec };
}

export async function parseDoc(book, blob) {
  if (book.format === 'docx') return docx(blob);
  if (book.format === 'epub') return epub(blob);
  return textual(blob, book.name || book.title);
}

// ---------- PDF: texto para modo lectura y búsqueda ----------
function paragraphsOf(items) {
  const lines = [];
  let cur = '', lastY = null, lastH = 10, curY = 0, curH = 10;
  const push = () => { if (cur.trim()) lines.push({ t: cur.trim(), y: curY, h: curH }); cur = ''; };
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform[5];
    const h = it.height || lastH;
    if (lastY !== null && Math.abs(y - lastY) > h * 0.5) push();
    if (!cur) { curY = y; curH = h; }
    cur += it.str;
    lastY = it.hasEOL ? null : y;
    lastH = h;
    if (it.hasEOL) push();
  }
  push();
  if (!lines.length) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) { const g = lines[i - 1].y - lines[i].y; if (g > 0) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const paras = [];
  let p = lines[0].t;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (med && gap > med * 1.35) { paras.push(p); p = lines[i].t; }
    else if (/-$/.test(p) && /^[a-záéíóúñü]/.test(lines[i].t)) p = p.slice(0, -1) + lines[i].t;
    else p += ' ' + lines[i].t;
  }
  paras.push(p);
  return paras;
}

export async function extractPdfTexts(pdf, onProgress) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(paragraphsOf(tc.items));
    page.cleanup();
    if (onProgress && i % 5 === 0) onProgress(i / pdf.numPages);
  }
  return pages;
}

export function pdfTextSections(pages) {
  return pages.map((paras) => ({ html: paras.map((p) => `<p>${esc(p)}</p>`).join('') }));
}
