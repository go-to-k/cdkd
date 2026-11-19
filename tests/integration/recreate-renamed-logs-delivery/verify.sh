#!/usr/bin/env bash
# verify.sh -- cdkd --recreate-via-cc-api replacement order for a CloudWatch
# Logs delivery source and destination an AWS::Logs::Delivery uses (issue 6589).
#
# Phases: deploy on the SDK route -> recreate the source under its SAME name
# (`blocked`): the delete comes first, CloudWatch Logs refuses it while the
# delivery uses the source, and the deploy fails naming the delivery, with
# nothing changed -> recreate all three with new names for the source and the
# destination (`renamed`): each is created first, the old ones are deleted
# after the delivery moved, and the deploy succeeds -> destroy.
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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
# assert_gone, plus the not-found error AWS answers for that type: the shared
# signature alone would also accept another not-found.
assert_gone_as() { # usage: assert_gone_as "<leak description>" <ErrorCode> aws <service> <read-verb> [args...]
  local desc="$1" code="$2" out
  shift 2
  assert_gone "${desc}" "$@"
  out=$("$@" 2>&1 >/dev/null || true)
  grep -qF "${code}" <<<"${out}" || { echo "FAIL: ${desc}: the gone-probe answered without ${code}: ${out}" >&2; exit 1; }
}
cd "$(dirname "$0")"

STACK="CdkdRecreateRenamedLogsDelivery"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The names the stack declares (lib/recreate-renamed-logs-delivery-stack.ts),
# by generation.
SOURCE_PREFIX="cdkd-rrld-src-"
DESTINATION_PREFIX="cdkd-rrld-dst-"
BUS_PREFIX="cdkd-rrld-bus-"
GROUP_PREFIX="/aws/vendedlogs/cdkd-rrld-"

STATE_JSON=""
load_state() {
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${STATE_JSON}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
}

# The state record for one resource, read from the last load_state. A missing
# record would make every assertion below read `null` and pass vacuously.
record() { # usage: record <logicalId> <jq-expression-over-the-resource-object>
  printf '%s' "${STATE_JSON}" | jq -e --arg k "$1" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource $1" >&2
    exit 1
  }
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

get_source() { # usage: get_source <name> <--query expression>
  aws logs get-delivery-source --name "$1" --region "${REGION}" --query "deliverySource.$2" --output text
}
get_destination() { # usage: get_destination <name> <--query expression>
  aws logs get-delivery-destination --name "$1" --region "${REGION}" --query "deliveryDestination.$2" --output text
}
get_delivery() { # usage: get_delivery <id> <--query expression>
  aws logs get-delivery --id "$1" --region "${REGION}" --query "delivery.$2" --output text
}

# Each record's layer, and the names / the delivery's link, read from AWS.
assert_generation() { # usage: assert_generation <phase-label> <1|2> <sdk|cc-api>
  local id pid got
  for id in RecreateDeliverySource RecreateDeliveryDestination RecreateDelivery; do
    got=$(record "${id}" '.provisionedBy')
    [ "${got}" = "$3" ] || { echo "FAIL: $1: ${id} recorded provisionedBy=${got}, expected $3" >&2; exit 1; }
  done
  pid=$(record RecreateDeliverySource '.physicalId')
  [ "${pid}" = "${SOURCE_PREFIX}$2" ] || { echo "FAIL: $1: the source recorded '${pid}', expected ${SOURCE_PREFIX}$2" >&2; exit 1; }
  got=$(get_source "${pid}" name) || { echo "FAIL: $1: cannot read source ${pid}" >&2; exit 1; }
  [ "${got}" = "${pid}" ] || { echo "FAIL: $1: source ${pid} reads back as '${got}'" >&2; exit 1; }
  pid=$(record RecreateDeliveryDestination '.physicalId')
  [ "${pid}" = "${DESTINATION_PREFIX}$2" ] || { echo "FAIL: $1: the destination recorded '${pid}', expected ${DESTINATION_PREFIX}$2" >&2; exit 1; }
  got=$(get_destination "${pid}" name) || { echo "FAIL: $1: cannot read destination ${pid}" >&2; exit 1; }
  [ "${got}" = "${pid}" ] || { echo "FAIL: $1: destination ${pid} reads back as '${got}'" >&2; exit 1; }
  pid=$(record RecreateDelivery '.physicalId')
  got=$(get_delivery "${pid}" deliverySourceName) || { echo "FAIL: $1: cannot read delivery ${pid}" >&2; exit 1; }
  [ "${got}" = "${SOURCE_PREFIX}$2" ] ||
    { echo "FAIL: $1: delivery ${pid} reads source '${got}', expected ${SOURCE_PREFIX}$2" >&2; exit 1; }
  got=$(get_delivery "${pid}" deliveryDestinationArn) || exit 1
  [ "${got}" = "$(get_destination "${DESTINATION_PREFIX}$2" arn)" ] ||
    { echo "FAIL: $1: delivery ${pid} writes to '${got}', not the generation-$2 destination" >&2; exit 1; }
}

