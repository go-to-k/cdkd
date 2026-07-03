#!/usr/bin/env bash
# verify.sh — cdkd circular Security Group reference integ test.
#
# Models the classic CloudFormation cycle the CFn-safe way: SG-A allows
# ingress from SG-B AND SG-B allows ingress from SG-A, where each rule is a
# STANDALONE AWS::EC2::SecurityGroupIngress resource (NOT an inline ingress)
# so the two SGs can exist before the cross-references are added.
#
# What it stresses in cdkd:
#   1. DEPLOY: the DAG builder must NOT raise a false `DependencyError` —
#      the standalone ingress resources break what would otherwise be a cycle.
#      This script first confirms via `cdkd synth` that CDK emitted exactly
#      two standalone `AWS::EC2::SecurityGroupIngress` resources and ZERO
#      inline `SecurityGroupIngress` entries on either SG.
#   2. DESTROY (the key test): the ingress rules must be revoked BEFORE the
#      SGs are deleted. An SG still referenced by a live cross-SG ingress rule
#      cannot be deleted — AWS rejects `DeleteSecurityGroup` with
#      `DependencyViolation: resource sg-xxx has a dependent object`. If cdkd
#      orders the deletes wrong, destroy FAILS or orphans SGs/VPC here.
#
# Asserts post-deploy: both SGs exist, each carries the cross-referencing
# ingress rule (UserIdGroupPairs points at the OTHER SG). Asserts post-destroy:
# both SGs gone, VPC gone, state file gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-safe (macOS): no `grep -P`, no `date -d`. Resources are located by the
# `cdkd:integ-fixture=sg-circular-dependency` tag (NOT aws:cdk:path, which AWS
# reserves and cdkd cannot set).

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSgCircularExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="sg-circular-dependency"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Captured ids (best-effort) so the cleanup trap can revoke-then-delete
# directly if cdkd's own destroy ordering fails.
SG_A_ID=""
SG_B_ID=""
VPC_ID=""

