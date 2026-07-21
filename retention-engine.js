/* retention-engine.js — Lógica pura del motor de retención.
   Implementa §7.3 (con Apéndice A) y §6.3 del contrato.
   LÓGICA PURA: sin DOM, sin Web Worker plumbing — testeable en Node.
   Importa de: ai-shared.js (primitivas léxicas + Fernández-Huerta), decisión D1.

   NOTA DE ARQUITECTURA (desvío aprobado por el humano, D3):
   El contrato §13.9 nombra solo `retention-worker.js`. Separamos la lógica
   pura en este archivo `retention-engine.js` para poder testearla en Node
   sin levantar un Worker. `retention-worker.js` queda como wrapper delgado.
   El grafo de §3.2 se extiende con este módulo (importado por el worker).

   REGLA DE ORO (§7.3 + Apéndice A): cada peso y cada umbral numérico lleva
   comentario con la cita de su fuente. No se aceptan valores sin
   documentación. */

import { wordCount, sentenceCount, syllables, fernandezHuerta, durationInSeconds } from './ai-shared.js';

/* ============================================================
   PESOS DEL MODELO PONDERADO (§7.3, tabla recalibrada; suma = 1.00)
   Cada peso con cita inline. Etiqueta epistémica en el comentario.
   ============================================================ */
export const WEIGHTS = {
  // Hook 0.25 — PrePublish 2026 (5k scripts: value claim en 15s → 52% vs 44% retención);
  //              Think with Google 2024 (+47% AVD); Backlinko (1.3M videos, caída 30-45s);
  //              RetentionRabbit 2025 (+18% retención al min 1).
  //              [SECUNDARIA convergente — múltiples estudios independientes coinciden]
  hookStrength: 0.25,

  // Pacing 0.17 — Seidel (2024) Springer "Short, Long, and Segmented Learning Videos"
  //               (1.419 canales + N=22 controlado: segmentación = mayores ganancias de aprendizaje);
  //               PrePublish 5k-script: "pacing variation > vocabulary quality".
  //               [PRIMARIA + SECUNDARIA]
  pacingScore: 0.17,

  // Pattern interrupts 0.14 — Kahneman (1973) "Attention and Effort" orienting response [PRIMARIA teoría];
  //                           Sokolov (1963) habituación [PRIMARIA teoría];
  //                           ytshark/longstories 2026 (+23% retención con interrupt en primeros 5s);
  //                           EdicionVideoPro 2026 (+40-60% con interrupts cada 3-5s, 200+ TikToks).
  //                           [PRIMARIA teoría + SECUNDARIA cuantitativa]
  patternInterrupts: 0.14,

  // Emotional arc 0.11 — Berger, Levermann et al. (2026) Springer "How should content creators
  //                      narrate their content?" (33.598 YouTube podcasts + 3.381 TED Talks + lab:
  //                      emotionality flips ↑ engagement, arousal = mecanismo confirmado causal);
  //                      Song et al. (2023) eNeuro (engagement sigue dramatic arc, predecible por dISC);
  //                      Knobloch-Westerwick et al. (2015).
  //                      [PRIMARIA causal — peso subido desde 0.08 en v16 por evidencia nueva]
  emotionalArc: 0.11,

  // Content density 0.11 — Miller (1956) "Magical Number Seven" (working memory 7±2 chunks);
  //                        Sweller (1988) Cognitive Load Theory;
  //                        AERO 2023 / ACER 2022 (chunking ↑ recall y engagement).
  //                        [PRIMARIA teoría; traducción a temas/min es INFERENCIAL]
  contentDensity: 0.11,

  // Promise delivery 0.09 — RetentionRabbit 2025 (value prop en 15s → +18% retención al min 1, correlacional);
  //                         PrePublish 2026 (payoff-at-15 test).
  //                         [SECUNDARIA correlacional — no causal]
  promiseDelivery: 0.09,

  // Readability 0.07 — Fernández-Huerta (1959) "Medidas sencillas de lecturabilidad" Consigna 214
  //                    (fórmula validada, constantes 206.84/60/1.02).
  //                    [PRIMARIA fórmula; mapeo "FH → retención de video" es INFERENCIAL]
  readability: 0.07,

  // CTA placement 0.03 — ClixieAI 2025 (mid-roll CTAs convierten 16.95% vs end-roll);
  //                      Wistia (guías de placement por duración); sender.net 2026 (~16% conversión video).
  //                      [SECUNDARIA indirecta — mide CONVERSIÓN, no retención; por eso peso bajo]
  ctaPlacement: 0.03,

  // Narrative completeness 0.03 — Song et al. (2023) eNeuro (engagement sigue dramatic arc);
  //                              USC study (70% top films siguen framework reconocible);
  //                              Booker (2004) "Seven Basic Plots".
  //                              [PRIMARIA estructura; peso bajo: necesaria pero no suficiente]
  narrativeCompleteness: 0.03
};

// Sanity check en tiempo de carga: la suma de pesos debe ser 1.00.
// [NO VALIDADO como sistema — cada peso se justifica individualmente, Apéndice A]
const _SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(_SUM - 1) > 1e-9) {
  throw new Error('WEIGHTS no suma 1.00: suma=' + _SUM + '. Revisar §7.3.');
}

