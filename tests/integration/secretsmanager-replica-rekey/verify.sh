#!/usr/bin/env bash
# verify.sh — AWS::SecretsManager::Secret replica re-key + destroy integ
# (issues #5302, #5323).
#
# #5302: `SecretsManagerSecretProvider.update()` only removed regions that left
# `ReplicaRegions` and replicated regions new to it, so a changed `KmsKeyId` on
# a region already replicated was never sent: the deploy went green, state
# recorded the new key, and the replica kept the old one. A real CloudFormation
# A/B showed CloudFormation re-keys the replica IN PLACE by calling
# ReplicateSecretToRegions for that region (with no key when it is removed).
# #5323: `delete()` sent DeleteSecret straight away, which Secrets Manager
# refuses while the secret still has replica regions.
#
# Phases:
#   0. Create a customer managed KMS key in the replica region by direct call
#      (a stack cannot create one in another region), under a fixed alias.
#   1. Deploy (no key): the replica uses the AWS managed key. Record the
#      primary's ARN and the replica's CreatedDate.
#   2. UPDATE (CDKD_TEST_REPLICA_KEY=<key arn>): the replica's KmsKeyId is
#      ADDED. Assert the replica reports the key, InSync, and the same
#      CreatedDate and primary ARN (re-keyed in place, not re-created).
#      Pre-fix: the replica stays on the AWS managed key.
#   3. UPDATE (no key again): the KmsKeyId is REMOVED. Assert the replica is
#      back on the AWS managed key, in place. Pre-fix: it stays on the key.
#   4. Destroy; assert the primary AND the replica are gone. Pre-fix the
#      destroy fails on the replica refusal (#5323).
#   Teardown schedules the KMS key for deletion (7-day window: a key in
#   PendingDeletion is the expected end state, not an orphan) and sweeps the
#   state bucket's object versions.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Optional:
#   REPLICA_REGION — defaults to us-west-2 (us-east-1 when AWS_REGION is us-west-2)

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

# The state bucket is versioned, so teardown sweeps object VERSIONS (issue
# #2096) — `aws s3 rm` alone leaves every version readable.
. ../s3-versions.sh

STACK="CdkdSecretsmanagerReplicaRekeyExample"
REGION="${AWS_REGION:-us-east-1}"
if [ "${REGION}" = "us-west-2" ]; then
  REPLICA_REGION="${REPLICA_REGION:-us-east-1}"
else
  REPLICA_REGION="${REPLICA_REGION:-us-west-2}"
fi
if [ "${REPLICA_REGION}" = "${REGION}" ]; then
  echo "FAIL: REPLICA_REGION (${REPLICA_REGION}) must differ from AWS_REGION (${REGION})" >&2
  exit 1
