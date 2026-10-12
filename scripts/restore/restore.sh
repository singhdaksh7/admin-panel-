#!/usr/bin/env bash
# Restore a backup made by scripts/backup/backup.sh.
#
#   scripts/restore/restore.sh <dump-file> --verify
#       Restores into a throw-away database (commerce_restore_verify), compares row counts of every
#       table with the live database, then drops it. Safe: does not touch the live DB.
#   scripts/restore/restore.sh <dump-file> --target <dbname> [--yes]
#       Restores INTO <dbname> (dropped & recreated). Requires --yes for non-verify restores.
#
# Uses `docker compose exec` against PG_SERVICE unless PG_MODE=direct (then psql/pg_restore on PATH
# with PGHOST/PGPORT/PGUSER/PGPASSWORD).
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file> (--verify | --target <db> --yes)}"
shift
MODE=""; TARGET=""; YES="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --verify) MODE=verify ;;
    --target) MODE=target; TARGET="${2:?--target needs a db name}"; shift ;;
    --yes) YES=yes ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { echo "choose --verify or --target <db>" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 2; }

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-commerce}"
LIVE_DB="${POSTGRES_DB:-commerce}"

if [ "${PG_MODE:-docker}" = "direct" ]; then
  psqlc()  { psql -v ON_ERROR_STOP=1 -U "$PG_USER" "$@"; }
  restore_into() { pg_restore --no-owner -U "$PG_USER" -d "$1" < "$DUMP"; }
else
  psqlc()  { docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" psql -v ON_ERROR_STOP=1 -U "$PG_USER" "$@"; }
  restore_into() { docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" pg_restore --no-owner -U "$PG_USER" -d "$1" < "$DUMP"; }
fi

recreate() {
  psqlc -d postgres -q -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)"
  psqlc -d postgres -q -c "CREATE DATABASE \"$1\""
}

# every table with its exact row count, as sorted "table|count" lines
counts() {
  local db="$1" tables t
  tables=$(psqlc -d "$db" -At -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
  for t in $tables; do
    echo "$t|$(psqlc -d "$db" -At -c "SELECT count(*) FROM \"$t\"")"
  done
}

if [ "$MODE" = verify ]; then
  VDB="commerce_restore_verify"
  echo "[verify] restoring into scratch database $VDB ..."
  recreate "$VDB"
  restore_into "$VDB"
  A="$(counts "$LIVE_DB")"; B="$(counts "$VDB")"
  psqlc -d postgres -q -c "DROP DATABASE IF EXISTS \"$VDB\" WITH (FORCE)"
  if [ "$A" = "$B" ]; then
    echo "[verify] OK - all $(echo "$A" | wc -l | tr -d ' ') tables match live row counts"
  else
    echo "[verify] MISMATCH (live vs restored; differences can be legitimate if data changed since the backup):" >&2
    diff <(echo "$A") <(echo "$B") >&2 || true
    exit 1
  fi
else
  [ "$YES" = yes ] || { echo "refusing to overwrite '$TARGET' without --yes" >&2; exit 2; }
  echo "[restore] recreating $TARGET and restoring ..."
  recreate "$TARGET"
  restore_into "$TARGET"
  echo "[restore] done -> $TARGET"
fi
