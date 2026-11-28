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
# Phases: 1 deploy + assertions (incl. the NoEcho arms, #2274 / #2453),
# 2 redeploy with a rotated NoEcho token (#2453), 3 the secret-echo arm
# (go-to-k/cdkd#7182: secrets a handler echoes in its `Data` values and keys),
# 4 destroy and sweep every state object version.
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

# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdCrGetAttDataExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# go-to-k/cdkd#7182: the secret-echo arm's inert literals, the defaults of its
# NoEcho template parameters (SECRET_ECHO in lib/cr-getatt-data-stack.ts).
# ECHO_SECRET must appear in NO state object version. SHORT_SECRET is three
# characters, so it is matched as a whole JSON string ("q~7"), never as a
# substring: the over-mask control key `Xq~7x` legitimately contains it.
# NAMED_SECRET is spelled by a template Fn::GetAtt, so the key holding it is
# template text and is kept by design.
# The arm is deployed ONLY by phase 3, which sets CDKD_TEST_SECRET_ECHO on its
# own commands; one exported by the caller would deploy it in phase 1 and void
# phase 3's premise, so it is dropped here.
unset CDKD_TEST_SECRET_ECHO
ECHO_SECRET="offtpl-echo-secret-7182"
NAMED_SECRET="offtpl-named-secret-7182"
SHORT_SECRET="q~7"
SECRET_ECHO_TYPE="Custom::CdkdSecretEcho"
# The phase-3 capture; may hold a secret-echo value on a failed run.
SECRET_ECHO_LOG=""

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
# Issue #2453: the same token EMBEDDED in a longer leaf. Phase 2 re-runs the
# handler with a new seed, so the rotated token must reach AWS through the
# embedded dependent although its record holds `***` before and after.
ROTATED_SEED="rotated"
EXPECTED_NOECHO_ROTATED="noecho-token-${ROTATED_SEED}"
embedded_value() { printf 'postgres://integ-user:%s@db.example.invalid/app' "$1"; }

# SSM parameter names (must match parameterName in the stack, with id=STACK).
PARAM_PREFIX="/cdkd-integ/cr-getatt-data/${STACK}"
PARAM_COMPUTED="${PARAM_PREFIX}/computed"
PARAM_ANOTHER="${PARAM_PREFIX}/another"
PARAM_NUMERIC="${PARAM_PREFIX}/numeric"
PARAM_NOECHO="${PARAM_PREFIX}/noecho"
PARAM_NOECHO_EMBEDDED="${PARAM_PREFIX}/noecho-embedded"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

LAMBDA_ARNS=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # With the secret-echo arm IN the template first: a custom resource whose
    # record holds a NoEcho input as `***` is deleted only by a command that
    # holds the template to re-resolve it (go-to-k/cdkd#4682); `state destroy`
    # skips its Delete handler by design. A clean stack makes this a no-op.
    CDKD_TEST_SECRET_ECHO=true node "${LOCAL_DIST}" destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --force
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
  for p in "${PARAM_COMPUTED}" "${PARAM_ANOTHER}" "${PARAM_NUMERIC}" "${PARAM_NOECHO}" "${PARAM_NOECHO_EMBEDDED}"; do
    aws ssm delete-parameter --region "${REGION}" --name "${p}" >/dev/null 2>&1 || true
  done
  # The historical state versions: the secret-echo arm keeps the GetAtt-spelled
  # key (template text) by design. `noncurrent`, so a live state.json a later
  # `cdkd state destroy` needs survives a failed run.
  if [ -n "${STATE_BUCKET:-}" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" noncurrent || true
  fi
  [ -z "${SECRET_ECHO_LOG}" ] || rm -f "${SECRET_ECHO_LOG}"
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
assert_param "${PARAM_NOECHO_EMBEDDED}" "$(embedded_value "${EXPECTED_NOECHO}")" "NoEcho Token embedded"

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

# 2c'. Issue #2453: the EMBEDDED dependent and output. The leaf merely
# CONTAINS the token, so it must be masked WHOLE -- a whole-leaf `***` is what
# `drift --revert` / `--accept` and the rollback replay recognise and refuse.
assert_embedded_masked() {
  local state="$1" prop out
  prop=$(echo "${state}" | jq -r --arg n "${PARAM_NOECHO_EMBEDDED}" '[.resources[] | select(.properties.Name == $n) | .properties.Value] | first // "<absent>"')
  if [ "${prop}" != "${SECRET_MASK}" ]; then
    echo "FAIL: the embedded dependent's state Value is '${prop}', expected '${SECRET_MASK}'" >&2
    echo "    => a NoEcho value embedded in a longer leaf reached state (issue #2453)" >&2
    exit 1
  fi
  out=$(echo "${state}" | jq -r '.outputs.NoEchoEmbeddedResolved // "<absent>"')
  if [ "${out}" != "${SECRET_MASK}" ]; then
    echo "FAIL: state output NoEchoEmbeddedResolved is '${out}', expected '${SECRET_MASK}'" >&2
    exit 1
  fi
  echo "    OK: the embedded dependent's state Value and the embedding output are masked whole"
}
assert_embedded_masked "${STATE_AFTER}"

# 2d. The WHOLE blob. The three checks above name the routes we know about;
# this one is what catches a fourth (observedProperties, a nested copy, an
# events record folded into state) without having to enumerate it.
if grep -qF "${EXPECTED_NOECHO}" <<<"${STATE_AFTER}"; then
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
assert_service_token_addressable() {
  local token
  token=$(echo "$1" | jq -r '[.resources[] | select(.attributes.Token != null) | .properties.ServiceToken] | first // "<absent>"')
  case "${token}" in
    arn:aws*:lambda:*:function:*)
      echo "    OK: the NoEcho CR ServiceToken is still an addressable Lambda ARN"
      ;;
    *)
      echo "FAIL: the NoEcho CR's state ServiceToken is '${token}', expected a Lambda ARN" >&2
      echo "    => the handler's ECHO of a cdkd-supplied input was registered as a redaction needle" >&2
      echo "       (issue #2274 review): a masked ServiceToken makes destroy invoke a Lambda named '***'" >&2
      exit 1
      ;;
  esac
}
assert_service_token_addressable "${STATE_AFTER}"

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

