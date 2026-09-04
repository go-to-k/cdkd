#!/usr/bin/env bash
# verify.sh — cdkd AWS::Backup::* Fn::GetAtt (BackupVaultArn) enrichment integ.
#
# Regression coverage for issue #984: AWS::Backup::* types have NO SDK provider
# (pure Cloud Control) and the CC CREATE ResourceModel is sparse for Backup, so
# `Fn::GetAtt(<Vault>, 'BackupVaultArn')` (the canonical CDK shape, emitted by
# `vault.backupVaultArn`) fell through cdkd's intrinsic resolver's
# constructAttribute default to the physicalId — which for a BackupVault is the
# vault NAME, not the ARN. The `CfnOutput('VaultArn')` then carried the bare
# vault name instead of a real `arn:aws:backup:...` ARN. Deploy stayed green
# (a silent GetAtt divergence).
#
# Phases:
#   1. Deploy Vault + Plan(referencing the vault) + tag-based Selection. Assert
#      the resolved `VaultArn` stack output STARTS WITH `arn:aws:backup:` (NOT
#      the bare vault name) — the proof the BackupVaultArn attribute enriched.
#   2. Destroy + assert the vault / plan are gone and the cdkd state file
#      removed (the empty vault deletes cleanly).
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
# COUNT BY ROWS, never `--query 'length(...)'` with `--output text`: the CLI
# applies --query PER PAGE, so a paginated listing prints one number per page
# (`1000\n189`) and an `!= "1"` compare false-fails on a healthy account.
# Projecting the NAME and counting exact matches is page-count-independent.
# The intermediate capture carries `|| return 1` because errexit is CLEARED
# inside `$( )`, so without it a failed probe would fall through to the
# formatting tail and report a truthful-looking 0.
count_backup_vaults() { # usage: count_backup_vaults <vault-name> -> row count
  local out
  out=$(aws backup list-backup-vaults --region "${REGION}" \
    --query "BackupVaultList[?BackupVaultName=='$1'].BackupVaultName" --output text) || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | awk -v n="$1" '$0 == n { c++ } END { print c + 0 }'
}
count_backup_plans() { # usage: count_backup_plans <plan-name> -> row count
  local out
  out=$(aws backup list-backup-plans --region "${REGION}" \
    --query "BackupPlansList[?BackupPlanName=='$1'].BackupPlanName" --output text) || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | awk -v n="$1" '$0 == n { c++ } END { print c + 0 }'
}
cd "$(dirname "$0")"

STACK="CdkdBackupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
VAULT="cdkdbackupexample-vault"
VAULT_V2="cdkdbackupexample-vault-v2"
PLAN="cdkdbackupexample-plan"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Delete every backup plan matching our plan name, then the empty vault.
  for PLAN_ID in $(aws backup list-backup-plans --region "${REGION}" \
      --query "BackupPlansList[?BackupPlanName=='${PLAN}'].BackupPlanId" \
      --output text 2>/dev/null); do
    for SEL_ID in $(aws backup list-backup-selections --backup-plan-id "${PLAN_ID}" \
        --region "${REGION}" --query 'BackupSelectionsList[].SelectionId' \
        --output text 2>/dev/null); do
      aws backup delete-backup-selection --backup-plan-id "${PLAN_ID}" \
        --selection-id "${SEL_ID}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    aws backup delete-backup-plan --backup-plan-id "${PLAN_ID}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws backup delete-backup-vault --backup-vault-name "${VAULT}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  # Phase 1b's rename target. The guard is expected to REFUSE the rename so the
  # v2 vault should never exist -- but a regression that let the replacement
  # through would create it, and leaving it behind is exactly the leak
  # `/run-integ`'s orphan sweep exists to catch.
  aws backup delete-backup-vault --backup-vault-name "${VAULT_V2}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  # The tag-based selection creates an IAM role (CDK default) that a direct
  # backup-resource cleanup above does NOT remove; delete it so a re-run's
  # fresh deploy does not collide with `Role ... already exists`.
  for ROLE in $(aws iam list-roles \
      --query "Roles[?starts_with(RoleName, '${STACK}-PlanSelectionRole')].RoleName" \
      --output text 2>/dev/null); do
    for POL in $(aws iam list-attached-role-policies --role-name "${ROLE}" \
        --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${ROLE}" --policy-arn "${POL}" >/dev/null 2>&1 || true
    done
    for INLINE in $(aws iam list-role-policies --role-name "${ROLE}" \
        --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${ROLE}" --policy-name "${INLINE}" >/dev/null 2>&1 || true
    done
    aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1 || true
  done
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
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy Vault + Plan + Selection"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# The `VaultArn` output is Fn::GetAtt(Vault, 'BackupVaultArn'). Read it from
# state.outputs. Locate the output entry by key prefix so a CDK-hashed output
# logical id (VaultArn<hash>) still matches; fall back to the exact key.
VAULT_ARN=$(echo "${STATE}" | jq -r \
  '[.outputs | to_entries[] | select(.key | startswith("VaultArn")) | .value] | first // (.outputs.VaultArn // "")')
echo "    VaultArn output: ${VAULT_ARN}"
case "${VAULT_ARN}" in
  arn:aws:backup:*:backup-vault:${VAULT}*) ;;
  arn:aws:backup:*) ;;
  *)
    echo "FAIL: VaultArn output is not a real backup vault ARN (enrichment gap): '${VAULT_ARN}'" >&2
    echo "    (Fn::GetAtt(Vault, 'BackupVaultArn') fell through to the vault NAME — issue #984)" >&2
    echo "${STATE}" | jq .outputs >&2
    exit 1
    ;;
