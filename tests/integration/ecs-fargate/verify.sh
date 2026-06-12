#!/usr/bin/env bash
# verify.sh — cdkd ECS TaskDefinition EnableFaultInjection backfill integ test
# (issue #609).
#
# Asserts that an ECS Fargate TaskDefinition whose template sets
# `EnableFaultInjection: true` has the flag reach AWS after `cdkd deploy`
# — the property was a silent-drop before the #609 backfill. Also
# asserts `Volumes[].ConfiguredAtLaunch` reaches the registered task
# definition and that the paired Service carries the managed EBS volume
# configuration (issue #806), and that the destroy path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="EcsFargateStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
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
  set -eu
}

trap cleanup EXIT

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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion: EnableFaultInjection reached AWS ----------------------
# DescribeTaskDefinition returns taskDefinition.enableFaultInjection only
# when set on the registered revision. Seeing `true` proves the
# silent-drop is closed by the #609 backfill.
TD_ARN=$(echo "${STATE}" | jq -r '.outputs.TaskDefinitionArn // "null"')
if [ "${TD_ARN}" = "null" ] || [ -z "${TD_ARN}" ]; then
  echo "FAIL: state.outputs.TaskDefinitionArn is missing after deploy" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi

ACTUAL=$(aws ecs describe-task-definition \
  --task-definition "${TD_ARN}" --region "${REGION}" \
  --query 'taskDefinition.enableFaultInjection' --output json 2>/dev/null)

if [ "${ACTUAL}" != "true" ]; then
  echo "FAIL: taskDefinition.enableFaultInjection is '${ACTUAL}', expected 'true' (silent-drop NOT closed)" >&2
  aws ecs describe-task-definition --task-definition "${TD_ARN}" --region "${REGION}" --query 'taskDefinition' | jq .
  exit 1
fi
echo "    OK: taskDefinition.enableFaultInjection == true on AWS (silent-drop CLOSED by #609)"

# --- Assertion: Volumes[].ConfiguredAtLaunch reached AWS (issue #806) --
# The fixture's ServiceManagedVolume synthesizes
# `Volumes: [{ Name: 'ebs-data', ConfiguredAtLaunch: true }]` on the task
# definition. Before the #806 fix, convertVolumes silently dropped
# ConfiguredAtLaunch, so the registered revision had no configuredAtLaunch
# volume and the paired Service create failed with "Volume configuration
# provided but no matching configuredAtLaunch volume found in task
# definition". jq note: booleans must be probed via has() — `.X // "null"`
# maps an explicit `false` to "null" (the // operator treats false as
# absent).
TD_VOLUMES=$(aws ecs describe-task-definition \
  --task-definition "${TD_ARN}" --region "${REGION}" \
  --query 'taskDefinition.volumes' --output json 2>/dev/null)

CONFIGURED_AT_LAUNCH=$(echo "${TD_VOLUMES}" | jq -r \
  '[.[]? | select(.name == "ebs-data")
    | if has("configuredAtLaunch") then .configuredAtLaunch | tostring else "null" end]
   | first // "missing"')

if [ "${CONFIGURED_AT_LAUNCH}" != "true" ]; then
  echo "FAIL: task-definition volume 'ebs-data' configuredAtLaunch is '${CONFIGURED_AT_LAUNCH}', expected 'true' (#806 silent-drop NOT closed)" >&2
  echo "${TD_VOLUMES}" | jq .
  exit 1
fi
echo "    OK: taskDefinition.volumes['ebs-data'].configuredAtLaunch == true on AWS (#806 silent-drop CLOSED)"

# --- Assertion: ScalableTarget reached AWS ----------------------------
# The fixture's `service.autoScaleTaskCount({...})` synthesizes an
# `AWS::ApplicationAutoScaling::ScalableTarget` whose `ResourceId` is
# `Fn::Join('', ['service/', cluster.clusterName, '/', service.serviceName])`
# — exercising `Fn::GetAtt(<Service>, 'Name')` end-to-end against cdkd's
# intrinsic resolver. Before this fix, the resolver had no per-type
# fallback for `AWS::ECS::Service.Name` and returned the service ARN
# (sometimes in `<arn>|<clusterName>` composite form), producing a
# malformed ResourceId AWS rejected with
# `Unsupported resource type: cluster`. Seeing a ScalableTarget
# successfully registered for the deployed cluster + service proves the
# resolver returns the short service name.
CLUSTER_NAME=$(echo "${STATE}" | jq -r '.outputs.ClusterName // empty')
SERVICE_NAME=$(echo "${STATE}" | jq -r '.outputs.ServiceName // empty')
if [ -z "${CLUSTER_NAME}" ] || [ -z "${SERVICE_NAME}" ]; then
  echo "FAIL: ClusterName / ServiceName missing from state outputs" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
