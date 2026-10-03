#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control UPDATE of a write-only key holding a
# create-only path (go-to-k/cdkd#4416).
# Deploys a Cognito ManagedLoginBranding (write-only + create-only ClientId),
# a Kinesis-source Pipe (write-only SourceParameters holding the create-only
# StartingPosition) and a CodePipeline CustomActionType (create-only Settings /
# ConfigurationProperties holding write-only leaves), then updates a MUTABLE
# property of each. Cloud Control refused all three updates while cdkd re-added
# the unchanged key ("createOnlyProperties [...] cannot be updated"). Asserts
# all three land in place (same ids, new values readable from AWS), then
# destroys clean.
#
# go-to-k/cdkd#4423: the pipe's UPDATE also changes the mutable
# `KinesisStreamParameters.BatchSize` beside the create-only StartingPosition,
# which Cloud Control cannot express at all, so the type gained an SDK
# provider. Before the UPDATE the pipe's record is rewritten to
# provisionedBy=cc-api -- what every pipe an earlier cdkd deployed carries --
# after asserting Cloud Control addresses the pipe by the SAME id cdkd stored.
# The UPDATE must then return the pipe to the SDK provider in place.

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

STACK="CdkdCcWriteOnlyCreateOnly"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="${STACK}-pool"
PIPE="${STACK}-pipe"
STREAM="${STACK}-src"
QUEUE="${STACK}-tgt"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# A deleted custom action version is never reusable: one per run, both deploys.
CDKD_ACTION_VERSION="r$(date +%s | tail -c 9)"
export CDKD_ACTION_VERSION
ACCOUNT=""

# The pool id by its exact name, or empty. `|| return 1` keeps a failed
# listing from reading as "no pool".
pool_id() {
  local out
  out=$(aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text) || return 1
  [ "${out}" = "None" ] && out=""
  printf '%s' "${out}"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${UPDATE_LOG:-}"
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws pipes delete-pipe --name "${PIPE}" --region "${REGION}" >/dev/null 2>&1
  P=$(pool_id 2>/dev/null)
  if [ -n "${P}" ]; then
    D=$(aws cognito-idp describe-user-pool --user-pool-id "${P}" --region "${REGION}" --query 'UserPool.Domain' --output text 2>/dev/null)
    [ -n "${D}" ] && [ "${D}" != "None" ] && aws cognito-idp delete-user-pool-domain --user-pool-id "${P}" --domain "${D}" --region "${REGION}" >/dev/null 2>&1
    aws cognito-idp delete-user-pool --user-pool-id "${P}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${ACCOUNT}" ]; then
    aws codepipeline delete-custom-action-type --category Test --provider CdkdWoCo --action-version "${CDKD_ACTION_VERSION}" --region "${REGION}" >/dev/null 2>&1
  fi
  aws kinesis delete-stream --stream-name "${STREAM}" --enforce-consumer-deletion --region "${REGION}" >/dev/null 2>&1
  Q=$(aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)
  [ -n "${Q}" ] && [ "${Q}" != "None" ] && aws sqs delete-queue --queue-url "${Q}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ACTION_ARN="arn:aws:codepipeline:${REGION}:${ACCOUNT}:actiontype:Custom/Test/CdkdWoCo/${CDKD_ACTION_VERSION}"

# Prints "<branding id> <colorSchemeMode>" for the pool's one client.
branding() {
  local p c out
  p=$(pool_id) || return 1
  [ -n "${p}" ] || { echo "FAIL: user pool ${POOL_NAME} not found" >&2; return 1; }
  c=$(aws cognito-idp list-user-pool-clients --user-pool-id "${p}" --region "${REGION}" \
    --query 'UserPoolClients[0].ClientId' --output text) || return 1
  out=$(aws cognito-idp describe-managed-login-branding-by-client --user-pool-id "${p}" --client-id "${c}" \
    --region "${REGION}" --query 'ManagedLoginBranding.[ManagedLoginBrandingId, Settings.categories.global.colorSchemeMode]' \
    --output text) || return 1
  printf '%s' "${out}"
}
# Prints the custom action's `phase` tag value.
action_tag() {
  aws codepipeline list-tags-for-resource --resource-arn "${ACTION_ARN}" --region "${REGION}" \
    --query "tags[?key=='phase'].value | [0]" --output text
}
# Prints "<CreationTime> <Description> <StartingPosition> <BatchSize>".
pipe_desc() {
  aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" \
    --query '[CreationTime, Description, SourceParameters.KinesisStreamParameters.StartingPosition, SourceParameters.KinesisStreamParameters.BatchSize]' --output text
}
PIPE_TYPE="AWS::Pipes::Pipe"
# Prints a jq path under the pipe's state record, or "" when absent.
pipe_record() {
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  echo "${state}" | jq -r --arg t "${PIPE_TYPE}" "[.resources | to_entries[] | select(.value.resourceType == \$t) | .value${1}] | first // \"\""
}

