#!/usr/bin/env bash
# Monthly restore drill (ADR-0014; runbook section 5). Restores the newest nightly backup the
# way the runbook's "Restoring from the off-site backup" does by hand, and checks the result:
#
# 1. Downloads the newest daily dump from Backblaze B2, decrypts it and checks each file
#    against the SHA-256 the backup recorded. A dump older than the 24-hour recovery point
#    fails the drill, which is how a missed night shows.
# 2. Starts a throwaway Supabase stack on this runner (database, auth and storage) on the
#    dump's Postgres version. Auth and storage create their own schemas at start-up, as they
#    do in a new project, so the restore sees the tables production's rows belong in.
# 3. Restores with Supabase's documented procedure, roles, schema, then data, from the files
#    scripts/backup/prepare-restore.sh writes.
# 4. Checks the database (packages/db, restore:check): row counts against the dump,
#    migrations against this commit's files, newer migrations applied, the schema against
#    packages/db/schema.json, row-level security on, and each organization seeing only its
#    own rows when signed in as expensewise_app.
# 5. Checks receipt images: for a sample of receipts, the encrypted copy decrypts to a file
#    whose SHA-256 is the one the receipt recorded.
# 6. Fails if all this took longer than the 4-hour recovery time.
#
# It needs only the bucket's key and the passphrase, never a production connection. The
# repository is public, and so are its logs: this prints steps, counts, table names and
# timings, never data, object names or credentials.
set -euo pipefail
umask 077

for name in BACKUP_PASSPHRASE B2_KEY_ID B2_APPLICATION_KEY B2_BUCKET; do
  if [ -z "${!name:-}" ]; then
    echo "::error::$name is not set. It is a secret in the GitHub environment 'backup' (runbook section 5)." >&2
    exit 1
  fi
done

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SUPABASE_BIN=${SUPABASE_BIN:-supabase}
IMAGE_SAMPLE=${IMAGE_SAMPLE:-100}
RECOVERY_POINT_HOURS=24
RECOVERY_TIME_HOURS=4

work=$(mktemp -d)
stack=""
cleanup() {
  if [ -n "$stack" ]; then
    (cd "$stack" && "$SUPABASE_BIN" stop --no-backup >/dev/null 2>&1) || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/db" "$work/gnupg"
export GNUPGHOME="$work/gnupg"
started=$(date +%s)
failures=0

step() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  echo "::error::$*" >&2
  failures=$((failures + 1))
}
size() { awk -v b="$1" 'BEGIN { if (b < 1048576) printf "%.0f KB", b / 1024; else printf "%.1f MB", b / 1048576 }'; }
# Error text from a tool may quote a connection string; never let a password through.
redact() { sed -E 's#://[^/@[:space:]]+@#://***@#g'; }

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
decrypt() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt \
    --output "$2" "$1" 3<<<"$BACKUP_PASSPHRASE" 2>/dev/null
}

# 1. The newest dump
latest=$(b2 s3api list-objects-v2 --bucket "$B2_BUCKET" --prefix db/daily/ --output json \
  --query 'Contents[].Key' | jq -r '[.[]?] | sort | last // empty')
if [ -z "$latest" ]; then
  echo "::error::The bucket holds no daily dump. Has the nightly backup run?" >&2
  exit 1
fi
b2 s3 cp "s3://$B2_BUCKET/$latest" "$work/db.tar.gz.gpg" --only-show-errors
if ! decrypt "$work/db.tar.gz.gpg" "$work/db.tar.gz"; then
  echo "::error::The newest dump does not decrypt with BACKUP_PASSPHRASE." >&2
  exit 1
fi
tar -C "$work/db" -xzf "$work/db.tar.gz"
manifest="$work/db/manifest.json"
for file in roles.sql schema.sql data.sql; do
  recorded=$(jq -r --arg f "$file" '.sha256[$f] // empty' "$manifest")
  if [ "$(sha256sum "$work/db/$file" | cut -d' ' -f1)" != "$recorded" ]; then
    echo "::error::$file in the newest dump does not match the SHA-256 the backup recorded." >&2
    exit 1
  fi
done
dumped_at=$(jq -r '.dumpedAt' "$manifest")
age=$(($(date +%s) - $(date -d "$dumped_at" +%s)))
step "Newest dump: $(jq -r '.date' "$manifest"), $(size "$(stat -c %s "$work/db.tar.gz.gpg")") encrypted, taken $((age / 3600)) h $((age % 3600 / 60)) min ago; its files match their checksums"
if [ "$age" -gt $((RECOVERY_POINT_HOURS * 3600)) ]; then
  fail "The newest dump is older than the $RECOVERY_POINT_HOURS-hour recovery point. Check the Nightly backup runs."