RESOURCE_ID="service/${CLUSTER_NAME}/${SERVICE_NAME}"
SCALABLE_TARGET_RID=$(aws application-autoscaling describe-scalable-targets \
  --region "${REGION}" --service-namespace ecs \
  --query "ScalableTargets[?ResourceId=='${RESOURCE_ID}'].ResourceId" \
  --output text 2>/dev/null || true)
if [ "${SCALABLE_TARGET_RID}" != "${RESOURCE_ID}" ]; then
  echo "FAIL: no ScalableTarget registered for ResourceId '${RESOURCE_ID}' (Fn::GetAtt(Service, 'Name') round-trip BROKEN)" >&2
  aws application-autoscaling describe-scalable-targets \
    --region "${REGION}" --service-namespace ecs --output json | jq .
  exit 1
fi
echo "    OK: ScalableTarget registered for ${RESOURCE_ID} (Fn::GetAtt(Service, 'Name') round-trip CLOSED)"

# --- Assertion: Service carries the managed EBS volume config (#806) ---
# `service.addVolume(ebsVolume)` synthesizes
# `AWS::ECS::Service.VolumeConfigurations` referencing the
# ConfiguredAtLaunch volume above. DescribeServices surfaces it on the
# deployment (deployments[].volumeConfigurations[].name) — seeing the
# 'ebs-data' entry proves the Service create accepted the pairing that
# issue #806 broke. The Service itself routes via Cloud Control (the
# template sets ServiceConnectConfiguration + VolumeConfigurations, both
# cdkd silent-drops on the SDK Service provider, which flips the resource
# to the CC-API path per the #614 routing rule), but the matching
# configuredAtLaunch volume MUST come from the SDK-registered task
# definition — exactly the cross-resource wiring the fix restores.
SERVICE_VOLUME_NAME=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --output json 2>/dev/null | jq -r \
  '[.services[0].deployments[]?.volumeConfigurations[]? | .name] | first // "missing"')

if [ "${SERVICE_VOLUME_NAME}" != "ebs-data" ]; then
  echo "FAIL: service deployment volumeConfigurations name is '${SERVICE_VOLUME_NAME}', expected 'ebs-data' (#806 Service/TaskDefinition volume pairing BROKEN)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" --output json | jq '.services[0].deployments'
  exit 1
fi
echo "    OK: service deployment carries volumeConfigurations['ebs-data'] (#806 pairing VERIFIED)"

# --- Assertion: Cluster ServiceConnectDefaults reached AWS ------------
# The fixture's `new ecs.Cluster({ defaultCloudMapNamespace: { ... } })`
# synthesizes an `AWS::ECS::Cluster` whose `ServiceConnectDefaults`
# property carries the auto-created `AWS::ServiceDiscovery::PrivateDnsNamespace`'s
# Arn. Seeing the namespace round-trip via DescribeClusters proves the
# silent-drop is closed by the #609 backfill.
CLUSTER_SVC_CONNECT=$(aws ecs describe-clusters \
  --clusters "${CLUSTER_NAME}" --region "${REGION}" \
  --query 'clusters[0].serviceConnectDefaults.namespace' --output text 2>/dev/null)

if [ -z "${CLUSTER_SVC_CONNECT}" ] || [ "${CLUSTER_SVC_CONNECT}" = "None" ]; then
  echo "FAIL: cluster.serviceConnectDefaults.namespace is empty/None, expected the CloudMap namespace ARN (silent-drop NOT closed)" >&2
  aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --region "${REGION}" | jq .
  exit 1
fi
# Sanity: the namespace ARN starts with the AWS ServiceDiscovery prefix.
case "${CLUSTER_SVC_CONNECT}" in
  arn:*:servicediscovery:*:namespace/*) ;;
  *)
    echo "FAIL: cluster.serviceConnectDefaults.namespace '${CLUSTER_SVC_CONNECT}' is not a ServiceDiscovery namespace ARN" >&2
    exit 1
    ;;
esac
echo "    OK: cluster.serviceConnectDefaults.namespace == '${CLUSTER_SVC_CONNECT}' on AWS (silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
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
echo "==> ecs-fargate test passed (EnableFaultInjection backfill + ConfiguredAtLaunch volume pairing (#806) + clean destroy)"
