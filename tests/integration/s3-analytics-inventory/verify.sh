#!/usr/bin/env bash
# verify.sh — cdkd S3 analytics + inventory DESTINATION integ (issue #1493 items 2/3).
#
# Both `applyAnalyticsConfigurations` and `applyInventoryConfigurations` pick
# between the CFn FLATTENED destination shape and the SDK NESTED one by probing
# member presence. Before the fix a `Destination` that was a string / array /
# unresolved intrinsic indexed every probe to `undefined`, fell through to an
# equally-`undefined` `S3BucketDestination`, and the caller's
# `s3Dest ? ... : undefined` omitted the whole block from the Put — the
# configuration deployed with NO destination and no error anywhere. The fix
# refuses that on the template-borne create path, warns on the replay-reachable
# update path, and widened the branch probe to include `Bucket`.
#
# Nothing in the integ tree exercised either configuration at all before this
# fixture, so this is the live proof that the rewritten branch selection still
# delivers a real destination to AWS.
#
# Only the FLATTENED shape is covered live — it is the only one a CDK template
# can express (see the stack's header for why the SDK nested spelling stays
# unit-covered).
#
# Phases:
#   1. Deploy; assert BOTH configurations reached AWS carrying the declared
#      destination bucket, format and prefix. Against the pre-fix binary this
#      phase still passes — a correct template was never the broken case — so
#      the value here is regression protection for the rewritten branch pick.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (changed prefix on analytics,
#      changed prefix + format on inventory). This runs the per-id diff path
#      (`diffArrayConfigById` -> the appliers with the warn callback wired) and
#      asserts the readback shows the new values — i.e. the update path still
#      delivers a destination rather than silently dropping it.
#   3. Destroy; assert both buckets and the state file are gone.
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

assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: expected $1 = '$2', got '$3'" >&2
    exit 1
  fi
  echo "  ok: $1 = $2"
}

cd "$(dirname "$0")"

STACK="CdkdS3AnalyticsInventoryExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SOURCE_BUCKET="cdkd-ai-source-${ACCOUNT_ID}"
REPORT_BUCKET="cdkd-ai-reports-${ACCOUNT_ID}"
REPORT_ARN="arn:aws:s3:::${REPORT_BUCKET}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws s3api delete-bucket --bucket "${SOURCE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${REPORT_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline ----------------------------------------------
echo "==> Phase 1: deploy source bucket with analytics + inventory configurations"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

echo "==> Phase 1: assert the ANALYTICS destination reached AWS"
ANALYTICS_P1="$(aws s3api get-bucket-analytics-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-analytics --region "${REGION}")"
assert_eq "analytics destination bucket" "${REPORT_ARN}" \
  "$(printf '%s' "${ANALYTICS_P1}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Bucket')"
assert_eq "analytics destination format" "CSV" \
  "$(printf '%s' "${ANALYTICS_P1}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Format')"
assert_eq "analytics destination prefix" "analytics-v1/" \
  "$(printf '%s' "${ANALYTICS_P1}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Prefix')"

echo "==> Phase 1: assert the INVENTORY destination reached AWS"
INVENTORY_P1="$(aws s3api get-bucket-inventory-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-inventory --region "${REGION}")"
assert_eq "inventory destination bucket" "${REPORT_ARN}" \
  "$(printf '%s' "${INVENTORY_P1}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Bucket')"
assert_eq "inventory destination format" "CSV" \
  "$(printf '%s' "${INVENTORY_P1}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Format')"
assert_eq "inventory destination prefix" "inventory-v1/" \
  "$(printf '%s' "${INVENTORY_P1}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Prefix')"

# --- Phase 2: UPDATE the destinations --------------------------------------
echo "==> Phase 2: re-deploy with changed prefixes + inventory format (UPDATE path)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

echo "==> Phase 2: assert the analytics destination was UPDATED, not dropped"
ANALYTICS_P2="$(aws s3api get-bucket-analytics-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-analytics --region "${REGION}")"
assert_eq "analytics destination bucket (after update)" "${REPORT_ARN}" \
  "$(printf '%s' "${ANALYTICS_P2}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Bucket')"
assert_eq "analytics destination prefix (after update)" "analytics-v2/" \
  "$(printf '%s' "${ANALYTICS_P2}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Prefix')"

echo "==> Phase 2: assert the inventory destination was UPDATED, not dropped"
INVENTORY_P2="$(aws s3api get-bucket-inventory-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-inventory --region "${REGION}")"
assert_eq "inventory destination bucket (after update)" "${REPORT_ARN}" \
  "$(printf '%s' "${INVENTORY_P2}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Bucket')"
assert_eq "inventory destination format (after update)" "ORC" \
  "$(printf '%s' "${INVENTORY_P2}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Format')"
assert_eq "inventory destination prefix (after update)" "inventory-v2/" \
  "$(printf '%s' "${INVENTORY_P2}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Prefix')"

echo "==> Phase 2: assert the source bucket was NOT replaced"
SOURCE_ID_P2="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json | jq -r '.state.resources.SourceBucket.physicalId')"
assert_eq "source bucket physicalId" "${SOURCE_BUCKET}" "${SOURCE_ID_P2}"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

echo "==> Phase 3: assert both buckets are gone"
assert_gone_eventually "source bucket ${SOURCE_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${SOURCE_BUCKET}" --region "${REGION}"
assert_gone_eventually "report bucket ${REPORT_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${REPORT_BUCKET}" --region "${REGION}"

echo "==> Phase 3: assert the state file is gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: s3-analytics-inventory"
