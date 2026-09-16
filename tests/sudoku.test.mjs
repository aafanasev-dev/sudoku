import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generate, solve, countSolutions, hasUniqueSolution, isValidGrid, candidates,
  clueCount, randomSolution, seededRandom, PEERS, UNITS, CELLS,
} from '../js/sudoku.js';
import { LEVELS, getLevel, nextLevel } from '../js/levels.js';

// A well-known puzzle with a unique solution.
const PUZZLE = [
  5, 3, 0, 0, 7, 0, 0, 0, 0,
  6, 0, 0, 1, 9, 5, 0, 0, 0,
  0, 9, 8, 0, 0, 0, 0, 6, 0,
  8, 0, 0, 0, 6, 0, 0, 0, 3,
  4, 0, 0, 8, 0, 3, 0, 0, 1,
  7, 0, 0, 0, 2, 0, 0, 0, 6,
  0, 6, 0, 0, 0, 0, 2, 8, 0,
  0, 0, 0, 4, 1, 9, 0, 0, 5,
  0, 0, 0, 0, 8, 0, 0, 7, 9,
];

const isCompleteSolution = g => isValidGrid(g) && g.every(v => v >= 1 && v <= 9);

test('peers and units have the right shape', () => {
  assert.equal(PEERS.length, CELLS);
  assert.ok(PEERS.every(p => p.length === 20));
  assert.equal(UNITS.length, 27);
  assert.ok(UNITS.every(u => u.cells.length === 9));
});

test('solves a known puzzle', () => {
  const s = solve(PUZZLE);
  assert.ok(isCompleteSolution(s));
  PUZZLE.forEach((v, i) => { if (v) assert.equal(s[i], v); });
  assert.equal(s.slice(0, 9).join(''), '534678912');
});

test('counts solutions up to the limit', () => {
  assert.equal(countSolutions(PUZZLE), 1);
  assert.ok(hasUniqueSolution(PUZZLE));
  const empty = new Array(81).fill(0);
  assert.equal(countSolutions(empty, 2), 2);
  assert.equal(countSolutions(empty, 5), 5);
});

test('contradictory grids have no solution', () => {
  const bad = PUZZLE.slice();
  bad[2] = 5; // clashes with the 5 in the same row
  assert.equal(isValidGrid(bad), false);
  assert.equal(solve(bad), null);
  assert.equal(countSolutions(bad), 0);
});

test('isValidGrid rejects malformed input', () => {
  assert.equal(isValidGrid(null), false);
  assert.equal(isValidGrid([1, 2, 3]), false);
  assert.equal(isValidGrid(new Array(81).fill(10)), false);
  assert.equal(isValidGrid(new Array(81).fill(0.5)), false);
  assert.equal(isValidGrid(new Array(81).fill(0)), true);
});

test('candidates respect row, column and box', () => {
  assert.deepEqual(candidates(PUZZLE, 2), [1, 2, 4]);
});

test('random solutions are complete and vary with the seed', () => {
  const a = randomSolution(seededRandom(1));
  const b = randomSolution(seededRandom(2));
  assert.ok(isCompleteSolution(a));
  assert.ok(isCompleteSolution(b));
  assert.notDeepEqual(a, b);
  assert.deepEqual(randomSolution(seededRandom(1)), a);
});

for (const level of LEVELS) {
  test(`${level.name}: puzzles are unique, match their solution and sit in ${level.minClues}-${level.maxClues} clues`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { puzzle, solution } = generate(level, seededRandom(seed * 7919 + level.id));
      const clues = clueCount(puzzle);
      assert.ok(clues >= level.minClues && clues <= level.maxClues, `${clues} clues`);
      assert.ok(isCompleteSolution(solution));
      puzzle.forEach((v, i) => { if (v) assert.equal(v, solution[i]); });
      assert.ok(hasUniqueSolution(puzzle));
      assert.deepEqual(solve(puzzle), solution);
    }
  });
}

test('generation reports failure instead of looping forever', () => {
  assert.throws(() => generate({ minClues: 5, maxClues: 5 }, seededRandom(3), 2), /Could not generate/);
});

test('level table', () => {
  assert.deepEqual(LEVELS.map(l => l.name), ['Easy', 'Medium', 'Hard', 'Expert', 'Evil']);
  for (let k = 1; k < LEVELS.length; k++) {
    assert.ok(LEVELS[k].maxClues < LEVELS[k - 1].minClues, 'clue ranges get strictly harder');
  }
  assert.equal(getLevel(3).name, 'Hard');
  assert.equal(nextLevel(4).name, 'Evil');
  assert.equal(nextLevel(5), null);
  assert.throws(() => getLevel(9), RangeError);
  assert.ok(Object.isFrozen(LEVELS[0]));
});
