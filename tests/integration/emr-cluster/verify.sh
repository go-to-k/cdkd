#!/usr/bin/env bash
# verify.sh — cdkd AWS::EMR::Cluster SDK provider integ (issue #1043).
#
# The type is ProvisioningType: NON_PROVISIONABLE, so there is no Cloud
# Control fallback — this fixture proves the new SDK provider end to end with
# the smallest / cheapest legal shape: a single master node (1x m5.xlarge, no
# core/task), emr-7.9.0, in a public subnet.
#
# Phases:
#   1. Deploy the cluster (+ minimal VPC + EMR default roles). Assert via
#      `aws emr describe-cluster` that it is WAITING/RUNNING, that the
#      MasterPublicDNS output (Fn::GetAtt) matches AWS, that the baseline
#      tags / StepConcurrencyLevel / AutoTerminationPolicy reached AWS, and
#      that state routes it via the SDK provider (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: StepConcurrencyLevel 1 -> 5
#      (ModifyCluster) + AutoTerminationPolicy IdleTimeout 3600 -> 7200
#      (PutAutoTerminationPolicy) + tag value change AND tag removal (AddTags
#      / RemoveTags). Assert the ClusterId is UNCHANGED (in-place, no replace).
#      (VisibleToAllUsers is intentionally NOT exercised — AWS deprecated it,
#      so SetVisibleToAllUsers(false) is a no-op; the provider still issues the
#      call and its unit tests cover the mapping.)
#   3. Import round-trip (issue #1090, follow-up to PR #1080 which added the
#      provider's `import()` / `readCurrentState()`): drop ONLY the cluster
#      row from cdkd state via `cdkd orphan <stack>/<constructPath>` (AWS
#      untouched — the cluster must still be live afterwards), then re-adopt
#      it with `cdkd import --resource <logicalId>=<clusterId>` (selective
#      mode). Assert the re-adopted row carries the SAME physical id / type /
#      provisionedBy, that the unlisted sibling rows (VPC / IAM / SG) survived
#      the selective merge, and that `observedProperties` was seeded from the
#      LIVE cluster by `readCurrentState` (this is the assertion that actually
#      exercises PR #1080 against real AWS — it must reflect the Phase 2
#      UPDATE values, not the template's).
#   4. Destroy + assert the cluster is TERMINATED (an EMR cluster bills per
#      instance-hour, so a leftover is never acceptable) with no ACTIVE
#      cluster carrying the fixture tag, and the cdkd state file is removed.
#      Because Phase 3 re-adopted the cluster, this destroy runs THROUGH the
#      imported state record — the round-trip is only proven if the cluster
#      actually terminates from it.
#
# NOTE: EMR cluster creation to WAITING takes ~5-15 minutes and termination a
# few more — expect a total wall clock of 20-40 minutes. Phase 3 adds only a
# few AWS API calls against the ALREADY-RUNNING cluster (no second cluster is
# launched), so it costs ~1 minute of wall clock and zero extra instance-hours
# — which is why the round-trip extends this fixture instead of standing up a
# dedicated `emr-import` one.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdEmrClusterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-integ-emr"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="emr-cluster"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Ids of ACTIVE (not terminated) clusters named like the fixture and carrying
# the fixture's constant tag.
# Ids of ACTIVE clusters named like the fixture and carrying its constant tag.
# Returns NON-ZERO if any underlying AWS call fails, so a caller can tell
# "no leftover clusters" apart from "could not determine". This matters for
# the post-destroy leak assertion: a throttled / failed `list-clusters` prints
# nothing, and a naive caller would read that as "nothing leaked" and pass.
strict_active_tagged_cluster_ids() {
  local ids id tags
  ids="$(aws emr list-clusters --active --region "${REGION}" \
    --query "Clusters[?Name=='${CLUSTER_NAME}'].Id" --output text)" || return 1
  ids="$(printf '%s' "${ids}" | tr '\t' '\n' | sed '/^$/d')"
  for id in ${ids}; do
    tags="$(aws emr describe-cluster --cluster-id "${id}" --region "${REGION}" \
      --query "Cluster.Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']" \
      --output text)" || return 1
    if printf '%s' "${tags}" | grep -q .; then
      echo "${id}"
    fi
  done
}

# Best-effort variant for cleanup(), where a transient API failure should not
# abort the teardown — the EXIT trap runs with `set +eu` and any leftover is
# caught by the next run's pre-run cleanup.
active_tagged_cluster_ids() {
  strict_active_tagged_cluster_ids 2>/dev/null || true
}