esac
echo "    VaultArn resolved to a real ARN (BackupVaultArn enrichment works)"

# Belt-and-suspenders: the vault's own state attributes should carry the ARN too.
STATE_VAULT_ARN=$(echo "${STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::Backup::BackupVault") | .value.attributes.BackupVaultArn] | first // ""')
case "${STATE_VAULT_ARN}" in
  arn:aws:backup:*) echo "    state vault attribute BackupVaultArn is a real ARN: ${STATE_VAULT_ARN}" ;;
  *) echo "FAIL: state vault attribute BackupVaultArn is not an ARN: '${STATE_VAULT_ARN}'" >&2; exit 1 ;;
esac

# `Ref` on the BackupSelection must resolve to the bare BackupSelectionId, NOT
# the compound `Id` (`<SelectionId>_<BackupPlanId>`) — issue #995. Assert the
# SelectionRef output EQUALS the real SelectionId from AWS (an EQUALITY check,
# not a "lacks a delimiter" check: the compound separator is `_`, so a
# `grep -v |` style assertion would false-pass on the composite).
SELECTION_REF=$(echo "${STATE}" | jq -r \
  '[.outputs | to_entries[] | select(.key | startswith("SelectionRef")) | .value] | first // (.outputs.SelectionRef // "")')
echo "    SelectionRef output: ${SELECTION_REF}"
REAL_SELECTION_ID=$(aws backup list-backup-selections --backup-plan-id "${PLAN_ID_FOR_ASSERT:-$(aws backup list-backup-plans --region "${REGION}" --query "BackupPlansList[?BackupPlanName=='${PLAN}'].BackupPlanId | [0]" --output text)}" \
  --region "${REGION}" --query 'BackupSelectionsList[0].SelectionId' --output text 2>/dev/null)
echo "    AWS real SelectionId: ${REAL_SELECTION_ID}"
if [ -z "${REAL_SELECTION_ID}" ] || [ "${REAL_SELECTION_ID}" = "None" ]; then
  echo "FAIL: could not read the real SelectionId from AWS to compare against" >&2
  exit 1
fi
if [ "${SELECTION_REF}" != "${REAL_SELECTION_ID}" ]; then
  echo "FAIL: Ref on BackupSelection is '${SELECTION_REF}' but should equal the bare SelectionId '${REAL_SELECTION_ID}' (issue #995 — returning the compound Id)" >&2
  exit 1
fi
case "${SELECTION_REF}" in
  *_*) echo "FAIL: SelectionRef still contains an underscore (compound Id leaked): '${SELECTION_REF}'" >&2; exit 1 ;;
