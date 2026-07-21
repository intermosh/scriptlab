/* ai-shared.js — Primitivas puras (matemáticas + léxicas) compartidas entre
   el hilo principal y los Web Workers.
   Implementa §13.3 del contrato.
   No importa de ningún módulo. Importable desde main thread y workers. */

/* ============================================================
   Sanitización para embeddings e5-small
   ============================================================ */
export function sanitizeText(text) {
  if (!text || typeof text !== 'string') return ' ';
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')   // control chars
    .replace(/[\u200B-\u200D\uFEFF]/g, '')                       // zero-width, BOM
    .replace(/[\uD800-\uDFFF]/g, '')                             // surrogates rotos
    .replace(/[\uE000-\uF8FF]/g, '')                             // private use area
    .replace(/[\uFFFE\uFFFF]/g, '')                              // non-characters
    .replace(/[\u{10000}-\u{10FFFF}]/gu, c => {                  // fuera de BMP
      const cp = c.codePointAt(0);
      if (cp >= 0x10000 && cp <= 0x2FFFF) return c;              // CJK común + latin extendido
      return '';
    })
    .trim() || ' ';
}

/* ============================================================
   Sanitización agresiva para RoBERTuito (BPE)
   Tokenizador distinto al de e5: NO unificar (lección de v16).
   ============================================================ */
export function sanitizeSentimentText(text) {
  if (!text || typeof text !== 'string') return 'texto';
  const s = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')                       // control chars
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g, '')      // zero-width, bidi
    .replace(/[\uD800-\uDFFF]/g, '')                                     // surrogates sueltos
    .replace(/[\uE000-\uF8FF]/g, '')                                     // private use
    .replace(/[\uFFFE\uFFFF\uFFF0-\uFFFD]/g, '')                         // specials
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')                             // fuera de BMP
    .replace(/[\u2600-\u27BF]/g, '')                                     // misc symbols
    .replace(/[\uFE00-\uFE0F]/g, '')                                     // variation selectors
    .replace(/[^\x20-\x7E\u00A0-\u024F\u1E00-\u1EFF\u00C0-\u00FF\u0100-\u017F]/g, '') // latin imprimible
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 3 ? s : 'texto';
}

/* ============================================================
   Álgebra vectorial
   ============================================================ */
export function dot(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function cosineSim(a, b) {
  if (!a || !b) return 0;
  const d = dot(a, b);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return d / (na * nb || 1);
}

/* ============================================================
   Conteo de sílabas en español (para Fernández-Huerta)
   ============================================================ */
export function syllables(w) {
  w = (w || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zñü]/g, '');
  let n = 0, last = false;
  for (const c of w) {
    const v = 'aeiouü'.includes(c);
    if (v && !last) n++;
    last = v;
  }
  return Math.max(1, n);
}

/* ============================================================
   Conteos léxicos
   ============================================================ */
export function wordCount(text) {
  return (text || '').trim().match(/[\p{L}\p{N}'''-]+/gu)?.length || 0;
}

export function sentenceCount(text) {
  return (text || '').split(/[.!?]+/).filter(s => s.trim()).length || 1;
}

/* ============================================================
   Fórmula de legibilidad de Fernández-Huerta (1959)
   Adaptación española del Flesch Reading Ease (Flesch, 1948).
   Fuente: Fernández Huerta, J. (1959). "Medidas sencillas de
   lecturabilidad." Consigna, 214, 29-32.
   Constantes 206.84, 60, 1.02 directas de la publicación original.
   ============================================================ */
export function fernandezHuerta(text) {
  const ws = (text || '').match(/[\p{L}]+/gu) || [];
  const ss = sentenceCount(text);
  if (!ws.length) return 0;
  const syllableRatio = ws.reduce((n, w) => n + syllables(w), 0) / ws.length;
  const wordsPerSentence = ws.length / ss;
  return Math.max(0, Math.min(100, 206.84 - 60 * syllableRatio - 1.02 * wordsPerSentence));
}

/* ============================================================
   Estimación de duración en segundos según WPM
   ============================================================ */
export function durationInSeconds(text, wpm = 150) {
  return Math.round(wordCount(text) / (wpm || 150) * 60);
}

/* ============================================================
   Solapamiento léxico (palabras ≥4 letras)
   ============================================================ */
export function overlap(a, b) {
  const x = new Set((a || '').toLowerCase().match(/[\p{L}]{4,}/gu) || []);
  const y = new Set((b || '').toLowerCase().match(/[\p{L}]{4,}/gu) || []);
  return [...x].some(w => y.has(w));
}
