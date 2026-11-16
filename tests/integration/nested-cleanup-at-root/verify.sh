#!/usr/bin/env bash
# verify.sh — cdkd nested-stack cleanup phase: a nested child's replaced
# resources are deleted only after the whole stack tree's deploy succeeded
# (issue #6398).
#
# A nested child ran its own cleanup pass when the CHILD finished, which is
# still inside its parent's deploy. Here child A renames a schedule group and
# child B (deployed after A, the group name reaching it as a parameter) moves
# its schedule into the new group. A's own cleanup deleted the old group, and
# with it every schedule still in it, before B moved: when the parent then
# failed, its rollback came back to an old group whose schedule was gone.
# CloudFormation runs every nested stack's cleanup at the end of the root
# stack's update, and so does cdkd now.
#
# Phases:
#   1. Deploy group cdkd-ncar-g1 (child A) holding schedule cdkd-ncar-schedule
#      (child B). Record the schedule's CreationDate.
#   2. Rename the group to cdkd-ncar-g2 with --replace, plus a parent queue AWS
#      refuses, created after both children. Assert the deploy fails, no
#      nested cleanup ran, and, data first: the ORIGINAL schedule (same
#      CreationDate) still exists in g1, g1 exists, g2 is gone.
#   3. Rename again without the failing queue, --replace. Assert it succeeds,
#      the schedule lives in g2, g1 is gone, and the root ran A's cleanup only
#      after B's schedule moved.
#   4. Destroy + assert the groups, the schedule, the target queue and every
#      cdkd state record (parent and children) are gone.
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

STACK="CdkdNestedCleanupAtRootExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The children's records live at cdkd/<parent>~<child logical id>/<region>/.
CHILD_PREFIX="cdkd/${STACK}~"
G1="cdkd-ncar-g1"
G2="cdkd-ncar-g2"
SCHEDULE="cdkd-ncar-schedule"

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
  local g
  for g in "${G1}" "${G2}"; do
    aws scheduler delete-schedule --name "${SCHEDULE}" --group-name "${g}" --region "${REGION}" >/dev/null 2>&1 || true
    aws scheduler delete-schedule-group --name "${g}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
    # The child prefix sweep must never widen past this fixture's children.
    case "${CHILD_PREFIX}" in
      cdkd/CdkdNestedCleanupAtRootExample~)
        aws s3 rm "s3://${STATE_BUCKET}/${CHILD_PREFIX}" --recursive >/dev/null 2>&1 || true
        ;;
      *)
        echo "    teardown sweep refused: child prefix '${CHILD_PREFIX}' is not this fixture's" >&2
        ;;
    esac
  fi
  [ -n "${P2_LOG:-}" ] && rm -f "${P2_LOG}"
  [ -n "${P3_LOG:-}" ] && rm -f "${P3_LOG}"
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

# The schedule's CreationDate in group $1: a re-created schedule has a new one.
schedule_created_in() {
  aws scheduler get-schedule --name "${SCHEDULE}" --group-name "$1" --region "${REGION}" \
    --query 'CreationDate' --output text
}
# The key of child B's state record (its logical id carries a CDK hash).
child_b_state_key() {
  aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${CHILD_PREFIX}ChildB" \
    --query "Contents[?ends_with(Key, '/${REGION}/state.json')].Key | [0]" --output text
}
# The queue URL child B's record holds for its schedule target.
child_b_queue_url() {
  local key
  key="$(child_b_state_key)" || return 1
  aws s3 cp "s3://${STATE_BUCKET}/${key}" - --region "${REGION}" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const found = Object.values(JSON.parse(s).resources).filter((r) => r.resourceType === "AWS::SQS::Queue");
      if (found.length !== 1) { console.error("expected one queue record, got " + found.length); process.exit(1); }
      console.log(found[0].physicalId);
    });'
}

