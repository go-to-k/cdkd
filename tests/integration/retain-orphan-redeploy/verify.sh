#!/usr/bin/env bash
# verify.sh — cdkd retain-orphan-redeploy integ test (issue #2902).
#
# The reported loop: a rollback leaves a `DeletionPolicy: Retain` resource in
# AWS and drops its state record (CloudFormation semantics, deliberate), and
# cdkd's generated names are fixed for a stack's lifetime — so the next deploy
# of the SAME stack asks AWS for a name the orphan still holds, fails, rolls
# back, and repeats. The reporter's only way out was hand-deleting resources
# through the AWS API.
#
# go-to-k/cdkd#5064 ended that loop on a stack with a stack instance id, as
# CloudFormation does: a generated name carries a suffix hashing the id, the
# logical id and the record's NAME GENERATION, and a record that leaves the
# stack (a rollback's Retain orphan, `state orphan --resource`) retires its
# generation, so the next create of that logical id asks for the NEXT
# generation's name and never collides with what was left behind. A stack whose
# record was deleted gets a new id altogether (phases 11b-11c).
#
# The #2902 DIAGNOSIS still matters for a create whose derived name IS held —
# by a resource an interrupted earlier attempt created, say. This arm plants
# such a holder on the name the redeploy will derive (phase 2b) and asserts
# that cdkd NAMES the cause and that the remedy it prints actually WORKS:
#
#   1. deploy               — a role under a cdkd-GENERATED name (generation 0)
#   2. state orphan --resource — drop the role's record (the stack keeps its
#                            record and its instance id, and retires the
#                            role's generation 0), leave the role in AWS
#   2b. plant a role out of band on the generation-1 name the redeploy derives
#   3. redeploy             — must FAIL on that name, and must print the
#                            diagnosis + command; the orphan is untouched
#   4. run THAT command     — parsed out of the message, not hand-written
#   5. redeploy             — must now SUCCEED (the loop is broken)
#   6. destroy + gone probe; the orphan (no record names it) is deleted by
#      the fixture
#
# Step 4 is the point. A message naming a remedy whose precondition the code
# never checks is issue #2610's defect class, so this runs the command the
# message emitted rather than a command the fixture author believed in.
#
# `cdkd state orphan` is used rather than an injected rollback: it reaches the
# same end state (resource live, record gone) deterministically, where a
# failure injection's timing would decide what got created.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

# The orphaned queue's existence, retried: SQS answers a just-deleted queue for
# up to 60 s, and a throttle is not an answer. `queue_state <url> exists`
# returns 0 once the queue answers and 1 on NonExistentQueue; `queue_state
# <url> gone` returns 0 once it reports NonExistentQueue. Anything still
# undetermined after ~90 s FAILs the run.
queue_state() { # usage: queue_state <url> <exists|gone>
  local url="$1" want="$2" out="" i
  for i in $(seq 1 15); do
    if out="$(aws sqs get-queue-attributes --queue-url "${url}" --attribute-names QueueArn 2>&1)"; then
      [ "${want}" = exists ] && return 0
    elif printf '%s' "${out}" | grep -qiE 'NonExistentQueue|does not exist'; then
      [ "${want}" = gone ] && return 0
      return 1
    fi
    sleep 6
  done
  echo "FAIL: queue ${url} is still not '${want}' after ~90 s: ${out:-it still answers}" >&2
  exit 1
}

# The 12-hex suffix cdkd gives a generated name at name generation <g> of
# <logicalId> (go-to-k/cdkd#5064): sha256(id NUL logicalId)[:12] at 0,
# sha256(id NUL logicalId NUL g)[:12] above, the id being the stackInstanceId
# of the state.json at <state-key>. Read from S3 into node's stdin: the id is
# never printed.
state_name_suffix() { # usage: state_name_suffix <state-key> <logicalId> <generation>
  aws s3 cp "s3://${STATE_BUCKET}/$1" - | node -e '
const { createHash } = require("node:crypto");
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const [logicalId, generation] = process.argv.slice(1);
  const id = JSON.parse(raw).stackInstanceId;
  if (typeof id !== "string" || id === "" || !/^(0|[1-9][0-9]*)$/.test(generation ?? "")) {
    process.stderr.write("state.json carries no stackInstanceId, or the generation is not a number\n");
    process.exit(1);
  }
  const hash = createHash("sha256").update(id).update("\0").update(logicalId);
  if (generation !== "0") hash.update("\0").update(generation);
  process.stdout.write(hash.digest("hex").slice(0, 12));
});' "$2" "$3"
}

