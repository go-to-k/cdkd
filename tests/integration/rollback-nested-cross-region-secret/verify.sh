#!/usr/bin/env bash
#
# verify.sh — cdkd NESTED-stack cross-region secret rollback-replay integ test
# (issue [#4174](https://github.com/go-to-k/cdkd/issues/4174)).
#
# THE DEFECT. The parent reads the producer's redacted output across a region
# boundary and hands the value to a nested child as a Parameter. The child
# records the parent's region-LESS `{{resolve:...}}` spelling, but its own
# `outputReads` never name the producer's region, so the child's rollback
# replay classified the reference `local` and resolved it against the
# same-named secret in the CONSUMER's region — writing that value onto a live
# resource.
#
# THE DISCRIMINATOR. The same SecureString NAME is seeded in BOTH regions with
# DIFFERENT values; every value assertion is against the PRODUCER region's
# value AND against the consumer region's value being absent.
#
# PHASES
#   0. Seed the SecureString in us-west-2 and us-east-1 with different values;
#      assert both came back `SecureString`.
#   1. Deploy the PRODUCER in us-west-2; its output is the redacted expression.
#   2. Deploy the CONSUMER v1 (cross-region read into the nested child).
#      Assert the live child echo carries the PRODUCER's value, the CHILD's
#      record holds the region-less expression, the PARENT's `outputReads`
#      names us-west-2, and the CHILD's own reads do NOT (the premise: the
#      child's evidence alone cannot explain the reference).
#   2d. DRIFT ARM (go-to-k/cdkd#4213): tamper the child's echo (Value and
#      Description), then `cdkd drift --revert` on the CHILD must refuse on the
#      parent's regions (exit 2) and write nothing. Pre-fix it wrote the
#      consumer region's secret. Phase 3's v2 deploy restores the resource.
#   3. ARM A (`cdkd rollback` of the parent): deploy v2 + INJECT_FAIL under
#      --no-rollback; assert the child journal carries the echo UPDATE whose
#      previous Value is the expression.
#   4. `cdkd rollback --force` of the parent: exit 2, the nested row's revert
#      refuses naming the reference and us-west-2, and the live echo still
#      holds the PRODUCER's value.
#   5. Destroy the consumer (cascades the child).
#   6. ARM B (the deploy's automatic rollback): deploy v1, then v2 +
#      INJECT_FAIL WITHOUT --no-rollback. The automatic rollback reverts the
#      nested row; assert it refused and the live value is untouched.
#   ARMS A AND B ARE REGRESSION NETS, NOT DISCRIMINATORS (measured against the
#   pre-#4174 binary: both pass). The parent's revert of the `Child` row
#   re-resolves the row's own `Parameters.SharedValue`, which holds the same
#   region-less expression, and the PARENT's evidence refuses it before the
#   child's journal replay runs. They pin that no nested revert writes the
#   wrong region's value, whichever layer refuses.
#   6c. ARM C (the CHILD engine's own automatic rollback): a failure inside
#      the child after its echo UPDATE; the child's rollback must refuse on
#      the parent engine's handed-down regions. THE DISCRIMINATING ARM: the
#      pre-#4174 binary resolves the echo in us-east-1 here and fails it.
#   Every refusal must name `producer region(s) on record: us-west-2` and
#   must NOT be the incomplete-evidence refusal, which a broken hand-down
#   would produce and which would otherwise pass.
#   7. Destroy both stacks, delete the seeded parameters, and assert every AWS
#      resource and state file is gone.
#
# Required env:
#   STATE_BUCKET — cdkd state bucket (account-scoped, e.g. cdkd-state-{accountId})
# Regions are PINNED (producer us-west-2, consumer us-east-1) regardless of
# AWS_REGION, because the CDK app pins `env.region` per stack.
#
# Run with `/run-integ rollback-nested-cross-region-secret` — never by hand.
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

