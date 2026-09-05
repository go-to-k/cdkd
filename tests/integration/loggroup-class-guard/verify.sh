#!/usr/bin/env bash
# verify.sh — cdkd LogGroupClass update-guard integ.
#
# Regression coverage for the bug where changing a log group's LogGroupClass
# (STANDARD <-> INFREQUENT_ACCESS) on redeploy was silently dropped: the CFn
# doc marks the property "Update requires: Updates are not supported" (no
# CloudWatch Logs API can change the class after creation; a CFn stack update
# carrying the change FAILS), but cdkd's logs-loggroup-provider.update()
# ignored it — the deploy reported success while AWS kept the old class, and
# state recorded the new one so the next diff saw no change and it could
# never self-heal. The fix throws ResourceUpdateNotSupportedError with an
# actionable message.
#
# That refusal has TWO arms since issue #2579, and this fixture drives both.
# When cdkd's RECORDED properties for the log group carry
# `DeletionProtectionEnabled`, the advised `--replace
# --force-stateful-recreation` is not enough: the replacement's DELETE runs
# from the deploy engine, which never sets `DeleteContext.removeProtection`
# (`cdkd deploy` has no `--remove-protection` flag at all), so AWS refuses the
# DeleteLogGroup and the advised command dies on a SECOND wall. The protected
# arm says so and hands over an out-of-band disable command; phase 6 runs that
# exact command and proves the remedy actually completes.
#
# Phases:
#   1. Deploy a STANDARD, UNPROTECTED log group. Assert AWS reports STANDARD
#      and deletion protection OFF.
#   2. Re-deploy as INFREQUENT_ACCESS WITHOUT --replace: expect FAILURE with
#      the actionable "cannot be changed after creation" + "--replace" message,
#      assert it is the UNPROTECTED arm (the protected arm's wording must be
#      absent), and assert AWS is unchanged.
#   3. Re-deploy the same change with --replace --force-stateful-recreation:
#      expect success and the log group recreated as INFREQUENT_ACCESS.
#   4. Turn deletion protection ON in place. Assert AWS reports it on and the
#      class unchanged — the input the protected arm reads is now in the
#      RECORDED bag, put there by a real deploy rather than by a hand edit.
#   5. Change the class back to STANDARD with protection still on and still no
#      --replace: expect FAILURE carrying the PROTECTED arm's wording — it must
#      name DeletionProtectionEnabled, say `cdkd deploy` has no
#      --remove-protection, and quote the out-of-band disable command with THIS
#      log group's name. Assert AWS unchanged in BOTH properties.
#   6. Follow the remedy the message hands the reader: EXTRACT the disable
#      command out of phase 5's own output, check its argv shape, run it, then
#      re-deploy with --replace --force-stateful-recreation. Expect success and
#      the class changed — plus protection back ON, because create() re-applies
#      it from the template.
#   7. `cdkd destroy --remove-protection` (the destroy-side flip-off, which is
#      what a protected log group needs) + assert the log group is gone and the
#      cdkd state removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# A pager attached to a non-interactive shell is its own route to a hang.
export AWS_PAGER=""

# Every content check on a captured cdkd LOG below is `grep -q ... <<<"${VAR}"`,
# never `printf '%s' "${VAR}" | grep -q ...`. Under `pipefail` the pipeline form
# is FAIL-OPEN once the capture is large enough: `grep -q` exits on the first
# match, the writer fills the pipe and takes SIGPIPE, and the pipeline reports
# 141 — so a NEGATIVE check (`if grep -q <bad thing>; then FAIL`) reads "not
# found" precisely when the bad thing WAS found. Phase 2's "did this deploy
# succeed?" and "is this the protected arm?" checks are both that shape.
# (Measured in the sibling loggroup-never-expire-guard fixture: the failure
# needs a capture somewhere between ~32 KB and ~155 KB.) The ONE exception is
# `gone_probe` below, which is the canonical helper block every affected fixture
# carries VERBATIM and may not be forked.

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

