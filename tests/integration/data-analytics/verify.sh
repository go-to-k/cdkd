#!/usr/bin/env bash
# verify.sh — cdkd Glue::Table OpenTableFormatInput (Iceberg) backfill integ
# test (issue #609).
#
# Asserts that a Glue Table whose template sets `OpenTableFormatInput`
# (Apache Iceberg, `{ IcebergInput: { MetadataOperation: 'CREATE', Version } }`)
# is actually created as an Iceberg table after `cdkd deploy` — the property
# was a silent-drop before the #609 backfill. OpenTableFormatInput is a
# create-time directive that GetTable does NOT echo back as an
# OpenTableFormatInput field; an Iceberg table surfaces via
# `Table.Parameters.table_type == 'ICEBERG'`, which is what we assert.
#
# Since issue #1408 it ALSO asserts `Table.Parameters.metadata_location` is an
# s3:// URI, i.e. that `MetadataOperation: CREATE` made Glue write real Iceberg
# metadata rather than merely tagging the catalog entry. See the comment at
# that assertion for why the `IcebergTableInput` coverage #1408 originally asked
# for is unreachable (CloudFormation itself cannot deploy that shape).
#
# Since issue #1461 it ALSO runs an UPDATE phase. Glue's `UpdateTable` replaces
# `TableInput` WHOLESALE, so a payload rebuilt purely from the template used to
# erase every `Parameters` entry AWS itself had written -- and for an Iceberg
# table `table_type` / `metadata_location` are exactly what make it readable as
# Iceberg by Athena / Spark / EMR. Verified live 2026-08-10 in us-east-1: after
# a deploy changing ONLY `TableInput.Description`, `Table.Parameters` came back
# `null`, deploy reporting success. A unit test cannot catch this -- the wiped
# values are AWS-authored and only exist on a live table. Phase 2 therefore
# re-deploys with an unrelated Description edit and re-asserts BOTH markers,
# and (on the plain `events` table) asserts a user-authored parameter the
# template DROPPED is still removed -- the mirror-image regression a naive
# "restore anything absent from the desired side" merge would introduce.
#
# Since issue #1479 it ALSO covers the StorageDescriptor subtree one level
# down: out-of-band SD members (a crawler's `StorageDescriptor.Parameters`
# bag, a `SerdeInfo.Parameters` entry -- injected via a raw UpdateTable, which
# is indistinguishable to cdkd from a crawler write) must survive the same
# unrelated Phase-2 update, while template-declared SD members (SerdeInfo's
# SerializationLibrary, Columns) stay template-authored.
#
# Also asserts the destroy path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

# --- shared Glue readback helper -------------------------------------------
# A plain strict capture (no `2>/dev/null`, no `|| echo ...` tail): a throttle
# or an auth failure must abort the run under `set -e`, never read as an empty
# / absent value that silently satisfies an assertion.
# An ABSENT parameter key renders as the literal `None` with `--output text`,
# which is what the removal assertions below compare against.
table_query() { # usage: table_query <table-name> <jmespath> -> value
  aws glue get-table \
    --database-name "${DB_NAME}" --name "$1" --region "${REGION}" \
    --query "$2" --output text
}

db_query() { # usage: db_query <jmespath> -> value
  aws glue get-database --name "${DB_NAME}" --region "${REGION}" --query "$1" --output text
}

