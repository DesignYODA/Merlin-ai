import os
from dotenv import load_dotenv, find_dotenv

# Search: backend/.env → project root .env → any .env up the tree
_explicit = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(dotenv_path=_explicit if os.path.exists(_explicit) else find_dotenv())


def _parse_list(env_var: str) -> list[str]:
    return [s.strip() for s in (os.getenv(env_var) or "").split(",") if s.strip()]


FIREFLIES_API_URL: str = os.getenv("FIREFLIES_API_URL", "https://api.fireflies.ai/graphql")
FIREFLIES_FROM_DATE: str = os.getenv("FIREFLIES_FROM_DATE", "2025-12-01T00:00:00.000Z")
HUBSPOT_API_BASE: str = os.getenv("HUBSPOT_API_BASE", "https://api.hubapi.com")

FIREFLIES_API_KEY: str | None = os.getenv("FIREFLIES_API_KEY")
GROQ_API_KEY: str | None = os.getenv("GROQ_API_KEY")
ANTHROPIC_API_KEY: str | None = os.getenv("ANTHROPIC_API_KEY")
HUBSPOT_API_KEY: str | None = os.getenv("HUBSPOT_API_KEY")

PORT: int = int(os.getenv("PORT", "3001"))

# In Lambda the deployment package (and thus __file__'s directory) is read-only —
# only /tmp is writable, so the sqlite files must live there instead.
IS_LAMBDA: bool = bool(os.getenv("AWS_LAMBDA_FUNCTION_NAME"))
_DATA_DIR = "/tmp/data" if IS_LAMBDA else os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
SQLITE_PATH: str = os.getenv("SQLITE_PATH", os.path.join(_DATA_DIR, "merlin.sqlite"))
ANALYTICAL_PATH: str = os.getenv("ANALYTICAL_PATH", os.path.join(_DATA_DIR, "analytical.sqlite"))
CHAT_PATH: str = os.getenv("CHAT_PATH", os.path.join(_DATA_DIR, "chat.sqlite"))
HUBSPOT_PATH: str = os.getenv("HUBSPOT_PATH", os.path.join(_DATA_DIR, "hubspot_data.sqlite"))

# Read replicas — separate files that frontend-facing GET endpoints read from,
# refreshed via SQLite's online backup API right after each write-sync so
# reads never contend with (or block on) an in-progress sync's writes.
MERLIN_REPLICA_PATH: str = os.getenv("MERLIN_REPLICA_PATH", os.path.join(_DATA_DIR, "merlin_replica.sqlite"))
HUBSPOT_REPLICA_PATH: str = os.getenv("HUBSPOT_REPLICA_PATH", os.path.join(_DATA_DIR, "hubspot_data_replica.sqlite"))

REDACTED_NAMES: list[str] = _parse_list("REDACTED_NAMES")
EXCLUDED_HOSTS: list[str] = _parse_list("EXCLUDED_HOSTS")
EXCLUDED_TITLES: list[str] = _parse_list("EXCLUDED_TITLES")
INTERNAL_DOMAINS: list[str] = _parse_list("INTERNAL_DOMAINS")
HIRING_KEYWORDS: list[str] = _parse_list("HIRING_KEYWORDS")
