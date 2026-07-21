#!/usr/bin/env bash
# verify.sh — cdkd "logical-id rename refactor" structural integ.
#
# The daily refactor pattern: a queue, a table, and a lambda get their
# construct ids (and thus logical ids) renamed in one deploy, while an events
# Rule with a stable id keeps targeting the lambda. The deploy must create the
# new generation, retarget the kept rule, and delete the old generation — and
# a resource whose logical id is PINNED (overrideLogicalId) while only its
# construct path changed (Metadata aws:cdk:path) must be a no-op, not an
# update. Verified CLEAN live in bug-hunt sweep 17 (2026-07-21); this fixture
# pins that behavior against regression.
#
# Phases:
#   1. Deploy baseline (generation "a"). Assert the lambda's env wiring is
#      real (invoke it), the rule targets it, and capture the pinned SSM
#      parameter's Version.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (generation "b"). Assert: new
#      queue/table/lambda exist with rewired references, the SAME rule now
#      targets the new lambda, every old-generation resource is gone, and the
#      pinned parameter's Version is UNCHANGED (metadata-only no-op).
#   3. Destroy + assert everything (incl. the rule and the pinned parameter)
#      is gone and the cdkd state file is removed.
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

STACK="CdkdRenameRefactorExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PFX="cdkd-rename-refactor"
PARAM_NAME="/cdkd-integ/${PFX}/stable"
RULE_NAME="${PFX}-tick"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# DynamoDB DeleteTable is ASYNC: right after a successful delete the table can
# still describe as DELETING for a while. Accept GONE or DELETING as deleted;
# any live status (ACTIVE / UPDATING) means the delete never happened.
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

