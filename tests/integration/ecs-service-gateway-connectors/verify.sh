#!/usr/bin/env bash
# verify.sh — cdkd AWS::ECS::Service GatewayConnectors integ test (issue #5634).
#
# Before #5634 `GatewayConnectors` was in the coverage map's SDK-unwired set,
# so a Service declaring it routed WHOLE through Cloud Control (a sticky
# `provisionedBy: cc-api`). Each phase below asserts the Service stayed on
# the SDK route AND reads the connector back from the service REVISION —
# DescribeServices has no `gatewayConnectors` member.
#
#   Phase 0 (setup):   CDKD_INTEG_PHASE=0 deploys only the gateway's
#                      infrastructure role and what the gateway needs that
#                      does not depend on it (VPC, cluster, task definition),
#                      then waits GATEWAY_ROLE_SETTLE_SECONDS (30s). Reason:
#                      go-to-k/cdkd#5661 — a gateway created in the SAME deploy
#                      as its role is rejected while the role propagates, and
#                      cdkd does not ride that out yet. No assertion here.
#   Phase 1 (create):  CDKD_TEST_UPDATE unset -> adds the gateway, the
#                      cluster association and the service; CreateService carries a
#                      connector with every nested block (PortName,
#                      HealthCheck, Filters); the revision echoes it exactly.
#   Phase 2 (update):  CDKD_TEST_UPDATE=true CHANGES the connector's filters
#                      -> the new revision carries the new access types.
#   Phase 3 (removal): CDKD_TEST_UPDATE=true,remove DROPS the property ->
#                      CloudFormation KEEPS the live connector (A/B on #5634:
#                      no deployment starts), so cdkd sends nothing and the
#                      phase-2 connector must survive.
#   Phase 4 (clear):   CDKD_TEST_UPDATE=true,remove,clear DECLARES `[]` -> the
#                      clearing form under CloudFormation; the new revision
#                      must carry no connector.
#   Phase 5:           a plain `cdkd destroy`; assert the Service, cluster,
#                      gateway, association, infrastructure role, VPC and
#                      state file are gone. This is the arm for
#                      go-to-k/cdkd#5664: the SDK service delete returned while
#                      the service was still DRAINING, the gateway's cluster
#                      association then stayed DISASSOCIATING, and the gateway
#                      delete was refused ("active cluster associations"). The
#                      delete now waits for INACTIVE, as CloudFormation does.
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

STACK="CdkdEcsServiceGatewayConnectorsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Both fixed in lib/ecs-service-gateway-connectors-stack.ts. The pre-flight
# refuses to deploy over a live one of either name (ECS CreateCluster with an
# existing name ADOPTS that cluster).
GATEWAY_NAME="cdkd-ecs-svc-gw-connectors"
FIXTURE_CLUSTER_NAME="cdkd-ecs-svc-gw-connectors"
# Per-run nonce. The stack tags the cluster and the gateway with it
# (`cdkd-integ-run-id`), and the teardown sweep deletes ONLY a resource that
# carries THIS run's tag: a same-named resource another run owns is never
# touched. Exported so every deploy (and its synth) sees the same value.
RUN_ID="$(date +%s)-$$"
export CDKD_INTEG_RUN_ID="${RUN_ID}"
RUN_TAG_KEY="cdkd-integ-run-id"
# Set right before the first deploy. Until then cleanup touches nothing: no
# resource of this run can exist, and a state record or a same-named resource
# found before that belongs to someone else.
DEPLOY_STARTED=0

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The latest service deployment's target revision carries `gatewayConnectors`.
# Prints its compact, key-sorted JSON (`null` when the revision has no such
# member); MISSING on any failed AWS call or unparseable reply.
# Always returns 0, so the caller's exact-string assert prints its FAIL line.
# One page of up to 100 (the API maximum) covers this fixture's few deployments.
revision_gateway_connectors() {
  local deployments rev revisions
  if ! deployments="$(aws ecs list-service-deployments --cluster "${CLUSTER_NAME}" --service "${SERVICE_NAME}" --region "${REGION}" --max-results 100 --output json 2>/dev/null)"; then
    echo "MISSING"
    return 0
  fi
  if ! rev="$(printf '%s' "${deployments}" | jq -r '.serviceDeployments | sort_by(.createdAt) | last | .targetServiceRevisionArn // empty')" || [ -z "${rev}" ]; then
    echo "MISSING"
    return 0
  fi
  if ! revisions="$(aws ecs describe-service-revisions --service-revision-arns "${rev}" --region "${REGION}" --output json 2>/dev/null)"; then
    echo "MISSING"
    return 0
  fi
  if ! printf '%s' "${revisions}" | jq -cS 'if (.serviceRevisions | length) == 1 then .serviceRevisions[0].gatewayConnectors else error("no revision") end' 2>/dev/null; then
    echo "MISSING"
  fi
  return 0
}

