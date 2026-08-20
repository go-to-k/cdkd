#!/usr/bin/env bash
# verify.sh — cross-stack import of a REDACTED secret-bearing export (issue #1934).
#
# THE DEFECT. Since PR #1899 a secret-bearing output is persisted REDACTED:
# `state.outputs` and the exports index hold the unresolved
# `{{resolve:secretsmanager:...}}` expression rather than the plaintext. A
# cross-stack CONSUMER resolving `Fn::ImportValue` got that stored value back
# VERBATIM and shipped the LITERAL TOKEN to AWS as the property value — a
# predictable credential reference landing in a password field, not merely a
# broken value. The fix re-resolves the imported value, in the PRODUCER's
# region, before returning it.
#
# THE FIXTURE. Two stacks:
#   Producer  — a Secrets Manager secret with a KNOWN, non-sensitive JSON value,
#               plus a `CfnOutput` whose value is the {{resolve:...}} token and
#               which carries `Export.Name: CdkdCrossStackSecretPassword`.
#   Consumer  — an SSM `String` parameter whose value is
#               `Fn::ImportValue(CdkdCrossStackSecretPassword)`. SSM is readable
#               back in the clear, which is the only way to prove what cdkd
#               actually SENT to AWS.
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
#   5. TEARDOWN     — consumer first (the producer's destroy is refused while
#                     the consumer's state.imports[] names the export), 0
#                     errors, state keys gone, SSM parameter gone, and the
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

PRODUCER_STATE_KEY="cdkd/${PRODUCER}/${REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER}/${REGION}/state.json"
# Everything each stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**. The shared exports index
# (`cdkd/_index/...`) is deliberately NOT swept -- it is not this stack's key
# space, other stacks' entries live in it, and the assertions below already
# prove it carries the expression rather than the plaintext.
PRODUCER_STATE_PREFIX="$(s3_stack_prefix "${PRODUCER}" "${REGION}")"
CONSUMER_STATE_PREFIX="$(s3_stack_prefix "${CONSUMER}" "${REGION}")"
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
      # Consumer FIRST: the producer's destroy is refused while the consumer's
      # state.imports[] still names the export.
      node "${LOCAL_DIST}" state destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${PRODUCER}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
    fi
    # Direct deletes in case state destroy missed them. The secret is
    # force-deleted: a scheduled deletion holds the NAME for its recovery
    # window and would block the next run's create.
    aws ssm delete-parameter --name "${PARAMETER_NAME}" --region "${REGION}" >/dev/null 2>&1
    aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER}/${REGION}/lock.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER}/${REGION}/lock.json" >/dev/null 2>&1
      # `aws s3 rm` / `state destroy` only leave DELETE MARKERS on a versioned
      # bucket, so the producer's literal SecretString survives in the prior
      # versions. NONCURRENT-only here: `sweep` also runs from the pre-run pass
      # and the failure traps, where a live state.json may be the only record of
      # resources still standing. The success path does the full sweep.
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX:-}" noncurrent
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
wait_gone 6 "the SSM parameter exists before the run - a stale value could stand in for the imported one" \
  aws ssm get-parameter --name "${PARAMETER_NAME}" --region "${REGION}"
wait_gone 6 "the fixture secret exists before the run" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"
pass "clean slate"

echo ""
echo "==> Step 1: deploy Producer + Consumer"
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

# --- Assertion 5: TEARDOWN -------------------------------------------------
echo ""
echo "==> Step 6 (assertion 5): destroy Consumer, then Producer"
node "${LOCAL_DIST}" destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force
node "${LOCAL_DIST}" destroy "${PRODUCER}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force

echo ""
echo "==> Step 7: no orphans left behind"
assert_gone "consumer state still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
assert_gone "producer state still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"
wait_gone 6 "the imported-value SSM parameter still exists after destroy" \
  aws ssm get-parameter --name "${PARAMETER_NAME}" --region "${REGION}"
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
  assert_no_plaintext "the exports index after teardown" "${INDEX_AFTER}"
fi
pass "no orphan state, parameter, secret or exports-index entry"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# This fixture is the textbook case for why the sweep cannot live only in
# `cleanup`: the line below DISARMS the trap, so on the normal path `cleanup`
# never runs at all. The bucket is VERSIONED, so without this the producer's
# literal secret survives the run in every prior version of its state.json
# (issue #2096). `sweep` is called explicitly first, then the trap is disarmed
# so nothing can write a new delete marker after the count is taken.
echo ""
echo "==> Final teardown + state-version sweep"
sweep
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" "cross-stack-secret-import producer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" "cross-stack-secret-import consumer state teardown"

echo ""
echo "==> All cross-stack-secret-import assertions passed"
