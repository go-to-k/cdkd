#!/usr/bin/env bash
# verify.sh — cdkd reversed explicit dependency (issue #6308).
#
# Baseline: SSM parameter A depends on B. Update: B depends on A and B's value
# changes, so B is an UPDATE and A, whose only change is its DependsOn, is
# NO_CHANGE. Before the fix A's state record kept `dependencies: [B]` beside
# B's new `[A]`, and `cdkd destroy` refused with "Circular dependency
# detected". Phases:
#   1. deploy the baseline; A's record lists B.
#   2. deploy the flip (change path); A's record no longer lists B, B's lists A,
#      and B's new value reached AWS.
#   3. write the pre-fix shape back into state (A lists B again), redeploy the
#      same template (no-change path); A's record is healed.
#   4. destroy succeeds; both parameters and the state file are gone.

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
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM_A}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PARAM_B}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  [ -n "${EDITED_STATE:-}" ] && rm -f "${EDITED_STATE}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
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
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: parameters and state gone"

trap - EXIT INT TERM
rm -f "${EDITED_STATE}"
echo "[verify] PASS — depends-on-flip: a reversed explicit dependency redeploys and destroys cleanly"
