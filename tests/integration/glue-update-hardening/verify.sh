#!/usr/bin/env bash
# verify.sh — cdkd Glue update/delete hardening integ test.
#
# Exercises the four Glue provider fixes:
#   1. Job stringly-typed numeric coercion — Timeout / NumberOfWorkers /
#      MaxRetries / ExecutionProperty.MaxConcurrentRuns are synthed as STRINGS
#      in the template; the provider must coerce them to numbers so the Glue
#      SDK accepts them. Asserted via `aws glue get-job` returning real numbers.
#   2. Crawler running-state delete handling (unit-tested; here the crawler is
#      idle so it just creates + deletes).
#   3. Trigger state-machine (unit-tested; the ON_DEMAND trigger create+delete
#      is exercised here).
#   4. Workflow Tags from a MAP shape reaching AWS — asserted via
#      `aws glue get-tags` on the workflow ARN.
#   5. Crawler `Targets.DynamoDBTargets[].ScanAll` / `.ScanRate` reaching AWS
#      (issue #1391). CFn spells them PascalCase; the SDK `DynamoDBTarget` is a
#      lowercase island (`scanAll` / `scanRate`), and the SDK v3 serializer
#      drops unknown members, so the scan tuning silently never reached AWS
#      while the target itself (matched by `Path`) survived. Asserted via
#      `aws glue get-crawler` on BOTH the base deploy and the UPDATE re-deploy.
#   6. Table `StorageDescriptor.SkewedInfo` reaching AWS (issue #1505).
#      `buildStorageDescriptor` was an explicit 11-member allow-list that
#      dropped it, and the #1479 live-merge made a DECLARED one worse than a
#      plain drop. Asserted via `aws glue get-table` on BOTH phases; the update
#      phase flips the skewed value so a stale carry-forward cannot pass.
#   7. Database `DatabaseInput.TargetDatabase` / `.CreateTableDefaultPermissions`
#      reaching AWS (issue #1807). `buildDatabaseInput` was a fresh-object
#      builder naming only Description / LocationUri / Parameters, so a
#      RESOURCE LINK database deployed as a plain empty one and a declared Lake
#      Formation default-permission set was dropped on the floor — same
#      spelling on the CFn and SDK sides, so nothing errored and drift could
#      not see it either. Asserted via `aws glue get-database` on BOTH phases;
#      the update phase flips the permission set (UpdateDatabase REPLACES
#      DatabaseInput wholesale, so a regression ERASES it from a live
#      database).
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

cd "$(dirname "$0")"

STACK="GlueUpdateHardeningStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOWER="$(echo "${STACK}" | tr '[:upper:]' '[:lower:]')"
JOB_NAME_FALLBACK="${LOWER}-etl-job"
WORKFLOW_NAME_FALLBACK="${LOWER}-workflow"
CRAWLER_NAME_FALLBACK="${LOWER}-crawler"
TRIGGER_NAME_FALLBACK="${LOWER}-trigger"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  local destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
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
# Force the base (non-update) synth even if the caller exported
# CDKD_TEST_UPDATE=true — the update path is exercised unconditionally in
# Phase 2 below, so Phase 1 must always create the base shape (Job.Timeout 60).
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

JOB_NAME=$(echo "${STATE}" | jq -r '.outputs.JobName // empty')
[ -z "${JOB_NAME}" ] && JOB_NAME="${JOB_NAME_FALLBACK}"
WORKFLOW_NAME=$(echo "${STATE}" | jq -r '.outputs.WorkflowName // empty')
[ -z "${WORKFLOW_NAME}" ] && WORKFLOW_NAME="${WORKFLOW_NAME_FALLBACK}"
CRAWLER_NAME=$(echo "${STATE}" | jq -r '.outputs.CrawlerName // empty')
[ -z "${CRAWLER_NAME}" ] && CRAWLER_NAME="${CRAWLER_NAME_FALLBACK}"
TRIGGER_NAME=$(echo "${STATE}" | jq -r '.outputs.TriggerName // empty')
[ -z "${TRIGGER_NAME}" ] && TRIGGER_NAME="${TRIGGER_NAME_FALLBACK}"
# The crawler's DynamoDB target table is CDK-autonamed, so there is no
# deterministic fallback — the output is the only source.
CRAWLER_TABLE_NAME=$(echo "${STATE}" | jq -r '.outputs.CrawlerTableName // empty')
if [ -z "${CRAWLER_TABLE_NAME}" ]; then
  echo "FAIL: state has no CrawlerTableName output after deploy" >&2
  exit 1
