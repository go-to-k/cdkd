#!/usr/bin/env bash
# verify.sh — go-to-k/cdkd#6097 against real AWS: a CDK `fn.currentVersion`
# after a code change, and an API Gateway deployment after a method change, are
# NEW resources whose own properties match the old ones'. `cdkd diff` must not
# advise `cdkd refactor` for them, `cdkd refactor` must not rename them, and the
# deploy must publish the new version and the new deployment.
#
# Phases:
#   1. Deploy generation "a"; record alias version N and the stage deployment.
#   2. Under generation "b" (CDKD_TEST_UPDATE=true):
#      a. `cdkd diff` shows both removals, neither with a `moved to` hint.
#      b. `cdkd refactor --dry-run` reports both as not refactored, naming the
#         changed reference; `cdkd refactor --yes` leaves the state ETag as is.
#      c. `cdkd deploy`: alias on N+1 returning code 'b'; stage on a new
#         deployment, the old one deleted.
#   3. Destroy; the function, the API and the state record are gone.
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

STACK="CdkdRefactorLambdaVersionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-refactor-lambda-version-fn"
API_NAME="cdkd-refactor-lambda-version-api"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cdkd() { node "${LOCAL_DIST}" "$@"; }
STATE_FLAGS=(--state-bucket "${STATE_BUCKET:-}" --region "${REGION}")

# The state ETag (quotes included), or "absent".
state_etag() {
  local out
  if out="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
      --query ETag --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    printf 'absent'
    return 0
  fi
  echo "FAIL: head-object undetermined: ${out}" >&2
  return 1
}

# The logical id of the ONE state resource of type $1.
logical_id_of_type() { # usage: logical_id_of_type <resource-type> <resources-listing>
  local matches
  matches="$(printf '%s\n' "$2" | awk -v t="$1" '$2 == t { print $1 }')"
  if [ "$(printf '%s\n' "${matches}" | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one state resource of type $1, got: ${matches:-<none>}" >&2
    return 1
  fi
  printf '%s' "${matches}"
}

# What the alias `live` returns when invoked.
invoke_live() {
  local out_file="${WORK_DIR}/invoke.json"
  aws lambda invoke --function-name "${FN_NAME}" --qualifier live --region "${REGION}" \
    "${out_file}" >/dev/null || return 1
  cat "${out_file}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" --region "${REGION}" >/dev/null 2>&1
  for id in $(aws apigateway get-rest-apis --region "${REGION}" \
      --query "items[?name=='${API_NAME}'].id" --output text 2>/dev/null); do
    [ "${id}" != "None" ] && aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1
  done
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" \
      --output text 2>/dev/null); do
    case "${role}" in
      "${STACK}-"?*)
        for p in $(aws iam list-attached-role-policies --role-name "${role}" \
            --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
          aws iam detach-role-policy --role-name "${role}" --policy-arn "${p}" >/dev/null 2>&1
        done
        aws iam delete-role --role-name "${role}" >/dev/null 2>&1
        ;;
    esac
  done
  # Unset until the pre-run cleanup has run (see below).
  [ -n "${WORK_DIR:-}" ] && rm -rf "${WORK_DIR}"
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

# Made AFTER the pre-run cleanup, which would otherwise remove it.
WORK_DIR="$(mktemp -d)"

# --- Phase 1: deploy generation "a" ------------------------------------------
echo "==> Phase 1: deploy generation a"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RES_A="$(cdkd state resources "${STACK}" "${STATE_FLAGS[@]}")"
OLD_VERSION_ID="$(logical_id_of_type AWS::Lambda::Version "${RES_A}")"
OLD_DEPLOYMENT_ID="$(logical_id_of_type AWS::ApiGateway::Deployment "${RES_A}")"
API_ID="$(printf '%s\n' "${RES_A}" | awk '$2 == "AWS::ApiGateway::RestApi" { print $3 }')"
[ -n "${API_ID}" ] || { echo "FAIL: no AWS::ApiGateway::RestApi in state" >&2; exit 1; }

VERSION_A="$(aws lambda get-alias --function-name "${FN_NAME}" --name live --region "${REGION}" \
  --query FunctionVersion --output text)"
case "${VERSION_A}" in
  ''|*[!0-9]*) echo "FAIL: alias live is on '${VERSION_A}', not a published version" >&2; exit 1 ;;
esac
OUT_A="$(invoke_live)"
case "${OUT_A}" in
  *'"code":"a"'*) ;;
  *) echo "FAIL: alias live returned ${OUT_A}, expected code a" >&2; exit 1 ;;
esac
STAGE_DEPLOYMENT_A="$(aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name live \
  --region "${REGION}" --query deploymentId --output text)"