/* ============================================================
   CURVAS DE RETENCIÓN BASELINE (§7.3, "Curva de retención")
   Valores por posición relativa (0-1) en el video.
   Fuente baseline: Wistia State of Video Report 2025 (800k+ videos, completion ~45%);
                    RetentionRabbit 2025 (overall avg 23.7%, 55% perdidos al min 1).
   Los valores numéricos exactos son interpolaciones propias basadas en la forma
   general de las curvas publicadas.
   [NO VALIDADO numéricamente — forma de curva basada en Wistia/RetentionRabbit]
   ============================================================ */
export const RETENTION_CURVES = {
  baseline: [
    // Curva estándar (hook promedio/débil). Wistia 2025: ~18% drop en primeros 5%.
    { pos: 0.00, ret: 1.00 },
    { pos: 0.05, ret: 0.82 },
    { pos: 0.10, ret: 0.72 },
    { pos: 0.20, ret: 0.62 },
    { pos: 0.30, ret: 0.55 },
    { pos: 0.50, ret: 0.48 },  // Wistia 2025: completion ~45%
    { pos: 0.70, ret: 0.42 },
    { pos: 0.85, ret: 0.38 },
    { pos: 1.00, ret: 0.35 }
  ],
  strongHook: [
    // Curva con hook fuerte (retiene más en primeros 5%).
    // Basada en YouTube Creator Insider: retener 80%+ en primeros 30s.
    { pos: 0.00, ret: 1.00 },
    { pos: 0.05, ret: 0.92 },
    { pos: 0.10, ret: 0.85 },
    { pos: 0.20, ret: 0.76 },
    { pos: 0.30, ret: 0.70 },
    { pos: 0.50, ret: 0.62 },
    { pos: 0.70, ret: 0.55 },
    { pos: 0.85, ret: 0.50 },
    { pos: 1.00, ret: 0.47 }
  ]
};

/* ============================================================
   8 FUNCIONES analyzeX — cada una devuelve { score:0-100, formula, ... }
   Umbrales documentados inline. Pesos internos marcados [NO VALIDADO].
   ============================================================ */