fi
SKEWED_DB_NAME=$(echo "${STATE}" | jq -r '.outputs.SkewedTableDbName // empty')
[ -z "${SKEWED_DB_NAME}" ] && SKEWED_DB_NAME="${LOWER}-table-db"
SKEWED_TABLE_NAME=$(echo "${STATE}" | jq -r '.outputs.SkewedTableName // empty')
[ -z "${SKEWED_TABLE_NAME}" ] && SKEWED_TABLE_NAME="${LOWER}-skewed-table"
LINK_DB_NAME="${LOWER}-link-db"
PERM_DB_NAME="${LOWER}-perm-db"

echo "    Using job '${JOB_NAME}', workflow '${WORKFLOW_NAME}', crawler '${CRAWLER_NAME}', trigger '${TRIGGER_NAME}', crawler table '${CRAWLER_TABLE_NAME}'"

# --- Assertion 1: Job numeric props reached AWS as NUMBERS ------------
# The provider's numeric-coercion fix sends real numbers to the Glue SDK.
# `aws glue get-job` returns JSON numbers — jq `type` confirms they are numbers
# (not strings) and the values match the fixture. (The string-INPUT coercion
# path is unit-tested; CDK's L1 validator rejects string numerics at synth.)
JOB_JSON=$(aws glue get-job --job-name "${JOB_NAME}" --region "${REGION}" 2>/dev/null)
if [ -z "${JOB_JSON}" ]; then
  echo "FAIL: get-job returned nothing for ${JOB_NAME}" >&2
  exit 1
fi

assert_number() {
  local path="$1" expected="$2" label="$3"
  local typ val
  typ=$(echo "${JOB_JSON}" | jq -r "${path} | type")
  val=$(echo "${JOB_JSON}" | jq -r "${path}")
  if [ "${typ}" != "number" ]; then
    echo "FAIL: ${label} is type '${typ}' (value '${val}'), expected number — numeric coercion NOT applied" >&2
    exit 1
  fi
  if [ "${val}" != "${expected}" ]; then
    echo "FAIL: ${label} is ${val}, expected ${expected}" >&2
    exit 1
  fi
  echo "    OK: ${label} == ${val} (number)"
}

assert_number '.Job.Timeout' '60' 'Job.Timeout'
assert_number '.Job.NumberOfWorkers' '2' 'Job.NumberOfWorkers'
assert_number '.Job.MaxRetries' '1' 'Job.MaxRetries'
assert_number '.Job.ExecutionProperty.MaxConcurrentRuns' '2' 'Job.ExecutionProperty.MaxConcurrentRuns'

# --- Assertion 2: Workflow tags (MAP shape) reached AWS ---------------
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
WF_ARN="arn:aws:glue:${REGION}:${ACCOUNT_ID}:workflow/${WORKFLOW_NAME}"
WF_TAGS=$(aws glue get-tags --resource-arn "${WF_ARN}" --region "${REGION}" \
  --query 'Tags' --output json)
ENV_TAG=$(echo "${WF_TAGS}" | jq -r '.env // empty')
TEAM_TAG=$(echo "${WF_TAGS}" | jq -r '."team" // empty')
if [ "${ENV_TAG}" != "integ" ] || [ "${TEAM_TAG}" != "data-platform" ]; then
  echo "FAIL: Workflow tags missing/wrong on AWS (env='${ENV_TAG}', team='${TEAM_TAG}'); MAP-shape tags were silently dropped" >&2
  echo "${WF_TAGS}" >&2
  exit 1
