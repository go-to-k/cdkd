#!/usr/bin/env bash
#
# Issue #3754: does the parent's AUTOMATIC rollback revert a nested child that
# the failed deploy had already updated?
#
#   PHASE 1: deploy v1 (child queue VisibilityTimeout=30). Record the child
#            queue URL from the child's state and the parent's Child row.
#   PHASE 2: deploy CHILD_VT=45 + INJECT_FAIL=true WITHOUT --no-rollback. The
#            child update completes (FailingQueue depends on the Child row),
#            then FailingQueue's CreateQueue is rejected and the automatic
#            rollback reverts the completed Child UPDATE through
#            NestedStackProvider.update. Asserts: the deploy failed, the
#            child update really ran, the rollback reached the Child row, and
#            the LIVE child queue is back at VisibilityTimeout=30 with the
#            child's state record agreeing.
#   PHASE 2b: CHILD_VT=60 + INJECT_FAIL under --no-rollback leaves the child at
#            60 with both journals; a synth-free `cdkd rollback` reverts the
#            child to 30 from its journal and clears both journals.
#   PHASE 2c: a successful deploy (CHILD_VT=45) leaves no child journal: the
#            root's success sweeps it.
#   PHASE 3: destroy clean; parent AND `<Parent>~Child` state prefixes gone,
#            the child queue gone.
#
# BSD/macOS-portable. The script prints "[verify] PASS" only at the very end.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdNestedRollback3754"
CHILD_STACK="${STACK}~Child"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/nested-stack-rollback"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

PARENT_STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PARENT_JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
CHILD_JOURNAL_KEY="cdkd/${CHILD_STACK}/${REGION}/rollback-journal.json"
LOG_DIR="$(mktemp -d)"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} logs=${LOG_DIR}"

CHILD_QUEUE_URL=""

read_state() { # usage: read_state <key>  -> body on stdout, or nothing when absent
  aws s3 cp "s3://${STATE_BUCKET}/$1" - 2>"${LOG_DIR}/s3-read.err" || true
}

live_vt() { # usage: live_vt <queue-url>
  aws sqs get-queue-attributes --queue-url "$1" --attribute-names VisibilityTimeout \
    --region "${REGION}" --query 'Attributes.VisibilityTimeout' --output text
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) - attempting cleanup"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    if [ -n "${CHILD_QUEUE_URL}" ]; then
      aws sqs delete-queue --queue-url "${CHILD_QUEUE_URL}" --region "${REGION}" >/dev/null 2>&1 || true
    fi
  fi
  echo "[verify] cleanup: remove sidecars"
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CHILD_STACK}/" --recursive >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && CI=true pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

# ---------------------------------------------------------------------------
# PHASE 1
# ---------------------------------------------------------------------------
echo "[verify] step 2: deploy v1 (child VisibilityTimeout=30)"
set +e
CHILD_VT=30 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/deploy1.log" 2>&1
RC1=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy1.log"
if [ "${RC1}" -ne 0 ]; then
  echo "[verify] FAIL: v1 deploy exited ${RC1}"
  exit 1
fi

CHILD_BODY_1="$(read_state "${CHILD_STATE_KEY}")"
CHILD_QUEUE_URL="$(printf '%s' "${CHILD_BODY_1}" | jq -r '.resources.ChildQueue.physicalId // empty')"
if [ -z "${CHILD_QUEUE_URL}" ]; then
  echo "[verify] FAIL: no ChildQueue physicalId in ${CHILD_STATE_KEY}"
  cat "${LOG_DIR}/s3-read.err" || true
  exit 1
fi
PARENT_BODY_1="$(read_state "${PARENT_STATE_KEY}")"
URL_1="$(printf '%s' "${PARENT_BODY_1}" | jq -r '.resources.Child.properties.TemplateURL | tostring')"
VT_1="$(live_vt "${CHILD_QUEUE_URL}")"
if [ "${VT_1}" != "30" ]; then
  echo "[verify] FAIL: premise: live child VisibilityTimeout after v1 is '${VT_1}' (expected 30)"
  exit 1
fi
echo "[verify] step 2 ok: child queue ${CHILD_QUEUE_URL} VisibilityTimeout=30; Child TemplateURL=${URL_1}"

# ---------------------------------------------------------------------------
# PHASE 2
# ---------------------------------------------------------------------------
echo "[verify] step 3: deploy CHILD_VT=45 + INJECT_FAIL (automatic rollback expected)"
set +e
CHILD_VT=45 INJECT_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose \
  > "${LOG_DIR}/deploy2.log" 2>&1
RC2=$?
set -e
grep -E 'nested stack|Rollback|FailingQueue|Child|rollback' "${LOG_DIR}/deploy2.log" | sed 's/^/  /' || true
if [ "${RC2}" -eq 0 ]; then
  echo "[verify] FAIL: the INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
# Premise 1: the child update RAN before the failure (else nothing to revert).
if ! grep -q "Updating nested stack ${CHILD_STACK}" "${LOG_DIR}/deploy2.log"; then
  echo "[verify] FAIL: premise: the phase-2 deploy never updated the nested child"
  exit 1
fi
# Premise 2: the rollback reached the Child row.
if ! grep -qE 'Rollback: Child restored' "${LOG_DIR}/deploy2.log"; then
  echo "[verify] FAIL: premise: the automatic rollback did not report restoring the Child row"
  exit 1
fi

