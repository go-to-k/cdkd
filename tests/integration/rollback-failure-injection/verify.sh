#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the cdkd deploy-engine ROLLBACK path on a
# RICH multi-resource stack (deploy-engine rollback regression net).
#
# The existing rollback coverage is only the trivial `basic` single-SQS
# `CDKD_TEST_FAIL` injection. This fixture is deliberately interdependent so
# several siblings COMPLETE before the failure fires — giving rollback real
# work to do. The fixture is SELF-CONTAINED: it defines its OWN failing
# resource gated on `ROLLBACK_INTEG_FAIL=true` (an SQS Queue with an
# out-of-range messageRetentionPeriod), wired to depend on the fast siblings
# (IAM Role + SSM Parameter) so those are guaranteed created when the failure
# fires. It does NOT reuse the `basic` fixture's CDKD_TEST_FAIL plumbing.
#
# What this asserts:
#   1. Deploy with the fail flag ON exits NON-ZERO.
#   2. The completed siblings are ROLLED BACK: queried directly against AWS,
#      the SSM Parameter / SecurityGroup / VPC / Lambda created before the
#      failure no longer exist, and cdkd state reflects rollback (state.json
#      gone / empty). NO leftover hyperplane ENIs / SGs / the VPC.
#   3. The #808 events captured the failure: `cdkd events --format json` shows
#      a RESOURCE_FAILED for the failing queue, ROLLBACK_* events for the
#      rolled-back siblings, and RUN_FINISHED result=FAILED.
#   4. Deploy with the fail flag OFF succeeds → destroy → clean (0 orphans).
#   5. Cleanup (EXIT trap) AGGRESSIVELY removes any orphan VPC/ENI/SG/Role/
#      Lambda/SSM/SQS + the events sidecar — this test INTENTIONALLY creates a
#      failed deploy, so the trap must not leak resources.
#
# BSD/macOS-portable: no grep -P, no date -d. Integ-exit-code-capture pattern
# (bash ...; rc=$?) so a piped/teed harness can't mask a failure; the script
# prints an explicit "[verify] PASS" only at the very end.
set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="CdkdRollbackFailureExample"
SSM_PARAM_NAME="${STACK}-marker"
FAILING_QUEUE_NAME="${STACK}-failing-queue"
# Deterministic, NON-reserved tag the fixture applies to EVERY resource via
# `cdk.Tags.of(this).add(...)` (lib/rollback-failure-stack.ts). We filter the
# EC2 VPC / SecurityGroup and the IAM Role / Lambda cleanup by this tag instead
# of `aws:cdk:path`: cdkd's EC2 provider only forwards template-supplied `Tags`,
# and AWS reserves the `aws:` prefix, so cdkd NEVER sets `aws:cdk:path` on a
# VPC / SG / Role / Lambda. A `tag:aws:cdk:path` filter therefore always returns
# empty — it would FALSELY FAIL the "VPC created" assertion (step 5a) and
# VACUOUSLY PASS the "gone" assertions (steps 3c/3d/7), masking real orphans.
# cdkd DOES apply this non-reserved tag (EC2 CreateTags / IAM TagRole /
# Lambda TagResource), so every resource-existence query below is reliable.
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="rollback-failure-injection"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-failure-injection"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
DEPLOYMENTS_PREFIX="cdkd/${STACK}/${REGION}/deployments/"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# --- Helper: find the fixture's VPC ids by the fixture tag. Echoes a
# space-separated list (may be empty). ---
find_fixture_vpcs() {
  aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null || true
}

# --- Helper: find the fixture's SecurityGroup ids by the fixture tag. ---
find_fixture_sgs() {
  aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'SecurityGroups[].GroupId' --output text 2>/dev/null || true
}

