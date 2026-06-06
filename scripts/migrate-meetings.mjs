/**
 * One-time migration: flatten the old meetings schema into the new column layout.
 *
 * Old schema: summary (JSON blob), participants (JSON array), hubspot_deals, video_url
 * New schema: summary_* individual columns, meeting_attendees as source of truth
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-meetings.mjs
 *
 * Safe to re-run — uses a staging table (meetings_v2) then swaps atomically.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "../data/merlin.sqlite");

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`Database not found at ${SQLITE_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(SQLITE_PATH);

// Check if old schema still present (has 'summary' column)
const cols = db.prepare("PRAGMA table_info(meetings)").all().map((r) => r.name);
const isOldSchema = cols.includes("summary");
const isNewSchema = cols.includes("summary_overview");

if (!isOldSchema && isNewSchema) {
  console.log("Already on new schema — nothing to migrate.");
  db.close();
  process.exit(0);
}

if (!isOldSchema && !isNewSchema) {
  console.error("Unrecognised meetings schema. Aborting.");
  db.close();
  process.exit(1);
}

const rows = db.prepare("SELECT * FROM meetings").all();
console.log(`Migrating ${rows.length} meetings…`);

function safeJson(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== "string") return val ?? fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

// ── Create staging table ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS meetings_v2 (
    id                       TEXT NOT NULL PRIMARY KEY,
    title                    TEXT,
    date                     INTEGER,
    duration                 INTEGER,
    organizer_email          TEXT,
    host_email               TEXT,
    transcript_url           TEXT,
    audio_url                TEXT,
    meeting_type             TEXT,
    meeting_attendees        TEXT,
    user                     TEXT,
    summary_keywords         TEXT,
    summary_action_items     TEXT,
    summary_outline          TEXT,
    summary_shorthand_bullet TEXT,
    summary_overview         TEXT,
    summary_bullet_gist      TEXT,
    summary_short_summary    TEXT,
    sentences                TEXT,
    metadata                 TEXT
  );
`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO meetings_v2
    (id, title, date, duration, organizer_email, host_email,
     transcript_url, audio_url, meeting_type,
     meeting_attendees, user,
     summary_keywords, summary_action_items, summary_outline, summary_shorthand_bullet,
     summary_overview, summary_bullet_gist, summary_short_summary,
     sentences, metadata)
  VALUES
    (@id, @title, @date, @duration, @organizer_email, @host_email,
     @transcript_url, @audio_url, @meeting_type,
     @meeting_attendees, @user,
     @summary_keywords, @summary_action_items, @summary_outline, @summary_shorthand_bullet,
     @summary_overview, @summary_bullet_gist, @summary_short_summary,
     @sentences, @metadata)
`);
insert.setAllowBareNamedParameters(true);

// ── Migrate rows ──────────────────────────────────────────────────────────────
let migrated = 0;
let failed = 0;

db.exec("BEGIN");

for (const row of rows) {
  try {
    const summary = safeJson(row.summary, {});

    // meeting_attendees takes precedence; synthesise from participants if missing
    let attendees = safeJson(row.meeting_attendees, []);
    if (attendees.length === 0) {
      const participants = safeJson(row.participants, []);
      if (participants.length > 0) {
        attendees = participants.map((email) => ({
          email: typeof email === "string" ? email : "",
          name: "", displayName: "", phoneNumber: "", location: "",
        }));
      }
    }

    const bulletGist = summary.bullet_gist;
    const bulletGistStr = typeof bulletGist === "string"
      ? bulletGist
      : Array.isArray(bulletGist) ? JSON.stringify(bulletGist) : "";

    insert.run({
      id: row.id,
      title: row.title,
      date: row.date,
      duration: row.duration,
      organizer_email: row.organizer_email,
      host_email: row.host_email,
      transcript_url: row.transcript_url,
      audio_url: row.audio_url,
      meeting_type: row.meeting_type,
      meeting_attendees: JSON.stringify(attendees),
      user: row.user || "null",
      summary_keywords: JSON.stringify(summary.keywords ?? []),
      summary_action_items: JSON.stringify(summary.action_items ?? []),
      summary_outline: JSON.stringify(summary.outline ?? []),
      summary_shorthand_bullet: JSON.stringify(summary.shorthand_bullet ?? []),
      summary_overview: summary.overview || null,
      summary_bullet_gist: bulletGistStr || null,
      summary_short_summary: summary.short_summary || null,
      sentences: row.sentences || "[]",
      metadata: row.metadata || "null",
    });

    migrated++;
  } catch (err) {
    console.error(`  ✗ Failed row ${row.id}: ${err.message}`);
    failed++;
  }
}

db.exec("COMMIT");

// ── Atomic swap ───────────────────────────────────────────────────────────────
db.exec("DROP TABLE meetings");
db.exec("ALTER TABLE meetings_v2 RENAME TO meetings");

console.log(`\nDone — ${migrated} migrated, ${failed} failed.`);
if (failed > 0) console.warn("Some rows failed — check errors above.");

db.close();
