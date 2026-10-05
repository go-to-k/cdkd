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
#   0b. Run FIRST: plant a PER-RUN UNIQUE bucket name in THIS region (same
#      CDKD_XR_ARM_BUCKET hook as phase 0) and deploy a stack declaring a bucket
#      of that name. go-to-k/cdkd#4344's pre-create name lookup must REFUSE
#      (`NAMED_CREATE_COLLISION`, "already holds that name", nothing created),
#      leave the planted bucket untouched, and leave no state record holding
#      it, nor a rollback-journal failed op for it (go-to-k/cdkd#4356). Neither arm may touch a name the fixture itself reuses -- an earlier
#      version planted the stack's own bucket name cross-region and poisoned it
#      for phase 1 too.
#   0. The same lookup against a PER-RUN UNIQUE bucket this account owns in
#      ANOTHER region: `HeadBucket` answers 301 and cdkd must refuse with that
#      cause before `CreateBucket` runs. Asserts that arm's text, not merely a
#      failed deploy, and that the issue #2227 `CreateBucket`-side guard
#      ("Refusing to adopt existing S3 bucket") did NOT fire -- on a plain
#      create it is now reached only when the name is taken between the lookup
#      and `CreateBucket`, which this fixture cannot stage; the unit suite
#      covers it. Phase 0b is its control (same lookup, other arm). The name is
#      unique per run because a name that has existed in one region cannot be
#      re-created in another for >10 minutes.
#   0c. Issue #2283 Cloud-Control-routed delete identity: plant TWO hand-written
#      single-resource state records whose one resource is an
#      `AWS::S3::Bucket` marked `provisionedBy: cc-api` -- the routing that
#      sends a delete to `CloudControlProvider` instead of `S3BucketProvider`,
#      so none of the phase-0 guards apply. Arm OK names a bucket really in
#      THIS region and must still delete (the negative control, and the proof
#      the hand-written state shape routes and works at all); arm XR names a
#      per-run unique bucket in ANOTHER region and must be REFUSED, with the
#      bucket still standing afterwards. Both arms are state-only: the CDK app
#      is untouched, so every other phase synthesizes exactly what it always
#      did.
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
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-lifecycle-test-${ACCOUNT_ID}"
LEGACY_BUCKET="cdkd-lifecycle-legacy-${ACCOUNT_ID}"
# The EventBridgeEnabled: true half of the issue #1430 pair (the `false` half
# rides on LEGACY_BUCKET).
EB_TRUE_BUCKET="cdkd-lifecycle-ebtrue-${ACCOUNT_ID}"
# Issue #1748: the bucket carrying the TOLERATED key spellings (the notification
# scalar `Event`, lifecycle `Days`).
ALIAS_BUCKET="cdkd-lifecycle-alias-${ACCOUNT_ID}"
# Issue #1759: the bucket whose EventBridgeEnabled becomes MALFORMED in phase 2.
EB_MALFORMED_BUCKET="cdkd-lifecycle-ebmalformed-${ACCOUNT_ID}"
NOTIFY_TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:cdkd-lifecycle-notify-${ACCOUNT_ID}"

# The region phase 0's cross-region arm plants its colliding
# bucket in. It only has to DIFFER from REGION -- S3 bucket names are globally
# unique, so any other region reproduces the collision.
XR_REGION="us-west-2"
if [ "${REGION}" = "${XR_REGION}" ]; then
  XR_REGION="us-east-2"
fi

