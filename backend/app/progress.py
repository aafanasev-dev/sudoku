"""Player progress: results, stats, settings and the unfinished game."""

import json
import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import CurrentUser, Db
from .db import transaction
from .levels import LEVELS, is_unlocked

router = APIRouter(prefix="/api")

MAX_SAVED_GAME_BYTES = 64 * 1024
DAY_MS = 24 * 60 * 60 * 1000
MIN_WIN_MS = 1000


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ResultIn(Strict):
    id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    level: int = Field(ge=1, le=len(LEVELS))
    won: bool
    time_ms: int = Field(alias="timeMs", ge=0, le=DAY_MS)
    mistakes: int = Field(ge=0, le=10_000)
    hints: int = Field(ge=0, le=81)
    good_moves: int = Field(alias="goodMoves", ge=0, le=10_000)


class SettingsIn(Strict):
    check_mistakes: bool = Field(alias="checkMistakes")
    highlight_peers: bool = Field(alias="highlightPeers")
    theme: Literal["system", "light", "dark"]


class SavedGameIn(Strict):
    state: dict[str, Any]


def _wins(db: sqlite3.Connection, user_id: int) -> dict[int, int]:
    rows = db.execute("SELECT level, wins FROM level_stats WHERE user_id = ?", (user_id,))
    return {row["level"]: row["wins"] for row in rows}


