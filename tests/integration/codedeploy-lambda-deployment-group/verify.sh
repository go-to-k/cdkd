#!/usr/bin/env bash
# verify.sh — cdkd CodeDeploy Lambda canary deployment group integ.
#
# AWS::CodeDeploy::Application / ::DeploymentGroup have NO SDK provider in
# cdkd, so they route via Cloud Control. The DeploymentGroup create references
# the same-stack service role created ~1s earlier, and CodeDeploy validates
# the trust policy at create time — so every fresh deploy re-opens the
# IAM-propagation race this fixture's retry pattern fixes ("AWS CodeDeploy
# does not have the permissions required to assume the role ...", which the
# pre-fix classifier did NOT retry).
#
# Phases (go-to-k/cdkd#6437 added the UpdatePolicy assertions of 2-5):
#   1. Deploy baseline (code v1) with --update-policy (a create: no CodeDeploy
#      deployment). Assert the CodeDeploy application (compute platform
#      Lambda) + deployment group (LambdaCanary10Percent5Minutes, BLUE_GREEN)
#      reached AWS, the alias points at a freshly published version N (Lambda
#      never reuses version numbers for a function name, even across delete +
#      re-create, so N is 1 only on the account's very first run), the
#      DeploymentGroup routed via cc-api, and the group has no deployment.
#   2. --update-policy, CDKD_TEST_UPDATE=true (code v1 -> v2, a NEW
#      Lambda::Version logical id): the alias's CodeDeployLambdaAliasUpdate
#      shifts it through ONE CodeDeploy deployment (the fixture's canary,
#      ~6 min), which Succeeded; the alias serves N+1 with no traffic split
#      and an invoke returns v2.
#   3. --update-policy --no-rollback, code v3 plus a queue AWS refuses
#      (CDKD_TEST_FAIL=true, created after the alias): the alias's shift
#      Succeeds (alias at N+2), then the deploy fails. `cdkd rollback` shifts
#      the alias back through a SECOND CodeDeploy deployment (~6 min), which
#      Succeeds: alias at N+1 live and in state, no split, nothing running.
#   4. --update-policy, code v4 with the BeforeAllowTraffic hook reporting
#      Failed: the deployment fails before any traffic moves, so the deploy
#      fails and its automatic rollback leaves the alias at N+1 (live and in
#      state) and puts the hook function's code back, with no deployment left
#      running.
#   5. No flag, code v5: the alias is switched directly (no new deployment),
#      cdkd prints the "skipped by default" hint, and an invoke returns v5.
#   6. Destroy + assert the application / deployment group / functions are
#      gone, the cdkd state file is removed, and Lambda log groups are swept.
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

