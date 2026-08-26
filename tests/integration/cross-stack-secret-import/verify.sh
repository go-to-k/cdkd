#!/usr/bin/env bash
# verify.sh — cross-stack import of a REDACTED secret-bearing export
# (issues #1934, #2133 and #2146).
#
# THE DEFECT (#1934). Since PR #1899 a secret-bearing output is persisted REDACTED:
# `state.outputs` and the exports index hold the unresolved
# `{{resolve:secretsmanager:...}}` expression rather than the plaintext. A
# cross-stack CONSUMER resolving `Fn::ImportValue` got that stored value back
# VERBATIM and shipped the LITERAL TOKEN to AWS as the property value — a
# predictable credential reference landing in a password field, not merely a
# broken value. The fix re-resolves the imported value, in the PRODUCER's
# region, before returning it.
#
# THE SECOND DEFECT (#2133), which shares this fixture because it needs exactly
# the same two stacks. `cdkd scrub` removes secret plaintext from persisted
# state, and it learns WHICH plaintexts to hunt for by re-resolving the template
# and recording each resolved secret as a NEEDLE. Every resolve context
# `scrubStack` built omitted `stateBackend`, which `resolveImportValue` requires,
# so a secret arriving through `Fn::ImportValue` threw for want of a dependency,
# the throw was swallowed by the per-item best-effort catch, no needle was
# recorded, and scrub exited 0 reporting "no plaintext secrets found" over state
# that may still have held it. The fix wires the backend into one context factory
# AND lifts the cross-stack class out of that catch with a pre-pass that REFUSES
# (`SCRUB_CROSS_STACK_READ_UNRESOLVED`, exit 2) when the read cannot be made.
#
# THE THIRD DEFECT (#2146), which needs one more stack on the same chain. The
# #2133 refusal gates on the DIRECT producer's template carrying a literal
# `{{resolve:`. A stack that merely RE-EXPORTS someone else's export has none, so
# scrubbing the stack at the END of such a chain returned early, found no needle,
# and printed "No plaintext secrets found" while that stack's record still held
# the imported plaintext — the #2133 silent success reached through a re-export.
# The fix follows the chain through the app's templates (visited-set termination,
# so a cycle halts) and refuses naming the head of the chain.
#
# THE FIXTURE. Three stacks:
#   Producer  — a Secrets Manager secret with a KNOWN, non-sensitive JSON value,
#               plus a `CfnOutput` whose value is the {{resolve:...}} token and
#               which carries `Export.Name: CdkdCrossStackSecretPassword`.
#   Consumer  — an SSM `String` parameter whose value is
#               `Fn::ImportValue(CdkdCrossStackSecretPassword)`. SSM is readable
#               back in the clear, which is the only way to prove what cdkd
#               actually SENT to AWS. It ALSO re-exports what it imported, as
#               `Export.Name: CdkdCrossStackSecretReexport` — which makes it the
#               MIDDLE of the chain and gives it a template with no literal
#               `{{resolve:` anywhere in it.
#   ChainConsumer — an SSM `String` parameter whose value is
#               `Fn::ImportValue(CdkdCrossStackSecretReexport)`, two hops from
#               the secret. Scrubbing THIS stack alone is issue #2146.
#
# THE ASSERTIONS, in the order that makes a failure legible:
#   1. PREMISE      — the producer's state.outputs AND the exports index hold
#                     the {{resolve:secretsmanager: EXPRESSION (not plaintext).
#                     If the premise breaks, a passing fix assertion means
#                     nothing. Passes pre-fix too: it is #1899's behaviour.
#   2. THE FIX      — the LIVE SSM parameter equals the secret's plaintext and
#                     carries no `{{resolve:`. This is the ONLY assertion that
#                     discriminates the bug: pre-fix the live value literally IS
#                     the token.
#   3. STATE STAYS  — the consumer's own state holds the EXPRESSION, and the
#      REDACTED       WHOLE state file carries zero occurrences of the
#                     plaintext. Passes pre-fix too (pre-fix nothing was ever
#                     resolved, so nothing could leak); post-fix it is a real
#                     guard, because the fix introduces a resolved plaintext
#                     into the consumer's pass for the first time.
#   4. CONVERGENCE  — a second consumer deploy is a no-op and `cdkd diff`
#                     exits 0. This is the perpetual-UPDATE class (state holds
#                     an expression, the template resolves to plaintext), so
#                     the EXIT CODE is asserted, not only the text: a guard
#                     that greps output but never checks rc has shipped green
#                     over exactly this defect in this repo before.
#   5. SCRUB        — `cdkd scrub` on the PRODUCER, which performs no
#      NEGATIVE       cross-stack read at all: exit 0, nothing scrubbed, no
#      CONTROL        refusal. Without it, a refusal firing on EVERYTHING (or a
#                     "Scrubbed" line the command emits for any stack) would
#                     satisfy assertion 7 for the wrong reason.
#   6. SCRUB        — the consumer's state.json is hand-patched to hold the
#      PREMISE        imported secret's PLAINTEXT, exactly as a pre-GHSA
#                     binary left it, and that is READ BACK from S3 before
#                     anything depends on it. A correct deploy never leaves
#                     such a record (assertion 3 just proved so), so without
#                     the seed both a fixed and a broken binary find nothing
#                     and assertion 7 is vacuous. Its own phase, ahead of the
#                     phase that needs it: this repo has shipped a live arm
#                     that was INERT because the command returned early.
#   7. SCRUB,       — `cdkd scrub` on the CONSUMER must exit 0 (rc CAPTURED,
#      THE FIX        not inferred from text) AND print the POSITIVE marker
#                     `Scrubbed 1 resource record(s) in <consumer>` plus
#                     `Done: scrubbed 1 stack(s).`. Pre-fix it printed
#                     `No plaintext secrets found` and exited 0, so those two
#                     lines are emitted ONLY by the fixed path. "The plaintext
#                     is gone" is a CONFLUENCE POINT — equally satisfied by a
#                     correct scrub and by anything that stopped short — so it
#                     is the stated secondary net, over the current object AND
#                     over every surviving OBJECT VERSION (the bucket is
#                     versioned; a delete marker is not removal).
#   8. SCRUB        — the fix's other half, which assertion 7 cannot see: with
#      REFUSES        the pre-pass deleted the context wiring alone still
#                     resolves the import and 7 still passes. The producer's
#                     state object is delete-markered so the read CANNOT
#                     succeed, and scrub must then exit 2 naming the reference
#                     — where pre-fix the same failure was swallowed and the
#                     stack reported clean. Restored before any assertion runs.
#   9. SCRUB        — the THIRD outcome of the same read, between 7 and 8: the
#      REFUSES AN      read SUCCEEDS but the producer's own state.outputs still
#      UNSCRUBBED      holds the BARE PLAINTEXT, as a pre-#1899 binary left it.
#      PRODUCER        There is then no {{resolve:...}} expression anywhere for
#                      scrub to write into the consumer's leaf, so it must
#                      refuse (SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT, exit 2)
#                      rather than report the stack clean. Assertion 7 cannot
#                      reach it (its producer is scrubbed) and neither can 8
#                      (its producer cannot be read at all); the discriminator
#                      for exactly this branch was implemented WRONG three
#                      times with the unit suite green through two of them, so
#                      it gets a live arm of its own. The consumer is named
#                      ALONE, never --all. Restored before any assertion runs.
#  10. RE-EXPORT    — the #2146 pair, on the stack at the END of the chain,
#      CHAIN           scrubbed ALONE. (a) with every stack healthy, scrub must
#                      RESOLVE through the re-export and rewrite the plaintext
#                      seeded into that stack — a walk that refuses on every
#                      re-export passes (b) and fails here. (b) with the MIDDLE
#                      stack's state.outputs seeded back to the pre-#1899
#                      plaintext, scrub must exit 2, name the middle stack as the
#                      producer, say the evidence came by RE-EXPORT from the
#                      PRODUCER, and prescribe the chain in scrub order. Pre-fix
#                      (b) exited 0 reporting the stack clean, because the middle
#                      template carries no literal {{resolve: to gate on. The
#                      message must NOT be the `declared` verdict — that would
#                      mean the middle template grew an expression and this phase
#                      had silently become a duplicate of assertion 9.
#  11. TEARDOWN     — down the chain (each destroy is refused while the stack
#                     below still names the export in its state.imports[]), 0
#                     errors, state keys gone, both SSM parameters gone, and the
#                     secret FORCE-deleted rather than left in a 7-day
#                     pending-deletion window.
#
# Run via: /run-integ cross-stack-secret-import

set -euo pipefail

# A pager invoked non-interactively is its own route to a hang.
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

cd "$(dirname "$0")"

# Shared S3 VERSION-sweep helpers (issue #2096). The PRODUCER's template
# declares the secret's value as a LITERAL SecretString, so `EXPECTED_PLAINTEXT`
# sits in that resource's own state properties by construction -- which is why
# the leak greps below are scoped to the outputs bag and to the CONSUMER. The
# state bucket is VERSIONED, so `aws s3 rm` only writes a delete marker and the
# producer's copy stays readable via GetObjectVersion.
. ../s3-versions.sh

REGION="${AWS_REGION:-us-east-1}"
PRODUCER="CdkdCrossStackSecretProducer"
CONSUMER="CdkdCrossStackSecretConsumer"
# The stack at the END of the re-export chain (issue #2146). The CONSUMER is the
# middle link: it imports the producer's export and RE-EXPORTS it, so this stack
# sits two hops from the only template that declares a `{{resolve:` expression.
CHAIN_CONSUMER="CdkdCrossStackSecretChainConsumer"

# These MUST stay byte-identical to `lib/shared.ts`. See that file's NAMING
# RULE comment for why none of them may share a substring with
# EXPECTED_PLAINTEXT below: the leak check greps the CONSUMER's whole state
# file for that one string, and every name here is persisted into that same
# file, so a collision would report a leak that is really a name clash.
SECRET_NAME="cdkd-crossstack-secret-import"
EXPORT_NAME="CdkdCrossStackSecretPassword"
PARAMETER_NAME="/cdkd-integ/cross-stack-secret-import/imported-secret"
PASSWORD_OUTPUT="CrossStackSecretPasswordOutput"
ARN_OUTPUT="CrossStackSecretArnOutput"
# The consumer's own export, and the chain consumer's SSM sink (issue #2146).
REEXPORT_NAME="CdkdCrossStackSecretReexport"
REEXPORT_OUTPUT="ReexportedSecretOutput"
CHAIN_PARAMETER_NAME="/cdkd-integ/cross-stack-secret-import/chained-secret"
# The producer's CONDITIONAL export and the value its UNTAKEN-branch deployment
# actually stores (issue
# [#2150](https://github.com/go-to-k/cdkd/issues/2150)). Mirrors
# `lib/shared.ts`; both spellings are in the `crossstack` vocabulary the naming
# rule above requires, so neither can collide with the plaintext needle.
CONDITIONAL_EXPORT_NAME="CdkdCrossStackConditionalSecret"
CONDITIONAL_OUTPUT="CrossStackConditionalSecretOutput"
CONDITIONAL_PLAIN_VALUE="crossstack-conditional-plain-branch"

PRODUCER_STATE_KEY="cdkd/${PRODUCER}/${REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER}/${REGION}/state.json"
CHAIN_STATE_KEY="cdkd/${CHAIN_CONSUMER}/${REGION}/state.json"
# Everything each stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
#
# The shared exports index (`cdkd/_index/<region>/exports.json`) is a SIBLING
# prefix no `s3_stack_prefix` reaches, and it holds RESOLVED Output values, so
# it is a versioned reader of the same material. It used to be skipped outright
# on the grounds that "other stacks' entries live in it" -- true for a
# PREFIX-scoped `all` purge, which would take other lanes' current objects with
# it, and FALSE for the key-scoped NONCURRENT sweep used below:
# `s3_purge_key_versions` names the one key and `noncurrent` leaves whatever is
# CURRENT intact, so a concurrent lane's live index is untouched while the
# historical versions this run wrote stop accumulating. The assertions further
# down prove the CURRENT object carries the expression rather than the
# plaintext; they say nothing about the versions behind it, which is the whole
# gap this file exists to close.
PRODUCER_STATE_PREFIX="$(s3_stack_prefix "${PRODUCER}" "${REGION}")"
CONSUMER_STATE_PREFIX="$(s3_stack_prefix "${CONSUMER}" "${REGION}")"
CHAIN_STATE_PREFIX="$(s3_stack_prefix "${CHAIN_CONSUMER}" "${REGION}")"
INDEX_KEY="cdkd/_index/${REGION}/exports.json"

