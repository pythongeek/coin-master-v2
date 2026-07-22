#!/usr/bin/env bash
# =============================================================================
#  disk-alert.sh - monitor disk usage and alert + auto-clean if needed
# =============================================================================
#  Runs every 5 minutes via cron. Behavior:
#    - Disk < 70%:  silent
#    - Disk 70-89%: log warning (visible in cron output)
#    - Disk >= 90%: log ERROR + send notification + AUTO-RUN cleanup-cron.sh
#
#  Notification strategy:
#    - Always write to /var/log/cryptoflip-disk-alert.log
#    - When threshold crossed, write to syslog (visible in journalctl)
#    - When critical (>95%), try to trigger Hermes via webhook if configured
#    - When critical, also write to /tmp/DISK_CRITICAL for any process to check
#
#  Configuration via env vars (set in crontab or /etc/environment):
#    DISK_WARN_PCT   (default: 70)
#    DISK_CRIT_PCT    (default: 90)
#    DISK_EMERG_PCT   (default: 95)
#    ALERT_WEBHOOK    (optional: URL to POST to when critical)
#
#  Install: see /root/DISK-MAINTENANCE.md
# =============================================================================

set -uo pipefail

# ---- Config (env override) ----
WARN_PCT=${DISK_WARN_PCT:-70}
CRIT_PCT=${DISK_CRIT_PCT:-90}
EMERG_PCT=${DISK_EMERG_PCT:-95}

LOG="/var/log/cryptoflip-disk-alert.log"
CRIT_FLAG="/tmp/DISK_CRITICAL"
LOCK="/tmp/disk-alert.lock"
mkdir -p "$(dirname "$LOG")"

# ---- Get disk usage ----
USE_PCT=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d '% ')
AVAIL=$(df -h / --output=avail 2>/dev/null | tail -1 | tr -d ' ')

# Prevent overlapping runs (cleanup-cron takes ~1 min)
LOCK_ACQUIRED=false
exec 9>"$LOCK" && {
    flock -n 9 && LOCK_ACQUIRED=true
}

log() {
    local level="$1"
    shift
    local msg="$*"
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[$ts] [$level] $msg" | tee -a "$LOG"
    # Also send to syslog so journalctl users see it
    logger -t cryptoflip-disk "$level: $msg"
}

send_webhook() {
    local msg="$1"
    [[ -z "${ALERT_WEBHOOK:-}" ]] && return 0
    local payload
    payload=$(printf '{"text":"CryptoFlip DISK ALERT: %s\\nDisk: %s%%\\nAvailable: %s"}' "$msg" "$USE_PCT" "$AVAIL")
    curl -sS -X POST -H "Content-Type: application/json" \
        -d "$payload" \
        "$ALERT_WEBHOOK" -m 10 -o /dev/null -w "%{http_code}\n" 2>&1 | head -1
}

# ---- Threshold logic ----
if [[ $USE_PCT -lt $WARN_PCT ]]; then
    # Below warn threshold - silent (uncomment next line for debug)
    # log INFO "Disk OK: ${USE_PCT}% (${AVAIL} available)"
    # Clear the critical flag if we were in recovery
    if [[ -f "$CRIT_FLAG" ]] && [[ $USE_PCT -lt $EMERG_PCT ]]; then
        log INFO "Disk recovered to ${USE_PCT}% - clearing critical flag"
        rm -f "$CRIT_FLAG"
    fi
    exit 0
fi

if [[ $USE_PCT -lt $CRIT_PCT ]]; then
    log WARN "Disk at ${USE_PCT}% (warn threshold ${WARN_PCT}%). ${AVAIL} available."
    log WARN "  Top consumers:"
    du -sh /root/.hermes/* 2>/dev/null | sort -hr | head -3 | while read line; do
        log WARN "    $line"
    done
    exit 0
fi

# Critical threshold - alert + auto-clean
if [[ $USE_PCT -ge $EMERG_PCT ]]; then
    log ERROR "DISK EMERGENCY: ${USE_PCT}% used, only ${AVAIL} free"
    log ERROR "  Triggering immediate cleanup..."
    touch "$CRIT_FLAG"  # Signal to other scripts (e.g. don't rebuild)
    send_webhook "EMERGENCY ${USE_PCT}% - auto-cleanup triggered"
else
    log ERROR "DISK CRITICAL: ${USE_PCT}% used, only ${AVAIL} free"
    send_webhook "CRITICAL ${USE_PCT}% - auto-cleanup triggered"
fi

# Run cleanup
if [[ -x /root/scripts/cleanup-cron.sh ]]; then
    /root/scripts/cleanup-cron.sh
else
    log ERROR "/root/scripts/cleanup-cron.sh not found or not executable"
fi

# Re-check after cleanup
NEW_PCT=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d '% ')
NEW_AVAIL=$(df -h / --output=avail 2>/dev/null | tail -1 | tr -d ' ')
log INFO "Post-cleanup disk: ${NEW_PCT}% (${NEW_AVAIL} free)"

if [[ $NEW_PCT -lt $EMERG_PCT ]]; then
    log INFO "Emergency resolved. Clearing critical flag."
    rm -f "$CRIT_FLAG"
    send_webhook "Recovered: now ${NEW_PCT}% / ${NEW_AVAIL} free"
fi