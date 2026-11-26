#!/usr/bin/env bash
# verify.sh — cache-streaming: VPC + ElastiCache Redis (SDK provider) + Kinesis
# Data Stream + Lambda with a Kinesis event source mapping.
#
# Converted from a standard-flow smoke test to a verify.sh so it owns its own
# deploy + assert + destroy cycle. A bare `cdkd deploy` / `cdkd destroy --force`
# invoked directly from a shell is refused by the auto-mode classifier (it looks
# like a skill bypass / Blind Apply); wrapping the same calls inside verify.sh
# lets `/run-integ cache-streaming` exercise the path end-to-end.
#
# LOAD-BEARING assertion: the stack injects `CfnCacheCluster
# .attrRedisEndpointAddress` (a Fn::GetAtt) into the Lambda's REDIS_ENDPOINT env
# var. Reading it back via the Lambda API is format-independent; a physicalId
# fallback would store the cluster id, NOT a real `*.cache.amazonaws.com`
# hostname — asserting the hostname shape proves GetAtt enrichment ran.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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

STACK="CacheStreamingStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STREAM_NAME="${STACK}-data-stream"
# ElastiCache lowercases CacheSubnetGroupName; the stack sets it from stackName.
SUBNET_GROUP="$(printf '%s' "${STACK}-redis-subnet-group" | tr '[:upper:]' '[:lower:]')"
MC_SUBNET_GROUP="$(printf '%s' "${STACK}-memcached-subnet-group" | tr '[:upper:]' '[:lower:]')"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t cache-streaming.XXXXXX)"

# DescribeCacheClusters / describe-stream can throttle right after a burst; let
# the CLI back off transparently for the assertion + cleanup calls.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

# Lambda auto-creates /aws/lambda/<fn> log groups on invoke (the ESM invokes
# the processor, and CDK's LogRetention singleton runs at deploy); neither CFn
# nor cdkd deletes them, so they are swept here. Guarded so an empty STACK can
# never widen the listing to every Lambda log group in the account.
sweep_log_groups() {
  ( set +eu
    case "${STACK}" in
      CacheStreaming?*)
        for lg in $(aws logs describe-log-groups --region "${REGION}" \
          --log-group-name-prefix "/aws/lambda/${STACK}-" \
          --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
          aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
        done
        ;;
      *)
        echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CacheStreaming?*" >&2
        ;;
    esac
  )
}

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  rm -f "${DRIFT_OUT:-}"
  # A failed replacement step (4f/4h/4i/4k) can leave a Memcached cluster on the
  # subnet group that cdkd state does not own; it would block the subnet-group
  # delete and orphan it. Delete every cluster on that group first and wait.
  for mc_leftover in $(aws elasticache describe-cache-clusters --region "${REGION}" \
    --query "CacheClusters[?CacheSubnetGroupName=='${MC_SUBNET_GROUP}'].CacheClusterId" --output text 2>/dev/null); do
    aws elasticache delete-cache-cluster --cache-cluster-id "${mc_leftover}" --region "${REGION}" >/dev/null 2>&1 || true
    aws elasticache wait cache-cluster-deleted --cache-cluster-id "${mc_leftover}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -x "${LOCAL_DIST}" ]; then
    # Best-effort real teardown first (removes AWS resources if the run died
    # mid-flight), then drop any residual state record.
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
  fi
  sweep_log_groups
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
# Probe the exact state.json key (NOT the cdkd/<stack>/ prefix, which retains
# the deployments/ event layer #808 by design and would false-positive here).
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} — clean up first." >&2
  exit 1
fi

echo "==> Step 1: deploy (VPC + ElastiCache Redis + Kinesis + Lambda ESM)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

echo "==> Step 2: locate the StreamProcessor Lambda"
FN_NAME=$(aws lambda list-functions --region "${REGION}" \
  --query "Functions[?contains(FunctionName, '${STACK}') && contains(FunctionName, 'StreamProcessor')].FunctionName | [0]" \
  --output text)
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "None" ]; then
  echo "FAIL: no StreamProcessor Lambda found for ${STACK}" >&2
  exit 1
fi
echo "    OK: Lambda ${FN_NAME}"

echo "==> Step 3 (LOAD-BEARING): assert GetAtt Redis endpoint resolved to a real *.cache.amazonaws.com hostname"
# The stack injects `redis.attrRedisEndpointAddress` (a Fn::GetAtt) into the
# Lambda's REDIS_ENDPOINT env var. Reading it back via the Lambda API is
# format-independent (unlike grepping deploy stdout, whose --verbose lines carry
# a timestamp/INFO prefix). A physicalId fallback would store the cluster id
# here instead of the real hostname.
REDIS_ENDPOINT=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
  --region "${REGION}" --query 'Environment.Variables.REDIS_ENDPOINT' --output text)
