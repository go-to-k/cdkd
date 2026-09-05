#!/usr/bin/env bash
# verify.sh — cdkd never-expire log-group stateful-guard integ (issue #2558).
#
# The defect: the stateful guard read `RetentionInDays` unset-or-zero as "this
# log group holds nothing". In CloudWatch Logs that is NEVER EXPIRE — the most
# data-bearing configuration the type has — so renaming such a log group in the
# template took the property-driven replacement path on a PLAIN `cdkd deploy`
# and destroyed every event in it with no flag, no prompt and no warning.
#
# Both polarities are exercised against real AWS, at both guard timings:
#
#   1. Deploy two never-expiring log groups. Assert AWS reports NO retention on
#      both (the fixture must contain the feature under test — with a retention
#      the run would exercise the `has-retention` branch and pass vacuously).
#   2. Seed one log stream + one event into the DATA group; assert the EMPTY
#      group still has zero streams. These are the two probe inputs.
#   3. PRE-FLIGHT, positive: `--recreate-via-cc-api DataLg` with NO consent flag
#      is REFUSED — the live `logs:DescribeLogStreams` probe finds a stream.
#      Assert the group and its stream survive.
#   3b. PRE-FLIGHT, consented: the same target WITH
#      `--force-stateful-recreation` reaches the per-target recreate plan, and
#      that plan must carry the **DATA LOSS** prefix + data line. The consent
#      flag is also what SKIPS the emptiness probe, so the plan is working from
#      the sync verdict alone — `null` for a never-expiring log group — and
#      reading that as "not stateful" dropped the warning from the one screen a
#      user reads before consenting.
#   4. PRE-FLIGHT, negative: `--recreate-via-cc-api EmptyLg` with NO consent
#      flag is ALLOWED THROUGH — zero streams proves the group empty, so the
#      condition stays conditional and a disposable log group is still
#      recreatable. That allow-arm is the whole reason the log group's guard is
#      CONDITIONAL rather than unconditional, so it is the assertion this phase
#      exists for: without it the fixture could not tell this fix from a
#      blanket refuse-everything.
#
#      Every PRE-FLIGHT phase — 3, 3b and 4 — runs `--dry-run`, matching what
#      the sibling fixture does for its own pre-flight-only pair
#      (`recreate-via-cc-api/verify.sh`, "Sub-3a" / "Sub-3c"). Phases 5-7 do
#      NOT: they are the mid-deploy half and have to reach the engine.
#      Two reasons for the pre-flight phases, and the first is why an earlier
#      revision of phase 4 could never pass. (a) The pre-flight is the ONLY
#      thing under test here, and it runs to completion before the engine
#      starts — a refusal throws out of it, and an allow reaches the target
#      plan. (b) Without `--dry-run` phase 4 asserted the recreate had actually
#      happened (`provisionedBy == cc-api`), which is unreachable on an
#      UNCHANGED template: phase 4 runs `env -u CDKD_TEST_UPDATE`, so its
#      template is byte-identical to phase 1's, the diff is `NO_CHANGE`, and
#      the deploy engine reads `recreateViaCcApiTargets` only inside its
#      `case 'UPDATE'`. Proving the recreate EXECUTES is the sibling fixture's
#      job; proving the guard is conditional is this one's.
#   5. MID-DEPLOY, the headline case: rename the DATA group on a plain
#      `cdkd deploy` with no flags at all. Expect a refusal, and assert the
#      original group AND its stream are still there.
#   6. Consent path: the same rename with `--force-stateful-recreation`
#      replaces the group.
#   7. Destroy; assert both groups are gone and the cdkd state is removed.
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
# match, `printf` fills the pipe and takes SIGPIPE, and the pipeline reports
# 141 — so a NEGATIVE check (`if grep -q <bad thing>; then FAIL`) reads "not
# found" precisely when the bad thing WAS found.
#
# MEASURED 2026-09-05 on this repo's dev host (bash 5.3, macOS), needle on line 1, five
# attempts per size: 3 KB and 31 KB → 0/5 non-zero; 155 KB, 310 KB, 620 KB and
# 1.5 MB → 5/5 non-zero. So the failure needs a capture somewhere between
# ~32 KB and ~155 KB, which THIS fixture's dry-run logs are well under today —
# the change is defence in depth, not a repair of an observed failure here, and
# the honest reading is that a verbose run or a fixture with more resources
# reaches the range while a quiet one does not. The herestring has no pipeline,
# so it does not depend on which side of that range a log lands.
#
# The ONE exception is `gone_probe` below, which keeps the pipeline form: it is
# the canonical helper block every affected fixture carries VERBATIM, fenced by
# `tests/unit/scripts/integ-verify-probe-not-found.test.ts`, so this fixture may
# not fork it. Its input is a single AWS error message, orders of magnitude
# under the range above.

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