echo "==> Deploy (base: LIGHT / v1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

B1=$(branding) || exit 1
read -r BID1 MODE1 <<<"${B1}"
[ "${MODE1}" = "LIGHT" ] || { echo "FAIL: base branding colorSchemeMode is '${MODE1}', expected LIGHT" >&2; exit 1; }
P1=$(pipe_desc) || exit 1
read -r PCT1 PDESC1 PSTART1 PBATCH1 <<<"${P1}"
[ "${PDESC1}" = "v1" ] || { echo "FAIL: base pipe Description is '${PDESC1}', expected v1" >&2; exit 1; }
[ "${PSTART1}" = "LATEST" ] || { echo "FAIL: base pipe StartingPosition is '${PSTART1}', expected LATEST" >&2; exit 1; }
[ "${PBATCH1}" = "10" ] || { echo "FAIL: base pipe BatchSize is '${PBATCH1}', expected 10" >&2; exit 1; }
T1=$(action_tag) || exit 1
[ "${T1}" = "v1" ] || { echo "FAIL: base custom action tag is '${T1}', expected v1" >&2; exit 1; }
echo "    OK: base deployed (branding ${BID1} LIGHT; pipe v1 LATEST BatchSize 10; custom action tag v1)"

echo "==> Seed the pipe's record to provisionedBy=cc-api (#4423)"
PIPE_ID=$(pipe_record .physicalId) || exit 1
PIPE_LOGICAL=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg t "${PIPE_TYPE}" '[.resources | to_entries[] | select(.value.resourceType == $t) | .key] | first // ""')
[ -n "${PIPE_LOGICAL}" ] || { echo "FAIL: #4423 premise: no ${PIPE_TYPE} record in state" >&2; exit 1; }
[ "${PIPE_ID}" = "${PIPE}" ] || { echo "FAIL: #4423 premise: pipe physicalId is '${PIPE_ID}', expected '${PIPE}'" >&2; exit 1; }
PRE_LAYER=$(pipe_record .provisionedBy) || exit 1
[ "${PRE_LAYER}" = "sdk" ] || { echo "FAIL: #4423 premise: a fresh pipe is provisionedBy '${PRE_LAYER}', expected sdk" >&2; exit 1; }
# Parity, observed: Cloud Control reads the pipe by the id cdkd stored.
CC_ID=$(aws cloudcontrol get-resource --type-name "${PIPE_TYPE}" --identifier "${PIPE_ID}" \
  --region "${REGION}" --query 'ResourceDescription.Identifier' --output text)
[ "${CC_ID}" = "${PIPE_ID}" ] || { echo "FAIL: #4423: Cloud Control's identifier '${CC_ID}' differs from cdkd's physicalId '${PIPE_ID}'" >&2; exit 1; }
# Assignments, not argument substitutions, so a failed read or jq aborts here
# under `set -e` instead of uploading an empty state file.
SEED_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
SEEDED=$(echo "${SEED_STATE}" | jq --arg t "${PIPE_TYPE}" '.resources |= with_entries(if .value.resourceType == $t then .value.provisionedBy = "cc-api" else . end)')
printf '%s\n' "${SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
SEEDED_LAYER=$(pipe_record .provisionedBy) || exit 1
[ "${SEEDED_LAYER}" = "cc-api" ] || { echo "FAIL: #4423: seeding the pipe record to cc-api did not stick (got '${SEEDED_LAYER}')" >&2; exit 1; }
echo "    OK: Cloud Control addresses the pipe by cdkd's physicalId; record seeded to cc-api"

