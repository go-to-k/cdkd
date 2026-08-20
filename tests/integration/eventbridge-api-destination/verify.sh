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

# Shared S3 VERSION-sweep helpers (issue #2096). The fixture stack declares the
# Connection's API key with `unsafePlainText`, so that value lands in the
# Connection's own state properties. The state bucket is VERSIONED, so
# `aws s3 rm` only writes a delete marker -- measured 2026-08-20, 15 of 18
# surviving versions of this stack's state.json carried `cdkd-integ-api-key`.
. ../s3-versions.sh

STACK="CdkdEventbridgeApiDestinationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
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
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Rule must lose its targets before it can be deleted.
  aws events remove-targets --rule "${RULE}" --ids Target0 --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-rule --name "${RULE}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-api-destination --name "${DEST}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-connection --name "${CONN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # The `aws s3 rm` above only wrote DELETE MARKERS. NONCURRENT-only here:
    # this also runs from the pre-run sweep and the failure traps, where a live
    # state.json may be the only record of resources still standing.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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

assert_gone "ApiDestination ${DEST} still exists after destroy" aws events describe-api-destination --name "${DEST}" --region "${REGION}"
assert_gone "Connection ${CONN} still exists after destroy" aws events describe-connection --name "${CONN}" --region "${REGION}"
assert_gone "Rule ${RULE} still exists after destroy" aws events describe-rule --name "${RULE}" --region "${REGION}"
echo "    Connection / ApiDestination / Rule deleted"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# head-object only looks at the CURRENT object; the bucket is VERSIONED, so the
# templated API key survives in prior versions without this (issue #2096). On
# the success path, not only in `cleanup`, and asserted rather than assumed.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "eventbridge-api-destination state teardown"

echo "[verify] PASS — Connection Arn / ApiDestination Arn GetAtt enrichment works end-to-end, 2 phases passed"
