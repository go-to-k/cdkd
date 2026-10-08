#!/usr/bin/env bash
# go-to-k/cdkd#4705 MIGRATION arm: deployments made by the PREVIOUS cdkd release
# (pinned below, installed from npm into a scratch dir, the mechanism the
# schema-v*-to-v*-migration fixtures use), then driven by this build's dist.
#
#   (a) An existing single-prefix stack (Cdkd4705MigrateSingle under PREFIX_S):
#       1. the old release deploys it;
#       2. this build redeploys it -- must SUCCEED with no cross-prefix refusal
#          (the existing-user regression case);
#       3. this build destroys it -- must succeed; the queue and record go.
#   (b) A pre-fix PAIR (Cdkd4705MigratePair under PREFIX_A and PREFIX_B):
#       4. the old release deploys A under PREFIX_A;
#       5. the old release deploys the same stack under PREFIX_B with
#          CDKD_4705_FAIL_LATER=1 and --no-rollback: the Queue and LogGroup
#          creates are handed A's resources (B's record names them), FailLater
#          fails, and B's journal holds the Queue's completed CREATE -- the
#          pair and the journal the repro's damage path replays;
#       6. this build redeploys A under PREFIX_A -- must succeed (an existing
#          record is not refused);
#       7. this build's `destroy` under PREFIX_B -- must be refused, the queue
#          survives;
#       8. this build's `rollback` under PREFIX_B -- must be refused, the queue
#          and B's journal survive;
#       8b. this build redeploys A WITHOUT the LogGroup (a plan that deletes)
#          -- must be refused (the destructive-plan check), and the log group
#          and the queue survive;
#       9. `state orphan` of B, then a normal destroy of A.
#
# Run via: /run-integ cross-backend-same-stack-migration
#         or: bash tests/integration/cross-backend-same-stack-migration/verify.sh

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
# The previous release, read from npm (`npm view @go-to-k/cdkd version`) when
# this arm was written; it predates the #4705 refusal.
OLD_CDKD_VERSION="${OLD_CDKD_VERSION:-0.296.13}"
SINGLE="Cdkd4705MigrateSingle"
PAIR="Cdkd4705MigratePair"
RUN_ID="$(date +%s)-$$"
PREFIX_S="${STATE_PREFIX_S:-cdkd-4705ms-${RUN_ID}}"
PREFIX_A="${STATE_PREFIX_A:-cdkd-4705ma-${RUN_ID}}"
PREFIX_B="${STATE_PREFIX_B:-cdkd-4705mb-${RUN_ID}}"
STATE_KEY_S="${PREFIX_S}/${SINGLE}/${REGION}/state.json"
JOURNAL_KEY_S="${PREFIX_S}/${SINGLE}/${REGION}/rollback-journal.json"
STATE_KEY_A="${PREFIX_A}/${PAIR}/${REGION}/state.json"
JOURNAL_KEY_A="${PREFIX_A}/${PAIR}/${REGION}/rollback-journal.json"
STATE_KEY_B="${PREFIX_B}/${PAIR}/${REGION}/state.json"
JOURNAL_KEY_B="${PREFIX_B}/${PAIR}/${REGION}/rollback-journal.json"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"
# Copied from src/state/cross-prefix-stack-scan.ts.
# Any cross-prefix refusal (used to assert there was NONE).
REFUSAL_NEEDLE="Refusing to"
# The FOUND messages only (the could-not-check refusal words it differently);
# each check also asserts the other prefix the message names.
DESTROY_REFUSAL_NEEDLE="is also recorded under another state prefix of bucket"
ROLLBACK_REFUSAL_NEEDLE="Refusing to roll back stack"
DESTRUCTIVE_REFUSAL_NEEDLE="this deploy deletes or replaces resources, and the stack is also recorded under another state prefix of bucket"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found -- run 'vp run build' first" >&2
  exit 1
fi

OLD_TMPDIR=""
OLD_BIN=""
RUN_LOG=""
QUEUE_URL_S=""
QUEUE_URL_A=""
LOG_GROUP_A=""
# Set just before this run's own first deploy of each stack.
DEPLOYED_S=""
DEPLOYED_A=""
DEPLOYED_B=""

state_physical_id() { # usage: state_physical_id <key> <type>
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/$1" -)" || return 1
  printf '%s' "${body}" | jq -r --arg t "$2" \
    '[(.resources // {})[] | select(.resourceType == $t) | .physicalId] | first // ""'
}

queue_exists() { # usage: queue_exists <url>; 0 when it exists
  ! gone_probe aws sqs get-queue-attributes --queue-url "$1" --attribute-names QueueArn --region "${REGION}"
}

