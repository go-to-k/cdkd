#!/usr/bin/env bash
# verify.sh — cdkd S3 sub-config REMOVAL semantics integ (issue #1466).
#
# An `AWS::S3::Bucket` declaring four sub-configs that all used to sit on the
# provider's unconditional "always-PUT" path. Removing one from the template
# was a silent no-op: the guarded `if (properties['X'])` branch never ran, the
# old value survived on the real bucket, `cdkd deploy` printed `updated` and
# `cdkd drift` printed `no drift` -- no command surfaced the difference.
#
# The expected post-removal state is NOT uniform. Each verdict below was pinned
# by a live CloudFormation A/B on this same template pair (see the issue):
#   VersioningConfiguration        -> CFn SUSPENDS
#   OwnershipControls              -> CFn DELETES
#   BucketEncryption               -> CFn RESETS to the SSE-S3 (AES256) default
#   PublicAccessBlockConfiguration -> CFn KEEPS it (cdkd already at parity)
#
# The PublicAccessBlock row is the guard against over-fixing: it looks identical
# to the other three in the provider source, so asserting that it SURVIVES is
# what stops a later "consistency" refactor turning correct behavior into a
# divergence.
#
# Phases:
#   1. Deploy baseline; assert all four sub-configs reached AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (all four REMOVED from the
#      template). Assert versioning Suspended, ownership controls gone,
#      encryption reset to AES256, PAB unchanged, and the bucket NOT replaced.
#      Every one of the first three assertions FAILS against the pre-fix binary.
#   3. Destroy; assert the bucket is gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# A pager invoked non-interactively is a route to a hang.
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

# S3 propagates a DeleteBucket to HeadBucket asynchronously: a probe issued
# immediately after a successful delete can still answer 200 for a few seconds.
# Retry on a bounded schedule instead of asserting once. This does NOT weaken
# leak detection -- a bucket that never disappears still FAILs, and gone_probe
# still hard-fails on any non-not-found probe error.
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

STACK="CdkdS3SubconfigRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-subconfig-removal-${ACCOUNT_ID}"

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

# --- Phase 1: deploy baseline (all four sub-configs present) ---------------
echo "==> Phase 1: deploy bucket with versioning + ownership + encryption + PAB"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BUCKET_ID_P1="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json | jq -r '.state.resources.SubconfigBucket.physicalId')"
if [ "${BUCKET_ID_P1}" != "${BUCKET_NAME}" ]; then
  echo "FAIL: expected physicalId ${BUCKET_NAME}, got ${BUCKET_ID_P1}" >&2
  exit 1
fi

VERSIONING_P1="$(aws s3api get-bucket-versioning --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'Status' --output text)"
OWNERSHIP_P1="$(aws s3api get-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)"
SSE_ALGO_P1="$(aws s3api get-bucket-encryption --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
  --output text)"
PAB_P1="$(aws s3api get-public-access-block --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'PublicAccessBlockConfiguration.BlockPublicAcls' --output text)"

if [ "${VERSIONING_P1}" != "Enabled" ]; then
  echo "FAIL: expected versioning Enabled after Phase 1, got ${VERSIONING_P1}" >&2
  exit 1
fi
if [ "${OWNERSHIP_P1}" != "BucketOwnerPreferred" ]; then
  echo "FAIL: expected ObjectOwnership BucketOwnerPreferred, got ${OWNERSHIP_P1}" >&2
  exit 1
fi
if [ "${SSE_ALGO_P1}" != "aws:kms" ]; then
  echo "FAIL: expected SSEAlgorithm aws:kms after Phase 1, got ${SSE_ALGO_P1}" >&2
  exit 1
fi
if [ "${PAB_P1}" != "True" ]; then
  echo "FAIL: expected BlockPublicAcls True after Phase 1, got ${PAB_P1}" >&2
  exit 1
fi
echo "    baseline applied: versioning=Enabled ownership=BucketOwnerPreferred sse=aws:kms pab=True"

