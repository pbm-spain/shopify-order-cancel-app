#!/usr/bin/env bash
#
# SQLite database backup script.
#
# Creates a consistent, hot backup of the SQLite database using the
# VACUUM INTO command, which produces a standalone copy without requiring
# the application to stop. The backup is compressed with gzip and stored
# in the configured backup directory with a timestamped filename.
#
# Usage:
#   ./scripts/backup-db.sh                    # uses defaults
#   DATA_DIR=/app/data ./scripts/backup-db.sh # custom data dir
#   BACKUP_DIR=/mnt/backups ./scripts/backup-db.sh
#   BACKUP_RETENTION_DAYS=14 ./scripts/backup-db.sh
#
# Cron example (daily at 03:00):
#   0 3 * * * /opt/shopify-cancel-app/scripts/backup-db.sh >> /var/log/backup.log 2>&1
#
# Requirements:
#   - sqlite3 CLI (apt install sqlite3 / apk add sqlite3)
#   - gzip

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────

DATA_DIR="${DATA_DIR:-./data}"
DB_FILE="${DATA_DIR}/cancel-requests.db"
BACKUP_DIR="${BACKUP_DIR:-${DATA_DIR}/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="cancel-requests_${TIMESTAMP}.db"

# ─── Validation ──────────────────────────────────────────────────────

if [ ! -f "$DB_FILE" ]; then
  echo "[ERROR] Database file not found: $DB_FILE"
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "[ERROR] sqlite3 CLI not found. Install it with: apt install sqlite3"
  exit 1
fi

# ─── Create backup directory ─────────────────────────────────────────

mkdir -p "$BACKUP_DIR"

# ─── Perform hot backup using VACUUM INTO ────────────────────────────
# VACUUM INTO creates a consistent snapshot of the database even while
# the application is running with WAL mode. It does not hold locks that
# would block the running app.

echo "[INFO] Starting backup of $DB_FILE..."

sqlite3 "$DB_FILE" "VACUUM INTO '${BACKUP_DIR}/${BACKUP_NAME}';"

if [ ! -f "${BACKUP_DIR}/${BACKUP_NAME}" ]; then
  echo "[ERROR] Backup file was not created"
  exit 1
fi

# ─── Compress the backup ─────────────────────────────────────────────

gzip "${BACKUP_DIR}/${BACKUP_NAME}"
FINAL_FILE="${BACKUP_DIR}/${BACKUP_NAME}.gz"

FILESIZE=$(stat -f%z "$FINAL_FILE" 2>/dev/null || stat --printf="%s" "$FINAL_FILE" 2>/dev/null)
echo "[INFO] Backup created: ${FINAL_FILE} (${FILESIZE} bytes)"

# ─── Verify backup integrity ─────────────────────────────────────────

TEMP_VERIFY=$(mktemp)
gzip -dc "$FINAL_FILE" > "$TEMP_VERIFY"
INTEGRITY=$(sqlite3 "$TEMP_VERIFY" "PRAGMA integrity_check;" 2>&1)
rm -f "$TEMP_VERIFY"

if [ "$INTEGRITY" != "ok" ]; then
  echo "[ERROR] Backup integrity check failed: $INTEGRITY"
  rm -f "$FINAL_FILE"
  exit 1
fi

echo "[INFO] Backup integrity verified: OK"

# ─── Clean up old backups ────────────────────────────────────────────

if [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  DELETED=$(find "$BACKUP_DIR" -name "cancel-requests_*.db.gz" -mtime +"$BACKUP_RETENTION_DAYS" -delete -print 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DELETED" -gt 0 ]; then
    echo "[INFO] Cleaned up ${DELETED} old backup(s) (older than ${BACKUP_RETENTION_DAYS} days)"
  fi
fi

echo "[INFO] Backup completed successfully"
