#!/usr/bin/env bash
#
# Real-AWS validation for issue #2854: `cdkd import` must not persist a
# DECRYPTED secret when a template parameter was DEPLOYED with a secret
# reference over a placeholder `Default`.
#
# Flow:
#   1. Create a Secrets Manager secret holding a pinned, greppable plaintext.
#   2. `cdk deploy` (upstream CLI) the root + nested child with
#      `--parameters DbPassword='{{resolve:secretsmanager:...}}'` (NoEcho) and
#      `--parameters ApiToken=<same>` (not NoEcho); the parent supplies the
#      child's two parameters as the literal reference. `Stage` is left at its
#      `Default`.
#   3. PREMISE: every secret-carrying SSM parameter on AWS holds the plaintext
#      (otherwise every absence assertion below is vacuous).
#   4. MEASURE the `DescribeStacks` premise the AWS docs leave implicit: print
#      the SHAPE CLASS of what CloudFormation returns for each parameter --
#      `literal-reference` / `masked` / `placeholder-default` /
#      `RESOLVED-PLAINTEXT` / `other` -- and NEVER the value.
#   5. `cdkd import --migrate-from-cloudformation --yes`.
#   6. Assert, for root AND child state: no plaintext anywhere; the four
#      secret-carrying resources carry `observedBaselineRefused` and no
#      `observedProperties`; the `Stage` control KEPT its baseline; the import
#      warned, naming the parameters; the plaintext is in no import log line.
#   7. `cdkd destroy`, then assert resources, state and every S3 object VERSION
#      under both state prefixes are gone, and force-delete the secret.
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

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-deployed-parameter-secret"
CLI="node ${REPO_ROOT}/dist/cli.js"

. "${REPO_ROOT}/tests/integration/s3-versions.sh"

STACK="CdkdImportDeployedParamSecret"
if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${STACK}~Child/${REGION}/state.json"
STATE_PREFIX="cdkd/${STACK}/${REGION}/"
CHILD_STATE_PREFIX="cdkd/${STACK}~Child/${REGION}/"

# MUST stay in sync with SECRET_NAME in lib/*.ts -- step 3's premise fails
# loudly if they drift, because the deploy would then resolve nothing.
SECRET_NAME='cdkd-integ-2854-deployed-parameter'
SECRET_REFERENCE="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:pw}}"
# The needle: pinned and unique enough to grep a whole state file for.
SECRET_PLAINTEXT='cdkd-integ-2854-DECRYPTED-NEEDLE-7f3a'

ASSERTIONS_RUN=0
IMPORT_LOG="$(mktemp -t cdkd-2854-import.XXXXXX)"
ROOT_PARAM_NAMES=""
CHILD_PARAM_NAMES=""

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  set +eu
  echo "[verify] cleanup (rc=${rc})"
  # SCOPE GUARD: accepting arm first, the catch-all leaves.
  case "${STACK}" in
    CdkdImportDeployedParam?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object --bucket "${STATE_BUCKET}" \
      --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force) >/dev/null 2>&1 || true
  fi
  if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  # By exact physical name, captured in step 3 (empty before it).
  for n in ${ROOT_PARAM_NAMES} ${CHILD_PARAM_NAMES}; do
    aws ssm delete-parameter --name "${n}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  AWS_REGION="${REGION}" ${CLI} state destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1 || true
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1 || true
  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_STATE_PREFIX:-}" noncurrent || true
  rm -f "${IMPORT_LOG}"
  set -eu
  return 0
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
(cd "${TEST_DIR}" && { [ -x node_modules/.bin/cdk ] || npm install; })
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
CDK_RESOLVED="$(command -v cdk)"
CDK_VERSION="$(cdk --version)"
echo "[verify] step 1 ok: using ${CDK_RESOLVED} (${CDK_VERSION})"

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists -- clean up first" >&2
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"; then
  echo "[verify] FAIL: cdkd state ${STATE_KEY} already exists -- clean up first" >&2
  exit 1
fi

echo "[verify] step 2b: seed the secret"
aws secretsmanager create-secret --name "${SECRET_NAME}" --region "${REGION}" \
  --secret-string "{\"pw\":\"${SECRET_PLAINTEXT}\"}" >/dev/null

echo "[verify] step 2c: cdk deploy with the reference as the DEPLOYED parameter value"
(cd "${TEST_DIR}" && cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --parameters "DbPassword=${SECRET_REFERENCE}" \
  --parameters "ApiToken=${SECRET_REFERENCE}" \
  --region "${REGION}") >/dev/null
echo "[verify] step 2c ok"

