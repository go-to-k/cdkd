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
#   #1170 (Service readCurrentState accepts the ARN physicalId): the Service
#         physicalId `createService` stores is the service ARN, but
#         readCurrentStateService only understood the composite
#         `<clusterArn>|<serviceName>` form and returned undefined for the ARN,
#         so every cdkd-created Service read back as drift-unknown and NO
#         observedProperties were captured for it. Phase 1c asserts the
#         Service's deploy-time observedProperties ARE captured (proving the
#         ARN-form read works) AND carry DeploymentConfiguration in CFn
#         PascalCase.
#   #1169 (ContainerDefinitions reverse-map): readCurrentStateTaskDefinition
#         surfaced the whole ContainerDefinitions array as raw SDK camelCase,
#         while the drift baseline is CFn PascalCase, so `cdkd drift`
#         phantom-drifted the TaskDefinition on ContainerDefinitions (the drift
#         comparator compares arrays wholesale via deepEqual). Phase 1d asserts
#         the deploy-time observedProperties.ContainerDefinitions is PascalCase
#         (free-form log-driver option keys preserved, AWS-defaulted empties
#         normalized), and Phase 1e runs a real `cdkd drift` asserting NO
#         ContainerDefinitions drift.
#   #1173 (ContainerDefinition sub-field silent-drop): convertContainerDefinitions
#         never mapped RestartPolicy (+ RepositoryCredentials / FirelensConfiguration
#         / ResourceRequirements / SystemControls / ...), so they were silently
#         dropped on RegisterTaskDefinition. Phase 1f sets RestartPolicy via the
#         L1 escape hatch and asserts it (a) reached AWS and (b) round-tripped
#         into observedProperties in CFn PascalCase.
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
# (Phase 1c proves the Service side reads back (#1170); Phase 1d + 1e prove the
# TaskDefinition ContainerDefinitions reverse-map (#1169). Phase 1e runs a real
# `cdkd drift` and asserts it reports NO ContainerDefinitions drift — before
# #1169 readCurrentState surfaced ContainerDefinitions as raw SDK camelCase,
# which the drift comparator (wholesale array deepEqual) phantom-drifted against
# the PascalCase baseline.)
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

# --- Phase 1c: Service observedProperties captured via ARN-form physicalId ----
# #1170: `createService` stores the service ARN as the physicalId, but
# `readCurrentStateService` only understood the composite
# `<clusterArn>|<serviceName>` form and returned undefined for the ARN. That
# made `cdkd drift` report every cdkd-created Service as drift-unknown AND meant
# NO observedProperties were captured for the Service at deploy time. After the
# fix the ARN-form read works, so the Service's observedProperties are present.
# We assert a nested field (DeploymentConfiguration.MaximumPercent = 150, set in
# phase 1) so the check also confirms the #1167 nested reverse-map ran on the
# Service read path. Before #1170 the whole `observedProperties` object would be
# absent for the Service, so this lookup would be MISSING.
echo "==> Phase 1c: assert Service observedProperties captured via ARN-form physicalId (#1170)"
OBS_SVC_MAXPCT=$(echo "${OBS_STATE}" | jq -r '[.resources[] | select(.resourceType=="AWS::ECS::Service") | .observedProperties.DeploymentConfiguration.MaximumPercent] | first // "MISSING"')
if [ "${OBS_SVC_MAXPCT}" != "150" ]; then
  echo "FAIL: Service observedProperties.DeploymentConfiguration.MaximumPercent is '${OBS_SVC_MAXPCT}', expected '150' (#1170 readCurrentStateService did NOT read back the ARN-form physicalId, so no observedProperties were captured for the Service)" >&2
  echo "${OBS_STATE}" | jq '[.resources[] | select(.resourceType=="AWS::ECS::Service") | {physicalId, hasObserved: (.observedProperties != null)}] | first'
  exit 1
fi
echo "    OK: Service observedProperties captured (DeploymentConfiguration.MaximumPercent=150) — ARN-form readCurrentState verified against real AWS (#1170)"

