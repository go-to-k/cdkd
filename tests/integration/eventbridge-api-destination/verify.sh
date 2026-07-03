#!/usr/bin/env bash
# verify.sh — cdkd EventBridge Connection Arn GetAtt enrichment integ.
#
# Regression coverage for the bug where `AWS::Events::Connection` (CC-API
# provisioned, primaryIdentifier=Name) had its readOnly `Arn` attribute fall
# through cdkd's intrinsic resolver to the physicalId (the connection NAME).
# An `AWS::Events::ApiDestination` whose `ConnectionArn` is
# `Fn::GetAtt(Connection, 'Arn')` then received the bare name, and its CREATE
# failed CC model validation (`#/ConnectionArn: failed validation constraint
# for keyword [pattern]`) — the whole webhook pattern was unusable.
#
# Phases:
#   1. Deploy Connection + ApiDestination + Rule(ApiDestination target). The
#      deploy SUCCEEDING is the core proof (the ApiDestination CREATE no longer
#      fails). Additionally assert the resolved ConnectionArn reaching AWS is a
#      real connection ARN, not the bare name.
#   2. Destroy + assert the resources are gone and the cdkd state file removed.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEventbridgeApiDestinationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CONN="cdkdeventbridgeapidestinationexample-conn"
DEST="cdkdeventbridgeapidestinationexample-dest"
RULE="cdkdeventbridgeapidestinationexample-rule"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Rule must lose its targets before it can be deleted.
  aws events remove-targets --rule "${RULE}" --ids Target0 --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-rule --name "${RULE}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-api-destination --name "${DEST}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-connection --name "${CONN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy Connection + ApiDestination + Rule"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The ApiDestination CREATE succeeding already proves the Connection Arn was
# enriched; additionally assert the ConnectionArn reaching AWS is a real ARN.
DEST_CONN_ARN="$(aws events describe-api-destination --name "${DEST}" --region "${REGION}" \
  --query 'ConnectionArn' --output text)"
echo "    ApiDestination ConnectionArn: ${DEST_CONN_ARN}"
case "${DEST_CONN_ARN}" in
  arn:aws:events:*:connection/${CONN}/*) ;;
  *) echo "FAIL: ConnectionArn is not a real connection ARN (enrichment gap): '${DEST_CONN_ARN}'" >&2; exit 1 ;;
esac
echo "    ConnectionArn resolved to a real ARN (Connection Arn enrichment works)"

# The Rule target Arn is Fn::GetAtt(ApiDestination, 'Arn') — assert it resolved
# to the ApiDestination ARN, not the bare destination name.
RULE_TARGET_ARN="$(aws events list-targets-by-rule --rule "${RULE}" --region "${REGION}" \
  --query 'Targets[0].Arn' --output text)"
echo "    Rule target Arn: ${RULE_TARGET_ARN}"
case "${RULE_TARGET_ARN}" in
  arn:aws:events:*:api-destination/${DEST}/*) ;;
  *) echo "FAIL: Rule target Arn is not a real ApiDestination ARN (enrichment gap): '${RULE_TARGET_ARN}'" >&2; exit 1 ;;
esac
echo "    Rule target Arn resolved to a real ARN (ApiDestination Arn enrichment works)"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws events describe-api-destination --name "${DEST}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ApiDestination ${DEST} still exists after destroy" >&2; exit 1
fi
if aws events describe-connection --name "${CONN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Connection ${CONN} still exists after destroy" >&2; exit 1
fi
if aws events describe-rule --name "${RULE}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Rule ${RULE} still exists after destroy" >&2; exit 1
fi
echo "    Connection / ApiDestination / Rule deleted"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — Connection Arn / ApiDestination Arn GetAtt enrichment works end-to-end, 2 phases passed"
