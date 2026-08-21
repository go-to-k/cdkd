#!/usr/bin/env bash
#
# verify.sh — cdkd cross-region SECRET rollback-replay integ test (issue
# [#2057](https://github.com/go-to-k/cdkd/issues/2057)).
#
# THE DEFECT. Since issue #1934 a cross-stack consumer re-resolves a redacted
# `{{resolve:...}}` value in the PRODUCER's region and then records the
# PRODUCER's spelling of the expression into its OWN state.json. That spelling
# carries no region. `replayRollback` rebuilds its resolver from the consumer's
# region alone, so a rollback re-resolved the producer's reference LOCALLY and
# wrote whatever a same-named secret holds in the CONSUMER's region onto a live
# resource — silently, on the recovery path.
#
# THE DISCRIMINATOR. The same SecureString NAME is seeded in BOTH regions with
# DIFFERENT values. A fixture that seeded one value (or the same value twice)
# could not tell a correct resolution from a wrong-region one and would pass
# vacuously. Every value assertion below is against the PRODUCER region's
# value AND against the consumer region's value being absent.
#
# PHASES
#   0. Seed `/cdkd/rollback-xregion/shared-secret` as a SecureString in
#      us-west-2 and us-east-1 with different values; assert BOTH really came
#      back `Type=SecureString` (a `String` would make the whole secret arm
#      vacuous — nothing would be redacted) and that the two values differ.
#   1. Deploy the PRODUCER in us-west-2. Assert its state.outputs.SharedSecret
#      holds the EXPRESSION, not either plaintext (PR #1899 redaction).
#   2. Deploy the CONSUMER v1 in us-east-1. Assert (a) the live echo parameter
#      carries the PRODUCER region's value — the #1934 cross-region read — (b)
#      the consumer's state record for it holds the region-LESS expression and
#      neither plaintext, and (c) state.outputReads records
#      sourceRegion=us-west-2, which is the evidence the fix keys on.
#   2b/2b2/2c. The `cdkd drift` half (issue #2108), riding the CLEAN v1 deploy
#      rather than the journal. 2b: `drift --json` on the untouched stack must
#      mark SecretEcho `notCompared` + `referencesUnresolved` and exit 2 -- the
#      exit code is the signal a CI gate reads, and pre-#2108 this population
#      exited 1. The phase also asserts the run REPORTED a refusal, since the
#      exit code is scoped to refusals rather than to the whole `notCompared`
#      roll-up. 2b2: tamper TWO properties out of band (the secret-bearing
#      `Value` AND the ordinary `Description`) and assert the resource is now
#      DRIFTED on Description only, still flagged, exiting 1 -- without the
#      second property the resource stays `notCompared` and the revert below returns
#      early, exercising no revert code at all. 2c: `drift --revert -y` must
#      reach the per-resource refusal (`refused to re-resolve`, a string only
#      the revert path produces), write NOTHING, and exit 2.
#   3. Deploy the CONSUMER v2 (Description change + injected SQS failure) under
#      --no-rollback. Assert it FAILED, a journal exists, and the journal
#      carries an UPDATE op for the echo parameter — without that op the
#      rollback has nothing to replay and phase 4 would pass vacuously.
#   4. `cdkd rollback --force`. Assert exit code 2 (partial: one op refused,
#      journal kept), that the refusal names the parameter and BOTH regions,
#      and — THE LOAD-BEARING ASSERTION — that the live echo parameter STILL
#      holds the PRODUCER region's value. Pre-fix the rollback "succeeds" and
#      overwrites it with the CONSUMER region's secret.
#   5. Destroy the consumer, resetting it to a stack that has never read across
#      a region.
#   6. ARM B — the reachable case. Deploy the consumer with NO cross-region read
#      (assert `outputReads` is empty), then a deploy that BOTH introduces the
#      read AND fails. Assert the FAILED deploy persisted the read it just made
#      (before the union fix this was empty, because every non-success save
#      wrote the pre-deploy snapshot), then that `cdkd rollback` refuses.
#      ARM A cannot see this: its phase 2 establishes the evidence with a
#      SUCCESSFUL deploy first, which is why a green ARM A coexisted with a
#      completely inert fix.
#   7. Destroy both stacks, delete the seeded parameters in both regions, and
#      assert every AWS resource + state file is gone.
#
# Required env:
#   STATE_BUCKET — cdkd state bucket (account-scoped, e.g. cdkd-state-{accountId})
# Regions are PINNED (producer us-west-2, consumer us-east-1) regardless of
# AWS_REGION, because the CDK app pins `env.region` per stack.
#
# Run with `/run-integ rollback-cross-region-secret` — never by hand.
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

PRODUCER_STACK="CdkdRbXregionProducer"
CONSUMER_STACK="CdkdRbXregionConsumer"
PRODUCER_REGION="us-west-2"
CONSUMER_REGION="us-east-1"
PRODUCER_OUTPUT_NAME="SharedSecret"

SHARED_SECURE_PARAM="/cdkd/rollback-xregion/shared-secret"
PRODUCER_PROBE_PARAM="/cdkd/rollback-xregion/producer-probe"
ECHO_PARAM="/cdkd/rollback-xregion/echo"
# The consumer's OWN region-less secret reference (issue #2109) — see the phase 2d note.
LOCAL_SECRET_PARAM="/cdkd/rollback-xregion/local-secret"
FAILING_QUEUE_NAME="${CONSUMER_STACK}-failing-queue"

# Same NAME, two regions, two DIFFERENT values. Fake test data, but treated as
# secret throughout: never echoed, only compared.
PRODUCER_SECRET="cdkd-2057-producer-us-west-2"
CONSUMER_SECRET="cdkd-2057-consumer-us-east-1"
SHARED_EXPRESSION="{{resolve:ssm:${SHARED_SECURE_PARAM}}}"

PRODUCER_STATE_KEY="cdkd/${PRODUCER_STACK}/${PRODUCER_REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/state.json"
CONSUMER_JOURNAL_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/rollback-journal.json"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-cross-region-secret"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local cdkd binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi
CLI="node ${LOCAL_DIST}"

# Per-RUN scratch dir. A fixed /tmp path collides between two concurrent runs
# (each would read the other's rollback output and assert against it) and
# survives a crash; `cleanup` removes this one unconditionally.
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-2057-XXXXXX")"

