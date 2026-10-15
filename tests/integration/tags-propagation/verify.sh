#!/usr/bin/env bash
#
# Failure-seeking real-AWS validation that STACK-LEVEL tags
# (`cdk.Tags.of(app).add(k, v)` in bin/app.ts) propagate to ALL taggable
# resources across MANY types, on BOTH the cdkd SDK-provider path AND the
# Cloud Control API path.
#
# cdk.Tags.of(...) injects the same N tags into the CFn `Tags` property of
# every taggable resource. cdkd must forward them to AWS correctly for
# every type — but each AWS type accepts tags in a DIFFERENT wire shape
# ({Key,Value}[] list vs { k: v } map vs the CC-API forwarder). Per memory
# feedback_ssm_parameter_tags_is_a_map, AWS::SSM::Parameter.Tags is a MAP
# (not the list almost every other type uses) and a provider doing
# `Tags.map()` crashed deploy. This fixture deliberately tags an SSM
# Parameter so that regression is caught end-to-end.
#
# What this proves that no other fixture does: for EACH of 16 taggable
# types, the verify reads the live AWS-side tags via that type's
# type-specific list/describe API and asserts ALL 3 stack-level tags are
# present with the correct value. A type that DROPS a tag (or crashes on
# the wrong Tags shape at deploy time) FAILs the run NAMING the type.
#
# Also: post-deploy `cdkd drift` must report exit 0 — a tag-list REORDER
# from AWS (per issue #802 canonicalizeTagListsDeep) must NOT show as a
# false-positive drift.
#
# go-to-k/cdkd#4971: the deploy runs as a throwaway role that may do anything
# EXCEPT create an IAM Role, SSM Parameter, Kinesis Stream, EC2 VPC, Subnet,
# InternetGateway, RouteTable, NetworkAcl or SecurityGroup whose create request
# lacks the `CdkdTagOwner` tag -- an explicit deny on `aws:RequestTag`, the
# shape of an organization SCP that requires tags on create. A provider that
# creates untagged and tags afterwards is refused there; `cdk deploy` is not.
#
# Path split asserted from state.json `provisionedBy`:
#   - SDK path: S3, SNS, SQS, SSM, IAM Role, Logs LogGroup, Lambda, DynamoDB,
#     Kinesis Stream, and the six EC2 types
#   - CC-API path: Athena WorkGroup (no SDK provider -> Cloud Control)
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps; create the
#      tag-requiring role and prove each of its deny statements binds (an
#      untagged create of every type under test meets the explicit deny)
#   2. cdkd deploy CdkdTagsPropagationExample AS that role (a Tags-shape
#      crash on any type, or a create sent without its tags, fails here)
#   3. read state.json; assert routing split (15 sdk + 1 cc-api)
#   4. for each type, read live AWS tags + assert all 3 stack tags present
#   5. cdkd drift -> assert exit 0 (no tag-order false positive, #802)
#   6. cdkd destroy --force (as the caller); the stream and EC2 resources
#      are gone
#   7. rewrite the role to deny only ec2:CreateTags and deploy again as it:
#      each EC2 create is re-sent untagged, then CreateTags warns, and the
#      deploy succeeds as it did before go-to-k/cdkd#4971
#   8. cdkd destroy --force (as the caller), the stream and EC2 resources
#      are gone, then delete the role
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
# BSD/macOS-portable (no `grep -P`, no `date -d`); real rc captured and an
# explicit `[verify] PASS` printed only on full success.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdTagsPropagationExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/tags-propagation"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The 3 stack-level tags — MUST match bin/app.ts exactly.
EXPECTED_KEYS=("CdkdTagOwner" "CdkdTagEnv" "CdkdTagCostCenter")
EXPECTED_VALS=("cdkd-integ" "test" "cc-1234")

# go-to-k/cdkd#4971: the role the deploy runs as (see the header).
ROLE="${STACK}-TagRequired"
POLICY_NAME="require-request-tag"
ROLE_CREATED=""
# Names the deny probes try to create untagged (the EC2 probes are dry runs and
# make nothing). Each is refused when the deny binds. Its flag is set only when
# a probe was ALLOWED -- this run then made that resource -- and cleanup deletes
# only a flagged one, so a same-named resource of a concurrent run is never
# touched.
PROBE_PARAM="/${STACK}/tag-required-probe"
PROBE_ROLE="${STACK}-tag-required-probe"
PROBE_STREAM="${STACK}-tag-required-probe"
PROBE_PARAM_CREATED=""
PROBE_ROLE_CREATED=""
PROBE_STREAM_CREATED=""

