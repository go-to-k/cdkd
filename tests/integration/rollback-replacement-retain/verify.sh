#!/usr/bin/env bash
#
# End-to-end real-AWS validation for issue #2598 — on a replacement rollback,
# `UpdateReplacePolicy: Retain` governs the fate of the replacement's NEW
# physical copy, and `DeletionPolicy` does NOT.
#
# WHY THIS FIXTURE EXISTS
#
# Six `rollback-*` fixtures already exercise the replacement-rollback arms, and
# not one of them declares `UpdateReplacePolicy: Retain` on a REPLACED
# resource. So every one of them measures the DEFAULT (delete) polarity, and
# the retain branch that #2598 adds to `readoptDelete` / `deleteNewFirst` /
# `deleteNewAfterRecreate` has no real-AWS coverage at all: cdkd would delete a
# physical resource the user explicitly marked to survive, and only the unit
# suite would notice.
#
# GROUND TRUTH (live CloudFormation A/B, us-east-1, 2026-09-05 — a forced
# `AWS::SSM::Parameter` replacement plus a deterministically failing sibling,
# rolled back). `UpdateReplacePolicy` decides; `DeletionPolicy` is inert here:
#
#   | DeletionPolicy | UpdateReplacePolicy | new copy | decisive CFn event |
#   | -------------- | ------------------- | -------- | ------------------ |
#   | (none)         | (none)              | DELETED  | DELETE_COMPLETE    |
#   | Retain         | (none)              | DELETED  | DELETE_COMPLETE    |
#   | (none)         | Retain              | SURVIVED | DELETE_SKIPPED     |
#
# A retained new copy is ORPHANED OUT of the stack, not kept as a managed
# resource — the A/B proved it by deleting the whole stack afterwards and
# finding the retained parameter still alive. cdkd matches that: it leaves NO
# state record naming the survivor, and instead names it in the DURABLE
# `ROLLBACK_RESOURCE_SUCCEEDED` event (plus a warn for whoever is watching), so
# the user is not handed an invisible orphan.
#
# WHY THREE SUBJECTS, AND WHY EACH ONE
#
#   RetainParam         UpdateReplacePolicy: Retain, no DeletionPolicy.
#                       THE POLARITY UNDER TEST — its new copy must SURVIVE.
#   ControlParam        no policies at all. Its new copy must be DELETED.
#   DeletionPolicyParam DeletionPolicy: Retain, no UpdateReplacePolicy. Its new
#                       copy must be DELETED TOO.
#
# A retain-only fixture cannot tell "the retain branch works" from "cdkd never
# deletes anything on this path", so `ControlParam` is mandatory.
# `DeletionPolicyParam` is the sharper control: it is the A/B row that refutes
# "DeletionPolicy governs it", so an edit that re-pointed
# `rollbackRetainsNewResource` at `deletionPolicy` would still satisfy
# `ControlParam` and fails here.
#
# WHY `AWS::SSM::Parameter`
#
# `Name` is create-only, so flipping it forces a property-driven replacement;
# the type has an SDK provider; a parameter name is released the instant it is
# deleted, so the control arms' re-create of the OLD name is deterministic
# (unlike an SQS queue name, which rides a ~60s cooldown, or a globally unique
# bucket name); and parameters are free, so the deliberate `Retain` survivor
# costs nothing while it is alive.
#
# WHAT THIS ASSERTS
#   1. Deploy v1 succeeds; all three parameters are live and state records the
#      two policies on the two resources that declare them (if CDK ever stopped
#      emitting them, every later assertion would be vacuous).
#   2. Deploy v2 renames all three (create-only -> REPLACEMENT) with a failure
#      wired AFTER them, so every replacement COMPLETES and the rollback
#      classifies each as a replacement. The deploy exits NON-ZERO.
#   3. The deploy engine took the RETAIN arm for RetainParam (old copy
#      orphaned) and the rollback took the readopt arm.
#   4. THE POINT: the new copy `retain-v2` is STILL ALIVE in AWS after the
#      rollback, while `control-v2` and `deletion-policy-v2` are GONE.
#   5. cdkd's state names the OLD copy for every subject and names the retained
#      new copy NOWHERE.
#   6. THE DURABLE CHANNEL: the recorded `ROLLBACK_RESOURCE_SUCCEEDED` event
#      for the retained subject carries the survivor's `physicalId`, a `reason`
#      naming both ids, and the survivor's routing layer -- and the two control
#      subjects' rows carry NEITHER field. A rollback runs during an
#      already-failing deploy, usually non-TTY with the log truncated or
#      discarded, so the `logger.warn` phase 3 greps is the least likely thing
#      the user still has; `cdkd events` is what outlives the terminal, and
#      "alive in AWS + absent from state + named in the event" is the whole
#      contract. The control rows' ABSENCE is the inverse bug: an unconditional
#      `physicalId` would point a cleanup pass at a resource just deleted.
#   7. `cdkd destroy` removes the tracked copies and leaves the untracked
#      survivor standing (exactly what the warning promises), then the fixture
#      deletes the two deliberate survivors itself and asserts the whole
#      parameter path is empty. `Retain` means cdkd will not clean up after
#      this fixture; the fixture must.
#
# BSD/macOS-portable: no grep -P, no date -d. Integ-exit-code-capture pattern
# (bash ...; rc=$?) so a piped/teed harness can't mask a failure; the script
# prints an explicit "[verify] PASS" only at the very end.
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

