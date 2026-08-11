#!/usr/bin/env bash
# verify.sh — cdkd S3 lifecycle V1/V2 normalization integ.
#
# An S3 bucket whose lifecycle config MIXES a prefix-scoped rule (CFn top-level
# `Prefix`, the deprecated "V1" form) with a rule that has no prefix and no
# filter (an AbortIncompleteMultipartUpload-only rule). S3 rejects a single
# PutBucketLifecycleConfiguration that mixes V1 (top-level Prefix) and V2
# (Filter) rules ("Filter element can only be used in Lifecycle V2"). cdkd must
# normalize every rule to one form. Regression coverage for:
#   - CREATE with a V1 prefix rule + a scope-less rule (would fail pre-fix)
#   - an in-place UPDATE that shortens a transition + adds a Filter-based rule
#
# Phases:
#   1. Deploy; assert all three rules reached AWS, none carries a top-level Prefix
#      (all normalized to V2 Filter form), and the archive rule's expiration=730.
#      Also assert the legacy singular lifecycle keys (issue #1388 / #1424) and
#      the issue #1430 EventBridgeEnabled pair (true -> block present, false ->
#      block absent, matching CloudFormation), then `cdkd drift` clean.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (expiration 730 -> 365, GLACIER
#      transition 90 -> 60, + a new big-objects Filter rule). Assert the new
#      values reached AWS, there are 4 rules, and the bucket was NOT replaced.
#      The two EventBridge booleans SWAP here, so re-asserting the pair with
#      the expectation inverted really exercises the UPDATE path.
#   3. Destroy; assert all three buckets are gone and the state file is removed.
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

# S3 propagates a DeleteBucket to HeadBucket asynchronously: a probe issued
# immediately after a successful delete can still answer 200 for a few seconds
# (observed 2026-08-09 with two buckets deleted in one destroy). Retry the
# gone-probe on a bounded schedule instead of asserting once. This does NOT
# weaken leak detection -- a bucket that never disappears still FAILs, and
# gone_probe still hard-fails on any non-not-found probe error.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws s3api head-bucket ...
  local desc="$1"; shift
  local attempt
  for attempt in $(seq 1 10); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 3
  done
  echo "FAIL: ${desc} (still present after 10 probes over ~30s)" >&2
  exit 1
}

cd "$(dirname "$0")"

STACK="CdkdS3LifecycleExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-lifecycle-test-${ACCOUNT_ID}"
LEGACY_BUCKET="cdkd-lifecycle-legacy-${ACCOUNT_ID}"
# The EventBridgeEnabled: true half of the issue #1430 pair (the `false` half
# rides on LEGACY_BUCKET).
EB_TRUE_BUCKET="cdkd-lifecycle-ebtrue-${ACCOUNT_ID}"

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
  aws s3api delete-bucket --bucket "${LEGACY_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${EB_TRUE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline (prefix rule + abort-only rule) ----------
echo "==> Phase 1: deploy bucket with a V1 prefix rule + a scope-less abort rule"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RULE_COUNT_P1="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(Rules)' --output text)"
if [ "${RULE_COUNT_P1}" != "3" ]; then
  echo "FAIL: expected 3 lifecycle rules after Phase 1, got ${RULE_COUNT_P1}" >&2
  exit 1
fi

# No rule may carry a top-level Prefix — all must be normalized to V2 Filter form
# (mixing V1 Prefix + V2 Filter is exactly what S3 rejects).
TOPLEVEL_PREFIXES="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'Rules[?Prefix!=null] | length(@)' --output text)"
if [ "${TOPLEVEL_PREFIXES}" != "0" ]; then
  echo "FAIL: ${TOPLEVEL_PREFIXES} rule(s) carry a top-level Prefix (V1/V2 mix)" >&2
  exit 1
fi

ARCHIVE_PREFIX_P1="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='archive'].Filter.Prefix | [0]" --output text)"
EXP_P1="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='archive'].Expiration.Days | [0]" --output text)"
if [ "${ARCHIVE_PREFIX_P1}" != "logs/" ] || [ "${EXP_P1}" != "730" ]; then
  echo "FAIL: expected archive Filter.Prefix=logs/ + Expiration.Days=730, got ${ARCHIVE_PREFIX_P1}/${EXP_P1}" >&2
  exit 1
fi
echo "    3 rules applied, all V2 Filter form (no top-level Prefix), archive expiration=730"

# --- the issue #1388 / #1424 rule-level + legacy-key assertions ------------
# Every one of these FAILS against the pre-fix binary, which is the point:
# a green deploy proved nothing here before, because each dropped key made
# cdkd send a DIFFERENT but still-valid lifecycle config.
LC() { # $1 = bucket, $2 = jmespath
  aws s3api get-bucket-lifecycle-configuration --bucket "$1" --region "${REGION}" \
    --query "$2" --output text
}

