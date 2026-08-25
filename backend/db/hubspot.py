"""
hubspot.py — SQLite access layer for hubspot_data.sqlite

Normalized tables:
  companies — one row per HubSpot company
  deals     — one row per deal (company_id FK)
  notes     — one row per note (company_id FK)
  emails    — one row per email engagement (company_id FK)
  contacts  — one row per contact (company_id FK)

On first open, migrates any existing legacy flat hubspot_data table automatically.
"""

import json
import os
import sqlite3
import threading
import time

from config.config import IS_LAMBDA, HUBSPOT_REPLICA_PATH
from config.logging_config import get_logger

logger = get_logger("merlin.db.hubspot")

_DATA_DIR = "/tmp/data" if IS_LAMBDA else os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
HUBSPOT_DB_PATH = os.environ.get("HUBSPOT_PATH", os.path.join(_DATA_DIR, "hubspot_data.sqlite"))

os.makedirs(os.path.dirname(os.path.abspath(HUBSPOT_DB_PATH)), exist_ok=True)

# RLock, not Lock: replica readers hold _lock while calling _get_replica_conn(),
# which self-heals a missing replica file by calling replicate_to_read_replica() —
# itself also acquiring _lock. A plain Lock would deadlock the calling thread.
_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(HUBSPOT_DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA cache_size = -8000;
            PRAGMA temp_store = MEMORY;
        """)
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS hs_kv (
            key   TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS companies (
            company_id          TEXT NOT NULL PRIMARY KEY,
            name                TEXT NOT NULL DEFAULT '',
            domain              TEXT NOT NULL DEFAULT '',
            phone               TEXT NOT NULL DEFAULT '',
            city                TEXT NOT NULL DEFAULT '',
            state               TEXT NOT NULL DEFAULT '',
            country             TEXT NOT NULL DEFAULT '',
            industry            TEXT NOT NULL DEFAULT '',
            createdate          TEXT NOT NULL DEFAULT '',
            lifecyclestage      TEXT NOT NULL DEFAULT '',
            hubspot_owner_id    TEXT NOT NULL DEFAULT '',
            hs_lastmodifieddate TEXT NOT NULL DEFAULT '',
            synced_at           INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS deals (
            deal_id             TEXT NOT NULL PRIMARY KEY,
            company_id          TEXT NOT NULL DEFAULT '',
            dealname            TEXT NOT NULL DEFAULT '',
            amount              TEXT NOT NULL DEFAULT '',
            dealstage           TEXT NOT NULL DEFAULT '',
            dealstage_label     TEXT NOT NULL DEFAULT '',
            closedate           TEXT NOT NULL DEFAULT '',
            pipeline            TEXT NOT NULL DEFAULT '',
            pipeline_label      TEXT NOT NULL DEFAULT '',
            hubspot_owner_id    TEXT NOT NULL DEFAULT '',
            createdate          TEXT NOT NULL DEFAULT '',
            hs_lastmodifieddate TEXT NOT NULL DEFAULT '',
            synced_at           INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS notes (
            note_id             TEXT NOT NULL PRIMARY KEY,
            company_id          TEXT NOT NULL DEFAULT '',
            hs_note_body        TEXT NOT NULL DEFAULT '',
            hs_createdate       TEXT NOT NULL DEFAULT '',
            hs_lastmodifieddate TEXT NOT NULL DEFAULT '',
            hubspot_owner_id    TEXT NOT NULL DEFAULT '',
            hs_timestamp        TEXT NOT NULL DEFAULT '',
            url                 TEXT NOT NULL DEFAULT '',
            synced_at           INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS emails (
            email_id            TEXT NOT NULL PRIMARY KEY,
            company_id          TEXT NOT NULL DEFAULT '',
            hs_email_subject    TEXT NOT NULL DEFAULT '',
            hs_email_text       TEXT NOT NULL DEFAULT '',
            hs_createdate       TEXT NOT NULL DEFAULT '',
            hs_lastmodifieddate TEXT NOT NULL DEFAULT '',
            hubspot_owner_id    TEXT NOT NULL DEFAULT '',
            hs_timestamp        TEXT NOT NULL DEFAULT '',
            url                 TEXT NOT NULL DEFAULT '',
            synced_at           INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS contacts (
            contact_id          TEXT NOT NULL PRIMARY KEY,
            company_id          TEXT NOT NULL DEFAULT '',
            firstname           TEXT NOT NULL DEFAULT '',
            lastname            TEXT NOT NULL DEFAULT '',
            email               TEXT NOT NULL DEFAULT '',
            createdate          TEXT NOT NULL DEFAULT '',
            lastmodifieddate    TEXT NOT NULL DEFAULT '',
            url                 TEXT NOT NULL DEFAULT '',
            synced_at           INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
        CREATE INDEX IF NOT EXISTS idx_notes_company ON notes(company_id);
        CREATE INDEX IF NOT EXISTS idx_emails_company ON emails(company_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

        -- Covers get_hubspot_flat_data()'s global ORDER BY (avoids a temp b-tree
        -- sort over the full table) and get_hubspot_company_details()'s
        -- per-company lookup (company_id, date) in a single index scan.
        CREATE INDEX IF NOT EXISTS idx_deals_closedate ON deals(closedate DESC, createdate DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_company_date ON notes(company_id, hs_createdate DESC);
        CREATE INDEX IF NOT EXISTS idx_emails_company_date ON emails(company_id, hs_createdate DESC);
    """)
    conn.commit()
    _migrate_add_deal_labels(conn)
    _migrate_add_url_columns(conn)
    _migrate_old_flat_table(conn)


