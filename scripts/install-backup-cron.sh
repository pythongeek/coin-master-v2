#!/bin/bash
# Install CryptoFlip backup cronjob on the host (cx23).
# Run this as root on cx23 once.
#
# Daily pg_dump at 03:00, weekly full base backup at Sunday 04:00.

set -euo pipefail

BACKUP_SCRIPT="/root/coin-master/scripts/backup.sh"
CRON_DAILY="0 3 * * * cd /root/coin-master && ${BACKUP_SCRIPT} dump >> /var/log/cryptoflip-backup.log 2>&1"
CRON_WEEKLY="0 4 * * 0 cd /root/coin-master && ${BACKUP_SCRIPT} full >> /var/log/cryptoflip-backup-full.log 2>&1"

# Remove any existing CryptoFlip backup lines to avoid duplicates
(crontab -l 2>/dev/null | grep -v '/cryptoflip-backup' || true) | crontab -

# Add new entries
(crontab -l 2>/dev/null; echo "${CRON_DAILY}"; echo "${CRON_WEEKLY}") | crontab -

echo "Cron installed. Current crontab:"
crontab -l | grep -E 'cryptoflip-backup|backup\.sh' || true

# Create log files if missing
touch /var/log/cryptoflip-backup.log /var/log/cryptoflip-backup-full.log
chmod 644 /var/log/cryptoflip-backup.log /var/log/cryptoflip-backup-full.log
echo "Logs: /var/log/cryptoflip-backup*.log"