# #1424, the data-loss one: a tag-scoped rule must carry BOTH tags under
# Filter.And.Tags. Pre-fix it gathered no scope and landed as Filter.Prefix=""
# — an expiration against the WHOLE bucket. Sorted because AWS does not
# preserve list order on readback.
TAGS="$(LC "${BUCKET_NAME}" "join(' ', sort(Rules[?ID=='tag-scoped'].Filter.And.Tags[].join('=', [Key, Value])))")"
if [ "${TAGS}" != "env=prod team=core" ]; then
  echo "FAIL: tag-scoped rule tags = '${TAGS}', expected 'env=prod team=core'" >&2
  exit 1
fi
TAG_PREFIX="$(LC "${BUCKET_NAME}" "Rules[?ID=='tag-scoped'].Filter.Prefix | [0]")"
if [ "${TAG_PREFIX}" != "None" ]; then
  echo "FAIL: tag-scoped rule carries Filter.Prefix='${TAG_PREFIX}' (whole-bucket scope leak)" >&2
  exit 1
fi
echo "    tag-scoped rule: both tags applied via Filter.And.Tags, no whole-bucket fallback"

# CFn TransitionInDays -> SDK NoncurrentDays on the PLURAL form (standard L2).
NVT_DAYS="$(LC "${BUCKET_NAME}" "Rules[?ID=='archive'].NoncurrentVersionTransitions[0].NoncurrentDays | [0]")"
if [ "${NVT_DAYS}" != "15" ]; then
  echo "FAIL: archive NoncurrentVersionTransitions[0].NoncurrentDays = ${NVT_DAYS}, expected 15" >&2
  exit 1
fi
echo "    noncurrent-version transition schedule reached AWS (NoncurrentDays=15)"

# Legacy singular forms on the L1 bucket.
LEG_RULES="$(LC "${LEGACY_BUCKET}" 'length(Rules)')"
LEG_T="$(LC "${LEGACY_BUCKET}" "Rules[?ID=='legacy-singular'].Transitions[0].Days | [0]")"
LEG_NVT="$(LC "${LEGACY_BUCKET}" "Rules[?ID=='legacy-singular'].NoncurrentVersionTransitions[0].NoncurrentDays | [0]")"
LEG_NVE="$(LC "${LEGACY_BUCKET}" "Rules[?ID=='legacy-singular'].NoncurrentVersionExpiration.NoncurrentDays | [0]")"
LEG_MARKER="$(LC "${LEGACY_BUCKET}" "Rules[?ID=='legacy-delete-marker'].Expiration.ExpiredObjectDeleteMarker | [0]")"
if [ "${LEG_RULES}" != "2" ] || [ "${LEG_T}" != "90" ] || [ "${LEG_NVT}" != "30" ] \
   || [ "${LEG_NVE}" != "365" ] || [ "${LEG_MARKER}" != "True" ]; then
  echo "FAIL: legacy bucket rules=${LEG_RULES} transition=${LEG_T} nvt=${LEG_NVT} nve=${LEG_NVE} marker=${LEG_MARKER}" >&2
  echo "      expected 2 / 90 / 30 / 365 / True" >&2
  exit 1
fi
echo "    legacy singular Transition + NoncurrentVersionTransition + NoncurrentVersionExpirationInDays + rule-level ExpiredObjectDeleteMarker all applied"

