#!/usr/bin/env bash
# verify.sh — generated physical names across a stack's lifetime (issue #5064).
#
# A stack the last v12 binary deployed is LEGACY: the local binary keeps every
# name `{stack}-{logicalId}`, writes no stackInstanceId or name generation, and
# keeps today's replacement behavior (a same-name collision, `--replace`
# delete-first, a `cdkd rollback` of it). A stack the local binary deploys
# fresh gets a stackInstanceId and names `{stack}-{logicalId}-{12 hex}`; each
# replacement of an un-named resource creates the new one FIRST under the next
# name GENERATION (no `--replace`), a crash re-run derives that same name, a
# rollback records the generation the deleted copy reached, a logical id that
# left the stack comes back under a new name, and what a rollback left in AWS
# is not taken back. Every expected name is recomputed by `names.mjs` from
# state.json's id, which is never printed.
#
# Red line (pre-fix): "replacement kept the generation / collided / needs
# --replace", "re-added id reused a name", "orphan re-adopted".
#
# PHASES
#   0  preflight, pre-run cleanup, the pinned v12 binary installed.
#   A1 v12 deploy: `version: 12`, no id, legacy names (the premise).
#   A2 local no-op deploy: every physical id and the RoleId unchanged, no id,
#      no name generation anywhere.
#   A3 local in-place update: the same.
#   A4 local replacement WITHOUT --replace: refused as before, nothing deleted.
#   A5 `--replace --no-rollback` with a failing sibling, then `cdkd rollback`:
#      the legacy name throughout, no generation written.
#   A6 destroy.
#   B1 fresh deploy (load balancer, nested child, extras): an id; every
#      un-named resource at generation 0's name; no generation written.
#   B2 no-op + in-place update: names and the RoleId unchanged.
#   C  replacement of Table (KeySchema), Role (Path), Tg (Port, behind a
#      listener), ChildRole (Path) and Queue (`--recreate-via-cc-api`), no
#      --replace: each at generation 1's name, created before the old one was
#      deleted, the old one gone (the in-use target group's delete deferred).
#   D1 crash (name-adopting): the load balancer's Scheme flips (and Tg's port,
#      since ELBv2 keeps a target group behind one load balancer); the deploy is
#      killed once generation 1's load balancer exists; the re-run takes THAT
#      load balancer, and no third one is created; Tg moves to generation 2.
#   D2 crash (non-adopting): Table's key flips; killed once generation 2's
#      table exists; the re-run refuses naming `cdkd import`; the import adopts
#      it; a no-op deploy changes nothing; the next replacement takes
#      generation 3.
#   E1 `--no-rollback` failure after Role's replacement, then `cdkd rollback`
#      (no --revert-failed): generation 1's role back, generation 2's gone,
#      the high-water mark 2; the retry takes generation 3.
#   E2 automatic rollback after Role's next replacement: the high-water mark
#      is recorded; the retry goes past it.
#   F1 ExtraQ (Delete) and ExtraKeptQ (Retain) leave the stack: both retire at
#      generation 0, the kept queue stays in AWS.
#   F2 both re-added: generation 1's names; the kept copy untouched.
#   F3 OrphanQ (Retain) is created beside a failing sibling: the rollback
#      leaves it in AWS and retires its generation.
#   F4 OrphanQ re-deployed: a NEW queue at generation 1, the orphan left alone,
#      the warning naming `cdkd import`.
#   G  destroy and a fresh deploy (a new lifetime): every name differs.
#   H  teardown; what Retain kept is deleted directly; state versions swept.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

export AWS_PAGER=""

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

. ../s3-versions.sh

STACK="CdkdGenNameLife"
CHILD_STACK="${STACK}~Child"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
CHILD_LOCK_KEY="cdkd/${CHILD_STACK}/${REGION}/lock.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
CHILD_STATE_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"

# The LAST v12-writing cdkd release on npm when this fixture was written.
# Phase A1 asserts it writes `version: 12` AND no id, so a wrong pin fails
# loudly instead of quietly testing something else.
V12_CDKD_VERSION="0.301.12"
V12_TMPDIR=""
V12_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

