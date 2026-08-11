#!/usr/bin/env bash
# verify.sh — cdkd EventBridge custom bus + EventBusPolicy integ.
#
# First AWS::Events::EventBusPolicy coverage in the integ suite (Cloud
# Control fallback — no SDK provider). Asserts the policy statement reaches
# AWS, a pure key ADDITION (a Condition block) is applied in place WITHOUT
# dropping the untouched statement keys, the `cdkd diff` for that addition
# renders symmetrically (issue #1608 regression guard: the old side must be
# `{}`, not the full statement), and destroy removes policy-then-bus cleanly.
#
# Phases:
#   1. Deploy; assert the policy statement carries Sid/Action and NO
#      Condition.
#   2. `cdkd diff` under CDKD_TEST_UPDATE=true; assert the #1608 symmetric
#      shape (old: {} / new: only the added Condition, no Principal echo).
#   3. Re-deploy with CDKD_TEST_UPDATE=true; assert the deployed statement
#      keeps Sid/Principal/Action/Resource AND gains the Condition.
#   4. Destroy + assert bus is gone and the cdkd state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""

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

STACK="CdkdEventbusPolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BUS_NAME="cdkd-integ-buspolicy-bus"

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
  aws events remove-permission --statement-id 'cdkd-integ-buspolicy-stmt' --event-bus-name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline (statement without Condition) ---------------
echo "==> Phase 1: deploy custom bus + bus policy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_P1="$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
if ! printf '%s' "${POLICY_P1}" | grep -q '"Sid":"cdkd-integ-buspolicy-stmt"'; then
  echo "FAIL: bus policy statement missing after Phase 1: ${POLICY_P1}" >&2
  exit 1
fi
if ! printf '%s' "${POLICY_P1}" | grep -q '"Action":"events:PutEvents"'; then
  echo "FAIL: bus policy Action missing after Phase 1: ${POLICY_P1}" >&2
  exit 1
fi
if printf '%s' "${POLICY_P1}" | grep -q '"Condition"'; then
  echo "FAIL: bus policy unexpectedly has a Condition after Phase 1: ${POLICY_P1}" >&2
  exit 1
fi
echo "    bus policy statement live (no Condition yet)"

# --- Phase 2: diff for the Condition addition must render symmetrically ---
echo "==> Phase 2: cdkd diff for the pure key addition (#1608 shape)"
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}")"
printf '%s\n' "${DIFF_OUT}"
if ! printf '%s' "${DIFF_OUT}" | grep -qF 'old: {}'; then
  echo "FAIL: diff old side is not '{}' for a pure key addition (issue 1608 regression)" >&2
  exit 1
fi
if ! printf '%s' "${DIFF_OUT}" | grep -q '"Condition"'; then
  echo "FAIL: diff new side does not show the added Condition" >&2
  exit 1
fi
if printf '%s' "${DIFF_OUT}" | grep -q '"Principal"'; then
  echo "FAIL: diff echoes unchanged statement keys (issue 1608 regression: reads as removal)" >&2
  exit 1
fi
echo "    diff renders the addition as old: {} / new: {Condition}"

# --- Phase 3: apply the Condition addition (in-place UPDATE) --------------
echo "==> Phase 3: re-deploy with the Condition added"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_P3="$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
for token in '"Sid":"cdkd-integ-buspolicy-stmt"' '"Action":"events:PutEvents"' '"Principal"' '"Resource"' '"Condition"' 'cdkd.integ'; do
  if ! printf '%s' "${POLICY_P3}" | grep -qF "${token}"; then
    echo "FAIL: bus policy statement lost ${token} after the Condition update: ${POLICY_P3}" >&2
    exit 1
  fi
done
echo "    full statement retained WITH the added Condition"

# --- Phase 4: destroy -----------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "event bus ${BUS_NAME} still exists after destroy" aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"
echo "    bus policy + bus deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — EventBusPolicy deploy/diff/update/destroy, all 4 phases passed"
