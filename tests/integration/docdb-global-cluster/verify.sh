#!/usr/bin/env bash
# verify.sh — cdkd DocDB clusters in global clusters (go-to-k/cdkd#5628).
#
# `AWS::DocDB::DBCluster.GlobalClusterIdentifier` on the SDK route. A real
# CloudFormation A/B (us-east-1, engine 5.0.0) measured the handler: a REMOVAL
# updates in place (the cluster is detached and stays available, standalone);
# an ADD or a CHANGE to another global cluster fails ("... not supported unless
# the cluster is already part of the target global cluster"); a stack delete
# deletes a member. cdkd matches all three.
#
# Two clusters, each the primary of its own global cluster (a same-region
# secondary is not possible): `Cluster` in `Global` stays a member to the end,
# so the destroy's detach runs; `ClusterB` in `Global2` is the removal subject.
#
# Phases:
#   1. Deploy. Both clusters are members (DescribeGlobalClusters), both
#      provisionedBy=sdk, both records hold GlobalClusterIdentifier.
#   2. CDKD_TEST_UPDATE=true: BackupRetentionPeriod 1 -> 2 on both, membership
#      unchanged. The change reached AWS; both still members.
#   3. + CDKD_TEST_CHANGE=true: `Cluster` asks for Global -> Global2. The deploy
#      FAILS with cdkd's refusal; `Cluster` is still in `Global`.
#   4. + CDKD_TEST_REMOVAL=true: `ClusterB` drops GlobalClusterIdentifier. The
#      deploy succeeds; `ClusterB` is the SAME cluster (resource id), available,
#      no longer listed by `Global2`, provisionedBy=sdk, its record has no key.
#   5. + CDKD_TEST_READD=true: `ClusterB` asks to re-join Global2. The deploy
#      FAILS with cdkd's refusal; `ClusterB` is still not a member.
#   6. Destroy: `Cluster` is detached (its line asserted), then everything is
#      deleted. Both clusters, both global clusters and the state are gone.
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

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Shared S3 VERSION-sweep helpers (issue #2096): the template's literal master
# password reaches the state records, and the state bucket is versioned.
# Sourced before the `cd` below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

cd "$(dirname "$0")"

STACK="CdkdDocdbGlobalClusterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
GLOBAL_ID="cdkd-integ-docdb-global-5628"
GLOBAL2_ID="cdkd-integ-docdb-global2-5628"
CLUSTER_ID="cdkd-integ-docdb-global-member-5628"
CLUSTER_B_ID="cdkd-integ-docdb-global-member-b-5628"
SUBNET_GROUP="cdkd-integ-docdb-global-5628"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
REFUSAL="Changing GlobalClusterIdentifier to a different global cluster is not supported"
DETACH_LINE="Detaching DocDB DBCluster Cluster from global cluster ${GLOBAL_ID} before the delete"
# Sentinel: the global cluster id on any line, independent of the wording.
DETACH_SENTINEL="from global cluster ${GLOBAL_ID}"

# Best-effort teardown of one cluster left in a global cluster: detach, wait for
# the member list to drop it, then for `available`, delete it, and wait until it
# is gone only when AWS took the delete.
sweep_cluster() { ( # usage: sweep_cluster <cluster id> <global cluster id>
  set +eu
  arn="$(aws docdb describe-db-clusters --db-cluster-identifier "$1" \
    --region "${REGION}" --query 'DBClusters[0].DBClusterArn' --output text 2>/dev/null)"
  case "${arn}" in
    arn:*) ;;
    *) exit 0 ;;
  esac
  aws docdb remove-from-global-cluster --global-cluster-identifier "$2" \
    --db-cluster-identifier "${arn}" --region "${REGION}" >/dev/null 2>&1
  for _ in $(seq 1 60); do
    members="$(aws docdb describe-global-clusters --global-cluster-identifier "$2" \
      --region "${REGION}" --query 'GlobalClusters[0].GlobalClusterMembers[].DBClusterArn' \
      --output text 2>&1)"
    case " ${members} " in
      *" ${arn} "*) sleep 10 ;;
      *) break ;;
    esac
  done
  for _ in $(seq 1 60); do
    status="$(aws docdb describe-db-clusters --db-cluster-identifier "$1" \
      --region "${REGION}" --query 'DBClusters[0].Status' --output text 2>/dev/null)"
    [ "${status}" = "available" ] && break
    sleep 10
  done
  if aws docdb delete-db-cluster --db-cluster-identifier "$1" \
    --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1; then
    for _ in $(seq 1 90); do
      out="$(aws docdb describe-db-clusters --db-cluster-identifier "$1" \
        --region "${REGION}" 2>&1)"
      case "${out}" in *DBClusterNotFound*) break ;; esac
      sleep 10
    done
  fi
) }

