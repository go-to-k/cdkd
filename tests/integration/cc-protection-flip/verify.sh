#!/usr/bin/env bash
# verify.sh — cdkd generic CC protection flip integ (issues #1314 / #1315).
#
# Five Tier 2 (Cloud-Control-routed) types deploy with deletion protection
# ON from creation:
#   - AWS::NeptuneGraph::Graph          (DeletionProtection: true)
#   - AWS::SMSVOICE::ProtectConfiguration (DeletionProtectionEnabled: true)
#   - AWS::VerifiedPermissions::PolicyStore (DeletionProtection: {Mode: ENABLED})
#   - AWS::RDS::GlobalCluster           (DeletionProtection: true; headless shell)
#   - AWS::DocDB::GlobalCluster         (DeletionProtection: true; headless shell)
#
# Phases:
#   1. Deploy. Assert each resource's protection value via
#      `aws cloudcontrol get-resource` (the same read path cdkd uses) and
#      that every resource routed via CC (provisionedBy=cc-api).
#   2. Bare destroy (no flag). Assert: exit non-zero, all five resources
#      still exist, state file retained.
#   3. Destroy with --remove-protection. Assert: exit 0, all five
#      resources gone, state file removed.
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

STACK="CdkdCcProtectionFlipExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
GRAPH_NAME="cdkd-ccprot-graph"
INTEG_TAG_KEY="cdkd-integ"
INTEG_TAG_VALUE="ccprot"
STORE_DESC="cdkd-integ-ccprot"
RDS_GLOBAL_ID="cdkd-ccprot-rds-global"
DOCDB_GLOBAL_ID="cdkd-ccprot-docdb-global"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --remove-protection --yes >/dev/null 2>&1
  fi
  # NeptuneGraph: deterministic name discovery.
  ( set +eu
    gid="$(aws neptune-graph list-graphs --region "${REGION}" \
      --query "graphs[?name=='${GRAPH_NAME}'].id | [0]" --output text 2>/dev/null)"
    if [ -n "${gid}" ] && [ "${gid}" != "None" ]; then
      aws neptune-graph update-graph --graph-identifier "${gid}" --no-deletion-protection --region "${REGION}" >/dev/null 2>&1
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
        st="$(aws neptune-graph get-graph --graph-identifier "${gid}" --region "${REGION}" --query 'status' --output text 2>/dev/null)"
        [ "${st}" = "AVAILABLE" ] && break
        sleep 5
      done
      aws neptune-graph delete-graph --graph-identifier "${gid}" --skip-snapshot --region "${REGION}" >/dev/null 2>&1
      echo "    deleted leftover NeptuneGraph graph ${gid}"
    fi
  )
  # SMSVOICE ProtectConfiguration: tag discovery.
  ( set +eu
    ids="$(aws pinpoint-sms-voice-v2 describe-protect-configurations --region "${REGION}" \
      --query 'ProtectConfigurations[].[ProtectConfigurationId,ProtectConfigurationArn]' --output text 2>/dev/null)"
    printf '%s\n' "${ids}" | while read -r pid parn; do
      [ -z "${pid}" ] && continue
      tagval="$(aws pinpoint-sms-voice-v2 list-tags-for-resource --resource-arn "${parn}" --region "${REGION}" \
        --query "Tags[?Key=='${INTEG_TAG_KEY}'].Value | [0]" --output text 2>/dev/null)"
      if [ "${tagval}" = "${INTEG_TAG_VALUE}" ]; then
        aws pinpoint-sms-voice-v2 update-protect-configuration --protect-configuration-id "${pid}" \
          --no-deletion-protection-enabled --region "${REGION}" >/dev/null 2>&1
        aws pinpoint-sms-voice-v2 delete-protect-configuration --protect-configuration-id "${pid}" \
          --region "${REGION}" >/dev/null 2>&1
        echo "    deleted leftover ProtectConfiguration ${pid}"
      fi
    done
  )
  # VerifiedPermissions PolicyStore: description discovery.
  ( set +eu
    sids="$(aws verifiedpermissions list-policy-stores --region "${REGION}" \
      --query "policyStores[?description=='${STORE_DESC}'].policyStoreId" --output text 2>/dev/null)"
    for sid in ${sids}; do
      [ "${sid}" = "None" ] && continue
      aws verifiedpermissions update-policy-store --policy-store-id "${sid}" \
        --validation-settings mode=OFF --deletion-protection mode=DISABLED --region "${REGION}" >/dev/null 2>&1
      aws verifiedpermissions delete-policy-store --policy-store-id "${sid}" --region "${REGION}" >/dev/null 2>&1
      echo "    deleted leftover PolicyStore ${sid}"
    done
  )
  # RDS / DocDB global cluster shells: deterministic identifier discovery.
  ( set +eu
    if aws rds describe-global-clusters --global-cluster-identifier "${RDS_GLOBAL_ID}" --region "${REGION}" >/dev/null 2>&1; then
      aws rds modify-global-cluster --global-cluster-identifier "${RDS_GLOBAL_ID}" --no-deletion-protection --region "${REGION}" >/dev/null 2>&1
      aws rds delete-global-cluster --global-cluster-identifier "${RDS_GLOBAL_ID}" --region "${REGION}" >/dev/null 2>&1
      echo "    deleted leftover RDS global cluster ${RDS_GLOBAL_ID}"
    fi
    if aws docdb describe-global-clusters --global-cluster-identifier "${DOCDB_GLOBAL_ID}" --region "${REGION}" >/dev/null 2>&1; then
      aws docdb modify-global-cluster --global-cluster-identifier "${DOCDB_GLOBAL_ID}" --no-deletion-protection --region "${REGION}" >/dev/null 2>&1
      aws docdb delete-global-cluster --global-cluster-identifier "${DOCDB_GLOBAL_ID}" --region "${REGION}" >/dev/null 2>&1
      echo "    deleted leftover DocDB global cluster ${DOCDB_GLOBAL_ID}"
    fi
  )
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f destroy-blocked.log
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

