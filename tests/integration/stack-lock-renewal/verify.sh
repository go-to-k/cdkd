#!/usr/bin/env bash
#
# Real-AWS validation for stack-lock renewal and conditional release
# (issue #2168).
#
# Before this change the stack lock had a fixed 30-minute TTL and no renewal
# anywhere, so an operation that ran longer than the TTL silently stopped being
# mutually exclusive -- and then, because `releaseLock` was an owner-blind
# unconditional DELETE, deleted the REPLACEMENT owner's lock on its way out,
# freeing the stack for a third process.
#
# Two arms, because they prove different halves and neither substitutes for the
# other:
#
#   A. `lock-probe.mjs` drives cdkd's own LockManager against the real,
#      VERSIONED state bucket with a 12-second TTL. That is what settles the
#      S3-side premises the unit suite has to mock away: that a PutObject ETag
#      is accepted verbatim as an `If-Match`, and that `If-Match` on
#      DeleteObject is evaluated against the current version of a versioned
#      object. It also reproduces the cascade itself.
#
#   B. A real `cdkd deploy` whose custom resource sleeps past the 120s renewal
#      cap, with the lock polled throughout. That is what settles the CLI-side
#      premises no probe can: that the CLI's own LockManager renews during a
#      deploy, that the heartbeat interval is unref'd so the process still
#      EXITS (a missing `unref()` would hang every cdkd command forever, and
#      nothing in the unit suite can observe process exit), and that the lock
#      is gone afterwards.
#
# BSD/macOS-portable: no grep -P, no date -d.
set -euo pipefail

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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdStackLockRenewalExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/stack-lock-renewal"
CLI="node ${REPO_ROOT}/dist/cli.js"

: "${STATE_BUCKET:?STATE_BUCKET must be set (the real cdkd state bucket)}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"

# The renewal cap in src/state/lock-manager.ts. The deploy has to outlive it
# for arm B to observe anything, and the sleep below is what guarantees that.
RENEWAL_CAP_SECONDS=120
SLEEP_SECONDS="${CDKD_LOCK_RENEWAL_SLEEP_SECONDS:-150}"
export CDKD_LOCK_RENEWAL_SLEEP_SECONDS="${SLEEP_SECONDS}"
if [ "${SLEEP_SECONDS}" -le "${RENEWAL_CAP_SECONDS}" ]; then
  echo "[verify] FAIL: sleep ${SLEEP_SECONDS}s does not outlive the ${RENEWAL_CAP_SECONDS}s renewal cap;" \
       "arm B would assert on a deploy that legitimately never renews" >&2
  exit 1
fi

cd "${TEST_DIR}"
. ../s3-versions.sh
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} sleep=${SLEEP_SECONDS}s"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

POLL_PID=""

