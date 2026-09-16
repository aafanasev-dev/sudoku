import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

# Each entry moves the schema one version forward (PRAGMA user_version).
MIGRATIONS: list[str] = [
    """
    CREATE TABLE users (
        id          INTEGER PRIMARY KEY,
        google_sub  TEXT NOT NULL UNIQUE,
        email       TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL DEFAULT '',
        picture     TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_login  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE level_stats (
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level                 INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
        wins                  INTEGER NOT NULL DEFAULT 0,
        best_time_ms          INTEGER,
        flawless_wins         INTEGER NOT NULL DEFAULT 0,
        best_flawless_ms      INTEGER,
        streak                INTEGER NOT NULL DEFAULT 0,
        best_streak           INTEGER NOT NULL DEFAULT 0,
        flawless_streak       INTEGER NOT NULL DEFAULT 0,
        best_flawless_streak  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, level)
    );

    CREATE TABLE totals (
        user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        good_moves      INTEGER NOT NULL DEFAULT 0,
        time_played_ms  INTEGER NOT NULL DEFAULT 0,
        streak          INTEGER NOT NULL DEFAULT 0,
        best_streak     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE settings (
        user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        check_mistakes   INTEGER NOT NULL DEFAULT 1,
        highlight_peers  INTEGER NOT NULL DEFAULT 1,
        theme            TEXT NOT NULL DEFAULT 'system'
    );

    CREATE TABLE saved_game (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        level       INTEGER NOT NULL,
        state_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    -- One row per reported result. The client-generated id makes retries idempotent.
    CREATE TABLE results (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level       INTEGER NOT NULL,
        won         INTEGER NOT NULL,
        time_ms     INTEGER NOT NULL,
        mistakes    INTEGER NOT NULL,
        hints       INTEGER NOT NULL,
        good_moves  INTEGER NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX results_user ON results(user_id, created_at);
    """,
]


def connect(path: str) -> sqlite3.Connection:
    # Autocommit mode; writes use explicit transactions via `transaction()`.
    # A connection lives for one request, but FastAPI may hand the request to a
    # different worker thread than the one that opened it.
    conn = sqlite3.connect(path, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def migrate(path: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for number, script in enumerate(MIGRATIONS[version:], start=version + 1):
            # executescript commits on its own, so wrap the script and the
            # version bump in one explicit transaction.
            conn.executescript(f"BEGIN;\n{script}\nPRAGMA user_version = {number};\nCOMMIT;")
    finally:
        conn.close()
