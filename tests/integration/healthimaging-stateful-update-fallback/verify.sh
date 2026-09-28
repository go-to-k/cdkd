#!/usr/bin/env bash
# verify.sh — the stateful guard on the deploy engine's UPDATE-FAILURE
# fallback, against real AWS (issue #2515).
#
# When a provider's update() throws Cloud Control's `UnsupportedActionException`
# (the type has no UPDATE handler), `DeployEngine` falls back to a DELETE +
# CREATE replacement. For a `STATEFUL_TYPES` member that fallback must refuse
# with STATEFUL_REPLACE_BLOCKED unless `--force-stateful-recreation` is passed
# (issue #2514). Only mocked unit tests covered that arm before this fixture.
#
# How the arm is reached. `AWS::HealthImaging::Datastore` is IMMUTABLE in the
# CFn registry (no update handler) and lists `Tags` as create-only, so with the
# live schema a tag change is a REPLACEMENT up front and takes the OTHER guard
# (the property-driven one). The update-failure arm is reached when the
# create-only lookup cannot run: a deploy identity without
# `cloudformation:DescribeType`. The type has no entry in cdkd's committed
# create-only snapshot, so the lookup falls back to `[]`, the tag change is
# sent as an in-place Cloud Control UPDATE, and Cloud Control refuses it.
#
# The denied identity is REAL, not a code seam: `sts get-federation-token` with
# a session policy of `Allow *` plus `Deny cloudformation:DescribeType`. The
# result is the intersection with the caller's own policies, so it grants
# nothing the caller lacks, and it creates no IAM resource. It needs IAM-USER
# credentials (GetFederationToken refuses a role session); the precondition
# below fails loudly otherwise.
#
# Phases:
#   1. Deploy the data store (caller's own identity); capture its id, assert
#      ACTIVE and tag phase=baseline.
#   2. CONTROL, caller's own identity: the tag change is refused by the
#      PROPERTY-DRIVEN guard (the live schema says Tags is create-only). Proves
#      the denial below, not the template, is what moves the refusal.
#   3. Denied identity, no flag: refused by the UPDATE-FAILURE guard. Asserts
#      the create-only lookup fell back to the registry-only classification
#      (no snapshot entry), the refusal is the fallback arm's wording and not
#      the property-driven one, and the data store is untouched (same id,
#      ACTIVE, still phase=baseline).
#   4. Denied identity, --force-stateful-recreation: the fallback replaces it —
#      a NEW id with phase=updated, the old id gone.
#   5. Destroy; assert the data store and the state file are gone.
#
# Required env vars: STATE_BUCKET, AWS_REGION (defaults us-east-1).

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

STACK="CdkdHealthImagingStatefulUpdateFallbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Must match `datastoreName` in lib/. An exact-match filter below, never a
# prefix, so an empty value cannot widen a sweep.
DS_NAME="cdkd-integ-healthimaging-stateful-fallback"
TYPE="AWS::HealthImaging::Datastore"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The needles. ARM_MARKER is the update-failure refusal's own wording;
# PROPERTY_MARKER is the property-driven refusal's; SHARED_MARKER is the phrase
# both refusals carry, the sentinel telling a reword from a missing refusal.
ARM_MARKER='cannot be updated in place by the provisioning layer it routes through'
PROPERTY_MARKER='requires replacement (immutable property changed: Tags'
SHARED_MARKER='but it is a stateful resource'
LOOKUP_MARKER="Failed to resolve create-only properties for ${TYPE} via cloudformation:DescribeType"
REGISTRY_ONLY_MARKER='Falling back to the registry-only replacement classification'
REPLACING_MARKER="UPDATE not supported for Datastore (${TYPE}), replacing"

# Session policy for the denied identity: everything the caller already has,
# minus DescribeType.
DENY_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"},{"Effect":"Deny","Action":"cloudformation:DescribeType","Resource":"*"}]}'
DENIED_AK=""
DENIED_SK=""
DENIED_ST=""

