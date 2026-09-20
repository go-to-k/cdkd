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
#   6. Assert, for root AND child state: no plaintext anywhere; the five
#      secret-carrying resources carry `observedBaselineRefused` and no
#      `observedProperties`; the `Stage` control KEPT its baseline; the import
#      warned, naming the parameters; the plaintext is in no import log line.
#   6a. SIMULATE A cdkd 0.290.35 RECORD (issue #3468): that version wrote these
#      refusals WITHOUT `observedBaselineRefusalReason`. Strip the reason from
#      every refused record in root AND child state.json (a guarded, scoped S3
#      rewrite) and assert the strip landed, so 6b runs against reason-less
#      markers. The deploy must then re-stamp the reason on every record whose
#      template definition names a parameter -- in the root AND in the child,
#      whose `ChildSecretEnvFn` gets the same code-only change so that a CHILD
#      engine runs over the child's reason-less markers (asserted: its code
#      sha moved, AWS still holds the decrypted value, the child state was
#      rewritten).
#   6b. REDEPLOY ARM (issue #3462): `cdkd deploy` with `CDKD_TEST_UPDATE=true`,
#      which changes `SecretEnvFn`'s inline CODE (and, for issue #3468, the
#      child template). The Lambda
#      provider sends `UpdateFunctionCode` alone, so the environment variable
#      AWS holds is STILL the decrypted value afterwards (asserted, or the arm
#      is vacuous). `cdkd deploy` binds the same placeholder `Default`, so a
#      post-UPDATE readback would pair the secret as an ordinary drifted
#      literal. Assert: the code really changed; every refused record still
#      carries the marker AND `observedBaselineRefusalReason`, with no
#      `observedProperties`; no plaintext in root or child state, in ANY
#      surviving object version under either prefix, or in the deploy log.
#   6c-pre. Strip the root reasons AGAIN (6b healed them), so the re-import's
#      carry is exercised on a REASON-LESS prior marker (issue #3468).
#   6c. RE-IMPORT ARM (issue #3462): a SELECTIVE `cdkd import --resource
#      SecretEnvFn=<name> --force`. The migration deleted the CloudFormation
#      stack, so this run has NO deployed parameter values, ARM 4 does not run,
#      and the rebuilt record would be captured against the placeholder. Assert
#      the refusal is carried (marker + reason, no `observedProperties`) and no
#      plaintext reached state, its object versions, or the log. Selective, not
#      auto: nothing here has a physical-name property, so an auto rebuild
#      would drop every record and orphan the resources.
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
DEPLOY_LOG="$(mktemp -t cdkd-3462-deploy.XXXXXX)"
REIMPORT_LOG="$(mktemp -t cdkd-3462-reimport.XXXXXX)"
STRIP_FILE="$(mktemp -t cdkd-3468-strip.XXXXXX)"
ROOT_PARAM_NAMES=""
CHILD_PARAM_NAMES=""
FN_NAME=""
FN_ROLE_NAME=""
CHILD_FN_NAME=""
CHILD_FN_ROLE_NAME=""

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
  # By exact physical name too, captured in step 3 (empty before it).
  if [ -n "${FN_NAME}" ]; then
    aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${FN_ROLE_NAME}" ]; then
    aws iam delete-role --role-name "${FN_ROLE_NAME}" >/dev/null 2>&1 || true
  fi
  if [ -n "${CHILD_FN_NAME}" ]; then
    aws lambda delete-function --function-name "${CHILD_FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${CHILD_FN_ROLE_NAME}" ]; then
    aws iam delete-role --role-name "${CHILD_FN_ROLE_NAME}" >/dev/null 2>&1 || true
  fi
  AWS_REGION="${REGION}" ${CLI} state destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1 || true
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1 || true
  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_STATE_PREFIX:-}" noncurrent || true
  rm -f "${IMPORT_LOG}" "${DEPLOY_LOG}" "${REIMPORT_LOG}" "${STRIP_FILE}"
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
# `DeleteSecret` is asynchronous even with --force-delete-without-recovery: a
# run started right after another run's cleanup finds the name still "scheduled
# for deletion" and `create-secret` refuses it. Wait for the name to be FREE,
# with the same polled strict gone-probe the teardown uses.
SECRET_NAME_FREE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret \
       --secret-id "${SECRET_NAME}" --region "${REGION}"; then
    SECRET_NAME_FREE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_NAME_FREE}" -ne 1 ]; then
  echo "[verify] FAIL: secret ${SECRET_NAME} still exists (or is still being deleted) after 60s --" >&2
  echo "         a previous run's force delete has not completed. Not seeding over it." >&2
  exit 1