PRODUCER_STACK="CdkdRbNestedXregionProducer"
CONSUMER_STACK="CdkdRbNestedXregionConsumer"
CHILD_STACK="${CONSUMER_STACK}~Child"
PRODUCER_REGION="us-west-2"
CONSUMER_REGION="us-east-1"
PRODUCER_OUTPUT_NAME="SharedSecret"

SHARED_SECURE_PARAM="/cdkd/rollback-nested-xregion/shared-secret"
PRODUCER_PROBE_PARAM="/cdkd/rollback-nested-xregion/producer-probe"
ECHO_PARAM="/cdkd/rollback-nested-xregion/echo"
FAILING_QUEUE_NAME="${CONSUMER_STACK}-failing-queue"
CHILD_FAILING_QUEUE_NAME="CdkdRbNestedXregionChildFailing-queue"

# Same NAME, two regions, two DIFFERENT values. Fake test data, but treated as
# secret throughout: never echoed, only compared.
PRODUCER_SECRET="cdkd-4174-producer-us-west-2"
CONSUMER_SECRET="cdkd-4174-consumer-us-east-1"
SHARED_EXPRESSION="{{resolve:ssm:${SHARED_SECURE_PARAM}}}"

PRODUCER_STATE_KEY="cdkd/${PRODUCER_STACK}/${PRODUCER_REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${CONSUMER_REGION}/state.json"
CONSUMER_JOURNAL_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/rollback-journal.json"
CHILD_JOURNAL_KEY="cdkd/${CHILD_STACK}/${CONSUMER_REGION}/rollback-journal.json"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-nested-cross-region-secret"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096): the state bucket is VERSIONED
# and this fixture resolves a SecureString on the deploy path, so a redaction
# regression would leave plaintext in object versions forever. Sourced by
# ABSOLUTE path, since this script `cd`s into the fixture dir below.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

PRODUCER_STATE_PREFIX="$(s3_stack_prefix "${PRODUCER_STACK}" "${PRODUCER_REGION}")"
CONSUMER_STATE_PREFIX="$(s3_stack_prefix "${CONSUMER_STACK}" "${CONSUMER_REGION}")"
CHILD_STATE_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${CONSUMER_REGION}")"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local cdkd binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi
CLI="node ${LOCAL_DIST}"

# Per-RUN scratch dir; `cleanup` removes it unconditionally.
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-4174-XXXXXX")"

echo "[verify] producer=${PRODUCER_STACK}@${PRODUCER_REGION} consumer=${CONSUMER_STACK}@${CONSUMER_REGION} state-bucket=${STATE_BUCKET}"

rc=0
cleaned=0
cleanup() {
  rc=$?
  if [ "${cleaned}" -eq 1 ]; then
    exit "${rc}"
  fi
  cleaned=1
  echo "[verify] cleanup (exit ${rc})"
  set +e
  rm -rf "${LOGDIR}"
  AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
    --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  consumer_destroy_rc=$?
  AWS_REGION="${PRODUCER_REGION}" ${CLI} destroy "${PRODUCER_STACK}" \
    --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  producer_destroy_rc=$?
  # Direct AWS cleanup, in case destroy itself is what broke: this test
  # INTENTIONALLY fails deploys.
  aws ssm delete-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PRODUCER_PROBE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${SHARED_SECURE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${SHARED_SECURE_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  local q_url q_name
  for q_name in "${FAILING_QUEUE_NAME}" "${CHILD_FAILING_QUEUE_NAME}"; do
    q_url="$(aws sqs get-queue-url --queue-name "${q_name}" --region "${CONSUMER_REGION}" \
      --query 'QueueUrl' --output text 2>/dev/null)"
    if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
      aws sqs delete-queue --queue-url "${q_url}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
    fi
  done
  # THE MODE FOLLOWS THE DESTROYS (issue #2225): `all` only once both stacks
  # are gone for good; otherwise leave CURRENT objects CURRENT so a later
  # `cdkd state destroy` can still read them, and drop only history.
  if [ "${rc}" -eq 0 ] && [ "${consumer_destroy_rc}" -eq 0 ] && [ "${producer_destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CHILD_STACK}/" --recursive >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER_STACK}/" --recursive >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER_STACK}/" --recursive >/dev/null 2>&1
    s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" all || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" all || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" all || true
    s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" \
      "rollback-nested-cross-region-secret child state teardown"
    s3_assert_versions_swept "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" \
      "rollback-nested-cross-region-secret consumer state teardown"
    s3_assert_versions_swept "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" \
      "rollback-nested-cross-region-secret producer state teardown"
  else
    s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_STATE_PREFIX}" noncurrent || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" noncurrent || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" noncurrent || true
  fi
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
  # `cdkd state destroy` FIRST: it reads the state to tear down what is still
  # standing, which an `aws s3 rm` first would strand as orphans.
  AWS_REGION="${CONSUMER_REGION}" node "${LOCAL_DIST}" state destroy "${CONSUMER_STACK}" \
    --state-bucket "${STATE_BUCKET:-}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
  AWS_REGION="${PRODUCER_REGION}" node "${LOCAL_DIST}" state destroy "${PRODUCER_STACK}" \
    --state-bucket "${STATE_BUCKET:-}" --region "${PRODUCER_REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PRODUCER_PROBE_PARAM}" --region "${PRODUCER_REGION}" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CHILD_STACK}/" --recursive >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER_STACK}/" --recursive >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER_STACK}/" --recursive >/dev/null 2>&1
  exit 0
)