# Delete one run prefix, only the per-run shape and only once its state record
# and journal are gone. Never under `cdkd/`.
sweep_prefix() { # usage: sweep_prefix <prefix> <state key> <journal key>
  case "${1:-}" in
    */*)
      echo "WARN: teardown sweep refused: prefix '$1' contains '/'" >&2
      ;;
    cdkd-4705ms-[0-9]*-[0-9]* | cdkd-4705ma-[0-9]*-[0-9]* | cdkd-4705mb-[0-9]*-[0-9]*)
      if ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$2" ) &&
        ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$3" ); then
        aws s3 rm "s3://${STATE_BUCKET}/$1/" --recursive >/dev/null 2>&1
      else
        echo "WARN: teardown incomplete; records kept under s3://${STATE_BUCKET:-}/$1/ (pass --state-prefix $1 to cdkd state destroy)" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: prefix '${1:-}' is not this fixture's cdkd-4705m*-* prefix" >&2
      ;;
  esac
}

# Delete this fixture's generated-name queues, roles, log groups and SSM
# parameters: names starting with exactly `<stack>-`, for the two literal stacks.
sweep_named() {
  local stack url role arn policy lg param
  for stack in "${SINGLE:-}" "${PAIR:-}"; do
    case "${stack}" in
      Cdkd4705MigrateSingle | Cdkd4705MigratePair) ;;
      *)
        echo "WARN: teardown sweep refused: stack '${stack}' is not one of this fixture's" >&2
        continue
        ;;
    esac
    for url in $(aws sqs list-queues --queue-name-prefix "${stack}-" --region "${REGION}" --query 'QueueUrls' --output text 2>/dev/null); do
      case "${url##*/}" in
        "${stack}"-?*) aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 ;;
      esac
    done
    for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, '${stack}-')].RoleName" --output text 2>/dev/null); do
      case "${role}" in
        "${stack}"-?*)
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
    for lg in $(aws logs describe-log-groups --log-group-name-prefix "/cdkd/${stack}-" --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
      case "${lg}" in
        "/cdkd/${stack}"-?*) aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 ;;
      esac
    done
    for param in $(aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=${stack}-" --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null); do
      case "${param}" in
        "${stack}"-?*) aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1 ;;
      esac
    done
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

rescan() {
  local stack p
  for stack in "${SINGLE}" "${PAIR}"; do
    warn_left "queues named ${stack}-* (a just-deleted queue can list for 60s)" \
      aws sqs list-queues --queue-name-prefix "${stack}-" --region "${REGION}" --query 'QueueUrls' --output text
    warn_left "roles named ${stack}-*" \
      aws iam list-roles --query "Roles[?starts_with(RoleName, '${stack}-')].RoleName" --output text
    warn_left "log groups named /cdkd/${stack}-*" \
      aws logs describe-log-groups --log-group-name-prefix "/cdkd/${stack}-" --region "${REGION}" --query 'logGroups[].logGroupName' --output text
    warn_left "SSM parameters named ${stack}-*" \
      aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=${stack}-" --region "${REGION}" --query 'Parameters[].Name' --output text
  done
  for p in "${PREFIX_S}" "${PREFIX_A}" "${PREFIX_B}"; do
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
  # B first, and only its RECORD (it names A's resources); a destroy of either
  # record would be refused while the other exists.
  if [ "${DEPLOYED_B:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}" ); }; then
    node "${LOCAL_DIST}" state orphan "${PAIR}" --stack-region "${REGION}" --state-bucket "${STATE_BUCKET:-}" \
      --state-prefix "${PREFIX_B}" --force >/dev/null 2>&1
  fi
  if [ "${DEPLOYED_A:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_A}" ); }; then
    node "${LOCAL_DIST}" state destroy "${PAIR}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${PREFIX_A}" --region "${REGION}" \
      --yes >/dev/null 2>&1
  fi
  if [ "${DEPLOYED_S:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_S}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_S}" ); }; then
    node "${LOCAL_DIST}" state destroy "${SINGLE}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${PREFIX_S}" --region "${REGION}" \
      --yes >/dev/null 2>&1
  fi
  if [ -n "${DEPLOYED_S:-}${DEPLOYED_A:-}" ]; then
    sweep_named
  fi
  sweep_prefix "${PREFIX_S}" "${STATE_KEY_S}" "${JOURNAL_KEY_S}"
  sweep_prefix "${PREFIX_A}" "${STATE_KEY_A}" "${JOURNAL_KEY_A}"
  sweep_prefix "${PREFIX_B}" "${STATE_KEY_B}" "${JOURNAL_KEY_B}"
  rescan
  if [ -n "${OLD_TMPDIR:-}" ] && [ -d "${OLD_TMPDIR}" ]; then
    rm -rf "${OLD_TMPDIR}"
  fi
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Installing the previous release (@go-to-k/cdkd@${OLD_CDKD_VERSION})"
OLD_TMPDIR="$(mktemp -d)"
(cd "${OLD_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${OLD_CDKD_VERSION}" >/dev/null)
OLD_BIN="${OLD_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${OLD_BIN}" ]; then
  echo "FAIL: the previous release was not installed at ${OLD_BIN}" >&2
  exit 1
