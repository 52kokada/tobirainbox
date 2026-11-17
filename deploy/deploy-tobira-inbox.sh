#!/bin/bash
# Auto-deploy for TobirAInbox (own lock/log/state):
# pull origin/main -> npm ci if lockfile changed -> restart -> health gate -> rollback.
set -euo pipefail

REPO=/opt/tobira-inbox
LOG=/var/log/tobira-inbox-deploy.log
HEALTH_URL="http://127.0.0.1:8960/healthz"
LOCK=/var/lock/tobira-inbox-deploy.lock
STATE_DIR=/var/lib/tobira-inbox-deploy
FAILED_SHA_FILE="$STATE_DIR/last-failed-sha"
mkdir -p "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0
cd "$REPO"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(stamp)] $*" >> "$LOG"; }
health_ok() {
  for _ in 1 2 3 4 5 6; do
    sleep 2
    if curl -fsS -m 4 -o /dev/null "$HEALTH_URL"; then return 0; fi
  done
  return 1
}
as_app() { sudo -u tobira-inbox -H "$@"; }

as_app git fetch origin main >> "$LOG" 2>&1
LOCAL=$(as_app git rev-parse HEAD)
REMOTE=$(as_app git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0
if [ -f "$FAILED_SHA_FILE" ] && [ "$(cat "$FAILED_SHA_FILE")" = "$REMOTE" ]; then exit 0; fi

log "Deploying $LOCAL -> $REMOTE"
as_app git reset --hard origin/main >> "$LOG" 2>&1
if ! as_app git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json; then
  log "package-lock.json changed -> npm ci --omit=dev"
  as_app npm ci --omit=dev --silent >> "$LOG" 2>&1
fi
systemctl restart tobira-inbox
systemctl is-enabled --quiet tobira-inbox-worker 2>/dev/null && systemctl restart tobira-inbox-worker || true
if health_ok; then
  log "OK $REMOTE"
  rm -f "$FAILED_SHA_FILE"
else
  log "HEALTH FAILED on $REMOTE -> rolling back to $LOCAL"
  echo "$REMOTE" > "$FAILED_SHA_FILE"
  as_app git reset --hard "$LOCAL" >> "$LOG" 2>&1
  if ! as_app git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json; then as_app npm ci --omit=dev --silent >> "$LOG" 2>&1; fi
  systemctl restart tobira-inbox
fi