STACK="CdkdLoggroupNeverExpireGuardExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Every log group this fixture creates lives under one prefix, so cleanup can
# sweep by prefix rather than by the names of the phase it happened to reach --
# the renamed group in phase 6 has a name no earlier phase knows.
LG_PREFIX="/cdkd-integ/never-expire-guard/"
DATA_LG="${LG_PREFIX}data"
DATA_LG_RENAMED="${LG_PREFIX}data-renamed"
EMPTY_LG="${LG_PREFIX}empty"
SEED_STREAM="cdkd-integ-seed"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Names under the fixture's prefix, one per line. Counted by ROWS of a
# projection, never `--query 'length(...)'`: --query is applied PER PAGE, so a
# multi-page listing prints one number per page.
lg_names_under_prefix() {
  aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text || return 1
}

sweep_log_groups() { # best-effort teardown; never aborts the sweep
  # The relaxation lives on its OWN line inside the subshell: that is the shape
  # `scripts/check-integ-probe-not-found.ts` recognises as a best-effort span,
  # and the subshell keeps it from re-arming strict mode in a caller that is
  # already running under `set +eu` (the cleanup trap).
  (
    set +eu
    local names name
    names="$(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}" \
      --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null)"
    for name in ${names}; do
      aws logs delete-log-group --log-group-name "${name}" --region "${REGION}" >/dev/null 2>&1
    done
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # The prefix sweep runs UNCONDITIONALLY: a refusal phase leaves the log
  # groups live by design, and a run interrupted there has state pointing at
  # them, so `state destroy` above normally takes them. This is the backstop
  # for the case where it could not.
  sweep_log_groups
  set -eu
}

trap cleanup EXIT
# `(exit N); cleanup; exit N` is the repo-wide shape that
# `scripts/check-integ-signal-traps.ts` enforces: the seed is what a `rc=$?`
# teardown reads, and the handler must EXIT rather than resume the interrupted
# phase (#1097 pattern 1). The `exit` re-fires the EXIT trap, so `cleanup` runs
# a SECOND time — and that is DELIBERATE, not an oversight.
#
# A `_teardown_done` sentinel closing the duplicate was tried and reverted: it
# trades an idempotent repeat for a LEAK. `cleanup` runs under `set +eu` with
# every AWS call soft-failed, so a second signal that kills an
# `aws delete-log-group` mid-`sweep_log_groups` still lets `cleanup` RETURN
# NORMALLY — the sentinel would then be set and the EXIT trap's re-run, which
# is the retry that would have swept the surviving log group, skipped. The
# duplicate costs one extra `state destroy` no-op and one extra prefix sweep;
# the sentinel costs a live, billing log group. Idempotence is what makes the
# repeat safe, and every step here has it.
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

