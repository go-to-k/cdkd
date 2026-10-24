#!/usr/bin/env bash
# verify.sh — stack-level `terminationProtection` (go-to-k/cdkd#5238).
#
# `CdkdTerminationProtection` holds one SSM StringParameter and sets
# `terminationProtection: true` unless `CDKD_TEST_UPDATE=true` flips it off in
# the CDK code. The run proves:
#   1. A deploy with it on records `terminationProtection: true` in state.
#   2. `cdkd destroy --force` refuses (exit 2); nothing is deleted.
#   3. `cdkd state destroy` (no CDK app) refuses the same way (exit 2), naming
#      `--remove-protection` as the bypass; nothing is deleted.
#   4. Flipping it off in code and redeploying (nothing else changes) clears
#      the recorded flag.
#   5. Turning it back on, then `cdkd state destroy --remove-protection`
#      succeeds (exit 0) and removes both the parameter and the state record.
#
# The run uses a NON-default --state-prefix.
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

STACK="CdkdTerminationProtection"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="cdkd-integ-termination-protection"
STATE_KEY="${PREFIX}/${STACK}/${REGION}/state.json"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cdkd() { node "${LOCAL_DIST}" "$@"; }

# `--state-prefix` and `--region` (but never the bucket flag, whose form
# differs by command — see docs/integ-fixture-conventions.md's
# "`state destroy` must pass `--state-bucket`") shared by every call.
COMMON_FLAGS=(--state-prefix "${PREFIX}" --region "${REGION}")

# The physical id of the ONE state resource whose logical id starts with $1.
physical_id_of() { # usage: physical_id_of <logical-id-prefix> <resources-listing>
  local matches
  matches="$(printf '%s\n' "$2" | awk -v p="$1" 'index($1, p) == 1 { print $3 }')"
  if [ "$(printf '%s\n' "${matches}" | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one state resource starting with $1, got: ${matches:-<none>}" >&2
    return 1
  fi
  printf '%s' "${matches}"
}

# The state record's `terminationProtection` field, read fresh from S3:
# "true" or "absent". A strict read (no silencing) — a missing object or a
# throttle fails the run loudly rather than being misread as either value.
state_termination_protection() {
  local tmp result
  tmp="$(mktemp)"
  aws s3api get-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" "${tmp}" >/dev/null
  result="$(node -e '
    const fs = require("fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(s.terminationProtection === true ? "true" : "absent");
  ' "${tmp}")"
  rm -f "${tmp}"
  printf '%s' "${result}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # `state destroy` both removes the AWS resource AND the state record, so
    # this alone reaches the SSM parameter -- which carries no deterministic
    # name to delete directly. `--remove-protection` bypasses the very guard
    # this fixture exercises. Called directly (not through the `cdkd()`
    # wrapper): `tests/unit/scripts/integ-state-bucket.test.ts` only
    # recognizes the `node "${LOCAL_DIST}" state destroy` spelling.
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      "${COMMON_FLAGS[@]}" --yes --remove-protection >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/${STACK}/${REGION}/create-tokens.json" >/dev/null 2>&1 || true
  fi
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

# --- Phase 1: deploy, protected -----------------------------------------
echo "==> Phase 1: deploy (terminationProtection: true)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${COMMON_FLAGS[@]}" --yes

RES_A="$(cdkd state resources "${STACK}" --state-bucket "${STATE_BUCKET:-}" "${COMMON_FLAGS[@]}")"
PARAM_ID="$(physical_id_of Param "${RES_A}")"
[ -n "${PARAM_ID}" ] || { echo "FAIL: PARAM_ID is empty" >&2; exit 1; }
echo "    parameter ${PARAM_ID}"

TP1="$(state_termination_protection)"
[ "${TP1}" = "true" ] \
  || { echo "FAIL: state record lacks terminationProtection: true after phase 1 deploy (got: ${TP1})" >&2; exit 1; }
echo "    state record carries terminationProtection: true"

# --- Phase 2: destroy --force refuses ------------------------------------
echo "==> Phase 2: destroy --force is refused by stack-level terminationProtection"
set +e
OUT_DESTROY="$(node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${COMMON_FLAGS[@]}" --force 2>&1)"
rc_destroy=$?
set -e
printf '%s\n' "${OUT_DESTROY}"
[ "${rc_destroy}" -eq 2 ] \
  || { echo "FAIL: destroy --force exited ${rc_destroy}, not 2" >&2; exit 1; }
# Sentinel: exit 2 alone is any per-stack failure; this is the code's refusal.
grep -qF -- 'has terminationProtection: true' <<<"${OUT_DESTROY}" \
  || { echo "FAIL: destroy exited 2 without the termination-protection refusal" >&2; exit 1; }
aws ssm get-parameter --name "${PARAM_ID}" --region "${REGION}" --query 'Parameter.Name' --output text >/dev/null
echo "    destroy --force exited 2, parameter still exists"

# --- Phase 2b: the RECORDED protection refuses, with the code's turned off --
# The code no longer protects the stack, but it was not redeployed: the
# deployed stack is still protected, as in CloudFormation.
echo "==> Phase 2b: destroy with protection off in code but not redeployed is refused"
set +e
OUT_DESTROY_REC="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${COMMON_FLAGS[@]}" --force 2>&1)"
rc_destroy_rec=$?
set -e
printf '%s\n' "${OUT_DESTROY_REC}"
[ "${rc_destroy_rec}" -eq 2 ] \
  || { echo "FAIL: destroy of a stack deployed protected exited ${rc_destroy_rec}, not 2" >&2; exit 1; }
grep -qF -- 'was last deployed with terminationProtection: true' <<<"${OUT_DESTROY_REC}" \
  || { echo "FAIL: destroy exited 2 without the recorded-protection refusal" >&2; exit 1; }
aws ssm get-parameter --name "${PARAM_ID}" --region "${REGION}" --query 'Parameter.Name' --output text >/dev/null
echo "    refused from the record, parameter still exists"

# --- Phase 3: state destroy refuses --------------------------------------
echo "==> Phase 3: state destroy (no --remove-protection) is refused"
set +e
OUT_STATE_DESTROY="$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
  "${COMMON_FLAGS[@]}" --yes 2>&1)"
