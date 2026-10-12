#!/usr/bin/env bash
# PostgreSQL backup (custom format, compressed) + optional uploads archive.
#
# Modes (auto-detected):
#   direct : pg_dump on PATH and DATABASE_URL set
#   docker : COMPOSE_FILE + PG_SERVICE (default: docker-compose.yml / postgres) -> `docker compose exec`
#
# Usage: scripts/backup/backup.sh [output_dir]     (default ./backups)
set -euo pipefail

OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/commerce-$STAMP.dump"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-commerce}"
PG_DB="${POSTGRES_DB:-commerce}"
mkdir -p "$OUT_DIR"

if [ -n "${DATABASE_URL:-}" ] && command -v pg_dump >/dev/null 2>&1; then
  # strip Prisma's ?schema= param which libpq rejects
  pg_dump --format=custom --no-owner --dbname="${DATABASE_URL%%\?*}" --file="$FILE"
else
  docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    pg_dump --format=custom --no-owner -U "$PG_USER" -d "$PG_DB" > "$FILE"
fi

# sanity: the archive must be readable and non-trivial
SIZE=$(wc -c < "$FILE" | tr -d ' ')
if [ "$SIZE" -lt 1024 ]; then
  echo "backup looks empty ($SIZE bytes) - failing" >&2
  rm -f "$FILE"
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$FILE" > "$FILE.sha256"; fi
echo "backup written: $FILE ($SIZE bytes)"

# keep newest N (default 14)
KEEP="${BACKUP_KEEP:-14}"
ls -1t "$OUT_DIR"/commerce-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done
