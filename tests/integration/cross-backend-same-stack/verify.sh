#!/usr/bin/env bash
# go-to-k/cdkd#4705: one stack name deployed under two state prefixes in the
# same account and region is unsupported (a stack name is unique per account
# and region, as in CloudFormation), and cdkd refuses the pair it can see.
# Before the fix, deployment B was handed A's queue and log group, rewrote the
# log group's retention, and its rollback deleted A's queue.
#
#   1. Deploy deployment A of Cdkd4705Verify under PREFIX_A with the LogGroup's
#      retention at 7 days. Capture A's queue URL, log group name and role name
#      from A's state.
#   2. Deploy deployment B of the SAME stack under PREFIX_B with retention 3,
#      rollback ON (the default). Every name is cdkd-generated from the stack
#      name and logical id, so B asks AWS for A's names: the Role collides, the
#      Queue and the LogGroup may be handed back.
#   3. OBSERVE (unique `OBSERVE:` lines): B's exit code, which resources failed
#      with which awsErrorCode and what B's rollback did (B's deployments/*.jsonl),
#      whether A's queue still exists, the log group's retention, and what B's
#      state and state.orphans hold. Then ASSERT: B is refused with the
#      cross-prefix refusal before any create, A's queue still exists, the log
#      group keeps A's retention, and B has no state record or journal.
#   4. Seed a pre-fix pair (A's state.json copied to B's key): `cdkd destroy`
#      under PREFIX_A must be refused and leave A's queue, and `cdkd rollback`
#      under PREFIX_A (over a seeded, empty journal) must be refused and keep
#      the journal. Remove the journal seed.
#   5. Negative control: redeploy A under PREFIX_A while the seeded B record
#      still exists; it must succeed. Then remove that seed.
#   5b. A successful deploy under PREFIX_B (a minimal template) whose journal
#      holds a proven failed-CREATE orphan naming A's KMS key: the settle must
#      KEEP the key (warn, exit 2), since PREFIX_A's record may hold it.
#   5c. A pre-fix pair whose redeploy under PREFIX_B (an empty record, so not a
#      first deploy, and a plan that only creates) ADDS the Queue -- handed A's
#      queue -- and a resource that fails after it: the AUTOMATIC rollback must
#      KEEP A's queue, warn naming PREFIX_A, and the deploy exits non-zero.
#   6. Destroy A, delete the retained log group.
#   7. Seed an EMPTY record plus a failed first deploy's journal under PREFIX_B:
#      a fresh deploy and a destroy under PREFIX_A must succeed, and each
#      must print the note naming PREFIX_B.
#
# Each run uses its OWN two state prefixes (unique per run): nothing under
# `cdkd/` is read or written, and the trap deletes only these two prefixes.
#
# Run via: /run-integ cross-backend-same-stack
#         or: bash tests/integration/cross-backend-same-stack/verify.sh

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
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="Cdkd4705Verify"
RETENTION_A=7
RETENTION_B=3
PREFIX_A="${STATE_PREFIX_A:-cdkd-4705a-$(date +%s)-$$}"
PREFIX_B="${STATE_PREFIX_B:-cdkd-4705b-$(date +%s)-$$}"
STATE_KEY_A="${PREFIX_A}/${STACK}/${REGION}/state.json"
STATE_KEY_B="${PREFIX_B}/${STACK}/${REGION}/state.json"
JOURNAL_KEY_A="${PREFIX_A}/${STACK}/${REGION}/rollback-journal.json"
JOURNAL_KEY_B="${PREFIX_B}/${STACK}/${REGION}/rollback-journal.json"
EVENTS_PREFIX_B="${PREFIX_B}/${STACK}/${REGION}/deployments/"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"
# Copied from src/state/cross-prefix-stack-scan.ts: each matches the FOUND
# message only (the could-not-check refusal words it differently), and every
# check below also asserts the other prefix the message names.
DEPLOY_REFUSAL_NEEDLE="is already recorded under another state prefix of bucket"
DESTROY_REFUSAL_NEEDLE="is also recorded under another state prefix of bucket"
ROLLBACK_REFUSAL_NEEDLE="Refusing to roll back stack"
STALE_NOTICE_NEEDLE="that owns no resource"
SETTLE_KEEP_NEEDLE="also records this stack under another state prefix"
# Copied from `keptForAnotherHolder` in src/deployment/rollback-executor/messages.ts.
AUTO_ROLLBACK_KEEP_NEEDLE="Rollback: Keeping created resource"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found -- run 'vp run build' first" >&2
  exit 1
fi

