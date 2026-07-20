#!/usr/bin/env bash
# verify.sh — UPDATE-time policy / DependsOn mutation integ test.
#
# Surfaces bugs in cdkd's update-diff edge cases (these are likely
# under-tested). Two deploys are driven by a CDK context flip
# (`-c phase=a` then `-c phase=b`). Verifies end-to-end:
#
#   Case 1 — UpdateReplacePolicy: Retain orphan-on-replace
#     phase-b changes RetainReplaceBucket's BucketName (a replacement
#     trigger). Because UpdateReplacePolicy is Retain, the OLD bucket
#     must SURVIVE on AWS while the NEW one is created. Assert both
#     physical ids exist after phase-b.
#
#   Case 2 — DeletionPolicy flip on update
#     PolicyFlipParam flips DESTROY (a) -> RETAIN (b). The FINAL destroy
#     runs under phase-b state, so the parameter must SURVIVE destroy.
#
#   Case 3 — DependsOn add / remove on update
#     phase-b ADDS a DependsOn (DependsOnAddB -> DependsOnAddA) and
#     REMOVES one (DependsOnRemoveB -> DependsOnRemoveA). The update must
#     succeed and both topics keep their physical ids (ARNs).
#
#   Case 4 — metadata-only / no-op update
#     A third deploy re-running phase-a (identical template) must report
#     "No changes detected" — cdkd must not spuriously update / replace.
#
# This test INTENTIONALLY creates orphans (the Retain-replaced old
# bucket + the phase-b Retain SSM parameter survive by design). The
# trap deletes EVERY captured physical id so the test leaves AWS clean.
#
# Run via: /run-integ update-policy-mutations
#         or: bash tests/integration/update-policy-mutations/verify.sh
#
# BSD-portable (macOS): no `grep -P`, no `date -d`. Real exit code is
# captured and the explicit PASS line is required for success.

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="CdkdUpdatePolicyMutationsExample"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"

POLICY_FLIP_PARAM="/cdkd-integ/update-policy-mutations/policy-flip"
STABLE_PARAM="/cdkd-integ/update-policy-mutations/stable"
# Deterministic bucket names (must match the stack's name derivation).
BUCKET_A="cdkd-updpolicy-${ACCOUNT_ID}-${AWS_REGION}-phase-a"
BUCKET_B="cdkd-updpolicy-${ACCOUNT_ID}-${AWS_REGION}-phase-b"