# --- issue #1430: NotificationConfiguration.EventBridgeConfiguration --------
# Same class as the legacy lifecycle keys above -- a CFn spelling with no SDK
# member behind it. CFn carries a REQUIRED boolean `EventBridgeEnabled`; the
# SDK's block is an EMPTY structure whose PRESENCE enables delivery. cdkd
# emitted the block whenever the CFn block existed, so an explicit `false`
# ENABLED notifications.
#
# Expected values are CloudFormation ground truth, not a guess: a real CFn A/B
# of this exact shape (stack Cdkd1430EbProbe, us-east-1, 2026-08-10) gave an
# EMPTY response for `false` and `{"EventBridgeConfiguration": {}}` for `true`.
#
# Run after BOTH phases: Phase 1 covers create(), Phase 2 covers the
# diffSubConfig -> applyNotificationConfiguration UPDATE path, which is a
# different call site and was previously unexercised against real AWS.
assert_eventbridge_pair() { # $1 = phase label, $2 = expected-true bucket, $3 = expected-false bucket
  local phase="$1" expect_true="$2" expect_false="$3"
  # An unconfigured bucket returns an EMPTY body, not `{}`, so both captures
  # are normalized before jq sees them -- without that the `false` assertion
  # fails on cdkd's CORRECT output. (The first real run of this assertion did
  # exactly that.) Each capture carries `|| return 1` because errexit is
  # CLEARED inside `$( )`, so without it a failed probe would fall through to
  # the normalization and read as "unconfigured" -- the gone-probe failure mode
  # one layer up. Reaching the normalization therefore means a SUCCESSFUL call
  # on a bucket that genuinely has no notification configuration.
  local eb_true_json eb_false_json eb_true_has eb_false_has
  eb_true_json="$(aws s3api get-bucket-notification-configuration \
    --bucket "${expect_true}" --region "${REGION}" --output json)" || return 1
  eb_false_json="$(aws s3api get-bucket-notification-configuration \
    --bucket "${expect_false}" --region "${REGION}" --output json)" || return 1
  [ -n "${eb_true_json//[[:space:]]/}" ] || eb_true_json='{}'
  [ -n "${eb_false_json//[[:space:]]/}" ] || eb_false_json='{}'

  eb_true_has="$(printf '%s' "${eb_true_json}" | jq -r 'has("EventBridgeConfiguration")')" || return 1
  eb_false_has="$(printf '%s' "${eb_false_json}" | jq -r 'has("EventBridgeConfiguration")')" || return 1

  # The `true` side is the vacuity guard: asserting only that the `false`
  # bucket lacks the block would pass just as happily if cdkd stopped applying
  # NotificationConfiguration altogether. Both assertions run unconditionally;
  # it is the PRESENCE of the true-side check that is load-bearing, not the
  # order in which they appear.
  if [ "${eb_true_has}" != "true" ]; then
    echo "FAIL [${phase}]: ${expect_true} (EventBridgeEnabled: true) has NO EventBridgeConfiguration" >&2
    echo "      response: ${eb_true_json}" >&2
    exit 1
  fi
  if [ "${eb_false_has}" != "false" ]; then
    echo "FAIL [${phase}]: ${expect_false} (EventBridgeEnabled: false) HAS an EventBridgeConfiguration" >&2
    echo "      this is the issue #1430 inversion: an explicit false enabled delivery" >&2
    echo "      response: ${eb_false_json}" >&2
    exit 1
  fi
  echo "    [${phase}] EventBridgeEnabled true -> block present, false -> block absent (matches CloudFormation)"
}

# Read side: `readCurrentState` must return the CFn shape
# (`{EventBridgeEnabled: <bool>}`), not the SDK's `{}` -- the state baseline
# holds the CFn spelling, so the SDK shape reported permanent phantom drift on
# every EventBridge-enabled bucket. `cdkd drift` exits 0 only when it finds none.
assert_no_drift() { # $1 = phase label
  local phase="$1"
  if ! node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}"; then
    echo "FAIL [${phase}]: cdkd drift reported drift on an unmodified stack" >&2
    echo "      (pre-#1430 the EventBridge boolean read back as permanently missing)" >&2
    exit 1
  fi
  echo "    [${phase}] no drift on a clean stack (#1430 read side)"
}

assert_eventbridge_pair "phase 1" "${EB_TRUE_BUCKET}" "${LEGACY_BUCKET}"
assert_no_drift "phase 1"

CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
echo "    baseline bucket CreationDate=${CREATION_P1}"

# --- Phase 2: in-place UPDATE (expiration + transition + new Filter rule) ----
echo "==> Phase 2: re-deploy (expiration 730 -> 365, GLACIER 90 -> 60, + big-objects rule)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RULE_COUNT_P2="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(Rules)' --output text)"
EXP_P2="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='archive'].Expiration.Days | [0]" --output text)"
BIG_SIZE_P2="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='big-objects'].Filter.ObjectSizeGreaterThan | [0]" --output text)"
if [ "${RULE_COUNT_P2}" != "4" ] || [ "${EXP_P2}" != "365" ] || [ "${BIG_SIZE_P2}" != "1048576" ]; then
  echo "FAIL: expected 4 rules / archive exp=365 / big-objects size=1048576, got ${RULE_COUNT_P2}/${EXP_P2}/${BIG_SIZE_P2}" >&2
  exit 1
fi
echo "    4 rules, archive expiration=365, big-objects ObjectSizeGreaterThan=1048576"

CREATION_P2="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: bucket was REPLACED (CreationDate ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    bucket identity preserved (CreationDate unchanged) — no replacement"

# Phase 2 SWAPS the expectation: the fixture inverts both booleans under
# CDKD_TEST_UPDATE, so this really drives diffSubConfig ->
# applyNotificationConfiguration, in BOTH directions at once. A same-value
# re-deploy would short-circuit on JSON equality and prove nothing.
assert_eventbridge_pair "phase 2" "${LEGACY_BUCKET}" "${EB_TRUE_BUCKET}"
assert_no_drift "phase 2"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone_eventually "bucket ${BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    bucket deleted"

assert_gone_eventually "legacy bucket ${LEGACY_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${LEGACY_BUCKET}" --region "${REGION}"
assert_gone_eventually "EventBridge bucket ${EB_TRUE_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${EB_TRUE_BUCKET}" --region "${REGION}"
echo "    legacy + EventBridge buckets deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — S3 lifecycle V1/V2 normalization CREATE + in-place UPDATE + destroy, all 3 phases passed"
