#!/usr/bin/env bash
# verify.sh — what a STILL-SDK resource does when the template gains a
# silently-dropped property (issue 2744).
#
# docs/cli-deploy-safety.md answered that twice, oppositely, ~70 lines apart:
# the `--prefer-sdk-route` section said the next deploy AUTO-ROUTES
# the resource through Cloud Control and that the flag exists to PREVENT that;
# the recreate-via-cc-api section said the property "will not reach AWS, because the
# SDK update path drops it silently" and a destroy-and-recreate is required.
# One of those costs the user downtime. `getProviderFor` reads like the first,
# but source does not settle whether the Cloud Control UPDATE succeeds against
# a physical id the SDK provider minted, nor whether the property lands.
#
# Phases:
#   1 base      -- deploy on the SDK route
#   1b badpolicy -- an auto-routed update Cloud Control refuses: the failure
#                  names both remedies (go-to-k/cdkd#4904).
#   2 drop      -- add ResourcePolicyDocument with NO flag. THE ARM.
#   3 rebase    -- --recreate-via-sdk-provider (+ --force-stateful-recreation:
#                  a log group is a stateful type) on a template without the
#                  property. CONTROL for the identity witness: a genuine
#                  destroy-and-recreate must kill the out-of-band tag, or the
#                  tag surviving phase 2 witnesses nothing.
#   4 allowdrop -- the property WITH --prefer-sdk-route. CONTROL
#                  for the premise: proves the SDK route really does drop it,
#                  rather than importing that from the generated coverage map.
#                  Also asserts the WRITE half of go-to-k/cdkd#2750: the record
#                  must not claim a value AWS does not hold.
#   4b allowmeta -- phase 4's properties plus UpdateReplacePolicy: Retain,
#                  same flag. go-to-k/cdkd#2809: a policy-only flip must take
#                  the state-only attribute refresh, not the provider's
#                  update().
#   4c allowdrop again -- the flip back, also state-only, restoring phase 4's
#                  record so phase 5 still starts from it.
#   5 dropagain -- the same property again with NO flag. Closes
#                  go-to-k/cdkd#2750: the opt-out deploy used to RECORD the
#                  property it never wrote, so the Cloud Control patch diffed it
#                  as unchanged and it never reached AWS. Identical operation to
#                  phase 2; the only difference is the recorded bag, which is
#                  what makes the pair a clean A/B.
#   7 subnet   -- go-to-k/cdkd#2790: a VPC + subnet join the stack, the subnet
#                  carrying AvailabilityZoneId -- a CREATE-ONLY silent drop --
#                  deployed WITH --prefer-sdk-route. The record keeps it.
#   8 subnettag -- an ordinary in-place change (the Name tag), same flag. The
#                  NEGATIVE CONTROL: a flag-ful redeploy over that record must
#                  not replace the subnet.
#   9 subnettag again with NO flag -- THE #2790 ARM. AWS never held the value,
#                  and applying it needs a replacement, so the deploy must
#                  REFUSE, leaving the subnet as it was. Before the fix it
#                  diffed NO_CHANGE and reported success.
#  10 subnettag with --recreate-via-cc-api <subnet> -- the opt-in the refusal
#                  names: the subnet is re-created through Cloud Control with
#                  the AZ id applied.
#   6 destroy (runs last)
#
# See lib/sdk-to-cc-autoroute-stack.ts for why AWS::Logs::LogGroup and why
# ResourcePolicyDocument specifically (go-to-k/cdkd#5524 moved the fixture off
# the CloudWatch alarm's EvaluationWindow once that property was wired).

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

# ---------------------------------------------------------------------------
cd "$(dirname "$0")"

# A paged `aws` read blocks forever under a non-interactive runner.
export AWS_PAGER=""

STACK="CdkdSdkToCcAutorouteExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOG_GROUP_NAME="${STACK}-log-group"
# The policy statement's Sid in lib/; the readback counts only statements
# carrying it, so an unrelated policy can never satisfy an assertion.
POLICY_SID="CdkdSdkToCcAutoroute"
# Resolved from the synth template, never hard-coded. A guessed key would make
# every state assertion read `null` and pass vacuously, and CDK's logical id is
# not derivable from the construct id in general -- a nested path is hashed.
# (Here it happens to be the bare `AutorouteLogGroup`, since the construct sits
# at the stack root; reading it is what keeps that from being load-bearing.)
LOGICAL_ID=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The go-to-k/cdkd#2790 subnet, resolved from its phase's synth template.
SUBNET_LOGICAL_ID=""
# What verify.sh's cleanup sweeps a VPC by; lib/ tags the VPC and subnet with
# the stack name, so the sweep reaches only this stack's leftovers.
FIXTURE_TAG_VALUE="${STACK}"

record() { # usage: record <jq-expression-over-the-resource-object>
  record_of "${LOGICAL_ID}" "$1"
}

record_of() { # usage: record_of <logical-id> <jq-expression-over-the-resource-object>
  local json key
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  key=$(printf '%s' "${json}" | jq -r --arg p "$1" \
    '.resources | keys[] | select(startswith($p))' | head -1)
  [ -n "${key}" ] || { echo "FAIL: no state resource whose logical id starts with $1" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "${key}" ".resources[\$k] | $2"
}

# The live subnet's AZ id, read from EC2 rather than from cdkd's record.
subnet_az_id() { # usage: subnet_az_id <subnet-id>
  aws ec2 describe-subnets --subnet-ids "$1" --region "${REGION}" \
    --query 'Subnets[0].AvailabilityZoneId' --output text
}

# The log group as JSON, EXACTLY this name (`describe-log-groups` matches a
# PREFIX, so a sibling `${LOG_GROUP_NAME}-x` must not answer), or `null`.
# Raw JSON + jq, never `--query`: an empty projection prints NOTHING with rc 0,
# which a string compare would read as a value.
log_group_json() {
  aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP_NAME}" \
    --region "${REGION}" --output json \
    | jq -c --arg n "${LOG_GROUP_NAME}" '[.logGroups[]? | select(.logGroupName == $n)] | .[0] // null'
}

# The log group's own ARN (no `:*` suffix), needed for tagging and for the
# resource-policy read. Read from AWS, not from cdkd's state record: this must
# observe AWS, not cdkd's belief about AWS.
log_group_arn() {
  local lg arn
  lg=$(log_group_json) || return 1
  arn=$(jq -r 'if . == null then "" else (.logGroupArn // ((.arn // "") | sub(":\\*$"; ""))) end' <<<"${lg}")
  [ -n "${arn}" ] || return 1
  printf '%s' "${arn}"
}

# RetentionInDays as AWS reports it, or `None` when unset / the group is gone.
log_group_retention() {
  log_group_json | jq -r 'if . == null then "None" else (.retentionInDays // "None" | tostring) end'
}

# How many `cdkd-integ-witness` tags the log group carries (0 or 1).
witness_count() { # usage: witness_count <log-group-arn>
  aws logs list-tags-for-resource --resource-arn "$1" --region "${REGION}" --output json \
    | jq '(.tags // {}) | has("cdkd-integ-witness") | if . then 1 else 0 end'
}

