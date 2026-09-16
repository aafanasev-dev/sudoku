from authlib.integrations.starlette_client import OAuthError


def test_endpoints_require_a_session(client):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/progress").status_code == 401
    assert client.put("/api/settings", json={"checkMistakes": True, "highlightPeers": True, "theme": "dark"}).status_code == 401


def test_callback_creates_the_user_and_starts_a_session(sign_in, client):
    sign_in(sub="abc", email="a@example.com", name="Ann")
    me = client.get("/api/me").json()
    assert me["email"] == "a@example.com"
    assert me["name"] == "Ann"
    assert "sudoku_session" in client.cookies


def test_signing_in_again_updates_the_same_user(sign_in, client):
    sign_in(sub="abc", name="Ann")
    first = client.get("/api/me").json()["id"]
    sign_in(sub="abc", name="Ann B.")
    me = client.get("/api/me").json()
    assert me["id"] == first
    assert me["name"] == "Ann B."


def test_different_google_accounts_are_different_users(sign_in, client):
    sign_in(sub="one")
    first = client.get("/api/me").json()["id"]
    sign_in(sub="two")
    assert client.get("/api/me").json()["id"] != first


def test_failed_google_exchange_redirects_with_an_error(app, client):
    async def boom(request):
        raise OAuthError(error="mismatching_state")

    app.state.oauth.google.authorize_access_token = boom
    res = client.get("/auth/callback", follow_redirects=False)
    assert res.status_code == 303
    assert res.headers["location"] == "/?auth_error=1"
    assert client.get("/api/me").status_code == 401


def test_login_redirects_to_google(app, client):
    captured = {}

    async def fake_redirect(request, redirect_uri, **kwargs):
        from starlette.responses import RedirectResponse
        captured["redirect_uri"] = redirect_uri
        return RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?fake=1")

    app.state.oauth.google.authorize_redirect = fake_redirect
    res = client.get("/auth/login", follow_redirects=False)
    assert res.status_code in (302, 307)
    assert res.headers["location"].startswith("https://accounts.google.com/")
    assert captured["redirect_uri"] == "http://localhost:8080/auth/callback"


def test_logout_ends_the_session(sign_in, client):
    sign_in()
    assert client.post("/auth/logout").status_code == 204
    assert client.get("/api/me").status_code == 401


def test_writes_from_another_origin_are_rejected(sign_in, client):
    sign_in()
    body = {"checkMistakes": False, "highlightPeers": True, "theme": "dark"}
    assert client.put("/api/settings", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
    client.headers.pop("Origin")
    assert client.put("/api/settings", json=body).status_code == 403
    assert client.post("/auth/logout").status_code == 403
    assert client.get("/api/me").status_code == 200


def test_tampered_session_cookie_is_ignored(sign_in, client):
    sign_in()
    client.cookies.set("sudoku_session", "garbage")
    assert client.get("/api/me").status_code == 401


def test_api_responses_are_not_cached(sign_in, client):
    sign_in()
    assert client.get("/api/progress").headers["cache-control"] == "no-store"


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}
