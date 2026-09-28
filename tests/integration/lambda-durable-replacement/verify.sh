#!/usr/bin/env bash
# verify.sh — cdkd Lambda REPLACEMENT execution (issue #1625).
#
# `tests/unit/analyzer/replacement-rules-lambda-609-props.test.ts` proves the
# CLASSIFICATION (dropping `DurableConfig` requires a replacement, because AWS
# rejects adding one to a function created without it and cannot express its
# removal at all). Nothing exercised the deploy engine PERFORMING that
# replacement for a Lambda: the create-first path, the collision detection, and
# the delete-first fallback that follows.
#
# What the first live run of this fixture established, and why the assertions
# below are shaped the way they are:
#
#   * cdkd generates an unnamed function's physical name DETERMINISTICALLY
#     (`{stackName}-{logicalId}`), so the create-first attempt lands on the name
#     the OLD function still holds. An unnamed Lambda therefore collides exactly
#     like a pinned one, and the physical id is IDENTICAL on both sides of the
#     replacement — so issue #1625's suggested "assert the physical id changed"
#     cannot be the proof of a replacement here. What proves it instead is the
#     pair of end states: the collision refusal in phase 2 (a silently-skipped
#     update would have reported success), and phase 3's live function carrying
#     the NEW properties with NO durable config.
#   * AWS spells the collision SINGULAR — `ResourceConflictException: Function
#     already exist: <name>`. cdkd's `isNameCollisionError` matched only
#     `already exists`, so until the fix shipped with this fixture NO Lambda
#     could take the collision path: the raw SDK error escaped and
#     `--replace`'s delete-first fallback never fired, leaving the replacement
#     unperformable by any flag. Phase 2 asserts the ACTIONABLE message, which
#     is what regresses if that matcher narrows again.
#
# Phases:
#   1. baseline deploy — function created WITH DurableConfig; assert it is live.
#   1b. (issue #3808) a function created OUT OF BAND holds a name; the template
#      renames the managed function onto it and deploys WITH --replace. The
#      name belongs to another resource, so delete-first cannot free it: the
#      deploy must refuse saying so, and the managed function must SURVIVE. A
#      pre-fix binary deleted it first and then collided again.
#   2. drop DurableConfig WITHOUT --replace — the deploy must FAIL with cdkd's
#      actionable replacement-collision error, and the live function must be
#      UNTOUCHED (still durable, still the old description).
#   3. same template WITH --replace — delete-first fallback runs; assert the
#      function exists, has NO durable config, and carries the new description.
#   4. destroy — function gone, state gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""

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

# Bounded-retry variant for a resource whose DELETE is acknowledged before the
# read plane catches up: `DeleteFunction` returns 204 while `GetFunction` can
# keep answering for a few seconds (the same lag `lambda-config-field-removal`
# records). gone_probe still hard-FAILs on an undetermined error, and a
# genuinely leaked function stays visible for the whole window.
assert_gone_eventually() { # usage: assert_gone_eventually <timeout-s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s)" >&2
      exit 1
    fi
    sleep 3
  done
}

cd "$(dirname "$0")"

STACK="CdkdLambdaDurableReplacementExample"
# Phase 1b's out-of-band name holder (issue #3808). Deterministic so `cleanup`
# can delete it even when the phase never ran.
HOLDER="${STACK}-NameHolder"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # DIRECT sweep in addition to `state destroy`, the same pairing
  # `lambda-config-field-removal` carries: `state destroy` can fail (lock held,
  # throttle, partial destroy) while the state.json delete below runs
  # unconditionally — which would orphan the function with no state record and
  # no tag to find it by. The name is deterministic, so it is known even when
  # `FN` was never resolved (a failure before phase 1's state read).
  aws lambda delete-function --function-name "${STACK}-DurableFn" --region "${REGION}" >/dev/null 2>&1
  aws lambda delete-function --function-name "${FN:-}" --region "${REGION}" >/dev/null 2>&1
  aws lambda delete-function --function-name "${HOLDER}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${HOLDER_DIR:-}" ]; then rm -rf "${HOLDER_DIR}"; fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
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

assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 = $2"
}

# STRICT captures: an AWS failure propagates to `set -e` rather than degrading
# into an empty string an assertion would read as "absent" (issue #1120).
fncfg() { # usage: fncfg <jmespath>
  local out
  out="$(aws lambda get-function-configuration --function-name "${FN}" \
    --region "${REGION}" --query "$1" --output text)" || return 1
  printf '%s' "${out}"
}

# --- Phase 1: baseline deploy ----------------------------------------------
echo "==> Phase 1: baseline deploy (function WITH DurableConfig)"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

FN_ROW="$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value')"
FN="$(echo "${FN_ROW}" | jq -r '.physicalId')"
FN_ROUTE="$(echo "${FN_ROW}" | jq -r '.provisionedBy // "sdk"')"
if [ -z "${FN}" ] || [ "${FN}" = "null" ]; then
  echo "FAIL: no AWS::Lambda::Function row in state" >&2
  exit 1