# Set only from what THIS run's state recorded; the trap acts on nothing else.
QUEUE_URL_A=""
LOG_GROUP_NAME=""
ROLE_NAME_A=""
# Every KMS key id this run's deploys recorded (the trap schedules any left).
KEY_IDS=""
# Phase 5b's SSM parameter under PREFIX_B, by the exact name B's record names
# (Phase 5c reuses it for a FailLater parameter that unexpectedly got created).
MINIMAL_PARAM_B=""
RUN_LOG=""
# Set just before this run's own first deploy: a pre-flight FAIL (a peer's run,
# or a leftover holding these names) must leave those resources alone.
DEPLOYED_A=""
DEPLOYED_B=""
# Phase 4 builds it from A's record; Phase 7 seeds it.
EMPTY_RECORD=""
# Set while Phase 4's seeded journal under PREFIX_A exists.
SEEDED_JOURNAL_A=""

# A KMS key's state (Enabled, PendingDeletion, ...).
key_state() { # usage: key_state <key id>
  aws kms describe-key --key-id "$1" --region "${REGION}" --query 'KeyMetadata.KeyState' --output text
}

# One field of A's or B's state, by resource type: `state_physical_id <key> <type>`.
state_physical_id() {
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/$1" -)" || return 1
  printf '%s' "${body}" | jq -r --arg t "$2" \
    '[(.resources // {})[] | select(.resourceType == $t) | .physicalId] | first // ""'
}

# The log group's current retention in days, "None" when it has none, or
# "<absent>" when no log group of that exact name exists.
log_group_retention() {
  local out
  out="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP_NAME}" --region "${REGION}" \
    --query "logGroups[?logGroupName=='${LOG_GROUP_NAME}'] | [0].retentionInDays" --output text)" || return 1
  if [ "$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP_NAME}" --region "${REGION}" \
    --query "length(logGroups[?logGroupName=='${LOG_GROUP_NAME}'])" --output text)" = "0" ]; then
    echo "<absent>"
  else
    echo "${out}"
  fi
}

# Every event of B's runs, one compact JSON object per line.
events_b() {
  local keys key
  keys="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${EVENTS_PREFIX_B}" \
    --query "Contents[?ends_with(Key, '.jsonl')].Key" --output text)" || return 1
  for key in ${keys}; do
    [ "${key}" = "None" ] && continue
    aws s3 cp "s3://${STATE_BUCKET}/${key}" - | jq -c '.' || return 1
  done
}

# Delete one run prefix, only the per-run shape and only once its state record
# and journal are gone: a record that survived a failed teardown is the one way
# back to its resources. Never under `cdkd/`.
sweep_prefix() { # usage: sweep_prefix <prefix> <state key> <journal key>
  case "${1:-}" in
    */*)
      echo "WARN: teardown sweep refused: prefix '$1' contains '/'" >&2
      ;;
    cdkd-4705a-[0-9]*-[0-9]* | cdkd-4705b-[0-9]*-[0-9]*)
      if ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$2" ) &&
        ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$3" ); then
        aws s3 rm "s3://${STATE_BUCKET}/$1/" --recursive >/dev/null 2>&1
      else
        echo "WARN: teardown incomplete; records kept under s3://${STATE_BUCKET:-}/$1/ (pass --state-prefix $1 to cdkd state destroy)" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: prefix '${1:-}' is not this fixture's cdkd-4705a-* / cdkd-4705b-* prefix" >&2
      ;;
  esac
}

# Delete this fixture's generated-name roles and queues: names starting with
# exactly `Cdkd4705Verify-`, and only when STACK is that literal.
sweep_named() {
  local url name role arn policy
  case "${STACK:-}" in
    Cdkd4705Verify) ;;
    *)
      echo "WARN: teardown sweep refused: STACK '${STACK:-}' is not Cdkd4705Verify" >&2
      return 0
      ;;
  esac
  for url in $(aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" --query 'QueueUrls' --output text 2>/dev/null); do
    name="${url##*/}"
    case "${name}" in
      "${STACK}"-?*) aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text 2>/dev/null); do
    case "${role}" in
      "${STACK}"-?*)
        for arn in $(aws iam list-attached-role-policies --role-name "${role}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
          [ "${arn}" = "None" ] || aws iam detach-role-policy --role-name "${role}" --policy-arn "${arn}" >/dev/null 2>&1
        done
        for policy in $(aws iam list-role-policies --role-name "${role}" --query 'PolicyNames' --output text 2>/dev/null); do
          [ "${policy}" = "None" ] || aws iam delete-role-policy --role-name "${role}" --policy-name "${policy}" >/dev/null 2>&1
        done
        aws iam delete-role --role-name "${role}" >/dev/null 2>&1
        ;;
    esac
  done
}

