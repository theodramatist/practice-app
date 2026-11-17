// Landing page: says how the page is running and whether it is ready offline.
import { isStandalone, noteVisit, registerServiceWorker } from './shell.js';

noteVisit();

const mode = isStandalone() ? 'Home Screen app' : 'Safari tab';
document.getElementById('mode-chip').textContent = mode;
document.getElementById('mode').textContent = mode;

const offline = document.getElementById('offline');
const build = document.getElementById('build');

registerServiceWorker().then(async (result) => {
  if (!result.supported) {
    offline.textContent = 'No: this browser has no service worker.';
    return;
  }
  if (result.error) {
    offline.textContent = `Not yet: ${result.error}`;
    return;
  }
  try {
    await navigator.serviceWorker.ready;
    offline.textContent = 'Yes, after this first visit.';
  } catch (error) {
    offline.textContent = `Not yet: ${error}`;
  }
});

fetch('./precache.json')
  .then((response) => response.json())
  .then((list) => {
    build.textContent = `${list.version} (${list.files.length} files)`;
  })
  .catch(() => {
    build.textContent = 'unknown';
  });
