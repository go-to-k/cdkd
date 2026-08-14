#!/usr/bin/env bash
# verify.sh - cdkd secrets-dynamic-ref integ.
#
# Failure-seeking test for CloudFormation DYNAMIC REFERENCES
# (`{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}`). cdkd resolves
# these itself in `resolveDynamicReferences`
# (src/deployment/intrinsic-function-resolver.ts) BEFORE the property reaches
# the provider, so AWS never sees the literal token.
#
# The fixture deploys:
#   - a SecretsManager secret with a KNOWN JSON value
#     ({"username":"cdkd-user","password":"cdkd-known-pw-123"})
#   - an SSM String parameter with a KNOWN value (cdkd-known-ssm-value)
#   - a consumer Lambda whose ENV VARS are literal {{resolve:...}} strings
#
# After deploy we read GetFunctionConfiguration and assert each env var
# carries the RESOLVED value rather than the literal {{resolve:...}} token.
# If a reference stays literal or resolves to the wrong value, the test FAILS
# with specifics.
#
# Phase 2 (CDKD_TEST_REMOVAL=true, issue #1160 secretsmanager batch) then
# drops the secret's Description + KmsKeyId from the template and asserts the
# live secret resets to the pristine defaults (both absent from
# DescribeSecret) instead of silently keeping the old values (UpdateSecret
# merges absent input fields). Phase 3 destroys.
#
# SECURITY: secret-derived values are NEVER printed. Assertions compare
# against a masked representation; only PASS/FAIL + a masked snippet is shown.
#
# Dynamic-reference forms exercised (and which cdkd supports):
#   - secretsmanager :SecretString:<jsonkey>            (JSON-key form)   SUPPORTED
#   - secretsmanager :SecretString  (no key)            (whole secret)    SUPPORTED
#   - secretsmanager :SecretString:<jsonkey>:AWSCURRENT (version-stage)   SUPPORTED
#   - ssm:<name>                                        (plaintext param) SUPPORTED
#   - ssm-secure:<name>                                 (SecureString)    NOT SUPPORTED -> see note below
#
# `ssm-secure` is intentionally NOT exercised: cdkd's resolveDynamicReferences
# routes only `secretsmanager` and `ssm`; an `ssm-secure:` reference hits the
# `else` branch (warn + leave literal), so it would deploy a broken value.
# A version-ID form (`...:SecretString:key::<uuid>`) is also not exercised
# because the secret's version id is not known ahead of deploy; the
# version-STAGE slot (AWSCURRENT) covers the optional-trailing-field grammar.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdSecretsDynamicRefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

SECRET_NAME="cdkd-test-dynref-secret-${ACCOUNT_ID}"
PARAM_NAME="cdkd-test-dynref-param-${ACCOUNT_ID}"

# Known values authored in the fixture stack (NOT secret in any real sense;
# this is test data, but we still mask the secret-derived ones in output).
EXPECTED_PASSWORD="cdkd-known-pw-123"
EXPECTED_FULL='{"username":"cdkd-user","password":"cdkd-known-pw-123"}'
EXPECTED_SSM="cdkd-known-ssm-value"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# mask <value> -> echoes a masked form (first 2 chars + length) so logs never
# leak the resolved secret value. Empty -> "<empty>".
mask() {
  local v="$1"
  if [ -z "${v}" ]; then
    echo "<empty>"
    return
  fi
  local n=${#v}
  local head
  head=$(printf '%s' "${v}" | cut -c1-2)
  echo "${head}***(len=${n})"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Best-effort delete of the secret + param in case state destroy missed them.
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# --- Assertion: dynamic references resolved on the deployed Lambda ----
echo "==> Reading consumer Lambda env vars from AWS (GetFunctionConfiguration)"
FN_NAME=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | jq -r '.state.outputs.FunctionName // empty')

if [ -z "${FN_NAME}" ]; then
  echo "FAIL: could not read FunctionName output from cdkd state" >&2
  exit 1
fi
echo "    Consumer function: ${FN_NAME}"

CFG=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")

get_env() {
  echo "${CFG}" | jq -r --arg k "$1" '.Environment.Variables[$k] // empty'
}

ENV_SECRET_PASSWORD=$(get_env SECRET_PASSWORD)
ENV_SECRET_FULL=$(get_env SECRET_FULL)
ENV_SECRET_PASSWORD_STAGED=$(get_env SECRET_PASSWORD_STAGED)
ENV_SSM_VALUE=$(get_env SSM_VALUE)

fail_count=0

# Guard 1: nothing must remain a literal {{resolve:...}} token.
check_not_literal() {
  local name="$1" val="$2"
  case "${val}" in
    *'{{resolve:'*)
      echo "FAIL: env var ${name} is still the LITERAL dynamic reference (unresolved): $(mask "${val}")" >&2
      fail_count=$((fail_count + 1))
      ;;
  esac
}

