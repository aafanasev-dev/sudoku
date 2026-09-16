// The puzzle engine. Pure functions over flat 81-cell arrays (0 = empty).
// No DOM: this file is imported by the UI, the Web Worker and Node tests.

export const SIZE = 9;
export const CELLS = 81;
const ALL = 0x3fe; // bits 1..9

export const rowOf = i => Math.floor(i / SIZE);
export const colOf = i => i % SIZE;
export const boxOf = i => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

/** For every cell, the 20 other cells sharing its row, column or box. */
export const PEERS = Array.from({ length: CELLS }, (_, i) => {
  const peers = [];
  for (let j = 0; j < CELLS; j++) {
    if (j !== i && (rowOf(j) === rowOf(i) || colOf(j) === colOf(i) || boxOf(j) === boxOf(i))) {
      peers.push(j);
    }
  }
  return peers;
});

/** The 27 units (9 rows, 9 columns, 9 boxes) as arrays of cell indexes. */
export const UNITS = (() => {
  const units = [];
  for (let r = 0; r < SIZE; r++) units.push({ type: 'row', index: r, cells: [...Array(SIZE)].map((_, c) => r * SIZE + c) });
  for (let c = 0; c < SIZE; c++) units.push({ type: 'col', index: c, cells: [...Array(SIZE)].map((_, r) => r * SIZE + c) });
  for (let b = 0; b < SIZE; b++) {
    const cells = [];
    for (let i = 0; i < CELLS; i++) if (boxOf(i) === b) cells.push(i);
    units.push({ type: 'box', index: b, cells });
  }
  return units;
})();

const bitCount = m => { let n = 0; while (m) { m &= m - 1; n++; } return n; };

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Digits (1-9) that can legally go in cell i given the rest of the grid. */
export function candidates(grid, i) {
  let used = 0;
  for (const p of PEERS[i]) used |= 1 << grid[p];
  const out = [];
  for (let d = 1; d <= 9; d++) if (!(used & (1 << d))) out.push(d);
  return out;
}

/** True if the grid has no two equal non-zero digits in a unit. */
export function isValidGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== CELLS) return false;
  for (let i = 0; i < CELLS; i++) {
    const v = grid[i];
    if (!Number.isInteger(v) || v < 0 || v > 9) return false;
    if (v && PEERS[i].some(p => grid[p] === v)) return false;
  }
  return true;
}

/**
 * Depth-first search with the most-constrained-cell heuristic.
 * Calls onSolution(grid) for each solution; stops when it returns true.
 */
function search(grid, rng, onSolution) {
  const g = grid.slice();
  const rows = new Array(SIZE).fill(0);
  const cols = new Array(SIZE).fill(0);
  const boxes = new Array(SIZE).fill(0);
  const empty = [];
  for (let i = 0; i < CELLS; i++) {
    const v = g[i];
    if (v) {
      const bit = 1 << v;
      if ((rows[rowOf(i)] | cols[colOf(i)] | boxes[boxOf(i)]) & bit) return; // contradictory givens
      rows[rowOf(i)] |= bit; cols[colOf(i)] |= bit; boxes[boxOf(i)] |= bit;
    } else {
      empty.push(i);
    }
  }

  let stop = false;
  const step = depth => {
    if (depth === empty.length) {
      stop = onSolution(g.slice()) === true;
      return;
    }
    // Pick the empty cell with the fewest options and swap it into position `depth`.
    let best = -1, bestMask = 0, bestCount = 10;
    for (let k = depth; k < empty.length; k++) {
      const i = empty[k];
      const mask = ALL & ~(rows[rowOf(i)] | cols[colOf(i)] | boxes[boxOf(i)]);
      const n = bitCount(mask);
      if (n < bestCount) { best = k; bestMask = mask; bestCount = n; if (n <= 1) break; }
    }
    if (bestCount === 0) return;
    [empty[depth], empty[best]] = [empty[best], empty[depth]];
    const i = empty[depth];
    const r = rowOf(i), c = colOf(i), b = boxOf(i);

    const digits = [];
    for (let d = 1; d <= 9; d++) if (bestMask & (1 << d)) digits.push(d);
    if (rng) shuffle(digits, rng);

    for (const d of digits) {
      const bit = 1 << d;
      g[i] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
      step(depth + 1);
      g[i] = 0; rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit;
      if (stop) return;
    }
  };
  step(0);
}

/** The first solution found, or null. */
export function solve(grid) {
  let result = null;
  search(grid, null, s => { result = s; return true; });
  return result;
}

/** Number of solutions, counting no further than `limit`. */
export function countSolutions(grid, limit = 2) {
  let n = 0;
  search(grid, null, () => ++n >= limit);
  return n;
}

export const hasUniqueSolution = grid => countSolutions(grid, 2) === 1;

/** A random completely filled valid grid. */
export function randomSolution(rng = Math.random) {
  let result = null;
  search(new Array(CELLS).fill(0), rng, s => { result = s; return true; });
  return result;
}

export const clueCount = grid => grid.reduce((n, v) => n + (v ? 1 : 0), 0);

/**
 * Remove clues from a full grid, one at a time, keeping the solution unique,
 * until `target` clues remain. Returns null if the grid can't get that low.
 */
function carve(solution, target, rng) {
  const puzzle = solution.slice();
  let clues = CELLS;
  for (const i of shuffle([...Array(CELLS).keys()], rng)) {
    if (clues <= target) break;
    const v = puzzle[i];
    puzzle[i] = 0;
    if (hasUniqueSolution(puzzle)) clues--;
    else puzzle[i] = v;
  }
  return clues === target ? puzzle : null;
}

/**
 * Generate a puzzle whose clue count lies in [minClues, maxClues] and which
 * has exactly one solution. Returns { puzzle, solution }.
 */
export function generate({ minClues, maxClues }, rng = Math.random, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const solution = randomSolution(rng);
    const target = minClues + Math.floor(rng() * (maxClues - minClues + 1));
    const puzzle = carve(solution, target, rng);
    if (puzzle) return { puzzle, solution };
  }
  throw new Error(`Could not generate a puzzle with ${minClues}-${maxClues} clues`);
}

/** Deterministic PRNG (mulberry32) so tests can reproduce puzzles. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
