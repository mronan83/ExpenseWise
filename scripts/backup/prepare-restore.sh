#!/usr/bin/env bash
# Prepares a decrypted nightly dump for restoring into a new Supabase project, as the restore
# drill and the runbook (section 5) both do. Writes roles.restore.sql and data.restore.sql
# next to the dump's files, which stay as they were:
#
# - Every new project grants Supabase's own roles what they need, and its postgres role may
#   not repeat those grants, so they are left out of the roles.
# - A table's data block is left out when the table had no rows. Copying no rows still needs
#   the right to insert, which postgres lacks on some of Supabase's own tables. A table with
#   rows is always kept, so a restore that can't write them still fails.
#
# Usage: scripts/backup/prepare-restore.sh <directory holding roles.sql and data.sql>
set -euo pipefail
umask 077

dir=${1:?Usage: prepare-restore.sh <directory holding roles.sql and data.sql>}

grep -vE '^GRANT .* TO "supabase_[a-z_]+"( WITH [A-Z ]+)?;$' "$dir/roles.sql" \
  >"$dir/roles.restore.sql" || true
grants=$(($(wc -l <"$dir/roles.sql") - $(wc -l <"$dir/roles.restore.sql")))

# A COPY header followed at once by its end marker is a table with no rows. Headers are only
# looked for between blocks, never inside one.
empty=$(awk -v out="$dir/data.restore.sql" '
  !inside && /^COPY .* FROM stdin;$/ { held = $0; inside = 1; first = 1; next }
  inside && first {
    first = 0
    if ($0 == "\\.") { inside = 0; dropped++; next }
    print held > out
  }
  inside && $0 == "\\." { inside = 0 }
  { print > out }
  END { print dropped + 0 }
' "$dir/data.sql")

echo "Left out $grants grant(s) Supabase makes itself and the data blocks of $empty empty table(s)."