# Both AWS-authored Iceberg markers, asserted identically after CREATE and
# after UPDATE. `$1` labels which phase is being checked.
assert_iceberg_markers() { # usage: assert_iceberg_markers "<phase label>"
  local phase="$1"
  local table_type metadata_location table_type_upper

  table_type="$(table_query "${TABLE_NAME}" 'Table.Parameters.table_type')"
  # Case-insensitive comparison -- Iceberg writes 'ICEBERG'.
  table_type_upper="$(echo "${table_type}" | tr '[:lower:]' '[:upper:]')"
  if [ "${table_type_upper}" != "ICEBERG" ]; then
    echo "FAIL: ${phase}: Table.Parameters.table_type is '${table_type}', expected 'ICEBERG'" >&2
    echo "      after CREATE this means the #609 OpenTableFormatInput silent-drop is NOT closed;" >&2
    echo "      after UPDATE it means the #1461 AWS-managed-Parameters wipe is NOT closed." >&2
    # Strict (unsilenced) diagnostic dump: a failing read here must abort
    # loudly under `set -e` rather than be swallowed inside this wrapper.
    aws glue get-table --database-name "${DB_NAME}" --name "${TABLE_NAME}" --region "${REGION}" \
      --query 'Table.Parameters' --output json >&2
    exit 1
  fi

  metadata_location="$(table_query "${TABLE_NAME}" 'Table.Parameters.metadata_location')"
  case "${metadata_location}" in
    s3://*)
      ;;
    *)
      echo "FAIL: ${phase}: Table.Parameters.metadata_location is '${metadata_location}', expected an s3:// URI" >&2
      echo "      after CREATE this means MetadataOperation: CREATE did not write Iceberg metadata (#609/#1408);" >&2
      echo "      after UPDATE it means the #1461 AWS-managed-Parameters wipe is NOT closed." >&2
      aws glue get-table --database-name "${DB_NAME}" --name "${TABLE_NAME}" --region "${REGION}" \
        --query 'Table.Parameters' --output json >&2
      exit 1
      ;;
  esac
  echo "    OK: ${phase}: table_type == ICEBERG, metadata_location == ${metadata_location}"
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="DataAnalyticsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# DB name mirrors the fixture: `${this.stackName}-analytics-db`.toLowerCase().
DB_NAME_FALLBACK="$(echo "${STACK}-analytics-db" | tr '[:upper:]' '[:lower:]')"
ICEBERG_TABLE_NAME="events_iceberg"
EVENTS_TABLE_NAME="events"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  local destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    # `state destroy` rejects `--force`; the confirmation skip flag is `--yes`.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    # Only sweep the state key when state destroy succeeded — otherwise we
    # would orphan the AWS resources the state record still points at.
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the database / iceberg-table names from the deploy state outputs,
# falling back to the fixture-computed values if the outputs are absent.
DB_NAME=$(echo "${STATE}" | jq -r '.outputs.DatabaseName // empty')
if [ -z "${DB_NAME}" ]; then
  DB_NAME="${DB_NAME_FALLBACK}"
fi
TABLE_NAME=$(echo "${STATE}" | jq -r '.outputs.IcebergTableName // empty')
if [ -z "${TABLE_NAME}" ]; then
  TABLE_NAME="${ICEBERG_TABLE_NAME}"
fi
echo "    Using database '${DB_NAME}', iceberg table '${TABLE_NAME}'"

# --- Assertion: OpenTableFormatInput reached AWS ----------------------
# OpenTableFormatInput is a create-time directive; GetTable does NOT return
# it as an OpenTableFormatInput field. An Iceberg table created via that
# directive surfaces with `Table.Parameters.table_type == 'ICEBERG'`. Seeing
# that proves OpenTableFormatInput was wired into CreateTable (silent-drop
# closed by the #609 backfill).
#
# --- Assertion: Glue actually WROTE Iceberg metadata to S3 ------------
# `table_type == ICEBERG` alone only proves the parameter was tagged onto the
# table. `MetadataOperation: CREATE` is supposed to make Glue write a real
# Iceberg metadata file under the StorageDescriptor location and record its
# key in `Parameters.metadata_location`; a table tagged ICEBERG with an EMPTY
# metadata_location would be a catalog entry no Iceberg reader can open.
#
# This is the achievable half of issue #1408. That issue asked for a fixture
# asserting a column that exists ONLY in `IcebergInput.IcebergTableInput`, and
# its live probe (2026-08-09, 5 raw glue:CreateTable shapes + 5 CloudFormation
# stacks) proved that unreachable: CloudFormation itself cannot deploy
# `IcebergTableInput` in ANY shape, every one failing with "Table metadata is
# expected only via TableInput or via IcebergTableInputProperties inside
# OpenTableFormatInput" — a third spelling present in neither the CFn registry
# schema (`IcebergTableInput`) nor `@aws-sdk/client-glue`
# (`CreateIcebergTableInput`). cdkd's compatibility target is CloudFormation,
# so there is nothing to be compatible WITH there. What a CDK user can actually
# deploy today is this shape, and this assertion is what pins it.
#
# Both markers are asserted together (and again after the UPDATE phase below)
# by the shared helper near the top of this script.
assert_iceberg_markers "after CREATE"

