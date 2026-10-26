#!/usr/bin/env bash
# verify.sh - cdkd kms-encryption integ + removal of KMS Key properties (#1160).
#
# Deploys the kms-encryption fixture, then redeploys with CDKD_TEST_REMOVAL=true:
#   - EncKey drops RotationPeriodInDays (90, rotation stays on) and KeyPolicy
#     (a declared policy with a Cdkd1160Extra statement), beside a Description
#     change. CloudFormation resets the period to 365 and the policy to the
#     KMS default key policy (`Id: key-default-1`) -- measured A/B, us-east-1.
#   - DisabledKey (Enabled false, rotation on, period 90) drops Enabled and
#     RotationPeriodInDays together. CloudFormation enables the key, then
#     resets the period to 365 (KMS refuses a rotation call on a disabled key).
#   - IMMUTABLE (issue #5299): SpecKey changes KeyUsage beside Description; the
#     deploy must fail with the refusal and change nothing, as CloudFormation
#     fails it.
#   - BYPASS (issue #5299): LockKey gets a policy without kms:PutKeyPolicy
#     and BypassPolicyLockoutSafetyCheck: true; the put must land.
# Then destroys clean: every key pending deletion, alias and bucket gone.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="KmsEncryptionStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ALIAS="alias/cdkd-kms-test"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Prints a resource's physical id from the cdkd state record.
physical_id() { # usage: physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "$1" '.resources[$l].physicalId // empty'
}

# Prints "<enabled>|<rotation>|<period>" for a key, e.g. "True|True|90".
key_attrs() { # usage: key_attrs <key-id>
  local e r
  e=$(aws kms describe-key --region "${REGION}" --key-id "$1" \
    --query KeyMetadata.Enabled --output text) || return 1
  r=$(aws kms get-key-rotation-status --region "${REGION}" --key-id "$1" \
    --query '[KeyRotationEnabled,RotationPeriodInDays]' --output text | tr '\t' '|') || return 1
  printf '%s|%s' "${e}" "${r}"
}

# Prints "<policy Id>|<statement Sids, comma-joined>|<principal of the IAM
# statement>" for a key's default policy, e.g.
# "key-default-1|Enable IAM User Permissions|arn:aws:iam::123456789012:root".
key_policy() { # usage: key_policy <key-id>
  aws kms get-key-policy --region "${REGION}" --key-id "$1" --policy-name default \
    --query Policy --output text \
    | jq -r '[(.Id // "<none>"), ([.Statement[] | .Sid // "<none>"] | join(",")),
        ([.Statement[] | select(.Sid == "Enable IAM User Permissions") | .Principal.AWS] | first // "<none>")] | join("|")'
}

# Polls `<fn> <key-id>` until it prints <want>, for up to 5 minutes: KMS
# read-after-write can lag for minutes. Prints the last value read.
poll_until() { # usage: poll_until <want> <fn> <key-id>
  local want="$1" fn="$2" id="$3" got="" i
  for i in $(seq 1 20); do
    got=$("${fn}" "${id}") || got="<read failed>"
    [ "${got}" = "${want}" ] && break
    sleep 15
  done
  printf '%s' "${got}"
}

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PARTITION=$(aws sts get-caller-identity --query Arn --output text | cut -d: -f2)
DEFAULT_POLICY="key-default-1|Enable IAM User Permissions|arn:${PARTITION}:iam::${ACCOUNT}:root"

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

ENC_KEY=$(physical_id EncKeyC32E48BA)
DIS_KEY=$(physical_id DisabledKey)
BUCKET=$(physical_id EncBucket0318B7B6)
if [ -z "${ENC_KEY}" ] || [ -z "${DIS_KEY}" ] || [ -z "${BUCKET}" ]; then
  echo "FAIL: physical ids missing from state: EncKey='${ENC_KEY}' DisabledKey='${DIS_KEY}' EncBucket='${BUCKET}'" >&2
  exit 1
fi

# Issue #1160 baseline: each key holds a non-default value first, so the
# default afterwards is the removal's doing.
P1_ENC=$(poll_until "True|True|90" key_attrs "${ENC_KEY}")
P1_DIS=$(poll_until "False|True|90" key_attrs "${DIS_KEY}")
P1_POLICY=$(key_policy "${ENC_KEY}")
if [ "${P1_ENC}" != "True|True|90" ] || [ "${P1_DIS}" != "False|True|90" ]; then
  echo "FAIL: enabled|rotation|period after create: EncKey='${P1_ENC}' (expected True|True|90), DisabledKey='${P1_DIS}' (expected False|True|90)" >&2
  exit 1
fi
case "${P1_POLICY}" in
  *Cdkd1160Extra*) ;;
  *)
    echo "FAIL: EncKey policy after create lacks the Cdkd1160Extra statement: '${P1_POLICY}'" >&2
    exit 1
    ;;