echo "[verify] step 3: PREMISE -- AWS holds the DECRYPTED value where the template says CHANGEME"
CHILD_PHYSICAL="$(aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query 'StackResources[?LogicalResourceId==`Child`].PhysicalResourceId' --output text)"
[ -n "${CHILD_PHYSICAL}" ] || { echo "[verify] FAIL: nested child row not found" >&2; exit 1; }
physical_of() { # usage: physical_of <stack> <logicalId>
  aws cloudformation describe-stack-resources --stack-name "$1" --region "${REGION}" \
    --query "StackResources[?LogicalResourceId==\`$2\`].PhysicalResourceId" --output text
}
ROOT_PW_NAME="$(physical_of "${STACK}" RootPwParam)"
ROOT_TOKEN_NAME="$(physical_of "${STACK}" RootTokenParam)"
ROOT_STAGE_NAME="$(physical_of "${STACK}" RootStageParam)"
CHILD_PW_NAME="$(physical_of "${CHILD_PHYSICAL}" ChildPwParam)"
CHILD_TOKEN_NAME="$(physical_of "${CHILD_PHYSICAL}" ChildTokenParam)"
ROOT_PARAM_NAMES="${ROOT_PW_NAME} ${ROOT_TOKEN_NAME} ${ROOT_STAGE_NAME}"
CHILD_PARAM_NAMES="${CHILD_PW_NAME} ${CHILD_TOKEN_NAME}"
for n in "${ROOT_PW_NAME}" "${ROOT_TOKEN_NAME}" "${CHILD_PW_NAME}" "${CHILD_TOKEN_NAME}"; do
  [ -n "${n}" ] || { echo "[verify] FAIL: an SSM parameter physical name is empty" >&2; exit 1; }
  LIVE="$(aws ssm get-parameter --name "${n}" --region "${REGION}" --query 'Parameter.Value' --output text)"
  if [ "${LIVE}" != "${SECRET_PLAINTEXT}" ]; then
    # Shape only, never the value.
    echo "[verify] FAIL: premise: ${n} does not hold the seeded plaintext (CloudFormation did not resolve the" >&2
    echo "         deployed reference at this position), so every absence assertion below would be vacuous." >&2
    exit 1
  fi
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
done
echo "[verify] step 3 ok: 4 live SSM parameters hold the decrypted value"