fi
OLD_REPORTED="$(node "${OLD_BIN}" --version)"
NEW_REPORTED="$(node "${LOCAL_DIST}" --version)"
echo "    old: ${OLD_REPORTED} (${OLD_BIN}); new: ${NEW_REPORTED} (${LOCAL_DIST})"
case "${OLD_REPORTED}" in
  *"${OLD_CDKD_VERSION}"*) ;;
  *)
    echo "FAIL: the installed old binary reports '${OLD_REPORTED}', not ${OLD_CDKD_VERSION}" >&2
    exit 1
    ;;
esac

echo "==> Pre-flight"
for key in "${STATE_KEY_S}" "${STATE_KEY_A}" "${STATE_KEY_B}" "${JOURNAL_KEY_S}" "${JOURNAL_KEY_A}" "${JOURNAL_KEY_B}"; do
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"; then
    echo "FAIL: s3://${STATE_BUCKET}/${key} already exists -- clean up a previous run first" >&2
    exit 1
  fi
done
for stack in "${SINGLE}" "${PAIR}"; do
  LEFT="$(aws sqs list-queues --queue-name-prefix "${stack}-" --region "${REGION}" --query 'QueueUrls' --output text)"
  LEFT="${LEFT}$(aws iam list-roles --query "Roles[?starts_with(RoleName, '${stack}-')].RoleName" --output text)"
  LEFT="${LEFT}$(aws logs describe-log-groups --log-group-name-prefix "/cdkd/${stack}-" --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
  LEFT="$(printf '%s' "${LEFT}" | sed 's/None//g' | tr -d '[:space:]')"
  if [ -n "${LEFT}" ]; then
    echo "FAIL: a queue, role or log group named ${stack}-* already exists -- delete it by hand first (${LEFT})" >&2
    exit 1
  fi
done

RUN_LOG="$(mktemp)"

# Run a cdkd command into RUN_LOG and echo it; the exit code is in CMD_RC.
run_logged() { # usage: run_logged <label> <cli.js> <args...>
  local label="$1"
  shift
  echo ""
  echo "==> ${label}"
  set +e
  node "$@" >"${RUN_LOG}" 2>&1
  CMD_RC=$?
  set -e
  sed 's/^/  /' "${RUN_LOG}"
  echo "OBSERVE: ${label}: rc=${CMD_RC}"
}

refused() { grep -qF "${REFUSAL_NEEDLE}" "${RUN_LOG}"; }

# --- (a) an existing single-prefix stack -------------------------------------
DEPLOYED_S=1
run_logged "(a)1 old release deploys ${SINGLE} under ${PREFIX_S}" "${OLD_BIN}" deploy "${SINGLE}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_S}" --yes
[ "${CMD_RC}" -eq 0 ] || { echo "FAIL: the old release could not deploy ${SINGLE} (output above)" >&2; exit 1; }
QUEUE_URL_S="$(state_physical_id "${STATE_KEY_S}" 'AWS::SQS::Queue')"
case "${QUEUE_URL_S}" in
  https://*/"${SINGLE}"-?*) ;;
  *) echo "FAIL: the old release's record does not name a ${SINGLE}-* queue (got '${QUEUE_URL_S}')" >&2; exit 1 ;;
esac

run_logged "(a)2 this build redeploys ${SINGLE} under ${PREFIX_S}" "${LOCAL_DIST}" deploy "${SINGLE}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_S}" --yes
if [ "${CMD_RC}" -ne 0 ] || refused; then
  echo "FAIL: this build did not redeploy a stack the previous release deployed under one prefix (rc=${CMD_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
queue_exists "${QUEUE_URL_S}" || { echo "FAIL: ${SINGLE}'s queue is gone after the redeploy" >&2; exit 1; }

