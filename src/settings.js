const KEY = 'lumen.settings';
export const FONTS = {
  serif: "'Fraunces Variable', Georgia, serif",
  sans: "'Instrument Sans Variable', system-ui, sans-serif",
  dislexia: "'Atkinson Hyperlegible', system-ui, sans-serif",
};
export const WIDTHS = { estrecho: '560px', medio: '700px', ancho: '900px' };
export const HL_COLORS = ['#F5C25B', '#7FB7A4', '#E8836B', '#B9A6E8'];
export const HL_NAMES = ['Ámbar', 'Menta', 'Coral', 'Violeta'];
const THEME_BAR = { papel: '#F6F1E7', sepia: '#E9D9B8', noche: '#14110D', oled: '#000000' };

export const settings = { theme: 'noche', size: 19, font: 'serif', lh: 1.7, width: 'medio', pdfMode: 'page', pdfZoom: 1, color: 0, auto: false, tapTurn: true, sort: 'recent', goal: 30, ttsRate: 1 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* sin almacenamiento */ }

// "Automático" sigue el modo claro/oscuro del sistema.
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const themeOf = () => (settings.theme === 'auto' ? (dark() ? 'noche' : 'papel') : settings.theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (settings.theme === 'auto') applySettings(); });

export function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = themeOf();
  r.style.setProperty('--fs', settings.size + 'px');
  r.style.setProperty('--lh', settings.lh);
  r.style.setProperty('--rf', FONTS[settings.font] || FONTS.serif);
  r.style.setProperty('--cw', WIDTHS[settings.width] || WIDTHS.medio);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_BAR[themeOf()] || '#14110D');
}
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* sin almacenamiento */ }
  applySettings();
}
