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

STACK="CdkdCrGetAttDataExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Expected values the CR handler returns (see lib/cr-getatt-data-stack.ts).
# Seed is the literal "integ"; Region is the deploy region.
EXPECTED_COMPUTED="computed-integ"
EXPECTED_ANOTHER="another-${REGION}"
EXPECTED_NUMERIC="42"
# Issue #2274: the `NoEcho` arm. This literal is what the SECOND handler
# returns; it must reach AWS verbatim and must NOT appear anywhere in the
# persisted state blob. Not a credential -- an inert marker, chosen distinctive
# so the whole-blob grep below is meaningful and cannot collide with the three
# needles above.
EXPECTED_NOECHO="noecho-token-integ"
SECRET_MASK="***"

# SSM parameter names (must match parameterName in the stack, with id=STACK).
PARAM_PREFIX="/cdkd-integ/cr-getatt-data/${STACK}"
PARAM_COMPUTED="${PARAM_PREFIX}/computed"
PARAM_ANOTHER="${PARAM_PREFIX}/another"
PARAM_NUMERIC="${PARAM_PREFIX}/numeric"
PARAM_NOECHO="${PARAM_PREFIX}/noecho"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

LAMBDA_ARNS=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Best-effort delete of the SSM parameters in case a partial destroy left them.
  for p in "${PARAM_COMPUTED}" "${PARAM_ANOTHER}" "${PARAM_NUMERIC}" "${PARAM_NOECHO}"; do
    aws ssm delete-parameter --region "${REGION}" --name "${p}" >/dev/null 2>&1 || true
  done
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
LAMBDA_ARNS=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | join(" ")')
echo "    resolved backing Lambdas: ${LAMBDA_ARNS:-<none>}"

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

# --- Issue #2274: the `NoEcho` arm ------------------------------------------
#
# TWO assertions that must BOTH hold, because the design's whole point is that
# they pull in opposite directions:
#
#   1. AWS holds the REAL token. CloudFormation delivers a `NoEcho` custom
#      resource's `Data` to a dependent resource in the clear (measured against
#      real CloudFormation on the issue thread), so masking at CAPTURE would
#      have written the literal mask onto this live SSM parameter -- a data
#      corruption strictly worse than the disclosure being fixed.
#   2. cdkd's persisted state holds the MASK, everywhere: the custom resource's
#      own `attributes`, the dependent's resolved `properties`, and the outputs
#      bag an importing stack reads.
#
# The negative arm is the three parameters above plus the cleartext state
# assertions below: a custom resource that sets NO `NoEcho` must keep resolving
# and persisting in the clear.
echo "==> Asserting the NoEcho CR Data reached AWS in the CLEAR"
assert_param "${PARAM_NOECHO}" "${EXPECTED_NOECHO}" "NoEcho Token"

echo "==> Asserting the NoEcho CR Data is MASKED in cdkd state"
STATE_AFTER=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_AFTER}" ]; then
  echo "FAIL: could not re-read the state file for the NoEcho assertions" >&2
  exit 1
fi

# 2a. The custom resource's OWN attributes. Selected by the attribute KEY
# rather than by a logical id, since CDK derives the id from the construct path
# and a rename would silently make this vacuous.
NOECHO_ATTR=$(echo "${STATE_AFTER}" | jq -r '[.resources[] | select(.attributes.Token != null) | .attributes.Token] | first // "<absent>"')
if [ "${NOECHO_ATTR}" != "${SECRET_MASK}" ]; then
  echo "FAIL: state attributes.Token is '${NOECHO_ATTR}', expected '${SECRET_MASK}'" >&2
  echo "    => the handler's NoEcho declaration did not reach the redaction (issue #2274)" >&2
  exit 1
fi
echo "    OK: the NoEcho CR attributes.Token is masked in state"

# 2b. The DEPENDENT's resolved properties. This is the half a fix that only
# masked the custom resource's own record would miss: the SSM parameter that
# consumed the value carries it too, and `perResourceSecrets` is keyed by
# logical id, so it needs its own registration.
NOECHO_PROP=$(echo "${STATE_AFTER}" | jq -r --arg n "${PARAM_NOECHO}" '[.resources[] | select(.properties.Name == $n) | .properties.Value] | first // "<absent>"')
if [ "${NOECHO_PROP}" != "${SECRET_MASK}" ]; then
  echo "FAIL: the dependent SSM parameter's state Value is '${NOECHO_PROP}', expected '${SECRET_MASK}'" >&2
  echo "    => the consumer's resolved property was persisted in the clear (issue #2274)" >&2
  exit 1
fi
echo "    OK: the dependent's state Value is masked"

