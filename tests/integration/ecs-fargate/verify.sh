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
# ROUTE FLIP (#609 Service property backfill): this Service sets
# ServiceConnectConfiguration + VolumeConfigurations, which used to be
# silent-drops that flipped it to the #614 Cloud Control fallback route.
# With the backfill the AWS::ECS::Service silent-drop set is EMPTY, so the
# Service is SDK-routed — ECSProvider.createService() now delivers both
# blobs itself. The provisionedBy assertion below pins the SDK route, and
# the deployment-level serviceConnectConfiguration / volumeConfigurations
# read-backs prove the SDK create carried them to AWS.
#
# Phase 0 + Phase 1 (issue #1275) cover the ECS Service wait semantics:
# `--no-wait --full-wait` is rejected as a contradictory pair, and the
# Phase 1 deploy passes `--full-wait` so the real `waitUntilServicesStable`
# call runs against AWS (cdkd's default deliberately does NOT wait, matching
# Terraform's `wait_for_steady_state = false`). The post-deploy assertion
# proves the wait was effective rather than a no-op.
#
# Phase 1c and Phase 3 (issue #4272) run `cdkd drift --json` before and after
# the destroy: the live Cluster / Service / TaskDefinition must be compared,
# and, with the pre-destroy state put back for one read-only run, the deleted
# ones must not be. The Service arm discriminates only when ECS still lists it
# as INACTIVE; the run says which arms it verified.
#
# Phase 1b (issue #807) additionally redeploys with CDKD_TEST_UPDATE=true
# (container command change -> TaskDefinition replacement) and asserts the
# Service's `taskDefinition` tracks the NEW revision ARN — i.e. the
# replacement propagated to the Ref-only dependent and UpdateService ran.
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

STACK="EcsFargateStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  rm -f "${SAVED_STATE:-}" "${DEAD_SVC_ERR:-}"
  # Phase 3 (issue #4272) put a DESTROYED stack's state back for one drift
  # run. Interrupted there, remove it directly: `state destroy` over records
  # of deleted resources may fail, and a failure below keeps the file.
  if [ "${PHASE3_RESTORED:-0}" = "1" ] && [ -n "${STATE_BUCKET:-}" ]; then
    local key
    for key in "${STATE_KEY}" "cdkd/${STACK}/${REGION}/lock.json"; do
      if ! aws s3 rm "s3://${STATE_BUCKET}/${key}" >/dev/null 2>&1; then
        echo "WARN: could not remove s3://${STATE_BUCKET}/${key} restored by Phase 3; delete it by hand" >&2
      fi
    done
    PHASE3_RESTORED=0
    return 0
  fi
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
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

# --- Phase 0: --no-wait / --full-wait are mutually exclusive (issue #1275) ---
# The two flags are opposite ends of one axis, so the pair is rejected before
# any AWS call. Checked first because it must NOT provision anything.
echo "==> Phase 0: reject --no-wait --full-wait"
# Capture the output rather than silencing it: a bare `if cmd >/dev/null
# 2>&1` would read ANY failure (missing bucket, bad creds, synth error) as
# "correctly rejected" and pass for the wrong reason.
REJECT_OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --no-wait --full-wait --yes 2>&1)" && REJECT_RC=0 || REJECT_RC=$?
if [ "${REJECT_RC}" -eq 0 ]; then
  echo "FAIL: deploy accepted --no-wait --full-wait; the pair must be rejected" >&2
  exit 1
fi
if ! printf '%s' "${REJECT_OUT}" | grep -q -- '--no-wait and --full-wait cannot be combined'; then
  echo "FAIL: deploy failed for the wrong reason (expected the mutual-exclusion error):" >&2
  printf '%s\n' "${REJECT_OUT}" >&2
  exit 1
fi
echo "    OK: --no-wait --full-wait rejected with the mutual-exclusion error"