esac
echo "    SelectionRef resolved to the bare SelectionId (Ref segment fix #995 works)"

# --- Phase 1b: the stateful guard refuses a rename ---------------------
# Issue #2553. `AWS::Backup::BackupVault` has no SDK provider, so a rename
# routes through Cloud Control's DELETE -- a property-driven replacement a
# plain `cdkd deploy` reaches with NO flag. Before the tier-2 sweep the guard
# list could not see the type at all and the deploy destroyed the vault's
# recovery points silently. The deploy must now REFUSE.
echo "==> Phase 1b: rename the vault; the stateful guard must refuse"
set +e
RENAME_OUT=$(CDKD_TEST_RENAME_VAULT=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
RENAME_RC=$?
set -e
echo "${RENAME_OUT}"

# SENTINEL FIRST, so a failure that never reached the guard is reported as
# itself rather than as an issue #2553 regression. Synth errors, expired
# credentials and a missing state bucket all die before the deploy names the
# stack, and every assertion below would otherwise blame the guard for them.
if ! printf '%s\n' "${RENAME_OUT}" | grep -q 'Deploying stack:'; then
  echo "FAIL: the renamed deploy never reached the stack -- this is NOT a guard result." >&2
  echo "      (synth / credentials / state-bucket failure; see the output above)" >&2
  exit 1
fi

# The refusal must come from the PROPERTY-DRIVEN pre-flight guard
# (deploy-engine.ts, the `requires replacement (immutable property changed:`
# arm), not from the update-failure fallback that shares the phrase "but it is
# a stateful resource". Matching the shared phrase alone would let a regression
# that loses the pre-flight arm pass on the fallback's message.
#
# ONE LINE, not the whole captured output: `AWS::Backup::BackupVault` and
# `BackupVaultName` both appear in ordinary plan output, so whole-output greps
# would be satisfied by a deploy that never refused anything.
GUARD_LINE=$(printf '%s\n' "${RENAME_OUT}" \
  | grep -m1 'requires replacement (immutable property changed:' || true)
if [ -z "${GUARD_LINE}" ]; then
  # TWO more sentinels, in order of what they rule out. The first one above
  # covers a failure BEFORE the deploy names the stack; these cover a failure
  # after it, and a REWORD of the marker this fixture parses.
  #
  # `Failed to <op> <LogicalId>` is `deploy-engine.ts`'s per-resource failure
  # line (`Failed to ${change.changeType.toLowerCase()} ${logicalId}`), so it
  # appears for a guard refusal AND for any other failure on the vault --
  # including one on the replacement's create or delete, which is why all three
  # verbs are matched rather than `update` alone.
  if printf '%s\n' "${RENAME_OUT}" | grep -q 'but it is a stateful resource'; then
    echo "FAIL: a stateful refusal fired but not the PROPERTY-DRIVEN one this fixture parses." >&2
    echo "      Either the pre-flight guard's wording drifted (update the needle in this" >&2
    echo "      file and in tests/unit/provisioning/stateful-guard-message-sync.test.ts) or" >&2
    echo "      the refusal came from the update-failure fallback instead." >&2
  elif printf '%s\n' "${RENAME_OUT}" | grep -qE 'Failed to (update|create|delete) Vault'; then
    echo "FAIL: the vault operation failed for a reason OTHER than the stateful guard." >&2
    echo "      This is NOT an issue #2553 regression -- read the output above." >&2
  else
    echo "FAIL: no property-driven stateful refusal in the output (issue #2553 regression)" >&2
  fi
  exit 1
fi
for NEEDLE in 'AWS::Backup::BackupVault' 'BackupVaultName' 'but it is a stateful resource' \
              'force-stateful-recreation'; do
  case "${GUARD_LINE}" in
    *"${NEEDLE}"*) ;;
    *)
      echo "FAIL: the refusal line does not carry '${NEEDLE}': ${GUARD_LINE}" >&2
      exit 1
      ;;
  esac
done
if [ "${RENAME_RC}" = "0" ]; then
  echo "FAIL: the refused deploy exited 0 -- the guard printed but did not block" >&2
  exit 1
