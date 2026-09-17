"""
hubspot.py — MySQL access layer for the HubSpot side of glessio_master.

Normalized tables:
  hs_companies — one row per HubSpot company
  hs_deals     — one row per deal (company_id FK)
  hs_notes     — one row per note (company_id FK)
  hs_emails    — one row per email engagement (company_id FK)
  hs_contacts  — one row per contact (company_id FK)
  hs_kv        — small key/value store (sync status, cached pipeline labels)

Was SQLite (hubspot_data.sqlite: companies, deals, notes, emails, contacts, hs_kv) —
migrated to MySQL. Every public function keeps its original name/signature/return
shape so interface.py/handler.py need no changes. See backend/db/mysql_pool.py for
the shared connection pool and full schema DDL.
"""

import json
import time

from db.mysql_pool import get_connection
from config.logging_config import get_logger

logger = get_logger("merlin.db.hubspot")


def close_hubspot_db() -> None:
    """No per-module connection to close anymore — the shared pool (owned by
    mysql_pool.py) is closed once from main.py's lifespan. Kept as a no-op so
    any existing import of close_hubspot_db doesn't break."""
    pass


def replicate_to_read_replica() -> None:
    """No-op — MySQL's InnoDB engine handles concurrent reads-during-writes
    natively via MVCC, so the SQLite-only "copy to a second file so reads
    don't block on writes" trick this used to do is unnecessary. Kept as a
    no-op so handler.py's existing `await asyncio.to_thread(_replicate_hubspot)`
    call sites need no changes."""
    pass


# ─── KV helpers (hs_kv) ─────────────────────────────────────────────────────

def hs_kv_get(key: str):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT `value` FROM hs_kv WHERE `key` = %s", (key,))
        row = cur.fetchone()
        cur.close()
        return json.loads(row[0]) if row else None


def hs_kv_set(key: str, value) -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                "INSERT INTO hs_kv (`key`, `value`) VALUES (%s, %s)"
                " ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
                (key, json.dumps(value)),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


# ─── Upsert SQL ───────────────────────────────────────────────────────────────

_COMPANY_UPSERT = """
    INSERT INTO hs_companies (company_id, name, domain, phone, city, state, country,
        industry, createdate, lifecyclestage, hubspot_owner_id, hs_lastmodifieddate, synced_at)
    VALUES (%(company_id)s, %(name)s, %(domain)s, %(phone)s, %(city)s, %(state)s, %(country)s,
        %(industry)s, %(createdate)s, %(lifecyclestage)s, %(hubspot_owner_id)s, %(hs_lastmodifieddate)s, %(synced_at)s)
    ON DUPLICATE KEY UPDATE
        name=VALUES(name), domain=VALUES(domain), phone=VALUES(phone),
        city=VALUES(city), state=VALUES(state), country=VALUES(country),
        industry=VALUES(industry), createdate=VALUES(createdate),
        lifecyclestage=VALUES(lifecyclestage), hubspot_owner_id=VALUES(hubspot_owner_id),
        hs_lastmodifieddate=VALUES(hs_lastmodifieddate), synced_at=VALUES(synced_at)
"""

_DEAL_UPSERT = """
    INSERT INTO hs_deals (deal_id, company_id, dealname, amount, dealstage, dealstage_label,
        closedate, pipeline, pipeline_label, hubspot_owner_id, createdate, hs_lastmodifieddate, synced_at)
    VALUES (%(deal_id)s, %(company_id)s, %(dealname)s, %(amount)s, %(dealstage)s, %(dealstage_label)s,
        %(closedate)s, %(pipeline)s, %(pipeline_label)s, %(hubspot_owner_id)s, %(createdate)s, %(hs_lastmodifieddate)s, %(synced_at)s)
    ON DUPLICATE KEY UPDATE
        company_id=VALUES(company_id), dealname=VALUES(dealname), amount=VALUES(amount),
        dealstage=VALUES(dealstage), dealstage_label=VALUES(dealstage_label),
        closedate=VALUES(closedate), pipeline=VALUES(pipeline), pipeline_label=VALUES(pipeline_label),
        hubspot_owner_id=VALUES(hubspot_owner_id), createdate=VALUES(createdate),
        hs_lastmodifieddate=VALUES(hs_lastmodifieddate), synced_at=VALUES(synced_at)
"""