cluster_state() {
  aws emr describe-cluster --cluster-id "$1" --region "${REGION}" \
    --query 'Cluster.Status.State' --output text 2>/dev/null
}

wait_cluster_terminated() {
  local id="$1"
  local deadline=$((SECONDS + 1800))
  local st
  while [ ${SECONDS} -lt ${deadline} ]; do
    st="$(cluster_state "${id}")"
    if [ "${st}" = "TERMINATED" ] || [ "${st}" = "TERMINATED_WITH_ERRORS" ] || [ -z "${st}" ]; then
      return 0
    fi
    sleep 15
  done
  return 1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # ORDER MATTERS — the tag-scoped cluster sweep MUST run before
  # `state destroy`. The sweep finds the cluster by NAME + TAG, so it works
  # whether or not the cluster is still tracked in cdkd state; `state destroy`
  # only knows what state records. Phase 3 deliberately creates a window (the
  # `cdkd orphan` -> `cdkd import` gap) where the cluster is LIVE but ABSENT
  # from state, and an interrupted run can leave the fixture exactly there.
  # With `state destroy` first, it would skip the untracked cluster, walk
  # straight into the VPC teardown, and block indefinitely on `delete-vpc`
  # because the running cluster's EC2 instances / ENIs hold the subnets — the
  # terminate below would never be reached while the cluster kept billing.
  # (Observed live: an interrupted run wedged here for 18+ minutes.)
  # Terminate any leftover active cluster (disable termination protection
  # first, defensively) and wait until it is gone — its ENIs / EC2 instances
  # block the VPC teardown below and it bills per instance-hour.
  for cid in $(active_tagged_cluster_ids); do
    echo "    terminating leftover EMR cluster ${cid}"
    aws emr modify-cluster-attributes --cluster-id "${cid}" --no-termination-protected \
      --region "${REGION}" >/dev/null 2>&1
    aws emr terminate-clusters --cluster-ids "${cid}" --region "${REGION}" >/dev/null 2>&1
    wait_cluster_terminated "${cid}"
  done
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Best-effort teardown of the fixture VPC (found via the CDK Name tag).
  for vpcid in $(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:Name,Values=${STACK}/Vpc" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    echo "    deleting leftover VPC ${vpcid}"
    # EMR auto-creates ElasticMapReduce-master / -slave security groups in the
    # cluster's VPC (NOT part of the CDK template, so cdkd's destroy never
    # touches them) and they reference EACH OTHER, so a plain delete-security-
    # group fails with DependencyViolation and orphans the whole VPC. Revoke
    # every ingress/egress rule on all non-default SGs FIRST, then delete.
    sgs="$(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null)"
    for sg in ${sgs}; do
      ingress="$(aws ec2 describe-security-groups --region "${REGION}" --group-ids "${sg}" \
        --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null)"
      [ -n "${ingress}" ] && [ "${ingress}" != "[]" ] && \
        aws ec2 revoke-security-group-ingress --region "${REGION}" --group-id "${sg}" \
          --ip-permissions "${ingress}" >/dev/null 2>&1
      egress="$(aws ec2 describe-security-groups --region "${REGION}" --group-ids "${sg}" \
        --query 'SecurityGroups[0].IpPermissionsEgress' --output json 2>/dev/null)"
      [ -n "${egress}" ] && [ "${egress}" != "[]" ] && \
        aws ec2 revoke-security-group-egress --region "${REGION}" --group-id "${sg}" \
          --ip-permissions "${egress}" >/dev/null 2>&1
    done
    for sg in ${sgs}; do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
    done
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
    done
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text 2>/dev/null); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
    done
    for igw in $(aws ec2 describe-internet-gateways --region "${REGION}" \
      --filters "Name=attachment.vpc-id,Values=${vpcid}" \
      --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null); do
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpcid}" \
        --region "${REGION}" >/dev/null 2>&1
      aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
    done
    aws ec2 delete-vpc --vpc-id "${vpcid}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

# INT / TERM need their OWN handlers that exit explicitly. A bare
# `trap cleanup INT` would run cleanup and then RETURN to the interrupted
# point, letting the script resume and potentially exit 0 — i.e. report PASS
# for a run that was killed partway through. The explicit `exit 130` / `143`
# (128 + signal) also make a harness timeout distinguishable from a real
# failure. Cleanup is idempotent, so the re-entry via the EXIT trap is a
# fast no-op once the sweep above has already run.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