# A pager invoked non-interactively is a route to a hang.
export AWS_PAGER=""

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdRollbackReplacementRetainExample"

# The parameter names. verify.sh owns them outright (the stack reads them from
# the env) so the template and the assertions cannot drift apart.
#
# FIXED, not per-run unique, and that is a decision: `PutParameter` runs with
# `Overwrite: false`, so a leftover from an aborted run would fail phase 1 with
# `ParameterAlreadyExists`. The pre-run sweep below deletes everything under
# PARAM_BASE first, which makes a fixed-name fixture self-healing where a
# per-run-id one would strand its leftovers under names no later run can find.
PARAM_BASE="/cdkd-integ/rollback-replacement-retain"
RETAIN_V1="${PARAM_BASE}/retain-v1"
RETAIN_V2="${PARAM_BASE}/retain-v2"
CONTROL_V1="${PARAM_BASE}/control-v1"
CONTROL_V2="${PARAM_BASE}/control-v2"
DP_V1="${PARAM_BASE}/deletion-policy-v1"
DP_V2="${PARAM_BASE}/deletion-policy-v2"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-replacement-retain"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"
CDKD="node ${LOCAL_DIST}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
# Honor the harness's exported STATE_BUCKET; only fall back to the account
# default. Overwriting it unconditionally would make every read below target a
# different bucket than the CLI writes to the moment the harness points
# somewhere else.
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

WORK_DIR="$(mktemp -d)"

cd "${TEST_DIR}"

# --------------------------------------------------------------------------
# sweep_params — delete EVERY parameter under this fixture's own path.
#
# Load-bearing rather than belt-and-braces: `UpdateReplacePolicy: Retain` means
# cdkd DELIBERATELY leaves `retain-v2` behind, and `DeletionPolicy: Retain`
# means `cdkd destroy` DELIBERATELY leaves `deletion-policy-v1` behind. Without
# this the fixture leaks two parameters on every single run, pass or fail.
#
# Best-effort by construction (`set +eu` in a SUBSHELL, so a caller that is
# itself running under `set +eu` can never have strict mode re-armed under it).
# The path is this fixture's alone, so the sweep cannot reach another lane's
# resources.
# --------------------------------------------------------------------------
sweep_params() { (
  set +eu
  names="$(aws ssm get-parameters-by-path --path "${PARAM_BASE}" --recursive \
    --query 'Parameters[].Name' --output text 2>/dev/null)"
  for n in ${names}; do
    [ -n "${n}" ] || continue
    [ "${n}" = "None" ] && continue
    echo "[verify] sweep: deleting parameter ${n}"
    aws ssm delete-parameter --name "${n}" >/dev/null 2>&1
  done
  # Load-bearing: a subshell exits with its LAST command's status, and the
  # last one here is a best-effort delete. Without this the pre-run call --
  # which runs under `set -e` -- aborts the whole run whenever the final
  # delete returns non-zero.
  true
) }

