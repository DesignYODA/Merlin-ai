// Fireflies.ai Frontend Helpers and Types

// ---- Types ----
export interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // unix timestamp in ms
  duration: number; // seconds
  organizer_email: string;
  participants: string[];
  transcript_url: string;
  audio_url: string;
  summary?: {
    keywords: string[];
    action_items: string[];
    outline: string[];
    shorthand_bullet: string[];
    overview: string;
    bullet_gist: string | string[];
    short_summary: string;
  };
  sentences?: {
    index: number;
    text: string;
    raw_text: string;
    start_time: number;
    end_time: number;
    speaker_id: number;
    speaker_name: string;
  }[];
}

export interface FirefliesUser {
  user_id: string;
  email: string;
  name: string;
  minutes_consumed: number;
  is_admin?: boolean;
}

// ---- Helpers ----

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0 min";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

export function formatDate(timestamp: number): string {
  if (!timestamp) return "Unknown";
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateShort(timestamp: number): string {
  if (!timestamp) return "Unknown";
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Simple sentiment analysis based on keywords in the summary
export function analyzeSentiment(summary?: FirefliesTranscript["summary"]): "positive" | "neutral" | "negative" {
  if (!summary) return "neutral";
  const bulletGist = Array.isArray(summary.bullet_gist) ? summary.bullet_gist.join(" ") : (summary.bullet_gist || "");
  const text = `${summary.overview || ""} ${summary.short_summary || ""} ${bulletGist}`.toLowerCase();

  const positiveWords = ["great", "excellent", "happy", "excited", "love", "perfect", "amazing", "wonderful", "agreed", "successful", "positive", "pleased", "impressed", "opportunity"];
  const negativeWords = ["concern", "issue", "problem", "difficult", "frustrated", "unhappy", "disappointed", "risk", "blocker", "objection", "worried", "complaint", "unfortunately"];

  let score = 0;
  positiveWords.forEach((w) => { if (text.includes(w)) score++; });
  negativeWords.forEach((w) => { if (text.includes(w)) score--; });

  if (score > 0) return "positive";
  if (score < 0) return "negative";
  return "neutral";
}

// Extract AE name from organizer email
// AE domain — only itilite.com employees are recognized as AEs
export const AE_DOMAIN = "itilite.com";

// Check if an email/participant belongs to the AE domain
export function isAEEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  return email.trim().toLowerCase().endsWith(`@${AE_DOMAIN}`);
}

// Extract name from email (works for any email)
export function extractNameFromEmail(email: string): string {
  if (!email) return "Unknown";
  const name = email.split("@")[0].replace(/[._-]/g, " ");
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Extract AE name — only returns a real name if organizer is from itilite.com
export function extractAEName(email: string): string {
  if (!email) return "Unknown";
  return extractNameFromEmail(email);
}

// Extract all AE participants from a participants list (itilite.com domain only)
export function extractAEParticipants(participants: string[], organizerEmail?: string): string[] {
  const aeSet = new Set<string>();
  // Check organizer first
  if (organizerEmail && isAEEmail(organizerEmail)) {
    aeSet.add(extractNameFromEmail(organizerEmail));
  }
  // Check all participants
  for (const p of participants) {
    if (!p || typeof p !== "string") continue;
    if (isAEEmail(p.trim())) {
      aeSet.add(extractNameFromEmail(p.trim()));
    }
  }
  return [...aeSet];
}

// Extract external (non-AE) participants
export function extractExternalParticipants(participants: string[], organizerEmail?: string): string[] {
  const externals: string[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    if (!p || typeof p !== "string") continue;
    const trimmed = p.trim();
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (!isAEEmail(trimmed)) {
      externals.push(trimmed.includes("@") ? extractNameFromEmail(trimmed) : trimmed);
    }
  }
  return externals;
}

// Extract topics from keywords
export function extractTopics(summary?: FirefliesTranscript["summary"]): string[] {
  if (!summary?.keywords) return [];
  // Filter out empty/falsy values, trim whitespace, deduplicate
  const seen = new Set<string>();
  const result: string[] = [];
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