fi
echo "    OK: Workflow MAP-shape tags reached AWS (env=integ, team=data-platform)"

# --- Assertion 3: Crawler DynamoDB scan tuning reached AWS (#1391) -----
# The SDK `DynamoDBTarget` spells the scan tuning `scanAll` / `scanRate`
# (lowercase) while CFn spells it `ScanAll` / `ScanRate`; the SDK v3 serializer
# DROPS unknown members, so without the rename the target still reaches AWS
# (matched by `Path`) but the tuning is silently lost. The fixture sends
# NON-DEFAULT values (`ScanAll: false`, `ScanRate: 0.9`) precisely so an
# AWS-side default cannot satisfy this assertion: `ScanAll` defaults to true
# when unset, and `ScanRate` is stored as null when unset.
assert_ddb_scan_tuning() { # usage: assert_ddb_scan_tuning <crawler-json> <want scanAll> <want scanRate> <phase label>
  local json="$1" want_all="$2" want_rate="$3" phase="$4"
  local target got_all got_rate rate_ok
  target=$(printf '%s' "${json}" | jq -c '.Crawler.Targets.DynamoDBTargets[0]')
  if [ -z "${target}" ] || [ "${target}" = "null" ]; then
    echo "FAIL: ${phase}: Crawler has no DynamoDBTargets entry at all" >&2
    printf '%s\n' "${json}" >&2
    exit 1
  fi
  # `has()` rather than jq's `//` alternative operator: `//` treats a
  # legitimate `false` as absent, which is exactly the base-phase ScanAll
  # value. The PascalCase branch is a diagnostic fallback — if AWS ever starts
  # echoing the CFn spelling we want a value mismatch, not a bogus "absent".
  got_all=$(printf '%s' "${target}" | jq -r 'if has("scanAll") then (.scanAll|tostring) elif has("ScanAll") then (.ScanAll|tostring) else "<absent>" end')
  got_rate=$(printf '%s' "${target}" | jq -r 'if has("scanRate") then (.scanRate|tostring) elif has("ScanRate") then (.ScanRate|tostring) else "<absent>" end')
  if [ "${got_all}" != "${want_all}" ]; then
    echo "FAIL: ${phase}: DynamoDBTargets[0] scanAll is '${got_all}', expected '${want_all}' — CFn ScanAll never reached AWS (issue #1391)" >&2
    printf '%s\n' "${target}" >&2
    exit 1
  fi
  if [ "${got_rate}" = "<absent>" ]; then
    echo "FAIL: ${phase}: DynamoDBTargets[0] scanRate is absent, expected ${want_rate} — CFn ScanRate never reached AWS (issue #1391)" >&2
    printf '%s\n' "${target}" >&2
    exit 1
  fi
  # AWS echoes ScanRate as a JSON double, so compare numerically with a
  # tolerance instead of string-matching a float rendering.
  rate_ok=$(jq -rn --argjson got "${got_rate}" --argjson want "${want_rate}" \
    'if ($got > ($want - 0.0001) and $got < ($want + 0.0001)) then "yes" else "no" end')
  if [ "${rate_ok}" != "yes" ]; then
    echo "FAIL: ${phase}: DynamoDBTargets[0] scanRate is ${got_rate}, expected ${want_rate} (issue #1391)" >&2
    printf '%s\n' "${target}" >&2
    exit 1
  fi
  echo "    OK: ${phase}: DynamoDBTargets[0] scanAll=${got_all} scanRate=${got_rate} reached AWS"
}

CRAWLER_JSON=$(aws glue get-crawler --name "${CRAWLER_NAME}" --region "${REGION}" --output json)
echo "    OK: crawler ${CRAWLER_NAME} exists"
# `Path` is the member that survived even BEFORE the #1391 fix (it is
# PascalCase in the SDK too), so asserting it separately keeps the two halves
# of the bug distinguishable in a failure report: target present, tuning lost.
DDB_TARGET_PATH=$(printf '%s' "${CRAWLER_JSON}" | jq -r '.Crawler.Targets.DynamoDBTargets[0].Path // "<absent>"')
if [ "${DDB_TARGET_PATH}" != "${CRAWLER_TABLE_NAME}" ]; then
  echo "FAIL: DynamoDBTargets[0].Path is '${DDB_TARGET_PATH}', expected '${CRAWLER_TABLE_NAME}'" >&2
  exit 1
