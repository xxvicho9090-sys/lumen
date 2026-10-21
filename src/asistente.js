// Interfaz de la IA de Lumen: estado y ajustes (Ollama + IA dentro de la app), resumir, preguntar al documento y explicar lo seleccionado.
import * as AI from './ai.js';

let C; // utilidades de app.js: { h, modal, toast, activeView, pdfTexts, captureRead, fold, I }
export const initAsistente = (ctx) => { C = ctx; };

let sop = null; // soporte de WebGPU, se consulta una vez
const soporte = () => (sop ||= AI.soporte());

// ---- Texto del documento ----
async function paginasDe(v) {
  if (v.kind === 'pdf') { const t = await C.pdfTexts(v.book, v.pdf); return { tx: t.map((p) => p.join(' ')), etq: (i) => `pág. ${i + 1}` }; }
  return { tx: v.secs.map((s) => s.textContent), etq: (i) => (v.paged ? `pág. ${i + 1}` : `sec. ${i + 1}`) };
}
async function textoVisible(v) {
  if (v.kind === 'pdf') { const { tx } = await paginasDe(v); return { texto: tx[v.page()] || '', etq: `pág. ${v.page() + 1}` }; }
  if (v.paged) { const i = v.page(); return { texto: v.secs[i]?.textContent || '', etq: `pág. ${i + 1}` }; }
  const vr = v.el.getBoundingClientRect();
  const partes = [];
  for (const el of v.el.querySelectorAll('.doc p, .doc li, .doc h1, .doc h2, .doc h3, .doc blockquote')) {
    const r = el.getBoundingClientRect();
    if (r.bottom < vr.top || r.top > vr.bottom) continue;
    const t = el.textContent.trim();
    if (t) partes.push(t);
  }
  return { texto: partes.join('\n'), etq: v.label() };
}
const sinTexto = (v) => (v.kind === 'pdf' ? 'Este PDF es una imagen escaneada (sin texto): la IA no puede leerlo.' : 'No encontré texto en esta parte del documento.');

// ---- Estado y ajustes de la IA ----
function linea() {
  const o = AI.estadoOllama(), e = AI.estado();
  if (o.ok) return { ok: true, t: `Lista · Ollama (${o.modelo})` };
  if (e.fase === 'listo') return { ok: true, t: 'Lista · IA de la app' };
  if (e.fase === 'bajando') return { ok: false, t: `Descargando la IA de la app… ${Math.round(e.f * 100)} %` };
  return { ok: false, t: 'Sin IA lista todavía' };
}

