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
# Step 0 runs BEFORE all of that, against a clean slate (issue #3247): synth,
# hand-modify the assembly so the Child template's `Grandchild` row points
# back at the Child template itself, and deploy THAT. cdkd must refuse before
# any level of the cyclic tree deploys — non-zero exit, the cycle named, and
# no state record under any `NestedStackDeep~...` key. Before the fix the same
# input deployed `~Child`, `~Child~Grandchild`, `~Child~Grandchild~Grandchild`
# ... until S3's key-length limit stopped it.
#
# The refusal must also land PRE-FLIGHT (issue #3449): before the work graph
# (asset publishing) is built and before the root stack starts, so there is no
# root state record and no lock either. A read-only `--dry-run` of the
# UNMODIFIED assembly is the positive control for the two log lines that
# check keys on.
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
# What NestedStackProvider logs immediately before it builds a child engine.
CHILD_DEPLOY_MARKER="Deploying nested stack"
# The first line a stack prints once `cdkd deploy` starts it: before its lock,
# its state read and its engine.
STACK_START_MARKER="Deploying stack:"
# Debug line printed once the asset-publish + stack work graph is built, i.e.
# before the first asset is published. Needs --verbose.
WORK_GRAPH_MARKER="Work graph:"
CHANGED_VALUE="cdkd-nested-stack-deep-grandchild-CHANGED"

CYCLIC_ASSEMBLY=""

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

# Every state record under a `NestedStackDeep~...` key, one per line. A cyclic
# deploy that was NOT refused writes `~Child`, `~Child~Grandchild`,
# `~Child~Grandchild~Grandchild`, ... so the sweep is by PREFIX, not by a key
# list. The literal `~` keeps the prefix from widening past this fixture.
list_nested_state_keys() {
  aws s3api list-objects-v2 \
    --bucket "${STATE_BUCKET}" \
    --prefix "cdkd/${STACK}~" \
    --query 'Contents[].Key' \
    --output text
}

# Destroy whatever a cyclic deploy that was NOT refused left behind: each
# runaway level is a real child stack with its own state record. Deepest first,
# so a parent's cascade never races its own child. Best-effort by design.
destroy_runaway_levels() { (
  set +eu
  case "${STACK}" in
    NestedStackDeep) ;;
    *) echo "teardown sweep refused: unexpected STACK '${STACK}'" >&2; return 0 ;;
  esac
  keys="$(list_nested_state_keys 2>/dev/null)"
  printf '%s\n' "${keys}" | tr '\t' '\n' | grep '/state\.json$' | awk '{ print length($0) " " $0 }' | sort -rn | cut -d' ' -f2- |
    while read -r key || [ -n "${key}" ]; do
      name="${key#cdkd/}"
      name="${name%%/*}"
      case "${name}" in
        "${STACK}~"?*) ;;
        *) continue ;;
      esac
      # </dev/null: the loop's stdin is the key list, which the command must not eat.
      ${CDKD} state destroy "${name}" --region "${AWS_REGION}" --stack-region "${AWS_REGION}" --state-bucket "${STATE_BUCKET:-}" --yes </dev/null >/dev/null 2>&1
    done
) }

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  destroy_runaway_levels || true
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  if [[ -n "${CYCLIC_ASSEMBLY}" && -d "${CYCLIC_ASSEMBLY}" ]]; then
    (cd "$(dirname "${CYCLIC_ASSEMBLY}")" && rm -rf "$(basename "${CYCLIC_ASSEMBLY}")") || true
  fi
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo ""
echo "==> Building cdkd"
(cd ../../.. && vp run build) >/dev/null

# --------------------------------------------------------------------
# Step 0: a nested-template CYCLE must be refused before anything deploys
# (issue #3247).
# --------------------------------------------------------------------
echo ""
echo "==> Step 0: a hand-modified cyclic assembly must be refused before any level deploys"
CYCLIC_ASSEMBLY="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-nested-stack-deep-cyclic.XXXXXX")"
${CDKD} synth --output "${CYCLIC_ASSEMBLY}" >/dev/null

# Positive control for the pre-flight check below, taken from the assembly
# BEFORE it is rewired: an ordinary run prints both markers, so their absence
# from the refused run means something. `--dry-run` keeps it read-only.
set +e
CONTROL_OUT=$(${CDKD} deploy ${STACK} \
  --app "${CYCLIC_ASSEMBLY}" \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --dry-run --verbose --yes 2>&1)
CONTROL_RC=$?
set -e
if [[ ${CONTROL_RC} -ne 0 ]]; then
  echo "${CONTROL_OUT}"
  echo "FAIL: the control 'deploy --dry-run' of the unmodified assembly exited ${CONTROL_RC}"
  exit 1
fi
for marker in "${WORK_GRAPH_MARKER}" "${STACK_START_MARKER}"; do
  if ! echo "${CONTROL_OUT}" | grep -qF "${marker}"; then
    echo "FAIL: an ordinary 'deploy --dry-run --verbose' no longer logs '${marker}' — the pre-flight check below would pass vacuously; update the marker"
    exit 1
  fi
done
echo "  OK: control run of the unmodified assembly logs both pre-flight markers"

# Point the Child template's `Grandchild` row back at the Child template. The
# row and the file are found from the assembly, not assumed: CDK names nested
# templates by construct path + hash.
CYCLIC_ASSEMBLY="${CYCLIC_ASSEMBLY}" STACK="${STACK}" python3 - <<'PY'
import json, os, sys

out = os.environ["CYCLIC_ASSEMBLY"]
stack = os.environ["STACK"]

def nested_rows(template):
    return {
        k: v for k, v in template.get("Resources", {}).items()
        if v.get("Type") == "AWS::CloudFormation::Stack"
    }