# Issue #2283: the two synthetic single-resource stacks the phase-0c arms plant
# directly into the state bucket. Fixed names (unlike the BUCKETS those records
# point at, which must be per-run unique) because a state KEY carries no S3
# namespace cooldown -- overwriting one is free, and a fixed name is what lets
# `cleanup` sweep a record an interrupted run left behind.
CC_ARM_STACK_XR="CdkdS3LifecycleCcArmXr"
CC_ARM_STACK_OK="CdkdS3LifecycleCcArmOk"
# Issue #2301 item 3: the arm that SUPPRESSES the identity guard rather than
# satisfying or tripping it. Its own stack, because it is the only phase-0c arm
# driven by `cdkd destroy` (not `cdkd state destroy`), so the top-level verb's
# deployment events are pinned live here and the state verb's in phase 0c-OK.
CC_ARM_STACK_ID="CdkdS3LifecycleCcArmId"

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
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1 || true
  fi
  # Phase 0 arm: the colliding bucket has a per-run unique name and lives in
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
  # Issue #2283 arms. Same reasoning as the two lines above: per-run unique
  # names, one of them in ANOTHER region, so the fixed-name "${REGION}" sweep
  # cannot reach either. Folded into THIS handler rather than given their own
  # `trap ... EXIT`, which would silently replace every line above.
  if [ -n "${CC_ARM_XR_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${CC_ARM_XR_BUCKET}" --region "${XR_REGION:-}" >/dev/null 2>&1 || true
  fi
  if [ -n "${CC_ARM_OK_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${CC_ARM_OK_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # Issue #2301: the indeterminate arm's bucket carries a policy DENYING
  # `s3:GetBucketLocation`. `DeleteBucketPolicy` is not denied by it, but the
  # delete does not need the policy gone either -- an explicit Deny scoped to
  # one read action never blocks `DeleteBucket`. Dropped first anyway so a
  # leftover bucket from an interrupted run is never left holding a policy that
  # confuses the next reader.
  if [ -n "${CC_ARM_ID_BUCKET:-}" ]; then
    aws s3api delete-bucket-policy --bucket "${CC_ARM_ID_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "${CC_ARM_ID_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${CC_ARM_ID_CLEAN_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${CC_ARM_ID_CLEAN_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # Assigned INSIDE the arm, never at load time: `cleanup` also runs pre-run,
  # and a scratch dir created at variable-definition time would be removed
  # before its first write.
  if [ -n "${CC_ARM_ID_WORKDIR:-}" ]; then
    rm -rf "${CC_ARM_ID_WORKDIR}" >/dev/null 2>&1 || true
  fi
  # Issue #2422: phase 1c's four per-run buckets and phase 2c's one, three
  # with a deny policy (dropped first, as for phase 0c-ID). The `state destroy` above also reaches
  # them while their records are still planted in this stack's state.
  if [ -n "${DEP_ARM_ID_BUCKET:-}" ]; then
    aws s3api delete-bucket-policy --bucket "${DEP_ARM_ID_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "${DEP_ARM_ID_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DEP_ARM_ID_CLEAN_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${DEP_ARM_ID_CLEAN_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DEP_ARM_OLD_BUCKET:-}" ]; then
    aws s3api delete-bucket-policy --bucket "${DEP_ARM_OLD_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "${DEP_ARM_OLD_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DEP_ARM_NEW_BUCKET:-}" ]; then
    aws s3api delete-bucket --bucket "${DEP_ARM_NEW_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DEP_ARM_RB_BUCKET:-}" ]; then
    aws s3api delete-bucket-policy --bucket "${DEP_ARM_RB_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "${DEP_ARM_RB_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DEP_ARM_ID_WORKDIR:-}" ]; then
    rm -rf "${DEP_ARM_ID_WORKDIR}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # Issue #2283: the two hand-written state records the phase-0c arms plant.
    # Unconditional (not gated on a run-scoped variable) so a record left by an
    # INTERRUPTED earlier run is also swept -- the pre-run `cleanup` call is the
    # only chance to clear one, and by then no phase-0c variable is set yet.
    for cc_arm_stack in "${CC_ARM_STACK_XR}" "${CC_ARM_STACK_OK}" "${CC_ARM_STACK_ID}"; do
      # Recursive over the whole per-stack prefix, not the two known keys: a
      # `state destroy` also writes `deployments/` event objects there, and
      # /run-integ's orphan scan reads `s3://<state bucket>/cdkd/` as a whole,
      # so a stray event object reports as a leak. The prefix is unique to
      # these arms, so the recursion cannot reach anything else.
      aws s3 rm --recursive "s3://${STATE_BUCKET}/cdkd/${cc_arm_stack}/" >/dev/null 2>&1 || true
    done
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

# --- Phase 0b: a SAME-region bucket already holding the name is refused -----
# go-to-k/cdkd#4344 (issue #4180): before a plain CREATE of an explicitly named
# `AWS::S3::Bucket`, cdkd asks `S3BucketProvider.import()` (a `HeadBucket` in
# this stack's region) whether a bucket already holds the name, and refuses
# with a non-retryable `NAMED_CREATE_COLLISION` -- nothing created -- when one
# does. That includes a bucket this account owns, on purpose: nothing in AWS
# tells cdkd's own leftover from a stranger's, and CloudFormation answers
# "already exists" here too. Without the lookup, `CreateBucket` would hand the
# existing bucket back (a legacy 200 OK in us-east-1, `BucketAlreadyOwnedByYou`
# elsewhere) and cdkd would record it as this stack's for a later destroy.
#
# Asserts the refusal's own text (the "an existing resource (...) already holds
# that name" arm, NOT the 301 arm phase 0 asserts), the planted bucket still
# there with the marker tag planted on it before the deploy, and no state
# record holding `XrArmBucket`.
#
# The name is per-run unique and carried by the stack's extra bucket that only
# exists while `CDKD_XR_ARM_BUCKET` is set, for the reason phase 0 records:
# a name that has existed in one region cannot be re-created in ANOTHER for
# >10 minutes, so the arms must never touch a name the fixture reuses.
SR_ARM_BUCKET="cdkd-lifecycle-sr-${ACCOUNT_ID}-$(date -u +%s)"
echo "==> Phase 0b: cdkd must REFUSE to create over ${SR_ARM_BUCKET}, already owned in ${REGION}"
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
# A marker only this run wrote, so "untouched" is checked against something the
# deploy would have had to remove or overwrite, not just against existence.
SR_MARKER="phase0b-$(date -u +%s)"
aws s3api put-bucket-tagging --bucket "${SR_ARM_BUCKET}" --region "${REGION}" \
  --tagging "TagSet=[{Key=cdkd-integ-marker,Value=${SR_MARKER}}]" || {
  echo "FAIL phase 0b premise: could not tag ${SR_ARM_BUCKET}" >&2
  exit 1
}

set +e
SR_OUT="$(CDKD_XR_ARM_BUCKET="${SR_ARM_BUCKET}" env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
SR_RC=$?
set -e
printf '%s\n' "${SR_OUT}"

if [ "${SR_RC}" -eq 0 ]; then
  echo "FAIL phase 0b: deploy SUCCEEDED over ${SR_ARM_BUCKET}, which already held the name -- cdkd took an existing bucket over" >&2
  exit 1
fi
# Short `-F` needles against a FLATTENED copy, never one long phrase against the
# raw output: grep is line-based, so a needle straddling a logger wrap scores 0
# on a correct message. Each is a literal of the refusal in
# src/deployment/deploy-engine/create.ts (`refuseTakenCreateName`).
SR_FLAT="$(printf '%s' "${SR_OUT}" | tr '\n' ' ' | tr -s ' ')"
for needle in 'XrArmBucket (AWS::S3::Bucket) is created with BucketName' \
  "(${SR_ARM_BUCKET}) already holds that name" \
  'Nothing was created.' 'Choose a name no other resource holds'; do
  if ! printf '%s' "${SR_FLAT}" | grep -qF -- "${needle}"; then
    echo "FAIL phase 0b: refusal output lacks message fragment: ${needle}" >&2
    exit 1
  fi
done
# The other arms of the same refusal must not be what fired: a 301 or 403 here
# would mean the lookup did not see the same-region bucket at all.
for needle in 'S3 answered 301' 'S3 answered 403'; do
  if printf '%s' "${SR_FLAT}" | grep -qF -- "${needle}"; then
    echo "FAIL phase 0b: the refusal took the '${needle}' arm for a bucket in this region" >&2
    exit 1
  fi
done

# Untouched: still there, still carrying the marker.
SR_TAG="$(aws s3api get-bucket-tagging --bucket "${SR_ARM_BUCKET}" --region "${REGION}" \
  --query "TagSet[?Key=='cdkd-integ-marker'].Value | [0]" --output text 2>&1)" || SR_TAG="<get-bucket-tagging failed: ${SR_TAG}>"
if [ "${SR_TAG}" != "${SR_MARKER}" ]; then
  echo "FAIL phase 0b: ${SR_ARM_BUCKET} was not left untouched by the refused deploy (marker tag '${SR_TAG}', expected '${SR_MARKER}')" >&2
  exit 1
fi

# No state record may hold XrArmBucket. The failed deploy rolls back what it
# created, and whether a state.json survives that depends on what else the run
# recorded, so only its CONTENT is asserted: absent is fine, present must not
# name the arm.
# stdout only into the JSON; stderr to its own file, read only on a failure.
SR_STATE_ERR="$(mktemp)"
set +e
SR_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>"${SR_STATE_ERR}")"
SR_STATE_RC=$?
set -e
SR_STATE_STDERR="$(cat "${SR_STATE_ERR}")"
rm -f "${SR_STATE_ERR}"
if [ "${SR_STATE_RC}" -eq 0 ]; then
  SR_STATE_ARM="$(printf '%s' "${SR_STATE}" | jq -r '(.resources // {}) | has("XrArmBucket")')" || {
    echo "FAIL phase 0b: could not parse s3://${STATE_BUCKET}/${STATE_KEY} as JSON" >&2
    exit 1
  }
  if [ "${SR_STATE_ARM}" != "false" ]; then
    echo "FAIL phase 0b: the state record holds XrArmBucket after a refused create (has=${SR_STATE_ARM})" >&2
    exit 1
  fi
# `aws s3 cp` on a missing key fails its HeadObject with exactly `(404)`;
# matched as that literal so a stray `404` in a request id cannot pass.
elif ! grep -qF '(404)' <<<"${SR_STATE_STDERR}" && ! grep -qF 'NoSuchKey' <<<"${SR_STATE_STDERR}"; then
  echo "FAIL phase 0b: could not read s3://${STATE_BUCKET}/${STATE_KEY} to check it: ${SR_STATE_STDERR}" >&2
  exit 1
fi

# go-to-k/cdkd#4356: the refused create is NOT journaled as a failed op. It was
# refused before anything was applied, so its only effect on the journal was
# `cdkd rollback --revert-failed` advising to delete "it" by hand -- i.e. the
# bucket that refused it, someone else's -- and the clean automatic rollback
# keeping a failed-only segment for it with a "may be partially applied" note.
# Absent journal is fine; a present one must not name the arm.
SR_JOURNAL_ERR="$(mktemp)"
set +e
SR_JOURNAL="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - 2>"${SR_JOURNAL_ERR}")"
SR_JOURNAL_RC=$?
set -e
SR_JOURNAL_STDERR="$(cat "${SR_JOURNAL_ERR}")"
rm -f "${SR_JOURNAL_ERR}"
if [ "${SR_JOURNAL_RC}" -eq 0 ]; then
  SR_JOURNAL_ARM="$(printf '%s' "${SR_JOURNAL}" | jq -r '[.segments[]? | (.failedOperations // [])[] | select(.logicalId == "XrArmBucket")] | length')" || {
    echo "FAIL phase 0b: could not parse s3://${STATE_BUCKET}/${JOURNAL_KEY} as JSON" >&2
    exit 1
  }
  if [ "${SR_JOURNAL_ARM}" != "0" ]; then
    echo "FAIL phase 0b: the rollback journal records the refused XrArmBucket create as a failed op (${SR_JOURNAL_ARM}x)" >&2
    exit 1
  fi
elif ! grep -qF '(404)' <<<"${SR_JOURNAL_STDERR}" && ! grep -qF 'NoSuchKey' <<<"${SR_JOURNAL_STDERR}"; then
  echo "FAIL phase 0b: could not read s3://${STATE_BUCKET}/${JOURNAL_KEY} to check it: ${SR_JOURNAL_STDERR}" >&2
  exit 1
fi
echo "    OK: refused (rc=${SR_RC}), ${SR_ARM_BUCKET} untouched, no state record holds XrArmBucket, no journal record of it"

echo "==> Phase 0b teardown"
cleanup
assert_gone_eventually "phase 0b teardown: ${SR_ARM_BUCKET} survived cleanup" \
  aws s3api head-bucket --bucket "${SR_ARM_BUCKET}" --region "${REGION}"

# --- Phase 0: a bucket of that name in ANOTHER region is refused ------------
# The same pre-create lookup as phase 0b, against a bucket this account owns in
# XR_REGION. The `HeadBucket` in REGION answers 301, which
# `refuseTakenCreateName` reads as "a bucket of that name already exists in
# another region" and refuses on, nothing created. That message names the
# bucket, not the two regions: S3's 301 to a `HeadBucket` reaches cdkd without
# a region it can name (SDK v3 surfaces it as a synthetic `Unknown` error,
# `src/utils/aws-region-resolver.ts`), so the regions are no longer asserted.
#
# The issue #2227 guard in `S3BucketProvider.create()` ("Refusing to adopt
# existing S3 bucket ... lives in <region>") reads the region back from
# `CreateBucket`'s `BucketAlreadyOwnedByYou`, so it now runs only when the
# lookup found the name FREE and a bucket took it before `CreateBucket` -- not
# reachable from this fixture. Its unit coverage is
# tests/unit/provisioning/s3-bucket-provider-already-owned-region.test.ts and
# s3-bucket-provider-us-east-1-preflight.test.ts. Asserting its text is ABSENT
# here pins which guard fired.
#
# The collision is planted on a PER-RUN UNIQUE name. Measured 2026-08-26: once
# a name has existed in one region, re-creating it in ANOTHER answers
# `OperationAborted` for well over ten minutes, while `HeadBucket` already
# reports 404 -- planting it on a name the fixture REUSES poisons that name for
# the rest of the run and the next one.
#
# Asserts the POSITIVE marker of this arm, NOT merely "the deploy failed" -- a
# deploy that died for any other reason would satisfy the negative. Phase 0b is
# the control: the same lookup, a same-region holder, a different arm.
XR_ARM_BUCKET="cdkd-lifecycle-xr-${ACCOUNT_ID}-$(date -u +%s)"
echo "==> Phase 0: cdkd must REFUSE to create ${XR_ARM_BUCKET}, owned in ${XR_REGION}"
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
# Same flattened `-F` needle style as phase 0b, literals of the 301 arm of
# `refuseTakenCreateName`.
XR_FLAT="$(printf '%s' "${XR_OUT}" | tr '\n' ' ' | tr -s ' ')"
for needle in 'XrArmBucket (AWS::S3::Bucket) is created with BucketName' \
  "BucketName ${XR_ARM_BUCKET}, and S3 answered 301 for that bucket" \
  'already exists in another region' 'Nothing was created.'; do
  if ! printf '%s' "${XR_FLAT}" | grep -qF -- "${needle}"; then
    echo "FAIL phase 0: refusal output lacks message fragment: ${needle}" >&2
    exit 1
  fi
done
if printf '%s' "${XR_FLAT}" | grep -qF -- 'Refusing to adopt existing S3 bucket'; then
  echo "FAIL phase 0: the issue #2227 CreateBucket-side guard fired, so the pre-create lookup let the name through as free" >&2
  exit 1
fi
echo "    OK: refused (rc=${XR_RC}) before CreateBucket: S3 answered 301 for ${XR_ARM_BUCKET}"

# Reset to a clean slate before the real phases: the refused deploy may have
# created the stack's other buckets before failing, and left a state record.
# `cleanup` also drops the colliding bucket, since its XR line was folded into
# that same handler.
echo "==> Phase 0 teardown"
cleanup
# Load-bearing: this bucket lives in XR_REGION, outside both the fixture's
# REGION-scoped sweeps and /run-integ's post-run orphan scan, so a failed
# delete would leak SILENTLY while the run still reports 0 orphans.
assert_gone_eventually "phase 0 teardown: ${XR_ARM_BUCKET} survived cleanup in ${XR_REGION}" \
  aws s3api head-bucket --bucket "${XR_ARM_BUCKET}" --region "${XR_REGION}"

# --- Phase 0c: Cloud-Control-routed delete, bucket identity (issue #2283) ---
# The issue #2227 / #2245 guards live in `S3BucketProvider`, on the SDK route.
# An `AWS::S3::Bucket` recorded as `provisionedBy: 'cc-api'` never reaches that
# provider at all: `ProviderRegistry.getProviderFor` step 2 (the sticky rule)
# hands it to `CloudControlProvider` BEFORE the SDK provider is consulted, and
# that provider's only region check fires on the `NotFound` branch -- which,
# per the mechanism issues #2245 / #2283 record, S3 does not produce here,
# because it follows the region redirect for a body-bearing operation. The
# destroy would then DELETE a live bucket in another region and report success.
# This phase is what holds that mechanism to account on the Cloud Control
# route: it has not been established there by measurement anywhere else.
#
# Both arms plant a single-resource state record BY HAND rather than deploying
# one. That is the defect's actual premise: a record written by a cdkd build
# from before the guards existed, whose `physicalId` names a bucket that is ours
# but lives elsewhere (a cdkd-GENERATED name carries no region or account --
# `src/provisioning/resource-name.ts:240` builds `{stackName}-{name}`, and the
# prefix is dropped only when BOTH halves of `:239` hold, a user-supplied name
# AND an active `getCurrentSkipPrefix()` -- so the same stack deployed to two
# regions produces the same bucket name). It also leaves the CDK app completely untouched, so every
# other phase synthesizes exactly the stack it always did.
#
# Arm OK is the negative control and it is load-bearing: it proves this
# hand-written state shape really does route through Cloud Control and really
# does delete. Without it, arm XR would "pass" on any malformed-state failure --
# a destroy that died for an unrelated reason also leaves the bucket standing.
#
# Both bucket names are PER-RUN UNIQUE. Measured 2026-08-26 on this fixture:
# once a name has existed in one region, re-creating it in ANOTHER answers
# `OperationAborted` for well over ten minutes, so planting a cross-region arm
# on a name the fixture reuses poisons it for the rest of the run and the next.
CC_ARM_STAMP="$(date -u +%s)"
CC_ARM_OK_BUCKET="cdkd-lifecycle-ccok-${ACCOUNT_ID}-${CC_ARM_STAMP}"
CC_ARM_XR_BUCKET="cdkd-lifecycle-ccxr-${ACCOUNT_ID}-${CC_ARM_STAMP}"

# Plant a v9 state record whose single resource is a cc-api-routed S3 bucket.
# `provisionedBy: cc-api` is what makes the destroy take the Cloud Control
# route; `region` is what the runner threads as `expectedRegion`.
write_cc_arm_state() { # usage: write_cc_arm_state <stackName> <bucketName>
  local stack_name="$1" bucket_name="$2"
  printf '%s' "{
  \"version\": 9,
  \"stackName\": \"${stack_name}\",
  \"region\": \"${REGION}\",
  \"resources\": {
    \"CcArmBucket\": {
      \"physicalId\": \"${bucket_name}\",
      \"resourceType\": \"AWS::S3::Bucket\",
      \"properties\": { \"BucketName\": \"${bucket_name}\" },
      \"dependencies\": [],
      \"provisionedBy\": \"cc-api\"
    }
  },
  \"outputs\": {},
  \"lastModified\": $(( CC_ARM_STAMP * 1000 ))
}" | aws s3 cp - "s3://${STATE_BUCKET}/cdkd/${stack_name}/${REGION}/state.json"
}

# The 0c-ID variant: TWO cc-api-routed buckets in one stack, so a single
# `cdkd destroy` run covers both sides of the new event's condition. Issue
# #2301's contract is not "a guard row exists" but "a guard row exists FOR THE
# RESOURCE WHOSE PROBE WAS DENIED, and for no other" -- and a single-resource
# stack cannot tell those apart: one resource yields one row whether the event
# is conditional or emitted unconditionally. The second bucket carries no deny
# policy, so its probe ANSWERS, and the run's guard-row count discriminates.
write_cc_arm_state_pair() { # usage: write_cc_arm_state_pair <stackName> <deniedBucket> <cleanBucket>
  local stack_name="$1" denied_bucket="$2" clean_bucket="$3"
  printf '%s' "{
  \"version\": 9,
  \"stackName\": \"${stack_name}\",
  \"region\": \"${REGION}\",
  \"resources\": {
    \"CcArmBucket\": {
      \"physicalId\": \"${denied_bucket}\",
      \"resourceType\": \"AWS::S3::Bucket\",
      \"properties\": { \"BucketName\": \"${denied_bucket}\" },
      \"dependencies\": [],
      \"provisionedBy\": \"cc-api\"
    },
    \"CcArmBucketClean\": {
      \"physicalId\": \"${clean_bucket}\",
      \"resourceType\": \"AWS::S3::Bucket\",
      \"properties\": { \"BucketName\": \"${clean_bucket}\" },
      \"dependencies\": [],
      \"provisionedBy\": \"cc-api\"
    }
  },
  \"outputs\": {},
  \"lastModified\": $(( CC_ARM_STAMP * 1000 ))
}" | aws s3 cp - "s3://${STATE_BUCKET}/cdkd/${stack_name}/${REGION}/state.json"
}

