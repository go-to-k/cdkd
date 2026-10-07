#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the RDS arm: a fix-forward deploy deletes the DB cluster
# and DB instance an earlier failed CREATE left in AWS, once a live read
# (`RDSProvider.isSameResource`) proves each is not the resource the new state
# record holds.
#
# Phases:
#   1. Baseline deploy: an isolated VPC and a DB subnet group.
#   2. The failed CREATE. A role is created that may create a DB cluster and
#      a DB instance but may not describe either, nor delete the cluster. A
#      `--no-rollback` deploy run as that role with WITH_ORPHANS=true creates
#      both, and each CREATE then fails: the instance's available-wait cannot
#      describe it, and the cluster's wait fails too while its self-cleanup
#      delete is refused. Asserted: the deploy failed, both exist in AWS, no
#      state record holds them, and the rollback journal carries each as a
#      proven orphan under its identifier, with its resource id as the
#      identity the settle compares (go-to-k/cdkd#4655).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps both
#      logical ids under other identifiers (`-b`). Asserted: the deploy exits
#      0, deletes both earlier resources (`deleting partially-created ...`),
#      never warns about them, drops the journal, and the state records hold
#      the new, live resources. Before #4606 it exited 2, warned and left both.
#   4. Destroy, and everything (both generations, the subnet group, the VPC,
#      the state file) is gone. The state prefix's object versions are swept:
#      the template's literal master password is in the journal's history.
#
# Cost: one Aurora cluster with no instance and one db.t3.micro instance per
# generation. A run takes roughly 40 minutes (two instance creates and two
# deletes). On any failure, cleanup deletes all four by identifier, destroys
# the stack and deletes the role.
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
STACK="CdkdRdsFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rds-fix-forward-orphan"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096): the template's literal
# master password reaches the journal's `attemptedProperties` and the state
# records, and the state bucket is versioned. Sourced by absolute path, before
# the `cd` below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The identifiers the stack derives from its lower-cased name.
ID_PREFIX="$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')"
CLUSTER_A="${ID_PREFIX}-orphan-cluster"
CLUSTER_B="${ID_PREFIX}-orphan-cluster-b"
DB_A="${ID_PREFIX}-orphan-db"
DB_B="${ID_PREFIX}-orphan-db-b"

DENY_ROLE="${STACK}-no-rds-describe"
DENY_POLICY_NAME="create-without-describe"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the four identifiers or
# the stack may belong to a concurrent or earlier run, which a failure-path
# delete must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

