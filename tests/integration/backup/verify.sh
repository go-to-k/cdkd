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
cd "$(dirname "$0")"

STACK="CdkdBackupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
VAULT="cdkdbackupexample-vault"
PLAN="cdkdbackupexample-plan"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
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

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

REMAINING_PLANS=$(aws backup list-backup-plans --region "${REGION}" \
  --query "length(BackupPlansList[?BackupPlanName=='${PLAN}'] || \`[]\`)" --output text 2>/dev/null || echo 0)
if [ "${REMAINING_PLANS}" != "0" ]; then
  echo "FAIL: backup plan ${PLAN} still exists after destroy" >&2; exit 1
fi
if aws backup describe-backup-vault --backup-vault-name "${VAULT}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: backup vault ${VAULT} still exists after destroy" >&2; exit 1
fi
echo "    Vault / Plan / Selection deleted"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — BackupVaultArn Fn::GetAtt enrichment works end-to-end, 2 phases passed"
