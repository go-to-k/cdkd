#!/usr/bin/env bash
#
# verify.sh — real-AWS net for issue #3208: `cdkd deploy --replace` must
# COMPLETE a same-name replacement of a cdkd-named ELBv2 target group.
#
# THE CLAIM UNDER TEST
#
# A property-driven replacement runs CloudFormation's safe order — create the
# new resource, then delete the old one. When the new resource must carry the
# SAME physical name, that create collides, and `--replace`'s delete-first
# fallback is the only way forward. The fallback (and the rollback executor's
# delete-new-first arm) gate on a name-collision predicate which, before the
# fix, read only the rendered MESSAGE and matched `already exist` /
# `AlreadyExists`.
#
# MEASURED live, us-east-1, 2026-09-16, creating a second target group under a
# live name:
#
#   name    = DuplicateTargetGroupNameException
#   message = A target group with the same name 'X' exists, but with different
#             settings
#
# The message never says "already exists" and carries no code, so the predicate
# missed it: the delete-first fallback never engaged and the deploy died at the
# forward replacement with `No completed operations to roll back`. A create-only
# change to a cdkd-NAMED target group could not be deployed AT ALL.
#
# The fix adds `isNameCollisionErrorFrom` (src/deployment/retryable-errors.ts),
# which reads the exception NAME off the bounded cause chain. The unit tests pin
# the predicate; THIS fixture is the end-to-end proof that `--replace` now
# completes such a replacement.
#
# WHY THE NAME MUST STAY THE SAME
#
# The collision IS the test. The target group is UNNAMED in the template, so
# cdkd mints `<stackName>-<logicalId>` from inputs that do not change between
# phases — the replacement therefore asks AWS for a name the old target group
# still holds. Declaring a `Name` and CHANGING it would replace the target group
# under a DIFFERENT name: nothing collides, the fallback is never reached, and
# the run passes identically with and without the fix. That is a vacuous test,
# and the pre-flight below refuses the template that would produce it.
#
# WHY `Port`
#
# `Port` is in `createOnlyProperties` for
# `AWS::ElasticLoadBalancingV2::TargetGroup` (verified against
# `tests/fixtures/cfn-schemas/AWS-ElasticLoadBalancingV2-TargetGroup.json`),
# so changing it classifies as a REPLACEMENT. `primaryIdentifier` is
# `TargetGroupArn`, NOT `Name` — so the replacement mints a new ARN while
# reusing the name verbatim. That pairing is what gives phase 3 a positive
# sentinel (the ARN moved) for an assertion set that is otherwise satisfied by
# "nothing was replaced".
#
# WHY TARGET GROUPS ARE ENUMERATED BY `VpcId` AND NEVER BY NAME PREFIX
#
# Same reasoning as the sibling fixture `rollback-replay-cc-generated-name`,
# which enumerates IAM roles by `Path`. A name-prefix query can only see target
# groups cdkd named the way cdkd is SUPPOSED to name them, so it is blind to
# exactly the failure modes worth catching here — a survivor AWS named, or a
# second target group left beside the new one. The fixture's VPC is a scope
# nothing else in the account shares, and `aws elbv2 describe-target-groups`
# plus a JMESPath filter on `VpcId` sees every target group in it regardless of
# name. `--query` here projects ROWS (never `length(...)`, which the AWS CLI
# applies PER PAGE and would print one number per page).
#
# PHASES
#
#   1. deploy                       -> exactly one target group in the fixture
#                                      VPC, carrying the `<stack>-` prefix cdkd
#                                      minted, on Port 8080. Its name is
#                                      captured as TG_NAME and its ARN as ARN_1.
#   2. TG_PORT=8081 deploy --replace
#                                   -> THE ARM. Must SUCCEED. Before the fix it
#                                      failed at the forward replacement with
#                                      the unmatched collision.
#   3. THE ASSERTIONS               -> the ARN MOVED (leading, positive), still
#                                      exactly ONE target group in the VPC, it
#                                      still carries TG_NAME, and its Port is
#                                      8081.
#   4. destroy                      -> the target group gone by ARN and by NAME,
#                                      zero target groups left in the VPC, state
#                                      gone, events sidecar swept.
#
# BSD/macOS-portable: no `grep -P`, no `date -d`, no bash-4 builtins. Every
# `wc` capture is piped through `tr -d ' '` because BSD `wc` pads to width 8.
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

