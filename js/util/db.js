// A small promise wrapper over IndexedDB. Everything stays on the device.
//
// Stores:
//   sessions  one record per recording session (labels and take results, no audio)
//   audio     one record per recorded take: { key: "<sessionId>/<takeId>", sessionId, bytes }
//   device    one record per device-check result
//   kv        small named values (launch counters, survival markers, ticks)

const DB_NAME = 'practice-prototype';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) {
        const audio = db.createObjectStore('audio', { keyPath: 'key' });
        audio.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('device')) db.createObjectStore('device', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The database is open in another tab.'));
  });
  return dbPromise;
}

function run(storeName, mode, action) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = action(tx.objectStore(storeName));
        let result;
        if (request) request.onsuccess = () => (result = request.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('The database write was cancelled.'));
      })
  );
}

export const dbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const dbGetAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const dbPut = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const dbDelete = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

/**
 * Write several records, possibly in different stores, as ONE transaction:
 * either every one of them is saved or none is. Used so a take's audio and its
 * labels can never come from different attempts.
 * @param {{store: string, value: object}[]} writes
 */
export function dbPutTogether(writes) {
  const stores = [...new Set(writes.map((write) => write.store))];
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('The database write was cancelled.'));
        try {
          for (const write of writes) tx.objectStore(write.store).put(write.value);
        } catch (error) {
          try { tx.abort(); } catch (ignored) { /* already aborting */ }
          reject(error);
        }
      })
  );
}
export const dbKeysByIndex = (store, index, value) =>
  run(store, 'readonly', (s) => s.index(index).getAllKeys(IDBKeyRange.only(value)));

export async function kvGet(key, fallback = null) {
  const row = await dbGet('kv', key);
  return row ? row.value : fallback;
}
export const kvSet = (key, value) => dbPut('kv', { key, value });

/** Ask the browser to keep this site's data. Returns what it said. */
export async function requestPersistence() {
  const out = { supported: !!(navigator.storage && navigator.storage.persist), persisted: null, granted: null, estimate: null };
  if (!out.supported) return out;
  try {
    out.persisted = await navigator.storage.persisted();
    out.granted = out.persisted ? true : await navigator.storage.persist();
    if (navigator.storage.estimate) out.estimate = await navigator.storage.estimate();
  } catch (error) {
    out.error = String(error);
  }
  return out;
}