# Best-effort removal of everything the stack names, for a run that failed
# before its destroy. A missing resource is the normal answer.
delete_leftovers() { (
  set +eu
  # Deliveries first: CloudWatch Logs refuses to delete a source or a
  # destination a delivery still uses.
  for id in $(aws logs describe-deliveries --region "${REGION}" \
    --query "deliveries[?starts_with(deliverySourceName, '${SOURCE_PREFIX}')].id" --output text 2>/dev/null); do
    [ "${id}" = "None" ] || aws logs delete-delivery --id "${id}" --region "${REGION}" >/dev/null 2>&1
  done
  for gen in 1 2; do
    aws logs delete-delivery-source --name "${SOURCE_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws logs delete-delivery-destination --name "${DESTINATION_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws events delete-event-bus --name "${BUS_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
    aws logs delete-log-group --log-group-name "${GROUP_PREFIX}${gen}" --region "${REGION}" >/dev/null 2>&1
  done
) }

cleanup() {
  echo "==> Cleanup"
  set +eu
  local destroy_rc=1 destroy_out=""
  if [ -f "${LOCAL_DIST}" ]; then
    destroy_out=$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)
    destroy_rc=$?
    # No state is the normal pre-run and post-destroy answer, not a failed teardown.
    if [ "${destroy_rc}" -ne 0 ] && ! grep -q 'No state found' <<<"${destroy_out}"; then
      echo "WARN: cdkd state destroy exited ${destroy_rc}; state was kept, so check the account for leftovers" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  delete_leftovers
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Phase 1: deploy (SDK route)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_generation "phase 1 (fresh deploy)" 1 sdk
DELIVERY_1=$(record RecreateDelivery '.physicalId')
echo "    OK: source, destination and delivery ${DELIVERY_1} created on the SDK route"

echo "==> Phase 2: recreate the source under its SAME name while the delivery uses it"
# The source keeps its name, so the recreate deletes it first; CloudWatch Logs
# refuses (ConflictException) and the deploy must fail, naming the delivery.
set +e
BLOCKED_OUT=$(env CDKD_TEST_PHASE=blocked \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api RecreateDeliverySource --yes 2>&1 | tee /dev/stderr)
BLOCKED_RC=${PIPESTATUS[0]}
set -e
BLOCKED_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' <<<"${BLOCKED_OUT}")
[ "${BLOCKED_RC}" -ne 0 ] || { echo "FAIL: phase 2: the same-name recreate succeeded; CloudWatch Logs no longer refuses the delete, so this phase proves nothing" >&2; exit 1; }
# Each needle is the one this phase is about; a reworded message must fail here.
for needle in \
  "Failed to destroy old resource RecreateDeliverySource (${SOURCE_PREFIX}1) during --recreate-via-cc-api" \
  "RecreateDeliverySource's replacement is not known to take a new name" \
  "still depend on it (RecreateDelivery)" \
  "Give it a new name in the template"; do
  grep -qF "${needle}" <<<"${BLOCKED_PLAIN}" || { echo "FAIL: phase 2: the failure does not say: ${needle}" >&2; exit 1; }
done
load_state
assert_generation "phase 2 (after the refused recreate)" 1 sdk
[ "$(record RecreateDelivery '.physicalId')" = "${DELIVERY_1}" ] ||
  { echo "FAIL: phase 2: the delivery record moved off ${DELIVERY_1}" >&2; exit 1; }
echo "    OK: the refused recreate named the delivery and changed nothing"

echo "==> Phase 3: recreate all three on Cloud Control, the source and destination renamed"
RENAMED_OUT=$(env CDKD_TEST_PHASE=renamed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api RecreateDeliverySource --recreate-via-cc-api RecreateDeliveryDestination \
    --recreate-via-cc-api RecreateDelivery --yes 2>&1 | tee /dev/stderr)
RENAMED_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' <<<"${RENAMED_OUT}")
for id in RecreateDeliverySource RecreateDeliveryDestination; do
  grep -qF "${id}'s new name differs from the one the old resource holds" <<<"${RENAMED_PLAIN}" ||
    { echo "FAIL: phase 3: ${id} was not created first (no create-first line)" >&2; exit 1; }
  if grep -qF "Destroying old ${id} " <<<"${RENAMED_PLAIN}"; then
    echo "FAIL: phase 3: ${id} was destroyed before its replacement existed" >&2
    exit 1
  fi
done
load_state
assert_generation "phase 3 (after the renamed recreate)" 2 cc-api
DELIVERY_2=$(record RecreateDelivery '.physicalId')
[ "${DELIVERY_2}" != "${DELIVERY_1}" ] || { echo "FAIL: phase 3: the delivery kept id ${DELIVERY_1}; it was not recreated" >&2; exit 1; }
assert_gone_as "generation-1 delivery ${DELIVERY_1} survived its recreate" ResourceNotFoundException \
  aws logs get-delivery --id "${DELIVERY_1}" --region "${REGION}"
assert_gone_as "generation-1 source survived its renamed recreate" ResourceNotFoundException \
  aws logs get-delivery-source --name "${SOURCE_PREFIX}1" --region "${REGION}"
assert_gone_as "generation-1 destination survived its renamed recreate" ResourceNotFoundException \
  aws logs get-delivery-destination --name "${DESTINATION_PREFIX}1" --region "${REGION}"
echo "    OK: created first, old source, destination and delivery deleted, all three on Cloud Control"

echo "==> Phase 4: destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone_as "delivery ${DELIVERY_2} survived the destroy" ResourceNotFoundException \
  aws logs get-delivery --id "${DELIVERY_2}" --region "${REGION}"
assert_gone_as "source ${SOURCE_PREFIX}2 survived the destroy" ResourceNotFoundException \
  aws logs get-delivery-source --name "${SOURCE_PREFIX}2" --region "${REGION}"
assert_gone_as "destination ${DESTINATION_PREFIX}2 survived the destroy" ResourceNotFoundException \
  aws logs get-delivery-destination --name "${DESTINATION_PREFIX}2" --region "${REGION}"
for gen in 1 2; do
  assert_gone_as "event bus ${BUS_PREFIX}${gen} survived the destroy" ResourceNotFoundException \
    aws events describe-event-bus --name "${BUS_PREFIX}${gen}" --region "${REGION}"
  assert_gone_as "log group ${GROUP_PREFIX}${gen} survived the destroy" ResourceNotFoundException \
    aws logs list-tags-log-group --log-group-name "${GROUP_PREFIX}${gen}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- recreate-renamed-logs-delivery (a renamed recreate creates first; a same-name one a delivery blocks names it)"