# WARN when a listing names anything, or could not be read: `warn_left <what> aws ...`.
warn_left() {
  local what="$1" left
  shift
  if left="$("$@" 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || echo "WARN: ${what} left: ${left}" >&2
  else
    echo "WARN: could not list ${what}: ${left}" >&2
  fi
}

# WARN on anything of this fixture still in AWS or in S3.
rescan() {
  warn_left "queues (a just-deleted queue can list for 60s)" \
    aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" --query 'QueueUrls' --output text
  warn_left "roles" \
    aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text
  warn_left "log groups" \
    aws logs describe-log-groups --log-group-name-prefix "/cdkd/${STACK}-" --region "${REGION}" --query 'logGroups[].logGroupName' --output text
  warn_left "SSM parameters" \
    aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=/${STACK}-" --region "${REGION}" --query 'Parameters[].Name' --output text
  for p in "${PREFIX_A}" "${PREFIX_B}"; do
    warn_left "objects under s3://${STATE_BUCKET:-}/${p}/" \
      aws s3api list-objects-v2 --bucket "${STATE_BUCKET:-}" --prefix "${p}/" --query 'Contents[].Key' --output text
  done
}

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors tolerated)"
  rm -f "${RUN_LOG:-}"
  # B first, and only its RECORD: whatever B's record (or Phase 4's seed) names
  # is A's resources, which A's destroy and the name sweep below delete. A
  # `state destroy` of B would also be refused while A's record exists.
  if [ "${DEPLOYED_B:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}" ); }; then
    node "${LOCAL_DIST}" state orphan "${STACK}" --stack-region "${REGION}" --state-bucket "${STATE_BUCKET:-}" \
      --state-prefix "${PREFIX_B}" --force >/dev/null 2>&1
  fi
  # Phase 4's seeded journal: an empty segment this run wrote, by its exact key.
  if [ "${SEEDED_JOURNAL_A:-}" = "1" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY_A}" >/dev/null 2>&1
  fi
  if [ "${DEPLOYED_A:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_A}" ); }; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${PREFIX_A}" --region "${REGION}" \
      --yes >/dev/null 2>&1
  fi
  # Phase 5b's parameter, by the exact name B's record named.
  case "${MINIMAL_PARAM_B:-}" in
    *"${STACK}"-?*) aws ssm delete-parameter --name "${MINIMAL_PARAM_B}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  # Every key this run recorded that is still enabled (a destroy schedules it).
  for key_id in ${KEY_IDS:-}; do
    if [ "$(key_state "${key_id}" 2>/dev/null)" = "Enabled" ]; then
      aws kms schedule-key-deletion --key-id "${key_id}" --pending-window-in-days 7 --region "${REGION}" >/dev/null 2>&1
    fi
  done
  # The RETAINed log group, by the exact name A's state recorded.
  case "${LOG_GROUP_NAME:-}" in
    "/cdkd/${STACK}"-?*) aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  if [ "${DEPLOYED_A:-}" = "1" ]; then
    sweep_named
  fi
  sweep_prefix "${PREFIX_A}" "${STATE_KEY_A}" "${JOURNAL_KEY_A}"
  sweep_prefix "${PREFIX_B}" "${STATE_KEY_B}" "${JOURNAL_KEY_B}"
  rescan
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight"
for key in "${STATE_KEY_A}" "${STATE_KEY_B}" "${JOURNAL_KEY_A}" "${JOURNAL_KEY_B}"; do
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"; then
    echo "FAIL: s3://${STATE_BUCKET}/${key} already exists -- clean up a previous run first" >&2
    exit 1
  fi
done
# A leftover holding one of this stack's generated names would be handed back
# or collide, and would confound every observation. Never deleted here: it is
# not this run's.
LEFT="$(aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" --query 'QueueUrls' --output text)"
LEFT="${LEFT}$(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text)"
LEFT="${LEFT}$(aws logs describe-log-groups --log-group-name-prefix "/cdkd/${STACK}-" --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
LEFT="$(printf '%s' "${LEFT}" | sed 's/None//g' | tr -d '[:space:]')"
if [ -n "${LEFT}" ]; then
  echo "FAIL: a queue, role or log group named ${STACK}-* already exists -- delete it by hand first (${LEFT})" >&2
  exit 1
fi

RUN_LOG="$(mktemp)"

