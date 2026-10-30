#!/usr/bin/env bash
# verify.sh — cdkd Lambda Web Function revision replacement integ
# (go-to-k/cdkd#4900).
#
# A code change replaces the AWS::Lambda::WebFunctionRevision. cdkd creates the
# new revision, then tries to delete the old one while the endpoint still
# routes to it, and AWS refuses (409 ConflictException). Before the fix the
# old revision was left in AWS, untracked; now the delete is retried once the
# endpoint has moved, so exactly one revision remains.
#
# The code object lives in a versioned bucket this script owns: a new object
# version changes the revision's create-only BuildConfig.
#
# go-to-k/cdkd#4926 adds SDK providers for the revision and the endpoint. The
# previous release (Cloud Control for both) deploys v1, so the records start
# pinned to cc-api; this build's v2 deploy must move both to the SDK route
# (the 'sdk-coverage' sticky exemption), and v3 runs SDK to SDK.
#
# go-to-k/cdkd#4978: a PerRegion endpoint's `Fn::GetAtt
# RegionalEndpoints.<region>.DomainName` feeds an SSM parameter. The SDK
# provider of 0.300.x did not record it and served the endpoint ARN; this build
# records it on create / update, and heals a record 0.300.x created without it.
# go-to-k/cdkd#4992 does the same for a path through an object-valued member
# (`RegionalEndpoints.<region>.ScalingConfig.MaxEnvironments`, into a second
# parameter), and records the whole map (`attrRegionalEndpoints`), which is
# compared with what AWS reports.
#
# Both released binaries run before this build's first deploy (phase 1c): this build
# writes state schema v13 (go-to-k/cdkd#5064), which no earlier release reads.
# Phases 3 and 3b replace the revision three more times on the SDK route, each
# leaving exactly one revision behind the same two endpoints.

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

STACK="CdkdLambdaWebFunctionRevisionReplaceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-integ-webfn-replace"
ROLE_NAME="cdkd-integ-webfn-${REGION}"
CODE_KEY="app.zip"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CODE_BUCKET="cdkd-integ-webfn-code-${ACCOUNT}-${REGION}"
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:web-function/${FN_NAME}"
FN_MODEL="{\"FunctionName\":\"${FN_NAME}\"}"
WORK="$(mktemp -d)"
OLD_CDKD_VERSION="${OLD_CDKD_VERSION:-0.299.7}"
# The last release whose SDK endpoint provider lacks the #4978 attributes.
PREFIX_CDKD_VERSION="${PREFIX_CDKD_VERSION:-0.300.2}"
OLD_TMPDIR=""
PREFIX_TMPDIR=""
# The PerRegion endpoint's second region; the stack reads the same variable.
case "${REGION}" in
  us-west-2) SECONDARY_REGION="us-east-2" ;;
  *) SECONDARY_REGION="us-west-2" ;;
esac
export SECONDARY_REGION
PARAM_NAME="/cdkd-integ/webfn-replace/regional-domain"
MAX_ENVS_PARAM="/cdkd-integ/webfn-replace/regional-max-environments"
# Phase 3b renames the PerRegion endpoint; the stack reads the same variable.
export REGIONAL_ENDPOINT_NAME="regional"

# Identifiers of every resource of a type under the web function.
cc_ids() { # usage: cc_ids <type>
  aws cloudcontrol list-resources --type-name "$1" --resource-model "${FN_MODEL}" \
    --region "${REGION}" --query 'ResourceDescriptions[].Identifier' --output text
}

