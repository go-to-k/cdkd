#!/usr/bin/env bash
# verify.sh — cdkd ECS Service UPDATE-props integ test (issue #975).
#
# Asserts that a change to `EnableECSManagedTags` / `PropagateTags` on an
# SDK-routed `AWS::ECS::Service` reaches AWS after `cdkd deploy` — both were
# silent-drops before the #975 fix (the properties were in the provider's
# handledProperties allow-list, so the resource stayed SDK-routed, cdkd diff
# detected the change, deploy went green, state.json recorded the NEW value,
# but ECSProvider.updateService() never mapped them into UpdateServiceCommand
# so AWS kept the OLD value).
#
# The Service in this fixture is deliberately plain (no
# ServiceConnectConfiguration / VolumeConfigurations) so it stays on cdkd's
# SDK provider path — the sibling `ecs-fargate` fixture's Service routes via
# Cloud Control and would NOT exercise the updateService() code path the
# #975 fix touches.
#
#   Phase 1 (base):   enableECSManagedTags == false, propagateTags == NONE
#   Phase 2 (update): CDKD_TEST_UPDATE=true flips to
#                     enableECSManagedTags == true, propagateTags == TASK_DEFINITION
#                     -> assert BOTH reach AWS via describe-services.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="EcsServiceUpdatePropsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Sweep the container log group (created by the fixture with
  # RemovalPolicy.DESTROY, but a partial run may orphan it) plus any
  # /aws/ecs auto-created group to keep the leftover-resources gate clean.
  aws logs describe-log-groups --region "${REGION}" \
    --log-group-name-prefix "/aws/ecs/cdkd-ecs-svc-update-props" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n' | while read -r lg; do
    [ -n "${lg}" ] && aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
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

# --- Phase 1: deploy (base) -------------------------------------------
echo "==> Phase 1: deploy with the local binary (base: managed-tags off, propagate NONE)"
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

# Confirm the Service is SDK-routed (provisionedBy != 'cc-api'). If it
# somehow routed to Cloud Control the test would pass for the wrong reason
# (CC forwards the full property map), so guard against silent test-rot.
SVC_ROUTING=$(echo "${STATE}" | jq -r '
  [.resources[] | select(.resourceType == "AWS::ECS::Service") | (.provisionedBy // "sdk")] | first // "missing"')
if [ "${SVC_ROUTING}" = "cc-api" ]; then
  echo "FAIL: ECS Service routed via Cloud Control (provisionedBy=cc-api) — this fixture must stay SDK-routed to exercise updateService() (#975). Test would pass for the wrong reason." >&2
  exit 1
fi
echo "    OK: ECS Service is SDK-routed (provisionedBy=${SVC_ROUTING})"

# Base assertion: managed tags off, propagate NONE.
BASE_MANAGED=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].enableECSManagedTags' --output json 2>/dev/null)
BASE_PROPAGATE=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].propagateTags' --output text 2>/dev/null)

if [ "${BASE_MANAGED}" != "false" ]; then
  echo "FAIL: base enableECSManagedTags is '${BASE_MANAGED}', expected 'false'" >&2
  exit 1
fi
# AWS reports the "no propagation" state as either NONE or (older API) an
# absent value surfaced as None by the CLI.
case "${BASE_PROPAGATE}" in
  NONE|None|"") ;;
  *)
    echo "FAIL: base propagateTags is '${BASE_PROPAGATE}', expected NONE/None" >&2
    exit 1
    ;;
esac
echo "    OK: base state on AWS is enableECSManagedTags=false, propagateTags=${BASE_PROPAGATE}"

# --- Phase 2: UPDATE pass (issue #975) --------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (flip EnableECSManagedTags + PropagateTags)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

AFTER_MANAGED=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].enableECSManagedTags' --output json 2>/dev/null)
AFTER_PROPAGATE=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].propagateTags' --output text 2>/dev/null)

if [ "${AFTER_MANAGED}" != "true" ]; then
  echo "FAIL: after update, enableECSManagedTags is '${AFTER_MANAGED}', expected 'true' (#975 EnableECSManagedTags silent-drop NOT closed)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
    --query 'services[0].{enableECSManagedTags:enableECSManagedTags,propagateTags:propagateTags}' | jq .
  exit 1
fi
if [ "${AFTER_PROPAGATE}" != "TASK_DEFINITION" ]; then
  echo "FAIL: after update, propagateTags is '${AFTER_PROPAGATE}', expected 'TASK_DEFINITION' (#975 PropagateTags silent-drop NOT closed)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
    --query 'services[0].{enableECSManagedTags:enableECSManagedTags,propagateTags:propagateTags}' | jq .
  exit 1
fi
echo "    OK: after update, AWS shows enableECSManagedTags=true, propagateTags=TASK_DEFINITION (#975 silent-drop CLOSED)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> ecs-service-update-props test passed (EnableECSManagedTags + PropagateTags UpdateService mapping (#975) + clean destroy)"