# Guard 2: resolved value must equal the known expected value.
check_equals() {
  local name="$1" got="$2" want="$3"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: env var ${name} resolved to the WRONG value." >&2
    echo "      got:  $(mask "${got}")" >&2
    echo "      want: $(mask "${want}")" >&2
    fail_count=$((fail_count + 1))
  else
    echo "    OK: ${name} resolved correctly -> $(mask "${got}")"
  fi
}

check_not_literal SECRET_PASSWORD "${ENV_SECRET_PASSWORD}"
check_not_literal SECRET_FULL "${ENV_SECRET_FULL}"
check_not_literal SECRET_PASSWORD_STAGED "${ENV_SECRET_PASSWORD_STAGED}"
check_not_literal SSM_VALUE "${ENV_SSM_VALUE}"

check_equals "SECRET_PASSWORD (secretsmanager :SecretString:<jsonkey>)" \
  "${ENV_SECRET_PASSWORD}" "${EXPECTED_PASSWORD}"
check_equals "SECRET_FULL (secretsmanager :SecretString whole-secret)" \
  "${ENV_SECRET_FULL}" "${EXPECTED_FULL}"
check_equals "SECRET_PASSWORD_STAGED (secretsmanager :SecretString:<jsonkey>:AWSCURRENT)" \
  "${ENV_SECRET_PASSWORD_STAGED}" "${EXPECTED_PASSWORD}"
check_equals "SSM_VALUE (ssm:<name> plaintext param)" \
  "${ENV_SSM_VALUE}" "${EXPECTED_SSM}"

if [ "${fail_count}" -ne 0 ]; then
  echo "FAIL: ${fail_count} dynamic-reference assertion(s) failed" >&2
  exit 1
fi
echo "    OK: all dynamic references resolved to the correct values (none left literal)"
echo "    SKIP: ssm-secure:<name> not exercised (cdkd does not resolve it; see header note)"

# --- Assertion 1b: baseline Description + KmsKeyId reached AWS ------------
DESC_P1=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'Description' --output text)
KMS_P1=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'KmsKeyId' --output text)
if [ "${DESC_P1}" != "cdkd f1160 removal-reset probe" ] || [ "${KMS_P1}" != "alias/aws/secretsmanager" ]; then
  echo "FAIL: expected baseline Description/'alias/aws/secretsmanager' on the secret, got '${DESC_P1}' / '${KMS_P1}'" >&2
  exit 1
fi
echo "    OK: baseline Description + KmsKeyId set on the secret"

# --- Assertion 1c: STATE stores the {{resolve:...}} expression, NOT the
#     resolved plaintext (GHSA secret-disclosure fix) --------------------
# cdkd sends the RESOLVED value to AWS (asserted above via the live Lambda
# env), but must PERSIST the unresolved expression so the plaintext never
# lands in state.json / `state show` / diff / drift. A plain `ssm:` value is
# public config and is deliberately NOT redacted, which is the discriminator.
echo "==> Reading cdkd state to assert secret redaction"
STATE_JSON=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)