delete_role() { ( # usage: delete_role  (best-effort)
  set +eu
  aws iam delete-role-policy --role-name "${ROLE}" --policy-name "${POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1
  true
); }

# go-to-k/cdkd#4971: the stream and EC2 resources a deploy recorded are gone
# after its destroy. Kinesis deletes asynchronously and EC2 reads are eventually
# consistent, so each probe is retried a bounded number of times; a resource
# still there at the end FAILs.
assert_new_types_gone() { # usage: assert_new_types_gone <state.json text> <phase label>
  local state="$1" label="$2" t id probe gone
  for t in 'AWS::Kinesis::Stream' 'AWS::EC2::VPC' 'AWS::EC2::Subnet' 'AWS::EC2::InternetGateway' \
           'AWS::EC2::RouteTable' 'AWS::EC2::NetworkAcl' 'AWS::EC2::SecurityGroup'; do
    id="$(echo "${state}" | jq -r --arg t "${t}" \
      '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""')"
    if [ -z "${id}" ]; then
      echo "[verify] FAIL: ${label}: no ${t} recorded to check for leftovers" >&2
      exit 1
    fi
    case "${t}" in
      AWS::Kinesis::Stream) probe=(aws kinesis describe-stream-summary --stream-name "${id}") ;;
      AWS::EC2::VPC) probe=(aws ec2 describe-vpcs --vpc-ids "${id}") ;;
      AWS::EC2::Subnet) probe=(aws ec2 describe-subnets --subnet-ids "${id}") ;;
      AWS::EC2::InternetGateway) probe=(aws ec2 describe-internet-gateways --internet-gateway-ids "${id}") ;;
      AWS::EC2::RouteTable) probe=(aws ec2 describe-route-tables --route-table-ids "${id}") ;;
      AWS::EC2::NetworkAcl) probe=(aws ec2 describe-network-acls --network-acl-ids "${id}") ;;
      AWS::EC2::SecurityGroup) probe=(aws ec2 describe-security-groups --group-ids "${id}") ;;
    esac
    gone=""
    for _ in $(seq 1 24); do
      if gone_probe "${probe[@]}" --region "${REGION}"; then gone=1; break; fi
      sleep 5
    done
    if [ -z "${gone}" ]; then
      echo "[verify] FAIL: ${label}: ${t} ${id} still exists 2 minutes after the destroy" >&2
      exit 1
    fi
  done
  echo "[verify]   ok: ${label}: the stream and the six EC2 resources are gone"
}

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