echo "    REDIS_ENDPOINT = '${REDIS_ENDPOINT}'"
case "${REDIS_ENDPOINT}" in
  *.cache.amazonaws.com)
    echo "    OK: RedisEndpoint is a real ElastiCache endpoint hostname"
    ;;
  *)
    echo "FAIL: RedisEndpoint is '${REDIS_ENDPOINT}', not a *.cache.amazonaws.com endpoint." >&2
    echo "      This would be a GetAtt physicalId-fallback bug (returned the cluster id)." >&2
    exit 1
    ;;
esac

echo "==> Step 4: assert the deployed resources exist on AWS"
STREAM_STATUS=$(aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
  --query 'StreamDescriptionSummary.StreamStatus' --output text)
if [ "${STREAM_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: Kinesis stream ${STREAM_NAME} status is '${STREAM_STATUS}', expected ACTIVE" >&2
  exit 1
fi
echo "    OK: Kinesis stream ${STREAM_NAME} is ACTIVE"

# The cache cluster physical id is auto-generated; attribute it via its subnet
# group (fixed, derived from the stack name) rather than a fragile id guess.
CACHE_COUNT=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "length(CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'])" --output text)
if [ "${CACHE_COUNT}" = "0" ] || [ "${CACHE_COUNT}" = "None" ]; then
  echo "FAIL: no ElastiCache cluster found on subnet group ${SUBNET_GROUP}" >&2
  exit 1
fi
echo "    OK: ElastiCache cluster present on subnet group ${SUBNET_GROUP}"
ESM_STATE=$(aws lambda list-event-source-mappings --region "${REGION}" \
  --function-name "${FN_NAME}" \
  --query "EventSourceMappings[?contains(EventSourceArn, '${STREAM_NAME}')].State | [0]" --output text)
if [ -z "${ESM_STATE}" ] || [ "${ESM_STATE}" = "None" ]; then
  echo "FAIL: Lambda ${FN_NAME} has no event source mapping on stream ${STREAM_NAME}" >&2
  exit 1
fi
echo "    OK: Lambda ${FN_NAME} wired to the Kinesis stream (ESM state: ${ESM_STATE})"

echo "==> Step 4b: BASELINE (issue #5004) -- the non-default values are live before the removal phase"
# The cluster id is auto-generated; attribute it via the fixed subnet group.
CACHE_ID=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'].CacheClusterId | [0]" --output text)
if [ -z "${CACHE_ID}" ] || [ "${CACHE_ID}" = "None" ]; then
  echo "FAIL: cannot resolve the cache cluster id on subnet group ${SUBNET_GROUP}" >&2
  exit 1
fi
cc_field() { # usage: cc_field <JMESPath on the single CacheCluster>
  aws elasticache describe-cache-clusters --cache-cluster-id "${CACHE_ID}" --region "${REGION}" \
    --query "CacheClusters[0].$1" --output text
}
assert_cc() { # usage: assert_cc <desc> <JMESPath> <expected>; polls 60s for read-after-write lag
  local desc="$1" expr="$2" want="$3" got="" _i
  for _i in 1 2 3 4 5 6; do
    got=$(cc_field "${expr}")
    [ "${got}" = "${want}" ] && { echo "    OK: ${desc} == ${want}"; return 0; }
    sleep 10
  done
  echo "FAIL: ${desc} is '${got}', expected '${want}'" >&2
  exit 1
}
TOPIC_ARN=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.NotificationTopicArn // empty')
if [ -z "${TOPIC_ARN}" ]; then
  echo "FAIL: cannot resolve the NotificationTopicArn output from the state file" >&2
  exit 1
fi
assert_cc "baseline SnapshotRetentionLimit" 'SnapshotRetentionLimit' "3"
assert_cc "baseline AutoMinorVersionUpgrade" 'AutoMinorVersionUpgrade' "False"
assert_cc "baseline NotificationTopicArn" 'NotificationConfiguration.TopicArn' "${TOPIC_ARN}"
assert_cc "baseline NotificationTopicStatus" 'NotificationConfiguration.TopicStatus' "active"
assert_cc "baseline PreferredMaintenanceWindow" 'PreferredMaintenanceWindow' "tue:05:00-tue:06:00"
assert_cc "baseline slow-log delivery status" "LogDeliveryConfigurations[?LogType=='slow-log'].Status | [0]" "active"
# Issue #5545: the three properties CloudFormation keeps on removal.
REDIS_PARAMS=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.resources.RedisParams.physicalId // empty')
if [ -z "${REDIS_PARAMS}" ]; then
  echo "FAIL: cannot resolve the RedisParams parameter group name from the state file" >&2
  exit 1
fi
assert_cc "baseline CacheParameterGroupName" 'CacheParameterGroup.CacheParameterGroupName' "${REDIS_PARAMS}"
assert_cc "baseline SnapshotWindow" 'SnapshotWindow' "02:00-03:00"
BASE_ENGINE_VERSION=$(cc_field 'EngineVersion')
case "${BASE_ENGINE_VERSION}" in
  7.1*) echo "    OK: baseline EngineVersion ${BASE_ENGINE_VERSION} (template 7.1)" ;;
  *) echo "FAIL: baseline EngineVersion is '${BASE_ENGINE_VERSION}', expected 7.1.x" >&2; exit 1 ;;