fi
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
FN_NAME="$(physical_of "${STACK}" SecretEnvFn)"
FN_ROLE_NAME="$(physical_of "${STACK}" SecretEnvFnRole)"
[ -n "${FN_NAME}" ] || { echo "[verify] FAIL: SecretEnvFn physical name is empty" >&2; exit 1; }
[ -n "${FN_ROLE_NAME}" ] || { echo "[verify] FAIL: SecretEnvFnRole physical name is empty" >&2; exit 1; }
CHILD_FN_NAME="$(physical_of "${CHILD_PHYSICAL}" ChildSecretEnvFn)"
CHILD_FN_ROLE_NAME="$(physical_of "${CHILD_PHYSICAL}" ChildSecretEnvFnRole)"
[ -n "${CHILD_FN_NAME}" ] || { echo "[verify] FAIL: ChildSecretEnvFn physical name is empty" >&2; exit 1; }
[ -n "${CHILD_FN_ROLE_NAME}" ] || { echo "[verify] FAIL: ChildSecretEnvFnRole physical name is empty" >&2; exit 1; }
live_fn_env() { # usage: live_fn_env [<function-name>] -- the DB_PASSWORD AWS holds; compared, never printed
  aws lambda get-function-configuration --function-name "${1:-${FN_NAME}}" --region "${REGION}" \
    --query 'Environment.Variables.DB_PASSWORD' --output text
}
for fn in "${FN_NAME}" "${CHILD_FN_NAME}"; do
  if [ "$(live_fn_env "${fn}")" != "${SECRET_PLAINTEXT}" ]; then
    echo "[verify] FAIL: premise: ${fn}'s DB_PASSWORD does not hold the seeded plaintext" >&2
    exit 1
  fi
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
done
echo "[verify] step 3 ok: 4 live SSM parameters and 2 Lambda environment variables hold the decrypted value"

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
state_last_modified() { # usage: state_last_modified <state-json>
  printf '%s' "$1" | python3 -c 'import json, sys; print(json.load(sys.stdin)["lastModified"])'
}
assert_record() { # usage: assert_record <label> <state-json> <logicalId> refused|marked|captured
  # `refused` means the UNVERIFIABLE-PARAMETER class specifically (issue #3462):
  # the marker alone is what any other refusal arm writes, and it is the REASON
  # that carries the refusal through an in-place UPDATE.
  printf '%s' "$2" | python3 -c '
import json, sys
label, logical_id, want = sys.argv[1], sys.argv[2], sys.argv[3]
record = json.load(sys.stdin)["resources"][logical_id]
refused = record.get("observedBaselineRefused") is True
reason = record.get("observedBaselineRefusalReason")
observed = "observedProperties" in record
if want == "refused" and not (refused and reason == "unverifiable-parameter" and not observed):
    sys.exit(f"{label}/{logical_id}: expected a REFUSED baseline with its reason (refused={refused}, reason={reason!r}, observed={observed})")
# `marked` (issue #3468): the marker survived with no baseline, whatever the
# reason -- for a record no writer touched after its reason was stripped.
if want == "marked" and not (refused and not observed):
    sys.exit(f"{label}/{logical_id}: expected a surviving REFUSAL MARKER (refused={refused}, reason={reason!r}, observed={observed})")
if want == "captured" and not (observed and not refused and reason is None):
    sys.exit(f"{label}/{logical_id}: expected a CAPTURED baseline (refused={refused}, reason={reason!r}, observed={observed})")
' "$1" "$3" "$4" || { echo "[verify] FAIL: baseline verdict (see above)" >&2; exit 1; }
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
assert_record root "${ROOT_STATE}" RootPwParam refused
assert_record root "${ROOT_STATE}" RootTokenParam refused
assert_record root "${ROOT_STATE}" SecretEnvFn refused
# NEGATIVE CONTROL: deployed AT its Default, so it must KEEP its baseline --
# without this, "refuse everything" would pass every assertion above.
assert_record root "${ROOT_STATE}" RootStageParam captured
assert_record child "${CHILD_STATE}" ChildPwParam refused
assert_record child "${CHILD_STATE}" ChildTokenParam refused
assert_record child "${CHILD_STATE}" ChildSecretEnvFn refused

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

echo "[verify] step 6a: SIMULATE a cdkd 0.290.35 record (issue #3468) -- strip the refusal reason"
# A GUARDED, SCOPED rewrite of a state document. Never prints a state body.
strip_refusal_reason() { # usage: strip_refusal_reason <state-key> <label>
  local key="$1" label="$2" etag stripped left
  # SCOPE GUARD: accepting arm first, the catch-all leaves. Only this
  # fixture's two exact state keys may ever be rewritten.
  case "${key}" in
    "cdkd/CdkdImportDeployedParamSecret/${REGION}/state.json") ;;
    "cdkd/CdkdImportDeployedParamSecret~Child/${REGION}/state.json") ;;
    *)
      echo "[verify] FAIL: strip refused -- '${key}' is not one of this fixture's two state keys" >&2
      exit 1
      ;;
  esac
  if ! etag="$(aws s3api get-object --bucket "${STATE_BUCKET}" --region "${REGION}" --key "${key}" \
      --query 'ETag' --output text "${STRIP_FILE}" 2>/dev/null)" || [ -z "${etag}" ] || [ "${etag}" = "None" ]; then
    echo "[verify] FAIL: ${label}: could not read the state document to strip" >&2
    exit 1
  fi
  if ! stripped="$(python3 -c '
