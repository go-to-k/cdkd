#!/usr/bin/env bash
# verify.sh — a removed resource whose delete AWS refuses keeps the deploy (issue #6969).
#
# CloudFormation deletes a removed resource in its cleanup phase: a refused
# delete is DELETE_FAILED and the stack ends UPDATE_COMPLETE with the update
# applied. cdkd used to fail the deploy and roll the update back. It now keeps
# the record (exit 2), keeps what the failed resource depends on, and the next
# deploy retries the delete.
#
# Phases:
#   1. Deploy: Main queue (VisibilityTimeout 30), Data bucket DependsOn Anchor
#      queue. Put one object in the bucket.
#   2. Re-deploy CDKD_TEST_UPDATE=true (Main at 60; Data + Anchor removed):
#      assert rc 2, Main at 60, the bucket and Anchor still live, and both
#      records kept in state (a pre-fix run exits 1 with Main back at 30).
#   3. Empty the bucket and re-deploy the same template: assert rc 0, the
#      bucket and Anchor gone, and their records dropped.
#   4. Destroy: assert Main and the state file are gone.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdRemovalDeleteKeptExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
SCRATCH="$(mktemp -d)"
BUCKET=""
QUEUE_PREFIX="${STACK}-"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${BUCKET}" ]; then
    aws s3 rm "s3://${BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1
    aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  case "${QUEUE_PREFIX}" in
    CdkdRemovalDeleteKeptExample-?*)
      for url in $(aws sqs list-queues --queue-name-prefix "${QUEUE_PREFIX}" --region "${REGION}" \
        --query 'QueueUrls[]' --output text 2>/dev/null); do
        [ "${url}" = "None" ] && continue
        aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
      done
      ;;
    *) echo "WARN: teardown sweep refused: unexpected queue prefix '${QUEUE_PREFIX}'" >&2 ;;
  esac
  rm -rf "${SCRATCH}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="cdkd-removal-kept-${ACCOUNT}-${REGION}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup
SCRATCH="$(mktemp -d)"

fetch_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${SCRATCH}/state.json" --quiet
}
# The logical id of the record whose id starts with $1 (CDK appends a hash).
logical_id() {
  node -e 'const s=require(process.argv[1]); const k=Object.keys(s.resources).filter((id)=>id.startsWith(process.argv[2])); if(k.length!==1){process.exit(1)} console.log(k[0])' \
    "${SCRATCH}/state.json" "$1"
}
physical_id() {
  node -e 'const s=require(process.argv[1]); console.log(s.resources[process.argv[2]].physicalId)' \
    "${SCRATCH}/state.json" "$1"
}
has_record() {
  node -e 'const s=require(process.argv[1]); process.exit(s.resources && s.resources[process.argv[2]] ? 0 : 1)' \
    "${SCRATCH}/state.json" "$1"
}
visibility() {
  aws sqs get-queue-attributes --queue-url "$1" --attribute-names VisibilityTimeout \
    --region "${REGION}" --query 'Attributes.VisibilityTimeout' --output text
}

# --- Phase 1 -----------------------------------------------------------------
echo "==> Phase 1: deploy Main + Data (DependsOn Anchor)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

fetch_state
MAIN_ID="$(logical_id Main)"
ANCHOR_ID="$(logical_id Anchor)"
DATA_ID="$(logical_id Data)"
MAIN_URL="$(physical_id "${MAIN_ID}")"
ANCHOR_URL="$(physical_id "${ANCHOR_ID}")"
if ! node -e 'const s=require(process.argv[1]); process.exit((s.resources[process.argv[2]].dependencies||[]).includes(process.argv[3]) ? 0 : 1)' \
  "${SCRATCH}/state.json" "${DATA_ID}" "${ANCHOR_ID}"; then
  echo "FAIL: Phase 1 state does not record ${DATA_ID} depending on ${ANCHOR_ID} (the precondition under test)" >&2; exit 1
fi
if [ "$(visibility "${MAIN_URL}")" != "30" ]; then
  echo "FAIL: Phase 1 expected Main VisibilityTimeout 30" >&2; exit 1
