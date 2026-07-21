/* render.js — Todo el DOM, gráficos e incrementalidad.
   Implementa §13.6, §9.3, §9.4, §9.5, §9.6, §5.3 del contrato.
   Se registra en workers.js vía setRenderCallbacks() (DI, §3.3).
   Depende de: state.js, scoring.js, ai-shared.js, db.js, workers.js. */

import { state, T, TRASH_SVG, HEURISTICS, time, esc, markAnalysisDirty, PREDEFINED_TOPICS, CALIBRATION_CONFIG, BENCHMARK_BUCKETS, recalibrateBucket } from './state.js';
import { analysis, quality } from './scoring.js';
import { wordCount, durationInSeconds } from './ai-shared.js';
import { all, put } from './db.js';
import { scheduleAI, scheduleSentiment, scheduleRetention, setRenderCallbacks, workerSend } from './workers.js';
import { analyzeCognitiveLoad } from './retention-engine.js';

const $ = s => document.querySelector(s);
/* Chart.js eliminado (D16). Curva de retención → SVG inline. */

/* Chart instances (module-scoped, §14.4) */
/* Chart.js eliminado (D16) — sin instancias de chart. */

/* ============================================================
   render() — orquestador principal
   ============================================================ */
export function render() {
  const proj = state.p;
  if (!proj) return;

  const titleEl = document.querySelector('#title');
  const promiseEl = document.querySelector('#promise');
  const wpmEl = document.querySelector('#wpm');
  const wpmValEl = document.querySelector('#wpm-value');
  if (titleEl && document.activeElement !== titleEl) titleEl.value = proj.title;
  if (promiseEl && document.activeElement !== promiseEl) promiseEl.value = proj.promise;
  if (wpmEl) wpmEl.value = proj.wpm || 150;
  if (wpmValEl) wpmValEl.textContent = (proj.wpm || 150) + ' WPM';
  const pfEl = document.querySelector('#proj-format');
  const pgEl = document.querySelector('#proj-genre');
  if (pfEl) pfEl.value = proj.format || 'long';
  if (pgEl) pgEl.value = proj.genre || 'educativo';

  const durSlider = document.querySelector('#target-duration');
  if (durSlider) {
    durSlider.value = proj.targetDuration || 0;
    const durVal = document.querySelector('#target-duration-value');
    if (durVal) durVal.textContent = proj.targetDuration ? time(proj.targetDuration) : '—';
  }

  const a = analysis();
  const flow = document.querySelector('#flow');
  const empty = document.querySelector('#empty');
  if (empty) empty.hidden = !!proj.blocks.length;

  if (state.flowDirty && flow) {
    flow.innerHTML = proj.blocks.map((b, i) => {
      const [n, c] = T[b.type];
      const q = quality(b, a);
      return '<article draggable="true" class="flow-block ' + (state.sel === b.id ? 'selected' : '') +
        '" data-id="' + b.id + '" style="border-left-color:' + c + '">' +
        '<header><select class="block-type-select" data-type-select="' + b.id + '" style="color:' + c + '">' +
        Object.entries(T).map(([tk, [tn]]) => '<option value="' + tk + '"' + (tk === b.type ? ' selected' : '') + '>' + tn + '</option>').join('') +
        '</select><span class="block-idx">· ' + (i + 1) + '</span></header>' +
        '<input class="block-title-input" value="' + esc(b.label || n) + '" data-title="' + b.id + '" spellcheck="false">' +
        '<textarea class="inline-block-editor" data-inline="' + b.id + '" placeholder="Pegá o escribí el contenido del bloque…">' + esc(b.content) + '</textarea>' +
        '<footer><span class="block-meta">' + wordCount(b.content) + ' palabras · ' + durationInSeconds(b.content, proj.wpm) + ' s</span> ' +
        '<b class="quality ' + q[1] + '">' + q[0] + '</b>' +
        '<button class="delete-inline" data-delete="' + b.id + '" title="Eliminar bloque" aria-label="Eliminar bloque">' + TRASH_SVG + '</button></footer></article>';
    }).join('');
    bindBlocks();
    state.flowDirty = false;
  }

  renderMetrics(a);
  scheduleAI();
  scheduleSentiment();
  applyAIModeVisibility();
  renderTimeline();
  renderTele();
  if (state.mode === 'ia') renderSentimentArc();  // R3: skip en heuristic
  renderStructure(a);
  renderTimeMeter(a);
  renderCognitiveLoad();
  updateRetentionPanel();
  scheduleRetention();
  updateDeepStatus();
}

/* ============================================================
   bindBlocks() — eventos por bloque + drag&drop
   ============================================================ */
