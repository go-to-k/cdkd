#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the `cdkd state info` subcommand
# (issue #1335).
#
# Before this script existed, the fixture only had the standard flow (synth ->
# deploy -> destroy), which never runs `cdkd state info` itself — the command
# the fixture is named after. This script closes that gap and also encodes the
# two operator-facing quirks that tripped the 2026-08-01 regression sweep:
#
#   - `state info` has NO `--region` flag (region is auto-detected via
#     GetBucketLocation); the bucket is passed via `--state-bucket` or the
#     `CDKD_STATE_BUCKET` env var (NOT the generic `STATE_BUCKET` env this
#     script itself takes — that name is an integ-suite convention, not a CLI
#     input). This fixture's cdk.json deliberately pins
#     `context.cdkd.stateBucket = "cdkd-state-test"` so the test proves both
#     real resolution sources (cli flag / env) override it.
#
# Flow:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy (SSM parameter marker stack)
#   3. `state info` (human) via --state-bucket: bucket name + stack count >= 1
#   4. `state info --json` via CDKD_STATE_BUCKET env: bucket / bucketSource=env
#      / integer schemaVersion / stackCount >= 1
#   5. cdkd destroy
#   6. assert the stack's state.json + SSM parameter are gone, and
#      `state info --json` still exits 0 (stackCount is bucket-wide, so no
#      absolute post-destroy count assert — parallel integ runs share the
#      bucket)
#
# BSD/macOS-portable: no grep -P, no date -d.
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

STACK="CdkdStateInfoExample"
SSM_PARAM_NAME="/cdkd-integ/state-info/marker"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/state-info-command"
CLI="node ${REPO_ROOT}/dist/cli.js"

: "${STATE_BUCKET:?STATE_BUCKET must be set (the real cdkd state bucket)}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    # Best-effort: destroy the stack if cdkd state still exists.
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    # Direct AWS cleanup in case destroy itself is what broke.
    echo "[verify] cleanup: delete SSM parameter ${SSM_PARAM_NAME} (ignore NotFound)"
    aws ssm delete-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

echo "[verify] step 3: state info (human output, bucket via --state-bucket flag)"
INFO_TXT="$(${CLI} state info --state-bucket "${STATE_BUCKET}")"
echo "${INFO_TXT}"
if ! echo "${INFO_TXT}" | grep -F -q "${STATE_BUCKET}"; then
  echo "[verify] FAIL: 'state info' output does not name the state bucket ${STATE_BUCKET}"
  exit 1
fi
# `Stacks:` count is bucket-wide; with our stack deployed it must be >= 1.
STACK_COUNT_TXT="$(echo "${INFO_TXT}" | sed -n 's/^Stacks:[[:space:]]*\([0-9][0-9]*\)$/\1/p')"
case "${STACK_COUNT_TXT}" in
  '' | *[!0-9]*)
    echo "[verify] FAIL: could not parse a numeric 'Stacks:' line from state info output"
    exit 1
    ;;
esac
if [ "${STACK_COUNT_TXT}" -lt 1 ]; then
  echo "[verify] FAIL: 'state info' reports ${STACK_COUNT_TXT} stacks while ${STACK} is deployed"
  exit 1
fi
echo "[verify] step 3 ok (Stacks: ${STACK_COUNT_TXT})"

echo "[verify] step 4: state info --json (bucket via CDKD_STATE_BUCKET env)"
INFO_JSON="$(CDKD_STATE_BUCKET="${STATE_BUCKET}" ${CLI} state info --json)"
echo "${INFO_JSON}"
EXPECTED_BUCKET="${STATE_BUCKET}" node -e '
  const d = JSON.parse(process.argv[1]);
  const fail = (msg) => {
    console.error(`[verify] FAIL: state info --json: ${msg}`);
    process.exit(1);
  };
  if (d.bucket !== process.env.EXPECTED_BUCKET) fail(`bucket=${d.bucket}, expected ${process.env.EXPECTED_BUCKET}`);
  if (d.bucketSource !== "env") fail(`bucketSource=${d.bucketSource}, expected env (CDKD_STATE_BUCKET)`);
  if (!Number.isInteger(d.schemaVersion)) fail(`schemaVersion=${JSON.stringify(d.schemaVersion)}, expected an integer while a stack is deployed`);
  if (!Number.isInteger(d.stackCount) || d.stackCount < 1) fail(`stackCount=${JSON.stringify(d.stackCount)}, expected >= 1`);
' "${INFO_JSON}"
echo "[verify] step 4 ok"

echo "[verify] step 5: cdkd destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 6: assert state + SSM parameter gone; state info still works"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "SSM parameter ${SSM_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}"
# stackCount is bucket-wide (parallel integ runs may own other stacks), so we
# only assert the command still succeeds post-destroy — the per-stack cleanup
# proof is the two assert_gone probes above.
${CLI} state info --state-bucket "${STATE_BUCKET}" --json >/dev/null
echo "[verify] step 6 ok"

trap - EXIT INT TERM
echo "[verify] PASS — cdkd state info (human + --json, flag + env bucket sources) verified end-to-end"
