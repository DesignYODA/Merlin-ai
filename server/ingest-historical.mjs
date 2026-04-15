/**
 * Historical Fireflies export ingest pipeline.
 *
 * Usage (CLI):
 *   node server/ingest-historical.mjs <path-to-historical_data-dir>
 *
 * Programmatic:
 *   import { fireflies_historical } from "./ingest-historical.mjs";
 *   await fireflies_historical("/abs/path/to/historical_data");
 */

import fs from "fs";
import path from "path";
import { upsertMeetings } from "./sqlite-api.mjs";
import { buildMeetingMetadata, classifyMeetingType } from "./apis.mjs";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Given a meeting folder, find a file matching a glob-style prefix pattern
 * and return its full path + the extracted ID segment.
 *
 * e.g. prefix="meeting-metadata-", suffix=".txt"
 * matches "meeting-metadata-7wE5Rlay1au0TttC.txt" → id="7wE5Rlay1au0TttC"
 */
function findFileByPattern(dir, prefix, suffix) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
      const id = entry.slice(prefix.length, -suffix.length);
      return { filePath: path.join(dir, entry), id };
    }
  }
  return null;
}

/**
 * Resolve the organizer / host email: prefer the first itilite.com address,
 * otherwise fall back to the first attendee.
 */
function resolveOrganizerEmail(attendees) {
  if (!Array.isArray(attendees) || attendees.length === 0) return null;
  const internal = attendees.find((e) => e && e.toLowerCase().includes("@itilite.com"));
  return internal || attendees[0] || null;
}

// ─────────────────────────────────────────────
// Per-meeting parser
// ─────────────────────────────────────────────

