#!/usr/bin/env bash
# verify.sh — cdkd deep GetAtt-chain resolution integ test.
#
# Failure-seeking: a 5-deep chain where each resource's POST-CREATE
# attribute (an ARN / generated name only known after the AWS create call)
# feeds the NEXT resource's property. Types are MIXED so some links route
# through the SDK provider and one through Cloud Control API, and a wrong /
# late attribute resolution on EITHER path is pinpointed by the failing
# assertion.
#
# Chain topology (each arrow = "left's post-create attribute feeds right"):
#   A  SNS::Topic                 (SDK)    --TopicArn-->  B.AlarmActions[0]
#   B  CloudWatch::Alarm          (SDK)    --Name(Ref)-->  C.AlarmRule
#   C  CloudWatch::CompositeAlarm  (CC-API) --Arn-->       D.Value + E.env
#   D  SSM::Parameter             (SDK)    --Name(Ref)-->  E.env
#   E  Lambda::Function           (SDK)    -- terminal multi-attr Fn::Sub consumer
#
# Per-link AWS-side assertions (a mismatch = FAIL naming the broken link):
#   Link A->B : alarm B's AlarmActions on AWS == topic A's real TopicArn.
#   Link B->C : composite C's AlarmRule on AWS contains alarm B's real name.
#   Link C->D : SSM param D's Value on AWS == "composite=<C.Arn>;alarm=<B.Arn>"
#               using C's + B's REAL ARNs read back from AWS (the CC-API link).
#   Link C/A/D->E : Lambda E's env on AWS resolves UPSTREAM_TOPIC_ARN /
#               UPSTREAM_COMPOSITE_ARN / UPSTREAM_PARAM_NAME / UPSTREAM_JOINED
#               to the REAL upstream attributes (terminal multi-attr Fn::Sub).
#
# Then destroys and asserts every named resource is gone (by its OWN
# `cdkd:integ-fixture` tag or state-resolved id — never `aws:cdk:path`).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId}); auto-derived if unset.
#   AWS_REGION   — defaults to us-east-1.
#
# BSD-portable (no `grep -P`, no `date -d`). Real rc capture via PIPESTATUS.
# Run via: /run-integ deep-getatt-chains
#      or: bash tests/integration/deep-getatt-chains/verify.sh

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="CdkdDeepGetAttChainsExample"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

TOPIC_NAME="cdkd-getatt-chain-topic"
ALARM_NAME="cdkd-getatt-chain-alarm"
COMPOSITE_ALARM_NAME="cdkd-getatt-chain-composite"
PARAM_NAME="/cdkd/getatt-chain/composite-and-alarm-arns"
FUNCTION_NAME="cdkd-getatt-chain-fn"
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="deep-getatt-chains"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

fail() {
  echo "[verify] FAIL: $*" >&2
  exit 1
}

cleanup() {
  echo "==> Cleanup (errors during this block are tolerated)"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ ! -f "${LOCAL_DIST}" ]; then
  fail "local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first"
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --------------------------------------------------------------------
# Phase 1: deploy. On failure, surface the failing resource + error.
# --------------------------------------------------------------------
echo ""
echo "==> Phase 1: deploy"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee /tmp/cdkd-getatt-chain-deploy.log
DEPLOY_RC=${PIPESTATUS[0]}
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "[verify] deploy failed (rc=${DEPLOY_RC}); failing resource + error:" >&2
  grep -iE 'fail|error|✗|rollback' /tmp/cdkd-getatt-chain-deploy.log | tail -20 >&2 || true
  fail "deploy did not complete cleanly"
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || true)
if [ -z "${STATE}" ]; then
  fail "no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy"
fi

# --------------------------------------------------------------------
# Read the REAL upstream attributes back from AWS (ground truth).
# --------------------------------------------------------------------
echo ""
echo "==> Reading real upstream attributes from AWS"

# A: topic ARN (the SNS topic physical id IS its ARN).
REAL_TOPIC_ARN=$(aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
  --output text)
[ -n "${REAL_TOPIC_ARN}" ] && [ "${REAL_TOPIC_ARN}" != "None" ] \
  || fail "could not resolve real TopicArn for ${TOPIC_NAME}"
echo "    A SNS TopicArn        = ${REAL_TOPIC_ARN}"

# B: alarm ARN + name.
REAL_ALARM_ARN=$(aws cloudwatch describe-alarms --region "${REGION}" \
  --alarm-names "${ALARM_NAME}" --alarm-types MetricAlarm \
  --query 'MetricAlarms[0].AlarmArn' --output text)