_NOTE_UPSERT = """
    INSERT INTO hs_notes (note_id, company_id, hs_note_body, hs_createdate, hs_lastmodifieddate,
        hubspot_owner_id, hs_timestamp, url, synced_at)
    VALUES (%(note_id)s, %(company_id)s, %(hs_note_body)s, %(hs_createdate)s, %(hs_lastmodifieddate)s,
        %(hubspot_owner_id)s, %(hs_timestamp)s, %(url)s, %(synced_at)s)
    ON DUPLICATE KEY UPDATE
        company_id=VALUES(company_id), hs_note_body=VALUES(hs_note_body),
        hs_createdate=VALUES(hs_createdate), hs_lastmodifieddate=VALUES(hs_lastmodifieddate),
        hubspot_owner_id=VALUES(hubspot_owner_id), hs_timestamp=VALUES(hs_timestamp),
        url=VALUES(url), synced_at=VALUES(synced_at)
"""

_EMAIL_UPSERT = """
    INSERT INTO hs_emails (email_id, company_id, hs_email_subject, hs_email_text, hs_createdate,
        hs_lastmodifieddate, hubspot_owner_id, hs_timestamp, url, synced_at)
    VALUES (%(email_id)s, %(company_id)s, %(hs_email_subject)s, %(hs_email_text)s, %(hs_createdate)s,
        %(hs_lastmodifieddate)s, %(hubspot_owner_id)s, %(hs_timestamp)s, %(url)s, %(synced_at)s)
    ON DUPLICATE KEY UPDATE
        company_id=VALUES(company_id), hs_email_subject=VALUES(hs_email_subject),
        hs_email_text=VALUES(hs_email_text), hs_createdate=VALUES(hs_createdate),
        hs_lastmodifieddate=VALUES(hs_lastmodifieddate), hubspot_owner_id=VALUES(hubspot_owner_id),
        hs_timestamp=VALUES(hs_timestamp), url=VALUES(url), synced_at=VALUES(synced_at)
"""

_CONTACT_UPSERT = """
    INSERT INTO hs_contacts (contact_id, company_id, firstname, lastname, email,
        createdate, lastmodifieddate, url, synced_at)
    VALUES (%(contact_id)s, %(company_id)s, %(firstname)s, %(lastname)s, %(email)s,
        %(createdate)s, %(lastmodifieddate)s, %(url)s, %(synced_at)s)
    ON DUPLICATE KEY UPDATE
        company_id=VALUES(company_id), firstname=VALUES(firstname), lastname=VALUES(lastname),
        email=VALUES(email), createdate=VALUES(createdate), lastmodifieddate=VALUES(lastmodifieddate),
        url=VALUES(url), synced_at=VALUES(synced_at)
"""


# ─── Write ────────────────────────────────────────────────────────────────────