# One run id for the whole script, exported BEFORE any cdkd invocation: every
# cdkd command re-synthesizes the app in a subprocess that inherits
# `process.env`, so deploy / re-deploy / diff all see the same value and the
# convergence assertion is not defeated by a value that moves under it. A
# unique-per-run plaintext also means a parameter left behind by an EARLIER run
# cannot satisfy assertion 2 — it carries the old run id and fails.
RUN_ID="${CDKD_INTEG_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
export CDKD_INTEG_RUN_ID="${RUN_ID}"
EXPECTED_PLAINTEXT="integ-1934-${RUN_ID}"

# Resolve the built CLI without a `cd` into dist/ that fails cryptically when
# dist/ is unbuilt -- the friendly guard below reports it instead.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

pass() { echo "    OK: $1"; }

fail() { # fail <message>
  echo "FAIL: $1" >&2
  exit 1
}

# Echo captured output as failure diagnostics — but never before proving it
# carries no plaintext. These diagnostics sit on exactly the paths that exist
# to DETECT a leak, so an unchecked echo prints the secret at the precise
# moment redaction failed.
diag() { # diag <text>
  if printf '%s' "$1" | grep -qF "${EXPECTED_PLAINTEXT}"; then
    echo "      output: <WITHHELD - it carries the resolved secret, which is itself the bug>" >&2
    return 0
  fi
  echo "      output: $1" >&2
}

assert_no_plaintext() { # assert_no_plaintext <what> <text>
  # grep -qF so a match is never echoed.
  if printf '%s' "$2" | grep -qF "${EXPECTED_PLAINTEXT}"; then
    fail "$1 carries the resolved secret plaintext"
  fi
  pass "$1 carries no plaintext"
}

# Poll a gone-probe until it reports GONE, hard-failing after <attempts>.
#
# Used for the AWS-side (non-S3) probes only. `DeleteSecret
# --force-delete-without-recovery` and `DeleteParameter` are effectively
# immediate but not instantaneously consistent, and both sites that need this
# run right after a delete: the pre-run sweep and the post-destroy check. A
# resource that is genuinely leaked stays present through every attempt, so
# this weakens nothing — it only stops a consistency lag from burning a whole
# real-AWS run. Routed through the canonical `gone_probe`, so an UNDETERMINED
# probe (throttle / auth / network) still hard-fails on the first attempt
# instead of being retried into a false "gone".
wait_gone() { # wait_gone <attempts> "<leak description>" aws <service> <read-verb> [args...]
  local attempts="$1" desc="$2"
  shift 2
  local i=1
  while [ "${i}" -le "${attempts}" ]; do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 5
    i=$((i + 1))
  done
  fail "${desc}"
}

# Best-effort teardown shared by the pre-run sweep and the traps. No `exit`
# here, so the pre-run call cannot terminate the script.
sweep() {
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ]; then
      # DOWN THE CHAIN: each stack's destroy is refused while the stack below it
      # still names its export in state.imports[], so the order is chain
      # consumer, consumer, producer.
      node "${LOCAL_DIST}" state destroy "${CHAIN_CONSUMER}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${PRODUCER}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
    fi
    # Direct deletes in case state destroy missed them. The secret is
    # force-deleted: a scheduled deletion holds the NAME for its recovery
    # window and would block the next run's create.
    aws ssm delete-parameter --name "${PARAMETER_NAME}" --region "${REGION}" >/dev/null 2>&1
    aws ssm delete-parameter --name "${CHAIN_PARAMETER_NAME}" --region "${REGION}" >/dev/null 2>&1
    aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CHAIN_CONSUMER}/${REGION}/lock.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER}/${REGION}/lock.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER}/${REGION}/lock.json" >/dev/null 2>&1
      # `aws s3 rm` / `state destroy` only leave DELETE MARKERS on a versioned
      # bucket, so the producer's literal SecretString survives in the prior
      # versions. NONCURRENT-only here: `sweep` also runs from the pre-run pass
      # and the failure traps, where a live state.json may be the only record of
      # resources still standing. The success path does the full sweep.
      # `|| true` like every other line in `sweep`: a failed LIST returns 1,
      # and this subshell runs under the caller's `set -euo pipefail` at the
      # PRE-RUN call site -- so an unguarded non-zero here aborts the run before
      # it starts. Inside `cleanup` it would preempt `exit "${rc}"` and turn a
      # SIGINT run's 130 into a 1.
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX:-}" noncurrent || true
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX:-}" noncurrent || true
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CHAIN_STATE_PREFIX:-}" noncurrent || true
      # The shared exports index, on EVERY path. `noncurrent` is safe anywhere
      # (it never touches the CURRENT object, which belongs to whichever stack
      # wrote it last), so scoping this to the success path -- as it first was
      # -- left every index version a FAILED or SIGNALLED run wrote, which is
      # the majority of the runs that write them. The key-scoped form is what
      # makes it safe: a prefix-scoped `all` here would take a concurrent
      # lane's live index.
      s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY:-}" noncurrent || true
    fi
  )
}

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (best-effort; errors in this block are tolerated)"
  sweep
  exit "${rc}"
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  fail "STATE_BUCKET env var is required"
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  fail "local binary not built at ${LOCAL_DIST} - run 'vp run build' from the repo root first"
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run sweep + clean-slate check (run id: ${RUN_ID})"
sweep
assert_gone "producer state exists before the run - clean up first" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"
assert_gone "consumer state exists before the run - clean up first" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
assert_gone "chain consumer state exists before the run - clean up first" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHAIN_STATE_KEY}"
wait_gone 6 "the SSM parameter exists before the run - a stale value could stand in for the imported one" \
  aws ssm get-parameter --name "${PARAMETER_NAME}" --region "${REGION}"
wait_gone 6 "the chained SSM parameter exists before the run - a stale value could stand in for the chained one" \
  aws ssm get-parameter --name "${CHAIN_PARAMETER_NAME}" --region "${REGION}"
wait_gone 6 "the fixture secret exists before the run" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"
pass "clean slate"

echo ""
echo "==> Step 1: deploy Producer + Consumer + ChainConsumer"
node "${LOCAL_DIST}" deploy --all --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# --- Assertion 1: PREMISE -------------------------------------------------
# The value the consumer imports must actually BE the redacted expression. If
# #1899's redaction ever stops applying to outputs, the consumer would import
# the plaintext, ship the right value for the wrong reason, and assertion 2
# would pass over a completely unexercised fix.
echo ""
echo "==> Step 2 (assertion 1 - PREMISE): the exported value is stored REDACTED"
PRODUCER_STATE_JSON=$(node "${LOCAL_DIST}" state show "${PRODUCER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)

STATE_EXPORT_VALUE=$(printf '%s' "${PRODUCER_STATE_JSON}" \
  | jq -r --arg k "${EXPORT_NAME}" '.state.outputs[$k] // empty')
case "${STATE_EXPORT_VALUE}" in
  '{{resolve:secretsmanager:'*)
    # Printable: it names the secret, not its value.
    pass "producer state.outputs[${EXPORT_NAME}] kept the expression: ${STATE_EXPORT_VALUE}"
    ;;
  '')
    # KEYS only. The whole producer state carries the fixture's literal
    # `SecretString`, so dumping it here would be withheld wholesale by `diag`
    # and the reader would learn nothing; the key list is what actually names
    # the problem, and still goes through `diag` in case a key ever carries a
    # resolved value (the issue #1919 class).
    diag "producer output keys: $(printf '%s' "${PRODUCER_STATE_JSON}" | jq -c '.state.outputs | keys')"
    fail "producer state.outputs has no ${EXPORT_NAME} key (the export alias was not written)"
    ;;
  *)
    fail "producer state.outputs[${EXPORT_NAME}] is NOT the {{resolve:...}} expression - the #1899 redaction premise is broken, so nothing below tests the #1934 fix"
    ;;
esac

STATE_OUTPUT_VALUE=$(printf '%s' "${PRODUCER_STATE_JSON}" \
  | jq -r --arg k "${PASSWORD_OUTPUT}" '.state.outputs[$k] // empty')
case "${STATE_OUTPUT_VALUE}" in
  '{{resolve:secretsmanager:'*) pass "producer state.outputs[${PASSWORD_OUTPUT}] kept the expression too" ;;
  *) fail "producer state.outputs[${PASSWORD_OUTPUT}] is NOT the {{resolve:...}} expression" ;;
esac

# The non-secret sibling output must still be RESOLVED. Without it, a bug that
# redacted (or failed to resolve) EVERY output would satisfy both checks above
# and the premise would be vacuous.
STATE_ARN_VALUE=$(printf '%s' "${PRODUCER_STATE_JSON}" \
  | jq -r --arg k "${ARN_OUTPUT}" '.state.outputs[$k] // empty')
case "${STATE_ARN_VALUE}" in
  'arn:'*':secretsmanager:'*)
    pass "the non-secret sibling output stayed RESOLVED (redaction is selective, not wholesale)"
    ;;
  *)
    fail "producer state.outputs[${ARN_OUTPUT}] is not a resolved secret ARN (got: ${STATE_ARN_VALUE}) - the premise check above cannot distinguish selective redaction from a resolver that resolved nothing"
    ;;
esac

# Scoped to the OUTPUTS bag, deliberately NOT to the whole producer state
# file. The fixture's own template declares the secret's value as a LITERAL
# `SecretString`, so the producer's `state.resources` holds that plaintext by
# construction — it never came from resolving a `{{resolve:...}}` reference and
# nothing redacts it. Grepping the whole file here would report a leak that is
# really the fixture's own literal, which is indistinguishable from a real one
# and sends the reader hunting in the redaction code. The whole-file grep
# belongs on the CONSUMER (step 4), whose state declares no secret at all.
PRODUCER_OUTPUTS=$(printf '%s' "${PRODUCER_STATE_JSON}" | jq -c '.state.outputs')
assert_no_plaintext "the producer's persisted outputs bag" "${PRODUCER_OUTPUTS}"

# --- Issue #2150 PREMISE: the conditional export stored its UNTAKEN branch ---
#
# THE WHOLE #2150 ARM IS INERT WITHOUT THIS, and inert in the silent direction.
# The defect needs the producer's STORED value to carry no expression: that is
# what turns the wrong `declared` verdict into
# `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`. If the condition had somehow evaluated
# TRUE, the stored value would be the `{{resolve:...}}` expression, the
# discriminator in `makeCrossStackPrePass` would return early, and step 8 would
# pass under BOTH the fixed and the broken code -- reporting green over an arm
# that tested nothing. The condition is a literal-false `Fn::Equals` in
# `lib/producer-stack.ts`, so this asserts a property of cdkd's condition
# evaluation, not of the run's environment.
#
# Checked on BOTH keys cdkd writes for an exported output -- the export ALIAS
# and the logical output id -- because the pre-pass matches an export by either
# spelling, so a wrong value under only one of them would still reach the
# verdict.
for cond_key in "${CONDITIONAL_EXPORT_NAME}" "${CONDITIONAL_OUTPUT}"; do
  COND_STORED=$(printf '%s' "${PRODUCER_STATE_JSON}" \
    | jq -r --arg k "${cond_key}" '.state.outputs[$k] // empty')
  if [ "${COND_STORED}" != "${CONDITIONAL_PLAIN_VALUE}" ]; then
    diag "producer output keys: $(printf '%s' "${PRODUCER_STATE_JSON}" | jq -c '.state.outputs | keys')"
    fail "producer state.outputs[${cond_key}] is '${COND_STORED}', expected the untaken-branch literal '${CONDITIONAL_PLAIN_VALUE}' - the issue 2150 arm is INERT: with an expression stored there, scrub's discriminator returns early and step 8 would pass under the broken code too"
  fi