# Before the trap is armed: a role already there may belong to a concurrent
# run, whose stack this run's failure-path destroy must not touch.
if ! gone_probe aws iam get-role --role-name "${ROLE}"; then
  echo "[verify] FAIL: precondition -- role ${ROLE} already exists (left by an earlier run, or a concurrent one); delete it first (nothing of this run to clean up)" >&2
  exit 1
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  if [ -n "${PROBE_PARAM_CREATED}" ]; then
    aws ssm delete-parameter --name "${PROBE_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${PROBE_ROLE_CREATED}" ]; then
    aws iam delete-role --role-name "${PROBE_ROLE}" >/dev/null 2>&1 || true
  fi
  if [ -n "${PROBE_STREAM_CREATED}" ]; then
    aws kinesis delete-stream --stream-name "${PROBE_STREAM}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${ROLE_CREATED}" ]; then
    delete_role
    if ! ( gone_probe aws iam get-role --role-name "${ROLE}" ); then
      echo "[verify] WARN: role ${ROLE} could not be confirmed deleted; delete it by hand: aws iam delete-role-policy --role-name ${ROLE} --policy-name ${POLICY_NAME}; aws iam delete-role --role-name ${ROLE}" >&2
    fi
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1b: a role that may not create the go-to-k/cdkd#4971 types without the CdkdTagOwner request tag"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Everything is allowed but the creates under test, each denied when its
# request lacks the tag. Each EC2 deny names only the TYPE that create makes:
# a create is also authorized against its parent VPC, which carries no request
# tag, so a deny listing `vpc/*` for CreateSubnet refuses a tagged subnet too
# (measured) -- an organization SCP is scoped the same way.
ROLE_POLICY="$(node -e '
const cond = { Null: { "aws:RequestTag/CdkdTagOwner": "true" } };
const st = [
  { Effect: "Allow", Action: "*", Resource: "*" },
  { Effect: "Deny", Action: ["iam:CreateRole", "ssm:PutParameter", "kinesis:CreateStream"], Resource: "*", Condition: cond },
  ...[["CreateVpc", "vpc"], ["CreateSubnet", "subnet"], ["CreateInternetGateway", "internet-gateway"],
      ["CreateRouteTable", "route-table"], ["CreateNetworkAcl", "network-acl"],
      ["CreateSecurityGroup", "security-group"]]
    .map(([a, t]) => ({ Effect: "Deny", Action: `ec2:${a}`, Resource: `arn:aws:ec2:*:*:${t}/*`, Condition: cond })),
];
process.stdout.write(JSON.stringify({ Version: "2012-10-17", Statement: st }));')"
aws iam create-role --role-name "${ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=tags-propagation >/dev/null
ROLE_CREATED=1
aws iam put-role-policy --role-name "${ROLE}" --policy-name "${POLICY_NAME}" \
  --policy-document "${ROLE_POLICY}"
ROLE_CREDS=""
for _ in $(seq 1 24); do
  if ROLE_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}" \
    --role-session-name cdkd-tags-propagation --duration-seconds 3600 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  ROLE_CREDS=""
  sleep 5
done
if [ -z "${ROLE_CREDS}" ]; then
  echo "[verify] FAIL: precondition -- could not assume ${ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r ROLE_AK ROLE_SK ROLE_ST < <(printf '%s\n' "${ROLE_CREDS}")
unset ROLE_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell, so the keys never sit in a process's argv.
as_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${ROLE_AK}" AWS_SECRET_ACCESS_KEY="${ROLE_SK}" AWS_SESSION_TOKEN="${ROLE_ST}"
    exec "$@"
  )
}
ROLE_ARN=""
for _ in $(seq 1 24); do
  if ROLE_ARN="$(as_role aws sts get-caller-identity --query Arn --output text 2>/dev/null)"; then
    break
  fi
  ROLE_ARN=""
  sleep 5
done
case "${ROLE_ARN}" in
  *":assumed-role/${ROLE}/"*) ;;
  *)
    echo "[verify] FAIL: precondition -- the role's commands run as '${ROLE_ARN:-<none>}', not ${ROLE}" >&2
    exit 1
    ;;
esac
# Every deny statement must bind before the deploy, or an untagged create of
# that type would pass for the wrong reason (a Resource ARN that never
# matches, say): each create under test, sent untagged, must meet the
# EXPLICIT deny. The EC2 ones are dry runs; `vpc-00000000` passes parameter
# validation and reaches the authorization check (measured: the same dry run
# carrying the tag answers DryRunOperation). The IAM, SSM and Kinesis ones are
# real creates: one that is ALLOWED sets its flag (the resource is this run's)
# and fails the run, and cleanup deletes what it made.
DUMMY_VPC="vpc-00000000"
NOOP_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
probe_deny() { # usage: probe_deny <label> <created-flag var or -> <aws args...>  (exits on any outcome but an explicit deny)
  local label="$1" flag="$2" out=""
  shift 2
  for _ in $(seq 1 24); do
    if out="$(as_role "$@" 2>&1)"; then
      [ "${flag}" = "-" ] || printf -v "${flag}" '%s' 1
      echo "[verify] FAIL: precondition -- ${ROLE} was ALLOWED an untagged ${label} (its deny must refuse it)" >&2
      exit 1
    elif printf '%s' "${out}" | grep -qi 'explicit deny'; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] FAIL: precondition -- ${ROLE}'s request-tag deny on ${label} never bound within 2 minutes (last answer: ${out})" >&2
  exit 1
}
probe_deny "ssm put-parameter" PROBE_PARAM_CREATED aws ssm put-parameter --name "${PROBE_PARAM}" --value probe --type String --region "${REGION}"
probe_deny "iam create-role" PROBE_ROLE_CREATED aws iam create-role --role-name "${PROBE_ROLE}" --assume-role-policy-document "${NOOP_TRUST}"
probe_deny "kinesis create-stream" PROBE_STREAM_CREATED aws kinesis create-stream --stream-name "${PROBE_STREAM}" \
  --stream-mode-details StreamMode=ON_DEMAND --region "${REGION}"
