#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd import --migrate-from-cloudformation`
# records cdkd's physical id for every AppSync type (issue #5364).
# CloudFormation identifies the API, data source, resolver and API key by ARN
# and the schema as `<apiId>GraphQLSchema`; before the fix those were recorded
# verbatim, the API was reported not found and `cdkd drift` read the schema as
# deleted.
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. Pre-flight orphan scan.
#   3. `cdk deploy` the stack (the CloudFormation stack to migrate), capturing
#      CloudFormation's physical ids.
#   4. `cdkd import --migrate-from-cloudformation --yes`: every resource imported.
#   5. Assert each record's physical id is cdkd's shape for that type.
#   6. `cdkd drift --json`: nothing drifted or deleted, and the API, schema and
#      data source were compared clean.
#   7. `cdkd deploy` (no template change): nothing updated.
#   7b. cdkd's stack outputs (the API key's `Arn` / `Ref`, the schema's `Ref`)
#       equal what CloudFormation resolved in step 3 (issue #5540).
#   8. `cdkd destroy --force`; gone-probes for the API and the state.
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
TEST_DIR="${REPO_ROOT}/tests/integration/import-migrate-appsync"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportMigrateAppSync"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# The API key's id is the AppSync credential and lands in state (its physical
# id). The state bucket is VERSIONED, so `cdkd destroy` leaves it readable in
# prior versions: sweep the stack's prefix and assert it on the success path.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-migrate-appsync.XXXXXX")"

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
  # The import sets Retain on every resource before retiring the stack, so a
  # run that failed between that and the state write leaves the API behind.
  if [ -n "${API_ID:-}" ] && aws appsync get-graphql-api --api-id "${API_ID}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws appsync delete-graphql-api ${API_ID}"
    aws appsync delete-graphql-api --api-id "${API_ID}" --region "${REGION}" || true
  fi
  # NONCURRENT only: a live state.json may be the only record of resources
  # still standing.
  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
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

aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query 'StackResources[].[LogicalResourceId,PhysicalResourceId]' --output text > "${WORK}/cfn-ids.txt"
cat "${WORK}/cfn-ids.txt"
API_ARN="$(awk '$1 == "Api" { print $2 }' "${WORK}/cfn-ids.txt")"
API_ID="${API_ARN##*/}"
KEY_ARN="$(awk '$1 == "Key" { print $2 }' "${WORK}/cfn-ids.txt")"
KEY_ID="${KEY_ARN##*/}"
# An empty id would reach a probe as `--api-id ""`, which the aws CLI does not
# reject: it waits, and the run hangs instead of failing.
for pair in "Api=${API_ID}" "Key=${KEY_ID}"; do
  case "${pair#*=}" in
    ""|None) echo "[verify] FAIL: could not resolve the physical id of ${pair%%=*}"; exit 1 ;;
  esac
done
# The premise: CloudFormation's ids are NOT cdkd's, or this run proves nothing.
case "${API_ARN}" in
  arn:*:appsync:*:apis/"${API_ID}") ;;
  *) echo "[verify] FAIL: premise — expected the API ARN as CloudFormation's id, got ${API_ARN}"; exit 1 ;;
esac
if [ "$(awk '$1 == "Schema" { print $2 }' "${WORK}/cfn-ids.txt")" != "${API_ID}GraphQLSchema" ]; then
  echo "[verify] FAIL: premise — expected ${API_ID}GraphQLSchema as the schema's CloudFormation id"
  exit 1
fi
# The oracle for step 7b: the values CloudFormation ITSELF resolved (#5540).
aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query 'Stacks[0].Outputs' --output json > "${WORK}/cfn-outputs.json"
echo "[verify] step 3 ok: api=${API_ID} key=${KEY_ID}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes) 2>&1 | tee "${WORK}/import.log"

echo "[verify] step 5: assert every record carries cdkd's physical id"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
python3 - "${WORK}/state.json" "${API_ID}" "${KEY_ID}" <<'PY'
import json, sys
res = json.load(open(sys.argv[1]))["resources"]
api, key = sys.argv[2], sys.argv[3]
want = {
    "Api": api,
    "Schema": api,
    "Ds": f"{api}|NoneDs",
    "Res": f"{api}|Query|hello",
    "Key": f"{api}|{key}",
}
bad = []
for logical, physical in want.items():
    got = res.get(logical, {}).get("physicalId")
    if got != physical:
        bad.append(f"{logical}.physicalId: got {got!r}, want {physical!r}")
