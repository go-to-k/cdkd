#!/usr/bin/env bash
# verify.sh — cdkd ECS Service UPDATE-props integ test (issues #975 + #1160 + #1165).
#
# Exercises three silent-drop classes on an SDK-routed `AWS::ECS::Service`
# create/update path:
#
#   #975  (add-on-update):  a CHANGE to EnableECSManagedTags / PropagateTags
#         must reach AWS. Before the #975 fix ECSProvider.updateService() never
#         mapped them into UpdateServiceCommand, so cdkd diff detected the
#         change, deploy went green, state recorded the NEW value, but AWS kept
#         the OLD one.
#   #1160 (reset-on-removal): a field DROPPED from the template must reset to
#         its CloudFormation default. UpdateService uses merge semantics (an
#         absent input field means "no change"), so before the #1160 fix a
#         removed PlatformVersion / HealthCheckGracePeriodSeconds silently kept
#         its old live value.
#   #1165 (nested-object casing): a CFn PascalCase nested object
#         (DeploymentConfiguration) must be converted to the SDK's camelCase
#         input shape. Before the #1165 fix ECSProvider passed the block raw,
#         so the SDK read absent keys and silently dropped the whole value on
#         create AND update -> AWS applied the defaults.
#   #1167 (readCurrentState reverse-map): the READ side must map those nested
#         objects back from SDK camelCase to CFn PascalCase so `cdkd drift`
#         does not phantom-drift when the baseline falls back to the template
#         `properties` (PascalCase). Phase 1b asserts the deploy-time
#         observedProperties baseline (captured FROM readCurrentState) carries
#         the nested RuntimePlatform in CFn PascalCase.
#
# The Service in this fixture is deliberately plain (no
# ServiceConnectConfiguration / VolumeConfigurations) so it stays on cdkd's
# SDK provider path — the sibling `ecs-fargate` fixture's Service routes via
# Cloud Control and would NOT exercise the updateService() code path these
# fixes touch.
#
#   Phase 1 (base):   enableECSManagedTags == false, propagateTags == NONE;
#                     PlatformVersion == 1.4.0, grace == 30.
#   Phase 2 (update): CDKD_TEST_UPDATE=true flips enableECSManagedTags == true,
#                     propagateTags == TASK_DEFINITION (#975) AND drops
#                     PlatformVersion / grace -> assert the #975 changes reach
#                     AWS AND the #1160 removals reset to LATEST / 0.
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

# Base assertion for the #1160 removable fields: PlatformVersion / grace period
# were SET by the phase-1 template (via L1 override).
BASE_PLATFORM=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].platformVersion' --output text 2>/dev/null)
BASE_GRACE=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].healthCheckGracePeriodSeconds' --output json 2>/dev/null)

if [ "${BASE_PLATFORM}" != "1.4.0" ]; then
  echo "FAIL: base platformVersion is '${BASE_PLATFORM}', expected '1.4.0'" >&2
  exit 1
fi
if [ "${BASE_GRACE}" != "30" ]; then
  echo "FAIL: base healthCheckGracePeriodSeconds is '${BASE_GRACE}', expected '30'" >&2
  exit 1
fi
echo "    OK: base #1160 fields on AWS are platformVersion=1.4.0, grace=30"

# Base assertion for issue #1165 (nested-object casing): the custom
# DeploymentConfiguration set by phase 1 (MaximumPercent 150 /
# MinimumHealthyPercent 50 / DeploymentCircuitBreaker Enable) must have reached
# AWS. Before the fix the raw PascalCase block was dropped and AWS applied the
# defaults (200 / 100 / circuit-breaker off).
BASE_MAXPCT=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].deploymentConfiguration.maximumPercent' --output text 2>/dev/null)
BASE_MINPCT=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text 2>/dev/null)
BASE_CB_ENABLE=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].deploymentConfiguration.deploymentCircuitBreaker.enable' --output json 2>/dev/null)

if [ "${BASE_MAXPCT}" != "150" ]; then
  echo "FAIL: base deploymentConfiguration.maximumPercent is '${BASE_MAXPCT}', expected '150' (#1165 DeploymentConfiguration casing silent-drop NOT closed)" >&2
  aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
    --query 'services[0].deploymentConfiguration' | jq .
  exit 1
fi
if [ "${BASE_MINPCT}" != "50" ]; then
  echo "FAIL: base deploymentConfiguration.minimumHealthyPercent is '${BASE_MINPCT}', expected '50' (#1165 casing silent-drop NOT closed)" >&2
  exit 1
