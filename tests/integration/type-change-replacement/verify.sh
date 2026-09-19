#!/usr/bin/env bash
#
# End-to-end real-AWS validation that a resource `Type` change on an EXISTING
# logical id is a replacement whose two halves route on two types (issue #2668),
# and that it is never swallowed by the UPDATE arm's no-op skip (issue #3036).
#
# The stack (lib/type-change-replacement-stack.ts) moves three rows from their
# v1 type to their v2 type under TYPE_VARIANT=v2:
#   Subject    SSM Parameter (stateful)  -> SNS Topic
#   Overlap    SSM Parameter             -> Logs LogGroup with the SAME bare name
#                                           (so the two physical ids are EQUAL)
#   EqualBags  SNS Topic {Tags}          -> Logs LogGroup with the SAME {Tags}
#
# What this asserts, by AWS NAME throughout (never by logical id):
#   1. Deploy v1. Both parameters and the topic exist; state records v1 types.
#   2. Deploy v2 WITHOUT --force-stateful-recreation: refused, naming Subject,
#      because the resource being destroyed is a STATEFUL SSM parameter. (The
#      guard used to key on the template's type, AWS::SNS::Topic, and never
#      fired.) Nothing in AWS or state changed.
#   3. Deploy v2 + INJECT_FAIL with the consent flag: all three replacements
#      complete, then FailingQueue is rejected and the AUTOMATIC rollback
#      reverses them. v1 is restored in AWS and in state — each OLD type
#      re-created through its own provider, each new resource deleted.
#   4. The same failing deploy under --no-rollback: v2 has landed, and the
#      journal records BOTH types per op (previousResourceType). Then
#      `cdkd rollback --force` restores v1 and clears the journal.
#   5. Deploy v2 for real. Old resources GONE, new ones exist, state records the
#      v2 types. For Overlap that means the parameter is gone AND the log group
#      of the same name survives. For EqualBags (#3036) the deploy must not have
#      been a no-op.
#   6. Re-deploy v2: "No changes detected" — state really holds the new types.
#   7. Destroy: 0 errors, state gone, every physical name from both variants
#      confirmed gone.
#
# This fixture INTENTIONALLY fails deploys, so the EXIT trap sweeps every
# deterministic physical name from both variants before it drops the state.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdTypeChangeReplacementExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/type-change-replacement"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

# Physical names, per row and variant. The two EqualBags names are the ones
# cdkd GENERATES for a nameless topic / log group (`<stack>-<logicalId>`, the
# log group under `/cdkd/`); step 1 and step 5 cross-check them against the
# physical id state records, so a change to that derivation fails loudly here
# instead of turning the leak checks below into probes of a name nothing uses.
SUBJECT_PARAM="/cdkd-integ/${STACK}/subject"
SUBJECT_TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${STACK}-subject"
OVERLAP_NAME="/cdkd-integ/${STACK}/overlap" # parameter in v1, log group in v2
EQUALBAGS_TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${STACK}-EqualBags"
EQUALBAGS_LOG_GROUP="/cdkd/${STACK}-EqualBags"
FAILING_QUEUE_NAME="${STACK}-failing-queue"

LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} logs=${LOG_DIR}"

# --- Readers ---------------------------------------------------------------

# Echo one field of one state record ("MISSING" when the record or the field is
# absent, so the caller's assertion prints instead of the capture aborting).
state_field() { # usage: state_field <logicalId> <field>
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg id "$1" --arg f "$2" '.resources[$id][$f] // "MISSING"' <<<"${body}"
}

# Echo the number of resources state records.
state_resource_count() {
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq '(.resources // {}) | length' <<<"${body}"
}

# Echo "present" when a log group with EXACTLY this name exists, else "absent".
# `describe-log-groups` answers an unknown name with an empty list rather than
# an error, so this is a strict capture, not a gone-probe: a throttle fails the
# run instead of reading as "absent". Rows of a projection, not `length(...)`.
log_group_state() { # usage: log_group_state <name>
  local out
  out="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'].logGroupName" --output text)" || return 1
  if [ "${out}" = "$1" ]; then echo present; else echo absent; fi
}

require_state_field() { # usage: require_state_field <step> <logicalId> <field> <expected>
  local got
  got="$(state_field "$2" "$3")"
  if [ "${got}" != "$4" ]; then
    echo "[verify] FAIL ($1): state ${2}.${3} is '${got}' (expected '$4')"
    exit 1
  fi
}