# Best-effort Cloud Control delete that waits for the request to settle.
cc_delete() { ( # usage: cc_delete <type> <identifier>
  set +eu
  token="$(aws cloudcontrol delete-resource --type-name "$1" --identifier "$2" --region "${REGION}" \
    --query 'ProgressEvent.RequestToken' --output text 2>/dev/null)"
  [ -n "${token}" ] || exit 0
  for _ in $(seq 1 60); do
    status="$(aws cloudcontrol get-resource-request-status --request-token "${token}" \
      --region "${REGION}" --query 'ProgressEvent.OperationStatus' --output text 2>/dev/null)"
    case "${status}" in SUCCESS | FAILED | CANCEL_COMPLETE) exit 0 ;; esac
    sleep 5
  done
) }

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  for id in $(cc_ids AWS::Lambda::WebFunctionEndpoint 2>/dev/null); do
    cc_delete AWS::Lambda::WebFunctionEndpoint "${id}"
  done
  for id in $(cc_ids AWS::Lambda::WebFunctionRevision 2>/dev/null); do
    cc_delete AWS::Lambda::WebFunctionRevision "${id}"
  done
  cc_delete AWS::Lambda::WebFunction "${FN_ARN}"
  for p in "${PARAM_NAME}" "${MAX_ENVS_PARAM}"; do
    aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1
  done
  aws iam detach-role-policy --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  case "${FN_NAME}" in
    cdkd-integ-webfn?*)
      for r in "${REGION}" "${SECONDARY_REGION}"; do
        for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${FN_NAME}" \
          --region "${r}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
          aws logs delete-log-group --log-group-name "${lg}" --region "${r}" >/dev/null 2>&1
        done
      done
      ;;
    *) echo "WARN: teardown sweep refused: FN_NAME '${FN_NAME}' is outside cdkd-integ-webfn?*" >&2 ;;
  esac
  for v in $(aws s3api list-object-versions --bucket "${CODE_BUCKET}" \
    --query '[Versions[].VersionId, DeleteMarkers[].VersionId][]' --output text 2>/dev/null); do
    [ "${v}" = "None" ] && continue
    aws s3api delete-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" --version-id "${v}" >/dev/null 2>&1
  done
  aws s3api delete-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  rm -rf "${WORK}"
  for d in "${OLD_TMPDIR:-}" "${PREFIX_TMPDIR:-}"; do
    if [ -n "${d}" ] && [ -d "${d}" ]; then
      rm -rf "${d}"
    fi
  done
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
WORK="$(mktemp -d)"

echo "==> Code bucket ${CODE_BUCKET}"
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "${CODE_BUCKET}" --versioning-configuration Status=Enabled
aws s3api put-bucket-policy --bucket "${CODE_BUCKET}" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": {\"Service\": \"lambda.amazonaws.com\"},
    \"Action\": [\"s3:GetObject\", \"s3:GetObjectVersion\"],
    \"Resource\": \"arn:aws:s3:::${CODE_BUCKET}/*\",
    \"Condition\": {\"ArnLike\": {\"aws:SourceArn\": \"${FN_ARN}/revision/*\"}}
  }]
}"

# Uploads an app answering <marker> and prints the new object version id.
upload_code() { # usage: upload_code <marker>
  mkdir -p "${WORK}/$1"
  cat >"${WORK}/$1/index.js" <<EOF
const http = require('node:http');
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '0.0.0.0:3000').split(':');
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('$1\n');
  })
  .listen(Number(port), host);
EOF
  (cd "${WORK}/$1" && zip -q "${WORK}/$1.zip" index.js)
  aws s3api put-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" --body "${WORK}/$1.zip" \
    --region "${REGION}" --query VersionId --output text
}

deploy() { # usage: deploy <version-id> [cli.js]
  ENDPOINT_NAME="${ENDPOINT_NAME:-prod}" CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="$1" \
    node "${2:-${LOCAL_DIST}}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1
}