done
pass "the conditional export stored its UNTAKEN branch ('${CONDITIONAL_PLAIN_VALUE}'), so the issue 2150 arm is armed"

# ...and the TEMPLATE really does carry the secret expression in the arm the
# deployment did NOT take. Without this the premise above is also satisfied by a
# producer whose Fn::If lost its secret arm entirely, which would make the arm
# inert the other way round: nothing for the old literal scan to have seen.
# Synthesized HERE rather than read from a `cdk.out` the run happens to leave
# behind: cdkd synthesizes into its own temporary directory, so there is no
# fixture-local assembly to read, and a stale one from an earlier run would
# answer for a template this run never deployed. `CDKD_INTEG_RUN_ID` is already
# exported, so this subprocess synthesizes the same app the deploy did.
COND_SYNTH_DIR=$(mktemp -d)
CDK_OUTDIR="${COND_SYNTH_DIR}" node bin/app.ts >/dev/null
COND_TEMPLATE_VALUE=$(node -e '
const fs = require("fs");
const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const v = t.Outputs?.[process.argv[2]]?.Value;
process.stdout.write(JSON.stringify(v?.["Fn::If"]?.[1] ?? null));
' "${COND_SYNTH_DIR}/${PRODUCER}.template.json" "${CONDITIONAL_OUTPUT}")
rm -rf "${COND_SYNTH_DIR}"
case "${COND_TEMPLATE_VALUE}" in
  '"{{resolve:secretsmanager:'*)
    pass "the conditional export's UNTAKEN arm carries a secret expression, which is what the old literal scan saw"
    ;;
  *)
    fail "the conditional export's Fn::If ifTrue arm is ${COND_TEMPLATE_VALUE}, not a {{resolve:secretsmanager:...}} expression - the issue 2150 arm is INERT: there is nothing for a both-arms scan to have found"
    ;;
esac

INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" -)
INDEX_VALUE=$(printf '%s' "${INDEX_BODY}" \
  | jq -r --arg k "${EXPORT_NAME}" '.exports[$k].value // empty')
case "${INDEX_VALUE}" in
  '{{resolve:secretsmanager:'*)
    pass "exports index entry kept the expression: ${INDEX_VALUE}"
    ;;
  '')
    fail "the exports index has no ${EXPORT_NAME} entry - the consumer cannot have resolved through the index path this test is about"
    ;;
  *)
    fail "the exports index entry for ${EXPORT_NAME} is NOT the {{resolve:...}} expression - premise broken"
    ;;
esac
assert_no_plaintext "the exports index" "${INDEX_BODY}"

# --- Assertion 2: THE FIX -------------------------------------------------
# The one assertion that discriminates issue #1934. PRE-FIX the live parameter
# value is literally the {{resolve:...}} token the producer's state holds,
# because `Fn::ImportValue` returned it verbatim and SSM stores whatever it is
# handed.
echo ""
echo "==> Step 3 (assertion 2 - THE FIX): the LIVE resource carries the RESOLVED secret"
LIVE_VALUE=$(aws ssm get-parameter --name "${PARAMETER_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
case "${LIVE_VALUE}" in
  *'{{resolve:'*)
    fail "the live SSM parameter holds a LITERAL dynamic-reference token - the consumer shipped the redacted expression to AWS (issue #1934 NOT fixed)"
    ;;
esac
if [ "${LIVE_VALUE}" != "${EXPECTED_PLAINTEXT}" ]; then
  # Not printed: on a redaction regression this is a real resolved value.
  fail "the live SSM parameter does not carry the imported secret's value (expected the run's plaintext, got a value of length ${#LIVE_VALUE})"
fi
pass "the live SSM parameter carries the RESOLVED secret and no {{resolve: token"

# The issue #2150 read, live. The conditional export reaches AWS through this
# parameter's DESCRIPTION rather than a second resource, so that arm moves none
# of the resource counts the steps below assert -- see `lib/consumer-stack.ts`.
# Asserting it here proves the read happened at all: the pre-pass walks the whole
# Properties bag, so a `Description` that came back without the branch value
# would mean `resolveImportValue` never ran for that export and the verdict under
# test was never reached.
LIVE_DESCRIPTION=$(aws ssm describe-parameters \
  --parameter-filters "Key=Name,Values=${PARAMETER_NAME}" \
  --region "${REGION}" --query 'Parameters[0].Description' --output text)
case "${LIVE_DESCRIPTION}" in
  *"${CONDITIONAL_PLAIN_VALUE}")
    pass "the live parameter description carries the conditional export's untaken-branch value, so that cross-stack read really resolved"
    ;;
  *'{{resolve:'*)
    fail "the live parameter description holds a LITERAL dynamic-reference token - the conditional export shipped an unresolved expression to AWS"
    ;;
  *)
    fail "the live parameter description does not end with '${CONDITIONAL_PLAIN_VALUE}' (got: ${LIVE_DESCRIPTION}) - the issue 2150 cross-stack read did not resolve, so nothing below exercises that verdict"
    ;;
esac

# --- Assertion 3: the CONSUMER's own state stays redacted ------------------
echo ""
echo "==> Step 4 (assertion 3): the consumer's own state holds the EXPRESSION"
CONSUMER_STATE_JSON=$(node "${LOCAL_DIST}" state show "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)
STATE_PARAM_VALUE=$(printf '%s' "${CONSUMER_STATE_JSON}" \
  | jq -r '[.state.resources
              | to_entries[]
              | select(.value.resourceType=="AWS::SSM::Parameter")
              | .value.properties.Value] | first // empty')
case "${STATE_PARAM_VALUE}" in
  '{{resolve:secretsmanager:'*)
    pass "consumer state properties.Value kept the expression: ${STATE_PARAM_VALUE}"
    ;;
  '')
    fail "could not read the SSM parameter's persisted Value from the consumer's state"
    ;;
  *)
    fail "consumer state properties.Value is NOT the {{resolve:...}} expression - the re-resolved plaintext was persisted"
    ;;
esac

CONSUMER_STATE_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)
# The WHOLE file, not just the property: `observedProperties` is read back from
# AWS on this path and holds the decrypted value unless redaction reaches it.
assert_no_plaintext "the consumer's persisted state file" "${CONSUMER_STATE_RAW}"

