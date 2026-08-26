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
#   0b. Run FIRST: plant a PER-RUN UNIQUE name in THIS region (same
#      CDKD_XR_ARM_BUCKET hook as phase 0) and assert cdkd ADOPTS it and
#      completes the deploy. Under the DEFAULT us-east-1 this does not enter the
#      guard at all -- S3 answers a same-region re-create with a legacy 200 OK
#      rather than the 409 -- so it is a regression net for "cdkd deploys
#      cleanly over a pre-existing same-region bucket", and only becomes a true
#      negative control for the guard when AWS_REGION is set elsewhere. The
#      guard's adopt arm is fenced by the unit suite either way. Neither arm may
#      touch a name the fixture itself reuses -- an earlier version planted the
#      stack's own bucket name cross-region and poisoned it for phase 1 too.
#   0. Issue #2227 cross-region adopt refusal: plant a PER-RUN UNIQUE bucket
#      name in another region and add a bucket of that name to the stack (via
#      CDKD_XR_ARM_BUCKET, which the stack reads), then deploy. `CreateBucket`
#      answers `BucketAlreadyOwnedByYou` on account-global OWNERSHIP, so cdkd
#      must read the bucket's real region back (from the 409's own
#      `x-amz-bucket-region` header) and REFUSE rather than adopt and
#      reconfigure a bucket that lives elsewhere. Asserts the refusal text
#      naming both regions, not merely a failed deploy. Phase 1 is NOT its
#      negative control (nothing collides there) -- Phase 0b is. The name is
#      unique per run because a name that has existed in one region cannot be
#      re-created in another for >10 minutes.
#   1. Deploy; assert all three rules reached AWS, none carries a top-level Prefix
#      (all normalized to V2 Filter form), and the archive rule's expiration=730.
#      Also assert the legacy singular lifecycle keys (issue #1388 / #1424) and
#      the issue #1430 EventBridgeEnabled pair (true -> block present, false ->
#      block absent, matching CloudFormation), plus the issue #1759 baseline
#      that a usable `false` leaves the malformed-arm bucket with no block,
#      then `cdkd drift` clean.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (expiration 730 -> 365, GLACIER
#      transition 90 -> 60, + a new big-objects Filter rule). Assert the new
#      values reached AWS, there are 4 rules, and the bucket was NOT replaced.
#      The two EventBridge booleans SWAP here, so re-asserting the pair with
#      the expectation inverted really exercises the UPDATE path. A third
#      bucket's EventBridgeEnabled becomes the MALFORMED string 'yes' here
#      (issue #1759): cdkd must warn and SKIP, leaving delivery OFF, where the
#      pre-fix gate turned it ON.
#   3. Destroy; assert every bucket is gone and the state file is removed.
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
# Plant a bucket, tolerating S3's post-delete namespace window.
#
# Measured 2026-08-26 while building the issue #2227 arms: re-creating a name
# shortly after deleting it answers `OperationAborted` ("A conflicting
# conditional operation is currently in progress against this resource"), NOT
# `BucketAlreadyOwnedByYou`. Same-region reuse clears in seconds; CROSS-region
# reuse did not clear in ten minutes, which is why the cross-region arm now
# plants a per-run unique name instead of reusing one (see Phase 0). The budget
# here is therefore short insurance for the same-region re-plant, not a wait --
# if it ever expires, something is genuinely wedged and failing fast is right.
#
# That error code is also the evidence for what these arms assert: a bucket
# being deleted surfaces as `OperationAborted`, which cdkd already classifies as
# transient, so it never reaches the `BucketAlreadyOwnedByYou` short-circuit at
# all. `--create-bucket-configuration` is omitted for us-east-1, which rejects it.
plant_bucket() { # usage: plant_bucket <bucket> <region>
  local bucket="$1" region="$2" attempt out
  local cbc=""
  [ "${region}" = "us-east-1" ] || cbc="--create-bucket-configuration LocationConstraint=${region}"
  for attempt in 1 2 3 4 5 6; do
    if out="$(aws s3api create-bucket --bucket "${bucket}" --region "${region}" ${cbc} 2>&1)"; then
      return 0
    fi
    if ! printf '%s' "${out}" | grep -qF 'OperationAborted'; then
      echo "FAIL: plant_bucket ${bucket} in ${region}: ${out}" >&2
      return 1
    fi
    echo "    (S3 namespace still settling, attempt ${attempt}/6)"
    sleep 15
  done
  echo "FAIL: plant_bucket ${bucket} in ${region}: still OperationAborted after 6 attempts" >&2
  return 1
}

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
# Issue #1748: the bucket carrying the TOLERATED key spellings (notification
# `TopicArn` + the scalar `Event`, lifecycle `Days` / `NoncurrentDays`).
ALIAS_BUCKET="cdkd-lifecycle-alias-${ACCOUNT_ID}"
# Issue #1759: the bucket whose EventBridgeEnabled becomes MALFORMED in phase 2.
EB_MALFORMED_BUCKET="cdkd-lifecycle-ebmalformed-${ACCOUNT_ID}"
NOTIFY_TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:cdkd-lifecycle-notify-${ACCOUNT_ID}"