fi

# 2. A throwaway Supabase stack, unless a database was given (rehearsals)
if [ -z "${RESTORE_DATABASE_URL:-}" ]; then
  major=$(jq -r '(.serverVersion // "17") | split(".")[0]' "$manifest")
  stack="$work/stack"
  mkdir -p "$stack"
  (cd "$stack" && "$SUPABASE_BIN" init --force >/dev/null 2>&1)
  sed -i -E "s/^major_version = .*/major_version = $major/" "$stack/supabase/config.toml"
  step "Starting a throwaway Supabase stack: Postgres $major, auth and storage"
  if ! (cd "$stack" && "$SUPABASE_BIN" start \
    -x studio,realtime,imgproxy,kong,mailpit,postgrest,postgres-meta,edge-runtime,logflare,vector,supavisor \
    >"$work/stack.log" 2>&1); then
    echo "::error::The throwaway Supabase stack did not start:" >&2
    tail -n 5 "$work/stack.log" | redact >&2
    exit 1
  fi
  RESTORE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
fi

# 3. The restore, as the runbook does it, from the files prepare-restore.sh writes
step "$(bash "$REPO_ROOT/scripts/backup/prepare-restore.sh" "$work/db")"
restore_started=$(date +%s)
if ! psql "$RESTORE_DATABASE_URL" -X -q --single-transaction -v ON_ERROR_STOP=1 \
  --file "$work/db/roles.restore.sql" --file "$work/db/schema.sql" \
  --command 'SET session_replication_role = replica' --file "$work/db/data.restore.sql" \
  >"$work/restore.log" 2>&1; then
  # Keep the message, not the values: Postgres quotes the offending value after ': "'.
  echo "::error::The restore failed:" >&2
  grep -m 3 'ERROR:' "$work/restore.log" | sed -E 's/: ".*$//; s/^.*ERROR: +/ERROR: /' | redact >&2
  echo "If it names an auth or storage column, production runs newer Supabase services than this CLI version: raise it in .github/workflows/restore-drill.yml." >&2
  exit 1
fi
step "Restored roles, schema and data in $(($(date +%s) - restore_started)) s"

# 4. The database checks
if ! (cd "$REPO_ROOT" && RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" DRILL_MANIFEST="$manifest" \
  pnpm --silent --filter @expensewise/db restore:check 2> >(redact >&2)); then
  fail "The restored database failed a check above."
fi

# 5. Receipt images
psql "$RESTORE_DATABASE_URL" -X -q -tA -F $'\t' -v ON_ERROR_STOP=1 \
  -c "select storage_key, sha256 from public.receipts order by random() limit $IMAGE_SAMPLE" \
  >"$work/images.tsv"
receipts=$(psql "$RESTORE_DATABASE_URL" -X -q -tA -c "select count(*) from public.receipts")
checked=0 missing=0 mismatched=0
while IFS=$'\t' read -r -u 4 key sha; do
  [ -n "$key" ] || continue
  checked=$((checked + 1))
  if ! b2 s3 cp "s3://$B2_BUCKET/receipts/$key.gpg" "$work/image.gpg" --only-show-errors \
    >/dev/null 2>&1; then
    missing=$((missing + 1))
    continue
  fi
  if ! decrypt "$work/image.gpg" "$work/image" ||
    [ "$(sha256sum "$work/image" | cut -d' ' -f1)" != "$sha" ]; then
    mismatched=$((mismatched + 1))
  fi
  rm -f "$work/image" "$work/image.gpg"
done 4<"$work/images.tsv"
step "Receipt images: $checked of $receipts checked, $missing missing from the bucket, $mismatched not matching their receipt"
if [ "$missing" -gt 0 ] || [ "$mismatched" -gt 0 ]; then
  fail "Some receipt images are missing from the backup or don't match their receipt's SHA-256."
fi

# 6. Recovery time
took=$(($(date +%s) - started))
step "Restored and checked in $((took / 60)) min $((took % 60)) s; the recovery time is $RECOVERY_TIME_HOURS hours"
if [ "$took" -gt $((RECOVERY_TIME_HOURS * 3600)) ]; then
  fail "The drill took longer than the $RECOVERY_TIME_HOURS-hour recovery time."
fi

if [ "$failures" -gt 0 ]; then
  step "The drill failed $failures check(s)"
  exit 1
fi
step "The drill passed"
