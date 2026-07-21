/* export-import.js — Import/export de proyectos.
   Implementa §13.7 y §12 del contrato.
   Depende de: state.js (normalizeProject), db.js (put/get/all). */

import { normalizeProject } from './state.js';
import { put, all } from './db.js';

/* ============================================================
   Helpers de descarga
   ============================================================ */
function download(data, name, type) {
  const u = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 800);
}

function fileSlug(text) {
  return (text || 'scriptlab').toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

/* ============================================================
   Export JSON — completo, re-importable (§12.1)
   ============================================================ */
export function exportJSON(project, analysis, calibration) {
  download(
    JSON.stringify({
      app: 'ScriptLab AI',
      version: 4,
      exportedAt: new Date().toISOString(),
      project, analysis, calibration
    }, null, 2),
    fileSlug(project.title) + '.scriptlab.json',
    'application/json'
  );
}

/* ============================================================
   Export Markdown — guion legible (§12.1)
   ============================================================ */
export function exportMarkdown(project, analysis) {
  let md = '# ' + project.title + '\n\n**Promesa:** ' + (project.promise || '—') + '\n\n**Salud del guion:** ' + (analysis?.score || 0) + '/100\n';
  project.blocks.forEach((b, i) => {
    md += '\n## ' + (i + 1) + '. ' + b.type + ': ' + b.label + '\n\n' +
      (b.content || '_Sin contenido_') + '\n' +
      (b.notes ? '\n> Nota: ' + b.notes + '\n' : '');
  });
  download(md, fileSlug(project.title) + '.md', 'text/markdown');
}

/* ============================================================
   Export HTML — standalone estilado (§12.1)
   ============================================================ */
export function exportHTML(project, analysis) {
  const clean = v => String(v || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const blocks = project.blocks.map((b, i) =>
    '<section><small>' + (i + 1) + '. ' + clean(b.type) + '</small><h2>' + clean(b.label) + '</h2>' +
    '<p>' + clean(b.content).replace(/\n/g, '<br>') + '</p></section>'
  ).join('');
  download(
    '<!doctype html><meta charset="utf-8"><title>' + clean(project.title) + '</title>' +
    '<style>body{font:16px system-ui;max-width:780px;margin:40px auto;line-height:1.6;color:#222}' +
    'section{border-left:4px solid #7969ff;padding:10px 20px;margin:15px 0;background:#fafafa}' +
    'small{color:#666}</style><h1>' + clean(project.title) + '</h1><p>' + clean(project.promise) + '</p>' +
    '<p>Salud del guion ' + (analysis?.score || 0) + '/100</p>' + blocks,
    fileSlug(project.title) + '.html',
    'text/html'
  );
}

/* ============================================================
   Parse Markdown → bloques (§12.2)
   ============================================================ */
export function parseMarkdownToBlocks(md) {
  const blocks = [];
  const skipped = [];
  const sections = md.split(/^##\s+/m);
  const validTypes = ['HOOK','CONTEXTO','EVIDENCIA','SEGMENTO','GIRO','VISUAL','CTA'];

  for (const section of sections) {
    const m = section.match(/^(\d+)\.\s+(\w+):\s*(.+?)(?:\n\n([\s\S]*))?$/);
    if (!m) {
      // Bug 4 fix: si la sección ## tiene contenido pero no matchea el patrón estricto,
      // no descartarla silenciosamente. La guardamos como SEGMENTO con el título como label.
      const trimmed = section.trim();
      if (trimmed && trimmed.length > 3) {
        const firstLine = trimmed.split('\n')[0].trim();
        const rest = trimmed.substring(firstLine.length).trim();
        blocks.push({
          id: crypto.randomUUID(),
          type: 'SEGMENTO',
          label: firstLine.substring(0, 60) || 'Importado',
          content: rest,
          notes: ''
        });
      } else if (trimmed) {
        skipped.push(trimmed.substring(0, 40));
      }
      continue;
    }
    const typeStr = m[2].toUpperCase();
    const type = validTypes.includes(typeStr) ? typeStr : 'SEGMENTO';
    let content = m[4] || '';
    content = content.replace(/^> Nota:\s*(.+)/gm, '').trim();
    const notesMatch = section.match(/^> Nota:\s*(.+)/m);
    blocks.push({
      id: crypto.randomUUID(),
      type, label: m[3].trim(),
      content,
      notes: notesMatch ? notesMatch[1].trim() : ''
    });
  }
  if (skipped.length) {
    console.warn('[ScriptLab] Secciones de Markdown ignoradas por formato:', skipped);
  }
  return blocks;
}

/* ============================================================
   importProject(onDone) — JSON o MD, con confirmación (§12.2)
   ============================================================ */
export function importProject(onDone) {
  const input = document.querySelector('#import-input');
  if (!input) return;
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    const ext = file.name.split('.').pop().toLowerCase();
    try {
      if (ext === 'json') {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.project && data.title === undefined) throw new Error('Formato JSON no reconocido.');
        // Pasar `data` completo, NO `data.project || data`: los bloques están en
        // data.blocks (hermano de data.project), no dentro de data.project.
        const imported = normalizeProject(data);
        if (!confirm('¿Importar "' + imported.title + '"? Se reemplazará el proyecto actual.')) return;
        await put('projects', imported);
        if (onDone) onDone();
      } else if (ext === 'md') {
        const text = await file.text();
        const blocks = parseMarkdownToBlocks(text);
        const titleMatch = text.match(/^#\s+(.+)/m);
        const promiseMatch = text.match(/\*\*Promesa:\*\*\s*(.+)/);
        if (!confirm('¿Importar "' + (titleMatch ? titleMatch[1] : 'Sin título') + '"? Se reemplazará el proyecto actual.')) return;
        const imported = normalizeProject({
          title: titleMatch ? titleMatch[1].trim() : 'Importado',
          promise: promiseMatch ? promiseMatch[1].trim() : '',
          blocks
        });
        await put('projects', imported);
        if (onDone) onDone();
      } else {
        alert('Formato no soportado. Usá .json o .md');
      }
    } catch (err) {
      alert('Error al importar: ' + err.message);
    }
  };
  input.click();
}
