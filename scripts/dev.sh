#!/usr/bin/env bash
# scripts/dev.sh — one-command local dev runner.
#
# Boots vision + API + Celery + both Vite frontends in the background with
# prefixed log streams. Ctrl-C tears everything down cleanly.
#
# Prereqs (the script checks each, exits with a hint if anything's missing):
#   - PostgreSQL 15+ listening on :5432 with database `plate_clean` and user
#     `plate` / password `plate`. `brew services start postgresql@15`.
#     Run `python -m app.scripts.seed` once after migrations to seed demo data.
#   - Redis 7+ listening on :6379. `brew services start redis`.
#   - Python 3.11+ with the apps/api venv created (`cd apps/api && python3
#     -m venv .venv && pip install --ignore-requires-python -e ".[dev]"`).
#   - services/vision venv created (`cd services/vision && python3 -m venv
#     .venv && pip install --ignore-requires-python -e ".[dev]"`).
#   - pnpm 9+ on PATH (or at ~/.npm-global/bin/pnpm).
#
# The script downloads MinIO to ~/bin if it can't find it anywhere
# sensible. The MinIO data dir lives in ~/.plate-clean/minio-data so it
# survives /tmp purges.

set -uo pipefail

# Resolve repo root via $0 so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Colour helpers (only when stdout is a TTY).
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_MAGENTA=""; C_CYAN=""
fi

say()  { printf "%s\n" "${C_BOLD}$*${C_RESET}"; }
warn() { printf "%s\n" "${C_YELLOW}$*${C_RESET}" >&2; }
err()  { printf "%s\n" "${C_RED}$*${C_RESET}" >&2; }

# ─── Track child PIDs for clean teardown ──────────────────────────────────
declare -a CHILD_PIDS=()
MINIO_STARTED_BY_US=0