[ -n "${REAL_ALARM_ARN}" ] && [ "${REAL_ALARM_ARN}" != "None" ] \
  || fail "could not resolve real AlarmArn for ${ALARM_NAME}"
echo "    B Alarm Arn           = ${REAL_ALARM_ARN}"

# C: composite-alarm ARN (CC-API post-create attribute — the critical link).
REAL_COMPOSITE_ARN=$(aws cloudwatch describe-alarms --region "${REGION}" \
  --alarm-names "${COMPOSITE_ALARM_NAME}" --alarm-types CompositeAlarm \
  --query 'CompositeAlarms[0].AlarmArn' --output text)
[ -n "${REAL_COMPOSITE_ARN}" ] && [ "${REAL_COMPOSITE_ARN}" != "None" ] \
  || fail "could not resolve real CompositeAlarm Arn for ${COMPOSITE_ALARM_NAME} (CC-API link)"
echo "    C Composite Arn       = ${REAL_COMPOSITE_ARN}"

# --------------------------------------------------------------------
# Link A -> B : alarm B's AlarmActions on AWS == topic A's real TopicArn.
# --------------------------------------------------------------------
echo ""
echo "==> Link A->B (SDK->SDK): SNS TopicArn must reach alarm B's AlarmActions"
B_ACTION=$(aws cloudwatch describe-alarms --region "${REGION}" \
  --alarm-names "${ALARM_NAME}" --alarm-types MetricAlarm \
  --query 'MetricAlarms[0].AlarmActions[0]' --output text)
if [ "${B_ACTION}" != "${REAL_TOPIC_ARN}" ]; then
  fail "link A->B broken: alarm AlarmActions[0] is '${B_ACTION}', expected real TopicArn '${REAL_TOPIC_ARN}' (Fn::GetAtt[Topic,TopicArn] mis-resolved)"
fi
echo "    OK: alarm AlarmActions[0] == real SNS TopicArn"

# --------------------------------------------------------------------
# Link B -> C : composite C's AlarmRule on AWS references alarm B's name.
# --------------------------------------------------------------------
echo ""
echo "==> Link B->C (SDK->CC-API): alarm B's name must reach composite C's AlarmRule"
C_RULE=$(aws cloudwatch describe-alarms --region "${REGION}" \
  --alarm-names "${COMPOSITE_ALARM_NAME}" --alarm-types CompositeAlarm \
  --query 'CompositeAlarms[0].AlarmRule' --output text)
# AWS canonicalizes AlarmRule to reference the alarm by ARN; the alarm name
# is the last path segment of that ARN. Assert the rule names alarm B either
# by bare name or by its ARN.
case "${C_RULE}" in
  *"${ALARM_NAME}"*) ;;
  *) fail "link B->C broken: composite AlarmRule '${C_RULE}' does not reference alarm '${ALARM_NAME}' (Fn::Sub[Ref ChainAlarm] mis-resolved)" ;;
esac
echo "    OK: composite AlarmRule references alarm B's name"

# --------------------------------------------------------------------
# Link C -> D : SSM param D's Value on AWS == joined real C.Arn + B.Arn.
# This is the critical CC-API attribute -> SDK-resource property hop.
# --------------------------------------------------------------------
echo ""
echo "==> Link C->D (CC-API->SDK): composite C.Arn + alarm B.Arn must reach SSM param D's Value"
EXPECTED_PARAM_VALUE="composite=${REAL_COMPOSITE_ARN};alarm=${REAL_ALARM_ARN}"
REAL_PARAM_VALUE=$(aws ssm get-parameter --region "${REGION}" \
  --name "${PARAM_NAME}" --query 'Parameter.Value' --output text)
if [ "${REAL_PARAM_VALUE}" != "${EXPECTED_PARAM_VALUE}" ]; then
  fail "link C->D broken: SSM param Value is '${REAL_PARAM_VALUE}', expected '${EXPECTED_PARAM_VALUE}' (Fn::GetAtt[CompositeAlarm,Arn] CC-API attr mis-resolved)"
fi
echo "    OK: SSM param Value == joined real composite Arn + alarm Arn"

# --------------------------------------------------------------------
# Link {A,C,D} -> E : Lambda E's env on AWS resolves to the real upstream
# attributes (terminal multi-attribute Fn::Sub consumer).
# --------------------------------------------------------------------
echo ""
echo "==> Link {A,C,D}->E (terminal multi-attr): Lambda env must resolve every upstream attr"
ENV_JSON=$(aws lambda get-function-configuration --region "${REGION}" \
  --function-name "${FUNCTION_NAME}" --query 'Environment.Variables' --output json)

