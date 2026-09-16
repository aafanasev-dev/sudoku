# Configuring Google sign-in

The game requires a Google account. The backend runs the OAuth 2.0 / OpenID
Connect *authorization-code* flow itself, so you need a **Web application**
OAuth client from Google Cloud. It takes about five minutes.

```
browser ──▶ /auth/login ──▶ accounts.google.com ──▶ /auth/callback ──▶ /
                (backend)        (user consents)       (backend: exchanges the
                                                         code, creates the user,
                                                         sets the session cookie)
```

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in.
2. Use the project picker at the top: **New project**. Name it (e.g. `sudoku`)
   and **Create**. Make sure it is the selected project afterwards.

## 2. Set up the consent screen

In the console, open **APIs & Services → OAuth consent screen**. Newer consoles
call this **Google Auth Platform**.

1. **Get started / Branding**
   - Set **App name** (shown to players on Google's consent page) and **User support email**.
   - Optionally add a logo and your home page and privacy policy links. You'll need the links before publishing.
2. **Audience**
   - Choose **External** so any Google account can sign in. Pick *Internal*
     only if this is for a Google Workspace organisation.
   - While the app is in **Testing** status, only the accounts listed under
     **Test users** can sign in (up to 100). Add your own address and any testers.
3. **Data access / Scopes**
   - The app asks for `openid`, `email` and `profile` only. These are
     non-sensitive scopes, so Google doesn't need to verify the app for them.
   - Adding them here is optional; the app requests them at sign-in anyway.
4. **Contact information**: enter your email, accept the policy, and **Create**.

When you're ready for everyone to sign in, go to **Audience** and click
**Publish app**. With only these basic scopes, publishing doesn't need Google's
review.

## 3. Create the OAuth client

Open **APIs & Services → Credentials → Create credentials → OAuth client ID**
(or **Google Auth Platform → Clients → Create client**).

- **Application type:** Web application
- **Name:** anything, e.g. `sudoku-web`
- **Authorized JavaScript origins:** the URL players open, e.g.
  - `http://localhost:8080` (local)
  - `https://sudoku.example.com` (production)
- **Authorized redirect URIs:** the same origin plus `/auth/callback`, e.g.
  - `http://localhost:8080/auth/callback`
  - `https://sudoku.example.com/auth/callback`

These must match exactly: scheme, host, port, and no trailing slash. Click
**Create**, then copy the **Client ID** and **Client secret**. Newer consoles
show the secret only once, so store it now.

> Google accepts plain `http://` only for `localhost`. Any other host has to
> be HTTPS.

## 4. Configure the app

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID from step 3 (ends in `.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | Client secret from step 3 |
| `SESSION_SECRET` | A random string of at least 32 characters. Generate one with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `PUBLIC_BASE_URL` | The origin players use, with no trailing slash: `http://localhost:8080` locally, `https://sudoku.example.com` in production |
| `COOKIE_SECURE` | `1` when served over HTTPS (the session cookie is then sent only over HTTPS); `0` for local http |
| `WEB_PORT` | Host port for the web container (default `8080`) |

Notes on these values:

- **Redirect URI:** the backend builds it as `PUBLIC_BASE_URL + /auth/callback`,
  so `PUBLIC_BASE_URL` must match one of the redirect URIs you registered.
- **CSRF check:** `PUBLIC_BASE_URL` also serves as a CSRF guard. Any write
  request whose `Origin` header differs from it is rejected.
- **`SESSION_SECRET`:** changing it signs everyone out.
- **Secrets:** `.env` is in `.gitignore`. Never commit it.

Start the stack:

```bash
docker compose up --build
```

Open `PUBLIC_BASE_URL` and click **Sign in with Google**.

The backend refuses to start if `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or
`SESSION_SECRET` is missing. Check `docker compose logs backend`.

## 5. Production checklist

- Put the web container behind a TLS-terminating proxy or load balancer, and
  set `PUBLIC_BASE_URL=https://…` and `COOKIE_SECURE=1`.
- The proxy must pass the original `Host` header through. nginx inside the
  web container forwards it (with `X-Forwarded-*`) to the backend.
- Register the production origin and redirect URI on the same OAuth client,
  or create a separate client per environment.
- Publish the consent screen (step 2), or only test users can sign in.
- Back up the `sudoku-data` volume. It holds the SQLite database
  (`/data/sudoku.db`, WAL mode). For a consistent copy:
  ```bash
  docker compose exec backend python -c "import sqlite3; s=sqlite3.connect('/data/sudoku.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)"
  docker compose cp backend:/data/backup.db ./sudoku-backup.db
  ```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Google shows **Error 400: redirect_uri_mismatch** | The redirect URI the app sent isn't registered. The error details show the URI; add it exactly under *Authorized redirect URIs*, or fix `PUBLIC_BASE_URL`. Changes can take a few minutes to apply. |
| **Error 401: invalid_client** | The client ID or secret is wrong, or has extra whitespace or quotes in `.env`. |
| **Access blocked: … has not completed the Google verification process** | The app is in *Testing* and this account isn't a test user. Add it under *Audience → Test users*, or publish the app. |
| Back on the game with "Sign-in didn't complete" | The callback failed. Usually the state cookie was lost: the page was opened on a different host than `PUBLIC_BASE_URL` (e.g. `127.0.0.1` vs `localhost`), or `COOKIE_SECURE=1` over plain http. `docker compose logs backend` shows the OAuth error. |
| Signed in, but every action shows "Can't reach the server" or gets a 403 | The browser's origin doesn't match `PUBLIC_BASE_URL`, so the CSRF check rejects writes. Open the site at exactly that URL. |
| Signed out after every page load | `COOKIE_SECURE=1` while serving over http, or `SESSION_SECRET` changes between restarts. |
| `backend` container keeps restarting | A required variable is missing; see `docker compose logs backend`. |

## How it works (for maintainers)

- `backend/app/auth.py` registers Google with Authlib using the discovery
  document (`https://accounts.google.com/.well-known/openid-configuration`).
  Authlib verifies the ID token's signature, issuer, audience and nonce.
- Users are keyed by Google's stable `sub` claim. Email, name and picture are
  refreshed on each sign-in.
- **Session:** a signed cookie (`sudoku_session`) holding only the user id.
  - It is `HttpOnly` and `SameSite=Lax`, and also `Secure` when `COOKIE_SECURE=1`.
  - It expires after 30 days.
  - Signing in again rotates it.
- **Endpoints:**
  - `GET /auth/login`: starts the sign-in.
  - `GET /auth/callback`: Google redirects back here.
  - `POST /auth/logout`: ends the session.
  - `GET /api/me`: returns the current user, or 401.
