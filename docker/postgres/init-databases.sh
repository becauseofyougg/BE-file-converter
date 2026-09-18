#!/bin/bash
set -euo pipefail

# Database per service. Locally that is one container with three databases; in
# production they would be three instances. Nobody reads another service's
# schema — cross-service data travels only as messages.
for db in identity conversion notification; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE $db'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
done
