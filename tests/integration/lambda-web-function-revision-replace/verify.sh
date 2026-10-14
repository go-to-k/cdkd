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
  aws iam detach-role-policy --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  case "${FN_NAME}" in
    cdkd-integ-webfn?*)
      for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${FN_NAME}" \
        --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
        aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
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

deploy() { # usage: deploy <version-id>
  CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="$1" \
    node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1
}

# The endpoint answers with the marker of the revision it routes to.
assert_serves() { # usage: assert_serves <marker>
  local endpoint domain body=""
  endpoint="$(cc_ids AWS::Lambda::WebFunctionEndpoint)" || return 1
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

echo "==> Phase 1: deploy v1"
V1="$(upload_code v1)"
OUT="$(deploy "${V1}")" || { echo "${OUT}"; echo "FAIL: phase 1 deploy" >&2; exit 1; }
echo "${OUT}"
REV1="$(assert_one_revision 'phase 1' | tail -1)"
assert_serves v1

echo "==> Phase 2: deploy v2 (replaces the revision)"
V2="$(upload_code v2)"
OUT="$(deploy "${V2}")" || { echo "${OUT}"; echo "FAIL: phase 2 deploy" >&2; exit 1; }
echo "${OUT}"
# The summary lines carry ANSI colors between the words the checks match.
OUT="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"${OUT}")"
if ! grep -q 'Revision (AWS::Lambda::WebFunctionRevision) replaced' <<<"${OUT}"; then
  echo "FAIL: the revision was not replaced -- the fixture no longer exercises #4900" >&2
  exit 1
fi
if grep -q 'Failed to delete old resource' <<<"${OUT}"; then
  echo "FAIL: the old revision's delete failed for good (#4900)" >&2
  exit 1
fi
# Sentinel: the inline delete must have been refused and retried, or the
# fixture passes without reaching the fix.
if ! grep -q 'Could not delete old Revision' <<<"${OUT}"; then
  echo "FAIL: the inline delete was not refused -- the retry path was not exercised" >&2
  exit 1
fi
if ! grep -q "Old Revision (${REV1}) deleted" <<<"${OUT}"; then
  echo "FAIL: no retry line deleting ${REV1}" >&2
  exit 1
fi
REV2="$(assert_one_revision 'phase 2' | tail -1)"
[ "${REV2}" = "${REV1}" ] && { echo "FAIL: the remaining revision is the OLD one (${REV1})" >&2; exit 1; }
assert_gone "old revision ${REV1} still exists" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionRevision --identifier "${REV1}" --region "${REGION}"
echo "    OK: old revision ${REV1} is gone"
assert_serves v2

echo "==> Destroy"
CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="${V2}" \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "web function ${FN_NAME} still exists after destroy" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunction --identifier "${FN_ARN}" --region "${REGION}"
assert_gone "revision ${REV2} still exists after destroy" \
  aws cloudcontrol get-resource --type-name AWS::Lambda::WebFunctionRevision --identifier "${REV2}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: web function, revisions, role and state gone"
echo ""
echo "[verify] PASS — lambda-web-function-revision-replace: the replaced revision is deleted once the endpoint moves (#4900)"
