#!/usr/bin/env bash
# verify.sh — cdkd Amazon Connect instance + chat-transcript storage config integ.
#
# Both types route through Cloud Control (no SDK provider), so this fixture is
# the live proof that the CC route deploys, updates in place, reads back clean
# and destroys them. It also prints how long each phase took, the number a user
# asking "how slow is a Connect instance under cdkd" wants.
#
# Phases:
#   1. Deploy: instance ACTIVE with inbound + outbound calls, contact-flow logs
#      off, transcripts under prefix `chat`.
#   2. Drift: both Connect resources report CLEAN.
#   3. UPDATE (CDKD_TEST_UPDATE=true): contact-flow logs on, prefix `chat-v2`;
#      both reach AWS and the instance id is unchanged (no replacement).
#   4. Destroy: instance, bucket and state file are gone.
#
# Account limit to keep in mind: Amazon Connect caps how many instances an
# account may create and delete within 30 days, so do not loop this fixture.
# The instance alias is a global URL and carries no region, so run this fixture
# in ONE region at a time.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdConnectInstanceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-connect-drift.$$.json"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
INSTANCE_ALIAS="cdkd-connect-${ACCOUNT}"
BUCKET_NAME="cdkd-connect-integ-${ACCOUNT}-${REGION}"

instance_id_by_alias() { # -> the instance id, or "None"
  # JSON, not --output text: text applies --query PER PAGE, so a second page
  # would print "None" beside the real id.
  local listing
  listing="$(aws connect list-instances --region "${REGION}" --output json)" || return 1
  jq -r --arg a "${INSTANCE_ALIAS}" 'first(.InstanceSummaryList[] | select(.InstanceAlias == $a) | .Id) // "None"' <<<"${listing}"
}

# Delete the leftover instance by alias, retrying, and wait until it is gone.
# Connect caps instance creates and deletes per account per 30 days, so a
# silently leaked instance costs future runs, not just money. Bounded at ~10 min.
reap_instance() {
  (
    set +eu
    LEFT_ID="$(instance_id_by_alias)" || { echo "WARN: cleanup could not list Connect instances — ${INSTANCE_ALIAS} may still exist and MUST be checked" >&2; exit 0; }
    [ "${LEFT_ID}" = "None" ] && exit 0
    DELETE_ERR=""
    for _ in $(seq 1 40); do
      DELETE_ERR="$(aws connect delete-instance --instance-id "${LEFT_ID}" --region "${REGION}" 2>&1 >/dev/null)" && break
      grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${DELETE_ERR}" && break
      sleep 15
    done
    # The alias is reused by the next deploy, so wait for the delete to settle.
    for _ in $(seq 1 60); do
      gone_probe aws connect describe-instance --instance-id "${LEFT_ID}" --region "${REGION}" && exit 0
      sleep 5
    done
    echo "WARN: cleanup could not delete Connect instance ${LEFT_ID} (${INSTANCE_ALIAS}) — it MUST be checked. Last AWS error: ${DELETE_ERR}" >&2
  )
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON}"
  # Exact names only; refuse the sweep when the account lookup came back empty.
  case "${ACCOUNT}" in
    [0-9]?*)
      reap_instance
      aws s3 rb "s3://${BUCKET_NAME}" --force --region "${REGION}" >/dev/null 2>&1 || true
      ;;
    *)
      echo "WARN: teardown sweep refused — account id '${ACCOUNT}' is not usable" >&2
      ;;
  esac
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
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
CLEANED_UP=0

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy the Connect instance + storage config"
T0="$(date +%s)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
DEPLOY_SECS=$(( $(date +%s) - T0 ))

INSTANCE_ID="$(instance_id_by_alias)"
if [ -z "${INSTANCE_ID}" ] || [ "${INSTANCE_ID}" = "None" ]; then
  echo "FAIL: no Connect instance with alias ${INSTANCE_ALIAS} after deploy" >&2
  exit 1
fi
STATUS="$(aws connect describe-instance --instance-id "${INSTANCE_ID}" --region "${REGION}" \
  --query 'join(`/`, [Instance.InstanceStatus, to_string(Instance.InboundCallsEnabled), to_string(Instance.OutboundCallsEnabled)])' --output text)"
if [ "${STATUS}" != "ACTIVE/true/true" ]; then
  echo "FAIL: instance status/inbound/outbound is '${STATUS}', expected ACTIVE/true/true" >&2
  exit 1
