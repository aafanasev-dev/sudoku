// Hands out puzzles. Generation runs in a Web Worker; the next puzzle for the
// level being played is prepared in the background. Falls back to generating
// inline when workers are unavailable.
import { generate } from './sudoku.js';
import { getLevel } from './levels.js';

let worker = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map();      // request id -> { resolve, reject }
const prefetched = new Map();   // level id -> Promise<{ puzzle, solution }>

function getWorker() {
  if (worker || workerBroken || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./generator.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const req = pending.get(data.id);
      if (!req) return;
      pending.delete(data.id);
      if (data.ok) req.resolve({ puzzle: data.puzzle, solution: data.solution });
      else req.reject(new Error(data.error));
    };
    worker.onerror = event => {
      event.preventDefault?.();
      failWorker(new Error('Puzzle worker failed'));
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function failWorker(err) {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const req of pending.values()) req.reject(err);
  pending.clear();
}

function generateInline(levelId) {
  // Yield first so the caller can paint a spinner before the CPU work.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(generate(getLevel(levelId))); } catch (err) { reject(err); }
    }, 0);
  });
}

function build(levelId) {
  const w = getWorker();
  if (!w) return generateInline(levelId);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, levelId });
  }).catch(() => generateInline(levelId));
}

/** Get a puzzle for the level, using a prefetched one if ready. */
export function getPuzzle(levelId) {
  const ready = prefetched.get(levelId);
  prefetched.delete(levelId);
  const result = ready ?? build(levelId);
  prefetch(levelId);
  return result;
}

/** Start preparing the next puzzle for a level. */
export function prefetch(levelId) {
  if (prefetched.has(levelId)) return;
  const p = build(levelId);
  p.catch(() => prefetched.delete(levelId));
  prefetched.set(levelId, p);
}
