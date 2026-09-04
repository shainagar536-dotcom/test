#!/usr/bin/env bash
# Starts a throwaway Postgres for the test suite if one is not already up.
#
# The suite talks to a real database rather than a stub, so this has to exist
# before `npm test`. Safe to run repeatedly.
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PORT=${TEST_PG_PORT:-5433}
DATA=${TEST_PG_DATA:-/tmp/pgdata}

export PATH="$PGBIN:$PATH"

if pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
  echo "postgres already listening on $PORT"
  exit 0
fi

id -u postgres >/dev/null 2>&1 || useradd -m postgres
rm -rf "$DATA" /tmp/pgrun
mkdir -p "$DATA" /tmp/pgrun
chown -R postgres "$DATA" /tmp/pgrun

su postgres -c "$PGBIN/initdb -D $DATA -A trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $DATA \
  -o '-p $PORT -k /tmp/pgrun -c listen_addresses=127.0.0.1' \
  -l /tmp/pg.log start" >/dev/null

for _ in $(seq 1 20); do
  pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break
  sleep 0.5
done

su postgres -c "$PGBIN/createdb -h 127.0.0.1 -p $PORT surense" 2>/dev/null || true
echo "postgres ready on $PORT"