import json, sys
path = sys.argv[1]
with open(path) as f:
    state = json.load(f)
count = 0
for record in state["resources"].values():
    if record.get("observedBaselineRefused") is True and "observedBaselineRefusalReason" in record:
        del record["observedBaselineRefusalReason"]
        count += 1
with open(path, "w") as f:
    json.dump(state, f)
print(count)
' "${STRIP_FILE}")"; then
    echo "[verify] FAIL: ${label}: could not rewrite the state document" >&2
    exit 1
  fi
  if [ -z "${stripped}" ] || [ "${stripped}" -lt 1 ]; then
    echo "[verify] FAIL: ${label}: stripped ZERO refusal reasons -- the redeploy below would not run against a reason-less marker" >&2
    exit 1
  fi
  # `--if-match`: refuse to overwrite a document someone wrote since the read.
  if ! aws s3api put-object --bucket "${STATE_BUCKET}" --region "${REGION}" --key "${key}" \
      --body "${STRIP_FILE}" --content-type application/json --if-match "${etag}" >/dev/null; then
    echo "[verify] FAIL: ${label}: the guarded state rewrite was refused or failed" >&2
    exit 1
  fi
  # The strip LANDED: read back from S3, not from the local file.
  if ! left="$(aws s3 cp "s3://${STATE_BUCKET}/${key}" - --region "${REGION}" | python3 -c '
import json, sys
records = json.load(sys.stdin)["resources"].values()
marked = [r for r in records if r.get("observedBaselineRefused") is True]
with_reason = [r for r in marked if "observedBaselineRefusalReason" in r]
print(f"{len(marked)} {len(with_reason)}")
')"; then
    echo "[verify] FAIL: ${label}: could not re-read the stripped state" >&2
    exit 1
  fi
  if [ "${left}" != "${stripped} 0" ]; then
    echo "[verify] FAIL: ${label}: after the strip expected ${stripped} reason-less marker(s) and 0 with a reason, got '${left}'" >&2
    exit 1
  fi
  echo "[verify] ${label}: ${stripped} refusal reason(s) stripped; every marker is now reason-less"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
