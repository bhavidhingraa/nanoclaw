#!/bin/bash

# Backup Alfred's memories to git
# This script commits and pushes memory changes to the nanoclaw repo

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "🧠 Backing up Alfred's memories..."

# Add memory files
git add groups/ CLAUDE.md 2>/dev/null || true

# Check if there are changes
if git diff --cached --quiet; then
  echo "✅ No memory changes to backup"
  exit 0
fi

# Create commit
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
git commit -m "chore: backup memories [$TIMESTAMP]

- Auto-backup of Alfred's memory files
- Groups, preferences, and conversations

Co-Authored-By: Alfred <alfred@assistant.com>"

# Push to remote
git push origin main

echo "✅ Memories backed up successfully at $TIMESTAMP"