# A field of a resource's state record.
record() { # usage: record <logical-id> <jq-expression-over-the-resource-object>
  local json
  json="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${json}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

assert_route() { # usage: assert_route <phase> <provisionedBy>
  local id got
  for id in Revision Endpoint RegionalEndpoint; do
    got="$(record "${id}" '.provisionedBy')" || return 1
    if [ "${got}" != "$2" ]; then
      echo "FAIL: after $1, ${id} is recorded provisionedBy=${got}, expected $2" >&2
      exit 1
    fi
  done
  echo "    OK: Revision, Endpoint and RegionalEndpoint recorded provisionedBy=$2 after $1"
}

# A code change: the revision is replaced, its inline delete is refused while
# the endpoint routes to it, and the retry deletes it once the endpoint moved.
assert_replaced() { # usage: assert_replaced <phase> <deploy-output> <old-revision>
  local out
  # The summary lines carry ANSI colors between the words the checks match.
  out="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"$2")"
  if ! grep -q 'Revision (AWS::Lambda::WebFunctionRevision) replaced' <<<"${out}"; then
    echo "FAIL: $1: the revision was not replaced -- the fixture no longer exercises #4900" >&2
    exit 1
  fi
  if grep -q 'Failed to delete old resource' <<<"${out}"; then
    echo "FAIL: $1: the old revision's delete failed for good (#4900)" >&2
    exit 1
  fi
  # Sentinel: the inline delete must have been refused and retried, or the
  # fixture passes without reaching the fix.
  if ! grep -q 'Could not delete old Revision' <<<"${out}"; then
    echo "FAIL: $1: the inline delete was not refused -- the retry path was not exercised" >&2
    exit 1
  fi
  if ! grep -q "Old Revision ($3) deleted" <<<"${out}"; then
    echo "FAIL: $1: no retry line deleting $3" >&2
    exit 1
  fi
}

# The endpoint answers with the marker of the revision it routes to.
assert_serves() { # usage: assert_serves <marker>
  local endpoint domain body=""
  endpoint="$(record Endpoint '.physicalId')" || return 1
  domain="$(aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionEndpoint \
    --identifier "${endpoint}" --region "${REGION}" --query 'ResourceDescription.Properties' \
    --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["DomainName"])')" || return 1
  for _ in $(seq 1 24); do
    body="$(curl -sS --max-time 10 "https://${domain}/" 2>&1 || true)"
    [ "${body}" = "$1" ] && break
    sleep 5
  done
  if [ "${body}" != "$1" ]; then
    echo "FAIL: https://${domain}/ answered '${body}', expected '$1'" >&2
    exit 1
  fi
  echo "    OK: endpoint serves $1"
}

# The SSM parameter holds what `Fn::GetAtt RegionalEndpoints.<secondary>.DomainName`
# resolved to; it must be the domain AWS reports for that region (#4978).
regional_read() { # usage: regional_read <member-path>; prints the secondary region's member AWS reports
  aws lambda-web get-web-function-endpoint --function-name "${FN_NAME}" --endpoint-name "${REGIONAL_ENDPOINT_NAME}" --region "${REGION}" \
    --query "regionalEndpoints.\"${SECONDARY_REGION}\".$1" --output text
}
regional_domain() { regional_read domainName; }
param_value() { # usage: param_value [name]
  aws ssm get-parameter --name "${1:-${PARAM_NAME}}" --region "${REGION}" --query Parameter.Value --output text
}
assert_regional_getatt() { # usage: assert_regional_getatt <phase>
  local want got
  want="$(regional_domain)" || return 1
  case "${want}" in
    "" | None | null | *:*)
      echo "FAIL: $1: AWS reports no usable ${SECONDARY_REGION} domain for the PerRegion endpoint: '${want}'" >&2
      exit 1
      ;;
  esac
  got="$(param_value)" || return 1
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: $1: Fn::GetAtt RegionalEndpoints.${SECONDARY_REGION}.DomainName resolved to '${got}', expected '${want}' (#4978)" >&2
    exit 1
  fi
  echo "    OK: $1: RegionalEndpoints.${SECONDARY_REGION}.DomainName resolved to ${got}"
  # go-to-k/cdkd#4992: a path through an object member, and the whole map.
  local max_want max_got map_domain map_max
  max_want="$(regional_read scalingConfig.maxEnvironments)" || return 1
  case "${max_want}" in
    "" | None | null)
      echo "FAIL: $1: AWS reports no ${SECONDARY_REGION} scalingConfig.maxEnvironments: '${max_want}'" >&2
      exit 1
      ;;
  esac
  max_got="$(param_value "${MAX_ENVS_PARAM}")" || return 1
  if [ "${max_got}" != "${max_want}" ]; then
    echo "FAIL: $1: Fn::GetAtt RegionalEndpoints.${SECONDARY_REGION}.ScalingConfig.MaxEnvironments resolved to '${max_got}', expected '${max_want}' (#4992)" >&2
    exit 1
  fi
  echo "    OK: $1: RegionalEndpoints.${SECONDARY_REGION}.ScalingConfig.MaxEnvironments resolved to ${max_got}"
  # The whole map (attrRegionalEndpoints) is served from the recorded object.
  map_domain="$(record RegionalEndpoint ".attributes.RegionalEndpoints[\"${SECONDARY_REGION}\"].DomainName")" || return 1
  map_max="$(record RegionalEndpoint ".attributes.RegionalEndpoints[\"${SECONDARY_REGION}\"].ScalingConfig.MaxEnvironments")" || return 1
  if [ "${map_domain}" != "${want}" ] || [ "${map_max}" != "${max_want}" ]; then
    echo "FAIL: $1: the recorded RegionalEndpoints map holds DomainName '${map_domain}' / MaxEnvironments '${map_max}', expected '${want}' / '${max_want}' (#4992)" >&2
    exit 1
  fi
  echo "    OK: $1: the recorded RegionalEndpoints map matches AWS"
}