export function bindBlocks() {
  document.querySelectorAll('.flow-block').forEach(e => {
    // Click para seleccionar
    e.onclick = event => {
      if (event.target.matches('textarea,input,button,svg,path')) return;
      state.sel = e.dataset.id;
      document.querySelectorAll('.flow-block').forEach(x => x.classList.toggle('selected', x.dataset.id === state.sel));
    };

    // Block type selector (M4) — clic cambia el tipo instantáneamente
    const typeSelect = e.querySelector('.block-type-select');
    if (typeSelect) {
      typeSelect.onchange = event => {
        event.stopPropagation();
        const b = state.p.blocks.find(x => x.id === typeSelect.dataset.typeSelect);
        if (!b) return;
        b.type = typeSelect.value;
        const c2 = T[b.type][1];
        e.style.borderLeftColor = c2;
        typeSelect.style.color = c2;
        if (!b.label || Object.values(T).some(([n]) => n === b.label)) b.label = T[b.type][0];
        markAnalysisDirty();
        saveDebounced();
        renderMetrics(analysis());
        renderStructure(analysis());
        renderCognitiveLoad();
        updateRetentionPanel();
        scheduleRetention();
      };
      typeSelect.onclick = event => event.stopPropagation();
    }

    // Textarea oninput — INCREMENTAL: solo footer + metrics, no re-render
    const text = e.querySelector('.inline-block-editor');
    if (text) {
      const grow = () => { text.style.height = 'auto'; text.style.height = text.scrollHeight + 'px'; };
      grow();
      text.oninput = () => {
        const b = state.p.blocks.find(x => x.id === text.dataset.inline);
        if (!b) return;
        b.content = text.value;
        grow();
        markAnalysisDirty();
        state.deepResult = null;
        updateDeepStatus();
        updateBlockFooterLocally(e, b, analysis());
        renderMetrics(analysis());
        scheduleAI();
        scheduleSentiment();
        saveDebounced();
        renderStructure(analysis());
      };
      text.onclick = event => event.stopPropagation();
    }

    // Title input
    const titleInput = e.querySelector('.block-title-input');
    if (titleInput) {
      titleInput.oninput = () => {
        const b = state.p.blocks.find(x => x.id === titleInput.dataset.title);
        if (!b) return;
        b.label = titleInput.value;
        saveDebounced();
      };
      titleInput.onclick = event => event.stopPropagation();
      titleInput.onfocus = () => titleInput.select();
    }

    // Delete
    const remove = e.querySelector('[data-delete]');
    if (remove) remove.onclick = event => {
      event.stopPropagation();
      const id = remove.dataset.delete;
      state.p.blocks = state.p.blocks.filter(b => b.id !== id);
      if (state.sel === id) state.sel = null;
      state.flowDirty = true;
      markAnalysisDirty();
      saveDebounced();
      render();
    };

    // Drag & drop reordenar
    e.ondragstart = x => {
      if (x.target.matches('textarea,input')) return;
      x.dataTransfer.setData('id', e.dataset.id);
    };
    e.ondragover = x => {
      x.preventDefault();
      if (!state.paletteDragType) {
        const rect = e.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        e.classList.toggle('dragover-top', x.clientY < mid);
        e.classList.toggle('dragover-bottom', x.clientY >= mid);
      }
    };
    e.ondragleave = x => {
      if (!e.contains(x.relatedTarget)) e.classList.remove('dragover', 'dragover-top', 'dragover-bottom');
    };
    e.ondrop = x => {
      x.preventDefault();
      e.classList.remove('dragover', 'dragover-top', 'dragover-bottom');
      const pType = x.dataTransfer.getData('palette-type');
      if (pType) {
        const rect = e.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        addBlock(pType, x.clientY < mid ? e.dataset.id : null);
        return;
      }
      const id = x.dataTransfer.getData('id');
      const from = state.p.blocks.findIndex(b => b.id === id);
      const to = state.p.blocks.findIndex(b => b.id === e.dataset.id);
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = state.p.blocks.splice(from, 1);
        state.p.blocks.splice(to, 0, moved);
        state.flowDirty = true;
        markAnalysisDirty();
        saveDebounced();
        render();
      }
    };
  });
}

/* ============================================================
   updateBlockFooterLocally — incremental (§14.4)
   ============================================================ */
export function updateBlockFooterLocally(blockArticle, block, a) {
  const metaSpan = blockArticle.querySelector('.block-meta');
  const qualityB = blockArticle.querySelector('.quality');
  const q = quality(block, a);
  if (metaSpan) metaSpan.textContent = wordCount(block.content) + ' palabras · ' + durationInSeconds(block.content, state.p.wpm) + ' s';
  if (qualityB) { qualityB.className = 'quality ' + q[1]; qualityB.textContent = q[0]; }
}

/* ============================================================
   Anillo Salud (SVG dashoffset, D10)
   ============================================================ */
function setRing(id, pct) {
  const el = document.querySelector('#' + id);
  if (el) el.style.strokeDashoffset = 276.5 * (1 - Math.max(0, Math.min(1, pct / 100)));
}

/* ============================================================
   renderMetrics(a) — anillo salud + desglose + eco mini + riesgos
   ============================================================ */
