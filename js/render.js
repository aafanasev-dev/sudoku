// Board DOM and input. Reads game state, calls game methods; the rest of the
// app hears about user intents through the `actions` callbacks.
import { CELLS, rowOf, colOf, boxOf, PEERS } from './sudoku.js';

const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

export class BoardView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.board
   * @param {HTMLElement} o.numpad
   * @param {HTMLElement} o.notesButton
   * @param {object} o.actions  { onHint, onUndo, onErase, onPause, onBack, onNotesChange }
   */
  constructor({ board, numpad, notesButton, actions }) {
    this.boardEl = board;
    this.numpadEl = numpad;
    this.notesButton = notesButton;
    this.actions = actions;
    this.game = null;
    this.settings = { checkMistakes: true, highlightPeers: true };
    this.selected = null;
    this.notesMode = false;
    this.cells = [];
    this.padButtons = [];
    this.#build();
  }

  #build() {
    const frag = document.createDocumentFragment();
    for (let r = 0; r < 9; r++) {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = -1;
        cell.dataset.index = String(i);
        if (c % 3 === 2 && c < 8) cell.classList.add('edge-right');
        if (r % 3 === 2 && r < 8) cell.classList.add('edge-bottom');
        const value = document.createElement('span');
        value.className = 'value';
        const notes = document.createElement('span');
        notes.className = 'notes';
        notes.setAttribute('aria-hidden', 'true');
        for (let d = 1; d <= 9; d++) {
          const n = document.createElement('span');
          n.dataset.digit = String(d);
          notes.append(n);
        }
        cell.append(value, notes);
        row.append(cell);
        this.cells.push(cell);
      }
      frag.append(row);
    }
    this.boardEl.replaceChildren(frag);

    for (let d = 1; d <= 9; d++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pad-btn';
      btn.dataset.digit = String(d);
      btn.innerHTML = `<span class="pad-digit">${d}</span><span class="pad-left" aria-hidden="true"></span>`;
      this.padButtons.push(btn);
      this.numpadEl.append(btn);
    }

    this.boardEl.addEventListener('pointerdown', e => {
      const cell = e.target.closest('.cell');
      if (cell) this.select(Number(cell.dataset.index));
    });
    this.numpadEl.addEventListener('click', e => {
      const btn = e.target.closest('.pad-btn');
      if (btn) this.input(Number(btn.dataset.digit));
    });
  }

  attach(game, settings) {
    this.game = game;
    this.settings = settings;
    this.selected = null;
    this.setNotesMode(false);
    for (const cell of this.cells) cell.classList.remove('pulse-good', 'pulse-bad', 'ripple', 'hinted');
    const firstOpen = game.entries.findIndex((v, i) => !v && !game.isGiven(i));
    this.select(firstOpen >= 0 ? firstOpen : 0, { focus: false });
  }

  setSettings(settings) {
    this.settings = settings;
    this.update();
  }

  setNotesMode(on) {
    this.notesMode = on;
    this.notesButton.setAttribute('aria-pressed', String(on));
    this.numpadEl.classList.toggle('notes-mode', on);
    this.actions.onNotesChange?.(on);
  }

  select(i, { focus = true } = {}) {
    if (!Number.isInteger(i) || i < 0 || i >= CELLS) return;
    this.selected = i;
    for (const cell of this.cells) cell.tabIndex = -1;
    this.cells[i].tabIndex = 0;
    if (focus) this.cells[i].focus({ preventScroll: true });
    this.update();
  }

  /** A digit from the pad or keyboard. */
  input(d) {
    const g = this.game;
    if (!g || this.selected === null || g.solved) return;
    if (this.notesMode) g.toggleNote(this.selected, d);
    else if (g.entries[this.selected] === d) g.erase(this.selected);
    else g.place(this.selected, d);
  }

  erase() {
    if (this.game && this.selected !== null) this.game.erase(this.selected);
  }

  /** Keyboard handling for the game screen. Returns true if handled. */
  handleKey(e) {
    if (!this.game || e.altKey || e.metaKey) return false;
    const key = e.key;
    if (e.ctrlKey) {
      if (key.toLowerCase() === 'z') { this.actions.onUndo(); return true; }
      return false;
    }
    if (ARROWS[key]) {
      const [dr, dc] = ARROWS[key];
      const i = this.selected ?? 0;
      const r = (rowOf(i) + dr + 9) % 9;
      const c = (colOf(i) + dc + 9) % 9;
      this.select(r * 9 + c);
      return true;
    }
    if (/^[1-9]$/.test(key)) { this.input(Number(key)); return true; }
    switch (key) {
      case 'Backspace': case 'Delete': case '0': this.actions.onErase(); return true;
      case 'n': case 'N': this.setNotesMode(!this.notesMode); return true;
      case 'u': case 'U': this.actions.onUndo(); return true;
      case 'h': case 'H': this.actions.onHint(); return true;
      case ' ': this.actions.onPause(); return true;
      case 'Escape': this.actions.onBack(); return true;
      default: return false;
    }
  }

  update() {
    const g = this.game;
    if (!g) return;
    const sel = this.selected;
    const selValue = sel === null ? 0 : g.entries[sel];
    const peers = new Set(sel === null || !this.settings.highlightPeers ? [] : PEERS[sel]);
    const conflicts = this.settings.checkMistakes ? new Set() : g.conflicts();

    for (let i = 0; i < CELLS; i++) {
      const cell = this.cells[i];
      const v = g.entries[i];
      const given = g.isGiven(i);
      const wrong = !given && this.settings.checkMistakes && g.isWrong(i);
      const cl = cell.classList;
      cl.toggle('given', given);
      cl.toggle('filled', !given && v !== 0);
      cl.toggle('selected', i === sel);
      cl.toggle('peer', peers.has(i));
      cl.toggle('same', v !== 0 && v === selValue && i !== sel);
      cl.toggle('wrong', wrong);
      cl.toggle('conflict', !given && conflicts.has(i));

      const valueEl = cell.firstChild;
      const text = v ? String(v) : '';
      if (valueEl.textContent !== text) valueEl.textContent = text;

      const notesEl = cell.lastChild;
      const mask = v ? 0 : g.notes[i];
      if (notesEl.dataset.mask !== String(mask)) {
        notesEl.dataset.mask = String(mask);
        for (const n of notesEl.children) {
          n.textContent = mask & (1 << Number(n.dataset.digit)) ? n.dataset.digit : '';
        }
      }

      let label = `Row ${rowOf(i) + 1}, column ${colOf(i) + 1}, box ${boxOf(i) + 1}: `;
      if (v) label += `${v}${given ? ', given' : ''}${wrong ? ', wrong' : ''}`;
      else if (mask) label += `empty, notes ${[...Array(9)].map((_, k) => k + 1).filter(d => mask & (1 << d)).join(' ')}`;
      else label += 'empty';
      cell.setAttribute('aria-label', label);
      cell.setAttribute('aria-selected', String(i === sel));
    }

    const counts = g.digitCounts();
    for (const btn of this.padButtons) {
      const d = Number(btn.dataset.digit);
      const left = 9 - counts[d];
      btn.lastChild.textContent = left > 0 ? String(left) : '';
      btn.classList.toggle('done', left === 0);
      btn.setAttribute('aria-label', `${this.notesMode ? 'Note' : 'Place'} ${d}${left === 0 ? ', all placed' : `, ${left} left`}`);
    }
  }

  /** Replay a CSS animation class on some cells. */
  flash(indexes, className) {
    for (const i of indexes) {
      const cell = this.cells[i];
      cell.classList.remove(className);
      void cell.offsetWidth; // restart the animation
      cell.classList.add(className);
    }
  }

  /** Ripple a unit outward from the cell that completed it. */
  ripple(cells, origin) {
    const sorted = [...cells].sort((a, b) => distance(a, origin) - distance(b, origin));
    sorted.forEach((i, k) => this.cells[i].style.setProperty('--delay', `${k * 35}ms`));
    this.flash(sorted, 'ripple');
  }
}

function distance(a, b) {
  return Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));
}
