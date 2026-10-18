// Subrayado anclado al texto.
// Cada subrayado se guarda como posición de caracteres (sin contar espacios) dentro de una
// "sección" (capítulo, página PDF…) más la cita textual. Al dibujarlo se envuelve la letra
// misma en <mark> dentro del DOM: así se mueve con el texto y nunca "baja" ni se desplaza,
// aunque cambie el tamaño de letra, el ancho de pantalla o se vuelva a dibujar la página.
const strip = (s) => s.replace(/\s/g, '');
const WS = /\s/;

function idxIn(root, node, off) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, off);
  return strip(r.toString()).length;
}

// Convierte la selección del usuario en anclas (una por sección que toque).
export function anchorsFromRange(range, roots) {
  const out = [];
  for (const root of roots) {
    if (!range.intersectsNode(root)) continue;
    const r = range.cloneRange();
    if (!root.contains(r.startContainer)) r.setStart(root, 0);
    if (!root.contains(r.endContainer)) r.setEnd(root, root.childNodes.length);
    const t = r.toString();
    const quote = strip(t);
    if (!quote) continue;
    const s = idxIn(root, r.startContainer, r.startOffset);
    out.push({ sec: +root.dataset.sec, s, e: s + quote.length, quote, text: t.replace(/\s+/g, ' ').trim().slice(0, 600) });
  }
  return out;
}

function rawOffset(d, k, end) {
  if (end && k === 0) return 0;
  let c = 0;
  for (let i = 0; i < d.length; i++) {
    if (WS.test(d[i])) continue;
    if (!end && c === k) return i;
    c++;
    if (end && c === k) return i + 1;
  }
  return d.length;
}

export function applyHl(root, h) {
  if (root.querySelector(`mark[data-hid="${h.id}"]`)) return true;
  const full = strip(root.textContent);
  let s = h.s, e = h.e;
  if (full.slice(s, e) !== h.quote) {
    let best = -1, i = -1;
    while ((i = full.indexOf(h.quote, i + 1)) !== -1) if (best < 0 || Math.abs(i - h.s) < Math.abs(best - h.s)) best = i;
    if (best < 0) return false;
    s = best; e = best + h.quote.length;
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segs = [];
  let pos = 0, n;
  while ((n = w.nextNode())) {
    const len = strip(n.data).length;
    if (len && pos < e && pos + len > s) segs.push({ n, a: Math.max(s - pos, 0), b: Math.min(e - pos, len) });
    pos += len;
    if (pos >= e) break;
  }
  for (const g of segs) {
    const r = document.createRange();
    r.setStart(g.n, rawOffset(g.n.data, g.a, false));
    r.setEnd(g.n, rawOffset(g.n.data, g.b, true));
    const m = document.createElement('mark');
    m.className = 'hl' + (h.note ? ' note' : '');
    m.dataset.hid = h.id;
    m.dataset.c = h.color;
    r.surroundContents(m);
  }
  return segs.length > 0;
}

export function removeHl(roots, id) {
  for (const root of roots) {
    for (const m of root.querySelectorAll(`mark[data-hid="${id}"]`)) {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      m.remove();
      p.normalize();
    }
  }
}

export function restyleHl(roots, h) {
  for (const root of roots) {
    for (const m of root.querySelectorAll(`mark[data-hid="${h.id}"]`)) {
      m.dataset.c = h.color;
      m.classList.toggle('note', !!h.note);
    }
  }
}