probe_deny "ec2 create-vpc" - aws ec2 create-vpc --dry-run --cidr-block 10.98.0.0/16 --region "${REGION}"
probe_deny "ec2 create-subnet" - aws ec2 create-subnet --dry-run --vpc-id "${DUMMY_VPC}" \
  --cidr-block 10.98.1.0/24 --region "${REGION}"
probe_deny "ec2 create-internet-gateway" - aws ec2 create-internet-gateway --dry-run --region "${REGION}"
probe_deny "ec2 create-route-table" - aws ec2 create-route-table --dry-run --vpc-id "${DUMMY_VPC}" --region "${REGION}"
probe_deny "ec2 create-network-acl" - aws ec2 create-network-acl --dry-run --vpc-id "${DUMMY_VPC}" --region "${REGION}"
probe_deny "ec2 create-security-group" - aws ec2 create-security-group --dry-run --vpc-id "${DUMMY_VPC}" \
  --group-name tag-required-probe --description probe --region "${REGION}"

echo "[verify] step 2: cdkd deploy as ${ROLE} (a wrong-Tags-shape crash, or a create sent without its tags, fails here)"
if ! as_role node "${REPO_ROOT}/dist/cli.js" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose; then
  echo "[verify] FAIL: the deploy as ${ROLE} failed -- if the output above shows an explicit deny on a create, that create was sent without its tags (go-to-k/cdkd#4971)" >&2
  exit 1
fi

echo "[verify] step 3: read state.json + assert routing split (15 sdk + 1 cc-api)"
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "[verify] FAIL: no state at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Helper: extract physicalId for a given resourceType from state.json.
physid_for_type() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""'
}
provisioned_for_type() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.provisionedBy // "sdk"] | first // ""'
}

# Athena WorkGroup must be CC-API-routed (no SDK provider). Everything
# else must be on the SDK path. A routing regression that pulls a tagged
# type onto the wrong path would change which read code runs.
WG_ROUTE="$(provisioned_for_type 'AWS::Athena::WorkGroup')"
if [ "${WG_ROUTE}" != "cc-api" ]; then
  echo "[verify] FAIL: Athena WorkGroup provisionedBy='${WG_ROUTE}', expected 'cc-api' (the CC-API tag-propagation path was not exercised)" >&2
  echo "${STATE}" | jq '.resources | to_entries[] | {type: .value.resourceType, by: .value.provisionedBy}'
  exit 1
fi
echo "[verify]   ok: Athena WorkGroup routed via cc-api"
for T in 'AWS::S3::Bucket' 'AWS::SNS::Topic' 'AWS::SQS::Queue' 'AWS::SSM::Parameter' \
         'AWS::IAM::Role' 'AWS::Logs::LogGroup' 'AWS::Lambda::Function' 'AWS::DynamoDB::Table' \
         'AWS::Kinesis::Stream' 'AWS::EC2::VPC' 'AWS::EC2::Subnet' 'AWS::EC2::InternetGateway' \
         'AWS::EC2::RouteTable' 'AWS::EC2::NetworkAcl' 'AWS::EC2::SecurityGroup'; do
  R="$(provisioned_for_type "${T}")"
  if [ -z "${R}" ]; then
    echo "[verify] FAIL: no ${T} in state (the fixture's resource of that type was not deployed)" >&2
    exit 1
  fi
  if [ "${R}" = "cc-api" ]; then
    echo "[verify] FAIL: ${T} provisionedBy='cc-api', expected 'sdk' (SDK tag path not exercised for this type)" >&2
    exit 1
  fi
done
echo "[verify]   ok: 15 SDK-path types routed via sdk"