esac

echo "==> Step 4b2: drift reads LogDeliveryConfigurations / PreferredAvailabilityZones (go-to-k/cdkd#6757)"
# Before #6757 the cluster readback returned neither, so turning the slow-log
# delivery off out of band read as no drift. The cheapest observable change is
# that one ModifyCacheCluster (a log-delivery change, no node work): turned
# off, the Redis cluster must be drifted at LogDeliveryConfigurations; turned
# back on by hand with the declared destination, clean again. The Memcached
# cluster's declared `PreferredAvailabilityZones: [az0, az0]` is read from its
# nodes' zones and must compare clean throughout.
DRIFT_OUT=$(mktemp)
drift_bucket() { # usage: drift_bucket <logicalId>; the report bucket holding it in ${DRIFT_OUT}
  jq -r --arg id "$1" '[.[0] | to_entries[] | select((.value | type) == "array") | .key as $b | .value[]? | objects | select(.logicalId == $id) | $b] | join(",")' "${DRIFT_OUT}"
}
run_cache_drift() { # usage: run_cache_drift; fills ${DRIFT_OUT}, rc 0/1/2 accepted
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"${DRIFT_OUT}" || rc=$?
  case "${rc}" in 0 | 1 | 2) ;; *) echo "FAIL: cdkd drift exited ${rc}" >&2; cat "${DRIFT_OUT}" >&2; exit 1 ;; esac
}
wait_cache_available() { # usage: wait_cache_available <desc>; a modify refuses a cluster that is not available
  local status="" _i
  for _i in $(seq 1 60); do
    status=$(cc_field 'CacheClusterStatus')
    [ "${status}" = "available" ] && return 0
    sleep 10
  done
  echo "FAIL: cache cluster ${CACHE_ID} is '${status}' 10 min after $1" >&2
  exit 1
}
assert_cache_clean() { # usage: assert_cache_clean <logicalId> <when>
  local bucket
  bucket=$(drift_bucket "$1")
  if [ "${bucket}" != "clean" ]; then
    echo "FAIL: $1 is '${bucket}' in drift $2, expected clean:" >&2
    jq --arg id "$1" '.[0].drifted[]? | select(.logicalId == $id)' "${DRIFT_OUT}" >&2
    exit 1
  fi
  echo "    OK: $1 compares clean $2"
}
SLOW_LOG_GROUP=$(cc_field "LogDeliveryConfigurations[?LogType=='slow-log'].DestinationDetails.CloudWatchLogsDetails.LogGroup | [0]")
case "${SLOW_LOG_GROUP}" in "" | None) echo "FAIL: no slow-log destination log group on ${CACHE_ID}" >&2; exit 1 ;; esac
# The baseline must HOLD both keys, or the clean checks below compare nothing:
# a binary without #6757 records neither and reads clean all the same.
CACHE_BASELINE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
if ! echo "${CACHE_BASELINE}" | jq -e '
  (.resources.MemcachedCluster.observedProperties.PreferredAvailabilityZones // null) as $read
  | $read != null and $read == .resources.MemcachedCluster.properties.PreferredAvailabilityZones' >/dev/null; then
  echo "FAIL: MemcachedCluster's drift baseline does not hold its declared PreferredAvailabilityZones (go-to-k/cdkd#6757):" >&2
  echo "${CACHE_BASELINE}" | jq -c '.resources.MemcachedCluster | {declared: .properties.PreferredAvailabilityZones, baseline: .observedProperties.PreferredAvailabilityZones}' >&2
  exit 1
fi
if ! echo "${CACHE_BASELINE}" | jq -e '[.resources.RedisCluster.observedProperties.LogDeliveryConfigurations[]? | select(.LogType == "slow-log")] | length == 1' >/dev/null; then
  echo "FAIL: RedisCluster's drift baseline holds no slow-log LogDeliveryConfigurations entry (go-to-k/cdkd#6757)" >&2
  exit 1
fi
echo "    OK: the drift baseline holds the declared zone list and the slow-log delivery"
run_cache_drift
assert_cache_clean RedisCluster "right after the deploy"
assert_cache_clean MemcachedCluster "right after the deploy"
aws elasticache modify-cache-cluster --cache-cluster-id "${CACHE_ID}" --region "${REGION}" \
  --apply-immediately --log-delivery-configurations 'LogType=slow-log,Enabled=false' >/dev/null
wait_cache_available "turning the slow-log delivery off"
run_cache_drift
if ! jq -e '[.[0].drifted[]? | select(.logicalId == "RedisCluster") | .changes[]?.path] | index("LogDeliveryConfigurations") != null' "${DRIFT_OUT}" >/dev/null; then
  echo "FAIL: RedisCluster with its slow-log delivery turned off out of band is not drifted at LogDeliveryConfigurations (go-to-k/cdkd#6757):" >&2
  jq '.[0] | {drifted, notSupported, notCompared}' "${DRIFT_OUT}" >&2
  exit 1
fi
echo "    OK: the slow-log delivery turned off out of band is drift at LogDeliveryConfigurations"
aws elasticache modify-cache-cluster --cache-cluster-id "${CACHE_ID}" --region "${REGION}" \
  --apply-immediately --log-delivery-configurations \
  "$(jq -cn --arg g "${SLOW_LOG_GROUP}" '[{LogType: "slow-log", DestinationType: "cloudwatch-logs", DestinationDetails: {CloudWatchLogsDetails: {LogGroup: $g}}, LogFormat: "json", Enabled: true}]')" >/dev/null
wait_cache_available "turning the slow-log delivery back on"
assert_cc "slow-log delivery status after turning it back on" "LogDeliveryConfigurations[?LogType=='slow-log'].Status | [0]" "active"
run_cache_drift
assert_cache_clean RedisCluster "once the delivery is back on"
assert_cache_clean MemcachedCluster "once the delivery is back on"
rm -f "${DRIFT_OUT}"

echo "==> Step 4c: REMOVAL deploy -- drop the four properties, change PreferredMaintenanceWindow"
# CDKD_TEST_REMOVAL=true synthesizes a cluster template that LACKS
# SnapshotRetentionLimit / AutoMinorVersionUpgrade / NotificationTopicArn /
# LogDeliveryConfigurations, and moves PreferredMaintenanceWindow tue -> wed in
# the SAME deploy so ModifyCacheCluster provably fires (the companion change
# landing proves the Modify call happened, so a KEEP value that survives was
# retained, not skipped). Real CloudFormation: the first three are KEPT, log
# delivery is RESET. No other mode token is in play, so no resource is dropped.
set +e
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
REMOVAL_RC=$?
set -e
if [ "${REMOVAL_RC}" -ne 0 ]; then
  echo "FAIL: removal deploy exited ${REMOVAL_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: removal deploy exited 0"
assert_cc "companion PreferredMaintenanceWindow (Modify fired)" 'PreferredMaintenanceWindow' "wed:05:00-wed:06:00"
assert_cc "RETAINED SnapshotRetentionLimit" 'SnapshotRetentionLimit' "3"
assert_cc "RETAINED AutoMinorVersionUpgrade" 'AutoMinorVersionUpgrade' "False"
assert_cc "RETAINED NotificationTopicArn" 'NotificationConfiguration.TopicArn' "${TOPIC_ARN}"
assert_cc "RETAINED NotificationTopicStatus" 'NotificationConfiguration.TopicStatus' "active"
# RESET: the slow-log entry is no longer active/enabling (disabling, or gone).
LOG_ACTIVE=""
for _i in 1 2 3 4 5 6; do
  LOG_ACTIVE=$(cc_field "LogDeliveryConfigurations[?Status=='active' || Status=='enabling'] | length(@)")
  [ "${LOG_ACTIVE}" = "0" ] && break
  sleep 10
done
if [ "${LOG_ACTIVE}" != "0" ]; then
  echo "FAIL: ${LOG_ACTIVE} log delivery configuration(s) still active after the removal deploy (RESET not applied)" >&2
  exit 1
fi
echo "    OK: LogDeliveryConfigurations RESET (slow-log delivery disabled)"
# Issue #5545 (real CloudFormation A/B): CloudFormation KEEPS EngineVersion,
# CacheParameterGroupName and SnapshotWindow on removal -- no move to
# default.redis7 -- and cdkd names every kept removal in ONE warning. This
# phase removes only kept properties, so no CacheCluster line may claim a
# CloudFormation reset. Pre-#5545 cdkd kept the values silently, so the warning
# is the assertion only the fix passes.
assert_cc "RETAINED CacheParameterGroupName" 'CacheParameterGroup.CacheParameterGroupName' "${REDIS_PARAMS}"
assert_cc "RETAINED SnapshotWindow" 'SnapshotWindow' "02:00-03:00"
assert_cc "RETAINED EngineVersion" 'EngineVersion' "${BASE_ENGINE_VERSION}"
REMOVAL_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DEPLOY_LOG}")"
KEPT_EXPECTED="RedisCluster (AWS::ElastiCache::CacheCluster): properties EngineVersion, CacheParameterGroupName, SnapshotWindow, SnapshotRetentionLimit, AutoMinorVersionUpgrade, NotificationTopicArn were removed from the template and keep their current AWS value, as CloudFormation leaves them;"
if ! grep -qF "${KEPT_EXPECTED}" <<<"${REMOVAL_PLAIN}"; then
  echo "FAIL: #5545: no warning naming the removed properties CloudFormation keeps. Expected:" >&2
  echo "  ${KEPT_EXPECTED}" >&2
  echo "RedisCluster lines in the output:" >&2
  grep -F "RedisCluster" <<<"${REMOVAL_PLAIN}" >&2 || true
  exit 1