assert_lg_exists() { # $1 = exact log group name
  # The `--query` argument is DOUBLE-quoted, so the JMESPath string literal
  # takes bare single quotes around `$1`; see `lg_retention`'s note below for
  # the escape idiom that belongs to single-quoted strings and silently breaks
  # this one.
  #
  # An EXACT-name row count, not a prefix probe: `--log-group-name-prefix` also
  # matches `<name>-renamed`, and a retention read answers EMPTY both for an
  # existing never-expire group and for a group that does not exist — so a
  # retention read alone cannot tell "exists, never expires" from "gone".
  # Every caller below asserts existence FIRST for that reason. Row-projection
  # form, so the per-page `--query` application cannot inflate the count.
  local rows
  # `|| return 1`, and EVERY call site is a bare statement or a plain
  # assignment — never a `$( )` inside `[ ... ]`. Measured on bash 5: a
  # failing function inside a test expands to an empty string, `[` exits 2,
  # `if` reads that as false, and the FAIL branch is SKIPPED. `exit 1` in the
  # function does not help either: it exits the SUBSHELL the substitution runs
  # in, which the test then swallows the same way.
  rows="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'].logGroupName" --output text)" || return 1
  if [ "$(printf '%s' "${rows}" | wc -w | tr -d '[:space:]')" != "1" ]; then
    echo "FAIL: expected exactly one log group named $1, found rows: '${rows}'" >&2
    exit 1
  fi
}

lg_retention() { # prints the live retention, or NONE for never-expire
  # Call assert_lg_exists FIRST — an empty answer here means "no retention set"
  # for an existing group and "no such group" for a missing one, and only the
  # existence assertion separates them.
  #
  # A row PROJECTION over the exact-name filter, never `| [0].retentionInDays`:
  # `--query` is applied PER PAGE, so the `[0]` pipe would print one `None` per
  # page that does not contain the group. The projection prints matching rows
  # only — and JMESPath drops a null out of a projection, which is why an
  # existing never-expire group prints nothing at all.
  #
  # The filter's quoting is load-bearing and was got WRONG once: the whole
  # `--query` argument is DOUBLE-quoted, so the JMESPath string literal needs
  # bare single quotes around `$1`. The `'"'"'` idiom escapes a single quote
  # inside a SINGLE-quoted string; used here it emitted
  # `logGroupName=='"…"'` — a raw-string literal containing the double-quote
  # characters — which matches no log group. For THIS read that made every
  # retention assertion vacuous (`NONE` unconditionally, including for a group
  # with a retention); for `assert_lg_exists` above it was loud instead (zero
  # rows, so the run died in phase 1). Both forms were driven through a fake
  # `aws` that echoes its argv, and the argv evaluated against a real JMESPath
  # implementation.
  local out
  out="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'].retentionInDays" --output text)" || return 1
  out="$(printf '%s' "${out}" | tr -d '[:space:]')"
  if [ -z "${out}" ]; then echo "NONE"; else echo "${out}"; fi
}

lg_stream_count() { # rows of a projection, not `length(...)` (see above)
  # A probe failure here must STOP THE RUN, never read as a count: AWS answers
  # `ResourceNotFoundException` when the log group does not exist, which is
  # exactly the destroy phase 5 asserts against. That propagation comes from
  # the CALL SITES — each one captures into a variable first, so `set -e` sees
  # the non-zero status — because a substitution inside `[ ... ]` swallows it.
  local out
  out="$(aws logs describe-log-streams --log-group-name "$1" --region "${REGION}" \
    --query 'logStreams[].logStreamName' --output text)" || return 1
  # `wc -w` rather than a match count: a stream name carries no whitespace, and
  # an empty listing must count as 0 without the non-zero exit a no-match count
  # returns (which a swallow tail would then have to hide).
  printf '%s' "${out}" | wc -w | tr -d '[:space:]'
}