# The whole v1 world, in AWS and in state. Used after step 1 and after each of
# the two rollbacks, which must put it back exactly.
assert_v1_world() { # usage: assert_v1_world <step>
  local step="$1" lg
  if ! aws ssm get-parameter --name "${SUBJECT_PARAM}" --region "${REGION}" >/dev/null; then
    echo "[verify] FAIL (${step}): Subject's SSM parameter ${SUBJECT_PARAM} does not exist"
    exit 1
  fi
  if ! aws ssm get-parameter --name "${OVERLAP_NAME}" --region "${REGION}" >/dev/null; then
    echo "[verify] FAIL (${step}): Overlap's SSM parameter ${OVERLAP_NAME} does not exist"
    exit 1
  fi
  if ! aws sns get-topic-attributes --topic-arn "${EQUALBAGS_TOPIC_ARN}" --region "${REGION}" >/dev/null; then
    echo "[verify] FAIL (${step}): EqualBags' topic ${EQUALBAGS_TOPIC_ARN} does not exist"
    exit 1
  fi
  assert_gone "(${step}) Subject's v2 topic ${SUBJECT_TOPIC_ARN} exists in the v1 world" \
    aws sns get-topic-attributes --topic-arn "${SUBJECT_TOPIC_ARN}" --region "${REGION}"
  lg="$(log_group_state "${OVERLAP_NAME}")"
  if [ "${lg}" != "absent" ]; then
    echo "[verify] FAIL (${step}): Overlap's v2 log group ${OVERLAP_NAME} exists in the v1 world"
    exit 1
  fi
  lg="$(log_group_state "${EQUALBAGS_LOG_GROUP}")"
  if [ "${lg}" != "absent" ]; then
    echo "[verify] FAIL (${step}): EqualBags' v2 log group ${EQUALBAGS_LOG_GROUP} exists in the v1 world"
    exit 1
  fi
  require_state_field "${step}" Subject resourceType AWS::SSM::Parameter
  require_state_field "${step}" Subject physicalId "${SUBJECT_PARAM}"
  require_state_field "${step}" Overlap resourceType AWS::SSM::Parameter
  require_state_field "${step}" Overlap physicalId "${OVERLAP_NAME}"
  require_state_field "${step}" EqualBags resourceType AWS::SNS::Topic
  require_state_field "${step}" EqualBags physicalId "${EQUALBAGS_TOPIC_ARN}"
  local count
  count="$(state_resource_count)"
  if [ "${count}" != "3" ]; then
    echo "[verify] FAIL (${step}): state records ${count} resource(s) (expected 3)"
    exit 1
  fi
}

# The whole v2 world.
assert_v2_world() { # usage: assert_v2_world <step>
  local step="$1" lg
  assert_gone "(${step}) Subject's OLD SSM parameter ${SUBJECT_PARAM} still exists" \
    aws ssm get-parameter --name "${SUBJECT_PARAM}" --region "${REGION}"
  if ! aws sns get-topic-attributes --topic-arn "${SUBJECT_TOPIC_ARN}" --region "${REGION}" >/dev/null; then
    echo "[verify] FAIL (${step}): Subject's new topic ${SUBJECT_TOPIC_ARN} does not exist"
    exit 1
  fi
  # Overlap: the two ids are EQUAL. The parameter must be gone AND the log
  # group must have survived the old resource's delete.
  assert_gone "(${step}) Overlap's OLD SSM parameter ${OVERLAP_NAME} still exists" \
    aws ssm get-parameter --name "${OVERLAP_NAME}" --region "${REGION}"
  lg="$(log_group_state "${OVERLAP_NAME}")"
  if [ "${lg}" != "present" ]; then
    echo "[verify] FAIL (${step}): Overlap's new log group ${OVERLAP_NAME} does not exist — the old resource's delete may have been aimed at it"
    exit 1
  fi
  # EqualBags (#3036): identical property bags, so a properties-only no-op
  # check reports nothing to do. The old topic must be GONE and the new log
  # group must EXIST, read from AWS.
  assert_gone "(${step}) EqualBags' OLD topic ${EQUALBAGS_TOPIC_ARN} still exists — the Type change was swallowed" \
    aws sns get-topic-attributes --topic-arn "${EQUALBAGS_TOPIC_ARN}" --region "${REGION}"
  lg="$(log_group_state "${EQUALBAGS_LOG_GROUP}")"
  if [ "${lg}" != "present" ]; then
    echo "[verify] FAIL (${step}): EqualBags' new log group ${EQUALBAGS_LOG_GROUP} does not exist — the Type change was swallowed"
    exit 1
  fi
  require_state_field "${step}" Subject resourceType AWS::SNS::Topic
  require_state_field "${step}" Subject physicalId "${SUBJECT_TOPIC_ARN}"
  require_state_field "${step}" Overlap resourceType AWS::Logs::LogGroup
  require_state_field "${step}" Overlap physicalId "${OVERLAP_NAME}"
  require_state_field "${step}" EqualBags resourceType AWS::Logs::LogGroup
  require_state_field "${step}" EqualBags physicalId "${EQUALBAGS_LOG_GROUP}"
}