echo "==> Phase 0c-OK (control): a cc-api-routed bucket IN ${REGION} must still delete"
plant_bucket "${CC_ARM_OK_BUCKET}" "${REGION}"
write_cc_arm_state "${CC_ARM_STACK_OK}" "${CC_ARM_OK_BUCKET}"

set +e
CC_OK_OUT="$(node "${LOCAL_DIST}" state destroy "${CC_ARM_STACK_OK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)"
CC_OK_RC=$?
set -e
printf '%s\n' "${CC_OK_OUT}"
if [ "${CC_OK_RC}" -ne 0 ]; then
  echo "FAIL phase 0c-OK: the identity guard refused (or the destroy broke) on a bucket that IS in ${REGION} (rc=${CC_OK_RC})" >&2
  exit 1
fi
assert_gone_eventually "phase 0c-OK: ${CC_ARM_OK_BUCKET} survived a destroy that reported success" \
  aws s3api head-bucket --bucket "${CC_ARM_OK_BUCKET}" --region "${REGION}"
echo "    OK: control arm deleted through the Cloud Control route"

# go-to-k/cdkd#2423: `cdkd state destroy` records a deployment-event run, the
# same as `cdkd destroy` (phase 0c-ID pins that one). Before #2423 it threaded
# no recorder and wrote no `deployments/` object at all, so every assertion
# below fails on that build at the first one. The pre-run `cleanup` sweeps this
# stack's whole prefix, so exactly one run belongs to THIS destroy.
CC_OK_EVENTS_PREFIX="cdkd/${CC_ARM_STACK_OK}/${REGION}/deployments/"
CC_OK_EVENT_KEYS="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${CC_OK_EVENTS_PREFIX}" --query 'Contents[].Key' --output text)" || {
  echo "FAIL phase 0c-OK: could not list s3://${STATE_BUCKET}/${CC_OK_EVENTS_PREFIX}" >&2
  exit 1
}
CC_OK_JSONL_KEY=""
CC_OK_JSONL_COUNT=0
for cc_ok_key in ${CC_OK_EVENT_KEYS}; do
  case "${cc_ok_key}" in
    *.jsonl)
      CC_OK_JSONL_KEY="${cc_ok_key}"
      CC_OK_JSONL_COUNT=$((CC_OK_JSONL_COUNT + 1))
      ;;
  esac
done
if [ "${CC_OK_JSONL_COUNT}" -ne 1 ]; then
  echo "FAIL phase 0c-OK: expected exactly 1 {runId}.jsonl from 'cdkd state destroy' under s3://${STATE_BUCKET}/${CC_OK_EVENTS_PREFIX}, got ${CC_OK_JSONL_COUNT} (keys: ${CC_OK_EVENT_KEYS})" >&2
  exit 1
fi
CC_OK_EVENTS="$(aws s3 cp "s3://${STATE_BUCKET}/${CC_OK_JSONL_KEY}" - )" || {
  echo "FAIL phase 0c-OK: could not read s3://${STATE_BUCKET}/${CC_OK_JSONL_KEY}" >&2
  exit 1
}
cc_ok_jq() { # usage: cc_ok_jq <filter>  -> raw value over the slurped NDJSON
  printf '%s\n' "${CC_OK_EVENTS}" | jq -r -s "$1" || {
    echo "FAIL phase 0c-OK: jq could not parse s3://${STATE_BUCKET}/${CC_OK_JSONL_KEY} as NDJSON" >&2
    exit 1
  }
}
# One bracket per run: a second RUN_STARTED / RUN_FINISHED (a double-record
# regression) fails here instead of hiding behind `.[0]`.
CC_OK_STARTED_CMD="$(cc_ok_jq '[.[] | select(.eventType == "RUN_STARTED")] | if length == 1 then .[0].command // "MISSING" else "RUN_STARTED x\(length)" end')" || exit 1
CC_OK_FINISHED="$(cc_ok_jq '[.[] | select(.eventType == "RUN_FINISHED")] | if length == 1 then .[0] | "\(.result // "MISSING") \(.counts.deleted // -1)" else "RUN_FINISHED x\(length)" end')" || exit 1
# The per-resource row is what proves the recorder reached the RUNNER rather
# than only bracketing the run in the CLI: the bracket alone records no
# resource. Keyed by the PLANTED physical id, so a row for anything else fails.
CC_OK_SUCCESS_ROWS="$(printf '%s\n' "${CC_OK_EVENTS}" | jq -r -s --arg pid "${CC_ARM_OK_BUCKET}" \
  '[.[] | select(.eventType == "RESOURCE_SUCCEEDED" and .logicalId == "CcArmBucket" and .physicalId == $pid and .operation == "DELETE")] | length')" || {
  echo "FAIL phase 0c-OK: jq could not count RESOURCE_SUCCEEDED rows in s3://${STATE_BUCKET}/${CC_OK_JSONL_KEY}" >&2
  exit 1
}
if [ "${CC_OK_STARTED_CMD}" != "destroy" ] || [ "${CC_OK_FINISHED}" != "SUCCEEDED 1" ] \
  || [ "${CC_OK_SUCCESS_ROWS}" != "1" ]; then
  echo "FAIL phase 0c-OK: the 'cdkd state destroy' run record is wrong: RUN_STARTED.command=${CC_OK_STARTED_CMD} (expected destroy), RUN_FINISHED='${CC_OK_FINISHED}' (expected 'SUCCEEDED 1'), RESOURCE_SUCCEEDED DELETE rows for CcArmBucket=${CC_OK_SUCCESS_ROWS} (expected 1)" >&2
  printf '%s\n' "${CC_OK_EVENTS}" >&2
  exit 1
fi
# NEGATIVE CONTROL for phase 0c-ID: this arm's identity probe ANSWERED, so its
# run must carry no RESOURCE_GUARD_INDETERMINATE row. Only meaningful now that
# the arm records anything at all -- an empty stream satisfied it vacuously.
CC_OK_GUARD_ROWS="$(cc_ok_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | length')" || exit 1
if [ "${CC_OK_GUARD_ROWS}" != "0" ]; then
  echo "FAIL phase 0c-OK: ${CC_OK_GUARD_ROWS} RESOURCE_GUARD_INDETERMINATE row(s) on a destroy whose identity probe answered" >&2
  printf '%s\n' "${CC_OK_EVENTS}" >&2
  exit 1
fi
echo "    OK: 'cdkd state destroy' recorded one destroy run (${CC_OK_JSONL_KEY}): SUCCEEDED, 1 deleted, no guard row"

echo "==> Phase 0c-XR: cdkd must REFUSE to delete ${CC_ARM_XR_BUCKET}, which lives in ${XR_REGION}"
plant_bucket "${CC_ARM_XR_BUCKET}" "${XR_REGION}"

# Prove the PREMISE before asserting anything that depends on it: if the bucket
# did not land in the foreign region there is nothing for the guard to catch,
# and the arm would "pass" on any unrelated failure.
# `set +e` around the read: bare under `set -e` a transient probe failure
# aborts the script with a raw AWS error, and the FAIL line below -- the one
# that names the phase and what it expected -- never prints.
#
# stderr is deliberately NOT folded in, unlike the two `state destroy` captures
# in this phase: those are grepped for needles, this one is compared for
# EQUALITY, so any AWS CLI warning on stderr would land inside the value and
# fail a premise that actually held. The rc capture is what reports a failed
# probe; stderr goes to the run log where it is readable. Matches the Phase 0
# sibling read, which is bare for the same reason.
set +e
CC_XR_LOC="$(aws s3api get-bucket-location --bucket "${CC_ARM_XR_BUCKET}" \
  --query 'LocationConstraint' --output text)"
CC_XR_LOC_RC=$?
set -e
if [ "${CC_XR_LOC_RC}" -ne 0 ] || [ "${CC_XR_LOC}" != "${XR_REGION}" ]; then
  echo "FAIL phase 0c-XR premise: arm bucket should be in ${XR_REGION}, got '${CC_XR_LOC}' (rc=${CC_XR_LOC_RC})" >&2
  exit 1
fi

# The state says ${REGION} while the bucket is in ${XR_REGION} -- the poisoned
# record the issue describes.
write_cc_arm_state "${CC_ARM_STACK_XR}" "${CC_ARM_XR_BUCKET}"

set +e
CC_XR_OUT="$(node "${LOCAL_DIST}" state destroy "${CC_ARM_STACK_XR}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)"
CC_XR_RC=$?
set -e
printf '%s\n' "${CC_XR_OUT}"