/* --- HOOK (§7.3.1, peso 0.25) --- */
function analyzeHook(hookBlock, promise, allBlocks) {
  // Detección de hook efectivo: explícito (tipo HOOK) o implícito (primer bloque
  // con pregunta/brevedad/urgencia).
  let effectiveHook = hookBlock;
  let isImplicit = false;
  if (!effectiveHook && allBlocks.length > 0) {
    const first = allBlocks[0];
    const content = first.content || '';
    const hasQuestion = /[?¿]/.test(content);
    const isShort = wordCount(content) <= 40;
    const hasUrgency = /ahora|hoy|descubr[ií]|secreto|nunca|siempre|error|truc[oa]|incre[ií]ble|sorprendente|clave|esencial/i.test(content);
    if (hasQuestion || isShort || hasUrgency) { effectiveHook = first; isImplicit = true; }
  }
  if (!effectiveHook) return { score: 0, reasons: ['Sin Hook definido'], formula: 'Sin hook → 0 pts' };

  const content = effectiveHook.content || '';
  const wc = wordCount(content);
  const reasons = [];
  let score = 0;

  // Longitud: 15-80 palabras = óptimo (§7.1 hs; referencia PrePublish payoff-at-15).
  if (wc >= 15 && wc <= 80) { score += isImplicit ? 20 : 30; reasons.push('Longitud óptima del hook (15-80 palabras)'); }
  else if (wc >= 10 && wc < 15) { score += isImplicit ? 10 : 15; reasons.push('Hook algo corto'); }
  else if (wc > 80 && wc <= 120) { score += isImplicit ? 12 : 18; reasons.push('Hook largo pero aceptable'); }
  else if (wc < 10) { score += 3; reasons.push('Hook demasiado corto (<10 palabras)'); }
  else { score += 5; reasons.push('Hook excesivamente largo (>120 palabras)'); }

  if (/[?¿]/.test(content)) { score += 15; reasons.push('Contiene pregunta (curiosity gap)'); }
  if (/\d/.test(content) && wc > 10) { score += 8; reasons.push('Contiene datos/números'); }

  if (promise) {
    const hookWords = new Set((content.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const promiseWords = new Set((promise.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const overlapCount = [...hookWords].filter(w => promiseWords.has(w)).length;
    const overlapRatio = overlapCount / Math.max(1, Math.min(hookWords.size, promiseWords.size));
    // 0.3 / 0.1 umbrales: [NO VALIDADO — heurística de overlap léxico]
    if (overlapRatio > 0.3) { score += 25; reasons.push('Fuerte alineación con promesa'); }
    else if (overlapRatio > 0.1) { score += 12; reasons.push('Alineación parcial con promesa'); }
    else { reasons.push('Débil alineación con promesa'); }
  }

  const urgencyRe = /ahora|hoy|descubr[ií]|secreto|nunca|siempre|error|truc[oa]|incre[ií]ble|sorprendente|importante|clave|esencial/i;
  if (urgencyRe.test(content)) { score += 12; reasons.push('Lenguaje de urgencia/curiosidad'); }
  if (isImplicit) reasons.push('(Hook implícito — primer bloque con características de hook)');

  const formula = `Hook${isImplicit?' implícito':''}: longitud(${wc}pal→${wc>=15&&wc<=80?'>=20':'<20'}pts) + pregunta(${/[?¿]/.test(content)?'+15':'+0'}) + nums(${/\d/.test(content)&&wc>10?'+8':'+0'}) + urgencia(${urgencyRe.test(content)?'+12':'+0'}) → ${Math.min(100, score)}/100`;
  return { score: Math.min(100, score), reasons, formula };
}

/* --- PACING (§7.3.2, peso 0.17) --- */
function analyzePacing(blocks, wpm) {
  if (!blocks.length) return { score: 50, details: [], formula: 'Sin bloques → 50 (default)' };

  const durations = blocks.map(b => durationInSeconds(b.content, wpm));
  const details = [];
  let score = 0;
  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;

  // 15-45s óptimo. [NO VALIDADO — sweet spot interno]
  if (avgDur >= 15 && avgDur <= 45) { score += 25; details.push('Duración promedio óptima (' + Math.round(avgDur) + 's)'); }
  else if (avgDur >= 10 && avgDur < 15) { score += 15; details.push('Bloques algo cortos'); }
  else if (avgDur > 45 && avgDur <= 70) { score += 12; details.push('Bloques algo largos'); }
  else { score += 5; details.push('Duración fuera de rango'); }

  // CV: 0.3-0.8 = ritmo variable saludable (Seidel 2024 segmentación).
  const mean = avgDur;
  const variance = durations.reduce((s, d) => s + (d - mean) ** 2, 0) / durations.length;
  const cv = Math.sqrt(variance) / (mean || 1);
  if (cv > 0.3 && cv < 0.8) { score += 25; details.push('Buen ritmo variable (CV: ' + cv.toFixed(2) + ')'); }
  else if (cv > 0.15 && cv <= 0.3) { score += 12; details.push('Ritmo algo monótono'); }
  else if (cv <= 0.15) { score += 5; details.push('Ritmo monótono (CV ≤0.15)'); }
  else { score += 8; details.push('Ritmo errático (CV >0.8)'); }

  // Penalización por bloques >50s. [NO VALIDADO — umbral interno]
  const longBlocks = durations.filter(d => d > 50).length;
  if (longBlocks === 0) { score += 15; details.push('Sin bloques >50s'); }
  else { score += Math.max(0, 15 - longBlocks * 8); details.push(longBlocks + ' bloque(s) >50s'); }

  // Varianza de longitud de oraciones (PrePublish: pacing variation > vocabulary).
  const sentLens = blocks.map(b => (b.content || '').split(/[.!?]+/).filter(s => s.trim()).map(s => wordCount(s)));
  const allSentLens = sentLens.flat();
  if (allSentLens.length > 2) {
    const sMean = allSentLens.reduce((a, b) => a + b, 0) / allSentLens.length;
    const sVar = allSentLens.reduce((s, l) => s + (l - sMean) ** 2, 0) / allSentLens.length;
    const sCv = Math.sqrt(sVar) / (sMean || 1);
    if (sCv > 0.3 && sCv < 1) { score += 10; details.push('Buena varianza de oraciones'); }
    else if (sCv <= 0.3) { details.push('Oraciones monótonas'); }
  }

  // Vacíos: -5 c/u. [NO VALIDADO — penalización interna]
  const emptyBlocks = blocks.filter(b => !b.content?.trim()).length;
  if (emptyBlocks > 0) { score -= emptyBlocks * 5; details.push(emptyBlocks + ' bloque(s) vacíos'); }

  const s = Math.max(0, Math.min(100, score));
  const formula = `Pacing: duración(avg ${Math.round(avgDur)}s) + CV(${cv.toFixed(2)}) + largos(${longBlocks}) + vacíos(${emptyBlocks}×-5) → ${s}/100`;
  return { score: s, details, formula };
}

/* --- PATTERN INTERRUPTS (§7.3.3, peso 0.14) --- */
function analyzePatternInterrupts(blocks) {
  const total = blocks.length;
  if (total < 2) return { score: 30, ratio: 0, formula: '<2 bloques → 30 (default)' };

  // Interruptores: GIRO, VISUAL, CTA (Kahneman 1973 orienting response).
  const interrupts = blocks.filter(b => b.type === 'GIRO' || b.type === 'VISUAL' || b.type === 'CTA').length;
  const ratio = interrupts / total;

  // Sweet spot 15-35%: [NO VALIDADO — extrapolado de práctica de edición cada 3-5s]
  let score;
  if (ratio >= 0.15 && ratio <= 0.35) score = 85 + Math.round((ratio - 0.15) * 75);
  else if (ratio >= 0.10 && ratio < 0.15) score = 60;
  else if (ratio > 0.35 && ratio <= 0.50) score = 70;
  else if (ratio < 0.10) score = 30 + Math.round(ratio * 200);
  else score = 50;

  const s = Math.min(100, score);
  const formula = `Interrupts: ${interrupts}/${total} bloques (${(ratio*100).toFixed(0)}%) → ${s}/100 (sweet spot: 15-35%)`;
  return { score: s, ratio, formula };
}

/* --- CONTENT DENSITY (§7.3.5, peso 0.11) --- */
function analyzeContentDensity(blocks, wpm) {
  const fullText = blocks.map(b => b.content).join(' ');
  const totalMinutes = wordCount(fullText) / (wpm || 150);
  if (totalMinutes < 0.5) return { score: 50, topicsPerMinute: 0, formula: '<0.5 min → 50 (default)' };

  // Detección de cambios temáticos por overlap léxico (Miller 1956 / Sweller 1988).
  // Umbral <15% overlap = tema distinto. [NO VALIDADO — heurística léxica]
  const topicShifts = blocks.filter((b, i) => {
    if (i === 0) return false;
    const prev = blocks[i - 1].content || '';
    const curr = b.content || '';
    const prevWords = new Set((prev.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const currWords = new Set((curr.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const overlapCount = [...currWords].filter(w => prevWords.has(w)).length;
    return overlapCount / Math.max(1, Math.min(prevWords.size, currWords.size)) < 0.15;
  }).length;

  const topicsPerMinute = topicShifts / Math.max(1, totalMinutes);
  // Sweet spot 1.5-3 temas/min. [NO VALIDADO — extrapolado de Miller 7±2 chunks]
  let score;
  if (topicsPerMinute >= 1.5 && topicsPerMinute <= 3) score = 85;
  else if (topicsPerMinute >= 1 && topicsPerMinute < 1.5) score = 65;
  else if (topicsPerMinute > 3 && topicsPerMinute <= 4.5) score = 60;
  else if (topicsPerMinute < 1) score = 35;
  else score = 40;

  const s = Math.min(100, score);
  const formula = `Densidad: ${topicShifts} shifts / ${totalMinutes.toFixed(1)} min = ${topicsPerMinute.toFixed(1)} temas/min → ${s}/100 (ideal: 1.5-3)`;
  return { score: s, topicsPerMinute: Math.round(topicsPerMinute * 10) / 10, formula };
}

/* --- PROMISE DELIVERY (§7.3.6, peso 0.09) --- */
function analyzePromiseDelivery(blocks, promise) {
  if (!promise) return { score: 40, deliveredAt: null, formula: 'Sin promesa → 40 (default)' };

  const promiseWords = new Set((promise.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
  if (promiseWords.size === 0) return { score: 40, deliveredAt: null, formula: 'Promesa sin palabras clave → 40' };

  let bestBlock = -1, bestOverlap = 0;
  blocks.forEach((b, i) => {
    if (i === 0) return; // No contar el hook (ahí vive la promesa, no su entrega).
    const contentWords = new Set((b.content.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const overlapCount = [...contentWords].filter(w => promiseWords.has(w)).length;
    const ratio = overlapCount / Math.max(1, Math.min(contentWords.size, promiseWords.size));
    if (ratio > bestOverlap) { bestOverlap = ratio; bestBlock = i; }
  });

  if (bestBlock < 0) return { score: 20, deliveredAt: null, formula: 'Promesa nunca se resuelve → 20' };

  const relativePosition = bestBlock / Math.max(1, blocks.length - 1);
  // Entrega en primer 30% = mejor retención (RetentionRabbit 2025, correlacional).
  // Umbrales 0.3/0.5 y overlap 0.2/0.15: [NO VALIDADO — recomendación de industria]
  let score;
  if (relativePosition <= 0.3 && bestOverlap > 0.2) score = 90;
  else if (relativePosition <= 0.5 && bestOverlap > 0.15) score = 70;
  else if (bestOverlap > 0.1) score = 50;
  else score = 30;

  const s = Math.min(100, score);
  const formula = `Promesa: bloque #${bestBlock + 1} (${(relativePosition*100).toFixed(0)}% video, overlap ${(bestOverlap*100).toFixed(0)}%) → ${s}/100`;
  return { score: s, deliveredAt: bestBlock, relativePosition, formula };
}

/* --- READABILITY (§7.3.7, peso 0.07) --- */
function analyzeReadability(blocks) {
  const fullText = blocks.map(b => b.content).join(' ');
  const fh = fernandezHuerta(fullText);
  // Rangos FH: 60-80 ideal (lenguaje oral), >90 penaliza infantil. [Mapeo NO VALIDADO]
  let score;
  if (fh >= 60 && fh <= 80) score = 85;
  else if (fh >= 50 && fh < 60) score = 65;
  else if (fh > 80 && fh <= 90) score = 70;
  else if (fh > 90) score = Math.max(25, 55 - (fh - 90) * 2); // penaliza lo infantil
  else if (fh < 50 && fh >= 30) score = 45;
  else score = 25;

  const s = Math.min(100, score);
  const formula = `Legibilidad: FH=${Math.round(fh)} (Fernández-Huerta 1959) → ${s}/100`;
  return { score: s, fh: Math.round(fh), formula };
}

/* --- CTA (§7.3.8, peso 0.03) --- */
function analyzeCTA(blocks) {
  const ctaIdx = blocks.findIndex(b => b.type === 'CTA');
  if (ctaIdx < 0) return { score: 30, position: null, formula: 'Sin CTA → 30 (default)' };

  const relativePos = ctaIdx / Math.max(1, blocks.length - 1);
  const ctaContent = blocks[ctaIdx].content || '';
  const wc = wordCount(ctaContent);
  let score = 40; // Base: tiene CTA. [NO VALIDADO — punto base]

  // 75-95% del video = ideal (Wistia 2026 / ClixieAI 2025). [Recomendación industria]
  if (relativePos >= 0.75 && relativePos <= 0.95) score += 30;
  else if (relativePos >= 0.6 && relativePos < 0.75) score += 20;
  else if (relativePos > 0.95) score += 10;
  else score += 5;

  // 10-40 palabras = ideal. [NO VALIDADO — heurística de longitud]
  if (wc >= 10 && wc <= 40) score += 20;
  else if (wc >= 5 && wc < 10) score += 10;

  // Verbos de acción: +10 (copywriting, Cialdini 1984 compromiso/consistencia).
  if (/(suscrib|compart|coment|like|dale|click|visit|descarg|activ)/i.test(ctaContent)) score += 10;

  const s = Math.min(100, score);
  const formula = `CTA: posición(${(relativePos*100).toFixed(0)}%) + longitud(${wc}pal) → ${s}/100`;
  return { score: s, position: relativePos, formula };
}

/* --- NARRATIVE COMPLETENESS (§7.3.9, peso 0.03) --- */
function analyzeNarrativeCompleteness(blocks) {
  const types = new Set(blocks.map(b => b.type));
  const present = [], missing = [];
  const essentials = [
    { type: 'HOOK', label: 'Hook' },
    { type: 'CONTEXTO', label: 'Contexto' },
    { type: 'EVIDENCIA', label: 'Evidencia' },
    { type: 'CTA', label: 'CTA' }
  ];
  const optional = [
    { type: 'GIRO', label: 'Giro narrativo' },
    { type: 'VISUAL', label: 'Nota visual' }
  ];
  essentials.forEach(e => { types.has(e.type) ? present.push(e.label) : missing.push(e.label); });
  optional.forEach(e => { if (types.has(e.type)) present.push(e.label); });

  // Essentials 4×20=80 base, bonus opcional +10 c/u (max 20). [Distribución NO VALIDADA]
  const essentialScore = ((essentials.length - missing.length) / essentials.length) * 80;
  const bonusScore = Math.min(20, (present.length - essentials.length + missing.length) * 10);
  const s = Math.min(100, Math.round(essentialScore + bonusScore));
  const formula = `Narrativa: ${essentials.length - missing.length}/4 esenciales + bonus opcional → ${s}/100`;
  return { score: s, present, missing, formula };
}

/* ============================================================
   GENERADOR DE CURVA DE RETENCIÓN POR BLOQUE
   Modificadores (§7.3, "Curva de retención"):
   - Pattern interrupt (GIRO/VISUAL): boost determinista con habituation
     baseBoost=0.05 (≈1/3 del piso del rango 15-22% de reengagement spike
     reportado por Wistia, citado en Gopinath 2025 "The Science of YouTube
     Retention Graphs"). Habituation: 1/log2(n+1) (Sokolov 1963 orienting
     response; Rankin et al. 2009 "Habituation revisited" Neurobiology of
     Learning and Memory — decay logarítmico estándar).
     GIRO y VISUAL tratados idénticamente (estricto de literatura: ninguna
     fuente distingue tipo de interrupt en la magnitud del OR).
     [baseBoost INFERIDO (escala conservadora del 15%); habitFactor PRIMARIA]
   - Bloque >50s: -0.04, >80s: -0.06 adicional [NO VALIDADO]
   - Hook fuerte en bloque 0: +0.05 [NO VALIDADO]
   - CTA: +0.03 [NO VALIDADO]
   - Bloque vacío: -0.15 [NO VALIDADO]
   - isDropRisk true cuando retention < 0.35 (RetentionRabbit 2025 completion ~23.7%)
   ============================================================ */
function interpolateRetention(pos, curve) {
  for (let i = 1; i < curve.length; i++) {
    if (pos <= curve[i].pos) {
      const t = (pos - curve[i - 1].pos) / (curve[i].pos - curve[i - 1].pos);
      return curve[i - 1].ret + t * (curve[i].ret - curve[i - 1].ret);
    }
  }
  return curve[curve.length - 1].ret;
}

function generateRetentionCurve(blocks, wpm, hookAnalysis) {
  if (!blocks.length) return [];
  const totalDuration = blocks.reduce((s, b) => s + durationInSeconds(b.content, wpm), 0);
  if (totalDuration === 0) return [];

  // Hook score ≥60 → curva strongHook. [Umbral NO VALIDADO — punto medio]
  const baseCurve = hookAnalysis.score >= 60 ? RETENTION_CURVES.strongHook : RETENTION_CURVES.baseline;
  const points = [];
  let elapsed = 0;
  let interruptCount = 0; // Contador global de pattern interrupts (para habituation)

  blocks.forEach((block, i) => {
    const blockDur = durationInSeconds(block.content, wpm);
    if (blockDur === 0 && !(block.content || '').trim()) {
      // Bloque vacío: igual cuenta como punto con penalización.
    }
    const midTime = elapsed + blockDur / 2;
    const relPos = totalDuration > 0 ? midTime / totalDuration : 0;
    let baseRet = interpolateRetention(relPos, baseCurve);
    let modifier = 0;

    if (block.type === 'GIRO' || block.type === 'VISUAL') {
      interruptCount++;
      // Boost determinista con habituation (no random — bug crítico corregido).
      // baseBoost=0.05: ≈1/3 del piso del rango 15-22% de reengagement spike
      //   reportado por Wistia (citado en Gopinath 2025). Conservador.
      //   [INFERIDO — escalamiento del 15% agregado a fracción por bloque]
      const baseBoost = 0.05;
      // Habituation: el OR decae con la repetición. Decay logarítmico estándar.
      //   [Sokolov (1963) orienting response; Rankin et al. (2009)
      //    "Habituation revisited" Neurobiology of Learning and Memory 92(2)]
      const habitFactor = 1 / Math.log2(interruptCount + 1);
      modifier += baseBoost * habitFactor;
    }
    if (blockDur > 50) modifier -= 0.04;
    if (blockDur > 80) modifier -= 0.06;
    if (i === 0 && hookAnalysis.score >= 60) modifier += 0.05;
    if (block.type === 'CTA') modifier += 0.03;
    if (!(block.content || '').trim()) modifier -= 0.15;

    const retention = Math.max(0.10, Math.min(1.0, baseRet + modifier));
    points.push({
      blockIndex: i,
      blockLabel: block.label || block.type,
      blockType: block.type,
      startTime: elapsed,
      duration: blockDur,
      retention: Math.round(retention * 1000) / 1000,
      retentionPct: Math.round(retention * 100),
      relPosition: Math.round(relPos * 1000) / 1000,
      isDropRisk: retention < 0.35,
      isCritical: i === 0 && hookAnalysis.score < 40
    });
    elapsed += blockDur;
  });

  return points;
}

/* ============================================================
   COGNITIVE LOAD ANALYSIS (Miller 1956, Sweller 1988 CLT)
   Heurística pura: mide si el guion puede sobrecargar al espectador.
   Devuelve { score:0-100, level, details } donde score bajo = liviano.
   ============================================================ */
export function analyzeCognitiveLoad(blocks, wpm) {
  const fullText = blocks.map(b => b.content).join(' ');
  const words = wordCount(fullText);
  if (!words) return { score: 50, level: 'Sin datos', details: [] };

  const details = [];
  let score = 0;

  // 1. Speaking pace: palabras reales / minutos estimados.
  // Faculty eCommons (2025): 130 WPM ideal para contenido educativo.
  const minutes = words / (wpm || 150);
  const actualWPM = minutes > 0 ? Math.round(words / minutes) : wpm;
  // [INFERIDO de Faculty eCommons 2025 "780-word rule": 780 pal / 6 min = 130 WPM]
  if (actualWPM <= 130) { score += 30; details.push('Ritmo pausado (' + actualWPM + ' WPM) — fácil de procesar'); }
  else if (actualWPM <= 160) { score += 20; details.push('Ritmo moderado (' + actualWPM + ' WPM)'); }
  else if (actualWPM <= 185) { score += 10; details.push('Ritmo rápido (' + actualWPM + ' WPM) — puede saturar'); }
  else { score += 3; details.push('Ritmo muy rápido (' + actualWPM + ' WPM) — alta carga'); }

  // 2. Information density: topics/min (Miller 1956 7±2 chunks, Sweller 1988).
  const topicShifts = blocks.filter((b, i) => {
    if (i === 0) return false;
    const prev = blocks[i - 1].content || '';
    const curr = b.content || '';
    const prevWords = new Set((prev.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const currWords = new Set((curr.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
    const overlapCount = [...currWords].filter(w => prevWords.has(w)).length;
    return overlapCount / Math.max(1, Math.min(prevWords.size, currWords.size)) < 0.15;
  }).length;
  const topicsPerMinute = topicShifts / Math.max(0.5, minutes);
  // Sweet spot: 1.5-3 temas/min. [INFERIDO de Miller 7±2]
  if (topicsPerMinute <= 1.5) { score += 25; details.push('Densidad baja (' + topicsPerMinute.toFixed(1) + ' temas/min) — procesable'); }
  else if (topicsPerMinute <= 3) { score += 20; details.push('Densidad óptima (' + topicsPerMinute.toFixed(1) + ' temas/min)'); }
  else if (topicsPerMinute <= 4.5) { score += 10; details.push('Densidad alta (' + topicsPerMinute.toFixed(1) + ' temas/min) — puede saturar'); }
  else { score += 3; details.push('Sobrecarga (' + topicsPerMinute.toFixed(1) + ' temas/min) — alto riesgo de abandono'); }

  // 3. Sentence load: palabras promedio por oración (working memory).
  // Sweller (1988): oraciones largas = más carga intrínseca.
  const sentences = fullText.split(/[.!?]+/).filter(s => s.trim());
  const avgWordsPerSentence = sentences.length ? Math.round(words / sentences.length) : 0;
  // [INFERIDO: 15-20 pal/oración = óptimo para español hablado]
  if (avgWordsPerSentence <= 15) { score += 25; details.push('Oraciones cortas (' + avgWordsPerSentence + ' pal) — liviano'); }
  else if (avgWordsPerSentence <= 20) { score += 20; details.push('Oraciones óptimas (' + avgWordsPerSentence + ' pal)'); }
  else if (avgWordsPerSentence <= 25) { score += 10; details.push('Oraciones largas (' + avgWordsPerSentence + ' pal) — pesado'); }
  else { score += 3; details.push('Oraciones muy largas (' + avgWordsPerSentence + ' pal) — overload'); }

  // 4. Rest points: ratio de VISUAL/GIRO como descansos cognitivos.
  // Sweller (1988): segmentación y pausas reducen cognitive load.
  const restPoints = blocks.filter(b => b.type === 'VISUAL' || b.type === 'GIRO').length;
  const restRatio = blocks.length > 0 ? restPoints / blocks.length : 0;
  if (restRatio >= 0.15 && restRatio <= 0.35) { score += 20; details.push('Descansos cognitivos bien distribuidos (' + restPoints + ' bloques)'); }
  else if (restRatio > 0 && restRatio < 0.15) { score += 10; details.push('Pocos descansos cognitivos (' + restPoints + ' bloques)'); }
  else if (restRatio === 0) { score += 3; details.push('Sin descansos cognitivos — sin pausas para procesar'); }
  else { score += 12; details.push('Muchos descansos (' + restPoints + ' bloques) — puede fragmentar'); }

  const s = Math.max(0, Math.min(100, score));
  const level = s >= 75 ? 'Liviana' : s >= 50 ? 'Moderada' : s >= 30 ? 'Pesada' : 'Sobrecarga';
  const formula = 'Carga cognitiva: ritmo(' + actualWPM + 'WPM) + densidad(' + topicsPerMinute.toFixed(1) + 'temas/min) + oraciones(' + avgWordsPerSentence + 'pal) + descansos(' + restPoints + ') → ' + s + '/100 (' + level + ')';
  return { score: s, level, topicsPerMinute: Math.round(topicsPerMinute * 10) / 10, avgWordsPerSentence, actualWPM, restPoints, details, formula };
}

/* ============================================================
   MOTOR PRINCIPAL
   Devuelve el schema §6.3 completo.
   APV clamp [15,95]; confianza cap 0.85 (§7.3).
   ============================================================ */
export function computeRetentionPrediction(data) {
  const { blocks = [], wpm = 150, promise = '', title = '' } = data || {};

  if (!blocks.length) {
    return {
      overallRetention: 15,  // Floor del clamp [15,95] (§14.3: APV siempre en rango). confidence=0 señala "no hay predicción".
      confidence: 0,
      curve: [],
      scores: {},
      weights: WEIGHTS,
      insights: ['Sin bloques para analizar.'],
      risks: [],
      recommendations: [],
      formula: '',
      meta: { totalBlocks: 0, contentBlocks: 0, totalDuration: 0, wpm, hasHook: false, hasCTA: false, computedAt: Date.now() }
    };
  }

  const hookBlock = blocks.find(b => b.type === 'HOOK');
  const contentBlocks = blocks.filter(b => (b.content || '').trim());

  const hookAnalysis = analyzeHook(hookBlock, promise, blocks);
  const pacingAnalysis = analyzePacing(blocks, wpm);
  const interruptAnalysis = analyzePatternInterrupts(blocks);
  const densityAnalysis = analyzeContentDensity(blocks, wpm);
  const promiseAnalysis = analyzePromiseDelivery(blocks, promise);
  const readabilityAnalysis = analyzeReadability(blocks);
  const ctaAnalysis = analyzeCTA(blocks);
  const narrativeAnalysis = analyzeNarrativeCompleteness(blocks);

  const scores = {
    hook: hookAnalysis,
    pacing: pacingAnalysis,
    patternInterrupts: interruptAnalysis,
    contentDensity: densityAnalysis,
    promiseDelivery: promiseAnalysis,
    readability: readabilityAnalysis,
    cta: ctaAnalysis,
    narrative: narrativeAnalysis
  };

  // Score ponderado: Σ(score_i × weight_i). [Conjunto NO VALIDADO, Apéndice A]
  // Bug D18 fix: emotionalArc (0.11) requiere sentiment (solo Modo IA).
  // En este engine no tenemos sentiment → normalizamos los 8 pesos a 1.00.
  const _effSum = WEIGHTS.hookStrength + WEIGHTS.pacingScore + WEIGHTS.patternInterrupts +
    WEIGHTS.contentDensity + WEIGHTS.promiseDelivery + WEIGHTS.readability +
    WEIGHTS.ctaPlacement + WEIGHTS.narrativeCompleteness; // = 0.89
  const _n = (w) => w / _effSum; // normaliza a fracción de 1.00

  const weightedScore =
    hookAnalysis.score * _n(WEIGHTS.hookStrength) +
    pacingAnalysis.score * _n(WEIGHTS.pacingScore) +
    interruptAnalysis.score * _n(WEIGHTS.patternInterrupts) +
    densityAnalysis.score * _n(WEIGHTS.contentDensity) +
    promiseAnalysis.score * _n(WEIGHTS.promiseDelivery) +
    readabilityAnalysis.score * _n(WEIGHTS.readability) +
    ctaAnalysis.score * _n(WEIGHTS.ctaPlacement) +
    narrativeAnalysis.score * _n(WEIGHTS.narrativeCompleteness);

  // APV clamp [15,95]. Wistia 2025: completion ~20-70% por duración.
  const overallRetention = Math.round(Math.max(15, Math.min(95, weightedScore)));

  // Confianza: 0.3 base + 0.05 por bloque con contenido, cap 0.85. [Fórmula NO VALIDADA]
  const confidence = Math.min(0.85, 0.3 + contentBlocks.length * 0.05);

  const curve = generateRetentionCurve(blocks, wpm, hookAnalysis);

  const insights = [], risks = [], recommendations = [];

  if (hookAnalysis.score >= 70) insights.push('✓ Hook fuerte: ' + hookAnalysis.reasons.join(', '));
  else if (hookAnalysis.score >= 40) {
    risks.push('⚠ Hook mejorable: ' + hookAnalysis.reasons.join(', '));
    recommendations.push('Reforzá el hook con una pregunta directa o dato impactante.');
  } else {
    risks.push('✗ Hook débil: ' + hookAnalysis.reasons.join(', '));
    recommendations.push('El hook es crítico. Agregá una pregunta, dato sorprendente o promesa clara en los primeros 15 segundos.');
  }

  if (pacingAnalysis.score < 50) {
    risks.push('⚠ Ritmo irregular: ' + pacingAnalysis.details.join(', '));
    recommendations.push('Variá la duración de los bloques. Alterná segmentos cortos (15-20s) con más largos (30-45s).');
  }

  if (interruptAnalysis.ratio < 0.10) {
    risks.push('⚠ Pocos cambios de ritmo narrativo');
    recommendations.push('Agregá bloques VISUAL o GIRO cada 2-3 segmentos para resetear la atención.');
  }

  if (promise && promiseAnalysis.deliveredAt === null) {
    risks.push('✗ La promesa nunca se cumple en el guion');
    recommendations.push('La promesa del hook debe resolverse explícitamente en el cuerpo del video.');
  } else if (promise && promiseAnalysis.relativePosition > 0.6) {
    risks.push('⚠ La promesa se entrega muy tarde (>60% del video)');
    recommendations.push('Entregá al menos una pista de la promesa en el primer 30% del video.');
  }

  if (ctaAnalysis.position === null) {
    risks.push('⚠ Sin CTA definido');
    recommendations.push('Agregá un llamado a la acción claro.');
  }

  if (narrativeAnalysis.missing.length > 0) {
    risks.push('⚠ Faltan elementos: ' + narrativeAnalysis.missing.join(', '));
  }

  if (overallRetention >= 60) insights.push('✓ Retención estimada alta (' + overallRetention + '% APV)');
  else if (overallRetention >= 40) insights.push('◐ Retención estimada moderada (' + overallRetention + '% APV)');
  else insights.push('✗ Retención estimada baja (' + overallRetention + '% APV)');

  const dropRisks = curve.filter(p => p.isDropRisk);
  if (dropRisks.length > 0) {
    risks.push('⚠ Puntos de fuga: bloque(s) ' + dropRisks.map(p => '#' + (p.blockIndex + 1)).join(', '));
    recommendations.push('Revisá los bloques con baja retención estimada. Acortá o reestructurá su contenido.');
  }

  const formula = `APV = Σ(score×peso) = ${hookAnalysis.score}×${WEIGHTS.hookStrength} + ${pacingAnalysis.score}×${WEIGHTS.pacingScore} + ${interruptAnalysis.score}×${WEIGHTS.patternInterrupts} + ${densityAnalysis.score}×${WEIGHTS.contentDensity} + ${promiseAnalysis.score}×${WEIGHTS.promiseDelivery} + ${readabilityAnalysis.score}×${WEIGHTS.readability} + ${ctaAnalysis.score}×${WEIGHTS.ctaPlacement} + ${narrativeAnalysis.score}×${WEIGHTS.narrativeCompleteness} = ${Math.round(weightedScore)} → clamp[15,95] = ${overallRetention}%`;

  return {
    overallRetention,
    confidence: Math.round(confidence * 100) / 100,
    curve,
    scores,
    weights: WEIGHTS,
    insights,
    risks,
    recommendations,
    formula,
    meta: {
      totalBlocks: blocks.length,
      contentBlocks: contentBlocks.length,
      totalDuration: curve.length ? curve[curve.length - 1].startTime + curve[curve.length - 1].duration : 0,
      wpm,
      hasHook: !!hookBlock,
      hasCTA: blocks.some(b => b.type === 'CTA'),
      computedAt: Date.now()
    }
  };
}
