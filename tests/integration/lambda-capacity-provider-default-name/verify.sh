#!/usr/bin/env bash
# verify.sh -- cdkd AWS::Lambda::CapacityProvider without an explicit name
# (issue #3174).
#
# `AWS::Lambda::CapacityProvider` has no SDK provider, so it is created through
# Cloud Control. The schema does not require `CapacityProviderName`, but a
# Cloud Control create without one fails with `Resource Handler Internal
# Failure`. cdkd now fills a generated name on the CREATE
# (`FALLBACK_NAME_RULES` in `src/provisioning/resource-name.ts`) and takes it
# back out of the UPDATE bag (`withoutGeneratedFallbackName`), where it would
# be a change to a create-only property for a provider whose live name is not
# the generated one.
#
# Phases:
#   1. Deploy a VPC, a capacity provider with NO name and a function attached
#      to it with `publishToLatestPublished`, and a second unnamed provider
#      (`SpareProvider`) with nothing attached. Assert: state records both
#      providers under their generated `<stack>-<logicalId>` names on the Cloud
#      Control route, AWS reports them `Active`, the function's
#      CapacityProviderConfig points at the first, and the ProviderArn output
#      agrees. The deploy runs with `--verbose` so the log shows whether the
#      create was retried on the operator-role propagation rejection
#      (`IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS`); the count is reported, not
#      asserted, since a role that propagates in time needs no retry.
#   2. `cdkd diff` reports no changes (the generated name must not read as a
#      create-only change on the next run).
#   2b. Re-point SpareProvider's state record at a provider created OUT OF BAND
#      under a different name, then delete the generated one. This is the
#      imported-under-another-name premise: the recorded bag names nothing, the
#      live name is not `<stack>-<logicalId>`. The record is rewritten directly
#      rather than through `cdkd import`, which records the template's
#      UNRESOLVED properties and `provisionedBy: 'sdk'` (import.ts) -- two
#      differences this phase is not about. Only the physical id, the `Arn`
#      attribute and any observed `CapacityProviderName` change.
#   3. UPDATE (CDKD_TEST_UPDATE=true tags both providers, a mutable property):
#      both go through the Cloud Control update path. Assert each tag reached
#      AWS, each provider keeps its ARN and its state physical id (in place,
#      not replaced), and a diff under the same mode is clean.
#   4. Destroy. Assert every provider and the function are gone, no instance is
#      left in the fixture VPC, the VPC is gone, and the state file is removed.
#
# Not established by this fixture: that phase 3 FAILS on a binary without the
# update-path fix. The unit suite carries that direction
# (tests/unit/deployment/deploy-engine-cc-update-fallback-name.test.ts).
#
# COST: the first provider launches EC2 instances once the function version is
# published, so every run carries an EC2 charge until the destroy finishes. The
# spare providers have no function and launch none.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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
export AWS_PAGER=""

STACK="CdkdLmiCapacityProviderExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Every name here is what cdkd derives, `<stack>-<logicalId>`, well under the
# 140-character cap, so no hash suffix -- except SPARE_REWIRED, which is the
# out-of-band name phase 2b deliberately makes DIFFERENT. `cleanup` reaches all
# of them by name even when the state record is gone.
PROVIDER_NAME="${STACK}-Provider2281708E"
SPARE_GENERATED="${STACK}-SpareProvider8B33A338"
SPARE_REWIRED="${STACK}-rewired-spare"
FUNCTION_NAME="${STACK}-Handler886CB40B"
DIFF_LOG="${TMPDIR:-/tmp}/cdkd-3174-diff.$$.log"
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-3174-deploy.$$.log"