assert_one_revision() { # usage: assert_one_revision <phase>
  local revisions count
  revisions="$(cc_ids AWS::Lambda::WebFunctionRevision)" || return 1
  count="$(wc -w <<<"${revisions}" | tr -d ' ')" || return 1
  if [ "${count}" != "1" ]; then
    echo "FAIL: ${count} revisions exist after $1 (expected 1): ${revisions}" >&2
    exit 1
  fi
  echo "    OK: exactly one revision after $1" >&2
  printf '%s\n' "${revisions}"
}

# Installs a release into <dir> and checks the binary reports that version.
install_release() { # usage: install_release <dir> <version>
  local bin reported
  (cd "$1" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@$2" >/dev/null) || return 1
  bin="$1/node_modules/@go-to-k/cdkd/dist/cli.js"
  if [ ! -f "${bin}" ]; then
    echo "FAIL: release $2 was not installed at ${bin}" >&2
    exit 1
  fi
  reported="$(node "${bin}" --version)" || return 1
  case "${reported}" in
    *"$2"*) ;;
    *)
      echo "FAIL: the installed binary reports '${reported}', not $2" >&2
      exit 1
      ;;
  esac
}

echo "==> Installing the previous releases (@go-to-k/cdkd@${OLD_CDKD_VERSION}, @${PREFIX_CDKD_VERSION})"
OLD_TMPDIR="$(mktemp -d)"
install_release "${OLD_TMPDIR}" "${OLD_CDKD_VERSION}"
OLD_BIN="${OLD_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
PREFIX_TMPDIR="$(mktemp -d)"
install_release "${PREFIX_TMPDIR}" "${PREFIX_CDKD_VERSION}"
PREFIX_BIN="${PREFIX_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"

# Every phase that runs a released binary comes FIRST: this build writes state
# schema v13 (go-to-k/cdkd#5064), which no earlier release reads.
echo "==> Phase 1: deploy v1 with the previous release (Cloud Control)"
V1="$(upload_code v1)"
OUT="$(deploy "${V1}" "${OLD_BIN}")" || { echo "${OUT}"; echo "FAIL: phase 1 deploy" >&2; exit 1; }
echo "${OUT}"
REV1="$(assert_one_revision 'phase 1' | tail -1)"
assert_route 'phase 1' cc-api
EP1="$(record Endpoint '.physicalId')"
REP1="$(record RegionalEndpoint '.physicalId')"
assert_serves v1
assert_regional_getatt 'phase 1'