if [ "${CC_XR_RC}" -eq 0 ]; then
  echo "FAIL phase 0c-XR: destroy SUCCEEDED while ${CC_ARM_XR_BUCKET} lives in ${XR_REGION} -- cdkd deleted a foreign-region bucket" >&2
  exit 1
fi
# Short needles against a FLATTENED copy, never one long phrase against the raw
# output: grep is line-based, so a needle straddling a logger line-wrap scores 0
# on a perfectly correct message -- a false FAIL that reads like a regression.
# Asserting the POSITIVE marker only the fixed path emits, not merely "the
# destroy failed", which any unrelated breakage would also satisfy.
CC_XR_FLAT="$(printf '%s' "${CC_XR_OUT}" | tr '\n' ' ' | tr -s ' ')"
for needle in 'Refusing to delete S3 bucket' "lives in ${XR_REGION}" "destroy targets ${REGION}"; do
  if ! printf '%s' "${CC_XR_FLAT}" | grep -qF -- "${needle}"; then
    echo "FAIL phase 0c-XR: refusal output lacks message fragment: ${needle}" >&2
    exit 1
  fi
done

# The assertion that actually distinguishes fixed from broken. The refusal
# message above proves the guard SPOKE; this proves the bucket is still there.
# Pre-fix this bucket is gone, unrecoverably.
set +e
CC_XR_HEAD_OUT="$(aws s3api head-bucket --bucket "${CC_ARM_XR_BUCKET}" --region "${XR_REGION}" 2>&1)"
CC_XR_HEAD_RC=$?
set -e
if [ "${CC_XR_HEAD_RC}" -ne 0 ]; then
  echo "FAIL phase 0c-XR: ${CC_ARM_XR_BUCKET} is GONE from ${XR_REGION} after a destroy that was supposed to refuse it: ${CC_XR_HEAD_OUT}" >&2
  exit 1
fi
echo "    OK: refused (rc=${CC_XR_RC}) and ${CC_ARM_XR_BUCKET} survives in ${XR_REGION}"


# --- Phase 0c-ID: the SUPPRESSED guard leaves a durable trace (issue #2301) ---
#
# The two arms above cover the guard ANSWERING: it confirms (0c-OK) or it
# refuses (0c-XR). This one covers the third outcome, which is the one the
# attack produces: the probe CANNOT answer, cdkd proceeds -- correctly, since
# refusing would strand every least-privilege destroy that never granted
# `s3:GetBucketLocation` -- and before issue #2301 the only trace was a
# `logger.warn` on a terminal that scrolls away. Afterwards, a destroy that
# proceeded WITHOUT confirming its target was indistinguishable from one that
# confirmed it.
#
# The suppression is planted the way an attacker would: a bucket policy on the
# TARGET denying `s3:GetBucketLocation`, which anyone holding
# `s3:PutBucketPolicy` on that bucket can set. An explicit resource-policy Deny
# beats the caller's own IAM Allow, so the probe 403s while the credentials are
# otherwise unchanged.
#
# The stack holds TWO cc-api-routed buckets and only the first is denied. That
# is what makes the assertions discriminating rather than merely green: the
# contract is "a guard row for the resource whose probe was denied, and for no
# other", and a one-resource stack yields one row under either reading. The
# second bucket is the in-run control -- same command, same route, same guard,
# answering probe.
#
# THE DELETE STILL HAS TO SUCCEED, and that is a claim about AWS rather than
# about cdkd, so it was MEASURED rather than assumed. `cloudformation
# describe-type --type RESOURCE --type-name AWS::S3::Bucket` (us-east-1,
# 2026-09-02) lists five handlers, and `s3:GetBucketLocation` appears in NONE of
# them -- `delete` needs only `s3:DeleteBucket` and `s3:ListBucket`. So a Deny
# scoped to that one action suppresses cdkd's probe and leaves Cloud Control's
# delete untouched. If this arm ever fails with an AccessDenied naming
# `s3:GetBucketLocation` from the CC handler rather than from cdkd's warn, that
# measurement has gone stale and the arm needs a different suppression, not a
# wider policy.
#
# `cdkd destroy`, NOT `cdkd state destroy` like its two siblings: both verbs
# record events since go-to-k/cdkd#2423, and phase 0c-OK pins the state verb's,
# so driving the top-level verb here is what keeps ITS recorder pinned live as
# well. `cdkd destroy` resolves candidate stacks from the CDK app when one
# synthesizes, and this stack is hand-planted rather than in the app -- so it
# runs from a scratch directory with no `cdk.json`, which is what makes the CLI
# fall back to its state-based stack list.
CC_ARM_ID_BUCKET="cdkd-lifecycle-ccid-${ACCOUNT_ID}-${CC_ARM_STAMP}"
# Same stack, same route, NO deny policy -- the in-run control (see
# `write_cc_arm_state_pair`).
CC_ARM_ID_CLEAN_BUCKET="cdkd-lifecycle-ccidok-${ACCOUNT_ID}-${CC_ARM_STAMP}"
CC_ARM_ID_WORKDIR="$(mktemp -d)"

echo "==> Phase 0c-ID: a DENIED s3:GetBucketLocation must still delete, must leave a durable record, and must not tar the bucket beside it"
plant_bucket "${CC_ARM_ID_BUCKET}" "${REGION}"
plant_bucket "${CC_ARM_ID_CLEAN_BUCKET}" "${REGION}"

cat > "${CC_ARM_ID_WORKDIR}/deny-getbucketlocation.json" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyGetBucketLocationToEveryone",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::${CC_ARM_ID_BUCKET}"
    }
  ]
}
POLICY
aws s3api put-bucket-policy --bucket "${CC_ARM_ID_BUCKET}" --region "${REGION}" \
  --policy "file://${CC_ARM_ID_WORKDIR}/deny-getbucketlocation.json"

# PROVE THE PREMISE before asserting anything that rests on it. A policy that
# did not actually take effect (Block Public Access rejecting it, eventual
# consistency, a typo in the resource ARN) would leave the guard ANSWERING, and
# then every assertion below would be measuring the ordinary 0c-OK path while
# reporting that it had exercised the suppressed one -- a green run over an arm
# that tested nothing. Polled, because a bucket policy is not read-after-write
# consistent.
CC_ID_DENIED=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  set +e
  CC_ID_LOC_OUT="$(aws s3api get-bucket-location --bucket "${CC_ARM_ID_BUCKET}" --region "${REGION}" 2>&1)"
  CC_ID_LOC_RC=$?
  set -e
  if [ "${CC_ID_LOC_RC}" -ne 0 ] && printf '%s' "${CC_ID_LOC_OUT}" | grep -qF 'AccessDenied'; then
    CC_ID_DENIED=1
    break
  fi
  echo "    (waiting for the deny policy to take effect, attempt ${attempt}/10)"
  sleep 3
done
if [ "${CC_ID_DENIED}" -ne 1 ]; then
  echo "FAIL phase 0c-ID premise: s3:GetBucketLocation on ${CC_ARM_ID_BUCKET} is still ANSWERING, so the guard was never suppressed (rc=${CC_ID_LOC_RC}, out=${CC_ID_LOC_OUT})" >&2
  exit 1
fi
echo "    premise: s3:GetBucketLocation on ${CC_ARM_ID_BUCKET} is DENIED"

# The state record is well-formed and points at a bucket that really is in
# ${REGION} -- the ONLY thing wrong with this destroy is that cdkd cannot
# CONFIRM that. So a refusal here would be a false refusal, and a silent
# success would be the issue.
write_cc_arm_state_pair "${CC_ARM_STACK_ID}" "${CC_ARM_ID_BUCKET}" "${CC_ARM_ID_CLEAN_BUCKET}"

set +e
# `env -u CDKD_APP`: the scratch directory has no `cdk.json`, but an ambient
# `CDKD_APP` would still resolve an app and make synth SUCCEED -- and then
# `cdkd destroy` filters its candidate stacks to that app's, which this
# hand-planted stack is not in, and the arm fails on "No matching stacks found"
# for a reason that has nothing to do with what it tests. Same idiom as the
# `env -u CDKD_TEST_UPDATE` deploys later in this file.
# `--verbose`: the CONFIRMED arm of the guard logs at `debug`, and asserting on
# it is the only positive evidence that the control bucket's probe actually RAN.
# Without it the control is "no guard row for CcArmBucketClean", which a probe
# that was never issued satisfies just as well as one that answered -- the same
# absence-proves-nothing trap the count assertion fell into.
CC_ID_OUT="$(cd "${CC_ARM_ID_WORKDIR}" && env -u CDKD_APP node "${LOCAL_DIST}" destroy "${CC_ARM_STACK_ID}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose 2>&1)"
CC_ID_RC=$?
set -e
# ECHOED with the caller's identity masked. `--verbose` turns on the `debug`
# line that carries AWS's own message, and for this arm that message is the
# `AccessDenied` naming `arn:aws:sts::<account>:assumed-role/<role>/<session>`.
# That is CORRECT behaviour -- issue #2302 routes AWS's wording to `debug`
# precisely so it stays available -- but this transcript gets pasted into PR
# bodies and issue comments, so the run should not be the thing that publishes
# it. Only the ECHO is masked; `CC_ID_FLAT` below is built from the RAW output,
# so every assertion still reads what cdkd actually printed.
printf '%s\n' "${CC_ID_OUT}" | sed -E 's#arn:aws:sts::[0-9]+:assumed-role/[^ ]*#arn:aws:sts::<account>:assumed-role/<masked>#g'