# Physical ids captured during the run, deleted in the trap regardless
# of where the run aborts. Bucket names are deterministic above; we
# still try to delete both phases unconditionally.
delete_bucket() {
  local b="$1"
  # Empty (best effort) then delete. Tolerate AccessDenied / NoSuchBucket.
  aws s3 rb "s3://${b}" --force --region "${AWS_REGION}" >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  # 1. Destroy any leftover cdkd-managed state (so re-runs work). This
  #    deletes the DESTROY-policy resources still in state; Retain ones
  #    survive and are handled below by direct delete.
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  # 2. Delete the intentional orphans + every resource this test creates,
  #    by captured / deterministic physical id. This test makes orphans
  #    on purpose (Retain bucket + Retain param), so clean ALL of them.
  delete_bucket "${BUCKET_A}"
  delete_bucket "${BUCKET_B}"
  aws ssm delete-parameter --region "${AWS_REGION}" --name "${POLICY_FLIP_PARAM}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --region "${AWS_REGION}" --name "${STABLE_PARAM}" >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# --- helpers (BSD-portable) ------------------------------------------
# All strict (issue #1097 pattern 2), routed through gone_probe: rc 0 =
# exists, rc 1 = confirmed not-found; any other probe failure (throttle,
# auth) hard-FAILs the run instead of reading as "gone".
bucket_exists() {
  # head-bucket answers 404 for a missing bucket (matches the canonical
  # signature); 403/AccessDenied on someone ELSE's bucket is undetermined
  # and hard-FAILs -- these buckets are account-owned, so that is correct.
  ! gone_probe aws s3api head-bucket --bucket "$1" --region "${AWS_REGION}"
}
ssm_exists() {
  ! gone_probe aws ssm get-parameter --region "${AWS_REGION}" --name "$1"
}
sns_exists() {
  ! gone_probe aws sns get-topic-attributes --region "${AWS_REGION}" --topic-arn "$1"
}

fail() {
  echo "FAIL: $*"
  exit 1
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo ""
echo "==> Pre-flight: stale state / resource check"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && {
  fail "stack state already exists at ${STATE_KEY} — clean up first."
}
for b in "${BUCKET_A}" "${BUCKET_B}"; do
  if bucket_exists "${b}"; then fail "${b} already exists — clean up first."; fi
done
for p in "${POLICY_FLIP_PARAM}" "${STABLE_PARAM}"; do
  if ssm_exists "${p}"; then fail "${p} already exists in SSM — clean up first."; fi
done
echo "    no stale state or resources (✓)"

# =====================================================================
echo ""
echo "==> Step 1: Deploy phase a"
${CDKD} deploy ${STACK} -c phase=a --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Step 1a: Capture phase-a physical ids + assert they exist"
if ! bucket_exists "${BUCKET_A}"; then fail "phase-a bucket ${BUCKET_A} not created"; fi
if ! ssm_exists "${POLICY_FLIP_PARAM}"; then fail "PolicyFlipParam not created in phase a"; fi
if ! ssm_exists "${STABLE_PARAM}"; then fail "StableParam not created in phase a"; fi
DEPENDS_ADD_B_ARN=$(${CDKD} state show ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const r=(j.state||j).resources||{};const k=Object.keys(r).find(x=>x.startsWith("DependsOnAddB"));process.stdout.write(k?(r[k].attributes&&(r[k].attributes.Arn||r[k].attributes.TopicArn)||r[k].physicalId||""):"")}catch(e){process.stdout.write("")}})')
DEPENDS_REMOVE_B_ARN=$(${CDKD} state show ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const r=(j.state||j).resources||{};const k=Object.keys(r).find(x=>x.startsWith("DependsOnRemoveB"));process.stdout.write(k?(r[k].attributes&&(r[k].attributes.Arn||r[k].attributes.TopicArn)||r[k].physicalId||""):"")}catch(e){process.stdout.write("")}})')
if [[ -z "${DEPENDS_ADD_B_ARN}" ]]; then fail "could not capture DependsOnAddB ARN from cdkd state"; fi
if [[ -z "${DEPENDS_REMOVE_B_ARN}" ]]; then fail "could not capture DependsOnRemoveB ARN from cdkd state"; fi
echo "    phase-a bucket + 2 SSM params present; SNS ARNs captured (✓)"
echo "      DependsOnAddB    = ${DEPENDS_ADD_B_ARN}"
echo "      DependsOnRemoveB = ${DEPENDS_REMOVE_B_ARN}"

# =====================================================================
echo ""
echo "==> Step 2: Deploy phase b (forces Retain-replace + DeletionPolicy flip + DependsOn add/remove)"
${CDKD} deploy ${STACK} -c phase=b --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Step 2a: Case 1 — UpdateReplacePolicy: Retain orphan-on-replace"
# The NEW (phase-b) bucket must exist.
if ! bucket_exists "${BUCKET_B}"; then
  fail "phase-b replacement bucket ${BUCKET_B} was not created (replacement did not run / new name not provisioned)"
fi
# The OLD (phase-a) bucket must STILL EXIST (UpdateReplacePolicy: Retain).
if ! bucket_exists "${BUCKET_A}"; then
  fail "OLD bucket ${BUCKET_A} was DELETED on replace despite UpdateReplacePolicy: Retain (orphan-on-replace not honored)"
fi
echo "    new bucket exists AND old bucket retained on replace (✓)"

echo ""
echo "==> Step 2b: Case 3 — DependsOn add/remove update kept topics intact"
# Both SNS topics must keep their physical ids (ARNs) across the
# metadata-only DependsOn change.
if ! sns_exists "${DEPENDS_ADD_B_ARN}"; then
  fail "DependsOnAddB (${DEPENDS_ADD_B_ARN}) lost/replaced after DependsOn ADD update"
fi
if ! sns_exists "${DEPENDS_REMOVE_B_ARN}"; then
  fail "DependsOnRemoveB (${DEPENDS_REMOVE_B_ARN}) lost/replaced after DependsOn REMOVE update"
fi
# Re-read state and confirm the ARNs are unchanged (no replacement).
DEPENDS_ADD_B_ARN_AFTER=$(${CDKD} state show ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const r=(j.state||j).resources||{};const k=Object.keys(r).find(x=>x.startsWith("DependsOnAddB"));process.stdout.write(k?(r[k].attributes&&(r[k].attributes.Arn||r[k].attributes.TopicArn)||r[k].physicalId||""):"")}catch(e){process.stdout.write("")}})')
if [[ "${DEPENDS_ADD_B_ARN_AFTER}" != "${DEPENDS_ADD_B_ARN}" ]]; then
  fail "DependsOnAddB ARN changed across the DependsOn update (${DEPENDS_ADD_B_ARN} -> ${DEPENDS_ADD_B_ARN_AFTER}) — DependsOn change wrongly triggered replacement"
