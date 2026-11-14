#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt of the whole-object read-only attributes
# ElastiCache CacheCluster RedisEndpoint / ConfigurationEndpoint, Kinesis
# Stream WarmThroughputObject, Lambda Function SnapStartResponse and EC2
# Instance State (issue #6242).
#
# Each object reaches a custom resource the way CloudFormation passes it to a
# consumer; the echo handler returns it as compact sorted JSON, and each is
# asserted against AWS's own read -- after the create, then after an in-place
# update of every probed resource -- then destroys clean.

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

STACK="CdkdGetattCacheKinesisLambdaEc2Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp)"

# Lambda auto-creates a log group for the echo function, which neither
# CloudFormation nor cdkd deletes. Swept by this fixture's own prefix.
sweep_log_groups() { (
  set +eu
  case "${STACK}" in
    CdkdGetattCacheKinesisLambdaEc2?*) ;;
    *) echo "WARN: teardown sweep refused -- '${STACK}' is outside this fixture's scope" >&2; exit 0 ;;
  esac
  for g in $(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "/aws/lambda/${STACK}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --region "${REGION}" --log-group-name "${g}" >/dev/null 2>&1 || true
  done
) }

# Set once the stack is up, so a failed run's cleanup can remove an internet
# gateway the destroy left behind (detached first: a deletion of an attached
# gateway fails).
IGW_ID=""

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${DEPLOY_LOG}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${IGW_ID}" in
    igw-*)
      for v in $(aws ec2 describe-internet-gateways --region "${REGION}" --internet-gateway-ids "${IGW_ID}" --query 'InternetGateways[0].Attachments[].VpcId' --output text 2>/dev/null); do
        aws ec2 detach-internet-gateway --region "${REGION}" --internet-gateway-id "${IGW_ID}" --vpc-id "${v}" >/dev/null 2>&1
      done
      aws ec2 delete-internet-gateway --region "${REGION}" --internet-gateway-id "${IGW_ID}" >/dev/null 2>&1
      ;;
  esac
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

