#!/usr/bin/env bash
# verify.sh — cdkd failed UPDATE of a resource deleted outside cdkd (issue #6106).
#
# An UPDATE of a resource deleted out of band fails on AWS's not-found. The
# clean automatic rollback used to keep the failed op in the journal and print
# `Revert it with: cdkd rollback <stack> --revert-failed`, which re-applies the
# previous properties through the same update, fails the same way, and asks
# for a re-run forever. The deploy now names the resource as deleted outside
# cdkd, prints `cdkd drift`'s remedy and keeps no journal.
#
# Phases:
#   1. Deploy Target (VisibilityTimeout 30) and Survivor.
#   2. Delete Target with `aws sqs delete-queue` and wait until SQS reports it gone.
#   3. CDKD_TEST_UPDATE=update (Target 30 -> 60): the deploy FAILS; its output
#      names Target as deleted outside cdkd, prints the remedy and never names
#      `--revert-failed`; no rollback-journal.json is left; Survivor is intact.
#   4. The printed remedy, step one: CDKD_TEST_UPDATE=removed (Target leaves the
#      app) deploys clean and drops Target's record.
#   5. Step two: CDKD_TEST_UPDATE=update (Target restored) deploys clean and
#      creates a new Target with VisibilityTimeout 60.
#   6. Destroy, assert both queues and the state file are gone.
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

STACK="CdkdUpdateDeletedOutsideExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

# The queue names are generated (a stack-instance suffix), so the cleanup reads
# the URLs from the state record, then sweeps by the stack-name prefix for a
# queue a crashed run created but never recorded. ListQueues is eventually
# consistent, so the sweep is best effort; the assertions never use it.
cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  local state url
  if [ -n "${STATE_BUCKET:-}" ]; then
    state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
    if [ -n "${state}" ]; then
      for url in $(printf '%s' "${state}" | jq -r '.resources[]? | select(.resourceType == "AWS::SQS::Queue") | .physicalId // empty' 2>/dev/null); do
        aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
      done
    fi
  fi
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${STACK}" in
    CdkdUpdateDeletedOutside?*)
      for url in $(aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" \
        --query 'QueueUrls[]' --output text 2>/dev/null); do
        [ "${url}" = "None" ] && continue
        aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' is outside CdkdUpdateDeletedOutside?*" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1 || true
  fi
  rm -rf "${LOG_DIR}"
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
LOG_DIR="$(mktemp -d)"

# The recorded field `<field>` of logical id `<id>` (empty when absent).
state_field() { # usage: state_field <logicalId> <jq path under the record>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${state}" | jq -r --arg l "$1" ".resources[\$l]${2} // empty"
}

queue_attr() { # usage: queue_attr <url> <attribute>
  aws sqs get-queue-attributes --queue-url "$1" --attribute-names "$2" --region "${REGION}" \
    --query "Attributes.$2" --output text
}

# --- Phase 1: deploy -----------------------------------------------------
echo "==> Phase 1: deploy Target and Survivor"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

TARGET_URL="$(state_field Target '.physicalId')"
SURVIVOR_URL="$(state_field Survivor '.physicalId')"
if [ -z "${TARGET_URL}" ] || [ -z "${SURVIVOR_URL}" ]; then
  echo "FAIL: no recorded physicalId for Target ('${TARGET_URL}') or Survivor ('${SURVIVOR_URL}')" >&2
  exit 1
fi
if [ "$(queue_attr "${TARGET_URL}" VisibilityTimeout)" != "30" ]; then
  echo "FAIL: Target's baseline VisibilityTimeout is not 30" >&2
  exit 1
fi
echo "    OK: Target ${TARGET_URL##*/} and Survivor ${SURVIVOR_URL##*/} deployed"

# --- Phase 2: delete Target outside cdkd ------------------------------------
echo "==> Phase 2: delete Target out of band"
aws sqs delete-queue --queue-url "${TARGET_URL}" --region "${REGION}"
# SQS documents up to 60s before a deleted queue stops answering; wait for the
# not-found the deploy's update and cdkd's read will both meet.
GONE=""
for i in $(seq 1 12); do
  if gone_probe aws sqs get-queue-attributes --queue-url "${TARGET_URL}" \
    --attribute-names QueueArn --region "${REGION}"; then
    GONE=yes
    break
  fi
  echo "    poll ${i}: Target still answers"
  sleep 10
done
if [ -z "${GONE}" ]; then
  echo "FAIL: Target still answers 120s after delete-queue" >&2
  exit 1
fi
echo "    OK: SQS reports Target gone"

# --- Phase 3: the update of the deleted Target -------------------------------
echo "==> Phase 3: redeploy with Target's VisibilityTimeout 30 -> 60 (CDKD_TEST_UPDATE=update)"
DEPLOY_LOG="${LOG_DIR}/phase3.log"
set +e
CDKD_TEST_UPDATE=update node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_LOG}" 2>&1
RC=$?
set -e
cat "${DEPLOY_LOG}"
if [ "${RC}" -eq 0 ]; then
  echo "FAIL: the update of the deleted Target exited 0" >&2
  exit 1
