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
#      (under `--dry-run` too), so one unrelated unregistered type anywhere in
#      this fixture's `ec2.Vpc` would hide the assertion. That minimal stack is
#      insulated from it.
#
#      `--dry-run` proves cdkd RESOLVES the identifier, not that CloudFormation
#      ACCEPTS it. The second half lives in `tests/integration/export`, whose
#      fixture gained a standalone ingress rule, runs a real IMPORT changeset,
#      and asserts CFn's own PhysicalResourceId for it.
#   4. The EXPORT-PATH BACKFILL (issue #1791) — the two arms phases 1c / 1d add.
#      A row written by any cdkd older than #1761 carries `attributes: {}`, and
#      `cdkd export` is all-or-nothing, so ONE such row makes a whole stack
#      un-exportable. The fix looks the rule up live
#      (`DescribeSecurityGroupRules` filtered by the composite physical id's
#      group id) and accepts the id only on an EXACTLY-ONE match.
#
#      A fresh deploy with the current binary records `attributes.Id`, so
#      assertion 3 above is satisfied from STATE and never reaches the backfill
#      at all — a fixture that cannot reach the changed line is not a live test
#      of it. Hence:
#
#      1c. HEALING arm. After the state-side assertions pass, `attributes.Id`
#          is STRIPPED off every ingress row of the export-arm stack's state
#          file in S3 (the exact pre-#1761 shape), the strip is verified to
#          have removed something and to have landed, and `cdkd export
#          --dry-run` is re-run. Every ingress row's plan line must then carry
#          the `sgr-...` id read back from AWS by a DIRECT
#          `describe-security-group-rules` call — not the value cdkd recorded,
#          which no longer exists in state, and not merely "an sgr- shaped
#          string".
#      1d. AMBIGUITY arm, on its own stack (`CdkdSgIngressAmbiguousExample`):
#          ONE ingress resource declaring BOTH `CidrIp` and `CidrIpv6`, for
#          which AWS mints TWO rules sharing the whole tuple cdkd's composite
#          physical id carries. That row needs no state mutation — cdkd's
#          exactly-one rule records nothing for it — and `cdkd export` must
#          exit NON-ZERO naming the row AND both `sgr-...` candidates. A
#          binary WITHOUT the fix also exits non-zero here (the state-only
#          refusal), so the ids are what discriminate: only a live lookup can
#          name them.
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

# Polling twin of assert_gone, for the arms added by issue #1791. Declared
# BELOW the canonical helper block above, which a lint matches VERBATIM.
#
# EC2's Describe* family is eventually consistent, so a just-deleted security
# group / VPC can still be reported for a few seconds after a SUCCESSFUL
# delete — a single sample would then FAIL the run and accuse the fix of
# leaking a resource cdkd had already removed. Delegates to gone_probe, so the
# tri-state is preserved: still-present retries, an undetermined probe
# hard-fails inside gone_probe on the spot rather than being retried into a
# timeout.
assert_gone_eventually() { # usage: assert_gone_eventually "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  local attempt=1
  while [ "${attempt}" -le 12 ]; do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 5
    attempt=$((attempt + 1))
  done
  echo "FAIL: ${desc} (still present after 12 probes over ~60s)" >&2
  exit 1
}

cd "$(dirname "$0")"

STACK="CdkdSgCircularExample"
# The issue #1761 export arm (see the header). Deployed, asserted and destroyed
# inside phase 1b so the main destroy phase below is unchanged. Phase 1c
# (issue #1791 healing) rides on the SAME stack, between its assertions and its
# destroy, because the row it heals has to be one this fixture already proved
# cdkd resolves from state.
EXPORT_STACK="CdkdSgIngressExportExample"
# The issue #1791 ambiguity arm (see the header). Its own stack: its ingress row
# is deliberately unresolvable, and `cdkd export` aborts the WHOLE run on the
# first row it cannot resolve, so putting it in EXPORT_STACK would abort the
# export phase 1b/1c assert succeeds.
AMBIGUOUS_STACK="CdkdSgIngressAmbiguousExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EXPORT_STATE_KEY="cdkd/${EXPORT_STACK}/${REGION}/state.json"
AMBIGUOUS_STATE_KEY="cdkd/${AMBIGUOUS_STACK}/${REGION}/state.json"
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
AMBIG_SG_ID=""
AMBIG_VPC_ID=""