echo "[verify] producer=${PRODUCER_STACK}@${PRODUCER_REGION} consumer=${CONSUMER_STACK}@${CONSUMER_REGION} state-bucket=${STATE_BUCKET}"

# Seed an `rc` so a signal-triggered cleanup does not read an unset variable as
# success and skip its own teardown.
rc=0
cleaned=0
cleanup() {
  rc=$?
  # The INT / TERM traps call `cleanup` and then `exit`, which re-fires the EXIT
  # trap — without this guard every signalled run tears down twice.
  if [ "${cleaned}" -eq 1 ]; then
    exit "${rc}"
  fi
  cleaned=1
  echo "[verify] cleanup (exit ${rc})"
  set +e
  rm -rf "${LOGDIR}"
  # Best-effort stack teardown first, each against its OWN region, so the
  # deployed parameters go with their stacks.
  AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
    --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  AWS_REGION="${PRODUCER_REGION}" ${CLI} destroy "${PRODUCER_STACK}" \
    --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  # Then direct AWS cleanup, in case destroy itself is what broke. This test
  # INTENTIONALLY fails a deploy, so the trap must not rely on a clean path.
  aws ssm delete-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${LOCAL_SECRET_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PRODUCER_PROBE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${SHARED_SECURE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${SHARED_SECURE_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  local q_url
  q_url="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${CONSUMER_REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)"
  if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${q_url}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  fi
  # State / journal / events sidecars for both stacks (events deliberately
  # survive destroy, and this run leaves a journal behind on purpose).
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER_STACK}/" --recursive >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER_STACK}/" --recursive >/dev/null 2>&1
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  echo "[verify] installing fixture deps"
  CI=true pnpm install --ignore-workspace --prefer-offline
fi

echo "[verify] pre-run sweep: drop anything stranded by an earlier failed run"
(
  set +e
  aws ssm delete-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${LOCAL_SECRET_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PRODUCER_PROBE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER_STACK}/" --recursive >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER_STACK}/" --recursive >/dev/null 2>&1
  exit 0
)

# ---------------------------------------------------------------------------
# PHASE 0: seed the SAME SecureString name in BOTH regions with DIFFERENT values
# ---------------------------------------------------------------------------
echo "[verify] phase 0: seed ${SHARED_SECURE_PARAM} as SecureString in both regions"
if [ "${PRODUCER_SECRET}" = "${CONSUMER_SECRET}" ]; then
  echo "FAIL: the two regions' seeded values are identical — the test could not discriminate" >&2
  exit 1
fi
aws ssm put-parameter --name "${SHARED_SECURE_PARAM}" --type SecureString \
  --value "${PRODUCER_SECRET}" --overwrite --region "${PRODUCER_REGION}" >/dev/null
aws ssm put-parameter --name "${SHARED_SECURE_PARAM}" --type SecureString \
  --value "${CONSUMER_SECRET}" --overwrite --region "${CONSUMER_REGION}" >/dev/null

# A parameter that silently came back `String` would resolve and pass every
# value assertion below while redacting NOTHING — the secret arm would be
# vacuous. Assert the type in both regions before deploying anything.
for region in "${PRODUCER_REGION}" "${CONSUMER_REGION}"; do
  SEED_TYPE="$(aws ssm get-parameter --name "${SHARED_SECURE_PARAM}" --region "${region}" \
    --query 'Parameter.Type' --output text)"
  if [ "${SEED_TYPE}" != "SecureString" ]; then
    echo "FAIL: ${SHARED_SECURE_PARAM} in ${region} has Type '${SEED_TYPE}', expected SecureString" >&2
    exit 1
  fi
done
echo "[verify]   ok: seeded SecureString in both regions, with different values"

# ---------------------------------------------------------------------------
# PHASE 1: producer in us-west-2
# ---------------------------------------------------------------------------
echo "[verify] phase 1: deploy ${PRODUCER_STACK} in ${PRODUCER_REGION}"
AWS_REGION="${PRODUCER_REGION}" ${CLI} deploy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

PRODUCER_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" -)"
PRODUCER_OUTPUT="$(printf '%s' "${PRODUCER_STATE}" | jq -r --arg k "${PRODUCER_OUTPUT_NAME}" '.outputs[$k] // empty')"
if [ "${PRODUCER_OUTPUT}" != "${SHARED_EXPRESSION}" ]; then
  echo "FAIL: producer output '${PRODUCER_OUTPUT_NAME}' is '${PRODUCER_OUTPUT}', expected the redacted expression '${SHARED_EXPRESSION}'" >&2
  exit 1
fi
if printf '%s' "${PRODUCER_STATE}" | grep -q "${PRODUCER_SECRET}"; then
  echo "FAIL: producer state.json holds the resolved SecureString plaintext (it must stay redacted)" >&2
  exit 1
fi
echo "[verify]   ok: producer state keeps the output REDACTED as the expression"

# ---------------------------------------------------------------------------
# PHASE 2: consumer v1 in us-east-1, reading the producer output cross-region
# ---------------------------------------------------------------------------
echo "[verify] phase 2: deploy ${CONSUMER_STACK} v1 in ${CONSUMER_REGION} (reads ${PRODUCER_REGION} cross-region)"
MARKER_VALUE=v1 WITH_XREGION=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

ECHO_VALUE="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${ECHO_VALUE}" != "${PRODUCER_SECRET}" ]; then
  if [ "${ECHO_VALUE}" = "${CONSUMER_SECRET}" ]; then
    echo "FAIL: the cross-region read resolved the CONSUMER region's secret — issue #1934 is regressed, so this fixture cannot test #2057" >&2
  else
    echo "FAIL: echo parameter holds an unexpected value after the v1 deploy" >&2
  fi
  exit 1
fi
echo "[verify]   ok: live echo parameter carries the PRODUCER region's secret"

CONSUMER_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)"
# Selected by the resource's real AWS NAME, never by logical id.
RECORDED_VALUE="$(printf '%s' "${CONSUMER_STATE}" | jq -r --arg pid "${ECHO_PARAM}" \
  '[.resources | to_entries[] | select(.value.physicalId == $pid) | .value.properties.Value] | first // empty')"
if [ "${RECORDED_VALUE}" != "${SHARED_EXPRESSION}" ]; then
  echo "FAIL: consumer state records Value '${RECORDED_VALUE}', expected the region-less expression '${SHARED_EXPRESSION}'" >&2
  exit 1
fi
for secret in "${PRODUCER_SECRET}" "${CONSUMER_SECRET}"; do
  if printf '%s' "${CONSUMER_STATE}" | grep -q "${secret}"; then
    echo "FAIL: consumer state.json holds a resolved SecureString plaintext (it must stay redacted)" >&2
    exit 1
  fi
done
echo "[verify]   ok: consumer state holds the region-LESS expression and no plaintext"

# The evidence the fix keys on: without a foreign producer region on record the
# refusal cannot fire, so assert it landed before relying on it in phase 4.
OUTPUT_READ_REGIONS="$(printf '%s' "${CONSUMER_STATE}" | jq -r --arg s "${PRODUCER_STACK}" \
  '[.outputReads[]? | select(.sourceStack == $s) | .sourceRegion] | unique | join(",")')"
if [ "${OUTPUT_READ_REGIONS}" != "${PRODUCER_REGION}" ]; then
  echo "FAIL: consumer state.outputReads records producer region(s) '${OUTPUT_READ_REGIONS}', expected '${PRODUCER_REGION}'" >&2
  printf '%s' "${CONSUMER_STATE}" | jq '.outputReads' >&2
  exit 1
fi
echo "[verify]   ok: consumer state.outputReads records sourceRegion=${PRODUCER_REGION}"

# ---------------------------------------------------------------------------
# PHASE 2b: `cdkd drift` must not baseline a cross-region secret LOCALLY
#           (issue #2108 -- the drift.ts twin of the replay defect below)
# ---------------------------------------------------------------------------
# This arm rides the CLEAN v1 deploy rather than the journal, because that is
# precisely what makes #2108 wider than #2057: the defect is reachable from an
# ORDINARY drift run, not only after a failed deploy. The discriminator is the
# same one phase 0 already seeded -- one NAME, two regions, two DIFFERENT
# values -- so a run where both regions agreed could not tell a correct
# resolution from a wrong one.
#
# Pre-fix, `resolveStateSecretExpressions` built its resolvers from the
# CONSUMER's region, so the state baseline for `SecretEcho.Value` resolved to
# ${CONSUMER_SECRET} and `--revert` pushed THAT onto the live parameter.
echo "[verify] phase 2b: 'cdkd drift' refuses to baseline the cross-region secret locally"

# Every artifact of this arm lives under LOGDIR, which `cleanup` removes
# unconditionally on EXIT / INT / TERM. A bare `mktemp` was registered with
# nothing, so a `set -e` abort between the create and the `rm -f` left a
# state-derived payload sitting in /tmp for whoever looks next.
DRIFT_CLEAN_JSON="${LOGDIR}/drift-clean.json"
DRIFT_CLEAN_ERR="${LOGDIR}/drift-clean.err"
DRIFT_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --json >"${DRIFT_CLEAN_JSON}" 2>"${DRIFT_CLEAN_ERR}" || DRIFT_RC=$?

# Scan for plaintext BEFORE any assertion that can DUMP a payload to stderr.
# Here the two seeded values are committed literals so a dump is harmless, but
# this fixture is the shape a future secret-flow fixture will copy, and with a
# randomly generated secret a failure dump would put the plaintext into the CI
# log on exactly the regression run that matters.
# The wrong-region plaintext must never reach the report or the --json payload:
# pre-fix it became the `secrets` needle, so it was both the value compared
# against AND the string redaction was hunting for.
assert_no_plaintext() { # usage: assert_no_plaintext <label> <file>...
  local label="$1"
  shift
  local secret file
  for secret in "${PRODUCER_SECRET}" "${CONSUMER_SECRET}"; do
    for file in "$@"; do
      if grep -qF "${secret}" "${file}"; then
        echo "FAIL: ${label} carries a SecureString plaintext" >&2
        exit 1
      fi
    done
  done
  echo "[verify]   ok: no plaintext in ${label}"
}
assert_no_plaintext "the drift --json payload + stderr" "${DRIFT_CLEAN_JSON}" "${DRIFT_CLEAN_ERR}"

# Recursive descent so the assertion does not depend on whether the report is
# wrapped in a `stacks[]` array.
NOT_COMPARED="$(jq -r '[.. | objects | select(has("notCompared")) | .notCompared[]?.logicalId] | unique | join(",")' \
  "${DRIFT_CLEAN_JSON}")"
case ",${NOT_COMPARED}," in
  *,SecretEcho,*)
    echo "[verify]   ok: SecretEcho reported notCompared (drift rc=${DRIFT_RC})"
    ;;
  *)
    echo "FAIL: drift --json did not mark SecretEcho notCompared (got '${NOT_COMPARED}') -- a refused comparison is being reported as clean" >&2
    jq '.' "${DRIFT_CLEAN_JSON}" >&2 || cat "${DRIFT_CLEAN_JSON}" >&2
    exit 1
    ;;