fi
echo "    OK: DynamoDBTargets[0].Path == ${CRAWLER_TABLE_NAME}"
assert_ddb_scan_tuning "${CRAWLER_JSON}" 'false' '0.9' 'create'

# --- Assertion: Table StorageDescriptor.SkewedInfo reached AWS (issue #1505) --
# `buildStorageDescriptor` was an explicit 11-member allow-list, so SkewedInfo
# was dropped outright. There is no AWS-side default that can satisfy this:
# an unset SkewedInfo reads back absent (or with empty member lists), so any
# non-empty skewed column name proves the member was delivered.
# `SkewedColumnValueLocationMaps` additionally proves the CFn free-form-object
# -> SDK Record<string,string> coercion.
assert_skewed_info() { # usage: assert_skewed_info <want skewed value> <phase label>
  local want="$1" phase="$2" table_json sd got_names got_values got_map
  # `|| return 1` on every capture (#1120): errexit is CLEARED inside `$( )`, so
  # without it a failed probe would fall through to the comparisons below and
  # report a misleading "SkewedInfo never reached AWS" instead of the real error.
  table_json=$(aws glue get-table --database-name "${SKEWED_DB_NAME}" --name "${SKEWED_TABLE_NAME}" \
    --region "${REGION}" --output json) || return 1
  sd=$(printf '%s' "${table_json}" | jq -c '.Table.StorageDescriptor // {}') || return 1
  # sort() both sides: AWS does not guarantee list order on readback.
  got_names=$(printf '%s' "${sd}" | jq -r '(.SkewedInfo.SkewedColumnNames // []) | sort | join(",")') || return 1
  if [ "${got_names}" != "country" ]; then
    echo "FAIL: ${phase}: StorageDescriptor.SkewedInfo.SkewedColumnNames is '${got_names}', expected 'country' — SkewedInfo never reached AWS (issue #1505)" >&2
    exit 1
  fi
  got_values=$(printf '%s' "${sd}" | jq -r '(.SkewedInfo.SkewedColumnValues // []) | sort | join(",")') || return 1
  if [ "${got_values}" != "${want}" ]; then
    echo "FAIL: ${phase}: SkewedInfo.SkewedColumnValues is '${got_values}', expected '${want}'" >&2
    exit 1
  fi
  got_map=$(printf '%s' "${sd}" | jq -r --arg k "${want}" '.SkewedInfo.SkewedColumnValueLocationMaps[$k] // "<absent>"') || return 1
  case "${got_map}" in
    s3://*"/skewed/${want}/") ;;
    *)
      echo "FAIL: ${phase}: SkewedColumnValueLocationMaps['${want}'] is '${got_map}', expected an s3://.../skewed/${want}/ URI" >&2
      exit 1
      ;;
  esac
  echo "    OK: ${phase}: SkewedInfo reached AWS (names=${got_names} values=${got_values} map[${want}]=${got_map})"
}
assert_skewed_info 'US' 'create'

