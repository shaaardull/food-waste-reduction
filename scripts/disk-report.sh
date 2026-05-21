#!/usr/bin/env bash
# scripts/disk-report.sh — read-only disk-usage diagnostic.
#
# Born out of live-smoke #2: MinIO refused writes because the host had only
# 2.1 GB free of 228 GB. This helper reports likely space hogs in $HOME plus
# system-managed caches, and suggests safe cleanup commands. It does NOT
# delete anything — copy the suggested command into your shell yourself.
#
# macOS-first (`du -sh`, `df -h`); the same commands work on Linux.

set -uo pipefail

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }
warn()   { printf "\033[33m%s\033[0m\n" "$*"; }
hr()     { printf '%.0s─' {1..72}; echo; }

bold "== Overall disk usage =="
df -h / 2>/dev/null || true
hr

bold "== Top space hogs in \$HOME (depth 2) =="
dim "(sorted descending; first column is human-readable size)"
# du -h -d 2 caps depth; sort -h sorts by human-readable size; tail+tac gives
# largest first. Skip the noisy "0B" lines.
du -h -d 2 "$HOME" 2>/dev/null \
  | grep -v '^[0-9]*B' \
  | sort -h \
  | tail -n 25 \
  | tac 2>/dev/null \
  || du -h -d 2 "$HOME" 2>/dev/null | sort -h | tail -n 25
hr

bold "== Known dev caches =="
for path in \
  "$HOME/Library/Caches" \
  "$HOME/Library/Application Support/Caches" \
  "$HOME/.cache" \
  "$HOME/.npm" \
  "$HOME/.pnpm-store" \
  "$HOME/.docker" \
  "$HOME/.colima" \
  "$HOME/.local/share/containers" \
  "$HOME/Library/Containers/com.docker.docker" \
  "/opt/homebrew/Caskroom" \
  "$(brew --cache 2>/dev/null || true)"
do
  if [[ -n "$path" && -d "$path" ]]; then
    size=$(du -sh "$path" 2>/dev/null | awk '{print $1}')
    printf "  %-60s %8s\n" "$path" "$size"
  fi
done
hr

bold "== Suggested safe cleanups (READ-ONLY — copy to run) =="
cat <<'TIPS'
  # Homebrew: removes old versions + downloads after every upgrade
  brew cleanup -s
  # npm cache (safe — npm re-downloads on demand)
  npm cache clean --force
  # pnpm cache (safe — pnpm re-downloads on demand)
  pnpm store prune
  # Docker images + build cache (only if Docker Desktop is running)
  docker system prune -af --volumes
  # Podman machine VM (only if you use podman, not Docker)
  podman machine ssh -- sudo dnf -y clean all
  podman system prune -af
  # macOS Caches dir (will be rebuilt on next launch of each app)
  rm -rf "$HOME/Library/Caches/"*
  # Old Xcode device support / DerivedData (if you've ever used Xcode)
  rm -rf "$HOME/Library/Developer/Xcode/DerivedData"
  rm -rf "$HOME/Library/Developer/Xcode/iOS DeviceSupport"
TIPS

hr
dim "Done. No files were modified."
