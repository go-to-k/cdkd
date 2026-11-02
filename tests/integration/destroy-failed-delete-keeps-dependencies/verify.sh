#!/usr/bin/env bash
# verify.sh -- issue #5670: after a resource's delete fails, `cdkd destroy`
# keeps the resources it depends on (as CloudFormation's DELETE_FAILED does)
# and still deletes the resources unrelated to the failure.
#
# Phase 1  deploy FailingBucket -> DepParam -> DeeperParam, and the unrelated
#          UnrelatedTwo -> UnrelatedOne.
# Phase 2  put an object in FailingBucket (no autoDeleteObjects, so cdkd
#          refuses to delete it), destroy: exit 2, DepParam and DeeperParam
#          still in AWS and in state, both unrelated parameters gone.
# Phase 3  empty the bucket, re-run the destroy: exit 0, everything gone.
#
# Before the fix, Phase 2 deleted DepParam and DeeperParam after the bucket's
# delete failed, so the "still exists" assertions there go red.

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

STACK="CdkdDestroyFailedDeleteKeepsDepsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_PREFIX="/cdkd-integ/${STACK}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="cdkd-5670-failing-${ACCOUNT}-${REGION}"

cleanup() {
  echo "==> Cleanup"
  set +eu
  # Empty the bucket first, so the state destroy below can delete it.
  aws s3 rm "s3://${BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  for name in deeper dep unrelated-one unrelated-two; do
    aws ssm delete-parameter --name "${PARAM_PREFIX}/${name}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# Strict read of a parameter that must still exist: any probe failure fails.
assert_param_value() { # usage: assert_param_value <name> <expected value>
  local got
  if ! got="$(aws ssm get-parameter --name "${PARAM_PREFIX}/$1" --region "${REGION}" \
    --query 'Parameter.Value' --output text)"; then
    echo "FAIL: parameter ${PARAM_PREFIX}/$1 could not be read (deleted?)" >&2
    exit 1
  fi
  if [ "${got}" != "$2" ]; then
    echo "FAIL: parameter ${PARAM_PREFIX}/$1 reads '${got}', expected '$2'" >&2
    exit 1
  fi
}

# The state record's logical ids, sorted and comma-joined.
state_ids() {
  local json
  json="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" || return 1
  node -e 'const s = JSON.parse(process.argv[1]); console.log(Object.keys(s.resources).sort().join(","));' "${json}"
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

for name in deeper dep unrelated-one unrelated-two; do
  assert_param_value "${name}" "${name}"
done
aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null
IDS="$(state_ids)"
if [ "${IDS}" != "DeeperParam,DepParam,FailingBucket,UnrelatedOne,UnrelatedTwo" ]; then
  echo "FAIL: state after deploy holds '${IDS}'" >&2
  exit 1
fi
echo "    OK: four parameters and the bucket deployed"

echo "==> Phase 2: destroy with the bucket's delete failing"
printf 'keep me' | aws s3 cp - "s3://${BUCKET}/blocker.txt" --region "${REGION}" >/dev/null
set +e
OUT="$(node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)"
RC=$?
set -e
printf '%s\n' "${OUT}"
# cdkd colours its output whether or not stdout is a terminal.
OUT_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' <<<"${OUT}")"
if [ "${RC}" -ne 2 ]; then
  echo "FAIL: destroy with a failing delete exited ${RC}, expected 2" >&2
  exit 1
fi
if ! grep -q 'Failed to delete FailingBucket' <<<"${OUT_PLAIN}"; then
  echo "FAIL: the bucket's delete did not fail (the premise of this phase)" >&2
  exit 1
fi
# The bug: these two were deleted after the bucket's delete failed.
assert_param_value dep dep
assert_param_value deeper deeper
aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null
echo "    OK: the failed bucket and both of its dependencies are still in AWS"
for id in DepParam DeeperParam; do
  if ! grep -q "${id} (AWS::SSM::Parameter) not deleted (FailingBucket depends on it and its delete failed)" <<<"${OUT_PLAIN}"; then
    echo "FAIL: no blocked line for ${id}" >&2
    exit 1
  fi
done
if ! grep -q '2 blocked' <<<"${OUT_PLAIN}"; then
  echo "FAIL: the summary does not count 2 blocked resources" >&2
  exit 1
fi
# Resources unrelated to the failure are still deleted, UnrelatedOne on the
# deletion level after the failing one included (CloudFormation does the same).
assert_gone "unrelated-two survived the destroy" \
  aws ssm get-parameter --name "${PARAM_PREFIX}/unrelated-two" --region "${REGION}"
assert_gone "unrelated-one survived the destroy" \
  aws ssm get-parameter --name "${PARAM_PREFIX}/unrelated-one" --region "${REGION}"
echo "    OK: both unrelated parameters deleted"
IDS="$(state_ids)"
if [ "${IDS}" != "DeeperParam,DepParam,FailingBucket" ]; then
  echo "FAIL: state after the failed destroy holds '${IDS}', expected DeeperParam,DepParam,FailingBucket" >&2
  exit 1
fi
echo "    OK: state keeps the failed bucket and its dependencies for a re-run"

echo "==> Phase 3: empty the bucket and re-run the destroy"
aws s3api delete-object --bucket "${BUCKET}" --key blocker.txt --region "${REGION}" >/dev/null
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "bucket ${BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
for name in deeper dep; do
  assert_gone "parameter ${PARAM_PREFIX}/${name} still exists after destroy" \
    aws ssm get-parameter --name "${PARAM_PREFIX}/${name}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: the re-run deleted the rest and the state"
echo ""
echo "[verify] PASS -- destroy-failed-delete-keeps-dependencies"
