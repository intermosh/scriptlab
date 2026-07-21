/* sentiment-worker.js — Análisis de sentimiento (arco emocional) para ScriptLab v4.
   Implementa §13.9 (sentiment-worker), §6.2, §7.6 + §7.6.1 del contrato.
   Modelo: Xenova/robertuito-sentiment-analysis (ONNX cuantizado, ~95 MB).
   Base: pysentimiento/robertuito-sentiment-analysis (RoBERTuito, español, POS/NEG/NEU).
   Carga transformers.js vía import map (CDN esm.sh, decisión D6).

   REGLA DE ORO: computa, NO genera texto (§1.2). */

// transformers.js con import() DINÁMICO dentro de init() (ver ai-worker.js para justificación).
import { sanitizeSentimentText } from './ai-shared.js';

// transformers.js — patrón copiado del software base (ver ai-worker.js para detalle).
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';

let classifier = null;

/* ============================================================
   INIT — carga el modelo, reporta progreso y READY
   ============================================================ */
async function init() {
  if (classifier) { self.postMessage({ type: 'READY' }); return; }
  self.postMessage({ type: 'PROGRESS', message: 'Cargando sentimiento…' });

  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.useBrowserCache = true;
  env.allowRemoteModels = true;

  classifier = await pipeline('text-classification', 'Xenova/robertuito-sentiment-analysis', {
    device: 'wasm',
    progress_callback: (p) => {
      self.postMessage({
        type: 'PROGRESS',
        message: p.status === 'progress'
          ? 'Descargando sentimiento: ' + Math.round(p.progress || 0) + '%'
          : 'Preparando sentimiento…'
      });
    }
  });

  self.postMessage({ type: 'READY' });
}

/* ============================================================
   Convierte salida del modelo {label, score} → valencia [-1, 1]
   POS: +score, NEG: -score, NEU: 0.
   ============================================================ */
function toValence(result) {
  // result puede ser {label, score} o array (topk). Tomamos el primero.
  const r = Array.isArray(result) ? result[0] : result;
  const label = (r.label || 'NEU').toUpperCase();
  const score = typeof r.score === 'number' ? r.score : 0;
  if (label === 'POS') return score;
  if (label === 'NEG') return -score;
  return 0; // NEU
}

/* ============================================================
   classifyTexts — clasifica en batches con retry uno-por-uno.
   Defensa contra el bug "Cannot convert undefined to a BigInt" de
   transformers.js (tensor con valor undefined, típicamente por texto
   problemático en el batch). Patrón copiado del software base (embedTexts).
   Devuelve resultados alineados con el input; los que fallan → null.
   ============================================================ */
async function classifyTexts(texts) {
  const results = new Array(texts.length).fill(null);
  const BATCH = 8;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    try {
      const out = await classifier(batch);
      const arr = Array.isArray(out) ? out : [out];
      arr.forEach((r, j) => { results[i + j] = r; });
    } catch (_) {
      // Batch falló — procesar uno por uno para no perder todo.
      for (let j = 0; j < batch.length; j++) {
        try {
          const out = await classifier([batch[j]]);
          const arr = Array.isArray(out) ? out : [out];
          results[i + j] = arr[0];
        } catch (__) {
          results[i + j] = null; // este texto no se pudo clasificar
        }
      }
    }
  }
  return results;
}

/* ============================================================
   SENTIMENT — clasifica cada texto, arma arco + agregados.
   Umbrales de salto tonal §7.6.1 (recalibrados con base VADER):
     detección mínima |Δ| ≥ 0.25; bajo < 0.50; medio < 0.75; alto ≥ 0.75.
   [INFERIDO de VADER (Hutto & Gilbert 2014, ICWSM), escala -4..+4 → -1..+1 ÷4 lineal]
   ============================================================ */