echo "==> Phase 1b: rename the PerRegion endpoint with ${PREFIX_CDKD_VERSION} (a record created without the #4978 attributes)"
# A rename replaces the endpoint, so the release before the fix CREATES its
# record; an update would keep the attributes an earlier deploy recorded. The
# code is unchanged, so the revision and the other endpoint are not touched
# and stay on Cloud Control for phase 2's move.
export REGIONAL_ENDPOINT_NAME="regional2"
OUT="$(deploy "${V1}" "${PREFIX_BIN}")" || { echo "${OUT}"; echo "FAIL: phase 1b deploy" >&2; exit 1; }
echo "${OUT}"
REP1B="$(record RegionalEndpoint '.physicalId')"
case "${REP1B}" in
  */endpoint/regional2) ;;
  *) echo "FAIL: phase 1b: the PerRegion endpoint record is ${REP1B}, expected the renamed endpoint/regional2" >&2; exit 1 ;;
esac
assert_gone "old PerRegion endpoint ${REP1} still exists after the rename" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionEndpoint --identifier "${REP1}" --region "${REGION}"
for id in Revision Endpoint; do
  GOT="$(record "${id}" '.provisionedBy')"
  if [ "${GOT}" != "cc-api" ]; then
    echo "FAIL: phase 1b: ${id} is recorded provisionedBy=${GOT}; phase 2 would no longer exercise the cc-api -> sdk move" >&2
    exit 1
  fi
done
echo "    OK: Revision and Endpoint still recorded provisionedBy=cc-api"
echo "    (${PREFIX_CDKD_VERSION} recorded the renamed PerRegion endpoint provisionedBy=$(record RegionalEndpoint '.provisionedBy'))"
# Sentinel: the release before the fix serves the ARN, or phase 1c would pass
# without the record lacking the attribute it heals.
GOT="$(param_value)"
case "${GOT}" in
  arn:aws:lambda:*) echo "    OK: ${PREFIX_CDKD_VERSION} resolved the GetAtt to the endpoint ARN (the #4978 bug)" ;;
  *)
    echo "FAIL: phase 1b: ${PREFIX_CDKD_VERSION} resolved the GetAtt to '${GOT}', not the ARN -- phase 1c no longer exercises the heal" >&2
    exit 1
    ;;
esac
GOT="$(param_value "${MAX_ENVS_PARAM}")"
case "${GOT}" in
  arn:aws:lambda:*) echo "    OK: ${PREFIX_CDKD_VERSION} resolved the ScalingConfig.MaxEnvironments GetAtt to the endpoint ARN (the #4992 bug)" ;;
  *)
    echo "FAIL: phase 1b: ${PREFIX_CDKD_VERSION} resolved the ScalingConfig.MaxEnvironments GetAtt to '${GOT}', not the ARN -- phase 1c no longer exercises its heal" >&2
    exit 1
    ;;
esac
HAS_MAP="$(record RegionalEndpoint '.attributes | has("RegionalEndpoints")')"
if [ "${HAS_MAP}" != "false" ]; then
  echo "FAIL: phase 1b: the ${PREFIX_CDKD_VERSION} record already carries the RegionalEndpoints map (${HAS_MAP})" >&2
  exit 1
fi
HAS_KEY="$(record RegionalEndpoint ".attributes | has(\"RegionalEndpoints.${SECONDARY_REGION}.DomainName\")")"
if [ "${HAS_KEY}" != "false" ]; then
  echo "FAIL: phase 1b: the ${PREFIX_CDKD_VERSION} record already carries the regional DomainName (${HAS_KEY})" >&2
  exit 1
fi

echo "==> Phase 1c: deploy v1 again with this build, no change (heals the ${PREFIX_CDKD_VERSION} record)"
# Nothing changes, so no provider rewrites the PerRegion endpoint's record:
# only the heal can answer the GetAtt. Its first write of this stack (v13).
OUT="$(deploy "${V1}")" || { echo "${OUT}"; echo "FAIL: phase 1c deploy" >&2; exit 1; }
echo "${OUT}"
# Stripped into a variable first: `grep -q` exiting on a match would give the
# feeding `sed` SIGPIPE, and `pipefail` would turn the match into a miss.
OUT_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"${OUT}")"
if grep -qE 'RegionalEndpoint \(AWS::Lambda::WebFunctionEndpoint\) (updated|replaced|created)' <<<"${OUT_PLAIN}"; then
  echo "FAIL: phase 1c: the deploy wrote the PerRegion endpoint, so its record no longer needs the heal" >&2
  exit 1
