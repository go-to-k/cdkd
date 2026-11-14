#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt CloudTrail SnsTopicArn and AppSync
# GraphQLEndpointArn / RealtimeUrl (issue #6242).
#
# Measured against CloudFormation: SnsTopicArn is the notified topic's ARN (cdkd
# served the trail's own ARN), and the AppSync two are built on the endpoint id
# of the API's GraphQL host (cdkd refused them). Asserts each against AWS, then
# an UPDATE that moves the trail to a second topic, then destroys clean.

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

STACK="CdkdGetattCloudtrailAppsyncExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TRAIL="${STACK}-trail"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp)"

# Lambda auto-creates a log group for the S3 auto-delete custom resource, which
# neither CloudFormation nor cdkd deletes. Swept by this fixture's own prefix.
sweep_log_groups() { (
  set +eu
  case "${STACK}" in
    CdkdGetattCloudtrailAppsync?*) ;;
    *) echo "WARN: teardown sweep refused -- '${STACK}' is outside this fixture's scope" >&2; exit 0 ;;
  esac
  for g in $(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "/aws/lambda/${STACK}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --region "${REGION}" --log-group-name "${g}" >/dev/null 2>&1 || true
  done
) }

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${DEPLOY_LOG}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws cloudtrail delete-trail --region "${REGION}" --name "${TRAIL}" >/dev/null 2>&1 || true
  sweep_log_groups
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
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

deploy() { # usage: deploy <phase label> [env...]
  "$@" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
  if grep -E 'Failed to resolve output|Unknown attribute (SnsTopicArn|GraphQLEndpointArn|RealtimeUrl)' "${DEPLOY_LOG}"; then
    echo "FAIL: an output did not resolve, or a physical-id fallback warning was printed (see above)" >&2
    exit 1
  fi
}

assert_trail_topic() { # usage: assert_trail_topic <expected topic name>
  local live
  live="$(aws cloudtrail get-trail --region "${REGION}" --name "${TRAIL}" --query 'Trail.SnsTopicARN' --output text)" || return 1
  case "${live}" in *":$1") ;; *) echo "FAIL: live trail topic '${live}' is not $1" >&2; exit 1 ;; esac
  expect_eq "TrailSnsTopicArn output" "$(output_of TrailSnsTopicArn)" "${live}"
}

echo "==> Phase 1: deploy"
deploy env -u CDKD_TEST_UPDATE
assert_trail_topic "${STACK}-a"

API_ID="$(output_of ApiId)"
API_JSON="$(aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}" --output json)"
ENDPOINT_ID="$(jq -r '.graphqlApi.dns.GRAPHQL' <<<"${API_JSON}" | cut -d. -f1)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
PARTITION="$(aws sts get-caller-identity --query Arn --output text | cut -d: -f2)"
expect_eq "GraphQLEndpointArn output" "$(output_of GraphQLEndpointArn)" "arn:${PARTITION}:appsync:${REGION}:${ACCOUNT}:endpoints/graphql-api/${ENDPOINT_ID}"
expect_eq "RealtimeUrl output" "$(output_of RealtimeUrl)" "$(jq -r '.graphqlApi.uris.REALTIME' <<<"${API_JSON}")"

echo "==> Phase 2: UPDATE the trail's topic"
deploy env CDKD_TEST_UPDATE=true
assert_trail_topic "${STACK}-b"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "trail ${TRAIL} still exists after destroy" aws cloudtrail get-trail --region "${REGION}" --name "${TRAIL}"
assert_gone "GraphQL API ${API_ID} still exists after destroy" aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}"
for t in a b; do
  assert_gone "topic ${STACK}-${t} still exists after destroy" aws sns get-topic-attributes --region "${REGION}" --topic-arn "arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${STACK}-${t}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
sweep_log_groups
LEFT="$(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "/aws/lambda/${STACK}" --query 'length(logGroups)' --output text)"
[ "${LEFT}" = "0" ] || { echo "FAIL: ${LEFT} /aws/lambda/${STACK}* log group(s) remain" >&2; exit 1; }
echo "    OK: trail, API, topic, log groups and state gone"

echo ""
echo "[verify] PASS — getatt-cloudtrail-appsync: SnsTopicArn follows the trail's topic across an update; GraphQLEndpointArn and RealtimeUrl match AWS"