# --- Assertion 4: CONVERGENCE ---------------------------------------------
# The failure mode the FIX itself introduces: state holds an expression while
# the template now resolves to plaintext, so a comparison of the two sides
# reports a change on every run forever. Asserted on the machine-readable
# verdict (exit code + --json counts) first, with the human wording second.
echo ""
echo "==> Step 5 (assertion 4 - CONVERGENCE): a re-deploy is a no-op and diff exits 0"
set +e
DEPLOY2_OUT=$(node "${LOCAL_DIST}" deploy "${CONSUMER}" --exclusively \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY2_RC=$?
set -e
assert_no_plaintext "the second deploy's output" "${DEPLOY2_OUT}"
if [ "${DEPLOY2_RC}" -ne 0 ]; then
  diag "${DEPLOY2_OUT}"
  fail "the second consumer deploy exited ${DEPLOY2_RC} (expected 0)"
fi
if ! printf '%s' "${DEPLOY2_OUT}" | grep -q "No changes detected"; then
  # Sentinel (see .claude/rules/testing.md, "a fixture that greps cdkd's OWN
  # output must fail loudly when the format drifts"): the stack NAME is emitted
  # by the deploy banner independently of the no-change wording, so its
  # presence proves the output was captured and the parse — not the run — is
  # what came up empty. Which of the two it is: run `cdkd diff <consumer>
  # --json` by hand — a non-empty `changes` array means a real perpetual
  # UPDATE, an empty one means only this grep went blind.
  if printf '%s' "${DEPLOY2_OUT}" | grep -q "${CONSUMER}"; then
    diag "${DEPLOY2_OUT}"
    fail "the second consumer deploy did not report 'No changes detected' - either the consumer re-UPDATEd (perpetual UPDATE) or cdkd's no-change wording drifted and this grep is now blind; 'cdkd diff ${CONSUMER} --json' separates the two"
  fi
  fail "the second consumer deploy printed neither 'No changes detected' nor the stack name - the output was not captured at all"
fi
pass "the second consumer deploy reported no change"

set +e
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${CONSUMER}" --fail \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
DIFF_RC=$?
set -e
assert_no_plaintext "'cdkd diff' output" "${DIFF_OUT}"
if [ "${DIFF_RC}" -ne 0 ]; then
  diag "${DIFF_OUT}"
  fail "'cdkd diff --fail' exited ${DIFF_RC} on an unchanged consumer (expected 0) - the imported secret is a perpetual UPDATE"
fi
pass "'cdkd diff --fail' exits 0 on the unchanged consumer"

set +e
DIFF_JSON=$(node "${LOCAL_DIST}" diff "${CONSUMER}" --json \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>/dev/null)
DIFF_JSON_RC=$?
set -e
if [ "${DIFF_JSON_RC}" -ne 0 ]; then
  fail "'cdkd diff --json' exited ${DIFF_JSON_RC}"
fi
assert_no_plaintext "'cdkd diff --json' payload" "${DIFF_JSON}"
# Positive receipt BEFORE the count: `add // 0` answers 0 for an empty payload
# too, so an unparsed / renamed / empty payload would read exactly like a clean
# diff. Requiring the tree for THIS stack to be present is what makes the zero
# below mean "nothing changed" rather than "nothing was parsed".
# (`cdkd diff --json` sets the log level to warn and writes only the payload to
# stdout — src/cli/commands/diff.ts — so the capture above is the whole JSON.)
PARSED_STACK=$(printf '%s' "${DIFF_JSON}" \
  | jq -r --arg s "${CONSUMER}" '[.[] | select(.stack == $s) | .stack] | first // empty')
if [ "${PARSED_STACK}" != "${CONSUMER}" ]; then
  diag "${DIFF_JSON}"
  fail "'cdkd diff --json' payload carries no tree for ${CONSUMER} - the payload shape changed and the change count below would be a vacuous zero"
fi
CHANGE_COUNT=$(printf '%s' "${DIFF_JSON}" \
  | jq '[.. | objects | select(has("changes") and has("outputChanges"))
           | (.changes|length) + (.outputChanges|length)] | add // 0')
if [ "${CHANGE_COUNT}" != "0" ]; then
  diag "${DIFF_JSON}"
  fail "'cdkd diff --json' reports ${CHANGE_COUNT} change(s) on the unchanged consumer (expected 0)"
fi
pass "'cdkd diff --json' parsed the ${CONSUMER} tree and reports zero resource + output changes"

# --- Assertions 5-8: `cdkd scrub` over an Fn::ImportValue-sourced secret ----
#
# ISSUE #2133. Every resolve context `scrubStack` built omitted `stateBackend`,
# which both `resolveImportValue` and `getSameAccountStackState` require. A
# secret arriving through `Fn::ImportValue` therefore threw for want of a
# dependency, the throw landed in the per-item best-effort
# `catch { logger.debug(...) }`, the plaintext never became a NEEDLE, and `cdkd
# scrub` exited 0 reporting "No plaintext secrets found" over a `state.json`
# that may still have held it. The fix wires the backend into one context
# factory and lifts the cross-stack class OUT of that catch with a pre-pass that
# REFUSES (`SCRUB_CROSS_STACK_READ_UNRESOLVED`, exit 2) when the read fails.
#
# WHY THE STATE HAS TO BE SEEDED. Scrub only rewrites a record that actually
# HOLDS plaintext, and a correct deploy never leaves one — assertion 3 above
# just proved this consumer's record holds the EXPRESSION. Against that state a
# fixed and a broken binary both find nothing and the arm is vacuous. The seed
# in step 7 writes the plaintext where a pre-GHSA-p5qg-v9gv-hc7w binary would
# have left it, which is exactly the population `cdkd scrub` exists to repair.
#
# WHAT MAKES EACH STEP DISCRIMINATING, since "the plaintext is gone" on its own
# is a CONFLUENCE POINT — equally satisfied by a correct scrub and by any
# unrelated failure that stopped short of writing anything:
#
#   Step 6      — NEGATIVE CONTROL. `cdkd scrub` on the PRODUCER, which has no
#   (assertion 5)  cross-stack read at all: exit 0, "No plaintext secrets
#                  found", no "Scrubbed" line and no refusal. Without it, a
#                  refusal that fired on EVERYTHING, or a "Scrubbed" line the
#                  command emits for any stack it is pointed at, would satisfy
#                  step 8 for the wrong reason.
#   Step 7      — PREMISE. The seeded plaintext really IS in the consumer's
#   (assertion 6)  state before scrub runs, read back through S3. Its own
#                  phase, ahead of the phase that depends on it: this repo has
#                  shipped a live arm that was INERT because the command
#                  returned early and never reached the new code.
#   Step 8      — THE FIX. The EXIT CODE is captured (`rc`), not merely grepped
#   (assertion 7)  for, and a POSITIVE marker naming the work done is required:
#                  `Scrubbed 1 resource record(s) in <consumer>` plus
#                  `Done: scrubbed 1 stack(s).`. Pre-fix the command prints
#                  `No plaintext secrets found in <consumer>` and exits 0, so
#                  those two lines are emitted ONLY by the fixed path. The
#                  plaintext's absence — from the current object AND from every
#                  surviving OBJECT VERSION, since the state bucket is
#                  versioned and a delete marker is not removal — is the
#                  stated secondary net, never the discriminator.
#   Step 9      — THE REFUSAL. The other half of the fix, and it needs its own
#   (assertion 8)  phase because step 8 passes with the pre-pass deleted (the
#                  context wiring alone resolves the import). The producer's
#                  state object is delete-markered so the read CANNOT succeed,
#                  and scrub must then exit 2 naming the reference — where
#                  pre-fix it exited 0 reporting the stack clean. Restored
#                  immediately, before any assertion runs, so no failure here
#                  can leave the producer unmanageable; and `sweep` deletes the
#                  secret by NAME on every abort path regardless.
#   Step 10     — THE OTHER REFUSAL, and the branch NEITHER step above can
#   (assertion 9)  enter. The read here SUCCEEDS — the producer's state is
#                  readable — but what it hands back is a BARE PLAINTEXT,
#                  because the producer's own `state.outputs` has not been
#                  scrubbed yet. `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`, exit
#                  2, and its message names the producer plus the remedy that
#                  actually works (`cdkd scrub <producer>` first). Step 8's
#                  producer holds the EXPRESSION, so its read is healthy; step
#                  9's producer cannot be read at all, so its read THROWS.
#                  Only a producer whose state still stores the plaintext
#                  reaches the discriminator, and that discriminator was
#                  implemented WRONG three times — `carriesDynamicReference`
#                  applied to the RESOLVED value (inverted), the producer's
#                  TEMPLATE (true of both outcomes), and a needle count (wrong
#                  in BOTH directions) — with the unit suite green through two
#                  of them and only a real-AWS run catching the third. What
#                  ships instead READS the producer's stored value and tests
#                  `carriesDynamicReference` on IT, which is a statement about
#                  a real state record and is therefore what this arm exercises.

# Every SURVIVING object version under one stack's key space, grepped for this
# run's plaintext. `head-object` reporting the state file gone proves nothing on
# a VERSIONED bucket: `aws s3 rm` writes a DELETE MARKER, and every byte ever
# written stays readable to anyone with `s3:GetObjectVersion` (issue #2096).
#
# `Versions[]` and not `([Versions, DeleteMarkers][])`: a delete marker carries a
# VersionId too, and `get-object --version-id <marker>` answers 405
# MethodNotAllowed — which would turn every marker into a spurious failure. A
# marker has no body, so it can leak nothing.
#
# ROWS are counted, never `length(...)`: the AWS CLI applies `--query` PER PAGE
# and concatenates, so a >1000-entry listing prints `1000\n189` and a numeric
# test on that is a bash error rather than a count (../s3-versions.sh, trap 3).
#
# The zero-scanned refusal is what stops this from certifying the wrong key
# space: a mistyped prefix lists nothing, every grep is skipped, and a bare
# "no plaintext found" would be a truthful statement about nothing at all.
assert_no_plaintext_in_versions() { # <prefix> <description>
  local prefix="$1" desc="$2" rows key vid body scanned=0
  if ! rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
      --prefix "${prefix}" --query 'Versions[].[Key,VersionId]' --output text 2>&1)"; then
    fail "${desc}: could not list object versions under s3://${STATE_BUCKET}/${prefix} (${rows}) — an unverified sweep is not a clean one"
  fi
  # `|| [ -n "${key}" ]`: `$(...)` strips the trailing newline, so `read` returns
  # non-zero on the LAST row and its body would never run (../s3-versions.sh,
  # trap 2). A here-string rather than a pipe so `scanned` survives the loop.
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    # `/dev/stdout` puts the BODY on stdout followed by the response metadata
    # JSON; both are captured, and the metadata cannot manufacture a match.
    # `< /dev/null` so nothing in the loop can consume the row stream.
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      fail "${desc}: could not read s3://${STATE_BUCKET}/${key} version ${vid} (${body}) — undetermined, which certifies nothing"
    fi
    # -qF so a match is never echoed: this is the site that exists to DETECT a
    # leak, and printing it here would disclose at the precise moment it failed.
    if printf '%s' "${body}" | grep -qF "${EXPECTED_PLAINTEXT}"; then
      fail "${desc}: s3://${STATE_BUCKET}/${key} version ${vid} STILL carries this run's plaintext"
    fi
    scanned=$((scanned + 1))
  done <<< "${rows}"
  if [ "${scanned}" -eq 0 ]; then
    fail "${desc}: scanned ZERO object versions under s3://${STATE_BUCKET}/${prefix} — the prefix names nothing, so a clean verdict here would be about the wrong key space"
  fi
  pass "${desc}: ${scanned} surviving object version(s) scanned, none carries the plaintext"
}

# The expression the consumer's record is stored as, captured in step 4 rather
# than re-spelled here: the seed below matches on it and step 8 asserts the
# record came back to it, so a change in how cdkd spells the reference cannot
# leave the seed a silent no-op while the assertions still read as meaningful.
CONSUMER_EXPRESSION="${STATE_PARAM_VALUE}"

echo ""
echo "==> Step 6 (assertion 5 - NEGATIVE CONTROL): scrubbing the PRODUCER neither refuses nor claims a scrub"
# The producer's template carries no `Fn::ImportValue` / `Fn::GetStackOutput` at
# all, so the pre-pass must not fire for it, and its records hold no plaintext
# scrub can identify (the fixture's own literal `SecretString` is not a
# reference, so nothing recorded it as a needle). This is what makes step 8's
# "Scrubbed 1 resource record(s)" a statement about the SEEDED consumer rather
# than something `cdkd scrub` says about any stack it is pointed at.
set +e
PRODUCER_SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${PRODUCER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
PRODUCER_SCRUB_RC=$?
set -e
assert_no_plaintext "the producer scrub's output" "${PRODUCER_SCRUB_OUT}"
if [ "${PRODUCER_SCRUB_RC}" -ne 0 ]; then
  diag "${PRODUCER_SCRUB_OUT}"
  fail "'cdkd scrub ${PRODUCER}' exited ${PRODUCER_SCRUB_RC} (expected 0) — the #2133 pre-pass is refusing a stack that performs no cross-stack read"
fi
case "${PRODUCER_SCRUB_OUT}" in
  *'could not resolve the'*)
    diag "${PRODUCER_SCRUB_OUT}"
    fail "'cdkd scrub ${PRODUCER}' reported an unresolvable cross-stack read — the refusal is firing on a stack that has none, so step 8 could not distinguish the fix from a refusal that fires on everything"
    ;;
esac
case "${PRODUCER_SCRUB_OUT}" in
  *'Scrubbed '*)
    diag "${PRODUCER_SCRUB_OUT}"
    fail "'cdkd scrub ${PRODUCER}' claims it rewrote a record — nothing in the producer's state holds a plaintext scrub can identify, so the 'Scrubbed' marker step 8 asserts on would not discriminate"
    ;;
esac
if ! printf '%s' "${PRODUCER_SCRUB_OUT}" | grep -qF "No plaintext secrets found in ${PRODUCER}"; then
  # Sentinel: the stack NAME is printed by the summary independently of the
  # no-finding wording, so its presence proves the output was captured and the
  # PARSE, not the run, came up empty (.claude/rules/testing.md).
  if printf '%s' "${PRODUCER_SCRUB_OUT}" | grep -qF "${PRODUCER}"; then
    diag "${PRODUCER_SCRUB_OUT}"
    fail "'cdkd scrub ${PRODUCER}' did not report 'No plaintext secrets found in ${PRODUCER}' — either it found something it should not have, or scrub's no-finding wording drifted and this grep is now blind"
  fi
  fail "'cdkd scrub ${PRODUCER}' printed neither the no-finding line nor the stack name — the output was not captured at all"
fi
pass "the producer scrub exits 0, refuses nothing, and rewrites nothing"

echo ""
echo "==> Step 7 (assertion 6 - PREMISE): seed the pre-#1899 shape and prove state HOLDS the plaintext"
# COUPLING, stated because it is invisible locally and someone will otherwise
# move one half: the grep after the patch proves the SEED LANDED only because
# this read proves the same plaintext was ABSENT a moment earlier. Delete this
# and that check degenerates into "the file contains a string it may well have
# contained all along".
PRE_SEED_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)
assert_no_plaintext "the consumer's state immediately before the seed" "${PRE_SEED_RAW}"

# Rewrite by MATCHING the stored expression rather than by naming a logical id,
# so a CDK logical-id change cannot silently turn the seed into a no-op — and
# require EXACTLY ONE match first, so it cannot be ambiguous either.
SEED_TARGETS=$(printf '%s' "${PRE_SEED_RAW}" \
  | jq --arg expr "${CONSUMER_EXPRESSION}" \
       '[.resources | to_entries[] | select(.value.properties.Value == $expr)] | length')
if [ "${SEED_TARGETS}" != "1" ]; then
  fail "expected exactly ONE consumer record whose properties.Value is the imported expression, found ${SEED_TARGETS} — the seed would be ambiguous or a no-op and every assertion after it would pass vacuously"