# Mint fresh denied credentials. One hour outlives a phase's Cloud Control
# delete + create; each phase mints its own so none rides an old token.
# Process substitution, not a here-string: bash 3.2 backs a here-string with
# a temp file, which would put the secret on disk.
mint_denied_creds() {
  DENIED_AK="" DENIED_SK="" DENIED_ST=""
  read -r DENIED_AK DENIED_SK DENIED_ST < <(aws sts get-federation-token \
    --name cdkd-integ-2515 --duration-seconds 3600 --policy "${DENY_POLICY}" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text) || true
  [ -n "${DENIED_AK}" ] && [ -n "${DENIED_SK}" ] && [ -n "${DENIED_ST}" ]
}

# Run a command as the denied identity, in a subshell so the caller's
# environment is untouched. Shell builtins only: an `env VAR=secret` prefix
# would put the secret in a process's argv. AWS_PROFILE is UNSET, not
# overridden: the SDK's default chain skips environment credentials whenever
# AWS_PROFILE is set, which would silently run the phase as the caller.
as_denied() (
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  export AWS_ACCESS_KEY_ID="${DENIED_AK}" AWS_SECRET_ACCESS_KEY="${DENIED_SK}" \
    AWS_SESSION_TOKEN="${DENIED_ST}"
  exec "$@"
)

# Prove the identity is the denied one before a phase leans on it: STS must
# name a federated user, and DescribeType must be refused as AccessDenied (not
# throttled, not a network failure — those would also fall back, and a later
# grant of the permission would then go unnoticed).
assert_denied_identity() {
  local arn dt_out
  arn="$(as_denied aws sts get-caller-identity --query Arn --output text)" || {
    echo "FAIL: the denied identity cannot call sts:GetCallerIdentity" >&2; exit 1
  }
  case "${arn}" in
    *:federated-user/cdkd-integ-2515) ;;
    *) echo "FAIL: the denied phase would run as ${arn}, not the federated user" >&2; exit 1 ;;
  esac
  if dt_out="$(as_denied aws cloudformation describe-type --type RESOURCE \
      --type-name "${TYPE}" --region "${REGION}" --query ProvisioningType --output text 2>&1)"; then
    echo "FAIL: DescribeType SUCCEEDED under the denied identity (${dt_out}) — the phase would take the property-driven arm" >&2
    exit 1
  fi
  if ! printf '%s' "${dt_out}" | grep -q 'AccessDenied'; then
    echo "FAIL: DescribeType failed under the denied identity, but not as AccessDenied: ${dt_out}" >&2
    exit 1
  fi
}

