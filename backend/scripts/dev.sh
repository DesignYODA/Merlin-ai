#!/usr/bin/env bash
# Start the SQLite API server and the Vite frontend together.
# Usage: ./scripts/dev.sh   or   bash scripts/dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Optional: load .env so FIREFLIES_API_KEY / GROQ_API_KEY / VITE_* are available
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "[dev] Starting API server (server/app.mjs)..."
node server/app.mjs &
SQLITE_PID=$!

cleanup() {
  echo ""
  echo "[dev] Stopping API server (pid ${SQLITE_PID})..."
  kill "${SQLITE_PID}" 2>/dev/null || true
  wait "${SQLITE_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[dev] Starting Vite frontend..."
exec npx vite
