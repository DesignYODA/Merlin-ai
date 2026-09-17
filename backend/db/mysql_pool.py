"""
mysql_pool.py — shared MySQL connection pool + schema for glessio_master.

Backs merlin_db.py (g_auth, g_sessions, g_fireflies, g_product_insights,
fireflies_kv) and hubspot.py (hs_kv, hs_companies, hs_deals, hs_notes,
hs_contacts, hs_emails) — both now share this one pool/database, replacing
the old per-file single-connection-plus-threading.RLock() SQLite pattern.
Schema for both domains is created here, once, since it's all one logical
database now rather than two separate SQLite files each owning their own
CREATE TABLE statements.

No SQLite-style "read replica" here — MySQL's InnoDB handles concurrent
reads-during-writes natively via MVCC, so the file-copy replica trick this
app used under SQLite (see the old replicate_to_read_replica() docstrings)
is unnecessary and has been dropped entirely.
"""

import contextlib
import time

import mysql.connector
from mysql.connector import pooling
from mysql.connector.errors import PoolError

from config.config import (
    MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE, MYSQL_POOL_SIZE,
)
from config.logging_config import get_logger

logger = get_logger("merlin.db.mysql_pool")

_pool: pooling.MySQLConnectionPool | None = None

# get_connection() raises PoolError immediately on exhaustion rather than
# blocking — retry briefly instead of failing a request outright on a burst.
_POOL_GET_RETRIES = 5
_POOL_GET_BACKOFF_SECONDS = 0.2

_CHARSET = "utf8mb4"
_COLLATION = "utf8mb4_unicode_ci"


def _create_database_if_missing() -> None:
    """CREATE DATABASE IF NOT EXISTS needs a connection with no database
    selected yet — done once, outside the pool (which is bound to MYSQL_DATABASE)."""
    cnx = mysql.connector.connect(
        host=MYSQL_HOST, port=MYSQL_PORT, user=MYSQL_USER, password=MYSQL_PASSWORD,
        charset=_CHARSET, use_pure=True,
    )
    try:
        cur = cnx.cursor()
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS `{MYSQL_DATABASE}` "
            f"CHARACTER SET {_CHARSET} COLLATE {_COLLATION}"
        )
        cnx.commit()
        cur.close()
    finally:
        cnx.close()


def init_pool() -> pooling.MySQLConnectionPool:
    """Lazily create the pool + schema on first use, mirroring the old
    per-file _get_conn()-on-first-call pattern. Safe to call more than once
    (e.g. once from main.py's lifespan, and idempotently again from any
    module that imports this before lifespan has run)."""
    global _pool
    if _pool is None:
        _create_database_if_missing()
        _pool = pooling.MySQLConnectionPool(
            pool_name="glessio_master_pool",
            pool_size=MYSQL_POOL_SIZE,
            host=MYSQL_HOST,
            port=MYSQL_PORT,
            user=MYSQL_USER,
            password=MYSQL_PASSWORD,
            database=MYSQL_DATABASE,
            charset=_CHARSET,
            use_pure=True,
            autocommit=False,
        )
        _init_schema()
        logger.info("[mysql] pool ready — %s@%s:%s/%s (pool_size=%s)",
                    MYSQL_USER, MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_POOL_SIZE)
    return _pool


def _checkout() -> mysql.connector.MySQLConnection:
    """Check a connection out of the pool, retrying briefly on PoolError, and
    ping it to transparently recover a connection MySQL's wait_timeout closed
    while idle (or that went stale across a Lambda freeze/thaw)."""
    pool = init_pool()
    last_err: Exception | None = None
    for attempt in range(_POOL_GET_RETRIES):
        try:
            cnx = pool.get_connection()
        except PoolError as err:
            last_err = err
            time.sleep(_POOL_GET_BACKOFF_SECONDS * (attempt + 1))
            continue
        try:
            cnx.ping(reconnect=True, attempts=3, delay=0.2)
        except mysql.connector.Error:
            cnx.close()
            raise
        return cnx
    assert last_err is not None
    raise last_err


@contextlib.contextmanager
def get_connection():
    """Context manager: check a connection out of the pool, yield it, always
    return it (mysql-connector's pooled connections return themselves to the
    pool on .close() — they aren't actually closed)."""
    cnx = _checkout()
    try:
        yield cnx
    finally:
        cnx.close()


def close_pool() -> None:
    """MySQLConnectionPool has no explicit "shut down" API — dropping the
    module-level reference lets already-checked-in connections be garbage
    collected. A connection still checked out (shouldn't happen at shutdown,
    since get_connection() always returns its connection) closes itself when
    its holder's context manager exits."""
    global _pool
    _pool = None


def _init_schema() -> None:
    cnx = mysql.connector.connect(
        host=MYSQL_HOST, port=MYSQL_PORT, user=MYSQL_USER, password=MYSQL_PASSWORD,
        database=MYSQL_DATABASE, charset=_CHARSET, use_pure=True,
    )
    try:
        cur = cnx.cursor()
        for stmt in _SCHEMA_STATEMENTS:
            cur.execute(stmt)
        cnx.commit()
        cur.close()
    finally:
        cnx.close()


