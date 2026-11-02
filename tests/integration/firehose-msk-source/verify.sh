#!/usr/bin/env bash
# verify.sh — cdkd Firehose DeliveryStream MSKSourceConfiguration on the SDK
# route (issue #5636).
#
# Before the fix the property was missing from the provider's
# handledProperties, so the stream routed through Cloud Control and its state
# record read `provisionedBy: "cc-api"` -- the first assertion after the
# deploy. CloudFormation reads `ReadFromTimestamp` as a string of epoch
# MILLISECONDS (an ISO 8601 date is refused with `For input string`, and
# `1761955200` reached Firehose as 1970-01-21; measured 2026-11-03 through
# Cloud Control); the SDK route converts it to the SDK's Date, so the instant
# AWS reports must be the template's to the millisecond.
#
# Phases:
#   1. Deploy: an MSK Serverless cluster (IAM auth) in a two-subnet isolated
#      VPC, a cluster policy for the Firehose service, and an MSKAsSource
#      stream on it (PRIVATE, ReadFromTimestamp 2026-01-01T00:00:00Z) into
#      an S3 bucket. Assert provisionedBy=sdk, every templated member in
#      DescribeDeliveryStream's Source.MSKSourceDescription, and the
#      template's spelling in observedProperties.
#   2. CDKD_TEST_UPDATE=true: a stream tag added (in place). Assert the same
#      stream (create timestamp unchanged), the tag, the MSK source
#      untouched, and a clean drift.
#   3. Destroy; assert the stream, cluster, role, bucket, VPC and state file
#      are gone.
#
# No topic is created: MSK's topic APIs refuse a serverless cluster, and the
# stream reaches ACTIVE without one (measured 2026-11-03: ~2.5 min on a fresh
# serverless cluster). No record is ever put, so the bucket stays empty. The
# serverless cluster reaches ACTIVE in ~2 min (measured), where a provisioned
# one takes 20-40.
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

STACK="CdkdFirehoseMskSourceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Deterministic names from lib/firehose-msk-source-stack.ts.
STREAM_NAME="CdkdFirehoseMsk5636"
CLUSTER_NAME="cdkd-firehose-msk-5636"
TOPIC_NAME="cdkd-5636-events"
VPC_NAME="cdkd-firehose-msk-5636"
ROLE_NAME="CdkdFirehoseMsk5636Role-${REGION}"
READ_FROM_TIMESTAMP="1767225600000"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Only a value shaped like a bucket name AND carrying the name cdkd generates
# for this stack's `Bucket` (resource-name.ts: the lowercased
# `{StackName}-{LogicalId}`, plus `-{12 hex}` on a stack with an instance id)
# is ever emptied or deleted.
is_fixture_bucket() { # usage: is_fixture_bucket <name>
  [[ "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] &&
    [[ "$1" =~ ^cdkdfirehosemsksourceexample-bucket(-[0-9a-f]{12})?$ ]]
}

# The ARN of the cluster named CLUSTER_NAME, or empty when there is none.
# Returns 1 when the list call fails: a throttle or auth error must not read
# as "no cluster", or an earlier run's orphan (billed hourly) goes unnoticed.
# The CLI's own error stays on stderr, so the LEAK? line has its cause.
cluster_arn_by_name() {
  local out
  out="$(aws kafka list-clusters-v2 --cluster-name-filter "${CLUSTER_NAME}" --region "${REGION}" \
    --query "ClusterInfoList[?ClusterName=='${CLUSTER_NAME}'].ClusterArn | [0]" --output text)" || return 1
  [ "${out}" = "None" ] || printf '%s' "${out}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # The bucket's name is generated, so read it from the record BEFORE the
  # state destroy drops it: a failed destroy leaves no other way to find it.
  local leftover_bucket=""
  if [ -n "${STATE_BUCKET:-}" ]; then
    leftover_bucket="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" 2>/dev/null |
      jq -r '.resources.Bucket.physicalId // empty' 2>/dev/null)"
  fi
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET:-}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  # By deterministic name: a run that died before recording them in state.
  # A delete leaves the name DELETING for minutes, and the next create of it
  # is refused, so wait (capped) until the stream is gone. The delete fails
  # on a stream already DELETING (ResourceInUse) as on an absent one, so the
  # wait keys on the stream's presence, not on the delete's exit code.
  aws firehose delete-delivery-stream --delivery-stream-name "${STREAM_NAME}" --allow-force-delete \
    --region "${REGION}" >/dev/null 2>&1 || true
  if ! (gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
    --region "${REGION}"); then
    for _ in $(seq 1 36); do
      # Subshell: an inconclusive probe (throttle, 5xx) exits only it, and
      # counts as still present, so the deletes below still run.
      (gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
        --region "${REGION}") && break
      sleep 5
    done
    if ! (gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
      --region "${REGION}"); then
      echo "LEAK: delivery stream ${STREAM_NAME} survived the cleanup -- delete it by hand" >&2
    fi
  fi
  # Stream, then cluster (its policy goes with it), then the VPC its endpoint
  # interfaces sit in.
  local cluster_arn listed
  if ! cluster_arn="$(cluster_arn_by_name)"; then
    echo "LEAK?: cannot list MSK clusters; a ${CLUSTER_NAME} cluster an earlier run left would be neither deleted nor reported -- check by hand" >&2
  elif [ -n "${cluster_arn}" ]; then
    aws kafka delete-cluster --cluster-arn "${cluster_arn}" --region "${REGION}" >/dev/null 2>&1 || true
    # A failed list is not gone: keep waiting; the probe below decides.
    for _ in $(seq 1 60); do
      listed="$(cluster_arn_by_name)" && [ -z "${listed}" ] && break
      sleep 10
    done
    # MSK Serverless bills by the hour: a survivor must not go unnoticed.
    if ! (gone_probe aws kafka describe-cluster-v2 --cluster-arn "${cluster_arn}" --region "${REGION}"); then
      echo "LEAK: MSK cluster ${CLUSTER_NAME} (${cluster_arn}) survived the cleanup -- delete it by hand" >&2
    fi
  fi
  aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name msk-source >/dev/null 2>&1 || true
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  if ! (gone_probe aws iam get-role --role-name "${ROLE_NAME}"); then
    echo "LEAK: IAM role ${ROLE_NAME} survived the cleanup -- delete it by hand" >&2
  fi
  local vpc_id
  for vpc_id in $(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=${VPC_NAME}" --region "${REGION}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    # MSK releases its endpoint interfaces a few minutes after the cluster
    # is gone; until then the subnets refuse their delete.
    local enis
    for _ in $(seq 1 36); do
      enis="$(aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=${vpc_id}" --region "${REGION}" \
        --query 'length(NetworkInterfaces)' --output text 2>/dev/null || echo ERR)"
      [ "${enis}" = "0" ] && break
      if [ "${enis}" = "ERR" ]; then
        echo "WARN: cannot list the network interfaces of ${vpc_id}; trying its deletes anyway" >&2
        break
      fi
      sleep 10
    done
    local id
    for id in $(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${vpc_id}" --region "${REGION}" \
      --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    for id in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${vpc_id}" --region "${REGION}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
      aws ec2 delete-security-group --group-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    if ! aws ec2 delete-vpc --vpc-id "${vpc_id}" --region "${REGION}" >/dev/null 2>&1; then
      echo "LEAK: VPC ${vpc_id} (${VPC_NAME}) survived the cleanup -- delete it by hand" >&2
    fi
  done
  # A failed state destroy left the bucket: empty and delete it by the name
  # read above, and name it loudly if it is still there.
  # Anything not this fixture's generated name is named and left alone.
  if [ "${rc}" != "0" ] && [ -n "${leftover_bucket}" ]; then
    if is_fixture_bucket "${leftover_bucket}"; then
      aws s3 rm "s3://${leftover_bucket}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
      aws s3api delete-bucket --bucket "${leftover_bucket}" --region "${REGION}" >/dev/null 2>&1 || true
      if ! (gone_probe aws s3api head-bucket --bucket "${leftover_bucket}" --region "${REGION}"); then
        echo "LEAK: bucket ${leftover_bucket} survived the cleanup -- delete it by hand" >&2
      fi
    else
      echo "SKIP: teardown sweep refused the recorded bucket name '${leftover_bucket}': not this fixture's generated name" >&2
      echo "LEAK: bucket '${leftover_bucket}' may remain -- delete it by hand" >&2
    fi
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

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

describe_stream() {
  aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
    --region "${REGION}" --output json
}

# The stream's Source.MSKSourceDescription, or FAIL when AWS reports none.
msk_desc() {
  local out
  out="$(describe_stream)" || return 1
  if [ "$(jq -r '.DeliveryStreamDescription.Source.MSKSourceDescription | type' <<<"${out}")" != "object" ]; then
    echo "FAIL: ${STREAM_NAME} has no Source.MSKSourceDescription (#5636):" >&2
    jq '.DeliveryStreamDescription.Source' <<<"${out}" >&2
    exit 1
  fi
  jq -c '.DeliveryStreamDescription.Source.MSKSourceDescription' <<<"${out}"
}

create_timestamp() {
  aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
    --region "${REGION}" --query 'DeliveryStreamDescription.CreateTimestamp' --output text
}

assert_eq() { # usage: assert_eq <description> <got> <want>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected '$3', got '$2' (#5636)" >&2
    exit 1
  fi
  echo "    ok: $1 = $2"
}

assert_sdk_route() {
  local by
  by="$(read_state | jq -r '.resources.Stream.provisionedBy // "<absent>"')"
  if [ "${by}" != "sdk" ]; then
    echo "FAIL: AWS::KinesisFirehose::DeliveryStream routing layer is '${by}', expected 'sdk' (MSKSourceConfiguration still routes the stream to Cloud Control, #5636)" >&2
    exit 1
  fi
  echo "    ok: the delivery stream stayed on the SDK route"
}

# Every templated member of the MSK source, read back from AWS.
assert_msk_members() { # usage: assert_msk_members <desc json>
  local desc="$1"
  assert_eq "MSKClusterARN" "$(jq -r '.MSKClusterARN' <<<"${desc}")" "${CLUSTER_ARN}"
  assert_eq "TopicName" "$(jq -r '.TopicName' <<<"${desc}")" "${TOPIC_NAME}"
  assert_eq "AuthenticationConfiguration.RoleARN" \
    "$(jq -r '.AuthenticationConfiguration.RoleARN' <<<"${desc}")" "${ROLE_ARN}"
  assert_eq "AuthenticationConfiguration.Connectivity" \
    "$(jq -r '.AuthenticationConfiguration.Connectivity' <<<"${desc}")" "PRIVATE"
  # The CLI prints the instant in the caller's zone (`+09:00` included), so
  # compare it as epoch milliseconds: read as seconds, the template's value
  # would land in 1970.
  local read_from
  read_from="$(jq -r '.ReadFromTimestamp // empty' <<<"${desc}")"
  if [ -z "${read_from}" ]; then
    echo "FAIL: MSKSourceDescription carries no ReadFromTimestamp -- the SDK route did not send it (#5636)" >&2
    exit 1
  fi
  assert_eq "ReadFromTimestamp (epoch ms; AWS: ${read_from})" \
    "$(node -e 'process.stdout.write(String(Date.parse(process.argv[1])))' "${read_from}")" "${READ_FROM_TIMESTAMP}"
}

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy (MSK Serverless source, PRIVATE, ReadFromTimestamp ${READ_FROM_TIMESTAMP})"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route
STATE="$(read_state)"
BUCKET_NAME="$(jq -r '.outputs.BucketName // empty' <<<"${STATE}")"
ROLE_ARN="$(jq -r '.outputs.RoleArn // empty' <<<"${STATE}")"
CLUSTER_ARN="$(jq -r '.outputs.ClusterArn // empty' <<<"${STATE}")"
VPC_ID="$(jq -r '.outputs.VpcId // empty' <<<"${STATE}")"
if [ -z "${BUCKET_NAME}" ] || [ -z "${ROLE_ARN}" ] || [ -z "${CLUSTER_ARN}" ] || [ -z "${VPC_ID}" ]; then
  echo "FAIL: BucketName / RoleArn / ClusterArn / VpcId missing from state outputs" >&2
  jq '.outputs' <<<"${STATE}" >&2
  exit 1
fi

assert_eq "DeliveryStreamType" \
  "$(describe_stream | jq -r '.DeliveryStreamDescription.DeliveryStreamType')" "MSKAsSource"
assert_msk_members "$(msk_desc)"

# The deploy-time read is readCurrentState's: the template's epoch-millisecond
# spelling, or every drift run would report the member.
OBSERVED="$(jq -c '.resources.Stream.observedProperties.MSKSourceConfiguration // empty' <<<"${STATE}")"
if [ "$(jq -r 'type' <<<"${OBSERVED:-null}")" != "object" ]; then
  echo "FAIL: the stream's observedProperties carry no MSKSourceConfiguration -- readCurrentState does not read the MSK source back (#5636)" >&2
  jq '.resources.Stream.observedProperties' <<<"${STATE}" >&2
  exit 1
fi
assert_eq "observed ReadFromTimestamp" \
  "$(jq -r '.ReadFromTimestamp // "<absent>"' <<<"${OBSERVED}")" "${READ_FROM_TIMESTAMP}"
assert_eq "observed TopicName" "$(jq -r '.TopicName // "<absent>"' <<<"${OBSERVED}")" "${TOPIC_NAME}"
assert_eq "observed MSKSourceConfiguration keys" \
  "$(jq -r 'keys | join(",")' <<<"${OBSERVED}")" \
  "AuthenticationConfiguration,MSKClusterARN,ReadFromTimestamp,TopicName"
BASE_CREATED="$(create_timestamp)"

# --- Phase 2: in-place update ------------------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (a stream tag added)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route
assert_eq "stream create timestamp (in place, not replaced)" "$(create_timestamp)" "${BASE_CREATED}"
assert_eq "phase tag" \
  "$(aws firehose list-tags-for-delivery-stream --delivery-stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query "Tags[?Key=='cdkd-5636-phase'].Value | [0]" --output text)" "2"
assert_msk_members "$(msk_desc)"

echo "==> Phase 2: drift must be clean"
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}"
echo "    ok: no drift after the update"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
is_fixture_bucket "${BUCKET_NAME}" || { echo "FAIL: '${BUCKET_NAME}' is not this fixture's generated bucket name" >&2; exit 1; }
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "delivery stream ${STREAM_NAME} still exists after destroy" \
  aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" --region "${REGION}"
assert_gone "MSK cluster ${CLUSTER_NAME} still exists after destroy" \
  aws kafka describe-cluster-v2 --cluster-arn "${CLUSTER_ARN}" --region "${REGION}"
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} (${VPC_NAME}) still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    ok: stream, cluster, role, bucket, VPC and state file are gone"

echo ""
echo "[verify] PASS — firehose-msk-source: MSKSourceConfiguration created on the SDK route, ReadFromTimestamp read as epoch milliseconds, read back in the template's spelling (#5636)"