# --- Teardown ---------------------------------------------------------------

# Every deterministic physical name from BOTH variants, deleted directly. Runs
# BEFORE the state record is dropped, and does not depend on it.
aggressive_cleanup() {
  echo "[verify] aggressive cleanup: sweeping every fixture physical name"
  (
  set +eu
  local q_url
  aws ssm delete-parameter --name "${SUBJECT_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${OVERLAP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${SUBJECT_TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${EQUALBAGS_TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "${OVERLAP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "${EQUALBAGS_LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
  q_url="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true)"
  if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  )
}

# Drop the stack's whole S3 prefix (state, journal, lock, events sidecars).
# Scope-guarded: the prefix is built from a variable, and an empty one would
# widen the delete to every stack in the bucket.
remove_state_prefix() {
  case "${STACK:-}" in
    CdkdTypeChange?*)
      aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
      ;;
    *)
      echo "[verify] WARN: teardown sweep refused — STACK='${STACK:-}' is not this fixture's stack" >&2
      ;;
  esac
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup (deploy/rollback logs kept in ${LOG_DIR})"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    aggressive_cleanup
  fi
  # ALWAYS remove the events / journal / state sidecars so the integ leaves
  # nothing behind (events deliberately survive destroy). After the name sweep
  # above, never before it.
  echo "[verify] cleanup: remove sidecars"
  remove_state_prefix
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Run a cdkd command, keep its output, echo it, and hand back the exit code in
# RUN_RC — so a failing command's output is in the harness log BEFORE the
# assertion on its exit code runs.
RUN_RC=0
run_logged() { # usage: run_logged <log-file> <command...>
  local log="$1"
  shift
  set +e
  "$@" >"${log}" 2>&1
  RUN_RC=$?
  set -e
  sed 's/^/  /' "${log}" || true
}