# The ARN of the service's newest deployment, or MISSING. Phase 3 compares it
# across the removal: CloudFormation starts NO deployment there (A/B on
# #5634), so a new ARN means cdkd sent something it should not have.
latest_deployment_arn() {
  local deployments arn
  if ! deployments="$(aws ecs list-service-deployments --cluster "${CLUSTER_NAME}" --service "${SERVICE_NAME}" --region "${REGION}" --max-results 100 --output json 2>/dev/null)"; then
    echo "MISSING"
    return 0
  fi
  if ! arn="$(printf '%s' "${deployments}" | jq -r '.serviceDeployments | sort_by(.createdAt) | last | .serviceDeploymentArn // empty')" || [ -z "${arn}" ]; then
    echo "MISSING"
    return 0
  fi
  printf '%s\n' "${arn}"
}

# Poll the revision for up to ~3 minutes: a fresh deployment can lag the deploy
# summary by a few seconds, and a stale read would assert the PREVIOUS phase.
assert_revision_connectors() { # usage: assert_revision_connectors <phase> <expected compact JSON>
  local phase="$1" expected="$2" actual=""
  for _ in $(seq 1 18); do
    actual="$(revision_gateway_connectors)"
    [ "${actual}" = "${expected}" ] && break
    sleep 10
  done
  if [ "${actual}" != "${expected}" ]; then
    echo "FAIL: ${phase}: service revision gatewayConnectors is '${actual}', expected '${expected}'" >&2
    exit 1
  fi
  echo "    OK: ${phase}: service revision gatewayConnectors == ${expected}"
}

assert_sdk_routed() { # usage: assert_sdk_routed <phase>
  local state routing
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)" || { echo "FAIL: $1: cannot read ${STATE_KEY}" >&2; exit 1; }
  routing="$(printf '%s' "${state}" | jq -r '[.resources[] | select(.resourceType == "AWS::ECS::Service") | (.provisionedBy // "sdk")] | first // "missing"')"
  if [ "${routing}" != "sdk" ]; then
    echo "FAIL: $1: ECS Service provisionedBy=${routing}, expected sdk — before #5634 GatewayConnectors was SDK-unwired, which sent the whole Service through Cloud Control, which would pass this test for the wrong reason" >&2
    exit 1
  fi
  echo "    OK: $1: ECS Service is SDK-routed"
}

