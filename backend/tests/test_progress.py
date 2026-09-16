import pytest

from app.levels import LEVELS, is_unlocked


def unlocked(progress):
    return {level["id"] for level in progress["levels"] if level["unlocked"]}


def test_new_player_has_only_easy_open(sign_in, client):
    sign_in()
    progress = client.get("/api/progress").json()
    assert unlocked(progress) == {1}
    assert progress["levels"][2]["requires"] == {"levelId": 2, "wins": 2, "have": 0}
    assert progress["totals"] == {"wins": 0, "streak": 0, "bestStreak": 0, "goodMoves": 0, "timePlayedMs": 0}
    assert progress["settings"] == {"checkMistakes": True, "highlightPeers": True, "theme": "system"}
    assert progress["savedGame"] is None


def test_the_whole_fibonacci_ladder(sign_in, report):
    sign_in()
    res = report(1)
    assert res["newlyUnlocked"] == [2]

    assert report(2)["newlyUnlocked"] == []
    assert report(2)["newlyUnlocked"] == [3]

    assert [report(3)["newlyUnlocked"] for _ in range(3)] == [[], [], [4]]
    assert [report(4)["newlyUnlocked"] for _ in range(5)] == [[], [], [], [], [5]]

    final = report(5)["progress"]
    assert unlocked(final) == {1, 2, 3, 4, 5}
    assert final["totals"]["wins"] == 12  # eleven to open everything, plus one on Evil


def test_wins_only_count_on_the_level_directly_below(sign_in, report):
    sign_in()
    for _ in range(10):
        progress = report(1)["progress"]
    assert unlocked(progress) == {1, 2}


def test_results_for_locked_levels_are_rejected(sign_in, report, client):
    sign_in()
    report(3, expect=403)
    assert client.get("/api/progress").json()["totals"]["wins"] == 0


def test_losses_do_not_unlock_or_count_as_wins(sign_in, report):
    sign_in()
    progress = report(1, won=False)["progress"]
    assert unlocked(progress) == {1}
    assert progress["levels"][0]["wins"] == 0


def test_best_times_and_flawless_bests(sign_in, report):
    sign_in()
    res = report(1, time_ms=90_000, mistakes=1)
    assert res["newBest"] and not res["newFlawlessBest"]

    res = report(1, time_ms=120_000)
    assert not res["newBest"] and res["newFlawlessBest"]

    res = report(1, time_ms=80_000, hints=2)
    assert res["newBest"] and not res["newFlawlessBest"]

    easy = res["progress"]["levels"][0]
    assert easy["bestTimeMs"] == 80_000
    assert easy["bestFlawlessMs"] == 120_000
    assert easy["wins"] == 3
    assert easy["flawlessWins"] == 1


def test_streaks(sign_in, report):
    sign_in()
    report(1)
    report(1)
    easy = report(1, mistakes=1)["progress"]["levels"][0]
    assert (easy["streak"], easy["bestStreak"]) == (3, 3)
    assert (easy["flawlessStreak"], easy["bestFlawlessStreak"]) == (0, 2)

    progress = report(1, won=False)["progress"]
    easy = progress["levels"][0]
    assert (easy["streak"], easy["bestStreak"]) == (0, 3)
    assert progress["totals"]["streak"] == 0
    assert progress["totals"]["bestStreak"] == 3


def test_totals_accumulate_time_and_good_moves(sign_in, report):
    sign_in()
    report(1, time_ms=60_000, good_moves=30)
    totals = report(1, won=False, time_ms=5_000, good_moves=4)["progress"]["totals"]
    assert totals["timePlayedMs"] == 65_000
    assert totals["goodMoves"] == 34


def test_retried_results_are_applied_once(sign_in, report):
    sign_in()
    report(1, result_id="same-id-123")
    res = report(1, result_id="same-id-123")
    assert res["progress"]["levels"][0]["wins"] == 1
    assert res["newlyUnlocked"] == []


@pytest.mark.parametrize("patch", [
    {"level": 0}, {"level": 6}, {"timeMs": -1}, {"hints": 82}, {"id": "short"},
    {"id": "bad id with spaces"}, {"extra": 1}, {"won": "maybe"},
])
def test_invalid_results_are_rejected(sign_in, client, patch):
    sign_in()
    body = {"id": "valid-id-0001", "level": 1, "won": True, "timeMs": 60_000,
            "mistakes": 0, "hints": 0, "goodMoves": 40, **patch}
    assert client.post("/api/results", json=body).status_code == 422


def test_implausibly_fast_wins_are_rejected(sign_in, report):
    sign_in()
    report(1, time_ms=200, expect=422)


def test_players_do_not_see_each_others_progress(sign_in, report, client):
    sign_in(sub="alice")
    report(1)
    sign_in(sub="bob")
    progress = client.get("/api/progress").json()
    assert progress["totals"]["wins"] == 0
    assert unlocked(progress) == {1}


def test_settings_round_trip(sign_in, client):
    sign_in()
    body = {"checkMistakes": False, "highlightPeers": False, "theme": "dark"}
    assert client.put("/api/settings", json=body).json() == body
    assert client.get("/api/progress").json()["settings"] == body
    assert client.put("/api/settings", json={**body, "theme": "neon"}).status_code == 422


def test_saved_game_round_trip(sign_in, client):
    sign_in()
    game = {"levelId": 1, "puzzle": [0] * 81, "entries": [1] * 81}
    assert client.put("/api/saved-game", json={"state": game}).status_code == 204
    assert client.get("/api/progress").json()["savedGame"] == game
    assert client.delete("/api/saved-game").status_code == 204
    assert client.get("/api/progress").json()["savedGame"] is None


def test_saved_game_limits(sign_in, client):
    sign_in()
    huge = {"levelId": 1, "blob": "x" * 70_000}
    assert client.put("/api/saved-game", json={"state": huge}).status_code == 413
    assert client.put("/api/saved-game", json={"state": {"levelId": 9}}).status_code == 422
    assert client.put("/api/saved-game", json={"state": {"levelId": True}}).status_code == 422
    assert client.put("/api/saved-game", json={"state": "nope"}).status_code == 422


def test_reset_clears_progress_but_keeps_settings(sign_in, report, client):
    sign_in()
    report(1)
    client.put("/api/settings", json={"checkMistakes": False, "highlightPeers": True, "theme": "light"})
    client.put("/api/saved-game", json={"state": {"levelId": 2}})

    assert client.delete("/api/progress").status_code == 204
    progress = client.get("/api/progress").json()
    assert unlocked(progress) == {1}
    assert progress["totals"]["wins"] == 0
    assert progress["savedGame"] is None
    assert progress["settings"]["theme"] == "light"


def test_unlock_rule_table():
    assert [level.wins_required for level in LEVELS] == [0, 1, 2, 3, 5]
    assert is_unlocked(1, {})
    assert not is_unlocked(2, {})
    assert is_unlocked(5, {4: 5})
    assert not is_unlocked(5, {4: 4, 1: 100})


def test_progress_survives_an_app_restart(settings, sign_in, report):
    sign_in()
    report(1)
    from fastapi.testclient import TestClient
    from app.main import create_app

    app2 = create_app(settings)
    async def fake_token(request):
        return {"userinfo": {"sub": "google-user-1", "email": "", "name": ""}}
    app2.state.oauth.google.authorize_access_token = fake_token
    with TestClient(app2, base_url=settings.public_base_url) as c:
        c.get("/auth/callback", follow_redirects=False)
        assert c.get("/api/progress").json()["levels"][0]["wins"] == 1