if [ "${CC_ID_RC}" -ne 0 ]; then
  echo "FAIL phase 0c-ID: the destroy did NOT proceed (rc=${CC_ID_RC}). A guard that cannot answer must warn and continue -- refusing here strands every least-privilege destroy. If the error names s3:GetBucketLocation as an AWS-side denial rather than a cdkd warning, the Cloud Control delete handler now needs that permission and this arm's suppression has to be redesigned." >&2
  exit 1
fi

assert_gone_eventually "phase 0c-ID: ${CC_ARM_ID_BUCKET} survived a destroy that reported success" \
  aws s3api head-bucket --bucket "${CC_ARM_ID_BUCKET}" --region "${REGION}"
assert_gone_eventually "phase 0c-ID: ${CC_ARM_ID_CLEAN_BUCKET} (the in-run control) survived a destroy that reported success" \
  aws s3api head-bucket --bucket "${CC_ARM_ID_CLEAN_BUCKET}" --region "${REGION}"

# Short needles against a FLATTENED copy, never one long phrase against the raw
# output: grep is line-based, so a needle straddling a logger line-wrap scores 0
# on a perfectly correct message.
#
# NONE of these may span a COLORIZED span either. `src/utils/colors.ts` emits
# ANSI unconditionally ("Always emit ANSI escape codes -- the terminal ... decides
# whether to render them"), so a needle crossing a coloured token scores 0 on a
# correct run: the summary suffix is `, ${yellow(N)} unverified`, which means the
# literal `1 unverified` is NOT in the output and `unverified, 0 errors)` is. The
# COUNT is pinned instead through the aggregate warning, whose number is not
# coloured -- and exactly, through the persisted event object below.
CC_ID_FLAT="$(printf '%s' "${CC_ID_OUT}" | tr '\n' ' ' | tr -s ' ')"
for needle in 'Could not confirm which region S3 bucket' 'Grant s3:GetBucketLocation' \
  'unverified, 0 errors)' '1 pre-flight safety check(s) could NOT be completed'; do
  if ! printf '%s' "${CC_ID_FLAT}" | grep -qF -- "${needle}"; then
    echo "FAIL phase 0c-ID: destroy output lacks fragment: ${needle}" >&2
    exit 1
  fi
done

# THE ASSERTION THIS ARM EXISTS FOR. Everything above is console text, which is
# exactly what issue #2301 says is not enough -- it does not survive the run.
# This reads the PERSISTED event object back out of S3, after the destroy has
# finished and the state record is gone.
CC_ID_EVENTS_PREFIX="cdkd/${CC_ARM_STACK_ID}/${REGION}/deployments/"
CC_ID_KEYS="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${CC_ID_EVENTS_PREFIX}" --query 'Contents[].Key' --output text)"
CC_ID_JSONL_KEY=""
for cc_id_key in ${CC_ID_KEYS}; do
  case "${cc_id_key}" in
    *.jsonl) CC_ID_JSONL_KEY="${cc_id_key}" ;;
  esac
done
if [ -z "${CC_ID_JSONL_KEY}" ]; then
  echo "FAIL phase 0c-ID: no {runId}.jsonl under s3://${STATE_BUCKET}/${CC_ID_EVENTS_PREFIX} (keys: ${CC_ID_KEYS})" >&2
  exit 1
fi

CC_ID_EVENTS="$(aws s3 cp "s3://${STATE_BUCKET}/${CC_ID_JSONL_KEY}" - )"

cc_id_jq() { # usage: cc_id_jq <filter>  -> raw value over the slurped NDJSON
  printf '%s\n' "${CC_ID_EVENTS}" | jq -r -s "$1"
}

CC_ID_GUARD_ROWS="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | length')"
if [ "${CC_ID_GUARD_ROWS}" != "1" ]; then
  echo "FAIL phase 0c-ID: expected exactly 1 RESOURCE_GUARD_INDETERMINATE event in ${CC_ID_JSONL_KEY}, got ${CC_ID_GUARD_ROWS}" >&2
  printf '%s\n' "${CC_ID_EVENTS}" >&2
  exit 1
fi

CC_ID_GUARD_NAME="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | .[0].guard // "MISSING"')"
CC_ID_GUARD_LOGICAL="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | .[0].logicalId // "MISSING"')"
CC_ID_GUARD_PHYSICAL="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | .[0].physicalId // "MISSING"')"
CC_ID_GUARD_REASON="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | .[0].reason // "MISSING"')"
if [ "${CC_ID_GUARD_NAME}" != "cc-delete-region-identity" ] \
  || [ "${CC_ID_GUARD_LOGICAL}" != "CcArmBucket" ] \
  || [ "${CC_ID_GUARD_PHYSICAL}" != "${CC_ARM_ID_BUCKET}" ]; then
  echo "FAIL phase 0c-ID: guard event identifies the wrong thing: guard=${CC_ID_GUARD_NAME} logicalId=${CC_ID_GUARD_LOGICAL} physicalId=${CC_ID_GUARD_PHYSICAL}" >&2
  exit 1
fi
# The reason is the whole value of the row -- a guard event with no cause tells
# the reader nothing they could act on.
case "${CC_ID_GUARD_REASON}" in
  *"s3:GetBucketLocation"*) : ;;
  *)
    echo "FAIL phase 0c-ID: guard event's reason does not name the denied probe: ${CC_ID_GUARD_REASON}" >&2
    exit 1
    ;;
esac

# ...and the reason must NOT carry the CALLER. This is the only place the REAL
# S3 wording is ever observed: the unit fence asserts the same property against
# a synthetic double, which shares its premise with the production code it is
# fencing. S3 words an `AccessDenied` on this probe as
# `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
# to perform: ...`, and since issue #2301 item 3 this value is PERSISTED to
# `deployments/*.jsonl`, which `cdkd destroy` does not sweep -- so a regression
# in `describeAwsFailure`'s redaction would write the destroying principal's
# identity into a durable artifact, at a moment the ATTACKER picks. A live
# needle is what makes that property fenced rather than assumed.
case "${CC_ID_GUARD_REASON}" in
  *"assumed-role"*|*"arn:aws:sts::"*|*"is not authorized to perform"*)
    echo "FAIL phase 0c-ID: the PERSISTED reason carries caller identity -- the issue #2302 redaction regressed: ${CC_ID_GUARD_REASON}" >&2
    exit 1
    ;;
esac
# The redaction keeps the error CLASS, which is the half an operator acts on.
case "${CC_ID_GUARD_REASON}" in
  *"AccessDenied"*) : ;;
  *)
    echo "FAIL phase 0c-ID: reason names neither the caller (good) nor the error class (bad) -- redaction dropped the actionable half: ${CC_ID_GUARD_REASON}" >&2
    exit 1
    ;;
esac

# THE IN-RUN NEGATIVE CONTROL, and the reason this arm's stack holds TWO
# buckets. `CcArmBucketClean` went through the same command, the same Cloud
# Control route and the same guard, differing only in that its probe was never
# denied -- so it must have NO guard row. Asserted as the guard rows' exact
# membership rather than only their count, because those are different claims:
# a count of 1 is satisfied by a row naming the WRONG resource.
#
# Without a second resource this control cannot exist. A single-resource stack
# yields exactly one guard row whether the event is conditional on the verdict
# or emitted unconditionally on every delete, so the count assertion above
# would pass either way -- it would read as fenced while discriminating
# nothing. (The unit suite covers the same condition at
# `tests/unit/cli/destroy-runner-guard-indeterminate.test.ts`, but a provider
# that reports a guard on every delete is a PRODUCER-side failure the runner
# tests cannot see, since they feed the runner its delete results directly.)
# POSITIVE evidence that the control's probe ran and ANSWERED. Paired with the
# membership assertion below: that one proves no row was emitted for the clean
# bucket, this one proves the guard was actually exercised on it, and only the
# two together distinguish "the guard answered" from "the guard never ran".
if ! printf '%s' "${CC_ID_FLAT}" | grep -qF -- "Confirmed S3 bucket ${CC_ARM_ID_CLEAN_BUCKET}"; then
  echo "FAIL phase 0c-ID control: no 'Confirmed S3 bucket ${CC_ARM_ID_CLEAN_BUCKET}' line -- the control bucket's identity probe never ran, so its lack of a guard row proves nothing." >&2
  exit 1
fi

CC_ID_GUARD_LOGICALS="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE") | .logicalId] | sort | join(",")')"
if [ "${CC_ID_GUARD_LOGICALS}" != "CcArmBucket" ]; then
  echo "FAIL phase 0c-ID control: guard rows name [${CC_ID_GUARD_LOGICALS}], expected exactly [CcArmBucket]. A row for CcArmBucketClean means the event fires regardless of the guard's verdict, not because the probe was denied." >&2
  printf '%s\n' "${CC_ID_EVENTS}" >&2
  exit 1
fi

# ...ALONGSIDE each resource's own success row, not instead of it. This is the
# design decision the PR records, so it gets an assertion rather than a comment:
# emitting instead-of would leave the RESOURCE_STARTED row with no terminal
# partner and would contradict RUN_FINISHED's `counts.deleted`. Both buckets
# were deleted, so both carry a success row and the run counts two.
CC_ID_SUCCESS_ROWS="$(cc_id_jq '[.[] | select(.eventType == "RESOURCE_SUCCEEDED" and (.logicalId == "CcArmBucket" or .logicalId == "CcArmBucketClean"))] | length')"
CC_ID_DELETED_COUNT="$(cc_id_jq '[.[] | select(.eventType == "RUN_FINISHED")] | .[0].counts.deleted // -1')"
if [ "${CC_ID_SUCCESS_ROWS}" != "2" ] || [ "${CC_ID_DELETED_COUNT}" != "2" ]; then
  echo "FAIL phase 0c-ID: the guard row replaced a success row instead of accompanying it (RESOURCE_SUCCEEDED=${CC_ID_SUCCESS_ROWS}, expected 2; counts.deleted=${CC_ID_DELETED_COUNT}, expected 2)" >&2
  printf '%s\n' "${CC_ID_EVENTS}" >&2
  exit 1
fi

echo "    OK: delete proceeded (rc=0), both buckets gone, and exactly one RESOURCE_GUARD_INDETERMINATE -- naming the denied bucket only -- persisted in ${CC_ID_JSONL_KEY}"

# The `deployments/` objects this arm just asserted on are NOT swept by
# `cdkd destroy` (state deletion deliberately leaves the post-mortem behind), so
# /run-integ's `s3://<state bucket>/cdkd/` orphan scan would report them. The
# recursive per-stack sweep in `cleanup` removes them; this is here so the
# reason is on record beside the arm that creates them.