async function sentiment({ requestId, texts, blockIds, blockIndices, blockTypes }) {
  // Saltar textos vacíos/muy cortos (no aparecen en sentimentArc).
  const eligible = [];
  for (let i = 0; i < texts.length; i++) {
    const t = sanitizeSentimentText(texts[i]);
    if (t.length >= 4) eligible.push({ idx: i, text: t });
  }

  if (eligible.length === 0) {
    self.postMessage({
      type: 'SENTIMENT_RESULT', requestId,
      sentimentArc: [], engagementScore: 0, emotionalMomentum: 0, tonalJumps: []
    });
    return;
  }

  // Clasificar todos los elegibles (con defensa BigInt: batches + retry).
  const rawResults = await classifyTexts(eligible.map(e => e.text));

  const sentimentArc = [];
  eligible.forEach((e, k) => {
    const r = rawResults[k];
    if (!r) return; // este texto falló al clasificar → se omite del arco
    const valence = toValence(r);
    const label = valence > 0.05 ? 'POS' : valence < -0.05 ? 'NEG' : 'NEU';
    sentimentArc.push({
      blockId: blockIds[e.idx],
      blockIndex: blockIndices[e.idx],
      blockType: blockTypes[e.idx],
      label,
      valence: Math.round(valence * 1000) / 1000
    });
  });

  if (sentimentArc.length === 0) {
    self.postMessage({
      type: 'SENTIMENT_RESULT', requestId,
      sentimentArc: [], engagementScore: 0, emotionalMomentum: 0, tonalJumps: []
    });
    return;
  }

  const valences = sentimentArc.map(p => p.valence);

  // --- Engagement: min(1, varianza*2 + |media|*0.5) (§7.6) ---
  const mean = valences.reduce((a, b) => a + b, 0) / (valences.length || 1);
  const variance = valences.reduce((s, v) => s + (v - mean) ** 2, 0) / (valences.length || 1);
  const engagementScore = Math.min(1, variance * 2 + Math.abs(mean) * 0.5);

  // --- Momentum: media(último tercio) − media(primer tercio) (§7.6) ---
  const third = Math.max(1, Math.floor(valences.length / 3));
  const firstThird = valences.slice(0, third);
  const lastThird = valences.slice(-third);
  const meanF = firstThird.reduce((a, b) => a + b, 0) / (firstThird.length || 1);
  const meanL = lastThird.reduce((a, b) => a + b, 0) / (lastThird.length || 1);
  const emotionalMomentum = Math.round((meanL - meanF) * 1000) / 1000;

  // --- Saltos tonales (§7.6.1, umbrales VADER) ---
  const tonalJumps = [];
  for (let i = 1; i < sentimentArc.length; i++) {
    const delta = Math.abs(sentimentArc[i].valence - sentimentArc[i - 1].valence);
    // Detección mínima |Δ| ≥ 0.25.
    // [INFERIDO VADER: neutral→"okay"=0.225 redondeado]
    if (delta >= 0.25) {
      let severity;
      // Bandas VADER normalizadas:
      //   bajo: 0.25–0.50 (neutral→"good"=0.475)
      //   medio: 0.50–0.75 (neutral→"great"/"horrible"=0.775/0.625)
      //   alto: ≥0.75 (cambio de signo con intensidad)
      if (delta >= 0.75) severity = 'high';
      else if (delta >= 0.50) severity = 'medium';
      else severity = 'low';
      tonalJumps.push({
        fromBlock: sentimentArc[i - 1].blockIndex,
        toBlock: sentimentArc[i].blockIndex,
        fromLabel: sentimentArc[i - 1].label,
        toLabel: sentimentArc[i].label,
        deltaValence: Math.round(delta * 1000) / 1000,
        severity
      });
    }
  }

  self.postMessage({
    type: 'SENTIMENT_RESULT',
    requestId,
    sentimentArc,
    engagementScore: Math.round(engagementScore * 1000) / 1000,
    emotionalMomentum,
    tonalJumps
  });
}

/* ============================================================
   Router de mensajes
   ============================================================ */
self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case 'INIT':
        await init();
        break;
      case 'SENTIMENT':
        await sentiment(data);
        break;
      default:
        self.postMessage({ type: 'ERROR', requestId: data.requestId, message: 'Tipo desconocido: ' + data.type });
    }
  } catch (error) {
    self.postMessage({ type: 'ERROR', requestId: data.requestId, message: error.message || 'Error en sentiment-worker' });
  }
};
