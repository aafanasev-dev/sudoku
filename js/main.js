// Wiring and screen routing.
import { createApi, ApiError } from './api.js';
import { Progress } from './progress.js';
import { Game } from './game.js';
import { LEVELS, getLevel, nextLevel } from './levels.js';
import { getPuzzle, prefetch } from './puzzles.js';
import { BoardView } from './render.js';
import { Praise } from './praise.js';

const $ = id => document.getElementById(id);

const screens = {
  boot: $('screen-boot'),
  signin: $('screen-signin'),
  levels: $('screen-levels'),
  game: $('screen-game'),
};

const api = createApi({ onUnauthorized: () => showSignIn() });
const progress = new Progress({ api });
const praise = new Praise({
  toasts: $('toasts'),
  confetti: $('confetti'),
  banner: $('unlock-banner'),
  bannerText: $('unlock-text'),
  bannerPlay: $('unlock-play'),
  bannerClose: $('unlock-close'),
});

let game = null;
let activeLevelId = null; // the level being played or loaded
let timerHandle = null;
let loadToken = 0;

const board = new BoardView({
  board: $('board'),
  numpad: $('numpad'),
  notesButton: $('notes-btn'),
  actions: {
    onHint: () => hint(),
    onUndo: () => game?.undo(),
    onErase: () => board.erase(),
    onPause: () => togglePause(),
    onBack: () => showLevels(),
  },
});

