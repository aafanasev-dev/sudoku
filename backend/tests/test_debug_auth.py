import dataclasses

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, Settings
from app.main import create_app

BASE_URL = "http://localhost:8080"
DEBUG_EMAIL = "dev@example.com"


@pytest.fixture
def debug_client(settings):
    app = create_app(dataclasses.replace(settings, debug_auth_email=DEBUG_EMAIL))
    with TestClient(app, base_url=BASE_URL, headers={"Origin": BASE_URL}) as c:
        yield c


def test_every_visitor_is_the_debug_user(debug_client):
    me = debug_client.get("/api/me").json()
    assert me["email"] == DEBUG_EMAIL
    assert me["name"] == "dev"
    assert me["debugAuth"] is True
    assert debug_client.get("/api/me").json()["id"] == me["id"]
    assert debug_client.get("/api/progress").status_code == 200


def test_login_skips_google(debug_client):
    res = debug_client.get("/auth/login", follow_redirects=False)
    assert res.status_code == 303
    assert res.headers["location"] == "/"
    assert debug_client.get("/api/me").json()["email"] == DEBUG_EMAIL


def test_logout_signs_the_debug_user_back_in(debug_client):
    first = debug_client.get("/api/me").json()["id"]
    assert debug_client.post("/auth/logout").status_code == 204
    assert debug_client.get("/api/me").json()["id"] == first


def test_me_reports_debug_auth_off(sign_in, client):
    sign_in()
    assert client.get("/api/me").json()["debugAuth"] is False


@pytest.fixture
def env(monkeypatch):
    for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_BASE_URL", "DEBUG_AUTH_EMAIL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)
    return monkeypatch


def test_from_env_needs_no_google_credentials_in_debug_mode(env):
    env.setenv("DEBUG_AUTH_EMAIL", f" {DEBUG_EMAIL} ")
    settings = Settings.from_env()
    assert settings.debug_auth_email == DEBUG_EMAIL
    assert settings.debug_auth


def test_from_env_still_needs_google_credentials_otherwise(env):
    with pytest.raises(ConfigError, match="GOOGLE_CLIENT_ID"):
        Settings.from_env()


def test_from_env_refuses_debug_mode_on_a_public_url(env):
    env.setenv("DEBUG_AUTH_EMAIL", DEBUG_EMAIL)
    env.setenv("PUBLIC_BASE_URL", "https://sudoku.example.com")
    with pytest.raises(ConfigError, match="DEBUG_AUTH_EMAIL"):
        Settings.from_env()