STATE_FILE=""
CHILD_STATE_FILE=""
DEPLOY_LOG=""
KILLED_PID=""
# Queues `DeletionPolicy: Retain` keeps out of every destroy; deleted by
# cleanup, by URL.
KEPT_QUEUE_URLS=()
# Tables a crash arm leaves outside state; deleted by cleanup, by name.
LEFT_TABLES=()
# Load balancers a crash arm can leave outside state; deleted by cleanup, by
# name, BEFORE the destroy (their network interfaces would hold the VPC).
LEFT_ALB_NAMES=()
# Target groups a crash arm can leave outside state; deleted by cleanup, by
# name, after the load balancers and before the destroy.
LEFT_TG_NAMES=()

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  # The fixture's ONE stack name, exactly: an empty or other value refuses.
  case "${STACK}" in
    CdkdGenNameLife) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  [ -n "${KILLED_PID}" ] && kill -9 "${KILLED_PID}" 2>/dev/null
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}" >/dev/null 2>&1
    aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${CHILD_LOCK_KEY}" >/dev/null 2>&1
  fi
  for name in "${LEFT_ALB_NAMES[@]}"; do
    arn="$(aws elbv2 describe-load-balancers --region "${REGION}" --names "${name}" \
      --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null)"; [ $? -eq 0 ] || arn=""
    case "${arn}" in
      arn:*)
        aws elbv2 delete-load-balancer --region "${REGION}" --load-balancer-arn "${arn}" >/dev/null 2>&1
        aws elbv2 wait load-balancers-deleted --region "${REGION}" --load-balancer-arns "${arn}" >/dev/null 2>&1
        ;;
    esac
  done
  for name in "${LEFT_TG_NAMES[@]}"; do
    arn="$(aws elbv2 describe-target-groups --region "${REGION}" --names "${name}" \
      --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)"; [ $? -eq 0 ] || arn=""
    case "${arn}" in
      arn:*) aws elbv2 delete-target-group --region "${REGION}" --target-group-arn "${arn}" >/dev/null 2>&1 ;;
    esac
  done
  if [ -f "${LOCAL_DIST}" ]; then
    AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Again after the destroy: one a listener still used was refused above.
  for name in "${LEFT_TG_NAMES[@]}"; do
    arn="$(aws elbv2 describe-target-groups --region "${REGION}" --names "${name}" \
      --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)"; [ $? -eq 0 ] || arn=""
    case "${arn}" in
      arn:*) aws elbv2 delete-target-group --region "${REGION}" --target-group-arn "${arn}" >/dev/null 2>&1 ;;
    esac
  done
  for url in "${KEPT_QUEUE_URLS[@]}"; do
    aws sqs delete-queue --region "${REGION}" --queue-url "${url}" >/dev/null 2>&1
  done
  for table in "${LEFT_TABLES[@]}"; do
    aws dynamodb delete-table --region "${REGION}" --table-name "${table}" >/dev/null 2>&1
  done
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${CHILD_STATE_PREFIX:-}" noncurrent || true
  if [ -n "${V12_TMPDIR}" ] && [ -d "${V12_TMPDIR}" ]; then
    rm -rf "${V12_TMPDIR}"
  fi
  rm -rf "${STATE_FILE:-}" "${CHILD_STATE_FILE:-}" "${DEPLOY_LOG:-}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup || true

STATE_FILE="$(mktemp)"
CHILD_STATE_FILE="$(mktemp)"
DEPLOY_LOG="$(mktemp)"

# The synth inputs (lib/generated-name-lifecycle-stack.ts).
export GNL_EDIT=1 GNL_TABLE_KEY=pk GNL_ROLE_PATH=/a/ GNL_TG_PORT=80 GNL_ALB=0
export GNL_ALB_INTERNAL=0 GNL_NESTED=0 GNL_CHILD_PATH=/a/ GNL_EXTRA=0 GNL_ORPHANQ=0
export GNL_FAIL=0 GNL_FAIL_AFTER=Table

# --- helpers ----------------------------------------------------------------

pass() { echo "    OK: $1"; }
fail() {
  echo "FAIL: $1" >&2
  exit 1
}

fetch_state() { # <label> — strict
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_FILE}" >/dev/null
  [ -s "${STATE_FILE}" ] || fail "$1: s3://${STATE_BUCKET}/${STATE_KEY} is empty"
}
fetch_child_state() { # <label> — strict
  aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" "${CHILD_STATE_FILE}" >/dev/null
  [ -s "${CHILD_STATE_FILE}" ] || fail "$1: the child state file is empty"
}
state_field() { # <jq expression>
  jq -r "$1" "${STATE_FILE}"
}
physical() { # <logicalId>
  state_field ".resources[\"$1\"].physicalId // \"\""
}
generation_of() { # <logicalId> — absent prints 0
  state_field ".resources[\"$1\"].nameGeneration // 0"
}
high_of() { # <logicalId> — absent prints ""
  state_field ".resources[\"$1\"].nameGenerationHigh // \"\""
}

assert_eq() { # <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    fail "$1: got '$2', expected '$3'"
  fi
  pass "$1"
}
assert_ne() { # <label> <actual> <unexpected>
  if [ "$2" = "$3" ]; then
    fail "$1: got '$2', which it must not be"
  fi
  pass "$1"
}

# The name cdkd generates for <logicalId> at <generation> (`names.mjs`), from
# the id in the given state file. Never prints the id.
expected_name() { # <state file> <stack> <logicalId> <generation> <kind>
  node names.mjs expected "$@" || return 1
}
held_name() { # <kind> <physicalId>
  node names.mjs held "$1" "$2" || return 1
}
assert_named() { # <label> <logicalId> <generation> <kind>
  local want got
  want="$(expected_name "${STATE_FILE}" "${STACK}" "$2" "$3" "$4")" || fail "$1: could not compute the expected name"
  got="$(held_name "$4" "$(physical "$2")")" || fail "$1: could not read the held name"
  assert_eq "$1: $2 holds generation $3's generated name" "${got}" "${want}"
}

no_generation_anywhere() { # <label>
  assert_eq "$1: no record carries a name generation" \
    "$(state_field '[.resources[] | (has("nameGeneration") or has("nameGenerationHigh"))] | any')" "false"
  assert_eq "$1: the record retires nothing" "$(state_field 'has("retiredNameGenerations")')" "false"
}

