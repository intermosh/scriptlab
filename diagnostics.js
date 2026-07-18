/* Compatibilidad Opera: indicador de carga y fallback si app.js no logra inicializar. */
window.ScriptLabBooted = false;
window.addEventListener('error', event => {
  if (window.ScriptLabBooted) return;
  const status = document.getElementById('save');
  if (status) status.textContent = 'Error JS: ' + event.message;
});
window.addEventListener('DOMContentLoaded', () => {
  const dialog = document.getElementById('aidialog');
  document.getElementById('ai')?.addEventListener('click', () => {
    if (window.ScriptLabBooted) return;
    if (dialog?.showModal) dialog.showModal(); else if (dialog) { dialog.open = true; dialog.style.display = 'block'; }
  });
});