strip_refusal_reason "${STATE_KEY}" "root state"
strip_refusal_reason "${CHILD_STATE_KEY}" "child state"
echo "[verify] step 6a ok"

echo "[verify] step 6b: REDEPLOY ARM (issue #3462) -- a code-only UPDATE after the import"
# Every surviving object VERSION, not just the current one: a deploy saves state
# more than once, and an intermediate save that carried the plaintext is a
# disclosure the final body does not show. Rows are counted, never `length(...)`
# (per-page under --output text); delete markers are outside `Versions[]`.
assert_no_plaintext_in_versions() { # usage: assert_no_plaintext_in_versions <prefix> <description>
  local prefix="$1" desc="$2" rows key vid body scanned=0
  if ! rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --region "${REGION}" \
      --prefix "${prefix}" --query 'Versions[].[Key,VersionId]' --output text 2>&1)"; then
    echo "[verify] FAIL: ${desc}: could not list object versions under ${prefix} (${rows})" >&2
    exit 1
  fi
  # `|| [ -n "${key}" ]`: `$(...)` strips the trailing newline, so `read` fails
  # on the LAST row. A here-string so `scanned` survives the loop.
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --region "${REGION}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      echo "[verify] FAIL: ${desc}: could not read ${key} version ${vid} -- undetermined" >&2
      exit 1
    fi
    # -qF: a match is never echoed.
    if printf '%s' "${body}" | grep -qF "${SECRET_PLAINTEXT}"; then
      echo "[verify] FAIL: ${desc}: ${key} version ${vid} carries the DECRYPTED secret" >&2
      exit 1
    fi
    scanned=$((scanned + 1))
  done <<< "${rows}"
  if [ "${scanned}" -eq 0 ]; then
    echo "[verify] FAIL: ${desc}: scanned ZERO object versions under ${prefix}" >&2
    exit 1
  fi
  echo "[verify] ${desc}: ${scanned} object version(s) scanned, none carries the plaintext"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
fn_code_sha() { # usage: fn_code_sha [<function-name>]
  aws lambda get-function-configuration --function-name "${1:-${FN_NAME}}" --region "${REGION}" \
    --query 'CodeSha256' --output text
}
CODE_SHA_BEFORE="$(fn_code_sha)"
CHILD_CODE_SHA_BEFORE="$(fn_code_sha "${CHILD_FN_NAME}")"
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes \
  --verbose) >"${DEPLOY_LOG}" 2>&1 || {
  tail -40 "${DEPLOY_LOG}" | sed "s/${SECRET_PLAINTEXT}/<SEEDED-PLAINTEXT>/g" >&2
  echo "[verify] FAIL: redeploy exited non-zero" >&2
  exit 1
}
# The UPDATE really ran: without this, "the marker is still there" is equally
# satisfied by a deploy that found nothing to do.
CODE_SHA_AFTER="$(fn_code_sha)"
if [ -z "${CODE_SHA_AFTER}" ] || [ "${CODE_SHA_AFTER}" = "${CODE_SHA_BEFORE}" ]; then
  echo "[verify] FAIL: SecretEnvFn's CodeSha256 did not change -- the redeploy did not UPDATE it" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
# NON-VACUITY: the update did not rewrite the placeholder-bound leaf, so AWS
# still holds the decrypted value exactly where a readback would find it.
if [ "$(live_fn_env)" != "${SECRET_PLAINTEXT}" ]; then
  echo "[verify] FAIL: premise: after the code-only update SecretEnvFn no longer holds the seeded plaintext," >&2
  echo "         so the absence assertions below would prove nothing." >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