# --- Aggressive orphan cleanup (used by the EXIT trap AND deliberately after
# the intentional failed deploy if rollback left anything behind). ---
aggressive_cleanup() {
  echo "[verify] aggressive cleanup: sweeping any fixture orphans"

  # SSM parameter (deterministic name).
  aws ssm delete-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true

  # SQS failing queue (deterministic name): resolve URL then delete.
  local q_url
  q_url="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true)"
  if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi

  # Lambda functions carrying the fixture tag. ListFunctions has no tag filter,
  # so enumerate + check each function's tags for the fixture tag.
  local fn_arns fn_arn fn_name tagval
  fn_arns="$(aws lambda list-functions --region "${REGION}" \
    --query 'Functions[].FunctionArn' --output text 2>/dev/null || true)"
  for fn_arn in ${fn_arns}; do
    tagval="$(aws lambda list-tags --resource "${fn_arn}" --region "${REGION}" \
      --query "Tags.\"${FIXTURE_TAG_KEY}\"" --output text 2>/dev/null || true)"
    case "${tagval}" in
      "${FIXTURE_TAG_VALUE}")
        fn_name="${fn_arn##*:}"
        echo "[verify]   deleting orphan Lambda ${fn_name}"
        aws lambda delete-function --function-name "${fn_arn}" --region "${REGION}" >/dev/null 2>&1 || true
        ;;
    esac
  done

  # IAM roles: ListRoles has no tag filter. Enumerate roles, check the fixture
  # tag, detach managed policies, then delete.
  local role_names role_name rtag pol_arns pol_arn
  role_names="$(aws iam list-roles --query 'Roles[].RoleName' --output text 2>/dev/null || true)"
  for role_name in ${role_names}; do
    rtag="$(aws iam list-role-tags --role-name "${role_name}" \
      --query "Tags[?Key=='${FIXTURE_TAG_KEY}'].Value | [0]" --output text 2>/dev/null || true)"
    case "${rtag}" in
      "${FIXTURE_TAG_VALUE}")
        echo "[verify]   deleting orphan IAM role ${role_name}"
        pol_arns="$(aws iam list-attached-role-policies --role-name "${role_name}" \
          --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)"
        for pol_arn in ${pol_arns}; do
          aws iam detach-role-policy --role-name "${role_name}" --policy-arn "${pol_arn}" >/dev/null 2>&1 || true
        done
        aws iam delete-role --role-name "${role_name}" >/dev/null 2>&1 || true
        ;;
    esac
  done

  # VPC + dependents (ENIs, SGs, subnets, NAT GW, IGW, route tables). Best-effort
  # ordered teardown so the VPC delete itself can succeed.
  local vpc_id eni_id sg_id subnet_id nat_id rtb_id igw_id
  for vpc_id in $(find_fixture_vpcs); do
    [ -z "${vpc_id}" ] && continue
    [ "${vpc_id}" = "None" ] && continue
    echo "[verify]   tearing down orphan VPC ${vpc_id}"
    # Hyperplane ENIs first (these block SG/subnet/VPC delete).
    for eni_id in $(aws ec2 describe-network-interfaces --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'NetworkInterfaces[].NetworkInterfaceId' --output text 2>/dev/null || true); do
      aws ec2 delete-network-interface --network-interface-id "${eni_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    # NAT gateways (async; best effort).
    for nat_id in $(aws ec2 describe-nat-gateways --region "${REGION}" \
      --filter "Name=vpc-id,Values=${vpc_id}" \
      --query 'NatGateways[].NatGatewayId' --output text 2>/dev/null || true); do
      aws ec2 delete-nat-gateway --nat-gateway-id "${nat_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    # Non-default security groups.
    for sg_id in $(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null || true); do
      aws ec2 delete-security-group --group-id "${sg_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    # Subnets.
    for subnet_id in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'Subnets[].SubnetId' --output text 2>/dev/null || true); do
      aws ec2 delete-subnet --subnet-id "${subnet_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    # Detach + delete internet gateways.
    for igw_id in $(aws ec2 describe-internet-gateways --region "${REGION}" \
      --filters "Name=attachment.vpc-id,Values=${vpc_id}" \
      --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null || true); do
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw_id}" --vpc-id "${vpc_id}" --region "${REGION}" >/dev/null 2>&1 || true
      aws ec2 delete-internet-gateway --internet-gateway-id "${igw_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    # Non-main route tables.
    for rtb_id in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text 2>/dev/null || true); do
      aws ec2 delete-route-table --route-table-id "${rtb_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    aws ec2 delete-vpc --vpc-id "${vpc_id}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    # Best-effort: destroy the stack if cdkd state still exists.
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    aggressive_cleanup
  fi
  # ALWAYS remove the events sidecar so the integ leaves nothing behind
  # (events deliberately survive destroy — the test itself must clean them).
  echo "[verify] cleanup: remove events sidecar s3://${STATE_BUCKET}/cdkd/${STACK}/"
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