STACK="CdkdCodedeployLambdaDeploymentGroupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-codedeploy-canary-fn"
HOOK_NAME="cdkd-codedeploy-canary-hook"
# The alias's logical id (CDK's hash of the construct path `Alias`).
ALIAS_ID="Alias325C5727"
APP_NAME="cdkd-codedeploy-integ-app"
DG_NAME="cdkd-codedeploy-integ-dg"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_log_groups() {
  for prefix in "/aws/lambda/${FN_NAME}" "/aws/lambda/${HOOK_NAME}"; do
    for lg in $(aws logs describe-log-groups \
      --log-group-name-prefix "${prefix}" --region "${REGION}" \
      --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
      aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  done
}

# Every deployment id of the fixture's deployment group, one per line (all
# pages: `--query 'deployments[]'` prints one line per page, so split on tabs
# and count lines, never length()).
deployment_ids() {
  local out
  out="$(aws deploy list-deployments --application-name "${APP_NAME}" \
    --deployment-group-name "${DG_NAME}" --region "${REGION}" \
    --query 'deployments[]' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v -e '^$' -e '^None$' || true
}

# The group's running deployments (the statuses cdkd treats as active).
active_deployment_ids() {
  local out
  out="$(aws deploy list-deployments --application-name "${APP_NAME}" \
    --deployment-group-name "${DG_NAME}" --region "${REGION}" \
    --include-only-statuses Created Queued InProgress Baking Ready \
    --query 'deployments[]' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v -e '^$' -e '^None$' || true
}

# Non-empty lines in $1 (a captured list, so a failed read aborts at its capture).
count_lines() { grep -c . <<<"$1" || true; }

# How many extra versions the alias routes traffic to (0: no split).
alias_weights() {
  aws lambda get-alias --function-name "${FN_NAME}" --name live --region "${REGION}" \
    --query 'length(keys(RoutingConfig.AdditionalVersionWeights || `{}`))' --output text
}

# The IAM roles THIS run created (the two function roles and the CodeDeploy
# service role), read from this run's own state record: IAM is global, so a
# name-prefix listing would also match a concurrent run of this fixture in
# another region. Only names under this stack's `<stack>-` prefix are kept.
# Strict: an unreadable record fails, never reads as none.
state_roles() {
  local json
  # stderr kept: a strict caller's failure then shows why.
  json="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json)" || return 1
  printf '%s' "${json}" | STACK="${STACK}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources;for(const k of Object.keys(r)){const x=r[k];if(x.resourceType==="AWS::IAM::Role"&&typeof x.physicalId==="string"&&x.physicalId.startsWith(process.env.STACK+"-"))console.log(x.physicalId)}})'
}
delete_role() { # <role name> -- best effort: its managed and inline policies, then the role
  ( set +eu
    local p
    for p in $(aws iam list-attached-role-policies --role-name "$1" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "$1" --policy-arn "${p}" >/dev/null 2>&1
    done
    for p in $(aws iam list-role-policies --role-name "$1" --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "$1" --policy-name "${p}" >/dev/null 2>&1
    done
    aws iam delete-role --role-name "$1" >/dev/null 2>&1
    true )
}

# The fixture's Lambda log groups, one per line. Strict.
fixture_log_groups() {
  local prefix out
  for prefix in "/aws/lambda/${FN_NAME}" "/aws/lambda/${HOOK_NAME}"; do
    out="$(aws logs describe-log-groups --log-group-name-prefix "${prefix}" --region "${REGION}" \
      --query 'logGroups[].logGroupName' --output text)" || return 1
    printf '%s\n' "${out}" | tr '\t' '\n' | awk 'NF' | grep -v '^None$' || true
  done
}

# The status the live hook function's code reports (Succeeded / Failed), read
# from its deployment package: the package is zipped at deploy time with a
# fresh timestamp, so its CodeSha256 differs on every update of the same code.
hook_code_status() {
  local url dir
  url="$(aws lambda get-function --function-name "${HOOK_NAME}" --region "${REGION}" \
    --query 'Code.Location' --output text)" || return 1
  dir="$(mktemp -d)"
  if ! curl -sSf -o "${dir}/code.zip" "${url}"; then
    rm -rf "${dir}"
    return 1
  fi
  unzip -p "${dir}/code.zip" index.js | grep -oE "status: '(Succeeded|Failed)'" | head -1 \
    | sed -E "s/status: '([A-Za-z]+)'/\1/" || true
  rm -rf "${dir}"
}

# The alias's FunctionVersion as cdkd state records it.
state_alias_version() {
  local json
  json="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>/dev/null)" || return 1
  printf '%s' "${json}" | ALIAS_ID="${ALIAS_ID}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources[process.env.ALIAS_ID];process.stdout.write(String((r&&r.properties&&r.properties.FunctionVersion)||""))})'
}

invoke_returns() { # usage: invoke_returns <version string>
  local out
  out="$(mktemp)"
  aws lambda invoke --function-name "${FN_NAME}:live" --region "${REGION}" \
    "${out}" >/dev/null
  if ! grep -q "\"version\":\"$1\"" "${out}"; then
    echo "FAIL: invoke through alias did not return $1: $(cat "${out}")" >&2
    rm -f "${out}"
    exit 1
  fi
  rm -f "${out}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # This run's roles, read before the state record goes (none when there is
  # no record: a pre-run cleanup, or a destroy that already finished).
  local cleanup_roles=""
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    cleanup_roles="$(state_roles 2>/dev/null)"
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Stop a deployment still in flight (an interrupted phase) before the
  # application goes, so CodeDeploy does not keep shifting a deleted alias.
  for d in $(active_deployment_ids 2>/dev/null); do
    aws deploy stop-deployment --deployment-id "${d}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # Deleting the application cascades to its deployment groups.
  aws deploy delete-application --application-name "${APP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${HOOK_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # Only this run's roles (from its state record), and only under this
  # fixture's own stack name.
  case "${STACK}" in
    CdkdCodedeployLambdaDeploymentGroupExample)
      for r in ${cleanup_roles}; do
        case "${r}" in "${STACK}"-?*) delete_role "${r}" ;; esac
      done ;;
    *) echo "WARN: teardown sweep refused: unexpected STACK '${STACK}' for the IAM role sweep" >&2 ;;
  esac
  sweep_log_groups
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

# --- Phase 1: deploy baseline (code v1) --------------------------------
echo "==> Phase 1: deploy baseline (code v1, --update-policy)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_HOOK node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --update-policy

PLATFORM="$(aws deploy get-application --application-name "${APP_NAME}" \
  --region "${REGION}" --query 'application.computePlatform' --output text)"
if [ "${PLATFORM}" != "Lambda" ]; then
  echo "FAIL: expected application computePlatform=Lambda, got '${PLATFORM}'" >&2
  exit 1
fi

DG_JSON="$(aws deploy get-deployment-group --application-name "${APP_NAME}" \
  --deployment-group-name "${DG_NAME}" --region "${REGION}" \
  --query 'deploymentGroupInfo.[deploymentConfigName,deploymentStyle.deploymentType]' \
  --output text)"
if [ "${DG_JSON}" != "CodeDeployDefault.LambdaCanary10Percent5Minutes	BLUE_GREEN" ]; then
  echo "FAIL: unexpected deployment group config/style: '${DG_JSON}'" >&2
  exit 1
fi
echo "    Application (Lambda) + DeploymentGroup (Canary10Percent5Minutes, BLUE_GREEN) reached AWS"

# Lambda never reuses version numbers for a function name, even across a
# delete + re-create, so the fresh deploy publishes :1 only on the very
# first run in an account. Capture the version and assert relatively.
ALIAS_V1="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
case "${ALIAS_V1}" in
  ''|*[!0-9]*)
    echo "FAIL: expected alias at a numeric version after Phase 1, got '${ALIAS_V1}'" >&2
    exit 1 ;;
