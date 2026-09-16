"""The unlock rule. This is the single source of truth; the frontend only
knows level names and clue ranges.

Level 1 is open. Level N+1 needs `wins_required` wins on level N — the
Fibonacci numbers 1, 2, 3, 5. Wins on any other level don't count, and wins
are never spent, so an unlock is permanent.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Level:
    id: int
    name: str
    wins_required: int  # wins needed on level id-1; 0 for the first level


LEVELS: tuple[Level, ...] = (
    Level(1, "Easy", 0),
    Level(2, "Medium", 1),
    Level(3, "Hard", 2),
    Level(4, "Expert", 3),
    Level(5, "Evil", 5),
)
LEVEL_IDS = frozenset(level.id for level in LEVELS)


def is_unlocked(level_id: int, wins: dict[int, int]) -> bool:
    level = LEVELS[level_id - 1]
    if level.wins_required == 0:
        return True
    return wins.get(level_id - 1, 0) >= level.wins_required


def unlocked_levels(wins: dict[int, int]) -> set[int]:
    return {level.id for level in LEVELS if is_unlocked(level.id, wins)}
