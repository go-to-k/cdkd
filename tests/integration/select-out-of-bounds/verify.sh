#!/usr/bin/env bash
# verify.sh — cdkd refuses an out-of-bounds Fn::Select (go-to-k/cdkd#6181).
#
# The stack's `Bad` SSM parameter takes its value from
# Fn::Select [1, Fn::Split ["-", Ref AWS::StackName]] over a stack name with
# no `-`: index 1 is past the end. CloudFormation refuses that template at
# CreateStack ("Fn::Select cannot select nonexistent value"). Asserts:
#   1. `cdkd deploy` exits non-zero and names the refusal (sentinel-checked);
#   2. no parameter holds a `{{Fn::Select:...:OutOfBounds}}` value, and both
#      the refused `Bad` and its sibling `Good` (rolled back) are gone;
#   3. no state record keeps either resource.

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

STACK="CdkdSelectOutOfBounds"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_PATH="/cdkd-select-oob/"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="$(mktemp)"

sweep() { (
  set +eu
  case "${PARAM_PATH}" in
    /cdkd-select-oob/) ;;
    *) echo "teardown sweep refused: parameter path '${PARAM_PATH}'" >&2; exit 0 ;;
  esac
  for name in $(aws ssm get-parameters-by-path --path "${PARAM_PATH}" --region "${REGION}" \
      --query 'Parameters[].Name' --output text 2>/dev/null); do
    aws ssm delete-parameter --name "${name}" --region "${REGION}" >/dev/null 2>&1
  done
) }

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/stack-instance.json" >/dev/null 2>&1
  fi
  sweep
  rm -f "${LOG}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG="$(mktemp)"

echo "==> 1. Deploy (must be refused)"
rc=0
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG}" 2>&1 || rc=$?
if [ "${rc}" = "0" ]; then
  echo "FAIL: cdkd deploy exited 0 over an out-of-bounds Fn::Select (CloudFormation refuses this template)" >&2
  sed 's/\x1b\[[0-9;]*m//g' "${LOG}" | tail -20 >&2
  exit 1
fi
# The parsed marker and an independent sentinel from the same refusal line:
# the sentinel present without the marker means the wording drifted.
if ! grep -qF "the index 1 is out of bounds (array length: 1)" "${LOG}"; then
  if grep -qF "CloudFormation refuses this template too" "${LOG}"; then
    echo "FAIL: the refusal's wording drifted (sentinel present, marker absent); update this fixture" >&2
  else
    echo "FAIL: cdkd deploy failed (rc=${rc}) without the out-of-bounds refusal" >&2
  fi
  sed 's/\x1b\[[0-9;]*m//g' "${LOG}" | tail -20 >&2
  exit 1
fi
echo "    OK: deploy refused the out-of-bounds Fn::Select (rc=${rc})"

echo "==> 2. Nothing on AWS"
values="$(aws ssm get-parameters-by-path --path "${PARAM_PATH}" --region "${REGION}" --query 'Parameters[].Value' --output text)"
case "${values}" in
  *OutOfBounds*) echo "FAIL: a parameter holds the OutOfBounds placeholder: ${values}" >&2; exit 1 ;;
esac
assert_gone "the refused parameter /cdkd-select-oob/bad exists" aws ssm get-parameter --name /cdkd-select-oob/bad --region "${REGION}"
assert_gone "the rolled-back parameter /cdkd-select-oob/good exists" aws ssm get-parameter --name /cdkd-select-oob/good --region "${REGION}"
echo "    OK: no parameter was left, and none holds the placeholder"

echo "==> 3. No state record keeps a resource"
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "    OK: no state record"
else
  count="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | jq '.resources | length')"
  [ "${count}" = "0" ] || { echo "FAIL: the state record keeps ${count} resource(s) after the refused deploy" >&2; exit 1; }
  echo "    OK: the state record holds no resource"
fi

trap - EXIT INT TERM
cleanup
echo ""
echo "==> select-out-of-bounds test passed"