# --- Assertion: user-authored Parameters landed on the plain table ----
# Phase 2 drops `owner_team` from the template while keeping `classification`;
# these two reads are the baseline that removal assertion is measured against.
EVENTS_CLASSIFICATION="$(table_query "${EVENTS_TABLE_NAME}" 'Table.Parameters.classification')"
EVENTS_OWNER_TEAM="$(table_query "${EVENTS_TABLE_NAME}" 'Table.Parameters.owner_team')"
if [ "${EVENTS_CLASSIFICATION}" != "json" ] || [ "${EVENTS_OWNER_TEAM}" != "analytics" ]; then
  echo "FAIL: after CREATE: expected events Parameters {classification=json, owner_team=analytics}, got {classification=${EVENTS_CLASSIFICATION}, owner_team=${EVENTS_OWNER_TEAM}}" >&2
  exit 1
fi
echo "    OK: user-authored events Parameters present after CREATE"

DB_KEEP="$(db_query 'Database.Parameters.keep_me')"
DB_DROP="$(db_query 'Database.Parameters.drop_me')"
if [ "${DB_KEEP}" != "yes" ] || [ "${DB_DROP}" != "phase-1-only" ]; then
  echo "FAIL: after CREATE: expected database Parameters {keep_me=yes, drop_me=phase-1-only}, got {keep_me=${DB_KEEP}, drop_me=${DB_DROP}}" >&2
  exit 1
fi
echo "    OK: user-authored database Parameters present after CREATE"