fi
echo "keep" > "${SCRATCH}/o.txt"
aws s3 cp "${SCRATCH}/o.txt" "s3://${BUCKET}/keep.txt" --region "${REGION}" --quiet
echo "    Main at 30, ${DATA_ID} depends on ${ANCHOR_ID}, one object in the bucket"

# --- Phase 2 -----------------------------------------------------------------
echo "==> Phase 2: remove Data + Anchor and update Main (the bucket's delete is refused)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${SCRATCH}/phase2.log"
RC=${PIPESTATUS[0]}
set -e
if [ "${RC}" -ne 2 ]; then
  echo "FAIL: Phase 2 deploy exited ${RC}, expected 2 (issue #6969: a refused removal delete rolled the deploy back)" >&2; exit 1
fi
sed 's/\x1b\[[0-9;]*m//g' "${SCRATCH}/phase2.log" > "${SCRATCH}/phase2.plain"
# Sentinel: the bucket's own failure line is printed whatever the outcome, so
# its presence without the marker means the marker's wording drifted.
if ! grep -qF "${DATA_ID} (AWS::S3::Bucket) was removed from the template, but its delete failed" "${SCRATCH}/phase2.plain"; then
  if grep -qF "Failed to delete ${DATA_ID}:" "${SCRATCH}/phase2.plain"; then
    echo "FAIL: Phase 2 printed the bucket's failure but not the kept-record line this fixture parses — update the marker" >&2; exit 1
  fi
  echo "FAIL: Phase 2 exited 2 without reaching the bucket's delete" >&2; exit 1
fi
# One line must carry both: the Anchor id also appears in the plan listing.
ANCHOR_LINES="$(grep -F "${ANCHOR_ID}" "${SCRATCH}/phase2.plain" || true)"
if ! grep -qF "${DATA_ID} depends on it and its delete failed" <<<"${ANCHOR_LINES}"; then
  if grep -qF "not deleted (" <<<"${ANCHOR_LINES}"; then
    echo "FAIL: Phase 2 kept ${ANCHOR_ID} in a wording this fixture does not parse — update the marker" >&2; exit 1
  fi
  echo "FAIL: Phase 2 did not report ${ANCHOR_ID} kept because ${DATA_ID}'s delete failed" >&2; exit 1
fi
if [ "$(visibility "${MAIN_URL}")" != "60" ]; then
  echo "FAIL: Phase 2 expected Main VisibilityTimeout 60 (the update was rolled back)" >&2; exit 1
fi
aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
visibility "${ANCHOR_URL}" >/dev/null
fetch_state
has_record "${DATA_ID}" || { echo "FAIL: Phase 2 dropped the ${DATA_ID} record" >&2; exit 1; }
has_record "${ANCHOR_ID}" || { echo "FAIL: Phase 2 dropped the ${ANCHOR_ID} record" >&2; exit 1; }
echo "    rc 2, Main at 60, bucket and Anchor live and still recorded"

# --- Phase 3 -----------------------------------------------------------------
echo "==> Phase 3: empty the bucket and re-deploy: the retried deletes succeed"
aws s3 rm "s3://${BUCKET}" --recursive --region "${REGION}" --quiet
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "bucket ${BUCKET} still exists after the retried delete" aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "Anchor queue still exists after the retried delete" aws sqs get-queue-attributes --queue-url "${ANCHOR_URL}" --region "${REGION}"
fetch_state
if has_record "${DATA_ID}" || has_record "${ANCHOR_ID}"; then
  echo "FAIL: Phase 3 still records ${DATA_ID} or ${ANCHOR_ID}" >&2; exit 1
fi
has_record "${MAIN_ID}" || { echo "FAIL: Phase 3 lost the ${MAIN_ID} record (the state read is not seeing resources)" >&2; exit 1; }
echo "    bucket and Anchor deleted, records dropped"

# --- Phase 4 -----------------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "Main queue still exists after destroy" aws sqs get-queue-attributes --queue-url "${MAIN_URL}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    Main deleted, cdkd state removed"

echo "[verify] PASS — a removed resource whose delete fails keeps the deploy, all 4 phases passed"
