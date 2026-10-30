#!/usr/bin/env bash
# verify.sh — cdkd AWS::DLM::LifecyclePolicy SDK provider integ (issue #1040).
#
# This fixture proves the SDK provider end to end.
#
# Phases:
#   1. Deploy a minimal EBS-snapshot lifecycle policy (+ its DLM execution
#      role). Assert via `aws dlm get-lifecycle-policy` that the policy is
#      ENABLED with the baseline description and carries the templated tags,
#      and that state routes it via the SDK provider (provisionedBy=sdk).
#   1b. Assert `cdkd drift` reports ZERO drift on the freshly-deployed policy
#      (exit 0). GetLifecyclePolicy returns PolicyDetails with server-injected
#      defaults (e.g. PolicyLanguage: SIMPLIFIED) the template never set; the
#      provider's readCurrentState + getDriftUnknownPaths must exclude those so
#      they never surface as phantom drift (issue #1067). This is the whole
#      point of the drift caveat — a no-op deploy MUST be drift-free.
#   2. Re-deploy with CDKD_TEST_UPDATE=true: description change + State
#      ENABLED -> DISABLED (UpdateLifecyclePolicy), tag value change AND tag
#      removal (TagResource / UntagResource — the #981 regression class).
#      Assert the PolicyId is UNCHANGED (in-place update, no replacement),
#      the new description/state reached AWS, `env` is now `changed`, and
#      `dropme` is GONE.
#   2b. Re-deploy with CDKD_TEST_REMOVAL=true (issue #1160 dlm batch): the
#      DISABLED VOLUME default policy drops every UpdateLifecyclePolicy
#      shorthand field (CreateInterval / RetainInterval / CopyTags /
#      ExtendDeletion / CrossRegionCopyTargets / Exclusions). A real
#      CloudFormation A/B (issue #5004) showed CloudFormation KEEPS the live
#      value, so cdkd sends no reset. Assert AWS still holds the baseline
#      values (2 / 3 / true / true / 1 / true / 1) and the policy id is
#      unchanged. The same redeploy drops the standard policy's Description
#      (issue #5546, kept by CloudFormation too): assert AWS keeps it and the
#      deploy warns once per policy, naming each kept property, and never
#      prints the shared "CloudFormation would reset it" line for either.
#   3. Destroy + assert the policies are gone from AWS and the cdkd state
#      file is removed.
#
# The policy targets a tag no volume carries, so it never creates snapshots.
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
    if [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --stack-region "${REGION}" --yes >/dev/null 2>&1
    fi
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

# Two AWS::DLM::LifecyclePolicy resources exist (standard + default), so
# resolve ids deterministically from the stack outputs instead of the first
# matching resourceType.
policy_id_from_state() { # usage: policy_id_from_state <OutputName>
  local output_name="$1"
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.state.outputs&&j.state.outputs[process.argv[1]])||"")})' "${output_name}"
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy baseline lifecycle policy (ENABLED, 3 tags)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_ID_P1="$(policy_id_from_state PolicyId)"
if [ -z "${POLICY_ID_P1}" ]; then
  echo "FAIL: no PolicyId output in cdkd state after Phase 1" >&2
  exit 1
fi
echo "    policy id: ${POLICY_ID_P1}"

DEFAULT_POLICY_ID_P1="$(policy_id_from_state DefaultPolicyId)"
if [ -z "${DEFAULT_POLICY_ID_P1}" ]; then
  echo "FAIL: no DefaultPolicyId output in cdkd state after Phase 1" >&2
  exit 1
fi
echo "    default policy id: ${DEFAULT_POLICY_ID_P1}"

# Baseline: the shorthand fields must have reached AWS at their non-default
# values (proves the removal assertion below actually flips something).
DP_DETAILS_P1="$(aws dlm get-lifecycle-policy --policy-id "${DEFAULT_POLICY_ID_P1}" \
  --region "${REGION}" --query 'Policy.PolicyDetails' --output json)"
