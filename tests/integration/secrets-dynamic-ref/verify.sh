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
# ...plus, created OUT OF BAND by this script (CloudFormation cannot create
# one), an SSM SecureString parameter the Lambda references through the PLAIN
# `{{resolve:ssm:...}}` form. That reference decrypts to a real secret, so
# issue #1901 requires it to be persisted as its expression while the String
# parameter beside it stays RESOLVED — the two together are what force the
# decision to be made on the parameter's TYPE rather than on the spelling.
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
#   - ssm:<name>            (String param)              (plaintext param) SUPPORTED
#   - ssm:<name>            (SecureString param)        (decrypts, and is
#                                                        REDACTED in state)   SUPPORTED
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
# SecureString counterpart (issue #1901). Created by THIS script, not by the
# stack: CloudFormation cannot create a SecureString parameter, so the fixture
# only references it.
SECURE_PARAM_NAME="cdkd-test-dynref-secure-${ACCOUNT_ID}"

# Known values authored in the fixture stack (NOT secret in any real sense;
# this is test data, but we still mask the secret-derived ones in output).
EXPECTED_PASSWORD="cdkd-known-pw-123"
EXPECTED_FULL='{"username":"cdkd-user","password":"cdkd-known-pw-123"}'
EXPECTED_SSM="cdkd-known-ssm-value"
# The version-stage reference reads the SAME json key as SECRET_PASSWORD, so
# both resolve to EXPECTED_PASSWORD. That collision is deliberate and is what
# makes the state-expression + `diff --fail` assertions below discriminating:
# the value-keyed redaction map collapses the pair, so only a POSITION source
# can keep each leaf on its own expression (issues #1904 / #1910). See the
# stack's comment.
EXPECTED_USERNAME="cdkd-user"
EXPECTED_SECURE="cdkd-known-secure-value-456"

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
  # The SecureString parameter is created by this script, so cdkd never deletes
  # it — the ONLY thing that keeps it from being an orphan is this sweep.
  aws ssm delete-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Out-of-band SecureString parameter (issue #1901) -----------------
# CloudFormation cannot CREATE a SecureString parameter, so the fixture stack
# only REFERENCES this one. Created AFTER the pre-run cleanup (which deletes
# it) and removed again by the cleanup trap.
echo "==> Creating the SecureString SSM parameter out of band"
aws ssm put-parameter --name "${SECURE_PARAM_NAME}" --type SecureString \
  --value "${EXPECTED_SECURE}" --overwrite --region "${REGION}" >/dev/null
# Fail loudly if AWS did not actually store it as a SecureString: every
# assertion below would otherwise pass vacuously against a String parameter,
# which is the OPPOSITE of what is under test.
SECURE_TYPE=$(aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Type' --output text)
if [ "${SECURE_TYPE}" != "SecureString" ]; then
  echo "FAIL: expected '${SECURE_PARAM_NAME}' to be a SecureString, got '${SECURE_TYPE}'" >&2
  exit 1
fi
echo "    OK: SecureString parameter created"

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
ENV_SSM_SECURE_VALUE=$(get_env SSM_SECURE_VALUE)

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
check_not_literal SSM_SECURE_VALUE "${ENV_SSM_SECURE_VALUE}"

check_equals "SECRET_PASSWORD (secretsmanager :SecretString:<jsonkey>)" \
  "${ENV_SECRET_PASSWORD}" "${EXPECTED_PASSWORD}"
check_equals "SECRET_FULL (secretsmanager :SecretString whole-secret)" \
  "${ENV_SECRET_FULL}" "${EXPECTED_FULL}"
# Same expected value as SECRET_PASSWORD above — that IS the collision. Both
# references must still reach AWS fully resolved; #1904 / #1910 change what
# STATE holds, never what the provider is handed.
check_equals "SECRET_PASSWORD_STAGED (secretsmanager :SecretString:<jsonkey>:AWSCURRENT)" \
  "${ENV_SECRET_PASSWORD_STAGED}" "${EXPECTED_PASSWORD}"
check_equals "SSM_VALUE (ssm:<name> plaintext param)" \
  "${ENV_SSM_VALUE}" "${EXPECTED_SSM}"
# The SecureString still has to REACH AWS decrypted — issue #1901 changes what
# STATE holds, never what the provider is handed.
check_equals "SSM_SECURE_VALUE (ssm:<name> SecureString param, decrypted)" \
  "${ENV_SSM_SECURE_VALUE}" "${EXPECTED_SECURE}"

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
STATE_SSM_SECURE_VALUE=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SSM_SECURE_VALUE // empty')
STATE_SECRET_PASSWORD_STAGED=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD_STAGED // empty')

# Guard 3: each secretsmanager env var in STATE must be the UNRESOLVED
# expression, not the plaintext. (We can print the expression — it names the
# secret, not its value.)
redaction_fail=0
case "${STATE_SECRET_PASSWORD}" in
  '{{resolve:secretsmanager:'*) echo "    OK: state SECRET_PASSWORD kept the expression: ${STATE_SECRET_PASSWORD}" ;;
  *) echo "FAIL: state SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${STATE_SECRET_PASSWORD}")" >&2; redaction_fail=1 ;;
