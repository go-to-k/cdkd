#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt of the RDS DBInstance / DBCluster and DocumentDB
# DBCluster read-only attributes cdkd used to refuse (issue #6242, tail).
#
# Phase 1 deploys an RDS instance, an instance-less Aurora cluster, a
# DocumentDB serverless v2 cluster with one instance, and an echo custom
# resource fed the whole `Endpoint` / `CertificateDetails` / `ReadEndpoint`
# objects, the lists, the boolean, the status and the timestamps; each echoed
# value must equal the shape CloudFormation serves (measured, us-east-1,
# 2026-11-14) built from DescribeDBInstances / DescribeDBClusters. Phase 2
# (CDKD_TEST_UPDATE=true) adds `ServerlessV2PlatformVersion` (from the create's
# record, or from the re-read a record lacking it triggers), which must equal
# DescribeDBClusters and end up on the record. Then destroys clean.
# Runtime: ~25 min (RDS instance, Aurora and DocumentDB creates + deletes).

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

STACK="CdkdGetattRdsDocdbAttributesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
NAME="cdkdgetattrdsdocdbattributesexample"
DB_ID="${NAME}-db"
CL_ID="${NAME}-cl"
DOC_ID="${NAME}-doc"
DOC_INSTANCE_ID="${NAME}-doc-1"
DB_SUBNETS="${NAME}-db"
DOC_SUBNETS="${NAME}-doc"
FUNCTION_NAME="${STACK}-echo"
ROLE_NAME="${STACK}-echo"
LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The VPC carries this Name tag (the stack sets it), so cleanup finds it, and
# its subnets, with no state of this run: a pre-run cleanup sweeps a VPC an
# earlier, interrupted run left behind.
VPC_NAME="${STACK}-vpc"

# Poll until a probe reports the resource gone (bounded; cleanup only).
wait_gone() { # usage: wait_gone <max seconds> aws <service> <read-verb> [args...]
  local deadline=$((SECONDS + $1))
  shift
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if ! "$@" >/dev/null 2>&1; then return 0; fi
    sleep 15
  done
}

# Run a delete, retrying while AWS answers DependencyViolation (bounded;
# cleanup only). Any other failure (already gone included) ends the retry.
retry_dependency() { # usage: retry_dependency <max seconds> aws <service> <verb> [args...]
  local deadline=$((SECONDS + $1)) out
  shift
  while :; do
    if out="$("$@" 2>&1)"; then return 0; fi
    grep -q 'DependencyViolation' <<<"${out}" || return 0
    [ "${SECONDS}" -lt "${deadline}" ] || { echo "WARN: still DependencyViolation: $*" >&2; return 0; }
    sleep 20
  done
}