TIMEOUT_OVERRIDES=(
  --resource-timeout AWS::RDS::DBCluster=40m
  --resource-timeout AWS::RDS::DBInstance=40m
)

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# Best-effort deletes by identifier, for cleanup only. A member still
# `creating` refuses its delete, so each waits for `available` first.
delete_instance_by_id() { ( # usage: delete_instance_by_id <identifier>
  set +eu
  aws rds wait db-instance-available --db-instance-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  aws rds delete-db-instance --db-instance-identifier "$1" --skip-final-snapshot \
    --delete-automated-backups --region "${REGION}" >/dev/null 2>&1
  aws rds wait db-instance-deleted --db-instance-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
delete_cluster_by_id() { ( # usage: delete_cluster_by_id <identifier>
  set +eu
  aws rds wait db-cluster-available --db-cluster-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  aws rds delete-db-cluster --db-cluster-identifier "$1" --skip-final-snapshot \
    --region "${REGION}" >/dev/null 2>&1
  aws rds wait db-cluster-deleted --db-cluster-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
delete_deny_role() { ( # usage: delete_deny_role
  set +eu
  aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null 2>&1
  true
); }

cleanup() {
  rc=$?
  set +eu
  rm -rf "${LOG_DIR}"
  if [ -n "${DENY_ROLE_CREATED}" ]; then
    delete_deny_role
    for _ in $(seq 1 12); do
      if ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then break; fi
      sleep 5
    done
    if ! ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then
      echo "[verify] WARN: role ${DENY_ROLE} could not be confirmed deleted; delete it by hand" >&2
    fi
  fi
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    # Instances first: a subnet group in use refuses the destroy's delete.
    delete_instance_by_id "${DB_A}"
    delete_instance_by_id "${DB_B}"
    delete_cluster_by_id "${CLUSTER_A}"
    delete_cluster_by_id "${CLUSTER_B}"
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force "${TIMEOUT_OVERRIDES[@]}")
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  # NONCURRENT only, per ../s3-versions.sh: on a failure a live state.json may
  # be the only record of what is still standing. The success path sweeps all.
  if [ -n "${CLEANUP_ARMED}" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
  fi
  exit "${rc}"
}
trap cleanup EXIT
# Drop the EXIT trap first: the signal handler's own `exit` would otherwise
# run the (slow) cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# A record or resource left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for id in "${CLUSTER_A}" "${CLUSTER_B}"; do
  assert_gone "precondition: DB cluster ${id} already exists (left by an earlier run); delete it first" \
    aws rds describe-db-clusters --db-cluster-identifier "${id}" --region "${REGION}"
done
for id in "${DB_A}" "${DB_B}"; do
  assert_gone "precondition: DB instance ${id} already exists (left by an earlier run); delete it first" \
    aws rds describe-db-instances --db-instance-identifier "${id}" --region "${REGION}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (VPC + DB subnet group)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 2: a role that may create RDS clusters and instances but not describe them"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls, never `*`. The S3 verbs are the state
# path's (src/state/{s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts): HeadBucket
# and ListObjectsV2 (ListBucket), ListObjectVersions, GetBucketLocation and
# GetBucketReplication on the bucket; Get/Head/Put/DeleteObject and a
# versioned DeleteObjects on this stack's keys only. The exports index is
# written on a successful deploy only, which this one is not. The create calls are allowed;
# DescribeDBClusters / DescribeDBInstances (every available-wait) and
# DeleteDBCluster (the cluster's self-cleanup) are denied, so both CREATEs
# fail after AWS made the resource.
DENY_POLICY="$(node -e 'const [bucket,stack]=process.argv.slice(1);process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["rds:CreateDBCluster","rds:CreateDBInstance","rds:AddTagsToResource","rds:ListTagsForResource","rds:Describe*","ec2:Describe*","cloudformation:Describe*","cloudformation:List*","ssm:GetParameter","ssm:GetParameters","kms:Decrypt","kms:GenerateDataKey","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["rds:DescribeDBClusters","rds:DescribeDBInstances","rds:DeleteDBCluster"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=rds-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-rds-fix-forward \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  DENY_CREDS=""
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "[verify] FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped.
# Exported inside a subshell rather than passed as `env VAR=value` arguments,
# so the keys never sit in a process's argv.
as_deny_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
# Credentials from a role created seconds ago can be refused for a while, so
# poll until STS accepts them, naming the last refusal if it never does.
DENY_ARN=""
deny_id_err=""
for _ in $(seq 1 24); do
  if DENY_ARN="$(as_deny_role aws sts get-caller-identity --query Arn --output text 2>"${LOG_DIR}/id-err")"; then
    break
  fi
  DENY_ARN=""
  deny_id_err="$(cat "${LOG_DIR}/id-err" 2>/dev/null || true)"
  sleep 5
done
if [ -z "${DENY_ARN}" ]; then
  echo "[verify] FAIL: precondition -- STS never accepted ${DENY_ROLE}'s credentials within 2 minutes (last answer: ${deny_id_err})" >&2
  exit 1
fi
case "${DENY_ARN}" in
  *":assumed-role/${DENY_ROLE}/"*) ;;
  *)
    echo "[verify] FAIL: precondition -- the role's commands run as '${DENY_ARN}', not ${DENY_ROLE}" >&2
    exit 1
    ;;
esac
# The EXPLICIT deny must already bind: before the inline policy propagates,
# the role is refused everything implicitly (the same AccessDenied), and the
# deploy below would then fail before any CREATE for the wrong reason.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws rds describe-db-clusters --max-records 20 --region "${REGION}" 2>&1)"; then
    DENY_PROBE=""
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DescribeDBClusters never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: both CREATEs fail after AWS made the resource"
set +e
as_deny_role env -u ORPHAN_FIX_FORWARD WITH_ORPHANS=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback "${TIMEOUT_OVERRIDES[@]}" > "${LOG_DIR}/inject.log" 2>&1
INJECT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/inject.log" || true
# The role is not needed again. Still flagged until confirmed gone, so a
# failure here leaves cleanup to retry the delete.
delete_deny_role
# IAM is eventually consistent: a get-role right after delete-role can still
# answer, so poll before the one assertion.
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${INJECT_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the --no-rollback deploy as ${DENY_ROLE} unexpectedly SUCCEEDED" >&2
  exit 1
fi
if ! CLUSTER_A_RID="$(aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_A}" --region "${REGION}" \
  --query 'DBClusters[0].DbClusterResourceId' --output text)"; then
  echo "[verify] FAIL: DB cluster ${CLUSTER_A} does not exist after step 2 -- its CREATE failed before CreateDBCluster returned (output above)" >&2
  exit 1
fi
if ! DB_A_RID="$(aws rds describe-db-instances --db-instance-identifier "${DB_A}" --region "${REGION}" \
  --query 'DBInstances[0].DbiResourceId' --output text)"; then
  echo "[verify] FAIL: DB instance ${DB_A} does not exist after step 2 -- its CREATE failed before CreateDBInstance returned (output above)" >&2
  exit 1
fi
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in OrphanCluster OrphanInstance; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# go-to-k/cdkd#4655: the journal also carries the identity the settle compares
# before deleting a name-keyed orphan, the resource id. The failed CREATE's
# describes are denied here, so it is the id the create call returned; it
# must equal what AWS reports for the resource now.
assert_journaled() { # usage: assert_journaled <logicalId> <identifier> <resource id>
  local op
  op="$(printf '%s' "${JOURNAL_2}" | jq -c --arg l "$1" '[.segments[-1].failedOperations[]? | select(.logicalId == $l)] | first // empty')" || return 1
  if [ -z "${op}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalId // "<absent>"')" != "$2" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.createdResourceIdentity // "<absent>"')" != "$3" ]; then
    echo "[verify] FAIL: the journal does not carry $1's proven id $2 with its resource id $3 after step 2 (op: ${op:-<none>})" >&2
    exit 1
  fi
}
case "${CLUSTER_A_RID}" in cluster-?*) ;; *)
  echo "[verify] FAIL: ${CLUSTER_A}'s DbClusterResourceId reads '${CLUSTER_A_RID}' (expected cluster-...)" >&2
  exit 1 ;;
esac
case "${DB_A_RID}" in db-?*) ;; *)
  echo "[verify] FAIL: ${DB_A}'s DbiResourceId reads '${DB_A_RID}' (expected db-...)" >&2
  exit 1 ;;
