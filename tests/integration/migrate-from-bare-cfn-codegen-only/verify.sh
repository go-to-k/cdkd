#!/usr/bin/env bash
#
# Codegen-only smoke test for PR A of #465 (cdkd migrate).
#
# This is a DOCKER-FREE / AWS-FREE / CDKD-FREE smoke test that proves
# the upstream `cdk migrate --from-path` CLI we depend on still
# behaves the way PR A's design doc assumes:
#
#   1. Logical IDs survive end-to-end from source template to synth.
#   2. Every Resource carries `Metadata.aws:cdk:path` matching
#      `<StackName>/<LogicalId>`.
#   3. `cdk synth` succeeds on the generated app without further
#      manual edits.
#
# PR A's library functions (under src/cli/commands/migrate/) do NOT
# call `cdk migrate --from-path` — they wrap `cdk migrate --from-stack`,
# which requires a real CFn stack on AWS. The `--from-path` form is the
# only `cdk migrate` flavor that is exercised end-to-end without AWS,
# and structurally it produces the same artifacts. This smoke test
# proves the contract the library depends on.
#
# Real-AWS coverage of `--from-stack` lives in PR B's integration test
# (`tests/integration/migrate-from-bare-cfn/`).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/migrate-from-bare-cfn-codegen-only"

# Pinned output dir (NOT /tmp — pnpm exec needs the cwd to host
# node_modules/.bin/cdk; we install aws-cdk into TEST_DIR's
# node_modules then invoke from a sibling output path).
OUTPUT_PARENT="$(mktemp -d -t cdkd-migrate-smoke-XXXXXX)"
OUTPUT_DIR="${OUTPUT_PARENT}/SmokeMigrated"
STACK_NAME="SmokeMigrated"

cleanup() {
  rm -rf "${OUTPUT_PARENT}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[smoke] test dir:   ${TEST_DIR}"
echo "[smoke] output dir: ${OUTPUT_DIR}"

# ---- Step 1: install pinned aws-cdk version ----
echo "[smoke] step 1: install aws-cdk in test dir"
pushd "${TEST_DIR}" >/dev/null
if [[ ! -x "node_modules/.bin/cdk" ]]; then
  # --ignore-workspace: the cdkd repo root declares a pnpm-workspace.yaml.
  # Without --ignore-workspace, sub-package installs are hoisted to the
  # workspace root's node_modules and the local node_modules/.bin/cdk
  # never appears. The integ test deliberately pins its own aws-cdk
  # version below the workspace floor, so workspace hoisting would
  # also lose that pinning.
  pnpm install --ignore-workspace --silent
fi
popd >/dev/null

CDK_BIN="${TEST_DIR}/node_modules/.bin/cdk"
echo "[smoke] cdk version: $("${CDK_BIN}" --version)"

# ---- Step 2: run cdk migrate --from-path ----
echo "[smoke] step 2: cdk migrate --from-path ${TEST_DIR}/template-fixture.json"
"${CDK_BIN}" migrate \
  --from-path "${TEST_DIR}/template-fixture.json" \
  --stack-name "${STACK_NAME}" \
  --output-path "${OUTPUT_PARENT}" \
  --language typescript

# ---- Step 3: assert generated artifacts exist ----
echo "[smoke] step 3: assert codegen output"
[[ -f "${OUTPUT_DIR}/cdk.json" ]] || {
  echo "[smoke][FAIL] cdk.json missing at ${OUTPUT_DIR}"
  exit 1
}
# The generated TypeScript stack file's name is the stack name in
# snake_case (cdk migrate convention). For "SmokeMigrated" the file
# becomes "smoke_migrated-stack.ts". Match liberally to tolerate
# upstream casing tweaks.
STACK_FILE=$(find "${OUTPUT_DIR}/lib" -maxdepth 1 -type f -name '*-stack.ts' | head -n 1 || true)
[[ -n "${STACK_FILE}" ]] || {
  echo "[smoke][FAIL] generated stack TS file missing under ${OUTPUT_DIR}/lib"
  ls -la "${OUTPUT_DIR}/lib" || true
  exit 1
}
echo "[smoke] generated stack: ${STACK_FILE}"

# ---- Step 4: cdk synth in the generated dir ----
echo "[smoke] step 4: cdk synth in generated dir (uses generated node_modules)"
pushd "${OUTPUT_DIR}" >/dev/null
# cdk migrate auto-runs `npm install` itself by default; rely on that.
# If it didn't, run it ourselves (best-effort).
[[ -d "node_modules" ]] || npm install --silent
# Use the cdk binary the generated app's own node_modules ships with;
# fall back to TEST_DIR's pinned binary if the generated app does not
# install it locally (older cdk migrate behavior).
GENERATED_CDK_BIN="./node_modules/.bin/cdk"
if [[ ! -x "${GENERATED_CDK_BIN}" ]]; then
  GENERATED_CDK_BIN="${CDK_BIN}"
fi
"${GENERATED_CDK_BIN}" synth --quiet
popd >/dev/null

# ---- Step 5: assert the synth template carries the source logical IDs ----
echo "[smoke] step 5: assert logical-ID preservation"
SYNTH_TEMPLATE="${OUTPUT_DIR}/cdk.out/${STACK_NAME}.template.json"
[[ -f "${SYNTH_TEMPLATE}" ]] || {
  echo "[smoke][FAIL] synth template missing at ${SYNTH_TEMPLATE}"
  ls -la "${OUTPUT_DIR}/cdk.out" || true
  exit 1
}

for logical_id in S3Bucket SsmParam SnsTopic; do
  if ! jq -e ".Resources | has(\"${logical_id}\")" "${SYNTH_TEMPLATE}" >/dev/null; then
    echo "[smoke][FAIL] synth template missing logical id '${logical_id}'"
    echo "[smoke] available resources:"
    jq '.Resources | keys' "${SYNTH_TEMPLATE}"
    exit 1
  fi
  expected_path="${STACK_NAME}/${logical_id}"
  actual_path=$(jq -r ".Resources.\"${logical_id}\".Metadata.\"aws:cdk:path\" // \"\"" "${SYNTH_TEMPLATE}")
  if [[ "${actual_path}" != "${expected_path}" ]]; then
    echo "[smoke][FAIL] '${logical_id}' aws:cdk:path mismatch:"
    echo "  expected: ${expected_path}"
    echo "  actual:   ${actual_path}"
    exit 1
  fi
done

# Sanity-check: every source resource type round-tripped to the synth
# template's expected AWS type.
expected_s3=$(jq -r '.Resources.S3Bucket.Type' "${SYNTH_TEMPLATE}")
expected_ssm=$(jq -r '.Resources.SsmParam.Type' "${SYNTH_TEMPLATE}")
expected_sns=$(jq -r '.Resources.SnsTopic.Type' "${SYNTH_TEMPLATE}")
[[ "${expected_s3}" == "AWS::S3::Bucket" ]] || {
  echo "[smoke][FAIL] S3Bucket has unexpected Type: ${expected_s3}"
  exit 1
}
[[ "${expected_ssm}" == "AWS::SSM::Parameter" ]] || {
  echo "[smoke][FAIL] SsmParam has unexpected Type: ${expected_ssm}"
  exit 1
}
[[ "${expected_sns}" == "AWS::SNS::Topic" ]] || {
  echo "[smoke][FAIL] SnsTopic has unexpected Type: ${expected_sns}"
  exit 1
}

echo "[smoke] PASS: 3/3 logical IDs preserved, aws:cdk:path metadata matches, cdk synth succeeded."