# Poll until a command prints 0 (bounded). rc 1 when it never does, or when the
# command fails, so an unreadable listing never reads as "none".
wait_zero() { # usage: wait_zero <max seconds> <command printing a count...>
  local deadline=$((SECONDS + $1)) n
  shift
  while :; do
    n="$("$@")" || return 1
    [ "${n}" = "0" ] && return 0
    [ "${SECONDS}" -lt "${deadline}" ] || return 1
    sleep 20
  done
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Instances before their clusters (a cluster with a member refuses the
  # delete), clusters before the subnet groups, those before the subnets.
  aws rds delete-db-instance --region "${REGION}" --db-instance-identifier "${DB_ID}" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || true
  aws docdb delete-db-instance --region "${REGION}" --db-instance-identifier "${DOC_INSTANCE_ID}" >/dev/null 2>&1 || true
  wait_gone 1500 aws docdb describe-db-instances --region "${REGION}" --db-instance-identifier "${DOC_INSTANCE_ID}"
  aws docdb delete-db-cluster --region "${REGION}" --db-cluster-identifier "${DOC_ID}" \
    --skip-final-snapshot >/dev/null 2>&1 || true
  aws rds delete-db-cluster --region "${REGION}" --db-cluster-identifier "${CL_ID}" \
    --skip-final-snapshot >/dev/null 2>&1 || true
  wait_gone 1500 aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "${DB_ID}"
  wait_gone 1500 aws rds describe-db-clusters --region "${REGION}" --db-cluster-identifier "${CL_ID}"
  wait_gone 1500 aws docdb describe-db-clusters --region "${REGION}" --db-cluster-identifier "${DOC_ID}"
  aws rds delete-db-subnet-group --region "${REGION}" --db-subnet-group-name "${DB_SUBNETS}" >/dev/null 2>&1 || true
  aws docdb delete-db-subnet-group --region "${REGION}" --db-subnet-group-name "${DOC_SUBNETS}" >/dev/null 2>&1 || true
  # Automated backups and any snapshot of this run's identifiers.
  local id arn
  for arn in $(aws rds describe-db-instance-automated-backups --region "${REGION}" --db-instance-identifier "${DB_ID}" \
    --query 'DBInstanceAutomatedBackups[].DBInstanceAutomatedBackupsArn' --output text 2>/dev/null); do
    aws rds delete-db-instance-automated-backup --region "${REGION}" --db-instance-automated-backups-arn "${arn}" >/dev/null 2>&1 || true
  done
  for id in $(aws rds describe-db-snapshots --region "${REGION}" --db-instance-identifier "${DB_ID}" --snapshot-type manual \
    --query 'DBSnapshots[].DBSnapshotIdentifier' --output text 2>/dev/null); do
    aws rds delete-db-snapshot --region "${REGION}" --db-snapshot-identifier "${id}" >/dev/null 2>&1 || true
  done
  for id in $(aws rds describe-db-cluster-snapshots --region "${REGION}" --db-cluster-identifier "${CL_ID}" --snapshot-type manual \
    --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier' --output text 2>/dev/null); do
    aws rds delete-db-cluster-snapshot --region "${REGION}" --db-cluster-snapshot-identifier "${id}" >/dev/null 2>&1 || true
  done
  for id in $(aws docdb describe-db-cluster-snapshots --region "${REGION}" --db-cluster-identifier "${DOC_ID}" --snapshot-type manual \
    --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier' --output text 2>/dev/null); do
    aws docdb delete-db-cluster-snapshot --region "${REGION}" --db-cluster-snapshot-identifier "${id}" >/dev/null 2>&1 || true
  done
  # The VPC by its Name tag. RDS releases a deleted instance's network
  # interfaces some minutes later, and a subnet / VPC delete answers
  # DependencyViolation until then: retry, bounded.
  local vpc subnet
  for vpc in $(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${VPC_NAME}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" \
      --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      retry_dependency 1200 aws ec2 delete-subnet --region "${REGION}" --subnet-id "${subnet}"
    done
    retry_dependency 600 aws ec2 delete-vpc --region "${REGION}" --vpc-id "${vpc}"
  done
  aws lambda delete-function --region "${REGION}" --function-name "${FUNCTION_NAME}" >/dev/null 2>&1 || true
  aws iam detach-role-policy --role-name "${ROLE_NAME}" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP}" >/dev/null 2>&1 || true
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

state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }

output_of() { # usage: output_of <output key>
  local state
  state="$(state_json)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

expect_json() { # usage: expect_json <label> <actual JSON> <expected JSON>
  local actual expected
  actual="$(jq -cS . <<<"$2")" || { echo "FAIL: $1 is not JSON: '$2'" >&2; exit 1; }
  expected="$(jq -cS . <<<"$3")"
  if [ "${actual}" != "${expected}" ]; then
    echo "FAIL: $1 is ${actual}, expected ${expected}" >&2
    exit 1
  fi
  echo "    OK: $1 == ${expected}"
}

# CloudFormation renders a timestamp as Java's Instant.toString(): UTC, `Z`,
# the fraction only when non-zero (millisecond precision here).
java_instant() { # usage: java_instant <timestamp the CLI printed>
  node -e 'process.stdout.write(JSON.stringify(new Date(process.argv[1]).toISOString().replace(".000Z", "Z")))' "$1"
}

# Describes through the AWS SDK for JavaScript (cdkd's own client, resolved from
# the repository's node_modules): an older AWS CLI drops members its model
# predates (DocumentDB's ServerlessV2PlatformVersion, RDS's
# StorageEncryptionType), which would read as absent. Dates print as ISO text.
sdk_describe() { # usage: sdk_describe rds-instance|rds-cluster|docdb-cluster <identifier>
  node --input-type=module -e '
    const [kind, id, region] = process.argv.slice(1);
    const rds = kind.startsWith("rds");
    const sdk = await import(rds ? "@aws-sdk/client-rds" : "@aws-sdk/client-docdb");
    const client = new (rds ? sdk.RDSClient : sdk.DocDBClient)({ region });
    const out = kind === "rds-instance"
      ? (await client.send(new sdk.DescribeDBInstancesCommand({ DBInstanceIdentifier: id }))).DBInstances[0]
      : (await client.send(new sdk.DescribeDBClustersCommand({ DBClusterIdentifier: id }))).DBClusters[0];
    process.stdout.write(JSON.stringify(out));
  ' "$1" "$2" "${REGION}"
}

deploy() { # usage: deploy <phase label>
  local log
  log="$(mktemp)"
  echo "==> Deploy ($1)"
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${log}"
  if grep -E 'Unknown attribute' "${log}"; then
    echo "FAIL: a physical-id fallback warning was printed (see above)" >&2
    rm -f "${log}"
    exit 1
  fi
  rm -f "${log}"
}

deploy "create"

# The VPC / subnet ids, for the gone-probes.
VPC_ID="$(output_of VpcId)"
SUBNET_IDS="$(output_of SubnetIds)"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: VpcId output '${VPC_ID}'" >&2; exit 1 ;; esac

# The fix is on the SDK providers' path; a Cloud Control record would pass
# this fixture without exercising it.
STATE="$(state_json)"
for type in AWS::RDS::DBInstance AWS::RDS::DBCluster AWS::DocDB::DBCluster; do
  route="$(jq -r --arg t "${type}" '[.resources[] | select(.resourceType == $t) | .provisionedBy // "<absent>"] | first // "<no record>"' <<<"${STATE}")"
  if [ "${route}" != "sdk" ]; then
    echo "FAIL: ${type} was provisioned by '${route:-<none>}', not the SDK provider" >&2
    exit 1
  fi
  echo "    OK: ${type} provisioned by the SDK provider (${route})"
done

DB="$(sdk_describe rds-instance "${DB_ID}")"
CL="$(sdk_describe rds-cluster "${CL_ID}")"
ECHO="$(output_of Echo)"
[ -n "${ECHO}" ] || { echo "FAIL: no Echo output" >&2; exit 1; }
echoed() { jq -c --arg k "$1" '.[$k]' <<<"${ECHO}"; }

expect_json "Db Endpoint" "$(echoed DbEndpoint)" \
  "$(jq -c '.Endpoint | {Address, HostedZoneId, Port: (.Port | tostring)}' <<<"${DB}")"
expect_json "Db CertificateDetails" "$(echoed DbCertificateDetails)" \
  "$(jq -c --argjson v "$(java_instant "$(jq -r '.CertificateDetails.ValidTill' <<<"${DB}")")" \
    '{CAIdentifier: .CertificateDetails.CAIdentifier, ValidTill: $v}' <<<"${DB}")"
expect_json "Db StatusInfos" "$(echoed DbStatusInfos)" "$(jq -c '.StatusInfos // []' <<<"${DB}")"
expect_json "Db ReadReplicaDBInstanceIdentifiers" "$(echoed DbReadReplicaDBInstanceIdentifiers)" \
  "$(jq -c '.ReadReplicaDBInstanceIdentifiers // []' <<<"${DB}")"
expect_json "Db ReadReplicaDBClusterIdentifiers" "$(echoed DbReadReplicaDBClusterIdentifiers)" \
  "$(jq -c '.ReadReplicaDBClusterIdentifiers // []' <<<"${DB}")"
expect_json "Db DBInstanceStatus" "$(echoed DbDBInstanceStatus)" '"available"'
expect_json "Db InstanceCreateTime" "$(echoed DbInstanceCreateTime)" \
  "$(java_instant "$(jq -r '.InstanceCreateTime' <<<"${DB}")")"
# cdkd's custom-resource property serializer turns a boolean or a number into
# a string (go-to-k/cdkd#6309; CloudFormation keeps the GetAtt's type), so the
# echoed scalar is compared by value; its TYPE is checked on the record below.
expect_json "Db IsStorageConfigUpgradeAvailable" "$(echoed DbIsStorageConfigUpgradeAvailable | jq -c 'tostring')" \
  "$(jq -c '.IsStorageConfigUpgradeAvailable | tostring' <<<"${DB}")"
# RDS advances LatestRestorableTime every few minutes: the recorded one is the
# value at the create, so it is a Java-rendered instant no later than now.
RESTORABLE="$(echoed DbLatestRestorableTime)"
node -e '
  const v = JSON.parse(process.argv[1]), live = new Date(process.argv[2]);
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(v) || new Date(v) > live) {
    console.error(`FAIL: Db LatestRestorableTime ${process.argv[1]} (live ${process.argv[2]})`); process.exit(1);
  }' "${RESTORABLE}" "$(jq -r '.LatestRestorableTime' <<<"${DB}")"
echo "    OK: Db LatestRestorableTime ${RESTORABLE}"

expect_json "Cluster Endpoint" "$(echoed ClEndpoint)" "$(jq -c '{Address: .Endpoint, Port: (.Port | tostring)}' <<<"${CL}")"
expect_json "Cluster ReadEndpoint" "$(echoed ClReadEndpoint)" "$(jq -c '{Address: .ReaderEndpoint}' <<<"${CL}")"
expect_json "Cluster StorageEncryptionType" "$(echoed ClStorageEncryptionType)" "$(jq -c '.StorageEncryptionType' <<<"${CL}")"
expect_json "Cluster StorageEncryptionType value" "$(echoed ClStorageEncryptionType)" '"sse-kms"'

# #6913: the managed master-user secret ARNs, as RDS reports them.
for pair in "Db:${DB}" "Cl:${CL}"; do
  label="${pair%%:*}"
  live="$(jq -c '.MasterUserSecret.SecretArn' <<<"${pair#*:}")"
  case "${live}" in '"arn:'*':secretsmanager:'*) ;; *) echo "FAIL: ${label} describe reports no MasterUserSecret.SecretArn: ${live}" >&2; exit 1 ;; esac
  expect_json "${label} MasterUserSecret.SecretArn" "$(echoed "${label}MasterUserSecretArn")" "${live}"
done
# The cluster's StorageThroughput is recorded as RDS reports it (absent: null both sides).
expect_json "Cluster record StorageThroughput" \
  "$(state_json | jq -c '[.resources[] | select(.resourceType == "AWS::RDS::DBCluster") | .attributes.StorageThroughput] | first')" \
  "$(jq -c '.StorageThroughput' <<<"${CL}")"

# A dotted member and the whole object come from one record.
expect_json "Db Endpoint.Address == Endpoint.Address" "\"$(output_of DbEndpointAddress)\"" "$(jq -c '.DbEndpoint.Address' <<<"${ECHO}")"
expect_json "Db Endpoint.Port == Endpoint.Port" "\"$(output_of DbEndpointPort)\"" "$(jq -c '.DbEndpoint.Port' <<<"${ECHO}")"
expect_json "Cluster Endpoint.Address == Endpoint.Address" "\"$(output_of ClEndpointAddress)\"" "$(jq -c '.ClEndpoint.Address' <<<"${ECHO}")"

# The recorded types, as CloudFormation serves them: a boolean, lists, string
# object members. Run after each deploy (an update replaces the record).
expect_record_types() { # usage: expect_record_types <phase label>
  local state
  state="$(state_json)"
  if ! jq -e '
      ([.resources[] | select(.resourceType == "AWS::RDS::DBInstance") | .attributes] | first) as $db
      | ([.resources[] | select(.resourceType == "AWS::RDS::DBCluster") | .attributes] | first) as $cl
      | ($db.IsStorageConfigUpgradeAvailable | type) == "boolean"
      and ($db.StatusInfos | type) == "array"
      and ($db.ReadReplicaDBInstanceIdentifiers | type) == "array"
      and ($db.ReadReplicaDBClusterIdentifiers | type) == "array"
      and ([$db["Endpoint.Address"], $db["Endpoint.Port"], $db["Endpoint.HostedZoneId"],
            $db["CertificateDetails.CAIdentifier"], $db["CertificateDetails.ValidTill"],
            $cl["Endpoint.Address"], $cl["Endpoint.Port"], $cl["ReadEndpoint.Address"]]
           | all(type == "string"))' <<<"${state}" >/dev/null; then
    echo "FAIL: ($1) a recorded attribute has the wrong JSON type" >&2
    exit 1
  fi
  echo "    OK: ($1) recorded types: boolean, arrays, string members"
}
expect_record_types "create"

CDKD_TEST_UPDATE=true deploy "update: reference ServerlessV2PlatformVersion"
expect_record_types "update"
DOC_VERSION="$(sdk_describe docdb-cluster "${DOC_ID}" | jq -c '.ServerlessV2PlatformVersion')"
[ "${DOC_VERSION}" != "null" ] || { echo "FAIL: DocumentDB reports no ServerlessV2PlatformVersion" >&2; exit 1; }
ECHO="$(output_of Echo)"
expect_json "DocDB ServerlessV2PlatformVersion" "$(echoed DocServerlessV2PlatformVersion)" "${DOC_VERSION}"
# The re-read value is persisted on the record.
expect_json "DocDB record ServerlessV2PlatformVersion" \
  "$(state_json | jq -c '[.resources[] | select(.resourceType == "AWS::DocDB::DBCluster") | .attributes.ServerlessV2PlatformVersion] | first')" \
  "${DOC_VERSION}"

# The AWS-managed master-user secrets (`rds!db-...`, `rds!cluster-...`),
# read before the destroy so their removal can be proved.
SECRET_ARNS="$(
  for spec in "rds-instance ${DB_ID}" "rds-cluster ${CL_ID}" "docdb-cluster ${DOC_ID}"; do
    # shellcheck disable=SC2086
    sdk_describe ${spec} | jq -r '.MasterUserSecret.SecretArn // empty'
  done
)"
[ "$(wc -w <<<"${SECRET_ARNS}" | tr -d ' ')" -eq 3 ] || { echo "FAIL: expected 3 managed master-user secrets, read: ${SECRET_ARNS}" >&2; exit 1; }

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "DB instance ${DB_ID} still exists after destroy" aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "${DB_ID}"
assert_gone "DB cluster ${CL_ID} still exists after destroy" aws rds describe-db-clusters --region "${REGION}" --db-cluster-identifier "${CL_ID}"
assert_gone "DocumentDB instance ${DOC_INSTANCE_ID} still exists after destroy" aws docdb describe-db-instances --region "${REGION}" --db-instance-identifier "${DOC_INSTANCE_ID}"
assert_gone "DocumentDB cluster ${DOC_ID} still exists after destroy" aws docdb describe-db-clusters --region "${REGION}" --db-cluster-identifier "${DOC_ID}"
assert_gone "echo function ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --region "${REGION}" --function-name "${FUNCTION_NAME}"
assert_gone "echo role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "RDS subnet group ${DB_SUBNETS} still exists after destroy" aws rds describe-db-subnet-groups --region "${REGION}" --db-subnet-group-name "${DB_SUBNETS}"
assert_gone "DocumentDB subnet group ${DOC_SUBNETS} still exists after destroy" aws docdb describe-db-subnet-groups --region "${REGION}" --db-subnet-group-name "${DOC_SUBNETS}"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
for subnet in ${SUBNET_IDS}; do
  assert_gone "subnet ${subnet} still exists after destroy" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${subnet}"
done
# A log group still listed under the exact name is a leak; the describe call
# answers an empty list, not an error, when it is gone.
if [ "$(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "${LOG_GROUP}" \
  --query "length(logGroups[?logGroupName=='${LOG_GROUP}'])" --output text)" != "0" ]; then
  echo "FAIL: log group ${LOG_GROUP} still exists after destroy" >&2
  exit 1
fi
# A managed secret is gone, or scheduled for deletion (DeletedDate).
for arn in ${SECRET_ARNS}; do
  if out="$(aws secretsmanager describe-secret --region "${REGION}" --secret-id "${arn}" 2>&1)"; then
    if [ "$(jq -r '.DeletedDate // empty' <<<"${out}")" = "" ]; then
      echo "FAIL: managed secret ${arn} still exists after destroy" >&2
      exit 1
    fi
  elif ! grep -q 'ResourceNotFoundException' <<<"${out}"; then
    echo "FAIL: secret probe undetermined (${arn}): ${out}" >&2
    exit 1
  fi
done
echo "    OK: managed master-user secrets gone or scheduled for deletion"

# Automated backups and snapshots: the automated ones take a few minutes to
# vanish after the delete, so poll (bounded).
count_of() { # usage: count_of <jq length path> aws ...
  local path="$1" out
  shift
  out="$("$@" --output json 2>&1)" || {
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}" && { echo 0; return 0; }
    echo "FAIL: listing undetermined ($*): ${out}" >&2
    return 1
  }
  jq -r "${path} | length" <<<"${out}"
}
wait_zero 900 count_of '.DBInstanceAutomatedBackups' aws rds describe-db-instance-automated-backups --region "${REGION}" --db-instance-identifier "${DB_ID}" \
  || { echo "FAIL: automated backups of ${DB_ID} remain after destroy" >&2; exit 1; }
wait_zero 900 count_of '.DBSnapshots' aws rds describe-db-snapshots --region "${REGION}" --db-instance-identifier "${DB_ID}" \
  || { echo "FAIL: snapshots of ${DB_ID} remain after destroy" >&2; exit 1; }
wait_zero 900 count_of '.DBClusterSnapshots' aws rds describe-db-cluster-snapshots --region "${REGION}" --db-cluster-identifier "${CL_ID}" \
  || { echo "FAIL: snapshots of ${CL_ID} remain after destroy" >&2; exit 1; }
wait_zero 900 count_of '.DBClusterSnapshots' aws docdb describe-db-cluster-snapshots --region "${REGION}" --db-cluster-identifier "${DOC_ID}" \
  || { echo "FAIL: snapshots of ${DOC_ID} remain after destroy" >&2; exit 1; }
echo "    OK: no automated backups or snapshots remain"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: instances, clusters, subnet groups, VPC, subnets, function, role, log group and state gone"

echo ""
echo "[verify] PASS — getatt-rds-docdb-attributes: the RDS instance / cluster and DocumentDB cluster read-only attributes match DescribeDBInstances / DescribeDBClusters in CloudFormation's shape"
