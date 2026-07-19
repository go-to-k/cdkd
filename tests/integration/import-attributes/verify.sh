#!/usr/bin/env bash
# verify.sh — cdkd import attribute-persistence integ (issue #1098 / PR #1099).
#
# WHAT THIS PROVES
#
# `cdkd import` builds each adopted resource's state row in `buildStackState`
# (src/cli/commands/import.ts). Pre-fix that function hardcoded
# `attributes: {}`, so the attribute map a provider's `import()` returned was
# computed and then thrown away. `attributes` is what backs `Fn::GetAtt`
# resolution against state, so an adopted resource started with an empty map
# while the same resource created by `cdkd deploy` had it populated.
#
# The probe resource is an `AWS::IAM::ManagedPolicy`.
# `IAMManagedPolicyProvider.import()` returns
# `{ physicalId: <arn>, attributes: { PolicyArn: <arn> } }` on the
# explicit-ARN branch — a NON-EMPTY map. That makes step 6's assertion a
# direct discriminator: it PASSES only against fixed cdkd and FAILS against
# pre-fix cdkd, where `attributes` is `{}` and `PolicyArn` is absent.
# (`import-nested-stack`, the other import fixture, cannot cover this: its
# only leaf type is `AWS::SSM::Parameter`, whose `import()` returns
# `attributes: {}`, so it passes identically either way.)
#
# Phases:
#   1. `cdkd deploy` the stack (creates the managed policy on AWS).
#   2. Capture the policy ARN and confirm it exists on AWS.
#   3. `cdkd state orphan` — drops the cdkd state record WITHOUT deleting the
#      AWS resource, leaving a live-but-unmanaged policy to re-adopt.
#   4. `cdkd import --resource Policy=<arn> --yes` — re-adopts it. The ARN
#      override lands in `input.knownPhysicalId`, which
#      `resolveExplicitPhysicalId` returns first, so the provider takes the
#      `explicit.startsWith('arn:')` branch (GetPolicy verify -> populated
#      attributes).
#   5. Assert the state row exists with the right physical id.
#   6. THE KEY ASSERTION: `attributes` is non-empty AND
#      `attributes.PolicyArn` equals the policy ARN.
#   7. `cdkd destroy --force`, then assert the policy is really gone from AWS
#      and the state file is cleared.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).
#
# NOTE on AWS_PROFILE: this script deliberately never assigns AWS_PROFILE.
# Under an `env -i` wrapper `AWS_PROFILE="${AWS_PROFILE:-}"` expands to the
# empty string, which the AWS CLI rejects outright; the caller's profile is
# inherited as-is instead.

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdImportAttributesExample"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
POLICY_NAME="cdkd-import-attributes-example-policy"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CLI="node ${LOCAL_DIST}"

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi

# Establish that the state bucket exists BEFORE any state probe runs. This is
# load-bearing, not defensive: `head-object` reports a missing bucket and a
# missing key identically (`An error occurred (404) ... Not Found`), so
# without this the post-destroy "state file is gone" assertion would pass
# trivially against a typo'd or not-yet-bootstrapped bucket. Checking once
# here lets state_object_state() treat a 404 as a genuinely absent key.
#
# This deliberately aborts the run on an account that has never been
# bootstrapped, rather than proceeding to a deploy that would fail later with
# a murkier error.
if ! bucket_err="$(aws s3api head-bucket --bucket "${STATE_BUCKET}" 2>&1 >/dev/null)"; then
  echo "FAIL: state bucket '${STATE_BUCKET}' is not reachable: ${bucket_err}" >&2
  echo "      (run \`cdkd bootstrap\` first, or check STATE_BUCKET / credentials)" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "==> region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"
echo "==> policy-arn=${POLICY_ARN}"

# ---------------------------------------------------------------------------
# Probe helper.
#
# Prints "present" or "absent" on stdout and returns 0 for either; returns 2
# (UNDETERMINED) for any other failure. A bare
# `if aws iam get-policy ... >/dev/null 2>&1` would read a throttle, an
# expired credential, or a network blip as "the resource is gone" and let a
# leak pass the post-destroy assertion — so an error is only accepted as
# proof of deletion when it actually carries a not-found signal.
# ---------------------------------------------------------------------------
policy_state() {
  local err
  # `2>&1 >/dev/null` captures stderr only (stderr is redirected to the
  # command substitution first, then stdout is discarded).
  if err="$(aws iam get-policy --policy-arn "${POLICY_ARN}" 2>&1 >/dev/null)"; then
    echo present
    return 0
  fi
  case "${err}" in
    *NoSuchEntity*|*NotFound*|*"does not exist"*|*404*)
      echo absent
      return 0
      ;;
  esac
  echo "UNDETERMINED: aws iam get-policy failed without a not-found signal: ${err}" >&2
  return 2
}