root = json.load(open(os.path.join(out, f"{stack}.template.json")))
root_rows = nested_rows(root)
assert list(root_rows) == ["Child"], f"expected exactly one root nested row 'Child', got {list(root_rows)}"
child_file = root_rows["Child"]["Metadata"]["aws:asset:path"]
child_path = os.path.join(out, child_file)
child = json.load(open(child_path))
child_rows = nested_rows(child)
assert list(child_rows) == ["Grandchild"], f"expected exactly one child nested row 'Grandchild', got {list(child_rows)}"
before = child_rows["Grandchild"]["Metadata"]["aws:asset:path"]
assert before != child_file, "fixture already cyclic?"
child["Resources"]["Grandchild"]["Metadata"]["aws:asset:path"] = child_file
json.dump(child, open(child_path, "w"))
print(f"  rewired {child_file}: Grandchild aws:asset:path {before} -> {child_file}")
PY

set +e
CYCLE_OUT=$(${CDKD} deploy ${STACK} \
  --app "${CYCLIC_ASSEMBLY}" \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose --yes 2>&1)
CYCLE_RC=$?
set -e
echo "${CYCLE_OUT}"
if [[ ${CYCLE_RC} -eq 0 ]]; then
  echo "FAIL: deploying a cyclic nested-template assembly exited 0 (expected a refusal)"
  exit 1
fi
# Two independent markers from the same refusal: if the wording drifts, one
# present without the other fails loudly instead of reading as "no refusal".
if ! echo "${CYCLE_OUT}" | grep -q "contains a cycle"; then
  if echo "${CYCLE_OUT}" | grep -q "Refusing to start the deploy"; then
    echo "FAIL: refusal fired but its 'contains a cycle' wording drifted — update this fixture"
  else
    echo "FAIL: deploy failed (rc=${CYCLE_RC}) but NOT with the nested-template cycle refusal"
  fi
  exit 1
fi
if ! echo "${CYCLE_OUT}" | grep -q "'Child' (.*) -> 'Grandchild' (.*)"; then
  echo "FAIL: the refusal did not name the cycle path ('Child' -> 'Grandchild')"
  exit 1
fi
echo "  OK: refused (rc=${CYCLE_RC}) naming the cycle"

# The refusal must land BEFORE the first child engine starts, not at the first
# repeat partway down. The provider logs "${CHILD_DEPLOY_MARKER} <child>" right
# before it builds a child engine, so that line must be absent here. Step 1
# asserts the same line IS printed by an ordinary deploy, so a reworded log
# cannot turn this into a check that passes by matching nothing.
if echo "${CYCLE_OUT}" | grep -q "${CHILD_DEPLOY_MARKER}"; then
  echo "FAIL: a child engine was started before the cyclic tree was refused:"
  echo "${CYCLE_OUT}" | grep "${CHILD_DEPLOY_MARKER}"
  exit 1
fi
echo "  OK: no child engine was started"

# Pre-flight (issue #3449): the refusal comes before the work graph is built,
# so no asset was published, and before the root stack starts, so no lock was
# taken and no root resource was dispatched. The control run above proves both
# lines are printed by a run that gets that far.
for marker in "${WORK_GRAPH_MARKER}" "${STACK_START_MARKER}"; do
  if echo "${CYCLE_OUT}" | grep -qF "${marker}"; then
    echo "FAIL: the cyclic tree was refused only AFTER '${marker}' — the refusal is no longer pre-flight:"
    echo "${CYCLE_OUT}" | grep -F "${marker}"
    exit 1
  fi
done
echo "  OK: refused pre-flight (no work graph, root stack never started)"

# No nested state record either. In THIS fixture that is a weaker signal than
# the check above: a level's record is written when its first resource
# completes, and each level's only resource waits on the nested row below it.
NESTED_KEYS="$(list_nested_state_keys)"
if [[ -n "${NESTED_KEYS}" && "${NESTED_KEYS}" != "None" ]]; then
  echo "FAIL: the refused deploy still wrote nested state record(s):"
  printf '%s\n' "${NESTED_KEYS}" | tr '\t' '\n'
  exit 1
fi
assert_gone "child state record exists after a refused cyclic deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}~Child/${AWS_REGION}/state.json"
echo "  OK: no state record under cdkd/${STACK}~*"

# A pre-flight refusal never reaches the root stack, so it leaves no root
# record and no lock behind. (A refusal at the nested-stack row could leave an
# empty root record here.)
assert_gone "root state record exists after a pre-flight refusal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${AWS_REGION}/state.json"
assert_gone "root lock exists after a pre-flight refusal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${AWS_REGION}/lock.json"
echo "  OK: no root state record and no lock"

# Belt and braces: Step 1 must start from the same slate it always has.
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true

# --------------------------------------------------------------------
# Step 1: deploy the 3-level tree (baseline grandchild value).
# --------------------------------------------------------------------
echo ""
echo "==> Step 1: deploy ${STACK} (parent -> Child -> Grandchild)"
# Captured as well as shown: Step 0's "no child engine was started" check keys
# on a log line, and this is the positive control proving that line exists.
STEP1_LOG="${CYCLIC_ASSEMBLY}/step1-deploy.log"
${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes 2>&1 | tee "${STEP1_LOG}"
if ! grep -q "${CHILD_DEPLOY_MARKER} ${GRANDCHILD_STACK}" "${STEP1_LOG}"; then
  echo "FAIL: an ordinary nested deploy no longer logs '${CHILD_DEPLOY_MARKER} <child>' — Step 0's child-engine check would pass vacuously; update CHILD_DEPLOY_MARKER"
  exit 1
fi

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
count = len(gc["changes"])
print(f"  OK: grandchild {target} carries {count} change(s) in --json output")
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