# --- Phase 1: base ------------------------------------------------------
echo "==> Phase 1: deploy group ${G1} (child A) and schedule ${SCHEDULE} (child B)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_FAIL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
CREATED_P1="$(schedule_created_in "${G1}")"
if [ -z "${CREATED_P1}" ] || [ "${CREATED_P1}" = "None" ]; then
  echo "FAIL: schedule ${SCHEDULE} has no CreationDate in ${G1} after Phase 1" >&2
  exit 1
fi
echo "    schedule is in ${G1} (created ${CREATED_P1})"

# --- Phase 2: rename + a failing parent resource -> fails, rolls back ----
echo "==> Phase 2: rename the group with --replace while the parent fails after both children"
P2_LOG="$(mktemp -t cdkd-ncar-p2.XXXXXX)"
set +e
env -u CDKD_TEST_UPDATE -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true CDKD_TEST_FAIL=true \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --replace >"${P2_LOG}" 2>&1
P2_RC=$?
set -e
cat "${P2_LOG}"
P2_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${P2_LOG}")"
if [ "${P2_RC}" -eq 0 ]; then
  echo "FAIL: Phase 2 deploy succeeded, but the parent's FailingQueue should have been refused" >&2
  exit 1
fi
# Sentinels: the run replaced the group in child A and failed on the parent's
# queue, or this phase tests nothing.
if ! grep -qE 'Replacing Group[0-9A-F]+ \(AWS::Scheduler::ScheduleGroup\)' <<<"${P2_PLAIN}"; then
  echo "FAIL: Phase 2 never replaced the group; the deferred delete was not exercised" >&2
  exit 1
fi
if ! grep -qE 'Replacing Schedule[0-9A-F]+ \(AWS::Scheduler::Schedule\)' <<<"${P2_PLAIN}"; then
  echo "FAIL: Phase 2 never moved child B's schedule; the failure came before both children ran" >&2
  exit 1
fi
# cdkd's own lines about the queue, not the synth validation warning that
# also names it.
P2_OWN="$(grep -vE 'CloudFormation-Validate|aws_sqs\.CfnQueue|WARNING MessageRetentionPeriod' <<<"${P2_PLAIN}" || true)"
if ! grep -qF 'FailingQueue' <<<"${P2_OWN}"; then
  echo "FAIL: Phase 2 did not fail on the parent's FailingQueue" >&2
  exit 1
fi

# Data safety first: the ORIGINAL schedule survived, in the old group.
if gone_probe aws scheduler get-schedule-group --name "${G1}" --region "${REGION}"; then
  echo "FAIL: group ${G1} is gone after the rollback" >&2
  exit 1
fi
if gone_probe aws scheduler get-schedule --name "${SCHEDULE}" --group-name "${G1}" --region "${REGION}"; then
  echo "FAIL: schedule ${SCHEDULE} is gone from ${G1} after the rollback (issue #6398)" >&2
  exit 1
fi
CREATED_P2="$(schedule_created_in "${G1}")"
if [ "${CREATED_P2}" != "${CREATED_P1}" ]; then
  echo "FAIL: schedule ${SCHEDULE} in ${G1} was re-created (CreationDate ${CREATED_P1} -> ${CREATED_P2}): child A's cleanup deleted it with the old group (issue #6398)" >&2
  exit 1
fi
echo "    the original schedule survived in ${G1}"
assert_gone "group ${G2} left behind by the rollback" aws scheduler get-schedule-group --name "${G2}" --region "${REGION}"
echo "    ${G2} removed by the rollback"
# Then the wording: no nested cleanup ran on the failed deploy.
if grep -qF 'Deleting the replaced resources of nested stack' <<<"${P2_PLAIN}"; then
  echo "FAIL: a nested stack's cleanup ran although the root deploy failed" >&2
  exit 1
fi
if ! grep -qF 'is deleted after the rest of the deploy succeeds' <<<"${P2_PLAIN}"; then
  echo "FAIL: no line saying the old group's delete waits for the deploy" >&2
  exit 1