# Run a cdkd command, its output into DEPLOY_LOG.
run_cdkd() { # <expect: ok|fail> <label> <binary> <args...>
  local expect="$1" label="$2" bin="$3" rc
  shift 3
  set +e
  AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${expect}" = "ok" ] && [ "${rc}" -ne 0 ]; then
    tail -60 "${DEPLOY_LOG}" >&2
    fail "${label}: exited ${rc}"
  fi
  if [ "${expect}" = "fail" ] && [ "${rc}" -eq 0 ]; then
    tail -60 "${DEPLOY_LOG}" >&2
    fail "${label}: exited 0, expected a failure"
  fi
  pass "${label}: exited ${rc} (${expect})"
}
deploy_local() { # <expect> <label> [extra flags...]
  local expect="$1" label="$2"
  shift 2
  run_cdkd "${expect}" "${label}" "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@"
}

# A line of cdkd's output, with a sentinel: <needle> must appear, and when the
# <sentinel> (an independent marker of the same message) is present without
# it, the wording drifted.
assert_log_has() { # <label> <needle> [sentinel]
  if grep -qF -- "$2" "${DEPLOY_LOG}"; then
    pass "$1: output names '$2'"
    return
  fi
  if [ -n "${3:-}" ] && grep -qF -- "$3" "${DEPLOY_LOG}"; then
    fail "$1: output carries '$3' but no longer '$2' — the message's wording drifted"
  fi
  tail -60 "${DEPLOY_LOG}" >&2
  fail "$1: output lacks '$2'"
}

log_line_no() { # <fixed text> — the first line number carrying it, or nothing
  grep -nF -- "$1" "${DEPLOY_LOG}" | head -1 | cut -d: -f1
}

table_key() { # <table name> — strict
  aws dynamodb describe-table --region "${REGION}" --table-name "$1" \
    --query 'Table.KeySchema[0].AttributeName' --output text
}
role_id() { # <role name> — strict
  aws iam get-role --role-name "$1" --query 'Role.RoleId' --output text
}

assert_table_gone() { # <label> <name> — DeleteTable completes asynchronously
  aws dynamodb wait table-not-exists --region "${REGION}" --table-name "$2" \
    || fail "$1: table $2 was still being deleted after the waiter gave up"
  assert_gone "$1: table $2 still exists" \
    aws dynamodb describe-table --region "${REGION}" --table-name "$2"
  pass "$1: table $2 is gone"
}
assert_role_gone() { # <label> <name>
  assert_gone "$1: role $2 still exists" aws iam get-role --role-name "$2"
  pass "$1: role $2 is gone"
}
assert_queue_gone() { # <label> <name> — SQS can answer for a deleted queue for up to 60s
  local i
  for i in $(seq 1 10); do
    if gone_probe aws sqs get-queue-url --region "${REGION}" --queue-name "$2"; then
      pass "$1: queue $2 is gone"
      return
    fi
    sleep 10
  done
  fail "$1: queue $2 still exists after 100s"
}
assert_tg_gone() { # <label> <name>
  assert_gone "$1: target group $2 still exists" \
    aws elbv2 describe-target-groups --region "${REGION}" --names "$2"
  pass "$1: target group $2 is gone"
}
wait_alb_gone() { # <label> <name> — a load balancer's delete completes asynchronously
  local i
  for i in $(seq 1 30); do
    if gone_probe aws elbv2 describe-load-balancers --region "${REGION}" --names "$2"; then
      pass "$1: load balancer $2 is gone"
      return
    fi
    sleep 10
  done
  fail "$1: load balancer $2 still exists after 300s"
}
queue_url() { # <name> — strict
  aws sqs get-queue-url --region "${REGION}" --queue-name "$1" --query QueueUrl --output text
}

release_lock() { # a killed run held the stack lock (and maybe the child's); release them as an operator would
  aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}" >/dev/null
  aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${CHILD_LOCK_KEY}" >/dev/null
}

# Deploy in the background and SIGKILL it once <probe> succeeds (the next
# generation's resource exists). The probe is a read: it fails until then.
deploy_and_kill_when() { # <label> <probe command...>
  local label="$1" i
  shift
  AWS_REGION="${REGION}" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force-stateful-recreation \
    >"${DEPLOY_LOG}" 2>&1 &
  KILLED_PID=$!
  for i in $(seq 1 120); do
    if "$@" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${KILLED_PID}" 2>/dev/null; then
      tail -40 "${DEPLOY_LOG}" >&2
      fail "${label}: the deploy ended before the next generation's resource appeared (premise)"
    fi
    sleep 2
  done
  if ! "$@" >/dev/null 2>&1; then
    fail "${label}: the next generation's resource never appeared within 240s (premise)"
  fi
  kill -9 "${KILLED_PID}"
  wait "${KILLED_PID}" 2>/dev/null || true
  KILLED_PID=""
  pass "${label}: the deploy was killed once the next generation's resource existed"
}

# ===========================================================================
echo "==> Phase 0: the pinned v12 binary (@go-to-k/cdkd@${V12_CDKD_VERSION})"
# ===========================================================================
V12_TMPDIR="$(mktemp -d)"
(cd "${V12_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${V12_CDKD_VERSION}" >/dev/null)
V12_BIN="${V12_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
[ -f "${V12_BIN}" ] || fail "the v12 binary was not installed at ${V12_BIN}"