# --- Phase 2: re-run the NoEcho handler with a NEW token (issue #2453) ----
# The embedded dependent's record holds `***` before and after, so a no-change
# skip comparing the redacted bags would call it unchanged and leave the OLD
# token on AWS. The new value must reach AWS, and still reach no state.
echo "==> Phase 2: redeploy with a rotated NoEcho token"
CDKD_TEST_NOECHO_SEED="${ROTATED_SEED}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_param "${PARAM_NOECHO}" "${EXPECTED_NOECHO_ROTATED}" "rotated NoEcho Token"
assert_param "${PARAM_NOECHO_EMBEDDED}" "$(embedded_value "${EXPECTED_NOECHO_ROTATED}")" "rotated NoEcho Token embedded"

STATE_ROTATED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_ROTATED}" ]; then
  echo "FAIL: could not re-read the state file after the rotated deploy" >&2
  exit 1
fi
assert_embedded_masked "${STATE_ROTATED}"
for token in "${EXPECTED_NOECHO}" "${EXPECTED_NOECHO_ROTATED}"; do
  if grep -qF "${token}" <<<"${STATE_ROTATED}"; then
    echo "FAIL: the NoEcho token '${token}' appears in the state blob after the rotated deploy" >&2
    exit 1
  fi
done
echo "    OK: neither NoEcho token appears in the state blob after the rotated deploy"
# The rotated deploy re-ran the handler, which is when an over-mask of the
# ServiceToken would be written -- and the destroy below reads it.
assert_service_token_addressable "${STATE_ROTATED}"

# --- Phase 3: the secret-echo arm (go-to-k/cdkd#7182) ------------------
# A custom resource is handed three NoEcho parameter values and its handler
# returns them in `Data`: the echo secret as a VALUE under a key the template
# never reads (#7158's shape) and inside a KEY (#7153's shape), the named
# secret inside a key a template Fn::GetAtt spells, and the 3-character short
# secret as a whole KEY (#7181) beside a key that only contains it.
#
# The short secret is also returned as the VALUE of `Data.Other`, a key no
# template reads (go-to-k/cdkd#7183): masked and declared NoEcho.
# `cdkd drift` skips custom resources (src/cli/commands/drift/detect.ts): a
# custom resource has no readback, so the `maskedEcho` half of #7181 is unit
# tested only; here drift and `drift --revert` must exit 0 and send nothing.
echo "==> Phase 3: the secret-echo arm"
# Premise: the arm is not deployed yet, so this phase's deploy is the one that
# creates it and every assertion below reads what that deploy wrote.
PRE_ECHO=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ "$(jq --arg t "Custom::CdkdSecretEcho" '[.resources[] | select(.resourceType == $t)] | length' <<<"${PRE_ECHO}")" != "0" ]; then
  echo "FAIL: premise: a Custom::CdkdSecretEcho resource is already deployed before phase 3." >&2
  echo "    Only phase 3 may deploy the secret-echo arm (CDKD_TEST_SECRET_ECHO on its own commands)." >&2
  exit 1