# Same tri-state contract for the cdkd state object. Used for both the
# "state was dropped" (orphan) and "state was cleared" (destroy) assertions,
# where a bare `if aws s3api head-object ... 2>/dev/null` would let an S3
# throttle or a permissions error masquerade as a successful deletion.
#
# `head-object` cannot distinguish "key missing" from "BUCKET missing" — S3
# renders both as `An error occurred (404) ... Not Found`, with no
# NoSuchBucket token to match on. So the bucket's existence is established
# ONCE up front (see the STATE_BUCKET precheck below) and this helper may
# then read a 404 as a genuinely absent key.
state_object_state() {
  local key="$1" err
  if err="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" 2>&1 >/dev/null)"; then
    echo present
    return 0
  fi
  case "${err}" in
    *404*|*"Not Found"*|*NoSuchKey*)
      echo absent
      return 0
      ;;
  esac
  echo "UNDETERMINED: aws s3api head-object ${key} failed without a not-found signal: ${err}" >&2
  return 2
}

# ---------------------------------------------------------------------------
# Cleanup.
#
# Must reach the AWS resource on EVERY failure path, including the window
# opened by step 3 where the policy is live on AWS but no longer in cdkd
# state (so `cdkd state destroy` cannot see it). Hence the unconditional
# raw `aws iam delete-policy` after the best-effort state teardown. Nothing
# is ever attached to this policy, so no detach pass is needed.
# ---------------------------------------------------------------------------
CLEANED=0
cleanup() {
  # `[ ... ] && return 0` would abort the whole script under `set -e` on the
  # not-yet-cleaned path, so guard with an explicit `if`.
  if [ "${CLEANED}" -eq 1 ]; then return 0; fi
  CLEANED=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    ${CLI} state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
  fi
  # Unconditional: covers the orphaned window and any state-teardown failure.
  aws iam delete-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1
  set -eu
  return 0
}

# ---------------------------------------------------------------------------
echo "==> Pre-flight: assert no leftovers from an earlier run"
#
# Deliberately runs BEFORE the cleanup traps are installed: if a leftover from
# an earlier run is found we bail so a human can look at it, rather than
# having the EXIT trap silently delete a resource this run never created.
# ---------------------------------------------------------------------------
PRE_POLICY="$(policy_state)"
if [ "${PRE_POLICY}" != "absent" ]; then
  echo "FAIL: ${POLICY_ARN} already exists on AWS — clean up before running" >&2
  exit 1
fi
PRE_STATE="$(state_object_state "${STATE_KEY}")"
if [ "${PRE_STATE}" != "absent" ]; then
  echo "FAIL: cdkd state ${STATE_KEY} already exists — clean up before running" >&2
  exit 1
fi
echo "==> Pre-flight ok"

# A bash signal handler RETURNS to the interrupted point, so a bare
# `trap cleanup INT` would let an interrupted run resume where it left off and
# exit 0 reporting PASS. Each signal handler therefore exits explicitly with
# the conventional 128+signo code.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
echo "==> Phase 1: cdkd deploy ${STACK}"
# ---------------------------------------------------------------------------
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose
echo "==> Phase 1 ok: deploy exited 0"

# ---------------------------------------------------------------------------
echo "==> Phase 2: capture + confirm the policy on AWS"
# ---------------------------------------------------------------------------
POST_DEPLOY="$(policy_state)"
if [ "${POST_DEPLOY}" != "present" ]; then
  echo "FAIL: ${POLICY_ARN} not found on AWS after deploy (probe said ${POST_DEPLOY})" >&2
  exit 1
fi
# Cross-check the ARN cdkd recorded against the one derived from the pinned
# policy name, so a naming-scheme change surfaces here rather than as a
# confusing import failure later.
DEPLOYED_ARN="$(aws iam get-policy --policy-arn "${POLICY_ARN}" --query 'Policy.Arn' --output text)"
if [ "${DEPLOYED_ARN}" != "${POLICY_ARN}" ]; then
  echo "FAIL: AWS reports policy ARN '${DEPLOYED_ARN}', expected '${POLICY_ARN}'" >&2
  exit 1