esac
# ...and specifically NOT its staged sibling's spelling. The case above accepts
# any secretsmanager expression, so on its own it passes on the collapsed state
# (#1904 / #1910) — the two leaves resolve to one value, so it is exactly this
# leaf that gets rewritten to the OTHER one's expression.
case "${STATE_SECRET_PASSWORD}" in
  *':AWSCURRENT}}')
    echo "FAIL: state SECRET_PASSWORD took the STAGED expression — the colliding pair collapsed (#1910)" >&2
    redaction_fail=1
    ;;
esac
case "${STATE_SECRET_FULL}" in
  '{{resolve:secretsmanager:'*) echo "    OK: state SECRET_FULL kept the expression: ${STATE_SECRET_FULL}" ;;
  *) echo "FAIL: state SECRET_FULL is NOT the {{resolve:...}} expression: $(mask "${STATE_SECRET_FULL}")" >&2; redaction_fail=1 ;;
esac
# The version-stage reference resolves to its OWN distinct value (see issue
# #1904 and the stack comment), so its state side needs its own assertion —
# otherwise the one env var whose expression differs from every other is the
# one form left unverified.
case "${STATE_SECRET_PASSWORD_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: state SECRET_PASSWORD_STAGED kept its OWN staged expression: ${STATE_SECRET_PASSWORD_STAGED}" ;;
  *) echo "FAIL: state SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${STATE_SECRET_PASSWORD_STAGED}")" >&2; redaction_fail=1 ;;
esac

# Guard 3b (issue #1901): an ssm reference to a SECURESTRING parameter is a
# secret too, so state must hold its expression — even though the SPELLING is
# identical to the plain-ssm reference Guard 4 requires to stay RESOLVED. The
# two guards together are the discriminator: cdkd must decide by the
# parameter's TYPE, and a fix that redacted by spelling would fail Guard 4
# while one that redacted nothing fails this guard.
case "${STATE_SSM_SECURE_VALUE}" in
  '{{resolve:ssm:'*) echo "    OK: state SSM_SECURE_VALUE kept the expression: ${STATE_SSM_SECURE_VALUE}" ;;
  *) echo "FAIL: state SSM_SECURE_VALUE is NOT the {{resolve:...}} expression: $(mask "${STATE_SSM_SECURE_VALUE}")" >&2; redaction_fail=1 ;;
esac

