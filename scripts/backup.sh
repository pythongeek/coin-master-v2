#!/bin/bash
# CryptoFlip automated PostgreSQL backup script.
#
# Usage:
#   ./scripts/backup.sh          # dump + cleanup
#   ./scripts/backup.sh full     # base backup (WAL) + dump
#
# Retention:
#   - Daily dumps kept for 7 days
#   - Weekly dumps kept for 4 weeks
#   - Monthly dumps kept for 12 months
#   - WAL base backups kept for 2 days
#
# Backups are written to /backups (Docker volume in production).

set -euo pipefail

MODE="${1:-dump}"

CONTAINER="coin-master-postgres-1"
BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d_%H%M%S)
DAY=$(date +%u)
RETENTION_DAILY=7
RETENTION_WEEKLY=28
RETENTION_MONTHLY=365

cd "$(dirname "$0")/.."

# Load env vars from .env (for local/manual runs)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

mkdir -p "${BACKUP_DIR}"

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "ERROR: PostgreSQL container ${CONTAINER} is not running." >&2
  exit 1
fi

if [ "${MODE}" = "full" ]; then
  # Continuous WAL archiving requires postgres.conf changes; this base backup
  # is the no-config equivalent for a single-node deploy.
  echo "Starting PostgreSQL base backup..."
  docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -u postgres "${CONTAINER}" \
    pg_basebackup -D "/backups/wal_${DATE}" -Fp -Xs -P -v
  echo "Base backup written to /backups/wal_${DATE}"

  # Rotate WAL base backups
  find "${BACKUP_DIR}" -maxdepth 1 -type d -name 'wal_*' -mtime +2 -print0 \
    | xargs -0 -r rm -rf
fi

# --- pg_dump custom-format compressed dump ---
DUMP_FILE="${BACKUP_DIR}/cryptoflip_${DATE}.dump"

echo "Starting pg_dump..."
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" -u postgres "${CONTAINER}" \
  pg_dump -Fc -Z9 -d "${POSTGRES_DB}" -U "${POSTGRES_USER}" > "${DUMP_FILE}"

echo "Dump completed: ${DUMP_FILE}"
ls -lh "${DUMP_FILE}"

# --- Retention cleanup ---
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'cryptoflip_*.dump' -mtime +${RETENTION_DAILY} -print0 \
  | xargs -0 -r rm -f

# Keep weekly and monthly representative backups (Sunday or 1st of month)
if [ "${DAY}" -eq 7 ]; then
  cp -v "${DUMP_FILE}" "${DUMP_FILE}.weekly"
fi
if [ "$(date +%d)" = "01" ]; then
  cp -v "${DUMP_FILE}" "${DUMP_FILE}.monthly"
fi

find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'cryptoflip_*.dump.weekly' -mtime +${RETENTION_WEEKLY} -print0 \
  | xargs -0 -r rm -f
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'cryptoflip_*.dump.monthly' -mtime +${RETENTION_MONTHLY} -print0 \
    | xargs -0 -r rm -f

echo "Backup rotation complete."