echo ""
echo "==> Phase 1: deploy A under ${PREFIX_A} (retention ${RETENTION_A})"
DEPLOYED_A=1
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes
QUEUE_URL_A="$(state_physical_id "${STATE_KEY_A}" 'AWS::SQS::Queue')"
LOG_GROUP_NAME="$(state_physical_id "${STATE_KEY_A}" 'AWS::Logs::LogGroup')"
ROLE_NAME_A="$(state_physical_id "${STATE_KEY_A}" 'AWS::IAM::Role')"
KEY_ID_A="$(state_physical_id "${STATE_KEY_A}" 'AWS::KMS::Key')"
case "${KEY_ID_A}" in
  [0-9a-f]*-?*) KEY_IDS="${KEY_IDS} ${KEY_ID_A}" ;;
  *) echo "FAIL: A's state does not record a KMS key id (got '${KEY_ID_A}')" >&2; exit 1 ;;
esac
case "${QUEUE_URL_A}" in
  https://*/"${STACK}"-?*) ;;
  *)
    echo "FAIL: A's state does not record a ${STACK}-* queue URL (got '${QUEUE_URL_A}')" >&2
    exit 1
    ;;
esac
case "${LOG_GROUP_NAME}" in
  "/cdkd/${STACK}"-?*) ;;
  *)
    echo "FAIL: A's state does not record a /cdkd/${STACK}-* log group (got '${LOG_GROUP_NAME}')" >&2
    exit 1
    ;;
esac
case "${ROLE_NAME_A}" in
  "${STACK}"-?*) ;;
  *)
    echo "FAIL: A's state does not record a ${STACK}-* role (got '${ROLE_NAME_A}')" >&2
    exit 1
    ;;
esac
RETENTION_AFTER_A="$(log_group_retention)"
if [ "${RETENTION_AFTER_A}" != "${RETENTION_A}" ]; then
  echo "FAIL: the log group's retention is '${RETENTION_AFTER_A}' after A's deploy (expected ${RETENTION_A})" >&2
  exit 1
fi
echo "    OK: queue ${QUEUE_URL_A}, log group ${LOG_GROUP_NAME} (retention ${RETENTION_A}), role ${ROLE_NAME_A}"

echo ""
echo "==> Phase 2: deploy B of the SAME stack under ${PREFIX_B} (retention ${RETENTION_B}, rollback on)"
DEPLOYED_B=1
set +e
CDKD_4705_RETENTION_DAYS="${RETENTION_B}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --yes >"${RUN_LOG}" 2>&1
B_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"

echo ""
echo "==> Phase 3: observe"
echo "OBSERVE: b-deploy-rc=${B_RC}"
if B_EVENTS="$(events_b)"; then
  if [ -z "${B_EVENTS}" ]; then
    echo "OBSERVE: b-events=<none recorded under s3://${STATE_BUCKET}/${EVENTS_PREFIX_B}>"
  else
    printf '%s\n' "${B_EVENTS}" | jq -r '
      select(.logicalId != null and (.eventType | test("^(RESOURCE_(SUCCEEDED|FAILED|RETAINED|SKIPPED)|ROLLBACK_RESOURCE_.*)$")))
      | "OBSERVE: b-event \(.eventType) \(.logicalId) (\(.resourceType // "?")) physicalId=\(.physicalId // "-") awsErrorCode=\(.error.awsErrorCode // "-") error=\(.error.name // "-")"'
  fi
else
  echo "OBSERVE: b-events=<unreadable>"
fi
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  A_QUEUE="gone"
else
  A_QUEUE="exists"
fi
echo "OBSERVE: a-queue=${A_QUEUE} (${QUEUE_URL_A})"
RETENTION_AFTER_B="$(log_group_retention)"
echo "OBSERVE: log-group-retention=${RETENTION_AFTER_B} (A deployed ${RETENTION_A}, B deployed ${RETENTION_B}) ${LOG_GROUP_NAME}"
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"; then
  echo "OBSERVE: b-state=<absent>"