echo "==> UPDATE (Settings LIGHT -> DARK, Description v1 -> v2, BatchSize 10 -> 5, Tags v1 -> v2) — must land in place (#4416, #4423)"
UPDATE_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${UPDATE_LOG}" 2>&1
UPDATE_RC=$?
set -e
cat "${UPDATE_LOG}"
if grep -q "cannot be updated" "${UPDATE_LOG}"; then
  echo "FAIL: Cloud Control refused the patch on a create-only path (#4416 regression)" >&2
  exit 1
fi
[ "${UPDATE_RC}" -eq 0 ] || { echo "FAIL: UPDATE deploy exited ${UPDATE_RC}" >&2; exit 1; }

B2=$(branding) || exit 1
read -r BID2 MODE2 <<<"${B2}"
[ "${BID2}" = "${BID1}" ] || { echo "FAIL: branding was replaced (${BID1} -> ${BID2}), expected in place" >&2; exit 1; }
[ "${MODE2}" = "DARK" ] || { echo "FAIL: branding colorSchemeMode after update is '${MODE2}', expected DARK" >&2; exit 1; }
P2=$(pipe_desc) || exit 1
read -r PCT2 PDESC2 PSTART2 PBATCH2 <<<"${P2}"
[ "${PCT2}" = "${PCT1}" ] || { echo "FAIL: pipe was replaced (CreationTime ${PCT1} -> ${PCT2}), expected in place" >&2; exit 1; }
[ "${PDESC2}" = "v2" ] || { echo "FAIL: pipe Description after update is '${PDESC2}', expected v2" >&2; exit 1; }
[ "${PSTART2}" = "LATEST" ] || { echo "FAIL: pipe StartingPosition after update is '${PSTART2}', expected LATEST" >&2; exit 1; }
[ "${PBATCH2}" = "5" ] || { echo "FAIL: pipe BatchSize after update is '${PBATCH2}', expected 5 (#4423)" >&2; exit 1; }
POST_LAYER=$(pipe_record .provisionedBy) || exit 1
POST_ID=$(pipe_record .physicalId) || exit 1
[ "${POST_LAYER}" = "sdk" ] || { echo "FAIL: #4423: the cc-api pipe record did not flip to sdk (got '${POST_LAYER}')" >&2; exit 1; }
[ "${POST_ID}" = "${PIPE_ID}" ] || { echo "FAIL: #4423: the flip changed the physicalId (${PIPE_ID} -> ${POST_ID})" >&2; exit 1; }
UPDATE_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${UPDATE_LOG}")"
# Sentinel: a flip with no line means the wording drifted.
if ! grep -qF "${PIPE_LOGICAL} (${PIPE_TYPE}): moving to the SDK provider" <<<"${UPDATE_PLAIN}"; then
  echo "FAIL: #4423: the record flipped, but no 'moving to the SDK provider' line names ${PIPE_LOGICAL} -- the wording drifted" >&2
  exit 1
fi
T2=$(action_tag) || exit 1
[ "${T2}" = "v2" ] || { echo "FAIL: custom action tag after update is '${T2}', expected v2" >&2; exit 1; }
echo "    OK: all updated in place (branding ${BID2} DARK; pipe v2 BatchSize 5 on the SDK provider, StartingPosition kept; custom action tag v2)"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Pipe delete is async (DELETING -> gone), and the SDK provider's delete waits
# for it (#4423): the pipe is already gone the moment destroy returns.
assert_gone "pipe ${PIPE} still exists right after destroy (the delete did not wait for DELETING to end)" \
  aws pipes describe-pipe --name "${PIPE}" --region "${REGION}"
LEFT=$(pool_id) || exit 1
[ -z "${LEFT}" ] || { echo "FAIL: user pool ${POOL_NAME} (${LEFT}) still exists after destroy" >&2; exit 1; }
SGONE=""
for _ in $(seq 1 36); do
  if gone_probe aws kinesis describe-stream-summary --stream-name "${STREAM}" --region "${REGION}"; then SGONE=1; break; fi
  sleep 5
done
[ -z "${SGONE}" ] && { echo "FAIL: stream ${STREAM} still exists after destroy" >&2; exit 1; }
assert_gone "custom action ${CDKD_ACTION_VERSION} remains" aws codepipeline list-tags-for-resource --resource-arn "${ACTION_ARN}" --region "${REGION}"
assert_gone "queue ${QUEUE} remains" aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: pipe, user pool, custom action, stream, queue and state gone"
echo ""
echo "==> cc-write-only-create-only test passed"