fi
flow_logs() {
  aws connect describe-instance-attribute --instance-id "${INSTANCE_ID}" --attribute-type CONTACTFLOW_LOGS \
    --region "${REGION}" --query 'Attribute.Value' --output text || return 1
}
transcript_target() { # -> "<count> <association-id> <bucket>/<prefix>"
  aws connect list-instance-storage-configs --instance-id "${INSTANCE_ID}" --resource-type CHAT_TRANSCRIPTS \
    --region "${REGION}" --output json \
    | jq -r '"\(.StorageConfigs | length) \(.StorageConfigs[0].AssociationId) \(.StorageConfigs[0].S3Config.BucketName)/\(.StorageConfigs[0].S3Config.BucketPrefix)"' \
    || return 1
}
if [ "$(flow_logs)" != "false" ]; then
  echo "FAIL: CONTACTFLOW_LOGS is '$(flow_logs)' after the baseline deploy, expected false" >&2
  exit 1
fi
TARGET_P1="$(transcript_target)"
read -r CONFIG_COUNT ASSOCIATION_ID TARGET <<<"${TARGET_P1}"
if [ "${CONFIG_COUNT}" != "1" ] || [ "${TARGET}" != "${BUCKET_NAME}/chat" ]; then
  echo "FAIL: chat transcript storage is '${TARGET_P1}', expected exactly one config at ${BUCKET_NAME}/chat" >&2
  exit 1
fi
echo "    instance ${INSTANCE_ID} ACTIVE, transcripts -> ${BUCKET_NAME}/chat (deploy took ${DEPLOY_SECS}s)"

# --- Phase 2: drift ----------------------------------------------------------
echo "==> Phase 2: cdkd drift reports both Connect resources clean"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null || true
if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}" 2>/dev/null)" != "yes" ]; then
  echo "FAIL: cdkd drift --json produced no stack report:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
connect_count() { # $1 = bucket (clean|drifted|notSupported)
  jq --arg b "$1" '[.[][$b][] | select(.type | startswith("AWS::Connect::"))] | length' "${DRIFT_JSON}"
}
if [ "$(connect_count drifted)" != "0" ] || [ "$(connect_count notSupported)" != "0" ] || [ "$(connect_count clean)" != "2" ]; then
  echo "FAIL: expected both Connect resources CLEAN; drifted=$(connect_count drifted) unknown=$(connect_count notSupported) clean=$(connect_count clean)" >&2
  jq '[.[] | {drifted, notSupported}]' "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    both Connect resources CLEAN"

# --- Phase 3: in-place UPDATE ------------------------------------------------
echo "==> Phase 3: turn on contact-flow logs and move the transcript prefix"
T0="$(date +%s)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
UPDATE_SECS=$(( $(date +%s) - T0 ))
if [ "$(instance_id_by_alias)" != "${INSTANCE_ID}" ]; then
  echo "FAIL: instance was REPLACED (${INSTANCE_ID} -> $(instance_id_by_alias))" >&2
  exit 1
fi
if [ "$(flow_logs)" != "true" ]; then
  echo "FAIL: CONTACTFLOW_LOGS is '$(flow_logs)' after the update, expected true" >&2
  exit 1
fi
# Same association, still one: the storage config was updated, not re-created.
if [ "$(transcript_target)" != "1 ${ASSOCIATION_ID} ${BUCKET_NAME}/chat-v2" ]; then
  echo "FAIL: chat transcript storage is '$(transcript_target)' after the update, expected '1 ${ASSOCIATION_ID} ${BUCKET_NAME}/chat-v2'" >&2
  exit 1
fi
echo "    updated in place: flow logs on, transcripts -> chat-v2 (update took ${UPDATE_SECS}s)"

# --- Phase 4: destroy --------------------------------------------------------
echo "==> Phase 4: destroy"
T0="$(date +%s)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
DESTROY_SECS=$(( $(date +%s) - T0 ))
# The delete may settle shortly after the call returns; bounded at ~5 min.
for _ in $(seq 1 60); do
  gone_probe aws connect describe-instance --instance-id "${INSTANCE_ID}" --region "${REGION}" && break
  sleep 5
done
assert_gone "Connect instance ${INSTANCE_ID} still exists after destroy" \
  aws connect describe-instance --instance-id "${INSTANCE_ID}" --region "${REGION}"
assert_gone "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_JSON}"
echo "[verify] PASS — Connect instance deployed (${DEPLOY_SECS}s), drift-clean, updated in place (${UPDATE_SECS}s), destroyed (${DESTROY_SECS}s)"
