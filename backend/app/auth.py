"""Google sign-in (OpenID Connect, authorization-code flow) and the session.

The session is a signed cookie holding only the user id. Authlib keeps the
OAuth `state` and `nonce` in the same session between /auth/login and
/auth/callback.
"""

import logging
import sqlite3
from collections.abc import Iterator
from typing import Annotated

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse

from .config import Settings
from .db import connect, transaction

log = logging.getLogger(__name__)

GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"

router = APIRouter()


def create_oauth(settings: Settings) -> OAuth:
    oauth = OAuth()
    oauth.register(
        name="google",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        server_metadata_url=GOOGLE_DISCOVERY_URL,
        client_kwargs={"scope": "openid email profile"},
    )
    return oauth


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    conn = connect(request.app.state.settings.database_path)
    try:
        yield conn
    finally:
        conn.close()


Db = Annotated[sqlite3.Connection, Depends(get_db)]


def current_user(request: Request, db: Db) -> sqlite3.Row:
    user_id = request.session.get("user_id")
    if not isinstance(user_id, int):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        request.session.clear()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    return user


CurrentUser = Annotated[sqlite3.Row, Depends(current_user)]


def upsert_user(db: sqlite3.Connection, userinfo: dict) -> int:
    with transaction(db):
        row = db.execute(
            """
            INSERT INTO users (google_sub, email, name, picture)
            VALUES (:sub, :email, :name, :picture)
            ON CONFLICT (google_sub) DO UPDATE SET
                email = excluded.email,
                name = excluded.name,
                picture = excluded.picture,
                last_login = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            RETURNING id
            """,
            {
                "sub": str(userinfo["sub"]),
                "email": str(userinfo.get("email") or ""),
                "name": str(userinfo.get("name") or userinfo.get("email") or ""),
                "picture": str(userinfo.get("picture") or ""),
            },
        ).fetchone()
    return row["id"]


@router.get("/auth/login")
async def login(request: Request):
    settings: Settings = request.app.state.settings
    # Drop any previous identity before starting a new sign-in.
    request.session.pop("user_id", None)
    return await request.app.state.oauth.google.authorize_redirect(
        request, settings.redirect_uri, prompt="select_account"
    )


@router.get("/auth/callback")
async def callback(request: Request, db: Db):
    try:
        token = await request.app.state.oauth.google.authorize_access_token(request)
    except OAuthError as err:
        log.warning("Google sign-in failed: %s", err.error)
        return RedirectResponse("/?auth_error=1", status_code=status.HTTP_303_SEE_OTHER)

    userinfo = token.get("userinfo") or {}
    if not userinfo.get("sub"):
        log.warning("Google sign-in returned no subject")
        return RedirectResponse("/?auth_error=1", status_code=status.HTTP_303_SEE_OTHER)

    user_id = upsert_user(db, userinfo)
    request.session.clear()  # new session on sign-in
    request.session["user_id"] = user_id
    return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/me")
def me(user: CurrentUser) -> dict:
    return {"id": user["id"], "name": user["name"], "email": user["email"], "picture": user["picture"]}