# Best-effort delete of a role and its policies, by name (cleanup only).
delete_role_best_effort() { # usage: delete_role_best_effort <name>
  (
  set +eu
  [ -n "$1" ] || exit 0
  for p in $(aws iam list-role-policies --role-name "$1" \
    --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "$1" --policy-name "${p}" >/dev/null 2>&1
  done
  for a in $(aws iam list-attached-role-policies --role-name "$1" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "$1" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "$1" >/dev/null 2>&1
  )
}

cd "$(dirname "$0")"

export AWS_PAGER=""

STACK="CdkdRetainOrphanRedeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved post-deploy; used by assertions + cleanup.
ROLE_NAME=""
ROLE_LOGICAL_ID=""
# Phase 2b's out-of-band role on the name the redeploy generates (generation
# 1), which phase 4 adopts and phase 6 destroys.
SQUAT_ROLE_NAME=""
REDEPLOY_LOG=""
# The adoption arm (issue #2934) — a SECOND stack, so its own names.
ADOPT_STACK="CdkdRetainOrphanAdoptExample"
ADOPT_STATE_KEY="cdkd/${ADOPT_STACK}/${REGION}/state.json"
# The role the phase 7 rollback orphans (RETAIN), which phase 9 no longer
# takes back on a stack with a stack instance id (go-to-k/cdkd#5064); the
# fixture deletes it itself after phase 10.
ADOPT_ORPHAN_NAME=""
# The role phase 9 creates beside it, under the next name generation; RETAIN
# too, so phase 11's destroy keeps it and the cleanup deletes it by name.
ADOPT_ROLE_NAME=""
# The role the adoption stack's SECOND lifetime creates (phase 11b), retained
# too by its destroy (phase 11c); the cleanup deletes it by name.
ADOPT_ROLE_NAME_2=""
# The adoption stack's RETAIN topic (`KeptTopic`, fixed mode), per lifetime:
# the one phase 11 keeps and records in `retained.json`, and the one phase 11b
# creates under the new lifetime's name. Deleted by ARN in the cleanup.
KEPT_TOPIC_ARN=""
KEPT_TOPIC_ARN_2=""
ADOPT_LOGICAL_ID=""
ADOPT_LOG=""
# The single-record orphan arm (go-to-k/cdkd#4602) — a THIRD stack.
ORPHAN_STACK="CdkdRetainOrphanResourceExample"
ORPHAN_STATE_KEY="cdkd/${ORPHAN_STACK}/${REGION}/state.json"
ORPHAN_QUEUE_URL=""
REFUSE_LOG=""
REDEPLOY_ORPHAN_LOG=""
DESTROY_ORPHAN_LOG=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders: the whole point of this fixture is a state record that
  # no longer names the live role, so `state destroy` can legitimately miss it
  # — the orphan, and the out-of-band role phase 2b plants.
  delete_role_best_effort "${ROLE_NAME}"
  delete_role_best_effort "${SQUAT_ROLE_NAME}"
  # The adoption arm's stack. Its role carries RETAIN, so `state destroy`
  # deliberately leaves it standing — the by-name delete below is the only
  # thing that stops this fixture leaking a role per run.
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${ADOPT_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  delete_role_best_effort "${ADOPT_ORPHAN_NAME}"
  delete_role_best_effort "${ADOPT_ROLE_NAME}"
  delete_role_best_effort "${ADOPT_ROLE_NAME_2}"
  for t in "${KEPT_TOPIC_ARN}" "${KEPT_TOPIC_ARN_2}"; do
    [ -n "${t}" ] && aws sns delete-topic --topic-arn "${t}" >/dev/null 2>&1
  done
  # The single-record arm's stack, then its queue: `state orphan --resource`
  # drops the queue's record on purpose, so no destroy can reach it and the
  # by-URL delete below is the only thing that stops a leak.
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${ORPHAN_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${ORPHAN_QUEUE_URL}" ]; then
    aws sqs delete-queue --queue-url "${ORPHAN_QUEUE_URL}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${ORPHAN_STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${ADOPT_STACK}/${REGION}/lock.json" >/dev/null 2>&1
    # The adoption stack's `retained.json` (and events): phase 11b asserts how
    # many resources an earlier lifetime kept, so a previous run's record must
    # not carry over. Guarded so an empty name cannot widen the sweep.
    case "${ADOPT_STACK}" in
      CdkdRetainOrphanAdopt?*)
        aws s3 rm "s3://${STATE_BUCKET}/cdkd/${ADOPT_STACK}/" --recursive >/dev/null 2>&1
        ;;
      *) echo "teardown sweep refused: ADOPT_STACK='${ADOPT_STACK}'" >&2 ;;
    esac
  fi
  rm -f "${REDEPLOY_LOG:-}" "${ADOPT_LOG:-}" "${REFUSE_LOG:-}" "${REDEPLOY_ORPHAN_LOG:-}" "${DESTROY_ORPHAN_LOG:-}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy (role under a cdkd-GENERATED name)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
# Resolved from state by TYPE, never hardcoded: CDK appends a path-derived hash
# to the construct id (`OrphanedRole` synthesizes as `OrphanedRole<8 hex>`), so
# a literal would break the moment the construct or stack id changes -- and it
# would break as a confusing "not found" rather than as a clear failure. The
# stack declares exactly one role, which is what makes the by-type read exact.
ROLE_LOGICAL_ID=$(echo "${STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .key] | first // ""')
ROLE_NAME=$(echo "${STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
if [ -z "${ROLE_LOGICAL_ID}" ] || [ -z "${ROLE_NAME}" ] || [ "${ROLE_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the role's logical id / physical id from state" >&2
  echo "${STATE}" | jq '{resources: (.resources | keys)}' >&2
  exit 1
fi
echo "    logicalId=${ROLE_LOGICAL_ID} role=${ROLE_NAME}"

# The diagnosis under test only fires for a name cdkd DERIVED, so a fixture
# whose role came out template-named would assert nothing. Pin the premise, in
# its #5064 shape: `{stack}-{logicalId}` cut to 64 - 13 = 51 characters, then
# `-` and the 12-hex stack instance suffix. The diagnosis recognizes only the
# EXACT suffix of the stack's own id, so phase 3 also proves that.
ROLE_BASE="${STACK}-${ROLE_LOGICAL_ID}"
ROLE_BASE="${ROLE_BASE:0:51}"
ROLE_BASE="${ROLE_BASE%%-}"
if ! printf '%s' "${ROLE_NAME}" | grep -qE "^${ROLE_BASE}-[0-9a-f]{12}\$"; then
  echo "FAIL: '${ROLE_NAME}' is not the cdkd derivation ${ROLE_BASE}-<12 hex> of ${STACK}/${ROLE_LOGICAL_ID} —" >&2
  echo "      the collision diagnosis under test would not fire for it" >&2
  exit 1
fi
# The derivation phase 2b aims its holder with must reproduce the name cdkd
# minted at generation 0; a mismatch here is the derivation, not the arm.
ROLE_SUFFIX_G0="$(state_name_suffix "${STATE_KEY}" "${ROLE_LOGICAL_ID}" 0)" || exit 1
if [ "${ROLE_NAME}" != "${ROLE_BASE}-${ROLE_SUFFIX_G0}" ]; then
  echo "FAIL: '${ROLE_NAME}' does not end in the generation-0 suffix derived from state.json's stackInstanceId (${ROLE_SUFFIX_G0})" >&2
  exit 1
fi

# --- Phase 2: manufacture the orphan -----------------------------------
echo "==> Phase 2: drop the role's state record, leave the role in AWS"
# `--resource`, not the whole stack (go-to-k/cdkd#5064): the stack keeps its
# record and so its instance id, and the record that left retires the role's
# generation 0 — so the redeploy derives the generation-1 name. A whole-stack
# orphan deletes the record; the next deploy would then be a new lifetime.
node "${LOCAL_DIST}" state orphan "${STACK}" --resource "${ROLE_LOGICAL_ID}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
ORPHANED_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
if [ "$(printf '%s' "${ORPHANED_STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources | has($k)')" != "false" ]; then
  echo "FAIL: the role's record survived 'cdkd state orphan --resource ${ROLE_LOGICAL_ID}'" >&2
  exit 1
fi
if [ "$(printf '%s' "${ORPHANED_STATE}" | jq -r '.stackInstanceId // "" | length > 0')" != "true" ]; then
  echo "FAIL: the stack record lost its stackInstanceId — the redeploy would be a new lifetime" >&2
  exit 1
fi
if [ "$(printf '%s' "${ORPHANED_STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.retiredNameGenerations[$k] // "none"')" != "0" ]; then
  echo "FAIL: 'state orphan --resource' did not retire ${ROLE_LOGICAL_ID} at generation 0 (retiredNameGenerations)" >&2
  exit 1
fi

if ! aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: 'cdkd state orphan' deleted the AWS role — it must only drop state" >&2
  exit 1
fi
ROLE_CREATED="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.CreateDate' --output text)"
echo "    OK: role still live, state record gone, generation 0 retired"

# --- Phase 2b: a holder on the name the redeploy derives ----------------
# The orphan no longer collides (generation 0 is retired), so the diagnosis
# needs a resource on the generation-1 name. Created with the template's own
# trust policy and description, as an earlier attempt of this create would
# have made it, so the adoption below changes nothing on it.
ROLE_SUFFIX_G1="$(state_name_suffix "${STATE_KEY}" "${ROLE_LOGICAL_ID}" 1)" || exit 1
SQUAT_CANDIDATE="${ROLE_BASE}-${ROLE_SUFFIX_G1}"
if [ "${SQUAT_CANDIDATE}" = "${ROLE_NAME}" ]; then
  echo "FAIL: generation 1's name equals generation 0's (${ROLE_NAME}) — the derivation is wrong" >&2
  exit 1
fi
if ! gone_probe aws iam get-role --role-name "${SQUAT_CANDIDATE}"; then
  echo "FAIL: ${SQUAT_CANDIDATE} exists before phase 2b planted it" >&2
  exit 1
fi
echo "==> Phase 2b: plant a role on the generation-1 name ${SQUAT_CANDIDATE}"
SQUAT_ROLE_NAME="${SQUAT_CANDIDATE}"
aws iam create-role --role-name "${SQUAT_ROLE_NAME}" \
  --description 'Resource whose cdkd-generated name the redeploy collides with' \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Action":"sts:AssumeRole","Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"}}]}' \
  >/dev/null

# --- Phase 3: the redeploy must FAIL, and must explain itself ----------
echo "==> Phase 3: redeploy over the held generation-1 name (must fail WITH a diagnosis)"
REDEPLOY_LOG="$(mktemp)"
if node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${REDEPLOY_LOG}" 2>&1; then
  echo "FAIL: the redeploy SUCCEEDED over a live holder of ${SQUAT_ROLE_NAME} — expected an already-exists failure" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi

# Sentinel: distinguishes "cdkd said nothing" from "this grep stopped parsing".
# The AWS sentence is the independent marker — it is not the string under test,
# and a redeploy that reached AWS at all must carry it.
if ! grep -q "already exists" "${REDEPLOY_LOG}"; then
  echo "FAIL: the redeploy failed WITHOUT an already-exists error — wrong failure" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
if ! grep -q "is one cdkd DERIVED from" "${REDEPLOY_LOG}"; then
  echo "FAIL: cdkd printed no orphan diagnosis for a collision on its own generated name." >&2
  echo "      The AWS error IS present, so this is a missing/reworded diagnosis," >&2
  echo "      not an absent condition (issue #2902)." >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
# The diagnosis names the generation-1 name the create sent — not the orphan's.
if ! grep -F "is one cdkd DERIVED from" "${REDEPLOY_LOG}" | grep -qF "(${SQUAT_ROLE_NAME})"; then
  echo "FAIL: the diagnosis does not name ${SQUAT_ROLE_NAME}, the generation-1 name the redeploy derives:" >&2
  grep -F "is one cdkd DERIVED from" "${REDEPLOY_LOG}" | sed 's/^/  /' >&2
  exit 1
fi
if [ "$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.CreateDate' --output text)" != "${ROLE_CREATED}" ]; then
  echo "FAIL: the orphaned role ${ROLE_NAME} was replaced or deleted by the failed redeploy" >&2
  exit 1
fi
echo "    OK: redeploy failed on ${SQUAT_ROLE_NAME} AND named the cause; the orphan ${ROLE_NAME} is untouched"

# --- Phase 4: run the command the MESSAGE printed ----------------------
echo "==> Phase 4: follow cdkd's own remedy"
# Parsed out of the message rather than hand-written: this is what makes the
# assertion about the ADVICE and not about a command the author believed in.
# The argument is SINGLE-QUOTED in the message (`shellQuote`, so a name
# carrying shell metacharacters pastes inertly), and the quotes are part of what
# the user would paste -- so the pattern accepts them and `eval` below re-parses
# them exactly as a shell would. Matching the unquoted form is what the first
# version did, and it broke the moment the quoting landed: the fixture caught
# its own PR's change, which is the point of parsing the message rather than
# rebuilding the command.
#
# `|| true` is load-bearing, not defensive: `grep -o` exits 1 on no match and
# `pipefail` carries that past `head`, so errexit killed the script here and the
# loud branch below -- the whole point of this phase -- never printed.
IMPORT_ARG=$(grep -o -- "--resource '\?${ROLE_LOGICAL_ID}=[A-Za-z0-9_+=,.@-]*'\?" "${REDEPLOY_LOG}" | head -1 || true)
if [ -z "${IMPORT_ARG}" ]; then
  echo "FAIL: the diagnosis carried no '--resource ${ROLE_LOGICAL_ID}=<name>' argument to run" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
echo "    running: cdkd import ${STACK} ${IMPORT_ARG} --yes"
# `eval` because the captured text carries the message's own single quotes, and
# the command under test is what a user PASTES -- so the shell must re-parse
# them the same way. The captured value is constrained by the grep pattern
# above to `--resource` plus the IAM name charset plus the quotes, so nothing
# else can reach the shell here.
# shellcheck disable=SC2086,SC2294
# NOTE: `cdkd import` declares no `--region`; it reads AWS_REGION / the profile.
# Stated because every OTHER invocation here passes one, and the state key
# asserted just below is region-scoped -- so the asymmetry is deliberate, not an
# omission to "fix".
eval node '"${LOCAL_DIST}"' import '"${STACK}"' "${IMPORT_ARG}" \
  --state-bucket '"${STATE_BUCKET}"' --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
REIMPORTED=$(echo "${STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
if [ "${REIMPORTED}" != "${SQUAT_ROLE_NAME}" ]; then
  echo "FAIL: after the advised import, state names '${REIMPORTED}', expected '${SQUAT_ROLE_NAME}'" >&2
  exit 1
fi
echo "    OK: the advised command adopted ${SQUAT_ROLE_NAME} into state"

# --- Phase 5: the loop is broken ---------------------------------------
echo "==> Phase 5: redeploy again (must now SUCCEED)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the deploy still fails after following cdkd's own remedy — the remedy does not work" >&2
  exit 1
fi
echo "    OK: deploy succeeds; the redeploy loop is broken"

# --- Phase 6: destroy --------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"
assert_gone "IAM role ${SQUAT_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${SQUAT_ROLE_NAME}"
echo "    OK: role gone"
# The orphan of phase 2: no record names it, so the destroy must have left it,
# and the fixture deletes it (it carries no policies).
if [ "$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.CreateDate' --output text)" != "${ROLE_CREATED}" ]; then
  echo "FAIL: the destroy replaced or deleted the orphaned role ${ROLE_NAME}, which no record names" >&2
  exit 1
fi
aws iam delete-role --role-name "${ROLE_NAME}"
assert_gone "the orphaned role ${ROLE_NAME} survived its own delete" aws iam get-role --role-name "${ROLE_NAME}"
echo "    OK: orphan left by the destroy, then deleted by the fixture"

# Nothing left for the cleanup trap to delete.
ROLE_NAME=""
SQUAT_ROLE_NAME=""

# ---------------------------------------------------------------------------
# The ADOPTION arm (issue #2934).
#
# Everything above proves the go-to-k/cdkd#2916 DIAGNOSIS: a create whose
# derived name another resource holds stops the deploy, with advice. This arm
# takes the orphan from an actual failed deploy, which writes an orphan
# record. #2934 re-adopted that orphan automatically; on a stack with a stack
# instance id (go-to-k/cdkd#5064, CloudFormation parity) the rollback retires
# the orphan's name generation instead, and the redeploy creates a NEW role
# under the next generation's name, leaves the orphan alone, and warns once
# naming `cdkd import`. The fixture then deletes the orphan itself.
# ---------------------------------------------------------------------------

echo ""
echo "==> Phase 7: deploy the adoption stack with a resource that FAILS"
ADOPT_LOG="$(mktemp)"
# Expected to fail: the queue's MessageRetentionPeriod is out of range, and the
# role it depends on is created first. `|| true` because the non-zero exit IS
# the expected outcome; the assertions below decide pass/fail, not this line.
CDKD_TEST_ADOPT=fail node "${LOCAL_DIST}" deploy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${ADOPT_LOG}" 2>&1 || true

# Read the name from the RECORD the rollback just wrote, never construct it:
# CDK appends a hash to the logical id (`AdoptedRole` becomes
# `AdoptedRole72C57DEE`), so a hand-built name is wrong AND the mistake reads
# as "the role is missing" — accusing the feature instead of the fixture.
# Taking it from the record also means these phases exercise the record itself.
ADOPT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" - 2>/dev/null || echo '{}')"
read -r ADOPT_LOGICAL_ID ADOPT_ORPHAN_NAME <<EOF
$(printf '%s' "${ADOPT_STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  const first = (parsed.orphans ?? [])[0];
  process.stdout.write((first?.logicalId ?? "") + " " + (first?.state?.physicalId ?? ""));
});')
EOF
if [ -z "${ADOPT_ORPHAN_NAME}" ]; then
  echo "FAIL: the rollback wrote no orphan record to ${ADOPT_STATE_KEY}."
  echo "      Without it the redeploy has nothing to warn about, so a missing"
  echo "      record means the feature is not wired."
  printf '%s\n' "${ADOPT_STATE}" | head -40
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
if ! aws iam get-role --role-name "${ADOPT_ORPHAN_NAME}" >/dev/null 2>&1; then
  echo "FAIL: the Retain role ${ADOPT_ORPHAN_NAME} is not in AWS after the failed deploy."
  echo "      Either the role was never created (the queue failed first, so the"
  echo "      dependsOn is not holding) or the rollback deleted it despite Retain."
  echo "      Either way the rest of this arm would assert nothing."
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
ADOPT_ORPHAN_CREATED="$(aws iam get-role --role-name "${ADOPT_ORPHAN_NAME}" --query 'Role.CreateDate' --output text)"
echo "    OK: ${ADOPT_ORPHAN_NAME} survived the rollback"

# go-to-k/cdkd#5064: the failed FIRST deploy still wrote the stack's instance
# id, the orphan holds the generation-0 name derived from it, and the rollback
# retired that generation — which is what sends phase 9 to a new name.
ADOPT_BASE="${ADOPT_STACK}-${ADOPT_LOGICAL_ID}"
ADOPT_BASE="${ADOPT_BASE:0:51}"
ADOPT_BASE="${ADOPT_BASE%%-}"
ADOPT_SUFFIX_G0="$(state_name_suffix "${ADOPT_STATE_KEY}" "${ADOPT_LOGICAL_ID}" 0)" || exit 1
if [ "${ADOPT_ORPHAN_NAME}" != "${ADOPT_BASE}-${ADOPT_SUFFIX_G0}" ]; then
  echo "FAIL: the orphan '${ADOPT_ORPHAN_NAME}' is not ${ADOPT_LOGICAL_ID}'s generation-0 name ${ADOPT_BASE}-${ADOPT_SUFFIX_G0}"
  exit 1
fi
if [ "$(printf '%s' "${ADOPT_STATE}" | jq -r --arg k "${ADOPT_LOGICAL_ID}" '.retiredNameGenerations[$k] // "none"')" != "0" ]; then
  echo "FAIL: the rollback did not retire ${ADOPT_LOGICAL_ID} at generation 0 (retiredNameGenerations)"
  exit 1
fi
ADOPT_SUFFIX_G1="$(state_name_suffix "${ADOPT_STATE_KEY}" "${ADOPT_LOGICAL_ID}" 1)" || exit 1
ADOPT_EXPECTED_G1="${ADOPT_BASE}-${ADOPT_SUFFIX_G1}"
# Registered for the cleanup BEFORE the deploy: a deploy that fails after
# creating it would otherwise leave a Retain role behind.
ADOPT_ROLE_NAME="${ADOPT_EXPECTED_G1}"

echo "==> Phase 8: the rollback must have RECORDED exactly one orphan"
ORPHAN_COUNT="$(printf '%s' "${ADOPT_STATE}" | node -e '
let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = {}; }
  process.stdout.write(String((parsed.orphans ?? []).length));
});')"
if [ "${ORPHAN_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 orphan record in ${ADOPT_STATE_KEY}, got ${ORPHAN_COUNT}."
  echo "      Without the record the redeploy below has nothing to warn about"
  echo "      — so a 0 here means the feature is not wired."
  printf '%s\n' "${ADOPT_STATE}" | head -40
  exit 1
fi
echo "    OK: state carries 1 orphan record"

# --- Phase 8b: the PREVIEW must agree with the deploy -------------------
# go-to-k/cdkd#2943, inverted by go-to-k/cdkd#5064: on a stack with a stack
# instance id the deploy does NOT take the orphan back (phase 9 creates a new
# role), so the diff must not preview an adoption either. The state holds the
# orphan record and the role is live in AWS — the window where an adoption
# preview could appear at all.
echo "==> Phase 8b: cdkd diff must NOT preview an adoption on a stack with an instance id"
DIFF_LOG="$(mktemp)"
# `|| DIFF_RC=$?`, not a bare `$?` on the next line: `set -e` is armed, so a
# non-zero exit aborts the script BEFORE the assignment and every diagnostic
# below is dead code. Seeded to 0 because the `||` arm does not run on success.
DIFF_RC=0
CDKD_TEST_ADOPT=fixed node "${LOCAL_DIST}" diff "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${DIFF_LOG}" 2>&1 || DIFF_RC=$?
if [ "${DIFF_RC}" != "0" ]; then
  echo "FAIL: cdkd diff exited ${DIFF_RC}; expected 0 (nothing here is refused —"
  echo "      no sibling stack claims this role). A 3 would mean the refusal"
  echo "      path fired on a record this run created and owns."
  tail -40 "${DIFF_LOG}"
  rm -f "${DIFF_LOG}"
  exit 1
fi
# SENTINEL: the diff summary line (`N to create, ...`) proves a preview was
# rendered at all, so the absence below is "no adoption previewed", never "the
# diff printed nothing".
if ! grep -q "to create, " "${DIFF_LOG}"; then
  echo "FAIL: cdkd diff printed no summary line — the run did not produce a preview,"
  echo "      so the absence of an adoption line below would prove nothing."
  tail -40 "${DIFF_LOG}"
  rm -f "${DIFF_LOG}"
  exit 1
fi
if grep -q "resource(s) to adopt from a previous rollback" "${DIFF_LOG}"; then
  echo "FAIL: cdkd diff previewed an adoption of the rollback orphan on a stack with"
  echo "      a stack instance id, where the deploy creates a new resource instead"
  echo "      (go-to-k/cdkd#5064) — the preview/apply divergence go-to-k/cdkd#2943 closed."
  tail -40 "${DIFF_LOG}"
  rm -f "${DIFF_LOG}"
  exit 1
fi
echo "    OK: cdkd diff previews no adoption"
rm -f "${DIFF_LOG}"

echo "==> Phase 9: redeploy with the failure repaired (must SUCCEED with a NEW role, leaving the orphan)"
CDKD_TEST_ADOPT=fixed node "${LOCAL_DIST}" deploy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${ADOPT_LOG}" 2>&1 || {
  echo "FAIL: the redeploy did not succeed. On a stack with a stack instance id the"
  echo "      orphan's generation is retired, so the create asks for a new name —"
  echo "      an already-exists collision here means it asked for the orphan's."
  tail -40 "${ADOPT_LOG}"
  exit 1
}
# The warning: the sentinel is its `cdkd import` remedy clause, the markers
# are the "does not take it back" statement and the orphan's name, all on the
# warning's one line.
if ! grep -qF "adopt it with 'cdkd import'" "${ADOPT_LOG}"; then
  echo "FAIL: the redeploy did not warn that the rollback's orphan is not taken back (no 'cdkd import' remedy line)"
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
if ! grep -F "adopt it with 'cdkd import'" "${ADOPT_LOG}" | grep -F "This deploy does not take it back" | grep -qF "${ADOPT_ORPHAN_NAME}"; then
  echo "FAIL: a 'cdkd import' remedy line is present but is not the orphan warning naming ${ADOPT_ORPHAN_NAME} (wording drifted?):"
  grep -F "adopt it with 'cdkd import'" "${ADOPT_LOG}" | sed 's/^/  /'
  exit 1
fi
if grep -q "Adopting ${ADOPT_LOGICAL_ID}" "${ADOPT_LOG}"; then
  echo "FAIL: the redeploy re-adopted the rollback orphan on a stack with a stack instance id"
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
echo "    OK: redeploy succeeded, warned about the orphan, adopted nothing"

echo "==> Phase 10: a new role under the generation-1 name; the orphan is untouched"
ADOPT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" -)"
ADOPT_ROLE_NAME="$(printf '%s' "${ADOPT_STATE}" | jq -r --arg k "${ADOPT_LOGICAL_ID}" '.resources[$k].physicalId // ""')"
if [ "${ADOPT_ROLE_NAME}" != "${ADOPT_EXPECTED_G1}" ]; then
  echo "FAIL: state records ${ADOPT_LOGICAL_ID} as '${ADOPT_ROLE_NAME}', expected the generation-1 name ${ADOPT_EXPECTED_G1}"
  echo "      (the rollback retired generation 0, so the create takes generation 1)."
  exit 1
fi
aws iam get-role --role-name "${ADOPT_ROLE_NAME}" >/dev/null
if [ "$(aws iam get-role --role-name "${ADOPT_ORPHAN_NAME}" --query 'Role.CreateDate' --output text)" != "${ADOPT_ORPHAN_CREATED}" ]; then
  echo "FAIL: the orphan ${ADOPT_ORPHAN_NAME} was replaced or deleted by the redeploy"
  exit 1
fi
# The record is kept until a deploy finds its logical id managed again: this
# one planned before the new role existed.
AFTER="$(printf '%s' "${ADOPT_STATE}" | jq -r '[((.orphans // []) | length), ((.orphans // [])[0].state.physicalId // "")] | map(tostring) | join(" ")')"
if [ "${AFTER}" != "1 ${ADOPT_ORPHAN_NAME}" ]; then
  echo "FAIL: expected the orphan record to be kept, still naming ${ADOPT_ORPHAN_NAME} ('1 ${ADOPT_ORPHAN_NAME}'), got '${AFTER}'."
  exit 1
fi
echo "    OK: ${ADOPT_ROLE_NAME} is managed; the orphan ${ADOPT_ORPHAN_NAME} and its record are kept"
# The orphan has served its purpose: no record will ever delete it, so the
# fixture does (a trivial role, no policies).
aws iam delete-role --role-name "${ADOPT_ORPHAN_NAME}"
assert_gone "the orphan ${ADOPT_ORPHAN_NAME} survived its own delete" \
  aws iam get-role --role-name "${ADOPT_ORPHAN_NAME}"
ADOPT_ORPHAN_NAME=""
KEPT_TOPIC_ARN="$(printf '%s' "${ADOPT_STATE}" | jq -r '.resources.KeptTopic.physicalId // ""')"
if [ -z "${KEPT_TOPIC_ARN}" ]; then
  echo "FAIL: the fixed deploy recorded no KeptTopic — phase 11b's new-lifetime arm would assert nothing"
  exit 1
fi

echo "==> Phase 11: destroy the adoption stack"
node "${LOCAL_DIST}" destroy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
# The role and KeptTopic carry RETAIN, so destroy leaves them: that is correct
# behaviour, not a leak to assert against. The cleanup trap deletes them.
assert_gone "state file s3://${STATE_BUCKET}/${ADOPT_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ADOPT_STATE_KEY}"
echo "    OK: adoption-arm state file is gone"

# --- Phases 11b-11c: a NEW lifetime does not take kept resources back -------
# go-to-k/cdkd#5064, CloudFormation parity. The destroy above kept the RETAIN
# role and topic, recorded both in the stack's `retained.json` (every kept
# resource under a generated name, except a name-adopting type made through
# Cloud Control), and deleted the record with its stack instance id. A
# redeploy is a FIRST deploy of a new lifetime: a new id, so new generated
# names. Before #5064 it asked for the kept topic's name and took the topic
# back (#4705's retained license). Now it must create a NEW topic and role
# beside the kept ones, leave those untouched, and say once that an earlier
# deployment kept a resource, naming `cdkd import`.
echo "==> Phase 11b: redeploy the destroyed adoption stack (a new lifetime)"
# The kept list the warning counts, read rather than assumed: exactly the
# kept role and topic, by physical id.
ADOPT_RETAINED="$(aws s3 cp "s3://${STATE_BUCKET}/cdkd/${ADOPT_STACK}/${REGION}/retained.json" -)" || {
  echo "FAIL: phase 11's destroy wrote no retained.json for ${ADOPT_STACK}"
  exit 1
}
# Both sides through the same byte-order sort: jq's codepoint order and a
# locale-aware `sort` disagree on mixed case (a role name vs an ARN).
KEPT_IDS="$(jq -r '.resources[]?.physicalId' <<<"${ADOPT_RETAINED}" | LC_ALL=C sort | paste -sd, -)"
WANT_IDS="$(printf '%s\n%s\n' "${ADOPT_ROLE_NAME}" "${KEPT_TOPIC_ARN}" | LC_ALL=C sort | paste -sd, -)"
if [ -z "${ADOPT_ROLE_NAME}" ] || [ -z "${KEPT_TOPIC_ARN}" ] || [ "${KEPT_IDS}" != "${WANT_IDS}" ]; then
  echo "FAIL: retained.json lists '${KEPT_IDS}', expected the kept role and topic '${WANT_IDS}'"
  exit 1
fi
KEPT_COUNT="$(jq '[.resources[]?] | length' <<<"${ADOPT_RETAINED}")"
echo "    OK: retained.json lists the kept role and topic (${KEPT_COUNT})"
ADOPT_KEPT_CREATED="$(aws iam get-role --role-name "${ADOPT_ROLE_NAME}" --query 'Role.CreateDate' --output text)"
aws sns get-topic-attributes --topic-arn "${KEPT_TOPIC_ARN}" >/dev/null
CDKD_TEST_ADOPT=fixed node "${LOCAL_DIST}" deploy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${ADOPT_LOG}" 2>&1 || {
  echo "FAIL: the redeploy of a destroyed stack failed — a new lifetime must not collide with the kept role"
  tail -40 "${ADOPT_LOG}"
  exit 1
}
# Sentinel + marker on the same warning: the marker carries the count, the
# sentinel is the independent `cdkd import` remedy clause.
if ! grep -qF "adopt it with 'cdkd import'" "${ADOPT_LOG}"; then
  echo "FAIL: the first deploy of a new lifetime did not warn about the kept topic (no 'cdkd import' remedy line)"
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
WARN_LINES="$(grep -F "adopt it with 'cdkd import'" "${ADOPT_LOG}")"
if ! grep -qF "kept ${KEPT_COUNT} resource(s) here" <<<"${WARN_LINES}"; then
  echo "FAIL: the kept-resources warning is present but does not say exactly ${KEPT_COUNT} resource(s) were kept (wording drifted?):"
  grep -F "adopt it with 'cdkd import'" "${ADOPT_LOG}" | sed 's/^/  /'
  exit 1
fi
if grep -q "Adopting ${ADOPT_LOGICAL_ID}" "${ADOPT_LOG}"; then
  echo "FAIL: a new lifetime re-adopted the kept role — it must create a new one"
  tail -40 "${ADOPT_LOG}"
  exit 1
fi
ADOPT_STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${ADOPT_STATE_KEY}" -)"
ADOPT_ROLE_NAME_2="$(printf '%s' "${ADOPT_STATE_2}" | jq -r --arg k "${ADOPT_LOGICAL_ID}" '.resources[$k].physicalId // ""')"
KEPT_TOPIC_ARN_2="$(printf '%s' "${ADOPT_STATE_2}" | jq -r '.resources.KeptTopic.physicalId // ""')"
for arn in "${KEPT_TOPIC_ARN}" "${KEPT_TOPIC_ARN_2}"; do
  if ! printf '%s' "${arn##*:}" | grep -qE "^${ADOPT_STACK}-KeptTopic-[0-9a-f]{12}\$"; then
    echo "FAIL: KeptTopic '${arn}' is not a generated ${ADOPT_STACK}-KeptTopic-<12 hex> topic"
    exit 1
  fi
done
if [ "${KEPT_TOPIC_ARN_2}" = "${KEPT_TOPIC_ARN}" ]; then
  echo "FAIL: the new lifetime took the kept topic ${KEPT_TOPIC_ARN} back — it must create a new one under a new name"
  exit 1
fi
aws sns get-topic-attributes --topic-arn "${KEPT_TOPIC_ARN}" >/dev/null || {
  echo "FAIL: the kept topic ${KEPT_TOPIC_ARN} is gone after the new lifetime's deploy"
  exit 1
}
for n in "${ADOPT_ROLE_NAME}" "${ADOPT_ROLE_NAME_2}"; do
  if ! printf '%s' "${n}" | grep -qE "^${ADOPT_BASE}-[0-9a-f]{12}\$"; then
    echo "FAIL: '${n}' is not a generated ${ADOPT_BASE}-<12 hex> name"
    exit 1
  fi
done
if [ "${ADOPT_ROLE_NAME_2}" = "${ADOPT_ROLE_NAME}" ]; then
  echo "FAIL: the new lifetime generated the SAME name ${ADOPT_ROLE_NAME} — its stack instance id was not renewed"
  exit 1
fi
if [ "$(aws iam get-role --role-name "${ADOPT_ROLE_NAME}" --query 'Role.CreateDate' --output text)" != "${ADOPT_KEPT_CREATED}" ]; then
  echo "FAIL: the kept role ${ADOPT_ROLE_NAME} was replaced or touched by the new lifetime"
  exit 1
fi
aws iam get-role --role-name "${ADOPT_ROLE_NAME_2}" >/dev/null
echo "    OK: new role and topic beside the untouched kept ${ADOPT_ROLE_NAME} / ${KEPT_TOPIC_ARN}, with the kept-resource warning"

echo "==> Phase 11c: destroy the second lifetime (roles and topics are RETAIN; the cleanup deletes all four)"
node "${LOCAL_DIST}" destroy "${ADOPT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${ADOPT_STATE_KEY} still exists after the second destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ADOPT_STATE_KEY}"
echo "    OK: second lifetime destroyed"

# ---------------------------------------------------------------------------
# The SINGLE-RECORD orphan arm (go-to-k/cdkd#4602).
#
# `cdkd state orphan <stack> --resource <logicalId>` drops ONE record of a
# stack that stays deployed, without the CDK app. Asserted: only that record
# goes, a surviving record's dependency on it is rewritten out, the resource
# stays in AWS, and the next deploy — with the construct gone from the
# template, the case the option exists for — leaves it alone rather than
# deleting it, because cdkd no longer holds a record of it.
# ---------------------------------------------------------------------------

echo ""
echo "==> Phase 12: deploy the single-record arm (a queue + a parameter that depends on it)"
CDKD_TEST_ORPHAN_RESOURCE=with node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ORPHAN_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" - 2>/dev/null || echo '{}')"
QUEUE_LOGICAL_ID=$(printf '%s' "${ORPHAN_STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::SQS::Queue") | .key] | first // ""')
KEEPER_LOGICAL_ID=$(printf '%s' "${ORPHAN_STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::SSM::Parameter") | .key] | first // ""')
ORPHAN_QUEUE_URL=$(printf '%s' "${ORPHAN_STATE}" | jq -r --arg k "${QUEUE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
KEEPER_NAME=$(printf '%s' "${ORPHAN_STATE}" | jq -r --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k].physicalId // ""')
BEFORE_KEYS=$(printf '%s' "${ORPHAN_STATE}" | jq -c '.resources | keys')
if [ -z "${QUEUE_LOGICAL_ID}" ] || [ -z "${KEEPER_LOGICAL_ID}" ] || [ -z "${ORPHAN_QUEUE_URL}" ] || [ -z "${KEEPER_NAME}" ]; then
  echo "FAIL: could not resolve the queue / parameter records from ${ORPHAN_STATE_KEY}" >&2
  printf '%s\n' "${ORPHAN_STATE}" | jq '{resources: (.resources | keys)}' >&2
  exit 1
fi
# Premise: the parameter's record DEPENDS on the queue, or the rewrite asserted
# below has nothing to rewrite and passes vacuously.
if ! printf '%s' "${ORPHAN_STATE}" | jq -e --arg k "${KEEPER_LOGICAL_ID}" --arg q "${QUEUE_LOGICAL_ID}" \
  '.resources[$k].dependencies | index($q) != null' >/dev/null; then
  echo "FAIL: premise: ${KEEPER_LOGICAL_ID}'s record does not list ${QUEUE_LOGICAL_ID} in its dependencies" >&2
  printf '%s\n' "${ORPHAN_STATE}" | jq --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k]' >&2
  exit 1
fi
echo "    queue=${QUEUE_LOGICAL_ID} parameter=${KEEPER_LOGICAL_ID} (depends on the queue)"

echo "==> Phase 13: an unknown --resource refuses and writes nothing"
REFUSE_LOG="$(mktemp)"
if node "${LOCAL_DIST}" state orphan "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" \
  --resource NoSuchLogicalId4602 --yes > "${REFUSE_LOG}" 2>&1; then
  echo "FAIL: 'state orphan --resource NoSuchLogicalId4602' succeeded; it must refuse an id the record does not hold" >&2
  cat "${REFUSE_LOG}" >&2
  exit 1
fi
# The REASON, not just the exit code: a flag typo, a bucket miss or a crash
# also exits non-zero.
if ! grep -q "Resource(s) not in state for" "${REFUSE_LOG}"; then
  echo "FAIL: the refusal is not the unknown-logical-id one" >&2
  cat "${REFUSE_LOG}" >&2
  exit 1
fi
AFTER_KEYS=$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" - 2>/dev/null | jq -c '.resources | keys')
if [ "${AFTER_KEYS}" != "${BEFORE_KEYS}" ]; then
  echo "FAIL: the refused run changed the record: ${BEFORE_KEYS} -> ${AFTER_KEYS}" >&2
  exit 1
fi
echo "    OK: refused, record unchanged"

echo "==> Phase 14: state orphan --resource ${QUEUE_LOGICAL_ID} (drop ONLY the queue's record)"
node "${LOCAL_DIST}" state orphan "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" \
  --resource "${QUEUE_LOGICAL_ID}" --yes

ORPHAN_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY}" - 2>/dev/null || echo '{}')"
EXPECTED_KEYS=$(printf '%s' "${BEFORE_KEYS}" | jq -c --arg q "${QUEUE_LOGICAL_ID}" 'map(select(. != $q))')
AFTER_KEYS=$(printf '%s' "${ORPHAN_STATE}" | jq -c '.resources | keys')
if [ "${AFTER_KEYS}" != "${EXPECTED_KEYS}" ]; then
  echo "FAIL: expected exactly the queue's record to go: ${BEFORE_KEYS} -> ${AFTER_KEYS} (wanted ${EXPECTED_KEYS})" >&2
  exit 1
fi
if printf '%s' "${ORPHAN_STATE}" | jq -e --arg k "${KEEPER_LOGICAL_ID}" --arg q "${QUEUE_LOGICAL_ID}" \
  '.resources[$k].dependencies | index($q) != null' >/dev/null; then
  echo "FAIL: ${KEEPER_LOGICAL_ID}'s record still depends on the removed ${QUEUE_LOGICAL_ID}" >&2
  exit 1
fi
if [ "$(printf '%s' "${ORPHAN_STATE}" | jq -r --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k].physicalId // ""')" != "${KEEPER_NAME}" ]; then
  echo "FAIL: the surviving parameter's record lost its physical id" >&2
  exit 1
fi
# The surviving record's value names the queue's URL, not a {Ref} to a
# record that no longer exists.
KEEPER_RECORDED=$(printf '%s' "${ORPHAN_STATE}" | jq -c --arg k "${KEEPER_LOGICAL_ID}" '.resources[$k].properties.Value')
if [ "${KEEPER_RECORDED}" != "$(jq -cn --arg u "${ORPHAN_QUEUE_URL}" '$u')" ]; then
  echo "FAIL: ${KEEPER_LOGICAL_ID}'s recorded Value is ${KEEPER_RECORDED}, expected the queue URL" >&2
  exit 1
fi
if ! queue_state "${ORPHAN_QUEUE_URL}" exists; then
  echo "FAIL: 'state orphan --resource' deleted the queue — it must only drop the record" >&2
  exit 1
fi
echo "    OK: only the queue's record is gone, the dependency is rewritten, the queue is live"

echo "==> Phase 15: redeploy with the queue gone from the template (must leave the queue alone)"
REDEPLOY_ORPHAN_LOG="$(mktemp)"
CDKD_TEST_ORPHAN_RESOURCE=without node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${REDEPLOY_ORPHAN_LOG}"
# The deploy must not even PLAN the queue: it holds no record of it.
# ONE process: under pipefail a `grep | grep -q` whose first stage takes
# SIGPIPE reads as no match, which is the failure this assertion exists for.
# A line carrying the queue URL is skipped: the URL holds the logical id
# (cdkd's generated name), so the survivor's old value would match otherwise.
if awk -v id="${QUEUE_LOGICAL_ID}" -v url="${ORPHAN_QUEUE_URL}" 'index($0, id) && !index($0, url) && tolower($0) ~ /delet/ {f = 1} END {exit !f}' \
  "${REDEPLOY_ORPHAN_LOG}"; then
  echo "FAIL: the redeploy planned or ran a delete of ${QUEUE_LOGICAL_ID}, whose record was orphaned" >&2
  rm -f "${REDEPLOY_ORPHAN_LOG}"
  exit 1
fi
rm -f "${REDEPLOY_ORPHAN_LOG}"
if ! queue_state "${ORPHAN_QUEUE_URL}" exists; then
  echo "FAIL: the redeploy deleted the orphaned queue; with no record cdkd must leave it alone" >&2
  exit 1
fi
KEEPER_VALUE=$(aws ssm get-parameter --name "${KEEPER_NAME}" --query 'Parameter.Value' --output text)
if [ "${KEEPER_VALUE}" != "detached" ]; then
  echo "FAIL: the surviving parameter was not updated by the redeploy (value: ${KEEPER_VALUE})" >&2
  exit 1
fi
echo "    OK: redeploy updated the survivor and left the orphaned queue in place"

echo "==> Phase 16: destroy the single-record arm, then delete the orphaned queue by URL"
DESTROY_ORPHAN_LOG="$(mktemp)"
CDKD_TEST_ORPHAN_RESOURCE=without node "${LOCAL_DIST}" destroy "${ORPHAN_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1 | tee "${DESTROY_ORPHAN_LOG}"
# The LOG, as in Phase 15: `queue_state exists` cannot catch a wrong delete,
# since SQS answers a just-deleted queue for up to 60 s.
if awk -v id="${QUEUE_LOGICAL_ID}" -v url="${ORPHAN_QUEUE_URL}" 'index($0, id) && !index($0, url) && tolower($0) ~ /delet/ {f = 1} END {exit !f}' \
  "${DESTROY_ORPHAN_LOG}"; then
  echo "FAIL: the destroy deleted ${QUEUE_LOGICAL_ID}, whose record was orphaned" >&2
  exit 1
fi
assert_gone "state file s3://${STATE_BUCKET}/${ORPHAN_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ORPHAN_STATE_KEY}"
assert_gone "SSM parameter ${KEEPER_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${KEEPER_NAME}"
# The destroy holds no record of the queue, so it must still be there (the
# log check above is the discriminating one; this catches a delete by other
# means once SQS stops answering).
if ! queue_state "${ORPHAN_QUEUE_URL}" exists; then
  echo "FAIL: the destroy deleted the orphaned queue, which no record names" >&2
  exit 1
fi
aws sqs delete-queue --queue-url "${ORPHAN_QUEUE_URL}"
queue_state "${ORPHAN_QUEUE_URL}" gone
ORPHAN_QUEUE_URL=""
echo "    OK: stack destroyed, orphaned queue deleted by URL"

cleanup
trap - EXIT INT TERM

echo ""
echo "=== PASS: retain-orphan-redeploy integ (a held derived name diagnosed + advised remedy recovers; a rollback orphan is left alone and the redeploy creates under the next name generation; a new lifetime leaves a kept resource alone; state orphan --resource drops one record) ==="
