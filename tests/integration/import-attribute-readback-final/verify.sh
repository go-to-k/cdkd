#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd import --migrate-from-cloudformation`
# records the attribute maps `create()` records (issue #3627, last batch):
# StepFunctions Name / StateMachineRevisionId, WAFv2 WebACL Id / LabelNamespace
# (and that the import accepts CloudFormation's `name|id|scope` id at all),
# Cognito UserPool ProviderName / ProviderURL, RDS DBCluster endpoints, and
# S3 Vectors VectorBucketArn (CloudFormation's id is the ARN).
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. Pre-flight orphan scan.
#   3. `cdk deploy` the stack, capturing CloudFormation's resolved values as the
#      oracle (the SSM parameters it wrote).
#   4. `cdkd import --migrate-from-cloudformation --yes`; no resource may be
#      left not-found or failed.
#   5. Assert each imported SSM parameter record equals the oracle.
#   6. `cdkd deploy` (no template change): nothing updated, no "Unknown attribute".
#   7. `cdkd destroy --force`; gone-probes for the state and the key resources.
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
TEST_DIR="${REPO_ROOT}/tests/integration/import-attribute-readback-final"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportAttrReadbackFinal"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-attr-final.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The import writes cdkd state BEFORE it retires the CloudFormation stack, so
# at every point one of the two owns every resource: destroy through whichever
# holds them.
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
MACHINE_ARN="$(physical_of Machine)"
ACL_ID_COMPOUND="$(physical_of Acl)"
POOL_ID="$(physical_of Pool)"
DB_ID="$(physical_of Db)"
VECTORS_ID="$(physical_of Vectors)"
# An empty id would reach a probe as an empty argument, which the aws CLI can
# wait on instead of rejecting.
for pair in "Machine=${MACHINE_ARN}" "Acl=${ACL_ID_COMPOUND}" "Pool=${POOL_ID}" "Db=${DB_ID}" "Vectors=${VECTORS_ID}"; do
  case "${pair#*=}" in
    ""|None) echo "[verify] FAIL: could not resolve the physical id of ${pair%%=*}"; exit 1 ;;
  esac
done
# The oracle is what CloudFormation ITSELF resolved each `Fn::GetAtt` to: the
# SSM parameters `cdk deploy` just wrote. Deriving the expected value here would
# restate cdkd's own derivation and pass whatever it computes.
python3 - "${WORK}/expected.json" <<'PY'
import json, subprocess, sys
names = ["MachineNameParam", "MachineRevisionParam", "AclIdParam", "AclLabelNamespaceParam",
         "PoolProviderNameParam", "PoolProviderUrlParam", "DbEndpointParam", "DbPortParam",
         "DbReadEndpointParam", "VectorsArnParam"]
def aws(*args):
    return subprocess.run(["aws", *args], check=True, capture_output=True, text=True).stdout.strip()
out = {}
for logical in names:
    physical = aws("cloudformation", "describe-stack-resource", "--stack-name", "CdkdImportAttrReadbackFinal",
                   "--logical-resource-id", logical, "--query", "StackResourceDetail.PhysicalResourceId",
                   "--output", "text")
    out[logical] = aws("ssm", "get-parameter", "--name", physical, "--query", "Parameter.Value", "--output", "text")
json.dump(out, open(sys.argv[1], "w"), indent=2)
PY
echo "[verify] step 3 ok: expected values captured"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes) 2>&1 | tee "${WORK}/import.log"
# Recorded, not exited on: step 5 then reports EVERY row.
IMPORT_FAILED=0
if grep -q 'Failed to resolve intrinsics' "${WORK}/import.log"; then
  echo "[verify] FAIL: import left an unresolved intrinsic (issue #3627)"
  IMPORT_FAILED=1
fi
# The WAFv2 import THREW on CloudFormation's `name|id|scope` id before the fix,
# so a resource left unadopted is a failure too.
if ! sed 's/\x1b\[[0-9;]*m//g' "${WORK}/import.log" | grep -E '^Summary: ' | tail -1 | grep -q ' 0 not found.* 0 failed'; then
  echo "[verify] FAIL: the import did not adopt every resource (issue #3627)"
  IMPORT_FAILED=1
fi
if grep -q 'Unknown attribute' "${WORK}/import.log"; then
  echo "[verify] FAIL: import fell back to the physical id for an attribute (issue #3627)"
  IMPORT_FAILED=1
fi

echo "[verify] step 5: assert the imported parameter records carry AWS's values"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
python3 - "${WORK}/state.json" "${WORK}/expected.json" <<'PY'
import json, sys
res = json.load(open(sys.argv[1]))["resources"]
want = json.load(open(sys.argv[2]))
empty = [k for k, v in want.items() if v in ("", "None", "null")]
if empty:
    print("[verify] FAIL: could not read the expected value for: " + ", ".join(empty))
    sys.exit(1)
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
if sed 's/\x1b\[[0-9;]*m//g' "${WORK}/deploy.log" | grep -qE '✓ .* updated'; then
  echo "[verify] FAIL: an unchanged deploy updated a resource the import should have recorded resolved"
  exit 1
fi
echo "[verify] step 6 ok"

echo "[verify] step 7: cdkd destroy --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
# DeleteStateMachine is asynchronous (the machine stays describable in
# DELETING for a while): poll until it is gone.
machine_gone=0
for _ in $(seq 1 30); do
  if gone_probe aws stepfunctions describe-state-machine --state-machine-arn "${MACHINE_ARN}" --region "${REGION}"; then
    machine_gone=1
    break
  fi
  sleep 5
done
[ "${machine_gone}" = 1 ] || { echo "FAIL: state machine ${MACHINE_ARN} still exists 150 seconds after destroy" >&2; exit 1; }
ACL_NAME="${ACL_ID_COMPOUND%%|*}"; ACL_REST="${ACL_ID_COMPOUND#*|}"; ACL_ID="${ACL_REST%%|*}"
assert_gone "web ACL ${ACL_ID} still exists after destroy" aws wafv2 get-web-acl --name "${ACL_NAME}" --id "${ACL_ID}" --scope REGIONAL --region "${REGION}"
assert_gone "user pool ${POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}"
case "${VECTORS_ID}" in
  arn:*) assert_gone "vector bucket ${VECTORS_ID} still exists after destroy" aws s3vectors get-vector-bucket --vector-bucket-arn "${VECTORS_ID}" --region "${REGION}" ;;
  *) assert_gone "vector bucket ${VECTORS_ID} still exists after destroy" aws s3vectors get-vector-bucket --vector-bucket-name "${VECTORS_ID}" --region "${REGION}" ;;
esac
# DeleteDBCluster is asynchronous: poll until the cluster is gone.
db_gone=0
for _ in $(seq 1 60); do
  if gone_probe aws rds describe-db-clusters --db-cluster-identifier "${DB_ID}" --region "${REGION}"; then
    db_gone=1
    break
  fi
  sleep 10
done
[ "${db_gone}" = 1 ] || { echo "FAIL: DB cluster ${DB_ID} still exists 10 minutes after destroy" >&2; exit 1; }
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 7 ok: resources and state gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
