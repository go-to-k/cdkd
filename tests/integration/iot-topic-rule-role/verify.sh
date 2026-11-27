#!/usr/bin/env bash
# verify.sh -- cdkd AWS::IoT::TopicRule created with a same-stack role
# (issue #6559).
#
# `AWS::IoT::TopicRule` has no SDK provider, so it is created through Cloud
# Control seconds after its action role. Until IAM propagates the role, IoT
# refuses the create with "AWS IoT (iot.amazonaws.com) is unable to assume role
# (sts:AssumeRole)", which cdkd did not retry: every first deploy failed and
# rolled back. `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS`
# (`src/deployment/retryable-errors/patterns.ts`) now carries that wording.
#
# Phases:
#   1. Deploy a role for `iot.amazonaws.com`, two queues and a topic rule with
#      an SQS action and an SQS error action, all new (the role is created in
#      this deploy, so the rule's create meets an unpropagated role). Assert:
#      state records the rule on the Cloud Control route, AWS reports the
#      template's SQL, action role and error action, and a message published to
#      the rule's topic reaches the queue.
#   2. `cdkd diff` reports no changes.
#   3. UPDATE (CDKD_TEST_UPDATE=true: a new SQL that selects one field, a new
#      description, the error action removed). Assert all reached AWS, the
#      rule kept its name (in place), a published message now arrives with the
#      selected field only, and a diff under the same mode is clean.
#      Two unnamed thing types ride the update (go-to-k/cdkd#7083):
#      SearchThingType gains a searchable attribute, which CloudFormation
#      replaces, so it must get a NEW name holding both attributes and the old
#      one must be gone; MqttThingType changes only its Mqtt5Configuration,
#      which CloudFormation updates in place, so it must keep its name and
#      hold the new key.
#   4. Destroy. Assert the rule, the thing types, the queues, the role and the
#      state file are gone.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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
export AWS_PAGER=""

STACK="CdkdIotTopicRuleRole"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
RULE_LOGICAL="Rule"
ROLE_LOGICAL="RuleRole85A02A56"
QUEUE_LOGICAL="RuleQueue3DC6640F"
ERROR_QUEUE_LOGICAL="ErrorQueue2580A2D4"
SEARCH_TYPE_LOGICAL="SearchThingType"
MQTT_TYPE_LOGICAL="MqttThingType"
TOPIC="cdkd-integ/iot-topic-rule-role/sensor1"
DIFF_LOG="${TMPDIR:-/tmp}/cdkd-6559-diff.$$.log"

