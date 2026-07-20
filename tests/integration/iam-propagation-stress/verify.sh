#!/usr/bin/env bash
# verify.sh - cdkd iam-propagation-stress integ.
#
# A RACE DETECTOR for IAM-propagation bugs on cdkd's fast SDK path. cdkd
# creates a fresh IAM role and has a service assume it within ~1s, before IAM
# finishes propagating the role / its trust policy. CloudFormation tolerates
# this via deployment latency; cdkd does NOT, so every "role created ->
# assumed within ~1s" edge is a potential failure. The race is handled
# NARROWLY for a few consumers (RDS Enhanced Monitoring #794, ECS
# CapacityProvider #805, Custom Resource #756) but MANY others are unprotected.
#
# This stack creates SEVERAL brand-new roles, each consumed IMMEDIATELY by a
# DIFFERENT service in one deploy, to surface any unprotected consumer:
#   edge 1: Lambda exec role            -> Lambda::Function (CreateFunction)
#   edge 2: SFN role                    -> StepFunctions::StateMachine
#   edge 3: EventBridge target role     -> Events::Rule SFN target (PutTargets)
#   edge 4: fresh principal role        -> SQS QueuePolicy + SNS TopicPolicy
#
# THE PASS CONDITION IS: deploy SUCCEEDS. A deploy failure here is a real cdkd
# finding (an unprotected consumer racing IAM propagation), so on failure this
# script prints WHICH resource failed + the error so triage is trivial, then
# still attempts destroy/cleanup.
#
# On success it also asserts each role-consuming resource actually works:
#   - invoke the Lambda (proves the fresh exec role assumed cleanly)
#   - start + describe an SFN execution (proves the fresh SFN role works AND
#     the SFN->Lambda invoke grant works)
#   - confirm the EventBridge rule + its SFN target exist (proves PutTargets
#     accepted the fresh target role)
# then destroys clean and asserts the named resources are gone.
#
# BSD/macOS-portable (no `grep -P`, no `date -d`). Captures the real rc and
# prints an explicit `[verify] PASS` only on full success.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdIamPropagationStressExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Physical ids captured from state in Phase 1, used by the destroy assertions.
FN_NAME=""
SM_ARN=""
RULE_NAME=""
QUEUE_URL=""
TOPIC_ARN=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # Drop the deployment-events sidecar (separate key family from state.json).
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/deployments/" \
      --recursive >/dev/null 2>&1 || true
  fi
  set -eu
}