state_json() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --json 2>/dev/null
}

output_value() {
  state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.state.outputs&&j.state.outputs[process.argv[1]])||"")})' "$1"
}

# Evaluate a JS expression against the parsed `state show --json` payload.
# `st` is the StackState object; the expression's value is printed raw (an
# `undefined` / `null` result prints as the empty string so callers can test
# with `[ -z ... ]`). Keeps the Phase 3 assertions readable instead of
# repeating a 200-char `node -e` per check.
state_query() {
  state_json | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const st = JSON.parse(s).state;
  const v = new Function("st", "return (" + process.argv[1] + ");")(st);
  process.stdout.write(v === undefined || v === null ? "" : String(v));
});' "$1"
}

# Logical id of the EMR cluster row in state. Derived (not hardcoded to
# `Cluster`) so a future CDK logical-id hashing change does not silently
# break the phase.
cluster_logical_id() {
  state_query 'Object.keys(st.resources).find((k) => st.resources[k].resourceType === "AWS::EMR::Cluster") || ""'
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy single-node EMR cluster (this takes ~5-15 min)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CID_P1="$(output_value ClusterId)"
DNS_OUT="$(output_value MasterPublicDns)"
if [ -z "${CID_P1}" ]; then
  echo "FAIL: ClusterId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    cluster id: ${CID_P1}"

read -r STATE_P1 STEP_P1 DNS_AWS <<EOF
$(aws emr describe-cluster --cluster-id "${CID_P1}" --region "${REGION}" \
  --query 'Cluster.[Status.State,StepConcurrencyLevel,MasterPublicDnsName]' \
  --output text)
EOF

if [ "${STATE_P1}" != "WAITING" ] && [ "${STATE_P1}" != "RUNNING" ]; then
  echo "FAIL: Phase 1 expected cluster state WAITING/RUNNING, got '${STATE_P1}'" >&2
  exit 1
fi
echo "    cluster is ${STATE_P1}"

if [ "${STEP_P1}" != "1" ]; then
  echo "FAIL: Phase 1 expected StepConcurrencyLevel 1, got '${STEP_P1}'" >&2
  exit 1
fi
IDLE_P1="$(aws emr get-auto-termination-policy --cluster-id "${CID_P1}" --region "${REGION}" \
  --query 'AutoTerminationPolicy.IdleTimeout' --output text 2>/dev/null)"
if [ "${IDLE_P1}" != "3600" ]; then
  echo "FAIL: Phase 1 expected AutoTerminationPolicy IdleTimeout 3600, got '${IDLE_P1}'" >&2
  exit 1
fi
echo "    baseline StepConcurrencyLevel=1, AutoTerminationPolicy IdleTimeout=3600"

# Fn::GetAtt MasterPublicDNS output must match the AWS-side value.
if [ -z "${DNS_OUT}" ] || [ "${DNS_OUT}" != "${DNS_AWS}" ]; then
  echo "FAIL: MasterPublicDns output '${DNS_OUT}' does not match AWS MasterPublicDnsName '${DNS_AWS}'" >&2
  exit 1
fi
echo "    Fn::GetAtt MasterPublicDNS matches AWS (${DNS_OUT})"

# Baseline tags reached AWS.
ENV_TAG_P1="$(aws emr describe-cluster --cluster-id "${CID_P1}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='env'].Value | [0]" --output text)"
DROPME_P1="$(aws emr describe-cluster --cluster-id "${CID_P1}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='dropme'].Value | [0]" --output text)"
if [ "${ENV_TAG_P1}" != "test" ] || [ "${DROPME_P1}" != "yes" ]; then
  echo "FAIL: Phase 1 expected tags env=test dropme=yes, got env='${ENV_TAG_P1}' dropme='${DROPME_P1}'" >&2
  exit 1
fi
echo "    baseline tags reached AWS (env=test, dropme=yes)"

# The cluster must route via the SDK provider (catch a routing flip).
PROVISIONED_BY="$(state_query 'Object.values(st.resources).find((r) => r.resourceType === "AWS::EMR::Cluster")?.provisionedBy ?? "sdk"')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected EMR cluster provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    cluster routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2: in-place update ------------------------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (step concurrency, auto-termination, tags)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CID_P2="$(output_value ClusterId)"
if [ "${CID_P1}" != "${CID_P2}" ]; then
  echo "FAIL: cluster was REPLACED (${CID_P1} -> ${CID_P2})" >&2
  exit 1