echo "    alias live on version ${VERSION_A}; stage live on deployment ${STAGE_DEPLOYMENT_A}"
echo "    old logical ids: ${OLD_VERSION_ID}, ${OLD_DEPLOYMENT_ID}"

# --- Phase 2: generation "b" -------------------------------------------------
export CDKD_TEST_UPDATE=true

echo "==> Phase 2a: diff shows both removals, with no refactor hint"
OUT_2A="$(cdkd diff "${STACK}" "${STATE_FLAGS[@]}" 2>&1)"
printf '%s\n' "${OUT_2A}"
for id in "${OLD_VERSION_ID}" "${OLD_DEPLOYMENT_ID}"; do
  ROW="$(printf '%s\n' "${OUT_2A}" | grep -F "[-] ${id} " || true)"
  # Sentinel: the removal row itself must be there, or "no hint" proves nothing.
  [ -n "${ROW}" ] || { echo "FAIL: diff shows no removal row for ${id}" >&2; exit 1; }
  case "${ROW}" in
    *"moved to"*) echo "FAIL: diff advises a refactor for ${id}, a new resource: ${ROW}" >&2; exit 1 ;;
  esac
done
echo "    no 'moved to' hint on ${OLD_VERSION_ID} or ${OLD_DEPLOYMENT_ID}"

echo "==> Phase 2b: cdkd refactor leaves both, and writes nothing"
ETAG_BEFORE="$(state_etag)"
OUT_2B="$(cdkd refactor "${STACK}" "${STATE_FLAGS[@]}" --dry-run 2>&1)"
printf '%s\n' "${OUT_2B}"
for id in "${OLD_VERSION_ID}" "${OLD_DEPLOYMENT_ID}"; do
  printf '%s\n' "${OUT_2B}" | grep -E "Not refactored: ${id} -> .* also changes the resource it references, " >/dev/null \
    || { echo "FAIL: refactor --dry-run does not report ${id} as not refactored for a changed reference" >&2; exit 1; }
done
if printf '%s\n' "${OUT_2B}" | grep -E "^  ${OLD_VERSION_ID} -> |^  ${OLD_DEPLOYMENT_ID} -> " >/dev/null; then
  echo "FAIL: refactor --dry-run plans a rename of a new resource" >&2
  exit 1
fi
cdkd refactor "${STACK}" "${STATE_FLAGS[@]}" --yes
ETAG_AFTER="$(state_etag)"
[ "${ETAG_BEFORE}" = "${ETAG_AFTER}" ] \
  || { echo "FAIL: cdkd refactor rewrote state (${ETAG_BEFORE} -> ${ETAG_AFTER})" >&2; exit 1; }
echo "    state ETag unchanged (${ETAG_AFTER})"

echo "==> Phase 2c: deploy publishes a new version and a new deployment"
cdkd deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
VERSION_B="$(aws lambda get-alias --function-name "${FN_NAME}" --name live --region "${REGION}" \
  --query FunctionVersion --output text)"
[ "${VERSION_B}" = "$((VERSION_A + 1))" ] \
  || { echo "FAIL: alias live on ${VERSION_B} after the code change, expected $((VERSION_A + 1))" >&2; exit 1; }
OUT_B="$(invoke_live)"
case "${OUT_B}" in
  *'"code":"b"'*) ;;
  *) echo "FAIL: alias live returned ${OUT_B} after the deploy, expected code b" >&2; exit 1 ;;
esac
STAGE_DEPLOYMENT_B="$(aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name live \
  --region "${REGION}" --query deploymentId --output text)"
[ "${STAGE_DEPLOYMENT_B}" != "${STAGE_DEPLOYMENT_A}" ] \
  || { echo "FAIL: stage live still on deployment ${STAGE_DEPLOYMENT_A} after the method change" >&2; exit 1; }
assert_gone "old deployment ${STAGE_DEPLOYMENT_A} still exists after the deploy" \
  aws apigateway get-deployment --rest-api-id "${API_ID}" --deployment-id "${STAGE_DEPLOYMENT_A}" --region "${REGION}"
echo "    alias live on version ${VERSION_B} (code b); stage live on deployment ${STAGE_DEPLOYMENT_B}"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
cdkd destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
trap - EXIT INT TERM
# The alias invocations created the function's log group; no stack owns it.
# Removed before the assertions, which exit on a failure.
aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
rm -rf "${WORK_DIR}"

assert_gone "function ${FN_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "rest api ${API_ID} still exists after destroy" \
  aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    function, API and cdkd state removed"

echo "[verify] PASS — a new Lambda version and API deployment are never refactored into the old ones; the deploy publishes both"
