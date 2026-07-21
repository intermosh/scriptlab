/* sw.js — Service worker para ScriptLab v4.
   Implementa §13.10 y §3.4 del contrato. Cache on-demand (D14).
   Cachea los archivos de la app a medida que se piden (no pre-cachea en install).
   NO cachea los modelos de IA (eso lo hace transformers.js vía Cache Storage).
   Versión v1 (D15: invalida caches viejas al cambiar el número). */

const CACHE_NAME = 'scriptlab-v4-v1';
const CDN_PREFIXES = [
  'https://cdn.jsdelivr.net',          // Chart.js + transformers.js
  'https://esm.sh',                     // fallback transformers
  'https://huggingface.co',             // modelos
  'https://us.aws.cdn.hf.co'            // CDN de HF (redirección)
];

/* ============================================================
   install — no pre-cachea (D14: cache on-demand). Solo toma control.
   ============================================================ */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

/* ============================================================
   activate — limpia caches viejas y toma control de los clientes.
   ============================================================ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

/* ============================================================
   fetch — estrategia según el origen.
   - Mismo origen (app): cache-first, fallback network + cachear.
   - CDN (transformers, Chart.js, HF): network-first, fallback cache.
     Esto permite updates de CDN sin stale, pero offline si ya está cacheado.
   - Modelos de HF: passthrough (transformers.js los cachea en Cache Storage,
     no en el SW cache — si los cacheáramos acá duplicaríamos ~210MB).
   ============================================================ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCDN = CDN_PREFIXES.some((p) => url.origin.startsWith(p) || url.href.startsWith(p));

  // Modelos de HF (.onnx, tokenizer, etc.): passthrough — transformers.js los maneja.
  if (url.href.includes('huggingface.co') || url.href.includes('cdn.hf.co')) {
    return; // no interceptar
  }

  if (isSameOrigin) {
    // Cache-first para archivos de la app.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          // Cachear copia si la respuesta es válida.
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => cached); // offline y no cacheado → devolver lo que haya
      })
    );
  } else if (isCDN) {
    // Network-first para CDN (Chart.js, transformers.js): updates frescos, offline fallback.
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
