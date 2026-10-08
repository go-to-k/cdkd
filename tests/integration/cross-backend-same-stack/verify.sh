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
#      under PREFIX_A must be refused and leave A's queue. Remove the seed.
#   5. Negative control: redeploy A under PREFIX_A; it must succeed.
#   6. Destroy A, delete the retained log group, and sweep.
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
DEPLOY_REFUSAL_NEEDLE="is already recorded under another state prefix of bucket"
DESTROY_REFUSAL_NEEDLE="is also recorded under another state prefix of bucket"

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
RUN_LOG=""
# Set just before this run's own first deploy: a pre-flight FAIL (a peer's run,
# or a leftover holding these names) must leave those resources alone.
DEPLOYED_A=""
DEPLOYED_B=""

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
  if [ "${DEPLOYED_A:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_A}" ); }; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${PREFIX_A}" --region "${REGION}" \
      --yes >/dev/null 2>&1
  fi
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
if ! grep -qF "${DEPLOY_REFUSAL_NEEDLE}" "${RUN_LOG}"; then
  echo "FAIL: deployment B did not fail with the cross-prefix refusal ('${DEPLOY_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
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
if ! grep -qF "${DESTROY_REFUSAL_NEEDLE}" "${RUN_LOG}"; then
  echo "FAIL: cdkd destroy did not fail with the cross-prefix refusal ('${DESTROY_REFUSAL_NEEDLE}'; output above) (go-to-k/cdkd#4705)" >&2
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
aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY_B}" >/dev/null
assert_gone "the seeded ${STATE_KEY_B} still exists after its removal" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
echo "    OK: the destroy was refused; A's queue and record are intact; the seed is removed"

echo ""
echo "==> Phase 5: negative control -- redeploy A under ${PREFIX_A} (retention ${RETENTION_A})"
CDKD_4705_RETENTION_DAYS="${RETENTION_A}" node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes
echo "    OK: a stack its own prefix records redeploys"

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

rm -f "${RUN_LOG}"
trap - EXIT INT TERM
sweep_prefix "${PREFIX_A}" "${STATE_KEY_A}" "${JOURNAL_KEY_A}"
sweep_prefix "${PREFIX_B}" "${STATE_KEY_B}" "${JOURNAL_KEY_B}"
rescan
echo "[verify] PASS — a second deployment of ${STACK} under another state prefix was refused before any create, a destroy of a paired record was refused, and deployment A's queue and log group stayed untouched (#4705)"
