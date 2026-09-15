#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the `cdkd state info` subcommand
# (issue #1335).
#
# Before this script existed, the fixture only had the standard flow (synth ->
# deploy -> destroy), which never runs `cdkd state info` itself — the command
# the fixture is named after. This script closes that gap and also encodes the
# two operator-facing quirks that tripped the 2026-08-01 regression sweep:
#
#   - `state info` has NO `--region` flag (region is auto-detected via
#     GetBucketLocation); the bucket is passed via `--state-bucket` or the
#     `CDKD_STATE_BUCKET` env var (NOT the generic `STATE_BUCKET` env this
#     script itself takes — that name is an integ-suite convention, not a CLI
#     input). This fixture's cdk.json deliberately pins
#     `context.cdkd.stateBucket = "cdkd-state-test"` so the test proves both
#     real resolution sources (cli flag / env) override it.
#
# Flow:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy (SSM parameter marker stack)
#   3. `state info` (human) via --state-bucket: bucket name + stack count >= 1
#   4. `state info --json` via CDKD_STATE_BUCKET env: bucket / bucketSource=env
#      / integer schemaVersion / stackCount >= 1
#   5. the malformed-`resources` arm (issue #3172): plant a record whose
#      `resources` is a STRING under a THROWAWAY sibling stack key, and assert
#      that every rendering view (`state resources` plain / `--long` / `--json`,
#      `state show` plain and `--show-nested`) describes zero resources and
#      warns, while BOTH `--json` branches of `state show` still return the
#      planted value and say nothing. Nothing deploys the probe stack name, so
#      the arm cannot touch step 2's record.
#   6. cdkd destroy
#   7. assert the stack's state.json + SSM parameter are gone, and
#      `state info --json` still exits 0 (stackCount is bucket-wide, so no
#      absolute post-destroy count assert — parallel integ runs share the
#      bucket)
#
# BSD/macOS-portable: no grep -P, no date -d.
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

STACK="CdkdStateInfoExample"
SSM_PARAM_NAME="/cdkd-integ/state-info/marker"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/state-info-command"
CLI="node ${REPO_ROOT}/dist/cli.js"

: "${STATE_BUCKET:?STATE_BUCKET must be set (the real cdkd state bucket)}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Issue #3172's arm. A SEPARATE stack name, never deployed by anything, so the
# planted record cannot be confused with — or overwrite — step 2's real one,
# and a failure mid-arm leaves the real record intact for `cleanup` to destroy.
MALFORMED_STACK="${STACK}MalformedBag"
MALFORMED_KEY="cdkd/${MALFORMED_STACK}/${REGION}/state.json"
# The probe stack's own prefix — a SIBLING of the real stack's, never a parent
# of it, so the end-of-run zero assertion certifies the planted record alone.
MALFORMED_PREFIX="cdkd/${MALFORMED_STACK}/${REGION}/"
# The planted bag. Six characters, so an unfixed binary renders SIX resources
# that do not exist — the count is what the assertions below read.
MALFORMED_BAG="abcdef"

# The DEPTH arm (issue go-to-k/cdkd#3172 round 2). A healthy parent naming one
# nested-stack child, whose OWN record carries the malformed bag — the shape a
# root-only guard passes and the one the round-2 fix is about. No deploy is
# involved: both are planted state records, and nothing ever creates a stack by
# either name, so this costs two PutObjects rather than a nested-stack deploy.
NESTED_ROOT_STACK="${STACK}MalformedNested"
NESTED_CHILD_STACK="${NESTED_ROOT_STACK}~Child"
NESTED_ROOT_KEY="cdkd/${NESTED_ROOT_STACK}/${REGION}/state.json"
NESTED_CHILD_KEY="cdkd/${NESTED_CHILD_STACK}/${REGION}/state.json"
NESTED_ROOT_PREFIX="cdkd/${NESTED_ROOT_STACK}/${REGION}/"
NESTED_CHILD_PREFIX="cdkd/${NESTED_CHILD_STACK}/${REGION}/"
# Newline-separated rather than a bash array: this is iterated inside `cleanup`
# under `set -u`, where an empty array is an unbound-variable error on macOS's
# bash 3.2 and would abort the sweep it exists to run.
PLANTED_KEYS="${MALFORMED_KEY}
${NESTED_ROOT_KEY}
${NESTED_CHILD_KEY}"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
# Sourced after the `cd`, per the convention in docs/integ-fixture-conventions.md.
# The state bucket is VERSIONED, so deleting the planted key below only writes a
# delete marker; `s3_purge_key_versions` is what actually removes it.
. ../s3-versions.sh