esac

# Second positive marker, on the resource entry itself rather than the roll-up.
REFS_UNRESOLVED="$(jq -r '[.. | objects | select(.logicalId == "SecretEcho") | .referencesUnresolved] | any' "${DRIFT_CLEAN_JSON}")"
if [ "${REFS_UNRESOLVED}" != "true" ]; then
  echo "FAIL: SecretEcho's drift entry does not carry referencesUnresolved=true (got '${REFS_UNRESOLVED}')" >&2
  jq '.' "${DRIFT_CLEAN_JSON}" >&2 || cat "${DRIFT_CLEAN_JSON}" >&2
  exit 1
fi
echo "[verify]   ok: SecretEcho carries referencesUnresolved=true"

# THE #2135 DISCRIMINATOR. Everything asserted above passes under the PRE-#2135
# shape too: issue #2108 already emitted a derived `notCompared[]` roll-up and
# the same exit code, so those assertions are a regression net for #2108 rather
# than evidence about this change. What #2135 actually altered is MEMBERSHIP --
# a refused resource used to be the `clean` outcome variant carrying a
# `referencesUnresolved: true` rider, and is now its own outcome, so it must no
# longer appear in `clean[]` at all. That is the one user-visible payload delta,
# and it is asserted here rather than left to the unit suite.
#
# Stated as a POSITIVE fact about the array (`clean[]` was emitted, and its
# membership is exactly what it should be) rather than as a bare absence: a run
# that stopped before writing `clean[]`, or a jq path typo, would satisfy a
# plain "SecretEcho is not in clean" and report success having compared nothing.
CLEAN_IDS="$(jq -r '[.. | objects | select(has("clean")) | .clean[]?.logicalId] | unique | join(",")' \
  "${DRIFT_CLEAN_JSON}")"
