const FIREFLIES_API_URL = process.env.FIREFLIES_API_URL;
const FIREFLIES_FROM_DATE = process.env.FIREFLIES_FROM_DATE;
const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE;
const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const PORT = Number(process.env.PORT || 3001);

// Comma-separated lists from env — fall back to empty arrays so the app
// works out-of-the-box without redaction if the vars are unset.
function parseList(envVar) {
  return (envVar || "").split(",").map((s) => s.trim()).filter(Boolean);
}

const REDACTED_NAMES = parseList(process.env.REDACTED_NAMES);
const EXCLUDED_HOSTS = parseList(process.env.EXCLUDED_HOSTS);
const EXCLUDED_TITLES = parseList(process.env.EXCLUDED_TITLES);
const INTERNAL_DOMAINS = parseList(process.env.INTERNAL_DOMAINS);
const HIRING_KEYWORDS = parseList(process.env.HIRING_KEYWORDS);

export {
    FIREFLIES_API_URL,
    FIREFLIES_FROM_DATE,
    HUBSPOT_API_BASE,
    FIREFLIES_API_KEY,
    GROQ_API_KEY,
    ANTHROPIC_API_KEY,
    HUBSPOT_API_KEY,
    PORT,
    REDACTED_NAMES,
    EXCLUDED_HOSTS,
    EXCLUDED_TITLES,
    INTERNAL_DOMAINS,
    HIRING_KEYWORDS,
}