function ajustes() {
  const { h, toast } = C;
  const cont = h('div', { class: 'ai-set' });
  const pintar = async () => {
    const o = AI.estadoOllama(), e = AI.estado(), cfg = AI.getOllama(), s = await soporte();
    const filas = [];
    // Ollama
    const url = h('input', { class: 'sbox', value: cfg.url, 'aria-label': 'Dirección de Ollama', spellcheck: 'false' });
    url.onchange = () => { AI.setOllama({ url: url.value }); AI.detectarOllama(true); };
    filas.push(h('div', { class: 'ai-card' },
      h('div', { class: 'ai-h' }, h('b', {}, 'Ollama (tu computador)'), h('span', { class: 'ai-pill ' + (o.ok ? 'ok' : '') }, o.ok ? 'Detectado' : cfg.apagada ? 'Apagado' : 'No detectado')),
      h('div', { class: 'sub' }, o.ok ? `Modelo: ${o.modelo}. Gratis, privado y sin límites.` : 'Se detecta solo cuando Ollama está abierto en este computador (ollama.com, luego “ollama pull qwen2.5:7b”).'),
      url,
      h('div', { class: 'acts ai-acts' },
        h('button', { class: 'btn ghost', onclick: async () => { AI.setOllama({ url: url.value }); toast((await AI.detectarOllama(true)) ? 'Ollama detectado' : 'No encontré Ollama en esa dirección'); } }, 'Buscar de nuevo'),
        h('button', { class: 'btn ghost', onclick: () => { AI.setOllama({ apagada: !cfg.apagada }); AI.detectarOllama(true); } }, cfg.apagada ? 'Volver a usar' : 'No usar'))));
    // IA dentro de la app
    const acc = [];
    if (e.fase === 'bajando') acc.push(h('button', { class: 'btn ghost', onclick: AI.detenerDescarga }, 'Pausar'));
    else if (e.fase === 'listo') acc.push(h('button', { class: 'btn ghost', onclick: () => { if (confirm('¿Borrar la IA de la app? Ocupa ' + AI.TAMANO + ' y se puede volver a bajar.')) AI.borrarLocal(); } }, 'Borrar'));
    else if (s.ok) acc.push(h('button', { class: 'btn', onclick: () => { AI.setRechazo(false); AI.descargarLocal(); } }, e.fase === 'pausada' ? 'Reanudar descarga' : e.fase === 'error' ? 'Reintentar' : `Descargar (${AI.TAMANO})`));
    const nota = e.pregunta ? ({ datos: 'Estás con datos móviles: no la bajé sola. ', memoria: 'Este dispositivo tiene poca memoria: no la bajé sola. ', espacio: 'Hay poco espacio libre: no la bajé sola. ' })[e.pregunta] : '';
    filas.push(h('div', { class: 'ai-card' },
      h('div', { class: 'ai-h' }, h('b', {}, 'IA dentro de la app'), h('span', { class: 'ai-pill ' + (e.fase === 'listo' ? 'ok' : '') }, ({ listo: 'Lista', bajando: 'Descargando', pausada: 'En pausa', error: 'Error', inicio: s.ok ? 'Sin descargar' : 'No compatible' })[e.fase])),
      h('div', { class: 'sub' }, s.ok ? `${nota}Funciona sin internet y sin cuentas, en este dispositivo. Se descarga una sola vez.${s.aviso ? ' ' + s.aviso : ''}` : s.motivo),
      e.fase === 'bajando' ? h('div', { class: 'ai-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(e.f * 100)) }, h('i', { style: `width:${Math.round(e.f * 100)}%` })) : null,
      e.fase === 'bajando' ? h('div', { class: 'sub ai-prog' }, e.texto) : null,
      e.fase === 'error' ? h('div', { class: 'sub', style: 'color:var(--bad)' }, e.error) : null,
      acc.length ? h('div', { class: 'acts ai-acts' }, acc) : null));
    // Descarga sola
    const tg = h('button', { class: 'toggle' + (AI.getAuto() ? ' on' : ''), role: 'switch', 'aria-checked': String(AI.getAuto()), 'aria-label': 'Descargar sola en segundo plano', onclick: () => { AI.setAuto(!AI.getAuto()); pintar(); } });
    filas.push(h('div', { class: 'row2' }, h('div', {}, h('div', {}, 'Descargar la IA de la app sola'), h('div', { class: 'sub' }, 'La primera vez que abres Lumen, si el dispositivo la soporta.')), tg));
    cont.replaceChildren(...filas);
  };
  pintar();
  const off = AI.suscribir(pintar);
  return { el: cont, off };
}

// ---- Asistente: resumir y preguntar ----
export function abrirAsistente(inicial = 'resumir') {
  const { h, modal, toast, activeView, I } = C;
  const v = activeView();
  return modal((box, close) => {
    box.classList.add('ai');
    let tab = v ? inicial : 'ajustes';
    let ac = null;
    const hist = [];
    const est = h('div', { class: 'ai-est' });
    const cuerpo = h('div', { class: 'ai-body' });
    const tabs = h('div', { class: 'tabs ai-tabs', role: 'tablist' });
    const pintaEst = () => { const l = linea(); est.replaceChildren(h('span', { class: 'ai-dot' + (l.ok ? ' ok' : '') }), l.t); };
    pintaEst();
    const offEst = AI.suscribir(pintaEst);
    let offAj = null;
    box._onClose = () => { ac?.abort(); offEst(); offAj?.(); };
    const falla = (e) => (e?.name === 'AbortError' ? null : (e?.message || 'No pude usar la IA.'));

    const vistaResumen = () => {
      const out = h('div', { class: 'ai-out', 'aria-live': 'polite' }, h('div', { class: 'sub' }, 'Elige qué quieres resumir. Funciona con el texto del documento, sin salir de tu dispositivo.'));
      const ir = async (modo) => {
        ac?.abort(); ac = new AbortController();
        out.replaceChildren(h('div', { class: 'sub ai-wait' }, 'La IA está leyendo…'));
        try {
          let texto = '', etq = '';
          if (modo === 'leido') { const cap = await C.captureRead(v); texto = cap.text; etq = cap.label; } else ({ texto, etq } = await textoVisible(v));
          if (texto.replace(/\s/g, '').length < 80) { out.replaceChildren(h('div', { class: 'sub' }, sinTexto(v))); return; }
          const r = await AI.resumir(texto.slice(0, 9000), ac.signal);
          out.replaceChildren(h('div', { class: 'sub' }, `Resumen de ${etq}`), h('div', { class: 'ai-txt' }, r.trim()), h('div', { class: 'acts ai-acts' }, h('button', { class: 'btn ghost', onclick: () => { C.copy?.(r.trim()); toast('Resumen copiado'); } }, 'Copiar')));
        } catch (e) { const m = falla(e); if (m) out.replaceChildren(h('div', { class: 'notice' }, m)); }
      };
      return h('div', {}, h('div', { class: 'chips' }, h('button', { class: 'chip', onclick: () => ir('aqui') }, 'Esta página / lo que ves'), h('button', { class: 'chip', onclick: () => ir('leido') }, 'Lo que leí en este bloque')), out);
    };

    const vistaPreguntar = () => {
      const log = h('div', { class: 'ai-log', 'aria-live': 'polite' }, h('div', { class: 'sub' }, `Pregúntale lo que quieras a “${v.book.title}”. Responde solo con lo que dice el documento y te indica la página.`));
      const inp = h('input', { class: 'sbox', placeholder: 'Escribe tu pregunta…', 'aria-label': 'Pregunta sobre el documento' });
      const enviar = async () => {
        const q = inp.value.trim();
        if (!q) return;
        inp.value = ''; inp.disabled = true;
        ac?.abort(); ac = new AbortController();
        log.append(h('div', { class: 'ai-q' }, q));
        const espera = h('div', { class: 'sub ai-wait' }, 'Buscando en el documento…');
        log.append(espera); log.scrollTop = log.scrollHeight;
        try {
          const { tx, etq } = await paginasDe(v);
          if (tx.every((t) => !t.trim())) throw new AI.AiError('sin', sinTexto(v));
          const ps = AI.pasajesPara(q, tx, C.fold);
          const r = await AI.responder(q, ps.map((p) => `[${etq(p.i)}] ${p.tx}`).join('\n\n'), hist, ac.signal);
          hist.push({ role: 'user', content: q }, { role: 'assistant', content: r.trim() });
          const pags = [...new Set(ps.map((p) => p.i))];
          espera.replaceWith(h('div', { class: 'ai-a' }, h('div', { class: 'ai-txt' }, r.trim()),
            h('div', { class: 'chips ai-src' }, h('span', { class: 'sub' }, 'Buscado en:'), ...pags.slice(0, 6).map((i) => h('button', { class: 'chip', onclick: () => { close(null); v.gotoPage(i); } }, etq(i))))));
        } catch (e) { const m = falla(e); if (m) espera.replaceWith(h('div', { class: 'notice' }, m)); else espera.remove(); }
        inp.disabled = false; inp.focus(); log.scrollTop = log.scrollHeight;
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
      return h('div', {}, log, h('div', { class: 'ai-ask' }, inp, h('button', { class: 'btn', onclick: enviar }, 'Preguntar')));
    };

    const vistaAjustes = () => { const a = ajustes(); offAj?.(); offAj = a.off; return a.el; };
    const pinta = () => {
      offAj?.(); offAj = null;
      tabs.replaceChildren(...[['resumir', 'Resumir'], ['preguntar', 'Preguntar'], ['ajustes', 'Ajustes de IA']]
        .filter(([k]) => v || k === 'ajustes')
        .map(([k, t]) => h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', onclick: () => { ac?.abort(); tab = k; pinta(); } }, t)));
      cuerpo.replaceChildren(tab === 'resumir' ? vistaResumen() : tab === 'preguntar' ? vistaPreguntar() : vistaAjustes());
    };
    pinta();
    box.append(h('h3', {}, h('span', { html: I.spark }), ' Asistente de IA'), est, tabs, cuerpo,
      h('div', { class: 'acts' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cerrar')));
  });
}

// ---- Explicar lo seleccionado ----
export async function explicarSeleccion(texto, v) {
  const { h, modal, toast, I } = C;
  let ac = null;
  return modal(async (box, close) => {
    box.classList.add('ai');
    const out = h('div', { class: 'ai-out', 'aria-live': 'polite' }, h('div', { class: 'sub ai-wait' }, 'La IA está pensando…'));
    box._onClose = () => ac?.abort();
    box.append(h('h3', {}, h('span', { html: I.spark }), ' Explicar'), h('blockquote', { class: 'ai-cita' }, texto.length > 400 ? texto.slice(0, 400) + '…' : texto), out,
      h('div', { class: 'acts' }, h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cerrar')));
    ac = new AbortController();
    try {
      let ctx = '';
      if (v) {
        const { tx } = await paginasDe(v);
        const clave = C.fold(texto.replace(/\s+/g, ' ').slice(0, 40));
        const pg = tx.find((t) => C.fold(t.replace(/\s+/g, ' ')).includes(clave));
        ctx = (pg || '').replace(/\s+/g, ' ').slice(0, 1800);
      }
      const r = await AI.explicar(texto.slice(0, 1500), ctx, ac.signal);
      out.replaceChildren(h('div', { class: 'ai-txt' }, r.trim()));
    } catch (e) { if (e?.name !== 'AbortError') out.replaceChildren(h('div', { class: 'notice' }, e?.message || 'No pude usar la IA.'), h('button', { class: 'btn ghost', onclick: () => { close(null); abrirAsistente('ajustes'); } }, 'Ver ajustes de IA')); }
  });
}