run_logged "(a)3 this build destroys ${SINGLE} under ${PREFIX_S}" "${LOCAL_DIST}" destroy "${SINGLE}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_S}" --force
if [ "${CMD_RC}" -ne 0 ] || refused; then
  echo "FAIL: this build did not destroy a stack the previous release deployed (rc=${CMD_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
assert_gone "state ${STATE_KEY_S} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_S}"
echo "    OK: (a) the previous release's single-prefix stack redeploys and destroys under this build"

# --- (b) a pre-fix pair --------------------------------------------------------
DEPLOYED_A=1
run_logged "(b)4 old release deploys ${PAIR} under ${PREFIX_A}" "${OLD_BIN}" deploy "${PAIR}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes
[ "${CMD_RC}" -eq 0 ] || { echo "FAIL: the old release could not deploy ${PAIR} under ${PREFIX_A} (output above)" >&2; exit 1; }
QUEUE_URL_A="$(state_physical_id "${STATE_KEY_A}" 'AWS::SQS::Queue')"
LOG_GROUP_A="$(state_physical_id "${STATE_KEY_A}" 'AWS::Logs::LogGroup')"
case "${QUEUE_URL_A}" in
  https://*/"${PAIR}"-?*) ;;
  *) echo "FAIL: A's record does not name a ${PAIR}-* queue (got '${QUEUE_URL_A}')" >&2; exit 1 ;;
esac
case "${LOG_GROUP_A}" in
  "/cdkd/${PAIR}"-?*) ;;
  *) echo "FAIL: A's record does not name a /cdkd/${PAIR}-* log group (got '${LOG_GROUP_A}')" >&2; exit 1 ;;
esac

DEPLOYED_B=1
export CDKD_4705_FAIL_LATER=1
run_logged "(b)5 old release deploys ${PAIR} under ${PREFIX_B} (--no-rollback, FailLater fails)" "${OLD_BIN}" deploy "${PAIR}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --yes --no-rollback
unset CDKD_4705_FAIL_LATER
# The premise: the old release built the pair. B's record names A's queue, and
# B's journal holds the Queue's completed CREATE.
if [ "${CMD_RC}" -eq 0 ]; then
  echo "FAIL: premise: the old release's B deploy succeeded (FailLater should fail it)" >&2
  exit 1
fi
QUEUE_URL_B="$( (aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_B}" - || true) | jq -r '[(.resources // {})[] | select(.resourceType == "AWS::SQS::Queue") | .physicalId] | first // ""' 2>/dev/null || true)"
echo "OBSERVE: b-record-queue=${QUEUE_URL_B:-<none>}"
if [ "${QUEUE_URL_B}" != "${QUEUE_URL_A}" ]; then
  echo "FAIL: premise: B's record does not name A's queue (B '${QUEUE_URL_B}', A '${QUEUE_URL_A}'; output above)" >&2
  exit 1
fi
JOURNALED_QUEUE="$( (aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY_B}" - || true) | jq -r '[.segments[]?.operations[]? | select(.logicalId | startswith("Queue")) | select(.changeType == "CREATE")] | last | .physicalId // ""' 2>/dev/null || true)"
echo "OBSERVE: b-journal-completed-queue-create=${JOURNALED_QUEUE:-<none>}"
if [ "${JOURNALED_QUEUE}" != "${QUEUE_URL_A}" ]; then
  echo "FAIL: premise: B's journal does not hold the Queue's completed CREATE of A's queue (got '${JOURNALED_QUEUE}')" >&2
  exit 1
fi

run_logged "(b)6 this build redeploys ${PAIR} under ${PREFIX_A}" "${LOCAL_DIST}" deploy "${PAIR}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes
if [ "${CMD_RC}" -ne 0 ] || refused; then
  echo "FAIL: this build refused or failed a redeploy of an existing record under ${PREFIX_A} (rc=${CMD_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi

run_logged "(b)7 this build destroys ${PAIR} under ${PREFIX_B}" "${LOCAL_DIST}" destroy "${PAIR}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --force
if [ "${CMD_RC}" -eq 0 ] || ! grep -qF "${DESTROY_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_A})" "${RUN_LOG}"; then
  echo "FAIL: this build's destroy under ${PREFIX_B} was not refused with the cross-prefix refusal (rc=${CMD_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
queue_exists "${QUEUE_URL_A}" || { echo "FAIL: A's queue is gone after a refused destroy under ${PREFIX_B} (go-to-k/cdkd#4705)" >&2; exit 1; }