else
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_B}" - | jq -r '
    "OBSERVE: b-state resources=\([(.resources // {}) | to_entries[] | "\(.key)=\(.value.physicalId)"] | join(","))",
    "OBSERVE: b-state orphans=\([(.orphans // [])[] | "\(.logicalId)=\(.state.physicalId // "?")"] | join(","))"'
fi
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"; then
  echo "OBSERVE: b-journal=<absent>"
else
  echo "OBSERVE: b-journal=<present>"
fi
echo "OBSERVE: a-state queue=$(state_physical_id "${STATE_KEY_A}" 'AWS::SQS::Queue') log-group=$(state_physical_id "${STATE_KEY_A}" 'AWS::Logs::LogGroup')"

FAILED=""
if [ "${B_RC}" -eq 0 ]; then
  echo "FAIL: deployment B of ${STACK} under a second state prefix SUCCEEDED; it must be refused (go-to-k/cdkd#4705)" >&2
  FAILED=1
fi
# Copied from `deployUnderOtherPrefixMessage` in src/state/cross-prefix-stack-scan.ts.
if ! grep -qF "${DEPLOY_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_A})" "${RUN_LOG}"; then
  echo "FAIL: deployment B did not fail with the cross-prefix refusal naming ${PREFIX_A} ('${DEPLOY_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  FAILED=1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"; then
  echo "FAIL: deployment B left a state record ${STATE_KEY_B}; the refusal must come before any create (go-to-k/cdkd#4705)" >&2
  FAILED=1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"; then
  echo "FAIL: deployment B left a rollback journal ${JOURNAL_KEY_B}; the refusal must come before any create (go-to-k/cdkd#4705)" >&2
  FAILED=1
fi
if [ "${A_QUEUE}" != "exists" ]; then
  echo "FAIL: deployment A's queue ${QUEUE_URL_A} is gone after deployment B's deploy under another state prefix (go-to-k/cdkd#4705)" >&2
  FAILED=1
fi
if [ "${RETENTION_AFTER_B}" != "${RETENTION_A}" ]; then
  echo "FAIL: deployment A's log group ${LOG_GROUP_NAME} has retention '${RETENTION_AFTER_B}' after deployment B's deploy (expected A's ${RETENTION_A}; go-to-k/cdkd#4705)" >&2
  FAILED=1
fi
if [ -n "${FAILED}" ]; then
  exit 1
fi
echo "    OK: B was refused before any create; A's queue exists and its log group keeps retention ${RETENTION_A}"

echo ""
echo "==> Phase 4: a pre-fix pair (A's record copied to ${PREFIX_B}) makes cdkd destroy under ${PREFIX_A} refuse"
# Phase 7's empty record: A's record with nothing left in it.
EMPTY_RECORD="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_A}" - | jq -c '.resources = {} | .outputs = {} | del(.orphans)')"
case "${EMPTY_RECORD}" in
  '{'*'"resources":{}'*) ;;
  *) echo "FAIL: could not build an empty record from A's (got '${EMPTY_RECORD}')" >&2; exit 1 ;;
esac
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_A}" "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
set +e
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force >"${RUN_LOG}" 2>&1
PAIR_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
echo "OBSERVE: paired-destroy-rc=${PAIR_RC}"
if [ "${PAIR_RC}" -eq 0 ]; then
  echo "FAIL: cdkd destroy under ${PREFIX_A} exited 0 while ${PREFIX_B} records the same stack (go-to-k/cdkd#4705)" >&2
  exit 1
fi
# Copied from `destroyUnderOtherPrefixMessage` in src/state/cross-prefix-stack-scan.ts.
if ! grep -qF "${DESTROY_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_B})" "${RUN_LOG}"; then
  echo "FAIL: cdkd destroy did not fail with the cross-prefix refusal naming ${PREFIX_B} ('${DESTROY_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  echo "FAIL: deployment A's queue ${QUEUE_URL_A} is gone after a refused destroy (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"; then
  echo "FAIL: A's state record is gone after a refused destroy (go-to-k/cdkd#4705)" >&2
  exit 1
fi
echo "    OK: the destroy was refused; A's queue and record are intact"

# The same pair makes `cdkd rollback` under PREFIX_A refuse. Its journal is a
# seeded, EMPTY segment, so a rollback that wrongly ran would replay nothing.
SEEDED_JOURNAL_A=1
printf '%s' "{\"journalVersion\":1,\"stackName\":\"${STACK}\",\"region\":\"${REGION}\",\"segments\":[{\"timestamp\":1,\"reason\":\"no-rollback-failure\",\"initialDeploy\":false,\"operations\":[],\"failedOperations\":[]}]}" |
  aws s3 cp - "s3://${STATE_BUCKET}/${JOURNAL_KEY_A}" >/dev/null
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force >"${RUN_LOG}" 2>&1
PAIR_ROLLBACK_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
echo "OBSERVE: paired-rollback-rc=${PAIR_ROLLBACK_RC}"
if [ "${PAIR_ROLLBACK_RC}" -eq 0 ]; then
  echo "FAIL: cdkd rollback under ${PREFIX_A} exited 0 while ${PREFIX_B} records the same stack (go-to-k/cdkd#4705)" >&2
  exit 1