# Best-effort, retried delete of one capacity provider by name. A provider
# refuses deletion while a function version still runs on it or its instances
# drain, so only an explicit not-found (or a successful delete) ends the loop.
delete_provider() { ( # usage: delete_provider <name>
  set +eu
  local name="$1" done="" err=""
  for _ in $(seq 1 40); do
    err="$(aws lambda delete-capacity-provider --capacity-provider-name "${name}" --region "${REGION}" 2>&1 >/dev/null)" && { done=1; break; }
    printf '%s\n' "${err}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' && { done=1; break; }
    sleep 15
  done
  if [ -z "${done}" ]; then
    echo "WARN: cleanup could not delete capacity provider ${name} after 40 attempts (~10 min) — it may still exist and MUST be checked. Last AWS error: ${err}" >&2
  fi
) }

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DIFF_LOG}" "${DEPLOY_LOG}"
  # The spare providers first, BEFORE `state destroy`: the out-of-band one is in
  # no state record until phase 2b rewrites it, and the generated one leaves
  # state at that point, so either can still reference the operator role,
  # security group and subnets `state destroy` is about to delete.
  delete_provider "${SPARE_REWIRED}"
  delete_provider "${SPARE_GENERATED}"
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # The function before its provider: deleting it deletes every version, which
  # frees the provider it runs on.
  aws lambda delete-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  delete_provider "${PROVIDER_NAME}"
  case "${STACK}" in
    CdkdLmi?*)
      for lg in $(aws logs describe-log-groups --region "${REGION}" \
        --log-group-name-prefix "/aws/lambda/${STACK}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
        aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdLmi?*" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup
CLEANED_UP=0

read_state() { # $1 = python expression over `s` (the state fetched into STATE_JSON)
  printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print($1)"
}
provider_field() { # usage: provider_field <name> <query field>; strict, no fallback
  aws lambda get-capacity-provider --capacity-provider-name "$1" --region "${REGION}" \
    --query "CapacityProvider.$2" --output text
}
provider_tag() { # usage: provider_tag <arn>; prints `None` when the tag is absent
  aws lambda list-tags --resource "$1" --region "${REGION}" \
    --query 'Tags."cdkd-integ-phase"' --output text
}
assert_clean_diff() { # $1 = phase label; runs under the caller's CDKD_TEST_UPDATE
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DIFF_LOG}" 2>&1
  if ! grep -q "No changes detected" "${DIFF_LOG}"; then
    echo "FAIL: diff $1 is not clean. Tail:" >&2
    tail -20 "${DIFF_LOG}" >&2
    exit 1
  fi
}

# --- Phase 1: deploy with no CapacityProviderName ------------------------
echo "==> Phase 1: deploy (two capacity providers without a name + an attached function)"
# `--verbose` only for this deploy, and only to count retries below; nothing in
# this script greps the deploy's own rows. `pipefail` keeps the deploy's rc.
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose 2>&1 | tee "${DEPLOY_LOG}"

# Was the create retried on the operator-role propagation rejection? Reported,
# not asserted: a role that has propagated needs no retry. The count is only
# meaningful when the log really holds debug output, so a capture that lost it
# (a format change, a dropped `--verbose`) fails here instead of reading as
# "no retry". Verbose lines are `<ISO timestamp> <LEVEL> <message>`.
DEPLOY_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${DEPLOY_LOG}")"
DEBUG_LINES="$(grep -ciE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z +debug ' <<< "${DEPLOY_PLAIN}" || true)"
[ "${DEBUG_LINES}" -gt 0 ] ||
  { echo "FAIL: phase 1 deploy log holds no debug lines -- the retry count below would be vacuous" >&2; exit 1; }
OPERATOR_ROLE_RETRIES="$(grep -cE 'Retrying .*operator role is invalid' <<< "${DEPLOY_PLAIN}" || true)"
echo "    operator-role propagation retries during phase 1: ${OPERATOR_ROLE_RETRIES} (debug lines captured: ${DEBUG_LINES})"

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
STATE_PROVIDER_ID="$(read_state "s['resources']['Provider2281708E']['physicalId']")"
STATE_PROVIDER_ROUTE="$(read_state "s['resources']['Provider2281708E'].get('provisionedBy', '')")"
STATE_SPARE_ID="$(read_state "s['resources']['SpareProvider8B33A338']['physicalId']")"
STATE_SPARE_ROUTE="$(read_state "s['resources']['SpareProvider8B33A338'].get('provisionedBy', '')")"
STATE_FUNCTION_ID="$(read_state "s['resources']['Handler886CB40B']['physicalId']")"
OUT_ARN="$(read_state "s.get('outputs', {}).get('ProviderArn', '')")"
VPC_ID="$(read_state "s['resources']['Vpc8378EB38']['physicalId']")"