# ===========================================================================
echo "==> Phase A1: a LEGACY stack (deployed by the v12 binary)"
# ===========================================================================
run_cdkd ok "A1 v12 deploy" "${V12_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "A1"
assert_eq "A1: state.version" "$(state_field '.version')" "12"
assert_eq "A1: no stackInstanceId" "$(state_field 'has("stackInstanceId")')" "false"
assert_eq "A1: Table holds the legacy name" "$(physical Table)" "${STACK}-Table"
assert_eq "A1: Role holds the legacy name" "$(physical Role)" "${STACK}-Role"
LEGACY_IDS="$(state_field '[.resources | to_entries[] | "\(.key)=\(.value.physicalId)"] | sort | join(",")')"
LEGACY_ROLE_ID="$(role_id "${STACK}-Role")"

# ===========================================================================
echo "==> Phase A2: a local no-op deploy over the legacy record"
# ===========================================================================
deploy_local ok "A2 no-op"
fetch_state "A2"
assert_eq "A2: still no stackInstanceId" "$(state_field 'has("stackInstanceId")')" "false"
assert_eq "A2: every physical id unchanged" \
  "$(state_field '[.resources | to_entries[] | "\(.key)=\(.value.physicalId)"] | sort | join(",")')" \
  "${LEGACY_IDS}"
assert_eq "A2: the role is the same role (RoleId)" "$(role_id "${STACK}-Role")" "${LEGACY_ROLE_ID}"
no_generation_anywhere "A2"

# ===========================================================================
echo "==> Phase A3: a local in-place update"
# ===========================================================================
export GNL_EDIT=2
deploy_local ok "A3 in-place update"
fetch_state "A3"
assert_eq "A3: every physical id unchanged" \
  "$(state_field '[.resources | to_entries[] | "\(.key)=\(.value.physicalId)"] | sort | join(",")')" \
  "${LEGACY_IDS}"
assert_eq "A3: the role is the same role (RoleId)" "$(role_id "${STACK}-Role")" "${LEGACY_ROLE_ID}"
assert_eq "A3: still no stackInstanceId" "$(state_field 'has("stackInstanceId")')" "false"
no_generation_anywhere "A3"

# ===========================================================================
echo "==> Phase A4: a legacy replacement without --replace is refused, as before"
# ===========================================================================
export GNL_TABLE_KEY=id
deploy_local fail "A4 replacement without --replace" --force-stateful-recreation
assert_log_has "A4" "requires replacement" "NAMED_REPLACEMENT_COLLISION"
assert_log_has "A4" "cdkd deploy --replace" "requires replacement"
fetch_state "A4"
assert_eq "A4: Table keeps the legacy name" "$(physical Table)" "${STACK}-Table"
assert_eq "A4: nothing was deleted (the table keeps its key)" "$(table_key "${STACK}-Table")" "pk"

# ===========================================================================
echo "==> Phase A5: --replace delete-first, a failing sibling, then cdkd rollback"
# ===========================================================================
export GNL_FAIL=1 GNL_FAIL_AFTER=Table
deploy_local fail "A5 --replace with a failing sibling" --replace --force-stateful-recreation --no-rollback
fetch_state "A5 after the failure"
assert_eq "A5: Table was re-created under the SAME legacy name" "$(physical Table)" "${STACK}-Table"
assert_eq "A5: the re-created table has the new key" "$(table_key "${STACK}-Table")" "id"
no_generation_anywhere "A5 after the failure"
run_cdkd ok "A5 cdkd rollback" "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --force
fetch_state "A5 after the rollback"
assert_eq "A5: Table is back under the legacy name" "$(physical Table)" "${STACK}-Table"
assert_eq "A5: the restored table has the old key" "$(table_key "${STACK}-Table")" "pk"
assert_eq "A5: still no stackInstanceId" "$(state_field 'has("stackInstanceId")')" "false"
no_generation_anywhere "A5 after the rollback"
export GNL_FAIL=0 GNL_TABLE_KEY=pk

# ===========================================================================
echo "==> Phase A6: destroy the legacy stack"
# ===========================================================================
run_cdkd ok "A6 destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "A6: state file still exists" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "A6: the state file is gone"
assert_table_gone "A6" "${STACK}-Table"

# ===========================================================================
echo "==> Phase B1: a fresh deploy mints an id; every name is generation 0's"
# ===========================================================================
export GNL_EDIT=1 GNL_ALB=1 GNL_NESTED=1 GNL_EXTRA=1
deploy_local ok "B1 fresh deploy"
fetch_state "B1"
# Registered first: Retain keeps it out of every destroy.
KEPT_QUEUE_URLS+=("$(physical ExtraKeptQ)")
case "$(state_field '.stackInstanceId // ""')" in
  ????????-????-4???-????-????????????) pass "B1: the record carries a stackInstanceId" ;;
  *) fail "B1: the record carries no well-formed stackInstanceId (value withheld)" ;;
