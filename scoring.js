/* scoring.js — Motor del Índice de Calidad Narrativa (ICN).
   Implementa §13.4 y §7.1 del contrato.
   LÓGICA PURA: no referencia document ni window (§3.3, principio P6).
   Testeable en aislamiento (acepta project/calRecords como argumentos).
   Importa de: state.js (constantes + state) y ai-shared.js (primitivas). */

import { T, state } from './state.js';
import { wordCount, durationInSeconds, fernandezHuerta, overlap } from './ai-shared.js';

/* Regex de urgencia/curiosidad para detección de hooks. Lista transparente. */
const URGENCY_RE = /ahora|hoy|descubr[ií]|secreto|nunca|siempre|error|truc[oa]|incre[ií]ble|sorprendente|importante|clave|esencial/i;

/* ============================================================
   computeAnalysis(project?, calRecords?)
   Devuelve el ICN + desglose + riesgos. Pura: no toca state salvo como default.
   ============================================================ */
export function computeAnalysis(project = state.p) {
  // R1 fix: calibración ahora usa activeBenchmarks del bucket del proyecto.
  if (!project) {
    return { hs: 0, cl: 0, pa: 0, pr: 0, score: 0, rawIcn: 0, calibrated: false, reference: null, r: [] };
  }

  const wpm = project.wpm || 150;
  const text = project.blocks.map(b => b.content).join(' ');
  const hook = project.blocks.find(b => b.type === 'HOOK');
  const sent = text.split(/[.!?]+/).filter(Boolean);
  const avg = wordCount(text) / Math.max(1, sent.length);
  const visual = project.blocks.filter(b => b.type === 'VISUAL' || b.type === 'GIRO').length;
  const r = [];

  /* --- Detección de hook efectivo (explícito o implícito) --- */
  const firstBlock = project.blocks[0];
  const hasHookType = !!hook;
  const firstIsHooky = firstBlock && firstBlock.content && (
    /[?¿]/.test(firstBlock.content) ||
    wordCount(firstBlock.content) < 30 ||
    URGENCY_RE.test(firstBlock.content)
  );
  const effectiveHook = hook || ((!hasHookType && firstIsHooky) ? firstBlock : null);

  /* --- Riesgos (r) --- */
  if (!effectiveHook) r.push(['bad', 'Sin Hook definido']);
  if (effectiveHook && wordCount(effectiveHook.content) < 12) r.push(['bad', 'Hook demasiado corto']);
  if (effectiveHook && project.promise && !overlap(effectiveHook.content, project.promise)) r.push(['warn', 'La promesa no aparece en el Hook']);
  if (avg > 25) r.push(['warn', 'Oraciones extensas']);
  if (avg < 8) r.push(['warn', 'Oraciones demasiado cortas (estilo infantil)']);
  if (durationInSeconds(text, wpm) > 180 && visual < 2) r.push(['warn', 'Ritmo visual bajo']);
  if (!project.blocks.some(b => b.type === 'CTA')) r.push(['warn', 'Sin CTA']);
  project.blocks.forEach(b => {
    if (!b.content && b.type !== 'VISUAL') r.push(['bad', T[b.type][0] + ' vacío', b.id]);
    if (durationInSeconds(b.content, wpm) > 65 && ['SEGMENTO', 'CONTEXTO'].includes(b.type)) r.push(['warn', 'Bloque de voz largo', b.id]);
  });

  /* --- Hook score (hs) --- */
  let hs;
  if (!effectiveHook) {
    hs = 5;
  } else {
    hs = 20;
    const wc = wordCount(effectiveHook.content);
    hs += wc >= 15 && wc <= 80 ? 20 : wc >= 10 ? 10 : 5;
    if (/[?¿]/.test(effectiveHook.content)) hs += 15;
    if (/\d/.test(effectiveHook.content) && wc > 10) hs += 10;
    if (effectiveHook === firstBlock && !hasHookType) hs = Math.round(hs * 0.7); // penalización hook implícito (§7.1)
    if (project.promise && overlap(effectiveHook.content, project.promise)) hs += 20;
    if (URGENCY_RE.test(effectiveHook.content)) hs += 10;
    hs = Math.min(100, hs);
  }

  /* --- Claridad (cl) — Fernández-Huerta con penalización bidireccional --- */
  const fh = fernandezHuerta(text);
  let cl;
  if (fh > 90) cl = Math.max(30, 60 - (fh - 90) * 3);                                   // demasiado simple (infantil)
  else if (fh >= 60) cl = Math.min(100, 70 + (fh - 60) * 0.5 - Math.max(0, avg - 18) * 2);
  else if (fh >= 40) cl = Math.max(20, 50 - (60 - fh) * 0.8);
  else cl = Math.max(10, 30 - (40 - fh));                                              // muy difícil

  /* --- Ritmo (pa) — visuales/giros + varianza de longitud de oraciones --- */
  const sentLens = sent.map(s => wordCount(s));
  const sentMean = sentLens.reduce((a, b) => a + b, 0) / Math.max(1, sentLens.length);
  const sentVar = sentLens.reduce((s, l) => s + (l - sentMean) ** 2, 0) / Math.max(1, sentLens.length);
  const sentCV = Math.sqrt(sentVar) / (sentMean || 1);
  const pa = Math.min(100, 25 + visual * 12 + (sentCV > 0.3 && sentCV < 1 ? 15 : sentCV <= 0.3 ? 0 : 5) + Math.min(20, sentLens.length > 3 ? 10 : 5));

  /* --- Promesa (pr) --- */
  const pr = effectiveHook && project.promise ? (overlap(effectiveHook.content, project.promise) ? 75 : 20) : 20;

  /* --- ICN bruto --- */
  const rawIcn = Math.round(Math.max(0, Math.min(100,
    hs * 0.31 + cl * 0.22 + pa * 0.22 + pr * 0.17 + (project.blocks.some(b => b.type === 'CTA') ? 8 : 0)
  )));

  /* --- Calibración con activeBenchmarks (R1 fix) --- */
  const fmt = project.format || 'long';
  const gen = project.genre || 'educativo';
  const benchmark = state.activeBenchmarks?.[fmt]?.[gen];
  const reference = benchmark != null ? benchmark * 100 : null;
  const icn = reference === null ? rawIcn : Math.round(rawIcn * 0.7 + reference * 0.3);

  return {
    hs: Math.round(hs),
    cl: Math.round(cl),
    pa: Math.round(pa),
    pr,
    score: icn,
    rawIcn,
    calibrated: reference !== null,
    reference: reference && Math.round(reference),
    r
  };
}