echo "==> Phase 0c teardown"
cleanup
# Load-bearing: this bucket lives in XR_REGION, outside both the fixture's
# REGION-scoped sweeps and /run-integ's post-run orphan scan, so a failed delete
# would leak SILENTLY while the run still reports 0 orphans.
assert_gone_eventually "phase 0c teardown: ${CC_ARM_XR_BUCKET} survived cleanup in ${XR_REGION}" \
  aws s3api head-bucket --bucket "${CC_ARM_XR_BUCKET}" --region "${XR_REGION}"

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
#   - notification: CFn declares the event as the SCALAR `Event` where the SDK
#     member is the LIST `Events`;
#   - lifecycle: `t['TransitionInDays'] ?? t['Days']`.
# (`TopicArn` / `NoncurrentDays` are refused pre-flight by the nested-required
# check and are no longer read — issue #3585.)
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
  local wire_days wire_topic wire_events
  wire_days="$(LC "${ALIAS_BUCKET}" "Rules[?ID=='alias-transitions'].Transitions[0].Days | [0]")"
  if [ "${wire_days}" != "${expect_days}" ]; then
    echo "FAIL [${phase}]: alias bucket wire Days=${wire_days} (want ${expect_days})" >&2
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
    event: (.properties.NotificationConfiguration.TopicConfigurations[0] | has("Event")),
    events: (.properties.NotificationConfiguration.TopicConfigurations[0] | has("Events")),
    tid: (.properties.LifecycleConfiguration.Rules[0].Transitions[0] | has("TransitionInDays")),
    days: (.properties.LifecycleConfiguration.Rules[0].Transitions[0] | has("Days")),
    tidValue: .properties.LifecycleConfiguration.Rules[0].Transitions[0].TransitionInDays
  } | tojson')"
  # Emptiness, not the exit code, is the read-failure signal (see `alias_state`).
  [ -n "${rec}" ] || { echo "FAIL [${phase}]: could not read the alias bucket state entry" >&2; exit 1; }
  local want="{\"topic\":true,\"event\":true,\"events\":false,\"tid\":true,\"days\":false,\"tidValue\":${expect_days}}"
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

# --- Phase 1c: a suppressed guard on the DEPLOY path is persisted (issue #2422)
# Phase 0c-ID pins the destroy verb. This arm drives the same Cloud Control
# delete through `cdkd deploy`, at two of its delete sites in ONE deploy, by
# planting three cc-api-routed bucket records into THIS stack's state:
#
#   - DepArmBucket: not in the template, so the deploy's template-DELETE
#     branch deletes it. Its bucket policy denies `s3:GetBucketLocation`, so
#     the identity guard cannot answer.
#   - DepArmBucketClean: the same, with no deny policy -- the in-run control
#     whose guard answers and must leave no row.
#   - DepArmReplaceBucket: IN the template (`CDKD_DEP_ARM_REPLACE_BUCKET`) under
#     a different BucketName, which is create-only, so the deploy REPLACES it:
#     it creates the new bucket first and then deletes the planted, denied one
#     inside the UPDATE. This is the row whose `operation` is the decision
#     issue #2422 records: `DELETE` on the guard row, `UPDATE` on the row's
#     own outcome.
#
# Everything else deploys the phase-1 template (`env -u CDKD_TEST_UPDATE`, as
# in phase 1b), and a second deploy without the variable then removes the new
# bucket, so the stack is back in its phase-1 shape for phase 2.
#
# The rollback half rides phase 2c (its rollback-of-a-CREATE arm). The
# remaining deploy sites (the `--recreate-via-*` destroy-then-create, the
# `--replace` delete-first fallback, the update-not-supported fallback) and the
# other rollback arms record through the same code and are unit-covered.
DEP_ARM_ID_BUCKET="cdkd-lifecycle-depid-${ACCOUNT_ID}-${CC_ARM_STAMP}"
DEP_ARM_ID_CLEAN_BUCKET="cdkd-lifecycle-depidok-${ACCOUNT_ID}-${CC_ARM_STAMP}"
DEP_ARM_OLD_BUCKET="cdkd-lifecycle-depold-${ACCOUNT_ID}-${CC_ARM_STAMP}"
DEP_ARM_NEW_BUCKET="cdkd-lifecycle-depnew-${ACCOUNT_ID}-${CC_ARM_STAMP}"
DEP_ARM_ID_WORKDIR="$(mktemp -d)"

echo "==> Phase 1c: a DENIED s3:GetBucketLocation on a deploy-path DELETE (removal and replacement) must leave a durable record"
plant_bucket "${DEP_ARM_ID_BUCKET}" "${REGION}"
plant_bucket "${DEP_ARM_ID_CLEAN_BUCKET}" "${REGION}"
plant_bucket "${DEP_ARM_OLD_BUCKET}" "${REGION}"

deny_get_bucket_location() { # usage: deny_get_bucket_location <bucket>
  local bucket="$1"
  cat > "${DEP_ARM_ID_WORKDIR}/deny-${bucket}.json" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyGetBucketLocationToEveryone",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::${bucket}"
    }
  ]
}
POLICY
  aws s3api put-bucket-policy --bucket "${bucket}" --region "${REGION}" \
    --policy "file://${DEP_ARM_ID_WORKDIR}/deny-${bucket}.json"
  # Prove the premise first, as phase 0c-ID does: a policy that did not take
  # effect leaves the guard answering, and the arm would then pass over the
  # ordinary path.
  local attempt out rc
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    set +e
    out="$(aws s3api get-bucket-location --bucket "${bucket}" --region "${REGION}" 2>&1)"
    rc=$?
    set -e
    if [ "${rc}" -ne 0 ] && printf '%s' "${out}" | grep -qF 'AccessDenied'; then
      echo "    premise: s3:GetBucketLocation on ${bucket} is DENIED"
      return 0
    fi
    echo "    (waiting for the deny policy on ${bucket} to take effect, attempt ${attempt}/10)"
    sleep 3
  done
  echo "FAIL phase 1c premise: s3:GetBucketLocation on ${bucket} is still ANSWERING, so the guard was never suppressed (rc=${rc}, out=${out})" >&2
  return 1
}
deny_get_bucket_location "${DEP_ARM_ID_BUCKET}"
deny_get_bucket_location "${DEP_ARM_OLD_BUCKET}"

# Plant the three records into the live phase-1 state.
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${DEP_ARM_ID_WORKDIR}/state.json" >/dev/null
jq --arg denied "${DEP_ARM_ID_BUCKET}" --arg clean "${DEP_ARM_ID_CLEAN_BUCKET}" \
  --arg old "${DEP_ARM_OLD_BUCKET}" '
  .resources.DepArmBucket = {
    physicalId: $denied, resourceType: "AWS::S3::Bucket",
    properties: { BucketName: $denied }, attributes: {}, dependencies: [],
    provisionedBy: "cc-api" }
  | .resources.DepArmBucketClean = {
    physicalId: $clean, resourceType: "AWS::S3::Bucket",
    properties: { BucketName: $clean }, attributes: {}, dependencies: [],
    provisionedBy: "cc-api" }
  | .resources.DepArmReplaceBucket = {
    physicalId: $old, resourceType: "AWS::S3::Bucket",
    properties: { BucketName: $old }, attributes: {}, dependencies: [],
    provisionedBy: "cc-api" }' \
  "${DEP_ARM_ID_WORKDIR}/state.json" > "${DEP_ARM_ID_WORKDIR}/state-planted.json"
aws s3 cp "${DEP_ARM_ID_WORKDIR}/state-planted.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null

# The deploy writes a NEW `{runId}.jsonl` beside phase 1's and 1b's, so the
# keys present now are recorded and the run is the one key added.
DEP_ID_EVENTS_PREFIX="cdkd/${STACK}/${REGION}/deployments/"
DEP_ID_KEYS_BEFORE="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${DEP_ID_EVENTS_PREFIX}" --query 'Contents[].Key' --output text)"

set +e
# `--verbose`: the guard's CONFIRMED arm logs at `debug`, the only positive
# evidence that the control bucket's probe ran (phase 0c-ID's reasoning).
# `--force-stateful-recreation`: any S3 bucket replacement is refused without
# it mid-deploy (cdkd cannot prove the old bucket empty there). It changes
# nothing on the two removals.
DEP_ID_OUT="$(env -u CDKD_TEST_UPDATE CDKD_DEP_ARM_REPLACE_BUCKET="${DEP_ARM_NEW_BUCKET}" \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose --force-stateful-recreation 2>&1)"
DEP_ID_RC=$?
set -e
# Echoed with the caller's identity masked, as in phase 0c-ID: the debug line
# carries AWS's AccessDenied wording, which names the assumed role.
printf '%s\n' "${DEP_ID_OUT}" | sed -E 's#arn:aws:sts::[0-9]+:assumed-role/[^ ]*#arn:aws:sts::<account>:assumed-role/<masked>#g' | tail -40
if [ "${DEP_ID_RC}" -ne 0 ]; then
  echo "FAIL phase 1c: the deploy did NOT proceed (rc=${DEP_ID_RC}); a guard that cannot answer must warn and continue" >&2
  exit 1
fi

assert_gone_eventually "phase 1c: ${DEP_ARM_ID_BUCKET} survived a deploy that removed it" \
  aws s3api head-bucket --bucket "${DEP_ARM_ID_BUCKET}" --region "${REGION}"
assert_gone_eventually "phase 1c: ${DEP_ARM_ID_CLEAN_BUCKET} (the in-run control) survived a deploy that removed it" \
  aws s3api head-bucket --bucket "${DEP_ARM_ID_CLEAN_BUCKET}" --region "${REGION}"
assert_gone_eventually "phase 1c: ${DEP_ARM_OLD_BUCKET} survived the replacement that retired it" \
  aws s3api head-bucket --bucket "${DEP_ARM_OLD_BUCKET}" --region "${REGION}"
DEP_ID_STATE_LEFT="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '[.resources | to_entries[] | select(.key | startswith("DepArm")) | "\(.key)=\(.value.physicalId)"] | join(",")')"
if [ "${DEP_ID_STATE_LEFT}" != "DepArmReplaceBucket=${DEP_ARM_NEW_BUCKET}" ]; then
  echo "FAIL phase 1c: state holds [${DEP_ID_STATE_LEFT}] after the deploy, expected exactly [DepArmReplaceBucket=${DEP_ARM_NEW_BUCKET}]" >&2
  exit 1
fi

DEP_ID_FLAT="$(printf '%s' "${DEP_ID_OUT}" | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' ' | tr -s ' ')"
if ! printf '%s' "${DEP_ID_FLAT}" | grep -qF -- "Confirmed S3 bucket ${DEP_ARM_ID_CLEAN_BUCKET}"; then
  echo "FAIL phase 1c control: no 'Confirmed S3 bucket ${DEP_ARM_ID_CLEAN_BUCKET}' line -- the control's identity probe never ran, so its lack of a guard row proves nothing" >&2
  exit 1
fi

