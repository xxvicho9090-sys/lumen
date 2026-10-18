import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

// Actualizaciones desde la misma app, sin instalar otro APK.
// Render publica /update/version.json y un zip con la web nueva; la app lo baja en segundo plano
// y queda activa al reiniciarla (o al instante si la persona lo pide). Si una versión no arranca,
// Capgo vuelve sola a la anterior.
export const UPDATE_BASE = 'https://lumen-lector.onrender.com/update/';

const native = Capacitor.isNativePlatform();
let status = { state: 'idle' };
const listeners = new Set();
const setStatus = (s) => { status = s; listeners.forEach((fn) => fn(s)); };
export const getUpdateStatus = () => status;
export const onUpdateStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

const BAD = 'lumen.badVersions';
const badVersions = () => { try { return JSON.parse(localStorage.getItem(BAD) || '[]'); } catch { return []; } };
const markBad = (v) => {
  if (!v || v === 'builtin') return;
  try { localStorage.setItem(BAD, JSON.stringify([...new Set([...badVersions(), v])].slice(-20))); } catch { /* sin almacenamiento */ }
};

let inFlight = null;
export function checkForUpdate() {
  if (!native) return Promise.resolve();
  if (!inFlight) inFlight = doCheck().finally(() => { inFlight = null; });
  return inFlight;
}

async function doCheck() {
  setStatus({ state: 'checking' });
  try {
    const res = await fetch(`${UPDATE_BASE}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    if (!info?.version || !info?.url) throw new Error('version.json incompleto');
    const wanted = info.force ? info.version !== __APP_VERSION__ : newer(info.version, __APP_VERSION__);
    if (!wanted || badVersions().includes(info.version)) return setStatus({ state: 'latest' });
    const { bundles } = await CapacitorUpdater.list();
    let bundle = bundles.find((b) => b.version === info.version && b.status !== 'error');
    if (!bundle) {
      setStatus({ state: 'downloading', version: info.version });
      bundle = await CapacitorUpdater.download({ url: new URL(info.url, UPDATE_BASE).href, version: info.version, checksum: info.checksum });
    }
    await CapacitorUpdater.next({ id: bundle.id });
    // Solo al cerrar la app: nunca recargar mientras se está leyendo.
    await CapacitorUpdater.setMultiDelay({ delayConditions: [{ kind: 'kill' }] }).catch(() => {});
    setStatus({ state: 'ready', version: info.version, notes: info.notes });
  } catch (err) {
    console.warn('Actualización no disponible:', err);
    setStatus({ state: 'offline' });
  }
}

export async function applyNow() {
  try {
    const { bundles } = await CapacitorUpdater.list();
    const target = bundles.find((b) => b.version === status.version);
    if (target) await CapacitorUpdater.set({ id: target.id });
  } catch (e) { console.warn('No se pudo aplicar la actualización', e); }
}

let readyNotified = false;
export function notifyReady() {
  if (!native || readyNotified) return;
  readyNotified = true;
  CapacitorUpdater.notifyAppReady().catch(() => {});
}

// Si quedó una versión pendiente, se aplica antes de mostrar la app (una sola vez por versión).
export async function applyPendingOnColdStart() {
  if (!native) return;
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), 1500));
    const next = await Promise.race([CapacitorUpdater.getNextBundle(), timeout]);
    if (!next?.id || next.status === 'error' || badVersions().includes(next.version)) return;
    const cur = await Promise.race([CapacitorUpdater.current(), timeout.then(() => ({}))]);
    if (!cur?.bundle || next.id === cur.bundle.id) return;
    const key = 'lumen.coldApply';
    if (localStorage.getItem(key) === next.id) return;
    localStorage.setItem(key, next.id);
    await CapacitorUpdater.reload();
  } catch (e) { console.warn('Arranque: no se aplicó la versión pendiente', e); }
}

export async function startUpdates() {
  if (!native) return;
  CapacitorUpdater.addListener('updateFailed', (e) => markBad(e?.bundle?.version)).catch?.(() => {});
  try {
    const failed = await CapacitorUpdater.getFailedUpdate?.();
    if (failed?.bundle?.version) markBad(failed.bundle.version);
  } catch { /* plugin antiguo */ }
  await checkForUpdate();
  const again = () => { if (document.visibilityState === 'visible' && !['ready', 'downloading'].includes(status.state)) checkForUpdate(); };
  setInterval(again, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', again);
}