esac
echo "    Alias 'live' -> version ${ALIAS_V1}"

# Assert the DeploymentGroup routed via Cloud Control (no SDK provider).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::CodeDeploy::DeploymentGroup");process.stdout.write((r[k]&&r[k].provisionedBy)||"")})')"
if [ "${PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: expected DeploymentGroup provisionedBy=cc-api, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    DeploymentGroup routed via Cloud Control (provisionedBy=cc-api)"

BASE_IDS="$(deployment_ids)"
BASE_DEPLOYMENTS="$(count_lines "${BASE_IDS}")"
if [ "${BASE_DEPLOYMENTS}" != "0" ]; then
  echo "FAIL: expected no CodeDeploy deployment after the create, got ${BASE_DEPLOYMENTS}" >&2
  exit 1
fi
echo "    No CodeDeploy deployment after the create"

LOG_DIR="$(mktemp -d)"

# --- Phase 2: --update-policy, v1 -> v2 through CodeDeploy -------------
echo "==> Phase 2: UPDATE with --update-policy (code v1 -> v2 through a CodeDeploy deployment)"
CDKD_TEST_UPDATE=true env -u CDKD_TEST_HOOK node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --update-policy \
  2>&1 | tee "${LOG_DIR}/phase2.log"

EXPECTED_V2=$((ALIAS_V1 + 1))
ALIAS_V2="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V2}" != "${EXPECTED_V2}" ]; then
  echo "FAIL: expected alias at version ${EXPECTED_V2} after Phase 2, got '${ALIAS_V2}'" >&2
  exit 1
fi
if [ "$(alias_weights)" != "0" ]; then
  echo "FAIL: alias still splits traffic after Phase 2" >&2
  exit 1
fi
invoke_returns v2