# Ownership-gated teardown sweep, for a gateway (an ALB, billed) or cluster
# that Cloud Control created but state never recorded (a run that died
# mid-create, or a create that succeeded after cdkd stopped waiting):
# `state destroy` cannot see those. It touches a fixed-name resource ONLY when
# it carries this run's `${RUN_TAG_KEY}` tag, and never before this run's
# first deploy. Order: the cluster's services (waited to INACTIVE, or
# delete-cluster refuses with ClusterContainsServices), the gateway's cluster
# association, the gateway (deletion protection off first; delete retried
# while the association is still DISASSOCIATING), then the cluster. A
# subshell, so the best-effort `set +eu` never leaks into a strict-mode
# caller; anything left is caught by the next run's pre-flight.
owned_by_this_run() { # usage: owned_by_this_run <tags JSON array>; reads stdin
  jq -e --arg k "${RUN_TAG_KEY}" --arg v "${RUN_ID}" \
    '[.[]? | select((.key // .Key) == $k and (.value // .Value) == $v)] | length > 0' >/dev/null
}
sweep_owned() { (
  set +eu
  [ "${DEPLOY_STARTED}" = "1" ] || exit 0
  # Scope guard: the listings below key on these names and this nonce, so
  # refuse anything but the fixture's own literals and a non-empty nonce.
  case "${GATEWAY_NAME}|${FIXTURE_CLUSTER_NAME}|${RUN_ID}" in
    "cdkd-ecs-svc-gw-connectors|cdkd-ecs-svc-gw-connectors|"?*) ;;
    *)
      echo "WARN: teardown sweep refused: unexpected names '${GATEWAY_NAME}' / '${FIXTURE_CLUSTER_NAME}' or empty run id" >&2
      exit 0
      ;;
  esac
  local cluster_owned=0 svcs gw gw_tags i
  if aws ecs describe-clusters --clusters "${FIXTURE_CLUSTER_NAME}" --include TAGS --region "${REGION}" --output json 2>/dev/null \
    | jq '[.clusters[]? | select(.status == "ACTIVE")] | first | .tags // []' | owned_by_this_run; then
    cluster_owned=1
    svcs=$(aws ecs list-services --cluster "${FIXTURE_CLUSTER_NAME}" --region "${REGION}" \
      --query 'serviceArns[]' --output text 2>/dev/null)
    for svc in ${svcs}; do
      echo "    sweep: deleting service ${svc}"
      aws ecs delete-service --cluster "${FIXTURE_CLUSTER_NAME}" --service "${svc}" --force \
        --region "${REGION}" >/dev/null 2>&1
    done
    if [ -n "${svcs}" ] && [ "${svcs}" != "None" ]; then
      # shellcheck disable=SC2086 # one argument per service ARN
      aws ecs wait services-inactive --cluster "${FIXTURE_CLUSTER_NAME}" --services ${svcs} \
        --region "${REGION}" >/dev/null 2>&1
    fi
  fi
  for gw in $(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json 2>/dev/null \
    | jq -r --arg n "${GATEWAY_NAME}" '.gateways[]? | select(.name == $n and .status != "DELETED") | .gatewayArn'); do
    # A failed tag read leaves the gateway alone: ownership is never assumed.
    gw_tags=$(aws ecs list-tags-for-resource --resource-arn "${gw}" --region "${REGION}" --output json 2>/dev/null)
    if printf '%s' "${gw_tags}" | jq '.tags // []' | owned_by_this_run; then
      :
    else
      echo "    sweep: leaving gateway ${gw} alone (no ${RUN_TAG_KEY}=${RUN_ID} tag)"
      continue
    fi
    echo "    sweep: deleting gateway ${gw}"
    aws ecs disassociate-gateway-from-cluster --no-cli-auto-prompt --gateway "${gw}" \
      --cluster "${FIXTURE_CLUSTER_NAME}" --region "${REGION}" >/dev/null 2>&1
    if aws ecs describe-gateway --gateway "${gw}" --region "${REGION}" --output json 2>/dev/null \
      | jq -e '.gateway.deletionProtection == true' >/dev/null; then
      # UpdateGateway requires the role and a configuration; only the members
      # it accepts are carried over unchanged.
      upd=$(mktemp)
      aws ecs describe-gateway --gateway "${gw}" --region "${REGION}" --output json 2>/dev/null \
        | jq '{gateway: .gateway.gatewayArn, infrastructureRoleArn: .gateway.infrastructureRoleArn,
               deletionProtection: false,
               configuration: {hostSharedAlb: (.gateway.configuration.hostSharedAlb
                 | {networkConfiguration: (if .networkConfiguration.inboundSecurityGroup then {inboundSecurityGroup: .networkConfiguration.inboundSecurityGroup} else null end),
                    maxAlbCount, webACLArn, accessLogs, httpDesync, testTrafficRules}
                 | with_entries(select(.value != null)))}}' > "${upd}"
      aws ecs update-gateway --no-cli-auto-prompt --cli-input-json "file://${upd}" --region "${REGION}" >/dev/null 2>&1
      rm -f "${upd}"
      for i in $(seq 1 30); do
        aws ecs describe-gateway --gateway "${gw}" --region "${REGION}" --output json 2>/dev/null \
          | jq -e '.gateway.deletionProtection == false and (.gateway.status | test("IN_PROGRESS") | not)' >/dev/null && break
        sleep 10
      done
    fi
    # Retried each poll: DeleteGateway refuses while the association is still
    # DISASSOCIATING.
    for i in $(seq 1 60); do
      aws ecs delete-gateway --no-cli-auto-prompt --gateway "${gw}" --region "${REGION}" >/dev/null 2>&1
      [ "$(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json 2>/dev/null \
        | jq -r --arg a "${gw}" '[.gateways[]? | select(.gatewayArn == $a and .status != "DELETED")] | length')" = "0" ] && break
      sleep 10
    done
  done
  if [ "${cluster_owned}" = "1" ]; then
    echo "    sweep: deleting cluster ${FIXTURE_CLUSTER_NAME}"
    aws ecs delete-cluster --cluster "${FIXTURE_CLUSTER_NAME}" --region "${REGION}" >/dev/null 2>&1
  fi
) }