# ─── Schema ─────────────────────────────────────────────────────────────────
# DDL is not transactional in MySQL (implicit commit around each statement) —
# executed one statement at a time, each individually idempotent via
# IF NOT EXISTS, so re-running this on an already-initialized database is safe.

_TABLE_OPTS = f"ENGINE=InnoDB DEFAULT CHARSET={_CHARSET} COLLATE={_COLLATION}"

_SCHEMA_STATEMENTS = [
    # ─── g_auth (merlin_db.py: auth) ───────────────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS g_auth (
        emailid          VARCHAR(320) NOT NULL PRIMARY KEY,
        password         VARCHAR(255) NOT NULL,
        username         VARCHAR(255) NOT NULL,
        securityquestion VARCHAR(500) NOT NULL,
        answer           VARCHAR(255) NOT NULL,
        title            VARCHAR(255) NOT NULL DEFAULT '',
        `role`           VARCHAR(20)  NOT NULL DEFAULT 'member',
        lastloggedin     BIGINT NULL
    ) {_TABLE_OPTS}
    """,

    # ─── g_sessions (merlin_db.py: sessions) ───────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS g_sessions (
        token      VARCHAR(64)  NOT NULL PRIMARY KEY,
        emailid    VARCHAR(320) NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        INDEX idx_g_sessions_emailid (emailid),
        INDEX idx_g_sessions_expires_at (expires_at)
    ) {_TABLE_OPTS}
    """,

    # ─── g_fireflies (merlin_db.py: meetings) — transcript/sentences get ───
    # LONGTEXT: full call transcripts and their raw per-sentence data can be
    # very large. Other JSON/prose columns get MEDIUMTEXT (16MB — generous
    # headroom, no realistic risk of truncation).
    f"""
    CREATE TABLE IF NOT EXISTS g_fireflies (
        id                       VARCHAR(255) NOT NULL PRIMARY KEY,
        title                    TEXT NULL,
        `date`                   BIGINT NULL,
        duration                 DOUBLE NULL,
        organizer_email          VARCHAR(320) NULL,
        host_email               VARCHAR(320) NULL,
        transcript_url           TEXT NULL,
        audio_url                TEXT NULL,
        video_url                TEXT NULL,
        meeting_type             VARCHAR(100) NULL,
        meeting_attendees        MEDIUMTEXT NULL,
        `user`                   MEDIUMTEXT NULL,
        summary_keywords         MEDIUMTEXT NULL,
        summary_action_items     MEDIUMTEXT NULL,
        summary_outline          MEDIUMTEXT NULL,
        summary_shorthand_bullet MEDIUMTEXT NULL,
        summary_overview         MEDIUMTEXT NULL,
        summary_bullet_gist      MEDIUMTEXT NULL,
        summary_short_summary    MEDIUMTEXT NULL,
        sentences                LONGTEXT NULL,
        metadata                 MEDIUMTEXT NULL,
        transcript               LONGTEXT NULL,
        INDEX idx_g_fireflies_date (`date` DESC)
    ) {_TABLE_OPTS}
    """,

    # ─── g_product_insights (merlin_db.py: product_insights) ──────────────
    f"""
    CREATE TABLE IF NOT EXISTS g_product_insights (
        call_id        VARCHAR(255) NOT NULL PRIMARY KEY,
        call_title     VARCHAR(255) NULL,
        ae_name        VARCHAR(255) NULL,
        client_name    VARCHAR(255) NULL,
        `date`         VARCHAR(50) NULL,
        transcript_url TEXT NULL,
        items          MEDIUMTEXT NOT NULL,
        analyzed_at    BIGINT NOT NULL
    ) {_TABLE_OPTS}
    """,

    # ─── fireflies_kv (merlin_db.py: kv_store) ─────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS fireflies_kv (
        `key`   VARCHAR(255) NOT NULL PRIMARY KEY,
        `value` MEDIUMTEXT NOT NULL
    ) {_TABLE_OPTS}
    """,

    # ─── hs_kv (hubspot.py: hs_kv) ──────────────────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS hs_kv (
        `key`   VARCHAR(255) NOT NULL PRIMARY KEY,
        `value` MEDIUMTEXT NOT NULL
    ) {_TABLE_OPTS}
    """,

    # ─── hs_companies (hubspot.py: companies) ──────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS hs_companies (
        company_id          VARCHAR(64) NOT NULL PRIMARY KEY,
        name                VARCHAR(500) NOT NULL DEFAULT '',
        domain              VARCHAR(255) NOT NULL DEFAULT '',
        phone               VARCHAR(50)  NOT NULL DEFAULT '',
        city                VARCHAR(255) NOT NULL DEFAULT '',
        state               VARCHAR(255) NOT NULL DEFAULT '',
        country             VARCHAR(255) NOT NULL DEFAULT '',
        industry            VARCHAR(255) NOT NULL DEFAULT '',
        createdate          VARCHAR(50)  NOT NULL DEFAULT '',
        lifecyclestage      VARCHAR(100) NOT NULL DEFAULT '',
        hubspot_owner_id    VARCHAR(64)  NOT NULL DEFAULT '',
        hs_lastmodifieddate VARCHAR(50)  NOT NULL DEFAULT '',
        synced_at           BIGINT NOT NULL DEFAULT 0
    ) {_TABLE_OPTS}
    """,

    # ─── hs_deals (hubspot.py: deals) ──────────────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS hs_deals (
        deal_id             VARCHAR(64) NOT NULL PRIMARY KEY,
        company_id          VARCHAR(64) NOT NULL DEFAULT '',
        dealname            VARCHAR(500) NOT NULL DEFAULT '',
        amount              VARCHAR(50) NOT NULL DEFAULT '',
        dealstage           VARCHAR(100) NOT NULL DEFAULT '',
        dealstage_label     VARCHAR(255) NOT NULL DEFAULT '',
        closedate           VARCHAR(50) NOT NULL DEFAULT '',
        pipeline            VARCHAR(100) NOT NULL DEFAULT '',
        pipeline_label      VARCHAR(255) NOT NULL DEFAULT '',
        hubspot_owner_id    VARCHAR(64) NOT NULL DEFAULT '',
        createdate          VARCHAR(50) NOT NULL DEFAULT '',
        hs_lastmodifieddate VARCHAR(50) NOT NULL DEFAULT '',
        synced_at           BIGINT NOT NULL DEFAULT 0,
        INDEX idx_hs_deals_company (company_id),
        INDEX idx_hs_deals_closedate (closedate DESC, createdate DESC)
    ) {_TABLE_OPTS}
    """,

    # ─── hs_notes (hubspot.py: notes) — hs_note_body can be lengthy HTML ──
    f"""
    CREATE TABLE IF NOT EXISTS hs_notes (
        note_id             VARCHAR(64) NOT NULL PRIMARY KEY,
        company_id          VARCHAR(64) NOT NULL DEFAULT '',
        hs_note_body        MEDIUMTEXT NOT NULL,
        hs_createdate       VARCHAR(50) NOT NULL DEFAULT '',
        hs_lastmodifieddate VARCHAR(50) NOT NULL DEFAULT '',
        hubspot_owner_id    VARCHAR(64) NOT NULL DEFAULT '',
        hs_timestamp        VARCHAR(50) NOT NULL DEFAULT '',
        url                 TEXT NULL,
        synced_at           BIGINT NOT NULL DEFAULT 0,
        INDEX idx_hs_notes_company (company_id),
        INDEX idx_hs_notes_company_date (company_id, hs_createdate DESC)
    ) {_TABLE_OPTS}
    """,

    # ─── hs_emails (hubspot.py: emails) — hs_email_text can be lengthy ────
    f"""
    CREATE TABLE IF NOT EXISTS hs_emails (
        email_id             VARCHAR(64) NOT NULL PRIMARY KEY,
        company_id           VARCHAR(64) NOT NULL DEFAULT '',
        hs_email_subject     VARCHAR(1000) NOT NULL DEFAULT '',
        hs_email_text        MEDIUMTEXT NOT NULL,
        hs_createdate        VARCHAR(50) NOT NULL DEFAULT '',
        hs_lastmodifieddate  VARCHAR(50) NOT NULL DEFAULT '',
        hubspot_owner_id     VARCHAR(64) NOT NULL DEFAULT '',
        hs_timestamp         VARCHAR(50) NOT NULL DEFAULT '',
        url                  TEXT NULL,
        synced_at            BIGINT NOT NULL DEFAULT 0,
        INDEX idx_hs_emails_company (company_id),
        INDEX idx_hs_emails_company_date (company_id, hs_createdate DESC)
    ) {_TABLE_OPTS}
    """,

    # ─── hs_contacts (hubspot.py: contacts) ────────────────────────────────
    f"""
    CREATE TABLE IF NOT EXISTS hs_contacts (
        contact_id       VARCHAR(64) NOT NULL PRIMARY KEY,
        company_id       VARCHAR(64) NOT NULL DEFAULT '',
        firstname        VARCHAR(255) NOT NULL DEFAULT '',
        lastname         VARCHAR(255) NOT NULL DEFAULT '',
        email            VARCHAR(320) NOT NULL DEFAULT '',
        createdate       VARCHAR(50) NOT NULL DEFAULT '',
        lastmodifieddate VARCHAR(50) NOT NULL DEFAULT '',
        url              TEXT NULL,
        synced_at        BIGINT NOT NULL DEFAULT 0,
        INDEX idx_hs_contacts_company (company_id)
    ) {_TABLE_OPTS}
    """,
]