# assert_tag <human-label> <newline-separated "key<TAB>value" pairs from AWS>
# Fails NAMING the type if any of the 3 stack tags is missing/wrong.
assert_all_tags() {
  local label="$1"
  local aws_pairs="$2"
  local i key val got
  for i in 0 1 2; do
    key="${EXPECTED_KEYS[$i]}"
    val="${EXPECTED_VALS[$i]}"
    # exact key match on the first field, emit the second field
    got="$(printf '%s\n' "${aws_pairs}" | awk -F'\t' -v k="${key}" '$1==k {print $2; found=1} END{if(!found) exit 0}')"
    if [ -z "${got}" ]; then
      echo "[verify] FAIL: ${label}: stack-level tag '${key}' is MISSING on AWS — this type DROPPED a propagated tag" >&2
      echo "[verify]   AWS-side tags were:" >&2
      printf '%s\n' "${aws_pairs}" >&2
      exit 1
    fi
    if [ "${got}" != "${val}" ]; then
      echo "[verify] FAIL: ${label}: tag '${key}' has value '${got}' on AWS, expected '${val}'" >&2
      exit 1
    fi
  done
  echo "[verify]   ok: ${label} carries all 3 stack-level tags"
}

echo "[verify] step 4: read live AWS tags per type + assert all 3 stack tags present"

# --- S3 Bucket: get-bucket-tagging -> TagSet[{Key,Value}] ---
S3_ID="$(physid_for_type 'AWS::S3::Bucket')"
S3_TAGS="$(aws s3api get-bucket-tagging --bucket "${S3_ID}" --region "${REGION}" \
  --query 'TagSet' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "S3 Bucket (${S3_ID})" "${S3_TAGS}"

# --- SNS Topic: list-tags-for-resource -> Tags[{Key,Value}] ---
SNS_ARN="$(physid_for_type 'AWS::SNS::Topic')"
SNS_TAGS="$(aws sns list-tags-for-resource --resource-arn "${SNS_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "SNS Topic (${SNS_ARN})" "${SNS_TAGS}"

# --- SQS Queue: list-queue-tags -> Tags{ k: v } map ---
SQS_URL="$(physid_for_type 'AWS::SQS::Queue')"
SQS_TAGS="$(aws sqs list-queue-tags --queue-url "${SQS_URL}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r 'to_entries[] | "\(.key)\t\(.value)"')"
assert_all_tags "SQS Queue (${SQS_URL})" "${SQS_TAGS}"

# --- SSM Parameter: list-tags-for-resource -> TagList[{Key,Value}]
#     (CFn Tags is a MAP -> the historical crash type) ---
SSM_NAME="$(physid_for_type 'AWS::SSM::Parameter')"
SSM_TAGS="$(aws ssm list-tags-for-resource --resource-type Parameter --resource-id "${SSM_NAME}" \
  --region "${REGION}" --query 'TagList' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "SSM Parameter (${SSM_NAME})" "${SSM_TAGS}"

# --- IAM Role: list-role-tags -> Tags[{Key,Value}] (IAM is global) ---
IAM_ROLE="$(physid_for_type 'AWS::IAM::Role')"
IAM_TAGS="$(aws iam list-role-tags --role-name "${IAM_ROLE}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "IAM Role (${IAM_ROLE})" "${IAM_TAGS}"

# --- Logs LogGroup: list-tags-for-resource -> tags{ k: v } map ---
LOG_NAME="$(physid_for_type 'AWS::Logs::LogGroup')"
LOG_ARN="arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_NAME}"
LOG_TAGS="$(aws logs list-tags-for-resource --resource-arn "${LOG_ARN}" --region "${REGION}" \
  --query 'tags' --output json | jq -r 'to_entries[] | "\(.key)\t\(.value)"')"
assert_all_tags "Logs LogGroup (${LOG_NAME})" "${LOG_TAGS}"

# --- Lambda Function: list-tags -> Tags{ k: v } map ---
FN_NAME="$(physid_for_type 'AWS::Lambda::Function')"
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FN_NAME}"
FN_TAGS="$(aws lambda list-tags --resource "${FN_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r 'to_entries[] | "\(.key)\t\(.value)"')"
assert_all_tags "Lambda Function (${FN_NAME})" "${FN_TAGS}"

