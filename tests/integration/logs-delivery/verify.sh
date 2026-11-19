#!/usr/bin/env bash
# verify.sh — cdkd CloudWatch Logs delivery SDK providers integ (PR #6577).
#
# An EventBridge bus's logs go to a CloudWatch Logs log group through
# AWS::Logs::DeliverySource, AWS::Logs::DeliveryDestination (with a
# DeliveryDestinationPolicy) and AWS::Logs::Delivery, each created through its
# SDK provider.
#
# Phases:
#   1. Deploy; all three exist in CloudWatch Logs as declared, and the state
#      records them on the SDK route under CloudFormation's physical ids.
#   2. CDKD_TEST_UPDATE=true: all three gain a tag, the destination policy
#      changes, the delivery narrows its RecordFields (AWS refuses a
#      FieldDelimiter for a CloudWatch Logs destination). All applied in place:
#      the source and destination ARNs and the delivery id are unchanged.
#   3. `cdkd drift` and `cdkd diff` are clean against the updated template.
#      The log group's data protection policy (one data identifier, two after
#      phase 2) and the destination policy are also drift-clean right after
#      phase 1 (go-to-k/cdkd#6609).
#   4. Destroy; the delivery, source, destination (whose policy is still
#      attached, so DeleteDeliveryDestination must succeed with one), log
#      group, bus and state are all gone. A destination re-created under the
#      same Name carries no policy, so the policy did not outlive its
#      destination.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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
cd "$(dirname "$0")"

STACK="CdkdLogsDeliveryExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SOURCE_NAME="cdkd-integ-logs-delivery-src"
DESTINATION_NAME="cdkd-integ-logs-delivery-dst"
BUS_NAME="cdkd-integ-logs-delivery-bus"
LOG_GROUP="/aws/vendedlogs/cdkd-integ-logs-delivery"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # Children first: a source or destination a delivery uses refuses deletion.
  for id in $(aws logs describe-deliveries --region "${REGION}" \
    --query "deliveries[?deliverySourceName=='${SOURCE_NAME}'].id" --output text 2>/dev/null); do
    aws logs delete-delivery --id "${id}" --region "${REGION}" >/dev/null 2>&1
  done
  aws logs delete-delivery-source --name "${SOURCE_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-delivery-destination-policy --delivery-destination-name "${DESTINATION_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-delivery-destination --name "${DESTINATION_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1
  aws events delete-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

# A field of a resource's state record.
record() { # usage: record <logicalId> <jq-expression-over-the-resource-object>
  local json
  json="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${json}" | jq -r ".resources.$1 | $2"
}

# The user tags of a CloudWatch Logs ARN as compact JSON.
tags_of() { # usage: tags_of <arn>
  local json
  json="$(aws logs list-tags-for-resource --resource-arn "$1" --region "${REGION}" --output json)" || return 1
  printf '%s' "${json}" | jq -c '.tags // {} | with_entries(select(.key | startswith("aws:") | not))'
}

# go-to-k/cdkd#6609: the baseline captured right after a member write (a
# policy or setting a separate call puts on the resource) matches the settled
# resource, so drift compares that member and finds nothing. Drift elsewhere
# (exit 1) or an incomplete comparison of another type (exit 2) is not this
# check's subject; only the member's path on the named type is read off the
# report. The phase's env goes after the label, as `env` arguments.
check_member_baseline() { # usage: check_member_baseline <type> <key> <phase label> [env args...]
  local type="$1" key="$2" label="$3" report rc=0
  shift 3
  report=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${report}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report after ${label}" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  if ! jq -e --arg stack "${STACK}" --arg type "${type}" --arg key "${key}" '
    def member: .path == $key or (.path | startswith($key + ".")) or (.path | startswith($key + "["));
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[], ($reports[0].drifted // [])[] | select(.type == $type)] | length) >= 1 and
    ([($reports[0].drifted // [])[] | select(.type == $type) | .changes[] | select(member)] | length) == 0 and
    ([($reports[0].notCompared // [])[] | select(.type == $type)] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: ${type} ${key} is drifted, or a ${type} is not compared, after ${label} (#6609)" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: every ${type} ${key} is drift-clean after ${label} (#6609)"
}

# go-to-k/cdkd#6609: drift alone cannot see a stale baseline while the live
# member is the declared one (the drift heal rule skips the key then), so this
# reads the baseline itself. The state record's observed member must be
# exactly what AWS holds now, key order aside ('<absent>' when neither holds
# one); a baseline captured before the write showed fails here.
state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }
state_lids() { # usage: state_lids <resourceType> -- every logical id of that type
  state_json | jq -r --arg t "$1" '.resources | to_entries[] | select(.value.resourceType == $t) | .key'
}
state_field() { # usage: state_field <logical-id> <jq path into the record>
  state_json | jq -r --arg l "$1" ".resources[\$l] | $2"
}
assert_observed_member() { # usage: assert_observed_member <logical-id> <jq path into observedProperties> <live JSON, '' for none> <label>
  local recorded live
  recorded=$(state_json | jq -cS --arg l "$1" \
    ".resources[\$l].observedProperties as \$o | if \$o == null then \"<no baseline>\" else ((\$o | $2) // \"<absent>\") end") \
    || { echo "FAIL: cannot read the state record of $1 after $4" >&2; exit 1; }
  if [ -z "$3" ]; then live='"<absent>"'; else live=$(jq -cS . <<<"$3"); fi
  if [ "${recorded}" != "${live}" ]; then
    echo "FAIL: $1's recorded baseline $2 is not what AWS holds after $4 (#6609)" >&2
    echo "  recorded: ${recorded}" >&2
    echo "  live:     ${live}" >&2
    exit 1
  fi
  echo "    OK: $1's baseline $2 is the live value after $4 (#6609)"
}

check_delivery_records() { # usage: check_delivery_records <phase label>
  local lid
  assert_observed_member Destination .DeliveryDestinationPolicy.DeliveryDestinationPolicy \
    "$(aws logs get-delivery-destination-policy --delivery-destination-name "${DESTINATION_NAME}" \
      --region "${REGION}" --query 'policy.deliveryDestinationPolicy' --output text)" "$1"
  lid=$(state_lids AWS::Logs::LogGroup)
  [ -n "${lid}" ] || { echo "FAIL: no AWS::Logs::LogGroup in state after $1" >&2; exit 1; }
  assert_observed_member "${lid}" .DataProtectionPolicy \
    "$(aws logs get-data-protection-policy --log-group-identifier "${LOG_GROUP}" --region "${REGION}" \
      --query policyDocument --output text)" "$1"
}

# The data identifiers of the log group's data protection policy, sorted and comma-joined.
dpp_identifiers() {
  local doc
  doc="$(aws logs get-data-protection-policy --log-group-identifier "${LOG_GROUP}" --region "${REGION}" \
    --query policyDocument --output text)" || return 1
  printf '%s' "${doc}" | jq -r '[.statement[0].dataIdentifier[] | split("/") | last] | sort | join(",")'
}

echo "==> Phase 1: deploy"
OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || {
  echo "${OUT}"; echo "FAIL: phase 1 deploy" >&2; exit 1
}
echo "${OUT}"
for id in Source Destination Delivery; do
  ROUTE="$(record "${id}" '.provisionedBy')"
  [ "${ROUTE}" = "sdk" ] || { echo "FAIL: ${id} recorded provisionedBy=${ROUTE}, expected sdk" >&2; exit 1; }
done
[ "$(record Source '.physicalId')" = "${SOURCE_NAME}" ] || { echo "FAIL: the source's physical id is not its Name" >&2; exit 1; }
[ "$(record Destination '.physicalId')" = "${DESTINATION_NAME}" ] || { echo "FAIL: the destination's physical id is not its Name" >&2; exit 1; }
DELIVERY_ID="$(record Delivery '.physicalId')"

SRC="$(aws logs describe-delivery-sources --region "${REGION}" --output json \
  | jq -c --arg n "${SOURCE_NAME}" '.deliverySources[] | select(.name == $n) | {arn, logType, resourceArns}')"
[ -n "${SRC}" ] || { echo "FAIL: describe-delivery-sources does not list ${SOURCE_NAME}" >&2; exit 1; }
SOURCE_ARN="$(jq -r .arn <<<"${SRC}")"
[ "$(jq -r .logType <<<"${SRC}")" = "INFO_LOGS" ] || { echo "FAIL: source logType: ${SRC}" >&2; exit 1; }
jq -e '.resourceArns[0] | endswith(":event-bus/cdkd-integ-logs-delivery-bus")' <<<"${SRC}" >/dev/null \
  || { echo "FAIL: source resourceArns: ${SRC}" >&2; exit 1; }
[ "$(record Source '.attributes.Arn')" = "${SOURCE_ARN}" ] || { echo "FAIL: recorded source Arn differs from ${SOURCE_ARN}" >&2; exit 1; }

DST="$(aws logs describe-delivery-destinations --region "${REGION}" --output json \
  | jq -c --arg n "${DESTINATION_NAME}" '.deliveryDestinations[] | select(.name == $n) | {arn, deliveryDestinationType, deliveryDestinationConfiguration}')"
[ -n "${DST}" ] || { echo "FAIL: describe-delivery-destinations does not list ${DESTINATION_NAME}" >&2; exit 1; }
DESTINATION_ARN="$(jq -r .arn <<<"${DST}")"
[ "$(jq -r .deliveryDestinationType <<<"${DST}")" = "CWL" ] || { echo "FAIL: destination type: ${DST}" >&2; exit 1; }
jq -e '.deliveryDestinationConfiguration.destinationResourceArn | contains(":log-group:/aws/vendedlogs/cdkd-integ-logs-delivery")' <<<"${DST}" >/dev/null \
  || { echo "FAIL: destination target: ${DST}" >&2; exit 1; }
POLICY="$(aws logs get-delivery-destination-policy --delivery-destination-name "${DESTINATION_NAME}" --region "${REGION}" \
  --query 'policy.deliveryDestinationPolicy' --output text)"
jq -e '.Statement[0].Sid == "AllowCreateDelivery"' <<<"${POLICY}" >/dev/null \
  || { echo "FAIL: destination policy: ${POLICY}" >&2; exit 1; }
DPP="$(dpp_identifiers)"
[ "${DPP}" = "EmailAddress" ] || { echo "FAIL: log group data protection identifiers after phase 1: '${DPP}'" >&2; exit 1; }
check_member_baseline AWS::Logs::DeliveryDestination DeliveryDestinationPolicy "phase 1" -u CDKD_TEST_UPDATE
check_member_baseline AWS::Logs::LogGroup DataProtectionPolicy "phase 1" -u CDKD_TEST_UPDATE
check_delivery_records "phase 1"

DEL="$(aws logs describe-deliveries --region "${REGION}" --output json \
  | jq -c --arg id "${DELIVERY_ID}" '.deliveries[] | select(.id == $id) | {arn, deliverySourceName, deliveryDestinationArn}')"
[ -n "${DEL}" ] || { echo "FAIL: describe-deliveries does not list ${DELIVERY_ID}" >&2; exit 1; }
DELIVERY_ARN="$(jq -r .arn <<<"${DEL}")"
[ "$(jq -r .deliverySourceName <<<"${DEL}")" = "${SOURCE_NAME}" ] || { echo "FAIL: delivery source: ${DEL}" >&2; exit 1; }
[ "$(jq -r .deliveryDestinationArn <<<"${DEL}")" = "${DESTINATION_ARN}" ] || { echo "FAIL: delivery destination: ${DEL}" >&2; exit 1; }
echo "    OK: source, destination (with policy) and delivery ${DELIVERY_ID} exist on the SDK route"

echo "==> Phase 2: tags, policy and RecordFields change in place"
OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || {
  echo "${OUT}"; echo "FAIL: phase 2 deploy" >&2; exit 1
}
echo "${OUT}"
[ "$(record Delivery '.physicalId')" = "${DELIVERY_ID}" ] || { echo "FAIL: the delivery was replaced" >&2; exit 1; }
[ "$(record Source '.attributes.Arn')" = "${SOURCE_ARN}" ] || { echo "FAIL: the source was replaced" >&2; exit 1; }
[ "$(record Destination '.attributes.Arn')" = "${DESTINATION_ARN}" ] || { echo "FAIL: the destination was replaced" >&2; exit 1; }
for arn in "${SOURCE_ARN}" "${DESTINATION_ARN}" "${DELIVERY_ARN}"; do
  TAGS="$(tags_of "${arn}")"
  [ "${TAGS}" = '{"cdkd-integ":"updated"}' ] || { echo "FAIL: tags of ${arn} are ${TAGS}" >&2; exit 1; }
done
POLICY="$(aws logs get-delivery-destination-policy --delivery-destination-name "${DESTINATION_NAME}" --region "${REGION}" \
  --query 'policy.deliveryDestinationPolicy' --output text)"
jq -e '.Statement[0].Sid == "AllowCreateDeliveryUpdated"' <<<"${POLICY}" >/dev/null \
  || { echo "FAIL: updated destination policy: ${POLICY}" >&2; exit 1; }
DPP="$(dpp_identifiers)"
[ "${DPP}" = "EmailAddress,IpAddress" ] || { echo "FAIL: log group data protection identifiers after phase 2: '${DPP}'" >&2; exit 1; }
check_delivery_records "phase 2"
FIELDS="$(aws logs get-delivery --id "${DELIVERY_ID}" --region "${REGION}" --output json | jq -c '.delivery.recordFields')"
[ "${FIELDS}" = '["resource_arn","event_bus_name"]' ] || { echo "FAIL: delivery recordFields is ${FIELDS}" >&2; exit 1; }
echo "    OK: tags, policy and RecordFields applied; ids and ARNs unchanged"

echo "==> Phase 3: drift and diff are clean"
DRIFT_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || {
  echo "${DRIFT_OUT}"; echo "FAIL: cdkd drift reported drift (or failed) right after a deploy" >&2; exit 1
}
echo "${DRIFT_OUT}"
# Exit 0 also covers a resource drift could not compare: require all five.
DRIFT_CLEAN="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"${DRIFT_OUT}")"
if ! grep -qF '(5 resources checked, 0 unsupported)' <<<"${DRIFT_CLEAN}"; then
  echo "FAIL: drift did not compare all five resources -- expected '(5 resources checked, 0 unsupported)'" >&2
  exit 1
fi
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || {
  echo "${DIFF_OUT}"; echo "FAIL: cdkd diff failed" >&2; exit 1
}
DIFF_CLEAN="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"${DIFF_OUT}")"
if ! grep -qF "No changes detected for stack ${STACK}" <<<"${DIFF_CLEAN}"; then
  echo "${DIFF_OUT}"; echo "FAIL: cdkd diff reported changes right after a deploy" >&2; exit 1
fi
echo "    OK: no drift (5 resources compared), no diff"

echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "delivery ${DELIVERY_ID} still exists after destroy" \
  aws logs get-delivery --id "${DELIVERY_ID}" --region "${REGION}"
assert_gone "delivery source ${SOURCE_NAME} still exists after destroy" \
  aws logs get-delivery-source --name "${SOURCE_NAME}" --region "${REGION}"
assert_gone "delivery destination ${DESTINATION_NAME} still exists after destroy" \
  aws logs get-delivery-destination --name "${DESTINATION_NAME}" --region "${REGION}"
assert_gone "log group ${LOG_GROUP} still exists after destroy" \
  aws logs list-tags-for-resource --resource-arn "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${LOG_GROUP}" --region "${REGION}"
assert_gone "event bus ${BUS_NAME} still exists after destroy" \
  aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: delivery, source, destination, log group, bus and state gone"

echo "==> Phase 5: the destination policy did not outlive its destination"
# Re-create the destination under the same Name, by hand, on a scratch log
# group: GetDeliveryDestinationPolicy then answers an empty policy (measured;
# it is not a not-found), which proves DeleteDeliveryDestination took the
# policy with it. Both are removed again here and by cleanup().
aws logs create-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}"
aws logs put-delivery-destination --name "${DESTINATION_NAME}" --region "${REGION}" \
  --delivery-destination-configuration "destinationResourceArn=arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${LOG_GROUP}" >/dev/null
LEFT="$(aws logs get-delivery-destination-policy --delivery-destination-name "${DESTINATION_NAME}" --region "${REGION}" \
  --query 'policy.deliveryDestinationPolicy' --output text)"
aws logs delete-delivery-destination --name "${DESTINATION_NAME}" --region "${REGION}"
aws logs delete-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}"
[ "${LEFT}" = "None" ] || { echo "FAIL: the re-created destination still carries the old policy: ${LEFT}" >&2; exit 1; }
assert_gone "scratch destination ${DESTINATION_NAME} still exists" \
  aws logs get-delivery-destination --name "${DESTINATION_NAME}" --region "${REGION}"
echo "    OK: no policy survived the destination"

trap - EXIT INT TERM
echo ""
echo "[verify] PASS — logs-delivery: a delivery source, destination (with policy) and delivery are created, updated in place, compare clean and are deleted through the SDK providers; no policy outlives its destination"