echo "[verify] step 0: install + build cdkd (root) + fixture deps, then a pre-run sweep"
(cd "${REPO_ROOT}" && CI=true pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi
aggressive_cleanup
remove_state_prefix

# ---------------------------------------------------------------------------
echo "[verify] step 1: deploy ${STACK} v1"
run_logged "${LOG_DIR}/1-v1.log" env TYPE_VARIANT=v1 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
if [ "${RUN_RC}" -ne 0 ]; then
  echo "[verify] FAIL (step 1): v1 deploy exited ${RUN_RC} (output above)"
  exit 1
fi
assert_v1_world "step 1"
# The #3036 arm is only the #3036 arm if EqualBags' RECORDED bag equals the bag
# its v2 type declares (lib/: the same `Tags` list under both types). If cdkd
# ever records more than the template declared (a generated name, a normalised
# Tags shape), the two bags differ, the no-op skip is never in play, and the
# steps below would pass on an engine that still swallows an equal-bag change.
STATE_BODY_V1="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
EQUALBAGS_RECORDED="$(jq -cS '.resources.EqualBags.properties' <<<"${STATE_BODY_V1}")"
EQUALBAGS_DECLARED="$(jq -cnS --arg stack "${STACK}" '{Tags: [{Key: "cdkd-integ-fixture", Value: $stack}]}')"
if [ "${EQUALBAGS_RECORDED}" != "${EQUALBAGS_DECLARED}" ]; then
  echo "[verify] FAIL (step 1): EqualBags' recorded bag is not the bag both of its types declare, so the #3036 arm would be vacuous"
  echo "    recorded: ${EQUALBAGS_RECORDED}"
  echo "    declared: ${EQUALBAGS_DECLARED}"
  exit 1
fi
echo "[verify] step 1 ok: v1 deployed — two parameters and a topic, state records the v1 types"

# ---------------------------------------------------------------------------
echo "[verify] step 2: deploy v2 WITHOUT --force-stateful-recreation (expect the stateful refusal, keyed on the OLD type)"
run_logged "${LOG_DIR}/2-refused.log" env TYPE_VARIANT=v2 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
if [ "${RUN_RC}" -eq 0 ]; then
  echo "[verify] FAIL (step 2): the v2 deploy SUCCEEDED without --force-stateful-recreation — the stateful guard did not evaluate the SSM parameter being destroyed"
  exit 1
fi
if ! grep -q -- '--force-stateful-recreation' "${LOG_DIR}/2-refused.log"; then
  echo "[verify] FAIL (step 2): the deploy failed, but not with the stateful refusal (no --force-stateful-recreation in its output)"
  exit 1
fi
# Sentinel on the same line as the parsed marker, keyed on a DIFFERENT
# substring: the refusal must name the row and the type being destroyed.
# (Captured first, then matched from a here-string: `grep | grep -q` under
# pipefail can fail on the first grep's SIGPIPE.)
REFUSAL_LINES="$(grep -- '--force-stateful-recreation' "${LOG_DIR}/2-refused.log" || true)"
if ! grep -q 'Subject (AWS::SSM::Parameter)' <<<"${REFUSAL_LINES}"; then
  echo "[verify] FAIL (step 2): the stateful refusal does not name 'Subject (AWS::SSM::Parameter)' — the wording moved, or the wrong row / type was evaluated"
  exit 1
fi
assert_v1_world "step 2"
echo "[verify] step 2 ok: refused on the stateful OLD type; AWS and state unchanged"

# ---------------------------------------------------------------------------
echo "[verify] step 3: deploy v2 + INJECT_FAIL with the consent flag (expect FAILURE after the replacements, then a clean AUTOMATIC rollback)"
run_logged "${LOG_DIR}/3-autorollback.log" env TYPE_VARIANT=v2 INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --force-stateful-recreation
if [ "${RUN_RC}" -eq 0 ]; then
  echo "[verify] FAIL (step 3): the INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
# Prove the failure came AFTER the replacements, or this arm measures nothing.
if ! grep -q 'Reversing replacement of Subject' "${LOG_DIR}/3-autorollback.log"; then
  echo "[verify] FAIL (step 3): the automatic rollback did not reverse Subject's replacement — the deploy failed before the Type change landed, so this arm was not exercised"
  exit 1
fi
if ! grep -q 'Reversing replacement of Overlap' "${LOG_DIR}/3-autorollback.log"; then
  echo "[verify] FAIL (step 3): the automatic rollback did not reverse Overlap's replacement (equal physical ids across two types must still classify as a replacement)"
  exit 1
fi
if ! grep -q 'Reversing replacement of EqualBags' "${LOG_DIR}/3-autorollback.log"; then
  echo "[verify] FAIL (step 3): the automatic rollback did not reverse EqualBags' replacement — the Type change was swallowed by the no-op skip (#3036)"
  exit 1
fi
assert_gone "(step 3) FailingQueue ${FAILING_QUEUE_NAME} exists — the injected CreateQueue should have been rejected" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"
assert_v1_world "step 3"
echo "[verify] step 3 ok: automatic rollback re-created each OLD type and deleted each new resource"

# ---------------------------------------------------------------------------
echo "[verify] step 4: the same failing deploy under --no-rollback (expect v2 to have landed and the journal to record BOTH types)"
run_logged "${LOG_DIR}/4-norollback.log" env TYPE_VARIANT=v2 INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --force-stateful-recreation --no-rollback
if [ "${RUN_RC}" -eq 0 ]; then
  echo "[verify] FAIL (step 4): the INJECT_FAIL --no-rollback deploy unexpectedly SUCCEEDED"
  exit 1
fi
assert_v2_world "step 4"
JOURNAL_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# "<logicalId> <new type> <old type>" per completed op of the newest segment.
JOURNAL_TYPES="$(jq -r '.segments[-1].operations[] | "\(.logicalId) \(.resourceType) \(.previousResourceType // "MISSING")"' <<<"${JOURNAL_BODY}" | sort)"
EXPECTED_JOURNAL_TYPES="$(printf '%s\n' \
  'EqualBags AWS::Logs::LogGroup AWS::SNS::Topic' \
  'Overlap AWS::Logs::LogGroup AWS::SSM::Parameter' \
  'Subject AWS::SNS::Topic AWS::SSM::Parameter' | sort)"
if [ "${JOURNAL_TYPES}" != "${EXPECTED_JOURNAL_TYPES}" ]; then
  echo "[verify] FAIL (step 4): the journal does not record both types per replacement:"
  printf '%s\n' "${JOURNAL_TYPES}" | sed 's/^/    got:      /'
  printf '%s\n' "${EXPECTED_JOURNAL_TYPES}" | sed 's/^/    expected: /'
  exit 1
fi
echo "[verify] step 4 ok: v2 landed under --no-rollback; the journal names the old AND the new type of all three ops"

echo "[verify] step 4a: cdkd rollback ${STACK} --force (expect v1 restored, journal cleared, exit 0)"
run_logged "${LOG_DIR}/4a-rollback.log" ${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force
if [ "${RUN_RC}" -ne 0 ]; then
  echo "[verify] FAIL (step 4a): cdkd rollback exited ${RUN_RC} (output above)"
  exit 1
fi
assert_v1_world "step 4a"
assert_gone "(step 4a) rollback journal still present after a clean rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
echo "[verify] step 4a ok: cdkd rollback reversed all three Type changes"

# ---------------------------------------------------------------------------
echo "[verify] step 5: deploy v2 for real"
run_logged "${LOG_DIR}/5-v2.log" env TYPE_VARIANT=v2 \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --force-stateful-recreation
if [ "${RUN_RC}" -ne 0 ]; then
  echo "[verify] FAIL (step 5): the v2 deploy exited ${RUN_RC} (output above)"
  exit 1
fi
assert_v2_world "step 5"
V2_COUNT="$(state_resource_count)"
if [ "${V2_COUNT}" != "3" ]; then
  echo "[verify] FAIL (step 5): state records ${V2_COUNT} resource(s) (expected 3)"
  exit 1
fi
echo "[verify] step 5 ok: each old resource deleted through its own type, each new one created, state records the v2 types"

# ---------------------------------------------------------------------------
echo "[verify] step 6: re-deploy v2 (expect 'No changes detected')"
run_logged "${LOG_DIR}/6-noop.log" env TYPE_VARIANT=v2 \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --force-stateful-recreation
if [ "${RUN_RC}" -ne 0 ]; then
  echo "[verify] FAIL (step 6): the v2 re-deploy exited ${RUN_RC} (output above)"
  exit 1
fi
if ! grep -qi 'No changes detected' "${LOG_DIR}/6-noop.log"; then
  echo "[verify] FAIL (step 6): the v2 re-deploy was not a no-op — state does not hold the v2 types, so the Type change is re-planned on every deploy"
  exit 1
fi
assert_v2_world "step 6"
echo "[verify] step 6 ok: the second v2 deploy had nothing to do"

# ---------------------------------------------------------------------------
echo "[verify] step 7: cdkd destroy ${STACK} --force"
run_logged "${LOG_DIR}/7-destroy.log" ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
if [ "${RUN_RC}" -ne 0 ]; then
  echo "[verify] FAIL (step 7): destroy exited ${RUN_RC} (output above)"
  exit 1
fi

echo "[verify] step 7a: assert destroy is clean (state gone, every physical name from BOTH variants gone)"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Subject's SSM parameter ${SUBJECT_PARAM} still exists after destroy" \
  aws ssm get-parameter --name "${SUBJECT_PARAM}" --region "${REGION}"
assert_gone "Overlap's SSM parameter ${OVERLAP_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${OVERLAP_NAME}" --region "${REGION}"
assert_gone "Subject's topic ${SUBJECT_TOPIC_ARN} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${SUBJECT_TOPIC_ARN}" --region "${REGION}"
assert_gone "EqualBags' topic ${EQUALBAGS_TOPIC_ARN} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${EQUALBAGS_TOPIC_ARN}" --region "${REGION}"
assert_gone "FailingQueue ${FAILING_QUEUE_NAME} still exists after destroy" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"
for lg_name in "${OVERLAP_NAME}" "${EQUALBAGS_LOG_GROUP}"; do
  LG_AFTER="$(log_group_state "${lg_name}")"
  if [ "${LG_AFTER}" != "absent" ]; then
    echo "[verify] FAIL (step 7a): log group ${lg_name} still exists after destroy"
    exit 1
  fi
done
echo "[verify] step 7a ok: destroy clean, 0 orphans"

echo "[verify] step 8: cleanup — remove the events sidecars so the integ leaves nothing behind"
remove_state_prefix
# `--recursive` is load-bearing: a delimited listing of this prefix returns
# only `PRE <region>/`, so a non-recursive check could never fail.
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive 2>&1 || true)"
if grep -E -q '\.(jsonl|json)$' <<<"${REMAINING}"; then
  echo "[verify] FAIL (step 8): sidecar not fully removed for ${STACK}:"
  sed 's/^/  /' <<<"${REMAINING}"
  exit 1
fi
echo "[verify] step 8 ok: sidecars removed"

trap - EXIT INT TERM
echo "[verify] PASS — a resource Type change is a replacement routed per half, forward and in both rollbacks"