# Best-effort teardown of a partial destroy, by fixed name and by the CDK Name
# tag: the clusters, the global clusters, the subnet group, then the VPC
# leaf-first.
sweep() { (
  set +eu
  sweep_cluster "${CLUSTER_ID}" "${GLOBAL_ID}"
  sweep_cluster "${CLUSTER_B_ID}" "${GLOBAL2_ID}"
  for g in "${GLOBAL_ID}" "${GLOBAL2_ID}"; do
    aws docdb delete-global-cluster --global-cluster-identifier "${g}" \
      --region "${REGION}" >/dev/null 2>&1
  done
  aws docdb delete-db-subnet-group --db-subnet-group-name "${SUBNET_GROUP}" \
    --region "${REGION}" >/dev/null 2>&1
  vpc="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" --query 'Vpcs[0].VpcId' --output text 2>/dev/null)"
  if [ -n "${vpc}" ] && [ "${vpc}" != "None" ]; then
    for eni in $(aws ec2 describe-network-interfaces --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query 'NetworkInterfaces[].NetworkInterfaceId' --output text 2>/dev/null); do
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${REGION}" >/dev/null 2>&1
    done
    for sg in $(aws ec2 describe-security-groups --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
    done
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
    done
    igw="$(aws ec2 describe-internet-gateways --region "${REGION}" --filters "Name=attachment.vpc-id,Values=${vpc}" --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null)"
    if [ -n "${igw}" ] && [ "${igw}" != "None" ]; then
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
      aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
    fi
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query "RouteTables[?Associations[0].Main!=\`true\`].RouteTableId" --output text 2>/dev/null); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
    done
    if aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1; then
      echo "    swept leftover VPC ${vpc}"
    else
      echo "    WARN: leftover VPC ${vpc} could not be deleted" >&2
    fi
  fi
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG:-}" "${DESTROY_LOG:-}"
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  sweep
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    # NONCURRENT only, per ../s3-versions.sh; the success path sweeps all.
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
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

cluster_field() { # usage: cluster_field <cluster id> <query>
  aws docdb describe-db-clusters --db-cluster-identifier "$1" \
    --region "${REGION}" --query "DBClusters[0].$2" --output text
}

# The member ARNs a global cluster lists (space-separated).
member_arns() { # usage: member_arns <global cluster id>
  aws docdb describe-global-clusters --global-cluster-identifier "$1" \
    --region "${REGION}" --query 'GlobalClusters[0].GlobalClusterMembers[].DBClusterArn' \
    --output text
}

assert_membership() { # usage: assert_membership <phase> <cluster id> <global id> <member|not-member>
  local arn members listed
  arn="$(cluster_field "$2" DBClusterArn)" || return 1
  members="$(member_arns "$3")" || return 1
  case " ${members} " in
    *" ${arn} "*) listed="member" ;;
    *) listed="not-member" ;;
  esac
  if [ "${listed}" != "$4" ]; then
    echo "FAIL: ${1}: ${2} is ${listed} of ${3}, want ${4} (members: '${members}')" >&2
    exit 1
  fi
  echo "    ${1}: ${2} is ${listed} of ${3}"
}

# A record's field, read from `cdkd state show --json`.
record_field() { # usage: record_field <logical id> <provisionedBy | properties.GlobalClusterIdentifier>
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources[process.argv[1]];if(!r){process.exit(3)}let v=r;for(const k of process.argv[2].split("."))v=v==null?undefined:v[k];process.stdout.write(v==null?"":String(v))})' "$1" "$2"
}

assert_record() { # usage: assert_record <phase> <logical id> <field> <want>
  local got
  got="$(record_field "$2" "$3")" || return 1
  if [ "${got}" != "$4" ]; then
    echo "FAIL: ${1}: ${2} record ${3}='${got}', want '${4}'" >&2
    exit 1
  fi
}

