# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A five-level browser Sudoku with Fibonacci-gated unlocks, Google sign-in, and progress stored server-side in SQLite.

- **Frontend:** plain ES modules and CSS with no build step and no npm dependencies, served by nginx.
- **Backend:** FastAPI (Python) in a second container.

`README.md` is the product spec (levels, keyboard shortcuts, praise rules, API table). `auth_config.md` covers setting up Google OAuth and `.env`.

## Commands

```bash
npm test                                           # frontend tests (node --test tests/*.test.mjs)
node --test tests/game.test.mjs                    # one suite
node --test --test-name-pattern="undo" tests/*.test.mjs

npm run setup:backend                              # once: backend/.venv with requirements-dev.txt
npm run test:backend                               # pytest (runs from backend/, pytest.ini sets pythonpath)
cd backend && .venv/bin/pytest tests/test_progress.py -k ladder

docker compose up --build                          # full stack on http://localhost:8080 (needs .env)
./run.sh                                           # same, with debug sign-in (DEBUG_AUTH_EMAIL), no Google client needed
docker compose up -d --build web                   # rebuild after frontend changes (files are baked into the image)
docker compose logs backend
```

There's no dev server without Docker: nginx supplies the `/api` and `/auth` proxy and the page expects same-origin.

## Architecture

**Request path:**
- The browser talks only to nginx (`web`), which serves static files and proxies `/api/`, `/auth/` and `/healthz` to `backend:8000`.
- The backend port isn't published, and there's no CORS.
- The SQLite DB lives in the `sudoku-data` named volume at `/data/sudoku.db`.

**The server owns the unlock rule** (`backend/app/levels.py`, thresholds 1/2/3/5 wins on the level directly below):
- `js/levels.js` deliberately has only names and clue ranges.
- The client POSTs results to `/api/results` and renders the `unlocked`/`requires` fields from `/api/progress`.
- Don't reintroduce thresholds on the client.

**Frontend layering:**
- **DOM-free modules:** `sudoku.js`, `levels.js`, `game.js` and `progress.js`. `sudoku.js` also runs inside `generator.worker.js`.
- **Events, not calls:** `game.js` emits events (`place`, `unit-complete`, `digit-complete`, `streak`, `solved`, `change`, …) via its `Emitter`. `main.js` subscribes and drives `render.js` (board and input) and `praise.js` (toasts, confetti, banner).
- **`progress.js`** is the only persistence layer. It is an in-memory cache over `api.js`:
  - **Results:** go through an ordered outbox with client-generated ids. The server dedupes them in the `results` table. Failed sends retry every 30 s. Permanent 4xx errors are dropped and emit `rejected`.
  - **Saved game:** saves are debounced by 2 s. `flushGame({keepalive:true})` runs on `visibilitychange`/`pagehide`.
  - **Tests:** `api` and `timers` are injected so the tests can script `fetch` and fire timers manually.
- **401 handling:** any 401 goes through `createApi({onUnauthorized})`, which shows the sign-in screen.
- **Element IDs:** `index.html` holds every screen (`#screen-boot`, `#screen-signin`, `#screen-levels`, `#screen-game`) and dialog. `main.js` looks elements up by ID, so rename in both places.

**Backend (`backend/app/`):**
- **`main.py`:**
  - `create_app(settings)` is the factory. Tests pass their own `Settings`; production uses `app_factory` → `Settings.from_env()`, which fails fast on missing env vars.
  - Its middleware rejects any non-GET request whose `Origin` isn't `PUBLIC_BASE_URL` (the CSRF guard). Tests set that header by default.
- **`auth.py`:**
  - Authlib Google OIDC client on `app.state.oauth`. Tests replace `app.state.oauth.google.authorize_access_token` to fake sign-in (see the `sign_in` fixture).
  - The session is Starlette's signed cookie `sudoku_session`, holding only `user_id`.
  - **Debug auth:** with `DEBUG_AUTH_EMAIL` set, `app.state.oauth` is `None`, `current_user` and `/auth/login` sign that user in without Google (`sign_in_debug_user`), and `/api/me` returns `debugAuth: true` so `main.js` shows a badge and hides Sign out. `Settings.from_env` refuses it unless `PUBLIC_BASE_URL` is localhost.
- **`db.py`:**
  - A stdlib `sqlite3` connection per request (`check_same_thread=False`), in autocommit mode. Writes go through `with transaction(db):` (`BEGIN IMMEDIATE`).
  - Schema changes are appended to `MIGRATIONS`, tracked with `PRAGMA user_version`. Never edit an existing entry.
- **`progress.py`:**
  - Pydantic models with camelCase aliases and `extra="forbid"`.
  - Stats are computed server-side from results. A `won: false` result means "abandoned" and resets streaks.

## Constraints

- **Strict CSP in `nginx.conf`:**
  - No external scripts, styles or fonts, and no inline `<script>`/`<style>` or `style="…"` attributes.
  - Setting CSS custom properties through `el.style.setProperty` is fine.
  - The only allowed image hosts are `data:` and Google profile pictures.
- **No hashed filenames:** assets are served `no-cache` with ETag revalidation. Keep it that way unless you add hashed filenames.
- **New top-level asset directories:** the web `Dockerfile` copies only `index.html`, `css/` and `js/`, so add any new directory there. The root `.dockerignore` excludes `backend/`, `tests/` and `*.md`.
- **Dependency pins:** Authlib uses `httpx2` (runtime dependency). Plain `httpx` is only in `requirements-dev.txt`, for Starlette's TestClient.
- **Secrets:** `.env` holds real secrets and is gitignored. `.env.example` is the template.
- **Env injection:** the app is deployed by freeholdy, which injects each container's env through `env_file:` entries in its generated `docker-compose.override.yml`. So `env_file: .env` is optional (`required: false`), and don't add `environment: X: ${X:-}` for app settings: `environment` beats `env_file` and would blank the injected values. Local-only overrides go in `docker-compose.local.yml` (used by `run.sh`).
