import os
from dataclasses import dataclass


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

    @property
    def redirect_uri(self) -> str:
        return f"{self.public_base_url}/auth/callback"

    @classmethod
    def from_env(cls) -> "Settings":
        missing = [
            name
            for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET")
            if not os.environ.get(name, "").strip()
        ]
        if missing:
            raise ConfigError(
                f"Missing required environment variables: {', '.join(missing)}. "
                "See auth_config.md."
            )
        secret = os.environ["SESSION_SECRET"].strip()
        if len(secret) < 32:
            raise ConfigError("SESSION_SECRET must be at least 32 characters.")
        return cls(
            google_client_id=os.environ["GOOGLE_CLIENT_ID"].strip(),
            google_client_secret=os.environ["GOOGLE_CLIENT_SECRET"].strip(),
            session_secret=secret,
            public_base_url=os.environ.get("PUBLIC_BASE_URL", cls.public_base_url).strip().rstrip("/"),
            database_path=os.environ.get("DATABASE_PATH", cls.database_path).strip(),
            cookie_secure=os.environ.get("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"},
        )