fi
if [ "${BASE_CB_ENABLE}" != "true" ]; then
  echo "FAIL: base deploymentConfiguration.deploymentCircuitBreaker.enable is '${BASE_CB_ENABLE}', expected 'true' (#1165 nested casing silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: base #1165 DeploymentConfiguration on AWS is maximumPercent=150, minimumHealthyPercent=50, circuitBreaker.enable=true"

# Base assertion for issue #1165 on the TaskDefinition: RuntimePlatform
# (ARM64 / Graviton) and EphemeralStorage (SizeInGiB) are nested CFn PascalCase
# objects that were passed raw into RegisterTaskDefinition's camelCase slots and
# silently dropped before the fix (task would register as the default X86_64 /
# default ephemeral storage). Read them back via describe-task-definition.
TASKDEF_ARN=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].taskDefinition' --output text 2>/dev/null)
if [ -z "${TASKDEF_ARN}" ] || [ "${TASKDEF_ARN}" = "None" ]; then
  echo "FAIL: could not resolve task definition ARN from the service" >&2
  exit 1
fi
BASE_CPU_ARCH=$(aws ecs describe-task-definition \
  --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
  --query 'taskDefinition.runtimePlatform.cpuArchitecture' --output text 2>/dev/null)
BASE_EPHEMERAL=$(aws ecs describe-task-definition \
  --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
  --query 'taskDefinition.ephemeralStorage.sizeInGiB' --output text 2>/dev/null)

if [ "${BASE_CPU_ARCH}" != "ARM64" ]; then
  echo "FAIL: task definition runtimePlatform.cpuArchitecture is '${BASE_CPU_ARCH}', expected 'ARM64' (#1165 RuntimePlatform casing silent-drop NOT closed)" >&2
  aws ecs describe-task-definition --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
    --query 'taskDefinition.{runtimePlatform:runtimePlatform,ephemeralStorage:ephemeralStorage}' | jq .
  exit 1
fi
if [ "${BASE_EPHEMERAL}" != "30" ]; then
  echo "FAIL: task definition ephemeralStorage.sizeInGiB is '${BASE_EPHEMERAL}', expected '30' (#1165 EphemeralStorage casing silent-drop NOT closed)" >&2
  exit 1
fi
# Container-level nested object: LinuxParameters.InitProcessEnabled (dropped raw
# before the #1165 fix -> the container would register without initProcessEnabled).
BASE_INIT_PROCESS=$(aws ecs describe-task-definition \
  --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions[0].linuxParameters.initProcessEnabled' --output json 2>/dev/null)
if [ "${BASE_INIT_PROCESS}" != "true" ]; then
  echo "FAIL: container linuxParameters.initProcessEnabled is '${BASE_INIT_PROCESS}', expected 'true' (#1165 LinuxParameters casing silent-drop NOT closed)" >&2
  aws ecs describe-task-definition --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
    --query 'taskDefinition.containerDefinitions[0].linuxParameters' | jq .
  exit 1
fi
echo "    OK: base #1165 TaskDefinition on AWS is runtimePlatform.cpuArchitecture=ARM64, ephemeralStorage.sizeInGiB=30, linuxParameters.initProcessEnabled=true"

# --- Phase 1b: observedProperties captured in CFn PascalCase (issue #1167) --
# `observedProperties` (the drift baseline) is captured FROM readCurrentState at
# deploy time. #1167 makes readCurrentState reverse-map the nested objects from
# SDK camelCase back to CFn PascalCase, so the captured RuntimePlatform must use
# the PascalCase key `RuntimePlatform.CpuArchitecture`. Before #1167 the read
# side emitted camelCase (`runtimePlatform.cpuArchitecture`), so the PascalCase
# lookup below would be MISSING — a robust, whole-stack-drift-free check that
# readCurrentState round-trips the nested casing against real AWS.
#
# (A whole-stack `cdkd drift` assertion is deliberately NOT used: this fixture's
# TaskDefinition also carries ContainerDefinitions, which readCurrentState still
# surfaces as raw SDK camelCase — a larger structural gap out of #1167 scope —
# and the ECS Service reads back drift-unknown because its physicalId is the ARN
# rather than the composite `<clusterArn>|<serviceName>` form readCurrentState
# expects; both would make a whole-stack drift assertion fail for reasons
# unrelated to #1167.)
echo "==> Phase 1b: assert deploy-time observedProperties captured RuntimePlatform in CFn PascalCase (#1167 readCurrentState reverse-map)"
OBS_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
OBS_CPU_ARCH=$(echo "${OBS_STATE}" | jq -r '[.resources[] | select(.resourceType=="AWS::ECS::TaskDefinition") | .observedProperties.RuntimePlatform.CpuArchitecture] | first // "MISSING"')
OBS_EPHEMERAL=$(echo "${OBS_STATE}" | jq -r '[.resources[] | select(.resourceType=="AWS::ECS::TaskDefinition") | .observedProperties.EphemeralStorage.SizeInGiB] | first // "MISSING"')

if [ "${OBS_CPU_ARCH}" != "ARM64" ]; then
  echo "FAIL: TaskDefinition observedProperties.RuntimePlatform.CpuArchitecture is '${OBS_CPU_ARCH}', expected 'ARM64' (#1167 readCurrentState did NOT reverse-map RuntimePlatform to CFn PascalCase)" >&2
  echo "${OBS_STATE}" | jq '[.resources[] | select(.resourceType=="AWS::ECS::TaskDefinition") | .observedProperties.RuntimePlatform] | first'
  exit 1
fi
# EphemeralStorage was already PascalCase before #1167 (the one already-correct
# field); asserting it guards against a regression in the reverse-map pass.
if [ "${OBS_EPHEMERAL}" != "30" ]; then
  echo "FAIL: TaskDefinition observedProperties.EphemeralStorage.SizeInGiB is '${OBS_EPHEMERAL}', expected '30'" >&2
  exit 1
fi
echo "    OK: deploy-time observedProperties captured RuntimePlatform.CpuArchitecture=ARM64 + EphemeralStorage.SizeInGiB=30 in CFn PascalCase (#1167 readCurrentState reverse-map verified against real AWS)"

# --- Phase 2: UPDATE pass (issue #975 add-on-update + #1160 reset-on-removal) --
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (flip EnableECSManagedTags + PropagateTags; DROP PlatformVersion / grace)"
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

# #1160: the removed fields must have reset to their CFn defaults, NOT kept the
# phase-1 values (the merge-semantics silent drop this PR closes).
AFTER_PLATFORM=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].platformVersion' --output text 2>/dev/null)
AFTER_GRACE=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].healthCheckGracePeriodSeconds' --output json 2>/dev/null)