def _migrate_add_deal_labels(conn: sqlite3.Connection) -> None:
    """Add label columns to existing deals tables that predate them."""
    for col in ("dealstage_label", "pipeline_label"):
        try:
            conn.execute(f"ALTER TABLE deals ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
            conn.commit()
        except sqlite3.OperationalError:
            pass  # column already exists


def _migrate_add_url_columns(conn: sqlite3.Connection) -> None:
    """Add the `url` column (HubSpot's own deep link) to notes/emails tables that predate it."""
    for table in ("notes", "emails"):
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN url TEXT NOT NULL DEFAULT ''")
            conn.commit()
        except sqlite3.OperationalError:
            pass  # column already exists


def _migrate_old_flat_table(conn: sqlite3.Connection) -> None:
    """One-time migration: copy rows from legacy flat hubspot_data into normalized tables."""
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "hubspot_data" not in tables:
        return
    old_cols = {r[1] for r in conn.execute("PRAGMA table_info(hubspot_data)").fetchall()}
    if "company_name" not in old_cols:
        return

    logger.info("[hubspot db] Migrating flat hubspot_data -> normalized tables...")
    conn.execute("""
        INSERT OR IGNORE INTO companies
            (company_id, name, domain, phone, city, state, country,
             industry, createdate, lifecyclestage, hubspot_owner_id,
             hs_lastmodifieddate, synced_at)
        SELECT DISTINCT
            company_id, company_name, company_domain, company_phone,
            company_city, company_state, company_country, company_industry,
            company_createdate, company_lifecyclestage, company_hubspot_owner_id,
            company_hs_lastmodifieddate, synced_at
        FROM hubspot_data WHERE company_id != ''
    """)
    conn.execute("""
        INSERT OR IGNORE INTO deals
            (deal_id, company_id, dealname, amount, dealstage, closedate,
             pipeline, hubspot_owner_id, createdate, hs_lastmodifieddate, synced_at)
        SELECT DISTINCT
            deal_id, company_id, deal_name, deal_amount, deal_dealstage,
            deal_closedate, deal_pipeline, deal_hubspot_owner_id,
            deal_createdate, deal_hs_lastmodifieddate, synced_at
        FROM hubspot_data WHERE deal_id != ''
    """)
    conn.execute("""
        INSERT OR IGNORE INTO notes
            (note_id, company_id, hs_note_body, hs_createdate, hs_lastmodifieddate,
             hubspot_owner_id, hs_timestamp, synced_at)
        SELECT
            note_id, company_id, note_hs_note_body, note_hs_createdate,
            note_hs_lastmodifieddate, note_hubspot_owner_id, note_hs_timestamp, synced_at
        FROM hubspot_data WHERE note_id NOT LIKE '_co_%'
    """)
    conn.commit()
    logger.info("[hubspot db] Migration complete")


def close_hubspot_db() -> None:
    global _conn
    with _lock:
        if _conn:
            _conn.close()
            _conn = None
    close_hubspot_replica()


# ─── Read replica ─────────────────────────────────────────────────────────────
# A separate file, read-only, that frontend-facing GET endpoints query instead
# of the primary. Refreshed via SQLite's online backup API (safe to run while
# the primary is mid-write) right after each sync writes to the primary —
# see replicate_to_read_replica() callers in interface/handler.py.

_replica_conn: sqlite3.Connection | None = None


def replicate_to_read_replica() -> None:
    """Snapshot the primary DB into the read replica file.

    The actual page-by-page copy (multi-second for a 250MB+ DB) runs with NO
    lock held: it uses its own read-only connection to the primary file (WAL
    mode gives it a consistent snapshot without blocking/being blocked by
    concurrent writers) and writes into a fresh temp file nobody else has
    open. _lock is only taken twice, briefly: once to make sure the primary
    is initialized, and once at the end to close the old replica handle and
    atomically swap the temp file into place. Previously the whole backup()
    call ran under _lock, so every /hubspot/* GET request (which also takes
    _lock to read the replica) queued up behind it for the full copy duration
    every ~30 min cron cycle — this is what caused /hubspot/flat-data to time
    out.
    """
    global _replica_conn
    with _lock:
        _get_conn()  # ensure primary connection/schema exists

    tmp_path = HUBSPOT_REPLICA_PATH + ".tmp"
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            os.remove(tmp_path + suffix)
        except FileNotFoundError:
            pass

    src = sqlite3.connect(f"file:{HUBSPOT_DB_PATH}?mode=ro", uri=True)
    dest = sqlite3.connect(tmp_path)
    try:
        src.backup(dest)
    finally:
        src.close()
        dest.close()

    with _lock:
        if _replica_conn is not None:
            _replica_conn.close()
            _replica_conn = None
        os.replace(tmp_path, HUBSPOT_REPLICA_PATH)


def _get_replica_conn() -> sqlite3.Connection:
    global _replica_conn
    if _replica_conn is None:
        if not os.path.exists(HUBSPOT_REPLICA_PATH):
            replicate_to_read_replica()
        _replica_conn = sqlite3.connect(f"file:{HUBSPOT_REPLICA_PATH}?mode=ro", uri=True, check_same_thread=False)
        _replica_conn.row_factory = sqlite3.Row
        _replica_conn.executescript("""
            PRAGMA cache_size = -65536;
            PRAGMA mmap_size = 268435456;
            PRAGMA temp_store = MEMORY;
        """)
    return _replica_conn


def close_hubspot_replica() -> None:
    global _replica_conn
    with _lock:
        if _replica_conn:
            _replica_conn.close()
            _replica_conn = None


# ─── KV helpers ───────────────────────────────────────────────────────────────

def hs_kv_get(key: str):
    with _lock:
        row = _get_conn().execute("SELECT value FROM hs_kv WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None


def hs_kv_set(key: str, value) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO hs_kv (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )
        conn.commit()


# ─── Upsert SQL ───────────────────────────────────────────────────────────────

_COMPANY_UPSERT = """
    INSERT INTO companies (company_id, name, domain, phone, city, state, country,
        industry, createdate, lifecyclestage, hubspot_owner_id, hs_lastmodifieddate, synced_at)
    VALUES (:company_id, :name, :domain, :phone, :city, :state, :country,
        :industry, :createdate, :lifecyclestage, :hubspot_owner_id, :hs_lastmodifieddate, :synced_at)
    ON CONFLICT(company_id) DO UPDATE SET
        name=excluded.name, domain=excluded.domain, phone=excluded.phone,
        city=excluded.city, state=excluded.state, country=excluded.country,
        industry=excluded.industry, createdate=excluded.createdate,
        lifecyclestage=excluded.lifecyclestage, hubspot_owner_id=excluded.hubspot_owner_id,
        hs_lastmodifieddate=excluded.hs_lastmodifieddate, synced_at=excluded.synced_at
"""

_DEAL_UPSERT = """
    INSERT INTO deals (deal_id, company_id, dealname, amount, dealstage, dealstage_label,
        closedate, pipeline, pipeline_label, hubspot_owner_id, createdate, hs_lastmodifieddate, synced_at)
    VALUES (:deal_id, :company_id, :dealname, :amount, :dealstage, :dealstage_label,
        :closedate, :pipeline, :pipeline_label, :hubspot_owner_id, :createdate, :hs_lastmodifieddate, :synced_at)
    ON CONFLICT(deal_id) DO UPDATE SET
        company_id=excluded.company_id, dealname=excluded.dealname, amount=excluded.amount,
        dealstage=excluded.dealstage, dealstage_label=excluded.dealstage_label,
        closedate=excluded.closedate, pipeline=excluded.pipeline, pipeline_label=excluded.pipeline_label,
        hubspot_owner_id=excluded.hubspot_owner_id, createdate=excluded.createdate,
        hs_lastmodifieddate=excluded.hs_lastmodifieddate, synced_at=excluded.synced_at
"""

_NOTE_UPSERT = """
    INSERT INTO notes (note_id, company_id, hs_note_body, hs_createdate, hs_lastmodifieddate,
        hubspot_owner_id, hs_timestamp, url, synced_at)
    VALUES (:note_id, :company_id, :hs_note_body, :hs_createdate, :hs_lastmodifieddate,
        :hubspot_owner_id, :hs_timestamp, :url, :synced_at)
    ON CONFLICT(note_id) DO UPDATE SET
        company_id=excluded.company_id, hs_note_body=excluded.hs_note_body,
        hs_createdate=excluded.hs_createdate, hs_lastmodifieddate=excluded.hs_lastmodifieddate,
        hubspot_owner_id=excluded.hubspot_owner_id, hs_timestamp=excluded.hs_timestamp,
        url=excluded.url, synced_at=excluded.synced_at
"""

_EMAIL_UPSERT = """
    INSERT INTO emails (email_id, company_id, hs_email_subject, hs_email_text, hs_createdate,
        hs_lastmodifieddate, hubspot_owner_id, hs_timestamp, url, synced_at)
    VALUES (:email_id, :company_id, :hs_email_subject, :hs_email_text, :hs_createdate,
        :hs_lastmodifieddate, :hubspot_owner_id, :hs_timestamp, :url, :synced_at)
    ON CONFLICT(email_id) DO UPDATE SET
        company_id=excluded.company_id, hs_email_subject=excluded.hs_email_subject,
        hs_email_text=excluded.hs_email_text, hs_createdate=excluded.hs_createdate,
        hs_lastmodifieddate=excluded.hs_lastmodifieddate, hubspot_owner_id=excluded.hubspot_owner_id,
        hs_timestamp=excluded.hs_timestamp, url=excluded.url, synced_at=excluded.synced_at
"""

_CONTACT_UPSERT = """
    INSERT INTO contacts (contact_id, company_id, firstname, lastname, email,
        createdate, lastmodifieddate, url, synced_at)
    VALUES (:contact_id, :company_id, :firstname, :lastname, :email,
        :createdate, :lastmodifieddate, :url, :synced_at)
    ON CONFLICT(contact_id) DO UPDATE SET
        company_id=excluded.company_id, firstname=excluded.firstname, lastname=excluded.lastname,
        email=excluded.email, createdate=excluded.createdate, lastmodifieddate=excluded.lastmodifieddate,
        url=excluded.url, synced_at=excluded.synced_at
"""


# ─── Write ────────────────────────────────────────────────────────────────────

def upsert_hubspot_data(companies: list[dict], label_map: dict | None = None) -> int:
    """
    Upsert enriched companies into normalized tables.
    Each company → companies row + N deals rows + M notes rows.
    label_map: { stage_id → { stageLabel, pipelineLabel } } — from pipelines API.
    Returns total rows written.
    """
    label_map = label_map or {}
    now = int(time.time() * 1000)
    co_rows:      list[dict] = []
    deal_rows:    list[dict] = []
    note_rows:    list[dict] = []
    email_rows:   list[dict] = []
    contact_rows: list[dict] = []

    for co in companies:
        cp    = co.get("properties") or {}
        co_id = co.get("id") or ""
        if not co_id:
            continue

        co_rows.append({
            "company_id":           co_id,
            "name":                 cp.get("name") or "",
            "domain":               cp.get("domain") or "",
            "phone":                cp.get("phone") or "",
            "city":                 cp.get("city") or "",
            "state":                cp.get("state") or "",
            "country":              cp.get("country") or "",
            "industry":             cp.get("industry") or "",
            "createdate":           cp.get("createdate") or "",
            "lifecyclestage":       cp.get("lifecyclestage") or "",
            "hubspot_owner_id":     cp.get("hubspot_owner_id") or "",
            "hs_lastmodifieddate":  cp.get("hs_lastmodifieddate") or "",
            "synced_at":            now,
        })

        for deal in co.get("resolved_deals") or []:
            dp        = deal.get("properties") or {}
            deal_id   = deal.get("id") or ""
            if not deal_id:
                continue
            stage_id  = dp.get("dealstage") or ""
            lbl       = label_map.get(stage_id, {})
            deal_rows.append({
                "deal_id":              deal_id,
                "company_id":           co_id,
                "dealname":             dp.get("dealname") or "",
                "amount":               dp.get("amount") or "",
                "dealstage":            stage_id,
                "dealstage_label":      lbl.get("stageLabel", ""),
                "closedate":            dp.get("closedate") or "",
                "pipeline":             dp.get("pipeline") or "",
                "pipeline_label":       lbl.get("pipelineLabel", ""),
                "hubspot_owner_id":     dp.get("hubspot_owner_id") or "",
                "createdate":           dp.get("createdate") or "",
                "hs_lastmodifieddate":  dp.get("hs_lastmodifieddate") or "",
                "synced_at":            now,
            })

        for note in co.get("resolved_notes") or []:
            np      = note.get("properties") or {}
            note_id = note.get("id") or ""
            if not note_id:
                continue
            note_rows.append({
                "note_id":              note_id,
                "company_id":           co_id,
                "hs_note_body":         np.get("hs_note_body") or "",
                "hs_createdate":        np.get("hs_createdate") or "",
                "hs_lastmodifieddate":  np.get("hs_lastmodifieddate") or "",
                "hubspot_owner_id":     np.get("hubspot_owner_id") or "",
                "hs_timestamp":         np.get("hs_timestamp") or "",
                "url":                  note.get("url") or "",
                "synced_at":            now,
            })

        for email in co.get("resolved_emails") or []:
            ep       = email.get("properties") or {}
            email_id = email.get("id") or ""
            if not email_id:
                continue
            email_rows.append({
                "email_id":             email_id,
                "company_id":           co_id,
                "hs_email_subject":     ep.get("hs_email_subject") or "",
                "hs_email_text":        ep.get("hs_email_text") or "",
                "hs_createdate":        ep.get("hs_createdate") or "",
                "hs_lastmodifieddate":  ep.get("hs_lastmodifieddate") or "",
                "hubspot_owner_id":     ep.get("hubspot_owner_id") or "",
                "hs_timestamp":         ep.get("hs_timestamp") or "",
                "url":                  email.get("url") or "",
                "synced_at":            now,
            })

        for contact in co.get("resolved_contacts") or []:
            cop        = contact.get("properties") or {}
            contact_id = contact.get("id") or ""
            if not contact_id:
                continue
            contact_rows.append({
                "contact_id":       contact_id,
                "company_id":       co_id,
                "firstname":        cop.get("firstname") or "",
                "lastname":         cop.get("lastname") or "",
                "email":            cop.get("email") or "",
                "createdate":       cop.get("createdate") or "",
                "lastmodifieddate": cop.get("lastmodifieddate") or "",
                "url":              contact.get("url") or "",
                "synced_at":        now,
            })

    with _lock:
        conn = _get_conn()
        with conn:
            if co_rows:
                conn.executemany(_COMPANY_UPSERT, co_rows)
            if deal_rows:
                conn.executemany(_DEAL_UPSERT, deal_rows)
            if note_rows:
                conn.executemany(_NOTE_UPSERT, note_rows)
            if email_rows:
                conn.executemany(_EMAIL_UPSERT, email_rows)
            if contact_rows:
                conn.executemany(_CONTACT_UPSERT, contact_rows)

    return len(co_rows) + len(deal_rows) + len(note_rows) + len(email_rows) + len(contact_rows)


def clear_hubspot_data() -> None:
    """Delete all rows from the normalized tables and reset sync/pipeline state."""
    with _lock:
        conn = _get_conn()
        conn.execute("DELETE FROM companies")
        conn.execute("DELETE FROM deals")
        conn.execute("DELETE FROM notes")
        conn.execute("DELETE FROM emails")
        conn.execute("DELETE FROM contacts")
        conn.execute("DELETE FROM hs_kv WHERE key = 'hubspot:sync_status'")
        conn.execute("DELETE FROM hs_kv WHERE key = 'hubspot:pipeline_labels'")
        conn.commit()


# ─── Read ─────────────────────────────────────────────────────────────────────

def get_hubspot_db_entities() -> dict:
    """Return {companies, deals, notes, emails, contacts} shaped for the frontend
    (same as enriched API shape). Reads from the read replica — this is purely
    a frontend-facing GET path, never used by any write flow."""
    with _lock:
        conn  = _get_replica_conn()
        cos   = [dict(r) for r in conn.execute("SELECT * FROM companies ORDER BY name").fetchall()]
        deals = [dict(r) for r in conn.execute("SELECT * FROM deals ORDER BY dealname").fetchall()]
        notes = [dict(r) for r in conn.execute(
            "SELECT * FROM notes ORDER BY hs_createdate DESC"
        ).fetchall()]
        emails = [dict(r) for r in conn.execute(
            "SELECT * FROM emails ORDER BY hs_createdate DESC"
        ).fetchall()]
        contacts = [dict(r) for r in conn.execute(
            "SELECT * FROM contacts ORDER BY lastname"
        ).fetchall()]

    def _co(r):
        return {
            "id": r["company_id"],
            "properties": {k: r[k] for k in r if k not in ("company_id", "synced_at")},
        }

    def _deal(r):
        return {
            "id": r["deal_id"],
            "company_id": r["company_id"],
            "properties": {k: r[k] for k in r if k not in ("deal_id", "company_id", "synced_at")},
        }

    def _note(r):
        return {
            "id": r["note_id"],
            "company_id": r["company_id"],
            "properties": {k: r[k] for k in r if k not in ("note_id", "company_id", "synced_at")},
        }

    def _email(r):
        return {
            "id": r["email_id"],
            "company_id": r["company_id"],
            "properties": {k: r[k] for k in r if k not in ("email_id", "company_id", "synced_at")},
        }

    def _contact(r):
        return {
            "id": r["contact_id"],
            "company_id": r["company_id"],
            "properties": {k: r[k] for k in r if k not in ("contact_id", "company_id", "synced_at")},
        }

    return {
        "companies": [_co(r) for r in cos],
        "deals":     [_deal(r) for r in deals],
        "notes":     [_note(r) for r in notes],
        "emails":    [_email(r) for r in emails],
        "contacts":  [_contact(r) for r in contacts],
    }


def get_hubspot_flat_data() -> list[dict]:
    """
    Return one row per company: company fields, id lists (for counts), the
    primary (most recent) deal/note/email preview, and the full deals/contacts
    lists (cheap — no large text columns).

    Does NOT include full note/email bodies for every engagement — the emails
    table alone holds 100MB+ of text across thousands of rows, and loading all
    of it on every list request took 1-2s+. Full note/email bodies for one
    company are fetched on demand via get_hubspot_company_details() when its
    modal is opened. Reads from the read replica — purely a frontend-facing
    GET path, never used by any write flow.
    """
    with _lock:
        conn = _get_replica_conn()
        cos  = [dict(r) for r in conn.execute("SELECT * FROM companies ORDER BY name").fetchall()]

        # Id-only scans (no large text columns) — cheap, used for per-company counts.
        deal_id_rows    = conn.execute("SELECT deal_id, company_id FROM deals").fetchall()
        note_id_rows    = conn.execute("SELECT note_id, company_id FROM notes").fetchall()
        email_id_rows   = conn.execute("SELECT email_id, company_id FROM emails").fetchall()
        contact_id_rows = conn.execute("SELECT contact_id, company_id FROM contacts").fetchall()

        all_deals    = [dict(r) for r in conn.execute(
            "SELECT * FROM deals ORDER BY closedate DESC, createdate DESC"
        ).fetchall()]
        all_contacts = [dict(r) for r in conn.execute(
            "SELECT * FROM contacts ORDER BY lastname"
        ).fetchall()]

        # Exactly one (most recent) note/email row per company — ranked on the
        # narrow id+date columns first, then joined back for the winning rows
        # only, so the large hs_note_body/hs_email_text text is read for
        # ~1 row per company instead of every row in the table.
        primary_notes = [dict(r) for r in conn.execute("""
            WITH ranked AS (
                SELECT note_id, ROW_NUMBER() OVER (
                    PARTITION BY company_id ORDER BY hs_createdate DESC
                ) AS rn
                FROM notes
            )
            SELECT n.* FROM notes n
            INNER JOIN ranked r ON r.note_id = n.note_id AND r.rn = 1
        """).fetchall()]
        primary_emails = [dict(r) for r in conn.execute("""
            WITH ranked AS (
                SELECT email_id, ROW_NUMBER() OVER (
                    PARTITION BY company_id ORDER BY hs_createdate DESC
                ) AS rn
                FROM emails
            )
            SELECT e.* FROM emails e
            INNER JOIN ranked r ON r.email_id = e.email_id AND r.rn = 1
        """).fetchall()]

    deals_by_co: dict[str, list[dict]] = {}
    for d in all_deals:
        deals_by_co.setdefault(d["company_id"], []).append(d)

    contacts_by_co: dict[str, list[dict]] = {}
    for c in all_contacts:
        contacts_by_co.setdefault(c["company_id"], []).append(c)

    deal_ids_by_co: dict[str, list[str]] = {}
    for r in deal_id_rows:
        deal_ids_by_co.setdefault(r["company_id"], []).append(r["deal_id"])
    note_ids_by_co: dict[str, list[str]] = {}
    for r in note_id_rows:
        note_ids_by_co.setdefault(r["company_id"], []).append(r["note_id"])
    email_ids_by_co: dict[str, list[str]] = {}
    for r in email_id_rows:
        email_ids_by_co.setdefault(r["company_id"], []).append(r["email_id"])
    contact_ids_by_co: dict[str, list[str]] = {}
    for r in contact_id_rows:
        contact_ids_by_co.setdefault(r["company_id"], []).append(r["contact_id"])

    notes_by_co  = {n["company_id"]: n for n in primary_notes}
    emails_by_co = {e["company_id"]: e for e in primary_emails}

    rows: list[dict] = []
    for co in cos:
        co_id    = co["company_id"]
        deals    = deals_by_co.get(co_id, [])
        contacts = contacts_by_co.get(co_id, [])
        pd     = deals[0] if deals else {}
        pn     = notes_by_co.get(co_id, {})
        pe     = emails_by_co.get(co_id, {})

        rows.append({
            # Company
            "company_id":                  co_id,
            "company_name":                co.get("name", ""),
            "company_domain":              co.get("domain", ""),
            "company_phone":               co.get("phone", ""),
            "company_city":                co.get("city", ""),
            "company_state":               co.get("state", ""),
            "company_country":             co.get("country", ""),
            "company_industry":            co.get("industry", ""),
            "company_createdate":          co.get("createdate", ""),
            "company_lifecyclestage":      co.get("lifecyclestage", ""),
            "company_hubspot_owner_id":    co.get("hubspot_owner_id", ""),
            "company_hs_lastmodifieddate": co.get("hs_lastmodifieddate", ""),
            "company_synced_at":           co.get("synced_at", 0),
            # ID lists
            "deal_ids":    deal_ids_by_co.get(co_id, []),
            "note_ids":    note_ids_by_co.get(co_id, []),
            "email_ids":   email_ids_by_co.get(co_id, []),
            "contact_ids": contact_ids_by_co.get(co_id, []),
            # Primary deal (prefer resolved labels over raw IDs)
            "deal_id":                  pd.get("deal_id", ""),
            "deal_name":                pd.get("dealname", ""),
            "deal_amount":              pd.get("amount", ""),
            "deal_stage":               pd.get("dealstage_label") or pd.get("dealstage", ""),
            "deal_closedate":           pd.get("closedate", ""),
            "deal_pipeline":            pd.get("pipeline_label") or pd.get("pipeline", ""),
            "deal_hubspot_owner_id":    pd.get("hubspot_owner_id", ""),
            "deal_createdate":          pd.get("createdate", ""),
            "deal_hs_lastmodifieddate": pd.get("hs_lastmodifieddate", ""),
            # Most-recent note
            "note_id":                  pn.get("note_id", ""),
            "note_hs_note_body":        pn.get("hs_note_body", ""),
            "note_hs_createdate":       pn.get("hs_createdate", ""),
            "note_hs_lastmodifieddate": pn.get("hs_lastmodifieddate", ""),
            "note_hubspot_owner_id":    pn.get("hubspot_owner_id", ""),
            "note_hs_timestamp":        pn.get("hs_timestamp", ""),
            "note_url":                 pn.get("url", ""),
            # Most-recent email
            "email_id":                 pe.get("email_id", ""),
            "email_hs_createdate":      pe.get("hs_createdate", ""),
            "email_hs_email_subject":   pe.get("hs_email_subject", ""),
            "email_hs_email_text":      pe.get("hs_email_text", ""),
            "email_hs_lastmodifieddate": pe.get("hs_lastmodifieddate", ""),
            "email_hs_object_id":       pe.get("email_id", ""),
            "email_hs_timestamp":       pe.get("hs_timestamp", ""),
            "email_hubspot_owner_id":   pe.get("hubspot_owner_id", ""),
            "email_url":                pe.get("url", ""),
            # Full deals list for modal — cheap, no large text columns.
            # Notes/emails full bodies are fetched separately, on demand,
            # via get_hubspot_company_details(company_id).
            "all_deals": [
                {
                    "deal_id":               d["deal_id"],
                    "deal_name":             d["dealname"],
                    "deal_amount":           d["amount"],
                    "deal_stage":            d.get("dealstage_label") or d["dealstage"],
                    "deal_closedate":        d["closedate"],
                    "deal_pipeline":         d.get("pipeline_label") or d["pipeline"],
                    "deal_hubspot_owner_id": d["hubspot_owner_id"],
                }
                for d in deals
            ],
            "all_contacts": [
                {
                    "contact_id":   c["contact_id"],
                    "first_name":   c["firstname"],
                    "last_name":    c["lastname"],
                    "email":        c["email"],
                    "contact_url":  c["url"],
                }
                for c in contacts
            ],
        })

    return rows


def get_hubspot_company_details(company_id: str) -> dict:
    """
    Full note/email bodies (all_notes, all_emails) for a single company, most
    recent first. Indexed on (company_id, hs_createdate) so this is a narrow
    lookup regardless of how large the notes/emails tables grow — unlike
    get_hubspot_flat_data(), which intentionally omits this per-company detail
    for every company at once. Reads from the read replica.
    """
    with _lock:
        conn = _get_replica_conn()
        notes = [dict(r) for r in conn.execute(
            "SELECT * FROM notes WHERE company_id = ? ORDER BY hs_createdate DESC", (company_id,)
        ).fetchall()]
        emails = [dict(r) for r in conn.execute(
            "SELECT * FROM emails WHERE company_id = ? ORDER BY hs_createdate DESC", (company_id,)
        ).fetchall()]

    return {
        "all_notes": [
            {
                "note_id":               n["note_id"],
                "note_hs_note_body":     n["hs_note_body"],
                "note_hs_createdate":    n["hs_createdate"],
                "note_hubspot_owner_id": n["hubspot_owner_id"],
                "note_url":              n["url"],
            }
            for n in notes
        ],
        "all_emails": [
            {
                "email_id":               e["email_id"],
                "email_hs_email_subject": e["hs_email_subject"],
                "email_hs_email_text":    e["hs_email_text"],
                "email_hs_createdate":    e["hs_createdate"],
                "email_hubspot_owner_id": e["hubspot_owner_id"],
                "email_url":              e["url"],
            }
            for e in emails
        ],
    }


def backfill_deal_labels(label_map: dict) -> int:
    """
    Back-fill dealstage_label and pipeline_label for every deal already in the DB
    using the given label_map { stage_id → { stageLabel, pipelineLabel } }.
    Returns the number of rows updated.
    """
    if not label_map:
        return 0
    with _lock:
        conn = _get_conn()
        rows = conn.execute("SELECT deal_id, dealstage FROM deals").fetchall()
        updated = 0
        for row in rows:
            lbl = label_map.get(row["dealstage"], {})
            stage_label = lbl.get("stageLabel", "")
            pipeline_label = lbl.get("pipelineLabel", "")
            if stage_label or pipeline_label:
                conn.execute(
                    "UPDATE deals SET dealstage_label=?, pipeline_label=? WHERE deal_id=?",
                    (stage_label, pipeline_label, row["deal_id"]),
                )
                updated += 1
        conn.commit()
    return updated


def get_all_company_ids() -> list[str]:
    """Every company_id already saved locally — used by backfill scripts."""
    with _lock:
        rows = _get_conn().execute("SELECT company_id FROM companies ORDER BY name").fetchall()
        return [r["company_id"] for r in rows]


def get_company_ids_with_emails() -> set[str]:
    """company_ids that already have at least one row in `emails` — used to skip
    already-backfilled companies."""
    with _lock:
        rows = _get_conn().execute("SELECT DISTINCT company_id FROM emails").fetchall()
        return {r["company_id"] for r in rows}


def get_company_count() -> int:
    with _lock:
        return _get_conn().execute("SELECT COUNT(*) FROM companies").fetchone()[0]


def get_deal_count() -> int:
    with _lock:
        return _get_conn().execute("SELECT COUNT(*) FROM deals").fetchone()[0]


def get_note_count() -> int:
    with _lock:
        return _get_conn().execute("SELECT COUNT(*) FROM notes").fetchone()[0]


def get_email_count() -> int:
    with _lock:
        return _get_conn().execute("SELECT COUNT(*) FROM emails").fetchone()[0]


def get_contact_count() -> int:
    with _lock:
        return _get_conn().execute("SELECT COUNT(*) FROM contacts").fetchone()[0]


# ─── Sync status ──────────────────────────────────────────────────────────────

def get_hubspot_sync_status() -> dict:
    return hs_kv_get("hubspot:sync_status") or {
        "lastSyncAt":   None,
        "dealCount":    0,
        "companyCount": 0,
        "noteCount":    0,
        "emailCount":   0,
        "contactCount": 0,
    }


def set_hubspot_sync_status(status: dict) -> None:
    hs_kv_set("hubspot:sync_status", status)


def get_pipeline_labels() -> dict:
    return hs_kv_get("hubspot:pipeline_labels") or {}


def set_pipeline_labels(labels: dict) -> None:
    hs_kv_set("hubspot:pipeline_labels", labels)
