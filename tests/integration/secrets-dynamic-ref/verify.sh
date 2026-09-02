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
# Phase 1d (issue #1914) then drives `cdkd drift` over the same stack: state
# holds the {{resolve:...}} expressions while AWS holds the resolved plaintext,
# so the command has to re-resolve for its comparison and for `--revert`'s
# provider call while persisting and printing only the expression. Phase 1e
# covers the standalone rollback.
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

# Shared S3 VERSION-sweep helpers (issue #2096). The state bucket is
# VERSIONED, so `aws s3 rm` only writes a delete marker and every state.json
# this fixture wrote -- including the pre-GHSA records it SEEDS with the
# plaintext password on purpose -- stays readable via GetObjectVersion after a
# green run. See the file header for the three traps that make a sweep
# silently partial.
. ../s3-versions.sh

STACK="CdkdSecretsDynamicRefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**. Swept as one prefix so a key added
# later cannot be forgotten; the trailing '/' is what keeps a sibling stack
# whose name merely starts the same out of it.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
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
# The MIXED leaf's persisted form, spelled out rather than globbed (issue #1926
# review). A glob like '{{resolve:ssm:'*'@db.' passes under a sibling-expression
# COLLAPSE — the #1904 / #1910 class this same file fences for the
# secretsmanager pair — because any ssm expression satisfies it. Pinning the
# parameter NAME is what makes the assertion about THIS reference.
EXPECTED_DB_URL_EXPR="postgres://app-svc:{{resolve:ssm:${SECURE_PARAM_NAME}}}@db.${REGION}.internal:5432/app"
# The SecureString reference as a WHOLE token, which is what SSM_SECURE_VALUE
# and SSM_SECURE_COPY must both hold in state (issues #1901 / #2012).
EXPECTED_SECURE_EXPR="{{resolve:ssm:${SECURE_PARAM_NAME}}}"
# The PUBLIC mixed leaf (issue #2036, still OPEN), in BOTH of its forms. The
# RESOLVED one is what state holds wherever the POSITION SOURCE carries no
# reference — which is every path reachable from a template-declared leaf, since
# a public ssm `String` is persisted resolved (issue #1901). The EXPRESSION one
# is the OVER-redaction #2036 records, produced once the source DOES carry the
# reference: the `cdkd import` warn-path shape Phase 1f3 stamps. Pinning both
# means the fixture states which input configuration gets which answer rather
# than accepting either.
EXPECTED_PUBLIC_URL="https://${EXPECTED_SSM}.${REGION}.example.internal"
EXPECTED_PUBLIC_URL_EXPR="https://{{resolve:ssm:${PARAM_NAME}}}.${REGION}.example.internal"

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

# Echo a captured command output as FAILURE diagnostics — but never before
# proving it carries no plaintext. These diagnostics sit on exactly the paths
# that exist to DETECT a redaction bug, so an unchecked echo prints the secret
# to the terminal and into the CI log at the precise moment redaction failed.
# Withholds rather than masking wholesale, so an ordinary failure still shows
# the output that explains it.
diag_output() { # diag_output <text>
  local text="$1"
  if printf '%s' "${text}" | grep -qF "${EXPECTED_PASSWORD}" \
    || printf '%s' "${text}" | grep -qF "${EXPECTED_SECURE}" \
    || printf '%s' "${text}" | grep -qF "${EXPECTED_USERNAME}"; then
    echo "      output: <WITHHELD — it carries a resolved secret, which is itself the bug>" >&2
    return 0
  fi
  echo "      output: ${text}" >&2
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
    # The `aws s3 rm` above only wrote DELETE MARKERS. Purge the versions they
    # hide, NONCURRENT-only: this same function runs from the pre-run sweep and
    # from the failure/INT/TERM traps, where a live state.json may still be the
    # only record of resources that are still standing -- deleting it would
    # strand them. The success path below does the full sweep, once destroy has
    # been asserted, and that is where the zero-assertion lives.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
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
ENV_DB_URL=$(get_env DB_URL)
ENV_SSM_SECURE_COPY=$(get_env SSM_SECURE_COPY)
ENV_PUBLIC_URL=$(get_env PUBLIC_URL)

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
check_not_literal DB_URL "${ENV_DB_URL}"
check_not_literal SSM_SECURE_COPY "${ENV_SSM_SECURE_COPY}"
check_not_literal PUBLIC_URL "${ENV_PUBLIC_URL}"

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
# The MIXED leaf must reach AWS with the reference SUBSTITUTED INTO the
# surrounding text (issue #1926 review). This is the PREMISE of Phase 1g: the
# live resource holds the decrypted value, so a readback of it is a disclosure
# unless state redacts it. Without this assertion Phase 1g could pass because
# nothing was ever resolved.
check_equals "DB_URL (Fn::Join embedding an ssm SecureString)" \
  "${ENV_DB_URL}" "postgres://app-svc:${EXPECTED_SECURE}@db.${REGION}.internal:5432/app"
# The SecureString still has to REACH AWS decrypted — issue #1901 changes what
# STATE holds, never what the provider is handed.
check_equals "SSM_SECURE_VALUE (ssm:<name> SecureString param, decrypted)" \
  "${ENV_SSM_SECURE_VALUE}" "${EXPECTED_SECURE}"
# The PREMISE of Phase 1f2 (issue #2012). That phase asserts the key is redacted
# once its position source is removed, which proves nothing unless the LIVE
# resource genuinely holds the decrypted value at that key — the readback is
# what makes the plaintext arrive in `observedProperties` at all.
check_equals "SSM_SECURE_COPY (second reference to the same SecureString)" \
  "${ENV_SSM_SECURE_COPY}" "${EXPECTED_SECURE}"
# The PREMISE of the PUBLIC_URL arms in Phases 1f / 1f3 / 1g, for the same
# reason. Each compares the persisted value against the RESOLVED one (or, in
# 1f3, against the expression that replaced it), so if the public reference
# never resolved on the way to AWS the comparison would be about a value that
# does not exist.
check_equals "PUBLIC_URL (Fn::Join embedding a PUBLIC ssm String)" \
  "${ENV_PUBLIC_URL}" "${EXPECTED_PUBLIC_URL}"

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
# The version-stage reference resolves to the SAME value as SECRET_PASSWORD
# (issue #1910 restored that collision deliberately — see the stack comment),
# so this assertion and the `:AWSCURRENT` guard on SECRET_PASSWORD above are a
# PAIR: together they fence both directions of the collapse. Neither is
# sufficient alone, because a collapsed state still holds a valid-looking
# secretsmanager expression at both leaves.
case "${STATE_SECRET_PASSWORD_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: state SECRET_PASSWORD_STAGED kept its OWN staged expression: ${STATE_SECRET_PASSWORD_STAGED}" ;;
  *) echo "FAIL: state SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${STATE_SECRET_PASSWORD_STAGED}")" >&2; redaction_fail=1 ;;
esac

# Guard 3a-mixed (issue #1926 review): the MIXED leaf — the reference EMBEDDED
# in surrounding text rather than being the whole value, which is what an
# `Fn::Join` around a secret renders. On the CREATE path the secrets map is
# populated, so the value SCAN redacts the embedded span; the harder path (empty
# map, position only) is Phase 1g. Asserting both halves means a regression in
# either is attributed to the right one.
STATE_DB_URL=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.DB_URL // empty')
if [ "${STATE_DB_URL}" = "${EXPECTED_DB_URL_EXPR}" ]; then
  echo "    OK: state DB_URL kept the EMBEDDED expression: ${STATE_DB_URL}"
else
  echo "FAIL: state DB_URL is not the expected embedded form: $(mask "${STATE_DB_URL}")" >&2
  redaction_fail=1
fi

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
  diag_output "${DIFF_OUT}"
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
  diag_output "${SCRUB_OUT}"
  exit 1
fi

# --- Phase 1d: `cdkd drift` and the secret expressions (issue #1914) -------
# The drift command is state-driven, so its baseline is the REDACTED record —
# `{{resolve:...}}` expressions — while `readCurrentState` returns the resolved
# plaintext AWS actually holds. Nothing reconciled the two, and all three of the
# command's modes broke on it: the comparison could not compare (PR #1899 bought
# quiet by SKIPPING every secret-bearing leaf, which also made a real console
# edit of one undetectable), `--accept` persisted the plaintext into state.json,
# and `--revert` shipped the literal `{{resolve:...}}` token to the live Lambda.
#
# Four assertions, in the order the fix has to hold them:
#   (a) a freshly deployed stack reports NO drift,
#   (b) no drift output ever carries the plaintext — nor any OTHER value at a
#       path known to carry a secret, since cdkd cannot tell an out-of-band edit
#       from the previous version of a rotated secret and must mask both,
#   (c) `--revert` leaves the live env var holding the RESOLVED value,
#   (d) `--accept` refuses a masked path and leaves no plaintext in state.json,
#       while still recording the non-secret paths in the same run.
#
# Ordered so the stack is handed back to Phase 1e exactly as it was found: the
# injected drift is reverted, and the accepted key is removed and re-accepted.
echo "==> Phase 1d: cdkd drift on a dynamic-reference stack (issue #1914)"

