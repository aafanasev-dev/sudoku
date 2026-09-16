import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.sessions import SessionMiddleware

from . import auth, progress
from .config import Settings
from .db import connect, migrate

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
SESSION_MAX_AGE = 30 * 24 * 60 * 60


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    migrate(settings.database_path)

    app = FastAPI(title="Sudoku API", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.oauth = auth.create_oauth(settings)

    @app.middleware("http")
    async def same_origin_writes(request: Request, call_next):
        # CSRF defence on top of SameSite=Lax: state-changing requests must
        # come from our own pages.
        if request.method not in SAFE_METHODS and request.headers.get("origin") != settings.public_base_url:
            return JSONResponse({"detail": "Cross-origin request rejected"}, status_code=403)
        response = await call_next(request)
        if request.url.path.startswith(("/api/", "/auth/")):
            response.headers["Cache-Control"] = "no-store"
        return response

    # Added last so it runs first: the session must exist for everything above.
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        session_cookie="sudoku_session",
        max_age=SESSION_MAX_AGE,
        same_site="lax",
        https_only=settings.cookie_secure,
    )

    app.include_router(auth.router)
    app.include_router(progress.router)

    @app.get("/healthz")
    def healthz() -> dict:
        conn = connect(settings.database_path)
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return {"status": "ok"}

    return app


def app_factory() -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    return create_app()