fi
echo "    cluster identity preserved (${CID_P2}) — in-place update"

STEP_P2="$(aws emr describe-cluster --cluster-id "${CID_P2}" --region "${REGION}" \
  --query 'Cluster.StepConcurrencyLevel' --output text)"
if [ "${STEP_P2}" != "5" ]; then
  echo "FAIL: Phase 2 expected StepConcurrencyLevel 5 (ModifyCluster), got '${STEP_P2}'" >&2
  exit 1
fi
IDLE_P2="$(aws emr get-auto-termination-policy --cluster-id "${CID_P2}" --region "${REGION}" \
  --query 'AutoTerminationPolicy.IdleTimeout' --output text 2>/dev/null)"
if [ "${IDLE_P2}" != "7200" ]; then
  echo "FAIL: Phase 2 expected AutoTerminationPolicy IdleTimeout 7200 (PutAutoTerminationPolicy), got '${IDLE_P2}'" >&2
  exit 1
fi
ENV_TAG_P2="$(aws emr describe-cluster --cluster-id "${CID_P2}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='env'].Value | [0]" --output text)"
DROPME_P2="$(aws emr describe-cluster --cluster-id "${CID_P2}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='dropme'].Value | [0]" --output text)"
if [ "${ENV_TAG_P2}" != "changed" ]; then
  echo "FAIL: Phase 2 expected tag env=changed, got '${ENV_TAG_P2}'" >&2
  exit 1
fi
if [ "${DROPME_P2}" != "None" ] && [ -n "${DROPME_P2}" ]; then
  echo "FAIL: Phase 2 expected tag 'dropme' to be REMOVED (RemoveTags), still '${DROPME_P2}'" >&2
  exit 1
fi
echo "    update reached AWS (StepConcurrencyLevel 5, AutoTerminationPolicy IdleTimeout 7200, env=changed, dropme removed)"

# --- Phase 3: import round-trip (issue #1090) ----------------------------
# Adopt the LIVE cluster back into cdkd state after dropping its row. This is
# the end-to-end proof of the provider's `import()` + `readCurrentState()`
# (PR #1080), which unit tests + a wire-format check covered but no integ did.
#
# Why `cdkd orphan <path>` (per-resource) and not `cdkd state orphan <stack>`
# (whole-stack): the fixture's VPC / IAM / SG rows have no `import()` reachable
# by physical id here, and cdkd deploy does NOT propagate `aws:cdk:path` as an
# AWS tag (AWS reserves the `aws:` prefix), so whole-stack AUTO import cannot
# re-adopt them — they would stay out of state and leak on destroy. Dropping
# only the cluster keeps the destroy path complete AND exercises the selective
# merge, which must preserve every unlisted sibling row.
echo "==> Phase 3: import round-trip (orphan the cluster row, re-adopt via cdkd import)"

CLUSTER_LID="$(cluster_logical_id)"
if [ -z "${CLUSTER_LID}" ]; then
  echo "FAIL: no AWS::EMR::Cluster row found in state before the import round-trip" >&2
  exit 1
fi
RES_COUNT_PRE="$(state_query 'Object.keys(st.resources).length')"
echo "    cluster logical id: ${CLUSTER_LID} (${RES_COUNT_PRE} resource rows in state)"

# !! INVARIANT — from here until the `cdkd import` below succeeds, the cluster
# !! is LIVE IN AWS BUT ABSENT FROM cdkd STATE, and it is billing per
# !! instance-hour. Nothing state-driven (`cdkd destroy` / `cdkd state
# !! destroy`) can clean it up in this window. The ONLY thing that recovers an
# !! interrupted run here is cleanup()'s tag-scoped sweep, which finds the
# !! cluster by name + `cdkd-integ` tag rather than through state — which is
# !! exactly why that sweep must stay ORDERED BEFORE `state destroy` in
# !! cleanup(). Do not "tidy" that ordering back; see the comment there.
#
# `orphan` takes a CONSTRUCT path, not a logical id — `Cluster` here is the
# construct id from lib/emr-cluster-stack.ts (`new emr.CfnCluster(this,
# 'Cluster')`), a source-level fact, whereas CLUSTER_LID above is a synth
# output read back from state. They happen to match today (a direct stack
# child gets no hash suffix) but are not the same thing.
#
# Synth with the SAME env as Phase 2 so the template cdkd imports against
# matches the cluster actually running in AWS.
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" orphan "${STACK}/Cluster" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ -n "$(cluster_logical_id)" ]; then
  echo "FAIL: AWS::EMR::Cluster row still present in state after 'cdkd orphan'" >&2
  exit 1
