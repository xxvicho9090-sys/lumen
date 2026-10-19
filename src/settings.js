const KEY = 'lumen.settings';
export const FONTS = {
  serif: "'Newsreader Variable', Georgia, serif",
  literata: "'Literata Variable', Georgia, serif",
  sans: "'Geist Variable', system-ui, sans-serif",
  dislexia: "'Atkinson Hyperlegible', system-ui, sans-serif",
};
export const WIDTHS = { estrecho: '560px', medio: '700px', ancho: '900px' };
export const HL_COLORS = ['#F4B740', '#5CB88A', '#E5707E', '#8B7CF0'];
export const HL_NAMES = ['Ámbar', 'Menta', 'Coral', 'Violeta'];
const THEME_BAR = { papel: '#F6F1E7', sepia: '#E9D9B8', noche: '#0A0D18', dia: '#F4F6FA', oled: '#000000' };

export const settings = { theme: 'noche', size: 19, font: 'serif', lh: 1.7, width: 'medio', pdfMode: 'page', pdfZoom: 1, color: 0, auto: false, tapTurn: true, sort: 'recent', goal: 30, ttsRate: 1, ttsVoice: '', ttsVoiceLabel: '', barHidden: false, welcomed: false, view: 'grid', pomoWork: 25, pomoShort: 5, pomoLong: 15, pomoEvery: 4, feynman: true, pomoAuto: false };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* sin almacenamiento */ }

// "Automático" sigue el modo claro/oscuro del sistema.
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const themeOf = () => (settings.theme === 'auto' ? (dark() ? 'noche' : 'dia') : settings.theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (settings.theme === 'auto') applySettings(); });

let lastTheme = null;
export function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = themeOf();
  if (lastTheme && lastTheme !== themeOf()) setTimeout(() => window.dispatchEvent(new Event('lumen-theme')));
  lastTheme = themeOf();
  r.style.setProperty('--fs', settings.size + 'px');
  r.style.setProperty('--lh', settings.lh);
  r.style.setProperty('--rf', FONTS[settings.font] || FONTS.serif);
  r.style.setProperty('--cw', WIDTHS[settings.width] || WIDTHS.medio);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_BAR[themeOf()] || '#0A0D18');
}
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* sin almacenamiento */ }
  applySettings();
}
