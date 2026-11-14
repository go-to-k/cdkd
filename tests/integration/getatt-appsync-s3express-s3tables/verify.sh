#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt AppSync GraphQLDns / RealtimeDns,
# S3 Express AvailabilityZoneName, S3 Tables WarehouseLocation / VersionToken
# (issue #6242).
#
# Measured against CloudFormation, each resolved to the physical id. Asserts
# every output equals the value AWS reports, then destroys clean. No UPDATE
# phase: none of these changes on an in-place update cdkd can drive here.

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

STACK="CdkdGetattAppsyncS3expressS3tablesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${DEPLOY_LOG}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
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

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

expect_eq() { # usage: expect_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3' (physical-id fallback?)" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
if grep -E 'Unknown attribute (GraphQLDns|RealtimeDns|AvailabilityZoneName|WarehouseLocation|VersionToken)' "${DEPLOY_LOG}"; then
  echo "FAIL: a physical-id fallback warning was printed (see above)" >&2
  exit 1
fi

API_ID="$(output_of ApiId)"
[ -n "${API_ID}" ] || { echo "FAIL: ApiId output missing" >&2; exit 1; }
API_JSON="$(aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}" --output json)"
expect_eq "GraphQLDns output" "$(output_of GraphQLDns)" "$(jq -r '.graphqlApi.dns.GRAPHQL' <<<"${API_JSON}")"
expect_eq "RealtimeDns output" "$(output_of RealtimeDns)" "$(jq -r '.graphqlApi.dns.REALTIME' <<<"${API_JSON}")"

LIVE_AZ="$(aws ec2 describe-availability-zones --region "${REGION}" --zone-ids use1-az4 --query 'AvailabilityZones[0].ZoneName' --output text)"
expect_eq "DirectoryBucketAz output" "$(output_of DirectoryBucketAz)" "${LIVE_AZ}"

TABLE_JSON="$(aws s3tables get-table --region "${REGION}" --table-arn "$(output_of TableArn)" --output json)"
expect_eq "WarehouseLocation output" "$(output_of WarehouseLocation)" "$(jq -r '.warehouseLocation' <<<"${TABLE_JSON}")"
expect_eq "VersionToken output" "$(output_of VersionToken)" "$(jq -r '.versionToken' <<<"${TABLE_JSON}")"

DIR_BUCKET="$(output_of DirectoryBucket)"
TABLE_ARN="$(output_of TableArn)"
TABLE_BUCKET_ARN="${TABLE_ARN%%/table/*}"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "GraphQL API ${API_ID} still exists after destroy" aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}"
assert_gone "directory bucket ${DIR_BUCKET} still exists after destroy" aws s3api head-bucket --region "${REGION}" --bucket "${DIR_BUCKET}"
assert_gone "table bucket ${TABLE_BUCKET_ARN} still exists after destroy" aws s3tables get-table-bucket --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: API, directory bucket, table bucket and state gone"

echo ""
echo "[verify] PASS — getatt-appsync-s3express-s3tables: GraphQLDns, RealtimeDns, AvailabilityZoneName, WarehouseLocation and VersionToken match AWS"