cleanup() {
  echo "==> Cleanup: dropping this run's state + AWS resources"
  set +eu
  if [ "${DEPLOY_STARTED}" != "1" ]; then
    # Nothing of this run exists yet; a state record or a same-named resource
    # here is another run's (the pre-flight names it).
    echo "    nothing deployed by this run; leaving state and resources alone"
    set -eu
    return 0
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET:-}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # After EVERY destroy, whatever its rc: a resource Cloud Control created but
  # state never recorded is reachable only by name, and only ours is touched.
  sweep_owned
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

# Pre-flight, FIRST and with no sweep before it: refuse to deploy over a live
# cluster or gateway of these names (a concurrent run's, or a leftover nobody
# swept): ECS would ADOPT the cluster and the gateway create would collide.
# There is no pre-run cleanup: this run owns nothing yet, and a state record
# or resource found now belongs to someone else.
PREFLIGHT_CLUSTER=$(aws ecs describe-clusters --clusters "${FIXTURE_CLUSTER_NAME}" --region "${REGION}" \
  --query 'clusters[0].status' --output text)
if [ "${PREFLIGHT_CLUSTER}" = "ACTIVE" ]; then
  echo "FAIL: pre-flight: ECS cluster ${FIXTURE_CLUSTER_NAME} already exists and is ACTIVE; delete it (and its services) before running this fixture" >&2
  exit 1
fi
PREFLIGHT_GATEWAYS=$(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json \
  | jq -r --arg n "${GATEWAY_NAME}" '[.gateways[]? | select(.name == $n and .status != "DELETED")] | length')
if [ "${PREFLIGHT_GATEWAYS}" != "0" ]; then
  echo "FAIL: pre-flight: ECS gateway ${GATEWAY_NAME} already exists (not DELETED); delete it before running this fixture" >&2
  exit 1
fi

if [ -n "${STATE_BUCKET:-}" ] && ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "FAIL: pre-flight: state ${STATE_KEY} already exists (another run, or a leftover); destroy it before running this fixture" >&2
  exit 1
fi
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
if [ -n "${STATE_BUCKET:-}" ] && ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"; then
  # The lock body's `expiresAt` is epoch milliseconds. A past one is a lock a
  # killed run left behind (it would stop this run's deploy partway); a future
  # one is a live peer holding the stack.
  LOCK_EXPIRES_AT=$(aws s3 cp "s3://${STATE_BUCKET}/${LOCK_KEY}" - --region "${REGION}" | jq -r '.expiresAt // empty')
  NOW_MS=$(( $(date +%s) * 1000 ))
  if [ -n "${LOCK_EXPIRES_AT}" ] && [ "${LOCK_EXPIRES_AT%.*}" -gt "${NOW_MS}" ] 2>/dev/null; then
    echo "FAIL: pre-flight: ${LOCK_KEY} is held by a live peer run (expiresAt ${LOCK_EXPIRES_AT} is in the future); wait for it to finish" >&2
  else
    echo "FAIL: pre-flight: a leftover lock ${LOCK_KEY} (expiresAt '${LOCK_EXPIRES_AT:-unknown}' has passed) would stop the deploy; clear it with: node dist/cli.js force-unlock ${STACK} --stack-region ${REGION} --state-bucket ${STATE_BUCKET}" >&2
  fi
  exit 1