function parseMeetingFolder(meetingDir) {
  // 1. Locate the metadata file — its suffix gives us the meeting ID
  const metaMatch = findFileByPattern(meetingDir, "meeting-metadata-", ".txt");
  if (!metaMatch) {
    console.warn(`  [skip] No meeting-metadata file in ${path.basename(meetingDir)}`);
    return null;
  }

  const { filePath: metaPath, id } = metaMatch;

  const rawMeta = readJsonFile(metaPath);
  if (!rawMeta) {
    console.warn(`  [skip] Could not parse metadata in ${path.basename(meetingDir)}`);
    return null;
  }

  // 2. Read optional companion files
  const summaryMatch = findFileByPattern(meetingDir, "meeting-summary-", ".txt");
  const urlMatch = findFileByPattern(meetingDir, "meeting-url-", ".txt");

  const summaryText = summaryMatch ? readTextFile(summaryMatch.filePath) : null;
  const transcriptUrl = urlMatch ? readTextFile(urlMatch.filePath) : null;

  const speakerMeta = readJsonFile(path.join(meetingDir, "speaker-meta.json"));
  const transcriptData = readJsonFile(path.join(meetingDir, "transcript.json"));

  // 3. Build the normalised meeting object
  const attendees = Array.isArray(rawMeta.attendees) ? rawMeta.attendees.filter(Boolean) : [];
  const organizerEmail = resolveOrganizerEmail(attendees);

  const startMs = rawMeta.meetingStartTime
    ? new Date(rawMeta.meetingStartTime).getTime()
    : null;

  // duration from Fireflies export is in minutes; keep consistent with live sync
  const durationMinutes =
    typeof rawMeta.meetingDuration === "number" ? rawMeta.meetingDuration : null;

  const meeting = {
    id,
    title: rawMeta.meetingTitle || null,
    date: startMs,
    duration: durationMinutes,
    organizer_email: organizerEmail,
    host_email: organizerEmail,          // same source for historical data
    transcript_url: transcriptUrl || null,
    audio_url: null,                     // local files not served
    video_url: null,
    meeting_type: null,                  // filled below after classification
    participants: attendees,
    meeting_attendees: attendees.map((email) => ({ email })),
    user: null,
    summary: summaryText || null,        // raw AI summary block as a single string
    sentences: transcriptData?.data ?? [],
    metadata: null,                      // filled below after buildMeetingMetadata
    hubspot_deals: [],
    // store speaker mapping in metadata extension
    _speakerMeta: speakerMeta?.speakerMeta ?? null,
  };

  // 4. Derive meeting_type and metadata using the shared helpers
  meeting.meeting_type = classifyMeetingType(meeting);
  meeting.metadata = {
    ...buildMeetingMetadata(meeting),
    source: "historical_export",
    speakerMeta: meeting._speakerMeta,
    rawStartTime: rawMeta.meetingStartTime || null,
    rawEndTime: rawMeta.meetingEndTime || null,
  };
  delete meeting._speakerMeta;

  return meeting;
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

/**
 * Process all meetings inside a Fireflies historical export directory and
 * upsert them into the SQLite `meetings` table.
 *
 * @param {string} historicalDir
 *   Absolute (or CWD-relative) path to the root historical_data folder.
 *   The function descends one level into export-* sub-folders automatically.
 *
 * @param {{ batchSize?: number, onProgress?: (done: number, total: number) => void }} [opts]
 *
 * @returns {Promise<{ inserted: number, skipped: number, errors: string[] }>}
 */
export async function fireflies_historical(historicalDir, opts = {}) {
  const { batchSize = 20, onProgress } = opts;

  const absRoot = path.resolve(historicalDir);
  if (!fs.existsSync(absRoot)) {
    throw new Error(`Historical data directory not found: ${absRoot}`);
  }

  // Collect all meeting-level directories (two levels deep: root → export-* → meeting-*)
  const meetingDirs = [];
  const topEntries = fs.readdirSync(absRoot, { withFileTypes: true });

  for (const exportEntry of topEntries) {
    if (!exportEntry.isDirectory()) continue;
    const exportDir = path.join(absRoot, exportEntry.name);
    const meetingEntries = fs.readdirSync(exportDir, { withFileTypes: true });
    for (const meetingEntry of meetingEntries) {
      if (meetingEntry.isDirectory()) {
        meetingDirs.push(path.join(exportDir, meetingEntry.name));
      }
    }
  }

  console.log(`[historical] Found ${meetingDirs.length} meeting folder(s) in ${absRoot}`);

  let inserted = 0;
  let skipped = 0;
  const errors = [];
  const batch = [];

  const flush = () => {
    if (batch.length === 0) return;
    try {
      upsertMeetings(batch.splice(0));
    } catch (err) {
      errors.push(`Batch upsert failed: ${err.message}`);
    }
  };

  for (let i = 0; i < meetingDirs.length; i++) {
    const dir = meetingDirs[i];
    const label = path.basename(dir);

    try {
      const meeting = parseMeetingFolder(dir);
      if (!meeting) {
        skipped++;
      } else {
        batch.push(meeting);
        inserted++;
        console.log(`  [ok] ${label} → id=${meeting.id} type=${meeting.meeting_type}`);
      }
    } catch (err) {
      skipped++;
      errors.push(`${label}: ${err.message}`);
      console.error(`  [err] ${label}: ${err.message}`);
    }

    if (batch.length >= batchSize) flush();
    if (onProgress) onProgress(i + 1, meetingDirs.length);
  }

  flush(); // remainder

  console.log(
    `[historical] Done — inserted/updated: ${inserted}, skipped: ${skipped}, errors: ${errors.length}`,
  );

  return { inserted, skipped, errors };
}

// ─────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace("file:///", "").replace(/\//g, path.sep))) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node server/ingest-historical.mjs <path-to-historical_data>");
    process.exit(1);
  }

  fireflies_historical(dir, {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r  Progress: ${done}/${total}`);
      }
    },
  })
    .then(({ inserted, skipped, errors }) => {
      process.stdout.write("\n");
      if (errors.length) {
        console.error("Errors:");
        errors.forEach((e) => console.error("  •", e));
      }
      process.exit(errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Fatal:", err.message);
      process.exit(1);
    });
}