# --- Phase 1: deploy --------------------------------------------------
# `--full-wait` (issue #1275) is what makes cdkd wait for the ECS Service to
# reach steady state. Passing it here is the only place the real
# waitUntilServicesStable call is exercised against AWS: a wrong cluster /
# service identifier would leave the waiter polling a MISSING service until
# it fails, so a green deploy here proves the identifiers are right too.
echo "==> Phase 1: deploy with the local binary (--full-wait)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --full-wait \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion: the Service is SDK-routed (#609 route flip) ---------------
# Before the #609 Service-property backfill this Service routed via Cloud
# Control (ServiceConnectConfiguration + VolumeConfigurations were
# silent-drops -> #614 CC fallback). With the backfill it must be SDK-routed,
# so this fixture actually exercises ECSProvider.createService() delivering
# those blobs. `provisionedBy` absent means the SDK legacy default.
SVC_ROUTING=$(echo "${STATE}" | jq -r '
  [.resources[] | select(.resourceType == "AWS::ECS::Service") | (.provisionedBy // "sdk")] | first // "missing"')
if [ "${SVC_ROUTING}" != "sdk" ]; then
  echo "FAIL: ECS Service provisionedBy is '${SVC_ROUTING}', expected 'sdk' — the #609 backfill should have flipped the Service off the Cloud Control route (a silent-drop property is back, or the routing regressed)" >&2
  echo "${STATE}" | jq '[.resources[] | select(.resourceType == "AWS::ECS::Service") | {physicalId, provisionedBy}]'
  exit 1
fi
echo "    OK: ECS Service is SDK-routed (provisionedBy=sdk) — #609 route flip verified"

# --- Assertion: --full-wait actually settled the Service (issue #1275) ---
# cdkd's DEFAULT returns once CreateService is accepted (matching Terraform's
# `wait_for_steady_state = false`), so this assertion is only meaningful
# because Phase 1 passed --full-wait. A COMPLETED rollout with a single
# deployment right after deploy returns is what "cdkd waited" looks like.
WAIT_CLUSTER=$(echo "${STATE}" | jq -r '.outputs.ClusterName // empty')
WAIT_SERVICE=$(echo "${STATE}" | jq -r '.outputs.ServiceName // empty')
if [ -z "${WAIT_CLUSTER}" ] || [ -z "${WAIT_SERVICE}" ]; then
  echo "FAIL: state.outputs.ClusterName / ServiceName missing after deploy" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi

SVC_JSON=$(aws ecs describe-services \
  --cluster "${WAIT_CLUSTER}" --services "${WAIT_SERVICE}" --region "${REGION}" \
  --output json)
ROLLOUT=$(echo "${SVC_JSON}" | jq -r '.services[0].deployments | length as $n
  | if $n == 1 then (.[0].rolloutState // "NONE") else "deployments=\($n)" end')
RUNNING=$(echo "${SVC_JSON}" | jq -r '.services[0].runningCount')
DESIRED=$(echo "${SVC_JSON}" | jq -r '.services[0].desiredCount')

if [ "${ROLLOUT}" != "COMPLETED" ]; then
  echo "FAIL: service rollout is '${ROLLOUT}' immediately after a --full-wait deploy, expected COMPLETED (#1275 wait NOT effective)" >&2
  echo "${SVC_JSON}" | jq '.services[0] | {status, runningCount, desiredCount, deployments}'
  exit 1
fi
if [ "${RUNNING}" != "${DESIRED}" ]; then
  echo "FAIL: runningCount ${RUNNING} != desiredCount ${DESIRED} immediately after a --full-wait deploy (#1275 wait NOT effective)" >&2
  exit 1
fi
echo "    OK: --full-wait left the service at a COMPLETED rollout (running=${RUNNING}/desired=${DESIRED})"

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

# --- Assertion: PortMappings[].ContainerPortRange reached AWS (issue #1472) ---
# The fixture injects a second port mapping `{ ContainerPortRange:
# '8080-8090', Protocol: 'tcp' }` via addPropertyOverride. Before the
# #1472 fix, convertPortMappings never wrote the SDK's containerPortRange
# member, so the range was silently dropped from the registered revision.
PORT_RANGE=$(aws ecs describe-task-definition \
  --task-definition "${TD_ARN}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions[0].portMappings[?containerPortRange!=`null`] | [0].containerPortRange' \
  --output text 2>/dev/null)

if [ "${PORT_RANGE}" != "8080-8090" ]; then
  echo "FAIL: no port mapping with containerPortRange '8080-8090' on the registered task definition (got '${PORT_RANGE}') — #1472 silent-drop NOT closed" >&2
  aws ecs describe-task-definition --task-definition "${TD_ARN}" --region "${REGION}" --query 'taskDefinition.containerDefinitions[0].portMappings' | jq .
  exit 1
fi
echo "    OK: taskDefinition port mapping containerPortRange == '8080-8090' on AWS (#1472 silent-drop CLOSED)"

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

# --- Assertion: Volumes[].EFSVolumeConfiguration reached AWS (issue #815) ---
# The fixture's `taskDefinition.addVolume({ name: 'efs-data',
# efsVolumeConfiguration: {...} })` synthesizes
# `Volumes: [{ Name: 'efs-data', EFSVolumeConfiguration: {
#   FilesystemId, RootDirectory, TransitEncryption,
#   AuthorizationConfig: { AccessPointId, IAM } } }]` (PascalCase). Before
# #815, convertVolumes cast EFSVolumeConfiguration through raw, so its
# nested keys reached the SDK still PascalCase. RegisterTaskDefinition then
# either rejected the unknown keys or dropped them, so the registered
# revision had no (or a malformed) efsVolumeConfiguration. Seeing the
# camelCase fields on AWS proves convertVolumes runs the EFS sub-block
# through the PascalCase->camelCase converter. jq note: probe nested keys
# via `// "missing"` (these are strings, never booleans, so the
# false-becomes-null trap does not apply here).
EFS_VOL=$(echo "${TD_VOLUMES}" | jq -c \
  '[.[]? | select(.name == "efs-data")] | first // "missing"')

if [ "${EFS_VOL}" = "missing" ] || [ "${EFS_VOL}" = "null" ]; then
  echo "FAIL: task-definition volume 'efs-data' not present on AWS (#815 EFS volume silent-drop NOT closed)" >&2
  echo "${TD_VOLUMES}" | jq .
  exit 1
fi

EFS_FS_ID=$(echo "${EFS_VOL}" | jq -r '.efsVolumeConfiguration.fileSystemId // "missing"')
EFS_TRANSIT=$(echo "${EFS_VOL}" | jq -r '.efsVolumeConfiguration.transitEncryption // "missing"')
EFS_AP_ID=$(echo "${EFS_VOL}" | jq -r '.efsVolumeConfiguration.authorizationConfig.accessPointId // "missing"')
EFS_IAM=$(echo "${EFS_VOL}" | jq -r '.efsVolumeConfiguration.authorizationConfig.iam // "missing"')

if [ "${EFS_TRANSIT}" != "ENABLED" ]; then
  echo "FAIL: efs-data efsVolumeConfiguration.transitEncryption is '${EFS_TRANSIT}', expected 'ENABLED' (#815 PascalCase->camelCase conversion BROKEN)" >&2
  echo "${EFS_VOL}" | jq .
  exit 1
fi
if [ "${EFS_IAM}" != "ENABLED" ]; then
  echo "FAIL: efs-data efsVolumeConfiguration.authorizationConfig.iam is '${EFS_IAM}', expected 'ENABLED' (#815 AuthorizationConfig.IAM->iam conversion BROKEN)" >&2
  echo "${EFS_VOL}" | jq .
  exit 1
fi
if [ "${EFS_FS_ID}" = "missing" ] || [ -z "${EFS_FS_ID}" ]; then
  echo "FAIL: efs-data efsVolumeConfiguration.fileSystemId missing on AWS (#815 FilesystemId->fileSystemId conversion BROKEN)" >&2
  echo "${EFS_VOL}" | jq .
  exit 1
fi
if [ "${EFS_AP_ID}" = "missing" ] || [ -z "${EFS_AP_ID}" ]; then
  echo "FAIL: efs-data efsVolumeConfiguration.authorizationConfig.accessPointId missing on AWS (#815 AccessPointId->accessPointId conversion BROKEN)" >&2
  echo "${EFS_VOL}" | jq .
  exit 1
fi
echo "    OK: taskDefinition.volumes['efs-data'].efsVolumeConfiguration reached AWS with camelCase fields (#815 PascalCase->camelCase CLOSED)"

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
  --output text)
if [ "${SCALABLE_TARGET_RID}" != "${RESOURCE_ID}" ]; then
  echo "FAIL: no ScalableTarget registered for ResourceId '${RESOURCE_ID}' (Fn::GetAtt(Service, 'Name') round-trip BROKEN)" >&2
  aws application-autoscaling describe-scalable-targets \
    --region "${REGION}" --service-namespace ecs --output json | jq .
  exit 1
fi
echo "    OK: ScalableTarget registered for ${RESOURCE_ID} (Fn::GetAtt(Service, 'Name') round-trip CLOSED)"

# --- Assertion: Service carries the managed EBS volume config (#806/#609) ---
# `service.addVolume(ebsVolume)` synthesizes
# `AWS::ECS::Service.VolumeConfigurations` referencing the
# ConfiguredAtLaunch volume above. DescribeServices surfaces it on the
# deployment (deployments[].volumeConfigurations[].name) — seeing the
# 'ebs-data' entry proves the Service create accepted the pairing that
# issue #806 broke. Since the #609 backfill the Service is SDK-routed
# (asserted above), so this read-back now proves ECSProvider.createService()
# delivered the VolumeConfigurations blob itself — including the
# ManagedEBSVolume -> managedEBSVolume / SizeInGiB -> sizeInGiB spellings —
# and the matching configuredAtLaunch volume comes from the SDK-registered
# task definition, exactly the cross-resource wiring the fixes restore.
SERVICE_VOLUME_NAME=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --output json 2>/dev/null | jq -r \
  '[.services[0].deployments[]?.volumeConfigurations[]? | .name] | first // "missing"')

if [ "${SERVICE_VOLUME_NAME}" != "ebs-data" ]; then
  echo "FAIL: service deployment volumeConfigurations name is '${SERVICE_VOLUME_NAME}', expected 'ebs-data' (#806/#609 Service VolumeConfigurations delivery BROKEN)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" --output json | jq '.services[0].deployments'
  exit 1
fi
echo "    OK: service deployment carries volumeConfigurations['ebs-data'] (#806 pairing + #609 SDK-route delivery VERIFIED)"

# --- Assertion: Service Connect config delivered by the SDK route (#609) ---
# The Service sets serviceConnectConfiguration (Enabled + Services[{PortName:
# 'http'}] + the cluster's Cloud Map namespace). DescribeServices surfaces it
# per-deployment (deployments[].serviceConnectConfiguration) — asserting the
# enabled flag + port name proves ECSProvider.createService() delivered the
# blob with camelCase spellings AWS accepts (the serializer would silently
# drop a mis-flipped member; a missing required `enabled` would fail the
# deploy outright).
SC_ENABLED=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --output json 2>/dev/null | jq -r \
  '[.services[0].deployments[]?.serviceConnectConfiguration | select(. != null)] | first | if . == null then "missing" else (.enabled | tostring) end')
SC_PORT_NAME=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --output json 2>/dev/null | jq -r \
  '[.services[0].deployments[]?.serviceConnectConfiguration.services[]? | .portName] | first // "missing"')

if [ "${SC_ENABLED}" != "true" ]; then
  echo "FAIL: service deployment serviceConnectConfiguration.enabled is '${SC_ENABLED}', expected 'true' (#609 ServiceConnectConfiguration delivery on the SDK route BROKEN)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" --output json | jq '.services[0].deployments'
  exit 1
fi
if [ "${SC_PORT_NAME}" != "http" ]; then
  echo "FAIL: service deployment serviceConnectConfiguration.services[0].portName is '${SC_PORT_NAME}', expected 'http' (#609 nested Services[].PortName -> portName conversion BROKEN)" >&2
  exit 1
fi
echo "    OK: service deployment carries serviceConnectConfiguration (enabled=true, portName=http) (#609 SDK-route delivery VERIFIED)"

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

# --- Phase 1b: UPDATE pass (issue #807 replacement propagation) -------
# CDKD_TEST_UPDATE=true changes the container command, which registers a
# NEW TaskDefinition revision (ContainerDefinitions is immutable ->
# replacement). The Service itself has NO template change — its only
# "change" is the Ref to the replaced TaskDefinition. Before the #807 fix
# the Service diffed as NO_CHANGE, UpdateService was never called, and the
# service kept running the old (deregistered) revision.
echo "==> Phase 1b: redeploy with CDKD_TEST_UPDATE=true (TaskDefinition replacement -> Service propagation)"

SERVICE_TD_BEFORE=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].taskDefinition' --output text)
echo "    service taskDefinition before update: ${SERVICE_TD_BEFORE}"

# `--full-wait` again so the UPDATE-side settleService call (issue #1275)
# is exercised too, not just the create-side one.
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --full-wait \
  --yes

SERVICE_TD_AFTER=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].taskDefinition' --output text)