esac
echo "    OK: baseline EncKey True|True|90 with the declared policy, DisabledKey False|True|90"

# --- Phase 2: REMOVAL (issue #1160) -----------------------------------
echo "==> Phase 2: removal (EncKey drops RotationPeriodInDays + KeyPolicy; DisabledKey drops Enabled + RotationPeriodInDays)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RM_ENC_KEY=$(physical_id EncKeyC32E48BA)
RM_DIS_KEY=$(physical_id DisabledKey)
if [ "${RM_ENC_KEY}" != "${ENC_KEY}" ] || [ "${RM_DIS_KEY}" != "${DIS_KEY}" ]; then
  echo "FAIL: a key was replaced by the removal (must reset in place): '${ENC_KEY}' -> '${RM_ENC_KEY}', '${DIS_KEY}' -> '${RM_DIS_KEY}'" >&2
  exit 1
fi

P2_ENC=$(poll_until "True|True|365" key_attrs "${ENC_KEY}")
if [ "${P2_ENC}" != "True|True|365" ]; then
  echo "FAIL: EncKey kept a removed RotationPeriodInDays (issue #1160): enabled|rotation|period='${P2_ENC}'; expected True|True|365, as CloudFormation resets it" >&2
  exit 1
fi
echo "    OK: EncKey's removed RotationPeriodInDays reset to 365 (issue #1160)"

P2_POLICY=$(poll_until "${DEFAULT_POLICY}" key_policy "${ENC_KEY}")
if [ "${P2_POLICY}" != "${DEFAULT_POLICY}" ]; then
  echo "FAIL: EncKey kept a removed KeyPolicy (issue #1160): '${P2_POLICY}'; expected the KMS default key policy '${DEFAULT_POLICY}', as CloudFormation resets it" >&2
  exit 1
fi
echo "    OK: EncKey's removed KeyPolicy reset to the KMS default key policy (issue #1160)"

P2_DESC=$(aws kms describe-key --region "${REGION}" --key-id "${ENC_KEY}" --query KeyMetadata.Description --output text)
if [ "${P2_DESC}" != "cdkd test encryption key (removal)" ]; then
  echo "FAIL: EncKey's same-update Description change did not land: '${P2_DESC}'" >&2
  exit 1
fi
echo "    OK: EncKey's Description change landed in the same update"

P2_DIS=$(poll_until "True|True|365" key_attrs "${DIS_KEY}")
if [ "${P2_DIS}" != "True|True|365" ]; then
  echo "FAIL: DisabledKey after removing Enabled + RotationPeriodInDays (issue #1160): enabled|rotation|period='${P2_DIS}'; expected True|True|365, as CloudFormation enables the key and resets the period" >&2
  exit 1
fi
echo "    OK: DisabledKey enabled, then its removed RotationPeriodInDays reset to 365 (issue #1160)"

# Prints "<KeySpec>|<KeyUsage>|<Description>" for a key.
key_shape() { # usage: key_shape <key-id>
  aws kms describe-key --region "${REGION}" --key-id "$1" \
    --query 'KeyMetadata.[KeySpec,KeyUsage,Description]' --output text | tr '\t' '|'
}

# --- Phase 2b: IMMUTABLE (issue #5299) --------------------------------
# SpecKey changes KeyUsage ENCRYPT_DECRYPT -> SIGN_VERIFY beside a Description
# change. CloudFormation fails this update (A/B, us-east-1): KMS has no call
# that changes a key's usage. cdkd used to report success with neither applied.
echo "==> Phase 2b: SpecKey KeyUsage change must be refused (issue #5299)"
SPEC_KEY=$(physical_id SpecKey)
LOCK_KEY=$(physical_id LockKey)
if [ -z "${SPEC_KEY}" ] || [ -z "${LOCK_KEY}" ]; then
  echo "FAIL: physical ids missing from state: SpecKey='${SPEC_KEY}' LockKey='${LOCK_KEY}'" >&2
  exit 1
