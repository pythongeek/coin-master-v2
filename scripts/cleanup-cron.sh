#!/usr/bin/env bash
# =============================================================================
#  cleanup-cron.sh - nightly disk cleanup
# =============================================================================
#  Runs daily at 04:00 via cron. Cleans:
#    - Docker build cache (reclaimable layer cache)
#    - Docker dangling images/containers/networks
#    - npm cache (root + per-profile)
#    - Hermes browser/chrome/snyk/puppeteer caches (rebuilt on demand)
#    - Old webui session transcripts (keep most recent 5)
#    - Old log files (>7 days, >10MB)
#    - Truncate very large log files (>100MB)
#
#  Logs to /var/log/cryptoflip-cleanup.log with timestamps.
#  Designed to be safe to run repeatedly (idempotent).
#
#  Install: see /root/DISK-MAINTENANCE.md
# =============================================================================

set -uo pipefail

LOG="/var/log/cryptoflip-cleanup.log"
mkdir -p "$(dirname "$LOG")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

log "=== cleanup-cron.sh started ==="

# ----------------------------------------------------------------------
# 1. Docker build cache (largest single source of reclaimable space)
# ----------------------------------------------------------------------
log "Pruning Docker build cache..."
BEFORE=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || echo "0")
docker builder prune -af --filter "until=168h" 2>&1 | grep -E "Total|reclaim" | tail -2 | while read line; do
    log "  docker: $line"
done

# ----------------------------------------------------------------------
# 2. Docker dangling resources (stopped containers, unused images, etc)
# ----------------------------------------------------------------------
log "Pruning Docker dangling resources..."
docker system prune -f 2>&1 | grep -E "Total|reclaim" | tail -2 | while read line; do
    log "  docker: $line"
done

# ----------------------------------------------------------------------
# 3. npm cache
# ----------------------------------------------------------------------
log "Cleaning npm cache..."
npm cache clean --force 2>&1 | tail -1 | while read line; do
    log "  npm: $line"
done

# Hermes per-profile npm cache (different from /root/.npm)
if [[ -d /root/.hermes/profiles/lean-dev/home/.npm ]]; then
    SIZE_BEFORE=$(du -sh /root/.hermes/profiles/lean-dev/home/.npm 2>/dev/null | cut -f1)
    rm -rf /root/.hermes/profiles/lean-dev/home/.npm/_cacache 2>/dev/null
    log "  hermes npm: cleared _cacache (was $SIZE_BEFORE, rebuilt on next npm install)"
fi

# ----------------------------------------------------------------------
# 4. Hermes browser caches (Chrome, Puppeteer, Snyk, etc)
# ----------------------------------------------------------------------
log "Cleaning Hermes browser caches..."
for cache in puppeteer chrome snyk pip node-gyp; do
    DIR="/root/.hermes/profiles/lean-dev/home/.cache/$cache"
    if [[ -d "$DIR" ]]; then
        SIZE=$(du -sh "$DIR" 2>/dev/null | cut -f1)
        rm -rf "$DIR" 2>/dev/null && log "  removed $cache cache (was $SIZE, rebuilt on demand)"
    fi
done

# ----------------------------------------------------------------------
# 5. Old webui session transcripts (keep most recent 5 only)
# ----------------------------------------------------------------------
if [[ -d /root/.hermes/webui/sessions ]]; then
    SESSION_COUNT=$(ls /root/.hermes/webui/sessions 2>/dev/null | wc -l)
    if [[ $SESSION_COUNT -gt 5 ]]; then
        REMOVED=$(bash -c 'cd /root/.hermes/webui/sessions && ls -t | tail -n +6 | xargs -r rm -rf' && echo "ok")
        log "  webui sessions: trimmed $((SESSION_COUNT - 5)) old transcripts (kept 5 most recent)"
    else
        log "  webui sessions: $SESSION_COUNT (under threshold, no cleanup needed)"
    fi
fi

# ----------------------------------------------------------------------
# 6. Old log files (>7 days, >10MB)
# ----------------------------------------------------------------------
log "Rotating old log files..."
OLD_LOGS=$(find /var/log /root/.hermes /root/coin-master -name "*.log" -size +10M -mtime +7 2>/dev/null | wc -l)
if [[ $OLD_LOGS -gt 0 ]]; then
    find /var/log /root/.hermes /root/coin-master -name "*.log" -size +10M -mtime +7 -delete 2>/dev/null
    log "  deleted $OLD_LOGS old log files"
else
    log "  no old log files to delete"
fi

# ----------------------------------------------------------------------
# 7. Truncate very large current logs (>100MB) instead of deleting
# ----------------------------------------------------------------------
log "Truncating oversized current logs..."
HUGE_LOGS=$(find /var/log /root -name "*.log" -size +100M 2>/dev/null)
if [[ -n "$HUGE_LOGS" ]]; then
    echo "$HUGE_LOGS" | while read -r f; do
        SIZE=$(du -sh "$f" 2>/dev/null | cut -f1)
        truncate -s 0 "$f" 2>/dev/null && log "  truncated $f (was $SIZE)"
    done
fi

# ----------------------------------------------------------------------
# Final disk state
# ----------------------------------------------------------------------
USE_PCT=$(df / --output=pcent | tail -1 | tr -d '% ')
log "=== Done. Disk usage: ${USE_PCT}% ==="
log ""

# Rotate this log too if it gets huge
if [[ $(stat -c%s "$LOG" 2>/dev/null || echo 0) -gt 10485760 ]]; then
    mv "$LOG" "${LOG}.old"
    touch "$LOG"
fi