fi
SECRET_ECHO_LOG="$(mktemp)"
# Each capture is printed on failure with the secrets replaced, so a FAIL line
# never discloses the values it is about.
show_redacted() { # show_redacted <file>
  sed -e "s/${ECHO_SECRET}/<echo-secret>/g" -e "s/${NAMED_SECRET}/<named-secret>/g" \
    -e "s/${SHORT_SECRET}/<short-secret>/g" "$1" >&2
}
secret_echo_fail() { # secret_echo_fail <message> [log]
  echo "FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "    captured log (secrets replaced):" >&2
    show_redacted "$2"
  fi
  exit 1
}
# True when the state object <file> carries a secret-echo value that must never
# persist. The short secret is matched as a whole JSON string: the control key
# `Xq~7x` legitimately contains it.
carries_secret() { # carries_secret <file>
  grep -qF "${ECHO_SECRET}" "$1" || grep -qF "\"${SHORT_SECRET}\"" "$1"
}
# The same for a command's log, where a value need not be quoted. No log line
# names the control key, so a bare match is a finding.
log_carries_secret() { # log_carries_secret <file>
  grep -qF "${ECHO_SECRET}" "$1" || grep -qF "${SHORT_SECRET}" "$1"
}
# Read EVERY object version under this stack's prefix (state.json, lock.json,
# deployments/*.jsonl, ...) and fail if one carries a secret. A zero-row
# listing FAILS: a clean verdict over nothing proves nothing.
assert_no_secret_in_versions() { # assert_no_secret_in_versions <description>
  local desc="$1" rows key vid body read_out scanned=0 err rc=0
  err="$(mktemp)"
  rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "${PREFIX}" \
    --query 'Versions[].[Key,VersionId]' --output text 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    cat "${err}" >&2
    rm -f "${err}"
    secret_echo_fail "${desc}: could not list object versions under s3://${STATE_BUCKET}/${PREFIX}"
  fi
  rm -f "${err}"
  body="$(mktemp)"
  # `|| [ -n "${key}" ]`: `$(...)` strips the last newline, so `read` returns
  # non-zero on the LAST row (../s3-versions.sh, trap 2).
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] && [ "${vid}" != "None" ] || continue
    if ! read_out="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" "${body}" 2>&1 < /dev/null)"; then
      rm -f "${body}"
      secret_echo_fail "${desc}: could not read s3://${STATE_BUCKET}/${key} version ${vid} (${read_out})"
    fi
    if carries_secret "${body}"; then
      rm -f "${body}"
      secret_echo_fail "${desc}: s3://${STATE_BUCKET}/${key} version ${vid} carries a secret-echo value (value withheld)"
    fi
    scanned=$((scanned + 1))
  done <<< "${rows}"
  rm -f "${body}"
  [ "${scanned}" -gt 0 ] || secret_echo_fail "${desc}: scanned ZERO object versions under s3://${STATE_BUCKET}/${PREFIX}"
  echo "    OK: ${desc}: ${scanned} object version(s) scanned, none carries a secret-echo value"
}
# The custom resource's persisted record, selected by its type.
secret_echo_record() { # secret_echo_record <state-json>
  jq -c --arg t "${SECRET_ECHO_TYPE}" '[.resources[] | select(.resourceType == $t)] | if length == 1 then .[0] else "<\(length) matches>" end' <<<"$1"
}

set +e
CDKD_TEST_NOECHO_SEED="${ROTATED_SEED}" CDKD_TEST_SECRET_ECHO=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes > "${SECRET_ECHO_LOG}" 2>&1
rc=$?
set -e
[ "${rc}" -eq 0 ] || secret_echo_fail "the secret-echo deploy exited ${rc}" "${SECRET_ECHO_LOG}"
log_carries_secret "${SECRET_ECHO_LOG}" && secret_echo_fail "the secret-echo deploy log carries a secret-echo value (value withheld)"
grep -qF "SecretEchoResource" "${SECRET_ECHO_LOG}" \
  || secret_echo_fail "the secret-echo deploy log never names SecretEchoResource: the arm did not deploy" "${SECRET_ECHO_LOG}"

STATE_ECHO=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
[ -n "${STATE_ECHO}" ] || secret_echo_fail "could not read the state file after the secret-echo deploy"
ECHO_RECORD="$(secret_echo_record "${STATE_ECHO}")"
case "${ECHO_RECORD}" in
  '"<'*) secret_echo_fail "state holds ${ECHO_RECORD} ${SECRET_ECHO_TYPE} records, expected 1" ;;
