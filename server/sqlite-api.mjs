import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

// =========================
// Config
// =========================
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "merlin.sqlite");

// =========================
// Ensure DB + Tables
// =========================
fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
const db = new DatabaseSync(SQLITE_PATH);

// Generic KV store — still used for sync:status, config keys, etc.
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Product insights cache — one row per analyzed call
db.exec(`
  CREATE TABLE IF NOT EXISTS product_insights (
    call_id TEXT NOT NULL PRIMARY KEY,
    call_title TEXT,
    ae_name TEXT,
    client_name TEXT,
    date TEXT,
    transcript_url TEXT,
    items TEXT NOT NULL,
    analyzed_at INTEGER NOT NULL
  );
`);

// Structured meetings table — one column per field, summary flattened
db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id                      TEXT NOT NULL PRIMARY KEY,
    title                   TEXT,
    date                    INTEGER,
    duration                INTEGER,
    organizer_email         TEXT,
    host_email              TEXT,
    transcript_url          TEXT,
    audio_url               TEXT,
    meeting_type            TEXT,
    meeting_attendees       TEXT,
    user                    TEXT,
    summary_keywords        TEXT,
    summary_action_items    TEXT,
    summary_outline         TEXT,
    summary_shorthand_bullet TEXT,
    summary_overview        TEXT,
    summary_bullet_gist     TEXT,
    summary_short_summary   TEXT,
    sentences               TEXT,
    metadata                TEXT
  );
`);

// ===========================
// KV helpers (unchanged API)
// ===========================
function kvGetRaw(key) {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key);
  return row ? row.value : null;
}

function kvSetRaw(key, valueText) {
  db.prepare(`
    INSERT INTO kv_store (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, valueText);
}

export function kvGet(key) {
  const raw = kvGetRaw(key);
  return raw ? JSON.parse(raw) : null;
}

export function kvSet(key, value) {
  kvSetRaw(key, JSON.stringify(value));
}

// export function getStoredApiKey(configKey) {
//   const v = kvGet(configKey);
//   if (!v) return null;
//   if (typeof v === "string") return v;
//   if (typeof v === "object" && v.apiKey && typeof v.apiKey === "string") return v.apiKey;
//   return null;
// }

export function kvDel(key) {
  db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
}

export function kvMdel(keys) {
  if (!keys.length) return;
  const placeholders = keys.map(() => "?").join(",");
  db.prepare(`DELETE FROM kv_store WHERE key IN (${placeholders})`).run(...keys);
}

export function kvGetByPrefix(prefix) {
  const like = `${prefix}%`;
  const rows = db.prepare("SELECT value FROM kv_store WHERE key LIKE ?").all(like);
  return rows.map((r) => JSON.parse(r.value));
}

