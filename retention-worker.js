/* retention-worker.js — Web Worker wrapper delgado.
   Implementa §13.9 (parte mensajería) y §6.3 del contrato.
   Desvío aprobado (D3): la lógica pura vive en retention-engine.js;
   este archivo solo enruta mensajes del hilo principal. */

import { computeRetentionPrediction } from './retention-engine.js';

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'PREDICT_RETENTION') {
      const result = computeRetentionPrediction({
        blocks: data.blocks,
        wpm: data.wpm,
        promise: data.promise,
        title: data.title
      });
      self.postMessage({ type: 'RETENTION_RESULT', requestId: data.requestId, ...result });
    } else {
      self.postMessage({ type: 'ERROR', requestId: data.requestId, message: 'Tipo desconocido: ' + data.type });
    }
  } catch (error) {
    self.postMessage({ type: 'ERROR', requestId: data.requestId, message: error.message || 'Error en retention worker' });
  }
};
