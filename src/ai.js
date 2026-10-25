// IA de Lumen, siempre disponible y sin cuentas ni claves:
//  1) Ollama del computador: se detecta sola cuando está abierto (gratis, privada, sin límites).
//  2) IA dentro de la app (WebLLM, Llama 3.2 3B): se descarga sola una vez y corre en el dispositivo, sin internet después.
// Si una falla, se usa la otra. Todo queda en este dispositivo.
const MIN = 60 * 1000;
const SOLO_ESPANOL = '\n\nIMPORTANTE: responde únicamente en español (alfabeto latino), sin otros idiomas ni caracteres extraños.';
export const MODELO = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';
export const TAMANO = '≈ 2 GB';
export const ESPACIO_MIN_GB = 3.5;
const PREF = [/qwen2\.5.*(32b|14b|7b)/, /llama3\.[123]/, /gemma[23]/, /qwen|mistral|phi/];
const MAX_CHARS = { ollama: 9000, local: 6500 };

export class AiError extends Error { constructor(code, message) { super(message); this.code = code; } }

const ls = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

// ---- Estado compartido (el panel de IA y el asistente muestran lo mismo) ----
// fase de la IA dentro de la app: inicio | bajando | pausada | error | listo ; pregunta: '' | datos | memoria | espacio
let est = { fase: ls.get('lumen.ai.local') === 'listo' ? 'listo' : 'inicio', f: 0, texto: '', error: '', auto: false, pregunta: '' };
const subs = new Set();
const set = (p) => { est = { ...est, ...p }; subs.forEach((f) => f()); };
export const estado = () => est;
export const suscribir = (f) => { subs.add(f); return () => subs.delete(f); };
export const localListo = () => est.fase === 'listo';