CLEANED_UP=0
PRE_RUN=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DIFF_LOG}"
  # `state destroy` throws when there is no state, as before any run and after a
  # PASS, so its failure means something only for a state that exists. Anything
  # but a clean not-found counts as existing: keeping a record costs nothing.
  STATE_LEFT=0
  if [ -n "${STATE_BUCKET:-}" ]; then
    if STATE_HEAD="$(aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" 2>&1 >/dev/null)"; then
      STATE_LEFT=1
    elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${STATE_HEAD}"; then
      STATE_LEFT=1
    fi
  fi
  if [ "${STATE_LEFT}" = "1" ] && [ -f "${LOCAL_DIST}" ] &&
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1; then
    STATE_LEFT=0
  fi
  # A deploy that failed before state recorded them leaves queues and a role
  # nothing here knows, and every generated name starts with the stack. The
  # account is shared and a peer may be running this fixture, so only this run's own
  # teardown deletes by prefix: before the run, a match is reported and stops
  # it. A failed rule create leaves no rule (Cloud Control rolls it back), and
  # the rule's name is generated by the handler, so it has no prefix to sweep;
  # so are the thing types' names.
  LEFT_BY_PREFIX=""
  case "${STACK}" in
    CdkdIot?*)
      if SWEPT_QUEUES="$(aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" \
        --query 'QueueUrls[]' --output text 2>&1)"; then
        for url in ${SWEPT_QUEUES}; do
          [ "${url}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} queue:${url##*/}"
          else
            aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 ||
              echo "WARN: could not delete queue ${url}" >&2
          fi
        done
      else
        echo "WARN: could not list queues of ${STACK}: ${SWEPT_QUEUES}" >&2
      fi
      # The action role, named `<stack>-RuleRole...` by cdkd. Its inline
      # policies go first: IAM refuses to delete a role that still has one.
      if SWEPT_ROLES="$(aws iam list-roles \
        --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text 2>&1)"; then
        for role in ${SWEPT_ROLES}; do
          [ "${role}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} role:${role}"
          else
            for policy in $(aws iam list-role-policies --role-name "${role}" --query 'PolicyNames[]' --output text 2>/dev/null); do
              aws iam delete-role-policy --role-name "${role}" --policy-name "${policy}" >/dev/null 2>&1 || true
            done
            aws iam delete-role --role-name "${role}" >/dev/null 2>&1 ||
              echo "WARN: could not delete role ${role}" >&2
          fi
        done
      else
        echo "WARN: could not list roles of ${STACK}: ${SWEPT_ROLES}" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdIot?*" >&2
      ;;
  esac
  # The state is the only record of what a failed `state destroy` left behind.
  if [ "${STATE_LEFT}" = "1" ]; then
    echo "WARN: state destroy failed: s3://${STATE_BUCKET:-}/${STATE_KEY} is kept, and resources of ${STACK} (rule, role) may remain" >&2
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
  if [ -n "${LEFT_BY_PREFIX}" ]; then
    echo "FAIL: ${STACK} resources exist before this run, possibly a peer's live run:${LEFT_BY_PREFIX}" >&2
    exit 1
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
PRE_RUN=1
cleanup
PRE_RUN=0
CLEANED_UP=0

read_state() { # $1 = python expression over `s` (the state fetched into STATE_JSON)
  printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print($1)"
}
thing_type_field() { # usage: thing_type_field <name> <query>; strict, no fallback
  aws iot describe-thing-type --thing-type-name "$1" --region "${REGION}" --query "$2" --output text
}
rule_field() { # usage: rule_field <query>; strict, no fallback
  aws iot get-topic-rule --rule-name "${RULE_NAME}" --region "${REGION}" --query "$1" --output text
}
assert_clean_diff() { # $1 = phase label; runs under the caller's CDKD_TEST_UPDATE
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DIFF_LOG}" 2>&1
  # cdkd's own line (src/cli/commands/diff.ts), naming this stack.
  if ! grep -qF "No changes detected for stack ${STACK}" "${DIFF_LOG}"; then
    echo "FAIL: diff $1 is not clean. Tail:" >&2
    tail -20 "${DIFF_LOG}" >&2
    exit 1
  fi
}
# Publishes $1 to the rule's topic and waits for the queue to receive a body;
# prints the first body and DELETES that message, so a later phase cannot
# receive it again once its visibility timeout lapses. The queue starts empty.
publish_and_receive() {
  local endpoint msg body receipt attempt
  endpoint="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "${REGION}" \
    --query endpointAddress --output text)" || return 1
  aws iot-data publish --endpoint-url "https://${endpoint}" --region "${REGION}" --topic "${TOPIC}" \
    --cli-binary-format raw-in-base64-out --payload "$1" >/dev/null || return 1
  for attempt in 1 2 3 4 5 6; do
    msg="$(aws sqs receive-message --queue-url "${QUEUE_URL}" --region "${REGION}" --wait-time-seconds 10 \
      --query 'Messages[0].[ReceiptHandle,Body]' --output text)" || return 1
    if [ -n "${msg}" ] && [ "${msg}" != "None" ]; then
      receipt="${msg%%$'\t'*}"
      body="${msg#*$'\t'}"
      aws sqs delete-message --queue-url "${QUEUE_URL}" --region "${REGION}" \
        --receipt-handle "${receipt}" >/dev/null || return 1
      printf '%s\n' "${body}"
      return 0
    fi
  done
  echo "FAIL: no message reached ${QUEUE_URL} within 60s of publishing to ${TOPIC}" >&2
  return 1
}

# --- Phase 1: deploy with a role created in the same deploy -----------------
echo "==> Phase 1: deploy (a topic rule and its brand-new action role)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
RULE_NAME="$(read_state "s['resources']['${RULE_LOGICAL}']['physicalId']")"
RULE_ROUTE="$(read_state "s['resources']['${RULE_LOGICAL}'].get('provisionedBy', '')")"
ROLE_NAME="$(read_state "s['resources']['${ROLE_LOGICAL}']['physicalId']")"
QUEUE_URL="$(read_state "s['resources']['${QUEUE_LOGICAL}']['physicalId']")"
ERROR_QUEUE_URL="$(read_state "s['resources']['${ERROR_QUEUE_LOGICAL}']['physicalId']")"
OUT_RULE="$(read_state "s.get('outputs', {}).get('RuleName', '')")"
[ -n "${RULE_NAME}" ] || { echo "FAIL: state records no physical id for ${RULE_LOGICAL}" >&2; exit 1; }
[ "${RULE_ROUTE}" = "cc-api" ] ||
  { echo "FAIL: ${RULE_LOGICAL} provisionedBy='${RULE_ROUTE}', expected cc-api" >&2; exit 1; }
[ "${OUT_RULE}" = "${RULE_NAME}" ] ||
  { echo "FAIL: output RuleName '${OUT_RULE}' != state physical id '${RULE_NAME}'" >&2; exit 1; }
echo "    state records rule ${RULE_NAME} via cc-api"

ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
RULE_SQL="$(rule_field rule.sql)"
RULE_ACTION_ROLE="$(rule_field 'rule.actions[0].sqs.roleArn')"
RULE_ACTION_QUEUE="$(rule_field 'rule.actions[0].sqs.queueUrl')"
RULE_ERROR_QUEUE="$(rule_field 'rule.errorAction.sqs.queueUrl')"
[ "${RULE_SQL}" = "SELECT * FROM 'cdkd-integ/iot-topic-rule-role/+'" ] ||
  { echo "FAIL: rule sql '${RULE_SQL}' is not the template's" >&2; exit 1; }
[ "${RULE_ACTION_ROLE}" = "${ROLE_ARN}" ] && [ "${RULE_ACTION_QUEUE}" = "${QUEUE_URL}" ] ||
  { echo "FAIL: rule action role '${RULE_ACTION_ROLE}' / queue '${RULE_ACTION_QUEUE}' != '${ROLE_ARN}' / '${QUEUE_URL}'" >&2; exit 1; }
[ "${RULE_ERROR_QUEUE}" = "${ERROR_QUEUE_URL}" ] ||
  { echo "FAIL: rule error action queue '${RULE_ERROR_QUEUE}' != '${ERROR_QUEUE_URL}'" >&2; exit 1; }
echo "    AWS reports the template's SQL, action role and error action"

BODY="$(publish_and_receive '{"temp":40,"hum":1}')"
[ "$(printf '%s' "${BODY}" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))')" = '{"hum": 1, "temp": 40}' ] ||
  { echo "FAIL: the queue received '${BODY}', expected the whole published message" >&2; exit 1; }
echo "    a message published to ${TOPIC} reached the queue"

# The thing types' premises (go-to-k/cdkd#7083), so Phase 3 cannot pass vacuously.
SEARCH_TYPE="$(read_state "s['resources']['${SEARCH_TYPE_LOGICAL}']['physicalId']")"
MQTT_TYPE="$(read_state "s['resources']['${MQTT_TYPE_LOGICAL}']['physicalId']")"
[ -n "${SEARCH_TYPE}" ] && [ -n "${MQTT_TYPE}" ] ||
  { echo "FAIL: #7083 premise: state records no physical id for ${SEARCH_TYPE_LOGICAL} ('${SEARCH_TYPE}') or ${MQTT_TYPE_LOGICAL} ('${MQTT_TYPE}')" >&2; exit 1; }
SEARCH_ATTRS="$(thing_type_field "${SEARCH_TYPE}" 'join(`,`, thingTypeProperties.searchableAttributes)')"
MQTT_KEY="$(thing_type_field "${MQTT_TYPE}" 'thingTypeProperties.mqtt5Configuration.propagatingAttributes[0].userPropertyKey')"
[ "${SEARCH_ATTRS}" = "serial" ] ||
  { echo "FAIL: #7083 premise: thing type ${SEARCH_TYPE} searchable attributes are '${SEARCH_ATTRS}', expected serial" >&2; exit 1; }
[ "${MQTT_KEY}" = "k1" ] ||
  { echo "FAIL: #7083 premise: thing type ${MQTT_TYPE} propagates user property key '${MQTT_KEY}', expected k1" >&2; exit 1; }
echo "    thing types ${SEARCH_TYPE} (serial) and ${MQTT_TYPE} (k1) exist"

# --- Phase 2: diff is clean -------------------------------------------------
echo "==> Phase 2: diff (expect no changes)"
# Empty rather than unset: a function call cannot take `env -u`, and the stack
# only updates when the value is exactly `true`.
CDKD_TEST_UPDATE= assert_clean_diff "after the create"
echo "    diff reports no changes"

# --- Phase 3: in-place UPDATE through Cloud Control -------------------------
echo "==> Phase 3: update (new SQL and description, error action removed; thing type changes)"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the update deploy failed (the rule update, or #7083: a SearchableAttributes change must replace ${SEARCH_TYPE_LOGICAL}, not update it in place)" >&2
  exit 1
fi

SQL_AFTER="$(rule_field rule.sql)"
DESCRIPTION_AFTER="$(rule_field rule.description)"
ERROR_AFTER="$(rule_field rule.errorAction)"
[ "${SQL_AFTER}" = "SELECT temp FROM 'cdkd-integ/iot-topic-rule-role/+' WHERE temp > 30" ] ||
  { echo "FAIL: rule sql after the update is '${SQL_AFTER}'" >&2; exit 1; }
[ "${DESCRIPTION_AFTER}" = "updated" ] ||
  { echo "FAIL: rule description after the update is '${DESCRIPTION_AFTER}', expected updated" >&2; exit 1; }
[ "${ERROR_AFTER}" = "None" ] ||
  { echo "FAIL: the removed error action is still on the rule: ${ERROR_AFTER}" >&2; exit 1; }
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
RULE_ID_AFTER="$(read_state "s['resources']['${RULE_LOGICAL}']['physicalId']")"
[ "${RULE_ID_AFTER}" = "${RULE_NAME}" ] ||
  { echo "FAIL: ${RULE_LOGICAL} was replaced ('${RULE_NAME}' -> '${RULE_ID_AFTER}')" >&2; exit 1; }
echo "    update reached AWS; ${RULE_NAME} updated in place"

SEARCH_TYPE_AFTER="$(read_state "s['resources']['${SEARCH_TYPE_LOGICAL}']['physicalId']")"
MQTT_TYPE_AFTER="$(read_state "s['resources']['${MQTT_TYPE_LOGICAL}']['physicalId']")"
[ -n "${SEARCH_TYPE_AFTER}" ] && [ "${SEARCH_TYPE_AFTER}" != "${SEARCH_TYPE}" ] ||
  { echo "FAIL: #7083: ${SEARCH_TYPE_LOGICAL} was not replaced on a SearchableAttributes change (physical id '${SEARCH_TYPE}' -> '${SEARCH_TYPE_AFTER}')" >&2; exit 1; }
SEARCH_ATTRS_AFTER="$(thing_type_field "${SEARCH_TYPE_AFTER}" 'join(`,`, thingTypeProperties.searchableAttributes)')"
[ "${SEARCH_ATTRS_AFTER}" = "serial,model" ] ||
  { echo "FAIL: #7083: replacement thing type ${SEARCH_TYPE_AFTER} searchable attributes are '${SEARCH_ATTRS_AFTER}', expected serial,model" >&2; exit 1; }
assert_gone "#7083: replaced thing type ${SEARCH_TYPE} still exists after the update" \
  aws iot describe-thing-type --thing-type-name "${SEARCH_TYPE}" --region "${REGION}"
[ "${MQTT_TYPE_AFTER}" = "${MQTT_TYPE}" ] ||
  { echo "FAIL: #7083: ${MQTT_TYPE_LOGICAL} was replaced on a Mqtt5Configuration change ('${MQTT_TYPE}' -> '${MQTT_TYPE_AFTER}'); CloudFormation updates it in place" >&2; exit 1; }
MQTT_KEY_AFTER="$(thing_type_field "${MQTT_TYPE}" 'thingTypeProperties.mqtt5Configuration.propagatingAttributes[0].userPropertyKey')"
[ "${MQTT_KEY_AFTER}" = "k2" ] ||
  { echo "FAIL: #7083: thing type ${MQTT_TYPE} propagates user property key '${MQTT_KEY_AFTER}' after the update, expected k2" >&2; exit 1; }
echo "    ${SEARCH_TYPE_LOGICAL} replaced (${SEARCH_TYPE} -> ${SEARCH_TYPE_AFTER}); ${MQTT_TYPE} updated in place to k2"

BODY="$(publish_and_receive '{"temp":40,"hum":1}')"
[ "$(printf '%s' "${BODY}" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))')" = '{"temp": 40}' ] ||
  { echo "FAIL: the queue received '${BODY}', expected only the selected field" >&2; exit 1; }
echo "    the updated SQL forwards the selected field only"

CDKD_TEST_UPDATE=true assert_clean_diff "after the update"
echo "    diff under the update mode reports no changes"

# --- Phase 4: destroy -------------------------------------------------------
echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# IoT answers `get-topic-rule` on a missing rule with UnauthorizedException,
# which no gone-probe accepts: read the (strict) rule list instead.
RULES_LEFT="$(aws iot list-topic-rules --region "${REGION}" \
  --query "rules[?ruleName=='${RULE_NAME}'].ruleName" --output text)"
[ -z "${RULES_LEFT}" ] ||
  { echo "FAIL: topic rule ${RULE_NAME} still exists after destroy" >&2; exit 1; }
assert_gone "thing type ${SEARCH_TYPE_AFTER} still exists after destroy" \
  aws iot describe-thing-type --thing-type-name "${SEARCH_TYPE_AFTER}" --region "${REGION}"
assert_gone "thing type ${MQTT_TYPE} still exists after destroy" \
  aws iot describe-thing-type --thing-type-name "${MQTT_TYPE}" --region "${REGION}"
assert_gone "queue ${QUEUE_URL} still exists after destroy" \
  aws sqs get-queue-attributes --queue-url "${QUEUE_URL}" --region "${REGION}"
assert_gone "queue ${ERROR_QUEUE_URL} still exists after destroy" \
  aws sqs get-queue-attributes --queue-url "${ERROR_QUEUE_URL}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

cleanup
trap - EXIT INT TERM
echo "[verify] PASS — a topic rule created with a brand-new role deployed, delivered, updated in place, diff clean; a thing type replaced on SearchableAttributes and one kept on Mqtt5Configuration; destroy left nothing"
