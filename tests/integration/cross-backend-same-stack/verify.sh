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
#      Queue and the LogGroup may be handed back. The stack registry marker A's
#      first deploy claimed (`_cdkd-registry/<region>/<stack>.json`) names
#      PREFIX_A, so B is refused before any create.
#   2b. CROSS-BUCKET: deploy B of the SAME stack into a per-run SECOND bucket.
#      No marker or record of A is there, so B's creates run, and each create
#      that would adopt A's queue or log group by its generated name is refused
#      before it is sent (nothing of B's names them): the log group keeps A's
#      retention and A's queue survives. The second bucket is deleted exactly.
#   3. OBSERVE (unique `OBSERVE:` lines): B's exit code, which resources failed
#      with which awsErrorCode and what B's rollback did (B's deployments/*.jsonl),
#      whether A's queue still exists, the log group's retention, and what B's
#      state and state.orphans hold. Then ASSERT: B is refused with the
#      cross-prefix refusal before any create, A's queue still exists, the log
#      group keeps A's retention, and B has no state record or journal.
#   4. Seed a pre-fix pair (A's state.json copied to B's key) that PREDATES the
#      registry (A's marker is removed first): `cdkd destroy` under PREFIX_A
#      must be refused by the one-time scan and leave A's queue, and
#      `cdkd rollback` under PREFIX_A (over a seeded, empty journal) must be
#      refused and keep the journal. Remove the journal seed.
#   5. Negative control: redeploy A under PREFIX_A while the seeded B record
#      still exists; it must succeed. Then remove that seed.
#   5b. A successful deploy under PREFIX_B (a minimal template) whose journal
#      holds a proven failed-CREATE orphan naming A's KMS key: the settle must
#      KEEP the key (warn, exit 2), since PREFIX_A's record may hold it.
#   5c. A pre-fix pair whose redeploy under PREFIX_B (an empty record, so not a
#      first deploy, and a plan that only creates) ADDS the Queue A holds: the
#      create is refused before it is sent, so nothing is adopted and A's queue
#      survives.
#   6. Destroy A: its RETAIN log group is kept and recorded as kept under
#      PREFIX_A (`retained.json`).
#   6b. RETAIN-REDEPLOY: redeploy A under PREFIX_A: the log group create takes
#      the kept log group back (licensed by that record), and the record then
#      forgets it. Destroy A again and delete the retained log group.
#   7. Seed an EMPTY record, a failed first deploy's journal and a registry
#      marker naming PREFIX_B (what a failed first deploy there leaves): a fresh
#      deploy under PREFIX_A must re-claim the stale marker, print the note
#      naming PREFIX_B, and succeed; its destroy too.
#
# Each run uses its OWN two state prefixes (unique per run): nothing under
# `cdkd/` is read or written, and the trap deletes only these two prefixes, the
# registry marker when it names one of them, and the second bucket it made.
# The registry marker is per stack name, not per prefix: run this fixture with
# its own STATE_BUCKET (`/run-integ` does), never two runs in one bucket.
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
# Copied from `refuseUnlicensedGeneratedName` in src/deployment/deploy-engine/create.ts.
ADOPT_REFUSAL_NEEDLE="nothing this stack records names that resource"
# The stack registry marker, at the bucket root (src/state/s3-state-backend.ts).
MARKER_KEY="_cdkd-registry/${REGION}/${STACK}.json"

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
# Phase 2b's per-run second bucket, set only once THIS run created it.
BUCKET_X=""

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