sweep_log_groups() {
  ( set +eu
    for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${PFX}-" \
        --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
      aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for gen in a b; do
    aws lambda delete-function --function-name "${PFX}-handler-${gen}" --region "${REGION}" >/dev/null 2>&1
    url="$(aws sqs get-queue-url --queue-name "${PFX}-work-${gen}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
    [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
    aws dynamodb delete-table --table-name "${PFX}-data-${gen}" --region "${REGION}" >/dev/null 2>&1
  done
  # Resolve target ids dynamically -- hardcoding CDK's generated "Target0"
  # would silently no-op if the id convention ever changes, leaking the rule.
  target_ids="$(aws events list-targets-by-rule --rule "${RULE_NAME}" --region "${REGION}" --query 'Targets[].Id' --output text 2>/dev/null)"
  # shellcheck disable=SC2086 # word splitting of the id list is intentional
  [ -n "${target_ids}" ] && aws events remove-targets --rule "${RULE_NAME}" --ids ${target_ids} --region "${REGION}" >/dev/null 2>&1
  aws events delete-rule --name "${RULE_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
  sweep_log_groups
  rm -f invoke-out.json
  if [ -n "${STATE_BUCKET:-}" ]; then
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

# --- Phase 1: deploy baseline (generation "a") -------------------------------
echo "==> Phase 1: deploy baseline (generation a)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

QUEUE_URL_A="$(aws sqs get-queue-url --queue-name "${PFX}-work-a" --region "${REGION}" --query QueueUrl --output text)"

ENV_QUEUE_P1="$(aws lambda get-function-configuration --function-name "${PFX}-handler-a" \
  --region "${REGION}" --query 'Environment.Variables.QUEUE_URL' --output text)"
if [ "${ENV_QUEUE_P1}" != "${QUEUE_URL_A}" ]; then
  echo "FAIL: handler-a QUEUE_URL env expected ${QUEUE_URL_A}, got ${ENV_QUEUE_P1}" >&2
  exit 1
fi
ENV_TABLE_P1="$(aws lambda get-function-configuration --function-name "${PFX}-handler-a" \
  --region "${REGION}" --query 'Environment.Variables.TABLE_NAME' --output text)"
if [ "${ENV_TABLE_P1}" != "${PFX}-data-a" ]; then
  echo "FAIL: handler-a TABLE_NAME env expected ${PFX}-data-a, got ${ENV_TABLE_P1}" >&2
  exit 1
fi
echo "    handler-a env wired to queue-a + table-a"

# Functional: the lambda actually runs and sees the wired env.
aws lambda invoke --function-name "${PFX}-handler-a" --region "${REGION}" invoke-out.json >/dev/null
if ! grep -q '"ok":true' invoke-out.json || ! grep -q "${PFX}-work-a" invoke-out.json; then
  echo "FAIL: handler-a invoke did not return the wired queue URL: $(cat invoke-out.json)" >&2
  exit 1
fi
echo "    handler-a invoke returned the wired queue URL (functional)"

FN_ARN_A="$(aws lambda get-function-configuration --function-name "${PFX}-handler-a" \
  --region "${REGION}" --query FunctionArn --output text)"
RULE_TARGET_P1="$(aws events list-targets-by-rule --rule "${RULE_NAME}" --region "${REGION}" \
  --query 'Targets[0].Arn' --output text)"
if [ "${RULE_TARGET_P1}" != "${FN_ARN_A}" ]; then
  echo "FAIL: rule target expected ${FN_ARN_A}, got ${RULE_TARGET_P1}" >&2
  exit 1
fi
echo "    rule ${RULE_NAME} targets handler-a"

PARAM_VERSION_P1="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Version' --output text)"
echo "    pinned parameter Version=${PARAM_VERSION_P1}"

# --- Phase 2: rename refactor (generation "b") -------------------------------
echo "==> Phase 2: re-deploy with renamed construct ids (generation b)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

QUEUE_URL_B="$(aws sqs get-queue-url --queue-name "${PFX}-work-b" --region "${REGION}" --query QueueUrl --output text)"

ENV_QUEUE_P2="$(aws lambda get-function-configuration --function-name "${PFX}-handler-b" \
  --region "${REGION}" --query 'Environment.Variables.QUEUE_URL' --output text)"
if [ "${ENV_QUEUE_P2}" != "${QUEUE_URL_B}" ]; then
  echo "FAIL: handler-b QUEUE_URL env expected ${QUEUE_URL_B}, got ${ENV_QUEUE_P2}" >&2
  exit 1
fi
ENV_TABLE_P2="$(aws lambda get-function-configuration --function-name "${PFX}-handler-b" \
  --region "${REGION}" --query 'Environment.Variables.TABLE_NAME' --output text)"
if [ "${ENV_TABLE_P2}" != "${PFX}-data-b" ]; then
  echo "FAIL: handler-b TABLE_NAME env expected ${PFX}-data-b, got ${ENV_TABLE_P2}" >&2
  exit 1
fi
echo "    handler-b env wired to queue-b + table-b (references rewired)"

FN_ARN_B="$(aws lambda get-function-configuration --function-name "${PFX}-handler-b" \
  --region "${REGION}" --query FunctionArn --output text)"
RULE_TARGET_P2="$(aws events list-targets-by-rule --rule "${RULE_NAME}" --region "${REGION}" \
  --query 'Targets[0].Arn' --output text)"
if [ "${RULE_TARGET_P2}" != "${FN_ARN_B}" ]; then
  echo "FAIL: kept rule target expected ${FN_ARN_B}, got ${RULE_TARGET_P2}" >&2
  exit 1
fi
# Exactly ONE target: a retarget that ADDED the new ARN instead of replacing
# would leave a stale handler-a target behind while Targets[0] still matches.
RULE_TARGET_COUNT_P2="$(aws events list-targets-by-rule --rule "${RULE_NAME}" --region "${REGION}" \
  --query 'length(Targets)' --output text)"
if [ "${RULE_TARGET_COUNT_P2}" != "1" ]; then
  echo "FAIL: kept rule expected exactly 1 target after retarget, got ${RULE_TARGET_COUNT_P2}" >&2
  exit 1
fi
echo "    kept rule ${RULE_NAME} retargeted to handler-b (single target)"

# Old generation must be gone after the rename deploy.
assert_gone "old lambda ${PFX}-handler-a still exists after rename" \
  aws lambda get-function --function-name "${PFX}-handler-a" --region "${REGION}"
assert_gone "old queue ${PFX}-work-a still exists after rename" \
  aws sqs get-queue-url --queue-name "${PFX}-work-a" --region "${REGION}"
assert_table_deleted "${PFX}-data-a" "after rename"
echo "    old generation (handler-a / work-a / data-a) deleted"

# The pinned-logical-id parameter saw only a Metadata aws:cdk:path change:
# it must NOT have been updated (SSM increments Version on every put).
PARAM_VERSION_P2="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Version' --output text)"
if [ "${PARAM_VERSION_P2}" != "${PARAM_VERSION_P1}" ]; then
  echo "FAIL: pinned parameter was updated (Version ${PARAM_VERSION_P1} -> ${PARAM_VERSION_P2}) despite metadata-only change" >&2
  exit 1
fi
echo "    pinned parameter untouched (Version ${PARAM_VERSION_P2}) — metadata-only no-op"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "lambda ${PFX}-handler-b still exists after destroy" \
  aws lambda get-function --function-name "${PFX}-handler-b" --region "${REGION}"
assert_gone "queue ${PFX}-work-b still exists after destroy" \
  aws sqs get-queue-url --queue-name "${PFX}-work-b" --region "${REGION}"
assert_table_deleted "${PFX}-data-b" "after destroy"
assert_gone "rule ${RULE_NAME} still exists after destroy" \
  aws events describe-rule --name "${RULE_NAME}" --region "${REGION}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    all resources + cdkd state removed"

sweep_log_groups
echo "    /aws/lambda/${PFX}-* log groups swept"

echo "[verify] PASS — rename refactor: new generation created, kept rule retargeted, old generation deleted, pinned logical id no-oped, destroy clean"