# The CFn logical id is NOT the construct id: CDK appends a path hash
# (`DataLg` -> `DataLg69F49812`), and `--recreate-via-cc-api` takes the
# TEMPLATE's logical id. Resolving it from the state record by the log group's
# AWS NAME keeps the flag correct if a future CDK version rehashes the path.
state_logical_id_for() { # $1 = log group name
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c '
import json, sys
state = json.load(sys.stdin)
name = sys.argv[1]
for logical_id, record in state["resources"].items():
    if (record.get("resourceType") == "AWS::Logs::LogGroup"
            and record.get("properties", {}).get("LogGroupName") == name):
        print(logical_id)
        break
else:
    sys.exit("no AWS::Logs::LogGroup state record named " + name)
' "$1"
}

# The refusal phases grep cdkd's OWN output, so a reword upstream would turn
# every assertion into a silent zero match. The sentinel distinguishes "the
# guard did not fire" from "the wording moved": if the refusal names the log
# group's TYPE but not the reason phrase, that is drift, and it is reported as
# drift rather than as a regression.
assert_stateful_refusal() { # $1 = phase label, $2 = output
  local label="$1" out="$2"
  if ! grep -q "log group is not provably empty" <<<"${out}"; then
    if grep -q "AWS::Logs::LogGroup" <<<"${out}"; then
      echo "FAIL: ${label}: the refusal names AWS::Logs::LogGroup but not the reason — renderStatefulReason('has-log-events') wording drifted; update this fixture with the source" >&2
    else
      echo "FAIL: ${label}: expected the stateful-guard refusal, got no reason phrase at all" >&2
    fi
    printf '%s\n' "${out}" | tail -20 >&2
    exit 1
  fi
  if ! grep -q -- "--force-stateful-recreation" <<<"${out}"; then
    echo "FAIL: ${label}: the refusal did not name --force-stateful-recreation as the remedy" >&2
    exit 1
  fi
}

# --- Phase 1: deploy two never-expiring log groups -------------------------
echo "==> Phase 1: deploy two log groups with NO retention policy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

for lg in "${DATA_LG}" "${EMPTY_LG}"; do
  assert_lg_exists "${lg}"
  RET="$(lg_retention "${lg}")"
  if [ "${RET}" != "NONE" ]; then
    echo "FAIL: ${lg} reports retention '${RET}' — this fixture must deploy NEVER-EXPIRE log groups, or every phase below tests the has-retention branch instead" >&2
    exit 1
  fi
done
echo "    both log groups live with no retention policy (never expire)"

# --- Phase 2: seed the data group; leave the other empty -------------------
echo "==> Phase 2: seed one log stream + one event into ${DATA_LG}"
aws logs create-log-stream --log-group-name "${DATA_LG}" --log-stream-name "${SEED_STREAM}" \
  --region "${REGION}"
aws logs put-log-events --log-group-name "${DATA_LG}" --log-stream-name "${SEED_STREAM}" \
  --log-events "timestamp=$(($(date +%s) * 1000)),message=cdkd-integ-never-expire-guard-seed" \
  --region "${REGION}" >/dev/null

DATA_STREAMS="$(lg_stream_count "${DATA_LG}")"
EMPTY_STREAMS="$(lg_stream_count "${EMPTY_LG}")"
echo "    streams: data=${DATA_STREAMS} empty=${EMPTY_STREAMS}"
if [ "${DATA_STREAMS}" -lt 1 ]; then
  echo "FAIL: the seeded log group reports ${DATA_STREAMS} streams — the probe's positive input is missing" >&2
  exit 1
fi
if [ "${EMPTY_STREAMS}" -ne 0 ]; then
  echo "FAIL: the empty log group already has ${EMPTY_STREAMS} streams — the probe's negative input is missing" >&2
  exit 1
fi

# --- Phase 3: pre-flight, POSITIVE polarity (probe finds a stream) ---------
echo "==> Phase 3: --recreate-via-cc-api on the SEEDED group without the consent flag (expect refusal)"
DATA_LOGICAL_ID="$(state_logical_id_for "${DATA_LG}")"
EMPTY_LOGICAL_ID="$(state_logical_id_for "${EMPTY_LG}")"
echo "    logical ids: data=${DATA_LOGICAL_ID} empty=${EMPTY_LOGICAL_ID}"
set +e
P3_OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --dry-run \
  --recreate-via-cc-api "${DATA_LOGICAL_ID}" 2>&1)"
