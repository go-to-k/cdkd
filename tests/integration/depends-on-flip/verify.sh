#!/usr/bin/env bash
# verify.sh — cdkd reversed explicit dependency (issue #6308), and a nested
# child's unchanged records whose dependencies change (issue #6314).
#
# Baseline: SSM parameter A depends on B. Update: B depends on A and B's value
# changes, so B is an UPDATE and A, whose only change is its DependsOn, is
# NO_CHANGE. Before the fix A's state record kept `dependencies: [B]` beside
# B's new `[A]`, and `cdkd destroy` refused with "Circular dependency
# detected". Phases:
#   1. deploy the baseline; A's record lists B. In the nested child (state
#      `<Stack>~Nested`), NC lists NB and NA lists nothing.
#   1b. (#6314) deploy a child template where NC no longer depends on NB, with
#      a parent queue AWS rejects that depends on the nested row: the child's
#      success trims NC's list, the parent fails and its rollback reverts the
#      child, which must put NC's edge to NB back.
#   2. deploy the flip (change path); A's record no longer lists B, B's lists A,
#      and B's new value reached AWS. (#6314) The child's NA, otherwise
#      unchanged, now depends on NB: the root's success records it.
#   3. write the pre-fix shape back into state (A lists B again), redeploy the
#      same template (no-change path); A's record is healed.
#   4. destroy succeeds; every parameter and both state files are gone.

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

STACK="CdkdDependsOnFlipExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_A="/${STACK}/a"
PARAM_B="/${STACK}/b"
CHILD_STACK="${STACK}~Nested"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PARAM_NA="/${STACK}/nested/na"
PARAM_NB="/${STACK}/nested/nb"
PARAM_NC="/${STACK}/nested/nc"
LOG_DIR=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM_A}" --region "${REGION}" >/dev/null 2>&1 || true
  for param in "${PARAM_B}" "${PARAM_NA}" "${PARAM_NB}" "${PARAM_NC}"; do
    aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    for prefix in "cdkd/${STACK}/${REGION}" "cdkd/${CHILD_STACK}/${REGION}"; do
      for key in state.json lock.json rollback-journal.json; do
        aws s3 rm "s3://${STATE_BUCKET}/${prefix}/${key}" >/dev/null 2>&1 || true
      done
    done
  fi
  [ -n "${EDITED_STATE:-}" ] && rm -f "${EDITED_STATE}"
  [ -n "${LOG_DIR:-}" ] && rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
# After the pre-run cleanup, which removes it.
LOG_DIR="$(mktemp -d)"

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

read_child_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}"
}

# The parameter NAMES the record holding parameter $1 depends on, sorted and
# space-joined. Records are found by physical id (the parameter name), so the
# check does not hard-code CDK's logical-id hashes. Exits non-zero when the
# record is missing.
deps_of() { # usage: deps_of <state json> <parameter name>
  node -e '
    const state = JSON.parse(process.argv[1]);
    const resources = state.resources ?? {};
    const byId = Object.fromEntries(Object.entries(resources).map(([id, r]) => [id, r.physicalId]));
    const entry = Object.entries(resources).find(([, r]) => r.physicalId === process.argv[2]);
    if (!entry) { console.error(`no record holds ${process.argv[2]}`); process.exit(1); }
    console.log((entry[1].dependencies ?? []).map((d) => byId[d] ?? d).sort().join(" "));
  ' "$1" "$2"
}

logical_id_of() { # usage: logical_id_of <state json> <parameter name>
  node -e '
    const state = JSON.parse(process.argv[1]);
    const entry = Object.entries(state.resources ?? {}).find(([, r]) => r.physicalId === process.argv[2]);
    if (!entry) { console.error(`no record holds ${process.argv[2]}`); process.exit(1); }
    console.log(entry[0]);
  ' "$1" "$2"
}

echo "==> Phase 1: deploy the baseline (A depends on B)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_1="$(read_state)"
A_DEPS_1="$(deps_of "${STATE_1}" "${PARAM_A}")"
B_DEPS_1="$(deps_of "${STATE_1}" "${PARAM_B}")"
[ "${A_DEPS_1}" = "${PARAM_B}" ] || { echo "FAIL: baseline A dependencies are '${A_DEPS_1}', expected '${PARAM_B}'" >&2; exit 1; }
[ -z "${B_DEPS_1}" ] || { echo "FAIL: baseline B dependencies are '${B_DEPS_1}', expected none" >&2; exit 1; }
echo "    OK: A lists B, B lists nothing"
CHILD_1="$(read_child_state)"
NA_DEPS_1="$(deps_of "${CHILD_1}" "${PARAM_NA}")"
NC_DEPS_1="$(deps_of "${CHILD_1}" "${PARAM_NC}")"
[ -z "${NA_DEPS_1}" ] || { echo "FAIL: baseline NA dependencies are '${NA_DEPS_1}', expected none" >&2; exit 1; }
[ "${NC_DEPS_1}" = "${PARAM_NB}" ] || { echo "FAIL: baseline NC dependencies are '${NC_DEPS_1}', expected '${PARAM_NB}'" >&2; exit 1; }
echo "    OK: nested NC lists NB, NA lists nothing"

echo "==> Phase 1b: NC drops its edge to NB, then the parent fails and reverts the child (#6314)"
if env -u CDKD_TEST_UPDATE CDKD_TEST_FAIL_NESTED=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG_DIR}/deploy1b.log" 2>&1; then
  cat "${LOG_DIR}/deploy1b.log"
  echo "FAIL: the deploy with the failing queue succeeded" >&2
  exit 1
