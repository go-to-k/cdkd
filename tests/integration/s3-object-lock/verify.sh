#!/usr/bin/env bash
# verify.sh — cdkd S3 Object Lock default-retention integ.
#
# An S3 bucket with Object Lock enabled and a default GOVERNANCE retention rule.
# cdkd's S3 provider applies it via PutObjectLockConfiguration and reads it back
# via GetObjectLockConfiguration. Regression coverage for:
#   - CREATE with ObjectLockEnabled + default retention (GOVERNANCE, 1 day)
#   - an in-place retention UPDATE (Days 1 -> 5) that must NOT replace the bucket
#   - DefaultRetention.DefaultEventHold reaching AWS on both (PR #3002)
#   - go-to-k/cdkd#5395: the top-level ObjectLockEnabled turned on for an
#     existing bucket (LateFlagBucket) is not applied, as in CloudFormation,
#     and the deploy warns about it
#
# Phases:
#   1. Deploy; assert ObjectLockEnabled + GOVERNANCE retention Days=1 and
#      DefaultEventHold.Days=1.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (Days 1 -> 5, hold 1 -> 3). Assert
#      both new values reached AWS and the bucket was not replaced (same
#      CreationDate). LateFlagBucket gains the top-level ObjectLockEnabled:
#      the deploy must warn, and the bucket must keep its CreationDate and
#      still have no Object Lock configuration.
#   2b. Re-deploy with CDKD_TEST_SUSPEND=true as well: LateFlagBucket's
#      versioning goes Suspended while the never-applied flag stays declared.
#      The bucket has no Object Lock, so the suspend must reach S3 (#5395).
#   3. Destroy; assert the bucket is gone and the state file is removed.
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

REPO_ROOT="${PWD}/../../.."

