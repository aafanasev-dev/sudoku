import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../js/game.js';
import { solve } from '../js/sudoku.js';

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
const SOLUTION = solve(PUZZLE);

function makeGame() {
  let t = 0;
  const clock = { advance: ms => { t += ms; } };
  const game = new Game({ levelId: 1, puzzle: PUZZLE, solution: SOLUTION, now: () => t });
  const events = [];
  game.on('*', e => events.push(e));
  return { game, clock, events, of: type => events.filter(e => e.type === type) };
}

const wrongDigit = i => (SOLUTION[i] % 9) + 1;
const openCells = () => PUZZLE.map((v, i) => (v ? -1 : i)).filter(i => i >= 0);

test('givens cannot be changed', () => {
  const { game } = makeGame();
  assert.equal(game.place(0, 1), false);
  assert.equal(game.erase(0), false);
  assert.equal(game.toggleNote(0, 1), false);
  assert.equal(game.entries[0], 5);
});

test('a correct digit is a good move; a wrong one is a mistake that breaks the streak', () => {
  const { game, of } = makeGame();
  game.place(2, SOLUTION[2]);
  assert.equal(game.goodMoves, 1);
  assert.equal(game.streak, 1);
  assert.deepEqual(of('place')[0], { type: 'place', index: 2, digit: SOLUTION[2], correct: true, hint: false });

  game.place(3, wrongDigit(3));
  assert.equal(game.mistakes, 1);
  assert.equal(game.streak, 0);
  assert.equal(of('mistake').length, 1);
  assert.ok(game.isWrong(3));
});

test('five correct in a row fires a streak event', () => {
  const { game, of } = makeGame();
  for (const i of openCells().slice(0, 5)) game.place(i, SOLUTION[i]);
  assert.deepEqual(of('streak').map(e => e.count), [5]);
});

test('placing a digit clears it from peer notes, and undo restores them', () => {
  const { game } = makeGame();
  const d = SOLUTION[2];
  game.toggleNote(11, d);           // same box as cell 2
  game.toggleNote(11, 4 === d ? 1 : 4);
  game.toggleNote(40, d);           // centre cell: open, not a peer of cell 2
  const before = game.notes.slice();
  game.place(2, d);
  assert.equal(game.hasNote(11, d), false);
  assert.equal(game.hasNote(40, d), true);
  game.undo();
  assert.deepEqual(game.notes, before);
  assert.equal(game.entries[2], 0);
});

test('notes toggle and cannot be added to filled cells', () => {
  const { game } = makeGame();
  game.toggleNote(2, 4);
  assert.ok(game.hasNote(2, 4));
  game.toggleNote(2, 4);
  assert.ok(!game.hasNote(2, 4));
  game.place(2, SOLUTION[2]);
  assert.equal(game.toggleNote(2, 1), false);
});

test('undo walks back through history', () => {
  const { game } = makeGame();
  game.place(2, 1);
  game.place(2, 2);
  game.erase(2);
  game.undo();
  assert.equal(game.entries[2], 2);
  game.undo();
  assert.equal(game.entries[2], 1);
  game.undo();
  assert.equal(game.entries[2], 0);
  assert.equal(game.undo(), false);
});

test('completing a row fires unit-complete once', () => {
  const { game, of } = makeGame();
  for (let i = 0; i < 9; i++) if (!PUZZLE[i]) game.place(i, SOLUTION[i]);
  const rows = of('unit-complete').filter(e => e.unit.type === 'row');
  assert.deepEqual(rows.map(e => e.unit.index), [0]);
});

test('the ninth correct copy of a digit fires digit-complete', () => {
  const { game, of } = makeGame();
  const cells = openCells().filter(i => SOLUTION[i] === 7);
  cells.forEach(i => game.place(i, 7));
  assert.deepEqual(of('digit-complete').map(e => e.digit), [7]);
});

test('hints fill a cell, are counted, and are not good moves', () => {
  const { game, of } = makeGame();
  const i = game.hint(2);
  assert.equal(i, 2);
  assert.equal(game.entries[2], SOLUTION[2]);
  assert.equal(game.hints, 1);
  assert.equal(game.goodMoves, 0);
  assert.equal(of('hint').length, 1);

  const other = game.hint(0); // a given: picks some other open cell
  assert.notEqual(other, 0);
  assert.equal(game.entries[other], SOLUTION[other]);
});

test('timer runs from the first move and stops while paused', () => {
  const { game, clock } = makeGame();
  clock.advance(5000);
  assert.equal(game.elapsed(), 0);
  game.place(2, SOLUTION[2]);
  clock.advance(3000);
  game.pause();
  clock.advance(10_000);
  assert.equal(game.elapsed(), 3000);
  game.start();
  clock.advance(1000);
  assert.equal(game.elapsed(), 4000);
});

test('solving emits solved with the stats, and flawless only without mistakes or hints', () => {
  const { game, clock, of } = makeGame();
  const open = openCells();
  game.start();
  for (const i of open) { clock.advance(100); game.place(i, SOLUTION[i]); }
  const [solved] = of('solved');
  assert.equal(solved.flawless, true);
  assert.equal(solved.timeMs, open.length * 100);
  assert.equal(solved.goodMoves, open.length);
  assert.ok(game.solved);
  assert.equal(game.place(open[0], 1), false, 'no edits after solving');

  const second = makeGame();
  second.game.place(open[0], wrongDigit(open[0]));
  for (const i of open) second.game.place(i, SOLUTION[i]);
  assert.equal(second.of('solved')[0].flawless, false);
  assert.equal(second.of('solved')[0].mistakes, 1);
});

test('a full board with a wrong digit is not solved', () => {
  const { game, of } = makeGame();
  const open = openCells();
  game.place(open[0], wrongDigit(open[0]));
  for (const i of open.slice(1)) game.place(i, SOLUTION[i]);
  assert.equal(of('solved').length, 0);
  assert.equal(of('full-with-errors').length, 1);
  assert.deepEqual([...game.conflicts()].length > 0, true);
});

test('round-trips through JSON, and ignores junk in saved state', () => {
  const { game, clock } = makeGame();
  game.place(2, SOLUTION[2]);
  game.place(3, wrongDigit(3));
  game.toggleNote(5, 2);
  clock.advance(7000);
  const saved = JSON.parse(JSON.stringify(game));

  const restored = Game.fromJSON(saved, () => 0);
  assert.deepEqual(restored.entries, game.entries);
  assert.deepEqual(restored.notes, game.notes);
  assert.ok(restored.hasNote(5, 2));
  assert.equal(restored.mistakes, 1);
  assert.equal(restored.goodMoves, 1);
  assert.equal(restored.elapsed(), 7000);
  assert.equal(restored.running, false);

  const junk = Game.fromJSON({ ...saved, entries: 'x', notes: [1], mistakes: -4, hints: 'many' });
  assert.deepEqual(junk.entries, PUZZLE);
  assert.equal(junk.mistakes, 0);
  assert.equal(junk.hints, 0);

  const tampered = saved.entries.slice();
  tampered[0] = 9; // try to overwrite a given
  assert.equal(Game.fromJSON({ ...saved, entries: tampered }).entries[0], 5);

  assert.throws(() => Game.fromJSON({ ...saved, puzzle: [1, 2] }), TypeError);
});