if ! jq -e '[.. | objects | select(has("clean"))] | length > 0' "${DRIFT_CLEAN_JSON}" >/dev/null; then
  echo "FAIL: drift --json emitted no clean[] array at all -- the absence assertion below would be vacuous" >&2
  jq '.' "${DRIFT_CLEAN_JSON}" >&2 || cat "${DRIFT_CLEAN_JSON}" >&2
  exit 1
fi
case ",${CLEAN_IDS}," in
  *,SecretEcho,*)
    echo "FAIL: SecretEcho is STILL in clean[] (got '${CLEAN_IDS}') -- pre-#2135 behaviour: a resource whose comparison was refused is being reported as clean-plus-a-flag" >&2
    jq '.' "${DRIFT_CLEAN_JSON}" >&2 || cat "${DRIFT_CLEAN_JSON}" >&2
    exit 1
    ;;
  *)
    echo "[verify]   ok: SecretEcho is absent from clean[] (clean=[${CLEAN_IDS}]) -- notCompared is a first-class outcome, not a rider on clean"
    ;;
esac

# THIRD marker, and the one a CI gate actually reads. Nothing drifted here, so
# the exit code is the only thing standing between "cdkd compared everything and
# found nothing" and "cdkd never compared the one property that could differ".
# 2 is this repo's "work completed but something was SKIPPED" code. Pre-#2108
# this population exited 1 (it reported phantom drift), so a non-zero exit
# PRESERVES what CI consumers already had -- 0 would be the silent downgrade.
#
# The exit code is scoped to comparisons cdkd REFUSED, which is a strict subset
# of the `notCompared` roll-up asserted above: a resource whose only uncompared
# property holds a surviving `{{resolve:ssm-secure:...}}` token is rolled up and
# still exits 0, because cdkd resolves that spelling for nobody and the
# condition can never clear. This fixture's SecretEcho IS a refusal (the
# resolution THREW on the region ambiguity), so 2 is the expected code -- but
# assert WHY rather than trusting the number, since a 2 arriving from the wider
# bucket would mean the narrowing had been lost.
if ! grep -q 'refused to resolve' "${DRIFT_CLEAN_ERR}"; then
  echo "FAIL: the drift run did not report a REFUSAL, so an exit 2 here would not be coming from the population the exit code is scoped to" >&2
  sed 's/^/  /' "${DRIFT_CLEAN_ERR}" >&2
  exit 1
fi
if [ "${DRIFT_RC}" -ne 2 ]; then
  echo "FAIL: drift exited ${DRIFT_RC} on a stack whose only secret-bearing property was REFUSED; expected 2 (1 would mean something drifted, 0 that the refusal is being reported as a pass)" >&2
  jq '.' "${DRIFT_CLEAN_JSON}" >&2 || cat "${DRIFT_CLEAN_JSON}" >&2
  exit 1
fi
echo "[verify]   ok: drift exited 2, and the run says it REFUSED (not merely did not compare)"

# ---------------------------------------------------------------------------
# PHASE 2b2 + 2c: the arm that WRITES
# ---------------------------------------------------------------------------
# TWO properties are tampered, and the SECOND one is what makes this arm run at
# all. `SecretEcho`'s only secret-bearing property is `Value`, whose STATE side
# is the `{{resolve:ssm:...}}` token the comparator SKIPS -- so tampering `Value`
# alone leaves the resource `notCompared` (issue #2135; it was `clean` plus a
# `referencesUnresolved` flag before), `drifted` empty, and `runRevert` returns
# early with "nothing to revert". The whole phase then issued live writes for
# zero signal, which is exactly why a real-AWS mutation probe of it came back
# green. `Description` is an ordinary non-secret property of the SAME resource,
# so tampering it makes the resource genuinely drifted, the revert actually runs,
# and it reaches the secret leaf and refuses there. The unit tests use this same
# shape (a tampered public env var beside a refused secret one).
#
# `Description` is passed EXPLICITLY rather than relying on PutParameter's
# overwrite semantics for an omitted optional field: this arm's premise must be
# a property this fixture sets, not a side effect of what AWS does with a field
# nobody named.
TAMPER_SENTINEL="cdkd-2108-tampered-do-not-resolve"
TAMPER_DESCRIPTION="cdkd-2108-tampered-description"
ECHO_DESCRIPTION_V1="cross-region secret echo (v1)"
aws ssm put-parameter --name "${ECHO_PARAM}" --value "${TAMPER_SENTINEL}" \
  --type String --description "${TAMPER_DESCRIPTION}" \
  --overwrite --region "${CONSUMER_REGION}" >/dev/null

echo_description() { # the live Description; get-parameter does not return it
  aws ssm describe-parameters --region "${CONSUMER_REGION}" \
    --parameter-filters "Key=Name,Values=${ECHO_PARAM}" \
    --query 'Parameters[0].Description' --output text
}
LIVE_DESCRIPTION="$(echo_description)"
if [ "${LIVE_DESCRIPTION}" != "${TAMPER_DESCRIPTION}" ]; then
  echo "FAIL: the out-of-band tamper did not take -- live Description is '${LIVE_DESCRIPTION}', expected '${TAMPER_DESCRIPTION}'. Phase 2c would exercise no revert code at all." >&2
  exit 1
fi
echo "[verify]   ok: tampered both Value (secret-bearing) and Description (ordinary)"

# PHASE 2b2: prove the revert has something to do BEFORE running it. Without
# this the phase can go silently inert again -- a `clean` resource makes
# `--revert` a no-op that still exits 0 and still passes every assertion below.
echo "[verify] phase 2b2: the tampered resource is DRIFTED and still only PARTIALLY compared"
DRIFT_TAMPERED_JSON="${LOGDIR}/drift-tampered.json"
DRIFT_TAMPERED_ERR="${LOGDIR}/drift-tampered.err"
DRIFT2_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --json >"${DRIFT_TAMPERED_JSON}" 2>"${DRIFT_TAMPERED_ERR}" || DRIFT2_RC=$?
assert_no_plaintext "the tampered-run --json payload + stderr" "${DRIFT_TAMPERED_JSON}" "${DRIFT_TAMPERED_ERR}"

DRIFTED_PATHS="$(jq -r '[.. | objects | select(has("drifted")) | .drifted[]? | select(.logicalId == "SecretEcho") | .changes[]?.path] | join(",")' \
  "${DRIFT_TAMPERED_JSON}")"