export function renderMetrics(a) {
  const proj = state.p;
  if (!proj) return;

  // Anillo + número
  setRing('ring-health', a.score);
  const healthNum = document.querySelector('#health-num');
  if (healthNum) healthNum.textContent = a.score;
  const miniHealth = document.querySelector('#mini-health');
  if (miniHealth) miniHealth.textContent = a.score;

  // Desglose
  const breakdown = document.querySelector('#health-breakdown');
  if (breakdown) {
    const rows = [
      ['Hook', a.hs, 'purple'],
      ['Claridad', a.cl, 'purple'],
      ['Ritmo', a.pa, a.pa < 40 ? 'warn' : 'purple'],
      ['Promesa', a.pr, 'purple']
    ];
    breakdown.innerHTML = rows.map(([lab, val, color]) =>
      '<div class="bd-row"><span class="bd-lab">' + lab + '</span>' +
      '<div class="bd-track"><i style="width:' + val + '%;background:var(--' + color + ')"></i></div>' +
      '<span class="bd-val">' + val + '</span></div>'
    ).join('');
  }

  // Riesgos
  const baseRisks = a.r.map(x => '<div class="retention-risk">' + esc(x[1]) + '</div>').join('');
  const risksEl = document.querySelector('#retention-risks');
  // (Los riesgos de retención se agregan en updateRetentionPanel)
  // Guardamos los heurísticos para combinarlos ahí.
  state._heuristicRisks = baseRisks;
}

/* ============================================================
   updateRetentionPanel — anillo retención + curva + factores
   ============================================================ */
export function renderRetentionPanel() { updateRetentionPanel(); }
function updateRetentionPanel() {
  const r = state.retentionResult;
  const proj = state.p;

  // Anillo retención + eco mini
  if (r) {
    setRing('ring-retention', r.overallRetention);
    const retNum = document.querySelector('#retention-num');
    if (retNum) retNum.textContent = r.overallRetention + '%';
    const miniRet = document.querySelector('#mini-retention');
    if (miniRet) miniRet.textContent = r.overallRetention + '%';

    // Summary
    const summary = document.querySelector('#retention-summary');
    if (summary) {
      const cls = r.overallRetention >= 60 ? 'good' : r.overallRetention >= 40 ? 'warn' : 'bad';
      summary.innerHTML = '<span class="rs-score ' + cls + '">' + r.overallRetention + '%</span>' +
        '<span style="font-size:11px;color:var(--muted)">APV estimado · confianza ' + Math.round(r.confidence * 100) + '%</span>';
    }

    // Curva (Chart.js con fallback)
    renderRetentionCurveSVG(r.curve);

    // Factores de retención SIEMPRE visibles con glosa (M2, D20: pesos eliminados)
    const fgrid = document.querySelector('#retention-factors-grid');
    if (fgrid && r.scores) {
      const factors = [
        ['Hook', r.scores.hook, 'Fuerza del gancho inicial (pregunta, dato, urgencia).'],
        ['Pacing', r.scores.pacing, 'Variación de ritmo entre bloques cortos y largos.'],
        ['Interrupts', r.scores.patternInterrupts, 'Cambios visuales/narrativos que resetean la atención.'],
        ['Densidad', r.scores.contentDensity, 'Cantidad de temas nuevos por minuto.'],
        ['Promesa', r.scores.promiseDelivery, 'Si la promesa del hook se cumple en el cuerpo.'],
        ['Legibilidad', r.scores.readability, 'Claridad del lenguaje (Fernández-Huerta).'],
        ['CTA', r.scores.cta, 'Presencia y posición del llamado a la acción.'],
        ['Narrativa', r.scores.narrative, 'Completitud de la estructura (hook→evidencia→cierre).']
      ];
      fgrid.innerHTML = factors.map(([label, data, glosa]) => {
        if (!data) return '';
        const c = data.score >= 70 ? 'good' : data.score >= 45 ? 'warn' : 'bad';
        return '<div class="rf-row"><div class="rf-head"><span class="rf-label">' + label +
          '</span><span class="rf-val ' + c + '">' + data.score + '</span></div>' +
          '<div class="rf-glosa">' + glosa + '</div>' +
          '<div class="rf-bar"><i style="width:' + data.score + '%;background:var(--' + (c === 'good' ? 'good' : c === 'warn' ? 'warn' : 'bad') + ')"></i></div></div>';
      }).join('');
    }

    // Risks + recommendations
    const risksEl = document.querySelector('#retention-risks');
    if (risksEl) {
      const heuristicRisks = state._heuristicRisks || '';
      const retentionRisks = (r.risks || []).map(x => '<div class="retention-risk">' + esc(x) + '</div>').join('');
      risksEl.innerHTML = heuristicRisks + retentionRisks || '<div class="retention-risk" style="border-left-color:var(--good)">Sin riesgos principales.</div>';
    }
    const recsEl = document.querySelector('#retention-recs');
    if (recsEl) {
      recsEl.innerHTML = (r.recommendations || []).map(x => '<div class="retention-rec">' + esc(x) + '</div>').join('');
    }
  } else {
    const retNum = document.querySelector('#retention-num');
    if (retNum) retNum.textContent = '—';
    const miniRet = document.querySelector('#mini-retention');
    if (miniRet) miniRet.textContent = '—';
  }
}

/* (Chart.js eliminado — renderRetentionCurveSVG arriba reemplaza esta función) */

/* ============================================================
   renderSentimentArc — arco emocional estilo Apple Health/ECG (sin emojis).
   Línea horizontal con puntos de color, altura según valencia.
   verde = POS (+), rojo = NEG (-), gris = NEU (~0).
   ============================================================ */