drift_env() { # drift_env <var> -> live value of one consumer-Lambda env var
  aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    | jq -r --arg k "$1" '.Environment.Variables[$k] // empty'
}

# Re-send the consumer Lambda's WHOLE env map with one key overridden (or added).
# The map is never echoed — it carries the resolved secrets by construction.
set_live_env() { # set_live_env <key> <value>
  local key="$1" value="$2" env_json
  env_json=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" \
    | jq -c --arg k "${key}" --arg v "${value}" '{Variables: (.Environment.Variables + {($k): $v})}') \
    || return 1
  aws lambda update-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" --environment "${env_json}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "${FN_NAME}" --region "${REGION}" \
    2>/dev/null || aws lambda wait function-updated --function-name "${FN_NAME}" --region "${REGION}"
}

drop_live_env() { # drop_live_env <key>
  local key="$1" env_json
  env_json=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" \
    | jq -c --arg k "${key}" '{Variables: (.Environment.Variables | del(.[$k]))}') \
    || return 1
  aws lambda update-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" --environment "${env_json}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "${FN_NAME}" --region "${REGION}" \
    2>/dev/null || aws lambda wait function-updated --function-name "${FN_NAME}" --region "${REGION}"
}

# grep -qF so a match is never echoed. Checks every known plaintext, including
# the SecureString one, which has no sibling resource legitimately holding it.
assert_no_plaintext() { # assert_no_plaintext "<what>" "<text>"
  local what="$1" text="$2" leaked=0
  printf '%s' "${text}" | grep -qF "${EXPECTED_PASSWORD}" && leaked=1
  printf '%s' "${text}" | grep -qF "${EXPECTED_SECURE}" && leaked=1
  printf '%s' "${text}" | grep -qF "${EXPECTED_USERNAME}" && leaked=1
  if [ "${leaked}" -ne 0 ]; then
    echo "FAIL: ${what} leaked a resolved secret plaintext" >&2
    exit 1
  fi
  echo "    OK: ${what} carries no plaintext"
}

run_drift() { # run_drift <extra args...> -> sets DRIFT_OUT / DRIFT_RC
  set +e
  DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" "$@" 2>&1)
  DRIFT_RC=$?
  set -e
}

# (a) + (b): a freshly deployed dynamic-ref stack has NO drift, and says so
# without printing anything the state record deliberately does not hold.
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' reported drift on a freshly deployed stack (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift' on a clean stack" "${DRIFT_OUT}"
echo "    OK: no drift on the freshly deployed stack"

# Inject drift the way a console edit would: overwrite ONE secret-bearing env
# var, leaving the rest of the map alone.
echo "==> Injecting out-of-band drift on the consumer Lambda's SECRET_PASSWORD"
DRIFT_SENTINEL="cdkd-drift-injected-not-the-secret"
set_live_env SECRET_PASSWORD "${DRIFT_SENTINEL}"

# The edit MUST be detected. Before the fix the comparator skipped every leaf
# whose state side is an expression, so this returned rc=0 — the assertion that
# makes the like-for-like comparison non-vacuous.
run_drift
if [ "${DRIFT_RC}" -eq 0 ]; then
  echo "FAIL: 'cdkd drift' saw no drift after SECRET_PASSWORD was changed out of band" >&2
  exit 1
fi
assert_no_plaintext "'cdkd drift' on a drifted secret leaf" "${DRIFT_OUT}"
if ! printf '%s' "${DRIFT_OUT}" | grep -qF "Environment.Variables.SECRET_PASSWORD"; then
  echo "FAIL: 'cdkd drift' did not name the drifted secret env var" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
# The state side of the diff must be the EXPRESSION (not the value it resolves
# to, and not a blind mask).
if ! printf '%s' "${DRIFT_OUT}" | grep -qF "{{resolve:secretsmanager:"; then
  echo "FAIL: the drift report's state side is not the {{resolve:...}} expression" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: the console edit is reported, with the expression on the state side"

# ...and the injected value itself must NOT be printed. cdkd cannot tell an
# out-of-band edit from the PREVIOUS version of a rotated secret — both are "a
# value at a path known to carry a secret that is not what the reference
# resolves to today" — so the AWS side of such a diff is masked. This sentinel
# is the stand-in for the rotated case, which needs no rotation to express.
if printf '%s' "${DRIFT_OUT}" | grep -qF "${DRIFT_SENTINEL}"; then
  echo "FAIL: 'cdkd drift' printed the AWS-current value at a secret-bearing path verbatim" >&2
  exit 1
fi
if ! printf '%s' "${DRIFT_OUT}" | grep -qF '***'; then
  echo "FAIL: 'cdkd drift' did not mask the AWS side of the drifted secret path" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: the unidentifiable AWS-side value is masked, not printed"

# The DRIFTED SET must be exactly that one path: every other secret-bearing env
# var compares expression-vs-plaintext too, so a fix that resolved nothing (or
# resolved only some references) shows up here as phantom drift.
set +e
DRIFT_JSON=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
set -e
DRIFT_PATHS=$(printf '%s' "${DRIFT_JSON}" \
  | jq -r '.[].drifted[] | select(.type=="AWS::Lambda::Function") | .changes[].path' \
  | sort | tr '\n' ',' | sed 's/,$//')
if [ "${DRIFT_PATHS}" != "Environment.Variables.SECRET_PASSWORD" ]; then
  echo "FAIL: expected exactly one drifted Lambda path, got: ${DRIFT_PATHS}" >&2
  exit 1
fi
assert_no_plaintext "'cdkd drift --json'" "${DRIFT_JSON}"
echo "    OK: exactly one drifted path — no phantom drift on the untouched references"

# --- The all-changes-REFUSED wording (issue #1958) -------------------------
# Everything above proves the refusal HAPPENS. This proves cdkd SAYS SO
# CONSISTENTLY. Two user-visible strings used to contradict the per-change
# `not accepting` warning printed right beside them:
#   - the PLAN header announced `update cdkd state for <stack>` over a body
#     that is nothing but `SKIPPED` lines;
#   - the SUMMARY counted DRIFTED resources rather than RECORDED ones, so it
#     reported `accepted drift on 1 resource(s)` for a run that accepted none.
# Both are read against the state this fixture is already in, which is the only
# state that can tell the two binaries apart: exactly one drifted resource,
# carrying exactly one change, and that change refused.
#
# PREMISE FIRST. Both assertions describe what cdkd says when EVERY change of
# EVERY drifted resource is refused, so a run with nothing to refuse would
# satisfy the same wording for the wrong reason. `DRIFT_JSON` was captured
# immediately above and nothing has been written since.
DRIFTED_RESOURCES=$(printf '%s' "${DRIFT_JSON}" | jq '[.[].drifted[]] | length')
DRIFTED_CHANGES=$(printf '%s' "${DRIFT_JSON}" | jq '[.[].drifted[].changes[]] | length')
if [ "${DRIFTED_RESOURCES}" != "1" ] || [ "${DRIFTED_CHANGES}" != "1" ]; then
  echo "FAIL: the all-refused premise does not hold — expected 1 drifted resource carrying 1 change, got ${DRIFTED_RESOURCES} resource(s) / ${DRIFTED_CHANGES} change(s)" >&2
  exit 1
fi
echo "    OK: exactly one drifted resource carrying exactly one change — the all-refused premise"