fi
SEEDED_RAW=$(printf '%s' "${PRE_SEED_RAW}" \
  | jq --arg expr "${CONSUMER_EXPRESSION}" --arg plain "${EXPECTED_PLAINTEXT}" '
      .resources |= with_entries(
        if .value.properties.Value == $expr
        then .value.properties.Value = $plain
        else . end)')
if ! printf '%s' "${SEEDED_RAW}" | grep -qF "${EXPECTED_PLAINTEXT}"; then
  fail "the pre-#1899 seed did not take — no plaintext in the patched document"
fi
printf '%s' "${SEEDED_RAW}" | aws s3 cp - "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}"

# Read back FROM S3, through the same path `cdkd scrub` reads, rather than
# trusting the document that was uploaded. This is the premise proper: without
# it a green step 8 would say nothing, because a scrub that never reached the
# new code also leaves behind a state file with no plaintext in it.
SEEDED_STATE_JSON=$(node "${LOCAL_DIST}" state show "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)
SEEDED_PARAM_VALUE=$(printf '%s' "${SEEDED_STATE_JSON}" \
  | jq -r '[.state.resources
              | to_entries[]
              | select(.value.resourceType=="AWS::SSM::Parameter")
              | .value.properties.Value] | first // empty')
if [ "${SEEDED_PARAM_VALUE}" != "${EXPECTED_PLAINTEXT}" ]; then
  # Never printed: on the failure this guards it is either the expression (seed
  # lost) or some other resolved value.
  fail "the consumer's persisted properties.Value is not the seeded plaintext (length ${#SEEDED_PARAM_VALUE}) — scrub would have nothing to remove and step 8 would be vacuous"
fi
pass "the consumer's state.json now HOLDS the imported secret's plaintext, as an older cdkd would have left it"

echo ""
# ALSO THE ISSUE #2150 DISCRIMINATOR, and that is why the conditional read was
# put on THIS stack. `cdkd scrub <consumer>` performs two cross-stack reads: the
# `Value`'s import of the secret-bearing export, and the `Description`'s import
# of the producer's CONDITIONAL export. The second one used to verdict `declared`
# off the `Fn::If` arm the deployment never took (the literal scan
# `JSON.stringify`d the whole node), and the discriminator then read the stored
# plain-branch value, found no expression, and raised
# `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` -- exit 2, no bypass flag, nothing a
# scrub of the producer could ever clear. So on `main` this step exits 2 and the
# consumer's real seeded secret is STRANDED; the assertions below are what say
# it no longer is.
echo "==> Step 8 (assertion 7 - THE FIX): 'cdkd scrub' resolves the Fn::ImportValue and REWRITES the record"
set +e
SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
SCRUB_RC=$?
set -e
assert_no_plaintext "'cdkd scrub' output" "${SCRUB_OUT}"
# THE EXIT CODE, captured and compared — not inferred from the text. A guard
# that greps a command's output but never checks its rc has shipped green over
# exactly the defect it was written for in this repo before.
if [ "${SCRUB_RC}" -ne 0 ]; then
  diag "${SCRUB_OUT}"
  fail "'cdkd scrub ${CONSUMER}' exited ${SCRUB_RC} (expected 0) — it could not scrub a state file whose imported secret IS resolvable"
fi
# THE POSITIVE MARKER, and the single assertion that discriminates issue #2133.
# Pre-fix `Fn::ImportValue` never resolved, so the plaintext never became a
# needle, `recordsChanged` stayed 0, and this line was `No plaintext secrets
# found in <consumer>`. Exactly ONE record can change: the consumer owns one
# resource record, and step 7 proved exactly one record was seeded. (It DOES
# declare an output since issue #2146 made it the middle of the chain -- the
# count is of RESOURCE records, which outputs are not, and the outputs bag is
# left holding its expression by that seed.)
if ! printf '%s' "${SCRUB_OUT}" | grep -qF "Scrubbed 1 resource record(s) in ${CONSUMER}"; then
  diag "${SCRUB_OUT}"
  fail "'cdkd scrub ${CONSUMER}' did not report 'Scrubbed 1 resource record(s)' — the seeded plaintext was never recognised, which is issue #2133 exactly: the Fn::ImportValue never resolved, so scrub had no needle and reported the stack clean"
fi
if ! printf '%s' "${SCRUB_OUT}" | grep -qF "Done: scrubbed 1 stack(s)."; then
  diag "${SCRUB_OUT}"
  fail "'cdkd scrub ${CONSUMER}' did not print its 'Done: scrubbed 1 stack(s).' summary — the per-stack line and the summary disagree about whether anything was rewritten"
fi
case "${SCRUB_OUT}" in
  *"No plaintext secrets found in ${CONSUMER}"*)
    diag "${SCRUB_OUT}"
    fail "'cdkd scrub ${CONSUMER}' reported the stack clean over state step 7 proved holds the plaintext — issue #2133's silent success"
    ;;
esac
pass "scrub reported rc=0 and 'Scrubbed 1 resource record(s) in ${CONSUMER}'"

# SECONDARY NET, stated as such: the record is back on its expression and the
# plaintext is gone. Both are satisfied by a scrub that worked AND by anything
# that stopped short, which is why neither is the discriminator above.
SCRUBBED_STATE_JSON=$(node "${LOCAL_DIST}" state show "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)
SCRUBBED_PARAM_VALUE=$(printf '%s' "${SCRUBBED_STATE_JSON}" \
  | jq -r '[.state.resources
              | to_entries[]
              | select(.value.resourceType=="AWS::SSM::Parameter")
              | .value.properties.Value] | first // empty')
if [ "${SCRUBBED_PARAM_VALUE}" != "${CONSUMER_EXPRESSION}" ]; then
  case "${SCRUBBED_PARAM_VALUE}" in
    '{{resolve:secretsmanager:'*)
      fail "scrub rewrote properties.Value to a DIFFERENT secret expression (${SCRUBBED_PARAM_VALUE}) than the one the deploy stored (${CONSUMER_EXPRESSION})"
      ;;
    *)
      fail "scrub left the consumer's properties.Value as something other than the imported expression (length ${#SCRUBBED_PARAM_VALUE})"
      ;;
  esac
fi
pass "the consumer's properties.Value is back to the expression: ${SCRUBBED_PARAM_VALUE}"

SCRUBBED_STATE_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)
assert_no_plaintext "the consumer's persisted state file after scrub" "${SCRUBBED_STATE_RAW}"

# VERSIONS, not the current object. `aws s3 rm` only writes a delete marker on
# this bucket, and the SEEDED version is a real disclosure of a real (fixture)
# secret for as long as it survives — so purge the noncurrent versions now
# rather than at teardown, then PROVE nothing under the prefix still carries it.
#
# `noncurrent` is load-bearing: the consumer is still DEPLOYED and its CURRENT
# state.json is what the teardown below destroys from. Sweeping `all` here would
# make step 11's destroy skip the stack entirely and orphan the SSM parameter.
s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" noncurrent || true
assert_no_plaintext_in_versions "${CONSUMER_STATE_PREFIX}" \
  "the consumer's surviving state-object versions after scrub"

echo ""
echo "==> Step 9 (assertion 8 - THE REFUSAL): an UNREADABLE producer makes scrub REFUSE, not report clean"
# The other half of #2133, and it needs its own phase: step 8 still passes with
# the pre-pass deleted, because the context wiring alone is enough to resolve
# the import. What only the pre-pass can do is turn a FAILED cross-stack read
# from a `logger.debug` into an exit-2 refusal — pre-fix the same failure was
# swallowed by the per-item best-effort catch and the stack was reported clean.
#
# The producer's state OBJECT is delete-markered so `Fn::ImportValue` cannot be
# answered by anyone: `cdkd scrub` supplies no `exportIndex` (deliberately — the
# index's scan arm would PATCH it, an S3 write from a command that performs no
# AWS mutation), so the state.json scan is the only route and it is now blind.
#
# Backed up in a shell variable rather than a file: this document carries the
# fixture's literal `SecretString`, and a scratch copy on disk would outlive an
# abort. The restore runs BEFORE any assertion below, so no failure here can
# leave the producer unmanageable — and `sweep` force-deletes the secret by NAME
# on every abort path regardless of what state.json says.
PRODUCER_STATE_BACKUP=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" -)
if ! printf '%s' "${PRODUCER_STATE_BACKUP}" \
    | jq -e --arg k "${EXPORT_NAME}" '.outputs | has($k)' > /dev/null; then
  fail "the producer state backup does not carry the ${EXPORT_NAME} output — refusing to delete an object this phase could not restore"
fi
aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}" > /dev/null
set +e
REFUSE_OUT=$(node "${LOCAL_DIST}" scrub "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
REFUSE_RC=$?
set -e
# Restore FIRST, assert second.
printf '%s' "${PRODUCER_STATE_BACKUP}" | aws s3 cp - "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}"
PRODUCER_STATE_BACKUP=""
RESTORED_EXPORT=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - \
  | jq -r --arg k "${EXPORT_NAME}" '.outputs[$k] // empty')
if [ "${RESTORED_EXPORT}" != "${STATE_EXPORT_VALUE}" ]; then
  fail "the producer's state was NOT restored (its ${EXPORT_NAME} output reads back as a value of length ${#RESTORED_EXPORT}) — the teardown below cannot destroy the producer"
fi
pass "the producer's state was restored before any assertion ran"

assert_no_plaintext "'cdkd scrub' refusal output" "${REFUSE_OUT}"
# rc=2 SPECIFICALLY, not merely non-zero: `--fail` uses 1 for "plaintext was
# found", and a CI gate reading the code alone must be able to tell "scrub
# looked and found a leak" from "scrub refused to look" — the two call for
# opposite responses (rotate the secret vs. deploy the producer and re-run).
if [ "${REFUSE_RC}" -ne 2 ]; then
  diag "${REFUSE_OUT}"
  fail "'cdkd scrub ${CONSUMER}' exited ${REFUSE_RC} with the producer's state unreadable (expected 2) — a 0 here is issue #2133 exactly: the unresolvable cross-stack read was swallowed and the stack reported clean"
fi
if ! printf '%s' "${REFUSE_OUT}" | grep -qF "could not resolve the Fn::ImportValue in resource"; then
  diag "${REFUSE_OUT}"
  fail "'cdkd scrub ${CONSUMER}' exited 2 but never named the unresolvable Fn::ImportValue — the exit code came from somewhere other than the #2133 pre-pass"
fi
if ! printf '%s' "${REFUSE_OUT}" | grep -qF "1 stack(s) could not be scrubbed: ${CONSUMER}"; then
  diag "${REFUSE_OUT}"
  fail "'cdkd scrub ${CONSUMER}' refused without naming the stack in its summary"
fi
pass "scrub refused with rc=2 and named the unresolvable Fn::ImportValue"

echo ""
echo "==> Step 10 (assertion 9 - THE OTHER REFUSAL): an UNSCRUBBED producer makes scrub REFUSE, not report clean"
# The THIRD outcome of one cross-stack read, and the branch neither step above
# enters. Step 8's producer state holds the {{resolve:...}} EXPRESSION, so the
# read is healthy and the consumer is scrubbed. Step 9's producer state cannot
# be read at all, so the read THROWS. Between them sits the population `cdkd
# scrub` exists for: a producer whose state an OLDER binary wrote, so its
# `state.outputs` still stores the resolved PLAINTEXT. The read then SUCCEEDS
# and returns that plaintext, and there is no expression anywhere for scrub to
# write into the consumer's leaf — so it must refuse
# (`SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`, exit 2) rather than report the stack
# clean, which is the same silent success as #2133 reached one step later.
#
# WHY THIS ONE IS WORTH A REAL-AWS PHASE. The discriminator for exactly this
# decision was implemented WRONG three times: `carriesDynamicReference` applied
# to the RESOLVED value (inverted — `reresolveCrossStackValue` hands back a
# plaintext in BOTH outcomes), the producer's TEMPLATE test (true of both, so it
# refused every consumer of a secret-bearing export), and a needle-count test
# (wrong in both directions). The unit suite was green through two of them,
# because the signals were perfectly correlated across its matrix, and the real-
# AWS arm is what caught the third. What ships now READS the producer's stored
# `state.outputs[<key the read matched>]` and tests `carriesDynamicReference` on
# THAT — a statement about a real state record, which is precisely the thing a
# live producer supplies and a fixture cannot fake into existence.
#
# THE CONSUMER ALONE, NEVER `--all`, and this is a non-obvious way for the arm
# to go vacuous rather than a stylistic choice. `orderScrubTargets` sorts
# producers ahead of their consumers, so a `--all` run would scrub the PRODUCER
# first, turn its stored plaintext back into the expression, and arrive at the
# consumer with the condition already healed — a green phase over a code path it
# never entered.
#
# THE SEED IS ON THE PRODUCER, NOT THE CONSUMER. The refusal is raised by the
# pre-pass walking the consumer's TEMPLATE `Properties`, so it does not depend on
# what the consumer's own state holds; step 8 left that record on its expression
# and this phase leaves it there, which is what makes "the record was not
# rewritten" below a meaningful secondary net.
#
# Backed up in a shell variable rather than a file, and restored BEFORE any
# assertion runs, for the two reasons step 9 states: this document carries the
# fixture's literal `SecretString`, and a scratch copy on disk would outlive an
# abort.
PRODUCER_STATE_BACKUP=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" -)
# The EXPORT-name key, not the output name. `resolveImportValue`'s state.json
# scan matches `exportName in state.outputs`, records that same string as the
# import's `exportName`, and the pre-pass then re-reads `state.outputs[<that
# key>]` to classify it — so `CdkdCrossStackSecretPassword` is the one key the
# seed has to change, and patching `CrossStackSecretPasswordOutput` instead
# would be a silent no-op that every assertion below would pass over.
#
# Required to hold the EXPRESSION first, compared against the value step 2
# captured. Without it the seed could be a no-op on a key that already held a
# plaintext, and "the plaintext is there afterwards" would be evidence of
# nothing — the same coupling step 7 spells out for its own seed.
PRE_SEED_EXPORT=$(printf '%s' "${PRODUCER_STATE_BACKUP}" \
  | jq -r --arg k "${EXPORT_NAME}" '.outputs[$k] // empty')