# Revoke every ingress rule off both SGs, then delete the SGs, then the VPC.
# This is the SAME ordering cdkd must perform — doing it here in cleanup
# guarantees we never leak resources even if cdkd's destroy left orphans.
force_cleanup_aws() {
  set +eu
  # 1) Revoke ALL ingress on each SG so neither references the other anymore.
  for SG in "${SG_A_ID}" "${SG_B_ID}"; do
    [ -z "${SG}" ] && continue
    PERMS=$(aws ec2 describe-security-groups \
      --group-ids "${SG}" \
      --region "${REGION}" \
      --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null)
    if [ -n "${PERMS}" ] && [ "${PERMS}" != "null" ] && [ "${PERMS}" != "[]" ]; then
      echo "    [cleanup] revoking ingress on ${SG}"
      aws ec2 revoke-security-group-ingress \
        --group-id "${SG}" \
        --ip-permissions "${PERMS}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    fi
  done
  # 2) Now the cross-references are gone, the SGs can be deleted.
  for SG in "${SG_A_ID}" "${SG_B_ID}"; do
    [ -z "${SG}" ] && continue
    echo "    [cleanup] deleting ${SG}"
    aws ec2 delete-security-group --group-id "${SG}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # 3) VPC last (subnet/IGW/route-table teardown is left to cdkd; if cdkd
  #    already removed them this is a no-op, otherwise we at least try).
  if [ -n "${VPC_ID}" ]; then
    echo "    [cleanup] attempting VPC delete ${VPC_ID} (best-effort)"
    aws ec2 delete-vpc --vpc-id "${VPC_ID}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  set -eu
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # state destroy first — exercises cdkd's own teardown ordering. Do NOT
    # silence stderr so a partial failure is visible.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders direct revoke-then-delete in case state destroy could
  # not complete (e.g. ordering bug left SGs cross-referencing each other).
  force_cleanup_aws
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

# --- Phase 0: synth — confirm the circular ref is modeled as standalone -----
#              AWS::EC2::SecurityGroupIngress resources (NOT inline ingress).
echo "==> Phase 0: synth and confirm standalone SecurityGroupIngress resources"
SYNTH_DIR="$(mktemp -d)"
# NOTE: `cdkd synth` only synthesizes the CDK app to a template — it does NOT
# read or write state, so it does NOT accept --state-bucket / --region (passing
# --state-bucket fails with `error: unknown option '--state-bucket'`). Only
# --output (+ the stack selector) are valid here.
node "${LOCAL_DIST}" synth "${STACK}" \
  --output "${SYNTH_DIR}" >/dev/null

TEMPLATE_FILE="${SYNTH_DIR}/${STACK}.template.json"
if [ ! -f "${TEMPLATE_FILE}" ]; then
  # Fall back to the first template in the synth dir.
  TEMPLATE_FILE=$(find "${SYNTH_DIR}" -name '*.template.json' | head -1)
fi
if [ -z "${TEMPLATE_FILE}" ] || [ ! -f "${TEMPLATE_FILE}" ]; then
  echo "FAIL: could not find synthesized template under ${SYNTH_DIR}" >&2
  rm -rf "${SYNTH_DIR}"
  exit 1
fi

INGRESS_COUNT=$(jq '[.Resources | to_entries[] | select(.value.Type == "AWS::EC2::SecurityGroupIngress")] | length' "${TEMPLATE_FILE}")
if [ "${INGRESS_COUNT}" -lt 2 ]; then
  echo "FAIL: expected >= 2 standalone AWS::EC2::SecurityGroupIngress resources, found ${INGRESS_COUNT} — the circular ref is NOT modeled the CFn-safe way" >&2
  jq '.Resources | to_entries[] | {id: .key, type: .value.Type}' "${TEMPLATE_FILE}" >&2
  rm -rf "${SYNTH_DIR}"
  exit 1
fi
echo "    OK: ${INGRESS_COUNT} standalone AWS::EC2::SecurityGroupIngress resources (cycle broken)"

# Confirm at least one standalone ingress references a SG as its source
# (UserIdGroupPairs / SourceSecurityGroupId via Fn::GetAtt or Ref), proving
# the cross-reference is the SG-to-SG kind, not a CIDR rule.
CROSS_REF_COUNT=$(jq '[.Resources | to_entries[]
  | select(.value.Type == "AWS::EC2::SecurityGroupIngress")
  | select(.value.Properties.SourceSecurityGroupId != null)] | length' "${TEMPLATE_FILE}")
if [ "${CROSS_REF_COUNT}" -lt 2 ]; then
  echo "FAIL: expected >= 2 ingress resources with SourceSecurityGroupId (SG-to-SG cross-ref), found ${CROSS_REF_COUNT}" >&2
  jq '.Resources | to_entries[] | select(.value.Type == "AWS::EC2::SecurityGroupIngress") | .value.Properties' "${TEMPLATE_FILE}" >&2
  rm -rf "${SYNTH_DIR}"
  exit 1
fi
echo "    OK: ${CROSS_REF_COUNT} ingress resources carry a SG-to-SG SourceSecurityGroupId (true circular ref)"

# Confirm NO AWS::EC2::SecurityGroup carries a non-empty inline
# `Properties.SecurityGroupIngress` array — the circular refs MUST be emitted
# ONLY as standalone AWS::EC2::SecurityGroupIngress resources (an inline ingress
# entry pointing at the other SG is exactly what reintroduces the CFn cycle this
# fixture exists to avoid). Names the offending SG logical id on failure.
INLINE_INGRESS_SGS=$(jq -r '[.Resources | to_entries[]
  | select(.value.Type == "AWS::EC2::SecurityGroup")
  | select((.value.Properties.SecurityGroupIngress // []) | length > 0)
  | .key] | join(", ")' "${TEMPLATE_FILE}")
if [ -n "${INLINE_INGRESS_SGS}" ]; then
  echo "FAIL: SecurityGroup(s) carry a non-empty inline Properties.SecurityGroupIngress: ${INLINE_INGRESS_SGS} — the circular refs must be emitted ONLY as standalone AWS::EC2::SecurityGroupIngress resources, not inline ingress" >&2
  jq '.Resources | to_entries[] | select(.value.Type == "AWS::EC2::SecurityGroup") | {id: .key, ingress: .value.Properties.SecurityGroupIngress}' "${TEMPLATE_FILE}" >&2
  rm -rf "${SYNTH_DIR}"
  exit 1
fi
echo "    OK: zero inline Properties.SecurityGroupIngress on any SecurityGroup (cross-refs are standalone-only)"
rm -rf "${SYNTH_DIR}"

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy with the local binary (DAG builder must NOT see a false cycle)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy (deploy likely failed)" >&2
  exit 1
fi

# Resolve both SG ids + the VPC id from state (physicalIds).
SG_IDS=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .value.physicalId] | .[]')
SG_A_ID=$(echo "${SG_IDS}" | sed -n '1p')
SG_B_ID=$(echo "${SG_IDS}" | sed -n '2p')
VPC_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first // ""')

if [ -z "${SG_A_ID}" ] || [ -z "${SG_B_ID}" ] || [ "${SG_A_ID}" = "null" ] || [ "${SG_B_ID}" = "null" ]; then
  echo "FAIL: could not resolve both SecurityGroup ids from state (got A='${SG_A_ID}' B='${SG_B_ID}')" >&2
  echo "${STATE}" | jq '.resources | to_entries[] | {id: .key, type: .value.resourceType, physicalId: .value.physicalId}'
  exit 1
fi
echo "    resolved SG-A=${SG_A_ID} SG-B=${SG_B_ID} VPC=${VPC_ID}"

# --- Assertions: both SGs exist and carry the cross-referencing ingress -----
SG_DESC=$(aws ec2 describe-security-groups \
  --group-ids "${SG_A_ID}" "${SG_B_ID}" \
  --region "${REGION}" \
  --query 'SecurityGroups' --output json 2>/dev/null)
if [ -z "${SG_DESC}" ] || [ "${SG_DESC}" = "null" ]; then
  echo "FAIL: DescribeSecurityGroups returned empty for ${SG_A_ID} / ${SG_B_ID}" >&2
  exit 1
fi

FOUND_SGS=$(echo "${SG_DESC}" | jq 'length')
if [ "${FOUND_SGS}" -ne 2 ]; then
  echo "FAIL: expected 2 security groups present after deploy, found ${FOUND_SGS}" >&2
  echo "${SG_DESC}" | jq '[.[].GroupId]'
  exit 1
fi
echo "    OK: both security groups exist on AWS"

# SG-A must have an ingress rule whose source group is SG-B, and vice versa.
A_REFERENCES_B=$(echo "${SG_DESC}" | jq --arg a "${SG_A_ID}" --arg b "${SG_B_ID}" \
  '[.[] | select(.GroupId == $a) | .IpPermissions[].UserIdGroupPairs[].GroupId] | index($b) != null')
B_REFERENCES_A=$(echo "${SG_DESC}" | jq --arg a "${SG_A_ID}" --arg b "${SG_B_ID}" \
  '[.[] | select(.GroupId == $b) | .IpPermissions[].UserIdGroupPairs[].GroupId] | index($a) != null')

if [ "${A_REFERENCES_B}" != "true" ]; then
  echo "FAIL: SG-A (${SG_A_ID}) has no ingress rule referencing SG-B (${SG_B_ID}) — circular ingress not applied" >&2
  echo "${SG_DESC}" | jq --arg a "${SG_A_ID}" '.[] | select(.GroupId == $a) | .IpPermissions'
  exit 1
fi
if [ "${B_REFERENCES_A}" != "true" ]; then
  echo "FAIL: SG-B (${SG_B_ID}) has no ingress rule referencing SG-A (${SG_A_ID}) — circular ingress not applied" >&2
  echo "${SG_DESC}" | jq --arg b "${SG_B_ID}" '.[] | select(.GroupId == $b) | .IpPermissions'
  exit 1
fi
echo "    OK: SG-A ingress references SG-B AND SG-B ingress references SG-A (circular ref is live on AWS)"

# --- Phase 2: destroy (THE KEY TEST) ---------------------------------------
# cdkd MUST revoke both ingress rules BEFORE deleting either SG. If it deletes
# an SG while the cross-reference is still live, AWS returns DependencyViolation
# and this step fails / leaves orphans.
echo "==> Phase 2: destroy (ingress rules MUST be revoked before the SGs are deleted)"
if ! node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force; then
  echo "FAIL: cdkd destroy returned non-zero — likely DeleteSecurityGroup DependencyViolation because an SG was deleted while still cross-referenced. Check the destroy output above for the offending resource + AWS error." >&2
  exit 1
fi

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# Both SGs must be gone from AWS.
for SG in "${SG_A_ID}" "${SG_B_ID}"; do
  if aws ec2 describe-security-groups --group-ids "${SG}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: security group ${SG} still exists after destroy (orphan — destroy ordering likely deleted in the wrong order or skipped it)" >&2
    exit 1
  fi
done
echo "    OK: both security groups are gone from AWS"

# VPC must be gone.
if [ -n "${VPC_ID}" ]; then
  if aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: VPC ${VPC_ID} still exists after destroy (orphan)" >&2
    exit 1
  fi
  echo "    OK: VPC ${VPC_ID} is gone from AWS"
fi

# Everything cleaned by cdkd — clear ids so the EXIT trap is a no-op.
SG_A_ID=""
SG_B_ID=""
VPC_ID=""

echo ""
echo "=== PASS: circular Security Group reference deploy + destroy integ ==="