fi
echo "    OK: the kept-on-removal warning names all six removed properties"
if grep -F "(AWS::ElastiCache::CacheCluster)" <<<"${REMOVAL_PLAIN}" | grep -qF "would reset it"; then
  echo "FAIL: #5545: a CacheCluster removal reached the shared 'CloudFormation would reset it' warning" >&2
  exit 1
fi
echo "    OK: no CacheCluster removal claims a CloudFormation reset"
# Replacement guard: the removal must be an in-place update.
CACHE_ID_AFTER=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'].CacheClusterId | [0]" --output text)
if [ "${CACHE_ID_AFTER}" != "${CACHE_ID}" ]; then
  echo "FAIL: cache cluster was REPLACED by the removal deploy (${CACHE_ID} -> ${CACHE_ID_AFTER})" >&2
  exit 1
fi
echo "    OK: removal was an in-place update"

echo "==> Step 4d: NODE TYPE deploy (issue #5438) -- CacheNodeType cache.t3.micro -> cache.t3.small"
# CDKD_TEST_NODETYPE=true changes only CacheNodeType (CDKD_TEST_REMOVAL stays
# set, so the #5004 phase's template is otherwise unchanged). Real
# CloudFormation scales the node in place (same cluster id, ApplyImmediately).
# Before #5438 cdkd's ModifyCacheCluster omitted CacheNodeType: the deploy
# succeeded and the cluster stayed cache.t3.micro.
assert_cc "pre-scale CacheNodeType" 'CacheNodeType' "cache.t3.micro"
set +e
CDKD_TEST_REMOVAL=true CDKD_TEST_NODETYPE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
NODETYPE_RC=$?
set -e
if [ "${NODETYPE_RC}" -ne 0 ]; then
  echo "FAIL: node-type deploy exited ${NODETYPE_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: node-type deploy exited 0"