if [ "${PRE_SEED_EXPORT}" != "${STATE_EXPORT_VALUE}" ]; then
  fail "the producer's state.outputs[${EXPORT_NAME}] is not the expression step 2 recorded (length ${#PRE_SEED_EXPORT}) — the seed below would not be the pre-#1899 shape and this phase would test nothing"
fi
PRODUCER_SEEDED=$(printf '%s' "${PRODUCER_STATE_BACKUP}" \
  | jq --arg k "${EXPORT_NAME}" --arg plain "${EXPECTED_PLAINTEXT}" '.outputs[$k] = $plain')
printf '%s' "${PRODUCER_SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}"
PRODUCER_SEEDED=""
# Read back THROUGH cdkd, not from the document that was uploaded, exactly as
# step 7 does: the premise this phase rests on is that `cdkd scrub` sees a
# plaintext there, and only a read through the same path can say so.
SEEDED_PRODUCER_EXPORT=$(node "${LOCAL_DIST}" state show "${PRODUCER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json \
  | jq -r --arg k "${EXPORT_NAME}" '.state.outputs[$k] // empty')
if [ "${SEEDED_PRODUCER_EXPORT}" != "${EXPECTED_PLAINTEXT}" ]; then
  # Never printed: on the failure this guards it is either the expression (seed
  # lost) or some other resolved value.
  fail "the producer's persisted state.outputs[${EXPORT_NAME}] is not the seeded plaintext (length ${#SEEDED_PRODUCER_EXPORT}) — the read below would return an expression and the refusal under test could not fire"
fi
pass "the producer's state.outputs[${EXPORT_NAME}] now holds the BARE PLAINTEXT, as a pre-#1899 binary left it"

# Captured BEFORE the scrub so "the consumer's record was not rewritten" can be
# stated as a byte comparison rather than as a re-parse of one field.
PRE_REFUSE_CONSUMER_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)
set +e
PLAINTEXT_PRODUCER_OUT=$(node "${LOCAL_DIST}" scrub "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
PLAINTEXT_PRODUCER_RC=$?
set -e
# Restore FIRST, assert second — a failed assertion here must not leave the
# producer's export holding a plaintext for the teardown below to destroy from.
printf '%s' "${PRODUCER_STATE_BACKUP}" | aws s3 cp - "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}"
PRODUCER_STATE_BACKUP=""
RESTORED_SEEDED_EXPORT=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - \
  | jq -r --arg k "${EXPORT_NAME}" '.outputs[$k] // empty')
if [ "${RESTORED_SEEDED_EXPORT}" != "${STATE_EXPORT_VALUE}" ]; then
  fail "the producer's state was NOT restored (its ${EXPORT_NAME} output reads back as a value of length ${#RESTORED_SEEDED_EXPORT}) — a later phase would inherit the seeded plaintext and the teardown could not destroy the producer"
fi
pass "the producer's state was restored before any assertion ran"

# VERSION COVERAGE for the seed, stated because the shape differs from step 8's.
# The seed wrote a NONCURRENT version of the producer's state.json carrying this
# run's plaintext in its outputs bag, so purge those now rather than at teardown
# — every phase such a version survives is extra time it is recoverable through
# `GetObjectVersion` (issue #2096). `noncurrent` is load-bearing for the reason
# step 8 gives: the producer is still DEPLOYED and its CURRENT state.json is what
# step 11's destroy reads.
#
# No `assert_no_plaintext_in_versions` follows, and that is not an omission. The
# producer's CURRENT object carries `EXPECTED_PLAINTEXT` BY CONSTRUCTION — the
# fixture's template declares the secret's value as a literal `SecretString`, so
# it sits in that resource's own state properties, which is why every leak grep
# in this file is scoped to the outputs bag or to the CONSUMER. What proves
# nothing survives on the producer side is the terminal
# `s3_purge_prefix_versions ... all` + `s3_assert_versions_swept` pair below,
# which already covers this seed: it asserts ZERO surviving versions under the
# whole producer prefix.
s3_purge_key_versions "${STATE_BUCKET}" "${PRODUCER_STATE_KEY}" noncurrent || true

assert_no_plaintext "'cdkd scrub' unscrubbed-producer refusal output" "${PLAINTEXT_PRODUCER_OUT}"
# THE DISCRIMINATOR, half one: rc CAPTURED above and compared to 2 SPECIFICALLY.
# A guard that greps a command's output but never checks its rc has shipped
# green over exactly the defect it was written for in this repo before, and
# non-zero alone is not enough either — `--fail` uses 1 for "plaintext was
# found", and a CI gate reading the code has to tell "scrub looked and found a
# leak" from "scrub refused to look".
if [ "${PLAINTEXT_PRODUCER_RC}" -ne 2 ]; then
  diag "${PLAINTEXT_PRODUCER_OUT}"
  fail "'cdkd scrub ${CONSUMER}' exited ${PLAINTEXT_PRODUCER_RC} with the producer's export stored as a PLAINTEXT (expected 2) — a 0 here is the #2133 silent success reached one step later: the read returned a bare string, nothing became a needle, and the stack was reported clean"
fi
# THE DISCRIMINATOR, half two: WHICH refusal. Both this phase and step 9 exit 2
# out of the same pre-pass, so the exit code alone cannot tell them apart, and a
# regression that made every cross-stack read UNRESOLVABLE would satisfy the rc
# check here while testing nothing about the plaintext-producer branch. The two
# messages are disjoint by construction — this one says the read RESOLVED, step
# 9's says it could NOT be resolved — so both polarities are asserted.
#
# NOT the error CODE: `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` is carried on the
# CdkdError and read by the unit suite, but `formatError` renders only
# `<name>: <message>`, so no cdkd invocation ever prints the code string. The
# message text below is the strongest marker the CLI actually emits.
if ! printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "resolved the Fn::ImportValue in resource"; then
  # Sentinel (see .claude/rules/testing.md): the stack NAME is printed by the
  # summary independently of the refusal wording, so its presence proves the
  # output was captured and the PARSE, not the run, came up empty.
  if printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "${CONSUMER}"; then
    diag "${PLAINTEXT_PRODUCER_OUT}"
    fail "'cdkd scrub ${CONSUMER}' exited 2 but never said it RESOLVED the Fn::ImportValue — the exit code came from somewhere other than the unscrubbed-producer branch, or that refusal's wording drifted and this grep is now blind"
  fi
  fail "'cdkd scrub ${CONSUMER}' printed neither the refusal wording nor the stack name — the output was not captured at all"
fi
if printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "could not resolve the Fn::ImportValue in resource"; then
  diag "${PLAINTEXT_PRODUCER_OUT}"
  fail "'cdkd scrub ${CONSUMER}' refused with step 9's UNRESOLVABLE-read message instead — the producer's state is readable here, so this phase would be a duplicate of step 9 rather than a test of the plaintext-producer branch"
fi
# The producer is NAMED, and named as the producer rather than as the stack
# being scrubbed: the whole point of this refusal over a bare failure is that it
# tells the operator which OTHER stack to scrub first.
if ! printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "to a PLAINTEXT value: the producer stack '${PRODUCER}'"; then
  diag "${PLAINTEXT_PRODUCER_OUT}"
  fail "'cdkd scrub ${CONSUMER}' refused without naming '${PRODUCER}' as the producer holding the plaintext"
fi
# `declares '<key>' from a {{resolve:...}} expression` is the `declared` verdict,
# which is only reached when an output of the producer's template matched THIS
# key by name or by literal `Export.Name`. The `widened` verdict spells itself
# differently ("publishes at least one output ... could not match"), so this
# grep also fences the key-matching half: a refusal that fired off the
# all-outputs fallback would be a refusal reached for a weaker reason than the
# one this fixture is built to exercise.
if ! printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "declares '${EXPORT_NAME}' from a {{resolve:...}} expression"; then
  diag "${PLAINTEXT_PRODUCER_OUT}"
  fail "'cdkd scrub ${CONSUMER}' refused without the 'declared' verdict for ${EXPORT_NAME} — the producer template match fell back to the widened all-outputs scan, so the refusal came from an over-approximation rather than from this export"
fi
# THE REMEDY. A refusal that does not name the working fix strands the operator
# on a command that can never succeed, which is why this branch refuses instead
# of writing something into the leaf: there is no correct value to write.
if ! printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "'cdkd scrub ${PRODUCER}'"; then
  diag "${PLAINTEXT_PRODUCER_OUT}"
  fail "'cdkd scrub ${CONSUMER}' refused without naming the remedy 'cdkd scrub ${PRODUCER}'"
fi
if ! printf '%s' "${PLAINTEXT_PRODUCER_OUT}" | grep -qF "1 stack(s) could not be scrubbed: ${CONSUMER}"; then
  diag "${PLAINTEXT_PRODUCER_OUT}"
  fail "'cdkd scrub ${CONSUMER}' refused without naming the stack in its summary"
fi
pass "scrub refused with rc=2, named ${PRODUCER} as the unscrubbed producer, and named the remedy"

# SECONDARY NET, stated as such: neither of the two below is the discriminator.
# "scrub did not claim the stack was clean" is satisfied by any failure that
# stopped short of the summary, and "the record was not rewritten" is satisfied
# by every path that wrote nothing at all — a CONFLUENCE POINT in both cases.
# The rc plus the refusal wording above is what says this branch was entered.
case "${PLAINTEXT_PRODUCER_OUT}" in
  *"No plaintext secrets found in ${CONSUMER}"*)
    diag "${PLAINTEXT_PRODUCER_OUT}"
    fail "'cdkd scrub ${CONSUMER}' reported the stack clean while refusing — the summary and the refusal contradict each other"
    ;;
esac
case "${PLAINTEXT_PRODUCER_OUT}" in
  *'Scrubbed '*)
    diag "${PLAINTEXT_PRODUCER_OUT}"
    fail "'cdkd scrub ${CONSUMER}' claims it rewrote a record while refusing — there is no expression to write, which is the whole reason this branch refuses"
    ;;
esac
POST_REFUSE_CONSUMER_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)
if [ "${POST_REFUSE_CONSUMER_RAW}" != "${PRE_REFUSE_CONSUMER_RAW}" ]; then
  # The document is NOT echoed: on the failure this guards, the difference is
  # whatever scrub decided to write into a secret-bearing leaf.
  fail "the consumer's state.json changed across a REFUSED scrub — the refusal must write nothing, and fabricating a value into an imported secret's leaf is the #1934 break class this branch exists to avoid"
fi
assert_no_plaintext "the consumer's persisted state file after the refusal" "${POST_REFUSE_CONSUMER_RAW}"
PRE_REFUSE_CONSUMER_RAW=""
POST_REFUSE_CONSUMER_RAW=""
pass "the consumer's state.json is byte-identical across the refusal and still carries no plaintext"