P3_RC=$?
set -e
if [ "${P3_RC}" -eq 0 ]; then
  echo "FAIL: pre-flight recreate of a non-empty never-expiring log group exited 0" >&2
  printf '%s\n' "${P3_OUT}" | tail -20 >&2
  exit 1
fi
assert_stateful_refusal "phase 3" "${P3_OUT}"
# The refusal has TWO arms and only one of them is this phase's subject. A
# missing `logs:DescribeLogStreams` permission, or a throttle, promotes to
# `has-log-events` too (`recreate-targets.ts`) -- so without this check the
# phase passes for the wrong reason on a role that cannot probe at all, and
# the run reports a guard it never exercised.
if grep -qF -- "live CloudWatch Logs probe failed for" <<<"${P3_OUT}" \
  || grep -qF -- "without settling it" <<<"${P3_OUT}"; then
  echo "FAIL: phase 3 refused because the probe could NOT RUN, not because it found a stream — grant logs:DescribeLogStreams (or retry a throttle); this run proves nothing about the guard" >&2
  printf '%s\n' "${P3_OUT}" | tail -20 >&2
  exit 1
fi
DATA_STREAMS_P3="$(lg_stream_count "${DATA_LG}")"
if [ "${DATA_STREAMS_P3}" -lt 1 ]; then
  echo "FAIL: the seeded log group lost its stream despite the refusal" >&2
  exit 1
fi
echo "    pre-flight refused; log group and its stream intact"

# --- Phase 3b: the CONSENTED plan must say what it is about to destroy -----
# Same target as phase 3, now WITH the consent flag, so the pre-flight allows
# it through to the per-target recreate plan. That flag is also what makes
# `probeAndRevalidateStateful` return EARLY, so nothing probes this group and
# the plan is working from the SYNC verdict alone -- `null` for a never-expiring
# log group. Reading that `null` as "not stateful" printed the plan row with no
# **DATA LOSS** prefix and no data line, i.e. the same defect as the guard
# itself, one layer up and on the one screen a user reads before consenting.
#
# `--dry-run` keeps it a pre-flight assertion: the plan is printed, nothing is
# destroyed, and the seeded stream is asserted intact below either way.
echo "==> Phase 3b: the same target WITH --force-stateful-recreation (expect a DATA LOSS plan row)"
# Capture the rc like phases 3/4/5 do. A bare `$(...)` under `set -e` aborts
# the whole run SILENTLY on a non-zero exit -- no FAIL line, no output tail --
# which reads as a crash rather than as this phase failing.
set +e
P3B_OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --dry-run \
  --force-stateful-recreation \
  --recreate-via-cc-api "${DATA_LOGICAL_ID}" 2>&1)"
P3B_RC=$?
set -e
if [ "${P3B_RC}" -ne 0 ]; then
  echo "FAIL: phase 3b: the consented dry-run exited ${P3B_RC}; --force-stateful-recreation should carry it past the guard" >&2
  printf '%s\n' "${P3B_OUT}" | tail -20 >&2
  exit 1
fi
if ! grep -qF -- "**DATA LOSS** ${DATA_LOGICAL_ID} (AWS::Logs::LogGroup)" <<<"${P3B_OUT}"; then
  echo "FAIL: phase 3b: the consented plan did not mark ${DATA_LOGICAL_ID} as DATA LOSS — a never-expiring log group is about to be destroyed with no warning on the plan" >&2
  printf '%s\n' "${P3B_OUT}" | tail -20 >&2
  exit 1
