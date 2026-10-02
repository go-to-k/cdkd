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
# Prints "<CreationTime> <Description> <StartingPosition>".
pipe_desc() {
  aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" \
    --query '[CreationTime, Description, SourceParameters.KinesisStreamParameters.StartingPosition]' --output text
}

echo "==> Deploy (base: LIGHT / v1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

B1=$(branding) || exit 1
read -r BID1 MODE1 <<<"${B1}"
[ "${MODE1}" = "LIGHT" ] || { echo "FAIL: base branding colorSchemeMode is '${MODE1}', expected LIGHT" >&2; exit 1; }
P1=$(pipe_desc) || exit 1
read -r PCT1 PDESC1 PSTART1 <<<"${P1}"
[ "${PDESC1}" = "v1" ] || { echo "FAIL: base pipe Description is '${PDESC1}', expected v1" >&2; exit 1; }
[ "${PSTART1}" = "LATEST" ] || { echo "FAIL: base pipe StartingPosition is '${PSTART1}', expected LATEST" >&2; exit 1; }
T1=$(action_tag) || exit 1
[ "${T1}" = "v1" ] || { echo "FAIL: base custom action tag is '${T1}', expected v1" >&2; exit 1; }
echo "    OK: base deployed (branding ${BID1} LIGHT; pipe v1 LATEST; custom action tag v1)"

echo "==> UPDATE (Settings LIGHT -> DARK, Description v1 -> v2, Tags v1 -> v2) — must land in place (#4416)"
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
read -r PCT2 PDESC2 PSTART2 <<<"${P2}"
[ "${PCT2}" = "${PCT1}" ] || { echo "FAIL: pipe was replaced (CreationTime ${PCT1} -> ${PCT2}), expected in place" >&2; exit 1; }
[ "${PDESC2}" = "v2" ] || { echo "FAIL: pipe Description after update is '${PDESC2}', expected v2" >&2; exit 1; }
[ "${PSTART2}" = "LATEST" ] || { echo "FAIL: pipe StartingPosition after update is '${PSTART2}', expected LATEST" >&2; exit 1; }
T2=$(action_tag) || exit 1
[ "${T2}" = "v2" ] || { echo "FAIL: custom action tag after update is '${T2}', expected v2" >&2; exit 1; }
echo "    OK: all updated in place (branding ${BID2} DARK; pipe v2, StartingPosition kept; custom action tag v2)"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Pipe delete is async (DELETING -> gone).
PGONE=""
for _ in $(seq 1 36); do
  if gone_probe aws pipes describe-pipe --name "${PIPE}" --region "${REGION}"; then PGONE=1; break; fi
  sleep 5
done
[ -z "${PGONE}" ] && { echo "FAIL: pipe ${PIPE} still exists after destroy" >&2; exit 1; }
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