DEP_ID_KEYS_AFTER="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${DEP_ID_EVENTS_PREFIX}" --query 'Contents[].Key' --output text)"
DEP_ID_JSONL_KEY=""
DEP_ID_JSONL_COUNT=0
for dep_id_key in ${DEP_ID_KEYS_AFTER}; do
  case "${dep_id_key}" in
    *.jsonl)
      case " ${DEP_ID_KEYS_BEFORE} " in
        *" ${dep_id_key} "*) : ;;
        *)
          DEP_ID_JSONL_KEY="${dep_id_key}"
          DEP_ID_JSONL_COUNT=$((DEP_ID_JSONL_COUNT + 1))
          ;;
      esac
      ;;
  esac
done
if [ "${DEP_ID_JSONL_COUNT}" -ne 1 ]; then
  echo "FAIL phase 1c: expected exactly 1 new {runId}.jsonl under s3://${STATE_BUCKET}/${DEP_ID_EVENTS_PREFIX}, got ${DEP_ID_JSONL_COUNT} (before: ${DEP_ID_KEYS_BEFORE}; after: ${DEP_ID_KEYS_AFTER})" >&2
  exit 1
fi
DEP_ID_EVENTS="$(aws s3 cp "s3://${STATE_BUCKET}/${DEP_ID_JSONL_KEY}" - )"
dep_id_jq() { # usage: dep_id_jq <filter>  -> raw value over the slurped NDJSON
  printf '%s\n' "${DEP_ID_EVENTS}" | jq -r -s "$1" || {
    echo "FAIL phase 1c: jq could not parse s3://${STATE_BUCKET}/${DEP_ID_JSONL_KEY} as NDJSON" >&2
    exit 1
  }
}

DEP_ID_COMMAND="$(dep_id_jq '[.[] | select(.eventType == "RUN_STARTED")] | if length == 1 then .[0].command // "MISSING" else "RUN_STARTED x\(length)" end')" || exit 1
if [ "${DEP_ID_COMMAND}" != "deploy" ]; then
  echo "FAIL phase 1c: the new run is not a deploy run (RUN_STARTED.command=${DEP_ID_COMMAND})" >&2
  exit 1
fi

# THE ASSERTION THIS ARM EXISTS FOR: exactly two guard rows -- the removed
# bucket and the replaced one, never the control -- each with the destroy
# runner's payload, aimed at the bucket the guarded delete ran on, and
# `operation: DELETE` for BOTH, including the one whose delete ran inside an
# UPDATE.
DEP_ID_GUARD="$(dep_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | sort_by(.logicalId) | map("\(.logicalId)|\(.operation)|\(.guard)|\(.physicalId)|\(.provisionedBy)|\(.resourceType)") | join(",")')" || exit 1
DEP_ID_GUARD_WANT="DepArmBucket|DELETE|cc-delete-region-identity|${DEP_ARM_ID_BUCKET}|cc-api|AWS::S3::Bucket,DepArmReplaceBucket|DELETE|cc-delete-region-identity|${DEP_ARM_OLD_BUCKET}|cc-api|AWS::S3::Bucket"
if [ "${DEP_ID_GUARD}" != "${DEP_ID_GUARD_WANT}" ]; then
  echo "FAIL phase 1c: guard rows are [${DEP_ID_GUARD}], expected exactly [${DEP_ID_GUARD_WANT}]. A row for DepArmBucketClean means the event fires regardless of the verdict; a missing row means that deploy-path delete site still discards the guard." >&2
  printf '%s\n' "${DEP_ID_EVENTS}" >&2
  exit 1
fi
DEP_ID_REASONS="$(dep_id_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE") | .reason // "MISSING"] | join(" || ")')" || exit 1
for dep_id_bucket in "${DEP_ARM_ID_BUCKET}" "${DEP_ARM_OLD_BUCKET}"; do
  case "${DEP_ID_REASONS}" in
    *"s3:GetBucketLocation on ${dep_id_bucket} could not be answered"*) : ;;
    *)
      echo "FAIL phase 1c: no guard reason names the denied probe on ${dep_id_bucket}: ${DEP_ID_REASONS}" >&2
      exit 1
      ;;
  esac
done
case "${DEP_ID_REASONS}" in
  *"AccessDenied"*) : ;;
  *)
    echo "FAIL phase 1c: the guard reasons do not carry the error class: ${DEP_ID_REASONS}" >&2
    exit 1
    ;;
esac
case "${DEP_ID_REASONS}" in
  *"assumed-role"*|*"arn:aws:sts::"*|*"is not authorized to perform"*)
    echo "FAIL phase 1c: a PERSISTED reason carries caller identity: ${DEP_ID_REASONS}" >&2
    exit 1
    ;;
esac

# Beside each row's own outcome, not instead of it: the two removals carry a
# DELETE success row, the replacement an UPDATE one naming the NEW bucket.
DEP_ID_SUCCESS_ROWS="$(dep_id_jq '[.[] | select(.eventType == "RESOURCE_SUCCEEDED" and .operation == "DELETE" and (.logicalId == "DepArmBucket" or .logicalId == "DepArmBucketClean"))] | length')" || exit 1
DEP_ID_REPLACE_ROW="$(dep_id_jq '[.[] | select(.eventType == "RESOURCE_SUCCEEDED" and .logicalId == "DepArmReplaceBucket")] | map("\(.operation)|\(.physicalId)") | join(",")')" || exit 1
DEP_ID_FINISHED="$(dep_id_jq '[.[] | select(.eventType == "RUN_FINISHED")] | if length == 1 then .[0].result // "MISSING" else "RUN_FINISHED x\(length)" end')" || exit 1
if [ "${DEP_ID_SUCCESS_ROWS}" != "2" ] || [ "${DEP_ID_REPLACE_ROW}" != "UPDATE|${DEP_ARM_NEW_BUCKET}" ] \
  || [ "${DEP_ID_FINISHED}" != "SUCCEEDED" ]; then
  echo "FAIL phase 1c: RESOURCE_SUCCEEDED DELETE rows=${DEP_ID_SUCCESS_ROWS} (expected 2), DepArmReplaceBucket outcome=[${DEP_ID_REPLACE_ROW}] (expected [UPDATE|${DEP_ARM_NEW_BUCKET}]), RUN_FINISHED.result=${DEP_ID_FINISHED} (expected SUCCEEDED)" >&2
  printf '%s\n' "${DEP_ID_EVENTS}" >&2
  exit 1
fi
echo "    OK: exactly two RESOURCE_GUARD_INDETERMINATE rows (removal + in-UPDATE replacement delete, both operation DELETE), none for the control, persisted in ${DEP_ID_JSONL_KEY}"

# Back to the phase-1 shape: the same template without the variable removes
# the replacement bucket, whose probe is not denied.
env -u CDKD_TEST_UPDATE -u CDKD_DEP_ARM_REPLACE_BUCKET node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone_eventually "phase 1c: ${DEP_ARM_NEW_BUCKET} survived the deploy that removed it from the template" \
  aws s3api head-bucket --bucket "${DEP_ARM_NEW_BUCKET}" --region "${REGION}"
rm -rf "${DEP_ARM_ID_WORKDIR}"

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
assert_eventbridge_absent "phase 2"
# The alias transition day count CHANGES in UPDATE mode (90 -> 60), so this
# really drives the update-path fold rather than re-reading the phase-1 record.
assert_alias_spellings "phase 2" "60"
assert_no_drift "phase 2"

# --- Phase 2b: a MALFORMED EventBridgeEnabled on the template path (#1759, #3740)
# The same bucket's EventBridgeEnabled becomes the string 'yes' on top of the
# phase-2 template. Since issue #3740 a template-path update REFUSES it before
# any write (the rollback revert arms and `drift --revert` keep the #1759
# warn-and-skip; unit-covered in s3-bucket-provider-applier-template-refusal).
# The deploy must fail NAMING the value, and AWS must still hold no block —
# the #1759 property (a value cdkd cannot read never ENABLES delivery), now
# reached through the refusal.
echo "==> Phase 2b: re-deploy with a MALFORMED EventBridgeEnabled — must be REFUSED before any write"
set +e
PHASE2B_OUT="$(CDKD_TEST_UPDATE=true CDKD_TEST_EB_MALFORMED=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
PHASE2B_RC=$?
set -e
printf '%s\n' "${PHASE2B_OUT}"
PHASE2B_PLAIN="$(printf '%s' "${PHASE2B_OUT}" | sed 's/\x1b\[[0-9;]*m//g')"
if [ "${PHASE2B_RC}" -eq 0 ]; then
  echo "FAIL [phase 2b]: the malformed EventBridgeEnabled deployed (exit 0); issue #3740 refuses it on the template path" >&2
  exit 1
fi
# Two independent markers on the refusal: the guard's own sentence and the
# pre-flight's suffix. A wording drift in either fails loudly here.
if ! printf '%s' "${PHASE2B_PLAIN}" | grep -q 'EventBridgeEnabled must be a boolean' ||
   ! printf '%s' "${PHASE2B_PLAIN}" | grep -q 'fix the template value'; then
  echo "FAIL [phase 2b]: the deploy failed, but not with the #3740 template-path refusal" >&2
  exit 1
fi
echo "    [phase 2b] the malformed EventBridgeEnabled was REFUSED (exit ${PHASE2B_RC})"
assert_eventbridge_absent "phase 2b"
# The rest of the stack did not move either: the lifecycle rules phase 2 applied
# on the main bucket are intact.
RULE_COUNT_P2B="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(Rules)' --output text)"
if [ "${RULE_COUNT_P2B}" != "4" ]; then
  echo "FAIL [phase 2b]: the refused deploy changed the lifecycle rules (count ${RULE_COUNT_P2B}, expected 4)" >&2
  exit 1
fi
assert_no_drift "phase 2b"

# --- Phase 2c: the #1759 warn-and-SKIP on the REPLAY path (issue #3740) -------
# The same malformed value reaches the notification applier only through a
# replay now. Fail an ordinary update of the bucket (a tag, then a queue AWS
# refuses, `--no-rollback`), doctor the journal's previous record to carry
# `EventBridgeEnabled: 'yes'` (a record an older binary could have written),
# and `cdkd rollback`: the revert arm must WARN and SKIP the whole
# notification configuration, and AWS must still hold no EventBridge block.
echo "==> Phase 2c: a REVERT replaying a MALFORMED EventBridgeEnabled must warn and skip, never enable"
# Issue #2422: the failing deploy also CREATES `DepArmRollbackBucket` before
# the queue fails, so the rollback below deletes it (see after the journal
# doctoring).
DEP_ARM_RB_BUCKET="cdkd-lifecycle-deprb-${ACCOUNT_ID}-${CC_ARM_STAMP}"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_EB_REVERT=true CDKD_DEP_ARM_ROLLBACK_BUCKET="${DEP_ARM_RB_BUCKET}" \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback
PHASE2C_RC=$?
set -e
if [ "${PHASE2C_RC}" -eq 0 ]; then
  echo "FAIL [phase 2c]: the inject-fail deploy SUCCEEDED, so there is no journal to roll back" >&2
  exit 1
