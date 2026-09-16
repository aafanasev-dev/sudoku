// The level table. Unlock thresholds are deliberately absent: the server owns
// the unlock rule (backend/app/levels.py) and reports it with the progress.

export const LEVELS = Object.freeze([
  { id: 1, key: 'easy',   name: 'Easy',   minClues: 44, maxClues: 50 },
  { id: 2, key: 'medium', name: 'Medium', minClues: 36, maxClues: 42 },
  { id: 3, key: 'hard',   name: 'Hard',   minClues: 32, maxClues: 35 },
  { id: 4, key: 'expert', name: 'Expert', minClues: 28, maxClues: 31 },
  { id: 5, key: 'evil',   name: 'Evil',   minClues: 24, maxClues: 27 },
].map(Object.freeze));

export function getLevel(id) {
  const level = LEVELS.find(l => l.id === id);
  if (!level) throw new RangeError(`Unknown level: ${id}`);
  return level;
}

export function nextLevel(id) {
  return LEVELS.find(l => l.id === id + 1) ?? null;
}