esac
# The over-mask controls and the kept key resolve first, so the record is the
# one this deploy wrote and the secret checks below are not vacuous.
ATTR_KEYS="$(jq -c '.attributes | keys' <<<"${ECHO_RECORD}")"
EXPECTED_KEYS="$(jq -cn --arg n "Named-${NAMED_SECRET}" --arg s "X${SHORT_SECRET}x" '[$n, $s, "Echo", "Other", "Public"] | sort')"
if [ "${ATTR_KEYS}" != "${EXPECTED_KEYS}" ]; then
  # A file, not a process substitution: `carries_secret` reads it twice.
  printf '%s\n' "${ATTR_KEYS}" > "${SECRET_ECHO_LOG}"
  carries_secret "${SECRET_ECHO_LOG}" \
    && secret_echo_fail "the record's attribute keys still hold a secret-echo value: a secret-named key was persisted (go-to-k/cdkd#7153 / #7181)" "${SECRET_ECHO_LOG}"
  secret_echo_fail "the record's attribute keys differ from the GetAtt-spelled key, the containing key, Echo and Public" "${SECRET_ECHO_LOG}"
fi
echo "    OK: the secret-named keys are dropped; the GetAtt-spelled key and the key that only contains the short secret are kept"
for prop in Echo Named Short; do
  [ "$(jq -r --arg p "${prop}" '.properties[$p]' <<<"${ECHO_RECORD}")" = "${SECRET_MASK}" ] \
    || secret_echo_fail "properties.${prop} is not '${SECRET_MASK}' (value withheld): a NoEcho input persisted at its position"
done
# go-to-k/cdkd#7183: `Data.Other` is the 3-character secret, under a key no
# template Fn::GetAtt reads, so it is masked and declared NoEcho.
[ "$(jq -r '.attributes.Other' <<<"${ECHO_RECORD}")" = "${SECRET_MASK}" ] \
  || secret_echo_fail "attributes.Other is not '${SECRET_MASK}' (value withheld): a short NoEcho value under an unread key persisted (go-to-k/cdkd#7183)"
jq -e '.noEchoAttributeNames | index("Other") != null' <<<"${ECHO_RECORD}" >/dev/null \
  || secret_echo_fail "noEchoAttributeNames does not name Other (go-to-k/cdkd#7183)"
[ "$(jq -r '.attributes.Echo' <<<"${ECHO_RECORD}")" = "${SECRET_MASK}" ] \
  || secret_echo_fail "attributes.Echo is not '${SECRET_MASK}' (value withheld): a NoEcho value under a template-absent key persisted (go-to-k/cdkd#7158)"
[ "$(jq -r '.attributes.Public' <<<"${ECHO_RECORD}")" = "public-secret-echo-value" ] \
  || secret_echo_fail "attributes.Public was masked: the redaction over-applied to a public value"
[ "$(jq -r --arg s "X${SHORT_SECRET}x" '.attributes[$s]' <<<"${ECHO_RECORD}")" = "k-contains-short" ] \
  || secret_echo_fail "the key that only CONTAINS the short secret lost its value: the equality arm over-applied"
for out_check in "SecretEchoNamedValue:k-named" "SecretEchoPublicValue:public-secret-echo-value"; do
  out_name="${out_check%%:*}"
  out_want="${out_check#*:}"
  out_got="$(jq -r --arg o "${out_name}" '.outputs[$o] // "<absent>"' <<<"${STATE_ECHO}")"
  [ "${out_got}" = "${out_want}" ] \
    || secret_echo_fail "state output ${out_name} is '${out_got}', expected '${out_want}': the kept key did not resolve through Fn::GetAtt"
done
echo "    OK: attributes.Echo is masked, the public values stay in the clear, and the GetAtt-spelled key resolves"
assert_no_secret_in_versions "after the secret-echo deploy"

# Drift: a custom resource is not compared, so drift must exit 0 and its
# revert must change nothing.
for drift_args in "" "--revert --yes"; do
  set +e
  # shellcheck disable=SC2086 # drift_args is a fixed flag list
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" ${drift_args} \
    > "${SECRET_ECHO_LOG}" 2>&1
  rc=$?
  set -e
  [ "${rc}" -eq 0 ] || secret_echo_fail "cdkd drift ${drift_args} exited ${rc}, expected 0" "${SECRET_ECHO_LOG}"
  log_carries_secret "${SECRET_ECHO_LOG}" && secret_echo_fail "cdkd drift ${drift_args} printed a secret-echo value (value withheld)"
  echo "    OK: cdkd drift ${drift_args:-(report)} exits 0 and prints no secret-echo value"