export function renderSentimentArc() {
  const root = document.querySelector('#sentiment-arc');
  if (!root) return;
  const sent = state.sentimentResult;
  const proj = state.p;

  if (!sent || !sent.sentimentArc || !sent.sentimentArc.length) {
    if (state.mode === 'ia' && state.sentimentReady) {
      root.innerHTML = '<div class="sentiment-empty">Escribí contenido para ver el arco emocional.</div>';
    } else if (state.mode === 'ia') {
      root.innerHTML = '<div class="sentiment-empty">Cargando modelo de sentimiento…</div>';
    } else {
      root.innerHTML = '<div class="sentiment-empty">Activá el Modo IA para ver el arco emocional.</div>';
    }
    return;
  }

  const arc = sent.sentimentArc;
  const typeNames = proj.blocks.reduce((m, b, i) => { m[i] = T[b.type]?.[0] || b.type; return m; }, {});

  // SVG ECG: ancho proporcional a cantidad de puntos, alto fijo 64.
  // Eje central = valencia 0. Rango [-1,1] mapeado a altura, +arriba.
  const W = Math.max(180, arc.length * 36);
  const H = 64, midY = H / 2;
  const pts = arc.map((p, i) => {
    const x = arc.length === 1 ? W / 2 : (i / (arc.length - 1)) * (W - 8) + 4;
    const y = midY - p.valence * (midY - 6);
    const color = p.label === 'POS' ? 'var(--good)' : p.label === 'NEG' ? 'var(--bad)' : 'var(--warn)';
    const r = 3 + Math.abs(p.valence) * 3;
    return { x, y, color, r, p };
  });

  const linePath = pts.map((pt, i) => (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1)).join(' ');
  const dotsSvg = pts.map(pt => {
    const tn = typeNames[pt.p.blockIndex] || '';
    const valStr = (pt.p.valence >= 0 ? '+' : '') + pt.p.valence.toFixed(2);
    return '<circle cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) + '" r="' + pt.r.toFixed(1) +
      '" fill="' + pt.color + '"><title>#' + (pt.p.blockIndex + 1) + ' ' + tn + ' (' + pt.p.label + ' ' + valStr + ')</title></circle>';
  }).join('');

  const engPct = Math.round((sent.engagementScore || 0) * 100);
  const engCls = engPct >= 50 ? 'good' : engPct >= 25 ? 'warn' : 'bad';
  const momPts = (sent.emotionalMomentum || 0) >= 0 ? '+' : '';
  const momCls = (sent.emotionalMomentum || 0) >= 0.1 ? 'good' : (sent.emotionalMomentum || 0) <= -0.1 ? 'bad' : 'warn';
  const jumps = (sent.tonalJumps || []).length;
  const jumpCls = jumps <= 2 ? 'good' : jumps <= 5 ? 'warn' : 'bad';

  root.innerHTML =
    '<div class="sentiment-legend">' +
      '<span><i class="lg-dot" style="background:var(--good)"></i>Positivo</span>' +
      '<span><i class="lg-dot" style="background:var(--warn)"></i>Neutral</span>' +
      '<span><i class="lg-dot" style="background:var(--bad)"></i>Negativo</span>' +
    '</div>' +
    '<div class="sentiment-ecg">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" style="width:100%;height:64px">' +
        '<line x1="0" y1="' + midY + '" x2="' + W + '" y2="' + midY + '" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3"/>' +
        '<path d="' + linePath + '" fill="none" stroke="var(--muted)" stroke-width="1.5" opacity="0.4"/>' +
        dotsSvg +
      '</svg>' +
    '</div>' +
    '<div class="sentiment-summary-grid">' +
    '<div class="sentiment-metric"><small>Engagement</small><b class="' + engCls + '">' + engPct + '%</b><div class="sentiment-glossa">Variación emocional del guion</div></div>' +
    '<div class="sentiment-metric"><small>Momentum</small><b class="' + momCls + '">' + momPts + Math.round((sent.emotionalMomentum || 0) * 100) + '</b><div class="sentiment-glossa">Termina más + o − de lo que empezó</div></div>' +
    '<div class="sentiment-metric"><small>Saltos tonales</small><b class="' + jumpCls + '">' + jumps + '</b><div class="sentiment-glossa">Cambios bruscos de tono</div></div>' +
    '</div>';
}

/* ============================================================
   renderStructure — chips ✓/✗ por tipo de bloque (tier 1)
   ============================================================ */
function renderStructure(a) {
  const proj = state.p;
  const root = document.querySelector('#structure-chips');
  if (!root || !proj) return;
  const essentials = [
    { type: 'HOOK', label: 'Hook' },
    { type: 'CONTEXTO', label: 'Contexto' },
    { type: 'EVIDENCIA', label: 'Evidencia' },
    { type: 'GIRO', label: 'Giro' },
    { type: 'CTA', label: 'CTA' }
  ];
  root.innerHTML = essentials.map(e => {
    const has = proj.blocks.some(b => b.type === e.type);
    return '<span class="schip ' + (has ? 'ok' : 'no') + '">' + (has ? '✓' : '✗') + ' ' + e.label + '</span>';
  }).join('');
}

/* ============================================================
   Timeline + Tele
   ============================================================ */
