import itertools

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

BASE_URL = "http://localhost:8080"


@pytest.fixture
def settings(tmp_path):
    return Settings(
        google_client_id="test-client",
        google_client_secret="test-secret",
        session_secret="x" * 40,
        public_base_url=BASE_URL,
        database_path=str(tmp_path / "test.db"),
    )


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    # Browsers send Origin on every non-GET request; mirror that.
    with TestClient(app, base_url=BASE_URL, headers={"Origin": BASE_URL}) as c:
        yield c


@pytest.fixture
def sign_in(app, client):
    """Sign in through the real callback route with Google's side faked."""

    def _sign_in(sub="google-user-1", email="player@example.com", name="Player"):
        async def fake_token(request):
            return {"userinfo": {"sub": sub, "email": email, "name": name, "picture": ""}}

        app.state.oauth.google.authorize_access_token = fake_token
        res = client.get("/auth/callback", follow_redirects=False)
        assert res.status_code == 303, res.text
        assert res.headers["location"] == "/"
        return client

    return _sign_in


_ids = itertools.count()


@pytest.fixture
def report(client):
    def _report(level, won=True, time_ms=60_000, mistakes=0, hints=0, good_moves=40, result_id=None, expect=200):
        body = {
            "id": result_id or f"result-{next(_ids):08d}",
            "level": level,
            "won": won,
            "timeMs": time_ms,
            "mistakes": mistakes,
            "hints": hints,
            "goodMoves": good_moves,
        }
        res = client.post("/api/results", json=body)
        assert res.status_code == expect, res.text
        return res.json()

    return _report
