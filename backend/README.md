# Backend Architecture — Fireflies & HubSpot

FastAPI backend (`main.py` → `interface/interface.py` → `interface/handler.py`) that ingests
Fireflies.ai call transcripts and HubSpot CRM data into **MySQL** (`glessio_master`), then serves
them to the frontend plus LLM-powered search/summarization on top.

> **Storage migration note**: this backend was migrated off per-file SQLite databases onto a
> single MySQL database, `glessio_master` (see `db/mysql_pool.py` for the connection pool + full
> DDL). Every table was carried over 1:1 with the same columns, just renamed/re-homed into one
> database — `merlin_db.py`'s `meetings`/`product_insights`/`kv_store`/`auth`/`sessions` became
> `g_fireflies`/`g_product_insights`/`fireflies_kv`/`g_auth`/`g_sessions`; `hubspot.py`'s
> `companies`/`deals`/`notes`/`emails`/`contacts`/`hs_kv` became
> `hs_companies`/`hs_deals`/`hs_notes`/`hs_emails`/`hs_contacts`/`hs_kv`. Every public function in
> both files kept its exact name/signature, so `interface.py`/`handler.py` needed no changes — this
> was a storage-layer swap only. The old SQLite-file "read replica" trick (copying to a second file
> so frontend reads never blocked on an in-progress sync write) is gone entirely — MySQL's InnoDB
> engine handles that natively via MVCC.
>
> [`database_architecture.md`](./database_architecture.md) still describes the **pre-migration
> SQLite schema** and is now stale for storage details — table/column names below are current; that
> file has not been updated to match.
>
> **Scope**: only `merlin_db.py` (Fireflies) and `hubspot.py` (HubSpot) moved to MySQL. Chat
> sessions (`db/chat_db.py`) and analytics/product-analysis snapshots (`db/analytical_db.py`) are
> **unaffected** — they remain on their own local SQLite files, initialized/closed separately in
> `main.py`'s lifespan alongside the MySQL pool.
>
> **Config**: connection settings are env vars read in `config/config.py` — `MYSQL_HOST` (default
> `localhost`), `MYSQL_PORT` (`3306`), `MYSQL_USER` (`root`), `MYSQL_PASSWORD`, `MYSQL_DATABASE`
> (`glessio_master`), `MYSQL_POOL_SIZE` (`10`). The database itself is created on first connect if
> missing (`CREATE DATABASE IF NOT EXISTS`); table schema is likewise created idempotently on pool
> init (`mysql_pool.py`'s `_init_schema()`).
>
> **One-time data migration**: `backend/scripts/migrate_sqlite_to_mysql.py` copies existing rows
> from the old `merlin.sqlite`/`hubspot_data.sqlite` files into the new MySQL tables (1:1 by
> column, `INSERT ... ON DUPLICATE KEY UPDATE` — safe to re-run). Session tokens (`sessions`) are
> intentionally **not** migrated (short-lived; users just log in again post-cutover):
>
> ```bash
> python scripts/migrate_sqlite_to_mysql.py              # migrate everything
> python scripts/migrate_sqlite_to_mysql.py --only meetings   # one table only
> python scripts/migrate_sqlite_to_mysql.py --dry-run     # read source rows, don't write
> ```
>
> `backend/backfill_hubspot_urls.py` was also updated to read/write `hs_notes`/`hs_emails` via the
> MySQL pool instead of raw SQLite connections — same CLI usage as before, storage layer only.

This document focuses on the two external integrations (Fireflies, HubSpot): how data gets
**updated**, what it's **stored as**, what **limits/style** each API imposes, and what
**endpoints** expose it.

---

## 1. Fireflies

### Updates (sync flow)

There is **no server-side scheduler** — all syncing is triggered externally:
- The frontend (`data-context.tsx`) polls `POST /sync-new` on an interval (`setInterval`) while the
  app is open.
- `POST /sync` (full) and `POST /sync-new` (incremental) can also be called directly/manually.

| Function (`interface/handler.py`) | Endpoint | Behavior |
|---|---|---|
| `sync_all_calls()` | `POST /sync` | Paginates through **all** Fireflies transcripts (`fetch_all_fireflies_transcripts`, falls back to a single bounded query on failure), filters, and upserts every call. Meant for first-run / full-refresh. |
| `sync_new_calls()` | `POST /sync-new` | Fetches only the most recent 50 transcripts, diffs against `get_all_meeting_ids()` (id-only, cheap) to find new ones, upserts just those. This is the one the frontend polls. Degrades gracefully to a no-op success response if Fireflies is unreachable, using the last known `sync:status`. |
| `get_sync_status()` | `GET /sync-status` | Reads the cached `sync:status` KV entry — last sync time + counts, no live Fireflies call. |

Every fetched transcript passes through two filters before being stored:
- **`should_analyze_meeting(meeting)`** (`apis/fireflies.py`) — excludes meetings by organizer host
  (`EXCLUDED_HOSTS`) or title match (`EXCLUDED_TITLES`), e.g. internal standups. Excluded meetings
  are logged and skipped, never written to `g_fireflies`.
- **`classify_meeting_type(meeting)`** — tags each surviving meeting (e.g. external vs internal,
  based on whether any attendee's email domain differs from the organizer's / `EXCLUDED_HOSTS`).

Two more transforms happen at ingestion, not on every read:
- **`redact_transcript(t)`** — strips any sentence whose speaker name matches `REDACTED_NAMES`
  (compiled once into `_REDACT_RE`), and redacts matching names elsewhere in the free text.
- **`transcript` (plain text)** is derived from the `sentences` array once at write time
  (`_meeting_to_row()`), not recomputed on every read.

Individual-call operations, not part of the bulk sync:
- `GET /calls/{id}` → `get_full_call_with_transcript(call_id)` — fetches (or backs off to cached)
  full sentence-level transcript for one call.
- `POST /calls/{id}/ask` → `ask_call(call_id, question)` — builds an LLM context from that call's
  `summary.overview` + `summary.bullet_gist` + transcript text (truncated to ~12k chars) and
  answers a free-text question about it via Groq/Anthropic.
- The frontend also runs a **client-side background backfill** (`calls-library-page.tsx`,
  `backfillMissingTranscripts`) that calls `GET /calls/{id}` every 15 minutes for any call missing
  a transcript, capped at 25 per run — this is a frontend timer, not a backend job.
- `backend/backfill_transcripts.py` — standalone CLI script to bulk re-fetch/repair transcripts
  (e.g. `--fix-timestamps` for a legacy `[MM:SS]` format bug). Not run automatically.

### API limits & request style

- **Protocol**: GraphQL, single endpoint (`FIREFLIES_API_URL`), `POST` with an
  `Authorization: Bearer` header.
- **Pagination**: `skip`/`limit` on the `transcripts` query, page size 50, capped at
  `MAX_PAGES = 20` (`fetch_all_fireflies_transcripts()`) — a single full sync fetches at most
  1,000 transcripts per run; a larger backlog needs multiple sync runs or
  `backend/utils/ingest_historical.py`.
- **No proactive client-side throttle** (unlike HubSpot below) — requests go out as fast as the
  caller issues them. On `429` or `5xx`, `_fireflies_post_with_retry()` retries up to
  `_FIREFLIES_MAX_RETRIES = 3` times, honoring `Retry-After` if Fireflies sends one, otherwise
  backing off `1s → 2s → 4s`.
- **Injection safety**: single-transcript fetches (`fetch_transcript_by_id`) pass `call_id` as a
  GraphQL variable (`$id: String!`), never string-interpolated into the query text.
- **Timeouts**: 15s for single-transcript queries, up to 45s per page during a full sync
  (`per_page_timeout_ms`).

### Storage

All Fireflies data lives in **MySQL (`glessio_master`)** (`db/merlin_db.py`, via the shared
connection pool in `db/mysql_pool.py`) — one `g_fireflies` row per call (was `data/merlin.sqlite`'s
`meetings` table before the SQLite→MySQL migration; columns unchanged). Key points:
- Most Fireflies fields (`summary_*`, `sentences`, `metadata`, `meeting_attendees`) are stored as
  serialized JSON text, deserialized on read. `transcript`/`sentences` are `LONGTEXT` (up to 4GB —
  full call transcripts and their raw per-sentence data can be very large); other JSON/prose
  columns are `MEDIUMTEXT` (16MB).
- `get_all_meetings_light()` (skips the large `sentences` column) is backed by an in-process cache
  invalidated on every write — per-process only, not shared across workers.
- `g_product_insights` (LLM-extracted product-request mentions per call, was `product_insights`)
  lives in the same database, joined to `g_fireflies` via SQL `LEFT JOIN` in
  `get_all_product_insights()`.
- Generic key/value state (sync status, API key config — was `kv_store`) now lives in the
  `fireflies_kv` table.

---

## 2. HubSpot

### Updates (sync flow)

Same pattern as Fireflies — no backend scheduler, triggered by the frontend or manually.

| Function (`interface/handler.py`) | Endpoint | Behavior |
|---|---|---|
| `sync_hubspot()` | `POST /hubspot/sync` | Full sync: `get_hubspot_companies_enriched()` paginates **all** companies (100/page), collects every associated deal/note/email ID across them, resolves each by individual ID endpoint (concurrently, batched via `asyncio.gather`), attaches `resolved_deals`/`resolved_notes`/`resolved_emails` to each company, then `upsert_hubspot_data()` writes all three normalized tables + pipeline-stage label backfill. |
| `sync_hubspot_incremental()` | `POST /hubspot/sync-incremental` | Uses `get_companies_updated_since(since_ms)` — HubSpot `search` on `hs_lastmodifieddate >= since` for companies **and** deals **and** notes, then batch-resolves which companies own any changed deal/note (`/crm/v4/associations/{type}/companies/batch/read`) to catch companies whose own fields didn't change but a child object did. Falls back to a full `sync_hubspot()` if there's no prior `lastSyncAt`. |
| `get_hubspot_sync_status()` | `GET /hubspot/sync-status` | Cached status only (`dealCount`/`companyCount`/`noteCount`/`emailCount`/`lastSyncAt`), no live call. |
| `hubspot_reset()` | `POST /hubspot/reset` | `clear_hubspot_data()` — wipes `hs_companies`/`hs_deals`/`hs_notes`/`hs_emails`/`hs_contacts` + cached sync/pipeline-label state. |
| `backfill_deal_labels()` | `POST /hubspot/backfill-labels` | Re-resolves `dealstage`/`pipeline` raw IDs → human labels for every deal already in the DB, using the cached pipeline label map — for when labels change without a full re-sync. |

See "API limits & request style" below for rate limiting, retries, and the Search API's 10k
result cap.

**Known issue — intermittent SSL errors**: `merlin.log` occasionally shows
`SSLCertVerificationError: Hostname mismatch, certificate is not valid for 'api.hubapi.com'`
(also seen against `api.fireflies.ai`) — this reproduces across *both* unrelated external hosts, and
direct `openssl s_client`/`nslookup` checks against `api.hubapi.com` from the same network succeed
cleanly with a valid cert. That points to an intermittent network-layer TLS interception (corporate
proxy/security appliance) rather than a bug in `hubspot_request()`/`httpx` config — worth flagging to
network/IT if it recurs, since no client-side retry can fix a genuine hostname/cert mismatch.

**Email backfill for pre-existing companies**: companies synced *before* email resolution was
added won't have any `emails` rows until backfilled. `backend/backfill_hubspot_emails.py` walks
every locally-saved `company_id`, skips ones that already have emails saved (checked via
`get_company_ids_with_emails()`), and resolves+stores emails only for the rest:
```
python backfill_hubspot_emails.py              # only pending companies
python backfill_hubspot_emails.py --dry-run     # fetch but don't write
python backfill_hubspot_emails.py --limit 20    # cap this run
python backfill_hubspot_emails.py --force       # re-fetch even already-filled companies
```

### API limits & request style

- **Protocol**: REST, base `HUBSPOT_API_BASE` (default `https://api.hubapi.com`),
  `Authorization: Bearer` header (private-app token).
- **Client-side throttle**: every call goes through `hubspot_request()`, which self-limits to
  **`_HS_MAX_PER_SECOND = 10` requests/second** (sliding 1-second window, `_hs_throttle()`).
  HubSpot's own standard private-app limit is 100 requests/10s (10/s sustained), so this tracks
  the API's actual ceiling rather than an arbitrary lower number.
- **Retries**: on `429`, retries up to 3 times, honoring `Retry-After` (defaults to 1s if absent).
- **Connection reuse**: one shared, keep-alive `httpx.AsyncClient` (`max_connections=20`,
  `max_keepalive_connections=10`) across all calls, instead of a fresh TCP+TLS handshake per
  request — this fixed an earlier `ConnectTimeout` storm under concurrent bursts (see the comment
  in `apis/hubspot.py`).
- **Search API cap**: HubSpot's Search API hard-fails (`400`) once a single query's matched result
  set crosses **10,000 results** (`_SEARCH_RESULT_CAP`) — it cannot be paginated past that
  regardless of filters. The incremental sync avoids ever approaching this by always searching a
  small `since` window (or capping to the most-recent N changes — see
  `get_recently_updated_companies()`); the historical backfill script
  (`backfill_hubspot_companies.py`) walks a large range in fixed-size date chunks specifically to
  keep each chunk's result set well under the cap.
- **Batch association reads**: `/crm/v4/associations/{type}/companies/batch/read`, resolved in
  batches of 100 object IDs per request (`_batch_assoc_company_ids`).

### Storage

All HubSpot data lives in **MySQL (`glessio_master`)** (`db/hubspot.py`) — normalized
`hs_companies` (1) → `hs_deals` / `hs_notes` / `hs_emails` / `hs_contacts` (many), all keyed by
`company_id` (was `data/hubspot_data.sqlite`'s `companies`/`deals`/`notes`/`emails`/`contacts`
before the SQLite→MySQL migration; columns unchanged, tables just renamed with an `hs_` prefix).
See [`database_architecture.md` §4](./database_architecture.md#4-hubspot_datasqlite--hubspot-crm-mirror)
for the pre-migration ER diagram shape (table names there are stale — see the migration note at
the top of this document).

```
hs_companies (1) ──< hs_deals     (company_id FK)
             (1) ──< hs_notes     (company_id FK)
             (1) ──< hs_emails    (company_id FK)
             (1) ──< hs_contacts  (company_id FK)
```

- **`hs_notes`/`hs_emails`**: `hs_note_body`/`hs_email_text` (HubSpot's own free-text bodies, can
  be lengthy HTML) are `MEDIUMTEXT` (16MB). Upserted via `_NOTE_UPSERT`/`_EMAIL_UPSERT`, cleared in
  `clear_hubspot_data()`, counted via `get_note_count()`/`get_email_count()`.
- **`get_hubspot_flat_data()`** — the read path behind `GET /hubspot/flat-data` — joins one row per
  company with its *primary* deal (latest by close/create date), *most-recent* note, and
  *most-recent* email flattened onto the row, plus `all_deals`/`all_notes`/`all_emails` arrays and
  `deal_ids`/`note_ids`/`email_ids` id-lists for the frontend's detail modal (Deals section, and the
  Notes/Emails pill switcher in `calls-library-page.tsx`).
- **`hs_kv`** — generic key/value table (mirrors the fireflies side's `fireflies_kv`), holding
  `hubspot:sync_status` and `hubspot:pipeline_labels` (raw stage/pipeline ID → label cache resolved
  from the Pipelines API).

`schema.py`'s Pydantic models around HubSpot fall into two roles that don't map 1:1 onto the tables
above — see [`database_architecture.md` §5](./database_architecture.md#5-schemapy--pydantic-models)
for the full breakdown (API-shape mirrors like `HubspotDeals`/`HubspotNotes`/`HubspotEmail` vs. the
flattened read-model `HubspotData`).

---

## 3. API endpoints

Base URL: `http://localhost:3001` (or `SQLITE_SERVER_BASE`/deployment URL). All routes are
registered in `interface/interface.py`, tagged by domain.

Every route below except `/health` and `/auth/*` requires a valid session — a raw ASGI
middleware in `main.py` (`AuthGateMiddleware`) checks an `Authorization: Bearer <token>` header
against `g_auth`/`g_sessions` before any route runs, default-deny.

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/signup` | Create an account (`g_auth`) |
| POST | `/auth/login` | Verify credentials, issue a session token (`g_sessions`, 7-day TTL) |
| POST | `/auth/security-question` | Look up an account's security question (forgot-password flow) |
| POST | `/auth/reset-password` | Verify the security answer and set a new password |
| POST | `/auth/logout` | Invalidate the current session token |

### Config
| Method | Path | Purpose |
|---|---|---|
| GET | `/config/status` | Which API keys (Fireflies/Anthropic/Groq/HubSpot) are configured, and active LLM |
| POST | `/config/fireflies-api-key` | Set Fireflies API key |
| POST | `/config/groq-api-key` | Set Groq API key |
| POST | `/config/hubspot-api-key` | Set HubSpot API key |

### Calls (Fireflies)
| Method | Path | Purpose |
|---|---|---|
| GET | `/calls` | List all stored calls (light — no full transcript) |
| GET | `/calls/{call_id}` | Full call detail incl. sentence-level transcript |
| POST | `/calls/{call_id}/ask` | Ask a free-text question about one call (LLM) |
| DELETE | `/calls` | Delete all stored calls |

### Sync (Fireflies)
| Method | Path | Purpose |
|---|---|---|
| POST | `/sync` | Full Fireflies sync |
| POST | `/sync-new` | Incremental Fireflies sync (frontend polls this) |
| GET | `/sync-status` | Cached last-sync status |

### HubSpot
| Method | Path | Purpose |
|---|---|---|
| GET | `/hubspot/deals` | Raw HubSpot deals (paged passthrough) |
| GET | `/hubspot/companies` | Raw HubSpot companies (paged passthrough) |
| GET | `/hubspot/contacts` | Raw HubSpot contacts (paged passthrough) |
| GET | `/hubspot/notes` | Raw HubSpot notes (paged passthrough) |
| GET | `/hubspot/companies/enriched` | Companies + resolved deals/notes/emails, live from HubSpot (not the local DB) |
| GET | `/hubspot/pipelines/deals` | Deal pipelines + stages (labels) |
| POST | `/hubspot/sync` | Full HubSpot sync → local DB |
| POST | `/hubspot/sync-incremental` | Incremental HubSpot sync → local DB |
| POST | `/hubspot/reset` | Wipe local HubSpot tables + cached status |
| GET | `/hubspot/sync-status` | Cached last-sync status (counts incl. `emailCount`) |
| GET | `/hubspot/db-data` | Local DB contents, enriched-API shape (`{companies, deals, notes, emails}`) |
| GET | `/hubspot/flat-data` | Local DB, one flattened row per company (`{rows: HubspotData[]}`) — powers the frontend HubSpot table |
| GET | `/hubspot/db-pipeline-labels` | Cached stage/pipeline ID → label map |
| POST | `/hubspot/backfill-labels` | Re-resolve stage/pipeline labels for all existing deals |
| POST | `/hubspot/ask-row` | Ask a free-text question about one company (context + deals + notes, LLM) |
| POST | `/hubspot/notes/search` | Raw HubSpot notes search passthrough |
| POST | `/hubspot/emails/search` | Raw HubSpot emails search passthrough |

### Product requests
| Method | Path | Purpose |
|---|---|---|
| POST | `/product-requests/analyze` | Run LLM product-mention extraction over calls |
| GET | `/product-insights` | List stored product-request insights (joined with call info) |
| DELETE | `/product-insights` | Delete all stored product-request insights |

### Analytics
| Method | Path | Purpose |
|---|---|---|
| GET | `/analytics` | Pre-computed dashboard aggregates (summary, calls-by-day, top topics/AEs, action items) |
| POST | `/analytics/process` | Recompute analytics from current `g_fireflies` data |
| GET | `/analytics/product-analysis` | Per-call product-analysis snapshots |
| DELETE | `/analytics/product-analysis` | Delete product-analysis snapshots |

### Query / ingestion
| Method | Path | Purpose |
|---|---|---|
| POST | `/rewrite-query` | LLM query-rewrite for ambiguous/follow-up chat questions |
| POST | `/ingest-historical` | Ingest historical Fireflies export data (see `utils/ingest_historical.py`) |

### Chat sessions
| Method | Path | Purpose |
|---|---|---|
| POST | `/chat/user` | Upsert a user by email |
| GET | `/chat/sessions` | List a user's chat sessions |
| POST | `/chat/sessions` | Create a new chat session |
| GET | `/chat/sessions/{session_id}` | Get one session |
| PUT | `/chat/sessions/{session_id}` | Update a session's messages/summary |
| DELETE | `/chat/sessions/{session_id}` | Delete a session |
| POST | `/chat/sessions/{session_id}/title` | Generate a short LLM title for a session |