fi
echo "    the guard refused the rename (rc=${RENAME_RC})"

# The refusal must be a REFUSAL, not a report issued after the damage: the
# original vault is still there and the v2 vault was never created.
if ! LIVE_V1=$(count_backup_vaults "${VAULT}"); then
  echo "FAIL: could not list backup vaults after the refused rename" >&2; exit 1
fi
if [ "${LIVE_V1}" != "1" ]; then
  echo "FAIL: the original vault ${VAULT} is gone after a REFUSED rename (count=${LIVE_V1})" >&2; exit 1
fi
if ! LIVE_V2=$(count_backup_vaults "${VAULT_V2}"); then
  echo "FAIL: could not list backup vaults after the refused rename" >&2; exit 1
fi
if [ "${LIVE_V2}" != "0" ]; then
  echo "FAIL: the renamed vault ${VAULT_V2} exists -- the replacement was NOT blocked" >&2; exit 1
fi
echo "    ${VAULT} still live and ${VAULT_V2} never created"

# --- Phase 1c: the opt-in still lets it through -------------------------
# The other polarity. Without it the guard could be a hard refusal with no
# escape and every assertion above would still pass -- and the flag would be
# credited to this fixture by `cli-flag-coverage` on the strength of appearing
# in a failure message alone.
echo "==> Phase 1c: re-run the rename with --force-stateful-recreation"
CDKD_TEST_RENAME_VAULT=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --force-stateful-recreation

if ! LIVE_V1=$(count_backup_vaults "${VAULT}"); then
  echo "FAIL: could not list backup vaults after the forced rename" >&2; exit 1
fi
if [ "${LIVE_V1}" != "0" ]; then
  echo "FAIL: ${VAULT} still exists after the forced replacement (count=${LIVE_V1})" >&2; exit 1
fi
if ! LIVE_V2=$(count_backup_vaults "${VAULT_V2}"); then
  echo "FAIL: could not list backup vaults after the forced rename" >&2; exit 1
fi
if [ "${LIVE_V2}" != "1" ]; then
  echo "FAIL: ${VAULT_V2} was not created by the forced replacement (count=${LIVE_V2})" >&2; exit 1
fi
echo "    --force-stateful-recreation replaced ${VAULT} with ${VAULT_V2}"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Strict capture (issue #1097 pattern 2): a silenced `|| echo 0` would read a
# throttled list call as "0 remaining" and silently pass the leak check.
if ! REMAINING_PLANS=$(count_backup_plans "${PLAN}"); then
  echo "FAIL: could not list backup plans after destroy (probe failed)" >&2; exit 1
fi
if [ "${REMAINING_PLANS}" != "0" ]; then
  echo "FAIL: backup plan ${PLAN} still exists after destroy" >&2; exit 1
fi
# AWS Backup masks a missing vault as AccessDeniedException ("Insufficient
# privileges to perform this action"), NOT a not-found error, so gone_probe
# cannot classify describe-backup-vault -- assert absence via a strict list.
# BOTH names: after Phase 1c the stack holds ${VAULT_V2}, so asserting only on
# ${VAULT} would pass vacuously -- it was deleted by the replacement, not by
# the destroy under test.
if ! REMAINING_V2=$(count_backup_vaults "${VAULT_V2}"); then
  echo "FAIL: could not list backup vaults after destroy" >&2; exit 1
fi
if [ "${REMAINING_V2}" != "0" ]; then
  echo "FAIL: backup vault ${VAULT_V2} still exists after destroy" >&2; exit 1
fi
if ! REMAINING_VAULTS=$(count_backup_vaults "${VAULT}"); then
  echo "FAIL: could not list backup vaults after destroy (probe failed)" >&2; exit 1
fi
if [ "${REMAINING_VAULTS}" != "0" ]; then
  echo "FAIL: backup vault ${VAULT} still exists after destroy" >&2; exit 1
fi
echo "    Vault / Plan / Selection deleted"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — BackupVaultArn Fn::GetAtt enrichment works end-to-end and the tier-2 stateful guard refuses / allows the vault rename, 4 phases passed"
