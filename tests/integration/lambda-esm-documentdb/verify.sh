#!/usr/bin/env bash
# verify.sh — cdkd Lambda DocumentDB event source mapping update integ (issue #1160).
# Baseline: a disabled DocumentDB mapping with db1 / c1 / UpdateLookup.
# change: BatchSize 10 -> 20, CollectionName c1 -> c2, FullDocument -> Default.
#   UpdateEventSourceMapping refuses DatabaseName / CollectionName, so the
#   update must still succeed, apply BatchSize and FullDocument, keep c1 (as
#   CloudFormation does) and warn about it. The same template deployed again
#   warns again, since state records the kept c1.
# removal: CollectionName and FullDocument leave the block; both stay live, as
#   CloudFormation keeps them, and cdkd warns about FullDocument.
# Then destroys clean.

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

# Shared S3 VERSION-sweep helpers (issue #2096): the cluster's master password
# is templated (a dynamic reference to the generated secret), and the state
# bucket is versioned.
. ../s3-versions.sh

STACK="CdkdLambdaEsmDocumentdbExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
PREFIX="$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')"
FN="${STACK}-fn"
CLUSTER="${PREFIX}-cluster"
INSTANCE="${PREFIX}-db"
SECRET="${STACK}-docdb"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="$(mktemp -t lambda-esm-documentdb.XXXXXX)"
TIMEOUT_OVERRIDES=(
  --resource-timeout AWS::DocDB::DBCluster=40m
  --resource-timeout AWS::DocDB::DBInstance=40m
)

# Best-effort removal of the billable DocDB pair when `cdkd destroy` did not
# get them. Instance first: a cluster holding an instance refuses its delete,
# and an instance still creating refuses its own, so each delete waits for a
# deletable state and is retried. Anything still standing is named loudly.
delete_docdb_leftovers() { (
  set +eu
  for _ in 1 2 3; do
    st=$(aws docdb describe-db-instances --db-instance-identifier "${INSTANCE}" --region "${REGION}" \
      --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1)
    case "${st}" in
      *DBInstanceNotFound*) break ;;
      deleting) ;;
      *) aws docdb wait db-instance-available --db-instance-identifier "${INSTANCE}" --region "${REGION}" >/dev/null 2>&1
         aws docdb delete-db-instance --db-instance-identifier "${INSTANCE}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
    aws docdb wait db-instance-deleted --db-instance-identifier "${INSTANCE}" --region "${REGION}" >/dev/null 2>&1 && break
  done
  for _ in 1 2 3; do
    st=$(aws docdb describe-db-clusters --db-cluster-identifier "${CLUSTER}" --region "${REGION}" \
      --query 'DBClusters[0].Status' --output text 2>&1)
    case "${st}" in
      *DBClusterNotFound*) break ;;
      deleting) ;;
      *) aws rds wait db-cluster-available --db-cluster-identifier "${CLUSTER}" --region "${REGION}" >/dev/null 2>&1
         aws docdb delete-db-cluster --db-cluster-identifier "${CLUSTER}" --skip-final-snapshot \
           --region "${REGION}" >/dev/null 2>&1 ;;
    esac
    aws rds wait db-cluster-deleted --db-cluster-identifier "${CLUSTER}" --region "${REGION}" >/dev/null 2>&1 && break
  done
  ( gone_probe aws docdb describe-db-instances --db-instance-identifier "${INSTANCE}" --region "${REGION}" ) \
    || echo "[verify] LEFTOVER: DocDB instance ${INSTANCE} may still exist (billable); delete it by hand in ${REGION}" >&2
  ( gone_probe aws docdb describe-db-clusters --db-cluster-identifier "${CLUSTER}" --region "${REGION}" ) \
    || echo "[verify] LEFTOVER: DocDB cluster ${CLUSTER} may still exist (billable); delete it by hand in ${REGION}" >&2
  true
); }

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${LOG}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force "${TIMEOUT_OVERRIDES[@]}" >/dev/null 2>&1
  fi
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  delete_docdb_leftovers
  aws secretsmanager delete-secret --secret-id "${SECRET}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # NONCURRENT only, per ../s3-versions.sh; the success path sweeps all.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install

# Reads one member of the mapping's DocumentDBEventSourceConfig (or BatchSize).
# Not silenced: a failed read aborts under `set -e`.
esm_read() { # usage: esm_read <JMESPath under EventSourceMappings[0]>
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query "EventSourceMappings[0].$1" --output text
}

# Deploys one phase, keeping its output for the warning checks.
deploy_phase() { # usage: deploy_phase <CDKD_TEST_UPDATE value>
  if ! env CDKD_TEST_UPDATE="$1" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --yes "${TIMEOUT_OVERRIDES[@]}" 2>&1 | tee "${LOG}"; then
    echo "FAIL: the '$1' deploy failed (an update sending DatabaseName / CollectionName is refused by AWS, issue #1160)" >&2
    exit 1
  fi
}