PARENT_BODY_2="$(read_state "${PARENT_STATE_KEY}")"
URL_2="$(printf '%s' "${PARENT_BODY_2}" | jq -r '.resources.Child.properties.TemplateURL | tostring')"
CHILD_BODY_2="$(read_state "${CHILD_STATE_KEY}")"
STATE_VT_2="$(printf '%s' "${CHILD_BODY_2}" | jq -r '.resources.ChildQueue.properties.VisibilityTimeout | tostring')"
VT_2="$(live_vt "${CHILD_QUEUE_URL}")"
echo "[verify] after rollback: parent Child TemplateURL=${URL_2} (v1: ${URL_1})"
echo "[verify] after rollback: child state VisibilityTimeout=${STATE_VT_2}, LIVE VisibilityTimeout=${VT_2}"

if [ "${URL_2}" != "${URL_1}" ]; then
  echo "[verify] FAIL: the parent's Child row was not restored to its v1 TemplateURL"
  exit 1
fi
if [ "${VT_2}" != "30" ] || [ "${STATE_VT_2}" != "30" ]; then
  echo "[verify] FAIL: the rollback reported the Child row restored, but the nested child was NOT reverted (live=${VT_2}, state=${STATE_VT_2}, expected 30)"
  exit 1
fi
echo "[verify] step 3 ok: the automatic rollback reverted the nested child to VisibilityTimeout=30"
# The clean rollback settled the child's pending segment, so its journal is gone.
assert_gone "the child rollback journal survived a clean automatic rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_JOURNAL_KEY}"

# ---------------------------------------------------------------------------
# PHASE 2b: --no-rollback failure, then a synth-free `cdkd rollback`
# ---------------------------------------------------------------------------
echo "[verify] step 3b: deploy CHILD_VT=60 + INJECT_FAIL --no-rollback (child updated, nothing reverted)"
set +e
CHILD_VT=60 INJECT_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback \
  > "${LOG_DIR}/deploy2b.log" 2>&1
RC2B=$?
set -e
if [ "${RC2B}" -eq 0 ]; then
  echo "[verify] FAIL: the --no-rollback INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
VT_2B="$(live_vt "${CHILD_QUEUE_URL}")"
if [ "${VT_2B}" != "60" ]; then
  sed 's/^/  /' "${LOG_DIR}/deploy2b.log"
  echo "[verify] FAIL: premise: the --no-rollback deploy left the child at '${VT_2B}' (expected 60)"
  exit 1
fi
for key in "${PARENT_JOURNAL_KEY}" "${CHILD_JOURNAL_KEY}"; do
  if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" >/dev/null 2>&1; then
    echo "[verify] FAIL: premise: ${key} is missing after the --no-rollback failure"
    exit 1
  fi
done

echo "[verify] step 3c: cdkd rollback (no synth) reverts the nested child from its journal"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/rollback.log" 2>&1
RCRB=$?
set -e
sed 's/^/  /' "${LOG_DIR}/rollback.log"
if [ "${RCRB}" -ne 0 ]; then
  echo "[verify] FAIL: cdkd rollback exited ${RCRB}"
  exit 1
fi
CHILD_BODY_3="$(read_state "${CHILD_STATE_KEY}")"
STATE_VT_3="$(printf '%s' "${CHILD_BODY_3}" | jq -r '.resources.ChildQueue.properties.VisibilityTimeout | tostring')"
VT_3="$(live_vt "${CHILD_QUEUE_URL}")"
if [ "${VT_3}" != "30" ] || [ "${STATE_VT_3}" != "30" ]; then
  echo "[verify] FAIL: cdkd rollback did not revert the nested child (live=${VT_3}, state=${STATE_VT_3}, expected 30)"
  exit 1
fi
for key in "${PARENT_JOURNAL_KEY}" "${CHILD_JOURNAL_KEY}"; do
  assert_gone "${key} survived a clean cdkd rollback" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
echo "[verify] step 3c ok: cdkd rollback reverted the nested child to VisibilityTimeout=30 and cleared both journals"

# ---------------------------------------------------------------------------
# PHASE 2c: a successful deploy leaves no child journal behind
# ---------------------------------------------------------------------------
echo "[verify] step 3d: successful deploy CHILD_VT=45 (the root sweeps the child journal)"
set +e
CHILD_VT=45 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/deploy3.log" 2>&1
RC3D=$?
set -e
if [ "${RC3D}" -ne 0 ]; then
  sed 's/^/  /' "${LOG_DIR}/deploy3.log"
  echo "[verify] FAIL: the successful CHILD_VT=45 deploy exited ${RC3D}"
  exit 1
fi
if [ "$(live_vt "${CHILD_QUEUE_URL}")" != "45" ]; then
  echo "[verify] FAIL: premise: the successful deploy did not update the child"
  exit 1
fi
assert_gone "the child's pending journal survived the parent's successful deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_JOURNAL_KEY}"
echo "[verify] step 3d ok: no child journal after a successful deploy"

# ---------------------------------------------------------------------------
# PHASE 3
# ---------------------------------------------------------------------------
echo "[verify] step 4: destroy"
set +e
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/destroy.log" 2>&1
RC3=$?
set -e
sed 's/^/  /' "${LOG_DIR}/destroy.log"
if [ "${RC3}" -ne 0 ]; then
  echo "[verify] FAIL: destroy exited ${RC3}"
  exit 1
fi
for key in "${PARENT_STATE_KEY}" "${CHILD_STATE_KEY}"; do
  assert_gone "${key} survived the destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
QUEUE_GONE=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if gone_probe aws sqs get-queue-attributes --queue-url "${CHILD_QUEUE_URL}" --attribute-names QueueArn --region "${REGION}"; then
    QUEUE_GONE=true
    break
  fi
  sleep 3
done
if [ "${QUEUE_GONE}" != "true" ]; then
  echo "[verify] FAIL: child queue ${CHILD_QUEUE_URL} survived the destroy"
  exit 1
fi
echo "[verify] step 4 ok: destroy clean"

echo "[verify] PASS"