done
STATE_AFTER_DRIFT=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
[ "$(secret_echo_record "${STATE_AFTER_DRIFT}")" = "${ECHO_RECORD}" ] \
  || secret_echo_fail "drift --revert rewrote the secret-echo record"
echo "    OK: drift --revert left the secret-echo record as it was"

# A redeploy of the same template is NO_CHANGE: the masked attribute and the
# dropped keys must not read as a difference.
set +e
CDKD_TEST_NOECHO_SEED="${ROTATED_SEED}" CDKD_TEST_SECRET_ECHO=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${SECRET_ECHO_LOG}" 2>&1
set -e
log_carries_secret "${SECRET_ECHO_LOG}" && secret_echo_fail "cdkd diff printed a secret-echo value (value withheld)"
grep -q "No changes detected" "${SECRET_ECHO_LOG}" \
  || secret_echo_fail "the diff after the secret-echo deploy is not clean" "${SECRET_ECHO_LOG}"
set +e
CDKD_TEST_NOECHO_SEED="${ROTATED_SEED}" CDKD_TEST_SECRET_ECHO=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes > "${SECRET_ECHO_LOG}" 2>&1
rc=$?
set -e
[ "${rc}" -eq 0 ] || secret_echo_fail "the secret-echo redeploy exited ${rc}" "${SECRET_ECHO_LOG}"
log_carries_secret "${SECRET_ECHO_LOG}" && secret_echo_fail "the secret-echo redeploy log carries a secret-echo value (value withheld)"
STATE_REDEPLOY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
[ "$(secret_echo_record "${STATE_REDEPLOY}")" = "${ECHO_RECORD}" ] \
  || secret_echo_fail "the NO_CHANGE redeploy rewrote the secret-echo record" "${SECRET_ECHO_LOG}"
echo "    OK: the diff is clean and the redeploy leaves the secret-echo record as it was"
assert_no_secret_in_versions "after the secret-echo redeploy"
rm -f "${SECRET_ECHO_LOG}"
SECRET_ECHO_LOG=""

# --- Phase 4: destroy -------------------------------------------------
echo "==> Phase 4: destroy"
# With the secret-echo arm in the template: its record holds the NoEcho inputs
# as `***`, and only a destroy holding the template re-resolves them for the
# Delete handler (go-to-k/cdkd#4682). The handler must run, never be skipped.
DESTROY_LOG="$(mktemp)"
set +e
CDKD_TEST_SECRET_ECHO=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force > "${DESTROY_LOG}" 2>&1
rc=$?
set -e
if [ "${rc}" -ne 0 ] || grep -qF "Delete handler not invoked" "${DESTROY_LOG}"; then
  echo "FAIL: destroy exited ${rc} or skipped a custom resource's Delete handler; log (secrets replaced):" >&2
  show_redacted "${DESTROY_LOG}"
  rm -f "${DESTROY_LOG}"
  exit 1
fi
log_carries_secret "${DESTROY_LOG}" && { rm -f "${DESTROY_LOG}"; echo "FAIL: the destroy log carries a secret-echo value (value withheld)" >&2; exit 1; }
rm -f "${DESTROY_LOG}"
echo "    OK: destroy ran every Delete handler and printed no secret-echo value"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# The CRs + backing Lambdas + every SSM parameter must all be gone.
for p in "${PARAM_COMPUTED}" "${PARAM_ANOTHER}" "${PARAM_NUMERIC}" "${PARAM_NOECHO}" "${PARAM_NOECHO_EMBEDDED}"; do
  assert_gone "SSM parameter ${p} still exists after destroy (orphan)" aws ssm get-parameter --region "${REGION}" --name "${p}"
done
echo "    OK: all five SSM parameters are gone"

for arn in ${LAMBDA_ARNS}; do
  assert_gone "backing Lambda ${arn} still exists after destroy (orphan)" aws lambda get-function --region "${REGION}" --function-name "${arn}"
done
if [ -n "${LAMBDA_ARNS}" ]; then
  echo "    OK: every backing Lambda is gone"
fi

# The state bucket is versioned: the destroy left every earlier state version
# readable, the GetAtt-spelled secret key among them. Nothing needs the state
# now, so every version and delete marker goes. The traps are disarmed first:
# `cleanup` on EXIT would otherwise write fresh delete markers after the sweep.
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"

echo ""
echo "=== PASS: Custom Resource Data GetAtt -> dependent property integ ==="