# Issue #2227: the region the cross-region adopt arm plants its colliding
# bucket in. It only has to DIFFER from REGION -- S3 bucket names are globally
# unique, so any other region reproduces the collision.
XR_REGION="us-west-2"
if [ "${REGION}" = "${XR_REGION}" ]; then
  XR_REGION="us-east-2"
fi

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
  aws s3api delete-bucket --bucket "${ALIAS_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${EB_MALFORMED_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${NOTIFY_TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  # Issue #2227 arm: the colliding bucket has a per-run unique name and lives in
  # ANOTHER region, so the sweep above (all "${REGION}", fixed names) cannot
  # reach it. Folded into this handler rather than given its own
  # `trap ... EXIT` -- bash does not chain EXIT traps, so a second one would
  # silently disarm every line above. Unset-guarded: this runs pre-run too,
  # before the name is chosen.
  if [ -n "${XR_ARM_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${XR_ARM_BUCKET}" --region "${XR_REGION:-}" >/dev/null 2>&1 || true
  fi
  if [ -n "${SR_ARM_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${SR_ARM_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
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

# --- Phase 0b: the negative control -- a SAME-region owned bucket is adopted --
# Plant a bucket cdkd is about to create, in the region this stack deploys to.
# cdkd must ADOPT it and finish the deploy, so a guard that refuses every
# already-owned bucket fails here while passing Phase 0 -- but see the SCOPE
# note below, which bounds that claim in the default region.
#
# Uses the same per-run unique `CDKD_XR_ARM_BUCKET` hook as Phase 0, and for the
# same measured reason: a name that has existed in one region cannot be
# re-created in ANOTHER for >10 minutes. An earlier version of this arm planted
# the STACK'S OWN bucket name cross-region, which poisoned that name for the
# base fixture's Phase 1 as well -- the arms must never touch a name the fixture
# reuses.
#
# Scope, stated because it is easy to over-read: in `us-east-1` S3 answers a
# re-create of a bucket you already own with a legacy 200 OK rather than
# `BucketAlreadyOwnedByYou` (measured 2026-08-26), so under the default REGION
# this phase does not traverse the guard's adopt arm -- it proves cdkd deploys
# cleanly over a pre-existing same-region bucket, which is the user-visible
# behaviour. The guard's own adopt arm is fenced by the unit suite, and the
# REFUSAL arm below does reach the guard from us-east-1 (a cross-region
# collision returns 409, also measured). Run with AWS_REGION set elsewhere and
# this phase traverses the adopt arm live too.
SR_ARM_BUCKET="cdkd-lifecycle-sr-${ACCOUNT_ID}-$(date -u +%s)"
echo "==> Phase 0b: cdkd must ADOPT ${SR_ARM_BUCKET}, already owned in ${REGION}"
plant_bucket "${SR_ARM_BUCKET}" "${REGION}"

# Prove the PREMISE: it really is in REGION. `get-bucket-location` reports an
# empty constraint for us-east-1 (an S3 quirk), which `--output text` renders
# as `None`.
SR_LOC="$(aws s3api get-bucket-location --bucket "${SR_ARM_BUCKET}" \
  --query 'LocationConstraint' --output text)"
[ "${SR_LOC}" = "None" ] && SR_LOC="us-east-1"
if [ "${SR_LOC}" != "${REGION}" ]; then
  echo "FAIL phase 0b premise: arm bucket should be in ${REGION}, got '${SR_LOC}'" >&2
  exit 1
fi

CDKD_XR_ARM_BUCKET="${SR_ARM_BUCKET}" env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Not just "the deploy exited 0": the adopted bucket must still be there. A
# guard that refused would have failed the deploy above; a cleanup that deleted
# it would fail here.
if ! aws s3api head-bucket --bucket "${SR_ARM_BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL phase 0b: ${SR_ARM_BUCKET} is gone after a deploy that should have ADOPTED it" >&2
  exit 1
fi
echo "    OK: adopted the pre-existing same-region bucket and completed the deploy"

echo "==> Phase 0b teardown"
cleanup
assert_gone_eventually "phase 0b teardown: ${SR_ARM_BUCKET} survived cleanup" \
  aws s3api head-bucket --bucket "${SR_ARM_BUCKET}" --region "${REGION}"

# --- Phase 0: cross-region adopt refusal (issue #2227) ---------------------
# `CreateBucket` answers `BucketAlreadyOwnedByYou` on OWNERSHIP, which is
# account-global, while a bucket is regional -- so it fires for a bucket of
# ours in ANY region. cdkd used to swallow that as an idempotent-create success
# and then apply this stack's whole bucket configuration to the foreign-region
# bucket while reporting success.
#
# The collision is planted on a PER-RUN UNIQUE name carried by an extra bucket
# that only exists while `CDKD_XR_ARM_BUCKET` is set (see the stack). Measured
# 2026-08-26: once a name has existed in one region, re-creating it in ANOTHER
# answers `OperationAborted` for well over ten minutes -- 40 retries across 10
# minutes never cleared it -- while `HeadBucket` already reports 404. Planting
# the collision on a name the fixture REUSES therefore poisons it for the rest
# of the run and for the next one, which is exactly how the first version of
# this arm wedged. A fresh name is only ever created in one region.
#
# Asserts the POSITIVE marker only the fixed path emits (the refusal naming
# both regions), NOT merely "the deploy failed" -- a deploy that died for any
# other reason would satisfy the negative. Phase 0b ABOVE is the negative
# control; Phase 1 is NOT one, because nothing collides there.
XR_ARM_BUCKET="cdkd-lifecycle-xr-${ACCOUNT_ID}-$(date -u +%s)"
echo "==> Phase 0: cdkd must REFUSE to adopt ${XR_ARM_BUCKET}, owned in ${XR_REGION}"
plant_bucket "${XR_ARM_BUCKET}" "${XR_REGION}"

# Prove the PREMISE before asserting anything that depends on it: an arm whose
# collision never landed would "pass" on any unrelated failure.
XR_LOC="$(aws s3api get-bucket-location --bucket "${XR_ARM_BUCKET}" \
  --query 'LocationConstraint' --output text)"
if [ "${XR_LOC}" != "${XR_REGION}" ]; then
  echo "FAIL phase 0 premise: colliding bucket should be in ${XR_REGION}, got '${XR_LOC}'" >&2
  exit 1
fi

set +e
XR_OUT="$(CDKD_XR_ARM_BUCKET="${XR_ARM_BUCKET}" env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
XR_RC=$?
set -e
printf '%s\n' "${XR_OUT}"

if [ "${XR_RC}" -eq 0 ]; then
  echo "FAIL phase 0: deploy SUCCEEDED while ${XR_ARM_BUCKET} lives in ${XR_REGION} -- cdkd adopted a foreign-region bucket" >&2
  exit 1
fi
# Short needles checked separately against a FLATTENED copy, never one long
# phrase against the raw output. grep is line-based, so if the logger wraps the
# refusal, a needle straddling the break scores 0 on a message that is
# perfectly correct -- a false FAIL that reads exactly like a real regression.
# `-F` because these are literals, not patterns (the getatt-fallback-guard
# fixture asserts a refusal the same way).
XR_FLAT="$(printf '%s' "${XR_OUT}" | tr '\n' ' ' | tr -s ' ')"
for needle in 'Refusing to adopt existing S3 bucket' "lives in ${XR_REGION}" "deploys to ${REGION}"; do
  if ! printf '%s' "${XR_FLAT}" | grep -qF -- "${needle}"; then
    echo "FAIL phase 0: refusal output lacks message fragment: ${needle}" >&2
    exit 1
  fi
done
echo "    OK: refused (rc=${XR_RC}), naming ${XR_REGION} vs ${REGION}"

# Reset to a clean slate before the real phases: the refused deploy created the
# stack's other buckets before failing, and left a state record. `cleanup` also
# drops the colliding bucket, since its XR line was folded into that same
# handler.
echo "==> Phase 0 teardown"
cleanup
# Load-bearing: this bucket lives in XR_REGION, outside both the fixture's
# REGION-scoped sweeps and /run-integ's post-run orphan scan, so a failed
# delete would leak SILENTLY while the run still reports 0 orphans.
assert_gone_eventually "phase 0 teardown: ${XR_ARM_BUCKET} survived cleanup in ${XR_REGION}" \
  aws s3api head-bucket --bucket "${XR_ARM_BUCKET}" --region "${XR_REGION}"

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

# --- issue #1759: a MALFORMED EventBridgeEnabled must not ENABLE delivery ---
# `coerceCfnBoolean` answers `undefined` for a value cdkd cannot read, and the
# pre-fix gate's `coerce(...) !== false` made `undefined` take the ENABLE arm --
# the destructive-default class #1595 refuses. The fix REFUSES instead: throw on
# a template-path create, warn-and-SKIP the whole notification configuration on
# the replay-reachable update path (the Put is a full replace, so skipping one
# family would delete every other one).
#
# Phase 1 deploys a usable `false`; phase 2 replaces it with the string 'yes'.
# The block must be absent in BOTH -- pre-fix, phase 2 created one. Phase 1 is
# the vacuity guard: it proves the bucket really is reached and really starts
# without a block, so a phase-2 pass cannot come from cdkd never touching it.
#
# NOTE `jq -r`, never `jq -e`: `-e` exits NON-ZERO on a `false` RESULT, so the
# `|| return 1` below would fire on the CORRECT answer and the read-failure
# fallback would accuse the fix.
assert_eventbridge_absent() { # $1 = phase label
  local phase="$1" body has
  body="$(aws s3api get-bucket-notification-configuration \
    --bucket "${EB_MALFORMED_BUCKET}" --region "${REGION}" --output json)" || return 1
  # An unconfigured bucket answers with an EMPTY body, not `{}`.
  [ -n "${body//[[:space:]]/}" ] || body='{}'
  has="$(printf '%s' "${body}" | jq -r 'has("EventBridgeConfiguration")')" || return 1
  if [ "${has}" != "false" ]; then
    echo "FAIL [${phase}]: ${EB_MALFORMED_BUCKET} HAS an EventBridgeConfiguration" >&2
    echo "      issue #1759: a value cdkd cannot read must never ENABLE delivery" >&2
    echo "      response: ${body}" >&2
    exit 1
  fi
  echo "    [${phase}] a malformed EventBridgeEnabled leaves delivery OFF (#1759)"
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

# --- issue #1748: the never-emitted key spellings ---------------------------
# cdkd accepts more than one spelling on the DESIRED side while
# `readCurrentState` emits only ONE, so a record written in the tolerated
# spelling can never match the readback. Two halves in one bucket:
#   - notification: the applier reads `t['Topic'] ?? t['TopicArn']` and CFn
#     declares the event as the SCALAR `Event` where the SDK member is the LIST
#     `Events`;
#   - lifecycle: `t['TransitionInDays'] ?? t['Days']` and
#     `nvt['TransitionInDays'] ?? nvt['NoncurrentDays']`.
#
# Three sides are asserted, and all three are needed: the WIRE (the tolerance
# must still reach AWS — a fix that stopped accepting the spelling would break
# templates that deploy today), the RECORD (`properties`, which must now hold
# the emitted spelling and must NOT hold the tolerated one), and the READBACK
# (`observedProperties`, which is where the `Events` -> `Event` change lands).
# Asserting only the record would pass just as happily if cdkd had stopped
# applying the configuration altogether.
state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" 2>/dev/null
}
# The alias bucket's state entry, looked up by PHYSICAL id rather than by a
# guessed logical id.
#
# `jq -r`, deliberately NOT `jq -e`: `-e` exits NON-ZERO when the last output is
# `false` or `null`, so every filter that legitimately answers `false` — which is
# half the `has(...)` probes below — would look like a failed read and take the
# caller's fallback. The first run of this assertion did exactly that and
# reported `Events=<missing>` for a correct `false`. Emptiness is the real
# read-failure signal and is checked by the caller.
alias_state() { # $1 = jq filter applied to the resource entry
  state_json | jq -r --arg b "${ALIAS_BUCKET}" \
    '(.resources | to_entries[] | select(.value.physicalId == $b) | .value) | '"$1"
}
assert_alias_spellings() { # $1 = phase label, $2 = expected transition Days
  local phase="$1" expect_days="$2"

  # --- the WIRE: the tolerated spellings still reach AWS unchanged ---
  local wire_days wire_nvt wire_topic wire_events
  wire_days="$(LC "${ALIAS_BUCKET}" "Rules[?ID=='alias-transitions'].Transitions[0].Days | [0]")"
  wire_nvt="$(LC "${ALIAS_BUCKET}" "Rules[?ID=='alias-transitions'].NoncurrentVersionTransitions[0].NoncurrentDays | [0]")"
  if [ "${wire_days}" != "${expect_days}" ] || [ "${wire_nvt}" != "15" ]; then
    echo "FAIL [${phase}]: alias bucket wire Days=${wire_days} (want ${expect_days}) NoncurrentDays=${wire_nvt} (want 15)" >&2
    exit 1
  fi
  # `|| return 1` on every intermediate capture: errexit is CLEARED inside
  # `$( )`, so without it a failed probe (throttle, auth) would fall through to
  # the compare and read as a wrong VALUE rather than a failed read.
  wire_topic="$(aws s3api get-bucket-notification-configuration --bucket "${ALIAS_BUCKET}" --region "${REGION}" \
    --query 'TopicConfigurations[0].TopicArn' --output text)" || return 1
  wire_events="$(aws s3api get-bucket-notification-configuration --bucket "${ALIAS_BUCKET}" --region "${REGION}" \
    --query "join(',', TopicConfigurations[0].Events)" --output text)" || return 1
  if [ "${wire_topic}" != "${NOTIFY_TOPIC_ARN}" ] || [ "${wire_events}" != "s3:ObjectCreated:*" ]; then
    echo "FAIL [${phase}]: alias bucket notification wire topic=${wire_topic} events=${wire_events}" >&2
    exit 1
  fi

  # --- the RECORD: `properties` must hold the EMITTED spelling only ---
  # `has(...)` on purpose, not a value compare: the tolerated key must be
  # REMOVED, and a key left present-but-null still makes the drift walk see two
  # different key sets.
  local rec
  rec="$(alias_state '{
    topic: (.properties.NotificationConfiguration.TopicConfigurations[0] | has("Topic")),
    topicArn: (.properties.NotificationConfiguration.TopicConfigurations[0] | has("TopicArn")),
    event: (.properties.NotificationConfiguration.TopicConfigurations[0] | has("Event")),
    events: (.properties.NotificationConfiguration.TopicConfigurations[0] | has("Events")),
    tid: (.properties.LifecycleConfiguration.Rules[0].Transitions[0] | has("TransitionInDays")),
    days: (.properties.LifecycleConfiguration.Rules[0].Transitions[0] | has("Days")),
    nvtid: (.properties.LifecycleConfiguration.Rules[0].NoncurrentVersionTransitions[0] | has("TransitionInDays")),
    ncd: (.properties.LifecycleConfiguration.Rules[0].NoncurrentVersionTransitions[0] | has("NoncurrentDays")),
    tidValue: .properties.LifecycleConfiguration.Rules[0].Transitions[0].TransitionInDays
  } | tojson')"
  # Emptiness, not the exit code, is the read-failure signal (see `alias_state`).
  [ -n "${rec}" ] || { echo "FAIL [${phase}]: could not read the alias bucket state entry" >&2; exit 1; }
  local want="{\"topic\":true,\"topicArn\":false,\"event\":true,\"events\":false,\"tid\":true,\"days\":false,\"nvtid\":true,\"ncd\":false,\"tidValue\":${expect_days}}"
  if [ "${rec}" != "${want}" ]; then
    echo "FAIL [${phase}]: recorded spellings ${rec}" >&2
    echo "      expected                  ${want}" >&2
    echo "      (issue #1748: the record must carry the spelling readCurrentState emits, with the tolerated key REMOVED)" >&2
    exit 1
  fi

  # --- the READBACK: observedProperties carries the CFn scalar `Event` ---
  # `readNotification` emitted the SDK LIST `Events` for every bucket, which is
  # a spelling no CFn template can declare.
  local obs_event obs_events
  obs_event="$(alias_state '.observedProperties.NotificationConfiguration.TopicConfigurations[0] | has("Event") | tojson')"
  obs_events="$(alias_state '.observedProperties.NotificationConfiguration.TopicConfigurations[0] | has("Events") | tojson')"
  if [ "${obs_event}" != "true" ] || [ "${obs_events}" != "false" ]; then
    echo "FAIL [${phase}]: readback emitted Event=${obs_event} Events=${obs_events}, expected true/false" >&2
    exit 1
  fi
  # --- issue #1751: the CFn STRING boolean `Enabled: 'false'` ---
  # The wire read used to be `(config['Enabled'] as boolean) ?? true`, so it
  # forwarded the STRING and defaulted a declared `null` to `true`. It now runs
  # `coerceCfnBoolean` behind a refusal guard, so `'false'` reaches AWS as the
  # boolean `false` and the record holds the coerced value — a string in state
  # could never match the boolean `inventorySdkToCfn` reads back.
  local wire_enabled rec_enabled
  wire_enabled="$(aws s3api get-bucket-inventory-configuration --bucket "${ALIAS_BUCKET}" \
    --id alias-inventory --region "${REGION}" --query 'InventoryConfiguration.IsEnabled' --output text)" || return 1
  if [ "${wire_enabled}" != "False" ]; then
    echo "FAIL [${phase}]: inventory IsEnabled=${wire_enabled} on the wire, expected False" >&2
    echo "      (issue #1751: a declared 'false' must not be defaulted or forwarded as a string)" >&2
    exit 1
  fi
  rec_enabled="$(alias_state '.properties.InventoryConfigurations[0].Enabled | tojson')"
  [ -n "${rec_enabled}" ] || { echo "FAIL [${phase}]: could not read the recorded inventory Enabled" >&2; exit 1; }
  if [ "${rec_enabled}" != "false" ]; then
    echo "FAIL [${phase}]: recorded inventory Enabled=${rec_enabled}, expected the coerced boolean false" >&2
    exit 1
  fi

  echo "    [${phase}] #1748: tolerated spellings reach the wire, the record + readback carry the emitted ones"
  echo "    [${phase}] #1751: a CFn string 'false' is sent coerced and recorded coerced"
}

assert_eventbridge_pair "phase 1" "${EB_TRUE_BUCKET}" "${LEGACY_BUCKET}"
assert_eventbridge_absent "phase 1"
assert_alias_spellings "phase 1" "90"
assert_no_drift "phase 1"

# --- Phase 1b: the `canonicalizeDesiredProperties` TWIN ---------------------
# The fold alone BREAKS the next deploy: state holds the emitted spelling while
# the template still declares the tolerated one, so an UNCHANGED template reads
# as a change and re-issues the same Put forever (issue #1717 measured exactly
# that on the sibling fold). Re-deploying the IDENTICAL template is the only
# assertion that can see it — a clean `cdkd drift` cannot, because it compares
# state to AWS rather than template to state.
echo "==> Phase 1b: re-deploy the IDENTICAL template — must be a no-op (issue #1748 twin)"
REDEPLOY_OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
# Strip ANSI: `cdkd deploy` colorizes the no-op line, so a plain grep for the
# sentence misses it.
if ! printf '%s' "${REDEPLOY_OUT}" | sed 's/\x1b\[[0-9;]*m//g' | grep -q 'No changes detected'; then
  echo "FAIL: re-deploying the identical template was NOT a no-op" >&2
  printf '%s\n' "${REDEPLOY_OUT}" | tail -30 >&2
  exit 1
fi
echo "    identical re-deploy is a no-op — the fold and its twin agree"

CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
echo "    baseline bucket CreationDate=${CREATION_P1}"

# --- Phase 2: in-place UPDATE (expiration + transition + new Filter rule) ----
echo "==> Phase 2: re-deploy (expiration 730 -> 365, GLACIER 90 -> 60, + big-objects rule)"
# Captured, not streamed, because the issue (#1759) SKIP warning is the only
# proof the malformed-value arm was actually REACHED. `assert_eventbridge_absent
# "phase 2"` below passes just as happily if cdkd never issued the notification
# update at all -- which is exactly what a regression that starts FOLDING the
# refused value would produce (both diff sides equal -> NO_CHANGE -> the applier
# is never called). Phase 1 proves the bucket exists and starts without a block;
# this grep is what proves the phase-2 attempt happened. Echoed back so a
# failure anywhere below is still diagnosable from the log.
PHASE2_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
printf '%s\n' "${PHASE2_OUT}"
# Strip ANSI first: cdkd colorizes warnings, so a plain grep can miss them.
if ! printf '%s' "${PHASE2_OUT}" | sed 's/\x1b\[[0-9;]*m//g' \
     | grep -q 'EventBridgeEnabled must be a boolean'; then
  echo "FAIL [phase 2]: the malformed EventBridgeEnabled did not produce a SKIP warning" >&2
  echo "      issue (#1759): the applier was never reached, so the absence assertion below" >&2
  echo "      would pass vacuously" >&2
  exit 1
fi
echo "    [phase 2] the malformed EventBridgeEnabled was REFUSED with a skip warning (#1759)"

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
# The row this fixture arm exists for: the same bucket's EventBridgeEnabled is
# now the string 'yes'. cdkd must WARN and skip rather than enable.
assert_eventbridge_absent "phase 2"
# The alias transition day count CHANGES in UPDATE mode (90 -> 60), so this
# really drives the update-path fold rather than re-reading the phase-1 record.
assert_alias_spellings "phase 2" "60"
assert_no_drift "phase 2"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone_eventually "bucket ${BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    bucket deleted"

assert_gone_eventually "legacy bucket ${LEGACY_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${LEGACY_BUCKET}" --region "${REGION}"
assert_gone_eventually "EventBridge bucket ${EB_TRUE_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${EB_TRUE_BUCKET}" --region "${REGION}"
assert_gone_eventually "alias-spelling bucket ${ALIAS_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${ALIAS_BUCKET}" --region "${REGION}"
assert_gone_eventually "malformed-EventBridge bucket ${EB_MALFORMED_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${EB_MALFORMED_BUCKET}" --region "${REGION}"
assert_gone "notification topic ${NOTIFY_TOPIC_ARN} still exists after destroy" aws sns get-topic-attributes --topic-arn "${NOTIFY_TOPIC_ARN}" --region "${REGION}"
echo "    legacy + EventBridge + alias buckets and the notification topic deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — S3 lifecycle V1/V2 normalization CREATE + in-place UPDATE + destroy, all 3 phases passed"
