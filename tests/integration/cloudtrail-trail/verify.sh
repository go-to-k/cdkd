#!/bin/bash
# cdkd integration test: AWS::CloudTrail::Trail removal semantics (issue #1160
# cloudtrail batch).
#
# Deploys a trail with every optional UpdateTrail field set, then re-deploys
# with CDKD_TEST_REMOVAL=true (all seven dropped from the template) and asserts
# the split a live CFn A/B measured:
#
#   RESET by CloudFormation -> cdkd must send the clear sentinel:
#     S3KeyPrefix -> '', SnsTopicName -> '', IsMultiRegionTrail -> false,
#     EnableLogFileValidation -> false, IncludeGlobalServiceEvents -> false
#   RETAINED by CloudFormation -> cdkd must pass through (parity):
#     CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn
#
# Asserting the retentions is deliberate: a fixture that only checked the
# resets would pass just as happily against an over-eager provider that
# cleared the CloudWatch Logs pair too, which would be a NEW divergence from
# CloudFormation rather than a fix.
#
# Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdCloudTrailTrailExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TRAIL_NAME="cdkd-integ-ct-${ACCOUNT_ID}"
BUCKET_NAME="cdkd-integ-ct-${ACCOUNT_ID}"
TOPIC_NAME="cdkd-integ-ct-${ACCOUNT_ID}"
LOG_GROUP="/aws/cloudtrail/cdkd-integ-${ACCOUNT_ID}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion -- best-effort cleanup
  # should run as much as it can with the env it has.
  set +eu
  state_destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    # `--state-bucket` is REQUIRED here: without it the command resolves
    # cdk.json's placeholder `cdkd-state-test` (the harness exports
    # STATE_BUCKET, not CDKD_STATE_BUCKET), silently targets a nonexistent
    # bucket, and a torn run leaks every resource the raw sweep below does
    # not name.
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    state_destroy_rc=$?
  fi
  # Belt-and-braces for a torn run: each of these is a billing / name-collision
  # hazard the next run would trip over.
  aws cloudtrail delete-trail --name "${TRAIL_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws s3 rm "s3://${BUCKET_NAME}" --recursive >/dev/null 2>&1
  aws s3api delete-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws sns delete-topic --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    # state.json is gated on the destroy SUCCEEDING: it is the only pointer to
    # resources a failed destroy left behind, so removing it on failure turns a
    # recoverable partial teardown into untracked orphans.
    if [ "${state_destroy_rc:-1}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    # lock.json is swept UNCONDITIONALLY. It points at nothing, and a lock
    # stranded by a force-quit makes `state destroy` itself exit non-zero --
    # so gating the lock sweep on that rc would suppress the very cleanup that
    # unsticks the fixture, wedging the next run's deploy until the lock TTL
    # expires.
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} -- run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# `get-trail` ERRORS (TrailNotFoundException) on a missing trail, so an
# unsilenced call outside condition position aborts under `set -e` rather than
# reading as a field value -- the read cannot silently report "absent" for a
# trail that is simply unreachable.
trail_field() { # usage: trail_field <jq-path>
  aws cloudtrail get-trail --name "${TRAIL_NAME}" --region "${REGION}" --output json \
    | jq -r "(.Trail | $1) | tostring"
}