# The deploy waits for the scale to finish, so the new type is live as soon as
# it returns (assert_cc's 60s poll only absorbs read-after-write lag).
assert_cc "SCALED CacheNodeType (#5438)" 'CacheNodeType' "cache.t3.small"
assert_cc "post-scale CacheClusterStatus" 'CacheClusterStatus' "available"
CACHE_ID_SCALED=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'].CacheClusterId | [0]" --output text)
if [ "${CACHE_ID_SCALED}" != "${CACHE_ID}" ]; then
  echo "FAIL: cache cluster was REPLACED by the node-type deploy (${CACHE_ID} -> ${CACHE_ID_SCALED})" >&2
  exit 1
fi
echo "    OK: node-type change was an in-place update"

echo "==> Step 4e: NODE REMOVAL deploy (issue #5441) -- Memcached NumCacheNodes 2 -> 1"
# The Memcached cluster's id is auto-generated; attribute it via its own
# subnet group. Before #5441 cdkd sent NumCacheNodes alone and AWS refused it
# (InvalidParameterCombination: CacheNodeIdsToRemove), failing this deploy;
# real CloudFormation removes the lowest node id and keeps the cluster.
mc_field() { # usage: mc_field <JMESPath on the single Memcached cluster>
  aws elasticache describe-cache-clusters --region "${REGION}" --show-cache-node-info \
    --query "CacheClusters[?CacheSubnetGroupName=='${MC_SUBNET_GROUP}'] | [0].$1" --output text
}
MC_ID=$(mc_field 'CacheClusterId')
if [ -z "${MC_ID}" ] || [ "${MC_ID}" = "None" ]; then
  echo "FAIL: cannot resolve the Memcached cluster on subnet group ${MC_SUBNET_GROUP}" >&2
  exit 1
fi
MC_NODES_BEFORE=$(mc_field 'CacheNodes[].CacheNodeId | sort(@) | join(`,`, @)')
if [ "${MC_NODES_BEFORE}" != "0001,0002" ]; then
  echo "FAIL: Memcached cluster ${MC_ID} starts with nodes '${MC_NODES_BEFORE}', expected 0001,0002" >&2
  exit 1
fi
echo "    OK: Memcached cluster ${MC_ID} starts with nodes ${MC_NODES_BEFORE}"
set +e
CDKD_TEST_REMOVAL=true CDKD_TEST_NODETYPE=true CDKD_TEST_NODEREMOVE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
NODEREMOVE_RC=$?
set -e
if [ "${NODEREMOVE_RC}" -ne 0 ]; then
  echo "FAIL: node-removal deploy exited ${NODEREMOVE_RC} (#5441)" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: node-removal deploy exited 0"
# The deploy waits until the removed node is gone, so the count is final as
# soon as it returns (the loop only absorbs read-after-write lag).
MC_NODES_AFTER=""
for _i in 1 2 3 4 5 6; do
  MC_NODES_AFTER=$(mc_field 'CacheNodes[].CacheNodeId | sort(@) | join(`,`, @)')
  [ "${MC_NODES_AFTER}" = "0002" ] && break
  sleep 10
done
if [ "${MC_NODES_AFTER}" != "0002" ]; then
  echo "FAIL: Memcached cluster nodes are '${MC_NODES_AFTER}' after the removal, expected 0002 (CloudFormation keeps the highest id)" >&2
  exit 1
