// IndexedDB 저장소(실패해도 앱은 계속 돈다)
const NAME = 'nyangcut', VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(NAME, VER); } catch (e) { rej(e); return; }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('media')) d.createObjectStore('media', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then((d) => new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const st = tx.objectStore(store);
    let out;
    const req = fn(st);
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}

export const db = {
  async get(store, key) { try { return await run(store, 'readonly', (s) => s.get(key)); } catch (e) { console.warn('db.get', e); return undefined; } },
  async put(store, val, key) { try { await run(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))); return true; } catch (e) { console.warn('db.put', e); return false; } },
  async del(store, key) { try { await run(store, 'readwrite', (s) => s.delete(key)); return true; } catch (e) { console.warn('db.del', e); return false; } },
  async all(store) { try { return (await run(store, 'readonly', (s) => s.getAll())) || []; } catch (e) { console.warn('db.all', e); return []; } },
};