# The prefix the registry marker names, or "" when there is none.
marker_prefix() {
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null)" || {
    echo ""
    return 0
  }
  printf '%s' "${body}" | jq -r '.prefix // ""'
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
  # The registry marker, only when it names one of THIS run's prefixes.
  case "$(marker_prefix)" in
    "${PREFIX_A}" | "${PREFIX_B}") aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 ;;
  esac
  # Phase 2b's second bucket, only by the per-run name THIS run created.
  case "${BUCKET_X:-}" in
    cdkd-4705x-[0-9]*-[0-9]*) aws s3 rb "s3://${BUCKET_X}" --force >/dev/null 2>&1 ;;
  esac
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
for key in "${STATE_KEY_A}" "${STATE_KEY_B}" "${JOURNAL_KEY_A}" "${JOURNAL_KEY_B}" "${MARKER_KEY}"; do
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"; then
    echo "FAIL: s3://${STATE_BUCKET}/${key} already exists -- clean up a previous run first (or run with this fixture's own STATE_BUCKET)" >&2
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
MARKER_AFTER_A="$(marker_prefix)"
echo "OBSERVE: registry-marker-after-a=${MARKER_AFTER_A:-<none>}"
if [ "${MARKER_AFTER_A}" != "${PREFIX_A}" ]; then
  echo "FAIL: A's first deploy did not claim the stack registry marker for ${PREFIX_A} (s3://${STATE_BUCKET}/${MARKER_KEY} names '${MARKER_AFTER_A}') (go-to-k/cdkd#4705)" >&2
  exit 1
fi
echo "    OK: queue ${QUEUE_URL_A}, log group ${LOG_GROUP_NAME} (retention ${RETENTION_A}), role ${ROLE_NAME_A}; the registry marker names ${PREFIX_A}"

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
echo "==> Phase 2b: CROSS-BUCKET -- deploy B of the SAME stack into a second, per-run bucket"
# Nothing in the second bucket knows A: no marker, no record. B's creates run,
# and each that would adopt A's queue or log group by its generated name must
# be refused BEFORE it is sent (go-to-k/cdkd#4705 C): the log group keeps A's
# retention and A's queue survives. The Role collides natively; B's KMS key
# is B's own, and its rollback deletes it.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
case "${ACCOUNT_ID}" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "FAIL: STS did not report a 12-digit account (got '${ACCOUNT_ID}')" >&2; exit 1 ;;
esac
BUCKET_X_NAME="cdkd-4705x-${ACCOUNT_ID}-$(date +%s)"
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${BUCKET_X_NAME}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${BUCKET_X_NAME}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
BUCKET_X="${BUCKET_X_NAME}"
set +e
CDKD_4705_RETENTION_DAYS="${RETENTION_B}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${BUCKET_X}" --state-prefix "${PREFIX_B}" --yes >"${RUN_LOG}" 2>&1
XB_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
XB_STATE="$( (aws s3 cp "s3://${BUCKET_X}/${STATE_KEY_B}" - 2>/dev/null || true) | jq -c '[(.resources // {})[] | .physicalId]' 2>/dev/null || true)"
RETENTION_AFTER_XB="$(log_group_retention)"
echo "OBSERVE: cross-bucket-deploy-rc=${XB_RC} b-records=${XB_STATE:-<none>} log-group-retention=${RETENTION_AFTER_XB}"
# B's own KMS key, if its record or events name one, for the trap.
for k in $( (aws s3 ls "s3://${BUCKET_X}/${PREFIX_B}/" --recursive 2>/dev/null || true) | awk '{print $4}' | grep 'deployments/.*\.jsonl$' || true); do
  for id in $( (aws s3 cp "s3://${BUCKET_X}/${k}" - 2>/dev/null || true) | jq -r 'select(.eventType == "RESOURCE_SUCCEEDED" and .resourceType == "AWS::KMS::Key") | .physicalId // empty' 2>/dev/null || true); do
    KEY_IDS="${KEY_IDS} ${id}"
  done
done
if [ "${XB_RC}" -eq 0 ]; then
  echo "FAIL: deployment B of ${STACK} in a second bucket SUCCEEDED; its adopting creates must be refused (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if ! grep -qF "${ADOPT_REFUSAL_NEEDLE}" "${RUN_LOG}"; then
  echo "FAIL: deployment B in a second bucket was not refused at an adopting create ('${ADOPT_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
case "${XB_STATE}" in
  *"${QUEUE_URL_A}"* | *"${LOG_GROUP_NAME}"*)
    echo "FAIL: B's record in the second bucket names A's queue or log group: it adopted it (${XB_STATE}) (go-to-k/cdkd#4705)" >&2
    exit 1
    ;;
