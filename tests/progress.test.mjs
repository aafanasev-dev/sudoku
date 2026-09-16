import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Progress } from '../js/progress.js';
import { createApi, ApiError } from '../js/api.js';

const STATE = {
  levels: [
    { id: 1, name: 'Easy', unlocked: true, requires: null, wins: 0 },
    { id: 2, name: 'Medium', unlocked: false, requires: { levelId: 1, wins: 1, have: 0 }, wins: 0 },
  ],
  totals: { wins: 0, streak: 0, bestStreak: 0, goodMoves: 0, timePlayedMs: 0 },
  settings: { checkMistakes: true, highlightPeers: true, theme: 'system' },
  savedGame: null,
};

const clone = o => structuredClone(o);

/** A scripted fetch: handlers keyed by "METHOD /path" return a Response or throw. */
function fakeServer(routes) {
  const calls = [];
  const fetch = async (path, init) => {
    const key = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, init });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ detail: 'nope' }), { status: 404 });
    return handler(body, calls.length);
  };
  return { fetch, calls, of: key => calls.filter(c => c.key === key) };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

/** Timers you fire by hand. */
function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimeout: t => pending.delete(t),
    pending,
    async runAll() {
      const fns = [...pending.values()].map(p => p.fn);
      pending.clear();
      for (const fn of fns) await fn();
    },
  };
}

function setup(routes) {
  const server = fakeServer({ 'GET /api/progress': () => json(clone(STATE)), ...routes });
  let unauthorized = 0;
  const api = createApi({ fetch: server.fetch, onUnauthorized: () => unauthorized++ });
  const timers = fakeTimers();
  const progress = new Progress({ api, timers });
  const events = [];
  for (const type of ['change', 'offline', 'online', 'rejected']) progress.on(type, e => events.push({ type, ...e }));
  return { server, progress, timers, events, unauthorized: () => unauthorized };
}

const RESULT = { levelId: 1, won: true, timeMs: 61234.4, mistakes: 0, hints: 0, goodMoves: 40 };