if bad:
    print("[verify] FAIL:\n  " + "\n  ".join(bad))
    sys.exit(1)
print("[verify] step 5 ok: " + ", ".join(f"{k}={v}" for k, v in want.items()))
PY

echo "[verify] step 6: cdkd drift"
DRIFT_RC=0
(cd "${TEST_DIR}" && ${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" --json) \
  > "${WORK}/drift.json" 2> "${WORK}/drift.err" || DRIFT_RC=$?
python3 - "${WORK}/drift.json" "${DRIFT_RC}" "${WORK}/drift.err" <<'PY'
import json, sys
rc = int(sys.argv[2])
try:
    report = json.load(open(sys.argv[1]))
except ValueError:
    print(f"[verify] FAIL: cdkd drift printed no JSON report (rc={rc}):")
    print(open(sys.argv[3]).read()[-2000:])
    sys.exit(1)
stack = report[0]
ids = lambda key: sorted(r["logicalId"] for r in stack.get(key, []))
bad = []
if stack.get("drifted"):
    bad.append(f"drifted: {json.dumps(stack['drifted'])}")
if stack.get("deleted"):
    bad.append(f"deleted: {ids('deleted')}")
missing = sorted({"Api", "Schema", "Ds"} - set(ids("clean")))
if missing:
    bad.append(f"not compared clean: {missing} (clean={ids('clean')}, notCompared={stack.get('notCompared')})")
if rc != 0:
    bad.append(f"cdkd drift exited {rc}")
if bad:
    print("[verify] FAIL:\n  " + "\n  ".join(bad))
    sys.exit(1)
print(f"[verify] step 6 ok: clean={ids('clean')}")
PY

echo "[verify] step 7: cdkd deploy with an unchanged template"
(cd "${TEST_DIR}" && ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}") 2>&1 | tee "${WORK}/deploy.log"
# Matched POSITIVELY on the summary, so a replacement (or any row verb) fails
# too, and a summary whose wording drifted fails rather than passing silently.
# cdkd colours its output, so strip ANSI first.
sed 's/\x1b\[[0-9;]*m//g' "${WORK}/deploy.log" > "${WORK}/deploy.plain"
for line in 'Created: 0' 'Updated: 0' 'Deleted: 0' 'Unchanged: 5'; do
  if ! grep -qxE "[[:space:]]*${line}" "${WORK}/deploy.plain"; then
    echo "[verify] FAIL: the unchanged deploy's summary lacks '${line}' — the import recorded something the template does not match"
    exit 1
  fi
done
echo "[verify] step 7 ok"

echo "[verify] step 7b: cdkd's outputs equal CloudFormation's (issue #5540)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state-after-deploy.json" --region "${REGION}" >/dev/null
python3 - "${WORK}/cfn-outputs.json" "${WORK}/state-after-deploy.json" <<'PY'
import json, sys
cfn = {o["OutputKey"]: o["OutputValue"] for o in json.load(open(sys.argv[1])) or []}
cdkd = json.load(open(sys.argv[2])).get("outputs") or {}
keys = ["KeyArn", "KeyRef", "SchemaRef"]
missing = [k for k in keys if not cfn.get(k)]
if missing:
    print(f"[verify] FAIL: CloudFormation reported no value for {missing}")
    sys.exit(1)
bad = [f"{k}: cdkd {cdkd.get(k)!r}, CloudFormation {cfn[k]!r}" for k in keys if cdkd.get(k) != cfn[k]]
if bad:
    print("[verify] FAIL:\n  " + "\n  ".join(bad))
    sys.exit(1)
print("[verify] step 7b ok: " + ", ".join(f"{k}={cfn[k]}" for k in keys))
PY

echo "[verify] step 8: cdkd destroy --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
assert_gone "api ${API_ID} still exists after destroy" aws appsync get-graphql-api --api-id "${API_ID}" --region "${REGION}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 8 ok: API and state gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "import-migrate-appsync state teardown"
echo "[verify] PASS"
