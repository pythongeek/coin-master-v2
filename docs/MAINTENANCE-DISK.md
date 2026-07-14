# Disk Maintenance — CryptoFlip on cx23

**Prevents the recurring "disk full" problem that breaks builds + Docker.**

---

## TL;DR

| Concern | Tool | Frequency |
|---|---|---|
| Disk fills during Docker builds | `cleanup-cron.sh` | Daily at 04:00 |
| Need to know before it crashes | `disk-alert.sh` | Every 5 minutes |

Both run via cron, are idempotent, and safe to invoke manually.

---

## Scripts

### `/root/scripts/cleanup-cron.sh` (5.3 KB)

Nightly cleanup. Removes:
- Docker **build cache** (often 1-2 GB, biggest single source of waste)
- Docker **dangling images / containers / networks**
- **npm cache** (root + per-Hermes-profile)
- Hermes **browser caches**: puppeteer/chrome, snyk, pip, node-gyp
- Old **webui session transcripts** (keeps most recent 5)
- **Log files** older than 7 days and >10 MB
- Truncates very large current logs (>100 MB)

**Logs to:** `/var/log/cryptoflip-cleanup.log`
**Runtime:** ~15 seconds typical

### `/root/scripts/disk-alert.sh` (4.1 KB)

3-tier threshold monitor:

| Disk % | Behavior |
|---|---|
| `< 70%` | Silent (clears critical flag if recovering) |
| `70–89%` | Log WARN + top 3 consumers |
| `>= 90%` | Log ERROR + **auto-run cleanup-cron.sh** + try webhook |
| `>= 95%` | Log EMERGENCY + same + write `/tmp/DISK_CRITICAL` flag |

The `/tmp/DISK_CRITICAL` flag is a safety signal — other scripts (e.g. `coin-master-monitor.sh`) can check it and **refuse to rebuild the backend image** when the disk is past emergency, preventing further damage.

**Logs to:** `/var/log/cryptoflip-disk-alert.log` + `syslog` (visible via `journalctl -t cryptoflip-disk`)
**Runtime:** < 1 second (unless triggering cleanup)

---

## Cron entries

```
0 4 * * * /root/scripts/cleanup-cron.sh >> /var/log/cryptoflip-cleanup.log 2>&1
*/5 * * * * /root/scripts/disk-alert.sh >> /var/log/cryptoflip-disk-alert.log 2>&1
```

View: `crontab -l`

---

## Tuning knobs (env vars on the cron line)

| Var | Default | Meaning |
|---|---|---|
| `DISK_WARN_PCT` | 70 | When to start logging WARN |
| `DISK_CRIT_PCT` | 90 | When to auto-trigger cleanup |
| `DISK_EMERG_PCT` | 95 | When to set `/tmp/DISK_CRITICAL` flag |
| `ALERT_WEBHOOK` | _(empty)_ | URL to POST critical alerts to (Slack, Discord, etc.) |

Example: stricter thresholds for a smaller disk:
```
*/5 * * * * DISK_WARN_PCT=60 DISK_CRIT_PCT=80 ALERT_WEBHOOK=https://hooks.slack.com/... /root/scripts/disk-alert.sh >> /var/log/cryptoflip-disk-alert.log 2>&1
```

---

## Manual usage

Run any script directly:

```bash
# Cleanup now (safe; idempotent)
/root/scripts/cleanup-cron.sh

# Force a critical alert (for testing)
DISK_WARN_PCT=50 DISK_CRIT_PCT=60 /root/scripts/disk-alert.sh

# Check current disk state
df -h /
cat /tmp/DISK_CRITICAL 2>/dev/null && echo "EMERGENCY STATE" || echo "Disk OK"
```

---

## What this solves

| Before | After |
|---|---|
| Disk hits 100% mid-build → backend won't restart | Build cache pruned nightly; 5-min checks catch emergencies early |
| No way to know disk is filling until too late | WARN at 70%, ERROR at 90% logged + visible in syslog |
| `docker compose up --build` silently fails with `no space left on device` | Critical flag prevents bad builds; auto-cleanup recovers space |
| Old Hermes browser caches (Chrome, Puppeteer, Snyk) grow forever | Rebuilt on demand, cleared nightly |

---

## What it does NOT do

- **Backup cleanup** — handled separately by `/root/coin-master/scripts/backup.sh` (already in cron at 3 AM + weekly full)
- **Database bloat** — `payment_orders`, `audit_log`, `transactions` etc. grow but are pruned by app-level policies (LLM feedback loop archives old audit logs)
- **Long-term archival** — these scripts only do local cleanup, not S3 archiving

---

## Installed: 2026-07-14

Both scripts verified working in manual test runs.
Disk went from 94% → 82% during initial cleanup.
No false positives observed in 3-test run.

### Known limitation

The `disk-alert.sh` runs as root via cron. If a non-root user runs the backend in a container, the alert webhook would still work but in-container log analysis won't. This is acceptable for our cx23 setup where everything runs as root.

### Related: existing cron jobs (untouched)

```
* * * * * /root/coin-master-monitor.sh
0 3 * * * cd /root/coin-master && /root/coin-master/scripts/backup.sh dump >> /var/log/cryptoflip-backup.log 2>&1
0 4 * * 0 cd /root/coin-master && /root/coin-master/scripts/backup.sh full >> /var/log/cryptoflip-backup-full.log 2>&1
```