fi
assert_regional_getatt 'phase 1c'
HAS_KEY="$(record RegionalEndpoint ".attributes | has(\"RegionalEndpoints.${SECONDARY_REGION}.DomainName\")")"
if [ "${HAS_KEY}" != "true" ]; then
  echo "FAIL: phase 1c: the healed regional DomainName was not saved to the record (${HAS_KEY})" >&2
  exit 1
fi
echo "    OK: phase 1c: the healed attribute was saved to the record"
for id in Revision Endpoint; do
  GOT="$(record "${id}" '.provisionedBy')"
  if [ "${GOT}" != "cc-api" ]; then
    echo "FAIL: phase 1c: the no-change deploy moved ${id} to provisionedBy=${GOT}; phase 2 would no longer exercise the cc-api -> sdk move" >&2
    exit 1
  fi
done
echo "    OK: Revision and Endpoint still recorded provisionedBy=cc-api"
assert_serves v1

# The revision replacement every later code change must repeat: replaced, the
# inline delete refused and retried, exactly one revision left, the old one
# gone, the endpoints not recreated. Prints the remaining revision.
replace_revision() { # usage: replace_revision <phase> <marker> <old-revision>
  local version out t0 rev
  # `|| exit 1` on each capture: `set -e` does not reach inside `$( )`.
  version="$(upload_code "$2")" || exit 1
  [ -n "${version}" ] || { echo "FAIL: $1: the code upload returned no version id" >&2; exit 1; }
  t0="$(date +%s)"
  out="$(deploy "${version}")" || { echo "${out}" >&2; echo "FAIL: $1 deploy" >&2; exit 1; }
  echo "${out}" >&2
  echo "    $1 deploy took $(($(date +%s) - t0)) s" >&2
  assert_replaced "$1" "${out}" "$3"
  rev="$(assert_one_revision "$1" | tail -1)" || exit 1
  [ -n "${rev}" ] || { echo "FAIL: $1: no remaining revision was read" >&2; exit 1; }
  [ "${rev}" = "$3" ] && { echo "FAIL: $1: the remaining revision is the OLD one ($3)" >&2; exit 1; }
  assert_gone "$1: old revision $3 still exists" \
    aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionRevision --identifier "$3" --region "${REGION}"
  echo "    OK: $1: old revision $3 is gone" >&2
  printf '%s\n%s\n' "${version}" "${rev}"
}

# The endpoints keep their ARN (their physical id) across a code change.
assert_endpoints_kept() { # usage: assert_endpoints_kept <phase>
  local ep rep
  ep="$(record Endpoint '.physicalId')" || return 1
  rep="$(record RegionalEndpoint '.physicalId')" || return 1
  if [ "${ep}" != "${EP1}" ] || [ "${rep}" != "${REP1B}" ]; then
    echo "FAIL: $1: an endpoint was recreated (${EP1} -> ${ep}, ${REP1B} -> ${rep})" >&2
    exit 1
  fi
  echo "    OK: $1: endpoints ${EP1} and ${REP1B} kept"
}

echo "==> Phase 2: deploy v2 with this build (replaces the revision, leaves Cloud Control)"
R="$(replace_revision 'phase 2' v2 "${REV1}")"
REV2="$(sed -n 2p <<<"${R}")"
assert_route 'phase 2' sdk
# The witness that the SDK provider addresses the endpoint Cloud Control
# created (provisioning-sticky-routing.md): the update kept the AWS-minted ARN.
assert_endpoints_kept 'phase 2'
assert_serves v2
assert_regional_getatt 'phase 2'

echo "==> Phase 3: deploy v3 with this build (SDK to SDK)"
R="$(replace_revision 'phase 3' v3 "${REV2}")"
REV3="$(sed -n 2p <<<"${R}")"
assert_route 'phase 3' sdk
assert_endpoints_kept 'phase 3'
assert_serves v3
assert_regional_getatt 'phase 3'

