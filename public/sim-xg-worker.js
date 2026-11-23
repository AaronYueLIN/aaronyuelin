/**
 * Isolated Rapier Monte Carlo worker for simulated goal probability.
 * Owns its own world. It never receives the game world's handles.
 */
import { createWorld, initRapier } from './physics-rapier.js?v=2026.11.23-r10';
import { freeWorld, simulateBatch } from './sim-xg.js?v=2026.11.23-r10';

let world = null;
let generation = 0;
let ready = null;

function ensureWorld() {
  if (!ready) {
    ready = initRapier().then(() => {
      if (!world) world = createWorld();
      return world;
    });
  }
  return ready;
}

function disposeWorld() {
  generation += 1;
  const old = world;
  world = null;
  ready = null;
  freeWorld(old);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    try {
      await ensureWorld();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'init-error', message: String(error?.message ?? error) });
    }
    return;
  }
  if (msg.type === 'cancel') {
    generation += 1;
    self.postMessage({ type: 'cancelled', id: msg.id ?? null });
    return;
  }
  if (msg.type === 'dispose') {
    disposeWorld();
    self.postMessage({ type: 'disposed', id: msg.id ?? null });
    return;
  }
  if (msg.type !== 'run') return;
  const id = msg.id;
  const myGen = (generation += 1);
  try {
    const isolated = await ensureWorld();
    if (myGen !== generation) {
      self.postMessage({ type: 'cancelled', id });
      return;
    }
    const result = await simulateBatch(isolated, msg.spec || {}, {
      shouldCancel: () => myGen !== generation,
      onProgress: (partial) => {
        if (myGen === generation) {
          self.postMessage({ type: 'progress', id, ...partial });
        }
      },
    });
    if (myGen !== generation || result.cancelled) {
      self.postMessage({ type: 'cancelled', id });
      return;
    }
    self.postMessage({ type: 'done', id, result });
  } catch (error) {
    if (myGen !== generation) return;
    self.postMessage({
      type: 'error',
      id,
      message: String(error?.message ?? error),
    });
  }
};
