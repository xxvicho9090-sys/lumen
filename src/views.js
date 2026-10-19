import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyHl, removeHl, restyleHl } from './anchors.js';
import { fold } from './parse.js';
import { settings, saveSettings, themeOf } from './settings.js';

const snip = (s, i, len) => {
  const a = Math.max(0, i - 36);
  return (a > 0 ? '…' : '') + s.slice(a, i + len + 60).replace(/\s+/g, ' ');
};


export async function pdfOutline(pdf) {
  const out = [];
  try {
    const o = await pdf.getOutline();
    if (!o) return out;
    const walk = async (items, d) => {
      for (const it of items) {
        if (out.length > 400) return;
        let page = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest)) page = await pdf.getPageIndex(dest[0]);
        } catch { /* destino roto */ }
        if (page != null && it.title) out.push({ title: it.title.trim().slice(0, 120), depth: d, page, sec: page });
        if (it.items?.length && d < 2) await walk(it.items, d + 1);
      }
    };
    await walk(o, 0);
  } catch { /* sin índice */ }
  return out;
}

function flashMark(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}

// ---------- Texto que fluye (Word, EPUB, TXT y PDF en modo texto) ----------
export class FlowView {
  constructor(app, book, data, opts = {}) {
    this.app = app;
    this.book = book;
    this.data = data;
    this.kind = 'flow';
    this.paged = !!opts.labels; // PDF en modo texto: una sección por página
    this.toc = data.toc || [];
    this.el = document.createElement('div');
    this.el.className = 'view flow';
    const doc = document.createElement('div');
    doc.className = 'doc';
    doc.lang = 'es';
    this.secs = [];
    data.sections.forEach((s, i) => {
      if (opts.labels) {
        const l = document.createElement('div');
        l.className = 'pglabel';
        l.textContent = `Página ${i + 1}`;
        doc.append(l);
      }
      const sec = document.createElement('section');
      sec.className = 'rt';
      sec.dataset.sec = i;
      sec.innerHTML = s.html;
      doc.append(sec);
      this.secs.push(sec);
    });
    this.el.append(doc);
    this.el.addEventListener('scroll', () => { this.lastScroll = Date.now(); app.onScroll(this); }, { passive: true });
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  roots() { return this.secs; }
  applyAll() { for (const h of this.app.hls(this.book.id)) this.addHl(h); }
  addHl(h) { const r = this.secs[h.sec]; if (r) applyHl(r, h); }
  rmHl(id) { removeHl(this.secs, id); }
  styleHl(h) { restyleHl(this.secs, h); }

  ratio() {
    const m = this.el.scrollHeight - this.el.clientHeight;
    return m > 0 ? this.el.scrollTop / m : 0;
  }
  seek(r) { this.el.scrollTop = r * Math.max(this.el.scrollHeight - this.el.clientHeight, 0); }

  page() {
    const y = this.el.scrollTop + 12;
    let lo = 0, hi = this.secs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.secs[mid].offsetTop <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }
  label() {
    return this.paged ? `Pág. ${this.page() + 1} de ${this.secs.length}` : `${Math.round(this.ratio() * 100)} %`;
  }
  getPos() { return { ratio: this.ratio(), page: this.page() }; }
  setPos(p) {
    if (!p) return;
    const apply = () => {
      if (this.paged && p.page != null && p.ratio == null) this.gotoPage(p.page);
      else if (p.ratio != null) this.seek(p.ratio);
      else if (p.page != null) this.gotoPage(p.page);
    };
    apply();
    // Las imágenes cargan después y cambian el alto: se reajusta una vez si la persona no se movió.
    const y = this.el.scrollTop;
    setTimeout(() => { if (Math.abs(this.el.scrollTop - y) < 4) apply(); }, 700);
  }

  scrollToEl(el, center) {
    const er = this.el.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    this.el.scrollTop += r.top - er.top - (center ? er.height / 2 - r.height / 2 : 10);
  }
  gotoPage(i) { const s = this.secs[i]; if (s) this.scrollToEl(s, false); }
  gotoToc(item) {
    let el = null;
    if (item.toc !== undefined) el = this.el.querySelector(`[data-toc="${item.toc}"]`);
    else if (item.frag) { try { el = this.secs[item.sec]?.querySelector('#' + CSS.escape(item.frag)); } catch { /* id raro */ } }
    el ||= this.secs[item.sec];
    if (el) this.scrollToEl(el, false);
  }
  gotoHl(h) {
    const m = this.secs[h.sec]?.querySelector(`mark[data-hid="${h.id}"]`);
    if (!m) { this.gotoPage(h.sec); return; }
    this.scrollToEl(m, true);
    flashMark(m);
  }

  onClick(e) {
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (this.data.pathToSec && !/^[a-z]+:/i.test(href)) {
        const sec = a.closest('section');
        const base = (sec?.dataset.sec != null ? this.data.sections[sec.dataset.sec].path : '') || '';
        const [p, frag] = href.split('#');
        const path = p ? decodeURIComponent(new URL(p, 'http://h/' + base).pathname.slice(1)) : base;
        const s = this.data.pathToSec[path];
        if (s !== undefined) this.gotoToc({ sec: s, frag });
      }
      return;
    }
    const m = e.target.closest('mark.hl');
    if (m && getSelection().isCollapsed) this.app.editHl(m.dataset.hid, m);
  }

