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
#   TWO KINDS OF RECORD (go-to-k/cdkd#4847). A v12 binary records the region
#   that resolved each `{{resolve:...}}` token (`referenceProvenance`) -- on
#   the child's SecretEcho too, inherited through the parent's parameter --
#   and the replay and drift resolve a region-less token in that region. So
#   the records THIS binary writes get the positive phases (2p, 2b, 5b, 6a2,
#   6c), each stating its pre-#4847 red line (the refusal its stripped twin
#   still asserts), and the refusals run on records stripped of the field
#   (premise present -> write -> read back gone), which is the pre-v12 shape.
#   2p. Premise: the parent's `Child` row and the child's SecretEcho record
#      both name us-west-2 for the token.
#   2b. With the child's echo tampered (Value and Description), `cdkd drift`
#      on the CHILD reports BOTH drifted (exit 1) and `--revert` exits 0,
#      writes the PRODUCER's value and restores the Description.
#   2s. Strip the child's provenance.
#   2d. DRIFT ARM (go-to-k/cdkd#4213), on the stripped child: tamper the
#      child's echo again, then `cdkd drift --revert` on the CHILD must refuse
#      on the parent's regions (exit 2) and write nothing. Pre-#4213 it wrote
#      the consumer region's secret. Phase 3's v2 deploy restores the resource.
#   3s. Strip the parent's provenance (the child's is still stripped): the
#      replay refuses on each journal's previousState, copied from this state.
#   3. ARM A (`cdkd rollback` of the parent): deploy v2 + INJECT_FAIL under
#      --no-rollback; assert the child journal carries the echo UPDATE whose
#      previous Value is the expression, and that neither journal's
#      previousState carries provenance.
#   4. `cdkd rollback --force` of the parent: exit 2, the nested row's revert
#      refuses naming the reference and us-west-2, and the live echo still
#      holds the PRODUCER's value.
#   5. Destroy the consumer (cascades the child).
#   5b. ARM A on v12 records: deploy v1, fail v2 (both journaled
#      previousStates name us-west-2), and `cdkd rollback` exits 0, restores
#      the v1 Description with the PRODUCER's value and drops the parent
#      journal. 5c destroys the consumer again.
#   6. ARM B (the deploy's automatic rollback): 6a deploys v1; 6a2 deploys v2
#      + INJECT_FAIL WITHOUT --no-rollback on v12 records, and the automatic
#      rollback completes the nested row's revert (v1 Description, PRODUCER's
#      value). 6a3 destroys, deploys v1 and strips both records; 6b repeats
#      the failing deploy and asserts the revert refused and the live value
#      is untouched.
#   ARMS A AND B ARE REGRESSION NETS, NOT DISCRIMINATORS (measured against the
#   pre-#4174 binary: both pass). The parent's revert of the `Child` row
#   re-resolves the row's own `Parameters.SharedValue`, which holds the same
#   region-less expression, and the PARENT's evidence refuses it before the
#   child's journal replay runs. They pin that no nested revert writes the
#   wrong region's value, whichever layer refuses.
#   6c. ARM C (the CHILD engine's own automatic rollback): a failure inside
#      the child after its echo UPDATE. On v12 records the child's rollback
#      completes (v1 Description, PRODUCER's value); 6c2 repeats it on a fresh,
#      stripped v1, and the child's rollback must refuse on the parent
#      engine's handed-down regions. THE DISCRIMINATING ARM for #4174: the
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
  if grep -qF -- "cross-region reads its parent made are not known" "$1"; then
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
# usage: assert_no_refusal <log> <what>
# The positive arms' discriminator: pre-#4847 each of them refused here.
assert_no_refusal() {
  if grep -qE -- 'cannot re-resolve the secret reference|refused to re-resolve|refused to resolve' "$1"; then
    echo "FAIL: $2 refused a reference whose record names its region (the pre-#4847 behaviour)" >&2
    sed 's/^/  /' "$1" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Recorded reference provenance (state schema v12, go-to-k/cdkd#4847)
# ---------------------------------------------------------------------------
# A v12 binary records, for each `{{resolve:...}}` token a record holds, the
# region that resolved it (`referenceProvenance`). The child's SecretEcho
# record gets us-west-2 for the parent-supplied token (the nested inherited
# provenance is recorded on the read route), and so does the parent's `Child`
# row for its `Parameters.SharedValue`. The rollback replay and `cdkd drift`
# resolve a region-less token in the region its record names, so on records
# THIS binary wrote nothing refuses: the positive phases (2b, 5b, 6a2, 6c)
# assert that. A record WITHOUT the field -- one written before v12 -- keeps
# the old reading, and refusing it is still today's behaviour. The refusal
# phases (2d, 4, 6b, 6c2) therefore run on records stripped of the field,
# which is exactly what a pre-v12 record looks like.
CHILD_ECHO_RECORD='.resources.SecretEcho'
PARENT_CHILD_ROW='.resources.Child'
CHILD_JOURNAL_ECHO_PREVIOUS='.segments[]?.operations[]? | select(.logicalId == "SecretEcho" and .changeType == "UPDATE") | .previousState'
PARENT_JOURNAL_CHILD_PREVIOUS='.segments[]?.operations[]? | select(.logicalId == "Child" and .changeType == "UPDATE") | .previousState'

# Exactly ONE record must match, or the check after it is ambiguous or vacuous.
assert_one_record() { # usage: assert_one_record <json file> <record filter> <what>
  local count
  count="$(jq "[$2 | objects] | length" "$1")" || { echo "FAIL: could not parse $1 for $3" >&2; exit 1; }
  if [ "${count}" != "1" ]; then
    echo "FAIL: expected exactly one record for $3, found ${count} -- the provenance check would be ambiguous or vacuous" >&2
    exit 1
  fi
}
assert_recorded_region() { # usage: assert_recorded_region <json file> <record filter> <region> <what>
  local got
  assert_one_record "$1" "$2" "$4"
  got="$(jq -r --arg t "${SHARED_EXPRESSION}" \
    "$2 | ((.referenceProvenance // {})[\$t] // {}).region // empty" "$1")" \
    || { echo "FAIL: could not read the provenance of $4" >&2; exit 1; }
  if [ "${got}" != "$3" ]; then
    echo "FAIL: $4 records region '${got}' for ${SHARED_EXPRESSION}, expected '$3'" >&2
    exit 1
  fi
  echo "[verify]   ok: $4 records region $3 for the reference"
}
assert_no_reference_provenance() { # usage: assert_no_reference_provenance <json file> <record filter> <what>
  local held
  assert_one_record "$1" "$2" "$3"
  held="$(jq "[$2 | has(\"referenceProvenance\")] | any" "$1")" \
    || { echo "FAIL: could not parse $1 for $3" >&2; exit 1; }
  if [ "${held}" != "false" ]; then
    echo "FAIL: $3 carries referenceProvenance -- the refusal below would be measuring a v12 record, not a pre-v12 one" >&2
    exit 1
  fi
  echo "[verify]   ok: $3 carries no referenceProvenance (the pre-v12 shape)"
}
# Every cdkd command this script runs is foreground and has exited before the
# next line, so nothing holds the stack lock while state.json is edited. The
# lock object is deleted on release; finding it means something else is
# running against this stack and the edit would race it.
assert_stack_unlocked() { # usage: assert_stack_unlocked <state key>
  local lock_key="${1%state.json}lock.json"
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${lock_key}"; then
    echo "FAIL: s3://${STATE_BUCKET}/${lock_key} exists -- a cdkd command holds the stack lock, so editing state.json now would race it" >&2
    exit 1
  fi
}
# Rewrite <state key> as a pre-v12 binary left it: every `referenceProvenance`
# and `outputReferenceProvenance` dropped, nothing else touched. The repo's
# precedent for an in-run state edit (cross-stack-secret-import, "Step 7"):
# PREMISE first (the field is there, so the strip is not vacuous), then write,
# then read back from S3 and prove it is gone.
strip_reference_provenance() { # usage: strip_reference_provenance <state key> <tag> <record filter> <what>
  local before="${LOGDIR}/$2-before-strip.json"
  local after="${LOGDIR}/$2-after-strip.json"
  local back="${LOGDIR}/$2-read-back.json"
  local tokens_before tokens_back left
  assert_stack_unlocked "$1"
  aws s3 cp "s3://${STATE_BUCKET}/$1" "${before}" >/dev/null \
    || { echo "FAIL: could not read s3://${STATE_BUCKET}/$1" >&2; exit 1; }
  assert_no_plaintext "${before}" "$4's state document before the strip"
  assert_recorded_region "${before}" "$3" "${PRODUCER_REGION}" "$4 (PREMISE, before the strip)"
  jq 'walk(if type == "object" then del(.referenceProvenance, .outputReferenceProvenance) else . end)' \
    "${before}" > "${after}" || { echo "FAIL: could not strip $1" >&2; exit 1; }
  aws s3 cp - "s3://${STATE_BUCKET}/$1" < "${after}" >/dev/null \
    || { echo "FAIL: could not write the stripped s3://${STATE_BUCKET}/$1" >&2; exit 1; }
  aws s3 cp "s3://${STATE_BUCKET}/$1" "${back}" >/dev/null \
    || { echo "FAIL: could not read back s3://${STATE_BUCKET}/$1" >&2; exit 1; }
  left="$(jq '[.. | objects | select(has("referenceProvenance") or has("outputReferenceProvenance"))] | length' "${back}")" \
    || { echo "FAIL: could not parse the read-back $1" >&2; exit 1; }
  if [ "${left}" != "0" ]; then
    echo "FAIL: the read-back $1 still carries ${left} provenance field(s)" >&2
    exit 1
  fi
  assert_no_reference_provenance "${back}" "$3" "$4 (read back after the strip)"
  # Only the field went: every `{{resolve:...}}` the record held is still there.
  tokens_before="$(jq '[.. | strings | select(contains("{{resolve:"))] | length' "${before}")" \
    || { echo "FAIL: could not count tokens in $1" >&2; exit 1; }
  tokens_back="$(jq '[.. | strings | select(contains("{{resolve:"))] | length' "${back}")" \
    || { echo "FAIL: could not count tokens in the read-back $1" >&2; exit 1; }
  if [ "${tokens_before}" != "${tokens_back}" ] || [ "${tokens_back}" = "0" ]; then
    echo "FAIL: the strip changed the references $1 holds (${tokens_before} -> ${tokens_back})" >&2
    exit 1
  fi
}
# usage: strip_consumer_and_child <tag>
# Both pre-deploy records a nested replay reads: the parent's `Child` row (its
# revert re-resolves `Parameters.SharedValue`) and the child's SecretEcho.
strip_consumer_and_child() {
  strip_reference_provenance "${CONSUMER_STATE_KEY}" "$1-parent" "${PARENT_CHILD_ROW}" "the parent's Child row"
  strip_reference_provenance "${CHILD_STATE_KEY}" "$1-child" "${CHILD_ECHO_RECORD}" "the child's SecretEcho record"
}
# usage: assert_v12_records <tag> -- both records name us-west-2 (the positive arms' premise)
assert_v12_records() {
  aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" "${LOGDIR}/$1-parent-state.json" >/dev/null \
    || { echo "FAIL: could not read the consumer state" >&2; exit 1; }
  aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" "${LOGDIR}/$1-child-state.json" >/dev/null \
    || { echo "FAIL: could not read the child state" >&2; exit 1; }
  assert_no_plaintext "${LOGDIR}/$1-parent-state.json" "consumer state.json ($1)"
  assert_no_plaintext "${LOGDIR}/$1-child-state.json" "child state.json ($1)"
  assert_recorded_region "${LOGDIR}/$1-parent-state.json" "${PARENT_CHILD_ROW}" "${PRODUCER_REGION}" "the parent's Child row ($1)"
  assert_recorded_region "${LOGDIR}/$1-child-state.json" "${CHILD_ECHO_RECORD}" "${PRODUCER_REGION}" "the child's SecretEcho record ($1)"
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

# PHASE 2p: the v12 records name the region (the premise of every positive
# arm). The child's record names it although the child's OWN reads name none:
# it came down with the parent's parameter.
echo "[verify] phase 2p: the v12 records name ${PRODUCER_REGION} for the parent-supplied reference"
assert_v12_records v1

# ---------------------------------------------------------------------------
# PHASE 2b (go-to-k/cdkd#4847): `cdkd drift --revert` on the CHILD's v12 record
# writes the PRODUCER region's value.
# Pre-#4847 red line: the Value leaf was refused (`notCompared`, drift saw
# Description only) and --revert printed `refused to re-resolve` on the
# parent's regions, exited 2 and left the tamper live -- exactly phase 2d's
# outcome on the stripped record. With the record's region the token is
# resolved in us-west-2, compared, and reverted with the producer's value.
# ---------------------------------------------------------------------------
TAMPER_SENTINEL="cdkd-4213-tampered-do-not-resolve"
ECHO_DESCRIPTION_V1="nested cross-region secret echo (v1)"
echo "[verify] phase 2b: 'cdkd drift --revert' on ${CHILD_STACK}'s v12 record writes the producer region's value"
aws ssm put-parameter --name "${ECHO_PARAM}" --value "${TAMPER_SENTINEL}" --type String \
  --description "cdkd-4213-tampered-description" --overwrite --region "${CONSUMER_REGION}" >/dev/null
if [ "$(live_echo_value)" != "${TAMPER_SENTINEL}" ]; then
  echo "FAIL: the out-of-band tamper did not take; the revert below would have nothing to do" >&2
  exit 1
fi
V12_DRIFT_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CHILD_STACK}" --json \
  --state-bucket "${STATE_BUCKET}" > "${LOGDIR}/drift-child-v12.json" 2> "${LOGDIR}/drift-child-v12.err" || V12_DRIFT_RC=$?
assert_no_plaintext "${LOGDIR}/drift-child-v12.json" "the v12 child drift --json payload"
assert_no_plaintext "${LOGDIR}/drift-child-v12.err" "the v12 child drift stderr"
assert_no_refusal "${LOGDIR}/drift-child-v12.err" "drift --json on the v12 child"
V12_DRIFTED_PATHS="$(jq -r '[.. | objects | select(has("drifted")) | .drifted[]? | select(.logicalId == "SecretEcho") | .changes[]?.path] | join(",")' \
  "${LOGDIR}/drift-child-v12.json")"
for path in Description Value; do
  case ",${V12_DRIFTED_PATHS}," in
    *,"${path}",*) ;;
    *)
      echo "FAIL: the tampered v12 child echo is not drifted on ${path} (got '${V12_DRIFTED_PATHS}', rc=${V12_DRIFT_RC})" >&2
      exit 1
      ;;
  esac
done
if [ "${V12_DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: drift --json on the tampered v12 child exited ${V12_DRIFT_RC}, expected 1" >&2
  exit 1
fi
V12_REVERT_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} drift "${CHILD_STACK}" --revert -y \
  --state-bucket "${STATE_BUCKET}" > "${LOGDIR}/drift-revert-v12.log" 2>&1 || V12_REVERT_RC=$?
sed 's/^/  /' "${LOGDIR}/drift-revert-v12.log" || true
assert_no_plaintext "${LOGDIR}/drift-revert-v12.log" "the v12 drift --revert output"
assert_no_refusal "${LOGDIR}/drift-revert-v12.log" "drift --revert on the v12 child"
if [ "${V12_REVERT_RC}" -ne 0 ]; then
  echo "FAIL: drift --revert on the v12 child exited ${V12_REVERT_RC}, expected 0" >&2
  exit 1
fi
assert_producer_value "after drift --revert on the v12 child"
if [ "$(live_echo_description)" != "${ECHO_DESCRIPTION_V1}" ]; then
  echo "FAIL: drift --revert on the v12 child did not restore the Description" >&2
  exit 1
fi
echo "[verify]   ok: drift --revert on the v12 child wrote the PRODUCER region's value (rc=0)"

# PHASE 2s: strip the child's provenance, so phase 2d measures the pre-v12
# record its refusal is still today's behaviour for.
echo "[verify] phase 2s: strip referenceProvenance from ${CHILD_STACK}'s state (the pre-v12 shape)"
strip_reference_provenance "${CHILD_STATE_KEY}" child-v1 "${CHILD_ECHO_RECORD}" "the child's SecretEcho record"

# ---------------------------------------------------------------------------
# PHASE 2d (DRIFT ARM, go-to-k/cdkd#4213): `cdkd drift --revert` on the CHILD
# must classify the parent-supplied expression with the PARENT's regions.
# Pre-fix, drift read only the child's own (empty) reads, resolved the
# expression in us-east-1, and --revert WROTE the consumer region's secret.
# ---------------------------------------------------------------------------
# Both Value (secret-bearing) and Description (ordinary) are tampered: with
# Value alone the resource is `notCompared`, nothing is drifted, and --revert
# returns early without reaching the refusal (the sibling fixture's phase 2b2).
# On the STRIPPED child record (phase 2s): a pre-v12 record names no region,
# so this refusal is still today's behaviour for it. Phase 2b is the v12 twin.
echo "[verify] phase 2d: 'cdkd drift --revert' on ${CHILD_STACK} (expect a refusal naming ${PRODUCER_REGION})"
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
# The replay's desired side is each journal's previousState, copied from the
# state as it stood BEFORE this deploy, and it is resolved (and refused)
# before the previous side, the record this deploy writes. So the pre-deploy
# records must be pre-v12: the child's is still the one phase 2s stripped
# (asserted), and the parent's `Child` row -- whose revert re-resolves
# `Parameters.SharedValue` and refuses first -- is stripped here.
echo "[verify] phase 3s: strip the parent's provenance; the child's is still stripped"
strip_reference_provenance "${CONSUMER_STATE_KEY}" parent-v1 "${PARENT_CHILD_ROW}" "the parent's Child row"
aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" "${LOGDIR}/child-state-before-v2.json" >/dev/null
assert_no_reference_provenance "${LOGDIR}/child-state-before-v2.json" "${CHILD_ECHO_RECORD}" \
  "the child's SecretEcho record before the v2 deploy"

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
assert_no_reference_provenance "${LOGDIR}/consumer-journal.json" "${PARENT_JOURNAL_CHILD_PREVIOUS}" \
  "the parent journal's previousState of the Child row"
assert_no_reference_provenance "${LOGDIR}/child-journal.json" "${CHILD_JOURNAL_ECHO_PREVIOUS}" \
  "the child journal's previousState of SecretEcho"
echo "[verify]   ok: the child's v2 UPDATE landed and its journal carries the expression"

# ---------------------------------------------------------------------------
# PHASE 4: cdkd rollback of the PARENT — the child's replay must REFUSE
# ---------------------------------------------------------------------------
# On pre-v12 journaled records (phase 3's premise), refusing is still today's
# behaviour. Phase 5b is the v12 twin, where the rollback completes.
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

# usage: destroy_consumer <phase>
destroy_consumer() {
  AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${CONSUMER_STACK}" \
    --state-bucket "${STATE_BUCKET}" --force
  assert_gone "echo parameter ${ECHO_PARAM} still exists after the $1 destroy" \
    aws ssm get-parameter --name "${ECHO_PARAM}" --region "${CONSUMER_REGION}"
  assert_gone "child state file still exists after the $1 destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
}
# usage: deploy_v1 <phase> -- a fresh v1, whose records a v12 binary wrote
deploy_v1() {
  MARKER_VALUE=v1 WITH_XREGION=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
    --state-bucket "${STATE_BUCKET}" --yes
  assert_producer_value "after the $1 v1 deploy"
  assert_v12_records "$1"
}
# usage: assert_reverted_to_v1 <log> <what> -- a positive arm's outcome
assert_reverted_to_v1() {
  assert_no_plaintext "$1" "$2 output"
  assert_no_refusal "$1" "$2"
  assert_producer_value "after $2"
  if [ "$(live_echo_description)" != "${ECHO_DESCRIPTION_V1}" ]; then
    echo "FAIL: $2 did not restore the v1 Description -- the nested revert was not applied" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# PHASE 5b (go-to-k/cdkd#4847): ARM A on the records as v12 writes them --
# `cdkd rollback` of the parent COMPLETES.
# Pre-#4847 red line: exit 2, the Child row's revert refusing with `cannot
# re-resolve the secret reference` on us-west-2, Description left at v2 --
# exactly phase 4's outcome on stripped records. With both journaled records
# naming us-west-2, the parent's row revert and the child's replay resolve the
# token there. The live value cannot tell "rewritten with the producer's value"
# from "untouched", so the Description flip proves the revert was applied.
# ---------------------------------------------------------------------------
echo "[verify] phase 5b: arm A on v12 records -- deploy v1, fail v2, cdkd rollback completes"
deploy_v1 5b
V12_DEPLOY_RC=0
MARKER_VALUE=v2 WITH_XREGION=true INJECT_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback --yes > "${LOGDIR}/v12-v2-deploy.log" 2>&1 || V12_DEPLOY_RC=$?
sed 's/^/  /' "${LOGDIR}/v12-v2-deploy.log" || true
if [ "${V12_DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the 5b v2 --no-rollback deploy unexpectedly SUCCEEDED" >&2
  exit 1
fi
assert_no_plaintext "${LOGDIR}/v12-v2-deploy.log" "the 5b v2 deploy output"
if [ "$(live_echo_description)" != "nested cross-region secret echo (v2)" ]; then
  echo "FAIL: the child's 5b v2 UPDATE did not land, so the rollback would have nothing to revert" >&2
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_JOURNAL_KEY}" "${LOGDIR}/consumer-journal-5b.json" >/dev/null
aws s3 cp "s3://${STATE_BUCKET}/${CHILD_JOURNAL_KEY}" "${LOGDIR}/child-journal-5b.json" >/dev/null
assert_recorded_region "${LOGDIR}/consumer-journal-5b.json" "${PARENT_JOURNAL_CHILD_PREVIOUS}" "${PRODUCER_REGION}" \
  "the parent journal's previousState of the Child row (5b)"
assert_recorded_region "${LOGDIR}/child-journal-5b.json" "${CHILD_JOURNAL_ECHO_PREVIOUS}" "${PRODUCER_REGION}" \
  "the child journal's previousState of SecretEcho (5b)"
V12_ROLLBACK_RC=0
AWS_REGION="${CONSUMER_REGION}" ${CLI} rollback "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${CONSUMER_REGION}" --force \
  > "${LOGDIR}/v12-rollback.log" 2>&1 || V12_ROLLBACK_RC=$?
sed 's/^/  /' "${LOGDIR}/v12-rollback.log" || true
assert_reverted_to_v1 "${LOGDIR}/v12-rollback.log" "the 5b parent rollback"
if [ "${V12_ROLLBACK_RC}" -ne 0 ]; then
  echo "FAIL: cdkd rollback exited ${V12_ROLLBACK_RC} on the v12 journals; expected 0" >&2
  exit 1
fi
assert_gone "the parent journal survived a rollback that completed" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_JOURNAL_KEY}"
echo "[verify]   ok: the v12 parent rollback completed (rc=0) and restored v1 with the PRODUCER region's value"

echo "[verify] phase 5c: destroy ${CONSUMER_STACK} again"
destroy_consumer 5c

# ---------------------------------------------------------------------------
# PHASE 6 (ARM B): the deploy's AUTOMATIC rollback reverts the nested row
# ---------------------------------------------------------------------------
echo "[verify] phase 6a: deploy ${CONSUMER_STACK} v1 again"
deploy_v1 6a

# PHASE 6a2 (go-to-k/cdkd#4847): arm B on v12 records -- the automatic
# rollback COMPLETES the nested row's revert. Pre-#4847 red line: the revert
# refused (`cannot re-resolve the secret reference`) and Description stayed
# at v2 -- exactly phase 6b's outcome on stripped records.
echo "[verify] phase 6a2: v2 + INJECT_FAIL on v12 records -- the automatic rollback completes (deploy still FAILS)"
ARMB_V12_RC=0
MARKER_VALUE=v2 WITH_XREGION=true INJECT_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes > "${LOGDIR}/armb-v12-deploy.log" 2>&1 || ARMB_V12_RC=$?
sed 's/^/  /' "${LOGDIR}/armb-v12-deploy.log" || true
if [ "${ARMB_V12_RC}" -eq 0 ]; then
  echo "FAIL: the 6a2 deploy unexpectedly SUCCEEDED -- nothing was rolled back" >&2
  exit 1
fi
assert_reverted_to_v1 "${LOGDIR}/armb-v12-deploy.log" "the 6a2 automatic rollback"
echo "[verify]   ok: the automatic rollback on v12 records reverted the nested row with the PRODUCER region's value"

# A fresh v1 for the refusal: its records are stripped, so the 6b deploy's
# journaled previousState is the pre-v12 shape.
echo "[verify] phase 6a3: destroy, deploy v1, strip the parent's and the child's provenance"
destroy_consumer 6a3
deploy_v1 6a3
strip_consumer_and_child armb

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
# 6c first runs on the records as v12 writes them (go-to-k/cdkd#4847): the
# child's own rollback resolves the token in the region its record names and
# COMPLETES. Pre-#4847 red line: the refusal on the parent's regions and
# Description left at v2 -- exactly 6c2's outcome on stripped records.
echo "[verify] phase 6c: destroy, deploy v1, then v2 + INJECT_CHILD_FAIL on v12 records (the child's rollback completes; the deploy still FAILS)"
destroy_consumer 6c
deploy_v1 6c
ARMC_V12_RC=0
MARKER_VALUE=v2 WITH_XREGION=true INJECT_CHILD_FAIL=true AWS_REGION="${CONSUMER_REGION}" ${CLI} deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes > "${LOGDIR}/armc-v12-deploy.log" 2>&1 || ARMC_V12_RC=$?
sed 's/^/  /' "${LOGDIR}/armc-v12-deploy.log" || true
if [ "${ARMC_V12_RC}" -eq 0 ]; then
  echo "FAIL: the 6c deploy unexpectedly SUCCEEDED -- nothing was rolled back" >&2
  exit 1
fi
assert_reverted_to_v1 "${LOGDIR}/armc-v12-deploy.log" "the child's own automatic rollback on v12 records"
echo "[verify]   ok: the child's own rollback on v12 records reverted the echo with the PRODUCER region's value"

# 6c2: the refusal, on a fresh v1 whose records are stripped (the pre-v12
# shape): the child engine's previousState comes from the child's state as it
# stood before the deploy.
echo "[verify] phase 6c2: destroy, deploy v1, strip, then v2 + INJECT_CHILD_FAIL (expect FAILURE + refusal)"
destroy_consumer 6c2
deploy_v1 6c2
strip_consumer_and_child armc
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
echo "[verify] PASS: rollback-nested-cross-region-secret — on v12 records drift --revert on the child, the parent rollback, the parent's automatic rollback and the child's own automatic rollback all resolved the parent-supplied secret in the producer's region; on pre-v12 records every one of them still refused; the live value never held the consumer region's secret"