live_echo_value() {
  aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}" \
    --query 'Parameter.Value' --output text
}
live_echo_description() {
  aws ssm describe-parameters --region "${CONSUMER_REGION}" \
    --parameter-filters "Key=Name,Values=${ECHO_PARAM}" \
    --query 'Parameters[0].Description' --output text
}
# usage: assert_no_plaintext <file> <what>
assert_no_plaintext() {
  local secret
  for secret in "${PRODUCER_SECRET}" "${CONSUMER_SECRET}"; do
    if grep -qF -- "${secret}" "$1"; then
      echo "FAIL: $2 holds a resolved SecureString plaintext" >&2
      exit 1
    fi
  done
}
# usage: assert_inherited_refusal <log> <what>
# The refusal must be the one taken on the PARENT's inherited region
# (`producer region(s) on record: us-west-2`), never the incomplete-evidence
# one: a broken hand-down makes every nested replay incomplete, which refuses
# too and would otherwise pass.
assert_inherited_refusal() {
  local needle
  for needle in 'cannot re-resolve the secret reference' "'${SHARED_SECURE_PARAM}'" \
    "producer region(s) on record: ${PRODUCER_REGION}"; do
    if ! grep -qF -- "${needle}" "$1"; then
      echo "FAIL: $2 did not refuse the child's replay with '${needle}'" >&2
      exit 1
    fi
  done
  if grep -qF -- "parent's cross-region reads are not known" "$1"; then
    echo "FAIL: $2 refused on INCOMPLETE evidence: the parent's regions never reached the child" >&2
    exit 1
  fi
}
# usage: assert_producer_value <when>
assert_producer_value() {
  local value
  value="$(live_echo_value)"
  if [ "${value}" = "${CONSUMER_SECRET}" ]; then
    echo "FAIL: $1: the live echo holds the CONSUMER region's secret — the wrong-region write of issue #4174" >&2
    exit 1
  fi
  if [ "${value}" != "${PRODUCER_SECRET}" ]; then
    echo "FAIL: $1: the live echo holds neither region's seeded value" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# PHASE 0: seed the SAME SecureString name in BOTH regions with DIFFERENT values
# ---------------------------------------------------------------------------
echo "[verify] phase 0: seed ${SHARED_SECURE_PARAM} as SecureString in both regions"
aws ssm put-parameter --name "${SHARED_SECURE_PARAM}" --type SecureString \
  --value "${PRODUCER_SECRET}" --overwrite --region "${PRODUCER_REGION}" >/dev/null
aws ssm put-parameter --name "${SHARED_SECURE_PARAM}" --type SecureString \
  --value "${CONSUMER_SECRET}" --overwrite --region "${CONSUMER_REGION}" >/dev/null
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

aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" "${LOGDIR}/producer-state.json" >/dev/null
PRODUCER_OUTPUT="$(jq -r --arg k "${PRODUCER_OUTPUT_NAME}" '.outputs[$k] // empty' "${LOGDIR}/producer-state.json")"
if [ "${PRODUCER_OUTPUT}" != "${SHARED_EXPRESSION}" ]; then
  echo "FAIL: producer output '${PRODUCER_OUTPUT_NAME}' is '${PRODUCER_OUTPUT}', expected the redacted expression" >&2
  exit 1
fi
assert_no_plaintext "${LOGDIR}/producer-state.json" "producer state.json"
echo "[verify]   ok: producer state keeps the output REDACTED as the expression"

# ---------------------------------------------------------------------------
# PHASE 2: consumer v1, passing the cross-region read into the nested child
# ---------------------------------------------------------------------------
echo "[verify] phase 2: deploy ${CONSUMER_STACK} v1 (reads ${PRODUCER_REGION} into ${CHILD_STACK})"
MARKER_VALUE=v1 WITH_XREGION=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

if [ "$(live_echo_value)" != "${PRODUCER_SECRET}" ]; then
  echo "FAIL: the child echo does not carry the PRODUCER region's secret after v1 — the cross-region read into the child is broken, so this fixture cannot test #4174" >&2
  exit 1
fi
echo "[verify]   ok: live child echo carries the PRODUCER region's secret"

aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" "${LOGDIR}/consumer-state.json" >/dev/null
aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" "${LOGDIR}/child-state.json" >/dev/null
assert_no_plaintext "${LOGDIR}/consumer-state.json" "consumer state.json"
assert_no_plaintext "${LOGDIR}/child-state.json" "child state.json"

CHILD_RECORDED="$(jq -r '.resources.SecretEcho.properties.Value // empty' "${LOGDIR}/child-state.json")"
if [ "${CHILD_RECORDED}" != "${SHARED_EXPRESSION}" ]; then
  echo "FAIL: the child records SecretEcho Value '${CHILD_RECORDED}', expected the region-less expression — the reference the replay re-resolves" >&2
  exit 1
fi
PARENT_READ_REGIONS="$(jq -r --arg s "${PRODUCER_STACK}" \
  '[.outputReads[]? | select(.sourceStack == $s) | .sourceRegion] | unique | join(",")' "${LOGDIR}/consumer-state.json")"
if [ "${PARENT_READ_REGIONS}" != "${PRODUCER_REGION}" ]; then
  echo "FAIL: the PARENT's outputReads name '${PARENT_READ_REGIONS}', expected '${PRODUCER_REGION}' — the evidence the child must inherit" >&2
  exit 1
fi
# The premise: the child's OWN reads cannot explain the reference. If they
# named us-west-2, the pre-fix replay would refuse too and this fixture could
# not tell the fix from the bug.
CHILD_READ_REGIONS="$(jq -r '[(.imports // [])[], (.outputReads // [])[] | .sourceRegion] | unique | join(",")' \
  "${LOGDIR}/child-state.json")"
if [ -n "${CHILD_READ_REGIONS}" ]; then
  echo "FAIL: the CHILD's own reads name '${CHILD_READ_REGIONS}'; the fixture needs a child whose reads cannot explain the reference" >&2
  exit 1
fi
echo "[verify]   ok: the child records the region-less expression; only the PARENT's reads name ${PRODUCER_REGION}"

# ---------------------------------------------------------------------------
# PHASE 2d (DRIFT ARM, go-to-k/cdkd#4213): `cdkd drift --revert` on the CHILD
# must classify the parent-supplied expression with the PARENT's regions.
# Pre-fix, drift read only the child's own (empty) reads, resolved the
# expression in us-east-1, and --revert WROTE the consumer region's secret.
# ---------------------------------------------------------------------------
# Both Value (secret-bearing) and Description (ordinary) are tampered: with
# Value alone the resource is `notCompared`, nothing is drifted, and --revert
# returns early without reaching the refusal (the sibling fixture's phase 2b2).
echo "[verify] phase 2d: 'cdkd drift --revert' on ${CHILD_STACK} (expect a refusal naming ${PRODUCER_REGION})"
TAMPER_SENTINEL="cdkd-4213-tampered-do-not-resolve"
aws ssm put-parameter --name "${ECHO_PARAM}" --value "${TAMPER_SENTINEL}" --type String \
  --description "cdkd-4213-tampered-description" --overwrite --region "${CONSUMER_REGION}" >/dev/null
# Premise guard (the sibling fixture's phase 2b2): the tamper must make the
# echo genuinely DRIFTED on Description, or --revert returns early and a red
# below would not say whether the tamper or the refusal was missing.
DRIFT_JSON_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CHILD_STACK}" --json \
  --state-bucket "${STATE_BUCKET}" > "${LOGDIR}/drift-child.json" 2> "${LOGDIR}/drift-child.err" || DRIFT_JSON_RC=$?