# --------------------------------------------------------------------------
# Cleanup. This fixture INTENTIONALLY creates a failed deploy AND two
# intentionally-retained parameters, so the trap must not leak either.
# --------------------------------------------------------------------------
cleanup() {
  rc=$?
  set +eu
  echo ""
  echo "[verify] cleanup (rc=${rc})..."

  # The state-driven destroy first, so the ordinary path does the ordinary
  # work; the path sweep below then catches everything state cannot reach (the
  # Retain survivors, and anything a failed phase orphaned).
  RETAIN_PARAM_NAME="${RETAIN_V1}" CONTROL_PARAM_NAME="${CONTROL_V1}" \
    DELETION_POLICY_PARAM_NAME="${DP_V1}" \
    ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --force >/dev/null 2>&1

  sweep_params

  # State + the rollback journal + the events sidecar this fixture's failed
  # run writes. Prefix-scoped, so it reaches all of them.
  aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/" --recursive >/dev/null 2>&1

  rm -rf "${WORK_DIR}"
  set -eu
  echo "[verify] cleanup done"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "[verify] region=${REGION} stack=${STACK} account=${ACCOUNT_ID}"
echo "[verify] installing fixture deps..."
npm install --silent >/dev/null 2>&1 || npm install >/dev/null

echo "[verify] pre-run sweep"
sweep_params

# --------------------------------------------------------------------------
# Phase 1 — deploy v1 (no failure injected).
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 1: deploy v1"
RETAIN_PARAM_NAME="${RETAIN_V1}" CONTROL_PARAM_NAME="${CONTROL_V1}" \
  DELETION_POLICY_PARAM_NAME="${DP_V1}" \
  ${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes

for p in "${RETAIN_V1}" "${CONTROL_V1}" "${DP_V1}"; do
  GOT="$(aws ssm get-parameter --name "${p}" --query 'Parameter.Name' --output text)"
  if [ "${GOT}" != "${p}" ]; then
    echo "FAIL: phase 1: get-parameter returned '${GOT}' for ${p}" >&2
    exit 1
  fi
done

aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state-v1.json" >/dev/null

# The template attributes must have REACHED STATE. Without this every later
# assertion is vacuous in the worst direction: a `RetainParam` whose
# `UpdateReplacePolicy` never made it into the record would take the ordinary
# delete arm, and the fixture would report a #2598 regression while the fix was
# working. Read by LOGICAL ID (the physical name is asserted separately) --
# both are checked so a swapped record cannot satisfy either.
V1_RETAIN_URP="$(jq -r '.resources.RetainParam.updateReplacePolicy // "ABSENT"' "${WORK_DIR}/state-v1.json")"
V1_RETAIN_DP="$(jq -r '.resources.RetainParam.deletionPolicy // "ABSENT"' "${WORK_DIR}/state-v1.json")"
V1_CONTROL_URP="$(jq -r '.resources.ControlParam.updateReplacePolicy // "ABSENT"' "${WORK_DIR}/state-v1.json")"
V1_CONTROL_DP="$(jq -r '.resources.ControlParam.deletionPolicy // "ABSENT"' "${WORK_DIR}/state-v1.json")"
V1_DP_URP="$(jq -r '.resources.DeletionPolicyParam.updateReplacePolicy // "ABSENT"' "${WORK_DIR}/state-v1.json")"
V1_DP_DP="$(jq -r '.resources.DeletionPolicyParam.deletionPolicy // "ABSENT"' "${WORK_DIR}/state-v1.json")"
if [ "${V1_RETAIN_URP}" != "Retain" ] || [ "${V1_RETAIN_DP}" != "ABSENT" ]; then
  echo "FAIL: phase 1: RetainParam must record UpdateReplacePolicy=Retain and NO" >&2
  echo "      DeletionPolicy, got urp='${V1_RETAIN_URP}' dp='${V1_RETAIN_DP}'." >&2
  echo "      A DeletionPolicy here would also make 'cdkd destroy' keep the" >&2
  echo "      re-adopted old copy, collapsing phase 7's discrimination." >&2
  exit 1
fi
if [ "${V1_CONTROL_URP}" != "ABSENT" ] || [ "${V1_CONTROL_DP}" != "ABSENT" ]; then
  echo "FAIL: phase 1: ControlParam must carry NO policy at all, got" >&2
  echo "      urp='${V1_CONTROL_URP}' dp='${V1_CONTROL_DP}'" >&2
  exit 1
fi
if [ "${V1_DP_URP}" != "ABSENT" ] || [ "${V1_DP_DP}" != "Retain" ]; then
  echo "FAIL: phase 1: DeletionPolicyParam must record DeletionPolicy=Retain and" >&2
  echo "      NO UpdateReplacePolicy, got urp='${V1_DP_URP}' dp='${V1_DP_DP}'." >&2
  echo "      Without exactly that split it stops being the control that refutes" >&2
  echo "      'DeletionPolicy governs the new copy'." >&2
  exit 1
fi

for pair in "RetainParam=${RETAIN_V1}" "ControlParam=${CONTROL_V1}" "DeletionPolicyParam=${DP_V1}"; do
  lid="${pair%%=*}"; want="${pair#*=}"
  got="$(jq -r --arg id "${lid}" '.resources[$id].physicalId // "ABSENT"' "${WORK_DIR}/state-v1.json")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: phase 1: state records ${lid} physicalId='${got}', expected '${want}'" >&2
    exit 1
  fi
done
echo "[verify] phase 1: OK (3 parameters live; Retain attributes recorded on the right two)"

# --------------------------------------------------------------------------
# Phase 2 — deploy v2: rename all three (replacement) + injected failure.
#
# `--force-stateful-recreation` is REQUIRED and is not incidental:
# `AWS::SSM::Parameter` is in `STATEFUL_TYPES`, so a property-driven
# replacement of ControlParam / DeletionPolicyParam is refused without explicit
# consent to the data loss. RetainParam needs no consent (a `Retain`
# UpdateReplacePolicy exempts the stateful guard because the old copy survives)
# and the flag changes nothing on its arm.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 2: deploy v2 (all three renamed, failure injected) -- expected to FAIL"
set +e
RETAIN_PARAM_NAME="${RETAIN_V2}" CONTROL_PARAM_NAME="${CONTROL_V2}" \
  DELETION_POLICY_PARAM_NAME="${DP_V2}" ROLLBACK_RETAIN_INTEG_FAIL=true \
  ${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --force-stateful-recreation --yes > "${WORK_DIR}/deploy-v2.log" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: phase 2: deploy was expected to fail but exited 0" >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
echo "[verify] phase 2: deploy failed as expected (rc=${DEPLOY_RC})"

# --------------------------------------------------------------------------
# Phase 3 — the run took the arms this fixture is about.
#
# Every grep below carries a SENTINEL: a second, independent marker that
# distinguishes "the condition did not occur" from "the wording drifted and
# this grep is now blind". A zero match on a log the fixture also produces is
# otherwise indistinguishable from a passing run of a broken parse.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 3: the deploy engine and the rollback took the expected arms"

# Sentinel for the deploy side: the create-first line every property-driven
# replacement prints, whatever the policy.
if ! grep -qF "Creating new RetainParam" "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: RetainParam was never REPLACED -- the create-first line is" >&2
  echo "      absent, so the run never reached the arm under test (or the deploy" >&2
  echo "      engine's wording drifted and this grep is blind)." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
if ! grep -qF "Retaining old RetainParam (${RETAIN_V1}) - UpdateReplacePolicy: Retain" \
  "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the replacement of RetainParam did NOT take the retain arm." >&2
  echo "      The old copy ${RETAIN_V1} was deleted instead of orphaned, so the" >&2
  echo "      rollback cannot classify reverse-replacement-readopt and the whole" >&2
  echo "      fixture would measure the wrong branch." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi

# Sentinel for the rollback side: the readopt arm's own completion line, which
# is emitted on BOTH polarities of the branch under test.
if ! grep -qF "Rollback: RetainParam restored to the retained old resource" \
  "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the rollback did not take the reverse-replacement-readopt" >&2
  echo "      arm for RetainParam, so this run does not exercise issue #2598." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
# ...and THE warning. The retained copy is untracked from here on, so the
# physical id in this line is the only thing standing between the user and an
# invisible orphan -- assert the ID, not just the phrase.
if ! grep -qF "(${RETAIN_V2}) is RETAINED by this rollback" "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the rollback never warned that ${RETAIN_V2} was retained." >&2
  echo "      The sentinel line above proves the readopt arm RAN, so this is" >&2
  echo "      either the issue #2598 regression (the arm deleted the new copy" >&2
  echo "      silently) or a reworded warning that no longer names the physical" >&2
  echo "      id -- and an unnamed survivor is an orphan the user cannot find." >&2
  grep -aiE 'rollback|retain' "${WORK_DIR}/deploy-v2.log" | tail -20 >&2
  exit 1
fi

# The controls must have taken the DELETE polarity of the same branch.
if ! grep -qF "Rollback: ControlParam replacement reversed (old resource re-created as ${CONTROL_V1})" \
  "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: ControlParam did not take the reverse-replacement arm" >&2
  echo "      (re-create the old copy, delete the new one)." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
if ! grep -qF "Rollback: DeletionPolicyParam replacement reversed (old resource re-created as ${DP_V1})" \
  "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: DeletionPolicyParam did not take the reverse-replacement arm." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
# The control-negatives below are only meaningful if this EXACT substring is
# one cdkd actually emits. Assert it POSITIVELY for the retain subject first:
# a reworded leading clause (a renamed type, a dropped " has ") would make the
# loop match nothing and pass vacuously, silently retiring the discriminator
# without failing anything.
if ! grep -qF "RetainParam (AWS::SSM::Parameter) has UpdateReplacePolicy: Retain" \
  "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the retain warning's exact phrasing was not found for" >&2
  echo "      RetainParam, so the control-negative loop below cannot" >&2
  echo "      discriminate -- it would pass against ANY output. Re-sync the" >&2
  echo "      substring with rollback-executor.ts's retainedSurvivorMessages()." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
# ...and neither control may claim the retention. A cdkd that warned this for
# every replacement would satisfy the positive grep above while retaining
# nothing in particular.
for lid in ControlParam DeletionPolicyParam; do
  if grep -qF "${lid} (AWS::SSM::Parameter) has UpdateReplacePolicy: Retain" \
    "${WORK_DIR}/deploy-v2.log"; then
    echo "FAIL: phase 3: ${lid} declares no UpdateReplacePolicy, yet the rollback" >&2
    echo "      announced it as retained -- the retention verdict is not reading" >&2
    echo "      the attribute it claims to read." >&2
    exit 1
  fi
done
echo "[verify] phase 3: OK (retain arm + retain warning + both control arms observed)"

# --------------------------------------------------------------------------
# Phase 4 — THE POINT: what is actually left standing in AWS.
#
# Probed against the SSM API by NAME, never inferred from cdkd's own output:
# the log says what cdkd believes, this says what AWS holds.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 4: post-rollback AWS state"

# Status-consuming capture (`out=$(...)`, then `$?`) rather than a bare strict
# capture: this is the assertion whose failure message matters most, and under
# `set -e` a bare capture would abort with a raw AWS error and no context.
set +e
RETAIN_V2_PROBE="$(aws ssm get-parameter --name "${RETAIN_V2}" --query 'Parameter.Name' --output text 2>&1)"
RETAIN_V2_RC=$?
set -e
if [ "${RETAIN_V2_RC}" -ne 0 ] || [ "${RETAIN_V2_PROBE}" != "${RETAIN_V2}" ]; then
  echo "FAIL: phase 4: issue #2598 REGRESSION -- the replacement's NEW physical" >&2
  echo "      resource ${RETAIN_V2} is GONE after the rollback." >&2
  echo "      It declares UpdateReplacePolicy: Retain, which CloudFormation" >&2
  echo "      honours on exactly this delete (DELETE_SKIPPED, resource orphaned" >&2
  echo "      out of the stack). cdkd destroyed a resource the user marked to" >&2
  echo "      survive." >&2
  echo "      probe: rc=${RETAIN_V2_RC} out='${RETAIN_V2_PROBE}'" >&2
  exit 1
fi

# The controls: the same branch, opposite polarity. If these survive too, the
# fixture is not measuring a retention -- it is measuring a cdkd that stopped
# deleting on this path at all.
assert_gone "phase 4: ${CONTROL_V2} survived the rollback -- a resource with NO UpdateReplacePolicy must be deleted" \
  aws ssm get-parameter --name "${CONTROL_V2}"
assert_gone "phase 4: ${DP_V2} survived the rollback -- DeletionPolicy: Retain does NOT govern the replacement's new copy (see the A/B table in this file's header)" \
  aws ssm get-parameter --name "${DP_V2}"

# ...and every OLD copy is back: re-adopted for RetainParam (it was never
# deleted), re-created for the two controls.
for p in "${RETAIN_V1}" "${CONTROL_V1}" "${DP_V1}"; do
  GOT="$(aws ssm get-parameter --name "${p}" --query 'Parameter.Name' --output text)"
  if [ "${GOT}" != "${p}" ]; then
    echo "FAIL: phase 4: the rollback did not restore ${p} (got '${GOT}')" >&2
    exit 1
  fi
done
echo "[verify] phase 4: OK (retain-v2 ALIVE; control-v2 + deletion-policy-v2 gone; all three v1 copies restored)"

# --------------------------------------------------------------------------
# Phase 5 — what cdkd's STATE says. The survivor is orphaned out of the stack,
# so the record naming it must be GONE, and every subject must point at its
# old copy.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 5: post-rollback state record"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state-rolled-back.json" >/dev/null

for pair in "RetainParam=${RETAIN_V1}" "ControlParam=${CONTROL_V1}" "DeletionPolicyParam=${DP_V1}"; do
  lid="${pair%%=*}"; want="${pair#*=}"
  got="$(jq -r --arg id "${lid}" '.resources[$id].physicalId // "ABSENT"' "${WORK_DIR}/state-rolled-back.json")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: phase 5: state records ${lid} physicalId='${got}', expected '${want}'" >&2
    exit 1
  fi
done

# The retained copy must appear NOWHERE in the record -- not as a physicalId,
# not in a properties bag, not in cached attributes. A whole-file grep rather
# than a per-field check: the point is that cdkd tracks it nowhere, and
# `retain-v1` is not a substring of `retain-v2`, so this cannot false-positive
# on the record that legitimately survives.
if grep -qF "${RETAIN_V2}" "${WORK_DIR}/state-rolled-back.json"; then
  echo "FAIL: phase 5: the state record still names the RETAINED new resource" >&2
  echo "      ${RETAIN_V2}. It is orphaned out of the stack (CloudFormation" >&2
  echo "      parity: DELETE_SKIPPED leaves it untracked), so a surviving" >&2
  echo "      reference would make 'cdkd destroy' or a later deploy act on a" >&2
  echo "      resource cdkd no longer manages." >&2
  jq -r '.resources | to_entries[] | "\(.key) -> \(.value.physicalId)"' \
    "${WORK_DIR}/state-rolled-back.json" >&2
  exit 1
fi
echo "[verify] phase 5: OK (all three records point at the old copies; nothing names ${RETAIN_V2})"

# --------------------------------------------------------------------------
# Phase 6 — THE DURABLE CHANNEL.
#
# Phase 3's grep is what an INTERACTIVE user sees, and it is the weakest thing
# available: a rollback runs during an already-failing deploy, usually non-TTY
# with the log truncated or discarded. The recorded event is the only channel
# that outlives the terminal, and the only one a cleanup pass can read, so a
# survivor named ONLY in a `logger.warn` dies with the terminal -- `cdkd
# events` would show a clean success, state names only the OLD copy, and a
# live, billing, untracked resource is left with nothing anywhere pointing at
# it. `Retain` is exactly the marker users put on data-bearing resources, so
# that is the worst population to lose the id for.
#
# Runs BEFORE the destroy on purpose: a destroy appends a run of its own, and
# this phase reads the FAILED deploy's stream.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 6: the recorded ROLLBACK_RESOURCE_SUCCEEDED events"

EVENTS_LIST="$(${CDKD} events "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --format json)"
# Select the failed deploy run by its RESULT, never by position: this stack's
# history also holds phase 1's successful deploy. `!= SUCCEEDED` rather than
# `== FAILED` because a run whose terminal event was lost lists as `UNKNOWN`,
# and a truncated stream is precisely the case this phase exists for; the
# result is printed either way.
FAILED_RUN_ID="$(printf '%s' "${EVENTS_LIST}" | jq -r \
  '[.runs[] | select(.command == "deploy" and .result != "SUCCEEDED")][0].runId // ""')"
FAILED_RUN_RESULT="$(printf '%s' "${EVENTS_LIST}" | jq -r \
  '[.runs[] | select(.command == "deploy" and .result != "SUCCEEDED")][0].result // ""')"
if [ -z "${FAILED_RUN_ID}" ]; then
  echo "FAIL: phase 6: the event history holds no failed deploy run, so the" >&2
  echo "      rollback recorded nothing durable at all." >&2
  printf '%s\n' "${EVENTS_LIST}" | sed 's/^/  /' >&2
  exit 1
fi
echo "[verify] phase 6: failed deploy run ${FAILED_RUN_ID} (result=${FAILED_RUN_RESULT})"

${CDKD} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" \
  --run "${FAILED_RUN_ID}" --format json > "${WORK_DIR}/run-events.json"

# Sentinel: the three rollback rows must EXIST before any field of theirs means
# anything. A jq selection that matches nothing answers "field absent" exactly
# as a genuinely dropped field does, so without this every assertion below
# passes on an empty stream.
ROLLBACK_ROWS="$(jq '[.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED")] | length' \
  "${WORK_DIR}/run-events.json")"
