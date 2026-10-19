import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/literata';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './design.css';
import { start } from './app.js';
import { applyPendingOnColdStart, notifyReady, startUpdates } from './updater.js';

(async () => {
  await applyPendingOnColdStart();
  await start();
  notifyReady();
  startUpdates();
})();