# --- Phase 1d: TaskDefinition observedProperties.ContainerDefinitions PascalCase (#1169) --
# #1169: readCurrentStateTaskDefinition surfaced the whole ContainerDefinitions
# array as RAW SDK camelCase (`result['ContainerDefinitions'] =
# td.containerDefinitions`), while the drift baseline is CFn PascalCase. Since
# observedProperties is captured FROM readCurrentState, the deploy-time snapshot
# must now carry PascalCase container keys (`Name` / `Image` /
# `LogConfiguration.LogDriver` / `LinuxParameters.InitProcessEnabled`). Before
# the fix these PascalCase lookups would be MISSING (the keys were camelCase).
echo "==> Phase 1d: assert deploy-time observedProperties.ContainerDefinitions in CFn PascalCase (#1169 reverse-map)"
CD_JQ='[.resources[] | select(.resourceType=="AWS::ECS::TaskDefinition") | .observedProperties.ContainerDefinitions[0]] | first'
OBS_CD_NAME=$(echo "${OBS_STATE}" | jq -r "${CD_JQ}.Name // \"MISSING\"")
OBS_CD_LOGDRIVER=$(echo "${OBS_STATE}" | jq -r "${CD_JQ}.LogConfiguration.LogDriver // \"MISSING\"")
OBS_CD_INITPROC=$(echo "${OBS_STATE}" | jq -r "${CD_JQ}.LinuxParameters.InitProcessEnabled // \"MISSING\"")
# The free-form awslogs option keys must be preserved verbatim (NOT case-flipped).
OBS_CD_AWSLOGS_GROUP=$(echo "${OBS_STATE}" | jq -r "${CD_JQ}.LogConfiguration.Options.\"awslogs-group\" // \"MISSING\"")
# camelCase leak guard: the lowercase `name` key must NOT be present.
OBS_CD_CAMEL_NAME=$(echo "${OBS_STATE}" | jq -r "${CD_JQ} | has(\"name\")")

if [ "${OBS_CD_NAME}" != "AppContainer" ]; then
  echo "FAIL: TaskDefinition observedProperties.ContainerDefinitions[0].Name is '${OBS_CD_NAME}', expected 'AppContainer' (#1169 readCurrentState did NOT reverse-map ContainerDefinitions to CFn PascalCase)" >&2
  echo "${OBS_STATE}" | jq "${CD_JQ}"
  exit 1
fi
if [ "${OBS_CD_LOGDRIVER}" != "awslogs" ]; then
  echo "FAIL: TaskDefinition observedProperties.ContainerDefinitions[0].LogConfiguration.LogDriver is '${OBS_CD_LOGDRIVER}', expected 'awslogs' (#1169 reverse-map)" >&2
  exit 1
fi
if [ "${OBS_CD_INITPROC}" != "true" ]; then
  echo "FAIL: TaskDefinition observedProperties.ContainerDefinitions[0].LinuxParameters.InitProcessEnabled is '${OBS_CD_INITPROC}', expected 'true' (#1169 reverse-map of nested LinuxParameters)" >&2
  exit 1
fi
if [ "${OBS_CD_AWSLOGS_GROUP}" = "MISSING" ]; then
  echo "FAIL: TaskDefinition observedProperties.ContainerDefinitions[0].LogConfiguration.Options.awslogs-group is MISSING (#1169 must preserve free-form log-driver option keys verbatim)" >&2
  echo "${OBS_STATE}" | jq "${CD_JQ}.LogConfiguration"
  exit 1
fi
if [ "${OBS_CD_CAMEL_NAME}" = "true" ]; then
  echo "FAIL: TaskDefinition observedProperties.ContainerDefinitions[0] carries a camelCase 'name' key (#1169 reverse-map leaked SDK camelCase)" >&2
  exit 1
fi
echo "    OK: observedProperties.ContainerDefinitions[0] captured in CFn PascalCase (Name/LogDriver/InitProcessEnabled), free-form awslogs option keys preserved, no camelCase leak (#1169)"

