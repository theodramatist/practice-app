// Service worker: lets the pages open with no connection.
//
// Strategy for the prototype: network first, cache as the fallback. When the
// iPad is online it always gets the newest files (so a fix reaches it at once);
// when it is offline it gets the last copy it saw. On install every file listed
// in precache.json is stored, so a page opens offline even if it was never
// visited. Only the app's own files are ever fetched.

const SHELL_PREFIX = 'practice-shell-';
const SHELL = `${SHELL_PREFIX}v1`;
const NETWORK_WAIT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const response = await fetch('./precache.json', { cache: 'no-store' });
      const list = await response.json();
      await cache.put('./precache.json', new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }));
      await cache.addAll(list.files.map((file) => new Request(file, { cache: 'reload' })));
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
      const cache = await caches.open(SHELL);
      try {
        const response = await fetchWithTimeout(request.url);
        if (response && response.ok) cache.put(request.url, response.clone());
        return response;
      } catch (error) {
        const hit = (await cache.match(request.url)) || (await cache.match(request.url, { ignoreSearch: true }));
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const home = await cache.match('./index.html');
          if (home) return home;
        }
        throw error;
      }
    })()
  );
});