if [ "${AFTER_PLATFORM}" != "LATEST" ]; then
  echo "FAIL: after removal, platformVersion is '${AFTER_PLATFORM}', expected 'LATEST' (#1160 PlatformVersion silent-drop NOT closed)" >&2
  exit 1
fi
if [ "${AFTER_GRACE}" != "0" ]; then
  echo "FAIL: after removal, healthCheckGracePeriodSeconds is '${AFTER_GRACE}', expected '0' (#1160 HealthCheckGracePeriodSeconds silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: after removal, AWS reset platformVersion=LATEST, grace=0 (#1160 silent-drop CLOSED)"

# #1165 update SET path: phase 2 CHANGED the DeploymentConfiguration to a new
# custom shape (MaximumPercent 175 / MinimumHealthyPercent 25 /
# DeploymentCircuitBreaker Rollback off). Assert the changed nested values
# reached AWS through updateService() (they would be dropped if the block were
# still passed raw).
AFTER_MAXPCT=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].deploymentConfiguration.maximumPercent' --output text 2>/dev/null)
AFTER_MINPCT=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].deploymentConfiguration.minimumHealthyPercent' --output text 2>/dev/null)
AFTER_CB_ROLLBACK=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${REGION}" \
  --query 'services[0].deploymentConfiguration.deploymentCircuitBreaker.rollback' --output json 2>/dev/null)

if [ "${AFTER_MAXPCT}" != "175" ]; then
  echo "FAIL: after update, deploymentConfiguration.maximumPercent is '${AFTER_MAXPCT}', expected '175' (#1165 update-path casing silent-drop NOT closed)" >&2
  exit 1
fi
if [ "${AFTER_MINPCT}" != "25" ]; then
  echo "FAIL: after update, deploymentConfiguration.minimumHealthyPercent is '${AFTER_MINPCT}', expected '25' (#1165 update-path casing silent-drop NOT closed)" >&2
  exit 1
fi
if [ "${AFTER_CB_ROLLBACK}" != "false" ]; then
  echo "FAIL: after update, deploymentConfiguration.deploymentCircuitBreaker.rollback is '${AFTER_CB_ROLLBACK}', expected 'false' (#1165 update-path nested casing silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: after update, AWS shows DeploymentConfiguration maximumPercent=175, minimumHealthyPercent=25, circuitBreaker.rollback=false (#1165 update-path silent-drop CLOSED)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> ecs-service-update-props test passed (EnableECSManagedTags + PropagateTags UpdateService mapping (#975); PlatformVersion + HealthCheckGracePeriodSeconds reset-on-removal (#1160); DeploymentConfiguration nested-object PascalCase->camelCase on create + update (#1165); clean destroy)"
