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
#   3. The `sgr-...` SECURITY-GROUP RULE ID (issue #1761). CloudFormation
#      identifies an ingress rule by the single field `Id`, which is that rule
#      id — NOT any segment of cdkd's composite physicalId — so `cdkd export`
#      can only build a correct `ResourcesToImport[].ResourceIdentifier` from a
#      recorded attribute. Two assertions cover it: state must carry
#      `attributes.Id` in `sgr-` shape after deploy, and `cdkd export --dry-run`
#      must RESOLVE that exact value into the import plan.
#
#      The export arm runs against a SECOND stack, `CdkdSgIngressExportExample`
#      — see `lib/sg-ingress-export-stack.ts` for why. Short version: `cdkd
#      export` aborts the whole run on the first resource it cannot resolve
#      (under `--dry-run` too), and this fixture's `ec2.Vpc` emits an
#      `AWS::EC2::Route`, whose two-field CFn identifier has no composite-id
#      splitter registered (issue #1771) — so the export would abort before ever
#      reaching an ingress row.
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

STACK="CdkdSgCircularExample"
# The issue #1761 export arm (see the header). Deployed, asserted and destroyed
# inside phase 1b so the main destroy phase below is unchanged.
EXPORT_STACK="CdkdSgIngressExportExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EXPORT_STATE_KEY="cdkd/${EXPORT_STACK}/${REGION}/state.json"
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
EXPORT_SG_A_ID=""
EXPORT_SG_B_ID=""
EXPORT_VPC_ID=""