fi

# --- Phase 0: the gateway's infrastructure role, ahead of the gateway ---------
# go-to-k/cdkd#5661: created in the same deploy as the gateway, the role is
# rejected while it propagates. Deploy it (and the gateway's other
# role-independent prerequisites) first, then wait an explicit, documented
# interval before phase 1 creates the gateway. Covered by `state destroy` and
# the ownership sweep exactly like every later phase's resources.
GATEWAY_ROLE_SETTLE_SECONDS=30
echo "==> Phase 0: deploy the gateway's infrastructure role and prerequisites (CDKD_INTEG_PHASE=0)"
DEPLOY_STARTED=1
env -u CDKD_TEST_UPDATE CDKD_INTEG_PHASE=0 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
echo "    waiting ${GATEWAY_ROLE_SETTLE_SECONDS}s for the infrastructure role to propagate (#5661)"
sleep "${GATEWAY_ROLE_SETTLE_SECONDS}"

# --- Phase 1: create ----------------------------------------------------------
echo "==> Phase 1: deploy (CreateService with a full GatewayConnector)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi
CLUSTER_NAME=$(echo "${STATE}" | jq -r '.outputs.ClusterName // empty')
SERVICE_NAME=$(echo "${STATE}" | jq -r '.outputs.ServiceName // empty')
if [ -z "${CLUSTER_NAME}" ] || [ -z "${SERVICE_NAME}" ]; then
  echo "FAIL: ClusterName / ServiceName missing from state outputs" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
echo "    cluster=${CLUSTER_NAME} service=${SERVICE_NAME}"
SERVICE_ARN_1=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" \
  --region "${REGION}" --query 'services[0].serviceArn' --output text)

assert_sdk_routed "phase 1"
assert_revision_connectors "phase 1" \
  '[{"filters":{"accessTypes":["PUBLIC"]},"healthCheck":{"healthCheckPath":"/health","healthyThresholdCount":3},"portName":"web"}]'

# --- Phase 2: update (SET) ----------------------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (CHANGE the connector)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_routed "phase 2"
# Only the filters change: ECS refuses a HealthCheck change under the
# ROLLING deployment strategy, CloudFormation included (A/B on #5634).
assert_revision_connectors "phase 2" \
  '[{"filters":{"accessTypes":["PUBLIC","PRIVATE"]},"healthCheck":{"healthCheckPath":"/health","healthyThresholdCount":3},"portName":"web"}]'
# Captured only AFTER the revision assert: by then the newest listed
# deployment is known to be phase 2's, not a phase-1 one read before the
# phase-2 deployment showed up in the listing.
DEPLOYMENT_AFTER_PHASE_2="$(latest_deployment_arn)"
if [ "${DEPLOYMENT_AFTER_PHASE_2}" = "MISSING" ]; then
  echo "FAIL: phase 2: cannot read the service's latest deployment" >&2
  exit 1
fi

# --- Phase 3: removal -----------------------------------------------------------
echo "==> Phase 3: redeploy with CDKD_TEST_UPDATE=true,remove (DROP GatewayConnectors)"
CDKD_TEST_UPDATE=true,remove node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_routed "phase 3"
# Kept, as CloudFormation keeps it. Before the A/B a reset to `[]` looked
# plausible (VpcLatticeConfigurations clears on removal); it would read `null`.
# A matching revision alone could be a STALE read that predates a lagging new
# deployment, so first require that no deployment started at all, re-checked
# across a full minute.
for _ in $(seq 1 6); do
  DEPLOYMENT_NOW="$(latest_deployment_arn)"
  if [ "${DEPLOYMENT_NOW}" != "${DEPLOYMENT_AFTER_PHASE_2}" ]; then
    echo "FAIL: phase 3: removing GatewayConnectors started a deployment (${DEPLOYMENT_AFTER_PHASE_2} -> ${DEPLOYMENT_NOW}); CloudFormation starts none and keeps the connector" >&2
    exit 1
  fi
  sleep 10
done
echo "    OK: phase 3: no new deployment started"
assert_revision_connectors "phase 3" \
  '[{"filters":{"accessTypes":["PUBLIC","PRIVATE"]},"healthCheck":{"healthCheckPath":"/health","healthyThresholdCount":3},"portName":"web"}]'

