#!/usr/bin/env bash
# verify.sh — cdkd API Gateway REST private integration through a VPC link v2
# (issue #5391).
#
# `Integration.IntegrationTarget` names the load balancer a private
# integration routes to. Before the fix cdkd never sent it to PutIntegration.
#
# Phases:
#   1. Deploy: the method routes to ALB A. Assert `integrationTarget` reads
#      back as ALB A's ARN and the stage answers with ALB A's fixed body.
#   2. Redeploy with CDKD_TEST_UPDATE=true: the method routes to ALB B (the
#      `Uri` is unchanged). Assert `integrationTarget` reads back as ALB B's ARN
#      and the stage answers with ALB B's body.
#   3. Destroy; assert the REST API, the VPC link, both load balancers, the VPC
#      and the state file are gone.
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

STACK="CdkdApigwVpclinkIntegrationTargetExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The fixture's literal names (lib/apigw-vpclink-integration-target-stack.ts).
API_NAME="cdkd-5391-vpclink-api"
VPC_LINK_NAME="cdkd-5391-vpclink"
ALB_NAMES="cdkd-5391-alb-a cdkd-5391-alb-b"
STAGE_NAME="prod"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Ids of the REST APIs named API_NAME, space-separated.
rest_api_ids() {
  aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?name=='${API_NAME}'].id" --output text
}
# Ids of the VPC links (v2) named VPC_LINK_NAME, space-separated.
vpc_link_ids() {
  aws apigatewayv2 get-vpc-links --region "${REGION}" \
    --query "Items[?Name=='${VPC_LINK_NAME}'].VpcLinkId" --output text
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # The state file is removed below only when `state destroy` succeeded or
  # left no state behind: after a failed destroy it is the record of what is
  # left, so it is kept and the run says so.
  # Global: the pre-run call stops the run on a failed destroy.
  CLEANUP_DESTROY_OK=1
  if [ -f "${LOCAL_DIST}" ] \
    && ! env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1 \
    && aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" >/dev/null 2>&1; then
    CLEANUP_DESTROY_OK=0
    echo "FAIL: cleanup: 'cdkd state destroy ${STACK}' failed; keeping s3://${STATE_BUCKET:-}/${STATE_KEY} -- check the stack's resources by hand" >&2
  fi
  # Backstops by the fixture's literal names (never a variable prefix).
  for id in $(rest_api_ids 2>/dev/null); do
    [ "${id}" = "None" ] && continue
    aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for id in $(vpc_link_ids 2>/dev/null); do
    [ "${id}" = "None" ] && continue
    aws apigatewayv2 delete-vpc-link --vpc-link-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for name in ${ALB_NAMES}; do
    for arn in $(aws elbv2 describe-load-balancers --names "${name}" --region "${REGION}" \
      --query 'LoadBalancers[].LoadBalancerArn' --output text 2>/dev/null); do
      case "${arn}" in
        arn:*:loadbalancer/app/cdkd-5391-alb-?/*)
          aws elbv2 delete-load-balancer --load-balancer-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 || true
          ;;
        *) echo "WARN: teardown sweep refused -- '${arn}' is not one of this fixture's load balancers" >&2 ;;
      esac
    done
  done
  if [ -n "${STATE_BUCKET:-}" ] && [ "${CLEANUP_DESTROY_OK}" = 1 ]; then
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
# Never deploy on top of a leftover stack whose destroy just failed.
if [ "${CLEANUP_DESTROY_OK}" != 1 ]; then
  echo "FAIL: pre-run cleanup could not destroy the leftover ${STACK}; not deploying over it" >&2
  exit 1
fi

# Prints the state's output whose key starts with $1.
state_output() { # usage: state_output <key prefix>
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  jq -r --arg k "$1" '[.outputs | to_entries[] | select(.key | startswith($k)) | .value] | first // empty' <<<"${state}"
}

# Asserts the method's integration targets $1 and the stage answers with $2.
# The stage can take a little while to serve a new deployment, so the body is
# retried for up to ~2 minutes.
assert_routes_to() { # usage: assert_routes_to <load balancer ARN> <expected body> <label>
  local target body i
  target=$(aws apigateway get-integration --rest-api-id "${API_ID}" \
    --resource-id "${ROOT_ID}" --http-method GET --region "${REGION}" \
    --query integrationTarget --output text) || return 1
  if [ "${target}" != "$1" ]; then
    echo "FAIL: [$3] integrationTarget is '${target}', expected '$1' (issue #5391)" >&2
    exit 1
  fi
  echo "    OK: [$3] integrationTarget == $1"
  body=""
  for i in $(seq 1 24); do
    body=$(curl -sS --max-time 10 "https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}/" || true)
    [ "${body}" = "$2" ] && break
    sleep 5
  done
  if [ "${body}" != "$2" ]; then
    echo "FAIL: [$3] the stage answered '${body}', expected '$2' from the load balancer the integration targets (issue #5391)" >&2
    exit 1
  fi
  echo "    OK: [$3] the stage answered '$2' through the VPC link"
}

# --- Phase 1: deploy (target ALB A) -------------------------------------------
echo "==> Phase 1: deploy (IntegrationTarget = ALB A)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

API_ID=$(state_output ApiId)
ROOT_ID=$(state_output RootResourceId)
ALB_A=$(state_output AlbAArn)
ALB_B=$(state_output AlbBArn)
VPC_ID=$(state_output VpcId)
for v in API_ID ROOT_ID ALB_A ALB_B VPC_ID; do
  if [ -z "${!v}" ]; then
    echo "FAIL: output ${v} missing from state" >&2
    exit 1
  fi
done
assert_routes_to "${ALB_A}" "from-alb-a" "create"

# --- Phase 2: update (target ALB B) -------------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (IntegrationTarget = ALB B)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_routes_to "${ALB_B}" "from-alb-b" "update"

# --- Phase 3: destroy ---------------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone "REST API ${API_ID} still exists after destroy" aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}"
echo "    OK: REST API is gone"
LEFT_LINKS=$(vpc_link_ids)
if [ -n "${LEFT_LINKS}" ] && [ "${LEFT_LINKS}" != "None" ]; then
  echo "FAIL: VPC link(s) ${LEFT_LINKS} named ${VPC_LINK_NAME} still exist after destroy" >&2
  exit 1
fi
echo "    OK: VPC link is gone"
assert_gone "load balancer ${ALB_A} still exists after destroy" aws elbv2 describe-load-balancers --load-balancer-arns "${ALB_A}" --region "${REGION}"
assert_gone "load balancer ${ALB_B} still exists after destroy" aws elbv2 describe-load-balancers --load-balancer-arns "${ALB_B}" --region "${REGION}"
echo "    OK: both load balancers are gone"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: VPC is gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS — apigw-vpclink-integration-target: IntegrationTarget created, updated, routed, and destroyed cleanly"