fi
JOURNAL_FILE="$(mktemp)"
DOCTORED_FILE="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" "${JOURNAL_FILE}" >/dev/null
jq '(.segments[].operations[] | select(.logicalId == "EbMalformedBucket" and .changeType == "UPDATE")
  | .previousState.properties.NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled) = "yes"' \
  "${JOURNAL_FILE}" > "${DOCTORED_FILE}"
DOCTORED_COUNT="$(jq '[.segments[].operations[] | select(.logicalId == "EbMalformedBucket" and .changeType == "UPDATE")
  | .previousState.properties.NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled
  | select(. == "yes")] | length' "${DOCTORED_FILE}")"
if [ "${DOCTORED_COUNT}" != "1" ]; then
  echo "FAIL [phase 2c]: expected exactly one EbMalformedBucket UPDATE op to doctor, got ${DOCTORED_COUNT}" >&2
  jq -c '[.segments[].operations[] | {logicalId, changeType}]' "${JOURNAL_FILE}" >&2
  exit 1
fi
aws s3 cp "${DOCTORED_FILE}" "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null
rm -f "${JOURNAL_FILE}" "${DOCTORED_FILE}"

# Issue #2422, the ROLLBACK half of phase 1c: the rollback of the failed
# deploy's CREATE of `DepArmRollbackBucket` must persist a guard its delete
# could not enforce. A plain deploy creates an `AWS::S3::Bucket` through the
# SDK provider, whose delete reports no guard, so the record and the journal
# op are re-pointed at Cloud Control (the route the rollback delete takes,
# `effectiveProvisionedBy`: the record first, the op as fallback) -- a
# Cloud Control delete of an SDK-created bucket deletes the same bucket. Then
# the bucket's policy denies the guard's probe, exactly as in phase 1c.
if ! aws s3api head-bucket --bucket "${DEP_ARM_RB_BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL [phase 2c] premise: the failing deploy did not create ${DEP_ARM_RB_BUCKET}, so the rollback has no CREATE to revert" >&2
  exit 1
fi
DEP_ARM_ID_WORKDIR="$(mktemp -d)"
aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" "${DEP_ARM_ID_WORKDIR}/journal.json" >/dev/null
jq '(.segments[].operations[] | select(.logicalId == "DepArmRollbackBucket" and .changeType == "CREATE")
  | .provisionedBy) = "cc-api"' "${DEP_ARM_ID_WORKDIR}/journal.json" > "${DEP_ARM_ID_WORKDIR}/journal-cc.json"
DEP_RB_OPS="$(jq --arg b "${DEP_ARM_RB_BUCKET}" '[.segments[].operations[] | select(.logicalId == "DepArmRollbackBucket" and .changeType == "CREATE" and .physicalId == $b)] | length' "${DEP_ARM_ID_WORKDIR}/journal-cc.json")"
if [ "${DEP_RB_OPS}" != "1" ]; then
  echo "FAIL [phase 2c] premise: expected exactly one journaled CREATE of DepArmRollbackBucket naming ${DEP_ARM_RB_BUCKET}, got ${DEP_RB_OPS}" >&2
  jq -c '[.segments[].operations[] | {logicalId, changeType, physicalId}]' "${DEP_ARM_ID_WORKDIR}/journal.json" >&2
  exit 1
fi
aws s3 cp "${DEP_ARM_ID_WORKDIR}/journal-cc.json" "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${DEP_ARM_ID_WORKDIR}/state.json" >/dev/null
DEP_RB_RECORD="$(jq -r '.resources.DepArmRollbackBucket.physicalId // "MISSING"' "${DEP_ARM_ID_WORKDIR}/state.json")"
if [ "${DEP_RB_RECORD}" != "${DEP_ARM_RB_BUCKET}" ]; then
  echo "FAIL [phase 2c] premise: state records DepArmRollbackBucket as ${DEP_RB_RECORD}, expected ${DEP_ARM_RB_BUCKET}" >&2
  exit 1
fi
jq '.resources.DepArmRollbackBucket.provisionedBy = "cc-api"' "${DEP_ARM_ID_WORKDIR}/state.json" \
  > "${DEP_ARM_ID_WORKDIR}/state-cc.json"
aws s3 cp "${DEP_ARM_ID_WORKDIR}/state-cc.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
deny_get_bucket_location "${DEP_ARM_RB_BUCKET}"
DEP_RB_EVENTS_PREFIX="cdkd/${STACK}/${REGION}/deployments/"
DEP_RB_KEYS_BEFORE="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${DEP_RB_EVENTS_PREFIX}" --query 'Contents[].Key' --output text)"

set +e
PHASE2C_OUT="$(node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)"
PHASE2C_ROLLBACK_RC=$?
set -e
printf '%s\n' "${PHASE2C_OUT}"
if [ "${PHASE2C_ROLLBACK_RC}" -ne 0 ]; then
  echo "FAIL [phase 2c]: cdkd rollback exited ${PHASE2C_ROLLBACK_RC}" >&2
  exit 1
fi
PHASE2C_PLAIN="$(printf '%s' "${PHASE2C_OUT}" | sed 's/\x1b\[[0-9;]*m//g')"
# Two independent markers: the guard's sentence and the skip decision.
if ! printf '%s' "${PHASE2C_PLAIN}" | grep -q 'EventBridgeEnabled must be a boolean' ||
   ! printf '%s' "${PHASE2C_PLAIN}" | grep -q 'Leaving the whole notification configuration unapplied'; then
  echo "FAIL [phase 2c]: the revert did not warn-and-skip the malformed EventBridgeEnabled (#1759)" >&2
  exit 1
fi
echo "    [phase 2c] the revert WARNED and skipped the malformed EventBridgeEnabled (#1759)"
assert_eventbridge_absent "phase 2c"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after the phase 2c rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"

# Issue #2422: the rollback deleted the bucket it created, under a denied
# probe, and its run record carries the guard row -- the SAME event type the
# deploy and destroy record, `operation: DELETE`, beside the rollback's own
# `ROLLBACK_RESOURCE_SUCCEEDED` for the reverted CREATE.
assert_gone_eventually "[phase 2c] ${DEP_ARM_RB_BUCKET} survived the rollback of its CREATE" \
  aws s3api head-bucket --bucket "${DEP_ARM_RB_BUCKET}" --region "${REGION}"
DEP_RB_KEYS_AFTER="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${DEP_RB_EVENTS_PREFIX}" --query 'Contents[].Key' --output text)"
DEP_RB_JSONL_KEY=""
DEP_RB_JSONL_COUNT=0
for dep_rb_key in ${DEP_RB_KEYS_AFTER}; do
  case "${dep_rb_key}" in
    *.jsonl)
      case " ${DEP_RB_KEYS_BEFORE} " in
        *" ${dep_rb_key} "*) : ;;
        *)
          DEP_RB_JSONL_KEY="${dep_rb_key}"
          DEP_RB_JSONL_COUNT=$((DEP_RB_JSONL_COUNT + 1))
          ;;
      esac
      ;;
  esac
done
if [ "${DEP_RB_JSONL_COUNT}" -ne 1 ]; then
  echo "FAIL [phase 2c]: expected exactly 1 new {runId}.jsonl from 'cdkd rollback', got ${DEP_RB_JSONL_COUNT} (before: ${DEP_RB_KEYS_BEFORE}; after: ${DEP_RB_KEYS_AFTER})" >&2
  exit 1
fi
DEP_RB_EVENTS="$(aws s3 cp "s3://${STATE_BUCKET}/${DEP_RB_JSONL_KEY}" - )"
dep_rb_jq() { # usage: dep_rb_jq <filter>  -> raw value over the slurped NDJSON
  printf '%s\n' "${DEP_RB_EVENTS}" | jq -r -s "$1" || {
    echo "FAIL [phase 2c]: jq could not parse s3://${STATE_BUCKET}/${DEP_RB_JSONL_KEY} as NDJSON" >&2
    exit 1
  }
}
DEP_RB_COMMAND="$(dep_rb_jq '[.[] | select(.eventType == "RUN_STARTED")] | if length == 1 then .[0].command // "MISSING" else "RUN_STARTED x\(length)" end')" || exit 1
DEP_RB_GUARD="$(dep_rb_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | map("\(.logicalId)|\(.operation)|\(.guard)|\(.physicalId)|\(.provisionedBy)|\(.resourceType)") | join(",")')" || exit 1
DEP_RB_GUARD_WANT="DepArmRollbackBucket|DELETE|cc-delete-region-identity|${DEP_ARM_RB_BUCKET}|cc-api|AWS::S3::Bucket"
DEP_RB_REASON="$(dep_rb_jq '[.[] | select(.eventType == "RESOURCE_GUARD_INDETERMINATE")] | .[0].reason // "MISSING"')" || exit 1
DEP_RB_REVERTED="$(dep_rb_jq '[.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == "DepArmRollbackBucket")] | map("\(.operation)|\(.provisionedBy)") | join(",")')" || exit 1
if [ "${DEP_RB_COMMAND}" != "rollback" ] || [ "${DEP_RB_GUARD}" != "${DEP_RB_GUARD_WANT}" ] \
  || [ "${DEP_RB_REVERTED}" != "CREATE|cc-api" ]; then
  echo "FAIL [phase 2c]: rollback run record is wrong: RUN_STARTED.command=${DEP_RB_COMMAND} (expected rollback), guard rows=[${DEP_RB_GUARD}] (expected [${DEP_RB_GUARD_WANT}]), ROLLBACK_RESOURCE_SUCCEEDED=[${DEP_RB_REVERTED}] (expected [CREATE|cc-api])" >&2
  printf '%s\n' "${DEP_RB_EVENTS}" >&2
  exit 1
fi
case "${DEP_RB_REASON}" in
  *"s3:GetBucketLocation on ${DEP_ARM_RB_BUCKET} could not be answered"*"AccessDenied"*) : ;;
  *)
    echo "FAIL [phase 2c]: the guard row's reason does not name the denied probe and its error class: ${DEP_RB_REASON}" >&2
    exit 1
    ;;
esac
case "${DEP_RB_REASON}" in
  *"assumed-role"*|*"arn:aws:sts::"*|*"is not authorized to perform"*)
    echo "FAIL [phase 2c]: the PERSISTED reason carries caller identity: ${DEP_RB_REASON}" >&2
    exit 1
    ;;
esac
rm -rf "${DEP_ARM_ID_WORKDIR}"
echo "    [phase 2c] the rollback's delete of ${DEP_ARM_RB_BUCKET} persisted one RESOURCE_GUARD_INDETERMINATE (operation DELETE) in ${DEP_RB_JSONL_KEY}"

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
