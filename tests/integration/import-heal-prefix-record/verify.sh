#!/usr/bin/env bash
#
# End-to-end real-AWS validation of the #3627 heal-residual row: a record
# imported by a cdkd OLDER than the `import()` read-backs lacks DynamoDB
# `StreamArn`, IAM `RoleId` and the path-bearing IAM `Arn`, and those resolver
# arms answered without reaching the #1852 deploy-time heal. This checkout's
# `cdkd deploy` must heal every row.
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. Pre-flight orphan scan.
#   3. `cdk deploy`; capture what CloudFormation resolved each `Fn::GetAtt` to
#      (the SSM parameters it wrote) as the oracle.
#   4. `cdkd import --migrate-from-cloudformation` with cdkd 0.291.13 (before
#      the read-backs), then assert the imported records are WRONG — otherwise
#      the fixture could not tell a heal from an import that was already right.
#   5. `cdkd deploy` with this checkout: every parameter record AND its live
#      SSM value must now equal the oracle.
#   6. A second `cdkd deploy` changes nothing.
#   7. `cdkd destroy --force`; gone-probes.
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
TEST_DIR="${REPO_ROOT}/tests/integration/import-heal-prefix-record"
CLI="node ${REPO_ROOT}/dist/cli.js"
OLD_CDKD_VERSION="0.291.13"
OLD_CLI="npx -y @go-to-k/cdkd@${OLD_CDKD_VERSION}"

STACK="CdkdImportHealPrefixRecord"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAMS=(StreamArnParam RoleIdParam RoleArnParam UserArnParam)

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-heal-prefix.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The import writes cdkd state BEFORE it retires the CloudFormation stack, so
# one of the two owns every resource at every point.
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
OLD_RESOLVED="$(${OLD_CLI} --version)"
if [ "${OLD_RESOLVED}" != "${OLD_CDKD_VERSION}" ]; then
  echo "[verify] FAIL: the old cdkd reported '${OLD_RESOLVED}', want ${OLD_CDKD_VERSION}"
  exit 1
fi
echo "[verify] step 1 ok: using ${CDK_RESOLVED} (${CDK_VERSION}), old cdkd ${OLD_RESOLVED}"

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
TABLE_NAME="$(physical_of Table)"
ROLE_NAME="$(physical_of Role)"
USER_NAME="$(physical_of User)"
for pair in "Table=${TABLE_NAME}" "Role=${ROLE_NAME}" "User=${USER_NAME}"; do
  case "${pair#*=}" in
    ""|None) echo "[verify] FAIL: could not resolve the physical id of ${pair%%=*}"; exit 1 ;;
  esac
done
# The oracle: what CloudFormation itself resolved each Fn::GetAtt to.
: > "${WORK}/expected.tsv"
for p in "${PARAMS[@]}"; do
  name="$(physical_of "${p}")"
  value="$(aws ssm get-parameter --name "${name}" --region "${REGION}" --query Parameter.Value --output text)"
  printf '%s\t%s\t%s\n' "${p}" "${name}" "${value}" >> "${WORK}/expected.tsv"
done
echo "[verify] step 3 ok: oracle captured"

record_values() { # usage: record_values <label> -> writes ${WORK}/<label>.json
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/$1.json" --region "${REGION}" >/dev/null || return 1
}

echo "[verify] step 4: cdkd ${OLD_CDKD_VERSION} import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${OLD_CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes)
record_values before
python3 - "${WORK}/before.json" "${WORK}/expected.tsv" <<'PY'
import json, sys
res = json.load(open(sys.argv[1]))["resources"]
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[2]) if l.strip()]
wrong = [p for p, _, v in rows if res.get(p, {}).get("properties", {}).get("Value") != v]
right = [p for p, _, _ in rows if p not in wrong]
# EVERY row must start wrong (the old binary is pinned, so this is
# deterministic): a row the old import got right cannot show a heal.
if right:
    print("[verify] FAIL: the old import already recorded these correctly, so no heal is observable for them: " + ", ".join(right))
    sys.exit(1)
print("[verify] step 4 ok: the old import left these rows wrong: " + ", ".join(wrong))
PY

echo "[verify] step 5: cdkd deploy with this checkout heals every row"
(cd "${TEST_DIR}" && ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}")
record_values after
python3 - "${WORK}/after.json" "${WORK}/expected.tsv" <<'PY'
import json, sys
res = json.load(open(sys.argv[1]))["resources"]
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[2]) if l.strip()]
bad = [f"{p}: record {res.get(p, {}).get('properties', {}).get('Value')!r}, want {v!r}"
       for p, _, v in rows if res.get(p, {}).get("properties", {}).get("Value") != v]
if bad:
    print("[verify] FAIL (issue #3627 heal):\n  " + "\n  ".join(bad))
    sys.exit(1)
print("[verify] step 5 ok: every parameter record equals the oracle")
PY
while IFS="$(printf '\t')" read -r p name want; do
  [ -n "${p}" ] || continue
  live="$(aws ssm get-parameter --name "${name}" --region "${REGION}" --query Parameter.Value --output text)"
  if [ "${live}" != "${want}" ]; then
    echo "[verify] FAIL: ${p} live value is '${live}', want '${want}'"
    exit 1
  fi
done < "${WORK}/expected.tsv"
echo "[verify] step 5 ok: every live parameter value equals the oracle"

echo "[verify] step 6: a second cdkd deploy changes nothing"
(cd "${TEST_DIR}" && ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}") 2>&1 | tee "${WORK}/deploy2.log"
if sed 's/\x1b\[[0-9;]*m//g' "${WORK}/deploy2.log" | grep -qE '✓ .* (created|updated|deleted)'; then
  echo "[verify] FAIL: the deploy after the heal still changed resources"
  exit 1
fi
echo "[verify] step 6 ok"

echo "[verify] step 7: cdkd destroy --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "user ${USER_NAME} still exists after destroy" aws iam get-user --user-name "${USER_NAME}"
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
while IFS="$(printf '\t')" read -r p name _; do
  [ -n "${p}" ] || continue
  assert_gone "parameter ${name} still exists after destroy" aws ssm get-parameter --name "${name}" --region "${REGION}"
done < "${WORK}/expected.tsv"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 7 ok: resources and state gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