assert_no_plaintext "${LOGDIR}/drift-child.json" "the child drift --json payload"
assert_no_plaintext "${LOGDIR}/drift-child.err" "the child drift stderr"
CHILD_DRIFTED_PATHS="$(jq -r '[.. | objects | select(has("drifted")) | .drifted[]? | select(.logicalId == "SecretEcho") | .changes[]?.path] | join(",")' \
  "${LOGDIR}/drift-child.json")"
if [ "${DRIFT_JSON_RC}" -ne 1 ]; then
  echo "FAIL: drift --json on the tampered child exited ${DRIFT_JSON_RC}, expected 1 (a Description drift detected)" >&2
  exit 1
fi
case ",${CHILD_DRIFTED_PATHS}," in
  *,Description,*) ;;
  *)
    echo "FAIL: the tampered child echo is not drifted on Description (got '${CHILD_DRIFTED_PATHS}', rc=${DRIFT_JSON_RC}); the --revert below would exercise no revert code" >&2
    exit 1
    ;;
esac
case ",${CHILD_DRIFTED_PATHS}," in
  *,Value,*)
    echo "FAIL: the child echo reports a Value drift: its secret leaf was compared instead of refused" >&2
    exit 1
    ;;
esac
DRIFT_REVERT_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CHILD_STACK}" --revert -y \
  --state-bucket "${STATE_BUCKET}" > "${LOGDIR}/drift-revert.log" 2>&1 || DRIFT_REVERT_RC=$?
