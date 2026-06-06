import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";

const ANALYTICAL_PATH =
  process.env.ANALYTICAL_PATH || path.join(process.cwd(), "data", "analytical.sqlite");

fs.mkdirSync(path.dirname(ANALYTICAL_PATH), { recursive: true });
const db = new DatabaseSync(ANALYTICAL_PATH);

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS summary (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_calls INTEGER NOT NULL DEFAULT 0,
    unique_topics INTEGER NOT NULL DEFAULT 0,
    active_aes INTEGER NOT NULL DEFAULT 0,
    total_action_items INTEGER NOT NULL DEFAULT 0,
    positive_sentiment INTEGER NOT NULL DEFAULT 0,
    neutral_sentiment INTEGER NOT NULL DEFAULT 0,
    negative_sentiment INTEGER NOT NULL DEFAULT 0,
    computed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS calls_by_day (
    day TEXT NOT NULL PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    computed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS top_topics (
    topic TEXT NOT NULL PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    call_ids TEXT NOT NULL DEFAULT '[]',
    computed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS top_aes (
    ae_name TEXT NOT NULL PRIMARY KEY,
    ae_email TEXT,
    call_count INTEGER NOT NULL DEFAULT 0,
    computed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_action_items (
    call_id TEXT NOT NULL PRIMARY KEY,
    call_title TEXT,
    ae_name TEXT,
    ae_email TEXT,
    date_ts INTEGER,
    transcript_url TEXT,
    action_items TEXT NOT NULL DEFAULT '[]',
    computed_at INTEGER NOT NULL
  );
`);

// product_analysis lives in analytical.sqlite — drop legacy sparse version and
// recreate with the full schema so it stays in sync with product_insights.
db.exec("DROP TABLE IF EXISTS product_analysis");
db.exec(`
  CREATE TABLE IF NOT EXISTS product_analysis (
    call_id        TEXT    NOT NULL PRIMARY KEY,
    call_title     TEXT,
    ae_name        TEXT,
    client_name    TEXT,
    date           TEXT,
    transcript_url TEXT,
    items          TEXT    NOT NULL DEFAULT '[]',
    analyzed_at    INTEGER NOT NULL
  );
`);

// ─────────────────────────────────────────────
// Helpers — ported from src/app/components/fireflies-api.ts
// ─────────────────────────────────────────────
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function extractAEName(email) {
  if (!email) return "Unknown";
  const name = email.split("@")[0].replace(/[._-]/g, " ");
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function analyzeSentiment(summary) {
  if (!summary) return "neutral";
  const bulletGist = Array.isArray(summary.bullet_gist)
    ? summary.bullet_gist.join(" ")
    : summary.bullet_gist || "";
  const text = `${summary.overview || ""} ${summary.short_summary || ""} ${bulletGist}`.toLowerCase();

  const positiveWords = ["great","excellent","happy","excited","love","perfect","amazing","wonderful","agreed","successful","positive","pleased","impressed","opportunity"];
  const negativeWords = ["concern","issue","problem","difficult","frustrated","unhappy","disappointed","risk","blocker","objection","worried","complaint","unfortunately"];

  let score = 0;
  positiveWords.forEach((w) => { if (text.includes(w)) score++; });
  negativeWords.forEach((w) => { if (text.includes(w)) score--; });

  if (score > 0) return "positive";
  if (score < 0) return "negative";
  return "neutral";
}

function extractTopics(summary) {
  if (!summary?.keywords) return [];
  const seen = new Set();
  const result = [];
  for (const kw of summary.keywords) {
    if (!kw || typeof kw !== "string") continue;
    const cleaned = kw.trim();
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(cleaned);
    if (result.length >= 5) break;
  }
  return result;
}

function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== "string") return val ?? fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

// ─────────────────────────────────────────────
// Core processing
// ─────────────────────────────────────────────

/**
 * Rebuild all analytical tables from the provided meetings array.
 * Pass the already-filtered (shouldAnalyzeMeeting) meetings from merlin.sqlite.
 *
 * @param {object[]} meetings
 */
export function processAnalytics(meetings) {
  const now = Date.now();

  // Per-meeting derived values
  const derived = meetings.map((m) => {
    const summary = safeJson(m.summary, null);
    return {
      id: m.id,
      title: m.title || "Untitled",
      aeEmail: m.organizer_email || "",
      aeName: extractAEName(m.organizer_email),
      dateTs: m.date || null,
      transcriptUrl: m.transcript_url || null,
      sentiment: analyzeSentiment(summary),
      topics: extractTopics(summary),
      actionItems: Array.isArray(safeJson(summary?.action_items, []))
        ? safeJson(summary?.action_items ?? null, [])
        : [],
    };
  });

  // ── summary ──────────────────────────────────────────────
  const totalCalls = derived.length;
  const allTopics = derived.flatMap((d) => d.topics.map((t) => t.toLowerCase()));
  const uniqueTopics = new Set(allTopics).size;
  const activeAEs = new Set(derived.map((d) => d.aeEmail).filter(Boolean)).size;
  const totalActionItems = derived.reduce((s, d) => s + d.actionItems.length, 0);
  const posSentiment = derived.filter((d) => d.sentiment === "positive").length;
  const neuSentiment = derived.filter((d) => d.sentiment === "neutral").length;
  const negSentiment = derived.filter((d) => d.sentiment === "negative").length;

  // ── calls_by_day ─────────────────────────────────────────
  const dayMap = Object.fromEntries(DAY_NAMES.map((d) => [d, 0]));
  for (const d of derived) {
    if (d.dateTs) dayMap[DAY_NAMES[new Date(d.dateTs).getDay()]]++;
  }

  // ── top_topics ───────────────────────────────────────────
  const topicMap = {};
  for (const d of derived) {
    for (const t of d.topics) {
      const key = t.toLowerCase();
      if (!topicMap[key]) topicMap[key] = { topic: t, count: 0, callIds: [] };
      topicMap[key].count++;
      topicMap[key].callIds.push(d.id);
    }
  }

  // ── top_aes ──────────────────────────────────────────────
  const aeMap = {};
  for (const d of derived) {
    if (!d.aeEmail) continue;
    if (!aeMap[d.aeName]) aeMap[d.aeName] = { aeName: d.aeName, aeEmail: d.aeEmail, callCount: 0 };
    aeMap[d.aeName].callCount++;
  }

  // ── Write to DB in a single transaction ─────────────────
  db.exec("BEGIN");
  try {
    // summary
    db.prepare(`
      INSERT INTO summary (id, total_calls, unique_topics, active_aes, total_action_items,
        positive_sentiment, neutral_sentiment, negative_sentiment, computed_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_calls = excluded.total_calls,
        unique_topics = excluded.unique_topics,
        active_aes = excluded.active_aes,
        total_action_items = excluded.total_action_items,
        positive_sentiment = excluded.positive_sentiment,
        neutral_sentiment = excluded.neutral_sentiment,
        negative_sentiment = excluded.negative_sentiment,
        computed_at = excluded.computed_at
    `).run(totalCalls, uniqueTopics, activeAEs, totalActionItems, posSentiment, neuSentiment, negSentiment, now);

    // calls_by_day
    const dayStmt = db.prepare(`
      INSERT INTO calls_by_day (day, count, computed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET count = excluded.count, computed_at = excluded.computed_at
    `);
    for (const [day, count] of Object.entries(dayMap)) dayStmt.run(day, count, now);

    // top_topics — full replace
    db.prepare("DELETE FROM top_topics").run();
    const topicStmt = db.prepare(`
      INSERT INTO top_topics (topic, count, call_ids, computed_at) VALUES (?, ?, ?, ?)
    `);
    for (const { topic, count, callIds } of Object.values(topicMap)) {
      topicStmt.run(topic, count, JSON.stringify(callIds), now);
    }

    // top_aes — full replace
    db.prepare("DELETE FROM top_aes").run();
    const aeStmt = db.prepare(`
      INSERT INTO top_aes (ae_name, ae_email, call_count, computed_at) VALUES (?, ?, ?, ?)
    `);
    for (const { aeName, aeEmail, callCount } of Object.values(aeMap)) {
      aeStmt.run(aeName, aeEmail, callCount, now);
    }

    // call_action_items — full replace
    db.prepare("DELETE FROM call_action_items").run();
    const aiStmt = db.prepare(`
      INSERT INTO call_action_items
        (call_id, call_title, ae_name, ae_email, date_ts, transcript_url, action_items, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of derived) {
      if (d.actionItems.length > 0) {
        aiStmt.run(d.id, d.title, d.aeName, d.aeEmail, d.dateTs, d.transcriptUrl, JSON.stringify(d.actionItems), now);
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  console.log(`[analytics] processed ${totalCalls} meetings — ${uniqueTopics} topics, ${activeAEs} AEs`);
  return { totalCalls, computedAt: now };
}

// ─────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────

export function getAnalytics() {
  const summaryRow = db.prepare("SELECT * FROM summary WHERE id = 1").get();
  const dayRows = db.prepare(
    "SELECT day, count FROM calls_by_day ORDER BY CASE day WHEN 'Mon' THEN 1 WHEN 'Tue' THEN 2 WHEN 'Wed' THEN 3 WHEN 'Thu' THEN 4 WHEN 'Fri' THEN 5 WHEN 'Sat' THEN 6 WHEN 'Sun' THEN 7 END"
  ).all();
  const topicRows = db.prepare("SELECT topic, count, call_ids FROM top_topics ORDER BY count DESC").all();
  const aeRows = db.prepare("SELECT ae_name, ae_email, call_count FROM top_aes ORDER BY call_count DESC").all();
  const aiRows = db.prepare(
    "SELECT call_id, call_title, ae_name, ae_email, date_ts, transcript_url, action_items FROM call_action_items ORDER BY date_ts DESC"
  ).all();

  return {
    summary: summaryRow
      ? {
          totalCalls: summaryRow.total_calls,
          uniqueTopics: summaryRow.unique_topics,
          activeAEs: summaryRow.active_aes,
          totalActionItems: summaryRow.total_action_items,
          positiveSentiment: summaryRow.positive_sentiment,
          neutralSentiment: summaryRow.neutral_sentiment,
          negativeSentiment: summaryRow.negative_sentiment,
        }
      : null,
    callsByDay: dayRows,
    topTopics: topicRows.map((r) => ({ topic: r.topic, count: r.count, callIds: JSON.parse(r.call_ids || "[]") })),
    topAEs: aeRows.map((r) => ({ aeName: r.ae_name, aeEmail: r.ae_email, callCount: r.call_count })),
    callActionItems: aiRows.map((r) => ({
      callId: r.call_id,
      callTitle: r.call_title,
      aeName: r.ae_name,
      aeEmail: r.ae_email,
      dateTs: r.date_ts,
      transcriptUrl: r.transcript_url,
      actionItems: JSON.parse(r.action_items || "[]"),
    })),
    computedAt: summaryRow?.computed_at ?? null,
  };
}

// ─────────────────────────────────────────────
// product_analysis helpers
// ─────────────────────────────────────────────

const _upsertProductAnalysisStmt = db.prepare(`
  INSERT INTO product_analysis
    (call_id, call_title, ae_name, client_name, date, transcript_url, items, analyzed_at)
  VALUES
    (@call_id, @call_title, @ae_name, @client_name, @date, @transcript_url, @items, @analyzed_at)
  ON CONFLICT(call_id) DO UPDATE SET
    call_title     = excluded.call_title,
    ae_name        = excluded.ae_name,
    client_name    = excluded.client_name,
    date           = excluded.date,
    transcript_url = excluded.transcript_url,
    items          = excluded.items,
    analyzed_at    = excluded.analyzed_at
`);
_upsertProductAnalysisStmt.setAllowBareNamedParameters(true);

/**
 * Upsert analyzed product mentions into analytical.sqlite.
 * Accepts the same shape as upsertProductInsights in sqlite-api.mjs.
 * @param {Array<{ call_id, call_title, ae_name, client_name, date, transcript_url, items: string[] }>} results
 */
export function upsertProductAnalysis(results) {
  const arr = Array.isArray(results) ? results : [results];
  if (arr.length === 0) return;
  const now = Date.now();
  db.exec("BEGIN");
  try {
    for (const r of arr) {
      _upsertProductAnalysisStmt.run({
        call_id:        r.call_id,
        call_title:     r.call_title ?? null,
        ae_name:        r.ae_name ?? null,
        client_name:    r.client_name ?? null,
        date:           r.date ?? null,
        transcript_url: r.transcript_url ?? null,
        items:          JSON.stringify(r.items ?? []),
        analyzed_at:    r.analyzed_at ?? now,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Return all product analysis rows, newest first. */
export function getProductAnalysis() {
  const rows = db.prepare(
    "SELECT * FROM product_analysis ORDER BY analyzed_at DESC"
  ).all();
  return rows.map((r) => ({ ...r, items: JSON.parse(r.items || "[]") }));
}

/** Delete product analysis rows by call_id, or all rows if ids omitted. */
export function deleteProductAnalysis(ids) {
  if (!ids || ids.length === 0) {
    db.prepare("DELETE FROM product_analysis").run();
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM product_analysis WHERE call_id IN (${placeholders})`
  ).run(...ids);
}

export function closeAnalyticalDb() {
  db.close();
}