esac
if [ "${RETENTION_AFTER_XB}" != "${RETENTION_A}" ]; then
  echo "FAIL: A's log group ${LOG_GROUP_NAME} has retention '${RETENTION_AFTER_XB}' after B's cross-bucket deploy (expected A's ${RETENTION_A}): B's create adopted and rewrote it (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  echo "FAIL: A's queue ${QUEUE_URL_A} is gone after B's cross-bucket deploy (go-to-k/cdkd#4705)" >&2
  exit 1
fi
aws s3 rb "s3://${BUCKET_X}" --force >/dev/null
assert_gone "the second bucket ${BUCKET_X} still exists after its removal" \
  aws s3api head-bucket --bucket "${BUCKET_X}"
BUCKET_X=""
echo "    OK: B in a second bucket was refused at its adopting creates; A's queue and log group retention are untouched; the bucket is deleted"

echo ""
echo "==> Phase 4: a pre-fix pair (A's record copied to ${PREFIX_B}) makes cdkd destroy under ${PREFIX_A} refuse"
# Phase 7's empty record: A's record with nothing left in it.
EMPTY_RECORD="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_A}" - | jq -c '.resources = {} | .outputs = {} | del(.orphans)')"
case "${EMPTY_RECORD}" in
  '{'*'"resources":{}'*) ;;
  *) echo "FAIL: could not build an empty record from A's (got '${EMPTY_RECORD}')" >&2; exit 1 ;;
esac
# A pair that PREDATES the registry: remove the marker A's first deploy claimed
# (an older cdkd wrote none), so the destroy falls back to its one-time scan.
aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null
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
# The scan found the pair, so nothing claimed the marker.
if [ -n "$(marker_prefix)" ]; then
  echo "FAIL: the refused destroy claimed the registry marker over a known pair (go-to-k/cdkd#4705)" >&2
  exit 1
fi
echo "    OK: the destroy was refused; A's queue and record are intact; no marker was claimed"

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
echo "==> Phase 5c: a deploy under ${PREFIX_B} whose plan would CREATE the queue ${PREFIX_A} holds is refused before that create"
# B's record is empty, so B's deploy is not a first deploy, and its plan only
# CREATEs (the Queue, then FailLater). The Queue's CreateQueue would hand back
# A's queue (identical attributes); nothing of B's names that queue, so the
# create is refused before it is sent (go-to-k/cdkd#4705 C) and nothing is
# adopted.
printf '%s' "${EMPTY_RECORD}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
set +e
CDKD_4705_B_AUTOROLLBACK=1 node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --yes >"${RUN_LOG}" 2>&1
REFUSED_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
B_QUEUE="$( (state_physical_id "${STATE_KEY_B}" 'AWS::SQS::Queue') || true)"
MINIMAL_PARAM_B="$( (state_physical_id "${STATE_KEY_B}" 'AWS::SSM::Parameter') || true)"
# Rollback-independent evidence that no create was sent for the Queue: B's
# events record no RESOURCE_SUCCEEDED for it.
QUEUE_SUCCEEDED="$( (events_b || true) | jq -r \
  'select(.eventType == "RESOURCE_SUCCEEDED" and .logicalId == "Queue4A7E3555") | .physicalId' 2>/dev/null || true)"