echo "[verify] step 4: MEASURE what DescribeStacks returns (shape class only, never the value)"
classify_parameter() { # usage: classify_parameter <stack> <parameterKey> <placeholderDefault>
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].Parameters[?ParameterKey==\`$2\`].ParameterValue | [0]" --output text)" || return 1
  case "${value}" in
    "${SECRET_REFERENCE}") echo "literal-reference" ;;
    '****') echo "masked" ;;
    "${SECRET_PLAINTEXT}") echo "RESOLVED-PLAINTEXT" ;;
    "$3") echo "placeholder-default" ;;
    *) echo "other" ;;
  esac
}
for spec in "${STACK}|DbPassword|CHANGEME-root" "${STACK}|ApiToken|CHANGEME-root-token" \
  "${CHILD_PHYSICAL}|ChildPw|CHANGEME-child" "${CHILD_PHYSICAL}|ChildToken|CHANGEME-child-token"; do
  IFS='|' read -r spec_stack spec_key spec_default <<<"${spec}"
  SHAPE="$(classify_parameter "${spec_stack}" "${spec_key}" "${spec_default}")"
  echo "[verify] MEASURED DescribeStacks shape: ${spec_key} -> ${SHAPE}"
  # The fix is premise-independent, so every class but one is survivable: a
  # deployed value EQUAL to the placeholder would mean the deploy did not apply
  # the parameter at all, and the arm below would prove nothing.
  if [ "${SHAPE}" = "placeholder-default" ]; then
    echo "[verify] FAIL: premise: ${spec_key} was deployed AT its placeholder Default" >&2
    exit 1
  fi
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
done

echo "[verify] step 5: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes \
  --verbose) >"${IMPORT_LOG}" 2>&1 || {
  # MASKED before it is shown: a regression that both leaks the needle into the
  # import's output AND fails the import must not print it into the run log.
  tail -40 "${IMPORT_LOG}" | sed "s/${SECRET_PLAINTEXT}/<SEEDED-PLAINTEXT>/g" >&2
  echo "[verify] FAIL: import exited non-zero" >&2
  exit 1
}
echo "[verify] step 5 ok"

echo "[verify] step 6: assertions on the written state"
ROOT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
CHILD_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}")"
for pair in "root|${ROOT_STATE}" "child|${CHILD_STATE}"; do
  label="${pair%%|*}"
  body="${pair#*|}"
  [ -n "${body}" ] || { echo "[verify] FAIL: ${label} state is empty" >&2; exit 1; }
  if printf '%s' "${body}" | grep -qF "${SECRET_PLAINTEXT}"; then
    echo "[verify] FAIL: the DECRYPTED secret is in the ${label} state.json" >&2
    exit 1
  fi
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
done
assert_record() { # usage: assert_record <label> <state-json> <logicalId> refused|captured
  printf '%s' "$2" | python3 -c '
import json, sys
label, logical_id, want = sys.argv[1], sys.argv[2], sys.argv[3]
record = json.load(sys.stdin)["resources"][logical_id]
refused = record.get("observedBaselineRefused") is True
observed = "observedProperties" in record
if want == "refused" and not (refused and not observed):
    sys.exit(f"{label}/{logical_id}: expected a REFUSED baseline (refused={refused}, observed={observed})")
if want == "captured" and not (observed and not refused):
    sys.exit(f"{label}/{logical_id}: expected a CAPTURED baseline (refused={refused}, observed={observed})")
' "$1" "$3" "$4" || { echo "[verify] FAIL: baseline verdict (see above)" >&2; exit 1; }
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
assert_record root "${ROOT_STATE}" RootPwParam refused
assert_record root "${ROOT_STATE}" RootTokenParam refused
# NEGATIVE CONTROL: deployed AT its Default, so it must KEEP its baseline --
# without this, "refuse everything" would pass every assertion above.
assert_record root "${ROOT_STATE}" RootStageParam captured
assert_record child "${CHILD_STATE}" ChildPwParam refused
assert_record child "${CHILD_STATE}" ChildTokenParam refused

if grep -qF "${SECRET_PLAINTEXT}" "${IMPORT_LOG}"; then
  echo "[verify] FAIL: the DECRYPTED secret is in the import's --verbose output" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
# The warning, keyed on TWO independent markers so a reword fails loudly
# instead of reading as "did not warn".
WARN_LINES="$(grep -c "whose deployed CloudFormation value could not be proven equal" "${IMPORT_LOG}" || true)"
SENTINEL_LINES="$(grep -c "no observed drift baseline was captured" "${IMPORT_LOG}" || true)"
if [ "${WARN_LINES}" -lt 2 ]; then
  if [ "${SENTINEL_LINES}" -gt 0 ]; then
    echo "[verify] FAIL: the #2854 warning was reworded -- update this fixture's grep" >&2
  else
    echo "[verify] FAIL: expected the #2854 warning once per stack (root + child), saw ${WARN_LINES}" >&2
  fi
  exit 1
fi
grep "whose deployed CloudFormation value could not be proven equal" "${IMPORT_LOG}" | grep -q "DbPassword" || { echo "[verify] FAIL: root warning does not name DbPassword" >&2; exit 1; }
grep "whose deployed CloudFormation value could not be proven equal" "${IMPORT_LOG}" | grep -q "ChildPw" || { echo "[verify] FAIL: child warning does not name ChildPw" >&2; exit 1; }
# The non-NoEcho pair too: their refusal must come from the COMPARISON, which
# only the name list ties to ARM 4 (the verdict alone could be another arm's).
grep "whose deployed CloudFormation value could not be proven equal" "${IMPORT_LOG}" | grep -q "ApiToken" || { echo "[verify] FAIL: root warning does not name ApiToken" >&2; exit 1; }
grep "whose deployed CloudFormation value could not be proven equal" "${IMPORT_LOG}" | grep -q "ChildToken" || { echo "[verify] FAIL: child warning does not name ChildToken" >&2; exit 1; }
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
echo "[verify] step 6 ok"

echo "[verify] step 7: cdkd destroy"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
for n in ${ROOT_PARAM_NAMES} ${CHILD_PARAM_NAMES}; do
  assert_gone "SSM parameter ${n} still exists after destroy" aws ssm get-parameter --name "${n}" --region "${REGION}"
done
assert_gone "root cdkd state still present" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
assert_gone "child cdkd state still present" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}"
assert_gone "source CloudFormation stack still present" aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# Success path: cleanup, THEN disarm, THEN the full version sweep + assertion.
cleanup
trap - EXIT INT TERM
# POLLED, not probed once: `DeleteSecret` is asynchronous, so `describe-secret`
# can still resolve for a few seconds after a force delete returns.
SECRET_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret \
       --secret-id "${SECRET_NAME}" --region "${REGION}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" -ne 1 ]; then
  echo "FAIL: secret ${SECRET_NAME} still exists 60s after the force delete" >&2
  exit 1
fi
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "import-deployed-parameter-secret root state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" "import-deployed-parameter-secret child state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# Literal floor, maintained by hand: 4 premise + 4 measured + 2 state greps +
# 5 verdicts + 1 log grep + 1 warning + 1 gone + 1 versions = 19.
if [ "${ASSERTIONS_RUN}" -lt 19 ]; then
  echo "FAIL: only ${ASSERTIONS_RUN} of 19 assertions executed -- a block was skipped" >&2
  exit 1
fi
echo "[verify] PASS -- no decrypted deployed-parameter secret reached state (issue #2854); ${ASSERTIONS_RUN} assertions executed"