# --- Phase 1e: `cdkd drift` reports NO ContainerDefinitions drift (#1169) --
# End-to-end proof against real AWS: with the reverse-map + AWS-defaulted-empty
# normalization, a `cdkd drift` right after deploy must not phantom-drift the
# TaskDefinition on ContainerDefinitions. drift is state-driven (no synth) and
# exits 1 if ANY resource drifts, so we capture the exit code and grep the
# report for the specific symptom rather than gating on the whole-stack result
# (unrelated CC-API drift on other resources must not fail this check).
echo "==> Phase 1e: assert 'cdkd drift' reports NO ContainerDefinitions drift on the TaskDefinition (#1169)"
set +e
DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" 2>&1)
DRIFT_RC=$?
set -e
# rc 0 = no drift, 1 = drift detected; rc 2 = command error (must not pass vacuously).
if [ "${DRIFT_RC}" != "0" ] && [ "${DRIFT_RC}" != "1" ]; then
  echo "FAIL: 'cdkd drift' exited ${DRIFT_RC} (command error, not a drift result) — cannot conclude anything about ContainerDefinitions" >&2
  echo "${DRIFT_OUT}" | tail -20
  exit 1
fi
if echo "${DRIFT_OUT}" | grep -q "ContainerDefinitions"; then
  echo "FAIL: 'cdkd drift' reported ContainerDefinitions drift on the TaskDefinition (#1169 reverse-map did NOT round-trip against real AWS)" >&2
  echo "${DRIFT_OUT}" | grep -B2 -A8 "ContainerDefinitions" | head -40
  exit 1
fi
echo "    OK: 'cdkd drift' (rc=${DRIFT_RC}) reports NO ContainerDefinitions drift — reverse-map + normalization round-trip verified against real AWS (#1169)"

# --- Phase 1f: RestartPolicy container sub-field write + read round-trip (#1173) --
# #1173: convertContainerDefinitions never mapped RestartPolicy (and 11 other
# container sub-fields), so they were silently dropped on RegisterTaskDefinition.
# The fixture sets RestartPolicy via the L1 escape hatch. Assert (a) AWS actually
# registered it (describe-task-definition) — before the fix it would be absent —
# AND (b) the deploy-time observedProperties captured it back in CFn PascalCase
# (the #1173 read-side reverse-map).
echo "==> Phase 1f: assert RestartPolicy reached AWS + round-tripped into observedProperties (#1173)"
AWS_RESTART_ENABLED=$(aws ecs describe-task-definition \
  --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions[0].restartPolicy.enabled' --output text 2>/dev/null)
if [ "${AWS_RESTART_ENABLED}" != "True" ]; then
  echo "FAIL: task definition containerDefinitions[0].restartPolicy.enabled is '${AWS_RESTART_ENABLED}', expected 'True' (#1173 RestartPolicy silently dropped on RegisterTaskDefinition)" >&2
  aws ecs describe-task-definition --task-definition "${TASKDEF_ARN}" --region "${REGION}" \
    --query 'taskDefinition.containerDefinitions[0].restartPolicy' | jq .
  exit 1
fi
OBS_CD_RESTART=$(echo "${OBS_STATE}" | jq -r '[.resources[] | select(.resourceType=="AWS::ECS::TaskDefinition") | .observedProperties.ContainerDefinitions[0].RestartPolicy.Enabled] | first // "MISSING"')
if [ "${OBS_CD_RESTART}" != "true" ]; then
  echo "FAIL: TaskDefinition observedProperties.ContainerDefinitions[0].RestartPolicy.Enabled is '${OBS_CD_RESTART}', expected 'true' (#1173 read-side reverse-map did NOT surface RestartPolicy in CFn PascalCase)" >&2
  echo "${OBS_STATE}" | jq '[.resources[] | select(.resourceType=="AWS::ECS::TaskDefinition") | .observedProperties.ContainerDefinitions[0]] | first'
  exit 1
fi
echo "    OK: RestartPolicy registered on AWS (enabled=True) AND captured in observedProperties as CFn PascalCase RestartPolicy.Enabled=true (#1173 write + read round-trip verified against real AWS)"

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
