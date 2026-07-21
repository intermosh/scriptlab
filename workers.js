/* workers.js — Orquestación del ciclo de vida y mensajería de los Web Workers de IA.
   Implementa §13.5, §4 (uso de state), §5.1/5.2 (schedulers), §11.3 (ciclo de vida).
   NO importa render.js (§3.3, P8): render se inyecta vía setRenderCallbacks.
   Importa de: state.js, db.js, scoring.js. */

import { state, contentHash } from './state.js';
import { get, put } from './db.js';
import { analysis } from './scoring.js';

/* ============================================================
   DI — callbacks de render inyectados desde render.js
   ============================================================ */
let renderMetricsRef = null;
let renderRetentionPanelRef = null;
let renderSentimentArcRef = null;

export function setRenderCallbacks(metricsCb, retentionCb, sentimentArcCb) {
  renderMetricsRef = metricsCb;
  renderRetentionPanelRef = retentionCb;
  renderSentimentArcRef = sentimentArcCb;
}

/* ============================================================
   Pill de actividad (selector #ai-activity)
   ============================================================ */
export function setAIActivity(kind, text) {
  const el = document.querySelector('#ai-activity');
  if (!el) return;
  el.className = 'ai-activity ' + kind;
  el.textContent = text;
  el.title = text;
  el.dataset.detail = text;
}

function updateDownloadProgress(value) {
  const progress = document.querySelector('#model-download-progress');
  if (!progress || !Number.isFinite(value)) return;
  // El 100% se reserva para READY: los eventos de transformers pueden
  // alcanzar 100 antes de que termine la inicialización del pipeline.
  const next = Math.max(Number(progress.value) || 0, Math.min(99, value));
  progress.value = next;
}

/* Helper: estado inicial del pill según modo y disponibilidad de modelos.
   Siempre informa al usuario qué hace la IA (acuerdo UI). */
export async function modelsAreReady() {
  const setting = await get('settings', 'modelsReady');
  const registry = await get('modelRegistry', 'scriptlab-models-v1');
  if (setting?.value === true && registry?.status === 'ready') return true;
  // Fallback para instalaciones anteriores: buscar ambos identificadores en
  // Cache Storage. Si el navegador no expone las entradas, no suponemos que
  // un flag viejo implique que los modelos estén disponibles.
  if (!("caches" in window)) return false;
  try {
    const keys = await caches.keys();
    const urls = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      const requests = await cache.keys();
      urls.push(...requests.map(r => r.url));
    }
    const hasEmbeddings = urls.some(u => /multilingual-e5-small/i.test(u));
    const hasSentiment = urls.some(u => /robertuito-sentiment-analysis/i.test(u));
    return hasEmbeddings && hasSentiment;
  } catch (_) { return false; }
}

export function resetAIResults() {
  state.aiResult = null;
  state.sentimentResult = null;
  state.redundancyResult = null;
  state.deepResult = null;
}

export function refreshAIActivityPill() {
  if (!state.p) return;
  if (state.mode !== 'ia') {
    setAIActivity('heuristic', '◌ Heurístico');
    return;
  }
  if (!state.worker) {
    setAIActivity('loading', '◌ IA: activá modelos');
  } else if (!state.sentimentReady) {
    setAIActivity('loading', '◌ IA: trabajando…');
  } else {
    const n = state.p.blocks?.length || 0;
    setAIActivity('semantic', '✦ IA lista · ' + n + ' bloques');
  }
}

export function updateAnalysisTabState() {
  const isAI = state.mode === 'ia' && state.worker;
  const notice = document.querySelector('#analysis-notice');
  const content = document.querySelector('#analysis-content');
  if (notice) notice.hidden = isAI;
  if (content) content.hidden = !isAI;
}

/* ============================================================
   syncWorkerWithState() — ÚNICO punto de control (§11.3).
   Se llama en boot, nuevo proyecto, importar, cambio de modo.
   ============================================================ */