fi
echo "==> Phase 2 ok: policy present at ${POLICY_ARN}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: cdkd state orphan ${STACK} (drop state, keep the AWS resource)"
# ---------------------------------------------------------------------------
${CLI} state orphan "${STACK}" --state-bucket "${STATE_BUCKET}" --yes
ORPHANED_STATE="$(state_object_state "${STATE_KEY}")"
if [ "${ORPHANED_STATE}" != "absent" ]; then
  echo "FAIL: state ${STATE_KEY} still present after orphan (probe said ${ORPHANED_STATE})" >&2
  exit 1
fi
ORPHANED="$(policy_state)"
if [ "${ORPHANED}" != "present" ]; then
  echo "FAIL: orphan deleted the AWS policy (probe said ${ORPHANED}) — it must only drop state" >&2
  exit 1
fi
echo "==> Phase 3 ok: state gone, policy still live on AWS"

# ---------------------------------------------------------------------------
echo "==> Phase 4: cdkd import ${STACK} --resource Policy=${POLICY_ARN}"
# ---------------------------------------------------------------------------
${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --resource "Policy=${POLICY_ARN}" \
  --yes \
  --verbose
echo "==> Phase 4 ok: import exited 0"

# ---------------------------------------------------------------------------
echo "==> Phase 5: assert the imported state row"
# ---------------------------------------------------------------------------
STATE_JSON="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json)"
IMPORTED_PHYSICAL="$(printf '%s' "${STATE_JSON}" | python3 -c \
  'import sys, json; print(json.load(sys.stdin)["state"]["resources"]["Policy"]["physicalId"])')"
if [ "${IMPORTED_PHYSICAL}" != "${POLICY_ARN}" ]; then
  echo "FAIL: imported Policy.physicalId is '${IMPORTED_PHYSICAL}', expected '${POLICY_ARN}'" >&2
  exit 1
fi
echo "==> Phase 5 ok: Policy.physicalId=${IMPORTED_PHYSICAL}"

# ---------------------------------------------------------------------------
echo "==> Phase 6: KEY ASSERTION — imported attributes are persisted"
#
# This is the entire point of the fixture. `IAMManagedPolicyProvider.import()`
# returns `attributes: { PolicyArn: <arn> }`. Pre-fix, `buildStackState`
# hardcoded `attributes: {}` and dropped it, so BOTH checks below fail against
# a pre-fix binary: the map is empty, and `PolicyArn` is absent. Post-fix,
# `rowAttributes ?? priorAttributes ?? {}` threads the provider's map into the
# state row.
# ---------------------------------------------------------------------------
ATTR_COUNT="$(printf '%s' "${STATE_JSON}" | python3 -c \
  'import sys, json; print(len(json.load(sys.stdin)["state"]["resources"]["Policy"].get("attributes") or {}))')"
if [ "${ATTR_COUNT}" -eq 0 ]; then
  echo "FAIL: imported Policy.attributes is EMPTY — provider-returned attributes were dropped (issue #1098 regression)" >&2
  exit 1
fi
ATTR_POLICY_ARN="$(printf '%s' "${STATE_JSON}" | python3 -c \
  'import sys, json; print((json.load(sys.stdin)["state"]["resources"]["Policy"].get("attributes") or {}).get("PolicyArn", ""))')"
if [ "${ATTR_POLICY_ARN}" != "${POLICY_ARN}" ]; then
  echo "FAIL: imported Policy.attributes.PolicyArn is '${ATTR_POLICY_ARN}', expected '${POLICY_ARN}'" >&2
  exit 1
fi
echo "==> Phase 6 ok: attributes has ${ATTR_COUNT} key(s), PolicyArn=${ATTR_POLICY_ARN}"

# ---------------------------------------------------------------------------
echo "==> Phase 7: cdkd destroy ${STACK} --force"
# ---------------------------------------------------------------------------
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
echo "==> Phase 7 ok: destroy exited 0"

POST_DESTROY="$(policy_state)"
if [ "${POST_DESTROY}" != "absent" ]; then
  echo "FAIL: ${POLICY_ARN} still exists after destroy (probe said ${POST_DESTROY})" >&2
  exit 1
fi
FINAL_STATE="$(state_object_state "${STATE_KEY}")"
if [ "${FINAL_STATE}" != "absent" ]; then
  echo "FAIL: cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY} (probe said ${FINAL_STATE})" >&2
  exit 1
fi
echo "==> Phase 7 ok: policy gone from AWS, state file cleared"

trap - EXIT INT TERM
echo "==> PASS"