def _settings(db: sqlite3.Connection, user_id: int) -> dict:
    row = db.execute("SELECT * FROM settings WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        return {"checkMistakes": True, "highlightPeers": True, "theme": "system"}
    return {
        "checkMistakes": bool(row["check_mistakes"]),
        "highlightPeers": bool(row["highlight_peers"]),
        "theme": row["theme"],
    }


def load_progress(db: sqlite3.Connection, user_id: int) -> dict:
    stats = {
        row["level"]: row
        for row in db.execute("SELECT * FROM level_stats WHERE user_id = ?", (user_id,))
    }
    wins = {level: row["wins"] for level, row in stats.items()}

    levels = []
    for level in LEVELS:
        row = stats.get(level.id)
        levels.append({
            "id": level.id,
            "name": level.name,
            "unlocked": is_unlocked(level.id, wins),
            # What it takes to unlock, and how far along the player is.
            "requires": None if level.wins_required == 0 else {
                "levelId": level.id - 1,
                "wins": level.wins_required,
                "have": min(wins.get(level.id - 1, 0), level.wins_required),
            },
            "wins": row["wins"] if row else 0,
            "bestTimeMs": row["best_time_ms"] if row else None,
            "flawlessWins": row["flawless_wins"] if row else 0,
            "bestFlawlessMs": row["best_flawless_ms"] if row else None,
            "streak": row["streak"] if row else 0,
            "bestStreak": row["best_streak"] if row else 0,
            "flawlessStreak": row["flawless_streak"] if row else 0,
            "bestFlawlessStreak": row["best_flawless_streak"] if row else 0,
        })

    totals = db.execute("SELECT * FROM totals WHERE user_id = ?", (user_id,)).fetchone()
    saved = db.execute("SELECT state_json FROM saved_game WHERE user_id = ?", (user_id,)).fetchone()

    return {
        "levels": levels,
        "totals": {
            "wins": sum(wins.values()),
            "streak": totals["streak"] if totals else 0,
            "bestStreak": totals["best_streak"] if totals else 0,
            "goodMoves": totals["good_moves"] if totals else 0,
            "timePlayedMs": totals["time_played_ms"] if totals else 0,
        },
        "settings": _settings(db, user_id),
        "savedGame": json.loads(saved["state_json"]) if saved else None,
    }


def _faster(best: int | None, time_ms: int) -> bool:
    return best is None or time_ms < best


@router.get("/progress")
def get_progress(user: CurrentUser, db: Db) -> dict:
    return load_progress(db, user["id"])


@router.post("/results")
def post_result(result: ResultIn, user: CurrentUser, db: Db) -> dict:
    uid = user["id"]
    if result.won and result.time_ms < MIN_WIN_MS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Implausible solve time")

    outcome = {"newlyUnlocked": [], "newBest": False, "newFlawlessBest": False}
    with transaction(db):
        wins_before = _wins(db, uid)
        if not is_unlocked(result.level, wins_before):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Level is locked")

        inserted = db.execute(
            """
            INSERT INTO results (id, user_id, level, won, time_ms, mistakes, hints, good_moves)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO NOTHING
            """,
            (result.id, uid, result.level, int(result.won), result.time_ms,
             result.mistakes, result.hints, result.good_moves),
        ).rowcount
        if inserted:
            outcome = _apply_result(db, uid, result, wins_before)

    return {"progress": load_progress(db, uid), **outcome}


def _apply_result(db: sqlite3.Connection, uid: int, result: ResultIn, wins_before: dict[int, int]) -> dict:
    db.execute("INSERT INTO level_stats (user_id, level) VALUES (?, ?) ON CONFLICT DO NOTHING", (uid, result.level))
    db.execute("INSERT INTO totals (user_id) VALUES (?) ON CONFLICT DO NOTHING", (uid,))
    row = db.execute(
        "SELECT * FROM level_stats WHERE user_id = ? AND level = ?", (uid, result.level)
    ).fetchone()

    new_best = new_flawless_best = False
    if result.won:
        flawless = result.mistakes == 0 and result.hints == 0
        new_best = _faster(row["best_time_ms"], result.time_ms)
        new_flawless_best = flawless and _faster(row["best_flawless_ms"], result.time_ms)
        streak = row["streak"] + 1
        f_streak = row["flawless_streak"] + 1 if flawless else 0
        db.execute(
            """
            UPDATE level_stats SET
                wins = wins + 1,
                best_time_ms = CASE WHEN :new_best THEN :t ELSE best_time_ms END,
                flawless_wins = flawless_wins + :flawless,
                best_flawless_ms = CASE WHEN :new_fbest THEN :t ELSE best_flawless_ms END,
                streak = :streak,
                best_streak = MAX(best_streak, :streak),
                flawless_streak = :fstreak,
                best_flawless_streak = MAX(best_flawless_streak, :fstreak)
            WHERE user_id = :uid AND level = :level
            """,
            {"new_best": new_best, "new_fbest": new_flawless_best, "t": result.time_ms,
             "flawless": int(flawless), "streak": streak, "fstreak": f_streak,
             "uid": uid, "level": result.level},
        )
        db.execute(
            """
            UPDATE totals SET streak = streak + 1, best_streak = MAX(best_streak, streak + 1)
            WHERE user_id = ?
            """,
            (uid,),
        )
    else:
        db.execute(
            "UPDATE level_stats SET streak = 0, flawless_streak = 0 WHERE user_id = ? AND level = ?",
            (uid, result.level),
        )
        db.execute("UPDATE totals SET streak = 0 WHERE user_id = ?", (uid,))

    db.execute(
        "UPDATE totals SET good_moves = good_moves + ?, time_played_ms = time_played_ms + ? WHERE user_id = ?",
        (result.good_moves, result.time_ms, uid),
    )

    wins_after = _wins(db, uid)
    newly_unlocked = [
        level.id for level in LEVELS
        if not is_unlocked(level.id, wins_before) and is_unlocked(level.id, wins_after)
    ]
    return {"newlyUnlocked": newly_unlocked, "newBest": new_best, "newFlawlessBest": new_flawless_best}


@router.put("/settings")
def put_settings(body: SettingsIn, user: CurrentUser, db: Db) -> dict:
    with transaction(db):
        db.execute(
            """
            INSERT INTO settings (user_id, check_mistakes, highlight_peers, theme)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                check_mistakes = excluded.check_mistakes,
                highlight_peers = excluded.highlight_peers,
                theme = excluded.theme
            """,
            (user["id"], int(body.check_mistakes), int(body.highlight_peers), body.theme),
        )
    return _settings(db, user["id"])


@router.put("/saved-game", status_code=status.HTTP_204_NO_CONTENT)
def put_saved_game(body: SavedGameIn, user: CurrentUser, db: Db) -> Response:
    state_json = json.dumps(body.state, separators=(",", ":"))
    if len(state_json.encode()) > MAX_SAVED_GAME_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Saved game is too large")
    level = body.state.get("levelId")
    if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= len(LEVELS):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Saved game needs a valid levelId")
    with transaction(db):
        db.execute(
            """
            INSERT INTO saved_game (user_id, level, state_json) VALUES (?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                level = excluded.level,
                state_json = excluded.state_json,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            """,
            (user["id"], level, state_json),
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/saved-game", status_code=status.HTTP_204_NO_CONTENT)
def delete_saved_game(user: CurrentUser, db: Db) -> Response:
    with transaction(db):
        db.execute("DELETE FROM saved_game WHERE user_id = ?", (user["id"],))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/progress", status_code=status.HTTP_204_NO_CONTENT)
def reset_progress(user: CurrentUser, db: Db) -> Response:
    """Wipe stats, results and the saved game. Settings and the account stay."""
    uid = user["id"]
    with transaction(db):
        for table in ("level_stats", "totals", "saved_game", "results"):
            db.execute(f"DELETE FROM {table} WHERE user_id = ?", (uid,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