# Scratch pair for the issue #1791 state mutation (phase 1c). PID-suffixed so
# two concurrent runs of this fixture cannot share them; seeded empty so the
# cleanup trap's `rm -f` is well-formed before phase 1c ever assigns them.
STATE_TMP_IN=""
STATE_TMP_OUT=""

# Every `sgr-...` INGRESS rule id AWS currently holds on a security group, as a
# sorted JSON array — the AWS-side authority the issue #1791 arms assert
# against, so neither arm can pass on a value cdkd itself produced.
#
# `|| return 1` on the intermediate capture is load-bearing: errexit is CLEARED
# inside `$( )`, so without it a failed probe would fall through to the jq tail
# and the caller would read an empty array as "no rules" (the gone-probe
# failure mode, one layer up). Egress rules are filtered out because every
# security group carries a default allow-all egress rule that matches no
# ingress row.
ingress_rule_ids_json() { # usage: ingress_rule_ids_json <groupId>
  local out
  out="$(aws ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=$1" \
    --region "${REGION}" \
    --output json)" || return 1
  printf '%s' "${out}" | jq -c '[.SecurityGroupRules[] | select(.IsEgress == false) | .SecurityGroupRuleId] | sort'
}

# Revoke every ingress rule off both SGs, then delete the SGs, then the VPC.
# This is the SAME ordering cdkd must perform — doing it here in cleanup
# guarantees we never leak resources even if cdkd's destroy left orphans.
force_cleanup_aws() {
  set +eu
  # 0) Sweep by the fixture tag FIRST, so a resource whose id never reached a
  #    shell variable (a deploy that died between the AWS create and the state
  #    read) is still torn down. The id-based passes below then run over the
  #    union of what the sweep found and what the phases captured — both are
  #    idempotent, so an overlap is a no-op.
  SWEPT_SGS=$(aws ec2 describe-security-groups \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --region "${REGION}" \
    --query 'SecurityGroups[].GroupId' --output text 2>/dev/null)
  SWEPT_VPCS=$(aws ec2 describe-vpcs \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --region "${REGION}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null)
  # 1) Revoke ALL ingress on each SG so neither references the other anymore.
  for SG in "${SG_A_ID}" "${SG_B_ID}" "${EXPORT_SG_A_ID}" "${EXPORT_SG_B_ID}" "${AMBIG_SG_ID}" ${SWEPT_SGS}; do
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
  for SG in "${SG_A_ID}" "${SG_B_ID}" "${EXPORT_SG_A_ID}" "${EXPORT_SG_B_ID}" "${AMBIG_SG_ID}" ${SWEPT_SGS}; do
    [ -z "${SG}" ] && continue
    echo "    [cleanup] deleting ${SG}"
    aws ec2 delete-security-group --group-id "${SG}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # 3) VPCs last (subnet/IGW/route-table teardown is left to cdkd; if cdkd
  #    already removed them this is a no-op, otherwise we at least try).
  for VPC in "${VPC_ID}" "${EXPORT_VPC_ID}" "${AMBIG_VPC_ID}" ${SWEPT_VPCS}; do
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
    node "${LOCAL_DIST}" state destroy "${AMBIGUOUS_STACK}" \
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
    aws s3 rm "s3://${STATE_BUCKET}/${AMBIGUOUS_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${AMBIGUOUS_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # The issue #1791 healing arm rewrites the export-arm state file through a
  # scratch pair; drop them here too so an interrupted run leaves nothing in
  # TMPDIR (PID-suffixed, so two concurrent runs cannot collide).
  rm -f "${STATE_TMP_IN:-}" "${STATE_TMP_OUT:-}"
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

# Assignment inside the `if` condition, not a bare `VAR=$(...)`: under `set -e`
# a failing command substitution in a standalone assignment aborts the script
# immediately, so the `[ -z ]` diagnostic below could never print. Fail-closed
# either way — a missing OR unreadable state file fails the run; nothing here
# concludes "gone" from a probe failure.
if ! STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null); then
  echo "FAIL: could not read the state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy (deploy likely failed, or the object is missing)" >&2
  exit 1
fi
if [ -z "${STATE}" ]; then
  echo "FAIL: state file at s3://${STATE_BUCKET}/${STATE_KEY} is EMPTY after deploy" >&2
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

# Same `set -e` shape as the phase-1 read above.
if ! EXPORT_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${EXPORT_STATE_KEY}" - 2>/dev/null); then
  echo "FAIL: could not read the state file at s3://${STATE_BUCKET}/${EXPORT_STATE_KEY} after deploy (deploy likely failed, or the object is missing)" >&2
  exit 1
fi
if [ -z "${EXPORT_STATE}" ]; then
  echo "FAIL: state file at s3://${STATE_BUCKET}/${EXPORT_STATE_KEY} is EMPTY after deploy" >&2
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
# and does not match the `sgr-` shape either. Both halves of the claim are
# checked: the state assertion above proves the PROVIDER recorded the id, this
# one proves the EXPORT resolved that same recorded value.
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
  echo "FAIL: cdkd export --dry-run exited ${EXPORT_PLAN_EXIT} for ${EXPORT_STACK}. If the failure names AWS::EC2::SecurityGroupIngress, cdkd could not resolve the rule's CloudFormation identifier — the state assertion above discriminates: an sgr- shaped attributes.Id there means the PROVIDER recorded it and the gap is the COMPOSITE_PHYSICAL_ID_IDENTIFIERS resolution in src/cli/commands/export.ts; a missing or non-sgr Id means the provider did not record it (issue #1761). If the failure names some OTHER type, an unregistered composite identifier is aborting the whole plan before the ingress rows are reached — that is not a #1761 regression. Full output:" >&2
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

# --- Phase 1c: issue #1791 legacy-state HEALING arm -------------------------
# Everything above passed because the rows carry `attributes.Id`, which is
# exactly why it does NOT test the backfill: the export resolves the identifier
# from STATE and the live lookup is never reached. So strip the attribute back
# to the pre-#1761 shape and re-run the same export.
echo "==> Phase 1c: strip attributes.Id from every ingress row (pre-#1761 state shape)"
STATE_TMP_IN="${TMPDIR:-/tmp}/cdkd-1791-state-in.$$.json"
STATE_TMP_OUT="${TMPDIR:-/tmp}/cdkd-1791-state-out.$$.json"
aws s3 cp "s3://${STATE_BUCKET}/${EXPORT_STATE_KEY}" "${STATE_TMP_IN}" --region "${REGION}" >/dev/null

# Fail loudly if there is nothing to strip. A silent no-op would leave the ids
# in place and the assertion below would pass on the state-side resolve — i.e.
# it would re-assert phase 1b and prove nothing about the backfill.
STRIP_CANDIDATES=$(jq '[.resources | to_entries[]
  | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress")
  | select(.value.attributes.Id != null)] | length' "${STATE_TMP_IN}")
if [ "${STRIP_CANDIDATES}" -lt 2 ]; then
  echo "FAIL: expected >= 2 ingress rows carrying attributes.Id to strip, found ${STRIP_CANDIDATES} — the healing assertion below would be vacuous" >&2
  jq '.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress") | {id: .key, physicalId: .value.physicalId, attributes: .value.attributes}' "${STATE_TMP_IN}" >&2
  exit 1
fi

jq '.resources |= map_values(
  if .resourceType == "AWS::EC2::SecurityGroupIngress"
  then .attributes |= del(.Id)
  else . end)' "${STATE_TMP_IN}" > "${STATE_TMP_OUT}"
