#!/usr/bin/env bash
# verify.sh — cdkd Aurora DSQL cluster integ (Cloud Control API fallback path).
#
# AWS::DSQL::Cluster has no SDK Provider (Tier 2 in the provider coverage
# report), so this fixture exercises the CC API path end to end for an
# async-lifecycle resource: create (CREATING -> ACTIVE), a tag-only in-place
# UPDATE via the CC patch document, and an async delete.
#
# DSQL clusters have NO user-settable name — the service generates the
# identifier — so the cluster is located via the stack outputs (ClusterId /
# ClusterArn) recorded in cdkd state, and pre/post-run cleanup discovers
# leftovers by the deterministic `cdkd-integ=dsql` tag.
#
# Phases:
#   1. Deploy a single-region cluster (deletion protection OFF, phase=one
#      tag). Assert: status ACTIVE, deletionProtectionEnabled=false, tags
#      reached AWS, and the resource routed via CC (provisionedBy=cc-api).
#   2. Re-deploy with CDKD_TEST_UPDATE=true (phase tag flips to `two` AND
#      deletion protection flips ON). Assert: identifier + creationTime
#      unchanged (in-place, no replacement), the tag value updated in AWS,
#      and deletionProtectionEnabled=true.
#   3. Attempt destroy while protection is ON. Assert: destroy exits
#      non-zero, the cluster is still ACTIVE, and the cdkd state file is
#      still present (the failed delete must not drop the resource from
#      state).
#   4. Destroy with --remove-protection while protection is STILL ON
#      (issue #1312: the generic CC protection flip patches
#      DeletionProtectionEnabled=false in-place, then deletes). Assert:
#      destroy succeeds, the cluster is gone, and the cdkd state file is
#      removed.
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

STACK="CdkdDsqlExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
INTEG_TAG_KEY="cdkd-integ"
INTEG_TAG_VALUE="dsql"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # DSQL clusters have no deterministic name: discover leftovers by the integ
  # tag and best-effort delete them (dropping deletion protection first).
  ( set +eu
    ids="$(aws dsql list-clusters --region "${REGION}" --query 'clusters[].identifier' --output text 2>/dev/null)"
    for id in ${ids}; do
      [ "${id}" = "None" ] && continue
      arn="$(aws dsql get-cluster --identifier "${id}" --region "${REGION}" --query 'arn' --output text 2>/dev/null)"
      [ -z "${arn}" ] && continue
      tagval="$(aws dsql list-tags-for-resource --resource-arn "${arn}" --region "${REGION}" --query "tags.\"${INTEG_TAG_KEY}\"" --output text 2>/dev/null)"
      if [ "${tagval}" = "${INTEG_TAG_VALUE}" ]; then
        aws dsql update-cluster --identifier "${id}" --no-deletion-protection-enabled --region "${REGION}" >/dev/null 2>&1
        # The update leaves the cluster UPDATING for a moment; a back-to-back
        # delete can be rejected with a conflict. Wait (bounded) for ACTIVE.
        for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
          st="$(aws dsql get-cluster --identifier "${id}" --region "${REGION}" --query 'status' --output text 2>/dev/null)"
          [ "${st}" = "ACTIVE" ] && break
          sleep 5
        done
        aws dsql delete-cluster --identifier "${id}" --region "${REGION}" >/dev/null 2>&1
        echo "    deleted leftover DSQL cluster ${id}"
      fi
    done
  )
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f destroy-protected.log
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

# Reads a named stack output from cdkd state. Usage: state_output <OutputName>
state_output() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.state.outputs[process.argv[1]]||"")})' "$1"
}

# --- Phase 1: deploy baseline cluster ----------------------------------
echo "==> Phase 1: deploy DSQL cluster (deletion protection off, phase=one)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CLUSTER_ID="$(state_output ClusterId)"
CLUSTER_ARN="$(state_output ClusterArn)"
if [ -z "${CLUSTER_ID}" ] || [ -z "${CLUSTER_ARN}" ]; then
  echo "FAIL: ClusterId/ClusterArn outputs missing from cdkd state" >&2
  exit 1
fi
echo "    cluster identifier=${CLUSTER_ID}"

STATUS_P1="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
  --query 'status' --output text)"
if [ "${STATUS_P1}" != "ACTIVE" ]; then
  echo "FAIL: expected cluster status ACTIVE after Phase 1, got '${STATUS_P1}'" >&2
  exit 1
fi
echo "    cluster is ACTIVE"

PROTECTION_P1="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
  --query 'deletionProtectionEnabled' --output text)"
if [ "${PROTECTION_P1}" != "False" ]; then
  echo "FAIL: expected deletionProtectionEnabled=False (API default is true; the template must have overridden it), got '${PROTECTION_P1}'" >&2
  exit 1
fi
echo "    deletion protection is off (template value reached AWS)"

