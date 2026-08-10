#!/usr/bin/env bash
# verify.sh - cdkd s3-directory-bucket integ (issue #1344 destroy data guard
#             + issue #609 Tags as a handled property).
#
# Deploys TWO S3 Express Directory Buckets — one untagged (guard target) and
# one carrying template Tags including the `aws-cdk:auto-delete-objects`
# opt-in — then exercises:
#
#   Phase 1:  deploy; assert the create-time tags landed (S3 Control
#             list-tags-for-resource).
#   Phase 1c: UPDATE-mode redeploy; assert the tag mutation landed
#             (TagResource value change + UntagResource removal).
#   Phase 2:  put an object into BOTH buckets out of band.
#   Phase 3:  destroy — must FAIL on the untagged bucket (CloudFormation
#             parity: CFn DELETE_FAILs a non-empty directory bucket) with the
#             "is not empty" guard error; the guarded object must be intact
#             and the state file must survive. The TAGGED bucket must be GONE
#             in the same run (data-carrying auto-empty via the tag opt-in).
#   Phase 4:  delete the guarded object via plain AWS CLI, destroy again —
#             must SUCCEED; buckets + state file gone.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

cd "$(dirname "$0")"

STACK="CdkdS3DirectoryBucketExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after deploy from the stack outputs; kept global for cleanup.
BUCKET=""
AUTO_BUCKET=""
ACCOUNT_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -n "${BUCKET}" ]; then
    aws s3api delete-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${AUTO_BUCKET}" ]; then
    aws s3api delete-object --bucket "${AUTO_BUCKET}" --key "auto/emptied-by-cdkd.txt" --region "${REGION}" >/dev/null 2>&1
  fi
  destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${BUCKET}" ]; then
    aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${AUTO_BUCKET}" ]; then
    aws s3api delete-bucket --bucket "${AUTO_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# read_tag <bucket-name> <tag-key> -> prints the tag value ('' when absent)
read_tag() {
  local bucket="$1" key="$2" tags_json
  tags_json="$(aws s3control list-tags-for-resource \
    --account-id "${ACCOUNT_ID}" \
    --resource-arn "arn:aws:s3express:${REGION}:${ACCOUNT_ID}:bucket/${bucket}" \
    --region "${REGION}" --output json)" || return 1
  printf '%s' "${tags_json}" | jq -r --arg k "${key}" '.Tags[] | select(.Key == $k) | .Value'
}

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_JSON=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
BUCKET=$(printf '%s' "${STATE_JSON}" | jq -r '.state.outputs.BucketName // empty')
AUTO_BUCKET=$(printf '%s' "${STATE_JSON}" | jq -r '.state.outputs.AutoBucketName // empty')
if [ -z "${BUCKET}" ] || [ -z "${AUTO_BUCKET}" ]; then
  echo "FAIL: could not read BucketName/AutoBucketName outputs from cdkd state" >&2
  exit 1
fi
echo "    Guard bucket:  ${BUCKET}"
echo "    Tagged bucket: ${AUTO_BUCKET}"

echo "==> Phase 1: asserting create-time tags landed (issue #609)"
V=$(read_tag "${AUTO_BUCKET}" "aws-cdk:auto-delete-objects")
if [ "${V}" != "true" ]; then
  echo "FAIL: aws-cdk:auto-delete-objects tag expected 'true', got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "cdkd-integ")
if [ "${V}" != "initial" ]; then
  echo "FAIL: cdkd-integ tag expected 'initial', got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "transient")
if [ "${V}" != "drop-me" ]; then
  echo "FAIL: transient tag expected 'drop-me', got '${V}'" >&2
  exit 1
fi
echo "    OK: create-time tags present on the directory bucket"

# --- Phase 1c: UPDATE-mode redeploy mutates the tag set ---------------------
echo "==> Phase 1c: UPDATE-mode redeploy (tag value change + tag removal)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

V=$(read_tag "${AUTO_BUCKET}" "cdkd-integ")
if [ "${V}" != "updated" ]; then
  echo "FAIL: cdkd-integ tag expected 'updated' after UPDATE deploy, got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "transient")
if [ -n "${V}" ]; then
  echo "FAIL: transient tag should have been removed by UntagResource, got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "aws-cdk:auto-delete-objects")
if [ "${V}" != "true" ]; then
  echo "FAIL: aws-cdk:auto-delete-objects tag lost across the UPDATE deploy (got '${V}')" >&2
  exit 1
fi
echo "    OK: tag update landed (value changed, removed key untagged, opt-in kept)"

# --- Phase 2: load data out of band ----------------------------------------
echo "==> Phase 2: putting an object into BOTH directory buckets"
echo "guard-data" > /tmp/cdkd-ddbg-obj.txt
aws s3api put-object --bucket "${BUCKET}" --key "guard/keep-me.txt" \
  --body /tmp/cdkd-ddbg-obj.txt --region "${REGION}" >/dev/null
aws s3api put-object --bucket "${AUTO_BUCKET}" --key "auto/emptied-by-cdkd.txt" \
  --body /tmp/cdkd-ddbg-obj.txt --region "${REGION}" >/dev/null
rm -f /tmp/cdkd-ddbg-obj.txt

# --- Phase 3: destroy must FAIL on the guard bucket, empty+delete the tagged one
echo "==> Phase 3: destroy (guard bucket must FAIL; tagged bucket must auto-empty)"
set +e
DESTROY1_LOG=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
DESTROY1_RC=$?
set -e
printf '%s\n' "${DESTROY1_LOG}"

if [ "${DESTROY1_RC}" -eq 0 ]; then
  echo "FAIL: destroy SUCCEEDED — the directory-bucket data guard did not fire" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY1_LOG}" | grep -q "is not empty"; then
  echo "FAIL: destroy output lacks the 'is not empty' guard error" >&2
  exit 1
fi
echo "    OK: destroy failed with the guard error (CFn DELETE_FAILED parity)"

# Guarded data must be intact and the state file must survive.
aws s3api head-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    OK: guarded object intact + state file survives the failed destroy"

# The tagged sibling must be GONE in the same run: the opt-in auto-empty
# deleted its data-carrying bucket (issue #609 live-exercise).
assert_gone "tagged directory bucket '${AUTO_BUCKET}' survived the destroy despite the auto-delete opt-in" \
  aws s3api head-bucket --bucket "${AUTO_BUCKET}" --region "${REGION}"
echo "    OK: tagged bucket auto-emptied and deleted in the same destroy"

# --- Phase 4: manual empty, then destroy must SUCCEED -----------------------
echo "==> Phase 4: delete the guarded object manually, destroy again"
aws s3api delete-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null

node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "directory bucket '${BUCKET}' still exists after second destroy" \
  aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: second destroy clean — buckets + state gone"

echo ""
echo "==> s3-directory-bucket test passed (tags landed + updated, guard fired with data intact, tagged bucket auto-emptied, clean second destroy)"