P2_IDS="$(deployment_ids)"
P2_COUNT="$(count_lines "${P2_IDS}")"
if [ "${P2_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly one CodeDeploy deployment after Phase 2, got ${P2_COUNT}" >&2
  exit 1
fi
P2_ID="$(head -1 <<<"${P2_IDS}")"
P2_INFO="$(aws deploy get-deployment --deployment-id "${P2_ID}" --region "${REGION}" \
  --query 'deploymentInfo.[status,deploymentConfigName]' --output text)"
if [ "${P2_INFO}" != "Succeeded	CodeDeployDefault.LambdaCanary10Percent5Minutes" ]; then
  echo "FAIL: unexpected Phase 2 deployment status/config: '${P2_INFO}'" >&2
  exit 1
fi
# cdkd's own lines, each carrying the deployment id AWS reports as a second,
# independent marker.
if ! grep -q "CodeDeploy deployment ${P2_ID} started" "${LOG_DIR}/phase2.log" \
  || ! grep -q "CodeDeploy deployment ${P2_ID} succeeded" "${LOG_DIR}/phase2.log"; then
  echo "FAIL: cdkd did not log the start and success of deployment ${P2_ID}" >&2
  exit 1
fi
echo "    Deployment ${P2_ID} Succeeded (canary); alias 'live' -> version ${ALIAS_V2}; invoke returns v2"

# --- Phase 3: a shift that succeeds, then a failing deploy; `cdkd rollback` --
echo "==> Phase 3: UPDATE with --update-policy --no-rollback that fails after the alias shifted"
set +e
CDKD_TEST_UPDATE=v3 CDKD_TEST_FAIL=true env -u CDKD_TEST_HOOK node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --update-policy --no-rollback \
  > "${LOG_DIR}/phase3.log" 2>&1
P3_RC=$?
set -e
cat "${LOG_DIR}/phase3.log"
if [ "${P3_RC}" = "0" ]; then
  echo "FAIL: Phase 3 deploy succeeded although its queue is invalid" >&2
  exit 1
fi
# The forward shift, from cdkd's line; AWS must list it and report Succeeded.
P3_FWD_ID="$(grep -oE 'CodeDeploy deployment d-[A-Z0-9]+ started' "${LOG_DIR}/phase3.log" | head -1 | awk '{print $3}' || true)"
P3_FWD_LISTED="$(deployment_ids)"
if [ -z "${P3_FWD_ID}" ] || ! grep -q -x -e "${P3_FWD_ID}" <<<"${P3_FWD_LISTED}"; then
  echo "FAIL: Phase 3 started no CodeDeploy deployment that AWS lists (got '${P3_FWD_ID}')" >&2
  exit 1
fi
P3_FWD_STATUS="$(aws deploy get-deployment --deployment-id "${P3_FWD_ID}" --region "${REGION}" \
  --query 'deploymentInfo.status' --output text)"
if [ "${P3_FWD_STATUS}" != "Succeeded" ]; then
  echo "FAIL: expected the Phase 3 forward deployment ${P3_FWD_ID} Succeeded, got '${P3_FWD_STATUS}'" >&2
  exit 1
fi
EXPECTED_V3=$((ALIAS_V2 + 1))
ALIAS_V3F="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V3F}" != "${EXPECTED_V3}" ]; then
  echo "FAIL: expected the alias shifted to ${EXPECTED_V3} before the failure, got '${ALIAS_V3F}'" >&2
  exit 1
fi
echo "    Forward deployment ${P3_FWD_ID} Succeeded (alias at ${ALIAS_V3F}); the deploy then failed"

echo "==> Phase 3: cdkd rollback (shifts the alias back through CodeDeploy)"
node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force \
  2>&1 | tee "${LOG_DIR}/phase3-rollback.log"
P3_REV_ID="$(grep -oE 'CodeDeploy deployment d-[A-Z0-9]+ started' "${LOG_DIR}/phase3-rollback.log" | head -1 | awk '{print $3}' || true)"
P3_REV_LISTED="$(deployment_ids)"
if [ -z "${P3_REV_ID}" ] || [ "${P3_REV_ID}" = "${P3_FWD_ID}" ] \
  || ! grep -q -x -e "${P3_REV_ID}" <<<"${P3_REV_LISTED}"; then
  echo "FAIL: the rollback started no second CodeDeploy deployment that AWS lists (got '${P3_REV_ID}')" >&2
  exit 1
fi
P3_REV_STATUS="$(aws deploy get-deployment --deployment-id "${P3_REV_ID}" --region "${REGION}" \
  --query 'deploymentInfo.status' --output text)"
