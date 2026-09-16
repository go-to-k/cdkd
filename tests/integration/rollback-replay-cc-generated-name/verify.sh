#!/usr/bin/env bash
#
# verify.sh — real-AWS net for issue #3199: the rollback executor's
# `reverse-replacement` replay-CREATE must fill a `FALLBACK_NAME_RULES` name
# when the re-create is routed to Cloud Control.
#
# THE CLAIM UNDER TEST
#
# When a replacement is rolled back, cdkd re-CREATEs the OLD resource from its
# recorded `properties` bag. That bag NEVER holds a cdkd-generated physical
# name (the record is rebuilt from the template's resolved properties), so on
# the Cloud Control route the replay used to be the only create site sending no
# name at all — AWS minted a random one, and the restored resource silently
# stopped matching what the forward path mints for it. The fix runs the replay
# bag through `applyDefaultNameForFallback` when the ROUTING DECISION is
# `cc-api`.
#
# WHY `AWS::IAM::Role`
#
# Three constraints have to hold at once, and this type is the only cheap one
# that satisfies all three. Two earlier drafts failed on the first two, so the
# reasoning is recorded here rather than re-derived:
#
#   1. The replacement must CHANGE THE PHYSICAL ID, because that is what
#      `isReplacementOp` keys on. `RoleName` is both the primary identifier and
#      a create-only property, so changing the name IS the replacement trigger
#      and the id necessarily changes.
#   2. NO DUPLICATE-NAME COLLISION may occur anywhere on the path. The new role
#      is created under a DIFFERENT name, so the create-first attempt never
#      collides with the old one. This is not a theoretical nicety: every
#      collision-based route into this arm is currently blocked by
#      go-to-k/cdkd#3208 — `isNameCollisionError` keys on `already exist` /
#      `AlreadyExists` and does not match some services' spellings, e.g. ELBv2's
#
#        A target group with the same name 'CdkdReplayCcName-TargetGroup'
#        exists, but with different settings
#
#      so `--replace`'s delete-first fallback never engaged, the deploy died at
#      the forward replacement reporting "No completed operations to roll back",
#      and the reverse-replacement replay never ran. Two ELBv2 drafts died
#      exactly there. This fixture must not be hostage to that defect.
#   3. The type must NOT be in `STATEFUL_TYPES`. An ECR draft died here:
#      `--recreate-via-cc-api` refuses a stateful type without
#      `--force-stateful-recreation`, and a property-driven replacement of one
#      hits a SECOND guard. Forcing past both would make the fixture
#      unrepresentative of the path under test. IAM roles trip neither guard.
#
# `AWS::IAM::Role` is also the RIGHT discriminator. `RoleName` is OPTIONAL in
# CloudFormation, so on a tree WITHOUT the fix the replay's Cloud Control create
# succeeds and AWS mints a RANDOM name — the silent-divergence half of #3199,
# which is what the fix addresses for the table's types today.
#
# An IAM role's physical id IS its name, in state and on both routes.
#
# WHY AN EXPLICIT MIGRATION PHASE IS NEEDED
#
# All `FALLBACK_NAME_RULES` types have SDK providers, and an SDK-routed create
# is deliberately left alone (its provider mints the name itself). So a plain
# deploy can never reach the arm: phase 2 forces the role onto Cloud Control
# with `--recreate-via-cc-api`, which stamps `provisionedBy: 'cc-api'` on the
# state record and makes every later op sticky on that layer — which is why
# phase 3 needs no routing flag of its own.
#
# WHY PHASE 4 ENUMERATES BY `Path` AND NOT BY NAME PREFIX
#
# The regression this fixture exists to catch produces a role whose name AWS
# chose. A `starts_with(RoleName, 'CdkdReplayCcName')` query cannot see it, so
# an "exactly one, named CC_NAME" assertion built on a name prefix would pass on
# exactly the broken tree. Every role this fixture creates sits under
# `/cdkd-replay-ccname/` (the stack's `ROLE_PATH`, held constant across phases
# because `Path` is itself create-only), and `iam list-roles --path-prefix` is
# the only filter that sees BOTH the cdkd-named role and an AWS-named survivor.
#
# WHY PHASE 4 LEADS WITH A `CreateDate` SENTINEL
#
# Every other phase-4 assertion is ALSO satisfied by "the deploy refused before
# replacing anything, and nothing changed" — a VACUOUS pass. A CHANGED
# `Role.CreateDate` on the role named CC_NAME is the only signal that the old
# role was really destroyed by the forward replacement and RE-CREATED by the
# rollback replay. It runs first so a run that never entered the arm fails
# saying exactly that, instead of reporting a green that proves nothing.
#
# PHASES
#
#   1. deploy, no routing flags     -> role created on the SDK route, UNNAMED in
#                                      the template, so cdkd mints
#                                      `<stack>-<logicalId>`.
#   2. ROLE_DESCRIPTION=... deploy --recreate-via-cc-api Role
#                                   -> destroyed + re-created through Cloud
#                                      Control; the record flips to `cc-api` and
#                                      is asserted to hold NO `RoleName`; the
#                                      live name is captured as CC_NAME and the
#                                      live `CreateDate` as the phase-4 sentinel.
#   3. ROLE_EXPLICIT_NAME=<explicit> ROLE_DESCRIPTION=... REPLAY_CC_NAME_FAIL=true
#      deploy                       -> EXPECTED TO FAIL. Adding the explicit name
#                                      replaces the role (create-only AND the
#                                      primary identifier), under a DIFFERENT
#                                      name so nothing collides; the invalid
#                                      queue — which DEPENDS on the role, so the
#                                      replacement has already completed — is
#                                      then rejected by AWS and cdkd rolls back
#                                      in-process.
#   4. THE ARM                      -> exactly ONE role under the fixture path,
#                                      named CC_NAME, with a CHANGED CreateDate;
#                                      the explicitly-named one gone; state
#                                      agrees; no orphan queue.
#   5. destroy                      -> both role names and the state all gone.
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