# --- capture ---------------------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CDKD} local invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the substitution fails, `set -e` kills the
# script BEFORE the assertion, and the CLI's stderr is already gone -- a log
# that ends at `[2/4] Invoking ...` with no error text (issue #3106's lane
# paid a re-run to learn a transient had hit; issue #3126 swept the shape).
# `capture` runs the command with its exit status captured EXPLICITLY. On a
# non-zero exit it prints the status, the last stdout line and the tail of
# the captured stderr, and emits NOTHING on stdout -- the assertion still
# runs and FAILS with its own text, and a response that happened to look
# right never passes a failed invoke (the old shape's one merit, kept). On
# success it emits the last stdout line. The stderr file is per call and
# removed here, so the EXIT trap chain carries no entry for it. Every
# fixture that uses this block carries it byte-for-byte (copy
# CANONICAL_CAPTURE_BLOCK from scripts/check-integ-capture-shape.ts); the
# fence is tests/unit/scripts/integ-verify-capture-shape.test.ts.
capture() {
  local out err rc=0
  err="$(mktemp)"
  out="$("$@" 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\n' "${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${err}" >&2
    rm -f "${err}"
    return 0
  fi
  rm -f "${err}"
  printf '%s\n' "${out}" | tail -1
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

# A pager invoked non-interactively is its own route to a hang (issue #1402).
export AWS_PAGER=""

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdElbv2SameName"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# The name cdkd mints for the UNNAMED target group:
# `generateResourceNameWithFallback(undefined, 'Tg', { maxLength: 32 })` ->
# `${STACK}-Tg`, 20 characters, under the type's 32-character cap — so
# `generateResourceName` never takes its truncate-plus-hash branch and the
# prefix assertions below compare against the plain `${STACK}-`. Used by the
# teardown sweep, which must be able to name the target group before any phase
# has read one back.
GENERATED_TG_NAME="${STACK}-Tg"

PORT_1=8080   # the template's default; also asserted live in phase 1
PORT_2=8081   # what TG_PORT carries into phase 2's replacement

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"
CLI="node ${LOCAL_DIST}"

# Resolved during the run; declared here so the teardown trap (which can fire
# before they are set) never reads an unbound name.
LOGICAL_ID=""
VPC_ID=""
TG_NAME=""
ARN_1=""
ARN_2=""
DEPLOY_LOG=""

# --- state readers ----------------------------------------------------------
# `record` matches the state key by PREFIX rather than guessing it, and
# hard-fails on an empty match: a guessed key would make every assertion below
# read `null` and pass vacuously. The intermediate capture carries its own
# emptiness guard, which is what keeps a failed `s3 cp` from reaching the
# formatting tail with an exit status of 0.
record() { # usage: record <jq-expression-over-the-resource-object>
  local json key
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null) || return 1
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  key=$(printf '%s' "${json}" | jq -r --arg p "${LOGICAL_ID}" \
    '.resources | keys[] | select(startswith($p))' | head -1)
  [ -n "${key}" ] || { echo "FAIL: no state resource whose logical id starts with ${LOGICAL_ID}" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "${key}" ".resources[\$k] | $1"
}

state_output() { # usage: state_output <OutputKey>
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null) || return 1
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "$1" '.outputs[$k] // empty'
}

# --- live readers -----------------------------------------------------------
# Target groups are enumerated by VPC, never by name prefix: see the header.
# `sort()` keeps the readback order-insensitive on both sides of a comparison.
#
# The empty-VPC guard is load-bearing rather than defensive: with an empty
# `VPC_ID` the filter becomes `?VpcId==''`, which in JMESPath matches nothing —
# but a target group of `targetType: lambda` carries NO `VpcId` at all, and a
# future rewrite reaching for `VpcId==null` would silently widen this to every
# Lambda target group in the account. Refuse the empty scope outright.
tgs_in_vpc() { # echoes the fixture VPC's target group NAMES, whitespace-separated
  [ -n "${VPC_ID}" ] || { echo "FAIL: tgs_in_vpc called with an empty VPC_ID" >&2; exit 1; }
  aws elbv2 describe-target-groups --region "${REGION}" \
    --query "sort(TargetGroups[?VpcId=='${VPC_ID}'].TargetGroupName)" --output text
}

# `elbv2 describe-target-groups` is a listing, and a listing taken moments after
# a create or a delete can lag. A lagging read here does not just flake — it
# prints a message that ACCUSES THE FIX ("the replacement did not reuse the
# generated name"), which is the anti-pattern `.claude/rules/testing.md` names.
#
# This retries until the listing equals the EXPECTED NAME LIST. It settles on
# the NAMES and not on a COUNT, and the difference matters: a listing still
# reflecting the pre-replacement world holds exactly ONE target group, so a
# count predicate converges on the FIRST read and the caller prints the
# accusing text anyway, for an infra delay. The count is subsumed — equal lists
# have equal lengths.
#
# It cannot mask the regression it exists to catch. On a broken tree phase 2
# FAILS outright (the deploy dies at the forward replacement), so this helper is
# never reached with a wrong world to converge on; and where it is reached, a
# genuinely wrong listing never equals the expectation, so the budget is spent
# in full and the caller fails with its own #3208 text.
tgs_in_vpc_settled() { # usage: tgs_in_vpc_settled "<expected names, or empty>"
  local want="$1" names="" attempt=0
  while [ "${attempt}" -lt 12 ]; do
    # `|| names=""` because this is a BARE assignment under `set -e`: without
    # it a single throttled or 5xx `describe-target-groups` aborts the whole
    # run from inside the substitution — in the helper whose entire job is
    # absorbing transient reads of this API.
    names="$(tgs_in_vpc)" || names=""
    if [ "${names}" = "${want}" ]; then
      printf '%s' "${names}"
      return 0
    fi
    attempt=$((attempt + 1))
    # No sleep after the last attempt — it would add 5s per call site to a run
    # that has already decided to give up.
    [ "${attempt}" -lt 12 ] && sleep 5
  done
  # Budget spent: hand back what the last read saw and let the CALLER fail with
  # its own assertion text, which names what it expected. Returning 0 here is
  # deliberate — a non-zero would abort under `set -e` before that message.
  printf '%s' "${names}"
}

count_words() { # usage: count_words "<string>"  -- BSD `wc` pads to width 8
  printf '%s\n' "$1" | wc -w | tr -d ' '
}

# --- teardown ---------------------------------------------------------------
# Best-effort orphan sweep. Runs pre-run, from the failure traps, and from the
# EXIT trap. The body is a SUBSHELL so `set +eu` dies with it and can never
# re-arm or relax strict mode in the caller.
#
# The destructive sweeps are dominated by a `case` whose ACCEPTING arm comes
# FIRST and whose pattern carries a literal prefix that cannot match an empty
# `STACK` (which `set +eu` would otherwise let through, widening every filter
# below to the whole account). The catch-all leaves via `exit 0` — inside the
# subshell that abandons only the sweep.
#
# The VPC is deliberately NOT swept here: unwinding one by hand means subnets,
# route tables and an internet gateway, and `cdkd destroy` (run by `teardown`
# just above this) already owns it. What this sweep exists for is the TARGET
# GROUP, whose surviving NAME is the one thing that would wedge the next run —
# the create-first attempt would collide on it, which is precisely the condition
# under test.
sweep_orphans() {
  (
  set +eu

  case "${STACK}" in
    CdkdElbv2SameName*)
      : # the fixture's own scope — proceed
      ;;
    *)
      echo "[verify] teardown sweep refused: STACK is not this fixture's own name (got: '${STACK}')" >&2
      exit 0
      ;;
  esac

  # 1. The target group cdkd names deterministically. Looked up BY NAME, which
  #    is the only handle available before any phase has read an ARN back.
  #    `delete-target-group` takes an ARN only, so the name has to be resolved
  #    first; the read is silenced and its emptiness checked, which is the
  #    best-effort-cleanup shape rather than a leak assertion.
  local tg_arn
  tg_arn="$(aws elbv2 describe-target-groups --names "${GENERATED_TG_NAME}" --region "${REGION}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
  if [ -n "${tg_arn}" ] && [ "${tg_arn}" != "None" ]; then
    echo "[verify]   deleting orphan target group ${GENERATED_TG_NAME}"
    aws elbv2 delete-target-group --target-group-arn "${tg_arn}" --region "${REGION}" >/dev/null 2>&1 || true
  fi

  # 2. EVERY target group in the fixture VPC. This is the only pass that can
  #    see a target group under a name this script never predicted — a survivor
  #    left beside the new one by a half-completed replacement. Guarded on a
  #    non-empty VPC_ID: under `set +eu` an unset one would make the filter
  #    `?VpcId==''`, and the same-shaped `VpcId==null` rewrite would match every
  #    Lambda target group in the account.
  if [ -n "${VPC_ID:-}" ]; then
    local arn
    for arn in $(aws elbv2 describe-target-groups --region "${REGION}" \
      --query "TargetGroups[?VpcId=='${VPC_ID}'].TargetGroupArn" --output text 2>/dev/null || true); do
      [ -z "${arn}" ] && continue
      [ "${arn}" = "None" ] && continue
      echo "[verify]   deleting target group ${arn} left in ${VPC_ID}"
      aws elbv2 delete-target-group --target-group-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi

  # 3. cdkd state + the events sidecar. `state destroy` takes the `:-` form:
  #    this helper runs under `set +eu` from a trap that can fire before the
  #    script's own STATE_BUCKET guard, and an empty value is treated as
  #    not-supplied by `resolveStateBucket()`.
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  )
}