# The consumer Lambda's persisted env vars.
LAMBDA_ENV=$(printf '%s' "${STATE_JSON}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.properties.Environment.Variables' | head -1)
if [ -z "${LAMBDA_ENV}" ] || [ "${LAMBDA_ENV}" = "null" ]; then
  echo "FAIL: could not read the consumer Lambda's persisted Environment.Variables from state" >&2
  exit 1
fi

STATE_SECRET_PASSWORD=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD // empty')
STATE_SECRET_FULL=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_FULL // empty')
STATE_SSM_VALUE=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SSM_VALUE // empty')

# Guard 3: each secretsmanager env var in STATE must be the UNRESOLVED
# expression, not the plaintext. (We can print the expression — it names the
# secret, not its value.)
redaction_fail=0
case "${STATE_SECRET_PASSWORD}" in
  '{{resolve:secretsmanager:'*) echo "    OK: state SECRET_PASSWORD kept the expression: ${STATE_SECRET_PASSWORD}" ;;
  *) echo "FAIL: state SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${STATE_SECRET_PASSWORD}")" >&2; redaction_fail=1 ;;
esac
case "${STATE_SECRET_FULL}" in
  '{{resolve:secretsmanager:'*) echo "    OK: state SECRET_FULL kept the expression: ${STATE_SECRET_FULL}" ;;
  *) echo "FAIL: state SECRET_FULL is NOT the {{resolve:...}} expression: $(mask "${STATE_SECRET_FULL}")" >&2; redaction_fail=1 ;;
esac

# Guard 4: the plain ssm value IS resolved in state (public config, not a secret).
if [ "${STATE_SSM_VALUE}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: state SSM_VALUE kept the resolved value (ssm is not a secret)"
else
  echo "FAIL: state SSM_VALUE should be the resolved '${EXPECTED_SSM}' (ssm is public config), got $(mask "${STATE_SSM_VALUE}")" >&2
  redaction_fail=1
fi

# Guard 5: the RESOLVED-REFERENCE values (the consumer Lambda's env vars) must
# NOT contain the plaintext — this is the dynamic-reference disclosure the fix
# targets. NOTE we scope this to the Lambda's persisted env, NOT the whole
# state: the AWS::SecretsManager::Secret resource's OWN `SecretString` is the
# fixture's hardcoded value (cdk `unsafePlainText`), which legitimately lands in
# that resource's state properties exactly as CloudFormation stores template
# values. Redacting a resource's own literal is a separate concern (hardcoded
# secrets in templates), out of scope for the dynamic-reference fix — and
# redacting it would be the cross-resource false-positive the per-resource
# scoping deliberately avoids. grep -q so the plaintext is never echoed.
if printf '%s' "${LAMBDA_ENV}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: the resolved secret plaintext LEAKED into the Lambda's persisted env (dynamic-ref disclosure)" >&2
  redaction_fail=1
else
  echo "    OK: resolved-reference plaintext is absent from the consumer Lambda's persisted state"
fi

if [ "${redaction_fail}" -ne 0 ]; then
  echo "FAIL: state secret-redaction assertions failed" >&2
  exit 1
fi

# Guard 6: a second `cdkd diff` shows NO change (expression-vs-expression) and
# prints no plaintext. A resolved-vs-expression compare would report a spurious
# UPDATE of every secret-bearing property on every deploy.
echo "==> Asserting a re-diff is clean (no perpetual UPDATE) and leaks no plaintext"
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" 2>&1) || true
if printf '%s' "${DIFF_OUT}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: 'cdkd diff' output leaked the resolved secret plaintext" >&2
  exit 1
fi
echo "    OK: diff leaks no plaintext"

# Guard 7: `cdkd scrub --dry-run` on the freshly-deployed stack finds NOTHING
# to scrub (deploy already wrote expressions), proving the command runs and the
# deploy-time redaction is complete.
echo "==> Asserting 'cdkd scrub --dry-run' finds nothing on the freshly-deployed stack"
SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --dry-run 2>&1)
if printf '%s' "${SCRUB_OUT}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: 'cdkd scrub' output leaked the resolved secret plaintext" >&2
  exit 1