STACK="CdkdReplayCcName"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FAILING_QUEUE_NAME="${STACK}-failing-queue"

# Must equal the stack class's `ROLE_PATH`. Phase 4 enumerates by it (see the
# header) and the pre-flight below asserts the synthesized template still
# carries it — a silent drift here would make the enumeration see nothing and
# the "exactly one" assertion fail for an unrelated reason.
ROLE_PATH="/cdkd-replay-ccname/"

# The name phase 3 ADDS to the template. It is the replacement trigger, and
# because it differs from the cdkd-generated name the create-first attempt has
# nothing to collide with (see constraint 2 in the header).
EXPLICIT_NAME="cdkd-replay-ccname-explicit"

# `AWS::IAM::Role`'s FALLBACK_NAME_RULES entry is
# `{ nameProperty: 'RoleName', options: { maxLength: 64 } }` — NO `lowercase`,
# unlike the S3/ECR entries — so both routes mint the stack name verbatim:
# `CdkdReplayCcName-Role`, 21 characters. That is well under IAM's 64-character
# RoleName cap, so `generateResourceName` never takes its truncate-plus-hash
# branch and the prefix assertions below compare against the plain `${STACK}-`.

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"
CLI="node ${LOCAL_DIST}"

# Resolved during the run; declared here so the teardown trap (which can fire
# before they are set) never reads an unbound name.
LOGICAL_ID=""
SDK_NAME=""
CC_NAME=""
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
# Roles are enumerated by PATH, never by name prefix: see the header. `sort()`
# keeps the readback order-insensitive on both sides of a comparison.
roles_under_path() { # echoes the fixture path's role NAMES, whitespace-separated
  [ -n "${ROLE_PATH}" ] || { echo "FAIL: roles_under_path called with an empty ROLE_PATH" >&2; exit 1; }
  aws iam list-roles --path-prefix "${ROLE_PATH}" --region "${REGION}" \
    --query 'sort(Roles[].RoleName)' --output text
}