if [ "${ROLLBACK_ROWS}" -lt 3 ]; then
  echo "FAIL: phase 6: expected 3 ROLLBACK_RESOURCE_SUCCEEDED rows (one per" >&2
  echo "      subject), got ${ROLLBACK_ROWS} -- the field assertions below would" >&2
  echo "      pass vacuously against a stream that names nothing." >&2
  jq -r '.[] | "\(.eventType) \(.logicalId // "-")"' "${WORK_DIR}/run-events.json" >&2
  exit 1
fi

EV_RETAIN_PID="$(jq -r '([.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == "RetainParam")][0] // {}) | if has("physicalId") then .physicalId else "ABSENT" end' "${WORK_DIR}/run-events.json")"
EV_RETAIN_REASON="$(jq -r '([.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == "RetainParam")][0] // {}) | if has("reason") then .reason else "ABSENT" end' "${WORK_DIR}/run-events.json")"
EV_RETAIN_LAYER="$(jq -r '([.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == "RetainParam")][0] // {}) | if has("provisionedBy") then .provisionedBy else "ABSENT" end' "${WORK_DIR}/run-events.json")"

if [ "${EV_RETAIN_PID}" != "${RETAIN_V2}" ]; then
  echo "FAIL: phase 6: the rollback's recorded event does not name the survivor." >&2
  echo "      physicalId='${EV_RETAIN_PID}', expected '${RETAIN_V2}'." >&2
  echo "      The warning in the deploy log is not a substitute: this run's log" >&2
  echo "      is the one thing a real user is least likely to still have, and" >&2
  echo "      state deliberately names only the OLD copy. Without this field the" >&2
  echo "      survivor is a live, billing resource nothing points at." >&2
  jq -r '.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED")' "${WORK_DIR}/run-events.json" >&2
  exit 1