cd "$(dirname "$0")"

STACK="CdkdLoggroupClassGuardExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# The log group is EXPLICITLY named by the fixture stack (keep in sync with
# `logGroupName` in lib/loggroup-class-guard-stack.ts, which phase 1 asserts
# against the state output). Phases 4-6 leave a log group with deletion
# protection ON, and AWS refuses `DeleteLogGroup` outright while that flag is
# set — so the teardown has to be able to find and unprotect the group from a
# FIXTURE-OWNED prefix even when the cdkd state record is gone. cdkd's
# generated name (`/cdkd/<logicalId>`) cannot support that: `/cdkd/` is shared
# with every other fixture, so sweeping it would delete another lane's live log
# groups.
LG_PREFIX="/cdkd-integ/loggroup-class-guard/"
LG_NAME="${LG_PREFIX}class"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Clear deletion protection on ONE log group, out of band.
#
# THREE outcomes, never two — "not found" is not an error here, it is the
# best possible answer (nothing left to unprotect and nothing left to leak):
#   0, prints `cleared` — the call succeeded. Idempotent at AWS, so this also
#      covers a group whose protection was already off.
#   0, prints `absent`  — the log group does not exist.
#   1                   — UNDETERMINED (throttle / auth / network). The caller
#      decides: a hard FAIL on the success path, a WARN inside the best-effort
#      teardown sweep. Collapsing this into "absent" is the bug this shape
#      exists to avoid — it would report a clean teardown over a live,
#      protected log group.
#
# Verified against real AWS (us-east-1, 2026-09-05): the missing-group arm is
# `ResourceNotFoundException ... The specified log group does not exist.`,
# which matches the canonical not-found signature above, and a delete attempted
# while protected fails with `InvalidParameterException ... LogGroup has delete
# protection enabled.`, which deliberately does NOT.
clear_deletion_protection() { # usage: clear_deletion_protection <logGroupName>
  local name="${1:-}" out
  if [ -z "${name}" ]; then
    echo "clear_deletion_protection: empty log group name" >&2
    return 1
  fi
  if out="$(aws logs put-log-group-deletion-protection \
      --log-group-identifier "${name}" \
      --no-deletion-protection-enabled \
      --region "${REGION}" 2>&1)"; then
    printf 'cleared\n'
    return 0
  fi
  if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    printf 'absent\n'
    return 0
  fi
  echo "clear_deletion_protection: undetermined for ${name}: ${out}" >&2
  return 1
}