  search(q) {
    const fq = fold(q);
    const out = [];
    for (let si = 0; si < this.secs.length; si++) {
      const w = document.createTreeWalker(this.secs[si], NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const f = fold(n.data);
        let i = -1;
        while ((i = f.indexOf(fq, i + 1)) !== -1) {
          const node = n, at = i;
          out.push({ label: this.paged ? `Pág. ${si + 1}` : '', snippet: snip(n.data, i, q.length), go: () => this.flashText(node, at, q.length) });
          if (out.length >= 200) return out;
        }
      }
    }
    return out;
  }
  flashText(node, at, len) {
    if (!node.isConnected) return;
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, Math.min(at + len, node.data.length));
    this.scrollToEl(node.parentElement, true);
    try {
      CSS.highlights.set('flash', new Highlight(r));
      setTimeout(() => CSS.highlights.delete('flash'), 2000);
    } catch { /* sin CSS Highlight API */ }
  }

  // Zoom con los dedos: en texto que fluye cambia el tamaño de letra.
  zoomValue() { return settings.size; }
  pinchStart(st) { st.r = this.ratio(); }
  pinchMove(st) {
    const z = Math.min(Math.max(Math.round(st.base * st.s), 12), 44);
    if (z === st.z) return;
    st.z = z;
    cancelAnimationFrame(st.raf);
    st.raf = requestAnimationFrame(() => { document.documentElement.style.setProperty('--fs', z + 'px'); this.seek(st.r); });
    this.app.hud?.(`${z} px`);
  }
  pinchEnd(st) { if (st.z != null) saveSettings({ size: st.z }); }

  suspend() {}
  resume() {}
  relayout() {}
  destroy() {
    (this.data.urls || []).forEach((u) => URL.revokeObjectURL(u));
    this.el.remove();
  }
}

// ---------- PDF con la página original ----------
export class PdfPageView {
  static async create(app, book, pdf) {
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    first.cleanup();
    return new PdfPageView(app, book, pdf, vp.height / vp.width);
  }