test('api: sends JSON with same-origin credentials and reports errors', async () => {
  const server = fakeServer({
    'POST /x': body => json({ echoed: body }),
    'GET /bad': () => json({ detail: 'Level is locked' }, 403),
    'GET /gone': () => noContent(),
  });
  const api = createApi({ fetch: server.fetch });
  assert.deepEqual(await api.post('/x', { a: 1 }), { echoed: { a: 1 } });
  assert.equal(server.calls[0].init.credentials, 'same-origin');
  assert.equal(server.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(await api.get('/gone'), null);
  await assert.rejects(api.get('/bad'), e => e instanceof ApiError && e.status === 403 && e.message === 'Level is locked');

  const offline = createApi({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.get('/x'), e => e.status === 0);
});

test('api: a 401 triggers onUnauthorized', async () => {
  const { progress, unauthorized } = setup({ 'GET /api/progress': () => json({ detail: 'Not signed in' }, 401) });
  await assert.rejects(progress.load(), e => e.status === 401);
  assert.equal(unauthorized(), 1);
});

test('load fills the cache and exposes reads', async () => {
  const { progress, events } = setup({});
  await progress.load();
  assert.equal(progress.isUnlocked(1), true);
  assert.equal(progress.isUnlocked(2), false);
  assert.equal(progress.isUnlocked(9), false);
  assert.equal(progress.level(2).requires.wins, 1);
  assert.equal(progress.settings.theme, 'system');
  assert.equal(events.filter(e => e.type === 'change').length, 1);
});

test('recordResult posts the result and adopts the server state', async () => {
  const unlocked = clone(STATE);
  unlocked.levels[1].unlocked = true;
  const { progress, server } = setup({
    'POST /api/results': () => json({ progress: unlocked, newlyUnlocked: [2], newBest: true, newFlawlessBest: true }),
  });
  await progress.load();
  const outcome = await progress.recordResult(RESULT);
  assert.deepEqual(outcome, { newlyUnlocked: [2], newBest: true, newFlawlessBest: true });
  assert.equal(progress.isUnlocked(2), true);

  const sent = server.of('POST /api/results')[0].body;
  assert.equal(sent.level, 1);
  assert.equal(sent.timeMs, 61234);
  assert.match(sent.id, /^[A-Za-z0-9-]{8,64}$/);
});

test('a result that fails to send is queued, retried with the same id, and the warning clears', async () => {
  let up = false;
  const { progress, server, timers, events } = setup({
    'POST /api/results': () => {
      if (!up) throw new TypeError('Failed to fetch');
      return json({ progress: clone(STATE), newlyUnlocked: [], newBest: false, newFlawlessBest: false });
    },
  });
  await progress.load();

  assert.equal(await progress.recordResult(RESULT), null);
  assert.deepEqual(events.filter(e => e.type === 'offline').length, 1);
  assert.equal(progress.outbox.length, 1);
  assert.equal(timers.pending.size, 1);

  up = true;
  await timers.runAll();
  await progress.chain;
  assert.equal(progress.outbox.length, 0);
  assert.equal(events.filter(e => e.type === 'online').length, 1);
  const ids = server.of('POST /api/results').map(c => c.body.id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test('queued results are sent in order before a new one', async () => {
  let up = false;
  const { progress, server } = setup({
    'POST /api/results': () => {
      if (!up) return json({ detail: 'down' }, 503);
      return json({ progress: clone(STATE), newlyUnlocked: [], newBest: false, newFlawlessBest: false });
    },
  });
  await progress.load();
  await progress.recordResult({ ...RESULT, won: false });
  up = true;
  const outcome = await progress.recordResult(RESULT);
  assert.ok(outcome);
  const sent = server.of('POST /api/results').map(c => c.body.won);
  assert.deepEqual(sent, [false, false, true]);
  assert.equal(progress.outbox.length, 0);
});

test('concurrent results are never posted twice', async () => {
  const { progress, server } = setup({
    'POST /api/results': () => json({ progress: clone(STATE), newlyUnlocked: [], newBest: false, newFlawlessBest: false }),
  });
  await progress.load();
  const [a, b] = await Promise.all([progress.recordResult(RESULT), progress.recordResult(RESULT)]);
  assert.ok(a && b);
  const ids = server.of('POST /api/results').map(c => c.body.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('a result the server rejects is dropped, not retried', async () => {
  const { progress, events, timers } = setup({
    'POST /api/results': () => json({ detail: 'Level is locked' }, 403),
  });
  await progress.load();
  assert.equal(await progress.recordResult({ ...RESULT, levelId: 2 }), null);
  assert.equal(progress.outbox.length, 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(events.find(e => e.type === 'rejected').error.message, 'Level is locked');
});

test('settings update optimistically and survive a failed write', async () => {
  const { progress, server, events } = setup({
    'PUT /api/settings': () => { throw new TypeError('offline'); },
  });
  await progress.load();
  await progress.updateSettings({ theme: 'dark' });
  assert.equal(progress.settings.theme, 'dark');
  assert.equal(progress.settings.checkMistakes, true);
  assert.deepEqual(server.of('PUT /api/settings')[0].body, { checkMistakes: true, highlightPeers: true, theme: 'dark' });
  assert.ok(events.some(e => e.type === 'offline'));
});

test('game saves are debounced, and the latest one wins', async () => {
  const { progress, server, timers } = setup({ 'PUT /api/saved-game': () => noContent() });
  await progress.load();
  progress.saveGame({ levelId: 1, n: 1 });
  progress.saveGame({ levelId: 1, n: 2 });
  assert.equal(server.of('PUT /api/saved-game').length, 0);
  assert.equal(timers.pending.size, 1);
  assert.equal(progress.savedGame.n, 2);
  await timers.runAll();
  const puts = server.of('PUT /api/saved-game');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { state: { levelId: 1, n: 2 } });
  assert.equal(progress.savedGame.n, 2);
});

test('flushGame sends immediately with keepalive; clearGame deletes', async () => {
  const { progress, server } = setup({
    'PUT /api/saved-game': () => noContent(),
    'DELETE /api/saved-game': () => noContent(),
  });
  await progress.load();
  progress.saveGame({ levelId: 1 });
  await progress.flushGame({ keepalive: true });
  assert.equal(server.of('PUT /api/saved-game')[0].init.keepalive, true);

  await progress.flushGame(); // nothing pending: no request
  assert.equal(server.of('PUT /api/saved-game').length, 1);

  await progress.clearGame();
  assert.equal(server.of('DELETE /api/saved-game').length, 1);
  assert.equal(progress.savedGame, null);
});

test('a failed game save is kept for the next attempt', async () => {
  let up = false;
  const { progress, server } = setup({
    'PUT /api/saved-game': () => { if (!up) throw new TypeError('offline'); return noContent(); },
  });
  await progress.load();
  progress.saveGame({ levelId: 1, n: 1 });
  await progress.flushGame();
  assert.equal(progress.savedGame.n, 1);
  up = true;
  await progress.flushGame();
  assert.equal(server.of('PUT /api/saved-game').length, 2);
});

test('reset deletes on the server and reloads', async () => {
  const { progress, server } = setup({ 'DELETE /api/progress': () => noContent() });
  await progress.load();
  progress.saveGame({ levelId: 1 });
  progress.outbox.push({ id: 'stale-result' });
  await progress.reset();
  assert.equal(server.of('DELETE /api/progress').length, 1);
  assert.equal(server.of('GET /api/progress').length, 2);
  assert.equal(progress.outbox.length, 0);
  assert.equal(progress.savedGame, null);
});
