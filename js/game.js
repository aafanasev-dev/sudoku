// One puzzle in play: entries, notes, undo, timer, mistakes and hints.
// No DOM. The UI subscribes to events instead of being called.
import { CELLS, PEERS, UNITS } from './sudoku.js';

export class Emitter {
  #handlers = new Map();
  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.#handlers.get(type)?.delete(fn);
  }
  emit(type, detail = {}) {
    for (const fn of this.#handlers.get(type) ?? []) fn(detail);
    for (const fn of this.#handlers.get('*') ?? []) fn({ type, ...detail });
  }
}

const noteBit = d => 1 << d;
const STREAK_STEP = 5;

export class Game extends Emitter {
  /**
   * @param {object} o
   * @param {number} o.levelId
   * @param {number[]} o.puzzle     givens, 0 = empty
   * @param {number[]} o.solution
   * @param {() => number} [o.now]  clock, injectable for tests
   */
  constructor({ levelId, puzzle, solution, now = () => Date.now() }) {
    super();
    if (puzzle?.length !== CELLS || solution?.length !== CELLS) throw new TypeError('Bad puzzle');
    this.levelId = levelId;
    this.puzzle = puzzle.slice();
    this.solution = solution.slice();
    this.entries = puzzle.slice();          // givens + player digits
    this.notes = new Array(CELLS).fill(0);  // bitmask of pencil marks
    this.mistakes = 0;
    this.hints = 0;
    this.goodMoves = 0;
    this.streak = 0;
    this.solved = false;
    this.history = [];
    this.now = now;
    this.elapsedBefore = 0;
    this.startedAt = null;                  // null while paused / not started
  }

  static fromJSON(data, now) {
    const g = new Game({ levelId: data.levelId, puzzle: data.puzzle, solution: data.solution, now });
    const ints = (a, max) => Array.isArray(a) && a.length === CELLS && a.every(v => Number.isInteger(v) && v >= 0 && v <= max);
    if (ints(data.entries, 9)) g.entries = data.entries.map((v, i) => g.puzzle[i] || v);
    if (ints(data.notes, 0x3fe)) g.notes = data.notes.slice();
    for (const k of ['mistakes', 'hints', 'goodMoves', 'streak', 'elapsedBefore']) {
      if (Number.isInteger(data[k]) && data[k] >= 0) g[k] = data[k];
    }
    return g;
  }

  toJSON() {
    return {
      levelId: this.levelId,
      puzzle: this.puzzle,
      solution: this.solution,
      entries: this.entries,
      notes: this.notes,
      mistakes: this.mistakes,
      hints: this.hints,
      goodMoves: this.goodMoves,
      streak: this.streak,
      elapsedBefore: this.elapsed(),
    };
  }

  // ── timer ──────────────────────────────────────────────────────────
  elapsed() {
    return this.elapsedBefore + (this.startedAt === null ? 0 : this.now() - this.startedAt);
  }
  get running() { return this.startedAt !== null; }
  start() {
    if (this.solved || this.running) return;
    this.startedAt = this.now();
    this.emit('timer', { running: true });
  }
  pause() {
    if (!this.running) return;
    this.elapsedBefore = this.elapsed();
    this.startedAt = null;
    this.emit('timer', { running: false });
  }

  // ── queries ────────────────────────────────────────────────────────
  isGiven(i) { return this.puzzle[i] !== 0; }
  isWrong(i) { return this.entries[i] !== 0 && this.entries[i] !== this.solution[i]; }
  hasNote(i, d) { return (this.notes[i] & noteBit(d)) !== 0; }
  /** Cells whose digit clashes with another digit in the same unit. */
  conflicts() {
    const out = new Set();
    for (let i = 0; i < CELLS; i++) {
      const v = this.entries[i];
      if (v && PEERS[i].some(p => this.entries[p] === v)) out.add(i);
    }
    return out;
  }
  /** How many correct copies of each digit are on the board (index 1-9). */
  digitCounts() {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < CELLS; i++) if (this.entries[i] && this.entries[i] === this.solution[i]) counts[this.entries[i]]++;
    return counts;
  }
  isFull() { return this.entries.every(v => v !== 0); }

  #unitsDone(i) {
    return UNITS.filter(u => u.cells.includes(i) && u.cells.every(c => this.entries[c] === this.solution[c]));
  }

  // ── moves ──────────────────────────────────────────────────────────
  #canEdit(i) {
    return !this.solved && Number.isInteger(i) && i >= 0 && i < CELLS && !this.isGiven(i);
  }

  place(i, d, { hint = false } = {}) {
    if (!this.#canEdit(i) || !(d >= 1 && d <= 9)) return false;
    if (this.entries[i] === d) return false;
    this.start();

    const unitsBefore = new Set(this.#unitsDone(i).map(u => u.type + u.index));
    const countBefore = this.digitCounts()[d];
    const record = { i, value: this.entries[i], notes: this.notes[i], peerNotes: [] };

    this.entries[i] = d;
    this.notes[i] = 0;
    const correct = d === this.solution[i];

    // A placed digit rules itself out of every peer's notes.
    for (const p of PEERS[i]) {
      if (this.notes[p] & noteBit(d)) {
        record.peerNotes.push([p, this.notes[p]]);
        this.notes[p] &= ~noteBit(d);
      }
    }
    this.history.push(record);

    if (hint) {
      this.hints++;
    } else if (correct) {
      this.goodMoves++;
      this.streak++;
    } else {
      this.mistakes++;
      this.streak = 0;
    }

    this.emit('place', { index: i, digit: d, correct, hint });
    if (!correct) this.emit('mistake', { index: i, digit: d, mistakes: this.mistakes });
    if (correct && !hint && this.streak > 0 && this.streak % STREAK_STEP === 0) {
      this.emit('streak', { count: this.streak });
    }
    if (correct) {
      for (const u of this.#unitsDone(i)) {
        if (!unitsBefore.has(u.type + u.index)) this.emit('unit-complete', { unit: u });
      }
      if (countBefore < 9 && this.digitCounts()[d] === 9) this.emit('digit-complete', { digit: d });
    }
    this.emit('change');
    this.#checkSolved();
    return true;
  }

  erase(i) {
    if (!this.#canEdit(i) || (this.entries[i] === 0 && this.notes[i] === 0)) return false;
    this.history.push({ i, value: this.entries[i], notes: this.notes[i], peerNotes: [] });
    this.entries[i] = 0;
    this.notes[i] = 0;
    this.emit('change');
    return true;
  }

  toggleNote(i, d) {
    if (!this.#canEdit(i) || this.entries[i] !== 0 || !(d >= 1 && d <= 9)) return false;
    this.start();
    this.history.push({ i, value: 0, notes: this.notes[i], peerNotes: [] });
    this.notes[i] ^= noteBit(d);
    this.emit('change');
    return true;
  }

  undo() {
    if (this.solved) return false;
    const rec = this.history.pop();
    if (!rec) return false;
    this.entries[rec.i] = rec.value;
    this.notes[rec.i] = rec.notes;
    for (const [p, mask] of rec.peerNotes) this.notes[p] = mask;
    this.emit('undo', { index: rec.i });
    this.emit('change');
    return true;
  }

  /** Reveal the answer for cell `i`, or for some empty/wrong cell. Returns the cell. */
  hint(i = null) {
    if (this.solved) return null;
    let target = i;
    if (target === null || !this.#canEdit(target) || this.entries[target] === this.solution[target]) {
      const open = [];
      for (let k = 0; k < CELLS; k++) if (!this.isGiven(k) && this.entries[k] !== this.solution[k]) open.push(k);
      if (!open.length) return null;
      target = open[Math.floor(Math.random() * open.length)];
    }
    this.place(target, this.solution[target], { hint: true });
    this.emit('hint', { index: target, hints: this.hints });
    return target;
  }

  #checkSolved() {
    if (!this.isFull()) return;
    if (this.entries.some((v, i) => v !== this.solution[i])) {
      this.emit('full-with-errors');
      return;
    }
    this.pause();
    this.solved = true;
    const timeMs = this.elapsed();
    this.emit('solved', {
      levelId: this.levelId,
      timeMs,
      mistakes: this.mistakes,
      hints: this.hints,
      goodMoves: this.goodMoves,
      flawless: this.mistakes === 0 && this.hints === 0,
    });
  }
}
