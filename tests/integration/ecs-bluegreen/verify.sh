#!/usr/bin/env bash
# verify.sh — cdkd ECS blue/green LoadBalancers[].AdvancedConfiguration integ
# (issue #1480, follow-up to the #1473 silent-drop fix).
#
# The #1473 fix forwards `LoadBalancers[].AdvancedConfiguration`
# (AlternateTargetGroupArn / ProductionListenerRule / TestListenerRule /
# RoleArn) onto CreateService / UpdateService, pinned by unit tests asserting
# the exact SDK input. This fixture proves the block reaches REAL AWS: deploy
# an ECS service wired for the built-in blue/green strategy (ALB + two target
# groups + production/test listener rules + ECS infrastructure role), read the
# service back via `describe-services`, and assert every AdvancedConfiguration
# member landed. Then destroy and assert 0 orphans — the ALB / TG /
# listener-rule teardown order is part of what this run exercises.
#
# Cost: desiredCount 0 — no task ever launches; the internal ALB idles for
# the few minutes of the run.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail
export AWS_PAGER=""

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

STACK="CdkdEcsBluegreenExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-ecs-bluegreen-test"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  ( set +eu
    if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
        --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    fi
    # Out-of-band sweep of the fixed-name ECS pieces so a crashed run cannot
    # poison the next one even if state destroy failed. Deliberately does NOT
    # remove state.json: when state destroy fails, that file is the only
    # ledger of what leaked (VPC/ALB etc.), and the pre-run cleanup below
    # retries it on the next invocation. Only the transient lock is dropped.
    for SVC_ARN in $(aws ecs list-services --cluster "${CLUSTER_NAME}" --region "${REGION}" \
        --query 'serviceArns[]' --output text 2>/dev/null); do
      aws ecs delete-service --cluster "${CLUSTER_NAME}" --service "${SVC_ARN}" \
        --force --region "${REGION}" >/dev/null 2>&1
    done
    aws ecs delete-cluster --cluster "${CLUSTER_NAME}" --region "${REGION}" >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    fi
  )
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

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy ECS blue/green service (ALB + 2 TGs + rules + infra role)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Read the deploy-time identities from cdkd state outputs so the assertions
# compare against the EXACT resources this run created (never a name guess).
state_output() { # $1 = output key -> value
  local out
  out="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const s=JSON.parse(d);process.stdout.write(String(s.outputs[process.argv[1]] ?? ''));
    });" "$1")" || return 1
  [ -n "${out}" ] || return 1
  printf '%s' "${out}"
}
SERVICE_NAME="$(state_output ServiceName)"
DEPLOYED_CLUSTER_NAME="$(state_output ClusterName)"
BLUE_TG_ARN="$(state_output BlueTgArn)"
GREEN_TG_ARN="$(state_output GreenTgArn)"
PROD_RULE_ARN="$(state_output ProdRuleArn)"
TEST_RULE_ARN="$(state_output TestRuleArn)"
INFRA_ROLE_ARN="$(state_output InfraRoleArn)"
TASK_ROLE_ARN="$(state_output TaskRoleArn)"
VPC_ID="$(state_output VpcId)"
if [ "${DEPLOYED_CLUSTER_NAME}" != "${CLUSTER_NAME}" ]; then
  echo "FAIL: deployed cluster name '${DEPLOYED_CLUSTER_NAME}' != expected '${CLUSTER_NAME}' (fixture drifted from its cleanup sweep)" >&2
  exit 1
fi
echo "    service: ${SERVICE_NAME}"

# --- The #1480 assertion: AdvancedConfiguration reached AWS -------------
SVC_JSON="$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" \
  --region "${REGION}" --query 'services[0]' --output json)"
read_svc() { # $1 = node -e JSON path expression over the service object
  printf '%s' "${SVC_JSON}" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const s=JSON.parse(d);
      const v=process.argv[1].split('.').reduce((a,k)=>a?.[k], s);
      process.stdout.write(String(v ?? ''));
    });" "$1" || return 1
}
STRATEGY="$(read_svc 'deploymentConfiguration.strategy')"
if [ "${STRATEGY}" != "BLUE_GREEN" ]; then
  echo "FAIL: deploymentConfiguration.strategy is '${STRATEGY}', expected BLUE_GREEN" >&2
  exit 1