fi
# Copied from `destroyUnderOtherPrefixMessage` (rollback arm) in src/state/cross-prefix-stack-scan.ts.
if ! grep -qF "${ROLLBACK_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "${DESTROY_REFUSAL_NEEDLE}" "${RUN_LOG}" ||
  ! grep -qF "(${PREFIX_B})" "${RUN_LOG}"; then
  echo "FAIL: cdkd rollback did not fail with the cross-prefix refusal naming ${PREFIX_B} ('${ROLLBACK_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_A}"; then
  echo "FAIL: the seeded journal ${JOURNAL_KEY_A} is gone after a refused rollback (go-to-k/cdkd#4705)" >&2
  exit 1
fi
aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY_A}" >/dev/null
SEEDED_JOURNAL_A=""
assert_gone "the seeded journal ${JOURNAL_KEY_A} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_A}"

echo "    OK: the rollback was refused and kept its journal; the journal seed is removed"

echo ""
echo "==> Phase 5: negative control -- redeploy A under ${PREFIX_A} WHILE ${PREFIX_B}'s seeded record still exists"
# A stack its own prefix records is not first-deploy checked, and a plan with
# no deletion or replacement is not checked at all.
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes
gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}" &&
  { echo "FAIL: premise: ${STATE_KEY_B} was gone during the negative control" >&2; exit 1; }
aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
assert_gone "the seeded ${STATE_KEY_B} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
echo "    OK: a stack its own prefix records redeploys beside another prefix's record; the seed is removed"

echo ""
echo "==> Phase 5b: a successful deploy under ${PREFIX_B} keeps a journaled orphan that ${PREFIX_A}'s record holds"
# B's record (empty, so B's first-deploy check is not what is tested) and a
# journal whose failed CREATE "recorded" A's KMS key as a proven orphan: the
# settle after B's successful deploy would delete it (a KMS key needs no
# identity read). The cross-prefix consult must keep it, warn, and exit 2.
printf '%s' "${EMPTY_RECORD}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
printf '%s' "{\"journalVersion\":1,\"stackName\":\"${STACK}\",\"region\":\"${REGION}\",\"segments\":[{\"timestamp\":1,\"reason\":\"no-rollback-failure\",\"initialDeploy\":false,\"operations\":[],\"failedOperations\":[{\"logicalId\":\"OrphanKey\",\"changeType\":\"CREATE\",\"resourceType\":\"AWS::KMS::Key\",\"provisionedBy\":\"sdk\",\"physicalId\":\"${KEY_ID_A}\",\"physicalIdRecoveredFromError\":true,\"attemptedProperties\":{}}]}]}" |
  aws s3 cp - "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" >/dev/null
set +e
CDKD_4705_B_MINIMAL=1 node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --yes >"${RUN_LOG}" 2>&1
SETTLE_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
MINIMAL_PARAM_B="$( (aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_B}" - || true) | jq -r '[(.resources // {})[] | select(.resourceType == "AWS::SSM::Parameter") | .physicalId] | first // ""' 2>/dev/null || true)"
echo "OBSERVE: settle-deploy-rc=${SETTLE_RC} minimal-param=${MINIMAL_PARAM_B:-<none>} key-state=$(key_state "${KEY_ID_A}")"
if [ "${SETTLE_RC}" -ne 2 ]; then
  echo "FAIL: the settle deploy under ${PREFIX_B} exited ${SETTLE_RC}, expected 2 (an orphan left unaddressed; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if [ "$(key_state "${KEY_ID_A}")" != "Enabled" ]; then
  echo "FAIL: A's KMS key ${KEY_ID_A} is no longer Enabled after B's settle (go-to-k/cdkd#4705)" >&2
  exit 1
fi
# Copied from `createCrossPrefixHolder` in src/cli/commands/cross-prefix-gate.ts.
if ! grep -qF "${SETTLE_KEEP_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_A})" "${RUN_LOG}"; then
  echo "FAIL: the settle did not say it kept the orphan for ${PREFIX_A}'s record ('${SETTLE_KEEP_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  echo "FAIL: A's queue ${QUEUE_URL_A} is gone after B's settle (go-to-k/cdkd#4705)" >&2
  exit 1
fi
case "${MINIMAL_PARAM_B}" in
  *"${STACK}"-?*) aws ssm delete-parameter --name "${MINIMAL_PARAM_B}" --region "${REGION}" >/dev/null ;;
  *) echo "FAIL: B's record does not name the minimal SSM parameter (got '${MINIMAL_PARAM_B}')" >&2; exit 1 ;;
esac
MINIMAL_PARAM_B=""
node "${LOCAL_DIST}" state orphan "${STACK}" --stack-region "${REGION}" --state-bucket "${STATE_BUCKET:-}" \
  --state-prefix "${PREFIX_B}" --force