esac
assert_named "B1" Table 0 table
assert_named "B1" Queue 0 queue
assert_named "B1" Topic 0 topic
assert_named "B1" LogGroup 0 loggroup
assert_named "B1" Role 0 role
assert_named "B1" Fn 0 fn
assert_named "B1" Rule 0 rule
assert_named "B1" Bucket 0 bucket
assert_named "B1" Tg 0 tg
assert_named "B1" TargetGroupWithAVeryLongLogicalIdPastTheCap 0 tg
assert_named "B1" Alb 0 alb
assert_named "B1" ExtraQ 0 queue
assert_named "B1" ExtraKeptQ 0 queue
LONG_TG_NAME="$(held_name tg "$(physical TargetGroupWithAVeryLongLogicalIdPastTheCap)")"
assert_eq "B1: the long logical id's name fits ELBv2's 32-character cap" \
  "$([ "${#LONG_TG_NAME}" -le 32 ] && echo yes)" "yes"
fetch_child_state "B1"
CHILD_WANT="$(expected_name "${CHILD_STATE_FILE}" "${CHILD_STACK}" ChildRole 0 role)" || fail "B1: child name"
assert_eq "B1: the nested child's ChildRole holds its own lifetime's generation-0 name" \
  "$(jq -r '.resources.ChildRole.physicalId' "${CHILD_STATE_FILE}")" "${CHILD_WANT}"
no_generation_anywhere "B1"
B1_TABLE="$(physical Table)"
B1_QUEUE_NAME="$(held_name queue "$(physical Queue)")"
B1_ROLE="$(physical Role)"
B1_ROLE_ID="$(role_id "${B1_ROLE}")"
B1_IDS="$(state_field '[.resources | to_entries[] | "\(.key)=\(.value.physicalId)"] | sort | join(",")')"

# ===========================================================================
echo "==> Phase B2: a no-op and an in-place update keep every name"
# ===========================================================================
deploy_local ok "B2 no-op"
export GNL_EDIT=2
deploy_local ok "B2 in-place update"
fetch_state "B2"
assert_eq "B2: every physical id unchanged" \
  "$(state_field '[.resources | to_entries[] | "\(.key)=\(.value.physicalId)"] | sort | join(",")')" \
  "${B1_IDS}"
assert_eq "B2: the role is the same role (RoleId)" "$(role_id "${B1_ROLE}")" "${B1_ROLE_ID}"
no_generation_anywhere "B2"

# ===========================================================================
echo "==> Phase C: replacements create generation 1 FIRST, with no --replace"
# ===========================================================================
B2_TG_NAME="$(held_name tg "$(physical Tg)")"
B2_QUEUE_NAME="$(held_name queue "$(physical Queue)")"
fetch_child_state "C before"
B2_CHILD_ROLE="$(jq -r '.resources.ChildRole.physicalId' "${CHILD_STATE_FILE}")"
export GNL_TABLE_KEY=id GNL_ROLE_PATH=/b/ GNL_TG_PORT=8080 GNL_CHILD_PATH=/b/
deploy_local ok "C replacements" --force-stateful-recreation --recreate-via-cc-api Queue
fetch_state "C"
for spec in Table:table Role:role Tg:tg Queue:queue; do
  assert_named "C" "${spec%%:*}" 1 "${spec##*:}"
  assert_eq "C: ${spec%%:*} records generation 1" "$(generation_of "${spec%%:*}")" "1"
done
# The property-driven arm: the new table was created before the old deleted.
CREATED_AT="$(log_line_no "Creating new Table")"
DELETED_AT="$(log_line_no "Deleting old Table")"
if [ -z "${CREATED_AT}" ] || [ -z "${DELETED_AT}" ] || [ "${CREATED_AT}" -ge "${DELETED_AT}" ]; then
  tail -80 "${DEPLOY_LOG}" >&2
  fail "C: Table was not created before the old one was deleted (create line ${CREATED_AT:-none}, delete line ${DELETED_AT:-none})"
fi
pass "C: Table's new table was created before the old one was deleted"
# The recreate arm: create-first because the name moved.
assert_log_has "C" "creating the new resource before deleting the old one" "new name differs from the one the old resource holds"
assert_log_has "C" "Queue's new name differs from the one the old resource holds" "creating the new resource before deleting the old one"
assert_table_gone "C" "${B1_TABLE}"
assert_role_gone "C" "${B1_ROLE}"
assert_queue_gone "C" "${B2_QUEUE_NAME}"
# Behind the listener: its delete was refused while in use and retried.
assert_tg_gone "C" "${B2_TG_NAME}"
assert_eq "C: the function now runs as the replacement role" \
  "$(aws lambda get-function-configuration --region "${REGION}" --function-name "$(physical Fn)" --query Role --output text | sed 's#.*/##')" \
  "$(physical Role)"
fetch_child_state "C"
CHILD_WANT="$(expected_name "${CHILD_STATE_FILE}" "${CHILD_STACK}" ChildRole 1 role)" || fail "C: child name"
assert_eq "C: the nested child's ChildRole is at generation 1" \
  "$(jq -r '.resources.ChildRole.physicalId' "${CHILD_STATE_FILE}")" "${CHILD_WANT}"
assert_eq "C: the child record says so" "$(jq -r '.resources.ChildRole.nameGeneration // 0' "${CHILD_STATE_FILE}")" "1"
assert_role_gone "C (child)" "${B2_CHILD_ROLE}"

# ===========================================================================
echo "==> Phase D1: a killed replacement of a name-adopting type is taken back"
# ===========================================================================
ALB_GEN0="$(physical Alb)"
ALB_GEN1_NAME="$(expected_name "${STATE_FILE}" "${STACK}" Alb 1 alb)" || fail "D1: name"
VPC_ID="$(aws elbv2 describe-load-balancers --region "${REGION}" --load-balancer-arns "${ALB_GEN0}" \
  --query 'LoadBalancers[0].VpcId' --output text)"
TG_GEN1_NAME="$(held_name tg "$(physical Tg)")" || fail "D1: tg name"
TG_GEN2_NAME="$(expected_name "${STATE_FILE}" "${STACK}" Tg 2 tg)" || fail "D1: tg name"
# The listener moves to the new load balancer, and ELBv2 refuses one target
# group behind two load balancers ("cannot be associated with more than one
# load balancer"), as it does to CloudFormation: a Scheme flip deploys only
# with a new target group, so Tg's port flips too.
export GNL_ALB_INTERNAL=1 GNL_TG_PORT=9090
# The killed run's load balancer is in no record until the re-run takes it;
# its target group likewise. Generation 1's target group too: its delete is
# refused while the listener still uses it, and a failed phase must not leave
# it billing (go-to-k/cdkd#5111).
LEFT_ALB_NAMES+=("${ALB_GEN1_NAME}")
LEFT_TG_NAMES+=("${TG_GEN2_NAME}" "${TG_GEN1_NAME}")
deploy_and_kill_when "D1" aws elbv2 describe-load-balancers --region "${REGION}" --names "${ALB_GEN1_NAME}"
ALB_KILLED_ARN="$(aws elbv2 describe-load-balancers --region "${REGION}" --names "${ALB_GEN1_NAME}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
fetch_state "D1 after the kill"
assert_eq "D1: the killed run recorded nothing (premise: Alb still at generation 0)" "$(physical Alb)" "${ALB_GEN0}"
release_lock
deploy_local ok "D1 re-run"
fetch_state "D1"
assert_eq "D1: the re-run took the load balancer the killed run made" "$(physical Alb)" "${ALB_KILLED_ARN}"
assert_eq "D1: Alb records generation 1" "$(generation_of Alb)" "1"
wait_alb_gone "D1" "$(held_name alb "${ALB_GEN0}")"
assert_eq "D1: exactly one load balancer is left in the VPC (no third)" \
  "$(aws elbv2 describe-load-balancers --region "${REGION}" \
    --query "LoadBalancers[?VpcId=='${VPC_ID}'].LoadBalancerArn" --output text | wc -w | tr -d ' ')" "1"
assert_named "D1" Tg 2 tg
assert_eq "D1: Tg records generation 2" "$(generation_of Tg)" "2"
assert_tg_gone "D1" "${TG_GEN1_NAME}"
# The record names them now: the stack's destroy deletes them.
LEFT_ALB_NAMES=()
LEFT_TG_NAMES=()

# ===========================================================================
echo "==> Phase D2: a killed replacement of a non-adopting type: refuse, import, go on"
# ===========================================================================
TABLE_GEN1="$(physical Table)"
TABLE_GEN2="$(expected_name "${STATE_FILE}" "${STACK}" Table 2 table)" || fail "D2: name"
LEFT_TABLES+=("${TABLE_GEN1}" "${TABLE_GEN2}")
export GNL_TABLE_KEY=sk
deploy_and_kill_when "D2" aws dynamodb describe-table --region "${REGION}" --table-name "${TABLE_GEN2}"
fetch_state "D2 after the kill"
assert_eq "D2: the killed run recorded nothing (premise: Table still at generation 1)" "$(physical Table)" "${TABLE_GEN1}"
release_lock
aws dynamodb wait table-exists --region "${REGION}" --table-name "${TABLE_GEN2}"
deploy_local fail "D2 re-run" --force-stateful-recreation
assert_log_has "D2" "interrupted earlier attempt of this replacement" "is the one this replacement generates"
assert_log_has "D2" "cdkd import" "interrupted earlier attempt of this replacement"
fetch_state "D2 after the refusal"
assert_eq "D2: nothing moved (Table still at generation 1)" "$(physical Table)" "${TABLE_GEN1}"
assert_eq "D2: nothing was deleted (generation 1's table keeps its key)" "$(table_key "${TABLE_GEN1}")" "id"
# A replacement refused on its name keeps its generation (bb6961757): the
# retry asks for the same name and refuses the same way, naming `cdkd import`.
assert_eq "D2: the refused replacement raised no high-water mark" "$(high_of Table)" ""
run_cdkd ok "D2 cdkd import" "${LOCAL_DIST}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --resource "Table=${TABLE_GEN2}" --force --yes
fetch_state "D2 after the import"
assert_eq "D2: Table now names generation 2's table" "$(physical Table)" "${TABLE_GEN2}"
assert_eq "D2: an imported record carries no generation of its own" \
  "$(state_field '.resources.Table | has("nameGeneration")')" "false"
# The import remembers the generation the replaced record reached (1); the
# next replacement goes past it AND past generation 2, whose name the imported
# record itself holds (`nextNameGeneration` skips a generation the physical id
# spells), so it takes generation 3 below.
assert_eq "D2: it remembers the generation the replaced record reached" "$(high_of Table)" "1"
deploy_local ok "D2 no-op after the import"
fetch_state "D2 no-op"
assert_eq "D2: the no-op kept the imported table" "$(physical Table)" "${TABLE_GEN2}"
# Generation 1's table is no record's now: delete it by hand, as the refusal said.
aws dynamodb delete-table --region "${REGION}" --table-name "${TABLE_GEN1}" >/dev/null
aws dynamodb wait table-not-exists --region "${REGION}" --table-name "${TABLE_GEN1}"
export GNL_TABLE_KEY=pk
deploy_local ok "D2 next replacement" --force-stateful-recreation
fetch_state "D2 next replacement"
assert_named "D2 next replacement" Table 3 table
assert_eq "D2: Table records generation 3 (past the imported one)" "$(generation_of Table)" "3"
assert_table_gone "D2" "${TABLE_GEN2}"

# ===========================================================================
echo "==> Phase E1: --no-rollback, then cdkd rollback (no --revert-failed), then retry"
# ===========================================================================
ROLE_GEN1="$(physical Role)"
ROLE_GEN2="$(expected_name "${STATE_FILE}" "${STACK}" Role 2 role)" || fail "E1: name"
export GNL_ROLE_PATH=/c/ GNL_FAIL=1 GNL_FAIL_AFTER=Role
deploy_local fail "E1 failing deploy" --no-rollback
fetch_state "E1 after the failure"
assert_eq "E1: Role was replaced at generation 2 before the failure" "$(physical Role)" "${ROLE_GEN2}"
run_cdkd ok "E1 cdkd rollback" "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --force
fetch_state "E1 after the rollback"
assert_eq "E1: generation 1's role is back" "$(physical Role)" "${ROLE_GEN1}"
assert_eq "E1: Role records generation 1" "$(generation_of Role)" "1"
assert_eq "E1: and the high-water mark 2" "$(high_of Role)" "2"
assert_role_gone "E1" "${ROLE_GEN2}"
assert_eq "E1: the restored role has the old path" \
  "$(aws iam get-role --role-name "${ROLE_GEN1}" --query Role.Path --output text)" "/b/"
export GNL_FAIL=0
deploy_local ok "E1 retry"
fetch_state "E1 retry"
assert_named "E1 retry" Role 3 role
assert_eq "E1: the retry took generation 3, never the rolled-back copy's" "$(generation_of Role)" "3"

# ===========================================================================
echo "==> Phase E2: an automatic rollback records the generation it reached"
# ===========================================================================
ROLE_GEN3="$(physical Role)"
ROLE_GEN4="$(expected_name "${STATE_FILE}" "${STACK}" Role 4 role)" || fail "E2: name"
export GNL_ROLE_PATH=/d/ GNL_FAIL=1 GNL_FAIL_AFTER=Role
deploy_local fail "E2 failing deploy (automatic rollback)"
fetch_state "E2 after the rollback"
assert_eq "E2: generation 3's role is back" "$(physical Role)" "${ROLE_GEN3}"
assert_eq "E2: Role records generation 3" "$(generation_of Role)" "3"
assert_eq "E2: the high-water mark is 4" "$(high_of Role)" "4"
assert_role_gone "E2" "${ROLE_GEN4}"
export GNL_FAIL=0
deploy_local ok "E2 retry"
fetch_state "E2 retry"
assert_named "E2 retry" Role 5 role

# ===========================================================================
echo "==> Phase F1: ExtraQ (Delete) and ExtraKeptQ (Retain) leave the stack"
# ===========================================================================
EXTRA_KEPT_GEN0_NAME="$(held_name queue "$(physical ExtraKeptQ)")"
EXTRA_GEN0_NAME="$(held_name queue "$(physical ExtraQ)")"
export GNL_EXTRA=0
deploy_local ok "F1 removal"
fetch_state "F1"
assert_eq "F1: ExtraQ retired at generation 0" "$(state_field '.retiredNameGenerations.ExtraQ // ""')" "0"
assert_eq "F1: ExtraKeptQ retired at generation 0" "$(state_field '.retiredNameGenerations.ExtraKeptQ // ""')" "0"
assert_queue_gone "F1" "${EXTRA_GEN0_NAME}"
assert_eq "F1: the Retain queue stays in AWS" \
  "$(held_name queue "$(queue_url "${EXTRA_KEPT_GEN0_NAME}")")" "${EXTRA_KEPT_GEN0_NAME}"

# ===========================================================================
echo "==> Phase F2: both re-added under NEW names"
# ===========================================================================
export GNL_EXTRA=1
deploy_local ok "F2 re-add"
fetch_state "F2"
KEPT_QUEUE_URLS+=("$(physical ExtraKeptQ)")
assert_named "F2" ExtraQ 1 queue
assert_named "F2" ExtraKeptQ 1 queue
assert_eq "F2: ExtraQ records generation 1" "$(generation_of ExtraQ)" "1"
assert_eq "F2: ExtraKeptQ records generation 1" "$(generation_of ExtraKeptQ)" "1"
assert_eq "F2: the kept copy is untouched" \
  "$(held_name queue "$(queue_url "${EXTRA_KEPT_GEN0_NAME}")")" "${EXTRA_KEPT_GEN0_NAME}"

# ===========================================================================
echo "==> Phase F3: a rollback leaves a Retain queue in AWS"
# ===========================================================================
ORPHAN_GEN0_NAME="$(expected_name "${STATE_FILE}" "${STACK}" OrphanQ 0 queue)" || fail "F3: name"
export GNL_ORPHANQ=1 GNL_FAIL=1 GNL_FAIL_AFTER=OrphanQ
deploy_local fail "F3 failing deploy (automatic rollback)"
ORPHAN_GEN0_URL="$(queue_url "${ORPHAN_GEN0_NAME}")"
KEPT_QUEUE_URLS+=("${ORPHAN_GEN0_URL}")
pass "F3: the Retain queue the rollback left is in AWS"
fetch_state "F3"
assert_eq "F3: the record has no OrphanQ" "$(state_field '.resources | has("OrphanQ")')" "false"
assert_eq "F3: OrphanQ retired at generation 0" "$(state_field '.retiredNameGenerations.OrphanQ // ""')" "0"

# ===========================================================================
echo "==> Phase F4: the next deploy creates a NEW queue and leaves the orphan alone"
# ===========================================================================
export GNL_FAIL=0
deploy_local ok "F4 redeploy"
fetch_state "F4"
KEPT_QUEUE_URLS+=("$(physical OrphanQ)")
assert_log_has "F4" "This deploy does not take it back" "adopt it with 'cdkd import'"
assert_log_has "F4" "adopt it with 'cdkd import'" "This deploy does not take it back"
assert_named "F4" OrphanQ 1 queue
assert_ne "F4: OrphanQ is a new queue" "$(physical OrphanQ)" "${ORPHAN_GEN0_URL}"
assert_eq "F4: the orphan is untouched" \
  "$(held_name queue "$(queue_url "${ORPHAN_GEN0_NAME}")")" "${ORPHAN_GEN0_NAME}"

# ===========================================================================
echo "==> Phase G: a new lifetime: destroy, and a fresh deploy differs in every name"
# ===========================================================================
run_cdkd ok "G destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
export GNL_EDIT=1 GNL_TABLE_KEY=pk GNL_ROLE_PATH=/a/ GNL_TG_PORT=80 GNL_ALB=0 GNL_ALB_INTERNAL=0
export GNL_NESTED=0 GNL_EXTRA=0 GNL_ORPHANQ=0
deploy_local ok "G fresh deploy"
fetch_state "G"
assert_named "G" Table 0 table
assert_ne "G: Table's name differs from the earlier lifetime's" "$(physical Table)" "${B1_TABLE}"
assert_ne "G: Queue's name differs from the earlier lifetime's" \
  "$(held_name queue "$(physical Queue)")" "${B1_QUEUE_NAME}"
assert_ne "G: Role's name differs from the earlier lifetime's" "$(physical Role)" "${B1_ROLE}"

# ===========================================================================
echo "==> Phase H: teardown"
# ===========================================================================
G_TABLE="$(physical Table)"
G_ROLE="$(physical Role)"
G_FN="$(physical Fn)"
G_TOPIC="$(physical Topic)"
G_BUCKET="$(physical Bucket)"
G_RULE="$(held_name rule "$(physical Rule)")"
G_TG="$(held_name tg "$(physical Tg)")"
G_LOG_GROUP="$(physical LogGroup)"
# An empty id would make its gone-probe below pass without testing anything.
for id in "${G_TABLE}" "${G_ROLE}" "${G_FN}" "${G_TOPIC}" "${G_BUCKET}" "${G_RULE}" "${G_TG}" "${G_LOG_GROUP}"; do
  [ -n "${id}" ] || fail "H: a resource of the last lifetime has no recorded id (premise)"
done
run_cdkd ok "H destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "H: state file still exists" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "H: the state file is gone"
assert_table_gone "H" "${G_TABLE}"
assert_role_gone "H" "${G_ROLE}"
assert_gone "H: function ${G_FN} still exists" \
  aws lambda get-function --region "${REGION}" --function-name "${G_FN}"
assert_gone "H: topic ${G_TOPIC} still exists" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${G_TOPIC}"
assert_gone "H: bucket ${G_BUCKET} still exists" aws s3api head-bucket --bucket "${G_BUCKET}"
assert_gone "H: rule ${G_RULE} still exists" \
  aws events describe-rule --region "${REGION}" --name "${G_RULE}"
assert_tg_gone "H" "${G_TG}"
G_LOG_GROUPS="$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "${G_LOG_GROUP}" --query 'logGroups[].logGroupName' --output text)"
assert_eq "H: the log group is gone" "${G_LOG_GROUPS}" ""
pass "H: every resource of the last lifetime is gone"
for url in "${KEPT_QUEUE_URLS[@]}"; do
  aws sqs delete-queue --region "${REGION}" --queue-url "${url}" >/dev/null 2>&1 || true
  assert_queue_gone "H (kept by Retain, deleted here)" "$(held_name queue "${url}")"
done
KEPT_QUEUE_URLS=()
for table in "${LEFT_TABLES[@]}"; do
  assert_table_gone "H (a crash arm's table)" "${table}"
done
LEFT_TABLES=()

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "generated-name-lifecycle state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" "generated-name-lifecycle child state teardown"

echo ""
echo "==> generated-name-lifecycle test passed (a legacy stack keeps its names and replacements; a fresh stack's replacements create the next generation first, crash re-runs reuse it, rollbacks record it, and what left the stack comes back under a new name)"