fi
if ! grep -qF -- "DATA: all data in ${DATA_LOGICAL_ID} will be lost" <<<"${P3B_OUT}"; then
  echo "FAIL: phase 3b: the plan carried the DATA LOSS prefix but not the per-target data line" >&2
  printf '%s\n' "${P3B_OUT}" | tail -20 >&2
  exit 1
fi
DATA_STREAMS_P3B="$(lg_stream_count "${DATA_LG}")"
if [ "${DATA_STREAMS_P3B}" -lt 1 ]; then
  echo "FAIL: the seeded log group lost its stream during the dry-run plan" >&2
  exit 1
fi
echo "    consented plan flags DATA LOSS on the never-expiring log group"

# --- Phase 4: pre-flight, NEGATIVE polarity (probe proves it empty) --------
echo "==> Phase 4: --recreate-via-cc-api on the EMPTY group without the consent flag (expect the guard to allow it)"
set +e
P4_OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --dry-run \
  --recreate-via-cc-api "${EMPTY_LOGICAL_ID}" 2>&1)"
P4_RC=$?
set -e
if [ "${P4_RC}" -ne 0 ]; then
  echo "FAIL: the pre-flight refused an EMPTY never-expiring log group — the guard is no longer conditional, it refuses every log group" >&2
  printf '%s\n' "${P4_OUT}" | tail -20 >&2
  exit 1
fi
# Exit 0 alone is weak evidence, so both halves of the allow-arm are asserted.
# NEGATIVE: the refusal phrase phase 3 matched must be absent — the same needle,
# so a reword upstream moves both together and cannot leave this one vacuous
# while phase 3 still passes.
if grep -q "log group is not provably empty" <<<"${P4_OUT}"; then
  echo "FAIL: the pre-flight emitted the stateful refusal for the EMPTY log group" >&2
  printf '%s\n' "${P4_OUT}" | tail -20 >&2
  exit 1
fi
# POSITIVE: the target reached the per-target recreate PLAN, which is printed
# only AFTER `renderRecreateTargetsErrors` found nothing to raise. Without this,
# any early exit that skipped the pre-flight entirely would read as an allow.
#
# Matched on the plan's OWN shape, not on a bare logical-id grep: the diff
# renderer prints `  [+] <id> (<Type>)` for the same id, so a bare grep is
# satisfied by a run that never reached the pre-flight at all — the vacuous
# pass this assertion exists to remove. Two needles: the plan HEADER, which the
# diff has no counterpart for, and the plan ROW's `- <id> (<Type>)` shape,
# whose leading `- ` is what separates it from the diff's `] ` forms. Both
# ASCII, deliberately — the row also carries a `[SDK → CC]` tag, and anchoring
# on a non-ASCII arrow would add a locale-dependent way to fail.
if ! grep -q "will destroy + recreate" <<<"${P4_OUT}"; then
  echo "FAIL: the pre-flight never printed the recreate plan header — it did not reach the allow path" >&2
  printf '%s\n' "${P4_OUT}" | tail -20 >&2
  exit 1
fi
if ! grep -qF -- "- ${EMPTY_LOGICAL_ID} (AWS::Logs::LogGroup)" <<<"${P4_OUT}"; then
  echo "FAIL: the recreate plan never named ${EMPTY_LOGICAL_ID} as a log group — the pre-flight did not reach the allow path" >&2
  printf '%s\n' "${P4_OUT}" | tail -20 >&2
  exit 1
fi
# The plan's data-loss line is the prompt-side half of the same verdict: the
# probe PROVED this group empty, so the row must carry no **DATA LOSS** prefix
# and no DATA caveat. A prompt that warned here would be over-warning on the
# one path that actually measured.
if grep -q "DATA LOSS" <<<"${P4_OUT}"; then
  echo "FAIL: the recreate plan flagged DATA LOSS for a log group the probe proved empty" >&2
  printf '%s\n' "${P4_OUT}" | tail -20 >&2
  exit 1