# --- Simulate an AWS-authored DATABASE parameter ----------------------
# The database's #1461 exposure is real but cannot be produced from a template:
# an AWS-authored value is BY DEFINITION one the template never declares, and a
# plain Glue database has no equivalent of the Iceberg markers Glue writes onto
# a table. So we write one out-of-band, which is indistinguishable to cdkd from
# any other AWS-authored entry (Lake Formation / federated-catalog markers, or
# a console edit) -- present in NEITHER the desired nor the previous template
# side, which is exactly the merge branch under test.
#
# UpdateDatabase is itself full-replace, so the injected input must carry the
# existing fields too; jq rebuilds DatabaseInput from the live read rather than
# hardcoding them.
echo "==> Injecting an out-of-band (AWS-authored-equivalent) database parameter"
DB_LIVE_JSON="$(aws glue get-database --name "${DB_NAME}" --region "${REGION}" --query 'Database' --output json)"
# Whitelisting individual fields here would silently DROP the ones not listed
# (CreateTableDefaultPermissions / TargetDatabase / FederatedDatabase), which
# is the very wholesale-replace data loss this test exists to detect -- caused
# by the test itself. Instead: take the live object, delete the read-only
# members UpdateDatabase does not accept, and keep everything else.
DB_INJECT_INPUT="$(printf '%s' "${DB_LIVE_JSON}" | jq -c '
  del(.CatalogId, .CreateTime)
  | .Parameters = ((.Parameters // {}) + {"out_of_band_marker": "must-survive"})
  | with_entries(select(.value != null))')"
aws glue update-database --name "${DB_NAME}" --region "${REGION}" \
  --database-input "${DB_INJECT_INPUT}" >/dev/null
if [ "$(db_query 'Database.Parameters.out_of_band_marker')" != "must-survive" ]; then
  echo "FAIL: the out-of-band database parameter injection did not take" >&2
  exit 1
fi
echo "    OK: out_of_band_marker injected"

# --- Simulate crawler-authored StorageDescriptor members (#1479) -------
# A Glue crawler writes `StorageDescriptor.Parameters` (sizeKey / recordCount
# / UPDATED_BY_CRAWLER ...) and `SerdeInfo.Parameters` entries the template
# never declares. Injecting them via a raw UpdateTable is indistinguishable to
# cdkd from a crawler write: present in NEITHER the desired nor the previous
# template side, which is the exact merge branch #1479 adds for the SD
# subtree. Same jq keep-everything rebuild as the database injection above --
# whitelisting members would itself cause the wholesale-replace data loss
# under test.
echo "==> Injecting out-of-band (crawler-equivalent) StorageDescriptor members onto '${EVENTS_TABLE_NAME}' (#1479)"
EVENTS_LIVE_JSON="$(aws glue get-table --database-name "${DB_NAME}" --name "${EVENTS_TABLE_NAME}" --region "${REGION}" --query 'Table' --output json)"
EVENTS_INJECT_INPUT="$(printf '%s' "${EVENTS_LIVE_JSON}" | jq -c '
  del(.DatabaseName, .CreateTime, .UpdateTime, .LastAccessTime, .CreatedBy,
      .IsRegisteredWithLakeFormation, .CatalogId, .VersionId,
      .IsMultiDialectView, .IsMaterializedView)
  | .StorageDescriptor.Parameters = ((.StorageDescriptor.Parameters // {}) + {"UPDATED_BY_CRAWLER": "cdkd-1479-sim"})
  | .StorageDescriptor.SerdeInfo.Parameters = ((.StorageDescriptor.SerdeInfo.Parameters // {}) + {"crawler.added": "yes"})
  | with_entries(select(.value != null))')"
aws glue update-table --database-name "${DB_NAME}" --region "${REGION}" \
  --table-input "${EVENTS_INJECT_INPUT}" >/dev/null
if [ "$(table_query "${EVENTS_TABLE_NAME}" 'Table.StorageDescriptor.Parameters.UPDATED_BY_CRAWLER')" != "cdkd-1479-sim" ]; then
  echo "FAIL: the out-of-band StorageDescriptor.Parameters injection did not take" >&2
  exit 1
fi
if [ "$(table_query "${EVENTS_TABLE_NAME}" 'Table.StorageDescriptor.SerdeInfo.Parameters."crawler.added"')" != "yes" ]; then
  echo "FAIL: the out-of-band SerdeInfo.Parameters injection did not take" >&2
  exit 1
fi
echo "    OK: crawler-equivalent SD members injected"

# --- Capture the pre-update identity of the Iceberg table -------------
# Asserted unchanged after phase 2. Without it the phase-2 assertions would
# also pass on a REPLACEMENT (delete + create), which would legitimately carry
# a fresh Description AND freshly-written Iceberg markers while having thrown
# away the table -- i.e. the exact failure this phase exists to detect, dressed
# up as a pass.
ICEBERG_CREATE_TIME_BEFORE="$(table_query "${TABLE_NAME}" 'Table.CreateTime')"
if [ -z "${ICEBERG_CREATE_TIME_BEFORE}" ] || [ "${ICEBERG_CREATE_TIME_BEFORE}" = "None" ]; then
  echo "FAIL: could not read Table.CreateTime before the update phase" >&2
  exit 1
fi

# --- Phase 2: UPDATE — unrelated edit must not wipe AWS Parameters ----
# Issue #1461. `UpdateTable` replaces `TableInput` wholesale, so a payload
# rebuilt purely from the template erased the AWS-authored `Parameters` bag:
# an Iceberg table silently degraded to a plain external table pointing at
# Iceberg data files, with the deploy reporting success. The template change
# here touches ONLY `TableInput.Description` on the Iceberg table — nothing
# in it mentions Parameters, which is precisely why no template-side diff
# hinted at the loss.
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (unrelated TableInput edit)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# The UPDATE must actually have landed. Without this the Parameters assertions
# below would pass vacuously against a table nothing ever updated — a no-op
# deploy is indistinguishable from a working fix on the Parameters alone.
ICEBERG_DESCRIPTION="$(table_query "${TABLE_NAME}" 'Table.Description')"
if [ "${ICEBERG_DESCRIPTION}" != "phase-2 update" ]; then
  echo "FAIL: after UPDATE: Table.Description is '${ICEBERG_DESCRIPTION}', expected 'phase-2 update' (the UpdateTable never landed, so the Parameters assertions below would be vacuous)" >&2
  exit 1
fi
echo "    OK: the unrelated TableInput.Description edit reached AWS"

ICEBERG_CREATE_TIME_AFTER="$(table_query "${TABLE_NAME}" 'Table.CreateTime')"
if [ "${ICEBERG_CREATE_TIME_AFTER}" != "${ICEBERG_CREATE_TIME_BEFORE}" ]; then
  echo "FAIL: after UPDATE: Table.CreateTime changed (${ICEBERG_CREATE_TIME_BEFORE} -> ${ICEBERG_CREATE_TIME_AFTER}) -- the table was REPLACED, not updated in place, so the Iceberg assertions below would only prove a fresh create" >&2
  exit 1
fi
echo "    OK: Table.CreateTime unchanged (the update was in-place, not a replacement)"

# The headline #1461 assertion: both AWS-authored Iceberg markers survived an
# update whose template never mentioned them. Pre-fix, both are gone here.
assert_iceberg_markers "after UPDATE"

# The mirror-image half: a user-authored parameter the template REMOVED must
# still be removed. A merge keyed on "anything absent from the desired side is
# restored" would make user parameters unremovable — converting #1461 into its
# opposite. `--output text` renders an absent key as the literal `None`.
EVENTS_CLASSIFICATION="$(table_query "${EVENTS_TABLE_NAME}" 'Table.Parameters.classification')"
EVENTS_OWNER_TEAM="$(table_query "${EVENTS_TABLE_NAME}" 'Table.Parameters.owner_team')"
if [ "${EVENTS_OWNER_TEAM}" != "None" ]; then
  echo "FAIL: after UPDATE: events Parameters.owner_team is '${EVENTS_OWNER_TEAM}', expected it to be REMOVED (the #1461 merge must not resurrect a user-removed parameter)" >&2
  exit 1
fi
if [ "${EVENTS_CLASSIFICATION}" != "json" ]; then
  echo "FAIL: after UPDATE: events Parameters.classification is '${EVENTS_CLASSIFICATION}', expected 'json' (a kept user parameter must pass through unchanged)" >&2
  exit 1
fi
echo "    OK: user-removed events parameter is gone, kept one passed through"

# --- The #1479 assertions: SD-subtree out-of-band members survived ------
# Phase 2 restated the events table's template SD (Location / Columns /
# formats / SerdeInfo.SerializationLibrary) with NO mention of the injected
# members. Pre-#1479, UpdateTable's wholesale TableInput replace erased both.
SD_CRAWLER_MARKER="$(table_query "${EVENTS_TABLE_NAME}" 'Table.StorageDescriptor.Parameters.UPDATED_BY_CRAWLER')"
if [ "${SD_CRAWLER_MARKER}" != "cdkd-1479-sim" ]; then
  echo "FAIL: after UPDATE: StorageDescriptor.Parameters.UPDATED_BY_CRAWLER is '${SD_CRAWLER_MARKER}', expected 'cdkd-1479-sim' (the #1479 SD-subtree merge is NOT closed)" >&2
  exit 1
fi
SERDE_CRAWLER_MARKER="$(table_query "${EVENTS_TABLE_NAME}" 'Table.StorageDescriptor.SerdeInfo.Parameters."crawler.added"')"
if [ "${SERDE_CRAWLER_MARKER}" != "yes" ]; then
  echo "FAIL: after UPDATE: SerdeInfo.Parameters.\"crawler.added\" is '${SERDE_CRAWLER_MARKER}', expected 'yes' (the #1479 SerdeInfo bag merge is NOT closed)" >&2
  exit 1
fi
# Template-declared SD members must stay TEMPLATE-authored -- the merge is
# per-member, not a blanket restore (drift --revert depends on this).
EVENTS_SERDE_LIB="$(table_query "${EVENTS_TABLE_NAME}" 'Table.StorageDescriptor.SerdeInfo.SerializationLibrary')"
if [ "${EVENTS_SERDE_LIB}" != "org.openx.data.jsonserde.JsonSerDe" ]; then
  echo "FAIL: after UPDATE: SerdeInfo.SerializationLibrary is '${EVENTS_SERDE_LIB}', expected the template value (the merge must not clobber template-declared members)" >&2
  exit 1
fi
EVENTS_COLUMN_COUNT="$(table_query "${EVENTS_TABLE_NAME}" 'length(Table.StorageDescriptor.Columns)')"
if [ "${EVENTS_COLUMN_COUNT}" != "3" ]; then
  echo "FAIL: after UPDATE: events Columns count is '${EVENTS_COLUMN_COUNT}', expected 3 (template-declared Columns must round-trip)" >&2
  exit 1
fi
echo "    OK: crawler-equivalent SD members survived the unrelated update; template-declared SD members intact (#1479)"

# --- The DATABASE half of #1461 (UpdateDatabase, same full-replace bag) ---
DB_MARKER="$(db_query 'Database.Parameters.out_of_band_marker')"
DB_KEEP="$(db_query 'Database.Parameters.keep_me')"
DB_DROP="$(db_query 'Database.Parameters.drop_me')"
DB_DESCRIPTION="$(db_query 'Database.Description')"
if [ "${DB_DESCRIPTION}" != "phase-2 update" ]; then
  echo "FAIL: after UPDATE: Database.Description is '${DB_DESCRIPTION}', expected 'phase-2 update' (the UpdateDatabase never landed, so the assertions below would be vacuous)" >&2
  exit 1
fi
if [ "${DB_MARKER}" != "must-survive" ]; then
  echo "FAIL: after UPDATE: database Parameters.out_of_band_marker is '${DB_MARKER}', expected 'must-survive' (UpdateDatabase wiped an entry no template side declared -- the #1461 database half is NOT closed)" >&2
  exit 1
fi
if [ "${DB_DROP}" != "None" ]; then
  echo "FAIL: after UPDATE: database Parameters.drop_me is '${DB_DROP}', expected it to be REMOVED (the merge must not resurrect a user-removed database parameter)" >&2
  exit 1
fi
if [ "${DB_KEEP}" != "yes" ]; then
  echo "FAIL: after UPDATE: database Parameters.keep_me is '${DB_KEEP}', expected 'yes' (a kept user parameter must pass through unchanged)" >&2
  exit 1
fi
echo "    OK: database AWS-authored parameter survived, user removal applied, kept one unchanged"

# --- Phase 2b: is UpdateTable's VersionId a real precondition? --------
# THE GUARD'S PREMISE, PINNED AGAINST LIVE AWS.
#
# `UpdateTableRequest.VersionId` is documented only as "the version ID at which
# to update the table contents" -- NOT explicitly as a precondition. cdkd sends
# it to close the read->write TOCTOU window (an Iceberg commit from Spark /
# Athena landing between the pre-read and the write would otherwise be undone
# by putting back the metadata_location cdkd read). If AWS silently IGNORES a
# stale value, that guard is a placebo and should be removed rather than
# shipped -- so this asserts the semantics directly instead of assuming them.
#
# Method: read the current VersionId, advance it with an out-of-band
# UpdateTable, then replay the ORIGINAL (now stale) version and require AWS to
# refuse. Run against the plain `events` table, never the Iceberg one, so a
# failed probe cannot leave the Iceberg fixture in a half-written state.
echo "==> Phase 2b: proving UpdateTable VersionId is a precondition (not advisory)"
EVENTS_LIVE_JSON="$(aws glue get-table --database-name "${DB_NAME}" --name "${EVENTS_TABLE_NAME}" --region "${REGION}" --query 'Table' --output json)"
STALE_VERSION_ID="$(printf '%s' "${EVENTS_LIVE_JSON}" | jq -r '.VersionId // empty')"
if [ -z "${STALE_VERSION_ID}" ]; then
  echo "FAIL: GetTable returned no VersionId for ${EVENTS_TABLE_NAME} -- cdkd's concurrency guard can never attach a precondition, so it is dead code. Remove the guard or find the shape that does return one." >&2
  exit 1
fi
echo "    Current VersionId: ${STALE_VERSION_ID}"

# Same del-the-read-only-members approach as the database injection above:
# UpdateTable rejects fields GetTable echoes back but TableInput has no room
# for, and an allow-list would silently drop the rest of the table definition.
EVENTS_TABLE_INPUT="$(printf '%s' "${EVENTS_LIVE_JSON}" | jq -c '
  del(.DatabaseName, .CatalogId, .CreateTime, .UpdateTime, .CreatedBy,
      .IsRegisteredWithLakeFormation, .VersionId, .FederatedTable,
      .IsMultiDialectView, .IsMaterializedView, .Status, .LastAccessTime,
      .LastAnalyzedTime)
  | with_entries(select(.value != null))')"

# Advance the version out of band. This is the "concurrent writer" cdkd's
# precondition is supposed to notice.
BUMPED_TABLE_INPUT="$(printf '%s' "${EVENTS_TABLE_INPUT}" | jq -c '.Description = "version-bump-probe"')"
aws glue update-table --database-name "${DB_NAME}" --region "${REGION}" \
  --table-input "${BUMPED_TABLE_INPUT}" >/dev/null

NEW_VERSION_ID="$(table_query "${EVENTS_TABLE_NAME}" 'Table.VersionId')"
if [ "${NEW_VERSION_ID}" = "${STALE_VERSION_ID}" ]; then
  echo "FAIL: VersionId did not advance after an out-of-band UpdateTable (${STALE_VERSION_ID} -> ${NEW_VERSION_ID}); the probe cannot distinguish stale from current, so it cannot prove anything." >&2
  exit 1
fi
echo "    VersionId advanced: ${STALE_VERSION_ID} -> ${NEW_VERSION_ID}"

# Now replay the STALE version. A real precondition rejects this.
PROBE_TABLE_INPUT="$(printf '%s' "${EVENTS_TABLE_INPUT}" | jq -c '.Description = "stale-version-probe"')"
set +e
STALE_UPDATE_OUT="$(aws glue update-table \
  --database-name "${DB_NAME}" --region "${REGION}" \
  --table-input "${PROBE_TABLE_INPUT}" \
  --version-id "${STALE_VERSION_ID}" 2>&1)"
STALE_UPDATE_RC=$?
set -e

if [ "${STALE_UPDATE_RC}" -eq 0 ]; then
  echo "FAIL: AWS ACCEPTED an UpdateTable carrying a stale VersionId (${STALE_VERSION_ID}, current ${NEW_VERSION_ID})." >&2
  echo "      UpdateTable's VersionId is therefore ADVISORY, not a precondition, and cdkd's" >&2
  echo "      TOCTOU guard in GlueProvider.updateTable is a PLACEBO: it cannot detect a" >&2
  echo "      concurrent Iceberg commit and must be removed rather than shipped, with the" >&2
  echo "      exposure documented instead. See issue #1461." >&2
  exit 1
fi

# Refused -- but for the RIGHT reason. Any old failure (bad shape, auth,
# throttle) would otherwise read as a pass and vouch for a guard that does not
# work. AWS raises ConcurrentModificationException for this.
if ! printf '%s' "${STALE_UPDATE_OUT}" | grep -qiE 'ConcurrentModification|concurrent'; then
  echo "FAIL: the stale-VersionId UpdateTable was refused, but NOT with a concurrency error -- so this does not prove the precondition works. AWS said: ${STALE_UPDATE_OUT}" >&2
  exit 1
fi
echo "    OK: AWS refused the stale-VersionId UpdateTable with a concurrency error"
echo "        (UpdateTable.VersionId IS a precondition -- cdkd's TOCTOU guard is real)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
# CDKD_TEST_UPDATE stays SET here on purpose: phase 2 is what is deployed, so
# destroy should synth the same shape. (Phase 1 uses `env -u` for the opposite
# reason -- an inherited value from the caller's shell would silently deploy
# the phase-2 template as the baseline and make phase 2 a no-op.)
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "Glue Iceberg table ${DB_NAME}.${TABLE_NAME} still exists after destroy" aws glue get-table --database-name "${DB_NAME}" --name "${TABLE_NAME}" --region "${REGION}"
echo "    OK: Glue Iceberg table is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> data-analytics test passed (Iceberg backfill #609 + AWS-managed Parameters survive UPDATE #1461 + out-of-band SD members survive UPDATE #1479 + clean destroy)"