fi
# The prose half must name BOTH ids -- the survivor to act on, and the old copy
# state was restored to, so a reader can tell the two apart without the log.
for want in "${RETAIN_V2}" "${RETAIN_V1}"; do
  if ! printf '%s' "${EV_RETAIN_REASON}" | grep -qF "${want}"; then
    echo "FAIL: phase 6: the recorded reason does not name ${want}." >&2
    echo "      reason='${EV_RETAIN_REASON}'" >&2
    exit 1
  fi
done
# The layer field is what tells a cleanup pass WHICH API manages the id beside
# it, so an id shipped next to a wrong layer is only half a remedy. Asserted as
# a VALUE, and the bound is stated rather than over-claimed: the retain arm
# reports the SURVIVOR's layer (the state record's) where every other path
# reports the OP's, and for a single SDK-routed type both are `sdk` -- so this
# pins that the field is present and correct, NOT that the two sources are told
# apart. Discriminating them would need the survivor's record to route
# differently from the journaled op, which one replacement of one type cannot
# produce.
if [ "${EV_RETAIN_LAYER}" != "sdk" ]; then
  echo "FAIL: phase 6: the survivor's event reports provisionedBy='${EV_RETAIN_LAYER}'," >&2
  echo "      expected 'sdk' (AWS::SSM::Parameter has an SDK provider). A wrong or" >&2
  echo "      missing layer beside the physical id dispatches a cleanup pass at" >&2
  echo "      the wrong API." >&2
  exit 1
