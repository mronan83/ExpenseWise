#!/usr/bin/env bash
# Starts or stops a local Postgres 16 for development and integration tests.
# Uses Docker when a daemon is reachable, otherwise local Postgres binaries.
# Usage: scripts/dev-postgres.sh start|stop|url
set -euo pipefail

PORT="${PGPORT:-54329}"
NAME="expensewise-postgres"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/.data/postgres"
URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

pg_bin() {
  if command -v pg_ctl >/dev/null 2>&1; then dirname "$(command -v pg_ctl)"; return; fi
  local dir
  dir="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$dir" ] && echo "$dir" && return
  echo "No Docker daemon and no Postgres binaries found. Install one of them." >&2
  exit 1
}

# Postgres refuses to run as root; use the postgres system user when we are root.
as_pg_user() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

start() {
  if have_docker; then
    docker start "$NAME" >/dev/null 2>&1 || docker run -d --name "$NAME" \
      -e POSTGRES_PASSWORD=postgres -p "${PORT}:5432" postgres:16 >/dev/null
  else
    local bin; bin="$(pg_bin)"
    if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
      mkdir -p "$DATA_DIR"
      [ "$(id -u)" = "0" ] && chown -R postgres:postgres "$(dirname "$DATA_DIR")"
      local pwfile; pwfile="$(mktemp)"; echo postgres > "$pwfile"; chmod 644 "$pwfile"
      as_pg_user "$bin/initdb" -D "$DATA_DIR" -U postgres --pwfile="$pwfile" \
        --auth-local=trust --auth-host=scram-sha-256 >/dev/null
      rm -f "$pwfile"
    fi
    as_pg_user "$bin/pg_ctl" -D "$DATA_DIR" -l "$DATA_DIR/server.log" \
      -o "-p ${PORT} -k /tmp -c listen_addresses=127.0.0.1" -w status >/dev/null 2>&1 ||
      as_pg_user "$bin/pg_ctl" -D "$DATA_DIR" -l "$DATA_DIR/server.log" \
        -o "-p ${PORT} -k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null
  fi
  for _ in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 || { have_docker && docker exec "$NAME" pg_isready >/dev/null 2>&1; }; then
      echo "Postgres is ready. Export this for integration tests:"
      echo "  export DATABASE_URL=${URL}"
      return
    fi
    sleep 1
  done
  echo "Postgres did not become ready in 30 s" >&2
  exit 1
}

stop() {
  if have_docker; then docker stop "$NAME" >/dev/null 2>&1 || true
  else as_pg_user "$(pg_bin)/pg_ctl" -D "$DATA_DIR" -m fast stop >/dev/null 2>&1 || true
  fi
  echo "Postgres stopped."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  url) echo "$URL" ;;
  *) echo "Usage: $0 start|stop|url" >&2; exit 2 ;;
esac
