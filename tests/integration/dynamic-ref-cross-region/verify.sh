#!/usr/bin/env bash
# verify.sh - cdkd dynamic-ref-cross-region integ (issue #1933).
#
# Failure-seeking test for the REGION dimension of cdkd's resolved
# dynamic-reference cache. `{{resolve:ssm:...}}` / `{{resolve:secretsmanager:...}}`
# values are REGIONAL: the same NAME in us-east-1 and us-west-2 is two
# different values. cdkd's cache used to be a process-global map keyed by the
# expression STRING alone, so in a run spanning regions the first region to
# resolve an expression won it for every later stack in every other region.
#
# The fixture:
#   1. creates the SAME SSM parameter name in TWO regions, with DIFFERENT
#      values (region A: cdkd-dynref-region-a / region B: cdkd-dynref-region-b);
#   2. deploys TWO stacks — one per region — in ONE cdkd process, each
#      declaring an SSM String parameter whose Value is the identical literal
#      `{{resolve:ssm:<shared name>}}` expression;
#   3. asserts each region's echo parameter carries ITS OWN region's value.
#
# Pre-fix, step 3 fails on the second stack: its resolution hits the cache
# populated by the first stack and writes the first region's value into the
# second region's resource.
#
# `--stack-concurrency 1` is REQUIRED and is not a convenience: cdkd installs
# the per-stack region-pinned AWS clients into a process-global singleton
# (`setAwsClients` in src/cli/commands/deploy.ts), so with the default
# concurrency of 4 two multi-region stacks race for the ambient clients — a
# hazard deploy.ts already documents and issue #1934 tracks. Serial deploy is
# the mode this fixture pins; the concurrent case is #1934's to verify.
#
# Only PUBLIC test values are used (SSM `String` parameters, never
# `SecureString`), so nothing here needs masking — the region dimension is a
# property of the CACHE KEY, not of the secret-ness of the value.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - region A, defaults to us-east-1
#   SECOND_REGION - region B, defaults to us-west-2 (auto-flips if it equals A)

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

REGION_A="${AWS_REGION:-us-east-1}"
REGION_B="${SECOND_REGION:-us-west-2}"
if [ "${REGION_A}" = "${REGION_B}" ]; then
  # The whole point is the region difference; flip B if the caller's base
  # region happens to be us-west-2.
  REGION_B="us-east-1"
fi
export AWS_REGION="${REGION_A}"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/dynamic-ref-cross-region"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found — run 'vp run build' first" >&2
  exit 1
fi
CLI="node ${LOCAL_DIST}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

STACK_A="CdkdDynamicRefCrossRegionAStack"
STACK_B="CdkdDynamicRefCrossRegionBStack"
ECHO_PARAM_A="${STACK_A}-echo"
ECHO_PARAM_B="${STACK_B}-echo"

SOURCE_PARAM="/cdkd-test/dynref-cross-region-${ACCOUNT_ID}"
EXPECTED_A="cdkd-dynref-region-a"
EXPECTED_B="cdkd-dynref-region-b"

export CDKD_IT_DYNREF_REGION_A="${REGION_A}"
export CDKD_IT_DYNREF_REGION_B="${REGION_B}"
export CDKD_IT_DYNREF_SOURCE_PARAM="${SOURCE_PARAM}"