echo "OBSERVE: refused-deploy-rc=${REFUSED_RC} b-queue=${B_QUEUE:-<none>} queue-succeeded=${QUEUE_SUCCEEDED:-<none>} fail-later-param=${MINIMAL_PARAM_B:-<none>}"
if [ "${REFUSED_RC}" -eq 0 ]; then
  echo "FAIL: the deploy under ${PREFIX_B} that creates A's queue exited 0 (output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if ! grep -qF "${ADOPT_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "Queue4A7E3555" "${RUN_LOG}"; then
  echo "FAIL: the Queue create under ${PREFIX_B} was not refused as adopting A's queue ('${ADOPT_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if [ -n "${QUEUE_SUCCEEDED}" ] || [ -n "${B_QUEUE}" ]; then
  echo "FAIL: B's Queue create was sent and recorded (${QUEUE_SUCCEEDED:-} ${B_QUEUE:-}): it adopted A's queue (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if gone_probe aws sqs get-queue-attributes --queue-url "${QUEUE_URL_A}" --attribute-names QueueArn --region "${REGION}"; then
  echo "FAIL: A's queue ${QUEUE_URL_A} is gone after B's refused deploy (go-to-k/cdkd#4705)" >&2
  exit 1
fi
case "${MINIMAL_PARAM_B}" in
  "") ;;
  *"${STACK}"-?*) aws ssm delete-parameter --name "${MINIMAL_PARAM_B}" --region "${REGION}" >/dev/null ;;
  *) echo "FAIL: B's record names an unexpected SSM parameter '${MINIMAL_PARAM_B}'" >&2; exit 1 ;;
esac
MINIMAL_PARAM_B=""
node "${LOCAL_DIST}" state orphan "${STACK}" --stack-region "${REGION}" --state-bucket "${STATE_BUCKET:-}" \
  --state-prefix "${PREFIX_B}" --force
assert_gone "${STATE_KEY_B} still exists after the Phase 5c cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "${JOURNAL_KEY_B} still exists after the Phase 5c cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"
echo "    OK: B's Queue create was refused before it was sent (rc ${REFUSED_RC}); nothing adopted; B's record and journal are removed"

echo ""
echo "==> Phase 6: destroy A: its RETAIN log group is kept, and recorded as kept under ${PREFIX_A}"
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force
assert_gone "state ${STATE_KEY_A} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"
assert_gone "state ${STATE_KEY_B} exists at the end of the run" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "role ${ROLE_NAME_A} still exists after the destroy" \
  aws iam get-role --role-name "${ROLE_NAME_A}"
# The destroy deleted the record FIRST, then released the marker naming it.
if [ -n "$(marker_prefix)" ]; then
  echo "FAIL: the registry marker survived A's destroy (names '$(marker_prefix)') (go-to-k/cdkd#4705)" >&2
  exit 1
fi
RETAINED_KEY_A="${PREFIX_A}/${STACK}/${REGION}/retained.json"
KEPT="$( (aws s3 cp "s3://${STATE_BUCKET}/${RETAINED_KEY_A}" - 2>/dev/null || true) | jq -r '[.resources[]? | .physicalId] | join(",")' 2>/dev/null || true)"
echo "OBSERVE: kept-after-destroy=${KEPT:-<none>}"
if [ "${KEPT}" != "${LOG_GROUP_NAME}" ]; then
  echo "FAIL: A's destroy did not record its kept log group ${LOG_GROUP_NAME} as kept (got '${KEPT}') (go-to-k/cdkd#4705)" >&2
  exit 1
fi
echo "    OK: both records are gone, the marker is released, and the kept log group is recorded under ${PREFIX_A}"

echo ""
echo "==> Phase 6b: RETAIN-REDEPLOY -- redeploy A under ${PREFIX_A}: its create takes the kept log group back"
set +e
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes >"${RUN_LOG}" 2>&1
READOPT_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
KEY_ID_6B="$( (state_physical_id "${STATE_KEY_A}" 'AWS::KMS::Key') || true)"
[ -z "${KEY_ID_6B}" ] || KEY_IDS="${KEY_IDS} ${KEY_ID_6B}"
READOPTED="$( (state_physical_id "${STATE_KEY_A}" 'AWS::Logs::LogGroup') || true)"
KEPT_AFTER="$( (aws s3 cp "s3://${STATE_BUCKET}/${RETAINED_KEY_A}" - 2>/dev/null || true) | jq -r '[.resources[]? | .physicalId] | join(",")' 2>/dev/null || true)"
echo "OBSERVE: readopt-rc=${READOPT_RC} record-log-group=${READOPTED:-<none>} kept-after-redeploy=${KEPT_AFTER:-<none>} marker=$(marker_prefix)"
if [ "${READOPT_RC}" -ne 0 ] || grep -qF "${ADOPT_REFUSAL_NEEDLE}" "${RUN_LOG}"; then
  echo "FAIL: redeploying A under ${PREFIX_A} did not take its own kept log group back (rc=${READOPT_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
