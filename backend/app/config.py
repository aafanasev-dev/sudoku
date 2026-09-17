import os
from dataclasses import dataclass
from urllib.parse import urlsplit

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    google_client_id: str
    google_client_secret: str
    session_secret: str
    public_base_url: str = "http://localhost:8080"
    database_path: str = "/data/sudoku.db"
    cookie_secure: bool = False
    # When set, Google is skipped and every visitor is this user. Local only.
    debug_auth_email: str = ""

    @property
    def debug_auth(self) -> bool:
        return bool(self.debug_auth_email)

    @property
    def redirect_uri(self) -> str:
        return f"{self.public_base_url}/auth/callback"

    @classmethod
    def from_env(cls) -> "Settings":
        debug_email = os.environ.get("DEBUG_AUTH_EMAIL", "").strip()
        required = ("SESSION_SECRET",) if debug_email else ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET")
        missing = [name for name in required if not os.environ.get(name, "").strip()]
        if missing:
            raise ConfigError(
                f"Missing required environment variables: {', '.join(missing)}. "
                "See auth_config.md."
            )
        secret = os.environ["SESSION_SECRET"].strip()
        if len(secret) < 32:
            raise ConfigError("SESSION_SECRET must be at least 32 characters.")
        public_base_url = os.environ.get("PUBLIC_BASE_URL", cls.public_base_url).strip().rstrip("/")
        if debug_email and urlsplit(public_base_url).hostname not in LOCAL_HOSTS:
            raise ConfigError(
                "DEBUG_AUTH_EMAIL signs every visitor in without Google; "
                f"it is only allowed when PUBLIC_BASE_URL is local, not {public_base_url}."
            )
        return cls(
            google_client_id=os.environ.get("GOOGLE_CLIENT_ID", "").strip(),
            google_client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", "").strip(),
            session_secret=secret,
            public_base_url=public_base_url,
            database_path=os.environ.get("DATABASE_PATH", cls.database_path).strip(),
            cookie_secure=os.environ.get("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"},
            debug_auth_email=debug_email,
        )