fi
rm -f "${P2_LOG}"

# --- Phase 3: rename, no failing resource --------------------------------
echo "==> Phase 3: rename the group with --replace (succeeds)"
P3_LOG="$(mktemp -t cdkd-ncar-p3.XXXXXX)"
set +e
env -u CDKD_TEST_UPDATE -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --replace >"${P3_LOG}" 2>&1
P3_RC=$?
set -e
cat "${P3_LOG}"
P3_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${P3_LOG}")"
if [ "${P3_RC}" -ne 0 ]; then
  echo "FAIL: Phase 3 deploy failed (rc=${P3_RC})" >&2
  exit 1
fi
CREATED_P3="$(schedule_created_in "${G2}")"
if [ -z "${CREATED_P3}" ] || [ "${CREATED_P3}" = "None" ]; then
  echo "FAIL: schedule ${SCHEDULE} not found in ${G2} after Phase 3" >&2
  exit 1
fi
assert_gone "old group ${G1} still exists after the replacement" aws scheduler get-schedule-group --name "${G1}" --region "${REGION}"
echo "    schedule moved to ${G2}; ${G1} deleted"
# Ordering: the root ran the nested cleanup after child B's schedule moved.
# Sentinel: both lines must be present, or the order check reads nothing.
SCHEDULE_LINE="$(grep -nE 'Replacing Schedule[0-9A-F]+ \(AWS::Scheduler::Schedule\)' <<<"${P3_PLAIN}" | tail -n 1 | cut -d: -f1 || true)"
# Child A's stack is `<parent>~ChildANestedStack...` (its logical id carries a CDK hash).
CLEANUP_LINE="$(grep -nF "Deleting the replaced resources of nested stack ${STACK}~ChildA" <<<"${P3_PLAIN}" | head -n 1 | cut -d: -f1 || true)"
if [ -z "${SCHEDULE_LINE}" ]; then
  echo "FAIL: Phase 3 never replaced child B's schedule" >&2
  exit 1
fi
if [ -z "${CLEANUP_LINE}" ]; then
  echo "FAIL: Phase 3 printed no cleanup line naming child A's nested stack" >&2
  exit 1
fi
if [ "${CLEANUP_LINE}" -le "${SCHEDULE_LINE}" ]; then
  echo "FAIL: child A's cleanup (line ${CLEANUP_LINE}) ran before child B's schedule moved (line ${SCHEDULE_LINE})" >&2
  exit 1
fi
echo "    the old group was deleted at the root's cleanup, after the schedule moved"
QUEUE_URL="$(child_b_queue_url)"
rm -f "${P3_LOG}"

# --- Phase 4: destroy ----------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "schedule ${SCHEDULE} still exists after destroy" aws scheduler get-schedule --name "${SCHEDULE}" --group-name "${G2}" --region "${REGION}"
assert_gone "group ${G2} still exists after destroy" aws scheduler get-schedule-group --name "${G2}" --region "${REGION}"
assert_gone "group ${G1} still exists after destroy" aws scheduler get-schedule-group --name "${G1}" --region "${REGION}"
assert_gone "target queue ${QUEUE_URL} still exists after destroy" aws sqs get-queue-attributes --queue-url "${QUEUE_URL}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CHILD_KEYS="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${CHILD_PREFIX}" \
  --query "Contents[?ends_with(Key, '/state.json')].Key" --output text)"
if [ -n "${CHILD_KEYS}" ] && [ "${CHILD_KEYS}" != "None" ]; then
  echo "FAIL: nested child state records left after destroy: ${CHILD_KEYS}" >&2
  exit 1
fi
echo "    groups, schedule, queue and every cdkd state record removed"

echo "[verify] PASS — a nested child's replaced schedule group is deleted only after the root deploy succeeds, so a failed root keeps the schedules"
