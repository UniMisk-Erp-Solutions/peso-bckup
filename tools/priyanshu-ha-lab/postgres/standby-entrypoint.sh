#!/bin/sh
set -e
PRIMARY_HOST="${PRIMARY_HOST:-pg46}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U postgres; do
  echo "waiting for primary $PRIMARY_HOST:$PRIMARY_PORT..."
  sleep 2
done

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  rm -rf "$PGDATA"/*
  gosu postgres env PGPASSWORD=replpass pg_basebackup \
    -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U replicator \
    -D "$PGDATA" -Fp -Xs -P -R
fi

exec docker-entrypoint.sh postgres -c hot_standby=on