# Print a focused triage block when the deploy fails (a race finding).
report_deploy_failure() {
  echo "" >&2
  echo "================ DEPLOY FAILED (possible IAM-propagation race) ================" >&2
  echo "This integ is a race detector: a deploy failure is a REAL cdkd finding." >&2
  echo "Below is the deploy output + per-resource state so triage is trivial." >&2
  echo "" >&2
  echo "---- deploy output (tail) ----" >&2
  tail -n 60 "${DEPLOY_LOG:-/dev/null}" >&2 2>/dev/null || true
  echo "" >&2
  echo "---- per-resource events (newest run, if any) ----" >&2
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" events "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --format json 2>/dev/null \
      | jq -r '
          if type == "object" and has("events") then .events else . end
          | (if type == "array" then . else [] end)
          | map(select(.type == "RESOURCE_FAILED" or (.error // null) != null))
          | .[]
          | "FAILED resource: logicalId=\(.logicalId // "?") type=\(.resourceType // "?") error=\(.error // "?")"
        ' 2>/dev/null || echo "(no structured events available)" >&2
  fi
  echo "" >&2
  echo "---- partial state resources (logicalId -> type) ----" >&2
  aws s3 cp "s3://${STATE_BUCKET:-}/${STATE_KEY}" - 2>/dev/null \
    | jq -r '.resources | to_entries[] | "\(.key)\t\(.value.resourceType)\tphysicalId=\(.value.physicalId // "<none>")"' \
    2>/dev/null || echo "(no state file written)" >&2
  echo "===============================================================================" >&2
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy (THE race-detecting step) ----------------------------
echo "==> Phase 1: deploy with the local binary (race detector)"
DEPLOY_LOG="$(mktemp)"
trap 'rm -f "${DEPLOY_LOG}"; cleanup' EXIT
trap 'rm -f "${DEPLOY_LOG}"; (exit 130); cleanup; exit 130' INT
trap 'rm -f "${DEPLOY_LOG}"; (exit 143); cleanup; exit 143' TERM

deploy_rc=0
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}" || deploy_rc=$?
# `tee` masks the real exit code; recover it from PIPESTATUS[0] (the node side).
if [ "${deploy_rc}" -eq 0 ]; then
  deploy_rc="${PIPESTATUS[0]}"
fi

if [ "${deploy_rc}" -ne 0 ]; then
  report_deploy_failure
  echo "FAIL: cdkd deploy exited ${deploy_rc} - a role-consuming resource likely raced IAM propagation (see triage above)" >&2
  exit 1
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve physical ids from state (CDK auto-names everything) ----------
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("WorkerFn")) | .value.physicalId] | first')
SM_ARN=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::StepFunctions::StateMachine") | .value.physicalId] | first')
RULE_PHYSICAL_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Events::Rule") | .value.physicalId] | first')
# cdkd's EventBridgeRuleProvider stores the rule ARN as the physical id
# (arn:<p>:events:<r>:<acct>:rule/<RuleName> on the default bus, or
# arn:...:rule/<BusName>/<RuleName> on a custom bus). `aws events
# list-targets-by-rule --rule` / `describe-rule --name` both want the bare
# rule NAME, not the ARN, so strip everything up to and including the LAST
# `/`. A bare name (no `/`) passes through unchanged.
RULE_NAME="${RULE_PHYSICAL_ID##*/}"
QUEUE_URL=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::SQS::Queue") | .value.physicalId] | first')
TOPIC_ARN=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::SNS::Topic") | .value.physicalId] | first')

for pair in "FN_NAME=${FN_NAME}" "SM_ARN=${SM_ARN}" "RULE_NAME=${RULE_NAME}" "QUEUE_URL=${QUEUE_URL}" "TOPIC_ARN=${TOPIC_ARN}"; do
  name="${pair%%=*}"
  val="${pair#*=}"
  if [ -z "${val}" ] || [ "${val}" = "null" ]; then
    echo "FAIL: could not resolve ${name} from state (a race-edge resource is missing)" >&2
    echo "${STATE}" | jq -r '.resources | to_entries[] | "\(.key)\t\(.value.resourceType)"' >&2
    exit 1
  fi
done
echo "    resolved: FN=${FN_NAME} SM=${SM_ARN} RULE=${RULE_NAME}"
echo "              QUEUE=${QUEUE_URL} TOPIC=${TOPIC_ARN}"
echo "    OK: deploy succeeded - all 4 fresh-role race edges created without an IAM-propagation failure"

# --- Phase 1b: assert each role-consuming resource actually works ----------
echo "==> Phase 1b: assert role-consuming resources work"

# Edge 1: invoke the Lambda on its fresh exec role.
OUT_FILE="$(mktemp)"
trap 'rm -f "${DEPLOY_LOG}" "${OUT_FILE}"; cleanup' EXIT
trap 'rm -f "${DEPLOY_LOG}" "${OUT_FILE}"; (exit 130); cleanup; exit 130' INT
trap 'rm -f "${DEPLOY_LOG}" "${OUT_FILE}"; (exit 143); cleanup; exit 143' TERM
aws lambda invoke \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"ping":"cdkd"}' \
  "${OUT_FILE}" >/dev/null 2>&1
MARKER=$(jq -r '.marker // empty' "${OUT_FILE}")
if [ "${MARKER}" != "cdkd-iam-propagation-stress-marker-v1" ]; then
  echo "FAIL: Lambda marker is '${MARKER}', expected 'cdkd-iam-propagation-stress-marker-v1' (fresh exec role invoke)" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi
echo "    OK: edge 1 - Lambda invoked on its fresh exec role"