echo ""
echo "==> Step 11 (assertion 10 - THE RE-EXPORT CHAIN): scrubbing the stack at the END of the chain"
# Issue #2146. Everything above tests a DIRECT import: the consumer reads an
# export whose producer TEMPLATE declares it from a literal
# `{{resolve:secretsmanager:...}}` expression, and scrub's producer-plaintext
# gate answers "is this export secret-bearing at all" by looking for exactly
# that literal in exactly that one template.
#
# A RE-EXPORT has none. The CONSUMER's `ReexportedSecretOutput` declares
# `{"Fn::ImportValue": "<the producer's export>"}`, so the gate looked at the
# consumer's template, found no `{{resolve:`, returned `no`, and the pre-pass
# returned early — and with the consumer's own `state.outputs` still holding a
# plaintext (the pre-#1899 shape step 10 seeds for the producer), `cdkd scrub
# <chain consumer>` printed `No plaintext secrets found` and exited 0 over a
# record that still held the imported secret. That is the #2133 silent success
# reached through a re-export instead of a direct import.
#
# THE CHAIN CONSUMER ALONE, NEVER `--all`, for the reason step 10 gives one link
# lower down: `orderScrubTargets` sorts producers ahead of consumers, so an
# `--all` run scrubs producer, then consumer, and reaches the chain consumer with
# the condition already healed — green over a code path it never entered. A user
# told to "scrub that stack" runs exactly the single-stack command this phase
# runs.
#
# TWO HALVES, and neither can stand in for the other. 11a is the RESOLVE half:
# with every stack healthy the walk must NOT refuse, and the chain must produce
# the needle that rewrites this stack's seeded plaintext — a fix that refuses on
# every re-export would pass 11b and fail here. 11b is the REFUSAL half: with the
# middle stack's state seeded back to the pre-#1899 plaintext, scrub must exit 2
# naming the chain, where pre-#2146 it exited 0 reporting the stack clean.

# --- 11a: the chain RESOLVES end to end ------------------------------------
CHAIN_STATE_JSON=$(node "${LOCAL_DIST}" state show "${CHAIN_CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)
CHAIN_PARAM_VALUE=$(printf '%s' "${CHAIN_STATE_JSON}" \
  | jq -r '[.state.resources
              | to_entries[]
              | select(.value.resourceType=="AWS::SSM::Parameter")
              | .value.properties.Value] | first // empty')
case "${CHAIN_PARAM_VALUE}" in
  '{{resolve:secretsmanager:'*)
    pass "chain consumer state properties.Value kept the expression two hops from the secret: ${CHAIN_PARAM_VALUE}"
    ;;
  '')
    fail "could not read the chained SSM parameter's persisted Value from ${CHAIN_CONSUMER}'s state"
    ;;
  *)
    fail "chain consumer state properties.Value is NOT the {{resolve:...}} expression - the re-resolved plaintext was persisted two hops down the chain"
    ;;
esac
# The LIVE resource carries the RESOLVED secret, which is what says the chain
# actually delivered the value rather than a token or an empty string. Without
# it every assertion below could hold over a chain that resolved to nothing.
CHAIN_LIVE_VALUE=$(aws ssm get-parameter --name "${CHAIN_PARAMETER_NAME}" \
  --region "${REGION}" --query 'Parameter.Value' --output text)
if [ "${CHAIN_LIVE_VALUE}" != "${EXPECTED_PLAINTEXT}" ]; then
  # Never echoed: on the failure this guards, the value is either the literal
  # token or some other resolved value.
  fail "the chained SSM parameter does not hold this run's plaintext (length ${#CHAIN_LIVE_VALUE}) — the re-export chain did not deliver the secret, so nothing below tests the chain"
fi
pass "the chained SSM parameter holds the resolved secret, so the chain delivered it end to end"

# PREMISE for 11b's seed: the middle stack's own export is stored as the
# EXPRESSION today, under BOTH keys the deploy writes (the output name and the
# `Export.Name` alias). The seed below patches the alias — the one
# `resolveImportValue`'s scan matches and the pre-pass then re-reads — so a
# change that stopped writing it would make the seed a silent no-op.
MIDDLE_STATE_JSON=$(node "${LOCAL_DIST}" state show "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)
MIDDLE_REEXPORT_VALUE=$(printf '%s' "${MIDDLE_STATE_JSON}" \
  | jq -r --arg k "${REEXPORT_NAME}" '.state.outputs[$k] // empty')
MIDDLE_REEXPORT_BY_NAME=$(printf '%s' "${MIDDLE_STATE_JSON}" \
  | jq -r --arg k "${REEXPORT_OUTPUT}" '.state.outputs[$k] // empty')
case "${MIDDLE_REEXPORT_VALUE}" in
  '{{resolve:secretsmanager:'*)
    pass "the middle stack's state.outputs[${REEXPORT_NAME}] holds the expression: ${MIDDLE_REEXPORT_VALUE}"
    ;;
  '')
    fail "the middle stack's state.outputs carries no ${REEXPORT_NAME} key (keys: $(printf '%s' "${MIDDLE_STATE_JSON}" | jq -c '.state.outputs | keys')) — the re-export never reached state and the chain under test does not exist"
    ;;
  *)
    fail "the middle stack's state.outputs[${REEXPORT_NAME}] is NOT the {{resolve:...}} expression (length ${#MIDDLE_REEXPORT_VALUE}) — the re-exported secret was persisted as a plaintext, which is a #1899 redaction regression rather than the #2146 case"
    ;;
esac
if [ "${MIDDLE_REEXPORT_BY_NAME}" != "${MIDDLE_REEXPORT_VALUE}" ]; then
  fail "the middle stack's state.outputs[${REEXPORT_OUTPUT}] and [${REEXPORT_NAME}] disagree — the export alias no longer mirrors the output, so the seed below would patch a key the read does not match"
fi

# Seed the chain consumer's record with the plaintext, the pre-GHSA shape, by
# MATCHING the stored expression rather than a logical id — and require exactly
# one match first, so the seed can be neither ambiguous nor a no-op. Same
# construction as step 7, one link further down the chain.
PRE_SEED_CHAIN_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CHAIN_STATE_KEY}" -)
assert_no_plaintext "the chain consumer's state immediately before the seed" "${PRE_SEED_CHAIN_RAW}"
CHAIN_SEED_TARGETS=$(printf '%s' "${PRE_SEED_CHAIN_RAW}" \
  | jq --arg expr "${CHAIN_PARAM_VALUE}" \
       '[.resources | to_entries[] | select(.value.properties.Value == $expr)] | length')
if [ "${CHAIN_SEED_TARGETS}" != "1" ]; then
  fail "expected exactly ONE chain consumer record whose properties.Value is the imported expression, found ${CHAIN_SEED_TARGETS} — the seed would be ambiguous or a no-op and every assertion after it would pass vacuously"
fi
CHAIN_SEEDED_RAW=$(printf '%s' "${PRE_SEED_CHAIN_RAW}" \
  | jq --arg expr "${CHAIN_PARAM_VALUE}" --arg plain "${EXPECTED_PLAINTEXT}" '
      .resources |= with_entries(
        if .value.properties.Value == $expr
        then .value.properties.Value = $plain
        else . end)')
if ! printf '%s' "${CHAIN_SEEDED_RAW}" | grep -qF "${EXPECTED_PLAINTEXT}"; then
  fail "the pre-#1899 seed did not take on the chain consumer — no plaintext in the patched document"
fi
printf '%s' "${CHAIN_SEEDED_RAW}" | aws s3 cp - "s3://${STATE_BUCKET}/${CHAIN_STATE_KEY}"
CHAIN_SEEDED_RAW=""
PRE_SEED_CHAIN_RAW=""
SEEDED_CHAIN_VALUE=$(node "${LOCAL_DIST}" state show "${CHAIN_CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json \
  | jq -r '[.state.resources
              | to_entries[]
              | select(.value.resourceType=="AWS::SSM::Parameter")
              | .value.properties.Value] | first // empty')
if [ "${SEEDED_CHAIN_VALUE}" != "${EXPECTED_PLAINTEXT}" ]; then
  fail "the chain consumer's persisted properties.Value is not the seeded plaintext (length ${#SEEDED_CHAIN_VALUE}) — scrub would have nothing to remove and 11a would be vacuous"
fi
pass "the chain consumer's state.json now HOLDS the imported secret's plaintext, as an older cdkd would have left it"

set +e
CHAIN_SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${CHAIN_CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
CHAIN_SCRUB_RC=$?
set -e
assert_no_plaintext "'cdkd scrub ${CHAIN_CONSUMER}' output" "${CHAIN_SCRUB_OUT}"
if [ "${CHAIN_SCRUB_RC}" -ne 0 ]; then
  diag "${CHAIN_SCRUB_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' exited ${CHAIN_SCRUB_RC} (expected 0) — every stack in the chain is healthy here, so a refusal means the chain walk refuses on a re-export it should have cleared"
fi
if ! printf '%s' "${CHAIN_SCRUB_OUT}" | grep -qF "Scrubbed 1 resource record(s) in ${CHAIN_CONSUMER}"; then
  diag "${CHAIN_SCRUB_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' did not report 'Scrubbed 1 resource record(s)' — the seeded plaintext two hops from the secret was never recognised"
fi
case "${CHAIN_SCRUB_OUT}" in
  *"No plaintext secrets found in ${CHAIN_CONSUMER}"*)
    diag "${CHAIN_SCRUB_OUT}"
    fail "'cdkd scrub ${CHAIN_CONSUMER}' reported the stack clean over state this phase proved holds the plaintext"
    ;;
esac
RESCRUBBED_CHAIN_VALUE=$(node "${LOCAL_DIST}" state show "${CHAIN_CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json \
  | jq -r '[.state.resources
              | to_entries[]
              | select(.value.resourceType=="AWS::SSM::Parameter")
              | .value.properties.Value] | first // empty')
if [ "${RESCRUBBED_CHAIN_VALUE}" != "${CHAIN_PARAM_VALUE}" ]; then
  fail "scrub left the chain consumer's properties.Value as something other than the imported expression (length ${#RESCRUBBED_CHAIN_VALUE})"
fi
# Assigned first rather than inlined as `"$(aws s3 cp ...)"`: under `set -e` a
# failed command substitution in ARGUMENT position does not abort, so the
# assertion would run over an empty string and pass over nothing.
SCRUBBED_CHAIN_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CHAIN_STATE_KEY}" -)
assert_no_plaintext "the chain consumer's persisted state file after scrub" "${SCRUBBED_CHAIN_RAW}"
SCRUBBED_CHAIN_RAW=""
# The seeded version is a real disclosure for as long as it survives, and
# `noncurrent` for the reason step 8 gives: this stack is still DEPLOYED and its
# CURRENT state.json is what the teardown destroys from.
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHAIN_STATE_PREFIX}" noncurrent || true
assert_no_plaintext_in_versions "${CHAIN_STATE_PREFIX}" \
  "the chain consumer's surviving state-object versions after scrub"
pass "11a: scrub resolved the RE-EXPORTED secret and rewrote the record it was seeded into"

# --- 11b: an unscrubbed MIDDLE stack makes scrub REFUSE --------------------
# Backed up in a shell variable rather than a file, for the reason steps 9 and 10
# give: this document carries the run's plaintext once seeded, and a scratch copy
# on disk would outlive an abort.
CONSUMER_STATE_BACKUP=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)
PRE_SEED_REEXPORT=$(printf '%s' "${CONSUMER_STATE_BACKUP}" \
  | jq -r --arg k "${REEXPORT_NAME}" '.outputs[$k] // empty')
if [ "${PRE_SEED_REEXPORT}" != "${MIDDLE_REEXPORT_VALUE}" ]; then
  fail "the middle stack's state.outputs[${REEXPORT_NAME}] is not the expression read a moment ago (length ${#PRE_SEED_REEXPORT}) — the seed below would not be the pre-#1899 shape and this phase would test nothing"
fi
MIDDLE_SEEDED=$(printf '%s' "${CONSUMER_STATE_BACKUP}" \
  | jq --arg k "${REEXPORT_NAME}" --arg plain "${EXPECTED_PLAINTEXT}" '.outputs[$k] = $plain')
