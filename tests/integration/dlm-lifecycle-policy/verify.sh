#!/usr/bin/env bash
# verify.sh — cdkd AWS::DLM::LifecyclePolicy SDK provider integ (issue #1040).
#
# The type is ProvisioningType: NON_PROVISIONABLE, so there is no Cloud
# Control fallback — this fixture proves the new SDK provider end to end.
#
# Phases:
#   1. Deploy a minimal EBS-snapshot lifecycle policy (+ its DLM execution
#      role). Assert via `aws dlm get-lifecycle-policy` that the policy is
#      ENABLED with the baseline description and carries the templated tags,
#      and that state routes it via the SDK provider (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: description change + State
#      ENABLED -> DISABLED (UpdateLifecyclePolicy), tag value change AND tag
#      removal (TagResource / UntagResource — the #981 regression class).
#      Assert the PolicyId is UNCHANGED (in-place update, no replacement),
#      the new description/state reached AWS, `env` is now `changed`, and
#      `dropme` is GONE.
#   3. Destroy + assert the policy is gone from AWS and the cdkd state file
#      is removed.
#
# The policy targets a tag no volume carries, so it never creates snapshots.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDlmLifecyclePolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="cdkd-integ-dlm-role"
CLEANUP_TAG="cdkd-integ=dlm-lifecycle-policy"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Delete any leftover lifecycle policy carrying the fixture's constant tag
  # (the policy id is service-generated, so look it up by tag).
  for pid in $(aws dlm get-lifecycle-policies --tags-to-add "${CLEANUP_TAG}" \
    --region "${REGION}" --query 'Policies[].PolicyId' --output text 2>/dev/null); do
    aws dlm delete-lifecycle-policy --policy-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # Delete the deterministic-name execution role (inline policy first).
  for pol in $(aws iam list-role-policies --role-name "${ROLE_NAME}" \
    --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${pol}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

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

policy_id_from_state() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::DLM::LifecyclePolicy");process.stdout.write((r[k]&&r[k].physicalId)||"")})'
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy baseline lifecycle policy (ENABLED, 3 tags)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_ID_P1="$(policy_id_from_state)"
if [ -z "${POLICY_ID_P1}" ]; then
  echo "FAIL: no AWS::DLM::LifecyclePolicy physicalId in cdkd state after Phase 1" >&2
  exit 1
fi
echo "    policy id: ${POLICY_ID_P1}"

STATE_P1="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P1}" --region "${REGION}" \
  --query 'Policy.State' --output text)"
DESC_P1="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P1}" --region "${REGION}" \
  --query 'Policy.Description' --output text)"
if [ "${STATE_P1}" != "ENABLED" ] || [ "${DESC_P1}" != "cdkd integ policy baseline" ]; then
  echo "FAIL: Phase 1 expected ENABLED/'cdkd integ policy baseline', got '${STATE_P1}'/'${DESC_P1}'" >&2
  exit 1
fi
ENV_TAG_P1="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P1}" --region "${REGION}" \
  --query 'Policy.Tags.env' --output text)"
DROPME_P1="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P1}" --region "${REGION}" \
  --query 'Policy.Tags.dropme' --output text)"
if [ "${ENV_TAG_P1}" != "test" ] || [ "${DROPME_P1}" != "yes" ]; then
  echo "FAIL: Phase 1 expected tags env=test dropme=yes, got env='${ENV_TAG_P1}' dropme='${DROPME_P1}'" >&2
  exit 1
fi
echo "    policy is ENABLED with baseline description and tags (env=test, dropme=yes)"

# The policy must route via the SDK provider (catch a routing flip).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::DLM::LifecyclePolicy");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected DLM policy provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    policy routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2: in-place update (state/description/tags) ------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (DISABLED, tag change + removal)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_ID_P2="$(policy_id_from_state)"
if [ "${POLICY_ID_P1}" != "${POLICY_ID_P2}" ]; then
  echo "FAIL: policy was REPLACED (${POLICY_ID_P1} -> ${POLICY_ID_P2})" >&2
  exit 1
fi
echo "    policy identity preserved (${POLICY_ID_P2}) — in-place update"

STATE_P2="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" \
  --query 'Policy.State' --output text)"
DESC_P2="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" \
  --query 'Policy.Description' --output text)"
if [ "${STATE_P2}" != "DISABLED" ] || [ "${DESC_P2}" != "cdkd integ policy updated" ]; then
  echo "FAIL: Phase 2 expected DISABLED/'cdkd integ policy updated', got '${STATE_P2}'/'${DESC_P2}'" >&2
  exit 1
fi
ENV_TAG_P2="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" \
  --query 'Policy.Tags.env' --output text)"
DROPME_P2="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" \
  --query 'Policy.Tags.dropme' --output text)"
if [ "${ENV_TAG_P2}" != "changed" ]; then
  echo "FAIL: Phase 2 expected tag env=changed, got '${ENV_TAG_P2}'" >&2
  exit 1
fi
if [ "${DROPME_P2}" != "None" ] && [ -n "${DROPME_P2}" ]; then
  echo "FAIL: Phase 2 expected tag 'dropme' to be REMOVED (UntagResource), still '${DROPME_P2}'" >&2
  exit 1
fi
echo "    update reached AWS (DISABLED, env=changed, dropme removed)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: lifecycle policy ${POLICY_ID_P2} still exists after destroy" >&2
  exit 1
fi
echo "    lifecycle policy deleted"

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: IAM role ${ROLE_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    execution role deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — AWS::DLM::LifecyclePolicy SDK provider: deploy + in-place update (incl. tag removal) + destroy all passed"