aws s3 cp "${STATE_TMP_OUT}" "s3://${STATE_BUCKET}/${EXPORT_STATE_KEY}" --region "${REGION}" >/dev/null
rm -f "${STATE_TMP_IN}" "${STATE_TMP_OUT}"
STATE_TMP_IN=""
STATE_TMP_OUT=""

# Read the mutation back from S3 rather than trusting the local jq output: what
# the export command will read is the OBJECT, so that is what has to be proven
# id-free.
if ! HEALED_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${EXPORT_STATE_KEY}" - 2>/dev/null); then
  echo "FAIL: could not re-read the state file at s3://${STATE_BUCKET}/${EXPORT_STATE_KEY} after the attributes.Id strip" >&2
  exit 1
fi
SURVIVING_IDS=$(printf '%s' "${HEALED_STATE}" | jq '[.resources | to_entries[]
  | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress")
  | select(.value.attributes.Id != null)] | length')
if [ "${SURVIVING_IDS}" -ne 0 ]; then
  echo "FAIL: ${SURVIVING_IDS} ingress row(s) still carry attributes.Id after the strip — the write did not land, so the assertion below would not reach the backfill" >&2
  exit 1
fi
echo "    OK: ${STRIP_CANDIDATES} ingress rows now carry no recorded rule id (pre-#1761 shape)"

