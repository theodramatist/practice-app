// Landing page: says how the page is running and whether it is ready offline.
import { modeLabel, noteVisit, offlineBuild, registerServiceWorker } from './shell.js';

noteVisit();

const mode = modeLabel();
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

// Two build codes can differ for a moment after an update: the one the site is
// serving now, and the one already stored on this iPad for use with no
// connection. Showing both says honestly which copy an offline launch would open.
async function showBuild() {
  let online = null;
  try {
    const list = await (await fetch('./precache.json', { cache: 'no-store' })).json();
    online = `${list.version} (${list.files.length} files)`;
    const stored = await offlineBuild();
    if (!stored) build.textContent = `${online}. Not stored for offline use yet: reload this page once.`;
    else if (stored === list.version) build.textContent = `${online}. The same build is stored for offline use.`;
    else build.textContent = `${online}. An older build (${stored}) is still stored for offline use: reload this page once while online.`;
  } catch (error) {
    const stored = await offlineBuild();
    build.textContent = stored ? `${stored} (the stored copy; the site could not be reached)` : 'unknown';
  }
}
navigator.serviceWorker ? navigator.serviceWorker.ready.then(showBuild, showBuild) : showBuild();