DP_BASE_SUMMARY="$(echo "${DP_DETAILS_P1}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write([d.CreateInterval,d.RetainInterval,d.CopyTags,d.ExtendDeletion,(d.CrossRegionCopyTargets||[]).length,(d.Exclusions&&d.Exclusions.ExcludeBootVolumes)||false,((d.Exclusions&&d.Exclusions.ExcludeTags)||[]).length].join("/"))})')"
if [ "${DP_BASE_SUMMARY}" != "2/3/true/true/1/true/1" ]; then
  echo "FAIL: default policy baseline shorthand fields did not reach AWS (CreateInterval/RetainInterval/CopyTags/ExtendDeletion/#CrossRegionCopyTargets/ExcludeBootVolumes/#ExcludeTags = ${DP_BASE_SUMMARY}, expected 2/3/true/true/1/true/1)" >&2
  echo "${DP_DETAILS_P1}"
  exit 1
fi
echo "    default policy baseline carries all shorthand fields at non-default values"

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

# --- Phase 1b: zero-drift assertion (server-default guard, issue #1067) --
echo "==> Phase 1b: assert cdkd drift reports NO drift on the freshly-deployed policy"
# `cdkd drift` exits 0 when in sync, 1 when drift is detected. GetLifecyclePolicy
# returns PolicyDetails with server-injected defaults (e.g. PolicyLanguage:
# SIMPLIFIED, PolicyType/ResourceTypes/per-schedule defaults) that the template
# never set. The provider's readCurrentState surfaces only
# Description/State/ExecutionRoleArn/Tags and lists PolicyDetails + the
# default-policy shorthand fields in getDriftUnknownPaths, so those server
# defaults must NOT register as phantom drift. A freshly-deployed, unmodified
# policy MUST be drift-free — that is the whole point of issue #1067.
if node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"; then
  echo "    cdkd drift reports zero drift (server-injected PolicyDetails defaults handled)"
else
  echo "FAIL: cdkd drift reported drift on a freshly-deployed DLM policy (expected none) — server-injected PolicyDetails defaults are leaking as phantom drift" >&2
  exit 1
fi

# --- Phase 2: in-place update (state/description/tags) ------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (DISABLED, tag change + removal)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_ID_P2="$(policy_id_from_state PolicyId)"
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

# --- Phase 2b: shorthand-field removal (issue #1160 dlm batch) -----------
echo "==> Phase 2b: re-deploy with CDKD_TEST_REMOVAL=true (all shorthand fields + Description dropped)"
P2B_LOG="$(mktemp)"
if ! CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${P2B_LOG}" 2>&1; then
  cat "${P2B_LOG}"
  rm -f "${P2B_LOG}"
  echo "FAIL: Phase 2b removal redeploy failed" >&2
  exit 1
fi
P2B_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${P2B_LOG}")"
rm -f "${P2B_LOG}"
printf '%s\n' "${P2B_PLAIN}" | sed 's/^/  /'

# issue #5546: one warning per policy naming what it kept, as CloudFormation
# keeps it. The sentinel separates "no warning" from "the wording drifted".
P2B_POLICY_NEEDLE="Policy (AWS::DLM::LifecyclePolicy): property Description was removed from the template and keeps its current AWS value, as CloudFormation leaves it;"
P2B_DEFAULT_NEEDLE="DefaultPolicy (AWS::DLM::LifecyclePolicy): properties CreateInterval, RetainInterval, CopyTags, ExtendDeletion, CrossRegionCopyTargets, Exclusions were removed from the template and keep their current AWS value, as CloudFormation leaves them;"
P2B_SENTINEL="UpdateLifecyclePolicy keeps a field it is not sent"
for needle in "${P2B_POLICY_NEEDLE}" "${P2B_DEFAULT_NEEDLE}"; do
  hits="$(grep -cF "${needle}" <<<"${P2B_PLAIN}" || true)"
  if [ "${hits}" -gt 1 ]; then
    echo "FAIL [phase 2b]: the kept-removal warning printed ${hits} times, expected once: '${needle}'" >&2
    exit 1
  fi
  if [ "${hits}" -ne 1 ]; then
    if grep -qF "${P2B_SENTINEL}" <<<"${P2B_PLAIN}"; then
      echo "FAIL [phase 2b]: a kept-removal warning fired but no longer reads '${needle}' -- the wording drifted; update this fixture" >&2
    else
      echo "FAIL [phase 2b]: a removal was dropped silently (issue #5546): no warning reading '${needle}'" >&2
    fi
    exit 1
  fi