# The PLAN half. `printAcceptPlan` runs BEFORE the `--dry-run` short-circuit,
# so this is the very header the write path prints too.
echo "==> Asserting the --accept PLAN does not promise a write it will refuse (issue #1958)"
set +e
ACCEPT_PLAN_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --dry-run 2>&1)
ACCEPT_PLAN_RC=$?
set -e
if [ "${ACCEPT_PLAN_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept --dry-run' failed (rc=${ACCEPT_PLAN_RC})" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --accept --dry-run'" "${ACCEPT_PLAN_OUT}"
# The body really is all-SKIPPED, from the command's own mouth — a second
# reading of the premise above, taken from the output being asserted on.
if ! printf '%s' "${ACCEPT_PLAN_OUT}" | grep -qF "SKIPPED"; then
  echo "FAIL: the --accept plan printed no SKIPPED line, so its header is not being read over an all-refused body" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
# POSITIVE marker: only the fixed binary emits this header.
if ! printf '%s' "${ACCEPT_PLAN_OUT}" | grep -qF "no accepted values will be written to cdkd state for"; then
  echo "FAIL: the --accept plan did not say that no accepted values will be written" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
# ...and it names WHAT the run does still write. `no accepted values`, not
# `nothing`: the real run over this same input takes the lock, bumps
# lastModified and rewrites the bag through the positioned re-redaction, so a
# plan promising an untouched state.json would be false the other way round.
if ! printf '%s' "${ACCEPT_PLAN_OUT}" | grep -qF "positioned re-redaction"; then
  echo "FAIL: the --accept plan did not name the positioned re-redaction the run still writes" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
# NEGATIVE: the pre-change header. Paired with the two positives above so this
# arm cannot go green by asserting absences over an empty output.
if printf '%s' "${ACCEPT_PLAN_OUT}" | grep -qF "Plan (--accept): update cdkd state for"; then
  echo "FAIL: the --accept plan still promises 'update cdkd state for' over an all-refused body" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
echo "    OK: the plan describes the body it prints, and names the write it does make"

# --accept must REFUSE this path rather than persisting what it just masked:
# writing `***` into the baseline would corrupt state and make the next deploy
# push the literal mask at AWS. The drift keeps being reported, which is the
# honest outcome — `--revert` below is what actually fixes it.
echo "==> Asserting --accept refuses the unidentifiable secret-bearing path"
set +e
ACCEPT_REFUSE_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes 2>&1)
ACCEPT_REFUSE_RC=$?
set -e
if [ "${ACCEPT_REFUSE_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed instead of refusing the path (rc=${ACCEPT_REFUSE_RC})" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --accept' on a masked path" "${ACCEPT_REFUSE_OUT}"
if ! printf '%s' "${ACCEPT_REFUSE_OUT}" | grep -qF "not accepting"; then
  echo "FAIL: --accept did not say it was refusing the secret-bearing path" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
# The SUMMARY half (issue #1958). Same run, same all-refused input: the
# per-change warning asserted just above says nothing was accepted, so the
# summary must agree. A pre-change binary counts `driftedOutcomes.length` here
# and prints `accepted drift on 1 resource(s)` directly under that warning.
if ! printf '%s' "${ACCEPT_REFUSE_OUT}" | grep -qF "0 resource(s) accepted"; then
  echo "FAIL: --accept did not report 0 resource(s) accepted after refusing every drifted change" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
if printf '%s' "${ACCEPT_REFUSE_OUT}" | grep -qF "accepted drift on"; then
  echo "FAIL: --accept claimed it accepted drift in the same run it refused every change" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
# ...and the write DID happen, which is what makes `0 resource(s) accepted` the
# honest wording rather than `nothing was written`: the summary is still
# prefixed by the state-updated line. Without this, the two assertions above
# would both be satisfied by a run that had silently stopped writing.
if ! printf '%s' "${ACCEPT_REFUSE_OUT}" | grep -qF "State updated for ${STACK} (${REGION})"; then
  echo "FAIL: --accept did not report the state write it still performs" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
echo "    OK: the summary reports 0 resource(s) accepted over the write it still made"
REFUSED_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
if printf '%s' "${REFUSED_STATE}" | grep -qF "${DRIFT_SENTINEL}"; then
  echo "FAIL: --accept persisted the injected value at a secret-bearing path" >&2
  exit 1
fi
if printf '%s' "${REFUSED_STATE}" | grep -qF '"***"'; then
  echo "FAIL: --accept persisted the MASK into state.json" >&2
  exit 1
fi
REFUSED_ENV=$(printf '%s' "${REFUSED_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
case "$(printf '%s' "${REFUSED_ENV}" | jq -r '.SECRET_PASSWORD // empty')" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}')
    echo "FAIL: --accept left SECRET_PASSWORD on its staged sibling's expression" >&2
    exit 1
    ;;
  '{{resolve:secretsmanager:'*) echo "    OK: --accept left the path on its own expression" ;;
  *)
    echo "FAIL: --accept did not leave SECRET_PASSWORD as its own {{resolve:...}} expression" >&2
    exit 1
    ;;
esac

# (c) --revert must RE-RESOLVE the expression before handing it to the provider.
# Shipping the literal token is the live-breakage half of issue #1914.
echo "==> Reverting the injected drift"
set +e
REVERT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --revert --yes 2>&1)
REVERT_RC=$?
set -e
if [ "${REVERT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --revert' failed (rc=${REVERT_RC})" >&2
  diag_output "${REVERT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --revert'" "${REVERT_OUT}"

REVERTED_PASSWORD=$(drift_env SECRET_PASSWORD)
case "${REVERTED_PASSWORD}" in
  '{{resolve:'*)
    echo "FAIL: --revert wrote the LITERAL {{resolve:...}} token to the live Lambda: ${REVERTED_PASSWORD}" >&2
    exit 1
    ;;
esac
if [ "${REVERTED_PASSWORD}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: --revert left SECRET_PASSWORD as $(mask "${REVERTED_PASSWORD}"), expected the resolved secret" >&2
  exit 1
fi
echo "    OK: --revert restored the RESOLVED secret on the live Lambda"

# The whole env map is re-sent on a revert, so every OTHER reference had to be
# re-resolved too — a fix that only handled the drifted leaf corrupts these.
REVERTED_STAGED=$(drift_env SECRET_PASSWORD_STAGED)
REVERTED_SECURE=$(drift_env SSM_SECURE_VALUE)
REVERTED_FULL=$(drift_env SECRET_FULL)
if [ "${REVERTED_STAGED}" != "${EXPECTED_PASSWORD}" ] \
  || [ "${REVERTED_SECURE}" != "${EXPECTED_SECURE}" ] \
  || [ "${REVERTED_FULL}" != "${EXPECTED_FULL}" ]; then
  echo "FAIL: --revert corrupted a sibling reference the same update re-sent" >&2
  echo "      staged=$(mask "${REVERTED_STAGED}") secure=$(mask "${REVERTED_SECURE}") full=$(mask "${REVERTED_FULL}")" >&2
  exit 1
fi
echo "    OK: every sibling reference the same update re-sent stayed resolved"

# ...and the revert's own state write (the #1644 narrowing record) must not have
# persisted what it just resolved.
POST_REVERT_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
POST_REVERT_ENV=$(printf '%s' "${POST_REVERT_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
if printf '%s' "${POST_REVERT_ENV}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: --revert persisted the resolved secret into the observed baseline" >&2
  exit 1
fi
if printf '%s' "${POST_REVERT_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: --revert persisted the decrypted SecureString value into state" >&2
  exit 1
fi
echo "    OK: the revert's state write kept the expressions"

run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' still reports drift after --revert (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: the stack is clean again after --revert"

# --- A property AWS stops reporting is UNKNOWN, not drift ------------------
# The live twin of the write-only-credential shape (`MasterUserPassword` and
# friends, which no readback returns). Dropping the env var out of band makes
# `readCurrentState` answer with no SECRET_PASSWORD at all, which is the same
# `awsValue === undefined` at a secret-bearing leaf.
#
# Before the fix this was three bugs at once, all introduced by resolving the
# baseline — `calculateResourceDrift`'s `{{resolve:` skip stopped firing once
# the state side was no longer a token: drift reported forever, `--accept`
# writing `undefined` and so DELETING the `{{resolve:...}}` reference out of
# state, and `--revert` re-pushing the credential on every run. No new resource
# and no extra deploy is needed to reach it.
echo "==> Asserting an absent readback at a secret-bearing leaf is not drift"
drop_live_env SECRET_PASSWORD
# The setup must be PROVEN to have taken: a silent no-op here leaves a clean
# stack and every assertion below passes for the wrong reason. Same guard the
# pre-fix seed further down carries.
if [ -n "$(drift_env SECRET_PASSWORD)" ]; then
  echo "FAIL: could not drop SECRET_PASSWORD from the live Lambda — the assertions below would pass vacuously" >&2
  exit 1
fi
echo "    OK: SECRET_PASSWORD is absent from the live Lambda"

run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' reported drift for a property AWS no longer returns (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift' on an absent secret-bearing property" "${DRIFT_OUT}"
if printf '%s' "${DRIFT_OUT}" | grep -qF "Environment.Variables.SECRET_PASSWORD"; then
  echo "FAIL: 'cdkd drift' named a property it cannot read back as drifted" >&2
  exit 1
fi
echo "    OK: an unreadable secret-bearing property is reported as neither clean nor drifted"

# ...and the reference must survive an --accept run driven by anything else.
set_live_env DRIFT_ABSENT_PROBE "cdkd-absent-probe"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes >/dev/null 2>&1
ABSENT_ACCEPT_RC=$?
set -e
if [ "${ABSENT_ACCEPT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed while a secret-bearing property was unreadable (rc=${ABSENT_ACCEPT_RC})" >&2
  exit 1
fi
ABSENT_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
ABSENT_ENV=$(printf '%s' "${ABSENT_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
# The accept must have LANDED, or the reference below survives only because
# nothing was written at all.
if [ "$(printf '%s' "${ABSENT_ENV}" | jq -r '.DRIFT_ABSENT_PROBE // empty')" != "cdkd-absent-probe" ]; then
  echo "FAIL: --accept did not record the probe key, so the reference assertion below is vacuous" >&2
  exit 1
fi
# observedProperties, NOT properties: this record HAS an observed capture, so
# that is the bag `--accept` rewrites (the `hasObserved` branch). Asserting
# against `properties` reads a bag the command never touches, which passes
# whether or not the fix is present.
ABSENT_PW=$(printf '%s' "${ABSENT_ENV}" | jq -r '.SECRET_PASSWORD // empty')
case "${ABSENT_PW}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}')
    # Inert here — no collapse route reaches this arm — but kept so all three
    # SECRET_PASSWORD checks in this file read the same way, and so a future
    # change that DOES open one is caught by whichever runs first.
    echo "FAIL: --accept left SECRET_PASSWORD on its staged sibling's expression" >&2
    exit 1
    ;;
  '{{resolve:secretsmanager:'*)
    echo "    OK: --accept left the unreadable property's reference intact in the observed baseline"
    ;;
  '')
    echo "FAIL: --accept ERASED the {{resolve:...}} reference from state.observedProperties" >&2
    exit 1
    ;;
  *)
    echo "FAIL: state SECRET_PASSWORD is no longer its {{resolve:...}} expression: $(mask "${ABSENT_PW}")" >&2
    exit 1
    ;;
esac

# Restore: put the resolved value back and drop the probe key, then re-accept so
# the observed baseline matches AWS again before phase 1d's seed.
set_live_env SECRET_PASSWORD "${EXPECTED_PASSWORD}"
drop_live_env DRIFT_ABSENT_PROBE
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes >/dev/null 2>&1
set -e
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: could not restore a clean drift state after the absent-property arm (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: stack restored to a clean drift state"

# (d) --accept must not carry a plaintext into state.json, on either of the two
# routes it can arrive by.
#
# Route 1 is the AWS-CURRENT value: the drift is injected on a NON-secret key so
# the accepted write is a real one, and what makes the assertion bite is that
# before the fix every secret-bearing leaf ALSO drifted, so the same `--accept`
# wrote every resolved secret into state.
#
# Route 2 is the bag ALREADY IN STATE, and it cannot be produced by driving the
# CLI — it is what a user HAS after running `cdkd drift --accept` on a pre-fix
# binary: `observedProperties` holding the resolved secret while `properties`
# still holds the expression. Re-accepting for an unrelated key re-persists that
# whole bag. So the record is seeded directly into the state bucket here, which
# is the only way to reach the positioned redaction at all — the very pass a
# mutation probe was used to justify, and which had no real-AWS coverage
# without this.
echo "==> Seeding a PRE-FIX state record (plaintext in observedProperties)"
PREFIX_SEED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq --arg pw "${EXPECTED_PASSWORD}" '
      .resources |= with_entries(
        if .value.resourceType == "AWS::Lambda::Function"
           and (.value.observedProperties.Environment.Variables.SECRET_PASSWORD? != null)
        then .value.observedProperties.Environment.Variables.SECRET_PASSWORD = $pw
        else . end)') || {
  echo "FAIL: could not read the state document to seed the pre-fix shape" >&2
  exit 1
}
# Fail loudly rather than seeding nothing: every assertion below would pass
# vacuously against an unmodified record.
if ! printf '%s' "${PREFIX_SEED}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: the pre-fix seed did not take — no plaintext in the patched document" >&2
  exit 1
fi
printf '%s' "${PREFIX_SEED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}"
echo "    OK: state now holds the plaintext an older binary would have written"

echo "==> Accepting an out-of-band env addition"
set_live_env DRIFT_EXTRA "cdkd-drift-extra"
set +e
ACCEPT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes 2>&1)
ACCEPT_RC=$?
set -e
if [ "${ACCEPT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed (rc=${ACCEPT_RC})" >&2
  diag_output "${ACCEPT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --accept'" "${ACCEPT_OUT}"

POST_ACCEPT_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
POST_ACCEPT_ENV=$(printf '%s' "${POST_ACCEPT_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
# Non-vacuous: the accept really did write something.
if [ "$(printf '%s' "${POST_ACCEPT_ENV}" | jq -r '.DRIFT_EXTRA // empty')" != "cdkd-drift-extra" ]; then
  echo "FAIL: --accept did not record the out-of-band env addition" >&2
  exit 1
fi
if printf '%s' "${POST_ACCEPT_ENV}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: --accept persisted the resolved secret plaintext into state.json" >&2
  exit 1
fi
if printf '%s' "${POST_ACCEPT_ENV}" | grep -qF "${EXPECTED_USERNAME}"; then
  echo "FAIL: --accept persisted the whole-secret plaintext into state.json" >&2
  exit 1
fi
if printf '%s' "${POST_ACCEPT_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: --accept persisted the decrypted SecureString value into state.json" >&2
  exit 1
fi
ACCEPT_STATE_PASSWORD=$(printf '%s' "${POST_ACCEPT_ENV}" | jq -r '.SECRET_PASSWORD // empty')
case "${ACCEPT_STATE_PASSWORD}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}')
    echo "FAIL: --accept left SECRET_PASSWORD on its staged sibling's expression" >&2
    exit 1
    ;;
  '{{resolve:secretsmanager:'*) : ;;
  *)
    echo "FAIL: --accept did not keep SECRET_PASSWORD as its own {{resolve:...}} expression" >&2
    exit 1
    ;;