[ "${STATE_PROVIDER_ID}" = "${PROVIDER_NAME}" ] ||
  { echo "FAIL: capacity provider physicalId '${STATE_PROVIDER_ID}' != generated name '${PROVIDER_NAME}'" >&2; exit 1; }
[ "${STATE_SPARE_ID}" = "${SPARE_GENERATED}" ] ||
  { echo "FAIL: spare provider physicalId '${STATE_SPARE_ID}' != generated name '${SPARE_GENERATED}'" >&2; exit 1; }
[ "${STATE_PROVIDER_ROUTE}" = "cc-api" ] && [ "${STATE_SPARE_ROUTE}" = "cc-api" ] ||
  { echo "FAIL: provisionedBy provider='${STATE_PROVIDER_ROUTE}' spare='${STATE_SPARE_ROUTE}', expected cc-api for both" >&2; exit 1; }
[ "${STATE_FUNCTION_ID}" = "${FUNCTION_NAME}" ] ||
  { echo "FAIL: function physicalId '${STATE_FUNCTION_ID}' != '${FUNCTION_NAME}' (cleanup targets that name)" >&2; exit 1; }
echo "    state records ${PROVIDER_NAME} and ${SPARE_GENERATED} via cc-api"

PROVIDER_STATE="$(provider_field "${PROVIDER_NAME}" State)"
PROVIDER_ARN="$(provider_field "${PROVIDER_NAME}" CapacityProviderArn)"
SPARE_STATE="$(provider_field "${SPARE_GENERATED}" State)"
[ "${PROVIDER_STATE}" = "Active" ] && [ "${SPARE_STATE}" = "Active" ] ||
  { echo "FAIL: provider states provider='${PROVIDER_STATE}' spare='${SPARE_STATE}', expected Active for both" >&2; exit 1; }
case "${PROVIDER_ARN}" in
  arn:aws*:lambda:*:capacity-provider:"${PROVIDER_NAME}") ;;
  *) echo "FAIL: capacity provider ARN '${PROVIDER_ARN}' does not end in ${PROVIDER_NAME}" >&2; exit 1 ;;
esac
[ "${OUT_ARN}" = "${PROVIDER_ARN}" ] ||
  { echo "FAIL: ProviderArn output '${OUT_ARN}' != AWS ARN '${PROVIDER_ARN}'" >&2; exit 1; }
echo "    AWS reports both providers Active; output agrees"

FN_PROVIDER_ARN="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" \
  --query 'CapacityProviderConfig.LambdaManagedInstancesCapacityProviderConfig.CapacityProviderArn' --output text)"
[ "${FN_PROVIDER_ARN}" = "${PROVIDER_ARN}" ] ||
  { echo "FAIL: function CapacityProviderArn '${FN_PROVIDER_ARN}' != '${PROVIDER_ARN}'" >&2; exit 1; }
echo "    function ${FUNCTION_NAME} runs on the provider"

INSTANCES_UP="$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text | wc -w)"
echo "    instances in ${VPC_ID} after deploy: ${INSTANCES_UP} (informational)"

# --- Phase 2: diff is clean ------------------------------------------------
echo "==> Phase 2: diff (expect no changes)"
# Empty rather than unset: a function call cannot take `env -u`, and the stack
# only tags when the value is exactly `true`.
CDKD_TEST_UPDATE= assert_clean_diff "after the create"
echo "    diff reports no changes"

