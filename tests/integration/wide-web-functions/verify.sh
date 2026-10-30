#!/usr/bin/env bash
# verify.sh — a wide stack of slow Cloud Control resources (issue #5242):
# Independent Lambda Web Functions (WIDE_WEBFN_COUNT, default 12), each with one revision and one
# HomeRegion endpoint, plus one shared execution role (37 resources). It
# measures how the --concurrency setting changes the deploy, read off the
# `CDKD_PHASE_TIMINGS` report.
#
# Phases: the code object is uploaded once to a versioned bucket this script
# owns. Then, for each setting in WIDE_WEBFN_SETTINGS (default "10 20"), under
# its own name token: deploy with --concurrency <n> and the phase report on,
# assert every web function, revision and endpoint is live, print the
# [measure] lines, destroy, assert gone. Finally the bucket goes, and the
# state file must be gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdWideWebFunctionsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Web functions in the stack (the stack's FUNCTIONS); with one revision and
# one endpoint each, plus the role, the DAG holds 3 * 12 + 1 resources.
FUNCTIONS="${WIDE_WEBFN_COUNT:-12}"
case "${FUNCTIONS}" in
  '' | *[!0-9]*) echo "FAIL: WIDE_WEBFN_COUNT must be an integer (got '${FUNCTIONS}')" >&2; exit 1 ;;
esac
# The stack reads the same variable.
export WIDE_WEBFN_COUNT="${FUNCTIONS}"
RESOURCES=$((3 * FUNCTIONS + 1))
NAME_PREFIX="cdkd-integ-webfn-wide"
CODE_KEY="app.zip"
# The --concurrency settings, in order. Overridable to measure others (a
# setting may repeat, to see run-to-run spread).
SETTINGS="${WIDE_WEBFN_SETTINGS:-10 20}"
# One name token per phase, `<letter><pid>`: at most ten phases.
TOKEN_LETTERS="a b c d e f g h i j"
ALL_TOKENS=""
for letter in ${TOKEN_LETTERS}; do ALL_TOKENS="${ALL_TOKENS} ${letter}$$"; done
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-5242-webfn-deploy.$$.log"
WORK=""
CLEANED_UP=0

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not built (run vp run build)" >&2
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CODE_BUCKET="${NAME_PREFIX}-code-${ACCOUNT}-${REGION}"

# Identifiers of every resource of a type under one web function.
cc_ids() { # usage: cc_ids <type> <function-name>
  aws cloudcontrol list-resources --type-name "$1" --resource-model "{\"FunctionName\":\"$2\"}" \
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

# Delete everything one run token named. Best-effort, in a subshell so a
# `set +eu` caller is never re-armed. The token is scoped by the guard: an
# empty or foreign token would widen every listing below to the account.
reap_run() { # usage: reap_run <token>
  (
    set +eu
    case "${1:-}" in
      [a-j][0-9]?*) ;;
      *)
        echo "WARN: teardown sweep refused — '${1:-}' is not one of this fixture's run tokens" >&2
        exit 0
        ;;
    esac
    local prefix="${NAME_PREFIX}-$1"
    for i in $(seq 0 $((FUNCTIONS - 1))); do
      fn="${prefix}-${i}"
      arn="$(aws lambda-web get-web-function --function-name "${fn}" --region "${REGION}" \
        --query functionArn --output text 2>/dev/null)" || continue
      for id in $(cc_ids AWS::Lambda::WebFunctionEndpoint "${fn}" 2>/dev/null); do
        cc_delete AWS::Lambda::WebFunctionEndpoint "${id}"
      done
      for id in $(cc_ids AWS::Lambda::WebFunctionRevision "${fn}" 2>/dev/null); do
        cc_delete AWS::Lambda::WebFunctionRevision "${id}"
      done
      cc_delete AWS::Lambda::WebFunction "${arn}"
    done
    for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${prefix}-" \
      --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
      aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
    role="${prefix}-${REGION}"
    aws iam detach-role-policy --role-name "${role}" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1
  )
}