assert_field() { # usage: assert_field <description> <jq-path> <expected>
  local desc="$1" path="$2" want="$3" got
  got="$(trail_field "${path}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${desc}: expected '${want}', got '${got}'" >&2
    exit 1
  fi
  echo "    ok: ${desc} = ${got}"
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 1: assert every optional field landed"
assert_field "S3KeyPrefix"                '.S3KeyPrefix'                'integprefix'
assert_field "SnsTopicName"               '.SnsTopicName'               "${TOPIC_NAME}"
assert_field "IsMultiRegionTrail"         '.IsMultiRegionTrail'         'true'
assert_field "LogFileValidationEnabled"   '.LogFileValidationEnabled'   'true'
assert_field "IncludeGlobalServiceEvents" '.IncludeGlobalServiceEvents' 'true'

# EventSelectors lives behind its own API (issue #1549), so it needs its own
# reader. The baseline assertion is what stops the phase-2 reset check from
# passing vacuously: without it, "the selector is `All` afterwards" is also
# true of a trail that never received the custom `WriteOnly` selector at all.
event_selector_field() { # usage: event_selector_field <jq-path>
  aws cloudtrail get-event-selectors --trail-name "${TRAIL_NAME}" --region "${REGION}" \
    --output json | jq -r "$1 | tostring"
}
assert_event_selector() { # usage: assert_event_selector <description> <jq-path> <expected>
  local desc="$1" path="$2" want="$3" got
  got="$(event_selector_field "${path}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${desc}: expected '${want}', got '${got}'" >&2
    exit 1
  fi
  echo "    ok: ${desc} = ${got}"
}
assert_event_selector "EventSelectors count" '(.EventSelectors | length)' '1'
assert_event_selector "EventSelectors ReadWriteType" '.EventSelectors[0].ReadWriteType' 'WriteOnly'

CW_GROUP_P1="$(trail_field '.CloudWatchLogsLogGroupArn')"
CW_ROLE_P1="$(trail_field '.CloudWatchLogsRoleArn')"
# Reject EMPTY as well as "null": an empty capture would sail through the
# guard and then compare "" == "" in phase 2, making the CFn-parity retention
# pin pass vacuously.
if [ -z "${CW_GROUP_P1}" ] || [ -z "${CW_ROLE_P1}" ] ||
   [ "${CW_GROUP_P1}" = "null" ] || [ "${CW_ROLE_P1}" = "null" ]; then
  echo "FAIL: phase 1 did not configure the CloudWatch Logs pair (group=${CW_GROUP_P1} role=${CW_ROLE_P1})" >&2
  exit 1
fi
echo "    ok: CloudWatch Logs pair configured"

# --- Phase 2: removal redeploy ---------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_REMOVAL=true (drops all seven)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 2: the five fields CFn RESETS must be cleared"
# Pre-fix these were absent -> undefined -> UpdateTrail merge no-op, so the
# live trail silently kept every value while cdkd reported success and the
# next `cdkd diff` said "No changes". Post-fix each carries its measured
# clear sentinel ('' for the two strings, false for the three booleans).
assert_field "S3KeyPrefix reset"                '.S3KeyPrefix'                'null'
assert_field "SnsTopicName reset"               '.SnsTopicName'               'null'
assert_field "IsMultiRegionTrail reset"         '.IsMultiRegionTrail'         'false'
assert_field "LogFileValidationEnabled reset"   '.LogFileValidationEnabled'   'false'
assert_field "IncludeGlobalServiceEvents reset" '.IncludeGlobalServiceEvents' 'false'

echo "==> Phase 2: EventSelectors must be RESET to the AWS default"
# Live CFn A/B (2026-08-11, issue #1549): a real CloudFormation removal of
# EventSelectors leaves `ReadWriteType: All` — the default a selector-less
# trail has — NOT the custom `WriteOnly` from phase 1. Pre-fix the provider
# skipped `PutEventSelectors` entirely on removal, so the live trail kept
# `WriteOnly` and this assertion fails against the pre-fix binary.
assert_event_selector "EventSelectors count after removal" '(.EventSelectors | length)' '1'
assert_event_selector "EventSelectors ReadWriteType reset" '.EventSelectors[0].ReadWriteType' 'All'

echo "==> Phase 2: the CloudWatch Logs pair CFn RETAINS must be unchanged"
# The CFn-parity pin. If a future change "fixes" these into resets, this block
# fails and forces a fresh live CFn A/B rather than a guess.
assert_field "CloudWatchLogsLogGroupArn retained" '.CloudWatchLogsLogGroupArn' "${CW_GROUP_P1}"
assert_field "CloudWatchLogsRoleArn retained"     '.CloudWatchLogsRoleArn'     "${CW_ROLE_P1}"

echo "==> Phase 2: the post-removal state must not report DRIFT"
# The phantom-drift guard the #1549 review asked for -- as a DRIFT check, not a
# diff one. `cdkd diff` compares the synth template against
# `state.resources[].properties`, and the deploy wrote that side FROM the same
# template, so no reset payload appears on either side and the assertion could
# not fail (it passed against the pre-fix binary too -- caught by a review of
# this fixture). `cdkd drift` is the check that actually exercises the class:
# it compares the deploy-time snapshot against what AWS reports NOW, which is
# where a reset that cannot converge shows up. Exit 0 = no drift.
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}"
echo "    ok: post-removal drift is clean"