# --- issue #1807: DatabaseInput.TargetDatabase / CreateTableDefaultPermissions
# `buildDatabaseInput` named only Description / LocationUri / Parameters, so a
# database declared as a RESOURCE LINK deployed as a plain empty database and
# a declared Lake Formation default-permission set never reached AWS. Both
# spell identically on the CFn and SDK sides, so nothing errored and the
# nested-key critic's KEY pass could not see it either — only its write pass
# could, which is why the fix and the `freshObjectMapper` opt-in landed
# together.
assert_resource_link() { # usage: assert_resource_link <phase label>
  local phase="$1" db_json got_db got_catalog
  # `|| return 1` on every capture (#1120): errexit is CLEARED inside `$( )`.
  db_json=$(aws glue get-database --name "${LINK_DB_NAME}" --region "${REGION}" --output json) || return 1
  got_db=$(printf '%s' "${db_json}" | jq -r '.Database.TargetDatabase.DatabaseName // "<absent>"') || return 1
  if [ "${got_db}" != "${SKEWED_DB_NAME}" ]; then
    echo "FAIL: ${phase}: TargetDatabase.DatabaseName is '${got_db}', expected '${SKEWED_DB_NAME}' — the resource link never reached AWS (issue #1807)" >&2
    exit 1
  fi
  got_catalog=$(printf '%s' "${db_json}" | jq -r '.Database.TargetDatabase.CatalogId // "<absent>"') || return 1
  case "${got_catalog}" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *)
      echo "FAIL: ${phase}: TargetDatabase.CatalogId is '${got_catalog}', expected a 12-digit account id (issue #1807)" >&2
      exit 1
      ;;
  esac
  echo "    OK: ${phase}: DatabaseInput.TargetDatabase reached AWS (${got_catalog}/${got_db})"
}

assert_default_permissions() { # usage: assert_default_permissions <want perms, sorted+joined> <phase label>
  local want="$1" phase="$2" db_json got_perms got_principal
  db_json=$(aws glue get-database --name "${PERM_DB_NAME}" --region "${REGION}" --output json) || return 1
  # sort() both sides: AWS does not guarantee list order on readback.
  got_perms=$(printf '%s' "${db_json}" \
    | jq -r '[.Database.CreateTableDefaultPermissions[]?.Permissions[]?] | sort | join(",")') || return 1
  if [ "${got_perms}" != "${want}" ]; then
    echo "FAIL: ${phase}: CreateTableDefaultPermissions grants '${got_perms}', expected '${want}' — the block never reached AWS (issue #1807; AWS defaults an undeclared database to ALL, so a drop reads as 'ALL')" >&2
    exit 1
  fi
  got_principal=$(printf '%s' "${db_json}" \
    | jq -r '.Database.CreateTableDefaultPermissions[0].Principal.DataLakePrincipalIdentifier // "<absent>"') || return 1
  if [ "${got_principal}" != "IAM_ALLOWED_PRINCIPALS" ]; then
    echo "FAIL: ${phase}: CreateTableDefaultPermissions[0].Principal.DataLakePrincipalIdentifier is '${got_principal}', expected IAM_ALLOWED_PRINCIPALS (issue #1807)" >&2
    exit 1
  fi
  echo "    OK: ${phase}: CreateTableDefaultPermissions reached AWS (${got_principal} -> ${got_perms})"
}

assert_resource_link 'create'
assert_default_permissions 'SELECT' 'create'

# --- Sanity: trigger exists -------------------------------------------
if aws glue get-trigger --name "${TRIGGER_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "    OK: trigger ${TRIGGER_NAME} exists"
else
  echo "FAIL: trigger ${TRIGGER_NAME} missing" >&2
  exit 1
fi

# --- Phase 2: UPDATE --------------------------------------------------
# Always exercise the update path (the whole point of "update hardening") by
# inlining CDKD_TEST_UPDATE=true on THIS deploy only — matching the
# dynamodb-ondemand Phase 1.5 convention. Gating the phase on a caller-set env
# would (a) skip the update test on a plain `bash verify.sh` run and (b) make
# Phase 1's base-shape deploy synth the updated values, so the env must be
# controlled per-phase, not globally.
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (trigger desc + job timeout + crawler scan tuning)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
NEW_TIMEOUT=$(aws glue get-job --job-name "${JOB_NAME}" --region "${REGION}" \
  --query 'Job.Timeout' --output text)
if [ "${NEW_TIMEOUT}" != "90" ]; then
  echo "FAIL: Job.Timeout after update is '${NEW_TIMEOUT}', expected 90 (update numeric coercion failed)" >&2
  exit 1
fi
echo "    OK: Job.Timeout updated to 90 (number)"