fi

# The inverse bug, and it is the reason both fields are gated on the retain
# branch: on every non-retain path through these arms the new copy was DELETED,
# so a `physicalId` here would name a dead resource and send a cleanup pass
# after it. Both controls are already in this run, so this costs one assertion
# over data phase 4 already collected.
for lid in ControlParam DeletionPolicyParam; do
  pid="$(jq -r --arg id "${lid}" '([.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == $id)][0] // {}) | if has("physicalId") then .physicalId else "ABSENT" end' "${WORK_DIR}/run-events.json")"
  reason="$(jq -r --arg id "${lid}" '([.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == $id)][0] // {}) | if has("reason") then .reason else "ABSENT" end' "${WORK_DIR}/run-events.json")"
  layer="$(jq -r --arg id "${lid}" '([.[] | select(.eventType == "ROLLBACK_RESOURCE_SUCCEEDED" and .logicalId == $id)][0] // {}) | if has("provisionedBy") then .provisionedBy else "ABSENT" end' "${WORK_DIR}/run-events.json")"
  if [ "${pid}" != "ABSENT" ] || [ "${reason}" != "ABSENT" ]; then
    echo "FAIL: phase 6: ${lid} retained NOTHING (its new copy was deleted), yet" >&2
    echo "      its event carries physicalId='${pid}' reason='${reason}'." >&2
    echo "      Those fields are the survivor record; emitting them here points a" >&2
    echo "      cleanup pass at a resource this rollback just destroyed." >&2
    exit 1
  fi
  if [ "${layer}" != "sdk" ]; then
    echo "FAIL: phase 6: ${lid}'s event reports provisionedBy='${layer}', expected" >&2
    echo "      'sdk' (the op's own layer, which is what a non-retain row describes)." >&2
    exit 1
  fi