printf '%s' "${MIDDLE_SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}"
MIDDLE_SEEDED=""
SEEDED_MIDDLE_REEXPORT=$(node "${LOCAL_DIST}" state show "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json \
  | jq -r --arg k "${REEXPORT_NAME}" '.state.outputs[$k] // empty')
if [ "${SEEDED_MIDDLE_REEXPORT}" != "${EXPECTED_PLAINTEXT}" ]; then
  fail "the middle stack's persisted state.outputs[${REEXPORT_NAME}] is not the seeded plaintext (length ${#SEEDED_MIDDLE_REEXPORT}) — the read below would return an expression and the refusal under test could not fire"
fi
pass "the middle stack's re-exported output now holds the BARE PLAINTEXT, as a pre-#1899 binary left it"

PRE_REFUSE_CHAIN_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CHAIN_STATE_KEY}" -)
set +e
CHAIN_REFUSE_OUT=$(node "${LOCAL_DIST}" scrub "${CHAIN_CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
CHAIN_REFUSE_RC=$?
set -e
# Restore FIRST, assert second — a failed assertion here must not leave the
# middle stack's export holding a plaintext for the teardown to destroy from.
printf '%s' "${CONSUMER_STATE_BACKUP}" | aws s3 cp - "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}"
CONSUMER_STATE_BACKUP=""
RESTORED_REEXPORT=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - \
  | jq -r --arg k "${REEXPORT_NAME}" '.outputs[$k] // empty')
if [ "${RESTORED_REEXPORT}" != "${MIDDLE_REEXPORT_VALUE}" ]; then
  fail "the middle stack's state was NOT restored (its ${REEXPORT_NAME} output reads back as a value of length ${#RESTORED_REEXPORT}) — a later phase would inherit the seeded plaintext and the teardown could not destroy the stack"
fi
pass "the middle stack's state was restored before any assertion ran"
# The seed wrote a NONCURRENT version of the middle stack's state.json carrying
# this run's plaintext in its outputs bag; purge it now rather than at teardown,
# for the reason step 10 gives.
s3_purge_key_versions "${STATE_BUCKET}" "${CONSUMER_STATE_KEY}" noncurrent || true

assert_no_plaintext "'cdkd scrub ${CHAIN_CONSUMER}' re-export refusal output" "${CHAIN_REFUSE_OUT}"
# THE DISCRIMINATOR, half one: rc CAPTURED and compared to 2 specifically. A 0
# here is issue #2146 verbatim — the walk stopped at the middle template, found
# no `{{resolve:`, and reported a stack holding a plaintext as clean.
if [ "${CHAIN_REFUSE_RC}" -ne 2 ]; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' exited ${CHAIN_REFUSE_RC} with the RE-EXPORTED value stored as a PLAINTEXT (expected 2) — this is issue #2146: the producer-plaintext gate asked only the middle stack's template, which declares no {{resolve:, so the stack was reported clean over surviving plaintext"
fi
# THE DISCRIMINATOR, half two: WHICH refusal, and it must be the PLAINTEXT one.
# The middle stack's state is perfectly readable here, so an "unresolvable read"
# refusal would mean the chain broke rather than that the gate followed it.
if ! printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "resolved the Fn::ImportValue in resource"; then
  # Sentinel: the stack NAME is printed by the summary independently of the
  # refusal wording, so its presence proves the output was captured and the
  # PARSE, not the run, came up empty (.claude/rules/testing.md).
  if printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "${CHAIN_CONSUMER}"; then
    diag "${CHAIN_REFUSE_OUT}"
    fail "'cdkd scrub ${CHAIN_CONSUMER}' exited 2 but never said it RESOLVED the Fn::ImportValue — the exit code came from somewhere other than the plaintext-producer branch, or that refusal's wording drifted and this grep is now blind"
  fi
  fail "'cdkd scrub ${CHAIN_CONSUMER}' printed neither the refusal wording nor the stack name — the output was not captured at all"
fi
if printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "could not resolve the Fn::ImportValue in resource"; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' refused with the UNRESOLVABLE-read message — the middle stack's state is readable here, so the chain broke rather than the gate following it"
fi
# It names the DIRECT producer — the middle stack, whose state holds the
# plaintext — rather than the stack being scrubbed or the root of the chain.
if ! printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "to a PLAINTEXT value: the producer stack '${CONSUMER}'"; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' refused without naming '${CONSUMER}' as the producer holding the plaintext"
fi
# THE #2146 ASSERTION. Only a walk that FOLLOWED the re-export can emit this: it
# names the stack at the head of the chain, which appears nowhere in the middle
# stack's template except as the export name it imports.
if ! printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "by RE-EXPORTING a value that '${PRODUCER}' declares from a {{resolve:...}} expression"; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' refused without saying the evidence came through a RE-EXPORT naming '${PRODUCER}' — the verdict did not follow the chain, so this refusal fired for some other reason"
fi
# ...and it is NOT the `declared` verdict, which would mean the middle stack's
# own template carries a literal `{{resolve:` — the fixture shape this phase
# exists to exclude. A drift that put an expression into the middle stack would
# make every assertion above pass for the DIRECT-import reason step 10 already
# covers, leaving #2146 untested.
if printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "declares '${REEXPORT_NAME}' from a {{resolve:...}} expression"; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' refused with the DIRECT-import 'declared' verdict — the middle stack's template now carries a literal expression, so this phase is a duplicate of step 10 rather than a test of the chain"
fi
# THE REMEDY, and for a chain it is more than one command: the middle stack can
# only store the expression once the head of the chain has been scrubbed, so a
# refusal naming only the middle stack sends the operator into a second refusal.
if ! printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "'cdkd scrub ${PRODUCER}', then 'cdkd scrub ${CONSUMER}'"; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' refused without prescribing the chain in scrub order ('cdkd scrub ${PRODUCER}', then 'cdkd scrub ${CONSUMER}')"
fi
if ! printf '%s' "${CHAIN_REFUSE_OUT}" | grep -qF "1 stack(s) could not be scrubbed: ${CHAIN_CONSUMER}"; then
  diag "${CHAIN_REFUSE_OUT}"
  fail "'cdkd scrub ${CHAIN_CONSUMER}' refused without naming the stack in its summary"
fi
pass "11b: scrub refused with rc=2, followed the re-export to ${PRODUCER}, and prescribed the chain in scrub order"

# SECONDARY NET, stated as such: both are satisfied by any path that stopped
# short, which is why the rc and the wording above are the discriminators.
case "${CHAIN_REFUSE_OUT}" in
  *"No plaintext secrets found in ${CHAIN_CONSUMER}"*)
    diag "${CHAIN_REFUSE_OUT}"
    fail "'cdkd scrub ${CHAIN_CONSUMER}' reported the stack clean while refusing — the summary and the refusal contradict each other"
    ;;
esac
case "${CHAIN_REFUSE_OUT}" in
  *'Scrubbed '*)
    diag "${CHAIN_REFUSE_OUT}"
    fail "'cdkd scrub ${CHAIN_CONSUMER}' claims it rewrote a record while refusing — there is no expression to write, which is the whole reason this branch refuses"
    ;;
esac
POST_REFUSE_CHAIN_RAW=$(aws s3 cp "s3://${STATE_BUCKET}/${CHAIN_STATE_KEY}" -)
if [ "${POST_REFUSE_CHAIN_RAW}" != "${PRE_REFUSE_CHAIN_RAW}" ]; then
  fail "the chain consumer's state.json changed across a REFUSED scrub — the refusal must write nothing, and fabricating a value into an imported secret's leaf is the #1934 break class this branch exists to avoid"
fi
assert_no_plaintext "the chain consumer's persisted state file after the refusal" "${POST_REFUSE_CHAIN_RAW}"
PRE_REFUSE_CHAIN_RAW=""
POST_REFUSE_CHAIN_RAW=""
pass "the chain consumer's state.json is byte-identical across the refusal and still carries no plaintext"

# --- Assertion 11: TEARDOWN ------------------------------------------------
echo ""
echo "==> Step 12 (assertion 11): destroy ChainConsumer, then Consumer, then Producer"

# DOWN THE CHAIN. Each destroy is refused while the stack below still names the
# export in its state.imports[], so this order is a property of the fixture
# rather than a preference.
node "${LOCAL_DIST}" destroy "${CHAIN_CONSUMER}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force
node "${LOCAL_DIST}" destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force
node "${LOCAL_DIST}" destroy "${PRODUCER}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force

echo ""
echo "==> Step 13: no orphans left behind"
assert_gone "chain consumer state still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHAIN_STATE_KEY}"
assert_gone "consumer state still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
assert_gone "producer state still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"
wait_gone 6 "the imported-value SSM parameter still exists after destroy" \
  aws ssm get-parameter --name "${PARAMETER_NAME}" --region "${REGION}"
wait_gone 6 "the chained-value SSM parameter still exists after destroy" \
  aws ssm get-parameter --name "${CHAIN_PARAMETER_NAME}" --region "${REGION}"
# describe-secret SUCCEEDS for a secret merely SCHEDULED for deletion (it
# returns DeletedDate), so this also catches a destroy that left a 7-day
# pending-deletion secret holding the name. Only a FORCE delete makes it 404.
wait_gone 6 "the fixture secret still exists (or is only pending deletion) after destroy - it must be force-deleted, not scheduled" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"

# The index OBJECT survives a destroy with its entries dropped, but it may also
# be absent entirely, so existence is decided by a strict gone-probe rather
# than by a `|| true` read whose empty output would also be what a throttle
# looks like. If the object races away between the probe and the read, the
# strict capture below fails the run loudly instead of passing silently.
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INDEX_KEY}"; then
  pass "the exports index object is gone entirely"
else
  INDEX_AFTER=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" -)
  STILL_INDEXED=$(printf '%s' "${INDEX_AFTER}" \
    | jq -r --arg k "${EXPORT_NAME}" 'if ((.exports // {}) | has($k)) then "yes" else "no" end')
  if [ "${STILL_INDEXED}" != "no" ]; then
    fail "the exports index still carries ${EXPORT_NAME} after the producer was destroyed"
  fi
  REEXPORT_STILL_INDEXED=$(printf '%s' "${INDEX_AFTER}" \
    | jq -r --arg k "${REEXPORT_NAME}" 'if ((.exports // {}) | has($k)) then "yes" else "no" end')
  if [ "${REEXPORT_STILL_INDEXED}" != "no" ]; then
    fail "the exports index still carries ${REEXPORT_NAME} after the middle stack was destroyed"
  fi
  assert_no_plaintext "the exports index after teardown" "${INDEX_AFTER}"
fi
pass "no orphan state, parameter, secret or exports-index entry"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# This fixture is the textbook case for why the sweep cannot live only in
# `cleanup`: the `trap - EXIT INT TERM` a few lines down DISARMS the trap, so on
# the normal path `cleanup` never runs at all. The bucket is VERSIONED, so
# without this the producer's literal secret survives the run in every prior
# version of its state.json (issue #2096). `sweep` (the teardown body `cleanup`
# would have called) is invoked explicitly first, THEN the trap is disarmed, so
# nothing can write a new delete marker after the count is taken.
echo ""
echo "==> Final teardown + state-version sweep"
sweep
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHAIN_STATE_PREFIX}" all || true
# The exports index: KEY-scoped and NONCURRENT-only, never `all`. It is shared
# with every other stack in this region, so its CURRENT object must survive.
# ASSERTED, not merely attempted: `|| true` with no count is the exact shape
# this whole convention exists to reject, and it would have been that shape here
# -- in the suite that rejects it -- had review not caught it.
s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
s3_assert_key_versions_swept "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent \
  "cross-stack-secret-import exports-index teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" "cross-stack-secret-import producer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" "cross-stack-secret-import consumer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHAIN_STATE_PREFIX}" "cross-stack-secret-import chain consumer state teardown"

echo ""
echo "==> All cross-stack-secret-import assertions passed"