fi
# Sentinel: the update failure line itself. Without it the deleted note below
# could be missing because the deploy failed somewhere else.
if ! grep -qE 'Failed to update Target' "${DEPLOY_LOG}"; then
  echo "FAIL: the deploy did not fail on Target's update (rc=${RC}); see the log above" >&2
  exit 1
fi
if ! grep -qF 'Target (AWS::SQS::Queue): AWS reports this resource no longer exists (deleted outside cdkd)' "${DEPLOY_LOG}"; then
  echo "FAIL (#6106): Target's update failed but the deploy did not name it as deleted outside cdkd" >&2
  exit 1
fi
if ! grep -qF 'remove it from the CDK app and deploy, then restore it and deploy again' "${DEPLOY_LOG}"; then
  echo "FAIL (#6106): the deleted-outside note carries no recovery remedy" >&2
  exit 1
fi
if grep -qF -- '--revert-failed' "${DEPLOY_LOG}"; then
  echo "FAIL (#6106): the deploy still points at 'cdkd rollback --revert-failed', which cannot revert a deleted resource" >&2
  exit 1
fi
assert_gone "(#6106) ${JOURNAL_KEY} was kept for an op no rollback can revert" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
if [ "$(state_field Survivor '.physicalId')" != "${SURVIVOR_URL}" ]; then
  echo "FAIL: Survivor's record changed in the failed deploy" >&2
  exit 1
fi
queue_attr "${SURVIVOR_URL}" QueueArn >/dev/null
echo "    OK: Target named as deleted outside cdkd with the remedy, no --revert-failed, no journal, Survivor intact"

# --- Phase 4: the remedy, step one (remove Target from the app) --------------
echo "==> Phase 4: deploy with Target removed (CDKD_TEST_UPDATE=removed)"
CDKD_TEST_UPDATE=removed node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
if [ -n "$(state_field Target '.physicalId')" ]; then
  echo "FAIL: Target's record survived the deploy that removed it from the app" >&2
  exit 1
fi
echo "    OK: Target's record dropped"

# --- Phase 5: the remedy, step two (restore Target) ---------------------------
echo "==> Phase 5: deploy with Target restored (CDKD_TEST_UPDATE=update)"
CDKD_TEST_UPDATE=update node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
NEW_TARGET_URL="$(state_field Target '.physicalId')"
if [ -z "${NEW_TARGET_URL}" ] || [ "${NEW_TARGET_URL}" = "${TARGET_URL}" ]; then
  echo "FAIL: Target was not re-created under a new URL (got '${NEW_TARGET_URL}')" >&2
  exit 1
fi
NEW_VT="$(queue_attr "${NEW_TARGET_URL}" VisibilityTimeout)"
if [ "${NEW_VT}" != "60" ]; then
  echo "FAIL: the re-created Target reads VisibilityTimeout '${NEW_VT}', expected 60" >&2
  exit 1
fi
echo "    OK: Target re-created as ${NEW_TARGET_URL##*/} with VisibilityTimeout 60"

# --- Phase 6: destroy ---------------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for url in "${NEW_TARGET_URL}" "${SURVIVOR_URL}"; do
  assert_gone "queue ${url##*/} still exists after destroy" aws sqs get-queue-url --queue-name "${url##*/}" --region "${REGION}"
done
echo "    OK: both queues are gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"

echo "[verify] PASS — a failed update of a resource deleted outside cdkd names it with the remedy, keeps no --revert-failed record, and the remedy converges"
