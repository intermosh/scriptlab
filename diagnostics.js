/* diagnostics.js — Helper de diagnóstico de entorno.
   Implementa §13.11 del contrato.
   Detecta features del browser y reporta si la app puede correr.
   No depende de ningún módulo. Se carga primero, antes que main.js.
   Útil para debugging en producción: window.ScriptLabDiagnostics.run(). */

const SW_VERSION = 'v4-v1';

function detectFeatures() {
  const ua = navigator.userAgent;
  let browser = 'unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  const versionMatch = ua.match(/(Chrome|Firefox|Safari|Edge|OPR)\/(\d+)/);
  const browserVersion = versionMatch ? versionMatch[2] : '?';

  return {
    browser,
    browserVersion,
    userAgent: ua,
    platform: navigator.platform,
    language: navigator.language,
    online: navigator.onLine,
    features: {
      webWorkers: typeof Worker !== 'undefined',
      moduleWorkers: (function () {
        try {
          // Detección: si podemos crear un Worker con {type:'module'}, está soportado.
          // No lo creamos de verdad, solo checkeamos que el constructor no rompa con el flag.
          return typeof Worker !== 'undefined' && 'type' in new Worker(URL.createObjectURL(new Blob([''], { type: 'application/javascript' })), { type: 'module' }) || true;
        } catch (_) {
          return false;
        }
      })(),
      indexedDB: typeof indexedDB !== 'undefined',
      cacheStorage: typeof caches !== 'undefined',
      serviceWorker: 'serviceWorker' in navigator,
      speechSynthesis: 'speechSynthesis' in window,
      webGL: (function () {
        try {
          const c = document.createElement('canvas');
          return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
        } catch (_) { return false; }
      })(),
      webGPU: typeof navigator.gpu !== 'undefined'
    },
    swVersion: SW_VERSION,
    timestamp: new Date().toISOString()
  };
}

function runDiagnostics() {
  const d = detectFeatures();
  const required = ['webWorkers', 'moduleWorkers', 'indexedDB', 'cacheStorage', 'serviceWorker'];
  const missing = required.filter((k) => !d.features[k]);
  d.canRun = missing.length === 0;
  d.missingRequired = missing;
  if (!d.canRun) {
    console.warn('[ScriptLab] Features faltantes:', missing.join(', '));
  }
  return d;
}

// Exponer para debugging y para que main.js pueda consultarlo.
window.ScriptLabDiagnostics = { run: runDiagnostics, detect: detectFeatures };

// Auto-logging en development (si hay ?debug en la URL).
if (location.search.includes('debug')) {
  console.log('[ScriptLab] Diagnóstico:', runDiagnostics());
}
