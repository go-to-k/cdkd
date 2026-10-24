#!/usr/bin/env bash
# verify.sh — `cdkd refactor` (go-to-k/cdkd#5201) against real AWS.
#
# Generation "a" and generation "b" (CDKD_TEST_UPDATE=true) differ only in
# construct ids. Without a refactor, deploying "b" would replace the table,
# the queue and both topics. With `cdkd refactor`, the state records are
# renamed and the deploy of "b" touches nothing.
#
# The whole run uses a NON-default --state-prefix, so every cdkd command's
# prefix handling (state read, lock, conditional save) is exercised, and the
# default-prefix key is asserted never to appear.
#
# Phases:
#   1. Deploy generation "a"; record physical ids; write a data item.
#   2. Under generation "b":
#      a. `cdkd diff --fail-on=destructive` reports the replacement (rc != 0).
#      b. `cdkd refactor --dry-run` refuses on the ambiguous topics and
#         writes nothing (state ETag unchanged).
#      c. `cdkd refactor --dry-run --override-file` plans 4 renames, writes nothing.
#      d. `cdkd refactor --yes --override-file` renames 4 records.
#      e. State holds the new logical ids under the SAME physical ids.
#      f. `cdkd diff --fail` reports no change (rc 0).
#      g. `cdkd deploy` keeps every physical id, the data item, and the SSM
#         parameter's Version (no update).
#   3. Destroy; every resource and the state record are gone.
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

STACK="CdkdRefactorCommandExample"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="cdkd-integ-refactor"
STATE_KEY="${PREFIX}/${STACK}/${REGION}/state.json"
DEFAULT_STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PFX="cdkd-refactor-command"
TABLE="${PFX}-data"
PARAM_NAME="/cdkd-integ/${PFX}/wiring"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cdkd() { node "${LOCAL_DIST}" "$@"; }

# Every cdkd call targets the non-default prefix.
STATE_FLAGS=(--state-bucket "${STATE_BUCKET:-}" --state-prefix "${PREFIX}" --region "${REGION}")

# The state ETag (quotes included), or "absent".
state_etag() {
  local out
  if out="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
      --query ETag --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    printf 'absent'
    return 0
  fi
  echo "FAIL: head-object undetermined: ${out}" >&2
  return 1
}