fi
assert_lg_exists "${EMPTY_LG}"
EMPTY_RET_P4="$(lg_retention "${EMPTY_LG}")"
if [ "${EMPTY_RET_P4}" != "NONE" ]; then
  echo "FAIL: the empty log group is no longer never-expire after the dry-run pre-flight" >&2
  exit 1
fi
# The probe's input must still be what phase 2 established. A group that
# acquired a stream between phases would make the allow-arm above prove the
# opposite of what it claims.
EMPTY_STREAMS_P4="$(lg_stream_count "${EMPTY_LG}")"
if [ "${EMPTY_STREAMS_P4}" -ne 0 ]; then
  echo "FAIL: the empty log group has ${EMPTY_STREAMS_P4} streams at phase 4 — the allow-arm was decided on the wrong input" >&2
  exit 1
fi
echo "    empty never-expiring log group ALLOWED through the pre-flight with NO consent flag — the condition is still conditional"

# --- Phase 5: mid-deploy, the headline case (plain deploy, no flags) -------
echo "==> Phase 5: rename the seeded log group on a PLAIN deploy (expect refusal, data intact)"
set +e
P5_OUT="$(CDKD_TEST_UPDATE=rename node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
P5_RC=$?
set -e
if [ "${P5_RC}" -eq 0 ]; then
  echo "FAIL: a plain deploy replaced a never-expiring log group and exited 0 — issue #2558 regressed" >&2
  printf '%s\n' "${P5_OUT}" | tail -20 >&2
  exit 1
fi
assert_stateful_refusal "phase 5" "${P5_OUT}"
if ! grep -q "requires replacement" <<<"${P5_OUT}"; then
  echo "FAIL: phase 5: expected the property-driven replacement refusal, not another failure" >&2
  printf '%s\n' "${P5_OUT}" | tail -20 >&2
  exit 1
fi
# The load-bearing assertion of the whole fixture: the data is still there.
# Captured, not inlined into the test: a `$( )` inside `[ ... ]` swallows the
# probe's failure, and a probe failure HERE means the log group is gone — the
# very outcome this assertion exists to catch.
DATA_STREAMS_P5="$(lg_stream_count "${DATA_LG}")"
if [ "${DATA_STREAMS_P5}" -lt 1 ]; then
  echo "FAIL: the never-expiring log group was destroyed by a plain deploy — the defect this fixture exists for" >&2
  exit 1
fi
assert_gone "renamed log group ${DATA_LG_RENAMED} exists although the deploy was refused" \
  aws logs describe-log-streams --log-group-name "${DATA_LG_RENAMED}" --region "${REGION}"
echo "    plain deploy refused; original log group and its events intact"

# --- Phase 6: the consent path replaces it ---------------------------------
echo "==> Phase 6: same rename with --force-stateful-recreation (expect replacement)"
CDKD_TEST_UPDATE=rename node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --force-stateful-recreation

assert_lg_exists "${DATA_LG_RENAMED}"
RENAMED_RET="$(lg_retention "${DATA_LG_RENAMED}")"
if [ "${RENAMED_RET}" != "NONE" ]; then
  echo "FAIL: expected the renamed log group to carry no retention after the consented replacement" >&2
  exit 1
fi
assert_gone "old log group ${DATA_LG} survived the consented replacement" \
  aws logs describe-log-streams --log-group-name "${DATA_LG}" --region "${REGION}"
echo "    consented replacement performed: old group deleted, renamed group created"

# --- Phase 7: destroy ------------------------------------------------------
echo "==> Phase 7: destroy"
CDKD_TEST_UPDATE=rename node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

REMAINING="$(lg_names_under_prefix)"
if [ -n "${REMAINING}" ]; then
  echo "FAIL: log groups still exist under ${LG_PREFIX} after destroy: ${REMAINING}" >&2
  exit 1
fi
echo "    both log groups deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — never-expire log-group guard (issue #2558): pre-flight probe both polarities, plain-deploy refusal with data intact, consented replacement, all 7 phases passed"