// ── helpers ──────────────────────────────────────────────────────────
function formatTime(ms) {
  if (ms == null) return '–';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatDuration(ms) {
  const minutes = Math.floor((ms ?? 0) / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  document.body.dataset.screen = name;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ── boot & auth ──────────────────────────────────────────────────────
async function boot() {
  show('boot');
  $('boot-retry').hidden = true;
  $('boot-text').textContent = 'Loading…';

  const params = new URLSearchParams(location.search);
  if (params.has('auth_error')) {
    $('auth-error').hidden = false;
    history.replaceState(null, '', location.pathname);
  }

  try {
    const me = await api.get('/api/me');
    $('user-name').textContent = me.name || me.email;
    $('user-name').title = me.email;
    await progress.load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // sign-in screen already shown
    $('boot-text').textContent = 'Couldn’t reach the server.';
    $('boot-retry').hidden = false;
    return;
  }
  applyTheme(progress.settings.theme);
  showLevels();
  prefetch(1);
}

function showSignIn() {
  stopGame();
  $('win-dialog').open && $('win-dialog').close();
  $('settings-dialog').open && $('settings-dialog').close();
  show('signin');
}

async function signOut() {
  if (game && !game.solved) progress.saveGame(game.toJSON());
  await progress.flushGame();
  try {
    await api.post('/auth/logout');
  } catch { /* the session is gone either way from the user's view */ }
  location.assign('/');
}

// ── level list ───────────────────────────────────────────────────────
function renderLevels() {
  const list = $('level-list');
  list.replaceChildren();
  for (const meta of LEVELS) {
    const lv = progress.level(meta.id);
    const unlocked = Boolean(lv?.unlocked);
    const li = el('li');
    const card = el('button', `level-card level-${meta.key}${unlocked ? '' : ' locked'}`);
    card.type = 'button';
    card.disabled = !unlocked;
    card.dataset.level = String(meta.id);

    const head = el('div', 'level-head');
    head.append(el('span', 'level-num', String(meta.id)), el('span', 'level-name', meta.name));
    head.append(el('span', 'level-clues', `${meta.minClues}–${meta.maxClues} clues`));
    card.append(head);

    if (unlocked) {
      const stats = el('div', 'level-stats');
      stats.append(el('span', null, lv.wins === 1 ? '1 win' : `${lv.wins} wins`));
      if (lv.bestTimeMs != null) stats.append(el('span', null, `Best ${formatTime(lv.bestTimeMs)}`));
      if (lv.bestFlawlessMs != null) stats.append(el('span', 'flawless', `✦ ${formatTime(lv.bestFlawlessMs)}`));
      if (lv.streak > 1) stats.append(el('span', null, `Streak ${lv.streak}`));
      card.append(stats);
    } else if (lv?.requires) {
      const need = lv.requires;
      const below = getLevel(need.levelId).name;
      const lock = el('div', 'level-lock');
      lock.append(el('span', null, `🔒 ${need.have}/${need.wins} ${below} ${need.wins === 1 ? 'win' : 'wins'}`));
      const bar = el('div', 'bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(need.wins));
      bar.setAttribute('aria-valuenow', String(need.have));
      bar.setAttribute('aria-label', `${meta.name} unlock progress`);
      const fill = el('span');
      fill.style.setProperty('--pct', `${(need.have / need.wins) * 100}%`);
      bar.append(fill);
      lock.append(bar);
      card.append(lock);
      card.setAttribute('aria-label', `${meta.name} — locked, ${need.have} of ${need.wins} ${below} wins`);
    }
    li.append(card);
    list.append(li);
  }

  const saved = progress.savedGame;
  $('resume-card').hidden = !saved;
  if (saved) {
    const filled = saved.entries?.filter((v, i) => v && !saved.puzzle[i]).length ?? 0;
    $('resume-detail').textContent = `${getLevel(saved.levelId).name} · ${formatTime(saved.elapsedBefore)} · ${filled} placed`;
  }

  const t = progress.totals;
  $('total-wins').textContent = String(t.wins);
  $('total-streak').textContent = String(t.bestStreak);
  $('total-moves').textContent = String(t.goodMoves);
  $('total-time').textContent = formatDuration(t.timePlayedMs);
}

function showLevels() {
  if (game && !game.solved) {
    game.pause();
    progress.saveGame(game.toJSON());
    progress.flushGame();
  }
  stopTimer();
  renderLevels();
  show('levels');
}

// ── playing ──────────────────────────────────────────────────────────
function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
}

function stopGame() {
  stopTimer();
  game = null;
}

/** Record an unfinished game as abandoned if the player actually played it. */
function abandon(g) {
  if (!g || g.solved) return;
  if (g.goodMoves + g.mistakes + g.hints === 0) return;
  progress.recordResult({
    levelId: g.levelId, won: false, timeMs: g.elapsed(),
    mistakes: g.mistakes, hints: g.hints, goodMoves: g.goodMoves,
  });
}

async function startLevel(levelId, { fromSaved = null } = {}) {
  if (!progress.isUnlocked(levelId)) return;
  const token = ++loadToken;
  activeLevelId = levelId;
  const previous = game;
  stopGame();
  praise.hideBanner();

  $('game-level').textContent = getLevel(levelId).name;
  show('game');
  $('pause-overlay').hidden = true;

  let next;
  if (fromSaved) {
    next = Game.fromJSON(fromSaved);
  } else {
    // A fresh puzzle replaces whatever was saved; an unfinished one counts as abandoned.
    abandon(previous ?? savedAsGame());
    progress.clearGame();
    $('loading-overlay').hidden = false;
    $('loading-text').textContent = `Building a${levelId === 1 ? 'n' : ''} ${getLevel(levelId).name} puzzle…`;
    try {
      const { puzzle, solution } = await getPuzzle(levelId);
      next = new Game({ levelId, puzzle, solution });
    } catch {
      $('loading-text').textContent = 'Couldn’t build a puzzle. Try again.';
      return;
    }
    if (token !== loadToken) return; // the player moved on meanwhile
    $('loading-overlay').hidden = true;
  }

  game = next;
  wireGame(game);
  board.attach(game, progress.settings);
  updateMeta();
  game.start();
  timerHandle = setInterval(updateMeta, 250);
  prefetch(levelId);
}

function savedAsGame() {
  const saved = progress.savedGame;
  if (!saved) return null;
  try { return Game.fromJSON(saved); } catch { return null; }
}

function wireGame(g) {
  const live = handler => detail => { if (g === game) handler(detail); };

  g.on('change', live(() => {
    board.update();
    updateMeta();
    if (!g.solved) progress.saveGame(g.toJSON());
  }));
  g.on('place', live(({ index, correct, hint }) => {
    if (hint) board.flash([index], 'hinted');
    else if (correct) { board.flash([index], 'pulse-good'); praise.goodMove(); }
    else if (progress.settings.checkMistakes) board.flash([index], 'pulse-bad');
  }));
  g.on('unit-complete', live(({ unit }) => {
    board.ripple(unit.cells, board.selected ?? unit.cells[0]);
    praise.unitComplete(unit);
  }));
  g.on('digit-complete', live(({ digit }) => praise.digitComplete(digit)));
  g.on('streak', live(({ count }) => praise.streak(count)));
  g.on('full-with-errors', live(() => {
    praise.toast('The board is full, but something’s not right yet.', { kind: 'warn' });
  }));
  g.on('solved', live(result => onSolved(g, result)));
}

function updateMeta() {
  if (!game) return;
  $('timer').textContent = formatTime(game.elapsed());
  $('mistake-count').textContent = String(game.mistakes);
  $('mistakes').hidden = !progress.settings.checkMistakes;
  $('pause-btn').setAttribute('aria-label', game.running ? 'Pause' : 'Resume');
  $('pause-btn').textContent = game.running || game.solved ? '⏸' : '▶';
}

function togglePause() {
  if (!game || game.solved) return;
  if (game.running) {
    game.pause();
    $('pause-overlay').hidden = false;
    progress.saveGame(game.toJSON());
  } else {
    $('pause-overlay').hidden = true;
    game.start();
  }
  updateMeta();
}

function hint() {
  if (!game || game.solved) return;
  const i = game.hint(board.selected);
  if (i !== null) board.select(i);
}

async function onSolved(g, result) {
  stopTimer();
  updateMeta();
  praise.confetti();
  progress.clearGame();

  const level = getLevel(g.levelId);
  $('win-title').textContent = result.flawless ? 'Flawless!' : 'Solved!';
  $('win-sub').textContent = `${level.name} puzzle complete.`;
  $('win-time').textContent = formatTime(result.timeMs);
  $('win-mistakes').textContent = String(result.mistakes);
  $('win-hints').textContent = String(result.hints);
  const badges = $('win-badges');
  badges.replaceChildren();
  if (result.flawless) badges.append(el('span', 'badge badge-flawless', '✦ Flawless'));
  $('win-next').hidden = true;
  $('win-dialog').showModal();

  const outcome = await progress.recordResult({
    levelId: g.levelId, won: true, timeMs: result.timeMs,
    mistakes: result.mistakes, hints: result.hints, goodMoves: result.goodMoves,
  });
  if (g !== game) return;

  if (!outcome) {
    badges.append(el('span', 'badge badge-muted', 'Will be saved when the server is back'));
    return;
  }
  const stats = progress.level(g.levelId);
  if (outcome.newFlawlessBest) badges.append(el('span', 'badge badge-best', 'New flawless best'));
  else if (outcome.newBest) badges.append(el('span', 'badge badge-best', 'New best time'));
  if (stats?.streak > 1) badges.append(el('span', 'badge', `${stats.streak} wins in a row`));
  if (stats?.wins === 1) badges.append(el('span', 'badge', `First ${level.name} win`));

  const next = nextLevel(g.levelId);
  $('win-next').hidden = !(next && progress.isUnlocked(next.id));
  if (next) $('win-next').textContent = `Next: ${next.name}`;

  for (const id of outcome.newlyUnlocked ?? []) {
    badges.prepend(el('span', 'badge badge-unlock', `🔓 ${getLevel(id).name} unlocked`));
    pendingUnlock = id;
    prefetch(id);
  }
}

// The banner can't sit above a modal dialog, so an unlock waits for the
// dialog to close and is skipped if the player went straight into that level.
let pendingUnlock = null;
$('win-dialog').addEventListener('close', () => {
  const id = pendingUnlock;
  pendingUnlock = null;
  if (id === null || activeLevelId === id) return;
  praise.banner(`🔓 ${getLevel(id).name} unlocked`, () => startLevel(id));
});

// ── events ───────────────────────────────────────────────────────────
$('boot-retry').addEventListener('click', boot);
$('signout-btn').addEventListener('click', signOut);

$('level-list').addEventListener('click', e => {
  const card = e.target.closest('.level-card');
  if (!card || card.disabled) return;
  const levelId = Number(card.dataset.level);
  const saved = progress.savedGame;
  if (saved && saved.levelId === levelId) startLevel(levelId, { fromSaved: saved });
  else startLevel(levelId);
});

$('resume-btn').addEventListener('click', () => {
  const saved = progress.savedGame;
  if (saved) startLevel(saved.levelId, { fromSaved: saved });
});
$('discard-btn').addEventListener('click', () => {
  abandon(savedAsGame());
  progress.clearGame();
  renderLevels();
});

$('back-btn').addEventListener('click', showLevels);
$('pause-btn').addEventListener('click', togglePause);
$('resume-game-btn').addEventListener('click', togglePause);
$('undo-btn').addEventListener('click', () => game?.undo());
$('erase-btn').addEventListener('click', () => board.erase());
$('notes-btn').addEventListener('click', () => board.setNotesMode(!board.notesMode));
$('hint-btn').addEventListener('click', hint);
$('new-btn').addEventListener('click', () => game && startLevel(game.levelId));

$('win-again').addEventListener('click', () => {
  $('win-dialog').close();
  if (game) startLevel(game.levelId);
});
$('win-next').addEventListener('click', () => {
  $('win-dialog').close();
  const next = game && nextLevel(game.levelId);
  if (next) startLevel(next.id);
});
$('win-levels').addEventListener('click', () => {
  $('win-dialog').close();
  showLevels();
});

// Settings
const settingsDialog = $('settings-dialog');
$('open-settings').addEventListener('click', () => {
  const s = progress.settings;
  $('set-check-mistakes').checked = s.checkMistakes;
  $('set-highlight').checked = s.highlightPeers;
  $('set-theme').value = s.theme;
  resetConfirm(false);
  settingsDialog.showModal();
});
$('set-check-mistakes').addEventListener('change', e => progress.updateSettings({ checkMistakes: e.target.checked }));
$('set-highlight').addEventListener('change', e => progress.updateSettings({ highlightPeers: e.target.checked }));
$('set-theme').addEventListener('change', e => {
  applyTheme(e.target.value);
  progress.updateSettings({ theme: e.target.value });
});
$('settings-close').addEventListener('click', () => settingsDialog.close());

// Reset needs a second tap within a few seconds.
let resetArmed = null;
function resetConfirm(armed) {
  clearTimeout(resetArmed);
  resetArmed = null;
  $('reset-btn').textContent = armed ? 'Tap again to erase everything' : 'Reset all progress';
  $('reset-btn').classList.toggle('armed', armed);
  if (armed) resetArmed = setTimeout(() => resetConfirm(false), 4000);
}
$('reset-btn').addEventListener('click', async () => {
  if (!resetArmed) { resetConfirm(true); return; }
  resetConfirm(false);
  try {
    await progress.reset();
    game = null;
    settingsDialog.close();
    renderLevels();
    praise.toast('Progress reset.');
  } catch {
    praise.toast('Couldn’t reset — the server is unreachable.', { kind: 'warn' });
  }
});

progress.on('change', () => {
  board.setSettings(progress.settings);
  updateMeta();
  if (!screens.levels.hidden) renderLevels();
});
progress.on('offline', () => { $('sync-warning').hidden = false; });
progress.on('online', () => { $('sync-warning').hidden = true; });
progress.on('rejected', ({ error }) => praise.toast(`A result wasn’t saved: ${error.message}`, { kind: 'warn' }));

document.addEventListener('keydown', e => {
  if (screens.game.hidden || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, select, textarea')) return;
  if (!$('pause-overlay').hidden && e.key !== ' ' && e.key !== 'Escape') return;
  if (board.handleKey(e)) e.preventDefault();
});

// Pause when the tab is hidden, and make sure the latest state gets saved.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (game && game.running) {
    game.pause();
    $('pause-overlay').hidden = false;
    updateMeta();
  }
  if (game && !game.solved) progress.saveGame(game.toJSON());
  progress.flushGame({ keepalive: true });
});
addEventListener('pagehide', () => progress.flushGame({ keepalive: true }));

boot();