esac
echo "    OK: --accept wrote the AWS-current value and left every secret leaf on its expression"
# ...and specifically: the plaintext SEEDED into observedProperties above is
# gone, re-redacted onto its own expression by the positioned pass. The
# `EXPECTED_PASSWORD` grep on `POST_ACCEPT_ENV` a few lines up is what proves
# it, but only because of the seed — without it that grep passes on a bag that
# never held the plaintext in the first place. This line records the dependency
# so the seed is not tidied away as setup noise.
echo "    OK: the seeded pre-fix plaintext was re-redacted out of the observed baseline"

# Restore: drop the injected key and re-accept, so Phase 1e starts from the
# baseline Phase 1 deployed.
drop_live_env DRIFT_EXTRA
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes >/dev/null 2>&1
set -e
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: could not restore the stack to a clean drift state (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: stack restored to a clean drift state"

# --- Phase 1e: standalone rollback RE-RESOLVES secret expressions (GHSA #1899) ---
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
echo "==> Phase 1e: --no-rollback failing deploy + standalone rollback re-resolves the secret"
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

# --- Phase 1f: `cdkd state refresh-observed` REDACTS (GHSA residual #1926) ---
# `refresh-observed` writes the provider readback into `observedProperties` and
# saves. The readback is what AWS actually holds — for this fixture's consumer
# Lambda that is the DECRYPTED secret, because the deploy sent the resolved
# value — so before issue #1926 this command persisted the plaintext into
# state.json with no redaction pass of any kind. It is the only observed-writer
# the #1910 sweep never reached, and unlike #1915 it leaked SCALARS too.
#
# Its secrets map is EMPTY by construction (the command neither synthesizes nor
# resolves), so what this arm really exercises is the PATH pass: the record's
# own `properties` still hold the expressions and position the observed bag
# against them.
#
# ORDERING. This runs after Phase 1e and before Phase 2 because it WRITES
# `observedProperties`. The drift phase (1d) reads that field as its baseline,
# so placing this arm before it would change what drift compares; Phase 2
# (a redeploy asserting AWS-side removal resets) and Phase 3 (destroy) read
# only `properties` and the live AWS state, so neither is affected.
echo "==> Phase 1f: cdkd state refresh-observed redacts the readback (issue #1926)"
# STALENESS GUARD. The deploy ALREADY wrote a correctly-redacted
# `observedProperties` for this Lambda, so every assertion below is satisfied by
# the pre-existing bag — a `refresh-observed` that wrote nothing at all would
# pass this phase. Stamp a sentinel into the persisted bag first, and require it
# to be GONE afterwards: only an actual refresh can remove it.
#
# Written directly to S3 rather than through the CLI because no command edits
# `observedProperties` in place — that is the point. Safe here: nothing else
# holds the lock between phases, and the next `saveState` reads its own etag.
echo "    stamping a staleness sentinel into the persisted observedProperties"
RO_STAMP_BEFORE=$(mktemp)
RO_STAMP_AFTER=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${RO_STAMP_BEFORE}" --quiet
# Resolve the logical id FIRST. An assignment cannot be written THROUGH
# `to_entries[]`: that builds a new array rather than a path back into the
# document, and jq rejects it with "Invalid path expression". Phase 1g below
# already uses this shape; Phase 1f now matches it.
RO_LID=$(jq -r '.resources | to_entries[]
                  | select(.value.resourceType=="AWS::Lambda::Function")
                  | .key' "${RO_STAMP_BEFORE}" | head -1)
if [ -z "${RO_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1f cannot stamp" >&2
  exit 1
fi
# Assert the bag EXISTS before stamping. A plain assignment would CREATE the
# path, so the post-stamp grep would succeed on a record that never had a
# deploy-time capture — turning the freshness guard into a no-op.
if ! jq -e --arg lid "${RO_LID}" \
     '.resources[$lid].observedProperties.Environment.Variables | objects | has("SSM_VALUE")' \
     "${RO_STAMP_BEFORE}" >/dev/null; then
  echo "FAIL: the Lambda has no persisted observedProperties.Environment.Variables to stamp" >&2
  echo "      (the deploy-time capture is expected to have written one; without it this phase cannot prove freshness)" >&2
  exit 1
fi
jq --arg lid "${RO_LID}" \
  '.resources[$lid].observedProperties.Environment.Variables.SSM_VALUE = "STALE-SENTINEL"' \
  "${RO_STAMP_BEFORE}" > "${RO_STAMP_AFTER}"
if ! grep -q 'STALE-SENTINEL' "${RO_STAMP_AFTER}"; then
  echo "FAIL: the sentinel stamp produced no sentinel — jq path expression is wrong" >&2
  exit 1
fi
aws s3 cp "${RO_STAMP_AFTER}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${RO_STAMP_BEFORE}" "${RO_STAMP_AFTER}"

# No `set +e` window around this call. An earlier revision wrapped it to tolerate
# a transient per-resource readback failure; the sentinel above makes that
# tolerance harmful, because a refresh that skipped this Lambda would leave the
# sentinel behind and the failure should be reported as what it is. Removing the
# wrapper simply lets the script's own `set -euo pipefail` (line 63) do it —
# there is no assertion added here beyond that.
node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RO_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
RO_OBSERVED=$(printf '%s' "${RO_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
# A missing / null observed bag would make every assertion below vacuously
# pass, so the run FAILS instead: `LambdaFunctionProvider.readCurrentState`
# reports `Environment.Variables`, and if that ever stops being true this arm
# stops testing anything.
if [ -z "${RO_OBSERVED}" ] || [ "${RO_OBSERVED}" = "null" ]; then
  echo "FAIL: refresh-observed wrote no observedProperties.Environment.Variables for the consumer Lambda" >&2
  exit 1
fi

RO_PASSWORD=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SECRET_PASSWORD // empty')
RO_SECURE=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SSM_SECURE_VALUE // empty')
RO_SSM=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SSM_VALUE // empty')

RO_PASSWORD_STAGED=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SECRET_PASSWORD_STAGED // empty')

refresh_fail=0
# The staleness guard's payoff: the sentinel is only gone if this command
# actually re-read AWS and rewrote the bag.
if printf '%s' "${RO_OBSERVED}" | grep -q 'STALE-SENTINEL'; then
  echo "FAIL: refresh-observed did not rewrite observedProperties — the staleness sentinel survived" >&2
  echo "      (every redaction assertion below would have passed on the deploy-time bag)" >&2
  refresh_fail=1
else
  echo "    OK: the staleness sentinel is gone — this bag was written by refresh-observed"
fi
case "${RO_PASSWORD}" in
  '{{resolve:secretsmanager:'*) echo "    OK: observed SECRET_PASSWORD kept the expression: ${RO_PASSWORD}" ;;
  *) echo "FAIL: observed SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${RO_PASSWORD}")" >&2; refresh_fail=1 ;;
esac
# The COLLAPSE pair, exactly as Guard 3 spells it on `properties`. The prefix
# check above accepts ANY secretsmanager expression, so on its own it passes on
# the collapsed state (#1904 / #1910): SECRET_PASSWORD and its staged sibling
# resolve to ONE value, so a value-keyed rewrite hands this leaf the OTHER
# one's expression and the prefix still matches. `refresh-observed` is a NEW
# writer of this bag, so it needs both directions fenced here too — and the
# plaintext greps below cannot see this one, since both spellings are valid
# expressions carrying no plaintext at all.
case "${RO_PASSWORD}" in
  *':AWSCURRENT}}')
    echo "FAIL: observed SECRET_PASSWORD took the STAGED expression — the colliding pair collapsed (#1910)" >&2
    refresh_fail=1
    ;;