# Deliberately does NOT exit: the EXIT trap preserves the original status on
# its own, and an exiting cleanup would swallow the success-path version sweep
# below -- the "trap-only sweep" failure the testing rules call out.
cleanup() {
  rc=$?
  set +eu
  if [ -n "${POLL_PID}" ]; then
    kill "${POLL_PID}" 2>/dev/null
    wait "${POLL_PID}" 2>/dev/null
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) - attempting cleanup"
    # The lock is removed FIRST: a probe arm that failed mid-way may have left
    # one behind, and destroy would then sit through the whole retry ladder
    # before giving up on a lock nothing is holding.
    ${CLI} force-unlock "${STACK}" --state-bucket "${STATE_BUCKET:-}" --stack-region "${REGION}" --yes
    if aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --force
    fi
    ${CLI} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
  fi
  # Lambda auto-creates a log group per function and nothing in the template
  # owns it, so neither cdkd nor CloudFormation deletes it on destroy. Left
  # alone it survives every run with the default never-expire retention. Not
  # gated on rc: the success path calls this function too, and that is the
  # path that leaks.
  for lg in $(aws logs describe-log-groups --region "${REGION}" \
    --log-group-name-prefix "/aws/lambda/${STACK}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --region "${REGION}" --log-group-name "${lg}" >/dev/null 2>&1
  done

  # Renewal writes a new object VERSION every two minutes, so this fixture
  # produces more lock.json versions than any other. NONCURRENT-only here:
  # this also runs from the failure traps, where a live state.json may be the
  # only record of resources still standing.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# --- Arm A: LockManager semantics against real, versioned S3 ---------------
echo "[verify] step 2 (arm A): lock semantics probe against real S3"
PROBE_OUT="$(node "${TEST_DIR}/lock-probe.mjs" "${STATE_BUCKET}" "${REGION}" "${STACK}" 2>&1)" || {
  echo "${PROBE_OUT}"
  echo "[verify] FAIL: lock semantics probe failed" >&2
  exit 1
}
echo "${PROBE_OUT}"
# The probe prints one receipt per assertion. Requiring the COUNT is what stops
# a probe that exited 0 without running (a bad import path, an early return)
# from reading as a pass.
PROBE_PASSES="$(printf '%s\n' "${PROBE_OUT}" | grep -c '^\[probe\] PASS ' || true)"
if [ "${PROBE_PASSES}" -ne 8 ]; then
  echo "[verify] FAIL: expected 8 probe receipts, saw ${PROBE_PASSES}" >&2
  exit 1
fi
echo "[verify] step 2 ok (${PROBE_PASSES} receipts)"

# --- Arm B: renewal during a real cdkd deploy ------------------------------
echo "[verify] step 3 (arm B): deploy that outlives the ${RENEWAL_CAP_SECONDS}s renewal cap"

SAMPLES="$(mktemp)"
LOCK_BODY="$(mktemp)"
poll_lock() {
  while :; do
    # An unreadable lock is RECORDED as `absent`, not skipped. Skipping makes
    # the analyzer blind to the one failure this arm exists to catch: a lock
    # that vanishes mid-deploy simply stops producing samples, and every
    # surviving row still satisfies "not expired" and "advanced".
    # Three outcomes, not two. A blind `else -> absent` reports a THROTTLE as a
    # missing lock, failing the run with a message that accuses the fix; and
    # skipping the sample instead is the original blindness. So: a confirmed
    # not-found is `absent` (a real gap), anything else undetermined is
    # `unknown` and is neither counted nor held against the run.
    if out="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}" "${LOCK_BODY}" 2>&1)"; then
      printf '%s %s\n' "$(date -u +%s)" \
        "$(node -e 'const fs=require("fs");try{process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expiresAt))}catch{process.stdout.write("unparsable")}' "${LOCK_BODY}")" \
        >> "${SAMPLES}"
    elif printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
      printf '%s absent\n' "$(date -u +%s)" >> "${SAMPLES}"
    else
      printf '%s unknown\n' "$(date -u +%s)" >> "${SAMPLES}"
    fi
    sleep 15
  done
}
poll_lock &
POLL_PID=$!

