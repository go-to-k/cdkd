#!/usr/bin/env bash
# verify.sh - cdkd s3-directory-bucket integ (issue #1344 destroy data guard).
#
# Deploys an S3 Express Directory Bucket, then exercises the destroy data
# guard end-to-end:
#
#   Phase 1: deploy.
#   Phase 2: put an object out of band.
#   Phase 3: destroy — must FAIL (CloudFormation parity: CFn DELETE_FAILs a
#            non-empty directory bucket) with the "is not empty" guard error;
#            the object must be intact and the state file must survive.
#   Phase 4: delete the object via plain AWS CLI, destroy again — must
#            SUCCEED; bucket + state file gone.
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

STACK="CdkdS3DirectoryBucketExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after deploy from the stack outputs; kept global for cleanup.
BUCKET=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -n "${BUCKET}" ]; then
    aws s3api delete-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null 2>&1
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

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

BUCKET=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | jq -r '.state.outputs.BucketName // empty')
if [ -z "${BUCKET}" ]; then
  echo "FAIL: could not read BucketName output from cdkd state" >&2
  exit 1
fi
echo "    Directory bucket: ${BUCKET}"

# --- Phase 2: load data out of band ----------------------------------------
echo "==> Phase 2: putting an object into the directory bucket"
echo "guard-data" > /tmp/cdkd-ddbg-obj.txt
aws s3api put-object --bucket "${BUCKET}" --key "guard/keep-me.txt" \
  --body /tmp/cdkd-ddbg-obj.txt --region "${REGION}" >/dev/null
rm -f /tmp/cdkd-ddbg-obj.txt

# --- Phase 3: destroy must FAIL (CFn parity) --------------------------------
echo "==> Phase 3: destroy (expecting FAILURE on the non-empty directory bucket)"
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
echo "    OK: object intact + state file survives the failed destroy"

# --- Phase 4: manual empty, then destroy must SUCCEED -----------------------
echo "==> Phase 4: delete the object manually, destroy again"
aws s3api delete-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null

node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "directory bucket '${BUCKET}' still exists after second destroy" \
  aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: second destroy clean — bucket + state gone"

echo ""
echo "==> s3-directory-bucket test passed (guard fired with data intact, clean second destroy)"
