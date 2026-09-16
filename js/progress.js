// The only module that holds player progress. The server is the source of
// truth (and owns the unlock rule); this keeps an in-memory copy for the UI,
// writes through the API, and retries results that failed to send.
import { Emitter } from './game.js';
import { randomId } from './api.js';

const SAVE_DELAY_MS = 2000;
const RETRY_MS = 30000;

const DEFAULT_SETTINGS = Object.freeze({ checkMistakes: true, highlightPeers: true, theme: 'system' });

export class Progress extends Emitter {
  /**
   * @param {object} o
   * @param {ReturnType<import('./api.js').createApi>} o.api
   * @param {object} [o.timers]  { setTimeout, clearTimeout } for tests
   */
  constructor({ api, timers = globalThis }) {
    super();
    this.api = api;
    this.timers = timers;
    this.state = null;
    this.outbox = [];          // results not yet accepted by the server
    this.outcomes = new Map(); // result id -> server response, until the caller reads it
    this.chain = Promise.resolve();
    this.saveTimer = null;
    this.retryTimer = null;
    this.pendingGame = undefined;
    this.offline = false;
  }

  async load() {
    this.#accept(await this.api.get('/api/progress'));
    return this.state;
  }

  // ── reads ──────────────────────────────────────────────────────────
  level(id) { return this.state?.levels.find(l => l.id === id) ?? null; }
  isUnlocked(id) { return Boolean(this.level(id)?.unlocked); }
  get settings() { return { ...DEFAULT_SETTINGS, ...this.state?.settings }; }
  get totals() { return this.state?.totals ?? { wins: 0, bestStreak: 0, goodMoves: 0, timePlayedMs: 0 }; }
  get savedGame() { return this.pendingGame !== undefined ? this.pendingGame : this.state?.savedGame ?? null; }

  // ── writes ─────────────────────────────────────────────────────────
  /**
   * Report a finished (won) or abandoned (won: false) puzzle.
   * Resolves to { newlyUnlocked: number[], newBest, newFlawlessBest } or
   * null if the server could not be reached (the result is queued).
   */
  async recordResult({ levelId, won, timeMs, mistakes, hints, goodMoves }) {
    const id = randomId();
    this.outbox.push({
      id,
      level: levelId,
      won: Boolean(won),
      timeMs: Math.max(0, Math.round(timeMs)),
      mistakes, hints, goodMoves,
    });
    await this.#flush();
    const outcome = this.outcomes.get(id) ?? null;
    this.outcomes.delete(id);
    return outcome;
  }

  /** Sends run one at a time so a result is never posted twice concurrently. */
  #flush() {
    this.chain = this.chain.then(() => this.#drainOutbox());
    return this.chain;
  }

  async #drainOutbox() {
    while (this.outbox.length) {
      const result = this.outbox[0];
      try {
        const res = await this.api.post('/api/results', result);
        this.outbox.shift();
        this.#accept(res.progress);
        this.outcomes.set(result.id, { newlyUnlocked: res.newlyUnlocked, newBest: res.newBest, newFlawlessBest: res.newFlawlessBest });
      } catch (err) {
        if (err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status)) {
          // The server rejected it for good; retrying won't help.
          this.outbox.shift();
          this.emit('rejected', { error: err });
          continue;
        }
        this.#failed(err);
        this.#scheduleRetry();
        return;
      }
    }
  }

  #scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.#flush();
    }, RETRY_MS);
  }

  async updateSettings(patch) {
    const next = { ...this.settings, ...patch };
    this.state = { ...this.state, settings: next };
    this.emit('change');
    try {
      const saved = await this.api.put('/api/settings', next);
      this.state = { ...this.state, settings: saved };
      this.#ok();
    } catch (err) {
      this.#failed(err);
    }
  }

  /** Remember the game in progress; the write is debounced. */
  saveGame(game) {
    this.pendingGame = game;
    if (this.saveTimer) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = this.timers.setTimeout(() => this.flushGame(), SAVE_DELAY_MS);
  }

  /** Clear the game in progress (after a win or discard). */
  clearGame() {
    this.saveGame(null);
    return this.flushGame();
  }

  /** Send any pending game save now. `keepalive` lets it outlive the page. */
  async flushGame({ keepalive = false } = {}) {
    if (this.saveTimer) { this.timers.clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.pendingGame === undefined) return;
    const game = this.pendingGame;
    this.pendingGame = undefined;
    this.state = { ...this.state, savedGame: game };
    try {
      if (game === null) await this.api.del('/api/saved-game', { keepalive });
      else await this.api.put('/api/saved-game', { state: game }, { keepalive });
      this.#ok();
    } catch (err) {
      if (this.pendingGame === undefined) this.pendingGame = game;
      this.#failed(err);
    }
  }

  async reset() {
    if (this.saveTimer) { this.timers.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.pendingGame = undefined;
    this.outbox = [];
    await this.api.del('/api/progress');
    await this.load();
  }

  // ── internals ──────────────────────────────────────────────────────
  #accept(state) {
    this.state = state;
    this.#ok();
    this.emit('change');
  }

  #ok() {
    if (this.offline) {
      this.offline = false;
      this.emit('online');
    }
  }

  #failed(err) {
    if (err?.status === 401) return; // handled by the api's onUnauthorized
    if (!this.offline) {
      this.offline = true;
      this.emit('offline', { error: err });
    }
  }
}