# ---------------------------------------------------------------------------
# PHASE 1: deploy with the failure injected — expect a NON-ZERO exit + rollback
# ---------------------------------------------------------------------------
echo "[verify] step 2: cdkd deploy ${STACK} with ROLLBACK_INTEG_FAIL=true (expect FAILURE)"
set +e
ROLLBACK_INTEG_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > /tmp/rollback-deploy.log 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-deploy.log || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: deploy with ROLLBACK_INTEG_FAIL=true unexpectedly SUCCEEDED (rc=0)"
  exit 1
fi
echo "[verify] step 2 ok: failed deploy exited non-zero (rc=${DEPLOY_RC})"

echo "[verify] step 3: assert completed siblings were ROLLED BACK (query AWS directly)"

# 3a. SSM Parameter (a fast sibling guaranteed created before the failure).
assert_gone "SSM parameter ${SSM_PARAM_NAME} still exists — rollback did NOT delete the completed sibling" aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}"
echo "[verify]   ok: SSM parameter ${SSM_PARAM_NAME} rolled back (gone)"

# 3b. The failing queue itself must not linger (AWS rejected it; nothing to clean,
#     but assert no half-created queue is left).
Q_URL="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}" \
  --query 'QueueUrl' --output text 2>/dev/null || true)"
if [ -n "${Q_URL}" ] && [ "${Q_URL}" != "None" ]; then
  echo "[verify] FAIL: failing queue ${FAILING_QUEUE_NAME} exists — invalid CreateQueue should have been rejected"
  exit 1
fi
echo "[verify]   ok: no failing queue left behind"

# 3c. VPC gone (the whole slow branch rolled back).
REMAINING_VPCS="$(find_fixture_vpcs)"
if [ -n "${REMAINING_VPCS}" ] && [ "${REMAINING_VPCS}" != "None" ]; then
  echo "[verify] FAIL: VPC(s) still present after rollback: ${REMAINING_VPCS}"
  exit 1
fi
echo "[verify]   ok: no fixture VPC left behind"

# 3d. SecurityGroup gone (would otherwise be an orphan + a hyperplane-ENI risk).
REMAINING_SGS="$(find_fixture_sgs)"
if [ -n "${REMAINING_SGS}" ] && [ "${REMAINING_SGS}" != "None" ]; then
  echo "[verify] FAIL: SecurityGroup(s) still present after rollback: ${REMAINING_SGS}"
  exit 1
fi
echo "[verify]   ok: no fixture SecurityGroup / leftover hyperplane ENI source left behind"

# 3e. cdkd state reflects rollback: state.json gone (rollback deleted everything,
#     so the engine removes the now-empty state) OR present-but-empty resources.
echo "[verify] step 3e: assert cdkd state reflects rollback (empty / no orphan)"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || true)"
  N_RES="$(echo "${STATE_JSON}" | jq '(.resources // {}) | length' 2>/dev/null || echo "unknown")"
  if [ "${N_RES}" != "0" ]; then
    echo "[verify] FAIL: state.json still records ${N_RES} resource(s) after rollback (expected 0 / no orphan)"
    echo "${STATE_JSON}" | sed 's/^/  /'
    exit 1
  fi
  echo "[verify]   ok: state.json present but records 0 resources"
else
  echo "[verify]   ok: state.json removed entirely after full rollback"
fi
echo "[verify] step 3 ok: all completed siblings rolled back, no orphans in AWS or state"

# ---------------------------------------------------------------------------
# PHASE 2: assert the #808 events captured the failure + rollback
# ---------------------------------------------------------------------------
echo "[verify] step 4: assert #808 events captured the failure + rollback"
EVENTS_JSON="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --format json 2>&1)"
RUN_ID="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].runId')"
RUN_CMD="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].command')"
RUN_RESULT="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].result')"
if [ -z "${RUN_ID}" ] || [ "${RUN_ID}" = "null" ]; then
  echo "[verify] FAIL: run-listing JSON has no runs[0].runId:"
  echo "${EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
if [ "${RUN_CMD}" != "deploy" ] || [ "${RUN_RESULT}" != "FAILED" ]; then
  echo "[verify] FAIL: newest run is not a FAILED deploy (command=${RUN_CMD} result=${RUN_RESULT})"
  echo "${EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify]   newest failed deploy run id: ${RUN_ID}"