teardown() {
  echo "[verify] teardown: sweeping fixture resources"
  # A live stack is destroyed through cdkd first so the sweep above has less
  # to do; guarded on the state object's presence, which is a best-effort
  # cleanup guard rather than a leak assertion.
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ] \
    && aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
    echo "[verify]   cdkd destroy ${STACK}"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >/dev/null 2>&1 || true
  fi
  sweep_orphans
  [ -n "${DEPLOY_LOG}" ] && rm -f "${DEPLOY_LOG}"
  return 0
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — running teardown"
  fi
  teardown
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
# PRE-FLIGHT
# ---------------------------------------------------------------------------
[ -n "${STATE_BUCKET:-}" ] || { echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1; }
[ -f "${LOCAL_DIST}" ] || { echo "FAIL: build cdkd first (vp run build) — no ${LOCAL_DIST}" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"
echo "[verify] pre-run teardown"
teardown

# Resolve the CFn logical id from the synthesized template (it is `Tg`).
# Deriving it rather than hardcoding keeps the fixture working if a CDK upgrade
# ever changes how the id is allocated.
${CLI} synth --region "${REGION}" >/dev/null
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
LOGICAL_ID=$(jq -r '.Resources | to_entries[]
  | select(.value.Type == "AWS::ElasticLoadBalancingV2::TargetGroup") | .key' "${TEMPLATE}" | head -1)
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no AWS::ElasticLoadBalancingV2::TargetGroup in ${TEMPLATE}" >&2; exit 1; }

# THE FIXTURE MUST CONTAIN THE FEATURE UNDER TEST. A template that grew a `Name`
# here would replace the target group under a name of the user's choosing, which
# COLLIDES WITH NOTHING — the `--replace` delete-first fallback would never be
# reached and phase 2 would pass identically with and without the #3208 fix.
# Fail here rather than run a vacuous test.
jq -e --arg k "${LOGICAL_ID}" \
  '(.Resources[$k].Properties // {}) | has("Name") | not' "${TEMPLATE}" >/dev/null \
  || { echo "FAIL: ${LOGICAL_ID} declares a Name in ${TEMPLATE}. This fixture only exercises #3208 while the target group is UNNAMED — a named one is replaced under a DIFFERENT name and never collides." >&2; exit 1; }

# The other half of the same guard: phase 2 must change a CREATE-ONLY property,
# or there is no replacement at all. `Port` is create-only for this type; this
# pins that the pre-flight synth (no `TG_PORT`) really carries the baseline
# value phase 1 then asserts live.
TEMPLATE_PORT=$(jq -r --arg k "${LOGICAL_ID}" '.Resources[$k].Properties.Port // ""' "${TEMPLATE}")
[ "${TEMPLATE_PORT}" = "${PORT_1}" ] || { echo "FAIL: ${LOGICAL_ID} synthesizes Port '${TEMPLATE_PORT}' with TG_PORT unset, expected ${PORT_1}. The TG_PORT seam has drifted and phase 2 would not be changing what this script thinks it is." >&2; exit 1; }
echo "[verify] resource under test: ${LOGICAL_ID} (unnamed in the template, Port ${TEMPLATE_PORT})"

# ---------------------------------------------------------------------------
# PHASE 1: deploy — cdkd mints the name
# ---------------------------------------------------------------------------
echo "[verify] phase 1: cdkd deploy ${STACK} (no seams — Port ${PORT_1})"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VPC_ID=$(state_output VpcId)
[ -n "${VPC_ID}" ] || { echo "FAIL: no VpcId output in state after phase 1 — every enumeration below is scoped by it" >&2; exit 1; }
case "${VPC_ID}" in
  vpc-*) : ;;
  *) echo "FAIL: the VpcId output is '${VPC_ID}', which is not a VPC id. The target-group enumeration would be scoped to nothing." >&2; exit 1 ;;