case ",${DRIFTED_PATHS}," in
  *,Description,*)
    echo "[verify]   ok: SecretEcho is drifted on Description (paths: ${DRIFTED_PATHS})"
    ;;
  *)
    echo "FAIL: SecretEcho does not report a Description drift (got '${DRIFTED_PATHS}') -- the revert below would return early and this phase would exercise NO revert code" >&2
    jq '.' "${DRIFT_TAMPERED_JSON}" >&2 || cat "${DRIFT_TAMPERED_JSON}" >&2
    exit 1
    ;;
esac

# The tampered `Value` must NOT be among them: its state side is the
# `{{resolve:...}}` token, so a reported change there would mean cdkd compared
# the token against the live plaintext -- the phantom drift #2108 removes.
case ",${DRIFTED_PATHS}," in
  *,Value,*)
    echo "FAIL: SecretEcho reports a Value drift -- the secret-bearing property is being compared after a refusal" >&2
    exit 1
    ;;
esac

# The flag on a DRIFTED entry, which the clean run above cannot reach: the
# changes it DOES report are real, and a consumer must still not read them as
# the whole comparison.
REFS2="$(jq -r '[.. | objects | select(.logicalId == "SecretEcho") | .referencesUnresolved] | any' "${DRIFT_TAMPERED_JSON}")"
if [ "${REFS2}" != "true" ]; then
  echo "FAIL: the DRIFTED SecretEcho entry does not carry referencesUnresolved=true (got '${REFS2}')" >&2
  exit 1
fi
# Drift wins the exit code: a consumer gating on 1 must not lose a detection it
# gets today just because the same run also refused a secret comparison.
if [ "${DRIFT2_RC}" -ne 1 ]; then
  echo "FAIL: drift exited ${DRIFT2_RC} with a drifted resource on record; expected 1 (2 would mean the refusal outranked a real detection)" >&2
  exit 1
fi
echo "[verify]   ok: drifted + partially compared exits 1, flag present on the drifted entry"

echo "[verify] phase 2c: 'cdkd drift --revert' must not write a foreign region's secret"
REVERT_LOG="${LOGDIR}/revert.log"
REVERT_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CONSUMER_STACK}" --revert -y \
  --state-bucket "${STATE_BUCKET}" >"${REVERT_LOG}" 2>&1 || REVERT_RC=$?
assert_no_plaintext "the revert output" "${REVERT_LOG}"

# THE DISCRIMINATOR for this phase, and it is POSITIVE: this string is produced
# ONLY by the revert path's refusal branch. The detection path says "refused to
# resolve"; only the revert says "re-resolve", and it is reached after
# `runRevert` has already decided the resource needs updating. A phase that
# returned early at "nothing to revert" cannot print it.
if ! grep -q 'refused to re-resolve' "${REVERT_LOG}"; then
  echo "FAIL: the revert never reached the per-resource refusal branch -- it either returned early (nothing drifted) or resolved the reference in the wrong region" >&2
  sed 's/^/  /' "${REVERT_LOG}" >&2
  exit 1
fi
# Named by the refusal so the message is actionable, and both regions so the
# ambiguity it refuses is legible.
for needle in "${SHARED_SECURE_PARAM}" "${PRODUCER_REGION}" "${CONSUMER_REGION}"; do
  if ! grep -qF "${needle}" "${REVERT_LOG}"; then
    echo "FAIL: the revert refusal does not name '${needle}'" >&2
    sed 's/^/  /' "${REVERT_LOG}" >&2
    exit 1
  fi
done
# Partial failure: the resource never reached provider.update, so the run is
# counted as one unresolvable resource and exits 2.
if [ "${REVERT_RC}" -ne 2 ]; then
  echo "FAIL: drift --revert exited ${REVERT_RC}, expected 2 (one resource refused, nothing written)" >&2
  sed 's/^/  /' "${REVERT_LOG}" >&2
  exit 1
fi
echo "[verify]   ok: the revert reached the refusal branch and exited 2"

POST_REVERT="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
# A SAFETY NET, deliberately NOT this arm's discriminator -- and that distinction
# is measured, not assumed. Running this fixture against real AWS with the region
# routing mutated back to pre-fix behaviour (every verdict forced to `local`) left
# this very assertion GREEN: the revert exited 2 instead of writing, so "the live
# value is not the consumer region's secret" is a confluence point that a correct
# refusal and an unrelated revert failure both produce. The discriminators are the
# positive markers asserted above; this check only guarantees that whatever else
# happens, the foreign plaintext never lands on the live resource.
if [ "${POST_REVERT}" = "${CONSUMER_SECRET}" ]; then
  echo "FAIL: drift --revert wrote the CONSUMER region's secret onto the live parameter (issue #2108 regressed)" >&2
  exit 1
fi
# Nothing was written AT ALL: the refusal returns before provider.update, so the
# non-secret property the revert was about is still tampered. This is what
# separates "refused" from "reverted everything except the secret".
POST_REVERT_DESCRIPTION="$(echo_description)"
if [ "${POST_REVERT_DESCRIPTION}" != "${TAMPER_DESCRIPTION}" ]; then
  echo "FAIL: the revert wrote Description ('${POST_REVERT_DESCRIPTION}') -- the refusal is expected to abandon the whole resource before provider.update" >&2
  exit 1
fi
echo "[verify]   ok: nothing was written to the live parameter (revert rc=${REVERT_RC})"

# Restore BOTH tampered properties, so phases 3+ start from exactly the state
# phase 2 left behind. Description is restored explicitly for the same reason it
# was tampered explicitly -- phase 3's v1 -> v2 UPDATE is a Description change,
# and starting it from a tampered value would measure a different delta.
aws ssm put-parameter --name "${ECHO_PARAM}" --value "${PRODUCER_SECRET}" \
  --type String --description "${ECHO_DESCRIPTION_V1}" \
  --overwrite --region "${CONSUMER_REGION}" >/dev/null
RESTORED="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
RESTORED_DESCRIPTION="$(echo_description)"
if [ "${RESTORED}" != "${PRODUCER_SECRET}" ] || [ "${RESTORED_DESCRIPTION}" != "${ECHO_DESCRIPTION_V1}" ]; then
  echo "FAIL: could not restore the echo parameter after the #2108 arm (value='${RESTORED}', description='${RESTORED_DESCRIPTION}'); later phases would be measuring the wrong baseline" >&2
  exit 1
