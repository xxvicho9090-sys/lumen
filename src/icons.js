// Un solo set de íconos (Lucide, ISC), trazo 1.75, esquinas redondeadas.
import bookOpen from 'lucide-static/icons/book-open.svg?raw';
import plus from 'lucide-static/icons/plus.svg?raw';
import search from 'lucide-static/icons/search.svg?raw';
import list from 'lucide-static/icons/list.svg?raw';
import highlighter from 'lucide-static/icons/highlighter.svg?raw';
import type from 'lucide-static/icons/type.svg?raw';
import trash from 'lucide-static/icons/trash-2.svg?raw';
import pencil from 'lucide-static/icons/pencil-line.svg?raw';
import copy from 'lucide-static/icons/copy.svg?raw';
import columns from 'lucide-static/icons/columns-2.svg?raw';
import sliders from 'lucide-static/icons/sliders-horizontal.svg?raw';
import download from 'lucide-static/icons/download.svg?raw';
import maximize from 'lucide-static/icons/maximize.svg?raw';
import share from 'lucide-static/icons/share.svg?raw';
import chevronDown from 'lucide-static/icons/chevron-down.svg?raw';
import chevronLeft from 'lucide-static/icons/chevron-left.svg?raw';
import bookmark from 'lucide-static/icons/bookmark.svg?raw';
import lightbulb from 'lucide-static/icons/lightbulb.svg?raw';
import layoutGrid from 'lucide-static/icons/layout-grid.svg?raw';
import timer from 'lucide-static/icons/timer.svg?raw';
import volume from 'lucide-static/icons/volume-2.svg?raw';
import play from 'lucide-static/icons/play.svg?raw';
import pause from 'lucide-static/icons/pause.svg?raw';
import square from 'lucide-static/icons/square.svg?raw';
import x from 'lucide-static/icons/x.svg?raw';
import check from 'lucide-static/icons/check.svg?raw';
import folder from 'lucide-static/icons/folder.svg?raw';
import ellipsis from 'lucide-static/icons/ellipsis.svg?raw';
import layers from 'lucide-static/icons/layers.svg?raw';
import wifiOff from 'lucide-static/icons/wifi-off.svg?raw';

// Solo se toca la etiqueta <svg> de apertura: los rectángulos internos conservan su ancho y alto.
const ic = (svg) => svg
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<svg[^>]*>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, '').replace(/class="[^"]*"/, 'class="ic" aria-hidden="true"'))
  .replace(/\s+/g, ' ')
  .trim();

export const I = {
  book: ic(bookOpen), plus: ic(plus), search: ic(search), list: ic(list), marker: ic(highlighter), type: ic(type),
  trash: ic(trash), note: ic(pencil), copy: ic(copy), split: ic(columns), sliders: ic(sliders), download: ic(download),
  expand: ic(maximize), share: ic(share), chevron: ic(chevronDown), chevronL: ic(chevronLeft), bookmark: ic(bookmark),
  bulb: ic(lightbulb), grid: ic(layoutGrid), rows: ic(list), timer: ic(timer), voice: ic(volume), play: ic(play),
  pause: ic(pause), stop: ic(square), close: ic(x), check: ic(check), folder: ic(folder), more: ic(ellipsis),
  layers: ic(layers), offline: ic(wifiOff),
};

// Marca: libro abierto con una chispa de luz.
export const LOGO = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5c-2.2-1.6-5-2-8-1.2v10.6c3-.8 5.8-.4 8 1.2 2.2-1.6 5-2 8-1.2V7.3c-3-.8-5.8-.4-8 1.2zM12 8.5v10.6"/><path d="M12 1.8l.7 1.6 1.6.7-1.6.7L12 6.4l-.7-1.6-1.6-.7 1.6-.7z" fill="currentColor" stroke="none"/></svg>';