# The CHILD (issue #3468): its function was UPDATEd by a child engine, and AWS
# holds the decrypted value where a readback by that engine would find it. What
# proves the STAMP in the child is the `refused` verdicts below (6a stripped
# the reasons). The child plaintext scans are a backstop on the redaction, not
# on the stamp: under `cdkd deploy` the parent hands the child the literal
# reference, so a child readback is positioned against an expression.
CHILD_CODE_SHA_AFTER="$(fn_code_sha "${CHILD_FN_NAME}")"
if [ -z "${CHILD_CODE_SHA_AFTER}" ] || [ "${CHILD_CODE_SHA_AFTER}" = "${CHILD_CODE_SHA_BEFORE}" ]; then
  echo "[verify] FAIL: ChildSecretEnvFn's CodeSha256 did not change -- no child engine UPDATEd it" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
if [ "$(live_fn_env "${CHILD_FN_NAME}")" != "${SECRET_PLAINTEXT}" ]; then
  echo "[verify] FAIL: premise: after the redeploy ChildSecretEnvFn no longer holds the seeded plaintext," >&2
  echo "         so the child plaintext scans below would have nothing to find." >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
ROOT_STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
CHILD_STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}")"
for pair in "root|${ROOT_STATE_2}" "child|${CHILD_STATE_2}"; do
  label="${pair%%|*}"
  body="${pair#*|}"
  [ -n "${body}" ] || { echo "[verify] FAIL: ${label} state is empty after the redeploy" >&2; exit 1; }
  if printf '%s' "${body}" | grep -qF "${SECRET_PLAINTEXT}"; then
    echo "[verify] FAIL: the DECRYPTED secret is in the ${label} state.json after the redeploy" >&2
    exit 1
  fi
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
done
# The record the deploy REBUILT is the discriminating one; the rest prove the
# refusal stands across whatever the deploy did or did not touch. Step 6a left
# every marker REASON-LESS, so `refused` also proves the engine that owns the
# record re-stamped the reason (issue #3468) -- the root engine for the root
# records, a CHILD engine for the child's.
assert_record root-redeployed "${ROOT_STATE_2}" SecretEnvFn refused
assert_record root-redeployed "${ROOT_STATE_2}" RootPwParam refused
assert_record root-redeployed "${ROOT_STATE_2}" RootTokenParam refused
assert_record root-redeployed "${ROOT_STATE_2}" RootStageParam captured
# The child engine really RAN and saved: otherwise `refused` below could not
# hold (6a stripped the reasons), but say so by name rather than by inference.
if [ "$(state_last_modified "${CHILD_STATE_2}")" = "$(state_last_modified "${CHILD_STATE}")" ]; then
  echo "[verify] FAIL: the child state was not rewritten by the redeploy -- no child engine ran over the reason-less markers" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
assert_record child-redeployed "${CHILD_STATE_2}" ChildPwParam refused
assert_record child-redeployed "${CHILD_STATE_2}" ChildTokenParam refused
assert_record child-redeployed "${CHILD_STATE_2}" ChildSecretEnvFn refused
if grep -qF "${SECRET_PLAINTEXT}" "${DEPLOY_LOG}"; then
  echo "[verify] FAIL: the DECRYPTED secret is in the redeploy's --verbose output" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
assert_no_plaintext_in_versions "${STATE_PREFIX}" "root state prefix after the redeploy"
assert_no_plaintext_in_versions "${CHILD_STATE_PREFIX}" "child state prefix after the redeploy"
echo "[verify] step 6b ok"

echo "[verify] step 6c: RE-IMPORT ARM (issue #3462) -- a selective re-import with no CloudFormation source"
# Step 6b healed the root reasons; strip them again so the carry under test
# starts from a REASON-LESS prior marker (issue #3468).
strip_refusal_reason "${STATE_KEY}" "root state before the re-import"
# PREMISE: the source stack is gone, so this run cannot have deployed values.
assert_gone "premise: the source CloudFormation stack still exists, so the re-import would HAVE a parameter source" \
  aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --resource "SecretEnvFn=${FN_NAME}" \
  --force \
  --yes \
  --verbose) >"${REIMPORT_LOG}" 2>&1 || {
  tail -40 "${REIMPORT_LOG}" | sed "s/${SECRET_PLAINTEXT}/<SEEDED-PLAINTEXT>/g" >&2
  echo "[verify] FAIL: re-import exited non-zero" >&2
  exit 1
}
# NON-VACUITY: AWS still holds the plaintext where a capture would read it.
if [ "$(live_fn_env)" != "${SECRET_PLAINTEXT}" ]; then
  echo "[verify] FAIL: premise: SecretEnvFn no longer holds the seeded plaintext before the re-import assertions" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