# A deploy that cdkd must refuse for <logical id>, before any write.
assert_deploy_refused() { # usage: assert_deploy_refused <phase> <logical id> <env assignments...>
  local phase="$1" logical="$2" rc
  shift 2
  DEPLOY_LOG="$(mktemp)"
  set +e
  env "$@" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${rc}" -eq 0 ]; then
    echo "FAIL: ${phase}: the deploy exited 0; cdkd must refuse ${logical}'s GlobalClusterIdentifier change" >&2
    cat "${DEPLOY_LOG}" >&2
    exit 1
  fi
  if ! grep -qF "${REFUSAL}" "${DEPLOY_LOG}"; then
    # Sentinel: the refusal's line opens with this, independent of the wording.
    if grep -qF "DocDB DBCluster ${logical}:" "${DEPLOY_LOG}"; then
      echo "FAIL: ${phase}: the ${logical} failure line no longer carries '${REFUSAL}' (wording drift?)" >&2
    else
      echo "FAIL: ${phase}: the deploy failed (rc=${rc}) for another reason than cdkd's refusal" >&2
    fi
    cat "${DEPLOY_LOG}" >&2
    exit 1
  fi
  rm -f "${DEPLOY_LOG}"
  echo "    ${phase}: deploy refused (rc=${rc}) for ${logical}"
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy baseline (each cluster joins its global cluster)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_CHANGE -u CDKD_TEST_REMOVAL -u CDKD_TEST_READD \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_membership "Phase 1" "${CLUSTER_ID}" "${GLOBAL_ID}" member
assert_membership "Phase 1" "${CLUSTER_B_ID}" "${GLOBAL2_ID}" member
for logical in Cluster ClusterB; do
  assert_record "Phase 1" "${logical}" provisionedBy sdk
done
assert_record "Phase 1" Cluster properties.GlobalClusterIdentifier "${GLOBAL_ID}"
assert_record "Phase 1" ClusterB properties.GlobalClusterIdentifier "${GLOBAL2_ID}"
B_RESOURCE_ID="$(cluster_field "${CLUSTER_B_ID}" DbClusterResourceId)"
echo "    both clusters provisionedBy=sdk; ClusterB resource id ${B_RESOURCE_ID}"

# --- Phase 2: UPDATE with the membership unchanged ----------------------
echo "==> Phase 2: UPDATE (BackupRetentionPeriod 1 -> 2, membership unchanged)"
env -u CDKD_TEST_CHANGE -u CDKD_TEST_REMOVAL -u CDKD_TEST_READD CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
for id in "${CLUSTER_ID}" "${CLUSTER_B_ID}"; do
  RETENTION="$(cluster_field "${id}" BackupRetentionPeriod)"
  if [ "${RETENTION}" != "2" ]; then
    echo "FAIL: Phase 2: ${id} BackupRetentionPeriod=${RETENTION}, want 2 (the update did not run)" >&2
    exit 1
  fi
done
assert_membership "Phase 2" "${CLUSTER_ID}" "${GLOBAL_ID}" member
assert_membership "Phase 2" "${CLUSTER_B_ID}" "${GLOBAL2_ID}" member

# --- Phase 3: a change to another global cluster is refused ---------------
echo "==> Phase 3: Cluster Global -> Global2 must be refused"
assert_deploy_refused "Phase 3" Cluster -u CDKD_TEST_REMOVAL -u CDKD_TEST_READD \
  CDKD_TEST_UPDATE=true CDKD_TEST_CHANGE=true
assert_membership "Phase 3" "${CLUSTER_ID}" "${GLOBAL_ID}" member
assert_membership "Phase 3" "${CLUSTER_ID}" "${GLOBAL2_ID}" not-member
assert_record "Phase 3" Cluster properties.GlobalClusterIdentifier "${GLOBAL_ID}"

# --- Phase 4: a removal detaches in place --------------------------------
echo "==> Phase 4: ClusterB drops GlobalClusterIdentifier (detached in place)"
env -u CDKD_TEST_CHANGE -u CDKD_TEST_READD CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATUS="$(cluster_field "${CLUSTER_B_ID}" Status)"
if [ "${STATUS}" != "available" ]; then
  echo "FAIL: Phase 4: ${CLUSTER_B_ID} status '${STATUS}', want available" >&2
  exit 1
fi
RESOURCE_ID="$(cluster_field "${CLUSTER_B_ID}" DbClusterResourceId)"
if [ "${RESOURCE_ID}" != "${B_RESOURCE_ID}" ]; then
  echo "FAIL: Phase 4: ${CLUSTER_B_ID} resource id ${RESOURCE_ID}, want ${B_RESOURCE_ID} (replaced, not updated in place)" >&2
  exit 1
fi
assert_membership "Phase 4" "${CLUSTER_B_ID}" "${GLOBAL2_ID}" not-member
assert_membership "Phase 4" "${CLUSTER_ID}" "${GLOBAL_ID}" member
assert_record "Phase 4" ClusterB provisionedBy sdk
assert_record "Phase 4" ClusterB properties.GlobalClusterIdentifier ""
echo "    ClusterB detached in place (same resource id, available, sdk, no recorded key)"

# --- Phase 5: re-joining is refused ----------------------------------------
echo "==> Phase 5: ClusterB re-joining Global2 must be refused"
assert_deploy_refused "Phase 5" ClusterB -u CDKD_TEST_CHANGE \
  CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true CDKD_TEST_READD=true
assert_membership "Phase 5" "${CLUSTER_B_ID}" "${GLOBAL2_ID}" not-member
assert_record "Phase 5" ClusterB properties.GlobalClusterIdentifier ""

# --- Phase 6: destroy (Cluster detached, then everything deleted) -----------
echo "==> Phase 6: destroy"
# --verbose: the provider's detach line is an info line, asserted below.
DESTROY_LOG="$(mktemp)"
set +e
env -u CDKD_TEST_UPDATE -u CDKD_TEST_CHANGE -u CDKD_TEST_REMOVAL -u CDKD_TEST_READD \
  node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose >"${DESTROY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: Phase 6: destroy exited ${DESTROY_RC}" >&2
  tail -n 60 "${DESTROY_LOG}" >&2
  exit 1
fi
# The detach must have RUN, not merely the delete succeeding: a clean destroy
# alone would also pass if AWS deleted a member without it.
if ! grep -qF "${DETACH_LINE}" "${DESTROY_LOG}"; then
  if grep -qF "${DETACH_SENTINEL}" "${DESTROY_LOG}"; then
    echo "FAIL: Phase 6: a detach line no longer reads '${DETACH_LINE}' (wording drift?)" >&2
  else
    echo "FAIL: Phase 6: destroy did not detach Cluster from ${GLOBAL_ID} before deleting it" >&2
  fi
  tail -n 60 "${DESTROY_LOG}" >&2
  exit 1
fi
rm -f "${DESTROY_LOG}"
echo "    destroy detached Cluster from ${GLOBAL_ID} before the delete"

assert_gone "DocDB cluster ${CLUSTER_ID} still exists after destroy" aws docdb describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}"
assert_gone "DocDB cluster ${CLUSTER_B_ID} still exists after destroy" aws docdb describe-db-clusters --db-cluster-identifier "${CLUSTER_B_ID}" --region "${REGION}"
assert_gone "DocDB global cluster ${GLOBAL_ID} still exists after destroy" aws docdb describe-global-clusters --global-cluster-identifier "${GLOBAL_ID}" --region "${REGION}"
assert_gone "DocDB global cluster ${GLOBAL2_ID} still exists after destroy" aws docdb describe-global-clusters --global-cluster-identifier "${GLOBAL2_ID}" --region "${REGION}"
assert_gone "DocDB subnet group ${SUBNET_GROUP} still exists after destroy" aws docdb describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
# A tag-filtered listing answers empty, not not-found: count its rows (a strict
# capture, so a failed read fails the run rather than reading as zero).
VPC_LEFT="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" \
  --query 'Vpcs[].VpcId' --output text)"
if [ -n "${VPC_LEFT}" ]; then
  echo "FAIL: fixture VPC ${VPC_LEFT} still exists after destroy" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    clusters, global clusters, subnet group, VPC and state all gone"

trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "docdb-global-cluster state teardown"
echo "[verify] PASS — DocDB GlobalClusterIdentifier: joined on create, kept on update, change and re-join refused, removal detached in place, member detached on destroy"