# Every version and delete marker of the code object, then the bucket.
reap_code_bucket() { (
  set +eu
  for v in $(aws s3api list-object-versions --bucket "${CODE_BUCKET}" \
    --query '[Versions[].VersionId, DeleteMarkers[].VersionId][]' --output text 2>/dev/null); do
    [ "${v}" = "None" ] && continue
    aws s3api delete-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" --version-id "${v}" >/dev/null 2>&1
  done
  aws s3api delete-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
) }

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  for token in ${ALL_TOKENS}; do reap_run "${token}"; done
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  reap_code_bucket
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  if [ -n "${WORK}" ] && [ -d "${WORK}" ]; then
    rm -rf "${WORK}"
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -d node_modules ] || npm install

cleanup
CLEANED_UP=0
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
    \"Condition\": {\"ArnLike\": {\"aws:SourceArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT}:web-function/${NAME_PREFIX}-*/revision/*\"}}
  }]
}"

echo "==> Uploading the app"
cat >"${WORK}/index.js" <<'EOF'
const http = require('node:http');
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '0.0.0.0:3000').split(':');
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('wide\n');
  })
  .listen(Number(port), host);
EOF
(cd "${WORK}" && zip -q "${WORK}/app.zip" index.js)
CODE_VERSION="$(aws s3api put-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" --body "${WORK}/app.zip" \
  --region "${REGION}" --query VersionId --output text)"
case "${CODE_VERSION}" in
  "" | None | null)
    echo "FAIL: the code upload returned no version id: '${CODE_VERSION}'" >&2
    exit 1
    ;;
esac

# Every web function Active, with exactly one revision and one endpoint, both
# Active, the endpoint routing all traffic to that revision. Polls a while:
# a create may return while AWS still reports Pending.
assert_live() { # usage: assert_live <token>
  local prefix="${NAME_PREFIX}-$1" i fn got want
  local -a f
  for i in $(seq 0 $((FUNCTIONS - 1))); do
    fn="${prefix}-${i}"
    want=""
    got=""
    for _ in $(seq 1 24); do
      # "<function state> <revision id> <revision state> <revision count>"
      # then "<endpoint name> <endpoint state> <routed revision> <weight> <endpoint count>".
      got="$(aws lambda-web get-web-function --function-name "${fn}" --region "${REGION}" \
        --query state --output text)" || return 1
      got="${got} $(aws lambda-web list-web-function-revisions --function-name "${fn}" --region "${REGION}" \
        --query '[revisions[0].revisionId, revisions[0].state, length(revisions)]' --output text)" || return 1
      got="${got} $(aws lambda-web list-web-function-endpoints --function-name "${fn}" --region "${REGION}" \
        --query '[endpoints[0].endpointName, endpoints[0].state, endpoints[0].revisionWeights[0].revisionId, endpoints[0].revisionWeights[0].weight, length(endpoints)]' \
        --output text)" || return 1
      got="$(tr -s '[:space:]' ' ' <<<"${got}" | sed 's/ $//')"
      read -r -a f <<<"${got}"
      want="Active ${f[1]:-} Active 1 prod Active ${f[1]:-} 100 1"
      [ "${got}" = "${want}" ] && break
      sleep 5
    done
    if [ "${got}" != "${want}" ]; then
      echo "FAIL: web function ${fn} is not live: '${got}' (want function Active, one Active revision, one Active endpoint 'prod' routing 100 to it)" >&2
      exit 1
    fi
  done
  echo "    OK: ${FUNCTIONS} web functions live, each with one Active revision and one Active endpoint"
}

