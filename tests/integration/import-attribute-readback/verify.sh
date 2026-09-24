#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd import --migrate-from-cloudformation`
# records the attribute maps `create()` records (issue #3627) for
# AWS::SNS::Topic, AWS::DynamoDB::Table, AWS::IAM::Role and
# AWS::Lambda::EventSourceMapping.
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. `cdk deploy` the stack (the existing CloudFormation stack to migrate).
#   3. `cdkd import --migrate-from-cloudformation --yes`.
#   4. Assert: no "Failed to resolve intrinsics" / "Unknown attribute" line, and
#      each SSM parameter's imported `Value` equals what AWS reports for the
#      attribute its `Fn::GetAtt` names.
#   5. `cdkd deploy` (no template change): assert no "Unknown attribute" line
#      and no resource updated.
#   6. `cdkd destroy --force`; gone-probes for every resource and the state.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-attribute-readback"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportAttributeReadback"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Captured after `cdk deploy`; empty until then so cleanup can read them under
# `set -u` when it fires earlier.
TOPIC_ARN=""
TABLE_NAME=""
ROLE_NAME=""
FN_NAME=""
ESM_UUID=""
PARAMS=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-attr-readback.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${STACK}"
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1) || true
  fi
  if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  # Retained resources survive a CFn delete after the import's Retain
  # injection, so reap them by the ids captured after `cdk deploy`.
  [ -n "${ESM_UUID}" ] && aws lambda delete-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${FN_NAME}" ] && aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" 2>/dev/null
  for n in ${PARAMS}; do
    aws ssm delete-parameter --name "${n}" --region "${REGION}" 2>/dev/null
  done
  [ -n "${TOPIC_ARN}" ] && aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" 2>/dev/null
  [ -n "${TABLE_NAME}" ] && aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${ROLE_NAME}" ]; then
    for p in $(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${p}" 2>/dev/null
    done
    for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" \
      --query 'PolicyNames' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" 2>/dev/null
    done
    aws iam delete-role --role-name "${ROLE_NAME}" 2>/dev/null
  fi
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" 2>/dev/null
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
(cd "${TEST_DIR}" && { [ -x node_modules/.bin/cdk ] || npm install; })
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
CDK_RESOLVED="$(command -v cdk)"
CDK_VERSION="$(cdk --version)"
echo "[verify] step 1 ok: using ${CDK_RESOLVED} (${CDK_VERSION})"

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists — clean up first"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${STATE_KEY} already exists — clean up first"
  exit 1
fi

echo "[verify] step 3: cdk deploy (the CloudFormation stack to migrate)"
(cd "${TEST_DIR}" && cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}")

physical_of() {
  aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
    --query "StackResources[?LogicalResourceId==\`$1\`].PhysicalResourceId" --output text
}
TOPIC_ARN="$(physical_of Topic)"
TABLE_NAME="$(physical_of Table)"
ROLE_NAME="$(physical_of Role)"
FN_NAME="$(physical_of Fn9270CBC0)"
ESM_UUID="$(physical_of Esm)"
for l in TopicNameParam StreamArnParam RoleIdParam RoleArnParam EsmArnParam; do
  PARAMS="${PARAMS} $(physical_of "${l}")"
done
WANT_TOPIC_NAME="${TOPIC_ARN##*:}"
WANT_STREAM_ARN="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" --query Table.LatestStreamArn --output text)"
WANT_ROLE_ID="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.RoleId --output text)"
WANT_ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
WANT_ESM_ARN="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" --query EventSourceMappingArn --output text)"
case "${WANT_ROLE_ARN}" in
  *:role/cdkd-integ/*) ;;
  *) echo "[verify] FAIL: the role has no non-/ Path, so the Arn row cannot discriminate: '${WANT_ROLE_ARN}'"; exit 1 ;;
esac
case "${TOPIC_ARN}" in
  arn:*) ;;
  *) echo "[verify] FAIL: CloudFormation's topic physical id is not an ARN: '${TOPIC_ARN}'"; exit 1 ;;
esac
echo "[verify] step 3 ok: topic=${TOPIC_ARN} table=${TABLE_NAME} role=${WANT_ROLE_ARN} esm=${ESM_UUID}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes) 2>&1 | tee "${WORK}/import.log"
# Recorded, not exited on: step 5 then reports EVERY row, so one failing type
# cannot hide whether the others were fixed.
IMPORT_FAILED=0
if grep -q 'Failed to resolve intrinsics' "${WORK}/import.log"; then
  echo "[verify] FAIL: import left an unresolved intrinsic (issue #3627)"
  IMPORT_FAILED=1
fi
if grep -q 'Unknown attribute' "${WORK}/import.log"; then
  echo "[verify] FAIL: import fell back to the physical id for an attribute (issue #3627)"
  IMPORT_FAILED=1
fi

echo "[verify] step 5: assert the imported parameter records carry AWS's values"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
python3 - "${WORK}/state.json" "${WANT_TOPIC_NAME}" "${WANT_STREAM_ARN}" "${WANT_ROLE_ID}" "${WANT_ROLE_ARN}" "${WANT_ESM_ARN}" <<'PY'
import json, sys
res = json.load(open(sys.argv[1]))["resources"]
want = dict(zip(
    ["TopicNameParam", "StreamArnParam", "RoleIdParam", "RoleArnParam", "EsmArnParam"],
    sys.argv[2:],
))
got = {k: res.get(k, {}).get("properties", {}).get("Value") for k in want}
bad = [f"{k}.properties.Value: got {got[k]!r}, want {v!r}" for k, v in want.items() if got[k] != v]
if bad:
    print("[verify] FAIL:\n  " + "\n  ".join(bad))
    sys.exit(1)
print("[verify] step 5 ok: " + ", ".join(want))
PY
[ "${IMPORT_FAILED}" = 0 ] || exit 1

echo "[verify] step 6: cdkd deploy with an unchanged template"
(cd "${TEST_DIR}" && ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}") 2>&1 | tee "${WORK}/deploy.log"
if grep -q 'Unknown attribute' "${WORK}/deploy.log"; then
  echo "[verify] FAIL: deploy fell back to the physical id for an attribute (issue #3627)"
  exit 1
fi
# cdkd colours every resource line, so strip ANSI before matching the row.
# A metadata-only row counts too: the import records the template's policies
# (issue #3645), so the first deploy has none to write.
if sed 's/\x1b\[[0-9;]*m//g' "${WORK}/deploy.log" | grep -qE '✓ .* updated'; then
  echo "[verify] FAIL: an unchanged deploy updated a resource the import should have recorded resolved"
  exit 1
fi
echo "[verify] step 6 ok"

echo "[verify] step 7: cdkd destroy --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
assert_gone "event source mapping ${ESM_UUID} still exists after destroy" aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}"
assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
# DeleteTable is asynchronous: poll until the table is gone.
table_gone=0
for _ in $(seq 1 60); do
  if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
    table_gone=1
    break
  fi
  sleep 5
done
[ "${table_gone}" = 1 ] || { echo "FAIL: table ${TABLE_NAME} still exists 5 minutes after destroy" >&2; exit 1; }
assert_gone "topic ${TOPIC_ARN} still exists after destroy" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
for n in ${PARAMS}; do
  assert_gone "parameter ${n} still exists after destroy" aws ssm get-parameter --name "${n}" --region "${REGION}"
done
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 7 ok: resources and state gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