E_TOPIC=$(echo "${ENV_JSON}" | jq -r '.UPSTREAM_TOPIC_ARN // empty')
[ "${E_TOPIC}" = "${REAL_TOPIC_ARN}" ] \
  || fail "link A->E broken: Lambda UPSTREAM_TOPIC_ARN is '${E_TOPIC}', expected '${REAL_TOPIC_ARN}'"

E_COMPOSITE=$(echo "${ENV_JSON}" | jq -r '.UPSTREAM_COMPOSITE_ARN // empty')
[ "${E_COMPOSITE}" = "${REAL_COMPOSITE_ARN}" ] \
  || fail "link C->E broken: Lambda UPSTREAM_COMPOSITE_ARN is '${E_COMPOSITE}', expected '${REAL_COMPOSITE_ARN}' (CC-API attr mis-resolved)"

E_PARAM=$(echo "${ENV_JSON}" | jq -r '.UPSTREAM_PARAM_NAME // empty')
[ "${E_PARAM}" = "${PARAM_NAME}" ] \
  || fail "link D->E broken: Lambda UPSTREAM_PARAM_NAME is '${E_PARAM}', expected '${PARAM_NAME}'"

E_JOINED=$(echo "${ENV_JSON}" | jq -r '.UPSTREAM_JOINED // empty')
EXPECTED_JOINED="topic=${REAL_TOPIC_ARN}|composite=${REAL_COMPOSITE_ARN}|param=${PARAM_NAME}"
[ "${E_JOINED}" = "${EXPECTED_JOINED}" ] \
  || fail "link {A,C,D}->E broken: Lambda UPSTREAM_JOINED is '${E_JOINED}', expected '${EXPECTED_JOINED}' (multi-attr Fn::Sub mis-resolved)"

echo "    OK: Lambda env resolves topic + composite + param + joined to real upstream attrs"

# --------------------------------------------------------------------
# Phase 2: destroy + assert every named resource is gone by OWN tag /
# state-resolved id (NOT aws:cdk:path).
# --------------------------------------------------------------------
echo ""
echo "==> Phase 2: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1 | tee /tmp/cdkd-getatt-chain-destroy.log
DESTROY_RC=${PIPESTATUS[0]}
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "[verify] destroy failed (rc=${DESTROY_RC}); tail:" >&2
  tail -20 /tmp/cdkd-getatt-chain-destroy.log >&2 || true
  fail "destroy did not complete cleanly"
fi

echo ""
echo "==> Post-destroy: assert named resources are gone"

# E: Lambda function gone.
assert_gone "Lambda ${FUNCTION_NAME} still exists after destroy" aws lambda get-function-configuration --region "${REGION}" --function-name "${FUNCTION_NAME}"
echo "    OK: Lambda E is gone"

# D: SSM parameter gone.
assert_gone "SSM parameter ${PARAM_NAME} still exists after destroy" aws ssm get-parameter --region "${REGION}" --name "${PARAM_NAME}"
echo "    OK: SSM param D is gone"

# C: composite alarm gone (and confirm it carried our OWN fixture tag while alive).
C_LEFT=$(aws cloudwatch describe-alarms --region "${REGION}" \
  --alarm-names "${COMPOSITE_ALARM_NAME}" --alarm-types CompositeAlarm \
  --query 'CompositeAlarms[0].AlarmArn' --output text 2>/dev/null || true)
if [ -n "${C_LEFT}" ] && [ "${C_LEFT}" != "None" ]; then
  fail "CompositeAlarm ${COMPOSITE_ALARM_NAME} still exists after destroy"
fi
echo "    OK: composite alarm C is gone"

# B: metric alarm gone.
B_LEFT=$(aws cloudwatch describe-alarms --region "${REGION}" \
  --alarm-names "${ALARM_NAME}" --alarm-types MetricAlarm \
  --query 'MetricAlarms[0].AlarmArn' --output text 2>/dev/null || true)
if [ -n "${B_LEFT}" ] && [ "${B_LEFT}" != "None" ]; then
  fail "Alarm ${ALARM_NAME} still exists after destroy"
fi
echo "    OK: alarm B is gone"

# A: SNS topic gone.
A_LEFT=$(aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
  --output text)
if [ -n "${A_LEFT}" ] && [ "${A_LEFT}" != "None" ]; then
  fail "SNS topic ${TOPIC_NAME} still exists after destroy"
fi
echo "    OK: SNS topic A is gone"

# State file gone.
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS: deep GetAtt chain resolved correctly across all SDK + CC-API links, and destroy was clean"