if [ "${P3_REV_STATUS}" != "Succeeded" ]; then
  echo "FAIL: expected the rollback deployment ${P3_REV_ID} Succeeded, got '${P3_REV_STATUS}'" >&2
  exit 1
fi
P3_ACTIVE_AFTER="$(active_deployment_ids)"
if [ -n "${P3_ACTIVE_AFTER}" ]; then
  echo "FAIL: a CodeDeploy deployment is still running after the rollback: ${P3_ACTIVE_AFTER}" >&2
  exit 1
fi
ALIAS_V3R="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V3R}" != "${ALIAS_V2}" ] || [ "$(alias_weights)" != "0" ]; then
  echo "FAIL: the rollback did not return the alias to version ${ALIAS_V2} with no split (got '${ALIAS_V3R}')" >&2
  exit 1
fi
P3_STATE_VERSION="$(state_alias_version)"
if [ "${P3_STATE_VERSION}" != "${ALIAS_V2}" ]; then
  echo "FAIL: state records the alias at '${P3_STATE_VERSION}' after the rollback, expected ${ALIAS_V2}" >&2
  exit 1
fi
invoke_returns v2
echo "    Rollback deployment ${P3_REV_ID} Succeeded; alias back at ${ALIAS_V2}"

# --- Phase 4: --update-policy, a failing BeforeAllowTraffic hook ---------
echo "==> Phase 4: UPDATE with --update-policy whose BeforeAllowTraffic hook fails"
HOOK_STATUS_BEFORE="$(hook_code_status)"
if [ "${HOOK_STATUS_BEFORE}" != "Succeeded" ]; then
  echo "FAIL: expected the hook's code to report Succeeded before Phase 4, got '${HOOK_STATUS_BEFORE}'" >&2
  exit 1
fi
set +e
CDKD_TEST_UPDATE=v4 CDKD_TEST_HOOK=fail node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --update-policy \
  > "${LOG_DIR}/phase4.log" 2>&1
P4_RC=$?
set -e
cat "${LOG_DIR}/phase4.log"
if [ "${P4_RC}" = "0" ]; then
  echo "FAIL: Phase 4 deploy succeeded although the hook reported Failed" >&2
  exit 1
fi
# The deployment cdkd started, from its own line (CodeDeploy's rollback of a
# failed deployment is a second deployment in the same group, so the list
# alone does not say which is which); it must also be one AWS lists.
P4_ID="$(grep -oE 'CodeDeploy deployment d-[A-Z0-9]+ started' "${LOG_DIR}/phase4.log" | head -1 | awk '{print $3}' || true)"
P4_LISTED="$(deployment_ids)"
if [ -z "${P4_ID}" ] || ! grep -q -x -e "${P4_ID}" <<<"${P4_LISTED}"; then
  echo "FAIL: Phase 4 started no CodeDeploy deployment that AWS lists (got '${P4_ID}')" >&2
  exit 1
fi
P4_STATUS="$(aws deploy get-deployment --deployment-id "${P4_ID}" --region "${REGION}" \
  --query 'deploymentInfo.status' --output text)"
if [ "${P4_STATUS}" != "Failed" ]; then
  echo "FAIL: expected the Phase 4 deployment ${P4_ID} Failed, got '${P4_STATUS}'" >&2
  exit 1
fi
if grep -q "Rollback failed" "${LOG_DIR}/phase4.log"; then
  echo "FAIL: the automatic rollback reported a failure" >&2
  exit 1
fi
ALIAS_V4F="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V4F}" != "${ALIAS_V2}" ] || [ "$(alias_weights)" != "0" ]; then
  echo "FAIL: alias not left at version ${ALIAS_V2} with no split after Phase 4" >&2
  exit 1
fi
P4_STATE_VERSION="$(state_alias_version)"
if [ "${P4_STATE_VERSION}" != "${ALIAS_V2}" ]; then
  echo "FAIL: state records the alias at '${P4_STATE_VERSION}', expected ${ALIAS_V2}" >&2
  exit 1
fi
P4_ACTIVE="$(active_deployment_ids)"
if [ -n "${P4_ACTIVE}" ]; then
  echo "FAIL: a CodeDeploy deployment is still running after Phase 4: ${P4_ACTIVE}" >&2
  exit 1