PHASE_TAG_P1="$(aws dsql list-tags-for-resource --resource-arn "${CLUSTER_ARN}" --region "${REGION}" \
  --query 'tags.phase' --output text)"
if [ "${PHASE_TAG_P1}" != "one" ]; then
  echo "FAIL: expected tag phase=one after Phase 1, got '${PHASE_TAG_P1}'" >&2
  exit 1
fi
echo "    tags reached AWS (phase=one)"

CREATION_P1="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
  --query 'creationTime' --output text)"
echo "    baseline creationTime=${CREATION_P1}"

# The cluster must route via the CC API fallback (no SDK provider exists for
# AWS::DSQL::Cluster — catch a silent routing flip in either direction).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::DSQL::Cluster");process.stdout.write(k?(r[k].provisionedBy||"sdk"):"missing-from-state")})')"
if [ "${PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: expected DSQL cluster provisionedBy=cc-api, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    cluster routed via Cloud Control API (provisionedBy=cc-api)"

# --- Phase 2: in-place UPDATE (tag flip + protection ON) ---------------
echo "==> Phase 2: re-deploy flipping tag phase=one -> two and protection ON (in-place CC update)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The cluster must be the SAME cluster (no replacement): identifier and
# creationTime unchanged.
CLUSTER_ID_P2="$(state_output ClusterId)"
if [ "${CLUSTER_ID}" != "${CLUSTER_ID_P2}" ]; then
  echo "FAIL: cluster was REPLACED (identifier ${CLUSTER_ID} -> ${CLUSTER_ID_P2})" >&2
  exit 1
fi
CREATION_P2="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
  --query 'creationTime' --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: cluster was REPLACED (creationTime ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    cluster identity preserved (identifier + creationTime unchanged) — no replacement"

PHASE_TAG_P2="$(aws dsql list-tags-for-resource --resource-arn "${CLUSTER_ARN}" --region "${REGION}" \
  --query 'tags.phase' --output text)"
if [ "${PHASE_TAG_P2}" != "two" ]; then
  echo "FAIL: expected tag phase=two after Phase 2, got '${PHASE_TAG_P2}'" >&2
  exit 1
fi
echo "    tag update reached AWS (phase=two)"

PROTECTION_P2="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
  --query 'deletionProtectionEnabled' --output text)"
if [ "${PROTECTION_P2}" != "True" ]; then
  echo "FAIL: expected deletionProtectionEnabled=True after Phase 2, got '${PROTECTION_P2}'" >&2
  exit 1
fi
echo "    deletion protection flipped on (boolean update reached AWS)"

# --- Phase 3: destroy attempt with protection ON (must fail) -----------
echo "==> Phase 3: destroy attempt while deletion protection is ON (must fail)"
if node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force \
    > destroy-protected.log 2>&1; then
  echo "FAIL: destroy succeeded despite deletionProtectionEnabled=true" >&2
  tail -20 destroy-protected.log >&2
  exit 1
fi
echo "    destroy exited non-zero as expected"

STATUS_P3="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
  --query 'status' --output text)"
if [ "${STATUS_P3}" != "ACTIVE" ]; then
  echo "FAIL: expected cluster still ACTIVE after blocked destroy, got '${STATUS_P3}'" >&2
  exit 1
fi
echo "    cluster survived the blocked destroy (still ACTIVE)"

# The failed delete must not drop the resource from state — the state file
# must still exist (strict probe: any failure here aborts under set -e).
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    cdkd state retained after blocked destroy"

# --- Phase 4: destroy --remove-protection (protection still ON) --------
# Issue #1312: the generic CC protection flip patches
# DeletionProtectionEnabled=false in-place via UpdateResource, waits, then
# deletes — so the destroy must succeed WITHOUT re-deploying protection off.
echo "==> Phase 4: destroy --remove-protection while protection is still ON"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection

# The CC delete polls the handler to completion, so the cluster should be gone
# (not-found) by now — but tolerate a terminal DELETING/DELETED read in case
# the service keeps the record visible briefly after handler success.
if gone_probe aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}"; then
  status="GONE"
elif ! status="$(aws dsql get-cluster --identifier "${CLUSTER_ID}" --region "${REGION}" \
    --query 'status' --output text 2>&1)"; then
  # TOCTOU: the cluster can vanish between gone_probe and this requery.
  printf '%s' "${status}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && status="GONE" \
    || { echo "FAIL: get-cluster requery undetermined: ${status}" >&2; exit 1; }
fi
if [ "${status}" != "GONE" ] && [ "${status}" != "PENDING_DELETE" ] && [ "${status}" != "DELETING" ] && [ "${status}" != "DELETED" ]; then
  echo "FAIL: cluster ${CLUSTER_ID} still exists (status ${status}) after destroy" >&2
  exit 1
fi
echo "    cluster deleted (status: ${status})"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Aurora DSQL cluster create/update/protected-destroy-block/remove-protection-destroy via CC API fallback, all 4 phases passed"
