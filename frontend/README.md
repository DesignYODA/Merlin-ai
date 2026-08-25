# Glisseo AI

Sales call intelligence platform for Itilite. Ingests Fireflies.ai meeting transcripts, stores them locally in SQLite, and surfaces insights through an AI-powered conversational search interface and analytics dashboards.

Figma design: [Glisseo AI on Figma](https://www.figma.com/design/9y9HX5frsQHbKeF6jO6C7S/Merlin-AI)

---

## Quick start

```bash
cp .env.example .env      # fill in your API keys
npm install
npm run dev               # starts Vite (port 5173) + Express (port 3001) concurrently
```

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        Browser (Vite/React)                  │
│                                                              │
│  DashboardPage  TopicsPage  AskAiPage  ProductRequestsPage  │
│  InsightsPage                                                │
│          │                                                   │
│     DataContext (shared state, polling, normalization)       │
└──────────────────────────┬──────────────────────────────────┘
                           │ fetch (JSON/REST)
                           │ VITE_SQLITE_SERVER_BASE (default :3001)
┌──────────────────────────▼──────────────────────────────────┐
│                    Express Server  (server/app.mjs)          │
│                                                              │
│  /sync  /sync-new  /calls  /data  /product-requests/analyze │
│  /rewrite-query  /analytics  /hubspot/*  /ingest-historical │
│                                                              │
│  apis.mjs                 sqlite-api.mjs                    │
│  ├─ shouldAnalyzeMeeting  ├─ merlin.sqlite                  │
│  ├─ redactTranscript      │   kv_store · meetings           │
│  ├─ firefliesQuery        │   product_insights              │
│  ├─ callLLM               └─ analytical.sqlite              │
│  └─ hubspotRequest            summary · calls_by_day        │
│                               top_topics · top_aes          │
│                               call_action_items             │
│                               product_analysis              │
└──────────┬───────────────────────┬──────────────────────────┘
           │                       │
    Fireflies GraphQL API   Anthropic API (claude-haiku-4-5)
    (transcripts, summaries  │  Groq fallback (llama-3.1-70b)
     sentences, keywords)   └─ HubSpot CRM API (deals, contacts)
```

---

## Data flow

### 1 — Full sync (`POST /sync`)

```text
Fireflies API
  └─ fetchAllFirefliesTranscripts()   paginated, 50/page, up to 20 pages
        │
        ├─ shouldAnalyzeMeeting()     server-side filter (see Meeting filters)
        ├─ redactTranscript()         strip REDACTED_NAMES from text/speakers
        ├─ classifyMeetingType()      "external_call" | "internal_call"
        ├─ buildMeetingMetadata()     flags: is_hiring, is_internal, has_external
        └─ findHubSpotDealsForEmails() attach linked deal IDs via HubSpot CRM
              │
              └─ upsertMeetings()     → merlin.sqlite  meetings table
                    │
                    └─ processAnalytics() → analytical.sqlite  (background, non-blocking)
```

### 2 — Incremental sync (`POST /sync-new`)

Same pipeline but fetches only the latest 50 transcripts and inserts only IDs not already present in the DB. Used by the frontend auto-sync (runs every 5 minutes when the app is open).

### 3 — Historical import (`POST /ingest-historical`)

Reads a local Fireflies export directory (`historical_data/export-*/meeting-*/`) — no API call required. Parses `meeting-metadata-<id>.txt`, `meeting-summary-<id>.txt`, `transcript.json`, `speaker-meta.json` and upserts via the same `upsertMeetings` path.

### 4 — Frontend normalization

`DataContext` fetches `/data` on mount and re-fetches on every sync. Raw meeting rows are normalized into `NormalizedCall` objects:

```text
raw meeting row
  → formatDate / formatDuration
  → extractAEName (from organizer_email)
  → extractTopics  (summary.keywords + bullet_gist)
  → analyzeSentiment (keyword scoring on overview + short_summary)
  → participants list (from meeting_attendees)
  → shouldShowMeeting()   ← client-side guard (Layer 3, mirrors server rules)
```

`NormalizedCall` is the shape consumed by every page component and `ask-ai-functions.tsx`.

### 5 — Conversational search (`AskAiPage`)

```text
User query
  ├─ checkInputGuardrails()          block injection / SQL / secrets probes
  ├─ queryNeedsRewrite()?
  │     └─ POST /rewrite-query       LLM resolves pronouns using conversation history
  ├─ classifyPlannerIntent()         SEARCH | COUNT | TREND | FOLLOW_UP | DRILL_DOWN | CORRECTION
  │     ├─ FOLLOW_UP / CORRECTION → reuse memory.lastResultData (no new search)
  │     └─ new intent → parseQuery() + extractCoreTopic()
  ├─ executeSearch(calls, parsed)    pure client-side over NormalizedCall[]
  │     topic_ranking · topic_search · keyword_search · participant_query
  │     action_items · sentiment · duration · competitor · general_overview · text_search
  ├─ deepTranscriptSearch()          (optional) fetch /calls/:id for sentence timestamps
  ├─ generateResultSummary()         2–3 line conversational intro
  └─ formatResponse()                structured header + ResultRenderer (D3/table UI)
```

Conversation memory is kept in a `useRef` (not re-render state) and holds the last 5 Q&A turns, the last parsed query, and the last result data for follow-up context.

### 6 — Product mentions analysis (`POST /product-requests/analyze`)

```text
For each unanalyzed call:
  getFullCallWithTranscript()   fetch from DB or Fireflies if sentences missing
  buildTranscript()             sentences → "Speaker: text" or fall back to summary
  extractProductMentions()      callLLM → JSON array of 3-15 word product mentions
      └─ upsertProductInsights() → merlin.sqlite  product_insights
      └─ upsertProductAnalysis() → analytical.sqlite  product_analysis
```

---

## Meeting filters

Applied at three layers to keep the dataset clean:

| Layer | Where | Rules |
| ----- | ----- | ----- |
| Server ingest | `shouldAnalyzeMeeting()` in `apis.mjs` | Excludes: specified hosts (`EXCLUDED_HOSTS`), exact-match titles (`EXCLUDED_TITLES`), hiring keywords (`HIRING_KEYWORDS`), internal-only meetings (no external participants) |
| DB purge | `/sync` endpoint | Deletes previously stored meetings that no longer pass filters |
| Frontend guard | `shouldShowMeeting()` in `data-context.tsx` | Mirror of server rules; prevents excluded meetings appearing even if they leaked into the DB |

---

## Storage

### `data/merlin.sqlite`

| Table | Purpose |
| ----- | ------- |
| `meetings` | One row per transcript. Summary fields flattened to columns. `sentences` and `metadata` stored as JSON. |
| `product_insights` | LLM-extracted product mention arrays, one row per analyzed call. |
| `kv_store` | Key-value pairs: `sync:status`, legacy config keys. |

### `data/analytical.sqlite`

Pre-computed aggregates rebuilt on every sync. All tables are replaced in a single transaction.

| Table | Purpose |
| ----- | ------- |
| `summary` | Totals: calls, unique topics, active AEs, action items, sentiment counts. |
| `calls_by_day` | Call count per day-of-week (Mon–Sun). |
| `top_topics` | All keywords with mention counts, call ID arrays, and computed trend. |
| `top_aes` | AE email + call count ranking. |
| `call_action_items` | Flattened action item rows with source call metadata. |
| `product_analysis` | Mirror of `product_insights` for analytical queries. |

---

## Key source files

```text
server/
  app.mjs               Express routes and startup/shutdown
  apis.mjs              Fireflies GraphQL, HubSpot REST, LLM caller, meeting filter logic
  sqlite-api.mjs        SQLite schema, CRUD helpers for merlin.sqlite
  analytical-store.mjs  Schema + processAnalytics() for analytical.sqlite
  prompts.mjs           LLM system prompts (product extraction, query rewrite)
  config.mjs            Env var exports
  ingest-historical.mjs Local Fireflies export importer

src/app/components/
  data-context.tsx      Global state: fetch, normalize, auto-sync, HubSpot data
  ask-ai-page.tsx       Chat UI, search orchestration (query planner → search → render)
  dashboard-page.tsx    Overview stats and charts
  topics-page.tsx       D3 zoomable sunburst for keyword distribution
  insights-page.tsx     Analytics charts (calls by day, top AEs, action items)
  product-requests-page.tsx  Product mention analysis trigger + results table
  fireflies-api.ts      Normalization helpers (sentiment, topics, duration, date)

utils/
  ask-ai-functions.tsx  Search engine, query parser, planner, LLM rewrite, result renderers

src/app/constants/
  constant.ts           industryKeywords + productList used for sunburst categorization
```

---

## Environment variables

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `FIREFLIES_API_KEY` | Yes | Fetches transcripts from Fireflies GraphQL API |
| `ANTHROPIC_API_KEY` | Recommended | Primary LLM — query rewrite + product extraction (claude-haiku-4-5) |
| `GROQ_API_KEY` | Fallback | Used when Anthropic key is absent (llama-3.1-70b-versatile) |
| `HUBSPOT_API_KEY` | Optional | Attaches deal IDs to meetings; enables `/hubspot/*` routes |
| `VITE_SQLITE_SERVER_BASE` | Optional | Frontend → backend URL (default `http://localhost:3001`) |
| `SQLITE_PATH` | Optional | Path to main DB (default `./data/merlin.sqlite`) |
| `ANALYTICAL_PATH` | Optional | Path to analytical DB (default `./data/analytical.sqlite`) |
| `REDACTED_NAMES` | Optional | Comma-separated names stripped from transcripts/summaries |
| `EXCLUDED_HOSTS` | Optional | Organizer names to exclude from sync |
| `EXCLUDED_TITLES` | Optional | Exact meeting titles to exclude |
| `INTERNAL_DOMAINS` | Optional | Email domains treated as internal (default: itilite.com) |
| `HIRING_KEYWORDS` | Optional | Title keywords that flag a hiring/interview meeting |
| `FIREFLIES_FROM_DATE` | Optional | ISO date — only sync meetings after this date |
| `PORT` | Optional | Express server port (default `3001`) |