fi
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
SECRET_NAME="${STACK}-replicated"
KEY_ARN=""
KEY_ALIAS="alias/cdkd-integ-secretsmanager-replica-rekey"
AWS_MANAGED_KEY="alias/aws/secretsmanager"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Schedule the aliased key for deletion and drop the alias. ScheduleKeyDeletion
# refuses an alias, so resolve the key id first. Best effort: runs under
# `set +eu` from cleanup.
retire_key() {
  (
    set +eu
    local key_id state
    key_id="$(aws kms describe-key --key-id "${KEY_ALIAS}" --region "${REPLICA_REGION}" \
      --query 'KeyMetadata.KeyId' --output text 2>/dev/null)"
    if [ -n "${key_id}" ] && [ "${key_id}" != "None" ]; then
      state="$(aws kms describe-key --key-id "${key_id}" --region "${REPLICA_REGION}" \
        --query 'KeyMetadata.KeyState' --output text 2>/dev/null)"
      if [ "${state}" != "PendingDeletion" ]; then
        aws kms schedule-key-deletion --key-id "${key_id}" --pending-window-in-days 7 \
          --region "${REPLICA_REGION}" >/dev/null 2>&1
      fi
      aws kms delete-alias --alias-name "${KEY_ALIAS}" --region "${REPLICA_REGION}" >/dev/null 2>&1
    fi
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # A stale lock from a killed previous run would make `state destroy` refuse
  # (the record is then KEPT, below), so drop it first.
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Best-effort delete by fixed name in case state destroy missed it: the
  # replica region goes first (DeleteSecret refuses a primary with replicas;
  # RemoveRegionsFromReplication deletes the replica).
  aws secretsmanager remove-regions-from-replication --secret-id "${SECRET_NAME}" \
    --remove-replica-regions "${REPLICA_REGION}" --region "${REGION}" >/dev/null 2>&1 || true
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  # A replica promoted to a standalone secret by an interrupted run would
  # block the next run's replication by name; a live replica refuses this.
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REPLICA_REGION}" >/dev/null 2>&1 || true
  retire_key
  # A key created but never aliased (create-alias failed, or the run died in
  # between) is invisible to retire_key: schedule this run's key by ARN too.
  if [ -n "${KEY_ARN:-}" ]; then
    if [ "$(aws kms describe-key --key-id "${KEY_ARN}" --region "${REPLICA_REGION}" \
      --query 'KeyMetadata.KeyState' --output text 2>/dev/null)" != "PendingDeletion" ]; then
      aws kms schedule-key-deletion --key-id "${KEY_ARN}" --pending-window-in-days 7 \
        --region "${REPLICA_REGION}" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    # The state record is removed ONLY after `state destroy` succeeded: on a
    # failed destroy it is still the record of resources that may be standing,
    # and the noncurrent purge below would otherwise reap it the moment the
    # `rm` turned it into a noncurrent version.
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent || true
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

# --- probes ----------------------------------------------------------------
# A force-deleted secret can still answer a describe for a few seconds, so a
# single gone-probe right after destroy reports a false leak: poll, keeping
# gone_probe's tri-state (copied from nested-stack-secret/verify.sh).
assert_gone_eventually() { # usage: assert_gone_eventually <timeout_s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local waited=0
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${waited}" -ge "${timeout}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s of polling)" >&2
      exit 1
    fi
    sleep 3
    waited=$(( waited + 3 ))
  done
}
primary_field() { # usage: primary_field <JMESPath>
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" \
    --query "$1" --output text || return 1
}
replica_field() { # usage: replica_field <JMESPath>
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REPLICA_REGION}" \
    --query "$1" --output text || return 1
}
assert_eq() { # usage: assert_eq "<what>" <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}
assert_nonempty() { # usage: assert_nonempty "<what>" <value>
  if [ -z "$2" ] || [ "$2" = "None" ]; then
    echo "FAIL: $1 is empty — the assertion built on it would be vacuous" >&2
    exit 1
  fi
}
# Replication is asynchronous: wait (<= 120s) until the primary reports the
# replica region InSync ON THE EXPECTED KEY (a stale InSync on the previous key
# right after the call would read as a false FAIL), then print the replica's
# KmsKeyId as the PRIMARY sees it. A key that never arrives falls through to
# the caller's assertion, which names it.
wait_in_sync() { # usage: wait_in_sync <phase label> <expected KmsKeyId>
  local status="" key="" i
  for i in $(seq 1 24); do
    status="$(primary_field "ReplicationStatus[?Region=='${REPLICA_REGION}'].Status | [0]")" || return 1
    key="$(primary_field "ReplicationStatus[?Region=='${REPLICA_REGION}'].KmsKeyId | [0]")" || return 1
    [ "${status}" = "InSync" ] && [ "${key}" = "$2" ] && break
    if [ "${status}" = "Failed" ]; then
      echo "FAIL: $1 replication to ${REPLICA_REGION} Failed: $(primary_field "ReplicationStatus[?Region=='${REPLICA_REGION}'].StatusMessage | [0]")" >&2
      exit 1
    fi
    sleep 5
  done
  if [ "${status}" != "InSync" ]; then
    echo "FAIL: $1 replication to ${REPLICA_REGION} not InSync after 120s (status: ${status})" >&2
    exit 1
  fi
  primary_field "ReplicationStatus[?Region=='${REPLICA_REGION}'].KmsKeyId | [0]"
}

# --- Phase 0: the customer managed key in the replica region -----------------
echo "==> Phase 0: create a customer managed KMS key in ${REPLICA_REGION}"
KEY_ARN="$(aws kms create-key --region "${REPLICA_REGION}" \
  --description "cdkd integ secretsmanager-replica-rekey (issue #5302)" \
  --query 'KeyMetadata.Arn' --output text)"
assert_nonempty "created KMS key ARN" "${KEY_ARN}"
aws kms create-alias --alias-name "${KEY_ALIAS}" --target-key-id "${KEY_ARN}" --region "${REPLICA_REGION}"
echo "    key created under ${KEY_ALIAS}"

# --- Phase 1: baseline deploy, AWS managed key --------------------------------
echo "==> Phase 1: deploy baseline (replica in ${REPLICA_REGION}, no KmsKeyId)"
env -u CDKD_TEST_REPLICA_KEY CDKD_REPLICA_REGION="${REPLICA_REGION}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_eq "Phase 1 replica KmsKeyId (primary's view)" "${AWS_MANAGED_KEY}" "$(wait_in_sync "Phase 1" "${AWS_MANAGED_KEY}")"
assert_eq "Phase 1 replica's PrimaryRegion" "${REGION}" "$(replica_field PrimaryRegion)"
# The replica's own view spells the AWS managed key as its alias (probed while
# writing #5302); asserted here so Phase 3's same check is known to be sound.
assert_eq "Phase 1 replica KmsKeyId (replica's view)" "${AWS_MANAGED_KEY}" "$(replica_field KmsKeyId)"
PRIMARY_ARN="$(primary_field ARN)"
REPLICA_CREATED="$(replica_field CreatedDate)"
assert_nonempty "Phase 1 primary ARN" "${PRIMARY_ARN}"
assert_nonempty "Phase 1 replica CreatedDate" "${REPLICA_CREATED}"
echo "    replica InSync on ${AWS_MANAGED_KEY}"

# --- Phase 2: KmsKeyId ADDED — the replica must be re-keyed in place ----------
echo "==> Phase 2: re-deploy with the replica's KmsKeyId set to the customer managed key"
CDKD_TEST_REPLICA_KEY="${KEY_ARN}" CDKD_REPLICA_REGION="${REPLICA_REGION}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_eq "Phase 2 replica KmsKeyId, primary's view (issue #5302: a changed key on a kept region was never sent)" \
  "${KEY_ARN}" "$(wait_in_sync "Phase 2" "${KEY_ARN}")"
assert_eq "Phase 2 replica KmsKeyId, replica's view (issue #5302)" "${KEY_ARN}" "$(replica_field KmsKeyId)"
assert_eq "Phase 2 replica CreatedDate (re-keyed in place, not re-created)" "${REPLICA_CREATED}" "$(replica_field CreatedDate)"
assert_eq "Phase 2 primary ARN (no replacement)" "${PRIMARY_ARN}" "$(primary_field ARN)"
echo "    replica re-keyed in place to the customer managed key"

# --- Phase 3: KmsKeyId REMOVED — back to the AWS managed key, in place --------
echo "==> Phase 3: re-deploy with the replica's KmsKeyId removed"
env -u CDKD_TEST_REPLICA_KEY CDKD_REPLICA_REGION="${REPLICA_REGION}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_eq "Phase 3 replica KmsKeyId, primary's view (issue #5302: a removed key on a kept region was never sent)" \
  "${AWS_MANAGED_KEY}" "$(wait_in_sync "Phase 3" "${AWS_MANAGED_KEY}")"
assert_eq "Phase 3 replica KmsKeyId, replica's view (issue #5302)" "${AWS_MANAGED_KEY}" "$(replica_field KmsKeyId)"
assert_eq "Phase 3 replica CreatedDate (re-keyed in place, not re-created)" "${REPLICA_CREATED}" "$(replica_field CreatedDate)"
assert_eq "Phase 3 primary ARN (no replacement)" "${PRIMARY_ARN}" "$(primary_field ARN)"
echo "    replica back on ${AWS_MANAGED_KEY}, in place"

# --- Phase 4: destroy — the replica region must be removed first (#5323) ------
echo "==> Phase 4: destroy"
if ! node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force; then
  echo "FAIL: destroy failed (issue #5323: DeleteSecret is refused while the secret still has replica regions)" >&2
  exit 1
fi

# The primary is force-deleted (gone); the replica is deleted by the removal.
assert_gone_eventually 60 "primary secret ${SECRET_NAME} still exists after destroy" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"
assert_gone_eventually 60 "replica ${SECRET_NAME} in ${REPLICA_REGION} still exists after destroy" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REPLICA_REGION}"
echo "    primary and replica deleted"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# Success path: retire the key, purge EVERY state version and delete marker
# under the stack prefix, then assert the sweep (issue #2096).
cleanup
trap - EXIT INT TERM
assert_eq "KMS key state after teardown" "PendingDeletion" \
  "$(aws kms describe-key --key-id "${KEY_ARN}" --region "${REPLICA_REGION}" --query 'KeyMetadata.KeyState' --output text)"
echo "    KMS key scheduled for deletion"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "secretsmanager-replica-rekey state teardown"
echo "    state bucket versions swept"

echo "[verify] PASS — a Secrets Manager replica is re-keyed in place when its KmsKeyId is added or removed (issue #5302), and a replicated secret destroys (issue #5323)"