fi
echo "[verify]   ok: echo parameter restored for the rollback arms"

# ---------------------------------------------------------------------------
# PHASE 2d: `cdkd scrub` must REFUSE a region-ambiguous reference, not report
#           success over a state file it could not scrub (issue #2109)
# ---------------------------------------------------------------------------
# WHY THIS ARM LIVES HERE AND NOT ON A SCRUB-SHAPED FIXTURE. `cdkd scrub` builds
# its plaintext -> expression needle map by resolving the TEMPLATE, so it can
# only classify a reference that is a LITERAL `{{resolve:...}}` there. Neither
# stack on its own puts the literal and the evidence together: the PRODUCER's
# template carries the literal but has no cross-stack read on record, so the
# classifier answers `local`; the CONSUMER has the foreign `outputReads` but its
# leaf is an `Fn::GetStackOutput` intrinsic with no literal at all. `LocalSecretEcho`
# exists to close exactly that -- a region-LESS literal in the stack that DOES
# carry foreign evidence. Without it a scrub arm here would pass with the fix
# reverted.
echo "[verify] phase 2d: 'cdkd scrub' refuses the region-ambiguous reference"

SCRUB_STATE_BEFORE="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - | shasum -a 256 | cut -d' ' -f1)"
SCRUB_LOG="${LOGDIR}/scrub-consumer.log"
SCRUB_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} scrub "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" >"${SCRUB_LOG}" 2>&1 || SCRUB_RC=$?

assert_no_plaintext "scrub output" "${SCRUB_LOG}"

# Silently succeeding is the one outcome this issue says must not survive, so a
# zero exit is the failure -- not merely an unexpected value.
if [ "${SCRUB_RC}" -eq 0 ]; then
  echo "FAIL: cdkd scrub exited 0 over a state file it could not re-resolve — issue #2109 regressed" >&2
  cat "${SCRUB_LOG}" >&2
  exit 1
fi

# POSITIVE discriminator: the refusal must be the REGION one, naming the
# reference and the producer region it could have come from. A non-zero exit
# alone is a confluence point -- any scrub failure produces it.
if ! grep -qF "cannot re-resolve the secret reference" "${SCRUB_LOG}"; then
  echo "FAIL: scrub exited ${SCRUB_RC} but not with the region-ambiguity refusal" >&2
  cat "${SCRUB_LOG}" >&2
  exit 1
fi
for needle in "${SHARED_SECURE_PARAM}" "${PRODUCER_REGION}"; do
  if ! grep -qF "${needle}" "${SCRUB_LOG}"; then
    echo "FAIL: the scrub refusal does not name '${needle}'" >&2
    cat "${SCRUB_LOG}" >&2
    exit 1
  fi
done
echo "[verify]   ok: scrub refused (rc=${SCRUB_RC}), naming the reference and ${PRODUCER_REGION}"

# A refusal must leave the document alone. Pre-fix scrub REWROTE state using a
# needle resolved in the wrong region.
SCRUB_STATE_AFTER="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - | shasum -a 256 | cut -d' ' -f1)"
if [ "${SCRUB_STATE_BEFORE}" != "${SCRUB_STATE_AFTER}" ]; then
  echo "FAIL: the refusing scrub still rewrote consumer state.json" >&2
  exit 1
fi
echo "[verify]   ok: consumer state.json is byte-identical after the refusal"

# NEGATIVE arm, and it is what stops the assertions above from passing on a
# scrub that refuses everything: the PRODUCER carries the same region-less
# literal but has NO cross-stack read on record, so the classifier must answer
# `local` and scrub must complete normally.
PROD_SCRUB_LOG="${LOGDIR}/scrub-producer.log"
PROD_SCRUB_RC=0
AWS_REGION="${PRODUCER_REGION}" ${CLI} scrub "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" >"${PROD_SCRUB_LOG}" 2>&1 || PROD_SCRUB_RC=$?
assert_no_plaintext "producer scrub output" "${PROD_SCRUB_LOG}"
if grep -qF "cannot re-resolve the secret reference" "${PROD_SCRUB_LOG}"; then
  echo "FAIL: scrub refused the PRODUCER, which has no foreign producer region on record — the refusal is firing on everything" >&2
  cat "${PROD_SCRUB_LOG}" >&2
  exit 1
fi
echo "[verify]   ok: the producer scrubs normally (rc=${PROD_SCRUB_RC}) — the refusal is scoped to foreign evidence"

# ---------------------------------------------------------------------------
# PHASE 3: failing consumer v2 under --no-rollback -> a journal to replay
# ---------------------------------------------------------------------------
echo "[verify] phase 3: deploy ${CONSUMER_STACK} v2 (Description change + INJECT_FAIL) --no-rollback (expect FAILURE)"
set +e
MARKER_VALUE=v2 WITH_XREGION=true INJECT_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback --yes > "${LOGDIR}/v2-deploy.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/v2-deploy.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the v2 --no-rollback deploy unexpectedly SUCCEEDED (rc=0) — no journal to replay" >&2
  exit 1
fi
echo "[verify]   ok: v2 --no-rollback deploy failed (rc=${DEPLOY_RC})"

if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "FAIL: no rollback journal at s3://${STATE_BUCKET}/${CONSUMER_JOURNAL_KEY}" >&2
  exit 1
fi
JOURNAL="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_JOURNAL_KEY}" -)"
# Without a completed UPDATE op for the echo parameter there is nothing for the
# replay to re-resolve, and phase 4 would pass without exercising anything.
JOURNAL_OPS="$(printf '%s' "${JOURNAL}" | jq -r --arg pid "${ECHO_PARAM}" \
  '[.segments[]?.operations[]? | select((.physicalId // .previousState.physicalId) == $pid) | .changeType] | join(",")')"
if [ "${JOURNAL_OPS}" != "UPDATE" ]; then
  echo "FAIL: journal records op(s) '${JOURNAL_OPS}' for the echo parameter, expected exactly 'UPDATE'" >&2
  printf '%s' "${JOURNAL}" | jq '.segments[]?.operations' >&2
  exit 1
fi
# The journaled previous properties must carry the region-LESS expression —
# that string is the input the replay re-resolves, so if it were already
# plaintext the rollback would have nothing to get wrong.
JOURNAL_PREV_VALUE="$(printf '%s' "${JOURNAL}" | jq -r --arg pid "${ECHO_PARAM}" \
  '[.segments[]?.operations[]? | select((.physicalId // .previousState.physicalId) == $pid) | .previousState.properties.Value] | first // empty')"