expect_eq() { # usage: expect_eq <label> <actual> <expected>
  if [ -z "$3" ] || [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

deploy() { # usage: deploy <command prefix...>, e.g. deploy env -u CDKD_TEST_UPDATE
  "$@" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
  if grep -E 'Failed to resolve output|Cannot resolve Fn::GetAtt|Unknown attribute' "${DEPLOY_LOG}"; then
    echo "FAIL: an attribute did not resolve, or a physical-id fallback warning was printed (see above)" >&2
    exit 1
  fi
}

# Compact, key-sorted JSON (the echo handler's spelling) of an AWS read.
canon() { jq -cS "$1"; }

assert_all() { # usage: assert_all <expected phase>
  expect_eq "ProbePhase output" "$(output_of ProbePhase)" "$1"

  local redis_id memcached_id stream fn instance
  redis_id="$(output_of RedisId)"
  memcached_id="$(output_of MemcachedId)"
  stream="$(output_of StreamName)"
  fn="$(output_of FunctionName)"
  instance="$(output_of InstanceId)"

  local redis_json
  redis_json="$(aws elasticache describe-cache-clusters --region "${REGION}" --cache-cluster-id "${redis_id}" --show-cache-node-info --output json)" || return 1
  expect_eq "RedisEndpoint" "$(output_of ProbeRedisEndpoint)" \
    "$(canon '.CacheClusters[0].CacheNodes[0].Endpoint | {Address, Port: (.Port | tostring)}' <<<"${redis_json}")"
  expect_eq "RedisEndpoint.Port" "$(output_of ProbeRedisEndpointPort)" \
    "$(jq -r '.CacheClusters[0].CacheNodes[0].Endpoint.Port | tostring' <<<"${redis_json}")"

  expect_eq "ConfigurationEndpoint" "$(output_of ProbeConfigurationEndpoint)" \
    "$(aws elasticache describe-cache-clusters --region "${REGION}" --cache-cluster-id "${memcached_id}" --output json \
      | canon '.CacheClusters[0].ConfigurationEndpoint | {Address, Port: (.Port | tostring)}')"

  # CloudFormation answers zeros where AWS reports no warm throughput.
  # Compared TYPE-INSENSITIVELY: a cdkd custom-resource request used to
  # stringify every number it passed, where CloudFormation passes a
  # GetAtt-derived number as a number (go-to-k/cdkd#6309). Both sides are
  # stringified so this holds before and after that fix; the recorded type is
  # pinned by assert_state_types below.
  expect_eq "WarmThroughputObject" "$(output_of ProbeWarmThroughputObject | jq -cS 'map_values(tostring)')" \
    "$(aws kinesis describe-stream-summary --region "${REGION}" --stream-name "${stream}" --output json \
      | canon '(.StreamDescriptionSummary.WarmThroughput // {}) | {TargetMiBps: (.TargetMiBps // 0), CurrentMiBps: (.CurrentMiBps // 0)} | map_values(tostring)')"

  local snap
  snap="$(aws lambda get-function-configuration --region "${REGION}" --function-name "${fn}" --query SnapStart --output json)" || return 1
  expect_eq "SnapStartResponse" "$(output_of ProbeSnapStartResponse)" "$(canon '{ApplyOn, OptimizationStatus}' <<<"${snap}")"
  expect_eq "SnapStartResponse.ApplyOn" "$(output_of ProbeSnapStartApplyOn)" "$(jq -r '.ApplyOn' <<<"${snap}")"

  expect_eq "Instance State" "$(output_of ProbeInstanceState)" \
    "$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${instance}" --output json \
      | canon '.Reservations[0].Instances[0].State | {Code: (.Code | tostring), Name}')"
}

# The JSON type each value is RECORDED with, as CloudFormation passes it:
# WarmThroughputObject members are numbers, the endpoint ports and State.Code
# strings. A Memcached cluster records no RedisEndpoint (refused).
assert_state_types() {
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -e '
    .resources as $r
    | ($r.Stream.attributes.WarmThroughputObject.TargetMiBps | type) == "number"
      and ($r.Stream.attributes.WarmThroughputObject.CurrentMiBps | type) == "number"
      and ($r.Instance.attributes.State.Code | type) == "string"
      and ($r.Instance.attributes.State.Name | type) == "string"
      and ($r.Echo.attributes.SnapStartResponse.ApplyOn | type) == "string"
      and ($r.Echo.attributes.SnapStartResponse.OptimizationStatus | type) == "string"
      and ($r.Redis.attributes["RedisEndpoint.Port"] | type) == "string"
      and ($r.Memcached.attributes["ConfigurationEndpoint.Port"] | type) == "string"
      and ($r.Redis.attributes | has("ConfigurationEndpoint.Address") | not)
      and ($r.Memcached.attributes | has("RedisEndpoint.Address") | not)
  ' <<<"${state}" >/dev/null || { echo "FAIL: a recorded attribute has the wrong JSON type or shape" >&2; return 1; }
  echo "    OK: WarmThroughputObject members are numbers, ports and State.Code strings, no Memcached RedisEndpoint, no Redis ConfigurationEndpoint"
}

echo "==> Phase 1: deploy"
deploy env -u CDKD_TEST_UPDATE
IGW_ID="$(output_of VpcIgwId)"
assert_all create
assert_state_types

echo "==> Phase 2: UPDATE every probed resource in place"
deploy env CDKD_TEST_UPDATE=true
assert_all update
assert_state_types

REDIS_ID="$(output_of RedisId)"
MEMCACHED_ID="$(output_of MemcachedId)"
STREAM="$(output_of StreamName)"
FN="$(output_of FunctionName)"
INSTANCE="$(output_of InstanceId)"
SUBNET_GROUP="$(output_of SubnetGroupName)"
ROLE="$(output_of RoleName)"
VPC="$(output_of VpcId)"
SG="$(output_of SecurityGroupId)"
for v in "${IGW_ID}" "${REDIS_ID}" "${MEMCACHED_ID}" "${STREAM}" "${FN}" "${INSTANCE}" "${SUBNET_GROUP}" "${ROLE}" "${VPC}" "${SG}"; do
  [ -n "${v}" ] || { echo "FAIL: a stack output read before destroy is empty" >&2; exit 1; }
done

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for c in "${REDIS_ID}" "${MEMCACHED_ID}"; do
  assert_gone "cache cluster ${c} still exists after destroy" aws elasticache describe-cache-clusters --region "${REGION}" --cache-cluster-id "${c}"
done
assert_gone "stream ${STREAM} still exists after destroy" aws kinesis describe-stream-summary --region "${REGION}" --stream-name "${STREAM}"
assert_gone "function ${FN} still exists after destroy" aws lambda get-function --region "${REGION}" --function-name "${FN}"
# A terminated instance stays describable for a while, so "gone" is either
# a not-found probe or a terminating / terminated state.
if ! gone_probe aws ec2 describe-instances --region "${REGION}" --instance-ids "${INSTANCE}"; then
  STATE_NAME="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${INSTANCE}" --query 'Reservations[0].Instances[0].State.Name' --output text)"
  case "${STATE_NAME}" in
    terminated|shutting-down) ;;
    *) echo "FAIL: instance ${INSTANCE} is '${STATE_NAME}' after destroy" >&2; exit 1 ;;
  esac
fi
assert_gone "subnet group ${SUBNET_GROUP} still exists after destroy" aws elasticache describe-cache-subnet-groups --region "${REGION}" --cache-subnet-group-name "${SUBNET_GROUP}"
assert_gone "role ${ROLE} still exists after destroy" aws iam get-role --role-name "${ROLE}"
assert_gone "security group ${SG} still exists after destroy" aws ec2 describe-security-groups --region "${REGION}" --group-ids "${SG}"
assert_gone "internet gateway ${IGW_ID} still exists after destroy" aws ec2 describe-internet-gateways --region "${REGION}" --internet-gateway-ids "${IGW_ID}"
assert_gone "VPC ${VPC} still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
sweep_log_groups
LEFT="$(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "/aws/lambda/${STACK}" --query 'length(logGroups)' --output text)"
[ "${LEFT}" = "0" ] || { echo "FAIL: ${LEFT} /aws/lambda/${STACK}* log group(s) remain" >&2; exit 1; }
echo "    OK: clusters, subnet group, stream, function, role, instance, security group, internet gateway, VPC, log groups and state gone"

echo ""
echo "[verify] PASS — getatt-cache-kinesis-lambda-ec2: RedisEndpoint, ConfigurationEndpoint, WarmThroughputObject, SnapStartResponse and State match AWS after create and update"