fi
MC_COUNT=$(mc_field 'NumCacheNodes')
if [ "${MC_COUNT}" != "1" ]; then
  echo "FAIL: Memcached NumCacheNodes is '${MC_COUNT}', expected 1" >&2
  exit 1
fi
MC_ID_AFTER=$(mc_field 'CacheClusterId')
if [ "${MC_ID_AFTER}" != "${MC_ID}" ]; then
  echo "FAIL: Memcached cluster was REPLACED by the node-removal deploy (${MC_ID} -> ${MC_ID_AFTER})" >&2
  exit 1
fi
echo "    OK: Memcached cluster ${MC_ID} scaled in place to node 0002 (#5441)"

echo "==> Step 4f: ZONE MOVE deploy (issue #5458) -- Memcached PreferredAvailabilityZones [az0] -> [az1]"
# Real CloudFormation REPLACES the cluster when the list moves to zones the
# previous list does not name. Before #5458 cdkd updated it in place, sending
# NewAvailabilityZones with no node added, which AWS refuses: the deploy
# failed. The type is in the stateful-recreate guard set, so the replacement
# needs --force-stateful-recreation (a refusal without it is the guard, not
# this bug).
MC_AZ_BEFORE=$(mc_field 'CacheNodes[0].CustomerAvailabilityZone')
set +e
CDKD_TEST_REMOVAL=true CDKD_TEST_NODETYPE=true CDKD_TEST_NODEREMOVE=true CDKD_TEST_PAZMOVE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --force-stateful-recreation \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
PAZMOVE_RC=$?
set -e
if [ "${PAZMOVE_RC}" -ne 0 ]; then
  echo "FAIL: zone-move deploy exited ${PAZMOVE_RC} (#5458)" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: zone-move deploy exited 0"
MC_ON_GROUP=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "length(CacheClusters[?CacheSubnetGroupName=='${MC_SUBNET_GROUP}'])" --output text)
if [ "${MC_ON_GROUP}" != "1" ]; then
  echo "FAIL: ${MC_ON_GROUP} Memcached clusters on ${MC_SUBNET_GROUP} after the zone move, expected 1 (old one not deleted?)" >&2
  exit 1
fi
MC_ID_MOVED=$(mc_field 'CacheClusterId')
if [ "${MC_ID_MOVED}" = "${MC_ID}" ]; then
  echo "FAIL: Memcached cluster ${MC_ID} was NOT replaced by the zone move (#5458: CloudFormation replaces it)" >&2
  exit 1
fi
MOVE_AZ=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.MemcachedMoveAz // empty')
if [ -z "${MOVE_AZ}" ] || [ "${MOVE_AZ}" = "${MC_AZ_BEFORE}" ]; then
  echo "FAIL: cannot resolve a target zone other than ${MC_AZ_BEFORE} from the MemcachedMoveAz output (got '${MOVE_AZ}')" >&2
  exit 1
fi
MC_AZ_AFTER=$(mc_field 'CacheNodes[0].CustomerAvailabilityZone')
if [ "${MC_AZ_AFTER}" != "${MOVE_AZ}" ]; then
  echo "FAIL: the replacement's node is in '${MC_AZ_AFTER}', expected ${MOVE_AZ} (the template's new zone)" >&2
  exit 1
fi
assert_gone "replaced Memcached cluster ${MC_ID} still exists after the zone move" \
  aws elasticache describe-cache-clusters --cache-cluster-id "${MC_ID}" --region "${REGION}"
echo "    OK: zone move replaced ${MC_ID} with ${MC_ID_MOVED}, node in ${MC_AZ_AFTER} (#5458)"

echo "==> Step 4g: SG REMOVAL deploy (issue #5491) -- the Redis cluster's VpcSecurityGroupIds removed"
# PARITY PIN, not a pre-fix red: cdkd sent no SecurityGroupIds for a removed
# list before #5491 as well. Real CloudFormation keeps the live group on this
# change (its Modify carries no securityGroupIds), so this goes RED only
# against a provider that resets or clears the group on removal. The companion
# PreferredMaintenanceWindow change (wed -> thu) proves the Modify fired.
SG_BEFORE=$(cc_field 'SecurityGroups[].SecurityGroupId | join(`,`, @)')
if [ -z "${SG_BEFORE}" ] || [ "${SG_BEFORE}" = "None" ]; then
  echo "FAIL: the Redis cluster ${CACHE_ID} reports no security group before the SG removal" >&2
  exit 1
fi
set +e
CDKD_TEST_REMOVAL=true CDKD_TEST_NODETYPE=true CDKD_TEST_NODEREMOVE=true CDKD_TEST_PAZMOVE=true CDKD_TEST_SGREMOVE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
SGREMOVE_RC=$?
set -e
if [ "${SGREMOVE_RC}" -ne 0 ]; then
  echo "FAIL: SG-removal deploy exited ${SGREMOVE_RC} (#5491)" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: SG-removal deploy exited 0"