# How many statements carrying ${POLICY_SID} the log group's RESOURCE-scoped
# policies hold (0 when it has none), read through the SDK rather than the AWS
# CLI: log-group-scoped resource policies (`resourceArn` / `policyScope` on
# DescribeResourcePolicies) are recent, and a CLI whose bundled model lacks a
# parameter or response field silently drops it -- measured for the old
# premise's EvaluationWindow on aws-cli 2.34.37. A reader that cannot see the
# property reports it absent whatever AWS holds: a false FAIL in phases 2b and
# 5, and a vacuous pass of phase 4's absence control. Phase 2b's positive read
# goes through this same reader, which is what makes phase 4's 0 evidence.
REPO_ROOT="${PWD}/../../.."
policy_statement_count() { # usage: policy_statement_count <log-group-arn>
  ( cd "${REPO_ROOT}" && REGION="${REGION}" ARN="$1" SID="${POLICY_SID}" node --input-type=module -e "
import { CloudWatchLogsClient, DescribeResourcePoliciesCommand } from '@aws-sdk/client-cloudwatch-logs';
const client = new CloudWatchLogsClient({ region: process.env.REGION });
const policies = [];
let nextToken;
// A log group with NO resource-scoped policy may answer ResourceNotFound
// rather than an empty list. The caller has already read the log group itself
// through log_group_arn, so that answer here means 'no policy', never 'no log
// group'; every other error still fails the read.
try {
  do {
    const res = await client.send(new DescribeResourcePoliciesCommand({
      resourceArn: process.env.ARN, policyScope: 'RESOURCE', nextToken,
    }));
    policies.push(...(res.resourcePolicies ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
} catch (e) {
  if (e?.name !== 'ResourceNotFoundException') throw e;
}
let count = 0;
for (const p of policies) {
  const doc = JSON.parse(p.policyDocument ?? '{}');
  const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  count += statements.filter((s) => s && s.Sid === process.env.SID).length;
}
process.stdout.write(String(count));
" ) || return 1
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # Deleting the log group takes its log-group-scoped resource policy with it.
  aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # The go-to-k/cdkd#2790 VPC + subnet, found by the tag lib/ puts on them.
  local vpc_id subnet_id
  for vpc_id in $(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:cdkd-integ-fixture,Values=${FIXTURE_TAG_VALUE}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    case "${vpc_id}" in
      vpc-?*) ;;
      *) echo "WARN: teardown sweep refused: unexpected VPC id '${vpc_id}'" >&2; continue ;;
    esac
    for subnet_id in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --region "${REGION}" --subnet-id "${subnet_id}" >/dev/null 2>&1
    done
    aws ec2 delete-vpc --region "${REGION}" --vpc-id "${vpc_id}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }

# Step 0: self-diagnosing trigger guard (issue 2648). The whole fixture rests
# on ResourcePolicyDocument being a NON-create-only silent drop for
# AWS::Logs::LogGroup. It is an `unhandledByDesign` entry, not backlog, but a
# provider change can still end it (go-to-k/cdkd#5524 is the day the previous
# premise, Alarm EvaluationWindow, ended). Without this, that day reads as
# phase 2 "failing to auto-route", a cdkd defect that is not one.
echo "==> Step 0: trigger premise guard"
if ! (cd "${REPO_ROOT}" && node --input-type=module -e "
const mod = await import('./src/provisioning/property-coverage.generated.ts');
const table = Object.values(mod).find((v) => v instanceof Map);
const cov = table && table.get('AWS::Logs::LogGroup');
if (!cov || !cov.silentDrop || !cov.silentDrop.has('ResourcePolicyDocument')) process.exit(1);
if (!cov.createOnlyDrops || cov.createOnlyDrops.has('ResourcePolicyDocument')) process.exit(1);
"); then
  echo "FAIL: AWS::Logs::LogGroup.ResourcePolicyDocument is no longer a non-create-only" >&2
  echo "      silent drop -- the provider wired it (or the schema made it create-only)" >&2
  echo "      and this fixture's premise is dead. Do NOT debug the deploy: move the" >&2
  echo "      fixture to a still-silent-drop property that meets the conditions in" >&2
  echo "      lib/sdk-to-cc-autoroute-stack.ts." >&2
  exit 1
fi
echo "    OK: ResourcePolicyDocument is still a silent-drop (premise holds)"
# go-to-k/cdkd#2790's phases rest on AvailabilityZoneId being a CREATE-ONLY
# silent drop for AWS::EC2::Subnet. A provider wiring it ends that premise.
if ! (cd "${REPO_ROOT}" && node --input-type=module -e "
const mod = await import('./src/provisioning/property-coverage.generated.ts');
const table = Object.values(mod).find((v) => v instanceof Map);
const cov = table && table.get('AWS::EC2::Subnet');
if (!cov || !cov.createOnlyDrops || !cov.createOnlyDrops.has('AvailabilityZoneId')) process.exit(1);
"); then
  echo "FAIL: AWS::EC2::Subnet.AvailabilityZoneId is no longer a create-only silent drop --" >&2
  echo "      phases 7-10 would test nothing. Move them to another type's create-only drop." >&2
  exit 1
fi
echo "    OK: AvailabilityZoneId is still a create-only silent drop (premise holds)"

# Any available AZ of the region: the SDK route drops the id and lets EC2 pick,
# so phase 10's readback is the only place the value is checked against AWS.
AZ_ID=$(aws ec2 describe-availability-zones --region "${REGION}" \
  --filters "Name=state,Values=available" "Name=zone-type,Values=availability-zone" \
  --query 'AvailabilityZones[-1].ZoneId' --output text)
case "${AZ_ID}" in
  ""|None) echo "FAIL: could not resolve an AZ id in ${REGION}" >&2; exit 1 ;;
esac
echo "    OK: phases 7-10 use AZ id ${AZ_ID}"

[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

if ! SYNTH_OUT=$(node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
  printf '%s\n' "${SYNTH_OUT}" >&2
  echo "FAIL: synth failed" >&2
  exit 1
fi
TEMPLATE="cdk.out/${STACK}.template.json"
# `[ -f ]`, not `ls | head -1`: under `pipefail` a missing file makes `ls` exit
# 2, errexit kills the run at the assignment, and the message below never
# prints.
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::Logs::LogGroup") | .key' "${TEMPLATE}" | head -1)
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no AWS::Logs::LogGroup in ${TEMPLATE}" >&2; exit 1; }
echo "==> Resource under test: ${LOGICAL_ID}"

# The premise the whole fixture rests on: ResourcePolicyDocument must be ABSENT
# from the base template and PRESENT in the drop one. If the override stops
# landing, every assertion below would be about the wrong template and would
# pass having tested nothing.
jq -e --arg k "${LOGICAL_ID}" '.Resources[$k].Properties.ResourcePolicyDocument' "${TEMPLATE}" >/dev/null 2>&1 && {
  echo "FAIL: the BASE phase template already carries ResourcePolicyDocument; phase 1 would not be an SDK-route deploy" >&2; exit 1; }
if ! SYNTH_OUT=$(env CDKD_TEST_PHASE=drop node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
  printf '%s\n' "${SYNTH_OUT}" >&2
  echo "FAIL: drop-phase synth failed" >&2
  exit 1
fi
jq -e --arg k "${LOGICAL_ID}" --arg sid "${POLICY_SID}" '[.Resources[$k].Properties.ResourcePolicyDocument.Statement[]? | select(.Sid == $sid)] | length == 1' "${TEMPLATE}" >/dev/null 2>&1 || {
  echo "FAIL: the DROP phase template does not carry the ${POLICY_SID} ResourcePolicyDocument; addPropertyOverride did not land and the arm would test nothing" >&2; exit 1; }
echo "    OK: the two phases really do differ by the silent-drop property"

# Phase 4b's premise: `allowmeta` differs from `allowdrop` by the policy
# attribute ALONE. A property difference would give the diff a real change to
# send, and the provider call it then makes would be correct, not the defect.
if ! SYNTH_OUT=$(env CDKD_TEST_PHASE=allowdrop node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
  printf '%s\n' "${SYNTH_OUT}" >&2
  echo "FAIL: allowdrop-phase synth failed" >&2
  exit 1
fi
# The WHOLE resource minus UpdateReplacePolicy, not just Properties: a
# DeletionPolicy (or any other attribute) slipped into `allowmeta` alone would
# otherwise pass, and a Retain DeletionPolicy is exactly the orphaning risk the
# stack's phase doc chose UpdateReplacePolicy to avoid.
ALLOW_REST=$(jq -cS --arg k "${LOGICAL_ID}" '.Resources[$k] | del(.UpdateReplacePolicy)' "${TEMPLATE}")
ALLOW_URP=$(jq -r --arg k "${LOGICAL_ID}" '.Resources[$k].UpdateReplacePolicy // "ABSENT"' "${TEMPLATE}")
if ! SYNTH_OUT=$(env CDKD_TEST_PHASE=allowmeta node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
  printf '%s\n' "${SYNTH_OUT}" >&2
  echo "FAIL: allowmeta-phase synth failed" >&2
  exit 1
fi
META_REST=$(jq -cS --arg k "${LOGICAL_ID}" '.Resources[$k] | del(.UpdateReplacePolicy)' "${TEMPLATE}")
META_URP=$(jq -r --arg k "${LOGICAL_ID}" '.Resources[$k].UpdateReplacePolicy // "ABSENT"' "${TEMPLATE}")
[ "${ALLOW_URP}" = "ABSENT" ] && [ "${META_URP}" = "Retain" ] || {
  echo "FAIL: UpdateReplacePolicy is ${ALLOW_URP} in allowdrop and ${META_URP} in allowmeta, expected ABSENT and Retain; phase 4b would flip nothing" >&2; exit 1; }
[ "${ALLOW_REST}" = "${META_REST}" ] || {
  echo "FAIL: allowdrop and allowmeta differ in more than UpdateReplacePolicy (a property or another attribute); phase 4b would not be a policy-only flip" >&2; exit 1; }
jq -e --arg sid "${POLICY_SID}" '[.Properties.ResourcePolicyDocument.Statement[]? | select(.Sid == $sid)] | length == 1' <<<"${META_REST}" >/dev/null || {
  echo "FAIL: the allowmeta template does not carry ResourcePolicyDocument; phase 4b would not exercise the allow-listed drop" >&2; exit 1; }
echo "    OK: allowmeta differs from allowdrop by UpdateReplacePolicy alone"

# Phases 7-10's premise: the subnet carries the AZ id, and `subnettag` differs
# from `subnet` in the subnet's Tags alone.
if ! SYNTH_OUT=$(env CDKD_TEST_PHASE=subnet CDKD_TEST_AZ_ID="${AZ_ID}" node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
  printf '%s\n' "${SYNTH_OUT}" >&2
  echo "FAIL: subnet-phase synth failed" >&2
  exit 1
fi
SUBNET_LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::EC2::Subnet") | .key' "${TEMPLATE}" | head -1)
[ -n "${SUBNET_LOGICAL_ID}" ] || { echo "FAIL: no AWS::EC2::Subnet in the subnet-phase template" >&2; exit 1; }
jq -e --arg k "${SUBNET_LOGICAL_ID}" --arg az "${AZ_ID}" '.Resources[$k].Properties.AvailabilityZoneId == $az' "${TEMPLATE}" >/dev/null || {
  echo "FAIL: the subnet does not carry AvailabilityZoneId ${AZ_ID}; phases 7-10 would test nothing" >&2; exit 1; }
SUBNET_REST=$(jq -cS --arg k "${SUBNET_LOGICAL_ID}" '.Resources[$k] | del(.Properties.Tags)' "${TEMPLATE}")
if ! SYNTH_OUT=$(env CDKD_TEST_PHASE=subnettag CDKD_TEST_AZ_ID="${AZ_ID}" node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
  printf '%s\n' "${SYNTH_OUT}" >&2
  echo "FAIL: subnettag-phase synth failed" >&2
  exit 1
fi
SUBNETTAG_REST=$(jq -cS --arg k "${SUBNET_LOGICAL_ID}" '.Resources[$k] | del(.Properties.Tags)' "${TEMPLATE}")
[ "${SUBNET_REST}" = "${SUBNETTAG_REST}" ] || {
  echo "FAIL: subnet and subnettag differ in more than the subnet's Tags; phase 8 would not be an ordinary in-place change" >&2; exit 1; }
echo "==> #2790 resource under test: ${SUBNET_LOGICAL_ID}"

echo "==> Phase 1: Deploy with handled properties only (SDK route expected)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

P0=$(record '.physicalId')
LAYER0=$(record '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0}, expected sdk. The question this fixture asks is about a STILL-SDK resource, so nothing below would be about it." >&2; exit 1; }
[ "${P0}" = "${LOG_GROUP_NAME}" ] || { echo "FAIL: the recorded physical id is ${P0}, expected the log group name ${LOG_GROUP_NAME}" >&2; exit 1; }
R0=$(log_group_retention)
[ "${R0}" = "1" ] || { echo "FAIL: the base deploy did not reach AWS (RetentionInDays=${R0}, expected 1)" >&2; exit 1; }
echo "    OK: created on the SDK route (${P0})"

# IDENTITY WITNESS. The log group name is fixed by the template, so a delete +
# create mints the SAME name and comparing physical ids cannot tell an in-place
# update from a replacement. A tag applied out of band survives an update and
# dies with a replacement, so its presence afterwards is positive evidence.
ARN0=$(log_group_arn) || { echo "FAIL: could not read the log group ARN after phase 1" >&2; exit 1; }
aws logs tag-resource --resource-arn "${ARN0}" \
  --tags "cdkd-integ-witness=2744" --region "${REGION}" >/dev/null
WITNESS_BEFORE=$(witness_count "${ARN0}")
[ "${WITNESS_BEFORE}" = "1" ] || { echo "FAIL: identity witness not established (tags=${WITNESS_BEFORE}, expected 1)" >&2; exit 1; }
# The absence read the arm's positive read is measured against: a fresh SDK
# create sends no policy, so the reader must report none here.
POLICY0=$(policy_statement_count "${ARN0}") || { echo "FAIL: could not read the log group's resource policies after phase 1" >&2; exit 1; }
[ "${POLICY0}" = "0" ] || { echo "FAIL: the log group already holds a ${POLICY_SID} resource policy after the base deploy (${POLICY0}); a leftover from an earlier run would make phase 2b's readback pass vacuously" >&2; exit 1; }
echo "    OK: identity witness attached (1 unmanaged tag), no resource policy yet"

echo "==> Phase 1b: an auto-routed update that Cloud Control REFUSES names its remedies (#4904)"
# The template gains a ResourcePolicyDocument that is an object (so cdkd's own
# shape pre-flight passes it) but no valid policy, so the update is auto-routed
# from the SDK provider and fails inside Cloud Control. The failure must carry
# cdkd's note naming both flags.
if BAD_OUT=$(env CDKD_TEST_PHASE=badpolicy \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1); then
  printf '%s\n' "${BAD_OUT}" >&2
  echo "FAIL: the badpolicy deploy SUCCEEDED; Cloud Control accepted a resource policy with no Principal and no Resource, so this phase reaches no failure and asserts nothing" >&2
  exit 1
fi
printf '%s\n' "${BAD_OUT}" >&2
BAD_PLAIN=$(printf '%s' "${BAD_OUT}" | sed $'s/\033\[[0-9;]*m//g')
# SENTINEL: the failure must be the update of THIS resource, or the note's
# absence below would read as a cdkd defect when the deploy died elsewhere.
grep -qE "Failed to update resource ${LOGICAL_ID}" <<<"${BAD_PLAIN}" || {
  echo "FAIL: the badpolicy deploy failed, but not on the update of ${LOGICAL_ID}; the arm below would test nothing" >&2; exit 1; }
# And inside Cloud Control: `CloudControlProvider.handleError` words its own
# failure this way, so a failure before the route, or on the SDK provider,
# reads as a premise failure rather than as a missing note.
grep -qF "UPDATE failed for ${LOGICAL_ID}:" <<<"${BAD_PLAIN}" || {
  echo "FAIL: the update of ${LOGICAL_ID} did not fail inside Cloud Control; the arm below would test nothing" >&2; exit 1; }
grep -qF -- "moved the resource from its SDK provider to Cloud Control API" <<<"${BAD_PLAIN}" || {
  echo "FAIL: the update of ${LOGICAL_ID} failed without naming the move to Cloud Control" >&2; exit 1; }
grep -qF -- "--recreate-via-cc-api ${LOGICAL_ID}" <<<"${BAD_PLAIN}" || {
  echo "FAIL: the failure does not name --recreate-via-cc-api ${LOGICAL_ID}" >&2; exit 1; }
grep -qF -- "--prefer-sdk-route AWS::Logs::LogGroup:ResourcePolicyDocument" <<<"${BAD_PLAIN}" || {
  echo "FAIL: the failure does not name --prefer-sdk-route AWS::Logs::LogGroup:ResourcePolicyDocument" >&2; exit 1; }
LAYER_BAD=$(record '.provisionedBy')
[ "${LAYER_BAD}" = "sdk" ] || { echo "FAIL: a FAILED auto-routed update moved the record to provisionedBy=${LAYER_BAD}; it must stay sdk" >&2; exit 1; }
[ "$(record '.physicalId')" = "${P0}" ] || { echo "FAIL: the failed update changed the recorded physical id" >&2; exit 1; }
echo "    OK: the refused update names both remedies; record still sdk at ${P0}"

echo "==> Phase 2a: the plan ANNOUNCES the re-route"
DIFF_OUT=$(env CDKD_TEST_PHASE=drop \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
grep -q 'via CC API: ResourcePolicyDocument' <<<"${DIFF_OUT}" || {
  echo "FAIL: cdkd diff did not announce the Cloud Control auto-route for ResourcePolicyDocument. A deploy that moves a live resource between provisioning layers must be visible at plan time." >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
}
echo "    OK: plan says 'via CC API: ResourcePolicyDocument'"

echo "==> Phase 2b: THE ARM -- deploy the silent-drop property with NO flag"
# Output captured so the per-resource VERB can be read. NOT piped through
# `tee`: /run-integ redirects this script to a regular file, and on Linux
# /dev/stderr resolves to that path, so tee would reopen it O_TRUNC and zero
# the run log out from under the shell.
# `if !` rather than a bare assignment: under `set -e` a failing deploy aborts
# AT the assignment, so a plain `ARM_OUT=$(...)` followed by a print loses every
# line of cdkd output for the one phase that answers this fixture's question --
# and the EXIT trap then destroys the stack, so there is nothing left to look
# at either.
if ! ARM_OUT=$(env CDKD_TEST_PHASE=drop \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1); then
  printf '%s\n' "${ARM_OUT}" >&2
  echo "FAIL: the arm deploy exited non-zero" >&2
  exit 1
fi
printf '%s\n' "${ARM_OUT}" >&2
# Colour codes sit between the marker and the verb, so strip them first.
ARM_PLAIN=$(printf '%s' "${ARM_OUT}" | sed $'s/\033\[[0-9;]*m//g')
# THE VERB, not the counts. A REPLACEMENT also increments `updated`
# (deploy-engine.ts, the replacement arm) and never increments `created`, so
# `Updated: 1 / Created: 0` is byte-identical for a replace and cannot witness
# in-placeness -- an earlier revision of this fixture asserted exactly that and
# proved nothing. The per-resource line is where the two differ: an in-place
# update renders the verb `updated`, a replacement renders `replaced`.
# ANCHORED TO THE RESOURCE, not searched over the whole capture. This block
# holds the CDK app's stderr verbatim -- `app-executor.ts` re-emits every line
# at INFO, and aws-cdk-lib deprecation notices routinely say "replaced by" --
# plus cdkd's own non-replacement lines that carry the word (lock-manager's
# "it has been replaced since ..."). An unanchored `replaced` would print a
# confidently wrong verdict, which is the exact failure this assertion replaced.
#
# READ FROM A HERESTRING, not a pipe: `printf | grep -q` exits 141 under
# `pipefail` when grep stops at an early match and printf takes SIGPIPE, which
# INVERTS both idioms below -- the refusal would silently skip on exactly the
# defect it guards.
# `LOGICAL_ID` is CDK-generated alphanumeric, so it is safe unescaped, and the
# update-path fallback line ("Resource <id> was replaced: ...") carries it too.
grep -qE "${LOGICAL_ID}.*\breplaced\b" <<<"${ARM_PLAIN}" && { echo "FAIL: the deploy REPLACED the resource instead of updating it in place" >&2; exit 1; }
grep -qE "${LOGICAL_ID}.*\bupdated\b" <<<"${ARM_PLAIN}" || { echo "FAIL: the deploy did not report an update of ${LOGICAL_ID} at all; it may have been a no-op" >&2; exit 1; }
# Liveness only. `Updated:` folds full and PARTIAL updates together, and the
# metadata-only path renders the same verb without calling a provider, so this
# line pins "one resource changed", not "the property was written" -- the
# RetentionInDays and resource-policy readbacks below are what pin that.
grep -qE '^[[:space:]]*Updated:[[:space:]]*1$' <<<"${ARM_PLAIN}" || { echo "FAIL: the summary does not count exactly one changed resource" >&2; exit 1; }

P1=$(record '.physicalId')
LAYER1=$(record '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: the record did not move to Cloud Control (provisionedBy=${LAYER1}). docs/cli-deploy-safety.md's --prefer-sdk-route section claims this re-route happens with no flag." >&2; exit 1; }
[ "${P1}" = "${P0}" ] || { echo "FAIL: the auto-route changed the physical id (${P0} -> ${P1})" >&2; exit 1; }

# Did the deploy actually provision anything? Without this, "the record says
# cc-api" is equally explained by a NO_CHANGE deploy that never called a
# provider.
R1=$(log_group_retention)
[ "${R1}" = "3" ] || { echo "FAIL: the deploy did not reach AWS (RetentionInDays=${R1}, expected 3); every assertion here would be vacuous" >&2; exit 1; }

# In place, not replaced -- read before the policy, whose reader needs the ARN.
ARN1=$(log_group_arn) || { echo "FAIL: the log group is GONE after the auto-route deploy; it was deleted rather than updated" >&2; exit 1; }

# THE question. Read from AWS, not from cdkd's state record. This is also the
# fixture's PREMISE that Cloud Control applies ResourcePolicyDocument to an
# existing log group at all: if it fires, either the CC update handler does not
# write the property, or the reader cannot see it -- NOT evidence about cdkd's
# routing until both are ruled out (the record above already says cc-api).
POLICY1=$(policy_statement_count "${ARN1}") || { echo "FAIL: could not read the log group's resource policies after phase 2b" >&2; exit 1; }
[ "${POLICY1}" = "1" ] || { echo "FAIL: ResourcePolicyDocument did NOT reach AWS (${POLICY_SID} statements=${POLICY1}, expected 1). Either docs/cli-deploy-safety.md's recreate-via-cc-api section is right and the auto-route does not apply the property to an existing SDK-created resource, or this fixture's premise (Cloud Control's LogGroup handler writes ResourcePolicyDocument on UPDATE) is false. Check the latter first." >&2; exit 1; }

WITNESS_AFTER=$(witness_count "${ARN1}")
# TWO explanations if this fires, and they are not the same finding: the
# resource was REPLACED (the auto-route is not churn-free), or Cloud Control's
# read-modify-write update dropped a tag the template does not declare. Both
# are worth knowing and neither is acceptable silently, so this fails either
# way and the message says to disambiguate rather than asserting which.
[ "${WITNESS_AFTER}" = "1" ] || { echo "FAIL: the unmanaged tag is gone (tags=${WITNESS_AFTER}, expected 1). Either the log group was REPLACED despite keeping its name, or the Cloud Control update stripped a tag the template does not declare. Disambiguate before reading this as churn." >&2; exit 1; }
echo "    OK: record moved to cc-api, ResourcePolicyDocument reached AWS, id unchanged, unmanaged tag intact"

echo "==> Phase 3: CONTROL -- a genuine recreate MUST kill the witness"
# The tag surviving phase 2b only means "not replaced" if a real replacement
# would have removed it. The log group name is fixed by the template, so its
# ARN survives a destroy-and-recreate too and cannot carry that weight; nothing
# so far shows the tag can die at all. `--recreate-via-sdk-provider` performs an
# actual destroy + create, so the tag must be gone afterwards. If it is not,
# the witness is inert and phase 2b's in-place conclusion is unsupported.
#
# The template drops back to handled properties only: the flag refuses while
# the template still carries a silent-drop property, since the auto-route would
# send the recreated resource straight back to Cloud Control.
# `--force-stateful-recreation`: cdkd treats every log group as stateful on a
# recreate (RetentionInDays > 0 here); this one holds no events.
env CDKD_TEST_PHASE=rebase \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-sdk-provider "${LOGICAL_ID}" --force-stateful-recreation --yes

LAYER_RE=$(record '.provisionedBy')
[ "${LAYER_RE}" = "sdk" ] || { echo "FAIL: --recreate-via-sdk-provider did not return the resource to the SDK route (provisionedBy=${LAYER_RE})" >&2; exit 1; }
ARN2=$(log_group_arn) || { echo "FAIL: the log group is gone after the recreate" >&2; exit 1; }
# Every later phase reads its retention back so a NO_CHANGE deploy cannot pass
# vacuously; this one carried only the witness check.
R_RE=$(log_group_retention)
[ "${R_RE}" = "5" ] || { echo "FAIL: the recreate did not reach AWS (RetentionInDays=${R_RE}, expected 5)" >&2; exit 1; }
WITNESS_RECREATED=$(witness_count "${ARN2}")
[ "${WITNESS_RECREATED}" = "0" ] || { echo "FAIL: the unmanaged tag SURVIVED a real destroy-and-recreate (tags=${WITNESS_RECREATED}). The witness cannot distinguish an update from a replacement, so phase 2b's in-place conclusion rests on nothing." >&2; exit 1; }
# The policy phase 2b applied must have died with the old log group, or phase
# 4's absence read below would be measuring a leftover rather than the drop.
POLICY_RE=$(policy_statement_count "${ARN2}") || { echo "FAIL: could not read the log group's resource policies after phase 3" >&2; exit 1; }
[ "${POLICY_RE}" = "0" ] || { echo "FAIL: the ${POLICY_SID} resource policy SURVIVED a destroy-and-recreate of its log group (${POLICY_RE}); phase 4's absence control would read a leftover" >&2; exit 1; }
echo "    OK: the witness and the policy die on a real recreate -- the tag's survival in phase 2b is meaningful"

echo "==> Phase 4: CONTROL -- the opt-in flag really does drop the property"
# The arm imports "the SDK route would drop ResourcePolicyDocument" from the
# generated coverage map. This observes it: same property, the flag that says
# "stay on the SDK path and accept the drop". The record is back on 'sdk' after
# phase 3's recreate, which is the state this control needs.
env CDKD_TEST_PHASE=allowdrop \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --prefer-sdk-route "AWS::Logs::LogGroup:ResourcePolicyDocument" --yes

LAYER_ALLOW=$(record '.provisionedBy')
[ "${LAYER_ALLOW}" = "sdk" ] || { echo "FAIL: --prefer-sdk-route did not keep the resource on the SDK route (provisionedBy=${LAYER_ALLOW})" >&2; exit 1; }
R_ALLOW=$(log_group_retention)
[ "${R_ALLOW}" = "7" ] || { echo "FAIL: the control deploy did not reach AWS (RetentionInDays=${R_ALLOW}, expected 7); it proves nothing about the drop" >&2; exit 1; }
ARN_ALLOW=$(log_group_arn) || { echo "FAIL: could not read the log group ARN after phase 4" >&2; exit 1; }
P_ALLOW=$(policy_statement_count "${ARN_ALLOW}") || { echo "FAIL: could not read the log group's resource policies after phase 4" >&2; exit 1; }
[ "${P_ALLOW}" = "0" ] || { echo "FAIL: ResourcePolicyDocument reached AWS on the SDK route (${POLICY_SID} statements=${P_ALLOW}); it is not a silent drop for this type, so phase 2b measured nothing" >&2; exit 1; }
# go-to-k/cdkd#2750, the WRITE half -- the record must describe what was SENT,
# not what the template asked for. This is the assertion that fails against the
# pre-fix binary, and the property whose presence used to make the flag-less
# deploy below a no-op patch.
RECORDED_ALLOW=$(record '.properties.ResourcePolicyDocument // "ABSENT"')
[ "${RECORDED_ALLOW}" = "ABSENT" ] || { echo "FAIL: the opt-out deploy RECORDED ResourcePolicyDocument (${RECORDED_ALLOW}) even though AWS does not hold it. go-to-k/cdkd#2750: state must not claim a value AWS does not hold -- the Cloud Control re-route below diffs against this bag." >&2; exit 1; }
# The record is NARROWED, not emptied: a wholesale replacement would satisfy the
# line above while destroying every value the SDK route DID write, and the patch
# in phase 5 would then re-send the whole bag.
RECORDED_RETENTION=$(record '.properties.RetentionInDays')
awk -v t="${RECORDED_RETENTION}" 'BEGIN { exit !(t + 0 == 7) }' || { echo "FAIL: the record lost a property the SDK route DID write (RetentionInDays=${RECORDED_RETENTION}, expected 7); the #2750 narrowing must drop only the silent-drop keys" >&2; exit 1; }
echo "    OK: stayed on SDK, other properties applied, ResourcePolicyDocument dropped and NOT recorded"

# Asserts one policy-attribute deploy took the STATE-ONLY branch. $1 = phase
# label, $2 = the captured deploy output.
#
# The observable is the per-resource VERB. The attribute-only branch renders
# `updated (metadata)`; a provider update renders a bare `updated`. The bare
# verb is the SENTINEL: present without `(metadata)` means the provider was
# called, absent altogether means the deploy saw no change and the phase
# tested nothing. Anchored to the resource for the reason phase 2b gives.
#
# The previous premise also read the alarm's configuration timestamp from AWS.
# A log group has no such field, and its provider's update() issues no call for
# an unchanged bag, so AWS cannot witness a provider call here: the verb is the
# whole observable.
assert_metadata_only() {
  local label="$1" plain
  plain=$(printf '%s' "$2" | sed $'s/\033\[[0-9;]*m//g')
  grep -qE "${LOGICAL_ID}.*\bupdated\b" <<<"${plain}" || {
    echo "FAIL (${label}): the deploy reported no update of ${LOGICAL_ID}; the diff did not see the UpdateReplacePolicy flip and this phase tests nothing" >&2; exit 1; }
  grep -qE "${LOGICAL_ID}.*updated \(metadata\)" <<<"${plain}" || {
    echo "FAIL (${label}): the policy-only flip reached the provider's update() (verb 'updated', not 'updated (metadata)'). go-to-k/cdkd#2809 has regressed: the no-change re-check compared the allow-listed drop on the desired side against a record that never held it." >&2; exit 1; }
}

echo "==> Phase 4b: go-to-k/cdkd#2809 -- a policy-only flip under the flag skips the provider"
# After phase 4 the record is narrowed (no ResourcePolicyDocument) while the
# template still carries it and the flag still allows the drop. The diff narrows
# its desired side by the allow set, so it reports the UpdateReplacePolicy flip
# and nothing else. The engine's no-change re-check must narrow the same way,
# or the two bags never match and the flip costs a full provider update()
# instead of the state-only refresh.
if ! META_OUT=$(env CDKD_TEST_PHASE=allowmeta \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --prefer-sdk-route "AWS::Logs::LogGroup:ResourcePolicyDocument" --yes 2>&1); then
  printf '%s\n' "${META_OUT}" >&2
  echo "FAIL: the phase 4b deploy exited non-zero" >&2
  exit 1
fi
printf '%s\n' "${META_OUT}" >&2
assert_metadata_only "phase 4b" "${META_OUT}"
URP_META=$(record '.updateReplacePolicy // "ABSENT"')
[ "${URP_META}" = "Retain" ] || { echo "FAIL: the record's updateReplacePolicy is ${URP_META} after phase 4b, expected Retain; the state half of the attribute refresh did not land" >&2; exit 1; }
LAYER_META=$(record '.provisionedBy')
[ "${LAYER_META}" = "sdk" ] || { echo "FAIL: phase 4b moved the record off the SDK route (provisionedBy=${LAYER_META})" >&2; exit 1; }
RECORDED_META=$(record '.properties.ResourcePolicyDocument // "ABSENT"')
[ "${RECORDED_META}" = "ABSENT" ] || { echo "FAIL: phase 4b recorded ResourcePolicyDocument (${RECORDED_META}); the attribute refresh must leave the narrowed properties alone" >&2; exit 1; }
R_META=$(log_group_retention)
[ "${R_META}" = "7" ] || { echo "FAIL: the log group's RetentionInDays is ${R_META} after phase 4b, expected phase 4's 7" >&2; exit 1; }
echo "    OK: updated (metadata), record carries UpdateReplacePolicy Retain, AWS untouched"

echo "==> Phase 4c: the flip back is state-only too"
# Deploys phase 4's template again, so the record phase 5 starts from is the
# one phase 4 wrote -- phase 5's comparison with phase 2b depends on that.
if ! BACK_OUT=$(env CDKD_TEST_PHASE=allowdrop \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --prefer-sdk-route "AWS::Logs::LogGroup:ResourcePolicyDocument" --yes 2>&1); then
  printf '%s\n' "${BACK_OUT}" >&2
  echo "FAIL: the phase 4c deploy exited non-zero" >&2
  exit 1
fi
printf '%s\n' "${BACK_OUT}" >&2
assert_metadata_only "phase 4c" "${BACK_OUT}"
URP_BACK=$(record '.updateReplacePolicy // "ABSENT"')
[ "${URP_BACK}" = "ABSENT" ] || { echo "FAIL: the record's updateReplacePolicy is ${URP_BACK} after the flip back, expected it cleared" >&2; exit 1; }
echo "    OK: flipped back through the attribute refresh; the record is phase 4's again"

echo "==> Phase 5: go-to-k/cdkd#2750 -- the re-route applies the property the opt-out dropped"
# Before go-to-k/cdkd#2750 the opt-out deploy persisted the silent-drop property
# into the state record even though it was never written to AWS, and
# `CloudControlProvider.update` builds a JSON Patch from the RECORDED bag to the
# desired one -- so the property was identical on both sides, the patch omitted
# it, and this flag-less deploy (byte-identical in operation to phase 2b, which
# DID apply it) silently did not.
#
# The fix is on the WRITE side: the record now describes what the SDK route
# sent, so the property is an ADDITION here and the patch carries it. Phase 4
# asserts the record half; this asserts the consequence AT AWS, which is the
# only place the two halves meeting is observable.
RECORDED_BEFORE=$(record '.properties.ResourcePolicyDocument // "ABSENT"')
[ "${RECORDED_BEFORE}" = "ABSENT" ] || { echo "FAIL: the opt-out deploy recorded ResourcePolicyDocument (${RECORDED_BEFORE}); go-to-k/cdkd#2750 has regressed on the write side and the patch below will diff it as unchanged" >&2; exit 1; }

# RE-ARM the identity witness. Phase 3's `--recreate-via-sdk-provider` really
# did destroy and re-create the log group, so phase 1's tag is gone by now
# (that is what phase 3 asserts). This deploy applies the property for real,
# which makes "in place or by replacement?" a live question again -- and phase
# 3 already proved the tag dies on a genuine recreate, so its survival below is
# evidence.
ARN_BEFORE_AGAIN=$(log_group_arn) || { echo "FAIL: could not read the log group ARN before phase 5" >&2; exit 1; }
aws logs tag-resource --resource-arn "${ARN_BEFORE_AGAIN}" \
  --tags "cdkd-integ-witness=2750" --region "${REGION}" >/dev/null
WITNESS_REARMED=$(witness_count "${ARN_BEFORE_AGAIN}")
[ "${WITNESS_REARMED}" = "1" ] || { echo "FAIL: identity witness not re-armed for phase 5 (tags=${WITNESS_REARMED}, expected 1)" >&2; exit 1; }

env CDKD_TEST_PHASE=dropagain \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LAYER_AGAIN=$(record '.provisionedBy')
[ "${LAYER_AGAIN}" = "cc-api" ] || { echo "FAIL: the resource did not re-route to Cloud Control (provisionedBy=${LAYER_AGAIN}); the property below can only land VIA that route, so without it the readback proves nothing about go-to-k/cdkd#2750" >&2; exit 1; }
R_AGAIN=$(log_group_retention)
[ "${R_AGAIN}" = "14" ] || { echo "FAIL: the deploy did not reach AWS (RetentionInDays=${R_AGAIN}, expected 14)" >&2; exit 1; }
ARN_AGAIN=$(log_group_arn) || { echo "FAIL: the log group is gone after phase 5" >&2; exit 1; }
P_AGAIN=$(policy_statement_count "${ARN_AGAIN}") || { echo "FAIL: could not read the log group's resource policies after phase 5" >&2; exit 1; }
[ "${P_AGAIN}" = "1" ] || { echo "FAIL: ResourcePolicyDocument did NOT reach AWS (${POLICY_SID} statements=${P_AGAIN}, expected 1). go-to-k/cdkd#2750 has regressed: the re-route fired but the Cloud Control patch still omitted the property the earlier opt-out deploy dropped." >&2; exit 1; }
# The re-route must not have replaced the log group to apply it -- the whole
# promise of the auto-route is an in-place update, and phase 3 proved the
# witness dies on a real recreate.
WITNESS_AGAIN=$(witness_count "${ARN_AGAIN}")
[ "${WITNESS_AGAIN}" = "1" ] || { echo "FAIL: the unmanaged tag is gone (tags=${WITNESS_AGAIN}, expected 1); the re-route applied ResourcePolicyDocument by REPLACING the log group rather than updating it in place" >&2; exit 1; }
echo "    OK: re-routed to Cloud Control, the property landed, and the log group was not replaced"

echo "==> Phase 7: go-to-k/cdkd#2790 -- a create-only drop accepted with --prefer-sdk-route"
env CDKD_TEST_PHASE=subnet CDKD_TEST_AZ_ID="${AZ_ID}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --prefer-sdk-route "AWS::EC2::Subnet:AvailabilityZoneId" --yes
SUBNET_P0=$(record_of "${SUBNET_LOGICAL_ID}" '.physicalId')
case "${SUBNET_P0}" in
  subnet-?*) ;;
  *) echo "FAIL: the subnet record has no subnet id (physicalId=${SUBNET_P0})" >&2; exit 1 ;;
esac
VPC_ID=$(aws ec2 describe-subnets --subnet-ids "${SUBNET_P0}" --region "${REGION}" \
  --query 'Subnets[0].VpcId' --output text)
case "${VPC_ID}" in
  vpc-?*) ;;
  *) echo "FAIL: could not read the subnet's VPC (VpcId=${VPC_ID})" >&2; exit 1 ;;
esac
SUBNET_LAYER0=$(record_of "${SUBNET_LOGICAL_ID}" '.provisionedBy')
[ "${SUBNET_LAYER0}" = "sdk" ] || { echo "FAIL: --prefer-sdk-route did not keep the subnet on its SDK provider (provisionedBy=${SUBNET_LAYER0}); the record below is not the one #2790 is about" >&2; exit 1; }
# The PREMISE of the arm: the record keeps the create-only drop it never wrote.
SUBNET_REC_AZ=$(record_of "${SUBNET_LOGICAL_ID}" '.properties.AvailabilityZoneId // "ABSENT"')
[ "${SUBNET_REC_AZ}" = "${AZ_ID}" ] || { echo "FAIL: the record holds AvailabilityZoneId=${SUBNET_REC_AZ}, expected ${AZ_ID}; a create-only drop is no longer kept in the record and phase 9 tests nothing" >&2; exit 1; }
# ...and names it as EVIDENCE that it was never sent: only a named key is
# refused, so without this phase 9 would see NO_CHANGE.
SUBNET_EVIDENCE=$(record_of "${SUBNET_LOGICAL_ID}" '(.acceptedCreateOnlyDrops // []) | any(.[]?; . == "AvailabilityZoneId")')
[ "${SUBNET_EVIDENCE}" = "true" ] || { echo "FAIL: the record does not name AvailabilityZoneId in acceptedCreateOnlyDrops; the SDK-route create wrote no #2790 evidence" >&2; exit 1; }
# Where EC2 put the SDK-created subnet. The SDK route drops the AZ id, so EC2
# picks; when it happens to pick ${AZ_ID}, phase 10's AZ readback cannot tell
# a written id from a coincidence, and says so rather than passing silently.
SUBNET_P0_AZ=$(subnet_az_id "${SUBNET_P0}")
case "${SUBNET_P0_AZ}" in
  ""|None) echo "FAIL: could not read subnet ${SUBNET_P0}'s AZ id" >&2; exit 1 ;;
esac
echo "    OK: subnet ${SUBNET_P0} on the SDK route (in ${SUBNET_P0_AZ}), record keeps AvailabilityZoneId"

echo "==> Phase 8: NEGATIVE CONTROL -- a flag-ful redeploy over that record does not replace"
env CDKD_TEST_PHASE=subnettag CDKD_TEST_AZ_ID="${AZ_ID}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --prefer-sdk-route "AWS::EC2::Subnet:AvailabilityZoneId" --yes
SUBNET_P1=$(record_of "${SUBNET_LOGICAL_ID}" '.physicalId')
[ "${SUBNET_P1}" = "${SUBNET_P0}" ] || { echo "FAIL: the flag-ful redeploy REPLACED the subnet (${SUBNET_P0} -> ${SUBNET_P1}); keeping the drop on both sides of the diff is what must prevent that" >&2; exit 1; }
NAME_TAG=$(aws ec2 describe-subnets --subnet-ids "${SUBNET_P0}" --region "${REGION}" \
  --query "Subnets[0].Tags[?Key=='Name'].Value | [0]" --output text)
[ "${NAME_TAG}" = "${STACK}-subnettag" ] || { echo "FAIL: the tag change did not reach AWS (Name=${NAME_TAG}); the phase changed nothing and proves nothing" >&2; exit 1; }
echo "    OK: tag updated in place, subnet not replaced"

echo "==> Phase 9: THE #2790 ARM -- the same template with NO flag must refuse"
# Before the fix the record and the template held the same AvailabilityZoneId,
# the diff called it NO_CHANGE, and the deploy reported success with the
# property never written. `if` rather than `!`: the deploy is EXPECTED to fail.
if REFUSE_OUT=$(env CDKD_TEST_PHASE=subnettag CDKD_TEST_AZ_ID="${AZ_ID}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1); then
  printf '%s\n' "${REFUSE_OUT}" >&2
  echo "FAIL: the flag-less deploy SUCCEEDED. go-to-k/cdkd#2790: AvailabilityZoneId was never written, applying it needs a replacement, and the deploy must refuse rather than report success." >&2
  exit 1
fi
printf '%s\n' "${REFUSE_OUT}" >&2
REFUSE_PLAIN=$(printf '%s' "${REFUSE_OUT}" | sed $'s/\033\[[0-9;]*m//g')
grep -qF "${SUBNET_LOGICAL_ID} (AWS::EC2::Subnet): AvailabilityZoneId is create-only, and the state record holds it" <<<"${REFUSE_PLAIN}" || {
  echo "FAIL: the deploy failed, but not with the #2790 refusal; read the output above" >&2; exit 1; }
grep -qF -- "--prefer-sdk-route does not cover AvailabilityZoneId" <<<"${REFUSE_PLAIN}" || {
  echo "FAIL: the refusal does not name AvailabilityZoneId as the key routing the subnet to Cloud Control" >&2; exit 1; }
grep -qF -- "--recreate-via-cc-api ${SUBNET_LOGICAL_ID}" <<<"${REFUSE_PLAIN}" || {
  echo "FAIL: the refusal does not name --recreate-via-cc-api ${SUBNET_LOGICAL_ID}, the opt-in phase 10 takes" >&2; exit 1; }
SUBNET_P2=$(record_of "${SUBNET_LOGICAL_ID}" '.physicalId')
[ "${SUBNET_P2}" = "${SUBNET_P0}" ] || { echo "FAIL: the refused deploy changed the subnet's record (${SUBNET_P0} -> ${SUBNET_P2})" >&2; exit 1; }
SUBNET_LAYER2=$(record_of "${SUBNET_LOGICAL_ID}" '.provisionedBy')
[ "${SUBNET_LAYER2}" = "sdk" ] || { echo "FAIL: the refused deploy moved the subnet's record to ${SUBNET_LAYER2}" >&2; exit 1; }
LIVE_AFTER_REFUSAL=$(aws ec2 describe-subnets --subnet-ids "${SUBNET_P0}" --region "${REGION}" \
  --query 'Subnets[0].SubnetId' --output text)
[ "${LIVE_AFTER_REFUSAL}" = "${SUBNET_P0}" ] || { echo "FAIL: subnet ${SUBNET_P0} is gone after the refusal (${LIVE_AFTER_REFUSAL}); the refusal must come before the delete" >&2; exit 1; }
echo "    OK: refused, naming AvailabilityZoneId and the opt-in; the subnet is untouched"

echo "==> Phase 10: the opt-in -- --recreate-via-cc-api applies the property"
env CDKD_TEST_PHASE=subnettag CDKD_TEST_AZ_ID="${AZ_ID}" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${SUBNET_LOGICAL_ID}" --yes
SUBNET_P3=$(record_of "${SUBNET_LOGICAL_ID}" '.physicalId')
case "${SUBNET_P3}" in
  subnet-?*) ;;
  *) echo "FAIL: the recreated subnet's record has no subnet id (physicalId=${SUBNET_P3})" >&2; exit 1 ;;
esac
[ "${SUBNET_P3}" != "${SUBNET_P0}" ] || { echo "FAIL: --recreate-via-cc-api kept subnet ${SUBNET_P0}; nothing was re-created" >&2; exit 1; }
SUBNET_LAYER3=$(record_of "${SUBNET_LOGICAL_ID}" '.provisionedBy')
[ "${SUBNET_LAYER3}" = "cc-api" ] || { echo "FAIL: the recreate did not land on Cloud Control (provisionedBy=${SUBNET_LAYER3})" >&2; exit 1; }
LIVE_AZ=$(subnet_az_id "${SUBNET_P3}")
[ "${LIVE_AZ}" = "${AZ_ID}" ] || { echo "FAIL: the recreated subnet is in ${LIVE_AZ}, expected ${AZ_ID}: AvailabilityZoneId did not reach AWS" >&2; exit 1; }
if [ "${SUBNET_P0_AZ}" = "${AZ_ID}" ]; then
  echo "    NOTE: EC2 placed the SDK-created subnet in ${AZ_ID} already, so this AZ readback does not discriminate on this run (phase 9's refusal still does)"
fi
assert_gone "the old subnet ${SUBNET_P0} survived the recreate" \
  aws ec2 describe-subnets --subnet-ids "${SUBNET_P0}" --region "${REGION}"
echo "    OK: re-created on Cloud Control in ${AZ_ID}; the old subnet is gone"

echo "==> Phase 6: Destroy + gone-probe"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "subnet ${SUBNET_P3} survived destroy" \
  aws ec2 describe-subnets --subnet-ids "${SUBNET_P3}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} survived destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
LG_GONE=$(log_group_json)
[ "${LG_GONE}" = "null" ] || { echo "FAIL: log group ${LOG_GROUP_NAME} survived destroy (${LG_GONE})" >&2; exit 1; }
echo "    OK: destroyed clean"

echo "PASS: sdk-to-cc-autoroute (auto-route observed on a live SDK-created resource; a never-written create-only drop refused)"