# `DefaultRetention.DefaultEventHold` (PR #3002) is not in aws-cli 2.35.13's S3
# model, so `aws s3api get-object-lock-configuration --query ...DefaultEventHold`
# reports None for a member AWS really holds -- a vacuous pass. Read it through
# the SDK instead (.claude/rules/testing.md, "call the SDK directly"); the repo
# root depends on `@aws-sdk/client-s3` >= 3.1129.0, which does model it.
# `|| return 1` is the canonical value-wrapper shape from
# .claude/rules/testing.md, kept for uniformity; here it is belt-and-braces,
# since the subshell is the body's LAST command so its status is already the
# function's. An empty result is not a silent pass either -- it falls into the
# `!= "1"` branch and FAILS the phase.
event_hold_days() { # $1 = bucket -> the DefaultEventHold.Days AWS holds, or empty
  ( cd "${REPO_ROOT}" && REGION="${REGION}" node --input-type=module -e "
import { S3Client, GetObjectLockConfigurationCommand } from '@aws-sdk/client-s3';
const client = new S3Client({ region: process.env.REGION });
const res = await client.send(new GetObjectLockConfigurationCommand({ Bucket: process.argv[1] }));
const hold = res.ObjectLockConfiguration?.Rule?.DefaultRetention?.DefaultEventHold;
process.stdout.write(String(hold?.Days ?? ''));
" "$1" ) || return 1
}

STACK="CdkdS3ObjectLockExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-objectlock-test-${ACCOUNT_ID}"
LATE_BUCKET_NAME="cdkd-objectlock-late-${ACCOUNT_ID}"
PHASE2_LOG="$(mktemp -t cdkd-s3-object-lock-p2.XXXXXX)"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws s3api delete-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${LATE_BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  rm -f "${PHASE2_LOG}"
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

# --- Phase 1: deploy baseline (GOVERNANCE, 1 day) ---------------------
echo "==> Phase 1: deploy bucket with Object Lock + default retention 1 day"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P1="$(aws s3api get-object-lock-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text)"
DAYS_P1="$(aws s3api get-object-lock-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text)"
if [ "${MODE_P1}" != "GOVERNANCE" ] || [ "${DAYS_P1}" != "1" ]; then
  echo "FAIL: expected GOVERNANCE/1 after Phase 1, got ${MODE_P1}/${DAYS_P1}" >&2
  exit 1
fi
echo "    Object Lock active: GOVERNANCE, ${DAYS_P1} day"

HOLD_P1="$(event_hold_days "${BUCKET_NAME}")"
if [ "${HOLD_P1}" != "1" ]; then
  echo "FAIL: expected DefaultEventHold.Days=1 after Phase 1, got '${HOLD_P1}' — the template's" >&2
  echo "      DefaultEventHold never reached AWS (PR #3002 silent-drop regression)" >&2
  exit 1
fi
echo "    DefaultEventHold reached AWS: ${HOLD_P1} days"

CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
echo "    baseline bucket CreationDate=${CREATION_P1}"

LATE_CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${LATE_BUCKET_NAME}'].CreationDate | [0]" --output text)"
if [ -z "${LATE_CREATION_P1}" ] || [ "${LATE_CREATION_P1}" = "None" ]; then
  echo "FAIL: ${LATE_BUCKET_NAME} was not created in Phase 1" >&2
  exit 1
fi
if ! gone_probe aws s3api get-object-lock-configuration --bucket "${LATE_BUCKET_NAME}" --region "${REGION}"; then
  echo "FAIL: ${LATE_BUCKET_NAME} has Object Lock after Phase 1; the #5395 arm needs a bucket without it" >&2
  exit 1
fi
echo "    ${LATE_BUCKET_NAME}: no Object Lock (CreationDate=${LATE_CREATION_P1})"

# --- Phase 2: raise retention 1 -> 5 days (in-place) ------------------
echo "==> Phase 2: re-deploy raising default retention 1 -> 5 days"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2_LOG}"

DAYS_P2="$(aws s3api get-object-lock-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text)"
if [ "${DAYS_P2}" != "5" ]; then
  echo "FAIL: expected retention Days=5 after Phase 2, got ${DAYS_P2}" >&2
  exit 1
fi
echo "    retention raised to ${DAYS_P2} days"

HOLD_P2="$(event_hold_days "${BUCKET_NAME}")"
if [ "${HOLD_P2}" != "3" ]; then
  echo "FAIL: expected DefaultEventHold.Days=3 after Phase 2, got '${HOLD_P2}'" >&2
  exit 1
fi
echo "    DefaultEventHold raised in place to ${HOLD_P2} days"

# The bucket must be the SAME bucket (no replacement): CreationDate unchanged.
CREATION_P2="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: bucket was REPLACED (CreationDate ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    bucket identity preserved (CreationDate unchanged) — no replacement"

# go-to-k/cdkd#5395: the top-level flag on an existing bucket is not applied
# (CloudFormation does not apply it either), and the deploy says so.
if ! sed $'s/\x1b\\[[0-9;]*m//g' "${PHASE2_LOG}" | grep -qF "Object Lock was NOT enabled on the existing bucket ${LATE_BUCKET_NAME}"; then
  echo "FAIL: Phase 2 did not warn that the top-level ObjectLockEnabled was not applied to ${LATE_BUCKET_NAME} (#5395)" >&2
  exit 1
fi
echo "    Phase 2 warned that ObjectLockEnabled was not applied to ${LATE_BUCKET_NAME}"
LATE_CREATION_P2="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${LATE_BUCKET_NAME}'].CreationDate | [0]" --output text)"
if [ "${LATE_CREATION_P1}" != "${LATE_CREATION_P2}" ]; then
  echo "FAIL: ${LATE_BUCKET_NAME} was REPLACED (CreationDate ${LATE_CREATION_P1} -> ${LATE_CREATION_P2})" >&2
  exit 1
fi
if ! gone_probe aws s3api get-object-lock-configuration --bucket "${LATE_BUCKET_NAME}" --region "${REGION}"; then
  echo "FAIL: ${LATE_BUCKET_NAME} gained Object Lock in Phase 2; CloudFormation leaves it off (#5395)" >&2
  exit 1
fi
echo "    ${LATE_BUCKET_NAME}: same bucket, still no Object Lock"

# --- Phase 2b: suspend versioning beside the never-applied flag ---------
echo "==> Phase 2b: suspend ${LATE_BUCKET_NAME} versioning with ObjectLockEnabled still declared"
CDKD_TEST_UPDATE=true CDKD_TEST_SUSPEND=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LATE_VERSIONING="$(aws s3api get-bucket-versioning --bucket "${LATE_BUCKET_NAME}" --region "${REGION}" \
  --query 'Status' --output text)"
if [ "${LATE_VERSIONING}" != "Suspended" ]; then
  echo "FAIL: ${LATE_BUCKET_NAME} versioning is '${LATE_VERSIONING}', expected Suspended: the top-level" >&2
  echo "      ObjectLockEnabled was never applied, so it must not block the suspend (#5395)" >&2
  exit 1
fi
echo "    ${LATE_BUCKET_NAME}: versioning Suspended (no Object Lock blocked it)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "bucket ${BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    bucket deleted"
assert_gone "bucket ${LATE_BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${LATE_BUCKET_NAME}" --region "${REGION}"
echo "    ${LATE_BUCKET_NAME} deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — S3 Object Lock CREATE + in-place retention UPDATE + destroy, all 3 phases passed"