# --- DynamoDB Table: list-tags-of-resource -> Tags[{Key,Value}] ---
DDB_NAME="$(physid_for_type 'AWS::DynamoDB::Table')"
DDB_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DDB_NAME}"
DDB_TAGS="$(aws dynamodb list-tags-of-resource --resource-arn "${DDB_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "DynamoDB Table (${DDB_NAME})" "${DDB_TAGS}"

# --- Kinesis Stream: list-tags-for-stream -> Tags[{Key,Value}] (go-to-k/cdkd#4971) ---
KIN_NAME="$(physid_for_type 'AWS::Kinesis::Stream')"
KIN_TAGS="$(aws kinesis list-tags-for-stream --stream-name "${KIN_NAME}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "Kinesis Stream (${KIN_NAME})" "${KIN_TAGS}"

# --- EC2 (go-to-k/cdkd#4971): describe-tags by resource id -> Tags[{Key,Value}] ---
for T in 'AWS::EC2::VPC' 'AWS::EC2::Subnet' 'AWS::EC2::InternetGateway' 'AWS::EC2::RouteTable' \
         'AWS::EC2::NetworkAcl' 'AWS::EC2::SecurityGroup'; do
  EC2_ID="$(physid_for_type "${T}")"
  EC2_TAGS="$(aws ec2 describe-tags --filters "Name=resource-id,Values=${EC2_ID}" --region "${REGION}" \
    --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
  assert_all_tags "${T#AWS::EC2::} (${EC2_ID})" "${EC2_TAGS}"
done

# --- Athena WorkGroup (CC-API path): list-tags-for-resource -> Tags[{Key,Value}] ---
WG_NAME="$(physid_for_type 'AWS::Athena::WorkGroup')"
WG_ARN="arn:aws:athena:${REGION}:${ACCOUNT_ID}:workgroup/${WG_NAME}"
WG_TAGS="$(aws athena list-tags-for-resource --resource-arn "${WG_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "Athena WorkGroup [CC-API] (${WG_NAME})" "${WG_TAGS}"

echo "[verify] step 5: cdkd drift immediately after deploy (expect exit 0, no #802 tag-order false positive)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: a clean deploy reported drift (exit ${rc}) — likely a tag-list reorder false positive (#802 canonicalizeTagListsDeep) or a tag-shape readback mismatch" >&2
  exit 1
fi
echo "[verify]   ok: clean deploy is drift-free (no tag-order false positive)"

echo "[verify] step 6: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_new_types_gone "${STATE}" "step 6"

# go-to-k/cdkd#4971, the other direction: a role WITHOUT ec2:CreateTags. The
# old post-create CreateTags only warned, so such a role could create the EC2
# resources untagged; a tagged create now needs ec2:CreateTags, and the
# provider re-sends a create denied it once without its tags, then tags with
# CreateTags (which warns again). The same role, its policy rewritten.
echo "[verify] step 7: redeploy as ${ROLE} with ec2:CreateTags explicitly denied (each EC2 create re-sent untagged)"
ROLE_POLICY_NO_TAGS="$(node -e '
const st = [
  { Effect: "Allow", Action: "*", Resource: "*" },
  { Effect: "Deny", Action: "ec2:CreateTags", Resource: "*" },
];
process.stdout.write(JSON.stringify({ Version: "2012-10-17", Statement: st }));')"
aws iam put-role-policy --role-name "${ROLE}" --policy-name "${POLICY_NAME}" \
  --policy-document "${ROLE_POLICY_NO_TAGS}"
# The rewrite must bind before the deploy: a TAGGED dry-run CreateVpc meets
# the explicit deny on ec2:CreateTags, and the untagged one is allowed (the
# request-tag deny of step 1b no longer applies). A dry-run CreateTags on a
# placeholder id cannot show the deny: EC2 checks the resource exists first
# (InvalidVpcID.NotFound, measured).
TAGS_DENY_BOUND=""
for _ in $(seq 1 24); do
  TAG_PROBE="$(as_role aws ec2 create-vpc --dry-run --cidr-block 10.98.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=probe,Value=1}]' --region "${REGION}" 2>&1 || true)"
  REQ_PROBE="$(as_role aws ec2 create-vpc --dry-run --cidr-block 10.98.0.0/16 \
    --region "${REGION}" 2>&1 || true)"
  if printf '%s' "${TAG_PROBE}" | grep -qF 'ec2:CreateTags' \
    && printf '%s' "${TAG_PROBE}" | grep -qi 'explicit deny' \
    && printf '%s' "${REQ_PROBE}" | grep -qF 'DryRunOperation'; then
    TAGS_DENY_BOUND=1
    break
  fi
  sleep 5
done
if [ -z "${TAGS_DENY_BOUND}" ]; then
  echo "[verify] FAIL: precondition -- ${ROLE}'s ec2:CreateTags deny never bound within 2 minutes (tagged CreateVpc: ${TAG_PROBE}; untagged CreateVpc: ${REQ_PROBE})" >&2
  exit 1
fi
NO_TAGS_LOG="$(mktemp)"
set +e
as_role node "${REPO_ROOT}/dist/cli.js" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose \
  > "${NO_TAGS_LOG}" 2>&1
NO_TAGS_RC=$?
set -e
NO_TAGS_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${NO_TAGS_LOG}" | tr '\n' ' ' | tr -s ' ')"
rm -f "${NO_TAGS_LOG}"
if [ "${NO_TAGS_RC}" -ne 0 ]; then
  printf '%s\n' "${NO_TAGS_FLAT}" | tail -c 4000 >&2
  echo "[verify] FAIL: the deploy as ${ROLE} without ec2:CreateTags exited ${NO_TAGS_RC}; a role that could create the EC2 resources untagged before go-to-k/cdkd#4971 must still deploy" >&2
  exit 1
fi
for LID in TaggedVpc TaggedSubnet TaggedInternetGateway TaggedRouteTable TaggedNetworkAcl TaggedSecurityGroup; do
  if ! grep -qF "Create of ${LID} with tags was denied ec2:CreateTags" <<<"${NO_TAGS_FLAT}"; then
    echo "[verify] FAIL: ${LID}'s tagged create was not re-sent untagged after its ec2:CreateTags denial (go-to-k/cdkd#4971)" >&2
    exit 1
  fi
  if ! grep -qF "Failed to apply tags to ${LID}" <<<"${NO_TAGS_FLAT}"; then
    echo "[verify] FAIL: ${LID} was not tagged by the follow-up CreateTags (expected its denial warning)" >&2
    exit 1
  fi
done
STATE_7=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
for T in 'AWS::EC2::VPC' 'AWS::EC2::Subnet' 'AWS::EC2::InternetGateway' 'AWS::EC2::RouteTable' \
         'AWS::EC2::NetworkAcl' 'AWS::EC2::SecurityGroup'; do
  EC2_ID="$(echo "${STATE_7}" | jq -r --arg t "${T}" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""')"
  if [ -z "${EC2_ID}" ]; then
    echo "[verify] FAIL: no ${T} in state after the step-7 deploy" >&2
    exit 1
  fi
  OWNER="$(aws ec2 describe-tags --filters "Name=resource-id,Values=${EC2_ID}" "Name=key,Values=CdkdTagOwner" \
    --region "${REGION}" --query 'length(Tags)' --output text)"
  if [ "${OWNER}" != "0" ]; then
    echo "[verify] FAIL: ${T} (${EC2_ID}) carries CdkdTagOwner although ec2:CreateTags was denied -- the deny did not bind" >&2
    exit 1
  fi
done
echo "[verify]   ok: each EC2 create was re-sent untagged and the deploy succeeded"

echo "[verify] step 8: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_new_types_gone "${STATE_7}" "step 8"

trap - EXIT INT TERM
# No probe resource to delete here: an ALLOWED probe exits the run at step 1b.
delete_role
if ! ( gone_probe aws iam get-role --role-name "${ROLE}" ); then
  echo "[verify] FAIL: role ${ROLE} could not be confirmed deleted; delete it by hand: aws iam delete-role-policy --role-name ${ROLE} --policy-name ${POLICY_NAME}; aws iam delete-role --role-name ${ROLE}" >&2
  exit 1
fi
echo "[verify] PASS"