if [ -z "${SERVICE_TD_AFTER}" ] || [ "${SERVICE_TD_AFTER}" = "None" ]; then
  echo "FAIL: could not read service taskDefinition after update deploy" >&2
  exit 1
fi
if [ "${SERVICE_TD_AFTER}" = "${SERVICE_TD_BEFORE}" ]; then
  echo "FAIL: service taskDefinition is still '${SERVICE_TD_BEFORE}' after the update deploy — the TaskDefinition replacement was NOT propagated to the Service (issue #807 regression: UpdateService never called)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" --query 'services[0].{taskDefinition:taskDefinition,deployments:deployments}' | jq .
  exit 1
fi

# --- Assertion: the UPDATE-side --full-wait actually settled the rollout ---
# SERVICE_TD_AFTER flips the instant UpdateService returns, so the check
# above passes even when the update-side settleService is a silent no-op
# (issue #1291 item 7). Repeating the COMPLETED / runningCount block here is
# what pins the update-side waitUntilServicesStable call: right after a
# --full-wait update deploy returns, the NEW rollout must already be
# COMPLETED with a single deployment.
UPD_SVC_JSON=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --output json)
UPD_ROLLOUT=$(echo "${UPD_SVC_JSON}" | jq -r '.services[0].deployments | length as $n
  | if $n == 1 then (.[0].rolloutState // "NONE") else "deployments=\($n)" end')
UPD_RUNNING=$(echo "${UPD_SVC_JSON}" | jq -r '.services[0].runningCount')
UPD_DESIRED=$(echo "${UPD_SVC_JSON}" | jq -r '.services[0].desiredCount')
if [ "${UPD_ROLLOUT}" != "COMPLETED" ]; then
  echo "FAIL: service rollout is '${UPD_ROLLOUT}' immediately after a --full-wait UPDATE deploy, expected COMPLETED (update-side settleService NOT effective — issue #1291 item 7)" >&2
  echo "${UPD_SVC_JSON}" | jq '.services[0] | {status, runningCount, desiredCount, deployments}'
  exit 1
fi
if [ "${UPD_RUNNING}" != "${UPD_DESIRED}" ]; then
  echo "FAIL: runningCount ${UPD_RUNNING} != desiredCount ${UPD_DESIRED} immediately after a --full-wait UPDATE deploy (update-side settleService NOT effective — issue #1291 item 7)" >&2
  exit 1
fi
echo "    OK: update-side --full-wait left the service at a COMPLETED rollout (running=${UPD_RUNNING}/desired=${UPD_DESIRED})"

# The revision the service now points at must be the NEW one: ACTIVE and
# carrying the updated container command.
NEW_TD_STATUS=$(aws ecs describe-task-definition \
  --task-definition "${SERVICE_TD_AFTER}" --region "${REGION}" \
  --query 'taskDefinition.status' --output text)
NEW_TD_COMMAND=$(aws ecs describe-task-definition \
  --task-definition "${SERVICE_TD_AFTER}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions[0].command' --output json)
if [ "${NEW_TD_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: service points at taskDefinition '${SERVICE_TD_AFTER}' with status '${NEW_TD_STATUS}', expected ACTIVE" >&2
  exit 1
fi
if [ "$(echo "${NEW_TD_COMMAND}" | jq -c .)" != '["echo","hello-updated"]' ]; then
  echo "FAIL: service's taskDefinition command is ${NEW_TD_COMMAND}, expected [\"echo\",\"hello-updated\"] — service is not running the updated revision" >&2
  exit 1
fi
echo "    OK: service taskDefinition tracks the new ACTIVE revision ${SERVICE_TD_AFTER} (replacement propagated — issue #807 CLOSED)"

# --- Phase 1c: drift reads the live ECS resources as present (issue #4272) ---
# The negative control for Phase 3: with every ECS resource ACTIVE, `cdkd
# drift` must COMPARE the Cluster, Service and TaskDefinition (clean or
# drifted), so the "not compared" verdict Phase 3 asserts after the destroy
# comes from the deleted status, not from a read that never works. The state
# captured here is what Phase 3 puts back.
#
# drift_ecs_verdicts prints `<type> <verdict>` for each of the three ECS
# types: `compared` (drifted or clean), `deleted` (AWS reports the resource
# is not there, go-to-k/cdkd#4283), `notSupported` (no read path), `skipped`,
# or `notCompared` (only in the incomplete list, e.g. a read that threw).
# It fails the run on a drift exit code that is not a verdict (0 / 1 / 2),
# or a payload that does not hold exactly one of each type.
drift_ecs_verdicts() {
  local out rc
  out="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json >"${out}"
  rc=$?
  set -e
  case "${rc}" in
    0 | 1 | 2) ;;
    *)
      echo "FAIL: cdkd drift --json exited ${rc}" >&2
      rm -f "${out}"
      exit 1
      ;;
  esac
  # Explicit `|| return`: errexit is not inherited into a command
  # substitution on every bash, so do not lean on it for the verdict.
  node -e '
const fs = require("fs");
const [s] = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const primary = [["compared", [...s.drifted, ...s.clean]], ["deleted", s.deleted], ["notSupported", s.notSupported], ["skipped", s.skipped]];
for (const type of ["AWS::ECS::Cluster", "AWS::ECS::Service", "AWS::ECS::TaskDefinition"]) {
  const found = primary.flatMap(([k, list]) => list.filter((o) => o.type === type).map(() => k));
  // An incomplete DRIFTED entry also sits in notCompared, so that list only
  // decides the verdict for a resource no primary list holds.
  const incomplete = s.notCompared.filter((o) => o.type === type).length;
  if (found.length > 1 || (found.length === 0 && incomplete !== 1)) {
    throw new Error(`expected one ${type} in the drift payload, found ${JSON.stringify(found)} + ${incomplete} incomplete: ${JSON.stringify(s)}`);
  }
  console.log(`${type} ${found[0] ?? "notCompared"}`);
}' "${out}" || { rm -f "${out}"; return 1; }
  rm -f "${out}"
  # The drift exit code rides the verdicts as its own line, so a caller can
  # pin it (go-to-k/cdkd#4283: a deleted resource exits 1).
  echo "drift_rc ${rc}"
}

echo "==> Phase 1c: drift compares the live ECS Cluster / Service / TaskDefinition (issue #4272 control)"
LIVE_VERDICTS="$(drift_ecs_verdicts)"
echo "${LIVE_VERDICTS}" | sed 's/^/    /'
if [ "$(echo "${LIVE_VERDICTS}" | grep -c ' compared$')" != "3" ]; then
  echo "FAIL: drift did not compare all three live ECS resources; Phase 3's not-compared verdict would prove nothing" >&2
  exit 1
fi
echo "    OK: all three live ECS resources were compared"

SAVED_STATE="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${SAVED_STATE}" >/dev/null

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Phase 3: drift reads the DELETED ECS resources as gone (issue #4272) ---
# ECS keeps describing a deleted cluster (and service) as INACTIVE for a while,
# and a deregistered task definition revision as INACTIVE indefinitely. Before
# #4272, readCurrentState returned their properties, so drift COMPARED a
# deleted resource. Put the pre-destroy state back for one read-only drift run,
# then remove it again before asserting anything, so a failing assertion
# cannot leave a state file naming deleted resources behind; PHASE3_RESTORED
# makes the EXIT / INT / TERM cleanup remove it directly if the run is cut
# short inside that window.
echo "==> Phase 3: drift over the destroyed stack's saved state (issue #4272)"
# Probe the ids the saved state RECORDS, which are what drift reads.
DEAD_CLUSTER_ID=$(jq -r '[.resources[] | select(.resourceType == "AWS::ECS::Cluster") | .physicalId] | if length == 1 then .[0] else "" end' "${SAVED_STATE}")
DEAD_TD_ID=$(jq -r '[.resources[] | select(.resourceType == "AWS::ECS::TaskDefinition") | .physicalId] | if length == 1 then .[0] else "" end' "${SAVED_STATE}")
if [ -z "${DEAD_CLUSTER_ID}" ] || [ -z "${DEAD_TD_ID}" ]; then
  echo "FAIL: the saved state does not record exactly one ECS Cluster and one TaskDefinition" >&2
  exit 1
fi
DEAD_CLUSTER_STATUS=$(aws ecs describe-clusters --clusters "${DEAD_CLUSTER_ID}" --region "${REGION}" \
  --query 'clusters[0].status' --output text)
DEAD_TD_STATUS=$(aws ecs describe-task-definition --task-definition "${DEAD_TD_ID}" --region "${REGION}" \
  --query 'taskDefinition.status' --output text)
# A lookup that FAILS aborts here with AWS's own error (no `|| fallback`:
# the gone-probe fence forbids swallowing a capture's failure).
# Premise guard: if ECS already stopped listing the cluster, it reads as gone
# with or without the fix, and the cluster arm would pass vacuously.
if [ "${DEAD_CLUSTER_STATUS}" != "INACTIVE" ] || [ "${DEAD_TD_STATUS}" != "INACTIVE" ]; then
  echo "FAIL: premise not met: after destroy ECS reports cluster '${DEAD_CLUSTER_STATUS}' and task definition '${DEAD_TD_STATUS}', expected both INACTIVE" >&2
  exit 1
fi
echo "    premise: ECS still lists the deleted cluster and task definition as INACTIVE"

# The Service arm discriminates only when DescribeServices still answers
# INACTIVE for it. Under a deleted cluster it may instead list nothing or
# refuse with a not-found error, and then the Service reads as absent with or
# without the fix: assert it is not compared, but do not claim it verified.
DEAD_SVC_ID=$(jq -r '[.resources[] | select(.resourceType == "AWS::ECS::Service") | .physicalId] | if length == 1 then .[0] else "" end' "${SAVED_STATE}")
if [ -z "${DEAD_SVC_ID}" ]; then
  echo "FAIL: the saved state does not record exactly one ECS Service" >&2
  exit 1
fi
DEAD_SVC_ERR="$(mktemp)"
if DEAD_SVC_OUT=$(aws ecs describe-services --cluster "${DEAD_CLUSTER_ID}" --services "${DEAD_SVC_ID}" \
  --region "${REGION}" --output json 2>"${DEAD_SVC_ERR}"); then
  DEAD_SVC_STATUS=$(printf '%s' "${DEAD_SVC_OUT}" | jq -r '.services[0].status // "not-listed"')
elif DEAD_SVC_OUT="$(cat "${DEAD_SVC_ERR}")" && printf '%s' "${DEAD_SVC_OUT}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  DEAD_SVC_STATUS="not-listed"
else
  echo "FAIL: describe-services for the deleted service did not answer: ${DEAD_SVC_OUT}" >&2
  exit 1
fi
rm -f "${DEAD_SVC_ERR}"
echo "    service: ECS reports '${DEAD_SVC_STATUS}' for the deleted service"

# Conditional write: a state file that appeared since the destroy (another run
# of this fixture) fails the put instead of being overwritten. The flag is set
# only AFTER the put lands, so that failure leaves the other file alone.
aws s3api put-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --body "${SAVED_STATE}" \
  --if-none-match '*' >/dev/null
PHASE3_RESTORED=1
set +e
DEAD_VERDICTS="$(drift_ecs_verdicts)"
DEAD_RC=$?
set -e
aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
PHASE3_RESTORED=0
rm -f "${SAVED_STATE}"
assert_gone "restored state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after Phase 3" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
if [ "${DEAD_RC}" != "0" ]; then
  echo "FAIL: drift over the destroyed stack's state did not produce a verdict" >&2
  exit 1
fi
echo "${DEAD_VERDICTS}" | sed 's/^/    /'
# All three must read as DELETED (go-to-k/cdkd#4283; before it, `notSupported`);
# only the ones ECS still lists as INACTIVE are named as verified below.
if ! echo "${DEAD_VERDICTS}" | grep -qx "drift_rc 1"; then
  echo "FAIL: drift over the deleted ECS resources did not exit 1: $(echo "${DEAD_VERDICTS}" | grep '^drift_rc ')" >&2
  exit 1
fi
for type in AWS::ECS::Cluster AWS::ECS::Service AWS::ECS::TaskDefinition; do
  if ! echo "${DEAD_VERDICTS}" | grep -qx "${type} deleted"; then
    echo "FAIL: drift read the deleted ${type} as present (issue #4272): $(echo "${DEAD_VERDICTS}" | grep "^${type} ")" >&2
    exit 1
  fi
done
if [ "${DEAD_SVC_STATUS}" = "INACTIVE" ]; then
  PHASE3_VERIFIED="Cluster / Service / TaskDefinition"
else
  PHASE3_VERIFIED="Cluster / TaskDefinition"
  echo "    note: ECS no longer lists the deleted service as INACTIVE, so its arm reads absent either way; the Service rule is unit-covered only on this run"
fi
echo "    OK: drift reports the deleted ECS ${PHASE3_VERIFIED} that ECS still lists as INACTIVE as deleted"

echo ""
echo "==> ecs-fargate test passed (EnableFaultInjection backfill + ConfiguredAtLaunch volume pairing (#806) + SDK-routed ServiceConnectConfiguration/VolumeConfigurations delivery (#609 route flip) + #807 replacement propagation + #4272/#4283 drift reports the deleted ECS ${PHASE3_VERIFIED} as deleted + clean destroy)"
