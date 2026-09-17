# Sudoku — Five Levels

A Sudoku game with five difficulty levels. Each one is locked until you have
earned your way in, and the game makes a point of noticing when you play well.

Players sign in with Google, and their progress lives on the server in SQLite,
so it follows them between devices. The frontend has no build step and no
dependencies: plain ES modules and CSS served by nginx. A small FastAPI
backend handles sign-in and storage.

---

## The Fibonacci ladder

Level 1 is open from the start. Every level after it needs a number of wins on
the level immediately before it, and those numbers walk the Fibonacci sequence:

| # | Level | Clues | To unlock |
|---|-------|-------|-----------|
| 1 | Easy | 44–50 | — open from the start |
| 2 | Medium | 36–42 | **1** win on Easy |
| 3 | Hard | 32–35 | **2** wins on Medium |
| 4 | Expert | 28–31 | **3** wins on Hard |
| 5 | Evil | 24–27 | **5** wins on Expert |

Eleven wins opens everything. Wins only count on the level directly below, so
grinding Easy will never unlock Hard — and wins are never spent, so an unlock
is permanent. Locked cards show live progress (`Hard — 1/2 Medium wins`).

## Playing

- **Mouse / touch** — tap a cell, then tap a digit on the pad.
- **Keyboard** — arrow keys to move, `1`–`9` to place, `Backspace` to clear,
  `N` for notes, `U` to undo, `H` for a hint, `Space` to pause, `Esc` for the
  level list.
- **Notes** are pencil marks; placing a digit automatically clears it from the
  notes of every cell that can no longer hold it.
- **Mistake checking** (on by default) flags a wrong digit as soon as it lands.
  Turn it off in settings for a harder game where only conflicts between digits
  you have actually entered are shown.
- A win with **no mistakes and no hints** is *flawless* and gets its own best
  time and streak.

Progress is saved to your account: wins, unlocks, best times, streaks,
settings and the one unfinished puzzle (saved a couple of seconds after each
move, and again when you leave the tab). The server decides what is unlocked.
If it can't be reached, the game keeps playing, shows a banner, and retries
finished results until they get through. Results carry an id, so a retry is
never counted twice.

## Praise

| When | What happens |
|---|---|
| A correct digit | The cell pulses green; an occasional, rate-limited toast |
| A finished row / column / box | The unit ripples and is called out |
| The ninth copy of a digit | `All the 7s are home.` |
| Five correct in a row | `5 in a row — on fire.` |
| A solved puzzle | Confetti, and a summary with time, mistakes, hints and badges |
| A new level | `🔓 Evil unlocked` with a button straight into it |

Praise on all 81 moves would stop being praise, so per-move toasts are
throttled while the big moments always land. Everything respects
`prefers-reduced-motion`: the text stays, the motion goes.

---

## Running it

Sign-in needs a Google OAuth client first. **[auth_config.md](auth_config.md)**
walks through creating one and filling in `.env`.

```bash
cp .env.example .env     # then fill it in, see auth_config.md
docker compose up --build
# → http://localhost:8080
```

