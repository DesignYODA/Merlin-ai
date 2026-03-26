import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

// =========================
// Config
// =========================
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "merlin.sqlite");

// =========================
// Ensure DB + Tables
// =========================
fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
const db = new Database(SQLITE_PATH);

// Generic KV store — still used for sync:status, config keys, etc.
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Structured meetings table — one column per Fireflies field
db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT NOT NULL PRIMARY KEY,
    title TEXT,
    date INTEGER,
    duration INTEGER,
    organizer_email TEXT,
    host_email TEXT,
    transcript_url TEXT,
    audio_url TEXT,
    video_url TEXT,
    meeting_type TEXT,
    participants TEXT,
    meeting_attendees TEXT,
    user TEXT,
    summary TEXT,
    sentences TEXT,
    metadata TEXT,
    hubspot_deals TEXT
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
  const tx = db.transaction((kvs) => {
    for (const { key, valueText } of kvs) insert.run(key, valueText);
  });
  const kvs = keys.map((k, i) => ({ key: k, valueText: JSON.stringify(values[i]) }));
  tx(kvs);
}

// =======================================
// Meetings table helpers
// =======================================

// JSON columns — these are stored as JSON strings in SQLite
const JSON_COLS = ["participants", "meeting_attendees", "user", "summary", "sentences", "metadata", "hubspot_deals"];

// All columns (order matters for the INSERT statement)
const ALL_COLS = [
  "id", "title", "date", "duration", "organizer_email", "host_email",
  "transcript_url", "audio_url", "video_url", "meeting_type",
  ...JSON_COLS,
];

function meetingToRow(m) {
  return {
    id: m.id || null,
    title: m.title || null,
    date: m.date ?? null,
    duration: m.duration ?? null,
    organizer_email: m.organizer_email || null,
    host_email: m.host_email || null,
    transcript_url: m.transcript_url || null,
    audio_url: m.audio_url || null,
    video_url: m.video_url || null,
    meeting_type: m.meeting_type || null,
    participants: JSON.stringify(m.participants ?? []),
    meeting_attendees: JSON.stringify(m.meeting_attendees ?? []),
    user: JSON.stringify(m.user ?? null),
    summary: JSON.stringify(m.summary ?? null),
    sentences: JSON.stringify(m.sentences ?? []),
    metadata: JSON.stringify(m.metadata ?? null),
    hubspot_deals: JSON.stringify(m.hubspot_deals ?? []),
  };
}

function rowToMeeting(row) {
  if (!row) return null;
  const obj = { ...row };
  for (const col of JSON_COLS) {
    if (typeof obj[col] === "string") {
      try { obj[col] = JSON.parse(obj[col]); } catch { obj[col] = null; }
    }
  }
  return obj;
}

const _upsertStmt = db.prepare(`
  INSERT INTO meetings (${ALL_COLS.join(", ")})
  VALUES (${ALL_COLS.map((c) => `@${c}`).join(", ")})
  ON CONFLICT(id) DO UPDATE SET
    ${ALL_COLS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(",\n    ")}
`);

/**
 * Upsert one or many meetings into the structured table in a single transaction.
 * @param {object|object[]} meetings - A single meeting object or an array of meeting objects.
 */
export function upsertMeetings(meetings) {
  const arr = Array.isArray(meetings) ? meetings : [meetings];
  if (arr.length === 0) return;
  const tx = db.transaction((rows) => {
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