esac
case "${RO_PASSWORD_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: observed SECRET_PASSWORD_STAGED kept its OWN staged expression: ${RO_PASSWORD_STAGED}" ;;
  *) echo "FAIL: observed SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${RO_PASSWORD_STAGED}")" >&2; refresh_fail=1 ;;
esac
# The ssm/ssm discriminator, same pair as Guards 3b + 4 on `properties`: the
# SecureString reference must be an expression while the plain String one must
# stay RESOLVED. A redaction that keyed on the SPELLING would fail the second.
case "${RO_SECURE}" in
  '{{resolve:ssm:'*) echo "    OK: observed SSM_SECURE_VALUE kept the expression: ${RO_SECURE}" ;;
  *) echo "FAIL: observed SSM_SECURE_VALUE is NOT the {{resolve:...}} expression: $(mask "${RO_SECURE}")" >&2; refresh_fail=1 ;;
esac
if [ "${RO_SSM}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: observed SSM_VALUE kept the resolved value (ssm String is public config)"
else
  echo "FAIL: observed SSM_VALUE should be the resolved '${EXPECTED_SSM}', got $(mask "${RO_SSM}")" >&2
  refresh_fail=1
fi
# The PUBLIC mixed leaf, and what this arm can HONESTLY assert about it — which
# is NOT issue #2036's residual, though an earlier revision of this phase said
# so and FAILED on both fixed code and `main` (PR #2415's pre-merge run, rc=1 at
# exactly this line).
#
# The reason is one step upstream of the redaction: `properties` holds this key
# RESOLVED. A public ssm `String` is persisted resolved by construction (issue
# #1901 — otherwise every parameter-backed property is a perpetual spurious
# UPDATE), and the `Fn::Join` around it declines the skeleton pass, so the
# POSITION SOURCE for PUBLIC_URL carries no reference at all.
# `refuseUncertifiedReadbackPositions` never reaches its mixed-leaf arm here:
# `isDynamicReferenceString(source)` is false and the readback value passes
# straight through. The verdict store is not consulted either way.
#
# #2036's residual is real, but it needs a source that CARRIES the expression,
# which in the wild only `cdkd import`'s warn path produces. Phase 1f3 stamps
# exactly that shape and asserts the residual there, on a premise that holds.
#
# This arm is a PREMISE PIN, not a discriminator: `origin/main` answers the same,
# for the same reason. It is kept because it is falsifiable by a FUTURE
# over-reach — a blanket needle, or a pairing rule that starts substituting at a
# non-reference source leaf — and because the premise it states is the one two
# earlier arms got wrong.
RO_PUBLIC_URL=$(printf '%s' "${RO_OBSERVED}" | jq -r '.PUBLIC_URL // empty')
if [ "${RO_PUBLIC_URL}" = "${EXPECTED_PUBLIC_URL}" ]; then
  echo "    OK: observed PUBLIC_URL kept the resolved value (premise pin; its source carries no expression)"
else
  echo "FAIL: observed PUBLIC_URL should be '${EXPECTED_PUBLIC_URL}', got $(mask "${RO_PUBLIC_URL}")" >&2
  refresh_fail=1
fi
# Both whole-token SecureString references, each on its OWN expression. They
# spell the same reference, so this is not a collapse fence; it is the baseline
# Phase 1f2 perturbs — that phase orphans SSM_SECURE_COPY from the position
# source, and an arm that never checked it here could not tell "the derived
# needle reached it" from "it was fine all along".
RO_SECURE_COPY=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SSM_SECURE_COPY // empty')
if [ "${RO_SECURE_COPY}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: observed SSM_SECURE_COPY kept the expression (positioned by its own source key)"
else
  echo "FAIL: observed SSM_SECURE_COPY should be '${EXPECTED_SECURE_EXPR}', got $(mask "${RO_SECURE_COPY}")" >&2
  refresh_fail=1
fi

# Same scoping split as Guard 5: the secret's own resource legitimately holds
# the fixture's hardcoded password, so the password grep is scoped to the
# consumer Lambda's observed bag, while the decrypted SecureString has no such
# sibling and the WHOLE state document is scanned for it.
if printf '%s' "${RO_OBSERVED}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: refresh-observed persisted the DECRYPTED secret into observedProperties (#1926)" >&2
  refresh_fail=1
else
  echo "    OK: no resolved secret plaintext in the refreshed observed bag"
fi
if printf '%s' "${RO_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: refresh-observed persisted the decrypted SecureString into state (#1926)" >&2
  refresh_fail=1
else
  echo "    OK: no decrypted SecureString anywhere in the refreshed state document"
fi

if [ "${refresh_fail}" -ne 0 ]; then
  echo "FAIL: refresh-observed redaction assertions failed" >&2
  exit 1
fi

# --- Phase 1f2: an observed KEY the SOURCE does not carry (issue #2012) ---
# The residual row this lane closes, exercised against a REAL readback rather
# than a hand-built bag. `refuseUncertifiedReadbackPositions` substitutes only
# where the position source carries the key; a key AWS reports and the source
# does not has no source leaf to take, and with an EMPTY secrets map the value
# scan it falls back to had no needles — so the DECRYPTED SecureString was
# persisted into `observedProperties` and stayed there.
#
# What closes it is a needle DERIVED from a position the same pass certifies:
# SSM_SECURE_VALUE is in the source as a whole `{{resolve:...}}` token, so
# certifying it establishes that AWS's value there IS that expression resolved,
# and SSM_SECURE_COPY — which holds the same plaintext — matches by value.
#
# HOW THE SHAPE IS PRODUCED. In the wild the extra key comes from AWS itself
# (`FunctionArn`, `LastModified`, a defaulted field). A Lambda's
# `Environment.Variables` is echoed back key-for-key, so the fixture instead
# DELETES one key from the persisted `properties` before refreshing, which is
# the same input configuration: source lacks a key the readback has. The deletion
# is reverted immediately afterwards so Phase 1g starts from the state Phase 1f
# left, and the live Lambda is never touched.
#
# The direct S3 write is the idiom Phase 1f already uses for its staleness
# sentinel, and is safe for the same reason: nothing holds the lock between
# phases and the next `saveState` reads its own etag.
echo "==> Phase 1f2: refresh-observed redacts a key the position source does not carry (issue #2012)"

F2_BEFORE=$(mktemp)
F2_ORPHANED=$(mktemp)
F2_RESTORED=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F2_BEFORE}" --quiet
F2_LID=$(jq -r '.resources | to_entries[]
                  | select(.value.resourceType=="AWS::Lambda::Function")
                  | .key' "${F2_BEFORE}" | head -1)
if [ -z "${F2_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1f2 cannot run" >&2
  exit 1
fi
# Assert the key is THERE before deleting it. `del` on an absent path is a
# silent no-op, so without this the phase would refresh an unperturbed record
# and pass on the position pass alone — proving nothing about the needle.
if ! jq -e --arg lid "${F2_LID}" \
     '.resources[$lid].properties.Environment.Variables | objects | has("SSM_SECURE_COPY")' \
     "${F2_BEFORE}" >/dev/null; then
  echo "FAIL: properties.Environment.Variables.SSM_SECURE_COPY is absent — nothing to orphan" >&2
  exit 1
fi
jq --arg lid "${F2_LID}" \
  'del(.resources[$lid].properties.Environment.Variables.SSM_SECURE_COPY)' \
  "${F2_BEFORE}" > "${F2_ORPHANED}"
if jq -e --arg lid "${F2_LID}" \
     '.resources[$lid].properties.Environment.Variables | objects | has("SSM_SECURE_COPY")' \
     "${F2_ORPHANED}" >/dev/null; then
  echo "FAIL: could not orphan SSM_SECURE_COPY from the position source" >&2
  exit 1
fi
# Stamp the observed side with the PLAINTEXT the pre-fix code would have left
# there. Two things this buys, and neither is available without it: the refresh
# has something to CHANGE at this key (so a no-op refresh cannot pass), and the
# starting state is exactly the leak being closed rather than a bag Phase 1f
# already cleaned.
jq --arg lid "${F2_LID}" --arg plain "${EXPECTED_SECURE}" \
  '.resources[$lid].observedProperties.Environment.Variables.SSM_SECURE_COPY = $plain' \
  "${F2_ORPHANED}" > "${F2_RESTORED}"
mv "${F2_RESTORED}" "${F2_ORPHANED}"
if ! grep -qF "${EXPECTED_SECURE}" "${F2_ORPHANED}"; then
  echo "FAIL: the plaintext stamp produced no plaintext — jq path expression is wrong" >&2
  exit 1
fi
aws s3 cp "${F2_ORPHANED}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet

node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

F2_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
F2_OBSERVED=$(printf '%s' "${F2_STATE}" \
  | jq -c --arg lid "${F2_LID}" '.state.resources[$lid].observedProperties.Environment.Variables')
if [ -z "${F2_OBSERVED}" ] || [ "${F2_OBSERVED}" = "null" ]; then
  echo "FAIL: refresh-observed wrote no observed Environment.Variables for ${F2_LID}" >&2
  exit 1
fi

orphan_fail=0
F2_COPY=$(printf '%s' "${F2_OBSERVED}" | jq -r '.SSM_SECURE_COPY // empty')
if [ "${F2_COPY}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: the orphaned SSM_SECURE_COPY took the expression by DERIVED NEEDLE (#2012)"
else
  echo "FAIL: orphaned SSM_SECURE_COPY should be '${EXPECTED_SECURE_EXPR}', got $(mask "${F2_COPY}")" >&2
  orphan_fail=1
fi
# The sibling that SUPPLIED the needle must still be right: a regression that
# reached the orphan by rewriting everything would show here first.
F2_SECURE=$(printf '%s' "${F2_OBSERVED}" | jq -r '.SSM_SECURE_VALUE // empty')
if [ "${F2_SECURE}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: the certifying sibling SSM_SECURE_VALUE still holds its own expression"
else
  echo "FAIL: SSM_SECURE_VALUE should be '${EXPECTED_SECURE_EXPR}', got $(mask "${F2_SECURE}")" >&2
  orphan_fail=1
fi
# The CONTROL, and it is the half that separates a value-keyed needle from a
# blanket rewrite: a public leaf must not be dragged along. SSM_VALUE is stored
# RESOLVED and is not the learned plaintext, so it must survive untouched.
F2_SSM=$(printf '%s' "${F2_OBSERVED}" | jq -r '.SSM_VALUE // empty')
if [ "${F2_SSM}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: the public SSM_VALUE was not dragged along by the needle"
else
  echo "FAIL: SSM_VALUE should still be the resolved '${EXPECTED_SSM}', got $(mask "${F2_SSM}")" >&2
  orphan_fail=1
fi
# WHOLE-DOCUMENT: the decrypted SecureString has no legitimate home in state.
if printf '%s' "${F2_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: the decrypted SecureString survived at a position the source does not carry (#2012)" >&2
  orphan_fail=1
else
  echo "    OK: the decrypted SecureString is absent from the WHOLE state document"
fi

# RESTORE the position source before anything else runs. Done from the bag read
# at the top of this phase rather than by re-adding the key, so a jq slip cannot
# leave a subtly different value behind — and asserted, because a silent restore
# failure would make Phase 1g deploy an UPDATE it is not expecting.
F2_AFTER=$(mktemp)
F2_FINAL=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F2_AFTER}" --quiet
jq --arg lid "${F2_LID}" --slurpfile before "${F2_BEFORE}" \
  '.resources[$lid].properties = $before[0].resources[$lid].properties' \
  "${F2_AFTER}" > "${F2_FINAL}"
if ! jq -e --arg lid "${F2_LID}" \
     '.resources[$lid].properties.Environment.Variables | objects | has("SSM_SECURE_COPY")' \
     "${F2_FINAL}" >/dev/null; then
  echo "FAIL: could not restore the orphaned key into the position source" >&2
  exit 1
fi
aws s3 cp "${F2_FINAL}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${F2_BEFORE}" "${F2_ORPHANED}" "${F2_AFTER}" "${F2_FINAL}"

if [ "${orphan_fail}" -ne 0 ]; then
  echo "FAIL: derived-needle redaction assertions failed" >&2
  exit 1
fi

# --- Phase 1f3: the #2036 RESIDUAL (still OPEN), on a source that carries it ---
# Issue [#2036](https://github.com/go-to-k/cdkd/issues/2036) records an
# OVER-redaction: a MIXED leaf embedding a PUBLIC ssm reference, refused on the
# empty-map readback paths because absence from the verdict store is not
# evidence of anything. Phase 1f used to claim this shape, and could not have:
# `properties` holds PUBLIC_URL RESOLVED (issue #1901), so its position source
# carries no reference and the mixed-leaf arm is never consulted. The arm failed
# on fixed code AND on `main`, which is the signature of a false premise rather
# than a regression.
#
# HOW THE SHAPE IS PRODUCED. A public ssm EXPRESSION survives in `properties`
# only where something wrote it there without resolving: `cdkd import`'s warn
# path, which records the template leaf verbatim. It is unreachable from a
# template-declared leaf on the deploy path, because a properties-borne
# expression makes the resource read as CHANGED and the next UPDATE rewrites it
# resolved. So the fixture stamps it, the same S3 write/restore idiom Phases 1f
# and 1f2 already use, and for the same reason: no command edits this field in
# place, which is the point.
#
# WHICH ARM CARRIES THE DISCRIMINATION, stated because the phase this one
# replaces got exactly this wrong. The residual assertion below is a PIN, not a
# discriminator: `origin/main` refuses this leaf too, and so does this branch --
# issue #2036 stays OPEN, so the refusal rule is unchanged. Keeping the pin is
# still worth the lines (it is falsifiable by any future over-reach that starts
# substituting here), but it is not what earns the phase its runtime. The arm
# that DOES discriminate is the BLAST-RADIUS one: on `main` `SSM_VALUE` stays
# `cdkd-known-ssm-value`, and on this branch it takes its own parameter's
# expression, because only this branch derives a needle from the refused leaf.
#
# WHY #2036 IS STILL OPEN, since this phase is the closest thing to its arm: a
# PROVEN-public verdict store WOULD admit the resolved value here, and PR #2415
# drafted one and WITHDREW it. Keyed on the bare expression and living for the
# whole process, it un-redacts a same-named `SecureString` in another region on
# a `cdkd deploy --all` -- measured, and the un-redacting direction. A revival
# must key the verdict by SCOPE (region + account) at the READ side.
#
# A SEPARATE phase rather than a fold into 1f2, and the reason is measurable:
# once PUBLIC_URL's source carries the expression, `learnMixedLeafNeedle` learns
# `<resolved param value> -> {{resolve:ssm:<name>}}` from it, and the value scan
# then rewrites SSM_VALUE — which holds that same resolved value — onto the same
# expression. That is correct (it is the SAME parameter, so nothing is
# misattributed) but it would destroy Phase 1f2's `SSM_VALUE was not dragged
# along` control, which separates a value-keyed needle from a blanket rewrite.
# The two shapes are therefore exercised on their own records.
echo "==> Phase 1f3: refresh-observed refuses a PUBLIC mixed leaf with no verdict (issue #2036 residual)"

F3_BEFORE=$(mktemp)
F3_STAMPED=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F3_BEFORE}" --quiet
F3_LID=$(jq -r '.resources | to_entries[]
                  | select(.value.resourceType=="AWS::Lambda::Function")
                  | .key' "${F3_BEFORE}" | head -1)
if [ -z "${F3_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1f3 cannot run" >&2
  exit 1
fi
# ASSERT the pre-stamp value is the RESOLVED one. This is the phase's own
# premise stated as a check rather than a comment: if `properties` already held
# the expression, the stamp would be a no-op and the assertion below would pass
# without this phase having perturbed anything.
F3_PRE=$(jq -r --arg lid "${F3_LID}" \
  '.resources[$lid].properties.Environment.Variables.PUBLIC_URL // empty' "${F3_BEFORE}")
if [ "${F3_PRE}" != "${EXPECTED_PUBLIC_URL}" ]; then
  echo "FAIL: properties PUBLIC_URL should start RESOLVED as '${EXPECTED_PUBLIC_URL}', got $(mask "${F3_PRE}")" >&2
  echo "      (Phase 1f3 stamps the expression OVER the resolved value; without that start it proves nothing)" >&2
  exit 1
fi
jq --arg lid "${F3_LID}" --arg expr "${EXPECTED_PUBLIC_URL_EXPR}" \
  '.resources[$lid].properties.Environment.Variables.PUBLIC_URL = $expr' \
  "${F3_BEFORE}" > "${F3_STAMPED}"
if ! grep -qF "${EXPECTED_PUBLIC_URL_EXPR}" "${F3_STAMPED}"; then
  echo "FAIL: the PUBLIC_URL expression stamp produced no expression — jq path expression is wrong" >&2
  exit 1
fi
aws s3 cp "${F3_STAMPED}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet

node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

F3_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
F3_OBSERVED=$(printf '%s' "${F3_STATE}" \
  | jq -c --arg lid "${F3_LID}" '.state.resources[$lid].observedProperties.Environment.Variables')

# RESTORE `properties` FIRST, before a single assertion runs. Phase 1g's plain
# deploy must not see the stamped expression: it would read the resource as
# CHANGED and issue an UPDATE that phase is not expecting. Restoring here rather
# than after the assertions means an assertion failure -- or the empty-bag
# refusal below -- cannot leave the stamp behind either, and the `rm -f` of this
# phase's temp files sits on that same path.
#
# Several paths can still leave the stamp live, and saying so beats implying
# there is one: every command between the stamp and the upload below aborts the
# script under `set -e` -- the `refresh-observed` call, the `state show` / `jq`
# reads, this block's own `aws s3 cp` and `jq`, and its `exit 1` when the
# restore does not verify. Counting them is not the point and an earlier
# revision that said THREE was already wrong; what bounds them all is the EXIT
# trap, which destroys the stack and its state. Nothing else does, so do not
# move assertions back above this block.
#
# Done from the bag read at the TOP of this phase rather than by un-stamping, so
# a jq slip cannot leave a subtly different value behind, and asserted, because
# a silent restore failure is what would make Phase 1g deploy an unexpected
# UPDATE.
F3_AFTER=$(mktemp)
F3_FINAL=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F3_AFTER}" --quiet
jq --arg lid "${F3_LID}" --slurpfile before "${F3_BEFORE}" \
  '.resources[$lid].properties = $before[0].resources[$lid].properties' \
  "${F3_AFTER}" > "${F3_FINAL}"
F3_RESTORED=$(jq -r --arg lid "${F3_LID}" \
  '.resources[$lid].properties.Environment.Variables.PUBLIC_URL // empty' "${F3_FINAL}")
if [ "${F3_RESTORED}" != "${EXPECTED_PUBLIC_URL}" ]; then
  echo "FAIL: could not restore the RESOLVED PUBLIC_URL into the position source" >&2
  exit 1
fi
aws s3 cp "${F3_FINAL}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${F3_BEFORE}" "${F3_STAMPED}" "${F3_AFTER}" "${F3_FINAL}"

if [ -z "${F3_OBSERVED}" ] || [ "${F3_OBSERVED}" = "null" ]; then
  echo "FAIL: refresh-observed wrote no observed Environment.Variables for ${F3_LID}" >&2
  exit 1
fi

residual_fail=0
# THE RESIDUAL, as a PIN (it answers the same on `origin/main` — see the header).
# `cdkd state refresh-observed` neither synthesizes nor resolves, so no
# `GetParameter` ran in this process and the verdict store holds nothing about
# this parameter. Absence is not evidence, the leaf is refused, and the
# expression wins over the value AWS holds. Visible, recoverable, and NOT a
# disclosure — the price of never persisting a decrypted `SecureString` on a
# path that cannot tell the two apart.
F3_PUBLIC_URL=$(printf '%s' "${F3_OBSERVED}" | jq -r '.PUBLIC_URL // empty')
if [ "${F3_PUBLIC_URL}" = "${EXPECTED_PUBLIC_URL_EXPR}" ]; then
  echo "    OK: observed PUBLIC_URL took the expression (#2036 residual, still open — a PIN, same on main)"
else
  echo "FAIL: observed PUBLIC_URL should be '${EXPECTED_PUBLIC_URL_EXPR}', got $(mask "${F3_PUBLIC_URL}")" >&2
  residual_fail=1
fi
# THE NEEDLE'S BLAST RADIUS — and THE ARM THAT DISCRIMINATES in this phase.
# `origin/main` leaves this leaf as `cdkd-known-ssm-value`; only a tree that
# derives needles rewrites it. Refusing
# the leaf also LEARNS from it (`learnMixedLeafNeedle`), so every other leaf
# holding that same resolved value takes the same expression — here SSM_VALUE,
# which references the very same parameter. Nothing is misattributed, and the
# next `cdkd drift` re-resolves it, but the propagation is real and a future
# change that narrows it should have to edit this line rather than discover it
# in the field.
EXPECTED_PUBLIC_EXPR="{{resolve:ssm:${PARAM_NAME}}}"
F3_SSM=$(printf '%s' "${F3_OBSERVED}" | jq -r '.SSM_VALUE // empty')
if [ "${F3_SSM}" = "${EXPECTED_PUBLIC_EXPR}" ]; then
  echo "    OK: SSM_VALUE took its OWN parameter's expression by value (the needle's blast radius)"
elif [ "${F3_SSM}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "FAIL: SSM_VALUE took the SecureString expression — the needle was MISATTRIBUTED across parameters" >&2
  residual_fail=1
else
  echo "FAIL: SSM_VALUE should be '${EXPECTED_PUBLIC_EXPR}', got $(mask "${F3_SSM}")" >&2
  echo "      (pinned by the unit case 'propagates a NO-VERDICT ssm needle by VALUE once its own source carries the expression')" >&2
  residual_fail=1
fi
# The SecureString half must be unaffected by any of this.
F3_SECURE=$(printf '%s' "${F3_OBSERVED}" | jq -r '.SSM_SECURE_VALUE // empty')
if [ "${F3_SECURE}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: SSM_SECURE_VALUE still holds its own expression"
else
  echo "FAIL: SSM_SECURE_VALUE should be '${EXPECTED_SECURE_EXPR}', got $(mask "${F3_SECURE}")" >&2
  residual_fail=1
fi
# WHOLE-DOCUMENT: over-redacting a public leaf may never come with a disclosure.
if printf '%s' "${F3_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: the decrypted SecureString survived the #2036 residual phase (#1926)" >&2
  residual_fail=1
else
  echo "    OK: the decrypted SecureString is absent from the WHOLE state document"
fi

if [ "${residual_fail}" -ne 0 ]; then
  echo "FAIL: issue #2036 residual assertions failed" >&2
  exit 1
fi

# --- Phase 1g: the DEFAULT `cdkd deploy` path redacts a MIXED leaf (#1926 review) ---
# Phase 1f drives the command; this drives the path that matters more. The
# refusal was hoisted into `secret-redaction.ts` precisely because the leak is
# NOT specific to `cdkd state refresh-observed`: a plain `cdkd deploy`
# auto-refreshes the baseline of any resource whose `observedProperties` is
# ABSENT (`DeployEngine.kickOffAutoRefreshObservedProperties`, on by default via
# `captureObservedState`). Such a resource is UNCHANGED this deploy, so it has
# no secrets map and no template bag, and its readback drains through the
# persist choke point with exactly the configuration Phase 1f exercises by hand.
# Verifying only the command would leave the default path on unit tests alone.
#
# Reaching that path needs the bag ABSENT, which after Phase 1 it is not — so
# this arm clears it, then runs an ordinary deploy with no template change.
echo "==> Phase 1g: a plain deploy re-captures the baseline WITHOUT the plaintext (issue #1926)"

PRE_G_STATE=$(mktemp)
POST_G_STATE=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${PRE_G_STATE}" --quiet

# ASSERT, do not assume, that the deploy captures a baseline at all: a silently
# empty bag would make every assertion below vacuous. `captureObservedState`
# defaults ON, and Phase 1f has just refreshed it, so absence here means the
# capture broke rather than that this fixture opted out.
G_LID=$(jq -r '.resources | to_entries[]
                 | select(.value.resourceType=="AWS::Lambda::Function")
                 | .key' "${PRE_G_STATE}" | head -1)
if [ -z "${G_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1g cannot run" >&2
  exit 1
fi
G_HAD_OBSERVED=$(jq -r --arg lid "${G_LID}" \
  '.resources[$lid].observedProperties.Environment.Variables.DB_URL // empty' "${PRE_G_STATE}")
if [ -z "${G_HAD_OBSERVED}" ]; then
  echo "FAIL: the deploy captured no observedProperties.Environment.Variables.DB_URL for ${G_LID}" >&2
  echo "      (captureObservedState is ON by default; an empty bag makes this phase vacuous)" >&2
  exit 1
fi
echo "    OK: a baseline exists to re-capture (${G_LID})"

# Clear ONLY that resource's observed bag — the auto-refresh keys on its absence.
jq --arg lid "${G_LID}" 'del(.resources[$lid].observedProperties)' "${PRE_G_STATE}" > "${POST_G_STATE}"
if jq -e --arg lid "${G_LID}" 'has("resources") and (.resources[$lid] | has("observedProperties"))' \
     "${POST_G_STATE}" >/dev/null; then
  echo "FAIL: could not clear observedProperties for ${G_LID}" >&2
  exit 1
fi
aws s3 cp "${POST_G_STATE}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${PRE_G_STATE}" "${POST_G_STATE}"

# A PLAIN deploy: no CDKD_TEST_* mode, no template change. Every resource is
# NO_CHANGE, which is the point — an unchanged resource has no secrets map.
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

G_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
G_OBSERVED=$(printf '%s' "${G_STATE}" \
  | jq -c --arg lid "${G_LID}" '.state.resources[$lid].observedProperties.Environment.Variables')
if [ -z "${G_OBSERVED}" ] || [ "${G_OBSERVED}" = "null" ]; then
  echo "FAIL: the plain deploy did NOT re-capture observedProperties for ${G_LID}" >&2
  echo "      (this phase cleared the bag; a deploy that leaves it empty proves nothing)" >&2
  exit 1
fi
echo "    OK: the plain deploy re-captured the baseline"

deploy_redaction_fail=0
G_DB_URL=$(printf '%s' "${G_OBSERVED}" | jq -r '.DB_URL // empty')
if [ "${G_DB_URL}" = "${EXPECTED_DB_URL_EXPR}" ]; then
  echo "    OK: re-captured DB_URL kept the EMBEDDED expression: ${G_DB_URL}"
else
  echo "FAIL: re-captured observed DB_URL is not the expected embedded expression: $(mask "${G_DB_URL}")" >&2
  deploy_redaction_fail=1
fi

# CONTROL 1: the persisted bag must still be AWS's READBACK, not a copy of the
# record's own `properties`. This is the control that catches a blanket
# "substitute the source wherever it carries a reference" regression, and it
# works because source and bag genuinely DIFFER here: the template sets only
# Code / Environment / Handler / Role / Runtime / Timeout, so `FunctionName` and
# `MemorySize` exist ONLY on the AWS side. A take-source-wholesale bug drops
# them; a mask/drop bug mangles them.
#
# The SSM_VALUE control below cannot do this job on its own, and the review was
# right about why: that leaf is stored RESOLVED, so `source === bag` there and a
# take-source bug writes back the identical string.
G_FN_NAME=$(printf '%s' "${G_STATE}" \
  | jq -r --arg lid "${G_LID}" '.state.resources[$lid].observedProperties.FunctionName // empty')
G_MEM=$(printf '%s' "${G_STATE}" \
  | jq -r --arg lid "${G_LID}" '.state.resources[$lid].observedProperties.MemorySize // empty')
if [ "${G_FN_NAME}" = "${FN_NAME}" ] && [ -n "${G_MEM}" ]; then
  echo "    OK: the persisted bag is AWS's readback (carries FunctionName + MemorySize, which the template never sets)"
else
  echo "FAIL: the re-captured bag lost AWS-only keys — FunctionName='${G_FN_NAME}' (want '${FN_NAME}'), MemorySize='${G_MEM}'" >&2
  echo "      (a bag missing keys the template never set is the record's own properties, not a readback)" >&2
  deploy_redaction_fail=1
fi

# CONTROL 2: a PUBLIC ssm String must still be RESOLVED — this one catches a
# mask/drop regression at a leaf whose correct answer is the plaintext.
G_SSM=$(printf '%s' "${G_OBSERVED}" | jq -r '.SSM_VALUE // empty')
if [ "${G_SSM}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: re-captured SSM_VALUE stayed RESOLVED (public config is not redacted)"
else
  echo "FAIL: re-captured SSM_VALUE should be the resolved '${EXPECTED_SSM}', got $(mask "${G_SSM}")" >&2
  deploy_redaction_fail=1
fi

# CONTROL 3: the mixed leaf carrying a PUBLIC ssm reference keeps AWS's value.
#
# LABELLED AS A SANITY CONTROL, NOT AS ISSUE #2036 COVERAGE, and the distinction
# was measured: this arm passes IDENTICALLY on `origin/main`. An earlier revision
# claimed it as the #2036 closure and said the failure form "means the public
# verdict was not consulted". Both were wrong for the same upstream reason Phase
# 1f's arm was: `properties` holds PUBLIC_URL RESOLVED (issue #1901), so the
# POSITION SOURCE carries no reference, `refuseUncertifiedReadbackPositions`
# never reaches its mixed-leaf arm, and the readback passes straight through.
#
# What it DOES still catch is a mask/drop regression at a leaf whose correct
# answer is the plaintext, on the DEPLOY path rather than the command path —
# worth keeping, worth not overselling.
#
# The #2036 residual direction is exercised in Phase 1f3, on a stamped source
# that genuinely carries the expression. There is no CLOSURE direction to fence:
# issue #2036 is still OPEN -- see Phase 1f3's header for the scope defect that
# withdrew the fix.
G_PUBLIC_URL=$(printf '%s' "${G_OBSERVED}" | jq -r '.PUBLIC_URL // empty')
if [ "${G_PUBLIC_URL}" = "${EXPECTED_PUBLIC_URL}" ]; then
  echo "    OK: re-captured PUBLIC_URL kept the RESOLVED public value (sanity control, not #2036 coverage)"
else
  echo "FAIL: re-captured PUBLIC_URL should be '${EXPECTED_PUBLIC_URL}', got $(mask "${G_PUBLIC_URL}")" >&2
  deploy_redaction_fail=1
fi

# ...and its SECRET twin on the same deploy, which is what stops the arm above
# from being satisfied by a blanket "keep the readback for every mixed leaf"
# regression. Same shape, same empty map, opposite answer.
G_SECURE_COPY=$(printf '%s' "${G_OBSERVED}" | jq -r '.SSM_SECURE_COPY // empty')
if [ "${G_SECURE_COPY}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: re-captured SSM_SECURE_COPY still holds the expression (the SecureString twin)"
else
  echo "FAIL: re-captured SSM_SECURE_COPY should be '${EXPECTED_SECURE_EXPR}', got $(mask "${G_SECURE_COPY}")" >&2
  deploy_redaction_fail=1
fi

# ...and the properties half, unchanged by this deploy, so a regression that
# rewrote `properties` instead of `observedProperties` cannot hide.
G_PROPS_DB_URL=$(printf '%s' "${G_STATE}" \
  | jq -r --arg lid "${G_LID}" '.state.resources[$lid].properties.Environment.Variables.DB_URL // empty')
case "${G_PROPS_DB_URL}" in
  'postgres://app-svc:{{resolve:ssm:'*'@db.'*'.internal:5432/app')
    echo "    OK: properties DB_URL still holds the embedded expression" ;;
  *) echo "FAIL: properties DB_URL is not the embedded expression: $(mask "${G_PROPS_DB_URL}")" >&2
     deploy_redaction_fail=1 ;;
esac

# WHOLE-DOCUMENT, not just the key. The SecureString's decrypted value has no
# legitimate home anywhere in state — unlike the secret's own `SecretString`,
# which the DynRefSecret resource genuinely holds (the reason Guard 5 scopes ITS
# password grep to the Lambda's env). That is why the MIXED leaf was built on
# the SecureString: it makes this assertion available.
if printf '%s' "${G_STATE}" | grep -qF "${EXPECTED_SECURE}"; then
  echo "FAIL: a plain deploy persisted the decrypted SecureString into state (#1926)" >&2
  deploy_redaction_fail=1
else
  echo "    OK: the decrypted SecureString is absent from the WHOLE state document"
fi

if [ "${deploy_redaction_fail}" -ne 0 ]; then
  echo "FAIL: default-deploy redaction assertions failed" >&2
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

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# "state file is gone" above is a head-object on the CURRENT object, and that
# is exactly the assertion that let issue #2096 stand: the bucket is VERSIONED,
# so it was green while 304 versions of this key still carried
# cdkd-known-pw-123. The sweep therefore runs HERE, on the normal path, and not
# only in `cleanup` -- a fixture that disarms its trap on success never runs a
# trap-only cleanup, which is how a sibling key reached 30 versions on
# 2026-08-19. `cleanup` is invoked explicitly first (it force-deletes the
# secret and drops the state/lock objects), then the trap is disarmed so
# nothing can write a new delete marker after the count is taken.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "secrets-dynamic-ref state teardown"

echo ""
echo "==> secrets-dynamic-ref test passed (dynamic references resolved correctly + clean destroy + zero surviving state versions)"