fi
IMM_LOG=$(mktemp)
set +e
CDKD_TEST_REMOVAL=true CDKD_TEST_IMMUTABLE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${IMM_LOG}" 2>&1
IMM_RC=$?
set -e
IMM_TAIL=$(tail -20 "${IMM_LOG}")
IMM_HIT=0
grep -qF 'SpecKey) cannot be updated in place: KeyUsage changed' "${IMM_LOG}" && IMM_HIT=1
rm -f "${IMM_LOG}"
if [ "${IMM_RC}" -eq 0 ]; then
  printf '%s\n' "${IMM_TAIL}" >&2
  echo "FAIL: a KeyUsage change deployed successfully (issue #5299); CloudFormation fails it, and KMS cannot apply it" >&2
  exit 1
fi
if [ "${IMM_HIT}" -ne 1 ]; then
  printf '%s\n' "${IMM_TAIL}" >&2
  echo "FAIL: the IMMUTABLE deploy failed, but not with the KeyUsage refusal (issue #5299)" >&2
  exit 1
fi
P2B_SHAPE=$(key_shape "${SPEC_KEY}")
if [ "${P2B_SHAPE}" != "RSA_2048|ENCRYPT_DECRYPT|cdkd test spec key" ]; then
  echo "FAIL: SpecKey changed by a refused update: '${P2B_SHAPE}' (expected RSA_2048|ENCRYPT_DECRYPT|cdkd test spec key -- the refusal comes before any call)" >&2
  exit 1
fi
if [ "$(physical_id SpecKey)" != "${SPEC_KEY}" ]; then
  echo "FAIL: SpecKey was replaced, not refused (issue #5299)" >&2
  exit 1
fi
echo "    OK: SpecKey's KeyUsage change refused with nothing applied (issue #5299)"

# --- Phase 2c: BYPASS (issue #5299) -----------------------------------
# LockKey's new policy grants the account no kms:PutKeyPolicy, so KMS refuses
# it unless the update sends BypassPolicyLockoutSafetyCheck, as CloudFormation
# does (A/B, us-east-1).
echo "==> Phase 2c: LockKey policy put with BypassPolicyLockoutSafetyCheck (issue #5299)"
CDKD_TEST_REMOVAL=true CDKD_TEST_BYPASS=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
lock_sids() { # usage: lock_sids <key-id>
  aws kms get-key-policy --region "${REGION}" --key-id "$1" --policy-name default \
    --query Policy --output text | jq -r '[.Statement[] | .Sid // "<none>"] | join(",")'
}
P2C_SIDS=$(poll_until "Cdkd5299NoPutKeyPolicy" lock_sids "${LOCK_KEY}")
if [ "${P2C_SIDS}" != "Cdkd5299NoPutKeyPolicy" ]; then
  echo "FAIL: LockKey policy after the BYPASS deploy has statements '${P2C_SIDS}' (expected Cdkd5299NoPutKeyPolicy)" >&2
  exit 1
fi
echo "    OK: LockKey's lockout policy put with the bypass (issue #5299)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

for k in "${ENC_KEY}" "${DIS_KEY}" "${SPEC_KEY}" "${LOCK_KEY}"; do
  KSTATE=$(aws kms describe-key --region "${REGION}" --key-id "${k}" --query KeyMetadata.KeyState --output text) \
    || { echo "FAIL: describe-key '${k}' failed after destroy" >&2; exit 1; }
  if [ "${KSTATE}" != "PendingDeletion" ]; then
    echo "FAIL: key '${k}' is '${KSTATE}' after destroy (expected PendingDeletion)" >&2
    exit 1
  fi
done
echo "    OK: all four keys are pending deletion"

assert_gone "alias '${ALIAS}' still exists after destroy" aws kms describe-key --region "${REGION}" --key-id "${ALIAS}"
assert_gone "bucket '${BUCKET}' still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}"
echo "    OK: alias and bucket are gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> kms-encryption test passed (removed RotationPeriodInDays / KeyPolicy / Enabled reset, refused KeyUsage change, lockout bypass + clean destroy)"
