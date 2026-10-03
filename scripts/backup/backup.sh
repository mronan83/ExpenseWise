#!/usr/bin/env bash
# Nightly off-site backup (ADR-0014; setup in docs/runbooks/environment-setup.md section 5).
#
# 1. Writes the heartbeat, so the Free plan never sees the project as idle. It comes first,
#    so a later failure, such as Backblaze being down, can't stop it.
# 2. Dumps the database with Supabase's documented procedure: roles, schema, then data,
#    auth users included, with row counts and the Postgres version recorded for the restore
#    drill (scripts/backup/restore-drill.sh).
# 3. Encrypts the dump on this machine and uploads it to the private Backblaze B2 bucket:
#    db/daily/<date> every night, db/monthly/<month> on the month's first good night.
#    It then downloads that copy again and checks that it decrypts to the same bytes.
# 4. Copies receipt images added since the last run, each encrypted, to receipts/.
#    Images are never deleted from the copy.
# 5. Fails if the database or file storage has passed 70% of its Free plan limit.
#
# The repository is public, and so are its logs. This prints steps, counts, sizes and
# timings, never data, object names or credentials.
set -euo pipefail
umask 077

for name in BACKUP_DATABASE_URL BACKUP_PASSPHRASE B2_KEY_ID B2_APPLICATION_KEY B2_BUCKET \
  SUPABASE_S3_ACCESS_KEY_ID SUPABASE_S3_SECRET_ACCESS_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "::error::$name is not set. It is a secret in the GitHub environment 'backup' (runbook section 5)." >&2
    exit 1
  fi
done

SUPABASE_BIN=${SUPABASE_BIN:-supabase}
RECEIPT_BUCKET=${RECEIPT_BUCKET:-receipts}
TODAY=${BACKUP_DATE:-$(date -u +%F)}
MONTH=${TODAY:0:7}
ALERT_PERCENT=70
DB_LIMIT_BYTES=${DB_LIMIT_BYTES:-$((500 * 1024 * 1024))}
STORAGE_LIMIT_BYTES=${STORAGE_LIMIT_BYTES:-$((1024 * 1024 * 1024))}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/db" "$work/gnupg"
export GNUPGHOME="$work/gnupg"
started=$(date +%s)

step() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }
# A small dump would read as 0.0 MB, which looks like an empty one.
size() { awk -v b="$1" 'BEGIN { if (b < 1048576) printf "%.0f KB", b / 1024; else printf "%.1f MB", b / 1048576 }'; }
# Error text from a tool may quote a connection string; never let a password through.
redact() { sed -E 's#://[^/@[:space:]]+@#://***@#g'; }
sql() { psql "$BACKUP_DATABASE_URL" -X -q -tA -v ON_ERROR_STOP=1 -c "$1" 2> >(redact >&2); }

# Supabase's S3 endpoint and region come from the session-pooler address, so the backup
# needs no extra settings: postgres.<ref>@aws-N-<region>.pooler.supabase.com.
if [ -z "${SUPABASE_S3_ENDPOINT:-}" ]; then
  pattern='^postgres(ql)?://postgres\.([a-z0-9]+):.*@aws-[0-9]+-([a-z0-9-]+)\.pooler\.supabase\.com'
  if [[ ! "$BACKUP_DATABASE_URL" =~ $pattern ]]; then
    echo "::error::BACKUP_DATABASE_URL should be the session-pooler address (postgres.<ref>@aws-N-<region>.pooler.supabase.com:5432)." >&2
    exit 1
  fi
  SUPABASE_S3_ENDPOINT="https://${BASH_REMATCH[2]}.supabase.co/storage/v1/s3"
  SUPABASE_S3_REGION=${BASH_REMATCH[3]}
fi

# 1. Heartbeat
sql "insert into ops.heartbeat (id, beat_at, source) values (1, now(), 'nightly-backup')
     on conflict (id) do update set beat_at = excluded.beat_at, source = excluded.source"
step "Heartbeat written"