esac
assert_journaled OrphanCluster "${CLUSTER_A}" "${CLUSTER_A_RID}"
assert_journaled OrphanInstance "${DB_A}" "${DB_A_RID}"
echo "[verify] step 2 ok: ${CLUSTER_A} and ${DB_A} are in AWS, journaled with their resource ids, with no state record"

# A user fixes forward minutes later, once both are up; an RDS resource still
# `creating` may refuse its delete, which is not what this step measures.
aws rds wait db-cluster-available --db-cluster-identifier "${CLUSTER_A}" --region "${REGION}"
aws rds wait db-instance-available --db-instance-identifier "${DB_A}" --region "${REGION}"

echo "[verify] step 3: the fix-forward (same logical ids, other identifiers)"
set +e
env WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" "${TIMEOUT_OVERRIDES[@]}" > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
if [ "${FF_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 0: the earlier cluster and instance are proven other resources and deleted -- output above)" >&2
  echo "         (before go-to-k/cdkd#4606 it exited 2 and left both)" >&2
  exit 1
fi
assert_gone "the rollback journal is still present after the fix-forward deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
aws rds wait db-cluster-deleted --db-cluster-identifier "${CLUSTER_A}" --region "${REGION}"
aws rds wait db-instance-deleted --db-instance-identifier "${DB_A}" --region "${REGION}"
assert_gone "the earlier attempt's DB cluster ${CLUSTER_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_A}" --region "${REGION}"
assert_gone "the earlier attempt's DB instance ${DB_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws rds describe-db-instances --db-instance-identifier "${DB_A}" --region "${REGION}"
# The new resources are the records': deleting the earlier ones must not touch them.
FF_CLUSTER_STATUS="$(aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_B}" --region "${REGION}" \
  --query 'DBClusters[0].Status' --output text)"
FF_DB_STATUS="$(aws rds describe-db-instances --db-instance-identifier "${DB_B}" --region "${REGION}" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)"
if [ "${FF_CLUSTER_STATUS}" != "available" ] || [ "${FF_DB_STATUS}" != "available" ]; then
  echo "[verify] FAIL: the fix-forward cluster ${CLUSTER_B} is '${FF_CLUSTER_STATUS}' and instance ${DB_B} is '${FF_DB_STATUS}' (expected both available -- the settle must not delete the records' resources)" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <identifier>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || return 1
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || return 1
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record OrphanCluster "${CLUSTER_B}"
assert_record OrphanInstance "${DB_B}"
SUBNET_GROUP="$(printf '%s' "${STATE_3}" | jq -r '.resources.SubnetGroup.physicalId // empty')"
VPC_ID="$(printf '%s' "${STATE_3}" | jq -r '[.resources[] | select(.resourceType == "AWS::EC2::VPC") | .physicalId] | first // empty')"
if [ -z "${SUBNET_GROUP}" ] || [ -z "${VPC_ID}" ]; then
  echo "[verify] FAIL: state names no DB subnet group ('${SUBNET_GROUP}') or VPC ('${VPC_ID}') after step 3" >&2
  exit 1
fi
# The assertions above decide the step on AWS's own answers. The log lines
# below only confirm the deploy's account of it, so a reworded line fails
# here, never silently above.
for lid in OrphanCluster OrphanInstance; do
  if ! grep -q "deleting partially-created ${lid}" "${LOG_DIR}/fix-forward.log"; then
    echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's ${lid} (output above)" >&2
    exit 1
  fi
  if grep -q "Skipping failed CREATE of ${lid}" "${LOG_DIR}/fix-forward.log"; then
    echo "[verify] FAIL: the fix-forward deploy still warned about the earlier ${lid} instead of deleting it (output above)" >&2
    exit 1
  fi
done
echo "[verify] step 3 ok: the fix-forward deleted ${CLUSTER_A} and ${DB_A}, kept ${CLUSTER_B} and ${DB_B}, exited 0 and dropped the journal"

echo "[verify] step 4: destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force "${TIMEOUT_OVERRIDES[@]}"
assert_gone "DB cluster ${CLUSTER_B} still exists after destroy" \
  aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_B}" --region "${REGION}"
assert_gone "DB instance ${DB_B} still exists after destroy" \
  aws rds describe-db-instances --db-instance-identifier "${DB_B}" --region "${REGION}"
assert_gone "DB subnet group ${SUBNET_GROUP} still exists after destroy" \
  aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "rds-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's DB cluster and DB instance (go-to-k/cdkd#4606)"