export function renderTimeline() {
  const proj = state.p;
  if (!proj) return;
  let s = 0;
  const list = document.querySelector('#timeline-list');
  if (!list) return;
  list.innerHTML = proj.blocks.map((b, i) => {
    const t = s; s += durationInSeconds(b.content, proj.wpm);
    return '<div class="timeline-item"><small>' + time(t) + '</small>' +
      '<i class="tl-dot" style="background:' + T[b.type][1] + '"></i>' +
      '<button data-go="' + b.id + '">' + (i + 1) + '. ' + esc(b.label || T[b.type][0]) + '</button>' +
      '<small>' + durationInSeconds(b.content, proj.wpm) + 's</small></div>';
  }).join('');
  document.querySelectorAll('[data-go]').forEach(x => x.onclick = () => {
    state.sel = x.dataset.go;
    view('canvas');
    render();
  });
}

export function renderTele() {
  const proj = state.p;
  if (!proj) return;
  const teleText = document.querySelector('#teletext');
  if (!teleText) return;
  teleText.innerHTML = proj.blocks.filter(b => b.content).map(b =>
    '<section class="tele-section"><small>' + T[b.type][0] + '</small><p>' + esc(b.content) + '</p></section>'
  ).join('') || '<p>Sin contenido para leer.</p>';
}

/* ============================================================
   renderHeuristics — catálogo
   ============================================================ */
export function renderHeuristics() {
  // (No hay contenedor dedicado en el wireframe v4; reservado para tooltip/future)
}

/* ============================================================
   renderCalibration
   ============================================================ */
export function renderCal() {
  const proj = state.p || {};
  const fmt = proj.format || 'long';
  const gen = proj.genre || 'educativo';
  const scores = state.realScores || [];
  const benchmarks = state.activeBenchmarks || {};
  const history = benchmarks._history || [];
  const bucketsEl = $('#cal-buckets');
  if (bucketsEl) {
    if (!scores.length) { bucketsEl.innerHTML = '<div class="cal-empty">Sin registros. Agregá tu primer video arriba.</div>'; }
    else {
      let html = '<table class="cal-bucket-table"><tr><th>Bucket</th><th>n</th><th>APV prom</th><th>Actual</th><th></th></tr>';
      BENCHMARK_BUCKETS.forEach(b => {
        const s = scores.filter(r => r.format === b.format && r.genre === b.genre && r.real_apv_pct > 0);
        const n = s.length;
        const avg = n ? (s.reduce((a, r) => a + r.real_apv_pct, 0) / n).toFixed(1) + '%' : '—';
        const cur = benchmarks[b.format]?.[b.genre];
        const curStr = cur ? (cur * 100).toFixed(1) + '%' : '—';
        const canR = n >= CALIBRATION_CONFIG.MIN_SAMPLES;
        const isCur = b.format === fmt && b.genre === gen;
        html += '<tr' + (isCur ? ' style="background:rgba(121,105,255,.06)"' : '') + '><td>' + b.format + '+' + b.genre + (isCur ? ' ◀' : '') + '</td><td>' + n + '</td><td>' + avg + '</td><td>' + curStr + '</td><td>' + (canR ? '<button class="cal-recab-btn" data-recab="' + b.format + '|' + b.genre + '">Recalibrar</button>' : '<span style="color:var(--faint)">' + n + '/' + CALIBRATION_CONFIG.MIN_SAMPLES + '</span>') + '</td></tr>';
      });
      bucketsEl.innerHTML = html + '</table>';
    }
  }
  const compEl = $('#cal-comparison');
  if (compEl) {
    if (!scores.length) { compEl.innerHTML = '<div class="cal-empty">Sin datos.</div>'; }
    else {
      let html = '<table class="cal-compare-table"><tr><th>Título</th><th>Bucket</th><th>Dur</th><th>Pred</th><th>Real</th><th>Δ</th><th></th></tr>';
      scores.slice().reverse().forEach(r => {
        const p = r.predicted_apv_pct != null ? r.predicted_apv_pct.toFixed(1) + '%' : '—';
        const re = r.real_apv_pct.toFixed(1) + '%';
        const d = r.predicted_apv_pct != null ? (r.predicted_apv_pct - r.real_apv_pct).toFixed(1) + 'pp' : '—';
        html += '<tr><td>' + esc(r.video_title || '?') + '</td><td>' + r.format + '+' + r.genre + '</td><td>' + (r.duration_sec || '?') + 's</td><td>' + p + '</td><td>' + re + '</td><td>' + d + '</td><td><button class="cal-del-btn" data-del-real="' + r.id + '">×</button></td></tr>';
      });
      compEl.innerHTML = html + '</table>';
    }
  }
  const histEl = $('#cal-history');
  if (histEl) {
    if (!history.length) { histEl.innerHTML = '<div class="cal-empty">Sin recalibraciones.</div>'; }
    else { histEl.innerHTML = history.slice().reverse().map(h => '<div class="cl-detail">' + esc(h.bucket) + ': ' + (h.oldValue * 100).toFixed(1) + '% → ' + (h.newValue * 100).toFixed(1) + '% (' + esc(h.note) + ')</div>').join(''); }
  }
}