fi
cat "${LOG_DIR}/deploy1b.log"
# Premise: the child's deploy completed and the parent's rollback reverted it;
# without that the restored edge below proves nothing.
grep -q 'Rollback: Nested restored' "${LOG_DIR}/deploy1b.log" \
  || { echo "FAIL: premise: the automatic rollback did not report restoring the Nested row" >&2; exit 1; }
NC_DEPS_1B="$(deps_of "$(read_child_state)" "${PARAM_NC}")"
[ "${NC_DEPS_1B}" = "${PARAM_NB}" ] \
  || { echo "FAIL: after the parent's revert NC lists '${NC_DEPS_1B}', expected '${PARAM_NB}' (trimmed edge not restored, #6314)" >&2; exit 1; }
echo "    OK: the revert put NC's edge to NB back"

echo "==> Phase 2: deploy the flip (B depends on A, B's value changes; A is NO_CHANGE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
B_VALUE="$(aws ssm get-parameter --name "${PARAM_B}" --region "${REGION}" --query 'Parameter.Value' --output text)"
[ "${B_VALUE}" = "b2" ] || { echo "FAIL: B's value on AWS is '${B_VALUE}', expected 'b2'" >&2; exit 1; }
STATE_2="$(read_state)"
A_DEPS_2="$(deps_of "${STATE_2}" "${PARAM_A}")"
B_DEPS_2="$(deps_of "${STATE_2}" "${PARAM_B}")"
# The #6308 assertion: the unchanged record drops the edge the flip reversed.
[ -z "${A_DEPS_2}" ] || { echo "FAIL: after the flip A's record still lists '${A_DEPS_2}' (stale dependencies, #6308)" >&2; exit 1; }
[ "${B_DEPS_2}" = "${PARAM_A}" ] || { echo "FAIL: after the flip B dependencies are '${B_DEPS_2}', expected '${PARAM_A}'" >&2; exit 1; }
echo "    OK: B's value is b2, A lists nothing, B lists A"
CHILD_2="$(read_child_state)"
NA_DEPS_2="$(deps_of "${CHILD_2}" "${PARAM_NA}")"
NC_DEPS_2="$(deps_of "${CHILD_2}" "${PARAM_NC}")"
# The #6314 assertion: an edge added to an unchanged nested record is recorded
# once the root deploy succeeds.
[ "${NA_DEPS_2}" = "${PARAM_NB}" ] \
  || { echo "FAIL: after the flip nested NA lists '${NA_DEPS_2}', expected '${PARAM_NB}' (added dependency not recorded, #6314)" >&2; exit 1; }
[ "${NC_DEPS_2}" = "${PARAM_NB}" ] || { echo "FAIL: after the flip nested NC lists '${NC_DEPS_2}', expected '${PARAM_NB}'" >&2; exit 1; }
echo "    OK: nested NA and NC list NB"

echo "==> Phase 3: write the pre-fix shape back (A lists B again), redeploy the same template"
A_ID="$(logical_id_of "${STATE_2}" "${PARAM_A}")"
B_ID="$(logical_id_of "${STATE_2}" "${PARAM_B}")"
EDITED_STATE="$(mktemp)"
node -e '
  const state = JSON.parse(process.argv[1]);
  state.resources[process.argv[2]].dependencies = [process.argv[3]];
  process.stdout.write(JSON.stringify(state));
' "${STATE_2}" "${A_ID}" "${B_ID}" > "${EDITED_STATE}"
aws s3 cp "${EDITED_STATE}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
STALE_DEPS="$(deps_of "$(read_state)" "${PARAM_A}")"
[ "${STALE_DEPS}" = "${PARAM_B}" ] || { echo "FAIL: the out-of-band edit did not land (A lists '${STALE_DEPS}')" >&2; exit 1; }
DEPLOY_3="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" \
  || { echo "${DEPLOY_3}"; echo "FAIL: the no-change redeploy failed" >&2; exit 1; }
echo "${DEPLOY_3}"
# The arm is about the no-change save path: a run that found a change proves nothing here.
grep -q 'No changes detected' <<<"${DEPLOY_3}" \
  || { echo "FAIL: the redeploy did not take the no-change path ('No changes detected' missing)" >&2; exit 1; }
A_DEPS_3="$(deps_of "$(read_state)" "${PARAM_A}")"
[ -z "${A_DEPS_3}" ] || { echo "FAIL: a no-change redeploy left A listing '${A_DEPS_3}' (stale dependencies, #6308)" >&2; exit 1; }
echo "    OK: the no-change redeploy healed A's record"

echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "parameter ${PARAM_A} still exists after destroy" aws ssm get-parameter --name "${PARAM_A}" --region "${REGION}"
assert_gone "parameter ${PARAM_B} still exists after destroy" aws ssm get-parameter --name "${PARAM_B}" --region "${REGION}"
for param in "${PARAM_NA}" "${PARAM_NB}" "${PARAM_NC}"; do
  assert_gone "parameter ${param} still exists after destroy" aws ssm get-parameter --name "${param}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "state file ${CHILD_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
echo "    OK: parameters and state gone"

trap - EXIT INT TERM
rm -f "${EDITED_STATE}"
rm -rf "${LOG_DIR}"
echo "[verify] PASS — depends-on-flip: a reversed explicit dependency redeploys and destroys cleanly, and nested dependency changes are recorded and reverted"
