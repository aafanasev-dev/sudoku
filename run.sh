#!/usr/bin/env bash
# Start the full stack locally with debug sign-in (no Google account needed).
# Extra arguments go to `docker compose up`, e.g. ./run.sh -d
set -euo pipefail
cd "$(dirname "$0")"

export DEBUG_AUTH_EMAIL="${DEBUG_AUTH_EMAIL:-claudiusvibekodic@gmail.com}"

# Compose reads SESSION_SECRET from the shell or .env; make one up if neither has it.
if [[ -z "${SESSION_SECRET:-}" ]] && ! grep -Eq '^SESSION_SECRET=.+' .env 2>/dev/null; then
  SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  export SESSION_SECRET
fi

# Same precedence as compose's interpolation: shell first, then .env.
port="${WEB_PORT:-$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | tail -n1)}"
url="http://localhost:${port:-8080}"

print_link() {
  local link="$url"
  # OSC 8 makes the URL clickable in terminals that support it.
  [[ -t 1 ]] && link=$'\e]8;;'"$url"$'\e\\'"$url"$'\e]8;;\e\\'
  printf '\n  ➜  Sudoku is ready: %s  (signed in as %s)\n\n' "$link" "$DEBUG_AUTH_EMAIL"
}

# The compose build output buries anything printed up front, so announce the
# link once /healthz (nginx → backend → database) answers. Gives up after 3 min.
wait_for_site() {
  for _ in $(seq 180); do
    if curl -fsS -o /dev/null "$url/healthz" 2>/dev/null; then
      print_link
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_site &
waiter=$!
trap 'kill "$waiter" 2>/dev/null || true' EXIT

status=0
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build "$@" || status=$?

# With -d, `up` returns before the site is healthy: let the waiter finish.
if [[ $status -eq 0 ]]; then
  wait "$waiter" || true
fi
exit "$status"