// ---- Ajustes ----
export const getOllama = () => ({ url: (ls.get('lumen.ai.ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, ''), modelo: ls.get('lumen.ai.ollamaModel'), apagada: ls.get('lumen.ai.ollamaOff') === '1' });
export const setOllama = ({ url, modelo, apagada }) => {
  if (url !== undefined) ls.set('lumen.ai.ollamaUrl', String(url || '').trim());
  if (modelo !== undefined) ls.set('lumen.ai.ollamaModel', String(modelo || '').trim());
  if (apagada !== undefined) ls.set('lumen.ai.ollamaOff', apagada ? '1' : '');
  det = { ok: false, modelo: '', modelos: [], hasta: 0 };
};
export const getAuto = () => ls.get('lumen.ai.auto') !== '0';
export const setAuto = (v) => ls.set('lumen.ai.auto', v ? '' : '0');
const rechazo = () => ls.get('lumen.ai.no') === '1';
export const setRechazo = (v) => ls.set('lumen.ai.no', v ? '1' : '');

// ---- Ollama: detección automática ----
let det = { ok: false, modelo: '', modelos: [], hasta: 0 };
export const estadoOllama = () => det;
const mejor = (nombres) => { for (const r of PREF) { const m = nombres.find((n) => r.test(n)); if (m) return m; } return nombres[0] || ''; };
export async function detectarOllama(forzar = false) {
  const ahora = Date.now();
  const { url, modelo: pedido, apagada } = getOllama();
  if (apagada) { det = { ok: false, modelo: '', modelos: [], hasta: ahora + MIN }; return false; }
  if (!forzar && ahora < det.hasta) return det.ok;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    const j = await (await fetch(`${url}/api/tags`, { signal: ac.signal })).json();
    const nombres = (j.models || []).map((m) => m.name).filter((n) => !/embed/i.test(n));
    const elegido = nombres.includes(pedido) ? pedido : mejor(nombres);
    det = { ok: !!elegido, modelo: elegido, modelos: nombres, hasta: ahora + MIN };
  } catch { det = { ok: false, modelo: '', modelos: [], hasta: ahora + 30 * 1000 }; } finally { clearTimeout(t); }
  set({});
  return det.ok;
}

// ---- IA dentro de la app (WebLLM) ----
export async function soporte() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return { ok: false, motivo: 'Este navegador o dispositivo no tiene WebGPU (usa Chrome o Edge actualizado en una laptop o tablet reciente).' };
  try { if (!(await navigator.gpu.requestAdapter())) return { ok: false, motivo: 'No encontré una tarjeta gráfica compatible con WebGPU.' }; } catch { return { ok: false, motivo: 'WebGPU no está disponible en este dispositivo.' }; }
  const gb = navigator.deviceMemory || 8;
  return { ok: true, memoriaGB: gb, aviso: gb <= 4 ? 'Este dispositivo tiene poca memoria: la IA puede ser muy lenta o cerrarse sola.' : '' };
}

let motor = null, cargando = null, worker = null;
async function crearMotor(onProgreso) {
  const web = await import('@mlc-ai/web-llm');
  worker = new Worker(new URL('./llm.worker.js', import.meta.url), { type: 'module' });
  return web.CreateWebWorkerMLCEngine(worker, MODELO, { initProgressCallback: (r) => onProgreso?.(r.text, r.progress) }, { context_window_size: 6144 });
}
async function prepararLocal(onProgreso) {
  if (motor) return motor;
  if (!cargando) {
    cargando = crearMotor(onProgreso)
      .then((m) => { motor = m; ls.set('lumen.ai.local', 'listo'); return m; })
      .catch((e) => { worker?.terminate(); worker = null; throw e; })
      .finally(() => { cargando = null; });
  }
  return cargando;
}
export async function descargarLocal({ auto = false } = {}) {
  if (est.fase === 'bajando') return;
  set({ fase: 'bajando', f: 0, texto: 'Preparando la descarga…', error: '', auto, pregunta: '' });
  try {
    try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
    await prepararLocal((texto, f) => { if (est.fase === 'bajando') set({ texto, f: f || 0 }); });
    set({ fase: 'listo', f: 1 });
  } catch (e) {
    if (est.fase === 'pausada') return;
    set({ fase: 'error', error: `No se pudo descargar: ${String(e?.message || e).slice(0, 160)}` });
  }
}
export function detenerDescarga() { worker?.terminate(); worker = null; cargando = null; motor = null; set({ fase: 'pausada', texto: '' }); }
export async function borrarLocal() {
  try { await motor?.unload(); } catch { /* ya descargado */ }
  motor = null; cargando = null; worker?.terminate(); worker = null;
  try { const web = await import('@mlc-ai/web-llm'); await web.deleteModelAllInfoInCache(MODELO); } catch { /* sin caché */ }
  ls.set('lumen.ai.local', '');
  set({ fase: 'inicio', f: 0, texto: '', error: '' });
}

// Decisión pura: qué hacer al abrir la app según cómo está el dispositivo.
export function decidirAuto({ soportado, listo, bajando, rechazado, auto, datosMoviles, libreGB, memoriaGB }) {
  if (!soportado || listo || bajando || rechazado || !auto) return 'nada';
  if (libreGB != null && libreGB < ESPACIO_MIN_GB) return 'espacio';
  if (memoriaGB != null && memoriaGB <= 4) return 'memoria';
  if (datosMoviles) return 'datos';
  return 'descargar';
}
const libreGB = async () => { try { const e = await navigator.storage?.estimate?.(); return e?.quota ? (e.quota - (e.usage || 0)) / 1e9 : null; } catch { return null; } };
const datosMoviles = () => { const c = navigator.connection; return !!c && (c.type === 'cellular' || c.saveData === true); };

// Se llama al abrir la app: busca Ollama y, si no hay, deja lista la IA dentro de la app (descarga sola cuando conviene).
export async function iniciar() {
  const conOllama = await detectarOllama();
  const sop = await soporte();
  const accion = decidirAuto({ soportado: sop.ok, listo: est.fase === 'listo', bajando: est.fase === 'bajando', rechazado: rechazo(), auto: getAuto(), datosMoviles: datosMoviles(), libreGB: await libreGB(), memoriaGB: sop.memoriaGB ?? null });
  if (accion === 'descargar') setTimeout(() => { if (['inicio', 'pausada'].includes(est.fase) && !rechazo()) descargarLocal({ auto: true }); }, conOllama ? 20000 : 4000);
  else if (['datos', 'memoria', 'espacio'].includes(accion)) set({ pregunta: accion });
  return accion;
}

// ---- Consulta ----
export const hayIA = () => det.ok || localListo();
export const quienResponde = () => (det.ok ? `Ollama · ${det.modelo}` : localListo() ? 'IA de la app' : '');
const recortar = (id, messages) => messages.map((m) => (m.role === 'system' ? { ...m, content: m.content + SOLO_ESPANOL } : m.content.length > MAX_CHARS[id] ? { ...m, content: m.content.slice(0, MAX_CHARS[id]) + '\n[…texto recortado por límite de memoria]' } : m));

async function viaOllama(messages, signal, esquema) {
  const modelo = det.modelo || getOllama().modelo;
  if (!modelo) throw new AiError('nokey', 'Ollama no tiene ningún modelo instalado.');
  const { url } = getOllama();
  const body = { model: modelo, stream: false, ...(esquema ? { format: esquema } : {}), options: { temperature: 0.2, num_ctx: 8192 }, messages: recortar('ollama', messages) };
  let res;
  try { res = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }); } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new AiError('offline', `No pude conectar con Ollama en ${url}. ¿Está abierto?`);
  }
  if (!res.ok) throw new AiError('http', `Ollama respondió con error (${res.status}).`);
  return (await res.json())?.message?.content ?? '';
}
// La IA del dispositivo falla a veces de dos formas: la decodificación guiada por esquema se rechaza a medio camino
// («Grammar matcher rejected…», se vio en una tablet) o la GPU pierde el modelo («Model not loaded»). Se sigue sin esquema / se recarga el motor.
const errorGramatica = (e) => /grammar|rejected the newly sampled/i.test(String(e?.message || e));
const modeloPerdido = (e) => /not loaded|ModelNotLoaded|device.{0,12}lost|DeviceLost|out of memory|OutOfMemory/i.test(String(e?.message || e));
const reiniciarMotor = () => { try { worker?.terminate(); } catch { /* ya detenido */ } worker = null; motor = null; cargando = null; };
async function viaLocalUnaVez(messages, signal, esquema, sinEsquema) {
  const m = await prepararLocal();
  const parar = () => m.interruptGenerate?.();
  signal?.addEventListener('abort', parar, { once: true });
  try {
    if (sinEsquema) { try { await m.resetChat?.(); } catch { /* sin conversación previa */ } }
    let msgs = recortar('local', messages);
    if (esquema && sinEsquema) msgs = msgs.map((x, i) => (i === msgs.length - 1 ? { ...x, content: x.content + '\n\nResponde únicamente con el JSON pedido, sin texto antes ni después.' } : x));
    const r = await m.chat.completions.create({ messages: msgs, temperature: 0.2, max_tokens: 1400, ...(esquema && !sinEsquema ? { response_format: { type: 'json_object', schema: JSON.stringify(esquema) } } : {}) });
    return r.choices?.[0]?.message?.content ?? '';
  } finally { signal?.removeEventListener('abort', parar); }
}
async function viaLocal(messages, signal, esquema) {
  let sinEsquema = ls.get('lumen.ai.sinGramatica') === '1';
  let recargado = false;
  for (let n = 0; n < 3; n++) {
    try { return await viaLocalUnaVez(messages, signal, esquema, sinEsquema); } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      if (errorGramatica(e) && !sinEsquema) { sinEsquema = true; ls.set('lumen.ai.sinGramatica', '1'); continue; }
      if (modeloPerdido(e) && !recargado) { recargado = true; reiniciarMotor(); continue; }
      if (modeloPerdido(e)) throw new AiError('http', 'La memoria gráfica de este dispositivo no alcanzó para la IA de la app (se reinició sola). Cierra otras apps e inténtalo de nuevo.');
      throw new AiError('http', `La IA dentro de la app falló: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  throw new AiError('http', 'La IA dentro de la app no pudo responder. Inténtalo de nuevo.');
}

// Pregunta con respaldo automático. esquema = JSON Schema (respuesta estructurada); sin esquema devuelve texto libre.
export async function chat(messages, { signal, esquema } = {}) {
  await detectarOllama();
  if (!det.ok && !localListo()) {
    if (est.fase === 'bajando') throw new AiError('bajando', 'La IA de la app todavía se está descargando. Ábrela en “IA” para ver el avance.');
    throw new AiError('nokey', 'No hay IA lista. Abre Ollama en tu computador o descarga la IA de la app desde “IA”.');
  }
  const orden = [];
  if (det.ok) orden.push(viaOllama);
  if (localListo()) orden.push(viaLocal);
  let primero = null;
  for (const f of orden) {
    try { return await f(messages, signal, esquema); } catch (e) {
      if (e?.name === 'AbortError' || !(e instanceof AiError)) throw e;
      primero = primero || e;
    }
  }
  throw primero;
}

// Saca el objeto JSON de una respuesta aunque venga con texto alrededor.
export function jsonDe(texto) {
  const a = texto.indexOf('{'), b = texto.lastIndexOf('}');
  const mal = () => new AiError('formato', 'La IA no respondió en el formato esperado. Inténtalo de nuevo.');
  if (a < 0 || b <= a) throw mal();
  try { return JSON.parse(texto.slice(a, b + 1)); } catch { throw mal(); }
}

// ---- Esquemas ----
const S = { type: 'string' };
export const ESQ_EVALUACION = {
  type: 'object', required: ['ideas', 'resumen'],
  properties: {
    ideas: { type: 'array', items: { type: 'object', required: ['n', 'dijiste', 'estado', 'comentario'], properties: { n: { type: 'integer' }, dijiste: S, estado: { type: 'string', enum: ['bien', 'parcial', 'falta', 'incorrecto'] }, comentario: S } } },
    resumen: S,
  },
};

export const ESQ_IDEAS = { type: 'object', required: ['ideas'], properties: { ideas: { type: 'array', items: S } } };

// ---- Tareas ----
// Los modelos chicos son demasiado generosos al corregir: se contrasta lo que dicen con las palabras reales de la explicación.
const plano = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const raices = (t) => [...new Set((plano(t).match(/[a-zn]{5,}/g) || []).map((w) => w.slice(0, 5)))];
export function ajustarEstado(idea, estado, explicacion) {
  if (estado === 'falta' || estado === 'incorrecto') return estado;
  const r = raices(idea);
  if (!r.length) return estado;
  const ex = new Set(raices(explicacion));
  const ov = r.filter((x) => ex.has(x)).length / r.length;
  if (estado === 'bien') return ov >= 0.4 ? 'bien' : ov >= 0.15 ? 'parcial' : 'falta';
  return ov >= 0.15 ? 'parcial' : 'falta';
}
const POR_DEFECTO = { falta: 'No lo mencionaste.', parcial: 'Lo mencionaste solo en parte.', incorrecto: 'Lo explicaste de forma incorrecta.', bien: '' };
export async function evaluarExplicacion({ texto, explicacion, signal }) {
  // Paso 1: las ideas clave salen SOLO del texto (si la IA viera la explicación, tendería a copiarla como si fueran las ideas).
  const o1 = await chat([
    { role: 'system', content: 'Lees un texto de estudio y extraes sus ideas clave: de 4 a 8, cada una una frase completa, concreta y distinta (definiciones, causas, pasos, cifras o condiciones importantes). Usa SOLO el texto. Responde solo JSON: {"ideas":["...","..."]}' },
    { role: 'user', content: texto },
  ], { signal, esquema: ESQ_IDEAS });
  const p1 = jsonDe(o1);
  const claves = (Array.isArray(p1.ideas) ? p1.ideas : []).map((x) => String(x || '').trim()).filter((x) => x.length > 8).slice(0, 8);
  if (claves.length < 2) throw new AiError('formato', 'La IA no pudo sacar ideas clave de este texto. Inténtalo de nuevo.');
  // Paso 2: se contrasta cada idea con la explicación del estudiante.
  const lista = claves.map((c, i) => `${i + 1}. ${c}`).join(String.fromCharCode(10));
  const sys = 'Eres un tutor exigente pero amable (técnica Feynman). Recibes una lista numerada de IDEAS CLAVE de un texto y la EXPLICACIÓN con que un estudiante lo explicó. Para CADA idea, en el mismo orden: en "dijiste" copia las palabras EXACTAS de la explicación que la cubren (o "" si no la menciona), y en "estado" pon "bien" (la explicó completa y correcta), "parcial" (la tocó a medias), "falta" (no la mencionó) o "incorrecto" (la explicó mal). Sé estricto: si no hay palabras suyas que la cubran, es "falta". En "comentario" una frase corta y concreta sobre ESA idea. En "resumen" 1–2 frases con lo principal a reforzar. Responde solo JSON: {"ideas":[{"n":1,"dijiste":"...","estado":"falta","comentario":"..."}],"resumen":"..."}';
  const o2 = await chat([{ role: 'system', content: sys }, { role: 'user', content: `IDEAS CLAVE:
${lista}

EXPLICACIÓN DEL ESTUDIANTE:
${explicacion}` }], { signal, esquema: ESQ_EVALUACION });
  const j = jsonDe(o2);
  const ESTADOS = ['bien', 'parcial', 'falta', 'incorrecto'];
  const rs = Array.isArray(j.ideas) ? j.ideas : [];
  const ideas = claves.map((idea, i) => {
    const x = rs.find((r) => Number(r.n) === i + 1) || rs[i] || {};
    const pedido = ESTADOS.includes(x.estado) ? x.estado : 'falta';
    const estado = ajustarEstado(idea, pedido, explicacion);
    const dicho = estado === pedido ? String(x.comentario || '').trim() : '';
    return { idea, estado, comentario: dicho || POR_DEFECTO[estado] };
  });
  return { ideas, resumen: String(j.resumen || '').trim() };
}

export const resumir = (texto, signal) => chat([
  { role: 'system', content: 'Resumes textos de estudio en español, de forma fiel y clara. Responde con un resumen en viñetas cortas (máximo 7) que empiecen con "• ", y al final una línea "Idea central: …". No inventes nada que no esté en el texto.' },
  { role: 'user', content: texto },
], { signal });

export const explicar = (fragmento, contexto, signal) => chat([
  { role: 'system', content: 'Eres un tutor. Explica el FRAGMENTO en español simple, como a alguien de 15 años: qué significa, por qué importa y un ejemplo cotidiano corto. Si hay términos técnicos, defínelos. Usa solo el contexto dado; no inventes datos. Máximo 150 palabras.' },
  { role: 'user', content: `${contexto ? `CONTEXTO:\n${contexto}\n\n` : ''}FRAGMENTO:\n${fragmento}` },
], { signal });

export const responder = (pregunta, pasajes, historial, signal) => chat([
  { role: 'system', content: 'Respondes preguntas sobre un documento. Usa SOLO los PASAJES entregados (cada uno con su ubicación). Cita la ubicación entre paréntesis, por ejemplo (pág. 12). Si los pasajes no alcanzan para responder, dilo claramente en vez de inventar. Responde en español, breve y claro.' },
  ...historial.slice(-4),
  { role: 'user', content: `PASAJES:\n${pasajes}\n\nPREGUNTA: ${pregunta}` },
], { signal });

// Busca los trozos del documento más parecidos a la pregunta (sin IA): se puntúan por palabras en común.
// "paginas" = lista de textos (uno por página o sección); devuelve [{ i, tx }] en orden de aparición.
export function pasajesPara(pregunta, paginas, fold, maxChars = 5200) {
  const stop = new Set('para como pero sobre entre cuando desde hasta porque donde quien cada tiene puede debe forma tipo parte esto estos estas según solo mismo otras otros cual cuales hacia contra ante bajo tras hecho hace hacer manera entonces luego siempre nunca todos todas todo toda mucho muchos poco pocos qué cómo cuál cuáles dónde quién'.split(' ').map(fold));
  const q = [...new Set((pregunta.match(/[A-Za-zÁÉÍÓÚÑÜáéíóúñü]{4,}/g) || []).map(fold).filter((w) => !stop.has(w)).map((w) => w.slice(0, 6)))];
  const trozos = [];
  paginas.forEach((tx, i) => {
    const t = tx.replace(/\s+/g, ' ').trim();
    for (let k = 0; k < t.length; k += 700) trozos.push({ i, tx: t.slice(Math.max(0, k - 80), k + 780) });
  });
  const pts = trozos.map((c) => { const f = fold(c.tx); return { c, n: q.reduce((a, w) => a + (f.includes(w) ? 1 : 0), 0) }; });
  const mejores = pts.filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const usados = [];
  let len = 0;
  for (const x of (mejores.length ? mejores : pts.slice(0, 4))) {
    if (len + x.c.tx.length > maxChars) break;
    usados.push(x.c); len += x.c.tx.length;
  }
  return usados.sort((a, b) => a.i - b.i);
}