fi
ADV_ALT="$(read_svc 'loadBalancers.0.advancedConfiguration.alternateTargetGroupArn')"
ADV_PROD="$(read_svc 'loadBalancers.0.advancedConfiguration.productionListenerRule')"
ADV_TEST="$(read_svc 'loadBalancers.0.advancedConfiguration.testListenerRule')"
ADV_ROLE="$(read_svc 'loadBalancers.0.advancedConfiguration.roleArn')"
if [ "${ADV_ALT}" != "${GREEN_TG_ARN}" ]; then
  echo "FAIL: advancedConfiguration.alternateTargetGroupArn is '${ADV_ALT}', expected '${GREEN_TG_ARN}' (the #1473 forward did not reach AWS)" >&2
  exit 1
fi
if [ "${ADV_PROD}" != "${PROD_RULE_ARN}" ]; then
  echo "FAIL: advancedConfiguration.productionListenerRule is '${ADV_PROD}', expected '${PROD_RULE_ARN}'" >&2
  exit 1
fi
if [ "${ADV_TEST}" != "${TEST_RULE_ARN}" ]; then
  echo "FAIL: advancedConfiguration.testListenerRule is '${ADV_TEST}', expected '${TEST_RULE_ARN}'" >&2
  exit 1
fi
if [ "${ADV_ROLE}" != "${INFRA_ROLE_ARN}" ]; then
  echo "FAIL: advancedConfiguration.roleArn is '${ADV_ROLE}', expected '${INFRA_ROLE_ARN}'" >&2
  exit 1
fi
echo "    OK: all four AdvancedConfiguration members reached AWS (alternate TG + prod/test rules + role)"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# The service lingers DRAINING/INACTIVE briefly after deletion, and
# `describe-clusters` does NOT error for a missing cluster (it reports it in
# `failures[]` and yields an empty `clusters[]`), so a gone_probe cannot apply
# here — a STRICT capture (no silence, no fallback; a throttle aborts loudly
# under set -e) of the status is the correct probe: a deleted cluster reads
# `None` (empty clusters[]) or `INACTIVE` (deletion settling).
CLUSTER_STATUS="$(aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --region "${REGION}" --query 'clusters[0].status' --output text)"
if [ "${CLUSTER_STATUS}" != "None" ] && [ "${CLUSTER_STATUS}" != "INACTIVE" ]; then
  echo "FAIL: cluster status after destroy is '${CLUSTER_STATUS}', expected gone/INACTIVE" >&2
  exit 1
fi
# Target groups are NOT children of the ALB (they survive ALB deletion), so
# BOTH get their own probe — a blue-TG-only leak is invisible to every other
# assertion here.
assert_gone "blue target group still exists after destroy" aws elbv2 describe-target-groups --target-group-arns "${BLUE_TG_ARN}" --region "${REGION}"
assert_gone "green target group still exists after destroy" aws elbv2 describe-target-groups --target-group-arns "${GREEN_TG_ARN}" --region "${REGION}"
assert_gone "production listener rule still exists after destroy" aws elbv2 describe-rules --rule-arns "${PROD_RULE_ARN}" --region "${REGION}"
assert_gone "test listener rule still exists after destroy" aws elbv2 describe-rules --rule-arns "${TEST_RULE_ARN}" --region "${REGION}"
ALB_COUNT="$(aws elbv2 describe-load-balancers --region "${REGION}" \
  --query "length(LoadBalancers[?VpcId=='${VPC_ID}'])" --output text)"
if [ "${ALB_COUNT}" != "0" ]; then
  echo "FAIL: ${ALB_COUNT} load balancer(s) still exist in ${VPC_ID} after destroy" >&2
  exit 1
fi
ROLE_NAME="${INFRA_ROLE_ARN##*/}"
assert_gone "ECS infrastructure role still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
TASK_ROLE_NAME="${TASK_ROLE_ARN##*/}"
assert_gone "task role still exists after destroy" aws iam get-role --role-name "${TASK_ROLE_NAME}"
assert_gone "VPC still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    ECS + ELB + IAM + VPC resources deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — ECS blue/green AdvancedConfiguration reached AWS; clean destroy, 0 orphans"