  constructor(app, book, pdf, ratio) {
    this.app = app;
    this.book = book;
    this.pdf = pdf;
    this.kind = 'pdf';
    this.ratio_ = ratio;
    this.paged = true;
    this.toc = [];
    this.q = [];
    this.busy = 0;
    this.off = false;
    this.el = document.createElement('div');
    this.el.className = 'view pdfv';
    this.wrap = document.createElement('div');
    this.wrap.className = 'pages';
    this.pgs = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const pg = document.createElement('div');
      pg.className = 'pg';
      pg.dataset.p = i;
      this.wrap.append(pg);
      this.pgs.push(pg);
    }
    this.el.append(this.wrap);
    this.io = new IntersectionObserver((es) => {
      for (const en of es) {
        const i = +en.target.dataset.p;
        const pg = this.pgs[i];
        pg._vis = en.isIntersecting;
        if (en.isIntersecting) { if (!this.off && !pg._on) { this.q.push(i); this.pump(); } } else this.drop(i);
      }
    }, { root: this.el, rootMargin: '200% 0px' });
    this.el.addEventListener('scroll', () => { this.lastScroll = Date.now(); app.onScroll(this); }, { passive: true });
    this.el.addEventListener('click', (e) => {
      const m = e.target.closest('mark.hl');
      if (m && getSelection().isCollapsed) app.editHl(m.dataset.hid, m);
    });
    this.lastW = 0;
    this.ro = new ResizeObserver(() => {
      const w = this.el.clientWidth;
      if (w > 0 && Math.abs(w - this.lastW) > 2) { clearTimeout(this._rt); this._rt = setTimeout(() => this.relayout(), 120); }
    });
    this.ro.observe(this.el);
    pdfOutline(pdf).then((t) => { this.toc = t; });
    this.prefetch();
  }

  // Medidas reales de todas las páginas (sin dibujarlas): así el alto no cambia al aparecer cada una y el scroll no da saltos.
  async prefetch() {
    this.ratios = [];
    for (let i = 0; i < this.pgs.length && !this.dead; i++) {
      try {
        const page = await this.pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        page.cleanup();
        this.ratios[i] = vp.height / vp.width;
        const pg = this.pgs[i];
        if (this.pw && !pg._on && !pg.firstChild) pg.style.height = Math.round(this.pw * this.ratios[i]) + 'px';
      } catch { /* página dañada */ }
      if (i % 6 === 5) await new Promise((r) => setTimeout(r, 30));
    }
  }

  // Espera a que se detenga el desplazamiento antes de hacer trabajo pesado en el hilo principal.
  async whenIdle() {
    for (let k = 0; k < 40 && Date.now() - (this.lastScroll || 0) < 160; k++) await new Promise((r) => setTimeout(r, 80));
  }

  width() {
    const avail = Math.max(this.el.clientWidth - 12, 240);
    return Math.round(Math.min(avail, 1000) * (this.book.zoom ?? settings.pdfZoom));
  }

  // Calcula el tamaño de las páginas y empieza a dibujar las visibles.
  relayout(skipPos) {
    const w = this.el.clientWidth;
    if (!w) return;
    const pos = this.getPos();
    this.lastW = w;
    this.pw = this.width();
    this.pgs.forEach((pg, i) => {
      this.drop(i);
      pg.style.width = this.pw + 'px';
      pg.style.height = Math.round(this.pw * (this.ratios?.[i] ?? this.ratio_)) + 'px';
      this.io.unobserve(pg);
    });
    this.pgs.forEach((pg) => this.io.observe(pg));
    if (this.started && !skipPos) this.setPos(pos); else this.started = true;
  }

  pump() {
    while (this.busy < 2 && this.q.length) {
      const i = this.q.shift();
      if (!this.pgs[i]._vis) continue;
      this.busy++;
      this.render(i).finally(() => { this.busy--; this.pump(); });
    }
  }

  async render(i) {
    const pg = this.pgs[i];
    if (pg._on || this.off) return;
    pg._on = true;
    const tok = (pg._tok = (pg._tok || 0) + 1);
    const alive = () => pg._on && pg._tok === tok;
    try {
      const page = await this.pdf.getPage(i + 1);
      if (!alive()) return;
      const base = page.getViewport({ scale: 1 });
      const scale = this.pw / base.width;
      const vp = page.getViewport({ scale });
      pg.style.width = Math.round(vp.width) + 'px';
      pg.style.height = Math.round(vp.height) + 'px';
      pg.style.setProperty('--scale-factor', scale);
      pg.style.setProperty('--total-scale-factor', scale);
      // Límite de píxeles por página para no agotar la memoria con zoom alto.
      const dpr = Math.max(Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16e6 / (vp.width * vp.height))), 0.6);
      const cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width * dpr);
      cv.height = Math.floor(vp.height * dpr);
      cv.style.width = vp.width + 'px';
      cv.style.height = vp.height + 'px';
      // El fondo del tema se pinta una sola vez en el canvas (sin mezclas de capas durante el scroll).
      const th = themeOf();
      const dark = th === 'noche' || th === 'oled';
      const paper = { papel: '#F6F1E7', sepia: '#E9D9B8' }[th] || '#ffffff';
      pg._task = page.render({ canvasContext: cv.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }), background: dark ? '#ffffff' : paper });
      await pg._task.promise;
      if (!alive()) return;
      let shown = cv;
      if (dark) {
        // Modo noche: la inversión de colores se hornea una vez; así el scroll no recalcula filtros en cada cuadro.
        const t = document.createElement('canvas');
        t.width = cv.width; t.height = cv.height;
        t.style.width = cv.style.width; t.style.height = cv.style.height;
        const tc = t.getContext('2d');
        if ('filter' in tc) { tc.filter = 'invert(0.9) hue-rotate(180deg)'; tc.drawImage(cv, 0, 0); cv.width = cv.height = 0; shown = t; } else cv.classList.add('cssinv');
      }
      pg.replaceChildren(shown);
      await this.whenIdle();
      if (!alive()) return;
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      tl.dataset.sec = i;
      pg.append(tl);
      pg._tl = new TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      await pg._tl.render();
      if (!alive()) return;
      for (const h of this.app.hls(this.book.id)) if (h.sec === i) applyHl(tl, h);
      page.cleanup();
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('pdf página', i, e);
      pg._on = false;
    }
  }

  drop(i) {
    const pg = this.pgs[i];
    if (!pg._on && !pg.firstChild) return;
    pg._on = false;
    pg._tok = (pg._tok || 0) + 1;
    try { pg._task?.cancel(); pg._tl?.cancel(); } catch { /* ya terminó */ }
    pg._task = pg._tl = null;
    pg.replaceChildren();
  }

  roots() { return [...this.el.querySelectorAll('.textLayer')]; }
  applyAll() { for (const h of this.app.hls(this.book.id)) this.addHl(h); }
  addHl(h) { const r = this.pgs[h.sec]?.querySelector('.textLayer'); if (r) applyHl(r, h); }
  rmHl(id) { removeHl(this.roots(), id); }
  styleHl(h) { restyleHl(this.roots(), h); }

  page() {
    const y = this.el.scrollTop + 8;
    let lo = 0, hi = this.pgs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pgs[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  ratio() { return this.pgs.length > 1 ? this.page() / (this.pgs.length - 1) : 0; }
  label() { return `Pág. ${this.page() + 1} de ${this.pgs.length}`; }
  getPos() {
    const p = this.page();
    const pg = this.pgs[p];
    const frac = pg.offsetHeight ? Math.min(Math.max((this.el.scrollTop + 8 - pg.offsetTop) / pg.offsetHeight, 0), 1) : 0;
    return { page: p, frac, ratio: this.ratio() };
  }
  setPos(p) {
    if (!p) return;
    const i = p.page != null ? p.page : Math.round((p.ratio || 0) * (this.pgs.length - 1));
    const pg = this.pgs[Math.min(Math.max(i, 0), this.pgs.length - 1)];
    this.el.scrollTop = pg.offsetTop + (p.frac || 0) * pg.offsetHeight - 8;
  }
  seek(r) { this.gotoPage(Math.round(r * (this.pgs.length - 1))); }
  gotoPage(i) { const pg = this.pgs[i]; if (pg) this.el.scrollTop = pg.offsetTop - 6; }
  gotoToc(item) { this.gotoPage(item.page); }
  gotoHl(h) {
    this.gotoPage(h.sec);
    let tries = 0;
    const t = setInterval(() => {
      const m = this.pgs[h.sec]?.querySelector(`mark[data-hid="${h.id}"]`);
      if (m) { clearInterval(t); this.el.scrollTop += m.getBoundingClientRect().top - this.el.getBoundingClientRect().top - this.el.clientHeight / 3; flashMark(m); }
      else if (++tries > 20) clearInterval(t);
    }, 100);
  }

  async search(q) {
    const texts = await this.app.pdfTexts(this.book, this.pdf);
    const fq = fold(q);
    const out = [];
    for (let p = 0; p < texts.length; p++) {
      const t = texts[p].join(' ');
      const f = fold(t);
      let i = -1;
      while ((i = f.indexOf(fq, i + 1)) !== -1) {
        out.push({ label: `Pág. ${p + 1}`, snippet: snip(t, i, q.length), go: () => this.gotoPage(p) });
        if (out.length >= 200) return out;
      }
    }
    return out;
  }

  // Zoom con los dedos: se escala la vista mientras se pellizca y al soltar se redibuja nítida.
  zoomValue() { return this.book.zoom ?? settings.pdfZoom; }
  pinchStart(st) {
    this.wrap.style.transformOrigin = `${this.el.scrollLeft + st.cx}px ${this.el.scrollTop + st.cy}px`;
    this.wrap.style.willChange = 'transform';
  }
  pinchMove(st) {
    st.z = Math.min(Math.max(st.base * st.s, 0.5), 4);
    this.wrap.style.transform = `scale(${st.z / st.base})`;
    this.app.hud?.(`${Math.round(st.z * 100)} %`);
  }
  pinchEnd(st) {
    this.wrap.style.transform = '';
    this.wrap.style.willChange = '';
    if (st.z == null || Math.abs(st.z - st.base) < 0.02) return;
    const sl = this.el.scrollLeft, stp = this.el.scrollTop, old = this.pw;
    this.book.zoom = Math.round(st.z * 100) / 100;
    this.app.saveBook?.(this.book);
    this.relayout(true);
    const r = this.pw / old;
    this.el.scrollTop = (stp + st.cy) * r - st.cy;
    this.el.scrollLeft = (sl + st.cx) * r - st.cx;
  }

  suspend() {
    this.off = true;
    this.q = [];
    this.pgs.forEach((_, i) => this.drop(i));
  }
  resume() {
    this.off = false;
    if (!this.el.clientWidth) return;
    if (!this.started || Math.abs(this.el.clientWidth - this.lastW) > 2) { this.relayout(); return; }
    this.pgs.forEach((pg) => { this.io.unobserve(pg); this.io.observe(pg); });
  }
  destroy() {
    this.dead = true;
    this.suspend();
    this.io.disconnect();
    this.ro.disconnect();
    this.pdf.destroy?.();
    this.el.remove();
  }
}
