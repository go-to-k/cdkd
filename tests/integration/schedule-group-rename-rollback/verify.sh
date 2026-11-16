#!/usr/bin/env bash
# verify.sh — cdkd ScheduleGroup rename: a failed deploy's rollback keeps the
# group's schedules (issue #6374).
#
# A create-first replacement deleted the OLD resource right after creating the
# new one, before the resources referencing it had moved. Deleting a schedule
# group deletes every schedule in it, so renaming a group deleted its
# schedules at once; when the deploy then failed (the schedule's GroupName
# change is refused in place without --replace), the rollback re-created an
# EMPTY old group and the schedule was gone for good. cdkd now deletes a
# replaced resource only after the rest of the deploy succeeds, as
# CloudFormation's cleanup phase does.
#
# Phases:
#   1. Deploy group cdkd-sgrr-g1 holding schedule cdkd-sgrr-schedule.
#   2. Rename the group to cdkd-sgrr-g2 without --replace. Assert the deploy
#      fails on the schedule's GroupName refusal, the schedule still exists in
#      g1, g2 is gone, and state names g1 again.
#   3. Deploy the rename with --replace. Assert the schedule now lives in g2
#      and g1 is gone.
#   4. Destroy + assert the group, the schedule and the cdkd state are gone.
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

STACK="CdkdScheduleGroupRenameRollbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
G1="cdkd-sgrr-g1"
G2="cdkd-sgrr-g2"
SCHEDULE="cdkd-sgrr-schedule"

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
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  [ -n "${P2_LOG:-}" ] && rm -f "${P2_LOG}"
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

# The group AWS reports for schedule SCHEDULE, looked up in group $1.
schedule_group_of() {
  aws scheduler get-schedule --name "${SCHEDULE}" --group-name "$1" --region "${REGION}" \
    --query 'GroupName' --output text
}
# The physical id state records for the ScheduleGroup, by logical id.
state_group_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [, rec] = Object.entries(JSON.parse(s).resources).find(([id]) => /^Group[0-9A-F]{8}$/.test(id));
      console.log(rec.physicalId);
    });'
}

# --- Phase 1: base ------------------------------------------------------
echo "==> Phase 1: deploy group ${G1} with schedule ${SCHEDULE}"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
if [ "$(schedule_group_of "${G1}")" != "${G1}" ]; then
  echo "FAIL: schedule ${SCHEDULE} not found in ${G1} after Phase 1" >&2
  exit 1
fi
echo "    schedule is in ${G1}"

# --- Phase 2: rename without --replace -> fails, rolls back --------------
echo "==> Phase 2: rename the group without --replace (must fail and roll back)"
P2_LOG="$(mktemp -t cdkd-sgrr-p2.XXXXXX)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${P2_LOG}" 2>&1
P2_RC=$?
set -e
cat "${P2_LOG}"
P2_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${P2_LOG}")"
if [ "${P2_RC}" -eq 0 ]; then
  echo "FAIL: Phase 2 deploy succeeded, but the schedule's GroupName change should have been refused" >&2
  exit 1
fi
# Sentinel: the run must have replaced the group before the schedule failed,
# or this phase tests nothing.
if ! grep -qE 'Replacing Group[0-9A-F]+ \(AWS::Scheduler::ScheduleGroup\)' <<<"${P2_PLAIN}"; then
  echo "FAIL: Phase 2 never replaced the group; the deferred delete was not exercised" >&2
  exit 1
fi

# Data safety first: the schedule survived, in the old group.
if gone_probe aws scheduler get-schedule-group --name "${G1}" --region "${REGION}"; then
  echo "FAIL: group ${G1} is gone after the rollback" >&2
  exit 1
fi
if gone_probe aws scheduler get-schedule --name "${SCHEDULE}" --group-name "${G1}" --region "${REGION}"; then
  echo "FAIL: schedule ${SCHEDULE} was deleted with the old group (issue #6374)" >&2
  exit 1
fi
echo "    schedule ${SCHEDULE} survived in ${G1}"
assert_gone "group ${G2} left behind by the rollback" aws scheduler get-schedule-group --name "${G2}" --region "${REGION}"
STATE_G="$(state_group_id)"
if [ "${STATE_G}" != "${G1}" ]; then
  echo "FAIL: state names group '${STATE_G}' after the rollback, expected ${G1}" >&2
  exit 1
fi
echo "    ${G2} removed and state names ${G1} again"
# Then the wording.
if ! grep -qF "is deleted after the rest of the deploy succeeds" <<<"${P2_PLAIN}"; then
  echo "FAIL: no line saying the old group's delete waits for the deploy" >&2
  exit 1
fi
rm -f "${P2_LOG}"

# --- Phase 3: rename with --replace --------------------------------------
echo "==> Phase 3: rename the group with --replace"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --replace
if [ "$(schedule_group_of "${G2}")" != "${G2}" ]; then
  echo "FAIL: schedule ${SCHEDULE} not found in ${G2} after Phase 3" >&2
  exit 1
fi
assert_gone "old group ${G1} still exists after the replacement" aws scheduler get-schedule-group --name "${G1}" --region "${REGION}"
echo "    schedule moved to ${G2}; ${G1} deleted"

# --- Phase 4: destroy ----------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "schedule ${SCHEDULE} still exists after destroy" aws scheduler get-schedule --name "${SCHEDULE}" --group-name "${G2}" --region "${REGION}"
assert_gone "group ${G2} still exists after destroy" aws scheduler get-schedule-group --name "${G2}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    group, schedule and cdkd state removed"

echo "[verify] PASS — a ScheduleGroup rename deletes the old group only after the deploy succeeds, so a failed deploy's rollback keeps its schedules"
