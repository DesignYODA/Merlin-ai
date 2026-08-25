"""
ingest_historical.py — Fireflies historical export ingest pipeline.
Mirrors ingest-historical.mjs.
"""

import json
import os
from pathlib import Path

from db.merlin_db import upsert_meetings
from apis.fireflies import classify_meeting_type, build_meeting_metadata


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _read_json(file_path: str) -> dict | None:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _read_text(file_path: str) -> str | None:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return None


def _find_file_by_pattern(directory: str, prefix: str, suffix: str) -> dict | None:
    """Find a file matching prefix+id+suffix, return {'file_path': ..., 'id': ...}."""
    try:
        for entry in os.listdir(directory):
            if entry.startswith(prefix) and entry.endswith(suffix):
                meeting_id = entry[len(prefix):-len(suffix)]
                return {"file_path": os.path.join(directory, entry), "id": meeting_id}
    except Exception:
        pass
    return None


def _resolve_organizer_email(attendees: list[str]) -> str | None:
    if not attendees:
        return None
    internal = next((e for e in attendees if e and "@itilite.com" in e.lower()), None)
    return internal or attendees[0]


def _parse_meeting_folder(meeting_dir: str) -> dict | None:
    meta_match = _find_file_by_pattern(meeting_dir, "meeting-metadata-", ".txt")
    if not meta_match:
        print(f"  [skip] No meeting-metadata file in {os.path.basename(meeting_dir)}")
        return None

    raw_meta = _read_json(meta_match["file_path"])
    if not raw_meta:
        print(f"  [skip] Could not parse metadata in {os.path.basename(meeting_dir)}")
        return None

    meeting_id = meta_match["id"]

    summary_match = _find_file_by_pattern(meeting_dir, "meeting-summary-", ".txt")
    url_match = _find_file_by_pattern(meeting_dir, "meeting-url-", ".txt")

    summary_text = _read_text(summary_match["file_path"]) if summary_match else None
    transcript_url = _read_text(url_match["file_path"]) if url_match else None

    speaker_meta = _read_json(os.path.join(meeting_dir, "speaker-meta.json"))
    transcript_data = _read_json(os.path.join(meeting_dir, "transcript.json"))

    attendees = [a for a in (raw_meta.get("attendees") or []) if a]
    organizer_email = _resolve_organizer_email(attendees)

    start_ms = None
    if raw_meta.get("meetingStartTime"):
        from datetime import datetime
        try:
            start_ms = int(datetime.fromisoformat(raw_meta["meetingStartTime"].replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            pass

    duration_minutes = raw_meta.get("meetingDuration") if isinstance(raw_meta.get("meetingDuration"), (int, float)) else None

    meeting: dict = {
        "id":              meeting_id,
        "title":           raw_meta.get("meetingTitle"),
        "date":            start_ms,
        "duration":        duration_minutes,
        "organizer_email": organizer_email,
        "host_email":      organizer_email,
        "transcript_url":  transcript_url,
        "audio_url":       None,
        "video_url":       None,
        "meeting_type":    None,
        "participants":    attendees,
        "meeting_attendees": [{"email": e} for e in attendees],
        "user":            None,
        "summary":         summary_text,
        "sentences":       (transcript_data.get("data") if transcript_data else None) or [],
        "metadata":        None,
        "hubspot_deals":   [],
    }

    meeting["meeting_type"] = classify_meeting_type(meeting)
    speaker_meta_val = (speaker_meta.get("speakerMeta") if speaker_meta else None)
    meeting["metadata"] = {
        **build_meeting_metadata(meeting),
        "source":       "historical_export",
        "speakerMeta":  speaker_meta_val,
        "rawStartTime": raw_meta.get("meetingStartTime"),
        "rawEndTime":   raw_meta.get("meetingEndTime"),
    }

    return meeting


# ─── Main entry ───────────────────────────────────────────────────────────────

async def fireflies_historical(
    historical_dir: str,
    *,
    batch_size: int = 20,
    on_progress=None,
) -> dict:
    abs_root = os.path.abspath(historical_dir)
    if not os.path.exists(abs_root):
        raise FileNotFoundError(f"Historical data directory not found: {abs_root}")

    meeting_dirs: list[str] = []
    for export_entry in os.scandir(abs_root):
        if not export_entry.is_dir():
            continue
        for meeting_entry in os.scandir(export_entry.path):
            if meeting_entry.is_dir():
                meeting_dirs.append(meeting_entry.path)

    print(f"[historical] Found {len(meeting_dirs)} meeting folder(s) in {abs_root}")

    inserted = 0
    skipped  = 0
    errors:  list[str] = []
    batch:   list[dict] = []

    def flush():
        nonlocal errors
        if not batch:
            return
        try:
            upsert_meetings(batch[:])
            batch.clear()
        except Exception as err:
            errors.append(f"Batch upsert failed: {err}")
            batch.clear()

    for i, d in enumerate(meeting_dirs):
        label = os.path.basename(d)
        try:
            meeting = _parse_meeting_folder(d)
            if not meeting:
                skipped += 1
            else:
                batch.append(meeting)
                inserted += 1
                print(f"  [ok] {label} → id={meeting['id']} type={meeting['meeting_type']}")
        except Exception as err:
            skipped += 1
            errors.append(f"{label}: {err}")
            print(f"  [err] {label}: {err}")

        if len(batch) >= batch_size:
            flush()
        if on_progress:
            on_progress(i + 1, len(meeting_dirs))

    flush()

    print(f"[historical] Done — inserted/updated: {inserted}, skipped: {skipped}, errors: {len(errors)}")
    return {"inserted": inserted, "skipped": skipped, "errors": errors}
