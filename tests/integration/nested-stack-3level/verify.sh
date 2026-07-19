#!/usr/bin/env bash
# verify.sh — deep (4-level) recursive nested-stack deploy / diff / state-tree /
# destroy-cascade, exercising the `nested-stack-deep-deploy-cascade` scenario.
#
# This fixture is a strictly DEEPER + WIDER + BIDIRECTIONAL superset of the
# existing `nested-stack-deep` fixture (3 levels, 1 resource/level, bottom-up
# Fn::GetAtt only). Here:
#
#   CdkdNestedStack3LevelExample (root, depth=0)
#   ├─ RootTopic   (AWS::SNS::Topic)           -- DOWNWARD ref source
#   ├─ RootRef     (AWS::SSM::Parameter)       -- UP via Fn::GetAtt(Child)
#   └─ Child       (AWS::CloudFormation::Stack, depth=1)
#      ├─ Param    (AWS::SSM::Parameter)       -- UP via Fn::GetAtt(Grandchild)
#      └─ Grandchild (AWS::CloudFormation::Stack, depth=2)
#         ├─ Topic (AWS::SNS::Topic)           -- sibling of the nested node
#         ├─ Param (AWS::SSM::Parameter)       -- UP via GetAtt + sibling topic
#         └─ GreatGrandchild (AWS::CloudFormation::Stack, depth=3)  <-- DEEPER
#            └─ Param (AWS::SSM::Parameter)     -- DOWN via Parameters (root topic)
#
# What this verify.sh asserts that `nested-stack-deep`'s does NOT:
#   - one state file per level at `cdkd/<parent>~<...>~<childLogicalId>/<region>/state.json`,
#     each carrying the correct v6 `parentStack` / `parentLogicalId` fields;
#   - every level's REAL AWS resource (SSM Parameter / SNS Topic) exists post-deploy;
#   - `cdkd state list --tree` renders the full 4-level hierarchy;
#   - the destroy cascade removes every level's AWS resource AND state file.
# It ALSO keeps the `nested-stack-deep` coverage: `cdkd diff --recursive` is
# clean post-deploy, and a deep changed value surfaces under the great-
# grandchild's nested-stack header.
#
# Run via: /run-integ nested-stack-3level
#         or: bash tests/integration/nested-stack-3level/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

STACK="CdkdNestedStack3LevelExample"
CHILD="${STACK}~Child"
GRANDCHILD="${STACK}~Child~Grandchild"
GREATGRANDCHILD="${STACK}~Child~Grandchild~GreatGrandchild"
CHANGED_VALUE="cdkd-3level-ggc-CHANGED"

# Collected physical ids (filled during the post-deploy state read) so the
# post-destroy sweep can confirm each one is gone on AWS.
SSM_PARAM_NAMES=()
SNS_TOPIC_ARNS=()

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# state_key_uri <stackName> -> the s3 URI of that level's state.json
state_key_uri() {
  echo "s3://${STATE_BUCKET}/cdkd/$1/${AWS_REGION}/state.json"
}