sweep_log_groups() { # best-effort teardown; never aborts the sweep
  # The relaxation lives on its OWN line inside the subshell: that is the shape
  # `scripts/check-integ-probe-not-found.ts` recognises as a best-effort span,
  # and the subshell keeps it from re-arming strict mode in a caller that is
  # already running under `set +eu` (the cleanup trap).
  (
    set +eu
    # PREFIX GUARD, the same one `s3_purge_prefix_versions` carries in
    # tests/integration/s3-versions.sh, and it is a safety property rather than
    # style: this sweep DELETES every name the listing returns, and the `set
    # +eu` at the top of this subshell has just disabled the only thing that
    # would have caught an empty or unset `LG_PREFIX` — which lists, and would
    # then delete, every log group in the account. Unreachable today (the prefix is
    # a literal), and CloudWatch Logs would also reject an empty
    # `--log-group-name-prefix`; the guard is what keeps that from being the
    # only thing standing between a future edit and an account-wide delete.
    # `exit 0` and not `return 0`: this is a SUBSHELL, so the exit ends the
    # sweep and the function returns its status, leaving the caller running.
    # The sibling `loggroup-never-expire-guard` fixture had the same sweep shape
    # without this guard; issue #2621 gave it the same guard and added the fence
    # `tests/unit/scripts/integ-sweep-prefix-guard.test.ts`, which refuses a
    # delete loop fed by a filter that collapses to the empty string when its
    # scope variable is empty, unless a guard dominates it — a `case` like this
    # one, a dominating emptiness test, a helper the scope is validated by, or
    # an explicit `# allow-unguarded-sweep: <reason>`.
    case "${LG_PREFIX}" in
      /cdkd-integ/*/) ;;
      *)
        echo "    WARN: teardown sweep refused a prefix outside /cdkd-integ/: '${LG_PREFIX:-<empty>}'" >&2
        exit 0
        ;;
    esac

    local names name status attempt del_out list_rc
    # stderr is deliberately NOT merged into this capture: a benign CLI warning
    # would become a phantom "log group name" handed straight to
    # `delete-log-group` below. The rc is read on its own line instead, so a
    # throttled or denied listing is REPORTED rather than read as "the prefix
    # holds nothing" — a silent-empty arm here would also be inconsistent with
    # the tri-state `clear_deletion_protection` this loop calls.
    names="$(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}" \
      --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null)"
    list_rc=$?
    if [ "${list_rc}" -ne 0 ]; then
      echo "    WARN: teardown sweep could not list ${LG_PREFIX} (rc=${list_rc}); a protected log group may survive this run" >&2
      exit 0
    fi
    for name in ${names}; do
      # The flip-off is not optional and it comes FIRST: `DeleteLogGroup` is
      # refused outright while protection is on, so without it this sweep is
      # decorative on exactly the phases that leave a protected group behind.
      if status="$(clear_deletion_protection "${name}")"; then
        echo "    teardown: protection ${status} for ${name}"
      else
        echo "    WARN: could not clear deletion protection on ${name}; the delete below will be refused" >&2
      fi
      # The delete's status is CAPTURED, not swallowed. A silenced delete makes
      # the backstop announce nothing while leaving behind exactly the orphan it
      # exists to prevent — and that is the likely case, not a remote one: the
      # flip-off above is not instantly visible to `DeleteLogGroup`, so the
      # first attempt can still be refused. One retry after a short sleep covers
      # that window; anything still failing is named.
      attempt=1
      while :; do
        if del_out="$(aws logs delete-log-group --log-group-name "${name}" --region "${REGION}" 2>&1)"; then
          echo "    teardown: deleted ${name}"
          break
        fi
        if printf '%s' "${del_out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
          echo "    teardown: ${name} already gone"
          break
        fi
        if [ "${attempt}" -ge 2 ]; then
          echo "    WARN: teardown could not delete ${name} after ${attempt} attempts: ${del_out}" >&2
          break
        fi
        attempt=$((attempt + 1))
        sleep 5
      done
    done
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # OUT-OF-BAND FIRST, and the ORDER is the point rather than a detail: cdkd's
  # own protection flip-off (`--remove-protection`) is one of the things this
  # fixture tests, so the teardown must not be the first thing to depend on it.
  # The sweep clears the flag with a raw AWS call and deletes the log group,
  # needs no state record to do either, and is idempotent — which is also what
  # makes it the arm that still works when `state destroy` below cannot: no
  # state record left, a wedged lock, or a regressed flip-off.
  #
  # Sweeping first costs the destroy nothing. The stack's only resource is the
  # log group, and `LogsLogGroupProvider.delete` treats a
  # ResourceNotFoundException as success, so `state destroy` still runs to
  # completion and still clears the state record.
  sweep_log_groups

  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --remove-protection \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
# `(exit N); cleanup; exit N`, the shape `scripts/check-integ-signal-traps.ts`
# enforces: the seed is what a `rc=$?` teardown reads, and the handler must EXIT
# rather than resume the interrupted phase (#1097 pattern 1). The `exit`
# re-fires the EXIT trap, so `cleanup` runs a second time — harmless, every step
# in it is idempotent, and the repeat is the retry that sweeps a log group whose
# delete the first pass was signalled out of.
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

lg_name() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["LgName"])'
}

# --- bounded polls ---------------------------------------------------------
# `DescribeLogGroups` is NOT read-after-write consistent with `CreateLogGroup`,
# `DeleteLogGroup` or `PutLogGroupDeletionProtection`: each write returns before
# the read reflects it. So every assertion below that follows a WRITE polls to
# the expected value before it FAILs. A single probe into a hard FAIL reports a
# regression for a value that had simply not landed yet — the repo's known
# async gone-probe class, where the failure accuses the fix.
#
# Assertions that follow a REFUSAL stay single-probe on purpose (phases 2, 5 and
# the class read in phase 4): no write was issued, the value was already polled
# to a settled state by the phase that wrote it, and polling for an UNCHANGED
# value would give a late-arriving change time to look like no change.
#
# The budget is small because the value is normally there on the first read, so
# a passing run pays nothing.
POLL_ATTEMPTS=5
POLL_INTERVAL=2

# Poll a value reader until it returns the expected value, then print what it
# LAST saw and return 0. The caller compares and owns the FAIL wording, so a
# timeout hands back the stale value rather than a verdict. A probe ERROR is
# never swallowed into a value: it propagates as a non-zero return, and every
# call site is a plain assignment, so `set -e` sees it.
poll_value() { # usage: poll_value <expected> <reader-fn> <log-group-name>
  local expected="$1" reader="$2" name="$3" got="" i=1
  while :; do
    got="$("${reader}" "${name}")" || return 1
    if [ "${got}" = "${expected}" ] || [ "${i}" -ge "${POLL_ATTEMPTS}" ]; then
      break
    fi
    i=$((i + 1))
    sleep "${POLL_INTERVAL}"
  done
  printf '%s\n' "${got}"
}

# Rows of an EXACT-name projection, never `--query 'length(...)'`: --query is
# applied PER PAGE, so a count prints one number per page rather than a total.
# The exact-name filter matters because `--log-group-name-prefix` also matches
# `<name>-anything`. Note both value readers below answer EMPTY for a log group
# that does not exist, which is why existence is asserted separately rather than
# inferred from a value.
lg_row_count() { # $1 = exact log group name
  # `|| return 1`, and every call site is a plain assignment — never a `$( )`
  # inside `[ ... ]`, where a failing function expands to an empty string, `[`
  # exits 2, and the FAIL branch is skipped.
  local rows
  rows="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'].logGroupName" --output text)" || return 1
  printf '%s' "${rows}" | wc -w | tr -d '[:space:]'
}

assert_lg_exists() { # $1 = exact log group name
  local n
  n="$(poll_value 1 lg_row_count "$1")" || return 1
  if [ "${n}" != "1" ]; then
    echo "FAIL: expected exactly one log group named $1 after ${POLL_ATTEMPTS} probes, last count: '${n}'" >&2
    exit 1
  fi
}

assert_lg_gone() { # $1 = exact log group name
  local n
  n="$(poll_value 0 lg_row_count "$1")" || return 1
  if [ "${n}" != "0" ]; then
    echo "FAIL: log group $1 still exists after destroy --remove-protection (last count: '${n}')" >&2
    exit 1
  fi
}

lg_class() { # prints the live log group class; STANDARD when AWS omits it
  # The whole `--query` argument is DOUBLE-quoted, so the JMESPath string
  # literal takes BARE single quotes around `$1`. The `'"'"'` idiom belongs to
  # single-quoted strings and would emit a raw-string literal here that matches
  # no log group at all — vacuously passing every class assertion.
  local cls
  cls="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'].logGroupClass" --output text)" || return 1
  cls="$(printf '%s' "${cls}" | tr -d '[:space:]')"
  if [ -z "${cls}" ] || [ "${cls}" = "None" ]; then
    echo "STANDARD"
  else
    echo "${cls}"
  fi
}

lg_protection() { # prints True / False for the exact-named log group
  local dp
  dp="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'].deletionProtectionEnabled" --output text)" || return 1
  dp="$(printf '%s' "${dp}" | tr -d '[:space:]')"
  # Measured against real AWS (us-east-1, 2026-09-05): the AWS CLI renders the
  # JSON boolean Python-style, so a protected group prints `True` and a cleared
  # one prints `False`. JMESPath drops a null out of a projection, so an EMPTY
  # answer is a log group whose record carries no such member — unprotected.
  if [ -z "${dp}" ]; then
    echo "False"
  else
    echo "${dp}"
  fi
}

# The three things ONLY the protected arm of the refusal can say. Kept SHORT on
# purpose: the refusal is one long line, and a needle spanning a reword is a
# silent zero match that reads as "the guard did not fire".
#
# BOTH polarities read this ONE list, through the two assert helpers below. That
# is the point of the indirection: a one-sided fence rewards the inverse
# regression, so a needle added here is automatically both asserted on the
# protected arm (phase 5) and forbidden on the unprotected one (phase 2), and
# the two can never drift apart.
protected_needles() { # $1 = exact log group name
  printf '%s\n' "carry DeletionProtectionEnabled"
  printf '%s\n' "cdkd deploy has no --remove-protection flag"
  printf '%s\n' "put-log-group-deletion-protection --log-group-identifier '$1' --no-deletion-protection-enabled"
}

assert_protected_arm() { # $1 = phase label, $2 = captured output, $3 = log group name
  local needle
  while IFS= read -r needle; do
    if ! grep -q -- "${needle}" <<<"$2"; then
      echo "FAIL: $1: the refusal is missing protected-arm text (#2579): ${needle}" >&2
      tail -20 <<<"$2" >&2
      exit 1
    fi
  done <<<"$(protected_needles "$3")"
}

assert_not_protected_arm() { # $1 = phase label, $2 = captured output, $3 = log group name
  local needle
  while IFS= read -r needle; do
    if grep -q -- "${needle}" <<<"$2"; then
      echo "FAIL: $1: an UNPROTECTED log group got protected-arm text (#2579 predicate stuck on?): ${needle}" >&2
      exit 1
    fi
  done <<<"$(protected_needles "$3")"
}

# --- Phase 1: deploy baseline (STANDARD, unprotected) --------------------
echo "==> Phase 1: deploy STANDARD, unprotected log group"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LG="$(lg_name)"
echo "    log group: ${LG}"
if [ "${LG}" != "${LG_NAME}" ]; then
  echo "FAIL: state output LgName is '${LG}', expected the fixture's explicit name '${LG_NAME}' — the teardown sweep is keyed on that prefix" >&2
  exit 1
fi

assert_lg_exists "${LG}"
# Polled: both reads follow a CreateLogGroup, which DescribeLogGroups does not
# reflect synchronously.
CLASS_P1="$(poll_value STANDARD lg_class "${LG}")"
PROT_P1="$(poll_value False lg_protection "${LG}")"
echo "    AWS class=${CLASS_P1} deletionProtection=${PROT_P1} (Phase 1)"
if [ "${CLASS_P1}" != "STANDARD" ]; then
  echo "FAIL: expected STANDARD after Phase 1, got '${CLASS_P1}'" >&2
  exit 1
fi
# Pins the value under test: phase 5 only means something if protection was
# genuinely OFF here and phase 4 genuinely turned it ON. A fixture that shipped
# protected from phase 1 would make phase 2's unprotected arm unreachable.
if [ "${PROT_P1}" != "False" ]; then
  echo "FAIL: expected deletion protection OFF after Phase 1, got '${PROT_P1}'" >&2
  exit 1
fi

# --- Phase 2: class change WITHOUT --replace must FAIL actionably ---------
echo "==> Phase 2: re-deploy as INFREQUENT_ACCESS without --replace (expect actionable failure, UNPROTECTED arm)"
set +e
P2_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
P2_RC=$?
set -e
tail -4 <<<"${P2_OUT}"

if [ "${P2_RC}" -eq 0 ]; then
  echo "FAIL: class change without --replace exited 0 (CLI exit-code contract broken?)" >&2
  exit 1
fi
if grep -q "Deployment completed successfully" <<<"${P2_OUT}"; then
  echo "FAIL: class change without --replace unexpectedly succeeded (silent drop regressed?)" >&2
  exit 1
fi
if ! grep -q "cannot be changed after creation" <<<"${P2_OUT}"; then
  echo "FAIL: expected the actionable LogGroupClass message, got rc=${P2_RC} without it" >&2
  exit 1
fi
if ! grep -q -- "--replace" <<<"${P2_OUT}"; then
  echo "FAIL: expected the --replace remediation hint in the error message" >&2
  exit 1
fi
# The FLOOR under phase 5, over the SAME three needles phase 5 requires — not a
# subset of them. Without it the protected arm's needles could be satisfied by
# text cdkd emits unconditionally, and the fixture would pass on a build whose
# predicate is stuck at `true`.
assert_not_protected_arm "Phase 2" "${P2_OUT}" "${LG}"

assert_lg_exists "${LG}"
# Single probe, not a poll: the guard refused before any write, and both values
# were polled to a settled state in phase 1 — polling for an UNCHANGED value
# would give a late-arriving change time to look like no change.
CLASS_P2="$(lg_class "${LG}")"
PROT_P2="$(lg_protection "${LG}")"
if [ "${CLASS_P2}" != "STANDARD" ]; then
  echo "FAIL: AWS class changed despite the guard (expected STANDARD, got '${CLASS_P2}')" >&2
  exit 1
fi
# Phase 5 pins BOTH properties across its refusal; this one has to as well, or
# the unprotected polarity is the weaker fence of the pair.
if [ "${PROT_P2}" != "False" ]; then
  echo "FAIL: deletion protection changed despite the guard (expected False, got '${PROT_P2}')" >&2
  exit 1
fi
echo "    guard fired with actionable message (unprotected arm); AWS unchanged (STANDARD, unprotected)"

# --- Phase 3: --replace --force-stateful-recreation recreates the group ---
echo "==> Phase 3: re-deploy with --replace --force-stateful-recreation (expect recreate as INFREQUENT_ACCESS)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --replace --force-stateful-recreation

assert_lg_exists "${LG}"
# Polled: the replacement is a DELETE + CREATE onto the same name, so a stale
# read here answers with the OLD group's class and false-FAILs the recreate.
CLASS_P3="$(poll_value INFREQUENT_ACCESS lg_class "${LG}")"
echo "    AWS log group class (Phase 3): ${CLASS_P3}"
if [ "${CLASS_P3}" != "INFREQUENT_ACCESS" ]; then
  echo "FAIL: expected INFREQUENT_ACCESS after --replace recreate, got '${CLASS_P3}'" >&2
  exit 1
fi
echo "    log group recreated under the new class"

# --- Phase 4: turn deletion protection ON in place (#2579 input) ----------
# The refusal reads the RECORDED bag, so the protection has to get there the way
# a user's would: through a real deploy that cdkd records, not a hand edit of
# state.json and not an out-of-band AWS call (which is in NO bag — the message
# says "cdkd's recorded properties" precisely because of that case).
echo "==> Phase 4: enable DeletionProtectionEnabled in place"
CDKD_TEST_UPDATE=true,protect node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_lg_exists "${LG}"
# Polled: this follows the PutLogGroupDeletionProtection write. The class is a
# single probe — nothing wrote it, and it is asserted UNCHANGED.
PROT_P4="$(poll_value True lg_protection "${LG}")"
CLASS_P4="$(lg_class "${LG}")"
echo "    AWS class=${CLASS_P4} deletionProtection=${PROT_P4} (Phase 4)"
if [ "${PROT_P4}" != "True" ]; then
  echo "FAIL: expected deletion protection ON after Phase 4, got '${PROT_P4}' — the #2579 arm's input was never established. If the template carried no DeletionProtectionEnabled at all, this fixture's node_modules predates the aws-cdk-lib L2 prop: 'rm -rf node_modules' here and re-run" >&2
  exit 1
fi
if [ "${CLASS_P4}" != "INFREQUENT_ACCESS" ]; then
  echo "FAIL: Phase 4 changed the class as a side effect (expected INFREQUENT_ACCESS, got '${CLASS_P4}')" >&2
  exit 1
fi

# --- Phase 5: class change on a PROTECTED log group (issue #2579) ---------
echo "==> Phase 5: class change back to STANDARD while protected, no --replace (expect the PROTECTED arm)"
set +e
P5_OUT="$(CDKD_TEST_UPDATE=protect node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
P5_RC=$?
set -e
tail -4 <<<"${P5_OUT}"

if [ "${P5_RC}" -eq 0 ]; then
  echo "FAIL: class change without --replace exited 0 on a protected log group" >&2
  exit 1
fi
if ! grep -q "cannot be changed after creation" <<<"${P5_OUT}"; then
  echo "FAIL: expected the LogGroupClass guard to fire, got rc=${P5_RC} without it" >&2
  exit 1
fi
# The #2579 assertions. Each needle names something ONLY the protected arm can
# say: the unprotected arm's whole remedy is "Re-deploy with --replace
# --force-stateful-recreation ... or revert the LogGroupClass change", which
# mentions neither the property, nor the flag that does not exist, nor the
# out-of-band command. The third needle carries THIS log group's physical name,
# so a `${logicalId}`-for-`${physicalId}` slip — a command naming a resource
# that does not exist — reddens here; phase 6 then EXECUTES the command it
# extracts from this same output.
assert_protected_arm "Phase 5" "${P5_OUT}" "${LG}"

assert_lg_exists "${LG}"
# Single probe, for the same reason as phase 2: the guard refused before any
# write, and both values were polled to a settled state in phase 4.
CLASS_P5="$(lg_class "${LG}")"
PROT_P5="$(lg_protection "${LG}")"
if [ "${CLASS_P5}" != "INFREQUENT_ACCESS" ]; then
  echo "FAIL: AWS class changed despite the guard (expected INFREQUENT_ACCESS, got '${CLASS_P5}')" >&2
  exit 1
fi
# The guard fires BEFORE any other mutation in applyUpdate(), so the deploy must
# not have got as far as the DeletionProtectionEnabled write either.
if [ "${PROT_P5}" != "True" ]; then
  echo "FAIL: deletion protection changed despite the guard (expected True, got '${PROT_P5}')" >&2
  exit 1
fi
echo "    protected arm fired, named the property, the missing flag and the disable command; AWS unchanged"

# --- Phase 6: the remedy the protected arm hands the reader ---------------
# Not "a disable command with the same effect" — THE command phase 5 just
# asserted, lifted out of that output and executed. Re-stating the flags in a
# helper would still pass after a future edit that moved the message and its
# needle together but left the helper on the old flags, and ruling that out is
# the whole point of this phase: what the message PRINTS has to be what WORKS.
#
# Extracted and re-executed, never `eval`ed — a fixture must not hand program
# output to the shell. The message prints exactly one shell-quoted argument (the
# log group name), and CloudWatch Logs names cannot contain whitespace, so
# stripping the quotes and word-splitting under `set -f` is a TOTAL parse rather
# than a shell evaluation; the resulting argv is then checked element by element
# before anything runs.
echo "==> Phase 6: run the disable command the refusal printed, then --replace --force-stateful-recreation"
# `sed -n 1p`, never `| head -1`: head exits on its first line, grep takes
# SIGPIPE, and under `pipefail` the substitution would abort the run.
ADVISED_CMD="$(grep -o "aws logs put-log-group-deletion-protection [^\`]*" <<<"${P5_OUT}" | sed -n '1p' || true)"
if [ -z "${ADVISED_CMD}" ]; then
  echo "FAIL: could not extract the advised disable command from the refusal (#2579)" >&2
  tail -20 <<<"${P5_OUT}" >&2
  exit 1
fi
echo "    advised: ${ADVISED_CMD}"
set -f
# `set -f` is load-bearing: without it a name carrying a glob character would be
# expanded against the working directory during the split.
ADVISED_ARGV=( ${ADVISED_CMD//\'/} )
set +f
if [ "${#ADVISED_ARGV[@]}" -ne 6 ] ||
  [ "${ADVISED_ARGV[0]}" != "aws" ] ||
  [ "${ADVISED_ARGV[1]}" != "logs" ] ||
  [ "${ADVISED_ARGV[2]}" != "put-log-group-deletion-protection" ] ||
  [ "${ADVISED_ARGV[3]}" != "--log-group-identifier" ] ||
  [ "${ADVISED_ARGV[4]}" != "${LG}" ] ||
  [ "${ADVISED_ARGV[5]}" != "--no-deletion-protection-enabled" ]; then
  echo "FAIL: the advised command is not the expected shape (${#ADVISED_ARGV[@]} words): ${ADVISED_CMD}" >&2
  exit 1
fi
# `--region` is the only thing the fixture adds: the message names no region
# (the reader's CLI has one configured) and an integ must not depend on ambient
# config.
if ! "${ADVISED_ARGV[@]}" --region "${REGION}"; then
  echo "FAIL: the disable command the refusal advises failed against real AWS (#2579)" >&2
  exit 1
fi
# Polled: this read follows the disable write.
PROT_P6_PRE="$(poll_value False lg_protection "${LG}")"
if [ "${PROT_P6_PRE}" != "False" ]; then
  echo "FAIL: protection still '${PROT_P6_PRE}' after the advised disable command" >&2
  exit 1
fi

CDKD_TEST_UPDATE=protect node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --replace --force-stateful-recreation

assert_lg_exists "${LG}"
# Polled: both follow the replacement's DELETE + CREATE onto the same name, so a
# stale read answers with the OLD group and false-FAILs the remedy.
CLASS_P6="$(poll_value STANDARD lg_class "${LG}")"
PROT_P6="$(poll_value True lg_protection "${LG}")"
echo "    AWS class=${CLASS_P6} deletionProtection=${PROT_P6} (Phase 6)"
if [ "${CLASS_P6}" != "STANDARD" ]; then
  echo "FAIL: the advised remedy did not complete — expected STANDARD after the replacement, got '${CLASS_P6}'" >&2
  exit 1
fi
# create() re-applies the flag from the DESIRED bag, which is why the refusal
# refuses to promise what the flag ends up as and sends the reader to
# docs/cli-deploy-safety.md instead. Pinned so that claim stays true.
if [ "${PROT_P6}" != "True" ]; then
  echo "FAIL: expected the recreated log group to carry the template's DeletionProtectionEnabled, got '${PROT_P6}'" >&2
  exit 1
fi
echo "    remedy completed: class changed, and the replacement re-applied the template's protection"

# --- Phase 7: destroy ------------------------------------------------------
# `--remove-protection` is what a protected log group needs: the flip-off lives
# in LogsLogGroupProvider.delete() behind DeleteContext.removeProtection, and
# only the destroy paths set it. A plain destroy here would be refused by AWS.
echo "==> Phase 7: destroy --remove-protection"
CDKD_TEST_UPDATE=protect node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --remove-protection --force

# Polled: DeleteLogGroup returns before DescribeLogGroups stops listing the
# group, so a single probe here false-FAILs a destroy that worked.
assert_lg_gone "${LG}"
echo "    log group deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — LogGroupClass guard: unprotected arm (actionable failure without --replace, recreate with --replace) and protected arm (#2579: names the property, the missing flag and the working out-of-band remedy), all 7 phases passed"
