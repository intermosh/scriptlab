/* ai-worker.js — Motor de análisis de embeddings para ScriptLab
   Modelo: Xenova/multilingual-e5-small (norma L2 habilitada → dot = coseno) */
let extractor = null;
let mode = 'basic';

async function loadExtractor() {
  if (extractor) return extractor;
  const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
  env.useBrowserCache = true;
  env.allowRemoteModels = true;
  extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    device: 'wasm',
    progress_callback: p => postMessage({
      type: 'PROGRESS',
      message: p.status === 'progress'
        ? 'Descargando modelo: ' + Math.round(p.progress || 0) + '%'
        : 'Preparando modelo local\u2026'
    })
  });
  return extractor;
}

/* ---------- sanitización de texto ---------- */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return ' ';
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')   // control chars
    .replace(/[\u200B-\u200D\uFEFF]/g, '')                   // zero-width, BOM
    .replace(/[\uD800-\uDFFF]/g, '')                         // surrogate pairs rotos
    .replace(/[\uE000-\uF8FF]/g, '')                         // private use area
    .replace(/[\uFFFE\uFFFF]/g, '')                          // non-characters
    .replace(/[\u{10000}-\u{10FFFF}]/gu, c => {              // chars fuera BMP: mantener solo CJK comun + latin extendido
      const cp = c.codePointAt(0);
      if (cp >= 0x10000 && cp <= 0x2FFFF) return c;  // CJK, símbolos extendidos
      return '';
    })
    .trim() || ' ';
}

/* ---------- utilidades vectoriales ---------- */
function dot(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function cosineSim(a, b) {
  if (!a || !b) return 0;
  const d = dot(a, b);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return d / (na * nb || 1);
}

/* Genera embeddings para un array de {id, text}.
   - Sanitiza cada texto para evitar token IDs fuera de rango.
   - Trunca a 512 tokens (límite de e5-small).
   - Si falla un batch, reintenta uno por uno para no perder todo. */
async function embedTexts(texts) {
  const model = await loadExtractor();
  const results = [];
  const BATCH = 8;
  const OPTS = { pooling: 'mean', normalize: true, truncation: true, max_length: 512 };

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const safe = batch.map(t => sanitizeText(t.text));
    try {
      const output = await model(safe, OPTS);
      const vectors = output.tolist();
      batch.forEach((t, j) => results.push({ id: t.id, embedding: vectors[j] }));
    } catch (_) {
      /* Batch falló — procesar uno por uno */
      for (let j = 0; j < batch.length; j++) {
        try {
          const output = await model([safe[j]], OPTS);
          const vectors = output.tolist();
          results.push({ id: batch[j].id, embedding: vectors[0] });
        } catch (__) {
          results.push({ id: batch[j].id, embedding: null });
        }
      }
    }
  }
  return results;
}

/* ---------- handlers por tipo de mensaje ---------- */

/* EMBED original — retrocompatibilidad con app.js */
async function handleEmbed(data) {
  const texts = [
    { id: 'title', text: data.texts.find(t => t.id === 'title')?.text || '', role: 'title' },
    { id: 'promise', text: data.texts.find(t => t.id === 'promise')?.text || '', role: 'promise' },
    ...data.texts.filter(t => t.role === 'block')
  ];
  const hookItem = data.texts.find(t => t.id === 'hook');
  if (hookItem) texts.push({ id: 'hook', text: hookItem.text, role: 'hook' });

  const embedded = await embedTexts(texts);
  const map = Object.fromEntries(embedded.map(e => [e.id, e.embedding]));

  const blocks = data.texts.filter(x => x.role === 'block');
  const adj = [];
  for (let i = 1; i < blocks.length; i++) {
    adj.push(dot(map[blocks[i - 1].id], map[blocks[i].id]));
  }
  return {
    type: 'EMBED_RESULT',
    requestId: data.requestId,
    cacheId: data.cacheId,
    alignment: dot(map.hook, map.promise),
    titleAlignment: dot(map.hook, map.title),
    redundancy: adj.length ? Math.max(...adj) : 0,
    confidence: 0.72
  };
}