/* ============================================================
   view(id) + saveDebounced + addBlock
   ============================================================ */
export function view(id) {
  document.querySelectorAll('.panel').forEach(x => x.classList.toggle('on', x.id === id));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.dataset.view === id));
}

export function saveDebounced() {
  markAnalysisDirty();
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    const proj = state.p;
    proj.title = document.querySelector('#title')?.value || 'Nuevo guion';
    proj.promise = document.querySelector('#promise')?.value || '';
    proj.updatedAt = Date.now();
    await put('projects', proj);
    if (Date.now() - (proj.lastSnapshotAt || 0) > 1800000) {
      proj.lastSnapshotAt = Date.now();
      await put('snapshots', { id: crypto.randomUUID(), projectId: proj.id, createdAt: proj.lastSnapshotAt, data: structuredClone(proj) });
    }
  }, 350);
}

export function addBlock(type = 'HOOK', insertBefore = null) {
  const proj = state.p;
  const block = { id: crypto.randomUUID(), type, label: T[type][0], content: '', notes: '' };
  if (insertBefore != null) {
    const idx = proj.blocks.findIndex(b => b.id === insertBefore);
    if (idx >= 0) proj.blocks.splice(idx, 0, block);
    else proj.blocks.push(block);
  } else {
    proj.blocks.push(block);
  }
  state.flowDirty = true;
  state.sel = block.id;
  markAnalysisDirty();
  saveDebounced();
  render();
}

/* renderDensityChart eliminado (Chart.js removido D16). El density result
   se muestra como texto + changes en renderDensity (tier 2). */
export function renderDensityChart() {}


/* R2 fix: updateDeepStatus — movido de main.js para evitar dependencia cruzada */
function updateDeepStatus() {
  const el = $('#deep-status');
  if (!el) return;
  if (!state.p || state.mode !== 'ia') { el.innerHTML = ''; return; }
  if (state.deepResult) {
    el.innerHTML = '✓ Actualizado';
    el.style.color = 'var(--good)';
  } else {
    el.innerHTML = '◐ Contenido cambió · volvé a analizar a fondo';
    el.style.color = 'var(--warn)';
  }
}

/* ============================================================
   M1+M4: applyAIModeVisibility — show/hide secciones según modo
   ============================================================ */
function applyAIModeVisibility() {
  const proj = state.p;
  const wantsIA = state.mode === 'ia';
  const isReady = state.modelsReady;
  const locked = $('#ia-locked');
  const content = $('#ia-content');
  if (wantsIA && isReady) {
    // Modo IA activo: desbloquear todo
    if (locked) { locked.hidden = true; locked.textContent = ''; }
    if (content) content.hidden = false;
  } else if (wantsIA && !isReady) {
    // Quiere IA pero modelos no descargados
    if (locked) { locked.hidden = false; locked.textContent = 'Descargá los modelos en ⚙ para activar el análisis IA.'; }
    if (content) content.hidden = true;
  } else {
    // Heurístico
    if (locked) { locked.hidden = false; locked.textContent = 'Activá el Modo IA en ⚙ para usar esta pestaña.'; }
    if (content) content.hidden = true;
  }
}

/* ============================================================
   M7: renderTimeMeter — tiempo del guion vs objetivo
   ============================================================ */
function renderTimeMeter(a) {
  const proj = state.p;
  const root = $('#time-meter');
  const hint = $('#time-hint');
  if (!root || !proj) return;
  const blockTime = proj.blocks.reduce((s, b) => s + durationInSeconds(b.content, proj.wpm), 0);
  const target = +(proj.targetDuration || 0);
  const timeStr = time(blockTime);
  if (target > 0) {
    const pct = Math.min(100, Math.round(blockTime / target * 100));
    const diff = target - blockTime;
    const diffLabel = diff > 0 ? 'Faltan ' + time(diff) : 'Sobran ' + time(Math.abs(diff));
    const barColor = pct >= 90 && pct <= 110 ? 'var(--good)' : pct > 110 ? 'var(--warn)' : 'var(--purple)';
    root.innerHTML = '<div class="time-row"><span>' + timeStr + '</span><span class="time-target">/ ' + time(target) + ' objetivo</span></div>' +
      '<div class="time-bar"><i style="width:' + pct + '%;background:' + barColor + '"></i></div>' +
      '<div class="time-diff">' + diffLabel + ' (' + pct + '%)</div>';
    if (hint) hint.textContent = diffLabel;
  } else {
    root.innerHTML = '<div class="time-row"><span>' + timeStr + '</span><span class="time-target">sin objetivo</span></div>';
    if (hint) hint.textContent = '';
  }
}

/* ============================================================
   Cognitive Load (Miller 1956 + Sweller 1988)
   ============================================================ */