assert_gone "${STATE_KEY_B} still exists after the Phase 5b cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "${JOURNAL_KEY_B} still exists after the Phase 5b cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"
echo "    OK: the settle kept A's key (exit 2, warned); B's parameter and record are removed"

echo ""
echo "==> Phase 5c: the AUTOMATIC rollback of a failed deploy under ${PREFIX_B} keeps the queue ${PREFIX_A}'s record holds"
# B's record is empty, so B's deploy is not a first deploy, and its plan only
# CREATEs (the Queue, then FailLater): neither check before the deploy runs.
# The Queue's CreateQueue hands back A's queue; FailLater fails; the automatic
# rollback would delete the "created" queue unless the cross-prefix consult
# keeps it.
printf '%s' "${EMPTY_RECORD}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
set +e
CDKD_4705_B_AUTOROLLBACK=1 node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --yes >"${RUN_LOG}" 2>&1
AUTO_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
B_QUEUE="$( (state_physical_id "${STATE_KEY_B}" 'AWS::SQS::Queue') || true)"
MINIMAL_PARAM_B="$( (state_physical_id "${STATE_KEY_B}" 'AWS::SSM::Parameter') || true)"
echo "OBSERVE: auto-rollback-deploy-rc=${AUTO_RC} b-queue=${B_QUEUE:-<none>} fail-later-param=${MINIMAL_PARAM_B:-<none>}"
if [ "${AUTO_RC}" -eq 0 ]; then
  echo "FAIL: the deploy under ${PREFIX_B} with a failing FailLater exited 0 (output above)" >&2
  exit 1
fi
# The PREMISE, from evidence the rollback does not write: B's create was
# handed A's queue. B's events record the Queue's RESOURCE_SUCCEEDED with A's
# URL, or B's journal its completed CREATE. Without it nothing below is tested.
PREMISE_EVENT="$( (events_b || true) | jq -r --arg q "${QUEUE_URL_A}" \
  'select(.eventType == "RESOURCE_SUCCEEDED" and .logicalId == "Queue4A7E3555" and .physicalId == $q) | .physicalId' 2>/dev/null || true)"
PREMISE_JOURNAL="$( (aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" - || true) | jq -r --arg q "${QUEUE_URL_A}" \
  '[(.segments // [])[] | (.operations // [])[] | select(.logicalId == "Queue4A7E3555" and .physicalId == $q)] | length' 2>/dev/null || true)"
echo "OBSERVE: premise-event=${PREMISE_EVENT:-<none>} premise-journal-ops=${PREMISE_JOURNAL:-<none>}"
if [ -z "${PREMISE_EVENT}" ] && { [ -z "${PREMISE_JOURNAL}" ] || [ "${PREMISE_JOURNAL}" = "0" ]; }; then
  echo "FAIL: premise not met: neither B's events nor B's journal show its Queue CREATE handed A's queue ${QUEUE_URL_A}, so the automatic rollback's keep is untested (output above)" >&2
  exit 1
fi
# The KEEP. An SQS read can still answer for up to 60s after DeleteQueue, so
# the queue's survival is not judged by that probe alone: the rollback's own
# keep line naming ${PREFIX_A}, and B's record still naming the queue (a
# deleted CREATE drops it), must agree with it.
if ! grep -qF "${AUTO_ROLLBACK_KEEP_NEEDLE}" "${RUN_LOG}" || ! grep -qF "${SETTLE_KEEP_NEEDLE}" "${RUN_LOG}" ||
  ! grep -qF "(${PREFIX_A})" "${RUN_LOG}"; then
  echo "FAIL: the automatic rollback did not say it kept the queue for ${PREFIX_A}'s record ('${AUTO_ROLLBACK_KEEP_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if [ "${B_QUEUE}" != "${QUEUE_URL_A}" ]; then
  echo "FAIL: B's record names queue '${B_QUEUE}' after the rollback, not the kept ${QUEUE_URL_A} (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  echo "FAIL: A's queue ${QUEUE_URL_A} is gone after B's automatic rollback (go-to-k/cdkd#4705)" >&2
  exit 1
fi
case "${MINIMAL_PARAM_B}" in
  "") ;;
  *"${STACK}"-?*) aws ssm delete-parameter --name "${MINIMAL_PARAM_B}" --region "${REGION}" >/dev/null ;;
  *) echo "FAIL: B's record names an unexpected SSM parameter '${MINIMAL_PARAM_B}'" >&2; exit 1 ;;