# --- Phase 2b: a console-side CloudWatch Logs ENABLE must be VISIBLE ---
# Issue #1565. `readCurrentState` used to emit the CloudWatchLogs pair only
# when AWS reported BOTH fields, so on a trail with no CW wiring the keys were
# absent from the captured snapshot -- and the drift comparator's top-level
# walk is baseline-keys-only, which made a console-side enable invisible
# FOREVER. The pair is now always-emitted (`''` when unwired), so the enable
# has something to compare against.
#
# The sequence matters: phase 1 configured the pair and phase 2's removal
# RETAINED it (CFn parity), so the live trail still has it. Clear it
# out-of-band first, re-baseline from AWS, then re-enable out-of-band -- that
# is the only shape where the pre-fix binary records a snapshot WITHOUT the
# keys, which is what makes this assertion fail before the fix.
echo "==> Phase 2b: clearing the CloudWatch Logs pair out-of-band"
aws cloudtrail update-trail --name "${TRAIL_NAME}" --region "${REGION}" \
  --cloud-watch-logs-log-group-arn '' --cloud-watch-logs-role-arn '' >/dev/null
assert_field "CloudWatchLogsLogGroupArn cleared" '.CloudWatchLogsLogGroupArn' 'null'

echo "==> Phase 2b: re-baselining state from AWS (drift --accept)"
# --accept exits 0 whether or not it found something to accept, so it cannot
# stand in for the assertion below; it is only how the baseline is captured
# with the pair UNWIRED.
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --accept --yes

echo "==> Phase 2b: re-enabling the pair out-of-band (the console-side enable)"
aws cloudtrail update-trail --name "${TRAIL_NAME}" --region "${REGION}" \
  --cloud-watch-logs-log-group-arn "${CW_GROUP_P1}" \
  --cloud-watch-logs-role-arn "${CW_ROLE_P1}" >/dev/null
assert_field "CloudWatchLogsLogGroupArn re-enabled" '.CloudWatchLogsLogGroupArn' "${CW_GROUP_P1}"

echo "==> Phase 2b: drift MUST report the enable"
# Exit codes: 0 = no drift, 1 = drift detected, 2 = error. Require exactly 1 --
# a 2 would otherwise read as "detected" and pass this assertion on a broken
# command.
set +e
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: a console-side CloudWatch Logs enable was not reported as drift (cdkd drift rc=${DRIFT_RC}, expected 1)" >&2
  exit 1
fi
echo "    ok: console-side CloudWatch Logs enable reported as drift"

echo "==> Phase 2b: drift --revert MUST actually undo the enable"
# Detection alone is half the feature: the update path used to drop the
# baseline's `''` pair as "absent", so --revert issued an UpdateTrail without
# the fields, AWS's merge semantics kept the console wiring, and cdkd still
# printed the resource as reverted -- a silent no-op with a success message.
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --revert --yes
assert_field "CloudWatchLogsLogGroupArn re-cleared by --revert" '.CloudWatchLogsLogGroupArn' 'null'
assert_field "CloudWatchLogsRoleArn re-cleared by --revert" '.CloudWatchLogsRoleArn' 'null'

echo "==> Phase 2b: drift must be clean after the revert"
# The convergence half: a revert that leaves the same difference behind would
# report drift again forever.
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}"
echo "    ok: drift clean after --revert"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

echo "==> Phase 3: assert every resource is gone"
assert_gone "CloudTrail trail ${TRAIL_NAME} survived destroy" \
  aws cloudtrail get-trail --name "${TRAIL_NAME}" --region "${REGION}"
assert_gone "trail bucket ${BUCKET_NAME} survived destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}"
assert_gone "SNS topic ${TOPIC_NAME} survived destroy" \
  aws sns get-topic-attributes \
  --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}" --region "${REGION}"
LOG_GROUPS_LEFT="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" \
  --region "${REGION}" --query 'length(logGroups)' --output text)"
if [ "${LOG_GROUPS_LEFT}" != "0" ]; then
  echo "FAIL: log group ${LOG_GROUP} survived destroy (count=${LOG_GROUPS_LEFT})" >&2
  exit 1
fi
echo "    ok: log group gone"

echo "==> Phase 3: assert state was removed"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: CloudTrail removal resets + the CFn-retained CloudWatch Logs pair verified end to end"
