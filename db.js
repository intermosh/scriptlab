/* db.js — Capa de persistencia IndexedDB.
   Implementa §13.2 y §8.3 del contrato.
   No importa de módulos de dominio (§3.3): solo IndexedDB + hash. */

let database;

/* ============================================================
   Apertura y schema
   DB 'scriptlab-ai', versión 4 (§8.3). Seis object stores.
   ============================================================ */
export function openDB() {
  if (database) return Promise.resolve(database);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('scriptlab-ai', 5);
    r.onupgradeneeded = () => {
      const d = r.result;
      ['projects', 'snapshots', 'calibrations', 'settings', 'analysisCache', 'modelRegistry',
       'realScores', 'benchmarks']
        .forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
    };
    r.onsuccess = () => { database = r.result; resolve(database); };
    r.onerror = () => reject(r.error);
  });
}

/* ============================================================
   CRUD genéricos (wrappers Promise sobre transacciones)
   ============================================================ */
export async function put(store, value) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store, 'readwrite').objectStore(store).put(value);
    r.onsuccess = () => resolve(value);
    r.onerror = () => reject(r.error);
  });
}

export async function get(store, id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store, 'readonly').objectStore(store).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function all(store) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function del(store, id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store, 'readwrite').objectStore(store).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

/* ============================================================
   Migración legacy (pre-IDB)
   Si existe localStorage['scriptlab-ai-project-v1'], lo migra una sola vez
   a la store 'projects' (id:'active') y marca el flag. Idempotente y a prueba
   de JSON corrupto.
   ============================================================ */
export async function migrateLegacy() {
  if (localStorage.getItem('scriptlab-idb-migrated')) return;
  const raw = localStorage.getItem('scriptlab-ai-project-v1');
  if (raw) {
    try {
      const rawProject = JSON.parse(raw);
      const meta = rawProject.project || rawProject;
      await put('projects', {
        ...meta,
        id: 'active',
        blocks: Array.isArray(rawProject.blocks) ? rawProject.blocks : [],
        updatedAt: Date.now()
      });
    } catch (error) {
      console.warn('No se pudo migrar proyecto anterior', error);
    }
  }
  localStorage.setItem('scriptlab-idb-migrated', '1');
}
