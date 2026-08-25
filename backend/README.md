# Backend Architecture — Fireflies & HubSpot

FastAPI backend (`main.py` → `interface/interface.py` → `interface/handler.py`) that ingests
Fireflies.ai call transcripts and HubSpot CRM data into local SQLite, then serves them to the
frontend plus LLM-powered search/summarization on top.

For full per-table SQLite schema detail (ER diagrams, column-by-column notes), see
[`database_architecture.md`](./database_architecture.md) — this document focuses on the two
external integrations (Fireflies, HubSpot): how data gets **updated**, what it's **stored as**,
and what **endpoints** expose it.

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
  are logged and skipped, never written to `meetings`.
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

### Storage

All Fireflies data lives in **`data/merlin.sqlite`** (`db/merlin_db.py`), one `meetings` row per
call — see [`database_architecture.md` §1](./database_architecture.md#1-merlinsqlite--calls--product-insights)
for the full column list. Key points:
- Most Fireflies fields (`summary_*`, `sentences`, `metadata`, `meeting_attendees`) are stored as
  serialized JSON text, deserialized on read.
- `get_all_meetings_light()` (skips the large `sentences` column) is backed by an in-process cache
  invalidated on every write — per-process only, not shared across workers.
- `product_insights` (LLM-extracted product-request mentions per call) lives in the same DB file,
  joined to `meetings` via SQL `LEFT JOIN` in `get_all_product_insights()`.

---

## 2. HubSpot

### Updates (sync flow)

Same pattern as Fireflies — no backend scheduler, triggered by the frontend or manually.

| Function (`interface/handler.py`) | Endpoint | Behavior |
|---|---|---|
| `sync_hubspot()` | `POST /hubspot/sync` | Full sync: `get_hubspot_companies_enriched()` paginates **all** companies (100/page), collects every associated deal/note/email ID across them, resolves each by individual ID endpoint (concurrently, batched via `asyncio.gather`), attaches `resolved_deals`/`resolved_notes`/`resolved_emails` to each company, then `upsert_hubspot_data()` writes all three normalized tables + pipeline-stage label backfill. |
| `sync_hubspot_incremental()` | `POST /hubspot/sync-incremental` | Uses `get_companies_updated_since(since_ms)` — HubSpot `search` on `hs_lastmodifieddate >= since` for companies **and** deals **and** notes, then batch-resolves which companies own any changed deal/note (`/crm/v4/associations/{type}/companies/batch/read`) to catch companies whose own fields didn't change but a child object did. Falls back to a full `sync_hubspot()` if there's no prior `lastSyncAt`. |
| `get_hubspot_sync_status()` | `GET /hubspot/sync-status` | Cached status only (`dealCount`/`companyCount`/`noteCount`/`emailCount`/`lastSyncAt`), no live call. |
| `hubspot_reset()` | `POST /hubspot/reset` | `clear_hubspot_data()` — wipes `companies`/`deals`/`notes`/`emails` + cached sync/pipeline-label state. |
| `backfill_deal_labels()` | `POST /hubspot/backfill-labels` | Re-resolves `dealstage`/`pipeline` raw IDs → human labels for every deal already in the DB, using the cached pipeline label map — for when labels change without a full re-sync. |

Rate limiting: every HubSpot call goes through `apis/hubspot.py`'s `hubspot_request()`, which
self-throttles to **5 req/s** (`_hs_throttle()`, a sliding 1-second window) and retries once on
`429` respecting `Retry-After`. This is a client-side limiter, not configurable per-call.

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

### Storage

All HubSpot data lives in **`data/hubspot_data.sqlite`** (`db/hubspot.py`) — normalized
`companies` (1) → `deals` / `notes` / `emails` (many), all keyed by `company_id`. See
[`database_architecture.md` §4](./database_architecture.md#4-hubspot_datasqlite--hubspot-crm-mirror)
for the full ER diagram (currently missing the `emails` table — see note below).

```
companies (1) ──< deals   (company_id FK)
          (1) ──< notes   (company_id FK)
          (1) ──< emails  (company_id FK)
```

- **`emails`** (added alongside `deals`/`notes`, same shape): `email_id PK, company_id, hs_email_subject,
  hs_email_text, hs_createdate, hs_lastmodifieddate, hubspot_owner_id, hs_timestamp, synced_at` +
  `idx_emails_company` index. Upserted via `_EMAIL_UPSERT`, cleared in `clear_hubspot_data()`,
  counted via `get_email_count()`.
- **`get_hubspot_flat_data()`** — the read path behind `GET /hubspot/flat-data` — joins one row per
  company with its *primary* deal (latest by close/create date), *most-recent* note, and
  *most-recent* email flattened onto the row, plus `all_deals`/`all_notes`/`all_emails` arrays and
  `deal_ids`/`note_ids`/`email_ids` id-lists for the frontend's detail modal (Deals section, and the
  Notes/Emails pill switcher in `calls-library-page.tsx`).
- **`hs_kv`** — generic key/value table (mirrors `merlin.sqlite`'s `kv_store`), holding
  `hubspot:sync_status` and `hubspot:pipeline_labels` (raw stage/pipeline ID → label cache resolved
  from the Pipelines API).
- Legacy migration: `_migrate_old_flat_table()` one-time-copies a pre-existing flat `hubspot_data`
  table (old single-table design) into the normalized tables on schema init; safe to run repeatedly.

`schema.py`'s Pydantic models around HubSpot fall into two roles that don't map 1:1 onto the tables
above — see [`database_architecture.md` §5](./database_architecture.md#5-schemapy--pydantic-models)
for the full breakdown (API-shape mirrors like `HubspotDeals`/`HubspotNotes`/`HubspotEmail` vs. the
flattened read-model `HubspotData`).

---

## 3. API endpoints

Base URL: `http://localhost:3001` (or `SQLITE_SERVER_BASE`/deployment URL). All routes are
registered in `interface/interface.py`, tagged by domain.

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
| POST | `/analytics/process` | Recompute analytics from current `meetings` data |
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