# Edge 2: start + describe an SFN execution (uses the fresh SFN role; the
# task invokes the Lambda via the fresh grant). We poll for a terminal state.
#
# IAM-propagation note: cdkd's fast SDK path attaches the SFN role's inline
# lambda:InvokeFunction grant and returns ~immediately; the SFN service then
# assumes that role and may cache policy-less credentials before IAM has
# propagated the grant to the assumed-role session, so the FIRST execution can
# FAIL with `lambda:InvokeFunction ... no identity-based policy allows` /
# AccessDenied. This is the very race this fixture stresses; CloudFormation
# never hits it because its slower finish lets IAM settle. The grant propagates
# within ~30s, so retry a FRESH execution across the propagation window on that
# narrow authz signal (a non-authz FAILED is a real failure - fail immediately).
SM_STATUS=""
SM_LAST_CAUSE=""
for attempt in 1 2 3 4 5 6; do
  EXEC_ARN=$(aws stepfunctions start-execution \
    --state-machine-arn "${SM_ARN}" --region "${REGION}" \
    --input '{"hello":"cdkd"}' \
    --query 'executionArn' --output text 2>/dev/null)
  if [ -z "${EXEC_ARN}" ] || [ "${EXEC_ARN}" = "None" ]; then
    echo "FAIL: could not start an SFN execution (fresh SFN role may have failed)" >&2
    exit 1
  fi
  SM_STATUS="RUNNING"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    SM_STATUS=$(aws stepfunctions describe-execution \
      --execution-arn "${EXEC_ARN}" --region "${REGION}" \
      --query 'status' --output text 2>/dev/null)
    if [ "${SM_STATUS}" != "RUNNING" ]; then
      break
    fi
    sleep 2
  done
  if [ "${SM_STATUS}" = "SUCCEEDED" ]; then
    break
  fi
  # Still RUNNING after the inner 15x2s=30s poll: the execution is slow, not
  # failed. Its `cause` query returns `None`, which matches no authz pattern and
  # would otherwise fall into the `*)` arm and FAIL a perfectly healthy-but-slow
  # run. Treat it as transient and continue the OUTER loop (start a fresh
  # execution after backoff) so it gets more wall-clock across attempts; the
  # outer loop is already capped at 6, and the post-loop guard below fails only
  # if it never SUCCEEDED.
  if [ "${SM_STATUS}" = "RUNNING" ]; then
    echo "    edge 2 attempt ${attempt}: SFN execution still RUNNING after inner poll (slow, retrying a fresh execution)" >&2
    sleep $(( attempt * 5 ))
    continue
  fi
  # FAILED (or other terminal status): inspect the cause. Retry only on the
  # IAM-propagation authz signal; any other terminal status is a real failure.
  SM_LAST_CAUSE=$(aws stepfunctions describe-execution \
    --execution-arn "${EXEC_ARN}" --region "${REGION}" \
    --query 'cause' --output text)
  case "${SM_LAST_CAUSE}" in
    *"lambda:InvokeFunction"*|*"no identity-based policy allows"*|*"AccessDeniedException"*|*"not authorized to perform"*)
      echo "    edge 2 attempt ${attempt}: SFN role grant not yet propagated (retrying a fresh execution)" >&2
      sleep $(( attempt * 5 ))
      continue
      ;;
    *)
      echo "FAIL: SFN execution status is '${SM_STATUS}', expected 'SUCCEEDED' (fresh SFN role / SFN->Lambda grant)" >&2
      aws stepfunctions describe-execution --execution-arn "${EXEC_ARN}" --region "${REGION}" >&2 2>/dev/null || true
      exit 1
      ;;
  esac
done
if [ "${SM_STATUS}" != "SUCCEEDED" ]; then
  echo "FAIL: SFN execution never SUCCEEDED after IAM-propagation retries (last status '${SM_STATUS}', cause: ${SM_LAST_CAUSE})" >&2
  exit 1
fi
echo "    OK: edge 2 - SFN execution SUCCEEDED on the fresh SFN role (and invoked the Lambda)"

# Edge 3: confirm the rule exists and carries the SFN target with a role.
TARGET_COUNT=$(aws events list-targets-by-rule \
  --rule "${RULE_NAME}" --region "${REGION}" \
  --query 'length(Targets)' --output text 2>/dev/null)