# Ids of every data store carrying our name that is not already DELETED.
live_ids() {
  aws medical-imaging list-datastores --region "${REGION}" \
    --query "datastoreSummaries[?datastoreName=='${DS_NAME}' && datastoreStatus!='DELETED'].datastoreId" \
    --output text
}
ds_status() {
  aws medical-imaging get-datastore --region "${REGION}" --datastore-id "$1" \
    --query 'datastoreProperties.datastoreStatus' --output text
}
ds_tag_phase() {
  local arn
  arn="$(aws medical-imaging get-datastore --region "${REGION}" --datastore-id "$1" \
    --query 'datastoreProperties.datastoreArn' --output text)" || return 1
  aws medical-imaging list-tags-for-resource --region "${REGION}" --resource-arn "${arn}" \
    --query 'tags.phase' --output text
}
# Exactly one live data store with our name; prints its id.
single_live_id() {
  local ids count
  ids="$(live_ids)" || { echo "FAIL: list-datastores failed" >&2; exit 1; }
  count="$(printf '%s' "${ids}" | wc -w | tr -d ' ')"
  if [ "${count}" != "1" ]; then
    echo "FAIL: expected exactly one live data store named ${DS_NAME}, found ${count}: ${ids}" >&2
    exit 1
  fi
  printf '%s' "${ids}" | tr -d '[:space:]'
}
# A deleted HealthImaging data store can stay readable with status DELETED, so
# "gone" is not-found OR DELETED. Polls up to 10 minutes for DELETING to settle.
assert_datastore_gone() { # usage: assert_datastore_gone <id> <description>
  local id="$1" desc="$2" status deadline
  deadline=$(( $(date +%s) + 600 ))
  while :; do
    if gone_probe aws medical-imaging get-datastore --region "${REGION}" --datastore-id "${id}"; then
      return 0
    fi
    status="$(ds_status "${id}")" || { echo "FAIL: could not read the status of ${id}" >&2; exit 1; }
    [ "${status}" = "DELETED" ] && return 0
    if [ "${status}" != "DELETING" ] || [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "FAIL: ${desc} (data store ${id} is ${status})" >&2
      exit 1
    fi
    sleep 15
  done
}
# Strict reads for assertions: a failed AWS read FAILs naming the read, rather
# than reading as a wrong value.
status_of() {
  local v
  v="$(ds_status "$1")" || { echo "FAIL: could not read the status of data store $1" >&2; exit 1; }
  printf '%s' "${v}"
}
tag_phase_of() {
  local v
  v="$(ds_tag_phase "$1")" || { echo "FAIL: could not read the tags of data store $1" >&2; exit 1; }
  printf '%s' "${v}"
}
strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Exact-name match (see DS_NAME), so this cannot widen to other data stores.
  for dsid in $(aws medical-imaging list-datastores --region "${REGION}" \
      --query "datastoreSummaries[?datastoreName=='${DS_NAME}' && datastoreStatus!='DELETED' && datastoreStatus!='DELETING'].datastoreId" \
      --output text 2>/dev/null); do
    aws medical-imaging delete-datastore --region "${REGION}" --datastore-id "${dsid}" >/dev/null 2>&1 || true
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

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' first" >&2; exit 1
fi

echo "==> Precondition: the caller can mint a DescribeType-denied identity"
if ! mint_denied_creds; then
  echo "FAIL: sts get-federation-token failed — this fixture needs IAM-USER credentials (a role session cannot call it) with sts:GetFederationToken" >&2
  exit 1
fi
assert_denied_identity
echo "    federated identity refuses cloudformation:DescribeType (AccessDenied)"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup
# cleanup only REQUESTS deletion. Wait for every earlier run's data store to
# settle, or Phase 1 would count a still-DELETING one as a second live store.
PRE_IDS="$(live_ids)" || { echo "FAIL: list-datastores failed after pre-run cleanup" >&2; exit 1; }
# One interrupted mid-CREATE is still CREATING, which refuses a delete: wait
# for it to settle (10 minutes), then delete it again.
for id in ${PRE_IDS}; do
  deadline=$(( $(date +%s) + 600 ))
  while :; do
    if gone_probe aws medical-imaging get-datastore --region "${REGION}" --datastore-id "${id}"; then
      PRE_STATUS="DELETED"; break
    fi
    PRE_STATUS="$(status_of "${id}")"
    [ "${PRE_STATUS}" = "CREATING" ] && [ "$(date +%s)" -lt "${deadline}" ] || break
    sleep 15
  done
  if [ "${PRE_STATUS}" = "ACTIVE" ]; then
    aws medical-imaging delete-datastore --region "${REGION}" --datastore-id "${id}" >/dev/null || {
      echo "FAIL: could not delete leftover data store ${id}" >&2; exit 1
    }
  fi
  assert_datastore_gone "${id}" "a data store from an earlier run did not delete"
done

# --- Phase 1: deploy ----------------------------------------------------
echo "==> Phase 1: deploy the data store (phase=baseline)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

DS_ID_P1="$(single_live_id)"
if [ "$(status_of "${DS_ID_P1}")" != "ACTIVE" ]; then
  echo "FAIL: data store ${DS_ID_P1} is not ACTIVE after Phase 1" >&2; exit 1
fi
if [ "$(tag_phase_of "${DS_ID_P1}")" != "baseline" ]; then
  echo "FAIL: data store ${DS_ID_P1} does not carry tag phase=baseline" >&2; exit 1
fi
echo "    created ${DS_ID_P1} (ACTIVE, phase=baseline)"

# The data store must be exactly as Phase 1 left it.
assert_untouched() { # usage: assert_untouched <phase label>
  local now
  now="$(single_live_id)"
  if [ "${now}" != "${DS_ID_P1}" ]; then
    echo "FAIL: $1: the data store changed (${DS_ID_P1} -> ${now}) although the deploy was refused" >&2; exit 1
  fi
  if [ "$(status_of "${DS_ID_P1}")" != "ACTIVE" ]; then
    echo "FAIL: $1: data store ${DS_ID_P1} is no longer ACTIVE" >&2; exit 1
  fi
  if [ "$(tag_phase_of "${DS_ID_P1}")" != "baseline" ]; then
    echo "FAIL: $1: data store ${DS_ID_P1} no longer carries phase=baseline" >&2; exit 1
  fi
}

# --- Phase 2: CONTROL — the caller's own identity takes the other guard -----
echo "==> Phase 2: control — with DescribeType allowed, the property-driven guard refuses"
set +e
CONTROL_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
CONTROL_RC=$?
set -e
CONTROL_PLAIN="$(printf '%s\n' "${CONTROL_OUT}" | strip_ansi)"
if [ "${CONTROL_RC}" -eq 0 ]; then
  echo "FAIL: Phase 2 deploy SUCCEEDED — no stateful guard fired for a create-only Tags change" >&2
  printf '%s\n' "${CONTROL_PLAIN}" >&2; exit 1
fi
if printf '%s\n' "${CONTROL_PLAIN}" | grep -qF "${LOOKUP_MARKER}"; then
  echo "FAIL: Phase 2 runs as the caller, but its create-only lookup failed — the caller lacks cloudformation:DescribeType, so the control proves nothing" >&2
  printf '%s\n' "${CONTROL_PLAIN}" >&2; exit 1
fi
if ! printf '%s\n' "${CONTROL_PLAIN}" | grep -qF "${PROPERTY_MARKER}"; then
  if printf '%s\n' "${CONTROL_PLAIN}" | grep -qF "${SHARED_MARKER}"; then
    echo "FAIL: Phase 2 was refused by a stateful guard, but not with '${PROPERTY_MARKER}' — the wording moved, or AWS no longer lists Tags as create-only" >&2
  else
    echo "FAIL: Phase 2 failed, but not with a stateful refusal" >&2
  fi
  printf '%s\n' "${CONTROL_PLAIN}" >&2; exit 1
fi
assert_untouched "Phase 2"
echo "    refused by the property-driven guard; data store untouched"

# --- Phase 3: denied identity, no flag — the update-failure guard refuses ---
echo "==> Phase 3: DescribeType denied — the update-failure guard refuses"
mint_denied_creds || { echo "FAIL: could not mint denied credentials for Phase 3" >&2; exit 1; }
assert_denied_identity
set +e
BLOCK_OUT="$(as_denied env CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
BLOCK_RC=$?
set -e
BLOCK_PLAIN="$(printf '%s\n' "${BLOCK_OUT}" | strip_ansi)"
if [ "${BLOCK_RC}" -eq 0 ]; then
  echo "FAIL: Phase 3 deploy SUCCEEDED without --force-stateful-recreation (the update-failure guard did not fire)" >&2
  printf '%s\n' "${BLOCK_PLAIN}" >&2; exit 1
fi
# The premise: the lookup failed and fell back to NOTHING (no snapshot entry).
# With a snapshot entry the change would be a replacement again, and this phase
# would be Phase 2 under another name.
if ! printf '%s\n' "${BLOCK_PLAIN}" | grep -qF "${LOOKUP_MARKER}"; then
  echo "FAIL: Phase 3 output does not show the failed create-only lookup ('${LOOKUP_MARKER}')" >&2
  printf '%s\n' "${BLOCK_PLAIN}" >&2; exit 1
fi
if ! printf '%s\n' "${BLOCK_PLAIN}" | grep -qF "${REGISTRY_ONLY_MARKER}"; then
  echo "FAIL: the create-only lookup did not fall back to the registry-only classification — ${TYPE} now has a committed snapshot entry, so this fixture no longer reaches the update-failure arm" >&2
  printf '%s\n' "${BLOCK_PLAIN}" >&2; exit 1
fi
if printf '%s\n' "${BLOCK_PLAIN}" | grep -qF "${PROPERTY_MARKER}"; then
  echo "FAIL: Phase 3 was refused by the PROPERTY-DRIVEN guard — the update-failure arm was not reached" >&2
  printf '%s\n' "${BLOCK_PLAIN}" >&2; exit 1
fi
if ! printf '%s\n' "${BLOCK_PLAIN}" | grep -qF "${ARM_MARKER}"; then
  if printf '%s\n' "${BLOCK_PLAIN}" | grep -qF "${SHARED_MARKER}"; then
    echo "FAIL: Phase 3 carries '${SHARED_MARKER}' but not '${ARM_MARKER}' — the update-failure refusal was reworded; update ARM_MARKER" >&2
  else
    echo "FAIL: Phase 3 failed, but not with the update-failure stateful refusal" >&2
  fi
  printf '%s\n' "${BLOCK_PLAIN}" >&2; exit 1
fi
if ! printf '%s\n' "${BLOCK_PLAIN}" | grep -F "${ARM_MARKER}" | grep -qF -- '--force-stateful-recreation'; then
  echo "FAIL: the Phase 3 refusal does not name --force-stateful-recreation" >&2
  printf '%s\n' "${BLOCK_PLAIN}" >&2; exit 1
fi
assert_untouched "Phase 3"
echo "    refused by the update-failure guard; data store untouched (${DS_ID_P1})"

# --- Phase 4: denied identity + flag — the fallback replaces ---------------
echo "==> Phase 4: DescribeType denied + --force-stateful-recreation — the fallback replaces"
mint_denied_creds || { echo "FAIL: could not mint denied credentials for Phase 4" >&2; exit 1; }
assert_denied_identity
set +e
FORCE_OUT="$(as_denied env CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force-stateful-recreation \
  --yes 2>&1)"
FORCE_RC=$?
set -e
FORCE_PLAIN="$(printf '%s\n' "${FORCE_OUT}" | strip_ansi)"
printf '%s\n' "${FORCE_PLAIN}"
if [ "${FORCE_RC}" -ne 0 ]; then
  echo "FAIL: Phase 4 deploy failed (rc=${FORCE_RC})" >&2; exit 1
fi
# The replacement must be the update-failure fallback's, not a property-driven
# one: only the fallback logs this line.
if ! printf '%s\n' "${FORCE_PLAIN}" | grep -qF "${REPLACING_MARKER}"; then
  echo "FAIL: Phase 4 output lacks '${REPLACING_MARKER}' — the replacement did not come from the update-failure fallback" >&2
  exit 1
fi
# The old id first: a replacement that left it DELETING would otherwise count
# as a second live data store below.
assert_datastore_gone "${DS_ID_P1}" "the OLD data store survived the forced replacement"
DS_ID_P4="$(single_live_id)"
if [ "${DS_ID_P4}" = "${DS_ID_P1}" ]; then
  echo "FAIL: the data store was NOT replaced (same id ${DS_ID_P1})" >&2; exit 1
fi
if [ "$(status_of "${DS_ID_P4}")" != "ACTIVE" ]; then
  echo "FAIL: replacement data store ${DS_ID_P4} is not ACTIVE" >&2; exit 1
fi
if [ "$(tag_phase_of "${DS_ID_P4}")" != "updated" ]; then
  echo "FAIL: replacement data store ${DS_ID_P4} does not carry phase=updated" >&2; exit 1
fi
echo "    replaced: ${DS_ID_P1} -> ${DS_ID_P4} (phase=updated), old gone"

# --- Phase 5: destroy -----------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_datastore_gone "${DS_ID_P4}" "data store still present after destroy"
REMAINING="$(live_ids)" || { echo "FAIL: list-datastores failed after destroy" >&2; exit 1; }
for id in ${REMAINING}; do
  assert_datastore_gone "${id}" "a data store named ${DS_NAME} is left after destroy"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    data store deleted, cdkd state removed"

echo "[verify] PASS — update-failure fallback stateful guard (#2515): property-driven control, update-failure refusal, forced replacement, destroy: all phases passed"