done
echo "[verify] phase 6: OK (survivor id + reason + layer recorded for RetainParam; both controls carry neither field)"

# --------------------------------------------------------------------------
# Phase 7 — destroy, then account for every parameter this run created.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 7: destroy + orphan accounting"
RETAIN_PARAM_NAME="${RETAIN_V1}" CONTROL_PARAM_NAME="${CONTROL_V1}" \
  DELETION_POLICY_PARAM_NAME="${DP_V1}" \
  ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

# Tracked, no retention policy -> destroyed.
assert_gone "phase 7: ${RETAIN_V1} survived destroy (it was re-adopted into state and carries no DeletionPolicy)" \
  aws ssm get-parameter --name "${RETAIN_V1}"
assert_gone "phase 7: ${CONTROL_V1} survived destroy" \
  aws ssm get-parameter --name "${CONTROL_V1}"

# Untracked survivor -> destroy cannot reach it. This is the second half of the
# warning's promise ("cdkd destroy will not remove it"), and asserting it is
# what makes the warning's remediation advice true rather than decorative.
set +e
RETAIN_V2_AFTER="$(aws ssm get-parameter --name "${RETAIN_V2}" --query 'Parameter.Name' --output text 2>&1)"
RETAIN_V2_AFTER_RC=$?
set -e
if [ "${RETAIN_V2_AFTER_RC}" -ne 0 ] || [ "${RETAIN_V2_AFTER}" != "${RETAIN_V2}" ]; then
  echo "FAIL: phase 7: ${RETAIN_V2} disappeared during destroy. The rollback" >&2
  echo "      warned it was no longer tracked and that destroy would not remove" >&2
  echo "      it; something is still reaching it." >&2
  echo "      probe: rc=${RETAIN_V2_AFTER_RC} out='${RETAIN_V2_AFTER}'" >&2
  exit 1