ROOT_STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
[ -n "${ROOT_STATE_3}" ] || { echo "[verify] FAIL: root state is empty after the re-import" >&2; exit 1; }
if printf '%s' "${ROOT_STATE_3}" | grep -qF "${SECRET_PLAINTEXT}"; then
  echo "[verify] FAIL: the DECRYPTED secret is in the root state.json after the re-import" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
# The re-import really WROTE state: `cdkd import` exits 0 without writing when
# no row imports, and the body left by step 6b satisfies every verdict below on
# its own. Read from the record, not from a log line whose wording can drift.
LAST_MODIFIED_2="$(state_last_modified "${ROOT_STATE_2}")"
LAST_MODIFIED_3="$(state_last_modified "${ROOT_STATE_3}")"
if [ -z "${LAST_MODIFIED_3}" ] || [ "${LAST_MODIFIED_3}" = "${LAST_MODIFIED_2}" ]; then
  echo "[verify] FAIL: the re-import did not write state (lastModified unchanged) -- SecretEnvFn was not re-imported," >&2
  echo "         so the carry under test never ran." >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
assert_record root-reimported "${ROOT_STATE_3}" SecretEnvFn refused
# The rows the selective run left in place are untouched: still reason-less.
assert_record root-reimported "${ROOT_STATE_3}" RootPwParam marked
assert_record root-reimported "${ROOT_STATE_3}" RootStageParam captured
if grep -qF "${SECRET_PLAINTEXT}" "${REIMPORT_LOG}"; then
  echo "[verify] FAIL: the DECRYPTED secret is in the re-import's --verbose output" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
assert_no_plaintext_in_versions "${STATE_PREFIX}" "root state prefix after the re-import"
echo "[verify] step 6c ok"

echo "[verify] step 7: cdkd destroy"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
for n in ${ROOT_PARAM_NAMES} ${CHILD_PARAM_NAMES}; do
  assert_gone "SSM parameter ${n} still exists after destroy" aws ssm get-parameter --name "${n}" --region "${REGION}"
done
assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "IAM role ${FN_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${FN_ROLE_NAME}"
assert_gone "Lambda function ${CHILD_FN_NAME} still exists after destroy" aws lambda get-function --function-name "${CHILD_FN_NAME}" --region "${REGION}"
assert_gone "IAM role ${CHILD_FN_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${CHILD_FN_ROLE_NAME}"
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

# Literal floor, maintained by hand: 5 premise + 4 measured + 2 state greps +
# 6 verdicts + 1 log grep + 1 warning + 1 gone + 1 versions = 21, plus the
# redeploy arm's 1 code sha + 1 live premise + 2 state greps + 6 verdicts +
# 1 log grep + 2 version scans = 13 -> 34, plus the re-import arm's 1 source
# premise + 1 live premise + 1 state grep + 1 state-written proof + 3 verdicts +
# 1 log grep + 1 version scan = 9 -> 43, plus the reason strips (issue #3468):
# root + child before the redeploy, root before the re-import = 3 -> 46, plus
# the child-state-rewritten proof = 47, plus the child function's 1 import
# premise + 1 import verdict + 1 code sha + 1 live premise after the redeploy +
# 1 redeploy verdict = 5 -> 52.
if [ "${ASSERTIONS_RUN}" -lt 52 ]; then
  echo "FAIL: only ${ASSERTIONS_RUN} of 52 assertions executed -- a block was skipped" >&2
  exit 1
fi
echo "[verify] PASS -- no decrypted deployed-parameter secret reached state, at import (issue #2854), at the redeploy after it, or at a source-less re-import (issue #3462), with the refusal reason stripped as cdkd 0.290.35 wrote it (issue #3468); ${ASSERTIONS_RUN} assertions executed"