RUN_EVENTS_JSON="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --run "${RUN_ID}" --format json 2>&1)"

# 4a. RUN_FINISHED with result=FAILED.
if ! echo "${RUN_EVENTS_JSON}" | jq -e \
  '[.[] | select(.eventType == "RUN_FINISHED" and .result == "FAILED")] | length >= 1' >/dev/null; then
  echo "[verify] FAIL: per-run stream has no RUN_FINISHED with result=FAILED"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify]   ok: RUN_FINISHED result=FAILED present"

# 4b. RESOURCE_FAILED for the failing SQS queue.
if ! echo "${RUN_EVENTS_JSON}" | jq -e \
  '[.[] | select(.eventType == "RESOURCE_FAILED" and .resourceType == "AWS::SQS::Queue")] | length >= 1' >/dev/null; then
  echo "[verify] FAIL: per-run stream has no RESOURCE_FAILED for AWS::SQS::Queue (the injected failure)"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify]   ok: RESOURCE_FAILED for AWS::SQS::Queue present"

# 4c. ROLLBACK_* events for the rolled-back siblings.
N_ROLLBACK="$(echo "${RUN_EVENTS_JSON}" | jq '[.[] | select(.eventType | startswith("ROLLBACK_"))] | length')"
if [ "${N_ROLLBACK}" -lt 1 ]; then
  echo "[verify] FAIL: per-run stream has no ROLLBACK_* events for the rolled-back siblings"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
# Assert at least one ROLLBACK_STARTED and one rollback per-resource SUCCEEDED.
if ! echo "${RUN_EVENTS_JSON}" | jq -e \
  '[.[] | select(.eventType == "ROLLBACK_STARTED")] | length >= 1' >/dev/null; then
  echo "[verify] FAIL: per-run stream has no ROLLBACK_STARTED event"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
if ! echo "${RUN_EVENTS_JSON}" | jq -e \
  '[.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED")] | length >= 1' >/dev/null; then
  echo "[verify] FAIL: per-run stream has no ROLLBACK_RESOURCE_SUCCEEDED event (no sibling actually rolled back)"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify]   ok: ROLLBACK_* events present (total=${N_ROLLBACK})"
echo "[verify] step 4 ok: events captured RESOURCE_FAILED + ROLLBACK_* + RUN_FINISHED=FAILED"

# ---------------------------------------------------------------------------
# PHASE 3: deploy CLEAN (fail flag OFF) → succeeds → destroy → clean
# ---------------------------------------------------------------------------
echo "[verify] step 5: cdkd deploy ${STACK} with ROLLBACK_INTEG_FAIL unset (expect SUCCESS)"
unset ROLLBACK_INTEG_FAIL
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

echo "[verify] step 5a: assert clean deploy created the siblings"
if ! aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: SSM parameter ${SSM_PARAM_NAME} missing after a successful deploy"
  exit 1
fi
CLEAN_VPCS="$(find_fixture_vpcs)"
if [ -z "${CLEAN_VPCS}" ] || [ "${CLEAN_VPCS}" = "None" ]; then
  echo "[verify] FAIL: no VPC created after a successful deploy"
  exit 1
fi
echo "[verify] step 5a ok: clean deploy created VPC(s) ${CLEAN_VPCS} + SSM parameter"

echo "[verify] step 6: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 7: assert destroy is clean (0 orphans, state gone)"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "SSM parameter ${SSM_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}"
POST_VPCS="$(find_fixture_vpcs)"
if [ -n "${POST_VPCS}" ] && [ "${POST_VPCS}" != "None" ]; then
  echo "[verify] FAIL: VPC(s) still present after destroy: ${POST_VPCS}"
  exit 1
fi
POST_SGS="$(find_fixture_sgs)"
if [ -n "${POST_SGS}" ] && [ "${POST_SGS}" != "None" ]; then
  echo "[verify] FAIL: SecurityGroup(s) still present after destroy: ${POST_SGS}"
  exit 1
fi
echo "[verify] step 7 ok: destroy clean — state gone, 0 orphan VPC/SG/SSM"

echo "[verify] step 8: cleanup — remove the events sidecar so the integ leaves nothing behind"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" 2>&1 || true)"
if echo "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "[verify] FAIL: events sidecar not fully removed:"
  echo "${REMAINING}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 8 ok: events sidecar removed"

trap - EXIT INT TERM
echo "[verify] PASS"