sed 's/^/  /' "${LOGDIR}/drift-revert.log" || true
assert_no_plaintext "${LOGDIR}/drift-revert.log" "the drift --revert output"
# `refused to re-resolve` is printed only by the revert path's refusal branch,
# on ONE line with the refusal's own text, so the needles are matched on the
# SAME line: detection's warning also names the producer region, and a revert
# refusing for another reason would otherwise still pass.
if ! grep -F -- 'refused to re-resolve' "${LOGDIR}/drift-revert.log" \
  | grep -F -- "'${SHARED_SECURE_PARAM}'" \
  | grep -qF -- "producer region(s) on record: ${PRODUCER_REGION}"; then
  echo "FAIL: drift --revert on the child did not refuse on the parent's region (no single line carries the revert refusal, the reference and ${PRODUCER_REGION})" >&2
  exit 1
fi
if grep -qF -- "parent stacks' cross-region reads could not be established" "${LOGDIR}/drift-revert.log"; then
  echo "FAIL: drift --revert refused on INCOMPLETE evidence: the parent record was not read" >&2
  exit 1
fi
if [ "${DRIFT_REVERT_RC}" -ne 2 ]; then
  echo "FAIL: drift --revert exited ${DRIFT_REVERT_RC}, expected 2 (one resource refused, nothing written)" >&2
  exit 1