/* ============================================================
   analysis() — versión con memo (para uso en runtime)
   Lee de state.p / state.activeBenchmarks. Invalida con markAnalysisDirty().
   ============================================================ */
export function analysis() {
  if (!state.analysisDirty && state.cachedAnalysis) return state.cachedAnalysis;
  state.cachedAnalysis = computeAnalysis();
  state.analysisDirty = false;
  return state.cachedAnalysis;
}

/* ============================================================
   quality(block, a) — etiqueta de calidad por bloque
   Devuelve [etiqueta, clase]: Óptimo/Revisar/Crítico/Vacío → good/warn/bad.
   ============================================================ */
export function quality(block, a) {
  if (!block.content && block.type !== 'VISUAL') return ['Vacío', 'bad'];
  const found = a.r.find(x => x[2] === block.id);
  return found ? [found[0] === 'bad' ? 'Crítico' : 'Revisar', found[0]] : ['Óptimo', 'good'];
}

/* ============================================================
   Utilidades de texto (compartidas con análisis on-demand tier 2)
   ============================================================ */
export function splitSentences(text) {
  if (!text) return [];
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.map(s => s.trim()).filter(s => s.length > 10);
}

export function splitIntoSegments(text, wpm) {
  const wordsPerMinute = wpm || state.p?.wpm || 150;
  const segments = [];
  const words = (text || '').split(/\s+/).filter(Boolean);
  const wordsPerSegment = Math.ceil(wordsPerMinute);
  for (let i = 0; i < words.length; i += wordsPerSegment) {
    segments.push({ text: words.slice(i, i + wordsPerSegment).join(' '), label: 'Min ' + (Math.floor(i / wordsPerMinute) + 1) });
  }
  return segments.length ? segments : [{ text: text || '', label: 'Min 1' }];
}