run_logged "(b)8 this build rolls back ${PAIR} under ${PREFIX_B}" "${LOCAL_DIST}" rollback "${PAIR}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --force
if [ "${CMD_RC}" -eq 0 ] || ! grep -qF "${ROLLBACK_REFUSAL_NEEDLE}" "${RUN_LOG}" ||
  ! grep -qF "${DESTROY_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_A})" "${RUN_LOG}"; then
  echo "FAIL: this build's rollback under ${PREFIX_B} was not refused with the cross-prefix refusal (rc=${CMD_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
queue_exists "${QUEUE_URL_A}" || { echo "FAIL: A's queue is gone after a refused rollback under ${PREFIX_B} (go-to-k/cdkd#4705)" >&2; exit 1; }
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY_B}"; then
  echo "FAIL: B's journal is gone after a refused rollback (go-to-k/cdkd#4705)" >&2
  exit 1
fi
echo "    OK: (b) the pre-fix pair: A redeploys; B's destroy and rollback are refused; A's queue survives"

# A redeploy of A whose plan DELETES a resource, with B's record present: the
# destructive-plan check refuses it (the pair predates the first-deploy check).
export CDKD_4705_DROP_LOGGROUP=1
run_logged "(b)8b this build redeploys ${PAIR} under ${PREFIX_A} without the LogGroup" "${LOCAL_DIST}" deploy "${PAIR}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --yes
unset CDKD_4705_DROP_LOGGROUP
if [ "${CMD_RC}" -eq 0 ] || ! grep -qF "${DESTRUCTIVE_REFUSAL_NEEDLE}" "${RUN_LOG}" || ! grep -qF "(${PREFIX_B})" "${RUN_LOG}"; then
  echo "FAIL: a redeploy of A that deletes the LogGroup was not refused while ${PREFIX_B} records the stack (rc=${CMD_RC}; output above) (go-to-k/cdkd#4705)" >&2
  exit 1
fi
LG_STILL="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP_A}" --region "${REGION}" \
  --query "length(logGroups[?logGroupName=='${LOG_GROUP_A}'])" --output text)"
if [ "${LG_STILL}" != "1" ]; then
  echo "FAIL: the LogGroup ${LOG_GROUP_A} is gone after a refused destructive redeploy (go-to-k/cdkd#4705)" >&2
  exit 1
fi
queue_exists "${QUEUE_URL_A}" || { echo "FAIL: A's queue is gone after a refused destructive redeploy (go-to-k/cdkd#4705)" >&2; exit 1; }
echo "    OK: (b)8b the destructive redeploy was refused; the LogGroup and the queue survive"

run_logged "(b)9a this build orphans B's record" "${LOCAL_DIST}" state orphan "${PAIR}" --stack-region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_B}" --force
[ "${CMD_RC}" -eq 0 ] || { echo "FAIL: state orphan of B failed (output above)" >&2; exit 1; }
assert_gone "B's record ${STATE_KEY_B} still exists after state orphan" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_B}"
queue_exists "${QUEUE_URL_A}" || { echo "FAIL: A's queue is gone after orphaning B's record" >&2; exit 1; }

run_logged "(b)9b this build destroys ${PAIR} under ${PREFIX_A}" "${LOCAL_DIST}" destroy "${PAIR}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX_A}" --force
[ "${CMD_RC}" -eq 0 ] || { echo "FAIL: the destroy of A failed (output above)" >&2; exit 1; }
assert_gone "state ${STATE_KEY_A} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY_A}"
LG_LEFT="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP_A}" --region "${REGION}" \
  --query "length(logGroups[?logGroupName=='${LOG_GROUP_A}'])" --output text)"
if [ "${LG_LEFT}" != "0" ]; then
  echo "FAIL: log group ${LOG_GROUP_A} still exists after the destroy (count '${LG_LEFT}')" >&2
  exit 1
fi
queue_exists "${QUEUE_URL_A}" && { echo "WARN: A's queue still lists after the destroy (SQS deletion can take 60s)" >&2; } || true

rm -f "${RUN_LOG}"
trap - EXIT INT TERM
sweep_named
sweep_prefix "${PREFIX_S}" "${STATE_KEY_S}" "${JOURNAL_KEY_S}"
sweep_prefix "${PREFIX_A}" "${STATE_KEY_A}" "${JOURNAL_KEY_A}"
sweep_prefix "${PREFIX_B}" "${STATE_KEY_B}" "${JOURNAL_KEY_B}"
rescan
rm -rf "${OLD_TMPDIR}"
echo "[verify] PASS — stacks the previous release (${OLD_CDKD_VERSION}) deployed redeploy and destroy under this build; a pre-fix pair's destroy and rollback under the second prefix are refused and keep the first deployment's queue (#4705)"
