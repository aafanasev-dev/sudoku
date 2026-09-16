// Runs puzzle generation off the main thread.
import { generate } from './sudoku.js';
import { getLevel } from './levels.js';

self.onmessage = ({ data }) => {
  const { id, levelId } = data;
  try {
    const result = generate(getLevel(levelId));
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