fi
RES_COUNT_ORPHANED="$(state_query 'Object.keys(st.resources).length')"
if [ "${RES_COUNT_ORPHANED}" != "$((RES_COUNT_PRE - 1))" ]; then
  echo "FAIL: 'cdkd orphan' should drop exactly 1 row, went ${RES_COUNT_PRE} -> ${RES_COUNT_ORPHANED}" >&2
  exit 1
fi
echo "    cluster row dropped from state (${RES_COUNT_PRE} -> ${RES_COUNT_ORPHANED} rows)"

# `orphan` must NOT touch AWS — the cluster has to still be running for the
# re-adoption to mean anything.
STATE_ORPHANED="$(cluster_state "${CID_P2}")"
if [ "${STATE_ORPHANED}" != "WAITING" ] && [ "${STATE_ORPHANED}" != "RUNNING" ]; then
  echo "FAIL: cluster ${CID_P2} is '${STATE_ORPHANED}' after 'cdkd orphan' — orphan must leave AWS untouched" >&2
  exit 1
fi
echo "    cluster still ${STATE_ORPHANED} in AWS (orphan left it alone)"

echo "    re-adopting via cdkd import --resource ${CLUSTER_LID}=${CID_P2}"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --resource "${CLUSTER_LID}=${CID_P2}" --yes

# --- re-adoption assertions ---
CID_IMPORTED="$(state_query 'st.resources["'"${CLUSTER_LID}"'"]?.physicalId')"
if [ "${CID_IMPORTED}" != "${CID_P2}" ]; then
  echo "FAIL: imported physicalId '${CID_IMPORTED}' != live cluster id '${CID_P2}'" >&2
  exit 1
fi
TYPE_IMPORTED="$(state_query 'st.resources["'"${CLUSTER_LID}"'"]?.resourceType')"
if [ "${TYPE_IMPORTED}" != "AWS::EMR::Cluster" ]; then
  echo "FAIL: imported resourceType '${TYPE_IMPORTED}' != 'AWS::EMR::Cluster'" >&2
  exit 1
fi
PROV_IMPORTED="$(state_query 'st.resources["'"${CLUSTER_LID}"'"]?.provisionedBy')"
if [ "${PROV_IMPORTED}" != "sdk" ]; then
  echo "FAIL: imported provisionedBy '${PROV_IMPORTED}' != 'sdk'" >&2
  exit 1
fi
echo "    re-adopted: physicalId=${CID_IMPORTED}, type=${TYPE_IMPORTED}, provisionedBy=${PROV_IMPORTED}"

# Selective mode is a MERGE — the unlisted sibling rows must all survive.
RES_COUNT_POST="$(state_query 'Object.keys(st.resources).length')"
if [ "${RES_COUNT_POST}" != "${RES_COUNT_PRE}" ]; then
  echo "FAIL: selective import should restore the row count to ${RES_COUNT_PRE}, got ${RES_COUNT_POST}" >&2
  exit 1
fi
echo "    unlisted sibling rows preserved by the selective merge (${RES_COUNT_POST} rows)"

# `observedProperties` is seeded post-import by the provider's
# `readCurrentState` against the LIVE cluster. These values must reflect the
# Phase 2 UPDATE (StepConcurrencyLevel 5), which proves the baseline came from
# AWS and not from the synthesized template.
OBS_STEP="$(state_query 'st.resources["'"${CLUSTER_LID}"'"]?.observedProperties?.StepConcurrencyLevel')"
if [ "${OBS_STEP}" != "5" ]; then
  echo "FAIL: observedProperties.StepConcurrencyLevel is '${OBS_STEP}', expected 5 from the live cluster" >&2
  echo "      (empty means readCurrentState did not run or was swallowed post-import)" >&2
  exit 1
fi
OBS_RELEASE="$(state_query 'st.resources["'"${CLUSTER_LID}"'"]?.observedProperties?.ReleaseLabel')"
if [ "${OBS_RELEASE}" != "emr-7.9.0" ]; then
  echo "FAIL: observedProperties.ReleaseLabel is '${OBS_RELEASE}', expected 'emr-7.9.0'" >&2
  exit 1