# The UPDATE path has its own CFn -> SDK rename call site (UpdateCrawler), so
# re-assert the scan tuning against the second, distinct pair.
CRAWLER_JSON=$(aws glue get-crawler --name "${CRAWLER_NAME}" --region "${REGION}" --output json)
# NOTE: scanRate carries the regression signal for THIS phase. `true` is AWS's
# own default for scanAll, so that half of the assertion would also pass if the
# update dropped the tuning entirely — only the 1.2 discriminates. (The create
# phase asserts the drop-proof pair, false/0.9, and fails first anyway.)
assert_ddb_scan_tuning "${CRAWLER_JSON}" 'true' '1.2' 'update'

# The UPDATE path shares `buildDatabaseInput` with create, but through
# UpdateDatabase — which REPLACES DatabaseInput wholesale, so a member the
# builder stopped naming is erased from a LIVE database rather than merely
# never sent. The resource link is re-asserted unchanged; the permission set
# flips to a second, distinct payload so a stale carry-forward cannot pass.
assert_resource_link 'update'
assert_default_permissions 'ALL,DROP' 'update'

# The UPDATE path is where the #1479 interaction bites: the merge's key sets
# come from the RAW template, so DECLARING SkewedInfo suppresses the live
# carry-forward — and before #1505 the builder sent nothing, so UpdateTable's
# full replace ERASED the member. The flipped value ('CA') is what discriminates:
# a carry-forward of the create-phase value would still read 'US'.
assert_skewed_info 'CA' 'update'

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

for chk in \
  "get-job --job-name ${JOB_NAME}" \
  "get-crawler --name ${CRAWLER_NAME}" \
  "get-trigger --name ${TRIGGER_NAME}" \
  "get-workflow --name ${WORKFLOW_NAME}" \
  "get-table --database-name ${SKEWED_DB_NAME} --name ${SKEWED_TABLE_NAME}" \
  "get-database --name ${SKEWED_DB_NAME}" \
  "get-database --name ${LINK_DB_NAME}" \
  "get-database --name ${PERM_DB_NAME}"; do
  # Route through gone_probe (issue #1097 pattern 2): Glue get-* not-found is
  # EntityNotFoundException, which matches the canonical signature; any other
  # probe failure (throttle, auth) hard-FAILs instead of reading as "gone".
  # shellcheck disable=SC2086
  if ! gone_probe aws glue ${chk} --region "${REGION}"; then
    echo "FAIL: Glue resource still exists after destroy: ${chk}" >&2
    exit 1
  fi
done
echo "    OK: all Glue resources are gone"

# DeleteTable is async and the provider does not wait, so the table is normally
# still DELETING moments after destroy returns. Accept GONE or DELETING; only a
# live state (ACTIVE / UPDATING) means the delete never happened. Same shape as
# dynamodb-gsi-update/verify.sh. (No sleep: DeleteTable transitions the table to
# DELETING synchronously, so one check right after destroy is sufficient.)
if gone_probe aws dynamodb describe-table --table-name "${CRAWLER_TABLE_NAME}" --region "${REGION}"; then
  ddb_status="GONE"
elif ! ddb_status="$(aws dynamodb describe-table --table-name "${CRAWLER_TABLE_NAME}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>&1)"; then
  # TOCTOU: the table can vanish between gone_probe and this requery.
  printf '%s' "${ddb_status}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && ddb_status="GONE" \
    || { echo "FAIL: describe-table requery undetermined: ${ddb_status}" >&2; exit 1; }
fi
if [ "${ddb_status}" != "GONE" ] && [ "${ddb_status}" != "DELETING" ]; then
  echo "FAIL: DynamoDB crawler-target table ${CRAWLER_TABLE_NAME} still exists (status ${ddb_status}) after destroy" >&2
  exit 1
fi
echo "    OK: DynamoDB crawler-target table is gone (status: ${ddb_status})"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> glue-update-hardening test passed (numeric coercion + MAP tags + DynamoDB scan tuning + Table SkewedInfo + Database TargetDatabase/CreateTableDefaultPermissions + clean destroy)"