# Asserts exactly one DocumentDBEventSourceConfig warning line for the mapping
# carries <marker>. The sentinel is the mapping's own prefix, so a reworded
# warning fails here instead of reading as "not warned".
assert_docdb_warning() { # usage: assert_docdb_warning <marker>
  local sentinel="Mapping (AWS::Lambda::EventSourceMapping): DocumentDBEventSourceConfig"
  local lines
  lines=$(grep -F "${sentinel}" "${LOG}" || true)
  if [ -z "${lines}" ]; then
    echo "FAIL: no DocumentDBEventSourceConfig warning for the mapping (expected one naming '$1')" >&2
    exit 1
  fi
  if ! grep -qF "$1" <<<"${lines}"; then
    echo "FAIL: the mapping's DocumentDBEventSourceConfig warning does not say '$1' (reworded?): ${lines}" >&2
    exit 1
  fi
  echo "    OK: warned: $1"
}

assert_eq() { # usage: assert_eq <what> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

echo "==> Pre-run cleanup"; cleanup

echo "==> Deploy (baseline: db1 / c1 / UpdateLookup, BatchSize 10)"
deploy_phase ""
UUID=$(esm_read UUID)
assert_eq "baseline CollectionName" "$(esm_read DocumentDBEventSourceConfig.CollectionName)" c1
assert_eq "baseline FullDocument" "$(esm_read DocumentDBEventSourceConfig.FullDocument)" UpdateLookup
assert_eq "baseline BatchSize" "$(esm_read BatchSize)" 10

echo "==> Deploy (change: BatchSize 20, CollectionName c2, FullDocument Default)"
deploy_phase change
assert_eq "mapping UUID (in place)" "$(esm_read UUID)" "${UUID}"
assert_eq "BatchSize after the change" "$(esm_read BatchSize)" 20
assert_eq "FullDocument after the change" "$(esm_read DocumentDBEventSourceConfig.FullDocument)" Default
assert_eq "CollectionName after the change (kept, as CloudFormation keeps it)" \
  "$(esm_read DocumentDBEventSourceConfig.CollectionName)" c1
assert_docdb_warning "DocumentDBEventSourceConfig.CollectionName cannot be changed on an existing event source mapping"

# State records the kept c1, not the template's c2, so the same template
# diffs as a change again and the warning repeats (a recorded c2 would deploy
# as no change, silently).
echo "==> Deploy (change again: state must still hold the kept CollectionName)"
deploy_phase change
assert_docdb_warning "DocumentDBEventSourceConfig.CollectionName cannot be changed on an existing event source mapping"

echo "==> Deploy (removal: CollectionName and FullDocument leave the block)"
deploy_phase removal
assert_eq "mapping UUID (in place)" "$(esm_read UUID)" "${UUID}"
assert_eq "FullDocument after its removal (kept, as CloudFormation keeps it)" \
  "$(esm_read DocumentDBEventSourceConfig.FullDocument)" Default
assert_eq "CollectionName after its removal" "$(esm_read DocumentDBEventSourceConfig.CollectionName)" c1
assert_docdb_warning "DocumentDBEventSourceConfig.FullDocument was removed from the template; the mapping keeps its current value"

# The subnet group name is generated, so read it off the cluster before destroy.
SUBNET_GROUP=$(aws docdb describe-db-clusters --db-cluster-identifier "${CLUSTER}" --region "${REGION}" \
  --query 'DBClusters[0].DBSubnetGroup' --output text)
[ -n "${SUBNET_GROUP}" ] && [ "${SUBNET_GROUP}" != "None" ] \
  || { echo "FAIL: could not read the cluster's DBSubnetGroup before destroy" >&2; exit 1; }

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force "${TIMEOUT_OVERRIDES[@]}"

GONE=""
for _ in $(seq 1 18); do
  if gone_probe aws lambda get-function --function-name "${FN}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
GONE=""
for _ in $(seq 1 120); do
  if gone_probe aws docdb describe-db-clusters --db-cluster-identifier "${CLUSTER}" --region "${REGION}"; then GONE=1; break; fi
  sleep 10
done
[ -z "${GONE}" ] && { echo "FAIL: DocDB cluster ${CLUSTER} still exists 20 min after destroy" >&2; exit 1; }
echo "    OK: DocDB cluster gone"
assert_gone "DocDB instance ${INSTANCE} still exists after destroy" \
  aws docdb describe-db-instances --db-instance-identifier "${INSTANCE}" --region "${REGION}"
echo "    OK: DocDB instance gone"
assert_gone "DocDB subnet group ${SUBNET_GROUP} still exists after destroy" \
  aws docdb describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
echo "    OK: DocDB subnet group gone"
VPCS=$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" \
  --query 'Vpcs[].VpcId' --output text)
[ -n "${VPCS}" ] && { echo "FAIL: VPC(s) ${VPCS} tagged ${STACK}/Vpc still exist after destroy" >&2; exit 1; }
echo "    OK: VPC gone"
# POLLED, not probed once: `DeleteSecret` is asynchronous, so `describe-secret`
# can still resolve for a few seconds after a force delete returns.
SECRET_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET}" --region "${REGION}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" -ne 1 ]; then
  echo "FAIL: secret ${SECRET} still exists 60s after destroy" >&2
  exit 1
fi
echo "    OK: secret gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true

trap - EXIT INT TERM
rm -f "${LOG}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "lambda-esm-documentdb state teardown"
echo ""
echo "[verify] PASS — lambda-esm-documentdb"