done
# The shared caller's line claims a CloudFormation reset, which CloudFormation
# does not do for these properties, so it must not name either policy. Two
# separate greps, not `grep | grep -q`: under pipefail the early exit of
# `grep -q` can fail the first grep with SIGPIPE and hide a hit.
P2B_DLM_LINES="$(grep -F "(AWS::DLM::LifecyclePolicy)" <<<"${P2B_PLAIN}" || true)"
if grep -qF "CloudFormation would reset it to its default" <<<"${P2B_DLM_LINES}"; then
  echo "FAIL [phase 2b]: the shared removal warning claimed a CloudFormation reset for a DLM policy (issue #5546)" >&2
  exit 1
fi
echo "    deploy warned about each policy's kept removals (issue #5546)"

DESC_P2B="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" \
  --query 'Policy.Description' --output text)"
if [ "${DESC_P2B}" != "cdkd integ policy updated" ]; then
  echo "FAIL [phase 2b]: removing Description did not keep the live value (got '${DESC_P2B}', expected 'cdkd integ policy updated' -- CloudFormation keeps it, issue #5546)" >&2
  exit 1
fi
# The companion change proves UpdateLifecyclePolicy really ran on this deploy.
COUNT_P2B="$(aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}" \
  --query 'Policy.PolicyDetails.Schedules[0].RetainRule.Count' --output text)"
if [ "${COUNT_P2B}" != "2" ]; then
  echo "FAIL [phase 2b]: the companion RetainRule.Count change did not reach AWS (got '${COUNT_P2B}', expected 2), so the Description check proves nothing" >&2
  exit 1
fi
echo "    removed Description kept at its live value beside an applied RetainRule change (CloudFormation parity, issue #5546)"

DEFAULT_POLICY_ID_P2B="$(policy_id_from_state DefaultPolicyId)"
if [ "${DEFAULT_POLICY_ID_P1}" != "${DEFAULT_POLICY_ID_P2B}" ]; then
  echo "FAIL: default policy was REPLACED (${DEFAULT_POLICY_ID_P1} -> ${DEFAULT_POLICY_ID_P2B})" >&2
  exit 1
fi
echo "    default policy identity preserved (${DEFAULT_POLICY_ID_P2B}) — in-place update"

# CloudFormation keeps the live value of a removed shorthand field (issue
# #5004), so the baseline summary asserted in Phase 1 must still hold.
DP_DETAILS_P2B="$(aws dlm get-lifecycle-policy --policy-id "${DEFAULT_POLICY_ID_P2B}" \
  --region "${REGION}" --query 'Policy.PolicyDetails' --output json)"
DP_REMOVAL_SUMMARY="$(echo "${DP_DETAILS_P2B}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write([d.CreateInterval,d.RetainInterval,d.CopyTags,d.ExtendDeletion,(d.CrossRegionCopyTargets||[]).length,(d.Exclusions&&d.Exclusions.ExcludeBootVolumes)||false,((d.Exclusions&&d.Exclusions.ExcludeTags)||[]).length].join("/"))})')"
if [ "${DP_REMOVAL_SUMMARY}" != "${DP_BASE_SUMMARY}" ]; then
  echo "FAIL: shorthand-field removal did NOT retain the live values (CreateInterval/RetainInterval/CopyTags/ExtendDeletion/#CrossRegionCopyTargets/ExcludeBootVolumes/#ExcludeTags = ${DP_REMOVAL_SUMMARY}, expected the baseline ${DP_BASE_SUMMARY} — CloudFormation keeps them, issue #5004)" >&2
  echo "${DP_DETAILS_P2B}"
  exit 1
fi
echo "    removal retained all shorthand fields at their live values (CloudFormation parity, issue #5004)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "lifecycle policy ${POLICY_ID_P2} still exists after destroy" aws dlm get-lifecycle-policy --policy-id "${POLICY_ID_P2}" --region "${REGION}"
echo "    lifecycle policy deleted"

assert_gone "default lifecycle policy ${DEFAULT_POLICY_ID_P1} still exists after destroy" aws dlm get-lifecycle-policy --policy-id "${DEFAULT_POLICY_ID_P1}" --region "${REGION}"
echo "    default lifecycle policy deleted"

assert_gone "IAM role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
echo "    execution role deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::DLM::LifecyclePolicy SDK provider: deploy + in-place update (incl. tag removal) + shorthand-field removal retained (#5004) + Description removal kept and warned (#5546) + destroy all passed"