esac

# Phase 1 reads the listing DIRECTLY rather than through `tgs_in_vpc_settled`,
# and not for lack of care: the settled form converges on an EXPECTED name list,
# and the whole point of this read is to learn a name nothing has asserted yet.
TGS_1=$(tgs_in_vpc)
N_1=$(count_words "${TGS_1}")
[ "${N_1}" = "1" ] || { echo "FAIL: expected exactly 1 target group in ${VPC_ID} after phase 1, found ${N_1}: ${TGS_1}" >&2; exit 1; }
TG_NAME="${TGS_1}"

# cdkd GENERATED the name — that is the premise the collision rests on. A
# user-named target group would be replaced under whatever the user chose.
case "${TG_NAME}" in
  "${STACK}-"*) : ;;
  *) echo "FAIL: the target group name '${TG_NAME}' does not carry the '${STACK}-' prefix, so cdkd did not generate it. #3208's collision only occurs because both deploys mint the SAME name from the stack name and logical id." >&2; exit 1 ;;
esac
[ "${TG_NAME}" = "${GENERATED_TG_NAME}" ] || { echo "FAIL: cdkd minted '${TG_NAME}' but this script's teardown sweep looks for '${GENERATED_TG_NAME}'. A name the sweep cannot predict is a name it cannot clean up." >&2; exit 1; }

