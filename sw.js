// Service worker: lets the pages open with no connection.
//
// Every build of the site has its own copy of this file (the BUILD line below
// is rewritten by scripts/build_precache.py) and its own cache. So when a new
// build is published, the browser sees that this file changed, installs the new
// worker, and that worker stores EVERY file of the new build before taking
// over. The copy that opens offline is therefore always one whole build, never
// a mix of old and new pages.
//
// Online, pages are fetched from the network first, so a fix arrives at once;
// offline, they come from the stored build. Only the app's own files are fetched.

const BUILD = '03336bb4fb';
const SHELL_PREFIX = 'practice-shell-';
const SHELL = `${SHELL_PREFIX}${BUILD}`;
const NETWORK_WAIT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // "?v=<build>" makes sure each file comes from the site itself and not
      // from a stale copy held somewhere on the way. It is stored under its plain name.
      const fresh = (path) => fetch(`${path}${path.includes('?') ? '&' : '?'}v=${BUILD}`, { cache: 'reload', credentials: 'same-origin' });
      const listResponse = await fresh('./precache.json');
      if (!listResponse.ok) throw new Error('precache.json could not be fetched');
      const list = await listResponse.clone().json();
      await cache.put('./precache.json', listResponse);
      await Promise.all(
        list.files.map(async (file) => {
          const response = await fresh(file);
          if (!response.ok) throw new Error(`${file} could not be fetched`);
          await cache.put(file, response);
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        // Only this worker's own old caches are removed; other caches are left alone.
        if (name.startsWith(SHELL_PREFIX) && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

function fetchWithTimeout(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_WAIT_MS);
    fetch(url, { cache: 'no-cache', credentials: 'same-origin' }).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        // The stored build is not touched here: it changes only as a whole,
        // when a new worker installs. That keeps the offline copy consistent.
        return await fetchWithTimeout(request.url);
      } catch (error) {
        const cache = await caches.open(SHELL);
        const hit = (await cache.match(request.url)) || (await cache.match(request.url, { ignoreSearch: true }));
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const home = (await cache.match('./index.html')) || (await cache.match('./'));
          if (home) return home;
        }
        throw error;
      }
    })()
  );
});

// A page can ask which build this worker serves offline.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'build' && event.source) event.source.postMessage({ type: 'build', build: BUILD });
});