fi
# Nothing was written, so the live value is still the tamper sentinel. Pre-fix
# the premise guard's Value-drift branch reds first (detection compared the
# secret leaf in the wrong region); this pins the write itself.
DRIFT_LIVE="$(live_echo_value)"
if [ "${DRIFT_LIVE}" = "${CONSUMER_SECRET}" ]; then
  echo "FAIL: drift --revert wrote the CONSUMER region's secret to the child's live resource — issue #4213" >&2
  exit 1
fi
if [ "${DRIFT_LIVE}" != "${TAMPER_SENTINEL}" ]; then
  echo "FAIL: drift --revert changed the live value although it refused" >&2
  exit 1
fi
echo "[verify]   ok: drift --revert on the child refused on the parent's regions and wrote nothing"

# ---------------------------------------------------------------------------
# PHASE 3 (ARM A): failing v2 under --no-rollback -> journals to replay
# ---------------------------------------------------------------------------
echo "[verify] phase 3: deploy ${CONSUMER_STACK} v2 + INJECT_FAIL --no-rollback (expect FAILURE)"
set +e
MARKER_VALUE=v2 WITH_XREGION=true INJECT_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback --yes > "${LOGDIR}/v2-deploy.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/v2-deploy.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the v2 --no-rollback deploy unexpectedly SUCCEEDED" >&2
  exit 1
fi
assert_no_plaintext "${LOGDIR}/v2-deploy.log" "the v2 deploy output"

aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_JOURNAL_KEY}" "${LOGDIR}/consumer-journal.json" >/dev/null
PARENT_ROW_OPS="$(jq -r '[.segments[]?.operations[]? | select(.logicalId == "Child") | .changeType] | join(",")' \
  "${LOGDIR}/consumer-journal.json")"
if [ "${PARENT_ROW_OPS}" != "UPDATE" ]; then
  echo "FAIL: the parent journal records '${PARENT_ROW_OPS}' for the Child row, expected exactly 'UPDATE'" >&2
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${CHILD_JOURNAL_KEY}" "${LOGDIR}/child-journal.json" >/dev/null
CHILD_PREV_VALUE="$(jq -r '[.segments[]?.operations[]? | select(.logicalId == "SecretEcho" and .changeType == "UPDATE") | .previousState.properties.Value] | first // empty' \
  "${LOGDIR}/child-journal.json")"
if [ "${CHILD_PREV_VALUE}" != "${SHARED_EXPRESSION}" ]; then
  echo "FAIL: the child journal's SecretEcho UPDATE carries previous Value '${CHILD_PREV_VALUE}', expected the region-less expression — without it the replay has nothing to get wrong" >&2
  exit 1
fi
if [ "$(live_echo_description)" != "nested cross-region secret echo (v2)" ]; then
  echo "FAIL: the child's v2 UPDATE did not land" >&2
  exit 1
fi
assert_producer_value "after the v2 deploy"
echo "[verify]   ok: the child's v2 UPDATE landed and its journal carries the expression"

# ---------------------------------------------------------------------------
# PHASE 4: cdkd rollback of the PARENT — the child's replay must REFUSE
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
  echo "FAIL: cdkd rollback exited ${ROLLBACK_RC}, expected 2 (partial — the child's revert refused)" >&2
  exit 1
fi
assert_inherited_refusal "${LOGDIR}/rollback.log" "the parent rollback"
assert_no_plaintext "${LOGDIR}/rollback.log" "the rollback output"
# THE LOAD-BEARING ASSERTION: pre-fix the child's replay resolved the
# region-less expression in us-east-1 and PutParameter'd that value.
assert_producer_value "after the parent rollback"
if [ "$(live_echo_description)" != "nested cross-region secret echo (v2)" ]; then
  echo "FAIL: the refused child revert still applied (Description changed)" >&2
  exit 1
fi
echo "[verify]   ok: the nested row's revert refused, and the live value is still the producer's"

# ---------------------------------------------------------------------------
# PHASE 5: reset the consumer (cascades the child)
# ---------------------------------------------------------------------------
echo "[verify] phase 5: destroy ${CONSUMER_STACK} — arm A done"
AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --force
assert_gone "echo parameter ${ECHO_PARAM} still exists after destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}"
assert_gone "child state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"