def upsert_hubspot_data(companies: list[dict], label_map: dict | None = None) -> int:
    """
    Upsert enriched companies into normalized tables.
    Each company → hs_companies row + N hs_deals rows + M hs_notes rows.
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

    with get_connection() as conn:
        cur = conn.cursor()
        try:
            if co_rows:
                cur.executemany(_COMPANY_UPSERT, co_rows)
            if deal_rows:
                cur.executemany(_DEAL_UPSERT, deal_rows)
            if note_rows:
                cur.executemany(_NOTE_UPSERT, note_rows)
            if email_rows:
                cur.executemany(_EMAIL_UPSERT, email_rows)
            if contact_rows:
                cur.executemany(_CONTACT_UPSERT, contact_rows)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()

    return len(co_rows) + len(deal_rows) + len(note_rows) + len(email_rows) + len(contact_rows)


def clear_hubspot_data() -> None:
    """Delete all rows from the normalized tables and reset sync/pipeline state."""
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute("DELETE FROM hs_companies")
            cur.execute("DELETE FROM hs_deals")
            cur.execute("DELETE FROM hs_notes")
            cur.execute("DELETE FROM hs_emails")
            cur.execute("DELETE FROM hs_contacts")
            cur.execute("DELETE FROM hs_kv WHERE `key` = 'hubspot:sync_status'")
            cur.execute("DELETE FROM hs_kv WHERE `key` = 'hubspot:pipeline_labels'")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


# ─── Read ─────────────────────────────────────────────────────────────────────

def get_hubspot_db_entities() -> dict:
    """Return {companies, deals, notes, emails, contacts} shaped for the frontend
    (same as enriched API shape). No separate replica to read from on MySQL —
    reads the primary directly (see mysql_pool.py's module docstring)."""
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM hs_companies ORDER BY name")
        cos = cur.fetchall()
        cur.execute("SELECT * FROM hs_deals ORDER BY dealname")
        deals = cur.fetchall()
        cur.execute("SELECT * FROM hs_notes ORDER BY hs_createdate DESC")
        notes = cur.fetchall()
        cur.execute("SELECT * FROM hs_emails ORDER BY hs_createdate DESC")
        emails = cur.fetchall()
        cur.execute("SELECT * FROM hs_contacts ORDER BY lastname")
        contacts = cur.fetchall()
        cur.close()

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
    table alone can hold 100MB+ of text across thousands of rows, and loading
    all of it on every list request is slow. Full note/email bodies for one
    company are fetched on demand via get_hubspot_company_details() when its
    modal is opened. No separate replica to read from on MySQL — reads the
    primary directly (see mysql_pool.py's module docstring).
    """
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT * FROM hs_companies ORDER BY name")
        cos = cur.fetchall()

        # Id-only scans (no large text columns) — cheap, used for per-company counts.
        cur.execute("SELECT deal_id, company_id FROM hs_deals")
        deal_id_rows = cur.fetchall()
        cur.execute("SELECT note_id, company_id FROM hs_notes")
        note_id_rows = cur.fetchall()
        cur.execute("SELECT email_id, company_id FROM hs_emails")
        email_id_rows = cur.fetchall()
        cur.execute("SELECT contact_id, company_id FROM hs_contacts")
        contact_id_rows = cur.fetchall()

        cur.execute("SELECT * FROM hs_deals ORDER BY closedate DESC, createdate DESC")
        all_deals = cur.fetchall()
        cur.execute("SELECT * FROM hs_contacts ORDER BY lastname")
        all_contacts = cur.fetchall()

        # Exactly one (most recent) note/email row per company — ranked on the
        # narrow id+date columns first, then joined back for the winning rows
        # only, so the large hs_note_body/hs_email_text text is read for
        # ~1 row per company instead of every row in the table.
        cur.execute("""
            WITH ranked AS (
                SELECT note_id, ROW_NUMBER() OVER (
                    PARTITION BY company_id ORDER BY hs_createdate DESC
                ) AS rn
                FROM hs_notes
            )
            SELECT n.* FROM hs_notes n
            INNER JOIN ranked r ON r.note_id = n.note_id AND r.rn = 1
        """)
        primary_notes = cur.fetchall()
        cur.execute("""
            WITH ranked AS (
                SELECT email_id, ROW_NUMBER() OVER (
                    PARTITION BY company_id ORDER BY hs_createdate DESC
                ) AS rn
                FROM hs_emails
            )
            SELECT e.* FROM hs_emails e
            INNER JOIN ranked r ON r.email_id = e.email_id AND r.rn = 1
        """)
        primary_emails = cur.fetchall()
        cur.close()

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
    for every company at once.
    """
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute(
            "SELECT * FROM hs_notes WHERE company_id = %s ORDER BY hs_createdate DESC", (company_id,)
        )
        notes = cur.fetchall()
        cur.execute(
            "SELECT * FROM hs_emails WHERE company_id = %s ORDER BY hs_createdate DESC", (company_id,)
        )
        emails = cur.fetchall()
        cur.close()

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
    with get_connection() as conn:
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT deal_id, dealstage FROM hs_deals")
        rows = cur.fetchall()
        updated = 0
        try:
            for row in rows:
                lbl = label_map.get(row["dealstage"], {})
                stage_label = lbl.get("stageLabel", "")
                pipeline_label = lbl.get("pipelineLabel", "")
                if stage_label or pipeline_label:
                    cur.execute(
                        "UPDATE hs_deals SET dealstage_label=%s, pipeline_label=%s WHERE deal_id=%s",
                        (stage_label, pipeline_label, row["deal_id"]),
                    )
                    updated += 1
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
    return updated


def get_all_company_ids() -> list[str]:
    """Every company_id already saved locally — used by backfill scripts."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT company_id FROM hs_companies ORDER BY name")
        rows = cur.fetchall()
        cur.close()
        return [r[0] for r in rows]


def get_company_ids_with_emails() -> set[str]:
    """company_ids that already have at least one row in hs_emails — used to skip
    already-backfilled companies."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT company_id FROM hs_emails")
        rows = cur.fetchall()
        cur.close()
        return {r[0] for r in rows}


def get_company_count() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM hs_companies")
        n = cur.fetchone()[0]
        cur.close()
        return n


def get_deal_count() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM hs_deals")
        n = cur.fetchone()[0]
        cur.close()
        return n


def get_note_count() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM hs_notes")
        n = cur.fetchone()[0]
        cur.close()
        return n


def get_email_count() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM hs_emails")
        n = cur.fetchone()[0]
        cur.close()
        return n


def get_contact_count() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM hs_contacts")
        n = cur.fetchone()[0]
        cur.close()
        return n


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
