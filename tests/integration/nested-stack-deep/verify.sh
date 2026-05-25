#!/usr/bin/env bash
# verify.sh — `cdkd diff <parent> --recursive` must diff every nested-stack
# child against its own deployed cdkd state (issue #555 A5).
#
# Flow:
#   1. Deploy the 3-level tree (parent -> Child -> Grandchild) with the
#      baseline grandchild SSM value.
#   2. `cdkd diff NestedStackDeep --recursive` must report NO changes — the
#      recursively-loaded child/grandchild templates exactly match the
#      deployed child/grandchild state (the #1 risk in a diff feature is a
#      false-positive caused by a bad template load or state-key derivation).
#   3. Re-synth with a CHANGED grandchild value (env override — no second
#      deploy) and run `cdkd diff NestedStackDeep --recursive --fail`:
#      - exit code MUST be 1 (a change was detected somewhere in the tree),
#      - the output MUST carry a `Nested stack: NestedStackDeep~Child~Grandchild`
#        block with a `[~]` UPDATE line (the deep change is surfaced under the
#        right header).
#   4. `--recursive --json` with the changed value must emit a nested tree
#      whose grandchild node carries a non-empty `changes` array.
#   5. cdkd destroy — clean removal, state gone.
#
# Run via: /run-integ nested-stack-deep
#         or: bash tests/integration/nested-stack-deep/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="NestedStackDeep"
GRANDCHILD_STACK="NestedStackDeep~Child~Grandchild"
CHANGED_VALUE="cdkd-nested-stack-deep-grandchild-CHANGED"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT INT TERM

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo ""
echo "==> Building cdkd"
(cd ../../.. && vp run build) >/dev/null

# --------------------------------------------------------------------
# Step 1: deploy the 3-level tree (baseline grandchild value).
# --------------------------------------------------------------------
echo ""
echo "==> Step 1: deploy ${STACK} (parent -> Child -> Grandchild)"
${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes

# --------------------------------------------------------------------
# Step 2: recursive diff against the just-deployed tree must be clean.
# --------------------------------------------------------------------
echo ""
echo "==> Step 2: 'cdkd diff ${STACK} --recursive' must report no changes"
CLEAN_OUT=$(${CDKD} diff ${STACK} --recursive --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}")
echo "${CLEAN_OUT}"
if ! echo "${CLEAN_OUT}" | grep -q "No changes detected"; then
  echo "FAIL: recursive diff of a freshly-deployed tree reported spurious changes"
  exit 1
fi
if echo "${CLEAN_OUT}" | grep -q "\[~\]\|\[+\]\|\[-\]"; then
  echo "FAIL: recursive diff of a freshly-deployed tree printed change markers"
  exit 1
fi
echo "  OK: clean recursive diff"

# Also confirm --recursive --fail exits 0 when there are no changes.
echo ""
echo "==> Step 2b: 'cdkd diff ${STACK} --recursive --fail' must exit 0 when clean"
set +e
${CDKD} diff ${STACK} --recursive --fail --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" >/dev/null 2>&1
CLEAN_RC=$?
set -e
if [[ ${CLEAN_RC} -ne 0 ]]; then
  echo "FAIL: --recursive --fail exited ${CLEAN_RC} on a clean tree (expected 0)"
  exit 1
fi
echo "  OK: --fail exits 0 when clean"

# --------------------------------------------------------------------
# Step 3: re-synth with a changed grandchild value -> recursive diff must
# detect the UPDATE deep in the tree and --fail must exit 1.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3: changed grandchild value -> '--recursive --fail' must exit 1 and surface the grandchild"
set +e
CHANGED_OUT=$(CDKD_INTEG_GRANDCHILD_VALUE="${CHANGED_VALUE}" ${CDKD} diff ${STACK} --recursive --fail --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
CHANGED_RC=$?
set -e
echo "${CHANGED_OUT}"
if [[ ${CHANGED_RC} -ne 1 ]]; then
  echo "FAIL: --recursive --fail exited ${CHANGED_RC} after a grandchild change (expected 1)"
  exit 1
fi
if ! echo "${CHANGED_OUT}" | grep -q "Nested stack: ${GRANDCHILD_STACK}"; then
  echo "FAIL: recursive diff did not print a 'Nested stack: ${GRANDCHILD_STACK}' block"
  exit 1
fi
if ! echo "${CHANGED_OUT}" | grep -q "\[~\]"; then
  echo "FAIL: recursive diff did not print an UPDATE ([~]) line for the changed grandchild"
  exit 1
fi
echo "  OK: --fail exits 1, grandchild UPDATE surfaced under its Nested stack header"

# --------------------------------------------------------------------
# Step 4: --recursive --json must emit a nested tree with the grandchild
# carrying a non-empty changes array.
# --------------------------------------------------------------------
echo ""
echo "==> Step 4: '--recursive --json' nested shape carries the grandchild change"
JSON_OUT=$(CDKD_INTEG_GRANDCHILD_VALUE="${CHANGED_VALUE}" ${CDKD} diff ${STACK} --recursive --json --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}")
echo "${JSON_OUT}" | GRANDCHILD_STACK="${GRANDCHILD_STACK}" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
target = os.environ["GRANDCHILD_STACK"]

def find(node):
    if node["stack"] == target:
        return node
    for c in node["children"]:
        hit = find(c)
        if hit:
            return hit
    return None

assert isinstance(data, list) and data, "top-level JSON must be a non-empty array"
gc = None
for root in data:
    gc = find(root)
    if gc:
        break
assert gc is not None, f"grandchild stack {target} not found in nested JSON tree"
assert gc["changes"], f"grandchild {target} changes array is empty"
assert any(c["changeType"] == "UPDATE" for c in gc["changes"]), "expected an UPDATE change on the grandchild"
print(f"  OK: grandchild {target} carries {len(gc[\"changes\"])} change(s) in --json output")
'

# --------------------------------------------------------------------
# Step 5: destroy + verify state gone.
# --------------------------------------------------------------------
echo ""
echo "==> Step 5: cdkd destroy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

if ${CDKD} state list --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 | grep -q "${STACK}"; then
  echo "FAIL: cdkd state still has ${STACK} after destroy"
  exit 1
fi

echo ""
echo "==> PASS: cdkd diff --recursive previews the full nested-stack tree"