export async function syncWorkerWithState() {
  if (!state.p) return;

  if (state.mode === 'ia') {
    if (!state.worker) {
      await initWorker();
    } else {
      scheduleAI();
      scheduleSentiment();
    }
  } else {
    // Modo básico: terminar workers y limpiar resultados.
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    if (state.sentimentWorker) {
      state.sentimentWorker.terminate();
      state.sentimentWorker = null;
      state.sentimentReady = false;
    }
    state.aiResult = null;
    state.sentimentResult = null;
    state.redundancyResult = null;
    state.deepResult = null;

    // Bug 3 fix: rechazar promesas tier 2 pendientes antes de limpiar.
    // Al terminar el worker, las promesas en analysisCallbacks nunca se resolverían
    // (memory leak + promesas colgadas). Las rechazamos explícitamente.
    for (const id in state.analysisCallbacks) {
      try { state.analysisCallbacks[id].reject(new Error('Modo IA desactivado')); } catch (_) {}
      delete state.analysisCallbacks[id];
    }

    const stateLabel = document.querySelector('#ai-state');
    if (stateLabel) stateLabel.textContent = 'Heurísticas locales';
    setAIActivity('heuristic', '◌ IA');
    updateAnalysisTabState();
    if (renderMetricsRef) renderMetricsRef(analysis());
    if (renderRetentionPanelRef) renderRetentionPanelRef();  // Bug 6 fix
    if (renderSentimentArcRef) renderSentimentArcRef();
  }
}

/* ============================================================
   initWorker() — embeddings worker (ai-worker.js)
   ============================================================ */
export async function initWorker() {
  state.worker?.terminate();
  state.worker = null;
  state.aiResult = null;

  const stateLabel = document.querySelector('#ai-state');
  if (stateLabel) stateLabel.textContent = 'Cargando motor IA…';
  setAIActivity('loading', '◌ IA: preparando…');
  updateAnalysisTabState();
  if (renderMetricsRef) renderMetricsRef(analysis());

  if (state.mode !== 'ia') return;

  return new Promise((resolve, reject) => {
    try {
      state.worker = new Worker('./ai-worker.js', { type: 'module' });
      state.worker.onerror = (e) => {
        // Errores de CARGA del worker (import map roto, sintaxis, etc.) no emiten
        // mensajes → sin onerror quedarían silenciosos y la Promise colgada.
        if (stateLabel) stateLabel.textContent = 'Error al cargar IA';
        setAIActivity('error', '! IA: error de carga');
        reject(new Error('ai-worker no cargó: ' + (e.message || 'ver consola — ¿falta import map de transformers?')));
      };
      state.worker.onmessage = (event) => {
        const d = event.data;
        if (d.type === 'PROGRESS') {
          setAIActivity('loading', '◌ IA: ' + d.message);
          const pct = Number((d.message.match(/(\d+)%/) || [])[1]);
          if (Number.isFinite(pct)) {
            const prog = document.querySelector('#model-download-progress');
            if (prog) prog.hidden = false;
            updateDownloadProgress(pct);
          }
        }
        if (d.type === 'READY') {
          setAIActivity('loading', '◌ IA: embeddings listos, cargando sentimiento…');
          initSentimentWorker()
            .then(async () => {
              if (stateLabel) stateLabel.textContent = 'Modelo local listo';
              state.modelsReady = true;
              await put('settings', { id: 'modelsReady', value: true });
              await put('modelRegistry', { id: 'scriptlab-models-v1', status: 'ready', cacheVerified: true, models: ['Xenova/multilingual-e5-small', 'Xenova/robertuito-sentiment-analysis'], updatedAt: Date.now() });
              setAIActivity('semantic', '✦ IA: 2 modelos listos');
              updateAnalysisTabState();
              scheduleAI();
              scheduleSentiment();
              resolve();
            })
            .catch((err) => {
              state.modelsReady = false;
              if (stateLabel) stateLabel.textContent = 'Error al cargar sentimiento';
              setAIActivity('error', '! IA: falta un modelo');
              reject(err);
            });
        }
        if (d.type === 'EMBED_RESULT') {
          state.aiResult = d;
          put('analysisCache', { id: d.cacheId || ('embedding-' + Date.now()), projectId: state.p?.id, updatedAt: Date.now(), result: d });
          setAIActivity('semantic', '✦ IA: ' + (state.p?.blocks?.length || 0) + ' bloques');
          if (renderMetricsRef) renderMetricsRef(analysis());
          scheduleSentiment();
        }
        if (d.type === 'ERROR') {
          if (stateLabel) stateLabel.textContent = 'Error en IA';
          setAIActivity('error', '! IA: error');
          reject(new Error(d.message));
        }
        handleWorkerResult(d); // tier 2 request/response
      };
      state.worker.postMessage({ type: 'INIT', mode: state.p.aiMode, revision: ++state.rev });
    } catch (error) {
      if (stateLabel) stateLabel.textContent = 'Error al iniciar IA';
      setAIActivity('error', '! IA: error al instanciar');
      reject(error);
    }
  });
}