# --- Phase 2b: a provider whose live name is not the generated one ---------
echo "==> Phase 2b: re-point SpareProvider8B33A338 at ${SPARE_REWIRED}, created out of band"
SUBNETS_JSON="$(read_state "json.dumps([s['resources'][k]['physicalId'] for k in ('VpcisolatedSubnet1SubnetE62B1B9B', 'VpcisolatedSubnet2Subnet39217055', 'VpcisolatedSubnet3Subnet44F2537D')])")"
SG_ID="$(read_state "s['resources']['LmiSgFC1639E4']['physicalId']")"
SPARE_ROLE_NAME="$(read_state "s['resources']['SpareProviderOperatorRole6345D27C']['physicalId']")"
SPARE_ROLE_ARN="$(aws iam get-role --role-name "${SPARE_ROLE_NAME}" --query 'Role.Arn' --output text)"
aws lambda create-capacity-provider --capacity-provider-name "${SPARE_REWIRED}" --region "${REGION}" \
  --vpc-config "{\"SubnetIds\":${SUBNETS_JSON},\"SecurityGroupIds\":[\"${SG_ID}\"]}" \
  --permissions-config "{\"CapacityProviderOperatorRoleArn\":\"${SPARE_ROLE_ARN}\"}" \
  --instance-requirements '{"Architectures":["arm64"]}' >/dev/null
REWIRED_STATE=""
for _ in $(seq 1 60); do
  REWIRED_STATE="$(provider_field "${SPARE_REWIRED}" State)"
  [ "${REWIRED_STATE}" = "Pending" ] || break
  sleep 5
done
[ "${REWIRED_STATE}" = "Active" ] ||
  { echo "FAIL: out-of-band provider ${SPARE_REWIRED} is '${REWIRED_STATE}', expected Active" >&2; exit 1; }
SPARE_REWIRED_ARN="$(provider_field "${SPARE_REWIRED}" CapacityProviderArn)"

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
REWRITTEN_JSON="$(printf '%s' "${STATE_JSON}" | SPARE_REWIRED="${SPARE_REWIRED}" SPARE_REWIRED_ARN="${SPARE_REWIRED_ARN}" python3 -c '
import json, os, sys
s = json.load(sys.stdin)
# The premise the update-path fix rests on: no recorded provider bag names
# anything, for either provider phase 3 updates.
for logical_id in ("Provider2281708E", "SpareProvider8B33A338"):
    if "CapacityProviderName" in s["resources"][logical_id].get("properties", {}):
        sys.exit(f"FAIL: premise: the recorded {logical_id} bag already carries CapacityProviderName")
r = s["resources"]["SpareProvider8B33A338"]
r["physicalId"] = os.environ["SPARE_REWIRED"]
r.setdefault("attributes", {})["Arn"] = os.environ["SPARE_REWIRED_ARN"]
observed = r.get("observedProperties")
if isinstance(observed, dict) and "CapacityProviderName" in observed:
    observed["CapacityProviderName"] = os.environ["SPARE_REWIRED"]
print(json.dumps(s))
')"
printf '%s' "${REWRITTEN_JSON}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
REWIRED_RECORD_ID="$(read_state "s['resources']['SpareProvider8B33A338']['physicalId']")"
[ "${REWIRED_RECORD_ID}" = "${SPARE_REWIRED}" ] ||
  { echo "FAIL: state rewrite did not land: SpareProvider8B33A338 is '${REWIRED_RECORD_ID}', not ${SPARE_REWIRED}" >&2; exit 1; }

# The generated spare is now in no state record; remove it so only the
# rewired provider remains under this logical id.
aws lambda delete-capacity-provider --capacity-provider-name "${SPARE_GENERATED}" --region "${REGION}" >/dev/null
SPARE_GENERATED_GONE=""
for _ in $(seq 1 60); do
  if gone_probe aws lambda get-capacity-provider --capacity-provider-name "${SPARE_GENERATED}" --region "${REGION}"; then
    SPARE_GENERATED_GONE=1
    break
  fi
  sleep 5