rc_state_destroy=$?
set -e
printf '%s\n' "${OUT_STATE_DESTROY}"
[ "${rc_state_destroy}" -eq 2 ] \
  || { echo "FAIL: state destroy (no --remove-protection) exited ${rc_state_destroy}, not 2" >&2; exit 1; }
grep -qF -- '--remove-protection' <<<"${OUT_STATE_DESTROY}" \
  || { echo "FAIL: refusal does not mention --remove-protection" >&2; exit 1; }
grep -qF -- 'was last deployed with terminationProtection: true' <<<"${OUT_STATE_DESTROY}" \
  || { echo "FAIL: refusal is not the recorded-protection refusal" >&2; exit 1; }
aws ssm get-parameter --name "${PARAM_ID}" --region "${REGION}" --query 'Parameter.Name' --output text >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    state destroy exited 2 naming --remove-protection, parameter and state record still exist"

# --- Phase 4: redeploy with protection off in code -----------------------
echo "==> Phase 4: redeploy with terminationProtection off in code"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${COMMON_FLAGS[@]}" --yes

TP4="$(state_termination_protection)"
[ "${TP4}" = "absent" ] \
  || { echo "FAIL: state record still carries terminationProtection after turning it off in code (got: ${TP4})" >&2; exit 1; }
echo "    state record no longer carries a terminationProtection key"

# --- Phase 5: redeploy protected, then remove-protection destroy succeeds --
echo "==> Phase 5: redeploy (terminationProtection: true again), then state destroy --remove-protection"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${COMMON_FLAGS[@]}" --yes

TP5="$(state_termination_protection)"
[ "${TP5}" = "true" ] \
  || { echo "FAIL: state record lacks terminationProtection: true after re-enabling it (got: ${TP5})" >&2; exit 1; }

set +e
OUT_REMOVE="$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
  "${COMMON_FLAGS[@]}" --yes --remove-protection 2>&1)"
rc_remove=$?
set -e
printf '%s\n' "${OUT_REMOVE}"
[ "${rc_remove}" -eq 0 ] \
  || { echo "FAIL: state destroy --remove-protection exited ${rc_remove}, not 0" >&2; exit 1; }

assert_gone "parameter ${PARAM_ID} still exists after the --remove-protection teardown" \
  aws ssm get-parameter --name "${PARAM_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after the --remove-protection teardown" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    parameter and state record removed"

echo "[verify] PASS — cdkd honors stack-level terminationProtection on destroy and state destroy, --remove-protection bypasses it"