# Guard 4: the plain ssm value IS resolved in state (public config, not a secret).
if [ "${STATE_SSM_VALUE}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: state SSM_VALUE kept the resolved value (ssm String is not a secret)"
else
  echo "FAIL: state SSM_VALUE should be the resolved '${EXPECTED_SSM}' (ssm String is public config), got $(mask "${STATE_SSM_VALUE}")" >&2
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
# Same guard for the decrypted SecureString (issue #1901). Unlike the
# secretsmanager case there is no sibling resource legitimately holding this
# value, so the whole STATE document is scanned, not just the Lambda's env.
if printf '%s' "${STATE_JSON}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: the decrypted SecureString value LEAKED into persisted state (issue #1901)" >&2
  redaction_fail=1
else
  echo "    OK: decrypted SecureString value is absent from the whole state document"
fi
# The secret's OTHER json key must not survive either. Since #1910 restored the
# collision, the staged reference resolves to the password and is covered by the
# grep above; this now guards SECRET_FULL, whose whole-secret resolution carries
# the username and must likewise be stored as its expression. Scoped to
# LAMBDA_ENV, not the whole state: the DynRefSecret resource's OWN SecretString
# legitimately contains it (same rationale as the password grep above).
if printf '%s' "${LAMBDA_ENV}" | grep -qF "${EXPECTED_USERNAME}"; then
  echo "FAIL: the whole-secret reference's resolved value LEAKED into the Lambda's persisted env" >&2
  redaction_fail=1
else
  echo "    OK: whole-secret plaintext is absent from the consumer Lambda's persisted state"
fi

if [ "${redaction_fail}" -ne 0 ]; then
  echo "FAIL: state secret-redaction assertions failed" >&2
  exit 1
fi

# Guard 6: a second `cdkd diff` shows NO change (expression-vs-expression) and
# prints no plaintext. A resolved-vs-expression compare would report a spurious
# UPDATE of every secret-bearing property on every deploy.
# `--fail` is what makes the no-change half non-vacuous: it exits 1 on ANY
# change, so a perpetual UPDATE fails the run instead of only being absent from
# a plaintext grep.
echo "==> Asserting a re-diff is clean (no perpetual UPDATE) and leaks no plaintext"
set +e
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --fail 2>&1)
DIFF_RC=$?
set -e
if printf '%s' "${DIFF_OUT}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: 'cdkd diff' output leaked the resolved secret plaintext" >&2
  exit 1
fi
if printf '%s' "${DIFF_OUT}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: 'cdkd diff' output leaked the decrypted SecureString value (issue #1901)" >&2
  exit 1
fi
echo "    OK: diff leaks no plaintext"
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' reported changes on an unchanged stack (spurious UPDATE — rc=${DIFF_RC})" >&2
  echo "      output: ${DIFF_OUT}" >&2
  exit 1
fi
echo "    OK: diff reports no changes (secret + SecureString compare expression-vs-expression)"

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
if printf '%s' "${SCRUB_OUT}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: 'cdkd scrub' output leaked the decrypted SecureString value (issue #1901)" >&2
  exit 1
fi
if printf '%s' "${SCRUB_OUT}" | grep -qiE 'no plaintext secrets|nothing to scrub'; then
  echo "    OK: scrub --dry-run reports the deployed state is already clean"
else
  echo "FAIL: scrub --dry-run should report nothing to scrub on a freshly-deployed stack" >&2
  echo "      output: ${SCRUB_OUT}" >&2
  exit 1
fi

