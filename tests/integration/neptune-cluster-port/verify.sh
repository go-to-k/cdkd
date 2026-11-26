#!/usr/bin/env bash
# verify.sh — cdkd Neptune DBCluster in-place DBPort change (issue #7006).
#
# A changed DBPort applies after ModifyDBCluster returns, so an update that
# recorded the cluster from the read right after the call kept the OLD `Port`,
# and a reader re-resolved after the update (here an SSM parameter holding
# `Fn::GetAtt [Cluster, Port]`) kept it too.
#
# Phase 1 deploys one Neptune cluster (no instance) on port 8182 and asserts
# the reader, the output and the record against DescribeDBClusters. Phase 2
# changes DBPort to 8183 in place, asserts the premise (the live port moved and
# the cluster was not replaced), then the same three against the live port.
# Phase 3 destroys and asserts everything is gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Runtime: ~15 min expected (a Neptune cluster create, a port change, a delete).

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

STACK="CdkdNeptuneClusterPortExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_ID="cdkdneptuneclusterportexample-cluster"
PORT_PARAM="/${STACK}/cluster-port"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws neptune delete-db-cluster --region "${REGION}" --db-cluster-identifier "${CLUSTER_ID}" \
    --skip-final-snapshot >/dev/null 2>&1 || true
  aws ssm delete-parameter --region "${REGION}" --name "${PORT_PARAM}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

expect_eq() { # usage: expect_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }

live_cluster() {
  aws neptune describe-db-clusters --region "${REGION}" --db-cluster-identifier "${CLUSTER_ID}" \
    --query 'DBClusters[0]' --output json
}

# The reader, the output and the record against the live port.
assert_port() { # usage: assert_port <phase> <port>
  local state live_port
  state="$(state_json)" || return 1
  live_port="$(live_cluster | jq -r '.Port')" || return 1
  expect_eq "$1: live DescribeDBClusters Port" "${live_port}" "$2"
  expect_eq "$1: port reader (SSM ${PORT_PARAM})" \
    "$(aws ssm get-parameter --region "${REGION}" --name "${PORT_PARAM}" --query 'Parameter.Value' --output text)" "${live_port}"
  expect_eq "$1: ClusterPort output" "$(jq -r '.outputs.ClusterPort // empty' <<<"${state}")" "${live_port}"
  expect_eq "$1: recorded Port" \
    "$(jq -r '[.resources[] | select(.resourceType == "AWS::Neptune::DBCluster") | .attributes.Port // empty] | first // empty' <<<"${state}")" "${live_port}"
}

echo "==> Phase 1: deploy on port 8182"
CDKD_TEST_DB_PORT=8182 node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The fix is on the SDK provider's path; a Cloud Control record would pass
# without exercising it.
ROUTE="$(state_json | jq -r '[.resources[] | select(.resourceType == "AWS::Neptune::DBCluster") | .provisionedBy // "sdk"] | first // empty')"
if [ "${ROUTE}" = "cc-api" ] || [ -z "${ROUTE}" ]; then
  echo "FAIL: the Neptune cluster was provisioned by '${ROUTE:-<none>}', not the SDK provider" >&2
  exit 1
fi
echo "    OK: Neptune cluster provisioned by the SDK provider (${ROUTE})"
RESOURCE_ID="$(live_cluster | jq -r '.DbClusterResourceId')"
assert_port "phase 1" 8182

echo "==> Phase 2: change DBPort to 8183 in place (issue #7006)"
CDKD_TEST_DB_PORT=8183 node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# Premise: the port really moved, and on the same cluster. A replacement
# records a fresh cluster and would pass the checks below without the fix.
LIVE="$(live_cluster)"
if [ "$(jq -r '.Port' <<<"${LIVE}")" = "8182" ]; then
  echo "FAIL: premise: the live cluster port is still 8182 after the DBPort change" >&2
  exit 1
fi
expect_eq "phase 2: DbClusterResourceId kept (no replacement)" "$(jq -r '.DbClusterResourceId' <<<"${LIVE}")" "${RESOURCE_ID}"
# Compare the record with the port the cluster SETTLES on: wait until it is
# out of `modifying` (bounded), so a record taken mid-change cannot match a
# live read taken mid-change too. The elapsed time is the measurement #7006
# lacked for Neptune.
SETTLE_START="$(date +%s)"
for _ in $(seq 1 60); do
  STATUS="$(live_cluster | jq -r '.Status')"
  [ "${STATUS}" != "modifying" ] && break
  sleep 10
done
if [ "${STATUS}" = "modifying" ]; then
  echo "FAIL: phase 2: the cluster was still modifying 10 minutes after the DBPort change" >&2
  exit 1
fi
echo "    OK: cluster ${STATUS} $(( $(date +%s) - SETTLE_START ))s after the deploy returned"
assert_port "phase 2" 8183

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "Neptune cluster ${CLUSTER_ID} still exists after destroy" aws neptune describe-db-clusters --region "${REGION}" --db-cluster-identifier "${CLUSTER_ID}"
assert_gone "SSM parameter ${PORT_PARAM} still exists after destroy" aws ssm get-parameter --region "${REGION}" --name "${PORT_PARAM}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: cluster, SSM parameter and state gone"

echo ""
echo "[verify] PASS — neptune-cluster-port: after an in-place DBPort change the SSM reader, the output and the recorded Port equal DescribeDBClusters"