if [ "${READOPTED}" != "${LOG_GROUP_NAME}" ]; then
  echo "FAIL: A's record names log group '${READOPTED}', not the kept ${LOG_GROUP_NAME} (go-to-k/cdkd#4705)" >&2
  exit 1
fi
case "${KEPT_AFTER}" in
  *"${LOG_GROUP_NAME}"*)
    echo "FAIL: the kept-resource record still lists ${LOG_GROUP_NAME} after the redeploy took it back (go-to-k/cdkd#4705)" >&2
    exit 1
    ;;
esac
if [ "$(marker_prefix)" != "${PREFIX_A}" ]; then
  echo "FAIL: A's redeploy did not claim the registry marker again (go-to-k/cdkd#4705)" >&2
  exit 1
fi
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force
assert_gone "state ${STATE_KEY_A} still exists after the Phase 6b destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"
aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}"
aws s3 rm "s3://${STATE_BUCKET}/${RETAINED_KEY_A}" >/dev/null
echo "    OK: the redeploy took the kept log group back and the record forgot it; destroyed again, the log group is deleted"

echo ""
echo "==> Phase 7: an EMPTY leftover record under ${PREFIX_B} (a failed first deploy's) does not block ${PREFIX_A}"
# The shape a failed FIRST deploy leaves: no resources, a journal whose only
# segment is an auto-rollback-clean initial deploy with no completed operation
# (observed in an integ bucket, written by cdkd 0.294.2), and the registry
# marker that first deploy claimed. Nothing there can own a resource and no
# lock is held, so the marker is stale: A's first deploy re-claims it.
printf '%s' "${EMPTY_RECORD}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
printf '%s' "{\"journalVersion\":1,\"stackName\":\"${STACK}\",\"region\":\"${REGION}\",\"segments\":[{\"timestamp\":1,\"reason\":\"auto-rollback-clean\",\"initialDeploy\":true,\"operations\":[],\"failedOperations\":[{\"logicalId\":\"Role\",\"changeType\":\"CREATE\",\"resourceType\":\"AWS::IAM::Role\"}]}]}" |
  aws s3 cp - "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" >/dev/null
printf '%s' "{\"prefix\":\"${PREFIX_B}\"}" | aws s3 cp - "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null
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
if [ "$(marker_prefix)" != "${PREFIX_A}" ]; then
  echo "FAIL: A's deploy did not re-claim the stale registry marker from ${PREFIX_B} (names '$(marker_prefix)') (go-to-k/cdkd#4705)" >&2
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
assert_gone "state ${STATE_KEY_A} still exists after the Phase 7 destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"
aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}"
aws s3 rm "s3://${STATE_BUCKET}/${PREFIX_A}/${STACK}/${REGION}/retained.json" >/dev/null
aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" >/dev/null
assert_gone "the seeded empty record ${STATE_KEY_B} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
assert_gone "the seeded journal ${JOURNAL_KEY_B} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"
assert_gone "the registry marker still exists after the Phase 7 destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"
echo "    OK: the empty leftover blocked nothing and was named; the stale marker was re-claimed; deploy and destroy under ${PREFIX_A} succeeded"

rm -f "${RUN_LOG}"
trap - EXIT INT TERM
sweep_prefix "${PREFIX_A}" "${STATE_KEY_A}" "${JOURNAL_KEY_A}"
sweep_prefix "${PREFIX_B}" "${STATE_KEY_B}" "${JOURNAL_KEY_B}"
rescan
echo "[verify] PASS — a second deployment of ${STACK} under another state prefix was refused before any create, one in another bucket was refused at its adopting creates, a destroy and a rollback of a paired record were refused, a create of A's queue under B was refused before it was sent, a redeploy took its own kept log group back, an empty leftover and a stale marker blocked nothing, and deployment A's queue and log group stayed untouched (#4705)"