function renderCognitiveLoad() {
  const proj = state.p;
  const root = $('#cognitive-load');
  if (!root || !proj?.blocks?.length) { if (root) root.innerHTML = '<div class="deep-empty">Escribí contenido para medir la carga.</div>'; return; }
  const cl = analyzeCognitiveLoad(proj.blocks, proj.wpm);
  const color = cl.score >= 75 ? 'var(--good)' : cl.score >= 50 ? 'var(--warn)' : 'var(--bad)';
  let html = '<div class="cl-header"><span class="cl-score" style="color:' + color + '">' + cl.score + '</span>' +
    '<span class="cl-level" style="color:' + color + '">' + cl.level + '</span></div>';
  // Métricas estructuradas (no frases perdidas)
  html += '<div class="cl-metrics">';
  html += '<div class="cl-metric"><small>Temas/min</small><b>' + cl.topicsPerMinute + '</b></div>';
  html += '<div class="cl-metric"><small>Pal/oración</small><b>' + cl.avgWordsPerSentence + '</b></div>';
  html += '<div class="cl-metric"><small>Descansos</small><b>' + cl.restPoints + '</b></div>';
  html += '</div>';
  html += '<div class="cl-details">';
  cl.details.forEach(d => { html += '<div class="cl-detail">' + esc(d) + '</div>'; });
  html += '</div>';
  root.innerHTML = html;
}

/* ============================================================
   M3: SVG retention curve (reemplaza Chart.js, D16)
   ============================================================ */