cleanup() {
  echo
  say "shutting down…"
  if [[ ${#CHILD_PIDS[@]} -gt 0 ]]; then
    # Send SIGTERM first; the wait loop below catches the exits.
    kill "${CHILD_PIDS[@]}" 2>/dev/null || true
    sleep 0.5
    # If anything's still up after the courtesy period, SIGKILL it.
    kill -9 "${CHILD_PIDS[@]}" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

# ─── Prereq checks ────────────────────────────────────────────────────────
say "Checking prerequisites…"

if ! command -v psql >/dev/null 2>&1; then
  err "  psql not found. Install Postgres 15+ (\`brew install postgresql@15\`) and start it."
  exit 1
fi

if ! PGPASSWORD=plate psql -h localhost -p 5432 -U plate -d plate_clean -c "SELECT 1" >/dev/null 2>&1; then
  err "  Postgres reachable on :5432 but couldn't open database \`plate_clean\` as user \`plate\`."
  err "  First-time setup: psql -h localhost -d postgres -c \"CREATE USER plate WITH PASSWORD 'plate' CREATEDB; CREATE DATABASE plate_clean OWNER plate;\""
  err "  Then run migrations + seed from apps/api: ./.venv/bin/alembic upgrade head && ./.venv/bin/python -m app.scripts.seed"
  exit 1
fi
printf "  ${C_GREEN}✓${C_RESET} Postgres reachable on :5432, db plate_clean ok\n"

REDIS_CLI=""
for r in redis-cli /opt/homebrew/opt/redis/bin/redis-cli /usr/local/bin/redis-cli; do
  if command -v "$r" >/dev/null 2>&1; then REDIS_CLI="$r"; break; fi
done
if [[ -z "$REDIS_CLI" ]] || ! "$REDIS_CLI" ping >/dev/null 2>&1; then
  err "  Redis not reachable on :6379. \`brew services start redis\`"
  exit 1
fi
printf "  ${C_GREEN}✓${C_RESET} Redis reachable on :6379\n"

# Python venvs
if [[ ! -x "$REPO_ROOT/apps/api/.venv/bin/uvicorn" ]]; then
  err "  apps/api/.venv missing. cd apps/api && python3 -m venv .venv && pip install --ignore-requires-python -e \".[dev]\""
  exit 1
fi
if [[ ! -x "$REPO_ROOT/services/vision/.venv/bin/uvicorn" ]]; then
  err "  services/vision/.venv missing. cd services/vision && python3 -m venv .venv && pip install --ignore-requires-python -e \".[dev]\""
  exit 1
fi
printf "  ${C_GREEN}✓${C_RESET} Python venvs found\n"

# pnpm
PNPM=""
for p in pnpm "$HOME/.npm-global/bin/pnpm" /opt/homebrew/bin/pnpm /usr/local/bin/pnpm; do
  if command -v "$p" >/dev/null 2>&1; then PNPM="$p"; break; fi
done
if [[ -z "$PNPM" ]]; then
  err "  pnpm not found. \`npm install -g pnpm\` (or \`corepack enable\`)."
  exit 1
fi
printf "  ${C_GREEN}✓${C_RESET} pnpm: %s\n" "$PNPM"

# MinIO binary
MINIO_BIN=""
for path in "$HOME/bin/minio" "/tmp/minio/minio" "/opt/homebrew/bin/minio" "/usr/local/bin/minio"; do
  if [[ -x "$path" ]]; then MINIO_BIN="$path"; break; fi
done
if [[ -z "$MINIO_BIN" ]]; then
  warn "  MinIO binary not found; downloading to ~/bin/minio…"
  mkdir -p "$HOME/bin"
  arch=$(uname -m); os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    darwin)
      url_arch=$([ "$arch" = "arm64" ] && echo "arm64" || echo "amd64")
      url="https://dl.min.io/server/minio/release/darwin-${url_arch}/minio" ;;
    linux)
      url="https://dl.min.io/server/minio/release/linux-amd64/minio" ;;
    *) err "  Unsupported OS: $os. Install MinIO manually."; exit 1 ;;
  esac
  if ! curl -sSL -o "$HOME/bin/minio" "$url"; then
    err "  download failed from $url"
    exit 1
  fi
  chmod +x "$HOME/bin/minio"
  MINIO_BIN="$HOME/bin/minio"
fi
printf "  ${C_GREEN}✓${C_RESET} MinIO: %s\n" "$MINIO_BIN"

# ─── Boot MinIO if it's not already up ────────────────────────────────────
if curl -sf http://127.0.0.1:9000/minio/health/ready >/dev/null 2>&1; then
  printf "  ${C_DIM}MinIO already running on :9000; reusing it${C_RESET}\n"
else
  say "Starting MinIO on :9000 (console :9001)…"
  mkdir -p "$HOME/.plate-clean/minio-data"
  MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
    "$MINIO_BIN" server "$HOME/.plate-clean/minio-data" \
      --address ':9000' --console-address ':9001' 2>&1 \
    | sed -u "s/^/${C_BLUE}[minio]${C_RESET} /" &
  CHILD_PIDS+=($!)
  MINIO_STARTED_BY_US=1
  until curl -sf http://127.0.0.1:9000/minio/health/ready >/dev/null 2>&1; do
    sleep 0.3
  done
  printf "  ${C_GREEN}✓${C_RESET} MinIO ready\n"
fi

# ─── Shared env for API + Celery worker ──────────────────────────────────
export NODE_ENV=development
export LOG_LEVEL=info
export DATABASE_URL_SYNC="postgresql://plate:plate@localhost:5432/plate_clean"
export DATABASE_URL="postgresql+asyncpg://plate:plate@localhost:5432/plate_clean"
export JWT_SECRET="dev_secret_change_me_min_32_chars_xxxx"
export REDIS_URL="redis://localhost:6379/0"
export S3_ENDPOINT="http://localhost:9000"
export S3_ACCESS_KEY="minioadmin"
export S3_SECRET_KEY="minioadmin"
export S3_BUCKET="plate-clean-images"
export USE_VISION_SERVICE="true"
export VISION_SERVICE_URL="http://localhost:8001"
export VISION_BACKEND="stub"
# Generous limits so demo-walks don't trip rate limits.
export MAX_SESSIONS_PER_USER_PER_DAY=20
export MAX_CAPTURES_PER_HOUR=50

# ─── Boot services/vision ────────────────────────────────────────────────
say "Starting services/vision on :8001…"
(
  cd "$REPO_ROOT/services/vision"
  ./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload 2>&1 \
    | sed -u "s/^/${C_CYAN}[vision]${C_RESET} /"
) &
CHILD_PIDS+=($!)

# ─── Boot apps/api ───────────────────────────────────────────────────────
say "Starting apps/api on :8000…"
(
  cd "$REPO_ROOT/apps/api"
  ./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload 2>&1 \
    | sed -u "s/^/${C_GREEN}[api]${C_RESET} /"
) &
CHILD_PIDS+=($!)

# ─── Boot Celery worker ──────────────────────────────────────────────────
say "Starting Celery worker…"
(
  cd "$REPO_ROOT/apps/api"
  ./.venv/bin/celery -A app.celery_app.celery_app worker --loglevel=info --concurrency=2 2>&1 \
    | sed -u "s/^/${C_MAGENTA}[celery]${C_RESET} /"
) &
CHILD_PIDS+=($!)

# ─── Boot frontends (Turbo, scoped to the two Vite apps only — apps/api is
# already up via its venv; running it again through pnpm dev would race on
# port 8000 with the system Python interpreter). ────────────────────────
say "Starting apps/web (:5173) + apps/dashboard (:5174)…"
(
  cd "$REPO_ROOT"
  "$PNPM" dev --filter @plate-clean/web --filter @plate-clean/dashboard 2>&1 \
    | sed -u "s/^/${C_YELLOW}[front]${C_RESET} /"
) &
CHILD_PIDS+=($!)

# ─── Print summary ───────────────────────────────────────────────────────
sleep 2
echo
say "All services launching. URLs:"
printf "  ${C_BOLD}Diner PWA${C_RESET}      http://localhost:5173\n"
printf "  ${C_BOLD}Staff dashboard${C_RESET} http://localhost:5174\n"
printf "  ${C_BOLD}API docs${C_RESET}        http://localhost:8000/docs\n"
printf "  ${C_BOLD}Vision docs${C_RESET}     http://localhost:8001/docs\n"
printf "  ${C_BOLD}MinIO console${C_RESET}   http://localhost:9001 ${C_DIM}(user: minioadmin / pass: minioadmin)${C_RESET}\n"
echo
printf "  ${C_DIM}Seeded logins (password: plate-clean-demo)${C_RESET}\n"
printf "    diner@example.com       (diner)\n"
printf "    staff1@example.com      (staff at Spice Trail)\n"
printf "    staff2@example.com      (staff at Konkan Kitchen)\n"
printf "    admin@example.com       (platform admin)\n"
echo
printf "  ${C_DIM}Ctrl-C to stop everything.${C_RESET}\n"
echo

# ─── Wait for any child to exit, then teardown ───────────────────────────
wait