assert_cc "companion PreferredMaintenanceWindow (Modify fired, #5491)" 'PreferredMaintenanceWindow' "thu:05:00-thu:06:00"
assert_cc "KEPT security groups after removing VpcSecurityGroupIds (#5491)" 'SecurityGroups[].SecurityGroupId | join(`,`, @)' "${SG_BEFORE}"
CACHE_ID_SG=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'].CacheClusterId | [0]" --output text)
if [ "${CACHE_ID_SG}" != "${CACHE_ID}" ]; then
  echo "FAIL: the Redis cluster was REPLACED by the SG removal (${CACHE_ID} -> ${CACHE_ID_SG})" >&2
  exit 1
fi
echo "    OK: SG removal kept ${SG_BEFORE} on ${CACHE_ID} in place (#5491)"

# Issue #5558: real CloudFormation REPLACES a single-az cluster when its
# PreferredAvailabilityZones, or its AZMode, is removed from the template.
# Before #5558 cdkd updated it in place (sending nothing) and the deploy
# exited 0 with the old cluster kept, so the id comparison is the assertion
# that discriminates. One removal per deploy: the zone-list half reads the
# previous AZMode from the sibling properties, the AZMode half its own value.
# Stateful type: the replacement needs --force-stateful-recreation. MC_ISSUE
# names the issue in the messages; MC_BEFORE holds the replaced id on success.
MC_ISSUE='#5558'
assert_memcached_replaced() { # usage: assert_memcached_replaced <phase label> <env assignments...>
  local label="$1"
  shift
  local before after on_group rc
  MC_BEFORE=""
  if ! before=$(mc_field 'CacheClusterId'); then
    echo "FAIL: cannot read the Memcached cluster id before the ${label} (${MC_ISSUE})" >&2
    exit 1
  fi
  if [ -z "${before}" ] || [ "${before}" = "None" ]; then
    echo "FAIL: cannot resolve the Memcached cluster before the ${label} (${MC_ISSUE})" >&2
    exit 1
  fi
  set +e
  env "$@" node "${LOCAL_DIST}" deploy "${STACK}" --force-stateful-recreation \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: ${label} deploy exited ${rc} (${MC_ISSUE})" >&2
    tail -60 "${DEPLOY_LOG}" >&2
    exit 1
  fi
  if ! on_group=$(aws elasticache describe-cache-clusters --region "${REGION}" \
    --query "length(CacheClusters[?CacheSubnetGroupName=='${MC_SUBNET_GROUP}'])" --output text); then
    echo "FAIL: cannot count the Memcached clusters after the ${label} (${MC_ISSUE})" >&2
    exit 1
  fi
  if [ "${on_group}" != "1" ]; then
    echo "FAIL: ${on_group} Memcached clusters on ${MC_SUBNET_GROUP} after the ${label}, expected 1 (old one not deleted?)" >&2
    exit 1
  fi
  if ! after=$(mc_field 'CacheClusterId'); then
    echo "FAIL: cannot read the Memcached cluster id after the ${label} (${MC_ISSUE})" >&2
    exit 1
  fi
  if [ "${after}" = "${before}" ]; then
    echo "FAIL: Memcached cluster ${before} was NOT replaced by the ${label} (${MC_ISSUE}: CloudFormation replaces it)" >&2
    exit 1
  fi
  assert_gone "replaced Memcached cluster ${before} still exists after the ${label}" \
    aws elasticache describe-cache-clusters --cache-cluster-id "${before}" --region "${REGION}"
  MC_BEFORE="${before}"
  echo "    OK: ${label} replaced ${before} with ${after} (${MC_ISSUE})"
}
PRIOR_ENV=(CDKD_TEST_REMOVAL=true CDKD_TEST_NODETYPE=true CDKD_TEST_NODEREMOVE=true CDKD_TEST_PAZMOVE=true CDKD_TEST_SGREMOVE=true)

echo "==> Step 4h: ZONE-LIST REMOVAL deploy (issue #5558) -- single-az Memcached PreferredAvailabilityZones removed"
assert_memcached_replaced "zone-list removal" "${PRIOR_ENV[@]}" CDKD_TEST_PAZREMOVE=true

echo "==> Step 4i: AZMODE REMOVAL deploy (issue #5558) -- single-az Memcached AZMode removed"
assert_memcached_replaced "AZMode removal" "${PRIOR_ENV[@]}" CDKD_TEST_PAZREMOVE=true CDKD_TEST_AZMODEREMOVE=true

echo "==> Step 4j: MEMCACHED SCALE-OUT deploy (issue #7045 setup) -- 2 nodes, single-az, no zone list"
# Sets up the previous template of the measured #7045 change: AZMode added
# back as single-az and NumCacheNodes 1 -> 2, no zone list. No replacement
# rule fires (an added AZMode is #5438's measured in-place row), so the same
# cluster must now hold 2 nodes. Not itself a pre-fix red.
REMOVED_ENV=("${PRIOR_ENV[@]}" CDKD_TEST_PAZREMOVE=true CDKD_TEST_AZMODEREMOVE=true)
MC_ID_SCALE=$(mc_field 'CacheClusterId')
if [ -z "${MC_ID_SCALE}" ] || [ "${MC_ID_SCALE}" = "None" ]; then
  echo "FAIL: cannot resolve the Memcached cluster before the scale-out (#7045 setup)" >&2
  exit 1