# ---------------------------------------------------------------------------
# PHASE 6 (ARM B): the deploy's AUTOMATIC rollback reverts the nested row
# ---------------------------------------------------------------------------
echo "[verify] phase 6a: deploy ${CONSUMER_STACK} v1 again"
MARKER_VALUE=v1 WITH_XREGION=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes
assert_producer_value "after the arm-B v1 deploy"

echo "[verify] phase 6b: deploy v2 + INJECT_FAIL with the automatic rollback (expect FAILURE)"
set +e
MARKER_VALUE=v2 WITH_XREGION=true INJECT_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes > "${LOGDIR}/armb-deploy.log" 2>&1
ARMB_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/armb-deploy.log" || true
if [ "${ARMB_RC}" -eq 0 ]; then
  echo "FAIL: the arm-B deploy unexpectedly SUCCEEDED" >&2
  exit 1
fi
assert_inherited_refusal "${LOGDIR}/armb-deploy.log" "the automatic rollback"
assert_no_plaintext "${LOGDIR}/armb-deploy.log" "the arm-B deploy output"
assert_producer_value "after the automatic rollback"
if [ "$(live_echo_description)" != "nested cross-region secret echo (v2)" ]; then
  echo "FAIL: the refused child revert still applied during the automatic rollback" >&2
  exit 1
fi
echo "[verify]   ok: the automatic rollback refused the nested row's revert, and the live value is untouched"

# ---------------------------------------------------------------------------
# PHASE 6c (ARM C): a failure INSIDE the child — the CHILD engine's own
# automatic rollback reverts the echo, with the parent engine's regions
# handed down to it (no journal replay of the row is involved).
# ---------------------------------------------------------------------------
echo "[verify] phase 6c: destroy, deploy v1, then v2 + INJECT_CHILD_FAIL (expect FAILURE)"
AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --force
MARKER_VALUE=v1 WITH_XREGION=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes
assert_producer_value "after the arm-C v1 deploy"
set +e
MARKER_VALUE=v2 WITH_XREGION=true INJECT_CHILD_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes > "${LOGDIR}/armc-deploy.log" 2>&1
ARMC_RC=$?
set -e
sed 's/^/  /' "${LOGDIR}/armc-deploy.log" || true
if [ "${ARMC_RC}" -eq 0 ]; then
  echo "FAIL: the arm-C deploy unexpectedly SUCCEEDED" >&2
  exit 1
fi
assert_inherited_refusal "${LOGDIR}/armc-deploy.log" "the child's own automatic rollback"
assert_no_plaintext "${LOGDIR}/armc-deploy.log" "the arm-C deploy output"
assert_producer_value "after the child's own automatic rollback"
if [ "$(live_echo_description)" != "nested cross-region secret echo (v2)" ]; then
  echo "FAIL: the refused child revert still applied during the child's own rollback" >&2
  exit 1
fi
echo "[verify]   ok: the child's own rollback refused on the parent's regions, and the live value is untouched"

# ---------------------------------------------------------------------------
# PHASE 7: teardown — both stacks, both regions, and the seeded parameters
# ---------------------------------------------------------------------------
echo "[verify] phase 7a: destroy ${CONSUMER_STACK} (${CONSUMER_REGION})"
AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --force
assert_gone "echo parameter ${ECHO_PARAM} still exists after the final destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}"
assert_gone "consumer state file still exists after the final destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
assert_gone "child state file still exists after the final destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"

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
assert_gone "the injected failing queue exists — it should never have been created" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${CONSUMER_REGION}"
assert_gone "the child's injected failing queue exists — it should never have been created" \
  aws sqs get-queue-url --queue-name "${CHILD_FAILING_QUEUE_NAME}" --region "${CONSUMER_REGION}"

echo ""
echo "[verify] PASS: rollback-nested-cross-region-secret — drift --revert on the child, the parent rollback, the parent's automatic rollback and the child's own automatic rollback all refused to re-resolve a parent-supplied cross-region secret, and the live value kept the producer region's secret"