fi
echo "    Resolved function name: ${FN}"
# The replacement classification only reaches the SDK provider's create/delete
# path when the row is SDK-routed; a cc-api route would exercise something else
# entirely (memory rule: type-keyed behavior needs a routing-matrix audit).
assert_eq "function provisionedBy" "sdk" "${FN_ROUTE}"

assert_eq "baseline DurableConfig.ExecutionTimeout" "3600" \
  "$(fncfg 'DurableConfig.ExecutionTimeout')"
assert_eq "baseline DurableConfig.RetentionPeriodInDays" "14" \
  "$(fncfg 'DurableConfig.RetentionPeriodInDays')"
assert_eq "baseline description" "cdkd-integ durable present" "$(fncfg 'Description')"

# --- Phase 1b: rename onto a name ANOTHER function holds, WITH --replace -----
# Issue #3808. The holder is created with the managed function's own execution
# role (already trusted by Lambda, so no propagation wait) and inline code.
echo "==> Phase 1b: rename onto a name another function holds, WITH --replace (must refuse, delete nothing)"
ROLE_ARN="$(fncfg 'Role')"
# The identity the survival check below compares: a re-created function would
# carry the same template values but a new LastModified. Waited first, since
# cdkd does not wait for Active and a state transition must not read as a
# re-creation.
aws lambda wait function-active-v2 --function-name "${FN}" --region "${REGION}"
aws lambda wait function-updated-v2 --function-name "${FN}" --region "${REGION}"
MODIFIED_BEFORE="$(fncfg 'LastModified')"
HOLDER_DIR="$(mktemp -d)"
python3 - "${HOLDER_DIR}/holder.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('index.js', 'exports.handler = async () => ({});\n')
PY
aws lambda create-function --function-name "${HOLDER}" --runtime nodejs22.x \
  --handler index.handler --role "${ROLE_ARN}" --description "cdkd-integ third-party holder" \
  --zip-file "fileb://${HOLDER_DIR}/holder.zip" --region "${REGION}" >/dev/null
aws lambda wait function-active-v2 --function-name "${HOLDER}" --region "${REGION}"

set +e
HELD_OUT="$(CDKD_TEST_HELD_NAME="${HOLDER}" env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --replace \
  --yes 2>&1)"
HELD_RC=$?
set -e
if [ "${HELD_RC}" -eq 0 ]; then
  echo "FAIL: renaming onto a name another function holds SUCCEEDED" >&2
  printf '%s\n' "${HELD_OUT}" >&2
  exit 1
fi
echo "    OK: deploy refused (rc=${HELD_RC})"
if ! printf '%s' "${HELD_OUT}" | grep -q 'held by ANOTHER existing resource'; then
  echo "FAIL: the refusal does not say the name is held by another resource" >&2
  printf '%s\n' "${HELD_OUT}" >&2
  exit 1
fi
if ! printf '%s' "${HELD_OUT}" | grep -q -- '--replace was NOT applied and nothing was deleted'; then
  echo "FAIL: the refusal does not say --replace was withheld" >&2
  printf '%s\n' "${HELD_OUT}" >&2
  exit 1
fi
echo "    OK: refusal names another holder and withholds --replace"
# The delete-first fallback's own log line; the refusal above is already proven
# present, so an absence here is not a wording drift.
if printf '%s' "${HELD_OUT}" | grep -q 'deleting old'; then
  echo "FAIL: the delete-first fallback ran against the managed function" >&2
  printf '%s\n' "${HELD_OUT}" >&2
  exit 1
fi
# The feared end state: the managed function deleted. The unchanged
# LastModified proves it is the same function, not a re-creation carrying the
# same values.
assert_eq "managed function is the same function (LastModified)" "${MODIFIED_BEFORE}" \
  "$(fncfg 'LastModified')"
assert_eq "managed function survived (DurableConfig)" "3600" \
  "$(fncfg 'DurableConfig.ExecutionTimeout')"
assert_eq "managed function survived (description)" "cdkd-integ durable present" \
  "$(fncfg 'Description')"
HOLDER_DESC="$(aws lambda get-function-configuration --function-name "${HOLDER}" \
  --region "${REGION}" --query 'Description' --output text)"