done
[ -n "${SPARE_GENERATED_GONE}" ] ||
  { echo "FAIL: generated spare ${SPARE_GENERATED} still exists 5 min after its delete" >&2; exit 1; }

# The update below must ADD the tags, so neither may be present yet. Captured
# first: a failing `list-tags` inside `[ ... ]` would not stop the script and
# would print the wrong cause.
PROVIDER_TAG_BEFORE="$(provider_tag "${PROVIDER_ARN}")"
REWIRED_TAG_BEFORE="$(provider_tag "${SPARE_REWIRED_ARN}")"
[ "${PROVIDER_TAG_BEFORE}" = "None" ] && [ "${REWIRED_TAG_BEFORE}" = "None" ] ||
  { echo "FAIL: premise: tag cdkd-integ-phase already present before the update phase (provider='${PROVIDER_TAG_BEFORE}' rewired='${REWIRED_TAG_BEFORE}')" >&2; exit 1; }
echo "    SpareProvider8B33A338 now records ${SPARE_REWIRED}; the generated spare is gone"

# --- Phase 3: in-place UPDATE through Cloud Control -------------------------
echo "==> Phase 3: update (tag both providers; mutable, so no replacement)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

for pair in "${PROVIDER_NAME} ${PROVIDER_ARN}" "${SPARE_REWIRED} ${SPARE_REWIRED_ARN}"; do
  name="${pair%% *}"
  arn="${pair#* }"
  tag="$(provider_tag "${arn}")"
  [ "${tag}" = "update" ] ||
    { echo "FAIL: tag cdkd-integ-phase on ${name} after the update is '${tag}', expected 'update'" >&2; exit 1; }
  arn_after="$(provider_field "${name}" CapacityProviderArn)"
  [ "${arn_after}" = "${arn}" ] ||
    { echo "FAIL: ${name} ARN changed across the update ('${arn}' -> '${arn_after}')" >&2; exit 1; }
done
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
PROVIDER_ID_AFTER="$(read_state "s['resources']['Provider2281708E']['physicalId']")"
SPARE_ID_AFTER="$(read_state "s['resources']['SpareProvider8B33A338']['physicalId']")"
[ "${PROVIDER_ID_AFTER}" = "${PROVIDER_NAME}" ] && [ "${SPARE_ID_AFTER}" = "${SPARE_REWIRED}" ] ||
  { echo "FAIL: a provider's state physical id changed across the update (provider='${PROVIDER_ID_AFTER}' spare='${SPARE_ID_AFTER}')" >&2; exit 1; }
echo "    tags reached AWS; both providers updated in place, ${SPARE_REWIRED} under its own name"

CDKD_TEST_UPDATE=true assert_clean_diff "after the update"
echo "    diff under the update mode reports no changes"

# --- Phase 4: destroy -------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "capacity provider ${PROVIDER_NAME} still exists after destroy" \
  aws lambda get-capacity-provider --capacity-provider-name "${PROVIDER_NAME}" --region "${REGION}"
assert_gone "capacity provider ${SPARE_REWIRED} still exists after destroy" \
  aws lambda get-capacity-provider --capacity-provider-name "${SPARE_REWIRED}" --region "${REGION}"
assert_gone "capacity provider ${SPARE_GENERATED} still exists after destroy" \
  aws lambda get-capacity-provider --capacity-provider-name "${SPARE_GENERATED}" --region "${REGION}"
assert_gone "function ${FUNCTION_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
INSTANCES_LEFT="$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text | wc -w)"
[ "${INSTANCES_LEFT}" = "0" ] ||
  { echo "FAIL: ${INSTANCES_LEFT} instance(s) still in ${VPC_ID} after destroy" >&2; exit 1; }
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"

cleanup
trap - EXIT INT TERM
echo "[verify] PASS — unnamed providers deployed under generated names, a provider under another name updated in place, diff clean, destroy left nothing"