echo "==> Phase 1c: cdkd export --dry-run must RECOVER each rule id from AWS"
if EXPORT_HEAL_RAW=$(node "${LOCAL_DIST}" export "${EXPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --dry-run 2>&1); then
  EXPORT_HEAL_EXIT=0
else
  EXPORT_HEAL_EXIT=$?
fi
EXPORT_HEAL=$(printf '%s' "${EXPORT_HEAL_RAW}" | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g')

if [ "${EXPORT_HEAL_EXIT}" -ne 0 ]; then
  echo "FAIL: cdkd export --dry-run exited ${EXPORT_HEAL_EXIT} for ${EXPORT_STACK} with the rule ids stripped from state. This is the pre-#1791 behavior: the state-only resolve refuses the row and the whole export aborts. If the failure names AWS::EC2::SecurityGroupIngress, the live DescribeSecurityGroupRules backfill did not run or did not find exactly one match. Full output:" >&2
  printf '%s\n' "${EXPORT_HEAL}" >&2
  exit 1
fi

HEAL_ASSERTED=0
while IFS=' ' read -r LID RID; do
  [ -z "${LID}" ] && continue
  # The group the row's composite physicalId names — the ONLY handle left after
  # the strip, and the same segment the backfill filters its lookup on.
  GROUP_ID=$(printf '%s' "${EXPORT_STATE}" | jq -r --arg l "${LID}" '.resources[$l].physicalId // ""' | cut -d'|' -f1)
  if [ -z "${GROUP_ID}" ]; then
    echo "FAIL: could not read a group id out of ${LID}'s composite physicalId" >&2
    exit 1
  fi
  if ! AWS_RULE_IDS=$(ingress_rule_ids_json "${GROUP_ID}"); then
    echo "FAIL: DescribeSecurityGroupRules failed for ${GROUP_ID} (the group ${LID} names) — the healing assertion has no AWS-side value to compare against" >&2
    exit 1
  fi
  AWS_RULE_COUNT=$(printf '%s' "${AWS_RULE_IDS}" | jq 'length')
  if [ "${AWS_RULE_COUNT}" -ne 1 ]; then
    echo "FAIL: expected exactly 1 ingress rule on ${GROUP_ID} (the group ${LID} names), AWS reports ${AWS_RULE_COUNT}: ${AWS_RULE_IDS} — this fixture's shape guarantees one, so the run cannot say which id ${LID} should resolve to" >&2
    exit 1
  fi
  AWS_RULE_ID=$(printf '%s' "${AWS_RULE_IDS}" | jq -r '.[0]')
  # Cross-check the AWS lookup against what cdkd had recorded BEFORE the strip.
  # A mismatch means the lookup is naming some other rule, which would make the
  # assertion below compare the wrong pair of values.
  if [ "${AWS_RULE_ID}" != "${RID}" ]; then
    echo "FAIL: AWS reports rule id ${AWS_RULE_ID} for ${LID}'s group ${GROUP_ID}, but cdkd had recorded ${RID} before the strip — the two must name the same rule" >&2
    exit 1
  fi
  PLAN_LINE=$(printf '%s\n' "${EXPORT_HEAL}" | grep -F "${LID} (AWS::EC2::SecurityGroupIngress)" || true)
  if [ -z "${PLAN_LINE}" ]; then
    echo "FAIL: cdkd export --dry-run printed no import-plan row for ${LID} (AWS::EC2::SecurityGroupIngress) after the strip. Full output:" >&2
    printf '%s\n' "${EXPORT_HEAL}" >&2
    exit 1
  fi
  # Asserted against the id AWS holds, read back by this script's own
  # describe-security-group-rules call — state carries none at this point, so
  # nothing here can be satisfied by a value cdkd merely echoed.
  if ! printf '%s\n' "${PLAN_LINE}" | grep -qF "Id=${AWS_RULE_ID}"; then
    echo "FAIL: import-plan row for ${LID} does not carry the rule id AWS holds ('Id=${AWS_RULE_ID}') — got: ${PLAN_LINE}" >&2
    exit 1
  fi
  echo "    OK: backfill recovered ${LID} <- Id=${AWS_RULE_ID} (live DescribeSecurityGroupRules on ${GROUP_ID})"
  HEAL_ASSERTED=$((HEAL_ASSERTED + 1))
done <<EOF
${EXPORT_INGRESS_ROWS}
EOF

if [ "${HEAL_ASSERTED}" -lt 2 ]; then
  echo "FAIL: expected to assert >= 2 healed export-plan ingress rows, asserted ${HEAL_ASSERTED} — the loop above passed vacuously" >&2
  exit 1
fi

# Destroyed with the STRIPPED state on purpose — that is the record a pre-#1761
# deploy leaves behind, and the revoke path addresses the rule by the composite
# physicalId rather than by the recorded id, so the teardown must be unaffected.
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
  # Skip an unresolved id like force_cleanup_aws does: `--group-ids ""` is a
  # MALFORMED-id error, not a not-found one, so gone_probe would report
  # "undetermined" and hide the real cause (state that never carried the id).
  [ -z "${SG}" ] && continue
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

# --- Phase 1d: issue #1791 AMBIGUITY arm ------------------------------------
# The other half of the backfill's contract: when the live lookup finds more
# than one rule matching the tuple cdkd's composite physicalId carries, it must
# REFUSE naming every candidate rather than adopt one of them.
echo "==> Phase 1d: deploy the ambiguity-arm stack (${AMBIGUOUS_STACK})"
node "${LOCAL_DIST}" deploy "${AMBIGUOUS_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! AMBIGUOUS_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${AMBIGUOUS_STATE_KEY}" - 2>/dev/null); then
  echo "FAIL: could not read the state file at s3://${STATE_BUCKET}/${AMBIGUOUS_STATE_KEY} after deploy (deploy likely failed, or the object is missing)" >&2
  exit 1
fi
if [ -z "${AMBIGUOUS_STATE}" ]; then
  echo "FAIL: state file at s3://${STATE_BUCKET}/${AMBIGUOUS_STATE_KEY} is EMPTY after deploy" >&2
  exit 1
fi

AMBIG_SG_ID=$(printf '%s' "${AMBIGUOUS_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .value.physicalId] | first // ""')
AMBIG_VPC_ID=$(printf '%s' "${AMBIGUOUS_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first // ""')
AMBIG_ROW=$(printf '%s' "${AMBIGUOUS_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroupIngress") | .key] | first // ""')
if [ -z "${AMBIG_SG_ID}" ] || [ -z "${AMBIG_ROW}" ]; then
  echo "FAIL: could not resolve the ambiguity-arm security group and ingress row from state (got SG='${AMBIG_SG_ID}' row='${AMBIG_ROW}')" >&2
  printf '%s' "${AMBIGUOUS_STATE}" | jq '.resources | to_entries[] | {id: .key, type: .value.resourceType, physicalId: .value.physicalId}' >&2
  exit 1
fi
echo "    resolved ambiguity-arm SG=${AMBIG_SG_ID} VPC=${AMBIG_VPC_ID} row=${AMBIG_ROW}"

# Premise 1: the row must carry NO recorded rule id. AuthorizeSecurityGroupIngress
# returns TWO rules for a dual-source resource and cdkd adopts an id only on an
# exactly-one response, so this arm needs no state mutation — the deploy itself
# produces the pre-#1761 shape. A recorded id means AWS's behavior changed and
# the FIXTURE, not the fix, is what needs updating.
AMBIG_RECORDED_ID=$(printf '%s' "${AMBIGUOUS_STATE}" | jq -r --arg l "${AMBIG_ROW}" '.resources[$l].attributes.Id // ""')
if [ -n "${AMBIG_RECORDED_ID}" ]; then
  echo "FAIL: ${AMBIG_ROW} recorded attributes.Id='${AMBIG_RECORDED_ID}'. This arm needs the row to carry NO id — a resource declaring both CidrIp and CidrIpv6 is expected to make AWS mint one rule PER SOURCE, so cdkd's exactly-one rule records nothing. If AWS now mints a single rule for that shape, the ambiguity premise is gone and this fixture needs a different way to reach two matches." >&2
  exit 1
fi
echo "    OK: ${AMBIG_ROW} carries no recorded rule id (the pre-#1761 shape, reached without mutating state)"

# Premise 2: AWS really does hold two rules matching the row's tuple. Read
# BEFORE the export so the refusal can be asserted against the actual ids.
if ! AMBIG_RULE_IDS=$(ingress_rule_ids_json "${AMBIG_SG_ID}"); then
  echo "FAIL: DescribeSecurityGroupRules failed for ${AMBIG_SG_ID} — the refusal assertion has no AWS-side ids to compare against" >&2
  exit 1
fi
AMBIG_RULE_COUNT=$(printf '%s' "${AMBIG_RULE_IDS}" | jq 'length')
if [ "${AMBIG_RULE_COUNT}" -ne 2 ]; then
  echo "FAIL: expected AWS to hold exactly 2 ingress rules on ${AMBIG_SG_ID} (one per declared source), found ${AMBIG_RULE_COUNT}: ${AMBIG_RULE_IDS} — without two matches the export below is not exercising the ambiguity branch" >&2
  exit 1
fi
AMBIG_RULE_ID_1=$(printf '%s' "${AMBIG_RULE_IDS}" | jq -r '.[0]')
AMBIG_RULE_ID_2=$(printf '%s' "${AMBIG_RULE_IDS}" | jq -r '.[1]')
echo "    OK: AWS holds 2 ingress rules for the one declared row: ${AMBIG_RULE_ID_1} ${AMBIG_RULE_ID_2}"

echo "==> Phase 1d: cdkd export --dry-run must REFUSE the ambiguous row, naming both ids"
if AMBIG_EXPORT_RAW=$(node "${LOCAL_DIST}" export "${AMBIGUOUS_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --dry-run 2>&1); then
  AMBIG_EXPORT_EXIT=0
else
  AMBIG_EXPORT_EXIT=$?
fi
AMBIG_EXPORT=$(printf '%s' "${AMBIG_EXPORT_RAW}" | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g')

if [ "${AMBIG_EXPORT_EXIT}" -eq 0 ]; then
  echo "FAIL: cdkd export --dry-run SUCCEEDED for ${AMBIGUOUS_STACK}. Two AWS rules match this row's tuple, so cdkd cannot say which one it is — adopting either would hand CloudFormation the identifier of a rule cdkd does not exclusively own. Full output:" >&2
  printf '%s\n' "${AMBIG_EXPORT}" >&2
  exit 1
fi

# A binary WITHOUT the fix also exits non-zero here (the state-only refusal), so
# the exit code alone proves nothing. The rule IDS are the discriminator: only a
# live DescribeSecurityGroupRules lookup can name them.
for TOKEN in "${AMBIG_ROW}" "${AMBIG_RULE_ID_1}" "${AMBIG_RULE_ID_2}"; do
  if ! printf '%s\n' "${AMBIG_EXPORT}" | grep -qF "${TOKEN}"; then
    echo "FAIL: the export refusal does not name '${TOKEN}'. It must name the ROW and BOTH candidate rule ids (${AMBIG_RULE_ID_1}, ${AMBIG_RULE_ID_2}) — a refusal naming neither id is the pre-#1791 state-only message, which tells the user to re-deploy and would not help here. Full output:" >&2
    printf '%s\n' "${AMBIG_EXPORT}" >&2
    exit 1
  fi
done
echo "    OK: export refused ${AMBIG_ROW} naming both candidate rule ids"

echo "==> Phase 1d: destroy the ambiguity-arm stack"
if ! node "${LOCAL_DIST}" destroy "${AMBIGUOUS_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force; then
  echo "FAIL: cdkd destroy returned non-zero for ${AMBIGUOUS_STACK} — the dual-source revoke must remove BOTH rules AWS minted, or the SG delete fails" >&2
  exit 1
fi

assert_gone "state file s3://${STATE_BUCKET}/${AMBIGUOUS_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${AMBIGUOUS_STATE_KEY}"
assert_gone_eventually "ambiguity-arm security group ${AMBIG_SG_ID} still exists after destroy (orphan — the dual-source revoke likely left a rule behind)" aws ec2 describe-security-groups --group-ids "${AMBIG_SG_ID}" --region "${REGION}"
if [ -n "${AMBIG_VPC_ID}" ]; then
  assert_gone_eventually "ambiguity-arm VPC ${AMBIG_VPC_ID} still exists after destroy (orphan)" aws ec2 describe-vpcs --vpc-ids "${AMBIG_VPC_ID}" --region "${REGION}"
fi
echo "    OK: ambiguity-arm stack destroyed cleanly (SG + VPC + state gone)"
# Cleared so the EXIT trap does not try to re-delete them.
AMBIG_SG_ID=""
AMBIG_VPC_ID=""

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
echo "=== PASS: circular Security Group reference deploy + destroy integ"
echo "          (incl. the issue #1791 healing + ambiguity export-backfill arms) ==="