/* ============================================================
   initRetentionWorker() — retention-worker.js (siempre activo, sin IA)
   ============================================================ */
export function initRetentionWorker() {
  try {
    state.retentionWorker = new Worker('./retention-worker.js', { type: 'module' });
    state.retentionWorker.onerror = (e) => {
      console.warn('Retention worker error de carga:', e.message || e);
    };
    state.retentionWorker.onmessage = (e) => {
      if (e.data.type === 'RETENTION_RESULT') {
        state.retentionResult = e.data;
        if (state.sentimentResult) state.retentionResult.sentiment = state.sentimentResult;
        if (renderRetentionPanelRef) renderRetentionPanelRef();
        const btn = document.querySelector('#run-retention');
        if (btn) { btn.disabled = false; btn.textContent = 'Calcular retención'; }
        if (renderMetricsRef) renderMetricsRef(analysis());
      }
      if (e.data.type === 'ERROR') {
        console.warn('Retention error:', e.data.message);
      }
    };
  } catch (e) {
    console.warn('Retention worker no disponible:', e);
  }
}

/* ============================================================
   initSentimentWorker() — sentiment-worker.js (robertuito)
   ============================================================ */
export function initSentimentWorker() {
  if (state.sentimentReady && state.sentimentWorker) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      state.sentimentWorker = new Worker('./sentiment-worker.js', { type: 'module' });
      state.sentimentWorker.onerror = (e) => {
        console.warn('Sentiment worker error de carga:', e.message || e);
        resolve(); // no rechazar: sentiment es opcional
      };
      state.sentimentWorker.onmessage = (e) => {
        if (e.data.type === 'PROGRESS') setAIActivity('loading', '◌ Sentimiento: ' + e.data.message);
        if (e.data.type === 'READY') {
          state.sentimentReady = true;
          scheduleSentiment();
          resolve();
        }
        if (e.data.type === 'SENTIMENT_RESULT') {
          state.sentimentResult = e.data;
          if (state.retentionResult) {
            state.retentionResult.sentiment = state.sentimentResult;
            if (renderRetentionPanelRef) renderRetentionPanelRef();
          }
          if (renderSentimentArcRef) renderSentimentArcRef();
        }
        if (e.data.type === 'ERROR') {
          console.warn('Sentiment error:', e.data.message);
          resolve(); // no rechazar: sentiment es opcional
        }
      };
      state.sentimentWorker.postMessage({ type: 'INIT' });
    } catch (e) {
      console.warn('Sentiment worker no disponible:', e);
      resolve();
    }
  });
}

/* ============================================================
   Schedulers (tier 1)
   scheduleSentiment usa timer de closure (NO en state, regla de v16).
   ============================================================ */
let sentimentTimer = null;