assert_eq "the holder is untouched" "cdkd-integ third-party holder" "${HOLDER_DESC}"
STATE_AFTER_HELD="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_eq "state still points at the managed function" "${FN}" \
  "$(echo "${STATE_AFTER_HELD}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId')"

aws lambda delete-function --function-name "${HOLDER}" --region "${REGION}"
assert_gone_eventually 60 "the out-of-band holder ${HOLDER} still exists after its delete" \
  aws lambda get-function --function-name "${HOLDER}" --region "${REGION}"
rm -rf "${HOLDER_DIR}"
HOLDER_DIR=""
echo "    OK: holder removed"

# --- Phase 2: drop DurableConfig WITHOUT --replace --------------------------
# The template change is classified as a REPLACEMENT, the create-first attempt
# collides with the live function's name, and cdkd must refuse with its
# actionable error rather than the raw SDK exception. A pre-fix binary fails
# here too — but with `ResourceConflictException` and no mention of --replace,
# which is exactly what the grep below discriminates.
echo "==> Phase 2: drop DurableConfig WITHOUT --replace (must refuse, actionably)"
set +e
DEPLOY_OUT="$(CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)"
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the replacement deploy SUCCEEDED without --replace — cdkd must refuse a" >&2
  echo "      create-first collision rather than silently reusing the old function" >&2
  printf '%s\n' "${DEPLOY_OUT}" >&2
  exit 1
fi
echo "    OK: deploy refused (rc=${DEPLOY_RC})"
# Match the phrase UNIQUE to the create-first collision refusal, not the
# generic 'requires replacement' — the idempotent-create and
# stateful-replace-blocked arms print that too, so a generic grep could not
# tell WHICH refusal fired. (`eventbridge-pipes/verify.sh` uses the same
# collision-unique phrase.)
if ! printf '%s' "${DEPLOY_OUT}" | grep -q 'custom-named resource requires replacing'; then
  echo "FAIL: the refusal is not cdkd's create-first collision error — the collision" >&2
  echo "      signature was not recognized (issue #1625: AWS spells it 'already exist')" >&2
  printf '%s\n' "${DEPLOY_OUT}" >&2
  exit 1
fi
echo "    OK: refusal names the create-first collision"
if ! printf '%s' "${DEPLOY_OUT}" | grep -q -- '--replace'; then
  echo "FAIL: the refusal does not point at the --replace escape hatch" >&2
  printf '%s\n' "${DEPLOY_OUT}" >&2
  exit 1
fi
echo "    OK: refusal points at --replace"

# ...and nothing was destroyed on the way: the live function still carries the
# OLD properties. Without this, a refusal that had already deleted the old
# function would pass every assertion above.
assert_eq "function survived the refused replacement (DurableConfig)" "3600" \
  "$(fncfg 'DurableConfig.ExecutionTimeout')"
assert_eq "function survived the refused replacement (description)" \
  "cdkd-integ durable present" "$(fncfg 'Description')"
# ...and STATE was not touched either: the refusal must leave the recorded
# properties describing the resource AWS still has, or the next deploy would
# diff against a record that never happened.
STATE_AFTER_REFUSAL="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_eq "state still records the DurableConfig after the refusal" "3600" \
  "$(echo "${STATE_AFTER_REFUSAL}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.DurableConfig.ExecutionTimeout')"

# --- Phase 3: same template WITH --replace ----------------------------------
echo "==> Phase 3: re-deploy with --replace (delete-first fallback executes)"
REPLACE_OUT="$(CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --replace \
  --yes 2>&1)"
printf '%s\n' "${REPLACE_OUT}"

# The end-state assertions below cannot tell WHICH path produced them, so pin
# the fallback itself: a future re-route through some other destroy-then-create
# path would still clear the durable config and silently pass otherwise.
if ! printf '%s' "${REPLACE_OUT}" | grep -q 'deleting old'; then
  echo "FAIL: the --replace deploy did not take the delete-first fallback" >&2
  printf '%s\n' "${REPLACE_OUT}" >&2
  exit 1
fi
echo "    OK: delete-first fallback ran"

# The re-created function keeps the deterministic name, so re-read by the SAME
# name — and assert the state row still points at it (a replacement that lost
# the row would leave the next destroy unable to reach the function).
STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
FN_AFTER="$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId')"
assert_eq "state physicalId after the replacement" "${FN}" "${FN_AFTER}"

# The proof the replacement EXECUTED rather than being skipped: the durable
# config is gone (an in-place UpdateFunctionConfiguration cannot express its
# removal — AWS keeps the live block) AND the new description landed.
DURABLE_AFTER="$(aws lambda get-function-configuration --function-name "${FN}" \
  --region "${REGION}" --query 'DurableConfig' --output json | jq -r '. // "NONE"')"
assert_eq "DurableConfig cleared by the replacement" "NONE" "${DURABLE_AFTER}"
assert_eq "replacement applied the new description" "cdkd-integ durable dropped" \
  "$(fncfg 'Description')"

# --- Phase 4: destroy -------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone_eventually 60 "Lambda function ${FN} still exists after destroy" \
  aws lambda get-function --function-name "${FN}" --region "${REGION}"
echo "    OK: Lambda function is gone"

assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

trap - EXIT INT TERM
echo "==> lambda-durable-replacement test passed (#1625 replacement refused without --replace, executed with it, clean destroy; #3808 rename onto a held name refused without deleting)"
