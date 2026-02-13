#!/bin/bash
# NanoClaw Knowledge Base Backup to Google Drive
# Backs up to local Google Drive folder (auto-syncs via Google Drive File Stream)

set -euo pipefail

# ===== CONFIGURATION =====
# Determine project directory dynamically relative to this script
SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_FILE="$PROJECT_DIR/store/messages.db"

# Google Drive path - update this after installing Google Drive File Stream
# Common locations:
#   GDRIVE_DIR="/Volumes/Google Drive/Backups/NanoClaw"
#   GDRIVE_DIR="$HOME/Google Drive/My Drive/NanoClaw/Backups"
GDRIVE_DIR="$HOME/Google Drive/My Drive/NanoClaw/Backups"

LOCAL_BACKUP_DIR="$PROJECT_DIR/backups"
LOG_FILE="$PROJECT_DIR/logs/backup.log"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Create directories
mkdir -p "$LOCAL_BACKUP_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=== Starting NanoClaw KB backup ==="

# Check if database exists
if [ ! -f "$DB_FILE" ]; then
    log "ERROR: Database file not found at $DB_FILE"
    exit 1
fi

# Export KB tables to SQL for human-readable backup
SQL_BACKUP="$LOCAL_BACKUP_DIR/kb-$TIMESTAMP.sql"

log "Exporting KB tables to SQL..."
sqlite3 "$DB_FILE" <<EOF
.output '$SQL_BACKUP'
.dump kb_sources kb_chunks
.quit
EOF

# Also backup full database
DB_BACKUP="$LOCAL_BACKUP_DIR/messages-$TIMESTAMP.db"

log "Copying full database..."
cp "$DB_FILE" "$DB_BACKUP"

# Get sizes for logging
SQL_SIZE=$(wc -c < "$SQL_BACKUP" | tr -d ' ')
DB_SIZE=$(wc -c < "$DB_BACKUP" | tr -d ' ')

log "Backup created: SQL ($((SQL_SIZE / 1024))KB, DB ($((DB_SIZE / 1024))KB"

# Copy to Google Drive folder if available (Google Drive app will auto-sync)
# Try to create directory and check if it succeeded
if mkdir -p "$GDRIVE_DIR" 2>/dev/null; then
    log "Copying to Google Drive folder: $GDRIVE_DIR"
    cp "$SQL_BACKUP" "$GDRIVE_DIR/"
    cp "$DB_BACKUP" "$GDRIVE_DIR/"
    log "✓ Copied to Google Drive (will sync automatically)"
else
    log "WARNING: Could not create or access Google Drive folder at: $GDRIVE_DIR"
    log "Local backup only saved to: $LOCAL_BACKUP_DIR"
fi

fi

# Summary
REMAINING_SQL=$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name 'kb-*.sql' -print 2>/dev/null | wc -l | tr -d ' ')
REMAINING_DB=$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name 'messages-*.db' -print 2>/dev/null | wc -l | tr -d ' ')

log "=== Backup complete ==="
log "Local backups: $REMAINING_SQL SQL files, $REMAINING_DB DB files"
log "Backup dir: $LOCAL_BACKUP_DIR"