if [ "${JOURNAL_PREV_VALUE}" != "${SHARED_EXPRESSION}" ]; then
  echo "FAIL: journaled previous Value is '${JOURNAL_PREV_VALUE}', expected the region-less expression" >&2
  exit 1
fi
echo "[verify]   ok: journal carries an UPDATE op whose previous Value is the region-less expression"

MID_ECHO_VALUE="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${MID_ECHO_VALUE}" != "${PRODUCER_SECRET}" ]; then
  echo "FAIL: after the v2 deploy the echo parameter no longer holds the producer's secret" >&2
  exit 1
fi
MID_ECHO_DESC="$(aws ssm describe-parameters --region "${CONSUMER_REGION}" \
  --parameter-filters "Key=Name,Values=${ECHO_PARAM}" \
  --query 'Parameters[0].Description' --output text)"
if [ "${MID_ECHO_DESC}" != "cross-region secret echo (v2)" ]; then
  echo "FAIL: after the v2 deploy the echo Description is '${MID_ECHO_DESC}', expected 'cross-region secret echo (v2)' — the UPDATE did not land" >&2
  exit 1
fi
echo "[verify]   ok: the v2 UPDATE landed (Description=v2) and the value is still the producer's"

# ---------------------------------------------------------------------------
# PHASE 4: cdkd rollback — must REFUSE the region-ambiguous replay
# ---------------------------------------------------------------------------
echo "[verify] phase 4: cdkd rollback ${CONSUMER_STACK} --force (expect exit 2 = partial)"
set +e
AWS_REGION="${CONSUMER_REGION}" ${CLI} rollback "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${CONSUMER_REGION}" --force \
  > "${LOGDIR}/rollback.log" 2>&1
ROLLBACK_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/rollback.log" || true
if [ "${ROLLBACK_RC}" -ne 2 ]; then
  echo "FAIL: cdkd rollback exited ${ROLLBACK_RC}, expected 2 (partial — one op refused, journal kept)" >&2
  exit 1
fi
echo "[verify]   ok: rollback exited 2 (partial)"

for needle in \
  'cannot re-resolve the secret reference' \
  "${SHARED_SECURE_PARAM}" \
  "${PRODUCER_REGION}" \
  "${CONSUMER_REGION}"; do
  if ! grep -qF -- "${needle}" "${LOGDIR}/rollback.log"; then
    echo "FAIL: the rollback refusal does not mention '${needle}'" >&2
    exit 1
  fi
done
echo "[verify]   ok: the refusal names the reference and BOTH regions"

# Neither region's plaintext may appear in the refusal output.
for secret in "${PRODUCER_SECRET}" "${CONSUMER_SECRET}"; do
  if grep -qF -- "${secret}" "${LOGDIR}/rollback.log"; then
    echo "FAIL: the rollback output leaked a SecureString plaintext" >&2
    exit 1
  fi
done
echo "[verify]   ok: no plaintext in the rollback output"

# THE LOAD-BEARING ASSERTION. Pre-fix the replay resolved the producer's
# region-less expression against us-east-1 and PutParameter'd the consumer
# region's secret over the live value (SSMParameterProvider.update always
# re-sends Value with Overwrite: true).
POST_ECHO_VALUE="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${POST_ECHO_VALUE}" = "${CONSUMER_SECRET}" ]; then
  echo "FAIL: the rollback replaced the live value with the CONSUMER region's secret — issue #2057, the exact wrong-region write this test exists to catch" >&2
  exit 1
fi
if [ "${POST_ECHO_VALUE}" != "${PRODUCER_SECRET}" ]; then
  echo "FAIL: after the refused rollback the echo parameter holds neither region's seeded value" >&2
  exit 1
fi
echo "[verify]   ok: the live value is STILL the producer region's secret"

# The refused op must NOT have applied its other properties either.
POST_ECHO_DESC="$(aws ssm describe-parameters --region "${CONSUMER_REGION}" \
  --parameter-filters "Key=Name,Values=${ECHO_PARAM}" \
  --query 'Parameters[0].Description' --output text)"
if [ "${POST_ECHO_DESC}" != "cross-region secret echo (v2)" ]; then
  echo "FAIL: the refused rollback still applied the revert (Description is '${POST_ECHO_DESC}')" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "FAIL: the journal was deleted after a partial rollback — a re-run would have nothing to retry" >&2
  exit 1
fi
echo "[verify]   ok: the revert did not apply and the journal is preserved for a re-run"

# ---------------------------------------------------------------------------
# PHASE 5: reset the consumer, so ARM B starts from a stack that has never
# read across a region.
# ---------------------------------------------------------------------------
echo "[verify] phase 5: destroy ${CONSUMER_STACK} (${CONSUMER_REGION}) — arm A done"
AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --force

assert_gone "echo parameter ${ECHO_PARAM} still exists after destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}"
assert_gone "local-secret parameter ${LOCAL_SECRET_PARAM} still exists after destroy" \
  aws ssm get-parameter --name "${LOCAL_SECRET_PARAM}" --region "${CONSUMER_REGION}"
assert_gone "consumer state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"


# ---------------------------------------------------------------------------
# PHASE 6 (ARM B): the cross-region read is INTRODUCED BY THE FAILING DEPLOY.
#
# This is the reachable case, and the one a green ARM A coexisted with a
# completely inert fix for. A rollback journal exists ONLY after a failed
# deploy, and every non-success state save used to persist the PRE-deploy
# `outputReads` snapshot — so on the deploy that first reads across a region,
# the evidence the refusal needs was never written, `classifyReplaySecretRegion`
# answered `local`, and the replay re-resolved the producer's region-less
# expression in the consumer's region.
#
# ARM A cannot see that: its phase 2 establishes `outputReads` with a SUCCESSFUL
# deploy before anything fails.
# ---------------------------------------------------------------------------
echo "[verify] phase 6a: deploy ${CONSUMER_STACK} v1 with NO cross-region read"
MARKER_VALUE=v1 AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

LOCAL_ONLY_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)"
LOCAL_ONLY_READS="$(printf '%s' "${LOCAL_ONLY_STATE}" | jq -r '(.outputReads // []) | length')"
if [ "${LOCAL_ONLY_READS}" != "0" ]; then
  echo "FAIL: the local-only deploy recorded ${LOCAL_ONLY_READS} outputRead(s); arm B needs a stack that has never read across a region" >&2
  printf '%s' "${LOCAL_ONLY_STATE}" | jq '.outputReads' >&2
  exit 1