if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  # UNCONDITIONAL, unlike the stack teardown below: the planted key is created
  # by step 5 alone and is never wanted afterwards, on any exit path. Scoped to
  # the ONE key, so a sibling stack's live record under the same bucket cannot
  # be reached even with an unset variable (the helper refuses an empty key).
  # Every planted key, not just the first. `>/dev/null` WITHOUT `2>&1` on the
  # purge: on the failure path this is the only sweep, and the helper reports a
  # listing it could not complete on stderr. Swallowing that leaves a malformed
  # `state.json` in the shared state bucket with nothing in the log saying so —
  # and `cdkd gc` aborts on a malformed record, so the next lane inherits a wedge
  # with no trail back to here.
  printf '%s\n' "${PLANTED_KEYS:-}" | while IFS= read -r planted_key; do
    [ -n "${planted_key}" ] || continue
    aws s3api delete-object --bucket "${STATE_BUCKET:-}" --key "${planted_key}" \
      --region "${REGION:-}" >/dev/null 2>&1 || true
    s3_purge_key_versions "${STATE_BUCKET:-}" "${planted_key}" all >/dev/null || true
  done
  # The arm's scratch files. Named per RUN by `mktemp`, so two concurrent runs
  # cannot share one, and swept here because the success-path `rm -f`s below do
  # not run when a step fails — an untracked leftover dirties `git status` for
  # the marker flow.
  rm -f "${MALFORMED_TMP_DIR:-/nonexistent}"/* 2>/dev/null || true
  [ -n "${MALFORMED_TMP_DIR:-}" ] && rmdir "${MALFORMED_TMP_DIR}" 2>/dev/null || true
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    # Best-effort: destroy the stack if cdkd state still exists.
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    # Direct AWS cleanup in case destroy itself is what broke.
    echo "[verify] cleanup: delete SSM parameter ${SSM_PARAM_NAME} (ignore NotFound)"
    aws ssm delete-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

echo "[verify] step 3: state info (human output, bucket via --state-bucket flag)"
INFO_TXT="$(${CLI} state info --state-bucket "${STATE_BUCKET}")"
echo "${INFO_TXT}"
if ! echo "${INFO_TXT}" | grep -F -q "${STATE_BUCKET}"; then
  echo "[verify] FAIL: 'state info' output does not name the state bucket ${STATE_BUCKET}"
  exit 1
fi
# `Stacks:` count is bucket-wide; with our stack deployed it must be >= 1.
STACK_COUNT_TXT="$(echo "${INFO_TXT}" | sed -n 's/^Stacks:[[:space:]]*\([0-9][0-9]*\)$/\1/p')"
case "${STACK_COUNT_TXT}" in
  '' | *[!0-9]*)
    echo "[verify] FAIL: could not parse a numeric 'Stacks:' line from state info output"
    exit 1
    ;;
esac
if [ "${STACK_COUNT_TXT}" -lt 1 ]; then
  echo "[verify] FAIL: 'state info' reports ${STACK_COUNT_TXT} stacks while ${STACK} is deployed"
  exit 1
fi
echo "[verify] step 3 ok (Stacks: ${STACK_COUNT_TXT})"

echo "[verify] step 4: state info --json (bucket via CDKD_STATE_BUCKET env)"
INFO_JSON="$(CDKD_STATE_BUCKET="${STATE_BUCKET}" ${CLI} state info --json)"
echo "${INFO_JSON}"
EXPECTED_BUCKET="${STATE_BUCKET}" node -e '
  const d = JSON.parse(process.argv[1]);
  const fail = (msg) => {
    console.error(`[verify] FAIL: state info --json: ${msg}`);
    process.exit(1);
  };
  if (d.bucket !== process.env.EXPECTED_BUCKET) fail(`bucket=${d.bucket}, expected ${process.env.EXPECTED_BUCKET}`);
  if (d.bucketSource !== "env") fail(`bucketSource=${d.bucketSource}, expected env (CDKD_STATE_BUCKET)`);
  if (!Number.isInteger(d.schemaVersion)) fail(`schemaVersion=${JSON.stringify(d.schemaVersion)}, expected an integer while a stack is deployed`);
  if (!Number.isInteger(d.stackCount) || d.stackCount < 1) fail(`stackCount=${JSON.stringify(d.stackCount)}, expected >= 1`);
' "${INFO_JSON}"
echo "[verify] step 4 ok"

echo "[verify] step 5: malformed 'resources' bag — the two read-only views (issue #3172)"
# The defect: `resources` is read as an unchecked cast, so a hand-edited or
# truncated record can carry a string there, and `Object.entries("abcdef")`
# yields six `[index, character]` pairs. Before the fix `cdkd state resources`
# rendered them as six resources in ALL THREE modes (its array is built above
# the `--json` branch) and `cdkd state show`'s text view printed
# `Resources (6):` with six blocks.
#
# Planted rather than deployed because no deploy produces this record: it is
# what a hand edit, a truncated write, or anyone with `s3:PutObject` on the
# bucket leaves behind.
#
# `mktemp -d` rather than fixed names under the fixture directory: two runs of
# this fixture must not share a scratch file, and `cleanup` sweeps the whole
# directory on every exit path so a failing step leaves nothing untracked
# behind. Created HERE rather than beside the other variables, so a run that
# fails before this step has nothing to sweep.
MALFORMED_TMP_DIR="$(mktemp -d)"

# plant_state_record <stackName> <key> <resources-as-json>
# The `resources` argument is spliced in as RAW JSON, so a caller can plant a
# string, a list or an object — the whole point of the arm is that the field's
# type is not what the schema claims.
plant_state_record() {
  local stack_name="$1" key="$2" resources_json="$3" body_file
  body_file="${MALFORMED_TMP_DIR}/planted-$(printf '%s' "${key}" | tr '/~' '__').json"
  PLANT_STACK="${stack_name}" PLANT_REGION="${REGION}" PLANT_RESOURCES="${resources_json}" node -e '
    process.stdout.write(
      JSON.stringify({
        version: 2,
        stackName: process.env.PLANT_STACK,
        region: process.env.PLANT_REGION,
        resources: JSON.parse(process.env.PLANT_RESOURCES),
        outputs: {},
        lastModified: 0,
      })
    );
  ' > "${body_file}"
  aws s3api put-object --bucket "${STATE_BUCKET}" --key "${key}" \
    --body "${body_file}" --region "${REGION}" --output json >/dev/null
  rm -f "${body_file}"
}

plant_state_record "${MALFORMED_STACK}" "${MALFORMED_KEY}" "\"${MALFORMED_BAG}\""

# PREMISE first: the record really is readable as a cdkd state record, so a
# later "zero resources" is the guard firing and not the command failing to
# find anything. `state show --json` is also the mode the `state list --long`
# reason text sends an operator to, so it must return the bag AS STORED.
MALFORMED_SHOW_JSON_ERR="${MALFORMED_TMP_DIR}/show-json.err"
MALFORMED_SHOW_JSON="$(${CLI} state show "${MALFORMED_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json \
  2>"${MALFORMED_SHOW_JSON_ERR}")" || {
  echo "[verify] FAIL: state show --json over the planted record exited non-zero" >&2
  tail -20 "${MALFORMED_SHOW_JSON_ERR}" >&2
  exit 1
}
EXPECTED_BAG="${MALFORMED_BAG}" node -e '
  const d = JSON.parse(process.argv[1]);
  if (d.state.resources !== process.env.EXPECTED_BAG) {
    console.error(`[verify] FAIL: state show --json laundered the bag: ${JSON.stringify(d.state.resources)}`);
    process.exit(1);
  }
' "${MALFORMED_SHOW_JSON}"
# ...and it says nothing, because it repaired nothing.
if grep -q "no readable 'resources' map" "${MALFORMED_SHOW_JSON_ERR}"; then
  echo "[verify] FAIL: state show --json warned — it must emit the record untouched" >&2
  exit 1
fi
rm -f "${MALFORMED_SHOW_JSON_ERR}"

# The SECOND `--json` branch, which is a separate return in the same command.
# It emits the record through the nested-stack TREE, and the tree is built by a
# walker that dereferences the bag — so this is the branch where a bag
# hand-edited from a map into a LIST of resource objects used to hard-fail
# before any output, and where a planted multi-megabyte string used to allocate
# a pair per character. It must exit 0, emit the bag AS STORED, and say nothing.
NESTED_JSON_ERR="${MALFORMED_TMP_DIR}/show-nested-json.err"
NESTED_JSON="$(${CLI} state show "${MALFORMED_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --show-nested --json \
  2>"${NESTED_JSON_ERR}")" || {
  echo "[verify] FAIL: state show --show-nested --json over the planted record exited non-zero" >&2
  tail -20 "${NESTED_JSON_ERR}" >&2
  exit 1
}
EXPECTED_BAG="${MALFORMED_BAG}" node -e '
  const d = JSON.parse(process.argv[1]);
  if (d.state.resources !== process.env.EXPECTED_BAG) {
    console.error(`[verify] FAIL: state show --show-nested --json laundered the bag: ${JSON.stringify(d.state.resources)}`);
    process.exit(1);
  }
  if (!Array.isArray(d.children) || d.children.length !== 0) {
    console.error(`[verify] FAIL: state show --show-nested --json invented children: ${JSON.stringify(d.children)}`);
    process.exit(1);
  }
' "${NESTED_JSON}"
if grep -q "no readable 'resources' map" "${NESTED_JSON_ERR}"; then
  echo "[verify] FAIL: state show --show-nested --json warned — it must emit the record untouched" >&2
  exit 1
fi
rm -f "${NESTED_JSON_ERR}"

# The three fabricating views. Each asserts the OUTPUT first (the harm) and the
# warning second (the only delta for a shape that yields no pairs at all).
malformed_view() { # usage: malformed_view <label> <expected-stdout-check> <cli args...>
  local label="$1" check="$2"
  shift 2
  local out err rc
  err="${MALFORMED_TMP_DIR}/${label}.err"
  out="$("$@" 2>"${err}")" && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL: ${label} exited ${rc} over the planted record" >&2
    tail -20 "${err}" >&2
    exit 1
  fi
  case "${check}" in
    empty)
      if [ -n "${out}" ]; then
        echo "[verify] FAIL: ${label} printed rows for a bag that holds none: ${out}" >&2
        exit 1
      fi
      ;;
    empty-json)
      if [ "${out}" != "[]" ]; then
        echo "[verify] FAIL: ${label} emitted ${out}, expected []" >&2
        exit 1
      fi
      ;;
    zero-resources)
      case "${out}" in
        *"Resources (0):"*) ;;
        *)
          echo "[verify] FAIL: ${label} did not print 'Resources (0):'" >&2
          echo "${out}" >&2
          exit 1
          ;;
      esac
      # `Type:` is printed once per RENDERED resource and nowhere else in the
      # block, so its absence is what a header count alone cannot prove.
      case "${out}" in
        *"Type:"*)
          echo "[verify] FAIL: ${label} rendered a resource block for a fabricated row" >&2
          echo "${out}" >&2
          exit 1
          ;;
      esac
      ;;
  esac
  if ! grep -q "no readable 'resources' map" "${err}"; then
    echo "[verify] FAIL: ${label} described zero resources SILENTLY — the warning is the only thing that tells the operator the record is broken" >&2
    tail -20 "${err}" >&2
    exit 1
  fi
  rm -f "${err}"
}

malformed_view resources empty \
  ${CLI} state resources "${MALFORMED_STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
malformed_view resources-long empty \
  ${CLI} state resources "${MALFORMED_STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --long
malformed_view resources-json empty-json \
  ${CLI} state resources "${MALFORMED_STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
malformed_view show zero-resources \
  ${CLI} state show "${MALFORMED_STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
# The tree TEXT path: a second render site for the same block, reached through
# the walker rather than directly, and the one that has to warn about the ROOT
# record rather than about a child.
malformed_view show-nested zero-resources \
  ${CLI} state show "${MALFORMED_STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --show-nested

# DEPTH >= 1. Everything above plants the bad bag on the record the command was
# POINTED AT, which a guard at the caller's own call site would also survive.
# This pair puts a healthy parent in front of it, so the malformed record is
# only reachable through the walker's RECURSION — the shape the round-2 fix is
# about, and the one the earlier root-only guard passed.
#
# The child's bag is a LIST of nested-stack objects rather than a string: an
# unguarded walk reads the list INDEX `0` as a logical id, looks for a child
# record at `<child>~0`, finds none and ABORTS the whole command, which is a
# louder and more specific failure than the per-element allocation a string
# produces.
plant_state_record "${NESTED_ROOT_STACK}" "${NESTED_ROOT_KEY}" \
  '{"Child":{"resourceType":"AWS::CloudFormation::Stack","physicalId":"arn:aws:cloudformation:::stack/planted","properties":{}}}'
plant_state_record "${NESTED_CHILD_STACK}" "${NESTED_CHILD_KEY}" \
  '[{"resourceType":"AWS::CloudFormation::Stack","physicalId":"arn:aws:cloudformation:::stack/planted-grandchild","properties":{}}]'

malformed_view nested-text zero-resources \
  ${CLI} state show "${NESTED_ROOT_STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --show-nested

NESTED_JSON_ERR2="${MALFORMED_TMP_DIR}/nested-depth-json.err"
NESTED_DEPTH_JSON="$(${CLI} state show "${NESTED_ROOT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --show-nested --json \
  2>"${NESTED_JSON_ERR2}")" || {
  echo "[verify] FAIL: state show --show-nested --json aborted on a malformed CHILD record" >&2
  tail -20 "${NESTED_JSON_ERR2}" >&2
  exit 1
}
node -e '
  const d = JSON.parse(process.argv[1]);
  const fail = (m) => { console.error(`[verify] FAIL: depth arm: ${m}`); process.exit(1); };
  if (!Array.isArray(d.children) || d.children.length !== 1) {
    fail(`parent should report exactly one child, got ${JSON.stringify(d.children)}`);
  }
  const child = d.children[0];
  // The child record comes back AS STORED — a list, not a repaired `{}`.
  if (!Array.isArray(child.state.resources)) {
    fail(`child bag was not preserved: ${JSON.stringify(child.state.resources)}`);
  }
  // ...and the walk stopped there rather than inventing `<child>~0`.
  if (!Array.isArray(child.children) || child.children.length !== 0) {
    fail(`walk descended past the malformed child: ${JSON.stringify(child.children)}`);
  }
' "${NESTED_DEPTH_JSON}"
# The cut subtree is announced, and it names the CHILD rather than the parent —
# `--show-nested --json` is the one mode where `children: []` is otherwise
# indistinguishable from a genuine leaf.
if ! grep -q "no readable 'resources' map" "${NESTED_JSON_ERR2}"; then
  echo "[verify] FAIL: --show-nested --json cut a subtree SILENTLY at depth 1" >&2
  exit 1
fi
if ! grep -qF "${NESTED_CHILD_STACK}" "${NESTED_JSON_ERR2}"; then
  echo "[verify] FAIL: the depth-1 warning does not name the child record" >&2
  tail -20 "${NESTED_JSON_ERR2}" >&2
  exit 1
fi
case "${NESTED_DEPTH_JSON}" in
  *"${NESTED_CHILD_STACK}~0"*)
    echo "[verify] FAIL: payload names a fabricated grandchild" >&2
    exit 1
    ;;
esac
rm -f "${NESTED_JSON_ERR2}"

# NEGATIVE CONTROL, and the reason it reads the REAL stack: step 2's record is
# healthy, so a guard that fired on everything would warn here too and every
# assertion above would still pass.
HEALTHY_ERR="${MALFORMED_TMP_DIR}/healthy-show.err"
${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" \
  >/dev/null 2>"${HEALTHY_ERR}"
if grep -q "no readable 'resources' map" "${HEALTHY_ERR}"; then
  echo "[verify] FAIL: state show warned about the HEALTHY record deployed in step 2" >&2
  exit 1
fi
rm -f "${HEALTHY_ERR}"

echo "[verify] step 5: removing every planted record"
printf '%s\n' "${PLANTED_KEYS}" | while IFS= read -r planted_key; do
  [ -n "${planted_key}" ] || continue
  aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${planted_key}" \
    --region "${REGION}" --output json >/dev/null
  s3_purge_key_versions "${STATE_BUCKET}" "${planted_key}" all
done
# Re-asserted OUTSIDE the loop: a `while` fed by a pipe runs in a SUBSHELL, so an
# `exit 1` from `assert_gone` inside it would set the subshell's status and the
# run would carry on. Each probe is its own statement here, under `set -e`.
assert_gone "planted malformed state.json survived step 5" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MALFORMED_KEY}" --region "${REGION}"
assert_gone "planted nested-parent state.json survived step 5" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NESTED_ROOT_KEY}" --region "${REGION}"
assert_gone "planted nested-child state.json survived step 5" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NESTED_CHILD_KEY}" --region "${REGION}"
# The scratch directory itself, on the SUCCESS path. Each `.err` file is removed
# as its check passes, so this only has to take the now-empty directory —
# `cleanup` still sweeps contents-and-all on every failing path.
rmdir "${MALFORMED_TMP_DIR}" 2>/dev/null || true
echo "[verify] step 5 ok"

echo "[verify] step 6: cdkd destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 7: assert state + SSM parameter gone; state info still works"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "SSM parameter ${SSM_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}"
# stackCount is bucket-wide (parallel integ runs may own other stacks), so we
# only assert the command still succeeds post-destroy — the per-stack cleanup
# proof is the two assert_gone probes above.
${CLI} state info --state-bucket "${STATE_BUCKET}" --json >/dev/null
echo "[verify] step 7 ok"

trap - EXIT INT TERM
# On the SUCCESS path, where the EXIT trap no longer runs. The state bucket is
# VERSIONED, so step 5's `delete-object` only wrote a delete marker and the
# planted record would stay readable through GetObjectVersion; this certifies
# that the purge removed every version AND that marker. Scoped to the probe
# stack's own prefix — the real stack's prefix legitimately keeps the delete
# markers `cdkd destroy` leaves, so asserting over it would fail on a clean run.
s3_assert_versions_swept "${STATE_BUCKET}" "${MALFORMED_PREFIX}" "state-info-command planted malformed record"
s3_assert_versions_swept "${STATE_BUCKET}" "${NESTED_ROOT_PREFIX}" "state-info-command planted nested parent"
s3_assert_versions_swept "${STATE_BUCKET}" "${NESTED_CHILD_PREFIX}" "state-info-command planted nested child"
echo "[verify] PASS — cdkd state info (human + --json, flag + env bucket sources) verified end-to-end"