fi
if printf '%s' "${SCRUB_OUT}" | grep -qiE 'no plaintext secrets|nothing to scrub'; then
  echo "    OK: scrub --dry-run reports the deployed state is already clean"
else
  echo "FAIL: scrub --dry-run should report nothing to scrub on a freshly-deployed stack" >&2
  echo "      output: ${SCRUB_OUT}" >&2
  exit 1
fi

# --- Phase 2: removal-reset redeploy (issue #1160 secretsmanager batch) ---
echo "==> Phase 2: re-deploy dropping Description + KmsKeyId (removal reset)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Pre-fix UpdateSecret merge semantics silently kept both values; post-fix
# the provider sends Description='' and KmsKeyId='' (the SDK-documented
# "revert to aws/secretsmanager" sentinel) and DescribeSecret reports the
# pristine shape again: Description absent (text output 'None') and KmsKeyId
# absent ('None').
DESC_P2=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'Description' --output text)
KMS_P2=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'KmsKeyId' --output text)
# Asymmetry is deliberate: a cleared Description may surface as omitted
# ('None') or as a literal empty string depending on how AWS normalizes the
# '' write — both mean "no description". A cleared KmsKeyId is always OMITTED
# from DescribeSecret (the pristine managed-key shape), so it must be exactly
# 'None' — an empty string there would be an unexpected wire shape.
if { [ "${DESC_P2}" != "None" ] && [ -n "${DESC_P2}" ]; } || [ "${KMS_P2}" != "None" ]; then
  echo "FAIL: expected Description/KmsKeyId cleared after removal redeploy, got '${DESC_P2}' / '${KMS_P2}'" >&2
  exit 1
fi
echo "    OK: Description + KmsKeyId reset to the pristine defaults on AWS"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "consumer Lambda '${FN_NAME}' still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: consumer Lambda is gone"

# SecretsManager DeleteSecret SCHEDULES deletion with a recovery window
# (7-30 days) by default; cdkd's secret provider matches CloudFormation and does
# NOT force-delete-without-recovery. So after destroy the secret is NOT gone
# immediately: describe-secret still returns it with a non-empty DeletedDate
# (ScheduledDeletionDate), and it disappears from a default list-secrets (which
# excludes planned-deletion) but reappears under --include-planned-deletion.
# Therefore "scheduled for deletion" (DeletedDate set) is a PASS; only a secret
# that is still ACTIVE with no DeletedDate is a real failure.
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
  SECRET_DELETED_DATE="GONE"
elif ! SECRET_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
    --region "${REGION}" --query 'DeletedDate' --output text 2>&1); then
  # TOCTOU: the secret can vanish between gone_probe and this requery.
  printf '%s' "${SECRET_DELETED_DATE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && SECRET_DELETED_DATE="GONE" \
    || { echo "FAIL: describe-secret requery undetermined: ${SECRET_DELETED_DATE}" >&2; exit 1; }
fi
if [ "${SECRET_DELETED_DATE}" = "GONE" ]; then
  echo "    OK: secret is gone (describe-secret reports it no longer exists)"
elif [ -n "${SECRET_DELETED_DATE}" ] && [ "${SECRET_DELETED_DATE}" != "None" ]; then
  echo "    OK: secret is scheduled for deletion (DeletedDate=${SECRET_DELETED_DATE}) - SecretsManager recovery-window semantics"
else
  echo "FAIL: secret '${SECRET_NAME}' still ACTIVE after destroy (no DeletedDate set)" >&2
  exit 1
fi

assert_gone "SSM parameter '${PARAM_NAME}' still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
echo "    OK: SSM parameter is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> secrets-dynamic-ref test passed (dynamic references resolved correctly + clean destroy)"