fi
echo "    both topics intact + ARNs stable across DependsOn add/remove (✓)"

# =====================================================================
echo ""
echo "==> Step 3: Case 4 — no-op / idempotent redeploy (phase b -> phase b, identical)"
NOOP_LOG=$(mktemp)
set +e
${CDKD} deploy ${STACK} -c phase=b --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" > "${NOOP_LOG}" 2>&1
NOOP_RC=$?
set -e
cat "${NOOP_LOG}"
if [[ ${NOOP_RC} -ne 0 ]]; then
  rm -f "${NOOP_LOG}"
  fail "identical redeploy exited non-zero (${NOOP_RC})"
fi
if ! grep -q "No changes detected" "${NOOP_LOG}"; then
  rm -f "${NOOP_LOG}"
  fail "identical redeploy did NOT report 'No changes detected' — cdkd spuriously updated/replaced on a no-op"
fi
rm -f "${NOOP_LOG}"
echo "    no-op redeploy reported no changes (✓)"

# =====================================================================
echo ""
echo "==> Step 4: Final destroy — must honor CURRENT (phase-b) DeletionPolicy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Step 4a: Case 2 — DeletionPolicy flip: PolicyFlipParam must SURVIVE destroy (phase-b = Retain)"
if ! ssm_exists "${POLICY_FLIP_PARAM}"; then
  fail "PolicyFlipParam was DELETED by destroy despite phase-b DeletionPolicy: Retain"
fi
echo "    PolicyFlipParam survived destroy (✓) — current Retain policy honored"

echo ""
echo "==> Step 4b: StableParam (DESTROY policy) must be GONE after destroy"
if ssm_exists "${STABLE_PARAM}"; then
  fail "StableParam (DeletionPolicy: Delete) was NOT deleted by destroy"
fi
echo "    StableParam deleted (✓)"

echo ""
echo "==> Step 4c: The phase-b (current) bucket is Retain too -> must SURVIVE destroy"
if ! bucket_exists "${BUCKET_B}"; then
  fail "phase-b bucket ${BUCKET_B} was DELETED by destroy despite DeletionPolicy: Retain"
fi
echo "    phase-b bucket survived destroy (✓) — Retain honored on destroy"

echo ""
echo "==> Step 5: cdkd state cleared after destroy"
assert_gone "cdkd state still exists at ${STATE_KEY} after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state cleared (✓)"

# =====================================================================
echo ""
echo "==> Step 6: Clean up ALL intentional orphans by captured/deterministic id"
# Retained-on-replace old bucket, phase-b current bucket, Retain SSM
# param. (StableParam + state already gone; trap re-runs are idempotent.)
delete_bucket "${BUCKET_A}"
delete_bucket "${BUCKET_B}"
aws ssm delete-parameter --region "${AWS_REGION}" --name "${POLICY_FLIP_PARAM}" >/dev/null 2>&1 || true

echo ""
echo "==> Step 6a: Assert 0 leftover resources"
LEFTOVERS=""
if bucket_exists "${BUCKET_A}"; then LEFTOVERS="${LEFTOVERS} ${BUCKET_A}"; fi
if bucket_exists "${BUCKET_B}"; then LEFTOVERS="${LEFTOVERS} ${BUCKET_B}"; fi
if ssm_exists "${POLICY_FLIP_PARAM}"; then LEFTOVERS="${LEFTOVERS} ${POLICY_FLIP_PARAM}"; fi
if ssm_exists "${STABLE_PARAM}"; then LEFTOVERS="${LEFTOVERS} ${STABLE_PARAM}"; fi
if sns_exists "${DEPENDS_ADD_B_ARN}"; then LEFTOVERS="${LEFTOVERS} ${DEPENDS_ADD_B_ARN}"; fi
if sns_exists "${DEPENDS_REMOVE_B_ARN}"; then LEFTOVERS="${LEFTOVERS} ${DEPENDS_REMOVE_B_ARN}"; fi
if [[ -n "${LEFTOVERS}" ]]; then
  fail "leftover AWS resources remain after cleanup:${LEFTOVERS}"
fi
echo "    0 leftover resources (✓)"

echo ""
echo "==> All update-policy-mutations checks passed"
trap - EXIT INT TERM