if [ -z "${TARGET_COUNT}" ] || [ "${TARGET_COUNT}" = "None" ] || [ "${TARGET_COUNT}" -lt 1 ]; then
  echo "FAIL: EventBridge rule ${RULE_NAME} has no targets (PutTargets may have failed on the fresh role)" >&2
  exit 1
fi
TARGET_ROLE=$(aws events list-targets-by-rule \
  --rule "${RULE_NAME}" --region "${REGION}" \
  --query 'Targets[0].RoleArn' --output text 2>/dev/null)
if [ -z "${TARGET_ROLE}" ] || [ "${TARGET_ROLE}" = "None" ]; then
  echo "FAIL: EventBridge rule target has no RoleArn (the fresh target role was not wired)" >&2
  exit 1
fi
echo "    OK: edge 3 - EventBridge rule has an SFN target bound to a fresh role (${TARGET_ROLE})"

# Edge 4: confirm the SQS QueuePolicy + SNS TopicPolicy were accepted (the
# fresh publisher-role principal did not bounce). A non-empty policy attribute
# proves the resource-policy PUT succeeded.
Q_POLICY=$(aws sqs get-queue-attributes \
  --queue-url "${QUEUE_URL}" --attribute-names Policy --region "${REGION}" \
  --query 'Attributes.Policy' --output text 2>/dev/null)
if [ -z "${Q_POLICY}" ] || [ "${Q_POLICY}" = "None" ]; then
  echo "FAIL: SQS queue has no resource policy (QueuePolicy with the fresh principal may have failed)" >&2
  exit 1
fi
T_POLICY=$(aws sns get-topic-attributes \
  --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query 'Attributes.Policy' --output text 2>/dev/null)
if [ -z "${T_POLICY}" ] || [ "${T_POLICY}" = "None" ]; then
  echo "FAIL: SNS topic has no resource policy (TopicPolicy with the fresh principal may have failed)" >&2
  exit 1
fi
echo "    OK: edge 4 - SQS QueuePolicy + SNS TopicPolicy accepted the fresh principal"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Assert each NAMED resource is gone (state-empty alone can miss an orphan
# carrying no stack name - per feedback_protection_integ_must_instantiate_resource).
assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: Lambda function is gone"

# StepFunctions DeleteStateMachine is ASYNC: the state machine enters
# Status=DELETING and `describe-state-machine` keeps returning it for a short
# window before it is fully removed (StateMachineDoesNotExist). cdkd's destroy
# correctly issued the delete (0 errors); poll until AWS finishes the async
# teardown rather than asserting immediate NotFound (which races the API).
SM_GONE=""
for _ in $(seq 1 24); do
  SM_DESCRIBE_STATUS=$(aws stepfunctions describe-state-machine \
    --state-machine-arn "${SM_ARN}" --region "${REGION}" \
    --query 'status' --output text 2>/dev/null) || { SM_GONE="yes"; break; }
  # An ACTIVE status here means the delete never fired - a real failure; stop polling.
  if [ "${SM_DESCRIBE_STATUS}" != "DELETING" ]; then
    echo "FAIL: state machine ${SM_ARN} still ${SM_DESCRIBE_STATUS} after destroy (delete not issued)" >&2
    exit 1
  fi
  sleep 5
done
if [ "${SM_GONE}" != "yes" ]; then
  echo "FAIL: state machine ${SM_ARN} still exists (stuck in DELETING) after destroy" >&2
  exit 1
fi
echo "    OK: state machine is gone"

assert_gone "EventBridge rule ${RULE_NAME} still exists after destroy" aws events describe-rule --name "${RULE_NAME}" --region "${REGION}"
echo "    OK: EventBridge rule is gone"

assert_gone "SQS queue ${QUEUE_URL} still exists after destroy" aws sqs get-queue-attributes --queue-url "${QUEUE_URL}" --region "${REGION}"
echo "    OK: SQS queue is gone"

assert_gone "SNS topic ${TOPIC_ARN} still exists after destroy" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: SNS topic is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> iam-propagation-stress test passed (4 fresh-role race edges deployed cleanly + all role consumers work + clean destroy)"
echo "[verify] PASS"