esac
MINIMAL_PARAM_B=""
# Only B's record and journal: the queue they name is A's.
node "${LOCAL_DIST}" state orphan "${STACK}" --stack-region "${REGION}" --state-bucket "${STATE_BUCKET:-}" \
  --state-prefix "${PREFIX_B}" --force
assert_gone "${STATE_KEY_B} still exists after the Phase 5c cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "${JOURNAL_KEY_B} still exists after the Phase 5c cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  echo "FAIL: A's queue ${QUEUE_URL_A} is gone after the Phase 5c cleanup" >&2
  exit 1
fi
echo "    OK: the automatic rollback kept A's queue (warned, rc ${AUTO_RC}); B's record and journal are removed"

echo ""
echo "==> Phase 6: destroy A; delete the retained log group"
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force
assert_gone "state ${STATE_KEY_A} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"
assert_gone "state ${STATE_KEY_B} exists at the end of the run" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "role ${ROLE_NAME_A} still exists after the destroy" \
  aws iam get-role --role-name "${ROLE_NAME_A}"
aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}"
echo "    OK: both records are gone and the retained log group is deleted"

echo ""
echo "==> Phase 7: an EMPTY leftover record under ${PREFIX_B} (a failed first deploy's) does not block ${PREFIX_A}"
# The shape a failed FIRST deploy leaves: no resources, and a journal whose only
# segment is an auto-rollback-clean initial deploy with no completed operation
# (observed in an integ bucket, written by cdkd 0.294.2).
printf '%s' "${EMPTY_RECORD}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
printf '%s' "{\"journalVersion\":1,\"stackName\":\"${STACK}\",\"region\":\"${REGION}\",\"segments\":[{\"timestamp\":1,\"reason\":\"auto-rollback-clean\",\"initialDeploy\":true,\"operations\":[],\"failedOperations\":[{\"logicalId\":\"Role\",\"changeType\":\"CREATE\",\"resourceType\":\"AWS::IAM::Role\"}]}]}" |
  aws s3 cp - "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" >/dev/null
set +e
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes >"${RUN_LOG}" 2>&1
STALE_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
echo "OBSERVE: stale-leftover-deploy-rc=${STALE_RC}"
KEY_ID_P7="$( (state_physical_id "${STATE_KEY_A}" 'AWS::KMS::Key') || true)"
[ -z "${KEY_ID_P7}" ] || KEY_IDS="${KEY_IDS} ${KEY_ID_P7}"
if [ "${STALE_RC}" -ne 0 ] || grep -qF "${DEPLOY_REFUSAL_NEEDLE}" "${RUN_LOG}"; then
  echo "FAIL: a fresh deploy under ${PREFIX_A} was refused or failed beside an EMPTY leftover record under ${PREFIX_B} (rc=${STALE_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
# Copied from `staleRecordNotice` in src/state/cross-prefix-stack-scan.ts.
if ! grep -qF "${STALE_NOTICE_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_B})" "${RUN_LOG}"; then
  echo "FAIL: the deploy did not name the empty leftover record under ${PREFIX_B} ('${STALE_NOTICE_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
set +e
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force >"${RUN_LOG}" 2>&1
STALE_DESTROY_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${STALE_DESTROY_RC}" -ne 0 ] || grep -qF "${DESTROY_REFUSAL_NEEDLE}" "${RUN_LOG}"; then
  echo "FAIL: the destroy under ${PREFIX_A} was refused or failed beside an EMPTY leftover record under ${PREFIX_B} (rc=${STALE_DESTROY_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if ! grep -qF "${STALE_NOTICE_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_B})" "${RUN_LOG}"; then
  echo "FAIL: the destroy did not name the empty leftover record under ${PREFIX_B} ('${STALE_NOTICE_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
assert_gone "state ${STATE_KEY_A} still exists after the Phase 7 destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"
aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}"
aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" >/dev/null
assert_gone "the seeded empty record ${STATE_KEY_B} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "the seeded journal ${JOURNAL_KEY_B} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"
echo "    OK: the empty leftover blocked nothing and was named; deploy and destroy under ${PREFIX_A} succeeded"

rm -f "${RUN_LOG}"
trap - EXIT INT TERM
sweep_prefix "${PREFIX_A}" "${STATE_KEY_A}" "${JOURNAL_KEY_A}"
sweep_prefix "${PREFIX_B}" "${STATE_KEY_B}" "${JOURNAL_KEY_B}"
rescan
echo "[verify] PASS — a second deployment of ${STACK} under another state prefix was refused before any create, a destroy and a rollback of a paired record were refused, a failed deploy's automatic rollback kept the queue it was handed, an empty leftover record blocked nothing, and deployment A's queue and log group stayed untouched (#4705)"