# 2c. The outputs bag, which is also what an importing stack reads.
OUT_NOECHO=$(echo "${STATE_AFTER}" | jq -r '.outputs.NoEchoValueResolved // "<absent>"')
if [ "${OUT_NOECHO}" != "${SECRET_MASK}" ]; then
  echo "FAIL: state output NoEchoValueResolved is '${OUT_NOECHO}', expected '${SECRET_MASK}'" >&2
  exit 1
fi
echo "    OK: state output NoEchoValueResolved is masked"

# 2d. The WHOLE blob. The three checks above name the routes we know about;
# this one is what catches a fourth (observedProperties, a nested copy, an
# events record folded into state) without having to enumerate it.
if printf '%s' "${STATE_AFTER}" | grep -qF "${EXPECTED_NOECHO}"; then
  echo "FAIL: the NoEcho token '${EXPECTED_NOECHO}' appears somewhere in the persisted state blob" >&2
  echo "${STATE_AFTER}" | jq . >&2
  exit 1
fi
echo "    OK: the NoEcho token appears NOWHERE in the state blob"

# 2e. The value cdkd ITSELF SUPPLIED must survive. The handler ECHOES its own
# `ServiceToken` back inside the same `NoEcho` `Data`, which is what the CDK
# `Provider` samples encourage. Registering an echoed input as a redaction
# needle rewrites `properties.ServiceToken` to '***' in the very record
# `CustomResourceProvider.delete` reads it back from -- and '***' is a TRUTHY
# STRING that passes both of that method's guards, so the delete would try to
# invoke a "Lambda" named '***'. Asserted on AWS-shaped data rather than on a
# fixed literal, because the ARN is CDK-derived.
echo "==> Asserting the echoed ServiceToken survived the redaction"
NOECHO_SERVICE_TOKEN=$(echo "${STATE_AFTER}" | jq -r '[.resources[] | select(.attributes.Token != null) | .properties.ServiceToken] | first // "<absent>"')
case "${NOECHO_SERVICE_TOKEN}" in
  arn:aws*:lambda:*:function:*)
    echo "    OK: the NoEcho CR ServiceToken is still an addressable Lambda ARN"
    ;;
  *)
    echo "FAIL: the NoEcho CR's state ServiceToken is '${NOECHO_SERVICE_TOKEN}', expected a Lambda ARN" >&2
    echo "    => the handler's ECHO of a cdkd-supplied input was registered as a redaction needle" >&2
    echo "       (issue #2274 review): a masked ServiceToken makes destroy invoke a Lambda named '***'" >&2
    exit 1
    ;;
esac

# --- The NEGATIVE arm, in state -------------------------------------------
# A custom resource WITHOUT `NoEcho` must be untouched by any of this. The
# existing assertions cover AWS and `state.outputs`; these cover the two state
# bags the arm above masks, so a redaction that over-applied would fail here.
CLEAR_ATTR=$(echo "${STATE_AFTER}" | jq -r '[.resources[] | select(.attributes.ComputedValue != null) | .attributes.ComputedValue] | first // "<absent>"')
if [ "${CLEAR_ATTR}" != "${EXPECTED_COMPUTED}" ]; then
  echo "FAIL: the non-NoEcho CR's state attributes.ComputedValue is '${CLEAR_ATTR}', expected '${EXPECTED_COMPUTED}'" >&2
  echo "    => redaction over-applied to a custom resource that declared no NoEcho" >&2
  exit 1
fi
CLEAR_PROP=$(echo "${STATE_AFTER}" | jq -r --arg n "${PARAM_COMPUTED}" '[.resources[] | select(.properties.Name == $n) | .properties.Value] | first // "<absent>"')
if [ "${CLEAR_PROP}" != "${EXPECTED_COMPUTED}" ]; then
  echo "FAIL: the non-NoEcho dependent's state Value is '${CLEAR_PROP}', expected '${EXPECTED_COMPUTED}'" >&2
  exit 1
fi
echo "    OK: the non-NoEcho custom resource and its dependent stay in the clear in state"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# The CR + backing Lambda + the three SSM parameters must all be gone.
for p in "${PARAM_COMPUTED}" "${PARAM_ANOTHER}" "${PARAM_NUMERIC}" "${PARAM_NOECHO}"; do
  assert_gone "SSM parameter ${p} still exists after destroy (orphan)" aws ssm get-parameter --region "${REGION}" --name "${p}"
done
echo "    OK: all four SSM parameters are gone"

for arn in ${LAMBDA_ARNS}; do
  assert_gone "backing Lambda ${arn} still exists after destroy (orphan)" aws lambda get-function --region "${REGION}" --function-name "${arn}"
done
if [ -n "${LAMBDA_ARNS}" ]; then
  echo "    OK: every backing Lambda is gone"
fi

echo ""
echo "=== PASS: Custom Resource Data GetAtt -> dependent property integ ==="