${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

kill "${POLL_PID}" 2>/dev/null || true
wait "${POLL_PID}" 2>/dev/null || true
POLL_PID=""

echo "[verify] lock samples taken during the deploy:"
cat "${SAMPLES}"

SAMPLE_COUNT="$(grep -c . "${SAMPLES}" || true)"
if [ "${SAMPLE_COUNT}" -lt 2 ]; then
  echo "[verify] FAIL: only ${SAMPLE_COUNT} lock sample(s); the deploy did not hold the lock long enough" \
       "for this arm to assert anything" >&2
  exit 1
fi

SAMPLES_FILE="${SAMPLES}" node -e '
  const fs = require("fs");
  const fail = (m) => { console.error(`[verify] FAIL: ${m}`); process.exit(1); };
  // `unknown` (an undetermined probe -- throttle, transport) is dropped: it is
  // evidence of nothing. `absent` AND `unparsable` are both gaps -- filtering
  // the unparsable ones out, as an earlier cut did, restores exactly the
  // blindness this analyzer exists to remove, since a lock whose body stops
  // parsing mid-deploy is at least as alarming as one that vanishes.
  const all = fs.readFileSync(process.env.SAMPLES_FILE, "utf8")
    .split("\n").filter(Boolean)
    .map((l) => l.split(" "))
    .filter(([, e]) => e !== "unknown")
    .map(([t, e]) => ({
      atMs: Number(t) * 1000,
      expiresAt: e === "absent" || e === "unparsable" ? null : Number(e),
      why: e,
    }));
  // A gap is legitimate only BEFORE the deploy acquires the lock and AFTER it
  // releases. One in between means the lock disappeared while the operation
  // was still running -- which is the whole defect.
  const first = all.findIndex((r) => r.expiresAt !== null);
  const last = all.length - 1 - [...all].reverse().findIndex((r) => r.expiresAt !== null);
  if (first < 0) fail("the lock was never observed at all during the deploy");
  const gaps = all.slice(first, last + 1).filter((r) => r.expiresAt === null);
  if (gaps.length > 0) {
    fail(`the lock was ${gaps.map((g) => g.why).join("/")} at ${gaps.length} sample(s) while the deploy was still holding it`);
  }
  const rows = all.slice(first, last + 1);
  if (rows.length < 2) fail(`only ${rows.length} parsable lock sample(s)`);
  // 1. The lock never lapsed while the deploy was running. This is the
  //    property the whole issue is about, and it is checked at every sample
  //    rather than once at the end: a single end-of-run check passes even if
  //    the lock lapsed in the middle and was re-taken.
  for (const r of rows) {
    if (!(r.expiresAt > r.atMs)) {
      fail(`lock had already expired at sample ${new Date(r.atMs).toISOString()} while the deploy ran`);
    }
  }
  // 2. It actually got RENEWED. Without this the arm passes vacuously on any
  //    deploy shorter than the TTL, which is every deploy -- the TTL is 30
  //    minutes and this one is ~3.
  const firstExp = rows[0].expiresAt;
  const lastExp = rows[rows.length - 1].expiresAt;
  if (!(lastExp > firstExp)) {
    fail(`expiresAt never advanced across ${rows.length} samples (${firstExp} -> ${lastExp}): the CLI did not renew`);
  }
  console.log(`[verify] arm B ok: ${rows.length} samples, expiresAt advanced by ${Math.round((lastExp - firstExp) / 1000)}s, never lapsed, never absent`);
' || exit 1

rm -f "${SAMPLES}" "${LOCK_BODY}"

echo "[verify] step 4: the lock is released once the deploy finishes"
assert_gone "lock.json still present after a successful deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"

echo "[verify] step 5: cdkd destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 6: teardown is clean"
assert_gone "state.json remains after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "lock.json remains after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"

LEFTOVER_FUNCS="$(aws lambda list-functions --region "${REGION}" \
  --query "join(' ', sort(Functions[?contains(FunctionName, \`${STACK}\`)].FunctionName))" --output text)"
if [ -n "${LEFTOVER_FUNCS}" ] && [ "${LEFTOVER_FUNCS}" != "None" ]; then
  echo "[verify] FAIL: Lambda functions survived destroy: ${LEFTOVER_FUNCS}" >&2
  exit 1
fi

LEFTOVER_ROLES="$(aws iam list-roles \
  --query "join(' ', sort(Roles[?contains(RoleName, \`${STACK}\`)].RoleName))" --output text)"
if [ -n "${LEFTOVER_ROLES}" ] && [ "${LEFTOVER_ROLES}" != "None" ]; then
  echo "[verify] FAIL: IAM roles survived destroy: ${LEFTOVER_ROLES}" >&2
  exit 1
fi

cleanup

# Asserted AFTER cleanup, because the log groups are cleanup's job rather than
# destroy's. Without this the sweep could quietly stop matching and the leak
# would be invisible for exactly as long as nobody listed the account.
LEFTOVER_LOGS="$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "/aws/lambda/${STACK}" \
  --query "join(' ', sort(logGroups[].logGroupName))" --output text)"
if [ -n "${LEFTOVER_LOGS}" ] && [ "${LEFTOVER_LOGS}" != "None" ]; then
  echo "[verify] FAIL: log groups survived cleanup: ${LEFTOVER_LOGS}" >&2
  exit 1
fi

trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "stack-lock-renewal state teardown"

echo "[verify] PASS"