# --- Phase 4: declared empty list ------------------------------------------------
echo "==> Phase 4: redeploy with CDKD_TEST_UPDATE=true,remove,clear (DECLARE GatewayConnectors: [])"
CDKD_TEST_UPDATE=true,remove,clear node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_routed "phase 4"
assert_revision_connectors "phase 4" 'null'

# Every phase updated the Service in place: a replacement would mint a new ARN.
SERVICE_ARN_4=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" \
  --region "${REGION}" --query 'services[0].serviceArn' --output text)
if [ "${SERVICE_ARN_1}" != "${SERVICE_ARN_4}" ]; then
  echo "FAIL: Service ARN changed (${SERVICE_ARN_1} -> ${SERVICE_ARN_4}); the updates must be in place" >&2
  exit 1
fi
echo "    OK: the Service was updated in place (same ARN)"

# --- Phase 5: destroy -----------------------------------------------------------
echo "==> Phase 5: destroy"
# Captured before the destroy for the gone-checks below.
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
INFRA_ROLE_NAME=$(printf '%s' "${STATE}" | jq -r '[.resources | to_entries[] | select(.key | startswith("GatewayInfraRole")) | .value.physicalId] | first // empty')
VPC_ID=$(printf '%s' "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first // empty')
if [ -z "${INFRA_ROLE_NAME}" ] || [ -z "${VPC_ID}" ]; then
  echo "FAIL: phase 5: cannot read the infrastructure role / VPC physical id from state" >&2
  exit 1
fi
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

SVC_STATUS=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" \
  --region "${REGION}" --query 'services[0].status' --output text 2>&1 || true)
case "${SVC_STATUS}" in
  INACTIVE|None|*ClusterNotFoundException*) echo "    OK: Service gone (${SVC_STATUS})" ;;
  *)
    echo "FAIL: Service still present after destroy (status=${SVC_STATUS})" >&2
    exit 1
    ;;
esac
CLUSTER_STATUS=$(aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --region "${REGION}" \
  --query 'clusters[0].status' --output text)
case "${CLUSTER_STATUS}" in
  INACTIVE|None) echo "    OK: cluster gone (${CLUSTER_STATUS})" ;;
  *)
    echo "FAIL: cluster still present after destroy (status=${CLUSTER_STATUS})" >&2
    exit 1
    ;;
esac
# ListGateways can return DELETED gateways, so only a non-DELETED one leaks.
GATEWAYS=$(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json \
  | jq -r --arg n "${GATEWAY_NAME}" '[.gateways[]? | select(.name == $n and .status != "DELETED")] | length')
if [ "${GATEWAYS}" != "0" ]; then
  echo "FAIL: gateway ${GATEWAY_NAME} still present (not DELETED) after destroy" >&2
  exit 1
fi
echo "    OK: gateway ${GATEWAY_NAME} gone"
# The cluster association: a not-found on the (now inactive) cluster is gone
# too (gone_probe hard-fails any other probe failure); a successful listing
# must hold no association that is not INACTIVE.
if ! gone_probe aws ecs list-gateway-cluster-associations --cluster "${CLUSTER_NAME}" --region "${REGION}"; then
  ASSOCIATIONS=$(aws ecs list-gateway-cluster-associations --cluster "${CLUSTER_NAME}" --region "${REGION}" --output json \
    | jq -r '[.gatewayClusterAssociations[]? | select((.status // "MISSING") != "INACTIVE")] | length')
  if [ "${ASSOCIATIONS}" != "0" ]; then
    echo "FAIL: a gateway cluster association on ${CLUSTER_NAME} is still not INACTIVE after destroy" >&2
    exit 1
  fi
fi
echo "    OK: gateway cluster association gone"
assert_gone "infrastructure role ${INFRA_ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${INFRA_ROLE_NAME}"
echo "    OK: infrastructure role ${INFRA_ROLE_NAME} gone"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: VPC ${VPC_ID} gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "[verify] PASS — GatewayConnectors reached AWS on the SDK route across create, change, removal (kept) and a declared empty list (cleared), and the stack tore down cleanly"
