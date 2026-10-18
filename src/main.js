import '@fontsource-variable/fraunces';
import '@fontsource-variable/instrument-sans';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './styles.css';
import { start } from './app.js';
import { applyPendingOnColdStart, notifyReady, startUpdates } from './updater.js';

(async () => {
  await applyPendingOnColdStart();
  await start();
  notifyReady();
  startUpdates();
})();
