#!/usr/bin/env bash
# Requires MariaDB tools on PATH. Original dump is read-only; no production connections.
set -euo pipefail
snapshot=${1:?Usage: bash scripts/validate-v3-snapshot.sh /path/to/snapshot.sql}
scope=/private/tmp/epgstation-v3-oct22
[ ! -e "$scope" ] || { echo 'Owned path already exists; inspect before reuse'; exit 1; }
mkdir -m 700 "$scope"
dbpid=
cleanup() {
  if [ -n "$dbpid" ]; then kill "$dbpid" 2>/dev/null || true; wait "$dbpid" 2>/dev/null || true; fi
  du -sk "$scope"
  rm -rf "$scope"
  test ! -e "$scope" && echo 'Snapshot validation artifacts cleaned'
}
trap cleanup EXIT INT TERM
mariadb-install-db --no-defaults --datadir="$scope/data" --auth-root-authentication-method=normal --skip-test-db > "$scope/init.log" 2>&1 || { cat "$scope/init.log"; exit 1; }
mariadbd --no-defaults --datadir="$scope/data" --socket="$scope/db.sock" --pid-file="$scope/db.pid" --skip-networking --innodb-buffer-pool-size=64M --innodb-log-file-size=16M --log-error="$scope/db.log" &
dbpid=$!
for i in $(seq 1 100); do
  if mariadb-admin --no-defaults --socket="$scope/db.sock" -u root ping >/dev/null 2>&1; then break; fi
  kill -0 "$dbpid" || { cat "$scope/db.log"; exit 1; }
  sleep .1
done
mariadb --no-defaults --socket="$scope/db.sock" -u root < "$snapshot"
size=$(du -sk "$scope" | awk '{print $1}')
[ "$size" -le 1048576 ] || { echo '1 GiB budget exceeded'; exit 1; }
SNAPSHOT_DB_SOCKET="$scope/db.sock" SNAPSHOT_WORK_DIR="$scope" node scripts/validate-v3-snapshot.mjs