# Backblaze reports the bucket's S3 endpoint when the key signs in.
if [ -z "${B2_S3_ENDPOINT:-}" ]; then
  if ! account=$(curl -fsS -K - https://api.backblazeb2.com/b2api/v3/b2_authorize_account \
    <<<"user = \"$B2_KEY_ID:$B2_APPLICATION_KEY\"" 2>/dev/null); then
    echo "::error::Backblaze refused B2_KEY_ID and B2_APPLICATION_KEY. Check both in the 'backup' environment." >&2
    exit 1
  fi
  B2_S3_ENDPOINT=$(jq -r '.apiInfo.storageApi.s3ApiUrl // .s3ApiUrl // empty' <<<"$account")
  unset account
fi
B2_REGION=${B2_REGION:-$(sed -E 's#^https?://s3\.([a-z0-9-]+)\.backblazeb2\.com.*#\1#' <<<"$B2_S3_ENDPOINT")}

# Path-style addressing for both stores, and checksums only where required: newer AWS CLI
# defaults add checksums that S3-compatible stores may reject.
export AWS_CONFIG_FILE="$work/aws-config"
cat >"$AWS_CONFIG_FILE" <<'EOF'
[default]
s3 =
  addressing_style = path
request_checksum_calculation = when_required
response_checksum_validation = when_required
EOF
b2() {
  AWS_ACCESS_KEY_ID=$B2_KEY_ID AWS_SECRET_ACCESS_KEY=$B2_APPLICATION_KEY AWS_DEFAULT_REGION=$B2_REGION \
    aws --endpoint-url "$B2_S3_ENDPOINT" "$@"
}
supabase_s3() {
  AWS_ACCESS_KEY_ID=$SUPABASE_S3_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$SUPABASE_S3_SECRET_ACCESS_KEY \
    AWS_DEFAULT_REGION=$SUPABASE_S3_REGION aws --endpoint-url "$SUPABASE_S3_ENDPOINT" "$@"
}

encrypt() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric \
    --cipher-algo AES256 --s2k-digest-algo SHA512 --compress-algo none \
    --output "$2" "$1" 3<<<"$BACKUP_PASSPHRASE"
}
decrypt() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt \
    --output "$2" "$1" 3<<<"$BACKUP_PASSPHRASE"
}

# 2. The database
step "Dumping the database (roles, schema, data)"
for part in "roles.sql --role-only" "schema.sql" "data.sql --use-copy --data-only"; do
  read -r file flags <<<"$part"
  # shellcheck disable=SC2086 # flags are words on purpose
  if ! "$SUPABASE_BIN" db dump --db-url "$BACKUP_DATABASE_URL" -f "$work/db/$file" $flags \
    >"$work/dump.log" 2>&1; then
    echo "::error::supabase db dump failed for $file:" >&2
    tail -n 5 "$work/dump.log" | redact >&2
    exit 1
  fi
done