# --- Phase 1b: drift must SURFACE a console-side ownership change ----------
# This is the assertion that actually exercises the GetBucketOwnershipControls
# read added by issue #1466. It has to run HERE, while state still declares
# OwnershipControls: the drift comparator only descends into keys present in
# state, so the same check after the Phase 2 removal would pass even with no
# read wired at all (i.e. it would be vacuous). Pre-#1466 the provider had no
# Get for this property, so drift could not see the change and exited 0.
echo "==> Phase 1b: out-of-band ownership change must be detected as drift"
aws s3api put-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

DRIFT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" || DRIFT_RC=$?
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: expected drift exit 1 after an out-of-band OwnershipControls change, got ${DRIFT_RC}" >&2
  exit 1
fi
echo "    drift detected the console-side ownership change (exit 1)"

# Restore so Phase 2 starts from the declared baseline again.
aws s3api put-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerPreferred}]'
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
echo "    restored; drift clean again"

# --- Phase 2: remove every sub-config from the template --------------------
# This is the phase the fix exists for. Against the pre-fix binary the first
# three assertions FAIL (old values survive) while cdkd still reports success.
echo "==> Phase 2: redeploy with all four sub-configs REMOVED from the template"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BUCKET_ID_P2="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json | jq -r '.state.resources.SubconfigBucket.physicalId')"
if [ "${BUCKET_ID_P2}" != "${BUCKET_ID_P1}" ]; then
  echo "FAIL: bucket was REPLACED across the removal update (${BUCKET_ID_P1} -> ${BUCKET_ID_P2})" >&2
  exit 1
fi
echo "    bucket not replaced (in-place update)"

# Versioning: CFn suspends. Pre-fix this stayed 'Enabled'.
VERSIONING_P2="$(aws s3api get-bucket-versioning --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'Status' --output text)"
if [ "${VERSIONING_P2}" != "Suspended" ]; then
  echo "FAIL: removing VersioningConfiguration must suspend versioning (CFn parity), got ${VERSIONING_P2}" >&2
  exit 1
fi
echo "    VersioningConfiguration removed -> Suspended"

# OwnershipControls: CFn deletes the block outright. Pre-fix it survived.
assert_gone "removing OwnershipControls must delete the block (CFn parity), but it is still present" \
  aws s3api get-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    OwnershipControls removed -> deleted"

# BucketEncryption: CFn resets to the SSE-S3 default. Pre-fix it stayed
# aws:kms, which also means the user keeps paying KMS request charges.
SSE_ALGO_P2="$(aws s3api get-bucket-encryption --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
  --output text)"
if [ "${SSE_ALGO_P2}" != "AES256" ]; then
  echo "FAIL: removing BucketEncryption must reset to the AES256 default (CFn parity), got ${SSE_ALGO_P2}" >&2
  exit 1
fi
echo "    BucketEncryption removed -> reset to AES256"

# PublicAccessBlock: VERIFIED PARITY -- CloudFormation keeps it too, so cdkd
# must NOT delete it. This assertion exists to stop an over-eager "make them
# all consistent" refactor from introducing a divergence.
PAB_P2="$(aws s3api get-public-access-block --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'PublicAccessBlockConfiguration.BlockPublicAcls' --output text)"
if [ "${PAB_P2}" != "True" ]; then
  echo "FAIL: removing PublicAccessBlockConfiguration must NOT clear it (CFn parity), got ${PAB_P2}" >&2
  exit 1
fi
echo "    PublicAccessBlockConfiguration removed -> retained (CFn parity, not a bug)"

# The read side must now see ownership controls, otherwise drift stays blind to
# exactly the property this issue fixed. A clean drift here proves state and
# AWS agree AFTER the removal round-trip.
echo "==> Phase 2b: drift must be clean after the removal update"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
echo "    drift clean"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone_eventually "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    bucket deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    state file removed"

trap - EXIT INT TERM
echo "PASS: s3-subconfig-removal"