assert_run_gone() { # usage: assert_run_gone <token>
  local prefix="${NAME_PREFIX}-$1" i fn
  for i in $(seq 0 $((FUNCTIONS - 1))); do
    fn="${prefix}-${i}"
    assert_gone "endpoint prod of ${fn} still exists after destroy" \
      aws lambda-web get-web-function-endpoint --function-name "${fn}" --endpoint-name prod --region "${REGION}"
    assert_gone "web function ${fn} still exists after destroy" \
      aws lambda-web get-web-function --function-name "${fn}" --region "${REGION}"
  done
  assert_gone "role ${prefix}-${REGION} still exists after destroy" aws iam get-role --role-name "${prefix}-${REGION}"
  # A revision cannot outlive its function, so the function probe covers it.
  # The log groups Lambda creates for the functions are not stack resources:
  # removed here, so a passing run leaves none behind, then asserted gone.
  local lg left
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${prefix}-" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text); do
    [ "${lg}" = "None" ] && continue
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null
  done
  left="$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${prefix}-" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text)" || return 1
  [ -z "${left}" ] || [ "${left}" = "None" ] \
    || { echo "FAIL: log groups of ${prefix} still exist after destroy: ${left}" >&2; exit 1; }
  echo "    OK: ${FUNCTIONS} web functions, their endpoints, the role and the log groups are gone"
}

run_phase() { # usage: run_phase <token> <label> [deploy args...]
  local token="$1" label="$2"
  shift 2
  echo "==> ${label}: deploy (run ${token})"
  CDKD_WIDE_RUN="${token}" CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="${CODE_VERSION}" \
    CDKD_PHASE_TIMINGS=1 node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@" >"${DEPLOY_LOG}" 2>&1 \
    || { cat "${DEPLOY_LOG}" >&2; echo "FAIL: ${label} deploy failed" >&2; exit 1; }
  assert_live "${token}"
  local wait_line
  wait_line="$(grep 'ready, waiting for a --concurrency slot' "${DEPLOY_LOG}" | sed 's/.*INFO[^ ]* *//' || true)"
  # Sentinel: the report itself must be there, or a missing wait line would
  # read as "no wait" rather than "no report".
  grep -q 'Phase timings (CDKD_PHASE_TIMINGS=1):' "${DEPLOY_LOG}" \
    || { echo "FAIL: ${label}: no phase timings report in the deploy output" >&2; exit 1; }
  grep -q "x${RESOURCES}" <<<"${wait_line}" \
    || { echo "FAIL: ${label}: no slot-wait line for all ${RESOURCES} resources: '${wait_line}'" >&2; exit 1; }
  echo "[measure] ${label}: ${wait_line}"
  echo "[measure] ${label}: $(grep -E 'resource DAG  ' "${DEPLOY_LOG}" | sed 's/.*INFO[^ ]* *//')"
  echo "[measure] ${label}: $(grep -cE 'Rate exceeded|Throttl' "${DEPLOY_LOG}" || true) throttling line(s)"
  # Every retry cdkd made, by error class (none is a valid answer).
  grep 'retry after ' "${DEPLOY_LOG}" | sed 's/.*INFO[^ ]* *//; s/^/[measure] '"${label}"': /' || true
  echo "==> ${label}: destroy"
  CDKD_WIDE_RUN="${token}" CODE_BUCKET="${CODE_BUCKET}" CODE_KEY="${CODE_KEY}" CODE_VERSION="${CODE_VERSION}" \
    node "${LOCAL_DIST}" destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >"${DEPLOY_LOG}" 2>&1 \
    || { cat "${DEPLOY_LOG}" >&2; echo "FAIL: ${label} destroy failed" >&2; exit 1; }
  assert_run_gone "${token}"
}

set -- ${ALL_TOKENS}
phases=0
for n in ${SETTINGS}; do
  [ "$#" -gt 0 ] || { echo "FAIL: more than ten phases requested" >&2; exit 1; }
  run_phase "$1" "web functions, --concurrency ${n}" --concurrency "${n}"
  shift
  phases=$((phases + 1))
done
[ "${phases}" -gt 0 ] || { echo "FAIL: no phase ran" >&2; exit 1; }

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Code bucket teardown"
reap_code_bucket
assert_gone "code bucket ${CODE_BUCKET} still exists" aws s3api head-bucket --bucket "${CODE_BUCKET}"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
rm -rf "${WORK}"
echo "[verify] PASS — wide-web-functions: ${FUNCTIONS} independent Lambda Web Functions (${RESOURCES} resources) deployed, live and destroyed at --concurrency ${SETTINGS}"
