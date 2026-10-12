# Backup & Restore

Each client deployment has its own Postgres database (and, with `STORAGE_PROVIDER=LOCAL`, an uploads volume).
Back up **both**. With S3/R2 storage, the bucket's own versioning/replication covers media.

## Backup

```bash
scripts/backup/backup.sh ./backups          # custom-format pg_dump, sha256 sidecar, keeps newest 14
```

- Direct mode: used when `pg_dump` is on PATH and `DATABASE_URL` is set.
- Docker mode (default otherwise): runs `pg_dump` inside the compose `postgres` service.
  For production use `COMPOSE_FILE=docker-compose.prod.yml POSTGRES_USER=... POSTGRES_DB=... scripts/backup/backup.sh`.
- `BACKUP_KEEP=30` changes retention. Fails (non-zero) if the dump is suspiciously small.
- Schedule it (cron / systemd timer) and **copy dumps off the server** (object storage, another host).

Uploads (LOCAL storage): `docker run --rm -v <project>_uploads:/data -v $PWD/backups:/out alpine tar czf /out/uploads-$(date +%F).tgz -C /data .`

## Verify a backup (safe, does not touch live data)

```bash
scripts/restore/restore.sh backups/commerce-<stamp>.dump --verify
```

Restores into a scratch DB (`commerce_restore_verify`), compares the exact row count of every table with the live
database, prints OK/MISMATCH and drops the scratch DB. Run this regularly - an unverified backup is a hope, not a backup.
(A mismatch right after a busy day is expected if data changed after the dump was taken.)

## Restore (disaster recovery)

```bash
docker compose -f docker-compose.prod.yml stop api
scripts/restore/restore.sh backups/commerce-<stamp>.dump --target commerce --yes   # drops & recreates `commerce`
docker compose -f docker-compose.prod.yml start api                                # entrypoint re-applies migrations
```

`--target` requires `--yes`. Restore into a **new** name first (`--target commerce_check --yes`) if you want to inspect
before replacing production. Migrations written after the dump are applied automatically on API start.

## Tested

The verify flow is exercised in the clean-room run (see `docs/NEW_CLIENT_CHECKLIST.md`).