# `iam list-roles` is EVENTUALLY CONSISTENT, and the read that matters most sits
# right after the rollback re-created a role. A lagging listing there does not
# just flake — it prints a message that ACCUSES THE FIX ("the rollback restored
# the role under '', not the generated name"), which is the anti-pattern
# `.claude/rules/testing.md` names: the failure text blames the change under
# test for an infrastructure delay.
#
# This retries until the listing equals the EXPECTED NAME LIST. It settles on
# the NAMES and not on a COUNT, and the difference is the whole point: a
# listing still reflecting the pre-rollback world holds exactly ONE role — the
# explicitly-named one — so a count predicate converges on the FIRST read and
# the caller prints the accusing text anyway, for an infra delay. The count is
# subsumed: equal lists have equal lengths.
#
# It cannot mask the regression it exists to catch. On a broken tree the listing
# holds one role under an AWS-MINTED name, which never equals the expected name,
# so the budget is spent in full and the caller then fails with its own #3199
# text. The cost of a genuine regression is 60s; the benefit is that a lagging
# read does not masquerade as one.
roles_under_path_settled() { # usage: roles_under_path_settled "<expected names, or empty>"
  local want="$1" names="" attempt=0
  while [ "${attempt}" -lt 12 ]; do
    # `|| names=""` because this is a BARE assignment under `set -e`: without
    # it a single throttled or 5xx `list-roles` aborts the whole run from
    # inside the substitution — in the helper whose entire job is absorbing
    # transient reads of this API.
    names="$(roles_under_path)" || names=""
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
sweep_orphans() {
  (
  set +eu

  case "${STACK}" in
    CdkdReplayCcName*)
      : # the fixture's own scope — proceed
      ;;
    *)
      echo "[verify] teardown sweep refused: STACK is not this fixture's own name (got: '${STACK}')" >&2
      exit 0
      ;;
  esac

  # 1. The injected failing queue (deterministic name). AWS rejects its
  #    creation, so normally nothing exists; a half-created queue would block
  #    nothing but must not be left billing a name.
  local q_url
  q_url="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true)"
  if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
    echo "[verify]   deleting orphan queue ${FAILING_QUEUE_NAME}"
    aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi

  # 2. Roles, in two passes on purpose. First the two names this fixture knows
  #    (the cdkd-generated one and the explicit one phase 3 replaces into),
  #    then EVERY role under the fixture path — the second pass is the only one
  #    that can see a role AWS named randomly, which is exactly what the #3199
  #    regression leaves behind. The path is a LITERAL, not derived from
  #    `${STACK}`, so `set +eu` cannot widen it.
  #
  #    A role under a path is deleted BY NAME only — `delete-role` takes no
  #    path argument. The deletes are issued unconditionally rather than behind
  #    a read probe: the absent case is the normal one, and a silenced read
  #    probe guarding a branch that says "orphan" is the exact shape issue
  #    #1097 pattern 2 bans. IAM requires a role's inline and attached policies
  #    to be removed first; this fixture attaches none, so a bare `delete-role`
  #    suffices and `|| true` absorbs the NoSuchEntity of the normal case.
  local role_name
  for role_name in "${STACK}-Role" "${EXPLICIT_NAME}"; do
    [ -z "${role_name}" ] && continue
    echo "[verify]   deleting role ${role_name} if it exists"
    aws iam delete-role --role-name "${role_name}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for role_name in $(aws iam list-roles --path-prefix "${ROLE_PATH}" --region "${REGION}" \
    --query 'Roles[].RoleName' --output text 2>/dev/null || true); do
    [ -z "${role_name}" ] && continue
    [ "${role_name}" = "None" ] && continue
    echo "[verify]   deleting role ${role_name} left under ${ROLE_PATH}"
    aws iam delete-role --role-name "${role_name}" --region "${REGION}" >/dev/null 2>&1 || true
  done

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

# Resolve the CFn logical id from the synthesized template (it is `Role`).
# `--recreate-via-cc-api` validates its argument against the template's OWN
# logical ids, so a construct id fails pre-flight; deriving it also keeps the
# fixture working if a CDK upgrade ever changes how the id is allocated.
${CLI} synth --region "${REGION}" >/dev/null
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
LOGICAL_ID=$(jq -r '.Resources | to_entries[]
  | select(.value.Type == "AWS::IAM::Role") | .key' "${TEMPLATE}" | head -1)
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no AWS::IAM::Role in ${TEMPLATE}" >&2; exit 1; }

# The fixture must CONTAIN the feature under test: `applyDefaultNameForFallback`
# is a no-op when the bag already names the resource, so a template that grew a
# `RoleName` here (the pre-flight synth runs with NO env seams, so the role must
# be unnamed) would make every assertion below pass identically with and without
# the #3199 fix. Fail here rather than run a vacuous test.
jq -e --arg k "${LOGICAL_ID}" \
  '(.Resources[$k].Properties // {}) | has("RoleName") | not' "${TEMPLATE}" >/dev/null \
  || { echo "FAIL: ${LOGICAL_ID} declares a RoleName in ${TEMPLATE}. This fixture only exercises #3199 while the role is UNNAMED — the fill is a no-op otherwise." >&2; exit 1; }

# The enumeration phase 4 rests on is only as good as the path it filters by.
# If the stack's ROLE_PATH ever drifts from this script's copy, `list-roles
# --path-prefix` would return nothing and phase 4 would fail for a reason that
# has nothing to do with #3199.
TEMPLATE_PATH=$(jq -r --arg k "${LOGICAL_ID}" '.Resources[$k].Properties.Path // ""' "${TEMPLATE}")
[ "${TEMPLATE_PATH}" = "${ROLE_PATH}" ] || { echo "FAIL: ${LOGICAL_ID} declares Path '${TEMPLATE_PATH}' but this script enumerates '${ROLE_PATH}'. Phase 4's list-roles --path-prefix would see nothing." >&2; exit 1; }
echo "[verify] resource under test: ${LOGICAL_ID} (unnamed in the template, under ${ROLE_PATH})"

# ---------------------------------------------------------------------------
# PHASE 1: deploy on the default route — the SDK provider mints the name
# ---------------------------------------------------------------------------
echo "[verify] phase 1: cdkd deploy ${STACK} (no routing flags, no env seams)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LAYER0=$(record '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0}, expected sdk. Phase 2's migration would then be a no-op and every assertion below vacuous." >&2; exit 1; }

# An IAM role's physical id IS its name, on both routes and in state.
SDK_NAME=$(record '.physicalId')
[ -n "${SDK_NAME}" ] || { echo "FAIL: state record has no physicalId after phase 1" >&2; exit 1; }
case "${SDK_NAME}" in
  "${STACK}-"*) : ;;
  *) echo "FAIL: the SDK route did not mint a cdkd-generated name (got '${SDK_NAME}', expected the '${STACK}-' prefix)" >&2; exit 1 ;;