# --- Phase 1d: standalone rollback RE-RESOLVES secret expressions (GHSA #1899) ---
# The journal (and each state record) stores the REDACTED {{resolve:...}}
# expression, never the plaintext. A standalone `cdkd rollback` must re-resolve
# that expression to the concrete secret for the provider replay — replaying the
# literal token would corrupt the Lambda's env. This phase proves it end to end:
#   1. A CDKD_TEST_ROLLBACK deploy adds a non-secret env var (ROLLBACK_EXTRA,
#      forcing a real Lambda UPDATE whose whole env map is re-sent) plus a
#      failing SQS queue that depends on the Lambda. --no-rollback leaves the
#      journal (Lambda previousState secret env = the redacted expression).
#   2. `cdkd rollback` reverts the Lambda; the fix re-resolves the expression.
#   3. The live Lambda must carry the RESOLVED secret (never the literal), and
#      the probe env var must be gone; state must still hold the expression.
echo "==> Phase 1d: --no-rollback failing deploy + standalone rollback re-resolves the secret"
set +e
CDKD_TEST_ROLLBACK=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --no-rollback --yes
ROLLBACK_DEPLOY_RC=$?
set -e
if [ "${ROLLBACK_DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the CDKD_TEST_ROLLBACK deploy was expected to FAIL (invalid SQS queue) but exited 0" >&2
  exit 1
fi
echo "    OK: rollback-probe deploy failed as expected (rc=${ROLLBACK_DEPLOY_RC})"

# The Lambda UPDATE must have completed (ROLLBACK_EXTRA live) before the rollback,
# else there is nothing to re-resolve on the revert.
RB_BEFORE=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")
EXTRA_BEFORE=$(printf '%s' "${RB_BEFORE}" | jq -r '.Environment.Variables.ROLLBACK_EXTRA // empty')
if [ "${EXTRA_BEFORE}" != "v2" ]; then
  echo "FAIL: expected the Lambda UPDATE (ROLLBACK_EXTRA=v2) to have completed before rollback, got '$(mask "${EXTRA_BEFORE}")'" >&2
  exit 1
fi
echo "    OK: Lambda UPDATE completed pre-rollback (ROLLBACK_EXTRA live)"

# Standalone rollback reads the REDACTED journal and must re-resolve.
node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RB_CFG=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")
rb_env() { printf '%s' "${RB_CFG}" | jq -r --arg k "$1" '.Environment.Variables[$k] // empty'; }
RB_PW=$(rb_env SECRET_PASSWORD)
RB_PW_STAGED=$(rb_env SECRET_PASSWORD_STAGED)
RB_SECURE=$(rb_env SSM_SECURE_VALUE)
RB_EXTRA=$(rb_env ROLLBACK_EXTRA)
case "${RB_PW}" in
  *'{{resolve:'*)
    echo "FAIL: after rollback the Lambda SECRET_PASSWORD is the LITERAL expression — the replay did NOT re-resolve: $(mask "${RB_PW}")" >&2
    exit 1
    ;;
esac
if [ "${RB_PW}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: after rollback the Lambda SECRET_PASSWORD is not the resolved value: got $(mask "${RB_PW}")" >&2
  exit 1
fi
# Issue #1901 makes the SecureString reference a SECOND thing the journal now
# stores redacted, so the replay has to re-resolve it too. Without these two
# checks a replay that shipped the literal `{{resolve:ssm:...}}` to the Lambda
# passes on the secretsmanager assertions alone.
case "${RB_SECURE}" in
  *'{{resolve:'*)
    echo "FAIL: after rollback the Lambda SSM_SECURE_VALUE is the LITERAL expression — the replay did NOT re-resolve the SecureString: $(mask "${RB_SECURE}")" >&2
    exit 1
    ;;
esac
if [ "${RB_SECURE}" != "${EXPECTED_SECURE}" ]; then
  echo "FAIL: after rollback the Lambda SSM_SECURE_VALUE is not the decrypted value: got $(mask "${RB_SECURE}")" >&2
  exit 1
fi
# Issue #1910: the journal is the writer whose collapse is not merely cosmetic.
# `resolveReplayProps` RE-RESOLVES these expressions and ships the result to the
# live Lambda, so a staged/unstaged pair collapsed onto one spelling makes the
# replay resolve the WRONG reference for one of the two leaves. Both must come
# back as the resolved value, and neither may still be a literal expression.
case "${RB_PW_STAGED}" in
  *'{{resolve:'*)
    echo "FAIL: after rollback the Lambda SECRET_PASSWORD_STAGED is the LITERAL expression — the replay did NOT re-resolve: $(mask "${RB_PW_STAGED}")" >&2
    exit 1
    ;;