# The physical id of the ONE state resource whose logical id starts with $1.
physical_id_of() { # usage: physical_id_of <logical-id-prefix> <resources-listing>
  local matches
  matches="$(printf '%s\n' "$2" | awk -v p="$1" 'index($1, p) == 1 { print $3 }')"
  if [ "$(printf '%s\n' "${matches}" | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one state resource starting with $1, got: ${matches:-<none>}" >&2
    return 1
  fi
  printf '%s' "${matches}"
}

# The logical id of the ONE state resource whose logical id starts with $1.
logical_id_of() { # usage: logical_id_of <logical-id-prefix> <resources-listing>
  local matches
  matches="$(printf '%s\n' "$2" | awk -v p="$1" 'index($1, p) == 1 { print $1 }')"
  if [ "$(printf '%s\n' "${matches}" | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one logical id starting with $1, got: ${matches:-<none>}" >&2
    return 1
  fi
  printf '%s' "${matches}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --state-prefix "${PREFIX}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1
  for url in $(aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" \
      --query 'QueueUrls[]' --output text 2>/dev/null); do
    [ "${url}" != "None" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  done
  for arn in $(aws sns list-topics --region "${REGION}" --query 'Topics[].TopicArn' --output text 2>/dev/null); do
    case "${arn}" in
      *":${STACK}-"?*) aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
  # Unset until the pre-run cleanup has run (see below).
  [ -n "${MAP_DIR:-}" ] && rm -rf "${MAP_DIR}"
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# Outside the fixture tree: the mapping file names the AWS account id. Made
# AFTER the pre-run cleanup, which would otherwise remove it.
MAP_DIR="$(mktemp -d)"
MAP_FILE="${MAP_DIR}/refactor-map.json"

# --- Phase 1: deploy generation "a" ------------------------------------------
echo "==> Phase 1: deploy generation a"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX}" --region "${REGION}" --yes

RES_A="$(cdkd state resources "${STACK}" "${STATE_FLAGS[@]}")"
OLD_TABLE_ID="$(logical_id_of LegacyTable "${RES_A}")"
OLD_QUEUE_ID="$(logical_id_of Queue "${RES_A}")"
OLD_TOPIC_X_ID="$(logical_id_of TopicX "${RES_A}")"
OLD_TOPIC_Y_ID="$(logical_id_of TopicY "${RES_A}")"
WIRING_ID="$(logical_id_of Wiring "${RES_A}")"
QUEUE_PID="$(physical_id_of Queue "${RES_A}")"
TOPIC_X_PID="$(physical_id_of TopicX "${RES_A}")"
TOPIC_Y_PID="$(physical_id_of TopicY "${RES_A}")"
TABLE_PID="$(physical_id_of LegacyTable "${RES_A}")"
[ "${TABLE_PID}" = "${TABLE}" ] || { echo "FAIL: table physical id ${TABLE_PID} != ${TABLE}" >&2; exit 1; }
for v in QUEUE_PID TOPIC_X_PID TOPIC_Y_PID; do
  [ -n "${!v}" ] || { echo "FAIL: ${v} is empty" >&2; exit 1; }
done
echo "    queue ${QUEUE_PID}, topics ${TOPIC_X_PID} / ${TOPIC_Y_PID}, table ${TABLE_PID}"

aws dynamodb put-item --table-name "${TABLE}" --region "${REGION}" \
  --item '{"pk":{"S":"keep-me"},"v":{"S":"survives the refactor"}}'
PARAM_VERSION_A="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Version' --output text)"
QUEUE_CREATED_A="$(aws sqs get-queue-attributes --queue-url "${QUEUE_PID}" --region "${REGION}" \
  --attribute-names CreatedTimestamp --query 'Attributes.CreatedTimestamp' --output text)"

if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${DEFAULT_STATE_KEY}"; then
  echo "FAIL: a state record appeared under the default prefix (${DEFAULT_STATE_KEY})" >&2
  exit 1
fi

# --- Phase 2: generation "b" -------------------------------------------------
export CDKD_TEST_UPDATE=true

echo "==> Phase 2a: diff reports the replacement a plain deploy would make"
set +e
OUT_2A="$(cdkd diff "${STACK}" "${STATE_FLAGS[@]}" --fail-on=destructive 2>&1)"
rc=$?
set -e
printf '%s\n' "${OUT_2A}"
[ "${rc}" -ne 0 ] || { echo "FAIL: diff --fail-on=destructive exited 0 before the refactor" >&2; exit 1; }
echo "    diff --fail-on=destructive rc=${rc}"
# go-to-k/cdkd#5203: the table's removal names where it reappears; the two
# look-alike topics are ambiguous, so neither carries a hint. Sentinel: the
# removal row itself must be there before its hint is judged.
TABLE_ROW="$(printf '%s\n' "${OUT_2A}" | grep -F "[-] ${OLD_TABLE_ID} (" || true)"
[ -n "${TABLE_ROW}" ] || { echo "FAIL: diff shows no removal row for ${OLD_TABLE_ID}" >&2; exit 1; }
printf '%s' "${TABLE_ROW}" | grep -qF "(moved to ${STACK}.StorageData" \
  || { echo "FAIL: the table's removal row carries no refactor hint" >&2; exit 1; }
printf '%s' "${TABLE_ROW}" | grep -qF "run 'cdkd refactor' to keep it)" \
  || { echo "FAIL: the table's hint does not name cdkd refactor" >&2; exit 1; }
TOPIC_ROWS="$(printf '%s\n' "${OUT_2A}" | grep -F '(AWS::SNS::Topic)' | grep -F '[-] ' || true)"
[ -n "${TOPIC_ROWS}" ] || { echo "FAIL: diff shows no topic removal rows" >&2; exit 1; }
if printf '%s\n' "${TOPIC_ROWS}" | grep -qF 'moved to'; then
  echo "FAIL: an ambiguous topic removal carries a refactor hint" >&2
  exit 1
fi
echo "    the table's removal names StorageData; the ambiguous topics carry no hint"

echo "==> Phase 2b: refactor --dry-run refuses on the ambiguous topics"
ETAG_BEFORE="$(state_etag)"
set +e
OUT_2B="$(cdkd refactor "${STACK}" "${STATE_FLAGS[@]}" --dry-run 2>&1)"
rc=$?
set -e
printf '%s\n' "${OUT_2B}"
[ "${rc}" -ne 0 ] || { echo "FAIL: refactor with ambiguous topics exited 0" >&2; exit 1; }
printf '%s' "${OUT_2B}" | grep -q 'Ambiguous (AWS::SNS::Topic)' \
  || { echo "FAIL: refactor did not report the ambiguous topics" >&2; exit 1; }
printf '%s' "${OUT_2B}" | grep -q "${OLD_TABLE_ID} -> StorageData" \
  || { echo "FAIL: refactor did not plan the table rename" >&2; exit 1; }
[ "$(state_etag)" = "${ETAG_BEFORE}" ] || { echo "FAIL: state changed during a refused dry run" >&2; exit 1; }

echo "==> Phase 2c: refactor --dry-run with a mapping file plans 4 renames"
cdkd synth "${STACK}" --region "${REGION}" >/dev/null
TEMPLATE_B="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE_B}" ] || { echo "FAIL: synth wrote no ${TEMPLATE_B}" >&2; exit 1; }
new_id() { # usage: new_id <prefix>
  node -e '
    const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ids = Object.keys(t.Resources).filter((id) => id.startsWith(process.argv[2]));
    if (ids.length !== 1) { console.error(`expected one ${process.argv[2]}*, got ${ids}`); process.exit(1); }
    process.stdout.write(ids[0]);
  ' "${TEMPLATE_B}" "$1"
}
NEW_TOPIC_X_ID="$(new_id AlertsX)"
NEW_TOPIC_Y_ID="$(new_id AlertsY)"
NEW_TABLE_ID="$(new_id StorageData)"
NEW_QUEUE_ID="$(new_id WorkQueue)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
cat > "${MAP_FILE}" <<JSON
{
  "environments": [
    {
      "account": "${ACCOUNT}",
      "region": "${REGION}",
      "resources": {
        "${STACK}.${OLD_TOPIC_X_ID}": "${STACK}.${NEW_TOPIC_X_ID}",
        "${STACK}.${OLD_TOPIC_Y_ID}": "${STACK}.${NEW_TOPIC_Y_ID}"
      }
    }
  ]
}
JSON
OUT_2C="$(cdkd refactor "${STACK}" "${STATE_FLAGS[@]}" --dry-run --override-file "${MAP_FILE}" 2>&1)"
printf '%s\n' "${OUT_2C}"
for pair in "${OLD_TABLE_ID} -> ${NEW_TABLE_ID}" "${OLD_QUEUE_ID} -> ${NEW_QUEUE_ID}" \
    "${OLD_TOPIC_X_ID} -> ${NEW_TOPIC_X_ID}" "${OLD_TOPIC_Y_ID} -> ${NEW_TOPIC_Y_ID}"; do
  printf '%s' "${OUT_2C}" | grep -qF "${pair}" || { echo "FAIL: plan lacks ${pair}" >&2; exit 1; }
done
# Plan lines are indented two spaces; cdkd's own notices (the --region
# deprecation warning) are not, and must not trip this. The positive anchor
# proves the plan lines still carry that indent, so a drift in it fails here
# instead of making the negative grep pass vacuously.
printf '%s\n' "${OUT_2C}" | grep -qE "^  ${OLD_TABLE_ID} -> ${NEW_TABLE_ID}  " \
  || { echo "FAIL: plan lines are no longer two-space indented; the check below would be vacuous" >&2; exit 1; }
if printf '%s\n' "${OUT_2C}" | grep -qE '^  (Warning:|Not refactored|Refused|Ambiguous)'; then
  echo "FAIL: the mapped plan carries a warning or refusal" >&2
  exit 1
fi
printf '%s' "${OUT_2C}" | grep -q 'state was NOT written' \
  || { echo "FAIL: dry run did not say it wrote nothing" >&2; exit 1; }
[ "$(state_etag)" = "${ETAG_BEFORE}" ] || { echo "FAIL: state changed during a dry run" >&2; exit 1; }

echo "==> Phase 2d: refactor"
OUT_2D="$(cdkd refactor "${STACK}" "${STATE_FLAGS[@]}" --yes --override-file "${MAP_FILE}" 2>&1)"
printf '%s\n' "${OUT_2D}"
printf '%s' "${OUT_2D}" | grep -q "Refactored 4 resource(s) in stack ${STACK}" \
  || { echo "FAIL: refactor did not report 4 renames" >&2; exit 1; }
[ "$(state_etag)" != "${ETAG_BEFORE}" ] || { echo "FAIL: refactor did not write state" >&2; exit 1; }
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${DEFAULT_STATE_KEY}"; then
  echo "FAIL: cdkd refactor wrote a state record under the default prefix (${DEFAULT_STATE_KEY})" >&2
  exit 1
fi

echo "==> Phase 2e: state holds the new logical ids under the same physical ids"
RES_B="$(cdkd state resources "${STACK}" "${STATE_FLAGS[@]}")"
[ "$(physical_id_of "${NEW_TABLE_ID}" "${RES_B}")" = "${TABLE_PID}" ] || { echo "FAIL: table physical id moved" >&2; exit 1; }
[ "$(physical_id_of "${NEW_QUEUE_ID}" "${RES_B}")" = "${QUEUE_PID}" ] || { echo "FAIL: queue physical id moved" >&2; exit 1; }
[ "$(physical_id_of "${NEW_TOPIC_X_ID}" "${RES_B}")" = "${TOPIC_X_PID}" ] || { echo "FAIL: topic X physical id moved" >&2; exit 1; }
[ "$(physical_id_of "${NEW_TOPIC_Y_ID}" "${RES_B}")" = "${TOPIC_Y_PID}" ] || { echo "FAIL: topic Y physical id moved" >&2; exit 1; }
for old in "${OLD_TABLE_ID}" "${OLD_QUEUE_ID}" "${OLD_TOPIC_X_ID}" "${OLD_TOPIC_Y_ID}"; do
  if printf '%s\n' "${RES_B}" | awk '{ print $1 }' | grep -qxF "${old}"; then
    echo "FAIL: old logical id ${old} is still in state" >&2
    exit 1
  fi
done
logical_id_of "${WIRING_ID}" "${RES_B}" >/dev/null

echo "==> Phase 2f: diff reports no change"
cdkd diff "${STACK}" "${STATE_FLAGS[@]}" --fail

echo "==> Phase 2g: deploy generation b touches nothing"
cdkd deploy "${STACK}" "${STATE_FLAGS[@]}" --yes
RES_G="$(cdkd state resources "${STACK}" "${STATE_FLAGS[@]}")"
[ "$(physical_id_of "${NEW_QUEUE_ID}" "${RES_G}")" = "${QUEUE_PID}" ] || { echo "FAIL: deploy replaced the queue" >&2; exit 1; }
[ "$(physical_id_of "${NEW_TOPIC_X_ID}" "${RES_G}")" = "${TOPIC_X_PID}" ] || { echo "FAIL: deploy replaced topic X" >&2; exit 1; }
[ "$(physical_id_of "${NEW_TOPIC_Y_ID}" "${RES_G}")" = "${TOPIC_Y_PID}" ] || { echo "FAIL: deploy replaced topic Y" >&2; exit 1; }
QUEUE_CREATED_G="$(aws sqs get-queue-attributes --queue-url "${QUEUE_PID}" --region "${REGION}" \
  --attribute-names CreatedTimestamp --query 'Attributes.CreatedTimestamp' --output text)"
[ "${QUEUE_CREATED_G}" = "${QUEUE_CREATED_A}" ] || { echo "FAIL: queue was re-created" >&2; exit 1; }
ITEM="$(aws dynamodb get-item --table-name "${TABLE}" --region "${REGION}" \
  --key '{"pk":{"S":"keep-me"}}' --query 'Item.v.S' --output text)"
[ "${ITEM}" = "survives the refactor" ] || { echo "FAIL: table data lost (got ${ITEM})" >&2; exit 1; }
PARAM_VERSION_G="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Version' --output text)"
[ "${PARAM_VERSION_G}" = "${PARAM_VERSION_A}" ] \
  || { echo "FAIL: SSM parameter was updated (Version ${PARAM_VERSION_A} -> ${PARAM_VERSION_G})" >&2; exit 1; }
echo "    every physical id, the data item and the parameter Version are unchanged"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
cdkd destroy "${STACK}" "${STATE_FLAGS[@]}" --force
assert_table_deleted() { # usage: assert_table_deleted <table-name> <context>
  local table="$1" ctx="$2" status
  if gone_probe aws dynamodb describe-table --table-name "${table}" --region "${REGION}"; then
    status="GONE"
  elif ! status="$(aws dynamodb describe-table --table-name "${table}" --region "${REGION}" \
      --query 'Table.TableStatus' --output text 2>&1)"; then
    # TOCTOU: the table can vanish between gone_probe and this requery.
    printf '%s' "${status}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && status="GONE" \
      || { echo "FAIL: describe-table requery undetermined (${ctx}): ${status}" >&2; exit 1; }
  fi
  if [ "${status}" != "GONE" ] && [ "${status}" != "DELETING" ]; then
    echo "FAIL: table ${table} still exists (status ${status}) ${ctx}" >&2
    exit 1
  fi
  echo "    table ${table} deleted (status: ${status})"
}
assert_table_deleted "${TABLE}" "after destroy"
assert_gone "queue ${QUEUE_PID} still exists after destroy" \
  aws sqs get-queue-attributes --queue-url "${QUEUE_PID}" --region "${REGION}"
assert_gone "topic ${TOPIC_X_PID} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_X_PID}" --region "${REGION}"
assert_gone "topic ${TOPIC_Y_PID} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_Y_PID}" --region "${REGION}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    all resources + cdkd state removed"

echo "[verify] PASS — cdkd refactor: ambiguity refused, mapped renames applied to state only, deploy kept every resource, destroy clean"