function renderRetentionCurveSVG(curve) {
  const container = $('#retention-curve-svg');
  if (!container) return;
  if (!curve || !curve.length) { container.innerHTML = '<div class="deep-empty">Calculá retención para ver la curva.</div>'; return; }
  const W = 380, H = 80, pad = 8;
  const n = curve.length;
  const xStep = (W - pad * 2) / Math.max(1, n - 1);
  const pts = curve.map((p, i) => ({
    x: pad + (n === 1 ? (W - pad * 2) / 2 : i * xStep),
    y: H - pad - (p.retentionPct / 100) * (H - pad * 2),
    p
  }));
  const path = pts.map((pt, i) => (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1)).join(' ');
  const areaPath = path + ' L' + pts[pts.length-1].x.toFixed(1) + ',' + (H-pad) + ' L' + pts[0].x.toFixed(1) + ',' + (H-pad) + ' Z';
  const dots = pts.map(pt => {
    const color = pt.p.isDropRisk ? 'var(--bad)' : 'var(--teal)';
    return '<circle cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) + '" r="4" fill="' + color +
      '" style="cursor:pointer" data-block-idx="' + pt.p.blockIndex + '"><title>#' + (pt.p.blockIndex+1) + ': ' + pt.p.retentionPct + '%</title></circle>';
  }).join('');
  container.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:80px">' +
    '<path d="' + areaPath + '" fill="rgba(50,210,172,.08)"/>' +
    '<path d="' + path + '" fill="none" stroke="var(--teal)" stroke-width="1.5" opacity="0.7"/>' +
    '<line x1="' + pad + '" y1="' + (H-pad) + '" x2="' + (W-pad) + '" y2="' + (H-pad) + '" stroke="var(--border)"/>' +
    dots + '</svg>' +
    '<div class="curve-legend"><span style="color:var(--teal)">●</span> estable <span style="color:var(--bad)">●</span> riesgo de fuga <span style="color:var(--muted)">clic para ir al bloque</span></div>';
  // Click handlers: scroll al bloque
  container.querySelectorAll('circle[data-block-idx]').forEach(c => {
    c.addEventListener('click', () => {
      const idx = parseInt(c.dataset.blockIdx);
      const blocks = document.querySelectorAll('.flow-block');
      if (blocks[idx]) {
        state.sel = blocks[idx].dataset.id;
        blocks[idx].classList.add('selected');
        blocks[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

/* ============================================================
   TIER 2 RENDERERS — Diagnóstico semántico profundo (on-demand)
   Movid desde main.js para respetar §13: render.js maneja todo el DOM,
   main.js solo orquesta. main.js las importa y las llama desde runDeep().
   ============================================================ */
export function renderExtractive(result) {
  const root = $('#extractive-block');
  if (!root) return;
  const sentences = result.sentences || [];
  if (!sentences.length) {
    root.innerHTML = '<div class="deep-empty">Sin oraciones suficientes.</div>';
    return;
  }
  root.innerHTML = '<p style="font-size:11px;color:var(--faint);margin-bottom:6px">Ideas centrales:</p>' +
    sentences.map(s =>
      '<div class="key-sentence">' + esc(s.text) + '<span class="score-badge">Relevancia: ' + Math.round((s.score || 0) * 100) + '%</span></div>'
    ).join('');
}

export function renderRedundancy(result) {
  const root = $('#redundancy-block');
  if (!root) return;
  let html = '<p style="font-size:11px;color:var(--faint);margin-bottom:6px">Repetición: ' +
    (result.redundantCount || 0) + ' redundancias · ' + (result.contrastCount || 0) + ' contrastes válidos</p>';

  if (result.redundantPairs && result.redundantPairs.length) {
    html += result.redundantPairs.slice(0, 6).map(pair =>
      '<div class="redundancy-pair"><span class="sim-tag high">' + Math.round(pair.similarity * 100) + '%</span>' +
      '<blockquote>' + esc(pair.textA.substring(0, 120)) + '</blockquote>' +
      '<blockquote>' + esc(pair.textB.substring(0, 120)) + '</blockquote></div>'
    ).join('');
  }
  if (result.contrastPairs && result.contrastPairs.length) {
    html += '<p style="font-size:11px;color:var(--teal);margin:8px 0 4px">Contrastes narrativos (válidos):</p>';
    html += result.contrastPairs.slice(0, 4).map(pair =>
      '<div class="redundancy-pair contrast"><span class="sim-tag contrast">' + Math.round(pair.similarity * 100) + '% · Δ' + (pair.valenceDiff || 0).toFixed(2) + '</span>' +
      '<blockquote>' + esc(pair.textA.substring(0, 120)) + '</blockquote>' +
      '<blockquote>' + esc(pair.textB.substring(0, 120)) + '</blockquote></div>'
    ).join('');
  }
  if (!result.redundantPairs?.length && !result.contrastPairs?.length) {
    html += '<div class="deep-empty" style="color:var(--good)">✓ Sin redundancias detectadas.</div>';
  }
  root.innerHTML = html;
}

export function renderDensity(result) {
  const root = $('#density-block');
  if (!root) return;
  const changes = result.changes || [];
  const totalSegments = Number(result.totalSegments || result.segments?.length || 0);
  if (!totalSegments) {
    root.innerHTML = '<div class="density-card"><span class="density-info">Ritmo de temas</span><p class="density-explainer">Escribí contenido suficiente para estimar temas por minuto.</p></div>';
    return;
  }
  const topicCount = Number.isFinite(Number(result.topicCount)) ? Number(result.topicCount) : changes.length + 1;
  const topicsPerMinute = Number.isFinite(Number(result.topicsPerMinute)) && Number(result.topicsPerMinute) > 0
    ? Number(result.topicsPerMinute)
    : topicCount / totalSegments;
  let html = '<div class="density-card">' +
    '<div class="density-card-head"><div><span class="density-value">' + topicsPerMinute.toFixed(1) + '</span>' +
    '<span class="density-unit">temas/min aprox.</span></div>' +
    '<span class="density-info">Ritmo de temas</span></div>' +
    '<p class="density-explainer">Temas nuevos detectados por minuto. Se calcula comparando segmentos consecutivos del guion.</p>' +
    '<div class="density-meta">' + topicCount + ' temas estimados · ' + changes.length + ' cambios de tema · ' + totalSegments + ' segmentos</div>' +
    '</div>';
  if (changes.length) {
    html += changes.slice(0, 5).map(c =>
      '<div class="density-change">Cambio temático tras segmento ' + (c.afterSegment + 1) + ' · similitud ' + Math.round(c.similarity * 100) + '%</div>'
    ).join('');
  } else {
    html += '<div class="density-change density-none">No se detectaron cortes temáticos fuertes entre segmentos.</div>';
  }
  root.innerHTML = html;
}

export function renderGaps() {
  const root = $('#gaps-block');
  if (!root) return Promise.resolve();
  const proj = state.p;
  const structuralTopics = PREDEFINED_TOPICS.filter(t => t.kind === 'structural');
  const semanticTopics = PREDEFINED_TOPICS.filter(t => t.kind === 'semantic');

  let html = '<p style="font-size:11px;color:var(--faint);margin-bottom:6px">Estructura del guion:</p><div class="chips">';
  structuralTopics.forEach(t => {
    const has = proj.blocks.some(b => b.type === t.blockType);
    html += '<span class="schip ' + (has ? 'ok' : 'no') + '">' + (has ? '✓' : '✗') + ' ' + t.label + '</span>';
  });
  html += '</div>';

  // Cobertura semántica (requiere IA)
  if (state.mode !== 'ia' || !state.worker) {
    html += '<p style="font-size:11px;color:var(--faint);margin-top:10px">Cobertura semántica: activá el Modo IA.</p>';
    root.innerHTML = html;
    return Promise.resolve();  // Bug 1 fix: siempre retorna Promise
  }

  const blocks = proj.blocks.map(b => b.content).filter(t => t && t.trim());
  if (!blocks.length) {
    root.innerHTML = html;
    return Promise.resolve();  // Bug 1 fix
  }

  // Bug 1 fix: retornar la promise del workerSend para que runDeep la espere.
  return workerSend('DETECT_GAPS', { blocks, topics: semanticTopics })
    .then(result => {
      let semHtml = '<p style="font-size:11px;color:var(--faint);margin-top:10px">Cobertura semántica (IA):</p><div class="gaps-list">';
      result.gaps.forEach(g => { semHtml += '<div class="gap-item"><div class="gap-topic">' + esc(g.topic) + '</div><small>Mejor match: ' + Math.round(g.maxSimilarity * 100) + '%</small></div>'; });
      result.covered.forEach(g => { semHtml += '<div class="gap-item covered"><div class="gap-topic">' + esc(g.topic) + '</div><small>Cubierto (' + Math.round(g.maxSimilarity * 100) + '%)</small></div>'; });
      semHtml += '</div>';
      root.innerHTML = html + semHtml;
    })
    .catch(err => { root.innerHTML = html + '<div class="deep-empty">Error: ' + esc(err.message) + '</div>'; });
}

/* ============================================================
   Registro en workers.js (DI, §3.3)
   ============================================================ */
setRenderCallbacks(renderMetrics, renderRetentionPanel, renderSentimentArc);