fi
# A positive mark of the automatic rollback: the hook function's failing
# code (this deploy's update of it) was put back, read from its package.
HOOK_STATUS_AFTER="$(hook_code_status)"
if [ "${HOOK_STATUS_AFTER}" != "Succeeded" ]; then
  echo "FAIL: the hook function's code was not rolled back (it reports '${HOOK_STATUS_AFTER}')" >&2
  exit 1
fi
invoke_returns v2
echo "    Deployment ${P4_ID} Failed; the deploy failed and rolled back; alias still at ${ALIAS_V2}"

# --- Phase 5: no flag, the alias is switched directly --------------------
echo "==> Phase 5: UPDATE without --update-policy (alias switched directly)"
BEFORE_P5_IDS="$(deployment_ids)"
BEFORE_P5="$(count_lines "${BEFORE_P5_IDS}")"
CDKD_TEST_UPDATE=v5 env -u CDKD_TEST_HOOK node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  2>&1 | tee "${LOG_DIR}/phase5.log"
AFTER_P5_IDS="$(deployment_ids)"
AFTER_P5="$(count_lines "${AFTER_P5_IDS}")"
if [ "${AFTER_P5}" != "${BEFORE_P5}" ]; then
  echo "FAIL: Phase 5 created a CodeDeploy deployment without --update-policy (${BEFORE_P5} -> ${AFTER_P5})" >&2
  exit 1
fi
ALIAS_V5="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
case "${ALIAS_V5}" in
  ''|*[!0-9]*)
    echo "FAIL: expected a numeric alias version after Phase 5, got '${ALIAS_V5}'" >&2
    exit 1 ;;
esac
if [ "${ALIAS_V5}" -le "${ALIAS_V2}" ]; then
  echo "FAIL: expected the alias past version ${ALIAS_V2} after Phase 5, got '${ALIAS_V5}'" >&2
  exit 1
fi
if ! grep -q "UpdatePolicy CodeDeployLambdaAliasUpdate is skipped by default; pass --update-policy" "${LOG_DIR}/phase5.log"; then
  echo "FAIL: cdkd did not print the UpdatePolicy hint in Phase 5" >&2
  exit 1
fi
invoke_returns v5
rm -rf "${LOG_DIR}"
echo "    Alias 'live' -> version ${ALIAS_V5} directly; no new deployment; hint printed"

# --- Phase 6: destroy + orphan-zero -------------------------------------
echo "==> Phase 6: destroy"
# This run's roles, from its state record before the destroy: the
# function's, the hook's and the CodeDeploy service role.
STACK_ROLES="$(state_roles)"
STACK_ROLE_COUNT="$(count_lines "${STACK_ROLES}")"
if [ "${STACK_ROLE_COUNT}" != "3" ]; then
  echo "FAIL: expected the stack's 3 IAM roles before destroy, found ${STACK_ROLE_COUNT}: ${STACK_ROLES}" >&2
  exit 1
fi
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "CodeDeploy application still exists after destroy" aws deploy get-application --application-name "${APP_NAME}" --region "${REGION}"
# Errors with ApplicationDoesNotExistException / DeploymentGroupDoesNotExist-
# Exception once either level is gone — both count as "deployment group gone".
assert_gone "CodeDeploy deployment group still exists after destroy" aws deploy get-deployment-group --application-name "${APP_NAME}" --deployment-group-name "${DG_NAME}" --region "${REGION}"
assert_gone "Lambda function still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "hook Lambda function still exists after destroy" aws lambda get-function --function-name "${HOOK_NAME}" --region "${REGION}"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
for r in ${STACK_ROLES}; do
  assert_gone "IAM role ${r} still exists after destroy" aws iam get-role --role-name "${r}"
done
echo "    Application / functions / roles / state all gone"

# The invokes (and CodeDeploy's hook invocations) auto-created the
# /aws/lambda/<fn> log groups: sweep them, then assert none is left.
sweep_log_groups
LEFT_LOG_GROUPS="$(fixture_log_groups)"
if [ -n "${LEFT_LOG_GROUPS}" ]; then
  echo "FAIL: log groups still exist after the sweep: ${LEFT_LOG_GROUPS}" >&2
  exit 1
fi

echo "[verify] PASS"