# Reads the physicalId of the single resource of a given type from cdkd
# state. Usage: state_physical_id <ResourceType>
state_physical_id() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType===process.argv[1]);process.stdout.write(k?r[k].physicalId:"")})' "$1"
}

# Reads a property from a live resource via Cloud Control (the same read
# path cdkd itself uses). Usage: cc_property <ResourceType> <Identifier> <js-expr>
cc_property() {
  aws cloudcontrol get-resource --type-name "$1" --identifier "$2" --region "${REGION}" \
    --query 'ResourceDescription.Properties' --output text \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);const v=eval("p."+process.argv[1]);process.stdout.write(String(v))})' "$3"
}

GRAPH_TYPE="AWS::NeptuneGraph::Graph"
PROT_TYPE="AWS::SMSVOICE::ProtectConfiguration"
STORE_TYPE="AWS::VerifiedPermissions::PolicyStore"
RDSG_TYPE="AWS::RDS::GlobalCluster"
DOCDBG_TYPE="AWS::DocDB::GlobalCluster"

# --- Phase 1: deploy with protection ON --------------------------------
echo "==> Phase 1: deploy (all five types protected from creation)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

GRAPH_ID="$(state_physical_id "${GRAPH_TYPE}")"
PROT_ID="$(state_physical_id "${PROT_TYPE}")"
STORE_ID="$(state_physical_id "${STORE_TYPE}")"
RDSG_ID="$(state_physical_id "${RDSG_TYPE}")"
DOCDBG_ID="$(state_physical_id "${DOCDBG_TYPE}")"
if [ -z "${GRAPH_ID}" ] || [ -z "${PROT_ID}" ] || [ -z "${STORE_ID}" ] || [ -z "${RDSG_ID}" ] || [ -z "${DOCDBG_ID}" ]; then
  echo "FAIL: missing physicalId in state (graph='${GRAPH_ID}' prot='${PROT_ID}' store='${STORE_ID}' rdsGlobal='${RDSG_ID}' docdbGlobal='${DOCDBG_ID}')" >&2
  exit 1
fi
echo "    graph=${GRAPH_ID} protectConfig=${PROT_ID} policyStore=${STORE_ID} rdsGlobal=${RDSG_ID} docdbGlobal=${DOCDBG_ID}"

