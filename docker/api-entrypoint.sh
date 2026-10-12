#!/bin/sh
set -e
# Apply pending migrations (safe/idempotent), then start the API.
if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  echo "[entrypoint] applying database migrations..."
  node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
fi
exec node apps/api/dist/server.js