export function scheduleSentiment() {
  clearTimeout(sentimentTimer);
  if (state.mode !== 'ia' || !state.sentimentWorker || !state.sentimentReady) return;

  const blocks = (state.p?.blocks || []).filter(b => b.content && b.content.trim().length >= 5);
  if (!blocks.length) return;

  sentimentTimer = setTimeout(() => {
    state.sentimentWorker.postMessage({
      type: 'SENTIMENT',
      requestId: ++state.analysisRequestId,  // Bug 2 fix: usar analysisRequestId, no state.rev
      texts: blocks.map(b => b.content),
      blockIds: blocks.map(b => b.id),
      blockIndices: blocks.map((_, i) => i),
      blockTypes: blocks.map(b => b.type)
    });
  }, 700);
}

export function scheduleAI() {
  clearTimeout(state.aiTimer);
  if (state.mode !== 'ia' || !state.worker) return;
  state.aiTimer = setTimeout(async () => {
    const texts = [
      { id: 'title', text: state.p.title, role: 'title' },
      { id: 'promise', text: state.p.promise, role: 'promise' },
      ...state.p.blocks.map(b => ({ id: b.id, text: b.content, role: 'block' }))
    ];
    const hook = state.p.blocks.find(b => b.type === 'HOOK');
    if (hook) texts.push({ id: 'hook', text: hook.content, role: 'hook' });
    const id = 'embedding-' + contentHash(JSON.stringify(texts));

    // Cache check antes de llamar al worker (§8.4).
    const cached = await get('analysisCache', id);
    if (cached?.result) {
      state.aiResult = cached.result;
      setAIActivity('semantic', '✦ IA: caché');
      if (renderMetricsRef) renderMetricsRef(analysis());
      return;
    }
    state.worker.postMessage({ type: 'EMBED', requestId: ++state.analysisRequestId, cacheId: id, texts });  // Bug 2 fix
  }, 700);
}

export function scheduleRetention() {
  if (!state.retentionWorker || !state.p) return;  // R3 fix: null guard
  state.retentionWorker.postMessage({
    type: 'PREDICT_RETENTION',
    requestId: ++state.analysisRequestId,  // Bug 2 fix
    blocks: state.p.blocks,
    wpm: state.p.wpm || 150,
    promise: state.p.promise || '',
    title: state.p.title || ''
  });
}

/* ============================================================
   Tier 2: workerSend / handleWorkerResult (request/response sobre ai-worker)
   ============================================================ */
export function workerSend(type, data) {
  if (!state.worker) {
    alert('Activá el modo AI primero (Configurar IA > Modo AI > Descargar modelo).');
    return null;
  }
  const id = ++state.analysisRequestId;
  return new Promise((resolve, reject) => {
    state.analysisCallbacks[id] = { resolve, reject };
    state.worker.postMessage({ type, requestId: id, ...data });
  });
}

export function handleWorkerResult(d) {
  const cb = state.analysisCallbacks[d.requestId];
  if (!cb) return;
  if (d.type === 'ERROR') { cb.reject(new Error(d.message)); delete state.analysisCallbacks[d.requestId]; return; }
  cb.resolve(d);
  delete state.analysisCallbacks[d.requestId];
}

/* ============================================================
   downloadModel() — para el botón "Descargar modelo"
   ============================================================ */
export async function downloadModel() {
  const status = document.querySelector('#model-download-status');
  const progress = document.querySelector('#model-download-progress');
  const complete = document.querySelector('#model-complete');
  if (progress) { progress.hidden = false; progress.value = 5; }
  if (status) status.textContent = 'Preparando descarga local…';
  try {
    // El botón representa la transición pendiente: initWorker necesita el modo
    // operativo IA para cargar, pero el estado queda confirmado solo si termina.
    const previousMode = state.mode;
    state.mode = 'ia';
    try {
      await initWorker();
    } catch (err) {
      state.mode = previousMode;
      throw err;
    }
    // Bug 5 fix: solo setear 100% si initWorker tuvo éxito (no antes del try).
    if (progress) progress.value = 100;
    if (status) status.textContent = '✓ 2 modelos listos en este navegador.';
    if (complete) complete.hidden = false;
  } catch (err) {
    // initWorker falló: no forzar 100%, mostrar el error real.
    if (status) status.textContent = 'No se pudo descargar: ' + (err.message || 'error desconocido');
    throw err;
  }
}