V1="$(cc_property "${GRAPH_TYPE}" "${GRAPH_ID}" 'DeletionProtection')"
V2="$(cc_property "${PROT_TYPE}" "${PROT_ID}" 'DeletionProtectionEnabled')"
V3="$(cc_property "${STORE_TYPE}" "${STORE_ID}" 'DeletionProtection.Mode')"
V4="$(cc_property "${RDSG_TYPE}" "${RDSG_ID}" 'DeletionProtection')"
V5="$(cc_property "${DOCDBG_TYPE}" "${DOCDBG_ID}" 'DeletionProtection')"
if [ "${V1}" != "true" ] || [ "${V2}" != "true" ] || [ "${V3}" != "ENABLED" ] || [ "${V4}" != "true" ] || [ "${V5}" != "true" ]; then
  echo "FAIL: expected protection ON everywhere (graph=${V1} prot=${V2} store=${V3} rdsGlobal=${V4} docdbGlobal=${V5})" >&2
  exit 1
fi
echo "    protection is ON for all five (via cloudcontrol get-resource)"

ROUTES="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources;const bad=Object.keys(r).filter(k=>r[k].resourceType!=="AWS::CDK::Metadata"&&r[k].provisionedBy!=="cc-api");process.stdout.write(bad.length?bad.join(","):"ok")})')"
if [ "${ROUTES}" != "ok" ]; then
  echo "FAIL: expected every resource provisionedBy=cc-api, offenders: ${ROUTES}" >&2
  exit 1
fi
echo "    all resources routed via Cloud Control (provisionedBy=cc-api)"

# --- Phase 2: bare destroy must fail on every protected resource -------
echo "==> Phase 2: bare destroy (must fail; protection is ON)"
if node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force \
    > destroy-blocked.log 2>&1; then
  echo "FAIL: bare destroy succeeded despite protection ON" >&2
  tail -20 destroy-blocked.log >&2
  exit 1
fi
echo "    bare destroy exited non-zero as expected"

# NOTE: '|' delimiter — CFn type names contain '::', so a ':' split would
# cut at the first colon (AWS|:NeptuneGraph::Graph...).
for spec in "${GRAPH_TYPE}|${GRAPH_ID}" "${PROT_TYPE}|${PROT_ID}" "${STORE_TYPE}|${STORE_ID}" "${RDSG_TYPE}|${RDSG_ID}" "${DOCDBG_TYPE}|${DOCDBG_ID}"; do
  t="${spec%%|*}"; i="${spec#*|}"
  if gone_probe aws cloudcontrol get-resource --type-name "${t}" --identifier "${i}" --region "${REGION}"; then
    echo "FAIL: ${t} ${i} was DELETED by the blocked bare destroy" >&2
    exit 1
  fi
done
echo "    all five resources survived the blocked destroy"

aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    cdkd state retained after blocked destroy"

# --- Phase 3: destroy --remove-protection ------------------------------
echo "==> Phase 3: destroy --remove-protection (flips all five off via CC patch, then deletes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection

assert_gone "NeptuneGraph graph ${GRAPH_ID} still exists after destroy" \
  aws cloudcontrol get-resource --type-name "${GRAPH_TYPE}" --identifier "${GRAPH_ID}" --region "${REGION}"
assert_gone "ProtectConfiguration ${PROT_ID} still exists after destroy" \
  aws cloudcontrol get-resource --type-name "${PROT_TYPE}" --identifier "${PROT_ID}" --region "${REGION}"
assert_gone "PolicyStore ${STORE_ID} still exists after destroy" \
  aws cloudcontrol get-resource --type-name "${STORE_TYPE}" --identifier "${STORE_ID}" --region "${REGION}"
assert_gone "RDS global cluster ${RDSG_ID} still exists after destroy" \
  aws cloudcontrol get-resource --type-name "${RDSG_TYPE}" --identifier "${RDSG_ID}" --region "${REGION}"
assert_gone "DocDB global cluster ${DOCDBG_ID} still exists after destroy" \
  aws cloudcontrol get-resource --type-name "${DOCDBG_TYPE}" --identifier "${DOCDBG_ID}" --region "${REGION}"
echo "    all five resources deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — generic CC protection flip (NeptuneGraph / SMSVOICE ProtectConfiguration / VerifiedPermissions PolicyStore / RDS GlobalCluster / DocDB GlobalCluster), all 3 phases passed"