fi
# The reverse-mapped Instances block (ListInstanceGroups -> role-keyed CFn
# shape) is the bulk of readCurrentState's work — assert it round-tripped.
OBS_MASTER_TYPE="$(state_query 'st.resources["'"${CLUSTER_LID}"'"]?.observedProperties?.Instances?.MasterInstanceGroup?.InstanceType')"
if [ "${OBS_MASTER_TYPE}" != "m5.xlarge" ]; then
  echo "FAIL: observedProperties.Instances.MasterInstanceGroup.InstanceType is '${OBS_MASTER_TYPE}', expected 'm5.xlarge'" >&2
  exit 1
fi
# Tags come back through normalizeAwsTagsToCfn — Phase 2 set env=changed and
# removed `dropme`, so the observed baseline must agree with AWS, not the
# baseline template.
OBS_ENV_TAG="$(state_query '(st.resources["'"${CLUSTER_LID}"'"]?.observedProperties?.Tags ?? []).find((t) => t.Key === "env")?.Value')"
if [ "${OBS_ENV_TAG}" != "changed" ]; then
  echo "FAIL: observedProperties Tags env is '${OBS_ENV_TAG}', expected 'changed' (the live post-update value)" >&2
  exit 1
fi
echo "    observedProperties seeded from the LIVE cluster by readCurrentState"
echo "      (StepConcurrencyLevel=5, ReleaseLabel=emr-7.9.0, MasterInstanceGroup.InstanceType=m5.xlarge, env=changed)"

# --- Phase 4: destroy ----------------------------------------------------
# Runs THROUGH the state record Phase 3 re-adopted — a broken import would
# surface here as a cluster that never terminates.
echo "==> Phase 4: destroy via the re-adopted state record (EMR termination takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FINAL_STATE="$(cluster_state "${CID_P2}")"
if [ "${FINAL_STATE}" != "TERMINATED" ] && [ "${FINAL_STATE}" != "TERMINATED_WITH_ERRORS" ]; then
  echo "FAIL: EMR cluster ${CID_P2} not terminated after destroy (state '${FINAL_STATE}')" >&2
  exit 1
fi
echo "    cluster ${FINAL_STATE} (by id)"

# Leak assertion — use the STRICT lookup so a throttled `emr list-clusters`
# cannot masquerade as "no leftover clusters". Retry a few times before
# giving up, then hard-fail rather than pass on an undetermined result.
LEFTOVERS=""
LEAK_CHECK_OK=false
for attempt in 1 2 3; do
  if LEFTOVERS="$(strict_active_tagged_cluster_ids)"; then
    LEAK_CHECK_OK=true
    break
  fi
  echo "    warn: 'aws emr list-clusters --active' failed (attempt ${attempt}/3), retrying" >&2
  sleep 5
done
if [ "${LEAK_CHECK_OK}" != "true" ]; then
  echo "FAIL: could not determine whether ACTIVE EMR clusters remain (AWS API calls failed 3x)" >&2
  echo "      refusing to report PASS on an unverified leak check — check the account manually" >&2
  exit 1
fi
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: ACTIVE EMR cluster(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no active cluster with the fixture tag remains (verified, not inferred from a failed call)"

# Distinguish "the object is genuinely gone" (404) from "the call failed"
# (throttle / expired credentials / network). The naive
# `if aws s3api head-object ... >/dev/null 2>&1` form reads ANY failure as
# "gone" and would silently pass this leak assertion on a throttle.
HEAD_ERR="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1 >/dev/null)" \
  && HEAD_RC=0 || HEAD_RC=$?
if [ "${HEAD_RC}" -eq 0 ]; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
if ! printf '%s' "${HEAD_ERR}" | grep -qiE '404|Not Found'; then
  echo "FAIL: could not determine whether ${STATE_KEY} still exists — head-object failed with:" >&2
  echo "      ${HEAD_ERR}" >&2
  echo "      refusing to report PASS on an unverified leak check" >&2
  exit 1
fi
echo "    cdkd state removed (confirmed via a 404, not an ambiguous error)"

echo "[verify] PASS — AWS::EMR::Cluster SDK provider: deploy + in-place update (incl. tag removal) + import round-trip (orphan -> import -> observedProperties from live AWS) + destroy (TERMINATED) all passed"