fi
# Tracked, DeletionPolicy: Retain -> destroy deliberately keeps it.
DP_V1_AFTER="$(aws ssm get-parameter --name "${DP_V1}" --query 'Parameter.Name' --output text)"
if [ "${DP_V1_AFTER}" != "${DP_V1}" ]; then
  echo "FAIL: phase 7: ${DP_V1} was deleted by destroy despite DeletionPolicy: Retain" >&2
  exit 1
fi

assert_gone "phase 7: state.json survived destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

# Test artifacts. Both are resources cdkd was CORRECT to leave behind, so the
# fixture -- not cdkd -- owns their deletion. A real user keeps them.
echo "[verify] phase 7: deleting the two deliberate survivors (test artifacts)"
aws ssm delete-parameter --name "${RETAIN_V2}"
aws ssm delete-parameter --name "${DP_V1}"
assert_gone "phase 7: ${RETAIN_V2} still present after artifact cleanup" \
  aws ssm get-parameter --name "${RETAIN_V2}"
assert_gone "phase 7: ${DP_V1} still present after artifact cleanup" \
  aws ssm get-parameter --name "${DP_V1}"

# Zero orphans over the whole fixture path. Names, not a count: the AWS CLI
# applies --query PER PAGE, so a `length(...)` projection prints one number per
# page and `[ "$n" -ne 0 ]` would fall through to announce a clean teardown.
LEFTOVER="$(aws ssm get-parameters-by-path --path "${PARAM_BASE}" --recursive \
  --query 'Parameters[].Name' --output text)"
if [ -n "${LEFTOVER}" ] && [ "${LEFTOVER}" != "None" ]; then
  echo "FAIL: phase 7: parameters survive under ${PARAM_BASE}: ${LEFTOVER}" >&2
  exit 1
fi
echo "[verify] phase 7: OK (0 orphans under ${PARAM_BASE}, state gone)"

trap - EXIT INT TERM
cleanup
echo ""
echo "[verify] PASS -- UpdateReplacePolicy: Retain kept the replacement's new resource across the rollback; DeletionPolicy: Retain and the bare control did not"