export function kvMset(keys, values) {
  if (keys.length !== values.length) throw new Error("kvMset keys/values length mismatch");
  const insert = db.prepare(`
    INSERT INTO kv_store (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const tx = withTransaction((kvs) => {
    for (const { key, valueText } of kvs) insert.run(key, valueText);
  });
  const kvs = keys.map((k, i) => ({ key: k, valueText: JSON.stringify(values[i]) }));
  tx(kvs);
}

// =======================================
// Meetings table helpers
// =======================================

const ALL_COLS = [
  "id", "title", "date", "duration", "organizer_email", "host_email",
  "transcript_url", "audio_url", "meeting_type",
  "meeting_attendees", "user",
  "summary_keywords", "summary_action_items", "summary_outline", "summary_shorthand_bullet",
  "summary_overview", "summary_bullet_gist", "summary_short_summary",
  "sentences", "metadata",
];

function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== "string") return val ?? fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

function meetingToRow(m) {
  const summary = m.summary || {};

  // Ensure meeting_attendees is populated; fall back to synthesising from participants
  let attendees = m.meeting_attendees ?? [];
  if (attendees.length === 0 && Array.isArray(m.participants) && m.participants.length > 0) {
    attendees = m.participants.map((email) => ({
      email: typeof email === "string" ? email : "",
      name: "", displayName: "", phoneNumber: "", location: "",
    }));
  }

  const bulletGist = summary.bullet_gist;
  const bulletGistStr = typeof bulletGist === "string"
    ? bulletGist
    : Array.isArray(bulletGist) ? JSON.stringify(bulletGist) : "";

  return {
    id: m.id || null,
    title: m.title || null,
    date: m.date ?? null,
    duration: m.duration ?? null,
    organizer_email: m.organizer_email || null,
    host_email: m.host_email || null,
    transcript_url: m.transcript_url || null,
    audio_url: m.audio_url || null,
    meeting_type: m.meeting_type || null,
    meeting_attendees: JSON.stringify(attendees),
    user: JSON.stringify(m.user ?? null),
    summary_keywords: JSON.stringify(summary.keywords ?? []),
    summary_action_items: JSON.stringify(summary.action_items ?? []),
    summary_outline: JSON.stringify(summary.outline ?? []),
    summary_shorthand_bullet: JSON.stringify(summary.shorthand_bullet ?? []),
    summary_overview: summary.overview ?? null,
    summary_bullet_gist: bulletGistStr || null,
    summary_short_summary: summary.short_summary ?? null,
    sentences: JSON.stringify(m.sentences ?? []),
    metadata: JSON.stringify(m.metadata ?? null),
  };
}

function rowToMeeting(row) {
  if (!row) return null;
  const meetingAttendees = safeJsonParse(row.meeting_attendees, []);
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    duration: row.duration,
    organizer_email: row.organizer_email,
    host_email: row.host_email,
    transcript_url: row.transcript_url,
    audio_url: row.audio_url,
    meeting_type: row.meeting_type,
    meeting_attendees: meetingAttendees,
    // Derive participants (email list) from meeting_attendees for backward compat
    participants: meetingAttendees.map((a) => a.email).filter(Boolean),
    user: safeJsonParse(row.user, null),
    summary: {
      keywords: safeJsonParse(row.summary_keywords, []),
      action_items: safeJsonParse(row.summary_action_items, []),
      outline: safeJsonParse(row.summary_outline, []),
      shorthand_bullet: safeJsonParse(row.summary_shorthand_bullet, []),
      overview: row.summary_overview || "",
      bullet_gist: row.summary_bullet_gist || "",
      short_summary: row.summary_short_summary || "",
    },
    sentences: safeJsonParse(row.sentences, []),
    metadata: safeJsonParse(row.metadata, null),
  };
}

const _upsertStmt = db.prepare(`
  INSERT INTO meetings (${ALL_COLS.join(", ")})
  VALUES (${ALL_COLS.map((c) => `@${c}`).join(", ")})
  ON CONFLICT(id) DO UPDATE SET
    ${ALL_COLS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(",\n    ")}
`);
_upsertStmt.setAllowBareNamedParameters(true);

function withTransaction(fn) {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };
}

/**
 * Upsert one or many meetings into the structured table in a single transaction.
 * @param {object|object[]} meetings - A single meeting object or an array of meeting objects.
 */
export function upsertMeetings(meetings) {
  const arr = Array.isArray(meetings) ? meetings : [meetings];
  if (arr.length === 0) return;
  const tx = withTransaction((rows) => {
    for (const row of rows) _upsertStmt.run(row);
  });
  tx(arr.map(meetingToRow));
}

/**
 * Get all meetings from the structured table.
 * @returns {object[]}
 */
export function getAllMeetings() {
  const rows = db.prepare("SELECT * FROM meetings").all();
  return rows.map(rowToMeeting);
}

/**
 * Get a single meeting by its Fireflies transcript ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getMeetingById(id) {
  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
  return rowToMeeting(row);
}

/**
 * Delete one or many meetings by ID.
 * @param {string[]} ids
 */
export function deleteMeetings(ids) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM meetings WHERE id IN (${placeholders})`).run(...ids);
}

// =======================================
// Product insights helpers
// =======================================

const _upsertInsightStmt = db.prepare(`
  INSERT INTO product_insights (call_id, call_title, ae_name, client_name, date, transcript_url, items, analyzed_at)
  VALUES (@call_id, @call_title, @ae_name, @client_name, @date, @transcript_url, @items, @analyzed_at)
  ON CONFLICT(call_id) DO UPDATE SET
    call_title = excluded.call_title,
    ae_name = excluded.ae_name,
    client_name = excluded.client_name,
    date = excluded.date,
    transcript_url = excluded.transcript_url,
    items = excluded.items,
    analyzed_at = excluded.analyzed_at
`);
_upsertInsightStmt.setAllowBareNamedParameters(true);

/**
 * Upsert analyzed product insights for one or many calls.
 * @param {Array<{ call_id, call_title, ae_name, client_name, date, transcript_url, items: string[] }>} results
 */
export function upsertProductInsights(results) {
  const arr = Array.isArray(results) ? results : [results];
  if (arr.length === 0) return;
  const now = Date.now();
  const tx = withTransaction((rows) => {
    for (const row of rows) _upsertInsightStmt.run(row);
  });
  tx(arr.map((r) => ({ ...r, items: JSON.stringify(r.items ?? []), analyzed_at: now })));
}

/**
 * Return all cached product insights, newest analyzed first.
 * @returns {Array}
 */
export function getAllProductInsights() {
  const rows = db.prepare("SELECT * FROM product_insights ORDER BY analyzed_at DESC").all();
  return rows.map((r) => ({ ...r, items: JSON.parse(r.items || "[]") }));
}

/**
 * Delete cached insights for the given call IDs (or all if ids is empty/omitted).
 * @param {string[]} [ids]
 */
export function deleteProductInsights(ids) {
  if (!ids || ids.length === 0) {
    db.prepare("DELETE FROM product_insights").run();
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM product_insights WHERE call_id IN (${placeholders})`).run(...ids);
}

export function closeDb() {
  db.close();
}