echo "==> Phase 3b: two more code changes with this build (one revision each time, endpoints kept)"
R="$(replace_revision 'phase 3b (v4)' v4 "${REV3}")"
REV4="$(sed -n 2p <<<"${R}")"
assert_endpoints_kept 'phase 3b (v4)'
assert_serves v4
R="$(replace_revision 'phase 3b (v5)' v5 "${REV4}")"
V_LAST="$(sed -n 1p <<<"${R}")"
REV_LAST="$(sed -n 2p <<<"${R}")"
assert_route 'phase 3b' sdk
assert_endpoints_kept 'phase 3b (v5)'
assert_serves v5
assert_regional_getatt 'phase 3b'

echo "==> Phase 4: rename the endpoint (SDK create of the new one, SDK delete of the old one)"
T0="$(date +%s)"
OUT="$(ENDPOINT_NAME=live deploy "${V_LAST}")" || { echo "${OUT}"; echo "FAIL: phase 4 deploy" >&2; exit 1; }
echo "${OUT}"
echo "    phase 4 deploy took $(($(date +%s) - T0)) s"
EP4="$(record Endpoint '.physicalId')"
case "${EP4}" in
  */endpoint/live) ;;
  *) echo "FAIL: the endpoint record is ${EP4}, expected the renamed endpoint/live" >&2; exit 1 ;;
esac
assert_gone "old endpoint ${EP1} still exists after the rename" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionEndpoint --identifier "${EP1}" --region "${REGION}"
echo "    OK: old endpoint ${EP1} is gone"
assert_route 'phase 4' sdk
assert_serves v5

echo "==> Phase 5: cdkd drift reports no drift on the SDK-recorded revision and endpoint"
DRIFT_OUT="$(ENDPOINT_NAME=live CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="${V_LAST}" \
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || {
  echo "${DRIFT_OUT}"
  echo "FAIL: cdkd drift reported drift (or failed) right after a deploy" >&2
  exit 1
}
echo "${DRIFT_OUT}"
# Exit 0 also covers a resource drift could not compare (unsupported or
# skipped), so require every resource of the stack to have been compared: the
# role, the function, the revision, the two endpoints and the two parameters.
DRIFT_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"${DRIFT_OUT}")"
if ! grep -qF '(7 resources checked, 0 unsupported)' <<<"${DRIFT_PLAIN}"; then
  echo "FAIL: drift did not compare all 7 resources -- expected '(7 resources checked, 0 unsupported)'" >&2
  exit 1
fi
echo "    OK: no drift, all 7 resources compared"

echo "==> Destroy"
ENDPOINT_NAME=live CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="${V_LAST}" \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "web function ${FN_NAME} still exists after destroy" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunction --identifier "${FN_ARN}" --region "${REGION}"
assert_gone "endpoint ${EP4} still exists after destroy" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionEndpoint --identifier "${EP4}" --region "${REGION}"
assert_gone "PerRegion endpoint ${REP1B} still exists after destroy" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionEndpoint --identifier "${REP1B}" --region "${REGION}"
assert_gone "revision ${REV_LAST} still exists after destroy" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionRevision --identifier "${REV_LAST}" --region "${REGION}"
for p in "${PARAM_NAME}" "${MAX_ENVS_PARAM}"; do
  assert_gone "parameter ${p} still exists after destroy" aws ssm get-parameter --name "${p}" --region "${REGION}"
done
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: web function, endpoints, revisions, parameter, role and state gone"
echo ""
echo "[verify] PASS — lambda-web-function-revision-replace: the replaced revision is deleted once the endpoint moves (#4900), revisions / endpoints recorded on Cloud Control move to their SDK providers (#4926), and a PerRegion endpoint's RegionalEndpoints.<region>.DomainName resolves and heals (#4978), as do a path through an object member and the whole map (#4992); two more code changes each leave one revision behind the same endpoints"
