#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6499.
#
# An AWS::Events::Connection (Cloud Control routed) keeps its API key at the
# write-only AuthParameters/ApiKeyAuthParameters/ApiKeyValue, nested under the
# readable AuthParameters. `cdkd drift --revert` sent the readback's
# AuthParameters, which lacks the key, and Cloud Control refused the model:
#   #/AuthParameters/ApiKeyAuthParameters: required key [ApiKeyValue] not found
# so no revert of a connection could succeed, whatever drifted.
#
# Two connections: PlainConn's key is a literal; SecretConn's key is a
# {{resolve:secretsmanager:...}} dynamic reference, which the revert must
# resolve, never send as text.
#
# Phases:
#   1. Deploy. Premise: both connections are Cloud Control provisioned and
#      their baselines hold no ApiKeyValue.
#   2. `cdkd drift` exits 0.
#   3. Change both descriptions OUT OF BAND.
#   4. `cdkd drift` exits 1 and names both.
#   5. `cdkd drift --revert -y` exits 0; both descriptions are back, and the
#      key each connection stores is the template's value (the resolved
#      secret for SecretConn, not the {{resolve:...}} text).
#   6. `cdkd drift` exits 0 again.
#   7. Destroy + gone-probes + the state bucket's object versions swept (the
#      template carries an unsafePlainText key).
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
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdDriftRevertNestedWriteOnlyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
PLAIN_ID="PlainConnConnection082B58BA"
SECRET_ID="SecretConnConnection8E194AA8"
DRIFT_LOG=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" noncurrent || true
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

run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  rm -f "${DRIFT_LOG:-}"
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
expect_drift_rc() { # usage: expect_drift_rc <want> <phase label>
  if [ "${DRIFT_RC}" != "$1" ]; then
    echo "FAIL: $2: cdkd drift exited ${DRIFT_RC}, want $1" >&2
    exit 1
  fi
}
expect_descriptions() { # usage: expect_descriptions <want> <phase label>
  local p s
  p="$(aws events describe-connection --name "${PLAIN_NAME}" --query Description --output text)" || return 1
  s="$(aws events describe-connection --name "${SECRET_NAME}" --query Description --output text)" || return 1
  if [ "${p}" != "$1" ] || [ "${s}" != "$1" ]; then
    echo "FAIL: $2: want both descriptions '$1', got '${p}' and '${s}'" >&2
    exit 1
  fi
  echo "    ok: $2: both descriptions '$1'"
}
expect_stored_key() { # usage: expect_stored_key <connection name> <want> <phase label>
  local arn stored
  arn="$(aws events describe-connection --name "$1" --query SecretArn --output text)" || return 1
  stored="$(aws secretsmanager get-secret-value --secret-id "${arn}" --query SecretString --output text)" || return 1
  # The values are this fixture's own test literals; compared, never printed.
  if [ "$(jq -r '.api_key_value // empty' <<<"${stored}")" != "$2" ]; then
    echo "FAIL: $3: connection $1 does not store the template's API key" >&2
    exit 1
  fi
  echo "    ok: $3: connection $1 stores the template's API key"
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
PLAIN_NAME="$(jq -r --arg id "${PLAIN_ID}" '.resources[$id].physicalId // empty' <<<"${STATE_JSON}")"
SECRET_NAME="$(jq -r --arg id "${SECRET_ID}" '.resources[$id].physicalId // empty' <<<"${STATE_JSON}")"
KEY_SECRET_ARN="$(jq -r '.resources.KeySecret2DA13121.physicalId // empty' <<<"${STATE_JSON}")"
if [ -z "${PLAIN_NAME}" ] || [ -z "${SECRET_NAME}" ] || [ -z "${KEY_SECRET_ARN}" ]; then
  echo "FAIL: Phase 1: the state lacks a connection or key secret record" >&2
  exit 1
fi
# Premise: Cloud Control provisioned, and the baseline (the read) holds no
# ApiKeyValue. Without both this run proves nothing.
for id in "${PLAIN_ID}" "${SECRET_ID}"; do
  if [ "$(jq -r --arg id "${id}" '.resources[$id].provisionedBy // empty' <<<"${STATE_JSON}")" != "cc-api" ]; then
    echo "FAIL: premise: ${id} is not Cloud Control provisioned" >&2
    exit 1
  fi
  if [ "$(jq -r --arg id "${id}" '.resources[$id].observedProperties.AuthParameters.ApiKeyAuthParameters | has("ApiKeyValue")' <<<"${STATE_JSON}")" != "false" ]; then
    echo "FAIL: premise: ${id}'s baseline is not an AuthParameters without ApiKeyValue" >&2
    exit 1
  fi
done
expect_stored_key "${PLAIN_NAME}" plain-key-1 "Phase 1"
expect_stored_key "${SECRET_NAME}" secret-key-1 "Phase 1"

echo "==> Phase 2: cdkd drift on the fresh stack reports no drift"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: change both descriptions out of band"
aws events update-connection --name "${PLAIN_NAME}" --description oob >/dev/null
aws events update-connection --name "${SECRET_NAME}" --description oob >/dev/null
expect_descriptions oob "Phase 3"

echo "==> Phase 4: cdkd drift reports both connections"
run_drift
expect_drift_rc 1 "Phase 4"
for id in "${PLAIN_ID}" "${SECRET_ID}"; do
  if ! grep -qF "${id} (AWS::Events::Connection)" "${DRIFT_LOG}"; then
    echo "FAIL: Phase 4: no drift block for ${id} — the report wording drifted" >&2
    exit 1
  fi
done

echo "==> Phase 5: cdkd drift --revert -y reverts both, keys intact"
run_drift --revert -y
expect_drift_rc 0 "Phase 5"
if grep -q 'secret-key-1\|plain-key-1' "${DRIFT_LOG}"; then
  echo "FAIL: Phase 5: the revert output prints an API key" >&2
  exit 1
fi
expect_descriptions integ "Phase 5"
expect_stored_key "${PLAIN_NAME}" plain-key-1 "Phase 5"
expect_stored_key "${SECRET_NAME}" secret-key-1 "Phase 5"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "connection ${PLAIN_NAME} leaked" aws events describe-connection --name "${PLAIN_NAME}"
assert_gone "connection ${SECRET_NAME} leaked" aws events describe-connection --name "${SECRET_NAME}"
# ForceDeleteWithoutRecovery is asynchronous: poll the strict gone-probe.
SECRET_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret --secret-id "${KEY_SECRET_ARN}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" != "1" ]; then
  echo "FAIL: key secret ${KEY_SECRET_ARN} leaked" >&2
  exit 1
fi
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"
echo "PASS: drift-revert-nested-write-only"