echo "[verify] region-a=${REGION_A} region-b=${REGION_B} source-param=${SOURCE_PARAM}"

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# Seed an `rc` so a signal-triggered cleanup does not read an unset variable
# as success and skip its own teardown.
rc=0
cleanup() {
  rc=$?
  echo "[verify] cleanup (exit ${rc})"
  # Best-effort stack teardown first, so the echo parameters go with their
  # stacks and cdkd state is not left pointing at deleted resources.
  ${CLI} destroy "${STACK_A}" "${STACK_B}" \
    --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  # Then direct AWS cleanup in case destroy itself is what broke.
  aws ssm delete-parameter --name "${ECHO_PARAM_A}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${ECHO_PARAM_B}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_B}" >/dev/null 2>&1 || true
  # Stale state/lock keys, in case the destroy above could not run.
  for region in "${REGION_A}" "${REGION_B}"; do
    for stack in "${STACK_A}" "${STACK_B}"; do
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${region}/state.json" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${region}/lock.json" >/dev/null 2>&1 || true
    done
  done
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Phase 1: seed the SAME parameter name in both regions with DIFFERENT values"
aws ssm put-parameter --name "${SOURCE_PARAM}" --type String \
  --value "${EXPECTED_A}" --overwrite --region "${REGION_A}" >/dev/null
aws ssm put-parameter --name "${SOURCE_PARAM}" --type String \
  --value "${EXPECTED_B}" --overwrite --region "${REGION_B}" >/dev/null
echo "    OK: ${SOURCE_PARAM} = ${EXPECTED_A} (${REGION_A}) / ${EXPECTED_B} (${REGION_B})"

echo "==> Phase 2: deploy BOTH stacks in ONE cdkd process (serial)"
${CLI} deploy "${STACK_A}" "${STACK_B}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-concurrency 1 \
  --yes

echo "==> Phase 3: assert each region's echo carries ITS OWN region's value"
ACTUAL_A="$(aws ssm get-parameter --name "${ECHO_PARAM_A}" --region "${REGION_A}" \
  --query 'Parameter.Value' --output text)"
ACTUAL_B="$(aws ssm get-parameter --name "${ECHO_PARAM_B}" --region "${REGION_B}" \
  --query 'Parameter.Value' --output text)"

echo "    ${REGION_A}: ${ECHO_PARAM_A} = ${ACTUAL_A}"
echo "    ${REGION_B}: ${ECHO_PARAM_B} = ${ACTUAL_B}"

if [ "${ACTUAL_A}" != "${EXPECTED_A}" ]; then
  echo "FAIL: ${ECHO_PARAM_A} (${REGION_A}) resolved to '${ACTUAL_A}', expected '${EXPECTED_A}'" >&2
  exit 1
fi
if [ "${ACTUAL_B}" = "${EXPECTED_A}" ]; then
  echo "FAIL: ${ECHO_PARAM_B} (${REGION_B}) carries region A's value '${ACTUAL_A}' — the" >&2
  echo "      dynamic-reference cache leaked one region's value into another (issue #1933)." >&2
  exit 1
fi
if [ "${ACTUAL_B}" != "${EXPECTED_B}" ]; then
  echo "FAIL: ${ECHO_PARAM_B} (${REGION_B}) resolved to '${ACTUAL_B}', expected '${EXPECTED_B}'" >&2
  exit 1
fi
echo "    OK: each region resolved its own value"

echo "==> Phase 4: destroy both stacks"
${CLI} destroy "${STACK_A}" "${STACK_B}" \
  --state-bucket "${STATE_BUCKET}" --force

echo "==> Phase 5: assert no leftovers"
assert_gone "${ECHO_PARAM_A} still exists in ${REGION_A} after destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM_A}" --region "${REGION_A}"
assert_gone "${ECHO_PARAM_B} still exists in ${REGION_B} after destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM_B}" --region "${REGION_B}"
assert_gone "state.json for ${STACK_A} still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_A}/${REGION_A}/state.json"
assert_gone "state.json for ${STACK_B} still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_B}/${REGION_B}/state.json"

echo "==> Phase 6: delete the seeded source parameters"
aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_A}" >/dev/null
aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_B}" >/dev/null
assert_gone "source parameter still exists in ${REGION_A}" \
  aws ssm get-parameter --name "${SOURCE_PARAM}" --region "${REGION_A}"
assert_gone "source parameter still exists in ${REGION_B}" \
  aws ssm get-parameter --name "${SOURCE_PARAM}" --region "${REGION_B}"

trap - EXIT INT TERM
echo "PASS: dynamic-ref-cross-region"