# fetch_state <stackName> -> prints the state JSON to stdout (fails if absent)
fetch_state() {
  aws s3 cp "$(state_key_uri "$1")" - 2>/dev/null
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo ""
echo "==> Building cdkd"
(cd ../../.. && vp run build) >/dev/null

# --------------------------------------------------------------------
# Step 1: deploy the 4-level tree.
# --------------------------------------------------------------------
echo ""
echo "==> Step 1: deploy ${STACK} (root -> Child -> Grandchild -> GreatGrandchild)"
${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes

# --------------------------------------------------------------------
# Step 2: one state file per level with correct parentStack/parentLogicalId.
# --------------------------------------------------------------------
echo ""
echo "==> Step 2: per-level state files + v6 parent fields"

# Format: "<stateKey> <expectedParentStack> <expectedParentLogicalId>"
# Root has no parent (parentStack must be absent/null).
assert_level() {
  local key="$1" expectedParent="$2" expectedLogicalId="$3"
  local json
  if ! json=$(fetch_state "${key}"); then
    echo "FAIL: missing state file at $(state_key_uri "${key}")"
    exit 1
  fi
  # stackName field must match the state key.
  local actualName
  actualName=$(echo "${json}" | jq -r '.stackName')
  if [[ "${actualName}" != "${key}" ]]; then
    echo "FAIL: state ${key} has stackName='${actualName}' (expected '${key}')"
    exit 1
  fi
  local actualParent actualLogicalId
  actualParent=$(echo "${json}" | jq -r 'if has("parentStack") then .parentStack else "null" end')
  actualLogicalId=$(echo "${json}" | jq -r 'if has("parentLogicalId") then .parentLogicalId else "null" end')
  if [[ "${actualParent}" != "${expectedParent}" ]]; then
    echo "FAIL: state ${key} parentStack='${actualParent}' (expected '${expectedParent}')"
    exit 1
  fi
  if [[ "${actualLogicalId}" != "${expectedLogicalId}" ]]; then
    echo "FAIL: state ${key} parentLogicalId='${actualLogicalId}' (expected '${expectedLogicalId}')"
    exit 1
  fi
  echo "  OK: ${key} (parentStack='${actualParent}', parentLogicalId='${actualLogicalId}')"

  # Collect this level's AWS physical ids so Step 3 / Step 6 can check them.
  local ssm sns
  while IFS= read -r ssm; do
    [[ -n "${ssm}" ]] && SSM_PARAM_NAMES+=("${ssm}")
  done < <(echo "${json}" | jq -r '.resources | to_entries[] | select(.value.resourceType=="AWS::SSM::Parameter") | .value.physicalId')
  while IFS= read -r sns; do
    [[ -n "${sns}" ]] && SNS_TOPIC_ARNS+=("${sns}")
  done < <(echo "${json}" | jq -r '.resources | to_entries[] | select(.value.resourceType=="AWS::SNS::Topic") | .value.physicalId')
}

assert_level "${STACK}"           "null"            "null"
assert_level "${CHILD}"           "${STACK}"        "Child"
assert_level "${GRANDCHILD}"      "${CHILD}"        "Grandchild"
assert_level "${GREATGRANDCHILD}" "${GRANDCHILD}"   "GreatGrandchild"

# Sanity: we should have collected 4 SSM params (RootRef, Child.Param,
# Grandchild.Param, GreatGrandchild.Param) and 2 SNS topics (RootTopic,
# Grandchild.Topic) across the tree.
if [[ ${#SSM_PARAM_NAMES[@]} -ne 4 ]]; then
  echo "FAIL: expected 4 SSM parameters across the tree, found ${#SSM_PARAM_NAMES[@]}: ${SSM_PARAM_NAMES[*]}"
  exit 1
fi
if [[ ${#SNS_TOPIC_ARNS[@]} -ne 2 ]]; then
  echo "FAIL: expected 2 SNS topics across the tree, found ${#SNS_TOPIC_ARNS[@]}: ${SNS_TOPIC_ARNS[*]}"
  exit 1
fi
echo "  OK: 4 state files, 4 SSM params + 2 SNS topics collected across all levels"

# --------------------------------------------------------------------
# Step 3: every level's REAL AWS resource exists.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3: each level's AWS resource exists"
for name in "${SSM_PARAM_NAMES[@]}"; do
  if ! aws ssm get-parameter --name "${name}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "FAIL: SSM parameter '${name}' not found on AWS after deploy"
    exit 1
  fi
  echo "  OK: SSM parameter exists: ${name}"
done
for arn in "${SNS_TOPIC_ARNS[@]}"; do
  if ! aws sns get-topic-attributes --topic-arn "${arn}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "FAIL: SNS topic '${arn}' not found on AWS after deploy"
    exit 1
  fi
  echo "  OK: SNS topic exists: ${arn}"
done

# Verify the DOWNWARD reference actually threaded the root topic name into the
# great-grandchild's parameter value (top-down Parameters forwarding). The
# great-grandchild Param value is `cdkd-3level-ggc-uses-root-topic:<rootTopicName>`.
GGC_JSON=$(fetch_state "${GREATGRANDCHILD}")
GGC_VALUE=$(echo "${GGC_JSON}" | jq -r '.resources | to_entries[] | select(.value.resourceType=="AWS::SSM::Parameter") | .value.properties.Value')
if [[ "${GGC_VALUE}" != cdkd-3level-ggc-uses-root-topic:* ]]; then
  echo "FAIL: great-grandchild param value '${GGC_VALUE}' did not carry the downward root-topic Parameter"
  exit 1
fi
echo "  OK: downward Parameters forwarding reached depth=3 (value='${GGC_VALUE}')"

# --------------------------------------------------------------------
# Step 4: recursive diff against the just-deployed tree must be clean.
# --------------------------------------------------------------------
echo ""
echo "==> Step 4: 'cdkd diff ${STACK} --recursive' must report no changes"
CLEAN_OUT=$(${CDKD} diff ${STACK} --recursive --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}")
echo "${CLEAN_OUT}"
if ! echo "${CLEAN_OUT}" | grep -q "No changes detected"; then
  echo "FAIL: recursive diff of a freshly-deployed tree reported spurious changes"
  exit 1
fi
if echo "${CLEAN_OUT}" | grep -qE "\[~\]|\[\+\]|\[-\]"; then
  echo "FAIL: recursive diff of a freshly-deployed tree printed change markers"
  exit 1
fi
echo "  OK: clean recursive diff across all 4 levels"

# Changed deep value -> '--recursive --fail' must exit 1 and surface the
# great-grandchild under its own Nested stack header (deepest-level diff).
echo ""
echo "==> Step 4b: changed great-grandchild value surfaces under its nested header"
set +e
CHANGED_OUT=$(CDKD_INTEG_GGC_VALUE="${CHANGED_VALUE}" ${CDKD} diff ${STACK} --recursive --fail --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
CHANGED_RC=$?
set -e
echo "${CHANGED_OUT}"
if [[ ${CHANGED_RC} -ne 1 ]]; then
  echo "FAIL: --recursive --fail exited ${CHANGED_RC} after a great-grandchild change (expected 1)"
  exit 1
fi
if ! echo "${CHANGED_OUT}" | grep -q "Nested stack: ${GREATGRANDCHILD}"; then
  echo "FAIL: recursive diff did not print a 'Nested stack: ${GREATGRANDCHILD}' block"
  exit 1
fi
if ! echo "${CHANGED_OUT}" | grep -q "\[~\]"; then
  echo "FAIL: recursive diff did not print an UPDATE ([~]) line for the changed great-grandchild"
  exit 1
fi
echo "  OK: depth=3 UPDATE surfaced under its Nested stack header"

# --------------------------------------------------------------------
# Step 5: 'cdkd state list --tree' renders the 4-level hierarchy.
# --------------------------------------------------------------------
echo ""
echo "==> Step 5: 'cdkd state list --tree' renders the 4-level hierarchy"
TREE_OUT=$(${CDKD} state list --tree --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}")
echo "${TREE_OUT}"
# Root row appears unindented; each deeper level renders with a box-drawing
# branch prefix. Assert the full ~-joined name shows at each level AND that the
# tree nesting (box-drawing chars) is present.
for lvl in "${STACK}" "${CHILD}" "${GRANDCHILD}" "${GREATGRANDCHILD}"; do
  if ! echo "${TREE_OUT}" | grep -qF "${lvl}"; then
    echo "FAIL: 'state list --tree' did not render level '${lvl}'"
    exit 1
  fi
done
if ! echo "${TREE_OUT}" | grep -qE '(└──|├──)'; then
  echo "FAIL: 'state list --tree' rendered no box-drawing branches (hierarchy not shown)"
  exit 1
fi
# The great-grandchild is the deepest leaf: its branch must be indented under a
# continuation prefix (it cannot be a top-level root row). Confirm at least one
# branch line carries the great-grandchild's own logical-id segment.
if ! echo "${TREE_OUT}" | grep -E '(└──|├──)' | grep -qF "GreatGrandchild"; then
  echo "FAIL: 'state list --tree' did not nest GreatGrandchild under a branch"
  exit 1
fi
echo "  OK: 4-level hierarchy rendered with box-drawing branches"

# --------------------------------------------------------------------
# Step 6: destroy + verify the full cascade (every AWS resource + state gone).
# --------------------------------------------------------------------
echo ""
echo "==> Step 6: cdkd destroy (cascade)"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

# 6a: no state file for ANY level remains.
for lvl in "${STACK}" "${CHILD}" "${GRANDCHILD}" "${GREATGRANDCHILD}"; do
  if aws s3 ls "$(state_key_uri "${lvl}")" >/dev/null 2>&1; then
    echo "FAIL: state file for '${lvl}' still present after destroy"
    exit 1
  fi
  echo "  OK: state gone: ${lvl}"
done
if ${CDKD} state list --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 | grep -q "${STACK}"; then
  echo "FAIL: 'cdkd state list' still shows ${STACK} after destroy"
  exit 1
fi

# 6b: every level's AWS resource is gone.
for name in "${SSM_PARAM_NAMES[@]}"; do
  if aws ssm get-parameter --name "${name}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "FAIL: SSM parameter '${name}' still exists on AWS after destroy (cascade leak)"
    exit 1
  fi
  echo "  OK: SSM parameter gone: ${name}"
done
for arn in "${SNS_TOPIC_ARNS[@]}"; do
  if aws sns get-topic-attributes --topic-arn "${arn}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "FAIL: SNS topic '${arn}' still exists on AWS after destroy (cascade leak)"
    exit 1
  fi
  echo "  OK: SNS topic gone: ${arn}"
done

echo ""
echo "==> PASS: 4-level nested-stack deploy / parent-link / state-tree / destroy-cascade verified"