/* ACTUALIZACIÓN 1 — Resumen extractivo (oraciones clave) */
async function handleExtractKeySentences(data) {
  const { sentences, topN = 5 } = data;
  const allTexts = [
    { id: '__full__', text: data.fullText || '' },
    ...sentences.map((s, i) => ({ id: 's' + i, text: s }))
  ];
  const embedded = await embedTexts(allTexts);
  const map = Object.fromEntries(embedded.map(e => [e.id, e.embedding]));
  const fullEmb = map['__full__'];

  const scored = sentences.map((s, i) => ({
    index: i,
    text: s,
    score: cosineSim(fullEmb, map['s' + i])
  }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN);
  top.sort((a, b) => a.index - b.index); // restaurar orden original

  return { type: 'EXTRACT_KEY_RESULT', requestId: data.requestId, sentences: top };
}

/* ACTUALIZACIÓN 2 — Redundancia global (detección de repetición semántica) */
async function handleRedundancy(data) {
  const { blocks, threshold = 0.85 } = data;
  const texts = blocks.map((b, i) => ({ id: 'b' + i, text: b }));
  const embedded = await embedTexts(texts);
  const vecs = embedded.map(e => e.embedding);

  const n = vecs.length;
  const matrix = [];
  let totalSim = 0;
  let pairs = 0;
  const redundant = [];

  for (let i = 0; i < n; i++) {
    matrix[i] = [];
    for (let j = i + 1; j < n; j++) {
      const sim = dot(vecs[i], vecs[j]);
      matrix[i][j] = sim;
      totalSim += sim;
      pairs++;
      if (sim > threshold && i !== j) {
        redundant.push({ i, j, similarity: sim, textA: blocks[i], textB: blocks[j] });
      }
    }
  }

  const globalIndex = pairs > 0 ? totalSim / pairs : 0;
  const density = Math.max(0, Math.min(1, 1 - globalIndex));

  return {
    type: 'REDUNDANCY_RESULT',
    requestId: data.requestId,
    redundantPairs: redundant.sort((a, b) => b.similarity - a.similarity),
    globalIndex,
    density,
    totalBlocks: n,
    totalPairs: pairs,
    redundantCount: redundant.length
  };
}

/* ACTUALIZACIÓN 3 — Densidad temática por minuto */
async function handleDensity(data) {
  const { segments, fullText } = data;
  const allTexts = [
    { id: '__global__', text: fullText || segments.map(s => s.text).join(' ') },
    ...segments.map((s, i) => ({ id: 'seg' + i, text: s.text }))
  ];
  const embedded = await embedTexts(allTexts);
  const map = Object.fromEntries(embedded.map(e => [e.id, e.embedding]));
  const globalEmb = map['__global__'];

  const n = segments.length;
  const globalSims = [];
  const transitionSims = [];

  for (let i = 0; i < n; i++) {
    const simGlobal = dot(map['seg' + i], globalEmb);
    globalSims.push(simGlobal);
    if (i > 0) {
      transitionSims.push(dot(map['seg' + i - 1], map['seg' + i]));
    }
  }

  const avgGlobalSim = globalSims.length ? globalSims.reduce((a, b) => a + b, 0) / globalSims.length : 0;
  const avgTransition = transitionSims.length ? transitionSims.reduce((a, b) => a + b, 0) / transitionSims.length : 0;
  const density = Math.max(0, 1 - avgGlobalSim);

  /* Estimación de temas por minuto */
  const estimatedMinutes = Math.max(1, n);
  const topicsPerMinute = density * 2.5; // escala heurística

  /* Identificar cambios temáticos */
  const changes = [];
  for (let i = 0; i < transitionSims.length; i++) {
    if (transitionSims[i] < avgTransition - 0.1) {
      changes.push({ afterSegment: i + 1, similarity: transitionSims[i] });
    }
  }

  return {
    type: 'DENSITY_RESULT',
    requestId: data.requestId,
    globalSims,
    transitionSims,
    density,
    avgGlobalSim,
    avgTransition,
    topicsPerMinute: Math.round(topicsPerMinute * 10) / 10,
    segments: segments.map((s, i) => ({
      index: i,
      label: s.label || 'Segmento ' + (i + 1),
      globalSim: globalSims[i]
    })),
    changes,
    totalSegments: n
  };
}

/* ACTUALIZACIÓN 4 — Comparación A/B semántica */
async function handleCompare(data) {
  const { script1, script2, blocks1, blocks2 } = data;
  const texts = [
    { id: '__s1__', text: script1 },
    { id: '__s2__', text: script2 }
  ];
  const embedded = await embedTexts(texts);
  const map = Object.fromEntries(embedded.map(e => [e.id, e.embedding]));

  const globalSim = dot(map['__s1__'], map['__s2__']);

  /* Desglose por bloques (opcional) */
  let blockBreakdown = null;
  if (blocks1 && blocks2) {
    const allBlocks = [
      ...blocks1.map((b, i) => ({ id: 'a' + i, text: b, group: 1, index: i })),
      ...blocks2.map((b, i) => ({ id: 'b' + i, text: b, group: 2, index: i }))
    ];
    const bEmb = await embedTexts(allBlocks);
    const bMap = Object.fromEntries(bEmb.map(e => [e.id, e.embedding]));

    const divergent = [];
    for (let i = 0; i < blocks1.length; i++) {
      let maxSim = 0;
      for (let j = 0; j < blocks2.length; j++) {
        const s = dot(bMap['a' + i], bMap['b' + j]);
        if (s > maxSim) maxSim = s;
      }
      divergent.push({ blockIndex: i, text: blocks1[i], maxSimilarity: maxSim });
    }
    for (let j = 0; j < blocks2.length; j++) {
      let maxSim = 0;
      for (let i = 0; i < blocks1.length; i++) {
        const s = dot(bMap['b' + j], bMap['a' + i]);
        if (s > maxSim) maxSim = s;
      }
      divergent.push({ blockIndex: j, text: blocks2[j], maxSimilarity: maxSim, group: 2 });
    }
    divergent.sort((a, b) => a.maxSimilarity - b.maxSimilarity);
    blockBreakdown = divergent.slice(0, 10);
  }

  let interpretation = 'muy diferente';
  if (globalSim > 0.9) interpretation = 'casi idéntico';
  else if (globalSim > 0.75) interpretation = 'muy similar';
  else if (globalSim > 0.5) interpretation = 'similar en temas principales';
  else if (globalSim > 0.3) interpretation = 'parcialmente diferente';
  else interpretation = 'muy diferente';

  return {
    type: 'COMPARE_RESULT',
    requestId: data.requestId,
    globalSimilarity: globalSim,
    interpretation,
    blockBreakdown
  };
}

/* ACTUALIZACIÓN 5 — Detección de huecos con temas predefinidos */
async function handleGaps(data) {
  const { blocks, topics } = data;
  const blockTexts = blocks.map((b, i) => ({ id: 'b' + i, text: b }));
  const topicTexts = topics.map((t, i) => ({ id: 't' + i, text: t.text }));

  const allTexts = [...blockTexts, ...topicTexts];
  const embedded = await embedTexts(allTexts);
  const map = Object.fromEntries(embedded.map(e => [e.id, e.embedding]));

  const gaps = [];
  const covered = [];
  for (let i = 0; i < topics.length; i++) {
    let maxSim = 0;
    let bestBlock = -1;
    for (let j = 0; j < blocks.length; j++) {
      const s = dot(map['t' + i], map['b' + j]);
      if (s > maxSim) { maxSim = s; bestBlock = j; }
    }
    const item = { topic: topics[i].label || topics[i].text, maxSimilarity: maxSim, bestBlock };
    if (maxSim < (data.threshold || 0.55)) {
      gaps.push(item);
    } else {
      covered.push(item);
    }
  }

  return {
    type: 'GAPS_RESULT',
    requestId: data.requestId,
    gaps,
    covered,
    totalTopics: topics.length,
    gapCount: gaps.length
  };
}

/* ACTUALIZACIÓN 6-8 — EMBED_TEXTS genérico (para referentes) */
async function handleEmbedTexts(data) {
  const { texts } = data;
  const embedded = await embedTexts(texts);
  const map = Object.fromEntries(embedded.map(e => [e.id, e.embedding]));
  return { type: 'EMBED_TEXTS_RESULT', requestId: data.requestId, embeddings: map };
}

/* ACTUALIZACIÓN 8 — Huecos comparando con referente */
async function handleRefGaps(data) {
  const { scriptBlocks, refBlocks, threshold = 0.5 } = data;
  const sTexts = scriptBlocks.map((b, i) => ({ id: 's' + i, text: b }));
  const rTexts = refBlocks.map((b, i) => ({ id: 'r' + i, text: b }));
  const allTexts = [...sTexts, ...rTexts];

  const embedded = await embedTexts(allTexts);
  const sMap = Object.fromEntries(
    embedded.filter(e => e.id.startsWith('s')).map(e => [e.id, e.embedding])
  );
  const rMap = Object.fromEntries(
    embedded.filter(e => e.id.startsWith('r')).map(e => [e.id, e.embedding])
  );

  /* Para cada bloque del referente, encontrar similitud máxima con cualquier bloque del guion */
  const missingInScript = [];
  for (let j = 0; j < refBlocks.length; j++) {
    let maxSim = 0;
    for (let i = 0; i < scriptBlocks.length; i++) {
      const s = dot(sMap['s' + i], rMap['r' + j]);
      if (s > maxSim) maxSim = s;
    }
    if (maxSim < threshold) {
      missingInScript.push({ refBlockIndex: j, text: refBlocks[j], maxSimilarity: maxSim });
    }
  }

  /* Viceversa: bloques del guion sin correspondencia en referente */
  const uniqueToScript = [];
  for (let i = 0; i < scriptBlocks.length; i++) {
    let maxSim = 0;
    for (let j = 0; j < refBlocks.length; j++) {
      const s = dot(sMap['s' + i], rMap['r' + j]);
      if (s > maxSim) maxSim = s;
    }
    if (maxSim < threshold) {
      uniqueToScript.push({ scriptBlockIndex: i, text: scriptBlocks[i], maxSimilarity: maxSim });
    }
  }

  return {
    type: 'REF_GAPS_RESULT',
    requestId: data.requestId,
    missingInScript: missingInScript.sort((a, b) => a.maxSimilarity - b.maxSimilarity),
    uniqueToScript: uniqueToScript.sort((a, b) => a.maxSimilarity - b.maxSimilarity),
    totalRefBlocks: refBlocks.length,
    totalScriptBlocks: scriptBlocks.length
  };
}

/* ---------- dispatcher principal ---------- */
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'INIT') {
      mode = data.mode || 'basic';
      if (mode === 'embeddings') {
        postMessage({ type: 'PROGRESS', message: 'Cargando motor IA local\u2026' });
        await loadExtractor();
      }
      postMessage({ type: 'READY', mode });
      return;
    }

    /* Todas las operaciones de embeddings requieren modo embeddings */
    if (mode !== 'embeddings') {
      postMessage({ type: 'ERROR', requestId: data.requestId, message: 'Modo embeddings no activo. Activá el modo AI primero.' });
      return;
    }

    let result;
    switch (data.type) {
      case 'EMBED':
        result = await handleEmbed(data);
        break;
      case 'EXTRACT_KEY_SENTENCES':
        result = await handleExtractKeySentences(data);
        break;
      case 'COMPUTE_REDUNDANCY':
        result = await handleRedundancy(data);
        break;
      case 'COMPUTE_DENSITY':
        result = await handleDensity(data);
        break;
      case 'COMPARE_SCRIPTS':
        result = await handleCompare(data);
        break;
      case 'DETECT_GAPS':
        result = await handleGaps(data);
        break;
      case 'EMBED_TEXTS':
        result = await handleEmbedTexts(data);
        break;
      case 'COMPUTE_REF_GAPS':
        result = await handleRefGaps(data);
        break;
      default:
        postMessage({ type: 'ERROR', requestId: data.requestId, message: 'Tipo de mensaje desconocido: ' + data.type });
        return;
    }
    postMessage(result);
  } catch (error) {
    postMessage({ type: 'ERROR', requestId: data.requestId, message: error.message || 'Error desconocido en worker' });
  }
};