esac

# Phase 1 deliberately does NOT enumerate by path. `list-roles` is eventually
# consistent, so every enumeration is a chance for a freshly-created role to be
# missing for reasons that have nothing to do with #3199 — and this one would
# buy nothing: the pre-flight already pinned the template's `Path`, and phase 2
# exercises the enumeration itself before phase 4 leans on it.

# The `RoleName` Output is a `Ref` to the role, which CloudFormation defines as
# the role NAME — so it must agree with the recorded physicalId. A disagreement
# means the record and the resolved template describe different resources, and
# every later assertion reads one of them.
OUT_NAME=$(state_output RoleName)
[ "${OUT_NAME}" = "${SDK_NAME}" ] || { echo "FAIL: the RoleName output is '${OUT_NAME}' but the state physicalId is '${SDK_NAME}' — Ref on AWS::IAM::Role must resolve to the role name" >&2; exit 1; }
echo "[verify] phase 1 ok: SDK-routed role '${SDK_NAME}'"

# ---------------------------------------------------------------------------
# PHASE 2: migrate the resource onto Cloud Control
# ---------------------------------------------------------------------------
# ROLE_DESCRIPTION carries a REAL property change: `--recreate-via-cc-api` on an
# otherwise-unchanged template prints its warning and then does nothing, because
# the differ classifies the resource NO_CHANGE and the engine never provisions
# it (go-to-k/cdkd#2651). Without a change here the record would never flip and
# phase 3 would run on the SDK route.
MIGRATED_DESCRIPTION='cdkd #3199 migrated'
echo "[verify] phase 2: ROLE_DESCRIPTION='${MIGRATED_DESCRIPTION}' cdkd deploy --recreate-via-cc-api ${LOGICAL_ID}"
ROLE_DESCRIPTION="${MIGRATED_DESCRIPTION}" ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --recreate-via-cc-api "${LOGICAL_ID}" --yes