To try it without a Google client, run `./run.sh`. It sets `DEBUG_AUTH_EMAIL`,
which skips Google and signs every visitor in as that address (local URLs only,
see [auth_config.md](auth_config.md#debug-sign-in)).

Compose runs two containers and one volume:

| Service | What it is |
|---|---|
| `web` | `nginx:alpine` with the static files. Proxies `/api/`, `/auth/` and `/healthz` to the backend. The only published port (`WEB_PORT`, default 8080). |
| `backend` | FastAPI + uvicorn on Python 3.12, running as a non-root user. Not published. |
| `sudoku-data` | Named volume mounted at `/data`, holding `sudoku.db` (SQLite, WAL mode). It survives `docker compose down`; `down -v` deletes it. |

Both containers have health checks. `web` waits until `backend` is healthy, and
`/healthz` on the web port checks nginx, the backend and the database together.

Because the browser only ever talks to nginx, the API is same-origin: there's
no CORS, and the session is a plain first-party cookie.

## Tests

```bash
npm test                 # frontend: node --test tests/*.test.mjs
npm run setup:backend    # once: creates backend/.venv
npm run test:backend     # backend: pytest
```

- **Frontend tests** use Node's built-in runner and need no dependencies:
  - The engine: every generated puzzle has exactly one solution and lands in its level's clue range.
  - The game model: notes, undo, streaks, hints, the timer, and saved-game round trips.
  - `progress.js` against a scripted `fetch`: retries, ordering, debounced saves, and 401 handling.
- **Backend tests** use FastAPI's TestClient against a temporary database, with
  Google's side of the sign-in faked. They cover:
  - sessions and the CSRF origin check
  - the whole unlock ladder, and rejection of results for locked levels
  - idempotent retries, best times and streaks
  - settings, saved-game limits, and reset

## API

Every `/api` route needs a session. Non-GET requests must carry an `Origin`
header equal to `PUBLIC_BASE_URL`.

| Route | |
|---|---|
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Google sign-in, see [auth_config.md](auth_config.md) |
| `GET /api/me` | The signed-in user, or 401 |
| `GET /api/progress` | Per-level stats with `unlocked` and `requires`, plus totals, settings and the saved game |
| `POST /api/results` | `{id, level, won, timeMs, mistakes, hints, goodMoves}` for a finished (`won: true`) or abandoned (`won: false`) puzzle. Returns the new progress plus `newlyUnlocked`, `newBest` and `newFlawlessBest` |
| `PUT /api/settings` | `{checkMistakes, highlightPeers, theme}` |
| `PUT /api/saved-game`, `DELETE /api/saved-game` | The unfinished puzzle (max 64 KB) |
| `DELETE /api/progress` | Reset: clears stats, results and the saved game, but keeps settings |

## Layout

```
index.html                 markup for all screens and dialogs
css/styles.css             tokens, board, responsive, light/dark
js/levels.js               level names and clue ranges
js/sudoku.js               engine: generate, solve, validate. Pure, no DOM.
js/generator.worker.js     runs generation off the main thread
js/puzzles.js              worker pool, prefetching, inline fallback
js/api.js                  same-origin JSON client, 401 → sign-in screen
js/progress.js             the only module that holds progress (server-backed cache)
js/game.js                 one puzzle: entries, notes, undo, timer, events
js/render.js               board DOM and input handling
js/praise.js               toasts, pulses, confetti, banners
js/main.js                 boot, auth, wiring and screen routing
tests/                     node:test suites
nginx.conf, Dockerfile     web container
backend/app/levels.py      the unlock rule (single source of truth)
backend/app/auth.py        Google OIDC, session, current user
backend/app/progress.py    progress API and stats logic
backend/app/db.py          SQLite connection and schema migrations
backend/tests/             pytest suites
docker-compose.yml         web + backend + sudoku-data volume
```

Three rules keep this navigable:

- `sudoku.js`, `levels.js`, `progress.js` and `game.js` never touch the DOM.
- `game.js` communicates by emitting events rather than calling the UI.

  Together, these first two rules make the engine testable in Node and let
  the same file run inside a Web Worker.
- The server owns the unlock rule. The client reports results and renders
  what the server says is unlocked, so the rule exists in exactly one place.

### Why a Web Worker

Carving an Evil puzzle runs the uniqueness check hundreds of times. On the main
thread that blocks exactly when the UI needs to paint a spinner, so generation
runs in a worker, and the next puzzle for the current level is prepared in the
background while you play. If workers are unavailable the game falls back to
generating inline.

### Security

- **Content-Security-Policy:** the page loads nothing from other origins apart
  from Google profile pictures, and has no inline scripts or styles, so
  `nginx.conf` sets a strict policy (`default-src 'none'`).
- **Caching:** asset filenames aren't content-hashed, so assets are served with
  `Cache-Control: no-cache` and revalidated by ETag. API responses are `no-store`.
- **Session cookie:** signed, and `HttpOnly` and `SameSite=Lax`. Every
  state-changing request must also come from `PUBLIC_BASE_URL`.
- **Result validation:** results are range-checked, results for locked levels
  are refused, and wins faster than a second are rejected.