fi
BASE_ECHO_VALUE="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${BASE_ECHO_VALUE}" != "local-literal-no-cross-region-read" ]; then
  echo "FAIL: the local-only echo value is '${BASE_ECHO_VALUE}', expected the literal" >&2
  exit 1
fi
echo "[verify]   ok: no cross-stack read on record, echo holds the local literal"

echo "[verify] phase 6b: deploy v2 that BOTH introduces the cross-region read AND fails"
set +e
MARKER_VALUE=v2 WITH_XREGION=true INJECT_FAIL=true AWS_REGION="${CONSUMER_REGION}" \
  ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback --yes > "${LOGDIR}/armb-deploy.log" 2>&1
ARMB_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/armb-deploy.log" || true
if [ "${ARMB_RC}" -eq 0 ]; then
  echo "FAIL: the arm-B deploy unexpectedly SUCCEEDED (rc=0) — no journal to replay" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "FAIL: no rollback journal after the arm-B deploy" >&2
  exit 1
fi

# The echo UPDATE completed before the queue failed, so the live parameter now
# carries the PRODUCER region's secret.
ARMB_ECHO_VALUE="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${ARMB_ECHO_VALUE}" != "${PRODUCER_SECRET}" ]; then
  echo "FAIL: after the arm-B deploy the echo parameter does not hold the producer's secret — the UPDATE that introduces the read did not complete, so there is nothing to roll back" >&2
  exit 1
fi

# THE ARM-B DISCRIMINATOR, half one: the FAILED deploy must have persisted the
# read it just made. Before the union fix this came back 0 and the refusal in
# phase 6c could not fire at all.
ARMB_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" -)"
ARMB_READ_REGIONS="$(printf '%s' "${ARMB_STATE}" | jq -r --arg s "${PRODUCER_STACK}" \
  '[.outputReads[]? | select(.sourceStack == $s) | .sourceRegion] | unique | join(",")')"
if [ "${ARMB_READ_REGIONS}" != "${PRODUCER_REGION}" ]; then
  echo "FAIL: the FAILED deploy persisted producer region(s) '${ARMB_READ_REGIONS}', expected '${PRODUCER_REGION}' — a non-success save is dropping this session's cross-stack reads (issue #2057 blocker)" >&2
  printf '%s' "${ARMB_STATE}" | jq '.outputReads' >&2
  exit 1
fi
echo "[verify]   ok: the FAILED deploy recorded sourceRegion=${PRODUCER_REGION}"

echo "[verify] phase 6c: cdkd rollback ${CONSUMER_STACK} --force (expect exit 2 = partial)"
set +e
AWS_REGION="${CONSUMER_REGION}" ${CLI} rollback "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${CONSUMER_REGION}" --force \
  > "${LOGDIR}/armb-rollback.log" 2>&1
ARMB_ROLLBACK_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/armb-rollback.log" || true
if [ "${ARMB_ROLLBACK_RC}" -ne 2 ]; then
  echo "FAIL: arm-B rollback exited ${ARMB_ROLLBACK_RC}, expected 2 — the read this deploy introduced was not on record, so the replay resolved it in '${CONSUMER_REGION}'" >&2
  exit 1
fi
if ! grep -qF -- 'cannot re-resolve the secret reference' "${LOGDIR}/armb-rollback.log"; then
  echo "FAIL: the arm-B rollback did not refuse the region-ambiguous reference" >&2
  exit 1
fi
for secret in "${PRODUCER_SECRET}" "${CONSUMER_SECRET}"; do
  if grep -qF -- "${secret}" "${LOGDIR}/armb-rollback.log"; then
    echo "FAIL: the arm-B rollback output leaked a SecureString plaintext" >&2
    exit 1
  fi
done
# The refused revert must not have restored the pre-read literal, and must
# certainly not have written the consumer region's secret.
ARMB_POST_VALUE="$(aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${ARMB_POST_VALUE}" = "${CONSUMER_SECRET}" ]; then
  echo "FAIL: the arm-B rollback wrote the CONSUMER region's secret to the live resource" >&2
  exit 1
fi
if [ "${ARMB_POST_VALUE}" != "${PRODUCER_SECRET}" ]; then
  echo "FAIL: the arm-B rollback applied its revert (value is now '${ARMB_POST_VALUE}') instead of refusing" >&2
  exit 1
fi
echo "[verify]   ok: arm B refused, and the live value is untouched"

# ---------------------------------------------------------------------------
# PHASE 7: teardown — both stacks, both regions, and the seeded parameters
# ---------------------------------------------------------------------------
echo "[verify] phase 7a: destroy ${CONSUMER_STACK} (${CONSUMER_REGION})"
AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --force

assert_gone "echo parameter ${ECHO_PARAM} still exists after the arm-B destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}"
assert_gone "consumer state file still exists after the arm-B destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"

echo "[verify] phase 7b: destroy ${PRODUCER_STACK} (${PRODUCER_REGION})"
AWS_REGION="${PRODUCER_REGION}" ${CLI} destroy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --force

assert_gone "producer probe parameter still exists after destroy" \
  aws ssm get-parameter --name "${PRODUCER_PROBE_PARAM}" --region "${PRODUCER_REGION}"
assert_gone "producer state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"

echo "[verify] phase 7c: delete the seeded SecureString in both regions"
aws ssm delete-parameter --name "${SHARED_SECURE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null
aws ssm delete-parameter --name "${SHARED_SECURE_PARAM}" --region "${CONSUMER_REGION}" >/dev/null
assert_gone "seeded SecureString still exists in ${PRODUCER_REGION}" \
  aws ssm get-parameter --name "${SHARED_SECURE_PARAM}" --region "${PRODUCER_REGION}"
assert_gone "seeded SecureString still exists in ${CONSUMER_REGION}" \
  aws ssm get-parameter --name "${SHARED_SECURE_PARAM}" --region "${CONSUMER_REGION}"

# The injected queue never got created; prove it, rather than assuming.
assert_gone "the injected failing queue exists — it should never have been created" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${CONSUMER_REGION}"


echo ""
echo "[verify] PASS: rollback-cross-region-secret — the region-ambiguous replay was refused, the live value kept the producer region's secret, and both regions are clean"