# Revoke every ingress rule off both SGs, then delete the SGs, then the VPC.
# This is the SAME ordering cdkd must perform — doing it here in cleanup
# guarantees we never leak resources even if cdkd's destroy left orphans.
force_cleanup_aws() {
  set +eu
  # 1) Revoke ALL ingress on each SG so neither references the other anymore.
  for SG in "${SG_A_ID}" "${SG_B_ID}" "${EXPORT_SG_A_ID}" "${EXPORT_SG_B_ID}"; do
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
  for SG in "${SG_A_ID}" "${SG_B_ID}" "${EXPORT_SG_A_ID}" "${EXPORT_SG_B_ID}"; do
    [ -z "${SG}" ] && continue
    echo "    [cleanup] deleting ${SG}"
    aws ec2 delete-security-group --group-id "${SG}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # 3) VPCs last (subnet/IGW/route-table teardown is left to cdkd; if cdkd
  #    already removed them this is a no-op, otherwise we at least try).
  for VPC in "${VPC_ID}" "${EXPORT_VPC_ID}"; do
    [ -z "${VPC}" ] && continue
    echo "    [cleanup] attempting VPC delete ${VPC} (best-effort)"
    aws ec2 delete-vpc --vpc-id "${VPC}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  set -eu
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # state destroy first — exercises cdkd's own teardown ordering. Do NOT
    # silence stderr so a partial failure is visible.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
    node "${LOCAL_DIST}" state destroy "${EXPORT_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders direct revoke-then-delete in case state destroy could
  # not complete (e.g. ordering bug left SGs cross-referencing each other).
  force_cleanup_aws
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${EXPORT_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${EXPORT_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Issue #1761: the sgr- rule id must be RECORDED in state ----------------
# Every AWS::EC2::SecurityGroupIngress row must carry `attributes.Id` holding
# the `sgr-...` id AuthorizeSecurityGroupIngress returned. Before the fix the
# provider recorded `attributes: {}`, so this loop fails on the FIRST row.
#
# NOTE: no `jq -e` anywhere below. `jq -e` exits non-zero when the RESULT is
# `false`, so a boolean probe written that way takes the read-failure branch and
# accuses the fix instead of reporting the value.
assert_recorded_rule_ids() { # usage: assert_recorded_rule_ids "<state json>" "<label>"
  local state_json="$1"
  local label="$2"
  local rows logical_id rule_id count

  rows=$(printf '%s' "${state_json}" | jq -r '
    .resources | to_entries[]
    | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress")
    | .key + " " + (.value.attributes.Id // "<MISSING>")')

  count=0
  while IFS=' ' read -r logical_id rule_id; do
    [ -z "${logical_id}" ] && continue
    count=$((count + 1))
    case "${rule_id}" in
      sgr-*)
        echo "    OK: ${label} ${logical_id} recorded attributes.Id=${rule_id}"
        ;;
      *)
        echo "FAIL: ${label} ${logical_id} (AWS::EC2::SecurityGroupIngress) has attributes.Id='${rule_id}' — expected the 'sgr-...' security-group rule id AWS returns from AuthorizeSecurityGroupIngress. Without it 'cdkd export' cannot build the CloudFormation import identifier (issue #1761)." >&2
        printf '%s' "${state_json}" | jq '.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress") | {id: .key, physicalId: .value.physicalId, attributes: .value.attributes}' >&2
        exit 1
        ;;
    esac
  done <<EOF
${rows}
EOF

  if [ "${count}" -lt 2 ]; then
    echo "FAIL: ${label} expected >= 2 AWS::EC2::SecurityGroupIngress rows in state, found ${count} — the assertion above would have passed vacuously" >&2
    exit 1
  fi
}

assert_recorded_rule_ids "${STATE}" "${STACK}"

# --- Phase 1b: issue #1761 export arm --------------------------------------
# Deploy the companion stack, assert the same recorded attribute, then prove
# `cdkd export --dry-run` RESOLVES it into the CloudFormation import plan.
echo "==> Phase 1b: deploy the export-arm stack (${EXPORT_STACK})"
node "${LOCAL_DIST}" deploy "${EXPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

EXPORT_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${EXPORT_STATE_KEY}" - 2>/dev/null)
if [ -z "${EXPORT_STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${EXPORT_STATE_KEY} after deploy (deploy likely failed)" >&2
  exit 1
fi

EXPORT_SG_IDS=$(echo "${EXPORT_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .value.physicalId] | .[]')
EXPORT_SG_A_ID=$(echo "${EXPORT_SG_IDS}" | sed -n '1p')
EXPORT_SG_B_ID=$(echo "${EXPORT_SG_IDS}" | sed -n '2p')
EXPORT_VPC_ID=$(echo "${EXPORT_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first // ""')
echo "    resolved export SG-A=${EXPORT_SG_A_ID} SG-B=${EXPORT_SG_B_ID} VPC=${EXPORT_VPC_ID}"

assert_recorded_rule_ids "${EXPORT_STATE}" "${EXPORT_STACK}"

# The end-to-end claim: `cdkd export` must resolve the CFn identifier for each
# ingress row FROM that attribute. `--dry-run` prints the import plan and stops
# before any lock / changeset, so nothing is mutated here.
#
# Against a binary WITHOUT the fix this step fails rather than passing quietly:
# `buildImportPlan` cannot resolve the identifier, pushes each ingress row into
# `blocked`, and aborts the whole run before the plan is ever printed — so the
# `Id=sgr-...` line the loop below greps for does not exist. It also fails on
# the PRE-#1659 behavior, which shipped the composite (`Id=sg-0abc|tcp|443|443`)
# and does not match the `sgr-` shape either.
echo "==> Phase 1b: cdkd export --dry-run must resolve Id=sgr-... for every ingress row"
# Assignment inside the `if` condition, not a bare `VAR=$(...)`: under `set -e`
# a failing command substitution in a standalone assignment aborts the script
# before `$?` can be read, so the diagnostic below would never print.
if EXPORT_PLAN_RAW=$(node "${LOCAL_DIST}" export "${EXPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --dry-run 2>&1); then
  EXPORT_PLAN_EXIT=0
else
  EXPORT_PLAN_EXIT=$?
fi
# Strip ANSI so a colorized plan line still matches the fixed-string greps.
EXPORT_PLAN=$(printf '%s' "${EXPORT_PLAN_RAW}" | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g')

if [ "${EXPORT_PLAN_EXIT}" -ne 0 ]; then
  echo "FAIL: cdkd export --dry-run exited ${EXPORT_PLAN_EXIT} for ${EXPORT_STACK}. If the failure names AWS::EC2::SecurityGroupIngress, cdkd could not resolve the rule's CloudFormation identifier from state (issue #1761). Full output:" >&2
  printf '%s\n' "${EXPORT_PLAN}" >&2
  exit 1
fi

EXPORT_INGRESS_ROWS=$(echo "${EXPORT_STATE}" | jq -r '
  .resources | to_entries[]
  | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress")
  | .key + " " + (.value.attributes.Id // "<MISSING>")')

EXPORT_ASSERTED=0
while IFS=' ' read -r LID RID; do
  [ -z "${LID}" ] && continue
  PLAN_LINE=$(printf '%s\n' "${EXPORT_PLAN}" | grep -F "${LID} (AWS::EC2::SecurityGroupIngress)" || true)
  if [ -z "${PLAN_LINE}" ]; then
    echo "FAIL: cdkd export --dry-run printed no import-plan row for ${LID} (AWS::EC2::SecurityGroupIngress). Full output:" >&2
    printf '%s\n' "${EXPORT_PLAN}" >&2
    exit 1
  fi
  # The exact recorded value, not merely 'an sgr- shaped string': that is what
  # excludes a plan built from anything other than the attribute this PR records.
  if ! printf '%s\n' "${PLAN_LINE}" | grep -qF "Id=${RID}"; then
    echo "FAIL: import-plan row for ${LID} does not carry the recorded rule id 'Id=${RID}' — got: ${PLAN_LINE}" >&2
    exit 1
  fi
  echo "    OK: export plan resolves ${LID} <- Id=${RID}"
  EXPORT_ASSERTED=$((EXPORT_ASSERTED + 1))
done <<EOF
${EXPORT_INGRESS_ROWS}
EOF

if [ "${EXPORT_ASSERTED}" -lt 2 ]; then
  echo "FAIL: expected to assert >= 2 export-plan ingress rows, asserted ${EXPORT_ASSERTED} — the loop above passed vacuously" >&2
  exit 1
fi

echo "==> Phase 1b: destroy the export-arm stack"
if ! node "${LOCAL_DIST}" destroy "${EXPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force; then
  echo "FAIL: cdkd destroy returned non-zero for ${EXPORT_STACK}" >&2
  exit 1
fi

assert_gone "state file s3://${STATE_BUCKET}/${EXPORT_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${EXPORT_STATE_KEY}"
for SG in "${EXPORT_SG_A_ID}" "${EXPORT_SG_B_ID}"; do
  assert_gone "export-arm security group ${SG} still exists after destroy (orphan)" aws ec2 describe-security-groups --group-ids "${SG}" --region "${REGION}"
done
if [ -n "${EXPORT_VPC_ID}" ]; then
  assert_gone "export-arm VPC ${EXPORT_VPC_ID} still exists after destroy (orphan)" aws ec2 describe-vpcs --vpc-ids "${EXPORT_VPC_ID}" --region "${REGION}"
fi
echo "    OK: export-arm stack destroyed cleanly (SGs + VPC + state gone)"
# Cleared so the EXIT trap does not try to re-delete them.
EXPORT_SG_A_ID=""
EXPORT_SG_B_ID=""
EXPORT_VPC_ID=""

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

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Both SGs must be gone from AWS.
for SG in "${SG_A_ID}" "${SG_B_ID}"; do
  assert_gone "security group ${SG} still exists after destroy (orphan — destroy ordering likely deleted in the wrong order or skipped it)" aws ec2 describe-security-groups --group-ids "${SG}" --region "${REGION}"
done
echo "    OK: both security groups are gone from AWS"

# VPC must be gone.
if [ -n "${VPC_ID}" ]; then
  assert_gone "VPC ${VPC_ID} still exists after destroy (orphan)" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
  echo "    OK: VPC ${VPC_ID} is gone from AWS"
fi

# Everything cleaned by cdkd — clear ids so the EXIT trap is a no-op.
SG_A_ID=""
SG_B_ID=""
VPC_ID=""

echo ""
echo "=== PASS: circular Security Group reference deploy + destroy integ ==="