esac
if [ "${RB_PW_STAGED}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: after rollback the Lambda SECRET_PASSWORD_STAGED is not the resolved value: got $(mask "${RB_PW_STAGED}")" >&2
  exit 1
fi
if [ -n "${RB_EXTRA}" ]; then
  echo "FAIL: rollback did not revert the Lambda env (ROLLBACK_EXTRA still '$(mask "${RB_EXTRA}")')" >&2
  exit 1
fi
echo "    OK: standalone rollback re-resolved the secret (live SECRET_PASSWORD=RESOLVED, ROLLBACK_EXTRA gone)"

# STATE must still hold the {{resolve:...}} expression after the rollback write.
RB_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
RB_LAMBDA_ENV=$(printf '%s' "${RB_STATE}" | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.properties.Environment.Variables' | head -1)
RB_STATE_PW=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD // empty')
RB_STATE_SECURE=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.SSM_SECURE_VALUE // empty')
RB_STATE_PW_STAGED=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD_STAGED // empty')
case "${RB_STATE_PW}" in
  '{{resolve:secretsmanager:'*) echo "    OK: post-rollback state kept the SECRET_PASSWORD expression" ;;
  *) echo "FAIL: post-rollback state SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${RB_STATE_PW}")" >&2; exit 1 ;;
esac
# Issue #1910: the rollback WRITES state after re-resolving, so it is a redaction
# site of its own — and the colliding pair is what makes this assertion bite. A
# plain `:AWSCURRENT}}` suffix check is what discriminates: without a position
# source BOTH leaves come back on whichever expression the replay recorded last,
# so SECRET_PASSWORD would hold the staged spelling and this leaf the unstaged
# one. Checking only "is it an expression" would pass on the collapsed state.
case "${RB_STATE_PW_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: post-rollback state kept SECRET_PASSWORD_STAGED's OWN staged expression" ;;
  *) echo "FAIL: post-rollback state SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${RB_STATE_PW_STAGED}")" >&2; exit 1 ;;
esac
case "${RB_STATE_PW}" in
  *':AWSCURRENT}}') echo "FAIL: post-rollback state SECRET_PASSWORD took the STAGED expression — the pair collapsed (#1910)" >&2; exit 1 ;;
esac
# The rollback WRITES a state record, so it is its own redaction site (issue
# #1901): re-resolving for the provider must not leave the decrypted value in
# what gets persisted.
case "${RB_STATE_SECURE}" in
  '{{resolve:ssm:'*) echo "    OK: post-rollback state kept the SSM_SECURE_VALUE expression" ;;
  *) echo "FAIL: post-rollback state SSM_SECURE_VALUE is NOT the {{resolve:...}} expression: $(mask "${RB_STATE_SECURE}")" >&2; exit 1 ;;
esac
# Scope the plaintext-leak grep to the CONSUMER Lambda's env, NOT the whole
# state — same rationale as Guard 5 above: the DynRefSecret resource's OWN
# SecretString legitimately holds the fixture's hardcoded password, which is out
# of scope for the dynamic-reference (consumer-side) disclosure this fix targets.
if printf '%s' "${RB_LAMBDA_ENV}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: post-rollback the Lambda's persisted env leaked the resolved secret plaintext" >&2
  exit 1
fi
# The SecureString has no such sibling holding it legitimately, so scan the
# WHOLE post-rollback state document (issue #1901).
if printf '%s' "${RB_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: post-rollback state leaked the decrypted SecureString value (issue #1901)" >&2
  exit 1
fi
echo "    OK: post-rollback state carries no resolved plaintext (secret + SecureString)"

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

# The SecureString parameter is NOT in the stack (this script created it), so
# destroy must have left it alone — deleting a resource cdkd does not manage
# would be the real failure here. Then remove it ourselves and prove it is gone,
# so the run ends with no orphan (the cleanup trap is a backstop, not the proof).
if gone_probe aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}"; then
  echo "FAIL: destroy deleted the out-of-band SecureString parameter '${SECURE_PARAM_NAME}' — cdkd must not touch a resource it does not manage" >&2
  exit 1
fi
echo "    OK: destroy left the unmanaged SecureString parameter intact"
aws ssm delete-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" >/dev/null
assert_gone "out-of-band SecureString parameter '${SECURE_PARAM_NAME}' still exists after its explicit delete" aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}"
echo "    OK: out-of-band SecureString parameter is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> secrets-dynamic-ref test passed (dynamic references resolved correctly + clean destroy)"