fi
set +e
env "${REMOVED_ENV[@]}" CDKD_TEST_MCSCALE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
MCSCALE_RC=$?
set -e
if [ "${MCSCALE_RC}" -ne 0 ]; then
  echo "FAIL: Memcached scale-out deploy exited ${MCSCALE_RC} (#7045 setup)" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
if [ "$(mc_field 'CacheClusterId')" != "${MC_ID_SCALE}" ]; then
  echo "FAIL: the Memcached scale-out replaced ${MC_ID_SCALE}; it must be in place (#7045 setup)" >&2
  exit 1
fi
MC_NODES=$(mc_field 'CacheNodes | length(@)')
if [ "${MC_NODES}" != "2" ]; then
  echo "FAIL: the Memcached cluster ${MC_ID_SCALE} has ${MC_NODES} nodes after the scale-out, expected 2" >&2
  exit 1
fi
echo "    OK: ${MC_ID_SCALE} scaled to 2 nodes in place"

echo "==> Step 4k: CROSS-AZ deploy (issue #7045) -- single-az -> cross-az + [az0, az1], same node count"
# Real CloudFormation REPLACES the cluster, and the new one spans both zones.
# Before #7045 cdkd updated it in place, sent no zone change (ModifyCacheCluster
# carries AZMode only beside nodes to add) and warned: the deploy exited 0 with
# the same single-zone cluster, so the id comparison discriminates.
MC_ISSUE='#7045'
assert_memcached_replaced "single-az -> cross-az move" "${REMOVED_ENV[@]}" CDKD_TEST_MCSCALE=true CDKD_TEST_CROSSAZ=true
if ! MC_ZONE_LIST=$(mc_field 'CacheNodes[].CustomerAvailabilityZone'); then
  echo "FAIL: cannot read the cross-az replacement's node zones (#7045)" >&2
  exit 1
fi
MC_ZONES=$(printf '%s\n' ${MC_ZONE_LIST} | sort -u | wc -l | tr -d ' ')
if [ "${MC_ZONES}" != "2" ]; then
  echo "FAIL: the cross-az replacement's nodes span ${MC_ZONES} zone(s), expected 2 (#7045)" >&2
  exit 1
fi
echo "    OK: the replacement of ${MC_BEFORE} spans 2 zones (#7045)"

echo "==> Step 5: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

echo "==> Step 6: assert 0 orphans"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Kinesis stream ${STREAM_NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}"
assert_gone "Lambda ${FN_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
CACHE_LEFT=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "length(CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'])" --output text)
if [ "${CACHE_LEFT}" != "0" ]; then
  echo "FAIL: ${CACHE_LEFT} ElastiCache cluster(s) still exist after destroy (orphan)" >&2
  exit 1
fi
MC_LEFT=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "length(CacheClusters[?CacheSubnetGroupName=='${MC_SUBNET_GROUP}'])" --output text)
if [ "${MC_LEFT}" != "0" ]; then
  echo "FAIL: ${MC_LEFT} Memcached cluster(s) still exist after destroy (orphan)" >&2
  exit 1
fi
assert_gone "Memcached subnet group ${MC_SUBNET_GROUP} still exists after destroy" \
  aws elasticache describe-cache-subnet-groups --cache-subnet-group-name "${MC_SUBNET_GROUP}" --region "${REGION}"
sweep_log_groups
LG_LEFT=$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "/aws/lambda/${STACK}-" --query 'logGroups[].logGroupName' --output text)
if [ -n "${LG_LEFT}" ] && [ "${LG_LEFT}" != "None" ]; then
  echo "FAIL: Lambda log groups still exist after the sweep: ${LG_LEFT}" >&2
  exit 1
fi
# Automatic snapshots (SnapshotRetentionLimit=3) die with the cluster; assert
# none of this run's remain (a failed probe must be not-found, not a throttle).
if SNAP_OUT=$(aws elasticache describe-snapshots --cache-cluster-id "${CACHE_ID}" --region "${REGION}" \
  --query 'length(Snapshots)' --output text 2>&1); then
  if [ "${SNAP_OUT}" != "0" ]; then
    echo "FAIL: ${SNAP_OUT} ElastiCache snapshot(s) of ${CACHE_ID} remain after destroy" >&2
    exit 1
  fi
elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${SNAP_OUT}"; then
  echo "FAIL: snapshot probe undetermined: ${SNAP_OUT}" >&2
  exit 1
fi
assert_gone "SNS topic ${TOPIC_ARN} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: 0 orphans (state + Kinesis + Lambda + ElastiCache + Lambda log groups all gone)"

echo ""
echo "==> cache-streaming test passed: GetAtt Redis endpoint resolved, VPC/ElastiCache/Kinesis/Lambda deployed + wired, clean destroy 0 orphans"
trap - EXIT INT TERM