ARN_1=$(capture aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
[ -n "${ARN_1}" ] || { echo "FAIL: could not read the TargetGroupArn for ${TG_NAME} after phase 1 — phase 3's replacement sentinel would be unfalsifiable" >&2; exit 1; }

# State, the resolved Output and live AWS must all describe the SAME target
# group, or every later assertion is reading one of three different resources.
STATE_ARN_1=$(record '.physicalId')
[ "${STATE_ARN_1}" = "${ARN_1}" ] || { echo "FAIL: state records physicalId '${STATE_ARN_1}' but AWS reports '${ARN_1}' for ${TG_NAME}" >&2; exit 1; }
OUT_ARN_1=$(state_output TargetGroupArn)
[ "${OUT_ARN_1}" = "${ARN_1}" ] || { echo "FAIL: the TargetGroupArn output is '${OUT_ARN_1}' but the live ARN is '${ARN_1}' — Ref on AWS::ElasticLoadBalancingV2::TargetGroup must resolve to the ARN" >&2; exit 1; }

LIVE_PORT_1=$(capture aws elbv2 describe-target-groups --target-group-arns "${ARN_1}" --region "${REGION}" \
  --query 'TargetGroups[0].Port' --output text)
[ "${LIVE_PORT_1}" = "${PORT_1}" ] || { echo "FAIL: the target group's live Port is '${LIVE_PORT_1}', expected ${PORT_1}. Phase 2 changes Port to ${PORT_2}; without a known baseline the change proves nothing." >&2; exit 1; }
echo "[verify] phase 1 ok: '${TG_NAME}' in ${VPC_ID} on port ${LIVE_PORT_1} (${ARN_1})"

# ---------------------------------------------------------------------------
# PHASE 2: THE ARM — TG_PORT=8081 deploy --replace
# ---------------------------------------------------------------------------
# `Port` is create-only, so this is a REPLACEMENT, and the target group is
# unnamed, so the new one must carry the SAME name the old one still holds. The
# create-first attempt therefore collides with
# `DuplicateTargetGroupNameException`, and only `--replace`'s delete-first
# fallback can finish the deploy — which it can only do if that exception is
# recognised as a name collision.
#
# `--replace` is declared on `deploy` (`replaceOption` in `deployOptions`,
# src/cli/options.ts), the subcommand it targets here. No
# `--force-stateful-recreation`: `AWS::ElasticLoadBalancingV2::TargetGroup` is
# not in `STATEFUL_TYPES`, so the stateful guard never fires and the run stays
# representative of what a user would type.
#
# The deploy's rc is captured explicitly instead of riding `set -e`, so the
# failure message below actually gets printed — on a broken tree this is the
# step that dies, and a bare abort would leave a reader with the CLI's output
# and no pointer to the issue.
echo "[verify] phase 2: TG_PORT=${PORT_2} cdkd deploy ${STACK} --replace (MUST SUCCEED)"
DEPLOY_LOG="$(mktemp)"
set +e
TG_PORT="${PORT_2}" ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --replace --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${DEPLOY_LOG}" || true
[ "${DEPLOY_RC}" -eq 0 ] || { echo "FAIL: the same-name replacement deploy FAILED (rc=${DEPLOY_RC}). This is the arm for go-to-k/cdkd#3208. Read the log above: the deploy dies at the FORWARD REPLACEMENT — the create-first attempt for ${LOGICAL_ID} collides with the live target group '${TG_NAME}', which still holds the name, and the run then reports 'No completed operations to roll back'. The likely cause is NOT in the ELBv2 provider and NOT in the replacement planner: it is that isNameCollisionErrorFrom (src/deployment/retryable-errors.ts) does not recognise this service's duplicate-name spelling, so --replace's delete-first fallback never engages. ELBv2 states the condition as exception name 'DuplicateTargetGroupNameException' with the message \"A target group with the same name '...' exists, but with different settings\" — no 'already exists', no error code in the text — so the message-only predicate misses it and NAME_COLLISION_ERROR_NAMES is what must carry it. Do not go hunting elsewhere." >&2; exit 1; }

# THE FALLBACK ACTUALLY ENGAGED, not merely "the deploy succeeded". Without this
# the whole fixture passes on a future tree where the planner delete-firsts by
# default, or where the collision never happens — neither of which says anything
# about go-to-k/cdkd#3208. `Re-creating <id>...` is emitted ONLY by the
# delete-first fallback (`deploy-engine.ts`, the sole `Re-creating` in the file);
# the create-first path says `Creating new <id>...`.
#
# SENTINEL, so a reworded log cannot read as "the fallback did not run": the
# `Old resource deleted` line is a second, independent marker on the same path.
# If it is present while `Re-creating` is absent, the wording drifted and this
# assertion has gone blind — say so rather than blaming the fix.
if ! grep -q "Re-creating ${LOGICAL_ID}" "${DEPLOY_LOG}"; then
  if grep -q 'Old resource deleted' "${DEPLOY_LOG}"; then
    echo "FAIL: the delete-first fallback ran (saw 'Old resource deleted') but this check greps for 'Re-creating ${LOGICAL_ID}' and did not find it. cdkd's wording drifted; fix THIS grep, do not read it as a go-to-k/cdkd#3208 regression." >&2
  else
    echo "FAIL: --replace succeeded but the delete-first fallback never engaged — no 'Re-creating ${LOGICAL_ID}' in the deploy log. The replacement completed some other way, so this run proves NOTHING about go-to-k/cdkd#3208, whose whole subject is that fallback being reachable for ELBv2." >&2
  fi
  exit 1
fi
echo "[verify] phase 2 ok: --replace completed the same-name replacement (rc=0)"

# ---------------------------------------------------------------------------
# PHASE 3: THE ASSERTIONS — what the replacement actually did
# ---------------------------------------------------------------------------
echo "[verify] phase 3: assert the target group was REPLACED under the same name"

# 3a. SENTINEL FIRST, and POSITIVE. Every other assertion in this phase —
#     "exactly one target group", "still named TG_NAME", even "Port is 8081" if
#     an in-place modify ever became possible for a create-only property — is
#     ALSO satisfied by "nothing was replaced". That is a VACUOUS pass. A
#     CHANGED `TargetGroupArn` is the only signal that the old target group was
#     really destroyed and a NEW one created in its place: the ARN is this
#     type's `primaryIdentifier`, so it cannot survive a replacement, and it
#     cannot change without one.
ARN_2=$(capture aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
[ -n "${ARN_2}" ] || { echo "FAIL: no target group named '${TG_NAME}' exists after the replacement — the delete-first fallback deleted the old one and the re-create never landed" >&2; exit 1; }
[ "${ARN_2}" != "${ARN_1}" ] || { echo "FAIL: '${TG_NAME}' still carries its phase-1 ARN (${ARN_1}) — it was never destroyed and re-created, so the replacement path was NEVER ENTERED and this run proves NOTHING about #3208. Check the deploy log above: if it reports no changes, the TG_PORT seam did not reach the template." >&2; exit 1; }

# 3b. Exactly ONE target group in the fixture VPC. Enumerating by VpcId (not by
#     name prefix) is what makes a survivor visible: a create-first attempt that
#     somehow succeeded beside the old one, or an old one the fallback failed to
#     delete, would both sit here under a name a prefix query might still match.
POST_TGS=$(tgs_in_vpc_settled "${TG_NAME}")
N_POST=$(count_words "${POST_TGS}")
[ "${N_POST}" = "1" ] || { echo "FAIL: expected exactly 1 target group in ${VPC_ID} after the replacement, found ${N_POST}: ${POST_TGS}. More than one means the old target group was not deleted; zero means the replacement's re-create never landed." >&2; exit 1; }

# 3c. The replacement REUSED the generated name. That is what makes this a
#     same-name replacement and therefore what made it collide at all.
[ "${POST_TGS}" = "${TG_NAME}" ] || { echo "FAIL: the target group in ${VPC_ID} is now named '${POST_TGS}', not '${TG_NAME}'. The replacement did not reuse cdkd's generated name, so this run exercised an ordinary rename and never reached #3208's collision." >&2; exit 1; }

# 3d. The replacement actually applied the new create-only value.
LIVE_PORT_2=$(capture aws elbv2 describe-target-groups --target-group-arns "${ARN_2}" --region "${REGION}" \
  --query 'TargetGroups[0].Port' --output text)
[ "${LIVE_PORT_2}" = "${PORT_2}" ] || { echo "FAIL: the replaced target group's live Port is '${LIVE_PORT_2}', expected ${PORT_2}" >&2; exit 1; }

# 3e. State and the resolved Output followed the new resource. Without this the
#     next deploy would address the deleted ARN.
STATE_ARN_2=$(record '.physicalId')
[ "${STATE_ARN_2}" = "${ARN_2}" ] || { echo "FAIL: state records physicalId '${STATE_ARN_2}' but the live target group is '${ARN_2}' — the replacement did not update the state record" >&2; exit 1; }
OUT_ARN_2=$(state_output TargetGroupArn)
[ "${OUT_ARN_2}" = "${ARN_2}" ] || { echo "FAIL: the TargetGroupArn output is '${OUT_ARN_2}' but the live ARN is '${ARN_2}' — the outputs were not re-resolved after the replacement" >&2; exit 1; }
echo "[verify] phase 3 ok: '${TG_NAME}' replaced in place of its name — ARN ${ARN_1} -> ${ARN_2}, port ${LIVE_PORT_1} -> ${LIVE_PORT_2}"

# ---------------------------------------------------------------------------
# PHASE 4: destroy — everything gone
# ---------------------------------------------------------------------------
echo "[verify] phase 4: cdkd destroy ${STACK}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# By ARN: this exact resource is gone. `describe-target-groups` answers a
# deleted ARN with `TargetGroupNotFound` / "... not found", which is the
# canonical not-found signature `gone_probe` accepts (same probe shape as
# `ecs-bluegreen/verify.sh`).
assert_gone "target group ${ARN_2} survived destroy" \
  aws elbv2 describe-target-groups --target-group-arns "${ARN_2}" --region "${REGION}"

# By NAME: nothing holds the generated name any more. Distinct from the ARN
# probe — a replacement-shaped leak would free the ARN while keeping the name
# occupied, and an occupied name is exactly what wedges the next run.
assert_gone "the generated name ${TG_NAME} is still taken after destroy" \
  aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${REGION}"

# Zero left in the VPC, which the name-scoped and ARN-scoped probes above cannot
# see. `cdkd destroy` removes the target group AND the VPC in one command, so
# this necessarily runs after the VPC is gone — it is still the right check:
# `VPC_ID` is captured, the filter is a plain string compare against a value AWS
# keeps on every surviving target group, and a leaked one would both appear here
# and (by holding a reference into the VPC) have failed the destroy above.
LEFTOVER_TGS=$(tgs_in_vpc_settled "")
N_LEFT=$(count_words "${LEFTOVER_TGS}")
[ "${N_LEFT}" = "0" ] || { echo "FAIL: ${N_LEFT} target group(s) still in ${VPC_ID} after destroy: ${LEFTOVER_TGS}" >&2; exit 1; }

assert_gone "state.json still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "[verify] phase 4 ok: the target group, its name, the VPC's target groups and the state are all gone"

# The events sidecar deliberately survives destroy, so the fixture removes it
# itself and then proves the prefix is clean.
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
# `--recursive` is load-bearing: a delimited `s3 ls` of this prefix returns only
# `PRE us-east-1/`, because state.json and `deployments/` sit one level deeper —
# so the `\.(jsonl|json)$` grep below could never match and the check could
# never fire (go-to-k/cdkd#3216 tracks the sibling fixtures still carrying the
# broken form).
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive 2>&1 || true)"
if printf '%s' "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "FAIL: events sidecar not fully removed:" >&2
  printf '%s\n' "${REMAINING}" | sed 's/^/  /' >&2
  exit 1
fi

rm -f "${DEPLOY_LOG}"
DEPLOY_LOG=""
trap - EXIT INT TERM
echo "[verify] PASS: elbv2-same-name-replacement (issue #3208)"
