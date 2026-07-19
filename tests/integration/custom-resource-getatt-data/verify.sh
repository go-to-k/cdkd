#!/usr/bin/env bash
# verify.sh — Custom Resource `Data` GetAtt -> dependent property integ.
#
# Failure-seeking: a Custom Resource returns `Data: { ComputedValue, Another,
# NumericValue }`; three SSM parameters consume those via
# `Fn::GetAtt(CR, '<key>')`. After deploy, each SSM parameter is read back
# from AWS and its Value asserted to equal the value the CR handler returned.
# This proves the CR `Data` attribute resolved THROUGH cdkd's intrinsic
# resolver INTO the dependent resource's property (fragile per #756 / #804 —
# CR attributes only exist after the CR Lambda runs). If the GetAtt-of-CR-Data
# resolves wrong/empty or the deploy fails, this FAILs with specifics.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdCrGetAttDataExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Expected values the CR handler returns (see lib/cr-getatt-data-stack.ts).
# Seed is the literal "integ"; Region is the deploy region.
EXPECTED_COMPUTED="computed-integ"
EXPECTED_ANOTHER="another-${REGION}"
EXPECTED_NUMERIC="42"

# SSM parameter names (must match parameterName in the stack, with id=STACK).
PARAM_PREFIX="/cdkd-integ/cr-getatt-data/${STACK}"
PARAM_COMPUTED="${PARAM_PREFIX}/computed"
PARAM_ANOTHER="${PARAM_PREFIX}/another"
PARAM_NUMERIC="${PARAM_PREFIX}/numeric"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

LAMBDA_ARN=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Best-effort delete of the SSM parameters in case a partial destroy left them.
  for p in "${PARAM_COMPUTED}" "${PARAM_ANOTHER}" "${PARAM_NUMERIC}"; do
    aws ssm delete-parameter --region "${REGION}" --name "${p}" >/dev/null 2>&1 || true
  done
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the backing Lambda ARN (CDK auto-named) from state so the
# post-destroy orphan check can target it precisely.
LAMBDA_ARN=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first // ""')
echo "    resolved backing Lambda: ${LAMBDA_ARN:-<none>}"

# Sanity: the CR's resolved ComputedValue should be in state.outputs too
# (belt-and-suspenders cross-check alongside the on-AWS SSM read below).
OUT_COMPUTED=$(echo "${STATE}" | jq -r '.outputs.ComputedValueResolved // ""')
if [ "${OUT_COMPUTED}" != "${EXPECTED_COMPUTED}" ]; then
  echo "FAIL: state output ComputedValueResolved is '${OUT_COMPUTED}', expected '${EXPECTED_COMPUTED}'" >&2
  echo "    (the CR Data attribute did NOT resolve into the output — GetAtt-of-CR-Data broken)" >&2
  echo "${STATE}" | jq .outputs >&2
  exit 1
fi
echo "    OK: state output ComputedValueResolved == '${EXPECTED_COMPUTED}'"

# --- Assertion: each SSM parameter Value on AWS == the CR's returned Data ---
# This is the load-bearing check: it proves the CR `Data.<key>` attribute
# flowed THROUGH the intrinsic resolver INTO the dependent SSM parameter's
# Value property. A blank/wrong value would otherwise pass silently.
assert_param() {
  local name="$1" expected="$2" label="$3"
  set +e
  local out rc
  out=$(aws ssm get-parameter --region "${REGION}" --name "${name}" \
    --query 'Parameter.Value' --output text 2>/tmp/cr-getatt-ssm-err)
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: get-parameter exited ${rc} for ${name} (${label})" >&2
    cat /tmp/cr-getatt-ssm-err >&2 || true
    exit 1
  fi
  if [ "${out}" != "${expected}" ]; then
    echo "FAIL: SSM ${label} (${name}) Value is '${out}', expected '${expected}'" >&2
    echo "    => Fn::GetAtt(CR, '<key>') of the CR response Data did NOT resolve correctly into the dependent SSM parameter." >&2
    exit 1
  fi
  echo "    OK: ${label} (${name}) == '${expected}' on AWS"
}

echo "==> Asserting CR Data resolved into each dependent SSM parameter"
assert_param "${PARAM_COMPUTED}" "${EXPECTED_COMPUTED}" "ComputedValue"
assert_param "${PARAM_ANOTHER}" "${EXPECTED_ANOTHER}" "Another"
assert_param "${PARAM_NUMERIC}" "${EXPECTED_NUMERIC}" "NumericValue"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# The CR + backing Lambda + the three SSM parameters must all be gone.
for p in "${PARAM_COMPUTED}" "${PARAM_ANOTHER}" "${PARAM_NUMERIC}"; do
  if aws ssm get-parameter --region "${REGION}" --name "${p}" >/dev/null 2>&1; then
    echo "FAIL: SSM parameter ${p} still exists after destroy (orphan)" >&2
    exit 1
  fi
done
echo "    OK: all three SSM parameters are gone"

if [ -n "${LAMBDA_ARN}" ]; then
  if aws lambda get-function --region "${REGION}" --function-name "${LAMBDA_ARN}" >/dev/null 2>&1; then
    echo "FAIL: backing Lambda ${LAMBDA_ARN} still exists after destroy (orphan)" >&2
    exit 1
  fi
  echo "    OK: backing Lambda is gone"
fi

echo ""
echo "=== PASS: Custom Resource Data GetAtt -> dependent property integ ==="