LAYER1=$(record '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: after --recreate-via-cc-api the record says provisionedBy=${LAYER1}, expected cc-api. The migration did not take, so the rollback below would replay on the SDK route and #3199's arm would never run." >&2; exit 1; }

# THE PREMISE THE WHOLE FIX RESTS ON: the recorded bag never holds a generated
# name. If this ever becomes true, `applyDefaultNameForFallback` takes its
# no-op branch in the replay and the fixture stops testing anything.
HAS_NAME=$(record '.properties | has("RoleName")')
[ "${HAS_NAME}" = "false" ] || { echo "FAIL: the state record's properties bag holds a RoleName key (has(\"RoleName\")=${HAS_NAME}). #3199's premise is that it never does — the replay fill would be a no-op and this fixture vacuous." >&2; exit 1; }

# The SECOND half of the premise, and it is a LEAK guard rather than a vacuity
# guard. The replay re-creates from this same bag, so it is the bag's `Path`
# that decides where the restored role lands. If the record ever stopped
# carrying one, the replay would create at `/` under an AWS-minted name —
# invisible to phase 4's `--path-prefix` enumeration AND to both cleanup sweeps,
# i.e. a silent leak that the run would still report as PASS.
RECORDED_PATH=$(record '.properties.Path // empty')
[ "${RECORDED_PATH}" = "${ROLE_PATH}" ] || { echo "FAIL: the state record's Path is '${RECORDED_PATH}', expected '${ROLE_PATH}'. The replay creates from this bag, so a missing or different Path puts the restored role outside the prefix every assertion and every sweep in this fixture looks under." >&2; exit 1; }

CC_NAME=$(record '.physicalId')
[ -n "${CC_NAME}" ] || { echo "FAIL: state record has no physicalId after phase 2" >&2; exit 1; }
case "${CC_NAME}" in
  "${STACK}-"*) : ;;
  *) echo "FAIL: the Cloud Control re-create did not carry a cdkd-generated name (got '${CC_NAME}', expected the '${STACK}-' prefix). preparePropertiesForCcApi should have filled it." >&2; exit 1 ;;
esac
[ "${CC_NAME}" = "${SDK_NAME}" ] || { echo "FAIL: the Cloud Control route minted '${CC_NAME}' where the SDK route minted '${SDK_NAME}'. Both are supposed to produce the SAME name — that equality is the invariant #3199 extends to the rollback replay." >&2; exit 1; }

CC_ROLES=$(roles_under_path_settled "${CC_NAME}")
N_CC=$(count_words "${CC_ROLES}")
[ "${N_CC}" = "1" ] || { echo "FAIL: expected exactly 1 role under ${ROLE_PATH} after phase 2, found ${N_CC}: ${CC_ROLES}" >&2; exit 1; }
[ "${CC_ROLES}" = "${CC_NAME}" ] || { echo "FAIL: the role under ${ROLE_PATH} is '${CC_ROLES}' but state records '${CC_NAME}'" >&2; exit 1; }

# Non-vacuous seeding: without this, "provisionedBy is cc-api" is equally
# explained by "nothing was provisioned at all".
DESC_SEEDED=$(capture aws iam get-role --role-name "${CC_NAME}" --region "${REGION}" \
  --query 'Role.Description' --output text)
[ "${DESC_SEEDED}" = "${MIGRATED_DESCRIPTION}" ] || { echo "FAIL: the Cloud Control re-create did not reach AWS (Role.Description='${DESC_SEEDED}', expected '${MIGRATED_DESCRIPTION}')" >&2; exit 1; }

# THE PHASE-4 SENTINEL. Captured here, compared in 4a: the role the rollback
# restores must be a DIFFERENT role object than this one.
CREATED_AT_1=$(capture aws iam get-role --role-name "${CC_NAME}" --region "${REGION}" \
  --query 'Role.CreateDate' --output text)
[ -n "${CREATED_AT_1}" ] || { echo "FAIL: could not read Role.CreateDate for ${CC_NAME} after phase 2 — the phase-4 sentinel would be unfalsifiable" >&2; exit 1; }
echo "[verify] phase 2 ok: cc-api-routed role '${CC_NAME}' (CreateDate=${CREATED_AT_1}), record holds no RoleName"

# ---------------------------------------------------------------------------
# PHASE 3: add an explicit name + injected failure — EXPECTED TO FAIL
# ---------------------------------------------------------------------------
# ROLE_DESCRIPTION stays at the phase-2 value so the ONLY template change on the
# role is the added `RoleName`.
#
# NO routing flag: the phase-2 migration made the record sticky on `cc-api`, so
# the replacement's create and the rollback's replay-CREATE both go through
# Cloud Control on their own.
#
# `RoleName` is create-only AND the primary identifier, so changing it IS the
# replacement trigger, and the new role is created under a DIFFERENT name — the
# create-first attempt has nothing to collide with. That is deliberate: every
# collision-based route into this arm is blocked by go-to-k/cdkd#3208, and two
# earlier drafts of this fixture died on exactly that. See the header.
echo "[verify] phase 3: ROLE_EXPLICIT_NAME=${EXPLICIT_NAME} REPLAY_CC_NAME_FAIL=true deploy (expect FAILURE)"
DEPLOY_LOG="$(mktemp)"
set +e
ROLE_EXPLICIT_NAME="${EXPLICIT_NAME}" ROLE_DESCRIPTION="${MIGRATED_DESCRIPTION}" REPLAY_CC_NAME_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
    > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${DEPLOY_LOG}" || true