database_bytes=$(sql "select pg_database_size(current_database())")
server_version=$(sql "show server_version")
rows=$(sql "
  select coalesce(json_object_agg(t.table_schema || '.' || t.table_name, (
           xpath('/row/n/text()', query_to_xml(
             format('select count(*) as n from %I.%I', t.table_schema, t.table_name),
             false, true, '')))[1]::text::bigint), '{}')
    from information_schema.tables t
   where t.table_type = 'BASE TABLE'
     and t.table_schema in ('public', 'auth', 'storage', 'drizzle', 'ops')")
migrations=$(sql "
  select json_build_object('applied', count(*), 'latest', max(created_at))
    from drizzle.__drizzle_migrations")
jq -n \
  --arg date "$TODAY" \
  --arg at "$(date -u +%FT%TZ)" \
  --argjson databaseBytes "$database_bytes" \
  --arg serverVersion "$server_version" \
  --argjson rows "$rows" \
  --argjson migrations "$migrations" \
  --arg roles "$(sha256sum "$work/db/roles.sql" | cut -d' ' -f1)" \
  --arg schema "$(sha256sum "$work/db/schema.sql" | cut -d' ' -f1)" \
  --arg data "$(sha256sum "$work/db/data.sql" | cut -d' ' -f1)" \
  '{date: $date, dumpedAt: $at, databaseBytes: $databaseBytes, serverVersion: $serverVersion,
    migrations: $migrations,
    rows: $rows, sha256: {"roles.sql": $roles, "schema.sql": $schema, "data.sql": $data}}' \
  >"$work/db/manifest.json"
tar -C "$work/db" -czf "$work/db.tar.gz" roles.sql schema.sql data.sql manifest.json
encrypt "$work/db.tar.gz" "$work/db.tar.gz.gpg"
step "Dump ready: $(size "$(stat -c %s "$work/db.tar.gz.gpg")") encrypted, $(jq 'length' <<<"$rows") tables"

# 3. The off-site copies
daily="db/daily/$TODAY.tar.gz.gpg"
b2 s3 cp "$work/db.tar.gz.gpg" "s3://$B2_BUCKET/$daily" --only-show-errors
step "Uploaded the daily copy"
monthly="db/monthly/$MONTH.tar.gz.gpg"
if b2 s3api head-object --bucket "$B2_BUCKET" --key "$monthly" >/dev/null 2>&1; then
  step "This month's copy already exists"
else
  b2 s3 cp "$work/db.tar.gz.gpg" "s3://$B2_BUCKET/$monthly" --only-show-errors
  step "Uploaded this month's copy"
fi

# A copy that can't be read back is not a backup: fetch it, decrypt it, compare.
b2 s3 cp "s3://$B2_BUCKET/$daily" "$work/check.gpg" --only-show-errors
decrypt "$work/check.gpg" "$work/check.tar.gz"
if ! cmp -s "$work/check.tar.gz" "$work/db.tar.gz" || ! tar -tzf "$work/check.tar.gz" >/dev/null; then
  echo "::error::The uploaded copy does not decrypt to the dump that was made." >&2
  exit 1
fi
step "Checked: the uploaded copy decrypts to the same dump"

# 4. Receipt images: copy each one not yet in the backup.
supabase_s3 s3api list-objects-v2 --bucket "$RECEIPT_BUCKET" --output json \
  --query 'Contents[].[Key, Size]' | jq -r '.[]? | @tsv' >"$work/source.tsv"
b2 s3api list-objects-v2 --bucket "$B2_BUCKET" --prefix receipts/ --output json \
  --query 'Contents[].Key' | jq -r '.[]? | sub("^receipts/"; "") | sub("\\.gpg$"; "")' \
  | sort -u >"$work/copied.txt"
copied=0
while IFS=$'\t' read -r -u 4 key _size; do
  [ -n "$key" ] || continue
  if grep -qxF -- "$key" "$work/copied.txt"; then continue; fi
  supabase_s3 s3 cp "s3://$RECEIPT_BUCKET/$key" "$work/image" --only-show-errors
  encrypt "$work/image" "$work/image.gpg"
  b2 s3 cp "$work/image.gpg" "s3://$B2_BUCKET/receipts/$key.gpg" --only-show-errors
  rm -f "$work/image" "$work/image.gpg"
  copied=$((copied + 1))
done 4<"$work/source.tsv"
step "Receipt images: $copied new, $(wc -l <"$work/source.tsv") in storage"

# 5. Free plan limits, across every bucket
storage_bytes=0
while read -r bucket; do
  [ -n "$bucket" ] || continue
  bytes=$(supabase_s3 s3api list-objects-v2 --bucket "$bucket" --output json \
    --query 'Contents[].Size' | jq '[.[]?] | add // 0')
  storage_bytes=$((storage_bytes + bytes))
done < <(supabase_s3 s3api list-buckets --output json --query 'Buckets[].Name' | jq -r '.[]?')
over=0
report() {
  local label=$1 used=$2 limit=$3 percent=$(($2 * 100 / $3))
  step "$label: $(mb "$used") of $(mb "$limit") ($percent%)"
  if [ "$percent" -ge "$ALERT_PERCENT" ]; then
    echo "::error::$label has passed $ALERT_PERCENT% of the Free plan limit. ADR-0014 says to move to Pro." >&2
    over=1
  fi
}
report "Database" "$database_bytes" "$DB_LIMIT_BYTES"
report "File storage" "$storage_bytes" "$STORAGE_LIMIT_BYTES"

step "Done in $(($(date +%s) - started)) s"
exit "$over"