[ "${DEPLOY_RC}" -ne 0 ] || { echo "FAIL: the deploy with REPLAY_CC_NAME_FAIL=true unexpectedly SUCCEEDED (rc=0). The injected queue must be rejected by AWS, otherwise no rollback runs." >&2; exit 1; }
echo "[verify] phase 3 ok: deploy failed as designed (rc=${DEPLOY_RC})"

# ---------------------------------------------------------------------------
# PHASE 4: THE ARM — what the rollback restored
# ---------------------------------------------------------------------------
echo "[verify] phase 4: assert the reverse-replacement replay restored the GENERATED name"

# 4a. SENTINEL FIRST, and POSITIVE. Every other assertion in this phase is also
#     satisfied by "the deploy refused before replacing anything and nothing
#     changed" — a VACUOUS pass. A CHANGED CreateDate on the role named CC_NAME
#     is the only signal that the old role was actually destroyed by the forward
#     replacement and RE-CREATED by the rollback replay.
#
#     If that role is ABSENT this capture emits nothing, which trivially differs
#     from CREATED_AT_1 and falls through to 4b — the assertion that names #3199
#     and is the right verdict for that case.
CREATED_AT_2=$(capture aws iam get-role --role-name "${CC_NAME}" --region "${REGION}" \
  --query 'Role.CreateDate' --output text)
[ "${CREATED_AT_2}" != "${CREATED_AT_1}" ] || { echo "FAIL: role ${CC_NAME} still carries its phase-2 CreateDate (${CREATED_AT_1}) — it was never destroyed and re-created, so the reverse-replacement replay-CREATE was NEVER ENTERED and this run proves NOTHING about #3199. Check the deploy log above: if it ends before the replacement, the forward path died early." >&2; exit 1; }

# 4b. Exactly ONE role under the fixture path, and it carries CC_NAME.
#     This is the assertion #3199 exists for: without the fill the replay sends
#     no RoleName, AWS mints a random one, and this reads a name that is not
#     CC_NAME. Enumerating by PATH (not by name prefix) is what makes the
#     randomly-named survivor visible — a name-prefix query would pass on
#     exactly the broken tree.
POST_ROLES=$(roles_under_path_settled "${CC_NAME}")
N_POST=$(count_words "${POST_ROLES}")
[ "${N_POST}" = "1" ] || { echo "FAIL: expected exactly 1 role under ${ROLE_PATH} after the rollback, found ${N_POST}: ${POST_ROLES}. More than one means the replacement's new role was not deleted; zero means the replay never re-created the old one." >&2; exit 1; }
[ "${POST_ROLES}" = "${CC_NAME}" ] || { echo "FAIL: the rollback restored the role under '${POST_ROLES}', not the cdkd-generated name '${CC_NAME}'. That is issue #3199: the reverse-replacement replay-CREATE did not run its bag through applyDefaultNameForFallback on the Cloud Control route, so the create went out with no RoleName and AWS minted the name instead." >&2; exit 1; }
echo "[verify]   ok: exactly one role under ${ROLE_PATH}, named '${CC_NAME}', CreateDate moved ${CREATED_AT_1} -> ${CREATED_AT_2}"

# 4c. The replacement's NEW role was deleted by the rollback. Asserted by NAME
#     as well as by the count above: the explicit name is created at the fixture
#     path too, so a survivor would already have failed 4b — this pins WHICH
#     resource is gone, and would still fire if the path ever stopped matching.
assert_gone "the replacement's role ${EXPLICIT_NAME} survived the rollback — the reverse-replacement did not delete the new resource" \
  aws iam get-role --role-name "${EXPLICIT_NAME}" --region "${REGION}"
echo "[verify]   ok: ${EXPLICIT_NAME} is gone"

# 4d. State points at the restored role, and that name resolves LIVE under the
#     fixture path — so the record and AWS agree after the replay.
P2=$(record '.physicalId')
[ "${P2}" = "${CC_NAME}" ] || { echo "FAIL: the state physicalId is '${P2}', expected the restored '${CC_NAME}'" >&2; exit 1; }
LIVE_ARN=$(capture aws iam get-role --role-name "${P2}" --region "${REGION}" \
  --query 'Role.Arn' --output text)
case "${LIVE_ARN}" in
  arn:*:iam::*:role"${ROLE_PATH}${CC_NAME}") : ;;
  *) echo "FAIL: the state physicalId ${P2} does not resolve live to a role at ${ROLE_PATH}${CC_NAME} (read back Arn: '${LIVE_ARN}')" >&2; exit 1 ;;
esac
echo "[verify]   ok: state physicalId ${P2} resolves live to ${LIVE_ARN}"

# 4e. The record still reads `cc-api` after the replay.
#
# STATED BOUND, because the obvious reading of this line is wrong: it does NOT
# pin the replay's ROUTING DECISION, which is the thing the fix keys on. The
# replay rebuilds the record as `{...prevRecord, physicalId, attributes,
# properties}`, so `provisionedBy` is CARRIED from the previous record and never
# written from the decision — given phase 2's `LAYER1` assert, this can only be
# `cc-api`. What it actually catches is a future change that starts rewriting
# the layer on a replay.
#
# The residual that leaves: nothing here would notice if the replay were routed
# to the SDK provider. Today that cannot happen — `getProviderFor` is called
# with no `properties`, so `wouldReturnToSdkProvider` short-circuits, and
# `AWS::IAM::Role` is not in `STICKY_CC_MIGRATION_EXEMPT`. A `cc-broken` entry
# for this type would return early and route the replay to `IAMRoleProvider`,
# which mints the name itself, and every assertion above would then pass on an
# unfixed tree. The unit suite is what pins the decision
# (`rollback-executor-replay-fallback-name.test.ts` asserts the routing input);
# this line is not a substitute for it.
LAYER2=$(record '.provisionedBy')
[ "${LAYER2}" = "cc-api" ] || { echo "FAIL: after the rollback the record says provisionedBy=${LAYER2}, expected cc-api" >&2; exit 1; }

# 4f. No leftover queue from the failed deploy.
if ! gone_probe aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"; then
  echo "FAIL: the failing queue ${FAILING_QUEUE_NAME} exists — the invalid CreateQueue should have been rejected outright" >&2
  exit 1
fi
echo "[verify] phase 4 ok: replay restored the generated name on a NEW role, new one deleted, state live, no orphan queue"

# ---------------------------------------------------------------------------
# PHASE 5: destroy — everything gone
# ---------------------------------------------------------------------------
echo "[verify] phase 5: cdkd destroy ${STACK}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone "role ${CC_NAME} survived destroy" \
  aws iam get-role --role-name "${CC_NAME}" --region "${REGION}"
assert_gone "role ${EXPLICIT_NAME} survived destroy" \
  aws iam get-role --role-name "${EXPLICIT_NAME}" --region "${REGION}"
assert_gone "state.json still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

# Nothing may be left under the fixture path either — the name-scoped probes
# above cannot see a role AWS named for us.
LEFTOVER_ROLES=$(roles_under_path_settled "")
N_LEFT=$(count_words "${LEFTOVER_ROLES}")
[ "${N_LEFT}" = "0" ] || { echo "FAIL: ${N_LEFT} role(s) still under ${ROLE_PATH} after destroy: ${LEFTOVER_ROLES}" >&2; exit 1; }
echo "[verify] phase 5 ok: both role names, the fixture path and the state all gone"

# The events sidecar deliberately survives destroy, so the fixture removes it
# itself and then proves the prefix is clean.
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
# `--recursive` is load-bearing: a delimited `s3 ls` of this prefix returns only
# `PRE us-east-1/`, because state.json and `deployments/` sit one level deeper —
# so the `\.(jsonl|json)$` grep below could never match and the check could
# never fire. FOUR sibling fixtures still carry the broken form — deployment-events,
# rollback-failure-injection, rollback-sqs-cooldown and rollback-command (the last
# inside a two-prefix loop) — tracked as go-to-k/cdkd#3216.
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive 2>&1 || true)"
if printf '%s' "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "FAIL: events sidecar not fully removed:" >&2
  printf '%s\n' "${REMAINING}" | sed 's/^/  /' >&2
  exit 1
fi

rm -f "${DEPLOY_LOG}"
DEPLOY_LOG=""
trap - EXIT INT TERM
echo "[verify] PASS: rollback-replay-cc-generated-name (issue #3199)"
