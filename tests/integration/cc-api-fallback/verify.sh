#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API greenfield fallback integ test
# (issue #614).
#
# Asserts that an HTTP API whose template uses a silent-drop property
# (`Body`, an inline OpenAPI spec — an ARCHITECTURAL exclusion, see
# issue #2473 and the rationale in lib/cc-api-fallback-stack.ts) is
# auto-routed via Cloud Control API and that the spec's route reaches
# AWS — the silent-drop bug is closed by default. Also asserts the
# destroy path works through CC API. Step 0 reds self-diagnosingly if
# the trigger is ever backfilled. Phase 1a (go-to-k/cdkd#5260) redeploys
# in-place edits of Body; phase 1c (go-to-k/cdkd#5264) switches it to
# BodyS3Location and edits that. Phase 1b (go-to-k/cdkd#2319) destroys the
# stack as a role denied API Gateway's write verbs, so the Cloud Control
# DELETE handler FAILs with a denial, and asserts the persisted
# RESOURCE_FAILED message carries `<caller-principal>` and none of the
# caller's identity. Phase 2 then destroys it as the caller.
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

STACK="CdkdCcApiFallback"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_TITLE="cdkd-cc-api-fallback-probe"
PROBE_ROUTE="GET /cdkd-2473-probe"
DENY_ROLE="${STACK}-no-apigw-write"
DENY_POLICY_NAME="cc-delete-without-apigw-write"
DENY_SESSION="cdkd-cc-deny-probe"
DENY_ROLE_CREATED=""
# go-to-k/cdkd#5264: the bucket phase 1c uploads definition objects to; its
# name needs the account id, so it is set once that is read.
DEFS_BUCKET=""
DEFS_BUCKET_CREATED=""
# Holds AWS text (the deny destroy's log, the events it wrote); removed on
# every exit.
LOG_DIR="$(mktemp -d)"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

delete_deny_role() { ( # usage: delete_deny_role
  set +eu
  aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null 2>&1
  true
); }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -n "${DEFS_BUCKET_CREATED}" ] && [ -n "${DEFS_BUCKET}" ]; then
    aws s3 rm "s3://${DEFS_BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1
    if aws s3api delete-bucket --bucket "${DEFS_BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
      DEFS_BUCKET_CREATED=""
    else
      echo "WARN: definition bucket ${DEFS_BUCKET} could not be deleted; delete it by hand" >&2
    fi
  fi
  if [ -n "${DENY_ROLE_CREATED}" ]; then
    delete_deny_role
    for _ in $(seq 1 12); do
      if ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then break; fi
      sleep 5
    done
    if ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then
      DENY_ROLE_CREATED=""
    else
      echo "WARN: role ${DENY_ROLE} could not be confirmed deleted; delete it by hand" >&2
    fi
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for api_id in $(aws apigatewayv2 get-apis --region "${REGION}" \
      --query "Items[?Name=='${API_TITLE:-cdkd-cc-api-fallback-probe}'].ApiId" --output text 2>/dev/null); do
    aws apigatewayv2 delete-api --api-id "${api_id}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
# The real exit only: the pre-run `cleanup` below must keep LOG_DIR.
on_exit() {
  cleanup
  rm -rf "${LOG_DIR}"
}

trap on_exit EXIT
trap '(exit 130); on_exit; exit 130' INT
trap '(exit 143); on_exit; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Step 0: self-diagnosing trigger guard (issue #2473) --------------------
# This fixture's premise is that `Body` is a silent-drop for
# AWS::ApiGatewayV2::Api. Every previous trigger died when the backfill
# campaign wired it (LoggingConfig -> RecursiveLoop -> RuntimeManagementConfig),
# each time as a mysterious permanent deploy-time red that cost a root-cause
# session. This guard turns that death into a one-line red naming its own fix.
echo "==> Step 0: trigger premise guard"
if ! (cd "${PWD}/../../.." && node --input-type=module -e "
const mod = await import('./src/provisioning/property-coverage.generated.ts');
const table = Object.values(mod).find((v) => v instanceof Map);
const cov = table && table.get('AWS::ApiGatewayV2::Api');
if (!cov || !cov.silentDrop || !cov.silentDrop.has('Body')) process.exit(1);
"); then
  echo "FAIL: AWS::ApiGatewayV2::Api.Body is no longer a silent-drop — the trigger" >&2
  echo "      was backfilled and this fixture's premise is dead. Do NOT debug the" >&2
  echo "      deploy: pick the next durable silent-drop trigger per the selection" >&2
  echo "      rule in lib/cc-api-fallback-stack.ts (issue 2473)." >&2
  exit 1
fi
echo "    OK: Body is still a silent-drop (premise holds)"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
case "${ACCOUNT_ID}" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    echo "FAIL: could not read this account's id (got '${ACCOUNT_ID}')" >&2
    exit 1
    ;;
esac
if [ -z "${CALLER_USERID}" ] || [ "${CALLER_USERID}" = "None" ]; then
  echo "FAIL: could not read the caller's UserId" >&2
  exit 1
fi

echo "==> Pre-run cleanup"
cleanup
# A per-run token: two concurrent runs in us-east-1 would otherwise share the
# name (create-bucket succeeds there for the owner), and one run's cleanup
# would delete the other's bucket.
DEFS_RUN_TOKEN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
case "${DEFS_RUN_TOKEN}" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *)
    echo "FAIL: could not draw a run token for the definition bucket (got '${DEFS_RUN_TOKEN}')" >&2
    exit 1
    ;;
esac
DEFS_BUCKET="cdkd-cc-api-fallback-defs-${ACCOUNT_ID}-${REGION}-${DEFS_RUN_TOKEN}"
# The per-run name cannot collide, so a precondition on it would be vacuous.
# Name any definition bucket an earlier run left instead (a WARN, not a FAIL:
# it may be a concurrent run's live bucket).
DEFS_LEFTOVERS="$(aws s3api list-buckets \
  --query "Buckets[?starts_with(Name, 'cdkd-cc-api-fallback-defs-${ACCOUNT_ID}-${REGION}-')].Name" \
  --output text)"
case "${DEFS_LEFTOVERS}" in
  '' | None) ;;
  *) echo "WARN: definition bucket(s) from another run of this fixture exist: ${DEFS_LEFTOVERS} -- delete them once no run is live" >&2 ;;
esac
# A role left by an earlier run would carry another run's policy.
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion 1: state.provisionedBy on the HTTP API is 'cc-api' -----
# Lookup by resourceType (CDK appends a hash to the logical id; the
# bare `SilentDropApi` key does not exist — it's e.g.
# `SilentDropApiXXXXXXXX`).
PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value.provisionedBy // ""] | first')
API_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value.physicalId // ""] | first')
if [ "${PROVISIONED}" != "cc-api" ]; then
  echo "FAIL: HTTP API resource has provisionedBy='${PROVISIONED}', expected 'cc-api' (auto-route should have fired on Body)" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: HTTP API resource provisionedBy == 'cc-api' (auto-route fired)"

# --- Assertion 2: state.provisionedBy on the IAM Role is 'sdk' (heterogeneous) ---
ROLE_PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .value.provisionedBy // ""] | first')
if [ "${ROLE_PROVISIONED}" != "sdk" ]; then
  echo "FAIL: IAM Role resource has provisionedBy='${ROLE_PROVISIONED}', expected 'sdk'" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: IAM Role resource provisionedBy == 'sdk' (heterogeneous routing in one stack)"

# --- Assertion 3: the OpenAPI Body actually reached AWS -----------------------
# The `GET /cdkd-2473-probe` route is declared ONLY inside `Body`, so its
# presence on the live API proves the CC route imported the spec; the SDK
# path would have silently dropped it, leaving an API with no routes.
case "${API_ID}" in
  '' | null)
    echo "FAIL: no ApiGatewayV2::Api physicalId in state" >&2
    exit 1
    ;;
esac
ROUTE_COUNT=$(aws apigatewayv2 get-routes --api-id "${API_ID}" --region "${REGION}" \
  --query "length(Items[?RouteKey=='${PROBE_ROUTE}'])" --output text)
case "${ROUTE_COUNT}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the route count (got '${ROUTE_COUNT}')" >&2
    exit 1
    ;;
esac
if [ "${ROUTE_COUNT}" -lt 1 ]; then
  echo "FAIL: route '${PROBE_ROUTE}' not found on API ${API_ID} (Body silent-drop NOT closed by CC route)" >&2
  exit 1
fi
echo "    OK: route '${PROBE_ROUTE}' exists on AWS (silent-drop CLOSED by #614)"

# --- Phase 1a: edit Body in place, twice (go-to-k/cdkd#5260) ---------------
# Before #5260 every Body change failed: Cloud Control applies a patch to the
# model it READ, which carries Name / ProtocolType / ..., and API Gateway
# refuses those beside Body ("Redundant fields [...] provided when either Body
# or BodyS3Location is not empty"). cdkd now sends the definition through
# ReimportApi, and the rest of the change through Cloud Control.
# `CC_BODY_EDIT=<n>` adds route `GET /cdkd-5260-edit-<n>` to the Body. From
# edit 2 the template also declares `Description` and `Tags`, the changes
# Cloud Control still applies, and the definition holds its own
# `info.description`, which a reimport writes over the API's description:
# - edit 1: Body only (ReimportApi alone);
# - edit 2: Body + an added Description + added Tags (reimport, then CC);
# - edit 3: Body + changed Tags, Description UNCHANGED, so only cdkd's
#   re-send of the declared Description keeps it over the definition's.
route_count() { # usage: route_count <route key>; prints a validated count
  local n
  n="$(aws apigatewayv2 get-routes --api-id "${API_ID}" --region "${REGION}" \
    --query "length(Items[?RouteKey=='$1'])" --output text)" || return 1
  case "${n}" in
    '' | *[!0-9]*)
      echo "FAIL: could not read the count of route '$1' (got '${n}')" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "${n}"
}
api_field() { # usage: api_field <JMESPath>; prints the live API's value
  local v
  v="$(aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}" \
    --query "$1" --output text)" || return 1
  printf '%s\n' "${v}"
}
for edit in 1 2 3; do
  echo "==> Phase 1a: redeploy with Body edit ${edit} (#5260)"
  if ! CC_BODY_EDIT="${edit}" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --yes; then
    echo "FAIL: the redeploy editing Body (edit ${edit}) failed -- an in-place Body change must succeed, as it does under the CDK CLI (#5260)" >&2
    exit 1
  fi
  EDIT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)" || {
    echo "FAIL: could not read s3://${STATE_BUCKET}/${STATE_KEY} after Body edit ${edit}" >&2
    exit 1
  }
  EDIT_API_ID="$(printf '%s' "${EDIT_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value.physicalId // ""] | first')"
  if [ "${EDIT_API_ID}" != "${API_ID}" ]; then
    echo "FAIL: Body edit ${edit} changed the API id from ${API_ID} to '${EDIT_API_ID}' -- an in-place edit must not replace the API (#5260)" >&2
    exit 1
  fi
  # Assigned first: under `set -e` a failed read in an assignment stops the
  # run, where inside `[ ]` it would compare an empty string and pass on.
  EDIT_ROUTES="$(route_count "GET /cdkd-5260-edit-${edit}")"
  PROBE_ROUTES="$(route_count "${PROBE_ROUTE}")"
  if [ "${EDIT_ROUTES}" -lt 1 ]; then
    echo "FAIL: route 'GET /cdkd-5260-edit-${edit}' is missing on API ${API_ID} after Body edit ${edit} -- the edited definition never reached AWS (#5260)" >&2
    exit 1
  fi
  if [ "${PROBE_ROUTES}" -lt 1 ]; then
    echo "FAIL: route '${PROBE_ROUTE}' is missing on API ${API_ID} after Body edit ${edit}" >&2
    exit 1
  fi
  if [ "${edit}" -ge 2 ]; then
    # The reimport REPLACES the definition: this edit's Body no longer holds
    # the previous edit's route. A merge would keep it.
    PREV_ROUTES="$(route_count "GET /cdkd-5260-edit-$((edit - 1))")"
    if [ "${PREV_ROUTES}" -ne 0 ]; then
      echo "FAIL: route 'GET /cdkd-5260-edit-$((edit - 1))' survived Body edit ${edit}, whose definition dropped it -- the update merged instead of replacing the definition (#5260)" >&2
      exit 1
    fi
    LIVE_DESC="$(api_field Description)"
    if [ "${LIVE_DESC}" != "cdkd-5260-declared" ]; then
      echo "FAIL: after Body edit ${edit} the API's Description reads '${LIVE_DESC}', not the declared 'cdkd-5260-declared' -- the reimport's info.description won, or the Cloud Control half never ran (#5260)" >&2
      exit 1
    fi
    LIVE_TAG="$(api_field Tags.cdkd5260)"
    if [ "${LIVE_TAG}" != "edit-${edit}" ]; then
      echo "FAIL: after Body edit ${edit} the API's cdkd5260 tag reads '${LIVE_TAG}', not 'edit-${edit}' -- the Cloud Control half of the update never reached AWS (#5260)" >&2
      exit 1
    fi
  fi
  echo "    OK: Body edit ${edit} deployed in place (same API id), and its route is live"
done
echo "    OK: each edit replaced the definition, and the declared Description and Tags read back (#5260)"

# --- Phase 1c: switch the definition to BodyS3Location, then edit it ---------
# go-to-k/cdkd#5264. ReimportApi takes the definition's text only, so cdkd
# reads the object BodyS3Location names (as the deploy identity, in the
# bucket's region) and reimports that text; before #5264 it refused the change.
# Redeploy 1 switches the inline Body to object v1; redeploy 2 points
# BodyS3Location at object v2. Each object adds its own route.
s3_definition() { # usage: s3_definition <n>; prints definition JSON with route /cdkd-5264-s3-<n>
  node -e 'const n=process.argv[1];const get={get:{responses:{"200":{description:"ok"}},"x-amazon-apigateway-integration":{type:"http_proxy",httpMethod:"GET",uri:"https://example.com",payloadFormatVersion:"1.0"}}};process.stdout.write(JSON.stringify({openapi:"3.0.1",info:{title:"cdkd-cc-api-fallback-probe",version:"1.0",description:"cdkd-5264-from-object"},paths:{"/cdkd-2473-probe":get,[`/cdkd-5264-s3-${n}`]:get}}))' "$1"
}
echo "==> Phase 1c: definition bucket ${DEFS_BUCKET}"
# Flagged BEFORE the create: an interrupt between the two would otherwise
# leave the bucket for the next run's precondition.
DEFS_BUCKET_CREATED=1
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${DEFS_BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${DEFS_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
for obj in 1 2; do
  s3_definition "${obj}" > "${LOG_DIR}/definition-${obj}.json"
  aws s3 cp "${LOG_DIR}/definition-${obj}.json" "s3://${DEFS_BUCKET}/defs/v${obj}.json" \
    --region "${REGION}" --quiet
done
for obj in 1 2; do
  echo "==> Phase 1c: redeploy with BodyS3Location -> defs/v${obj}.json (#5264)"
  if ! CC_BODY_S3_BUCKET="${DEFS_BUCKET}" CC_BODY_S3_KEY="defs/v${obj}.json" \
    node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --yes; then
    echo "FAIL: the redeploy to BodyS3Location defs/v${obj}.json failed -- an in-place BodyS3Location change must succeed, as it does under the CDK CLI (#5264)" >&2
    exit 1
  fi
  S3_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)" || {
    echo "FAIL: could not read s3://${STATE_BUCKET}/${STATE_KEY} after the BodyS3Location redeploy ${obj}" >&2
    exit 1
  }
  S3_API_ID="$(printf '%s' "${S3_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value.physicalId // ""] | first')"
  if [ "${S3_API_ID}" != "${API_ID}" ]; then
    echo "FAIL: the BodyS3Location redeploy ${obj} changed the API id from ${API_ID} to '${S3_API_ID}' (#5264)" >&2
    exit 1
  fi
  S3_ROUTES="$(route_count "GET /cdkd-5264-s3-${obj}")"
  if [ "${S3_ROUTES}" -lt 1 ]; then
    echo "FAIL: route 'GET /cdkd-5264-s3-${obj}' is missing on API ${API_ID} -- object v${obj}'s definition never reached AWS (#5264)" >&2
    exit 1
  fi
  # The previous definition (inline edit 3, then object v1) is replaced.
  if [ "${obj}" = 1 ]; then PREV_ROUTE="GET /cdkd-5260-edit-3"; else PREV_ROUTE="GET /cdkd-5264-s3-1"; fi
  PREV_ROUTES="$(route_count "${PREV_ROUTE}")"
  if [ "${PREV_ROUTES}" -ne 0 ]; then
    echo "FAIL: route '${PREV_ROUTE}' survived the BodyS3Location redeploy ${obj}, whose definition dropped it (#5264)" >&2
    exit 1
  fi
  LIVE_DESC="$(api_field Description)"
  if [ "${LIVE_DESC}" != "cdkd-5260-declared" ]; then
    echo "FAIL: after the BodyS3Location redeploy ${obj} the API's Description reads '${LIVE_DESC}', not the declared 'cdkd-5260-declared' (#5264)" >&2
    exit 1
  fi
  echo "    OK: BodyS3Location redeploy ${obj} imported object v${obj} in place (same API id, its route live)"
done
# Emptied and deleted here, confirmed gone; `cleanup` retries on any failure.
aws s3 rm "s3://${DEFS_BUCKET}" --recursive --region "${REGION}" >/dev/null
aws s3api delete-bucket --bucket "${DEFS_BUCKET}" --region "${REGION}"
for _ in $(seq 1 12); do
  if gone_probe aws s3api head-bucket --bucket "${DEFS_BUCKET}" --region "${REGION}"; then break; fi
  sleep 5
done
assert_gone "definition bucket ${DEFS_BUCKET} still exists after its delete" \
  aws s3api head-bucket --bucket "${DEFS_BUCKET}" --region "${REGION}"
DEFS_BUCKET_CREATED=""

# --- Phase 1b: a denied Cloud Control DELETE (go-to-k/cdkd#2319) ------------
# The Cloud Control handler calls API Gateway with the CALLER's credentials, so
# a caller denied API Gateway's write verbs makes the handler FAIL, and AWS
# words that denial with the caller's principal: `User:
# arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized ...`.
# cdkd keeps the handler's StatusMessage in the persisted RESOURCE_FAILED
# event (it is what a user fixes a template from) with the caller's identity
# masked. The handler's exact wording is known only from a run, so a message
# that quotes no principal at all FAILs as an unmet PREMISE, not a pass.
# A DELETE, not an UPDATE: Cloud Control applies an UPDATE to the model it
# READ, which carries `Name` / `ProtocolType` beside `Body`, and API Gateway
# refuses that model ("Redundant fields ... when either Body or BodyS3Location
# is not empty") before IAM is consulted. DeleteApi has no such validation.
echo "==> Phase 1b: destroy the stack as a role denied API Gateway writes (#2319)"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this destroy calls. The S3 verbs are the state path's
# (state.json, lock.json, deployments/*.jsonl under this stack's prefix); the
# `cloudformation:` verbs are Cloud Control's own (DeleteResource and its
# status poll, GetResource). API Gateway's reads stay allowed so the handler
# reaches DeleteApi; every write verb is denied. Nothing grants `iam:` writes,
# so the stack's SDK-routed IAM Role survives this destroy too.
DENY_POLICY="$(node -e 'const [bucket,stack]=process.argv.slice(1);process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["cloudformation:DeleteResource","cloudformation:GetResource","cloudformation:GetResourceRequestStatus","cloudformation:Describe*","cloudformation:List*","apigateway:GET","iam:GetRole","iam:ListRolePolicies","iam:ListAttachedRolePolicies","ssm:GetParameter","ssm:GetParameters","kms:Decrypt","kms:GenerateDataKey","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["apigateway:PUT","apigateway:PATCH","apigateway:POST","apigateway:DELETE"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}")"
# Flagged BEFORE the create: an interrupt between the two would otherwise
# leave the role for the next run's precondition; a delete of a role that
# never existed is harmless.
DENY_ROLE_CREATED=1
DENY_ROLE_ID="$(aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=cc-api-fallback --query Role.RoleId --output text)"
case "${DENY_ROLE_ID}" in
  AROA?*) ;;
  *)
    echo "FAIL: precondition -- create-role returned no AROA... RoleId (got '${DENY_ROLE_ID}')" >&2
    exit 1
    ;;
esac
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name "${DENY_SESSION}" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  DENY_CREDS=""
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped; the keys are
# exported inside a subshell, never placed in a process's argv.
as_deny_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
# The deny must bind before the destroy, or a pass would test nothing. The probe
# is a no-op PATCH (the API's own name) that the deny refuses.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws apigatewayv2 update-api --api-id "${API_ID}" --name "${API_TITLE}" \
    --region "${REGION}" 2>&1)"; then
    DENY_PROBE=""
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "FAIL: precondition -- ${DENY_ROLE}'s explicit deny on apigateway:PATCH never bound within 2 minutes" >&2
  exit 1
fi
EVENTS_PREFIX="cdkd/${STACK}/${REGION}/deployments/"
list_event_keys() {
  aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${EVENTS_PREFIX}" --output json \
    | jq -r '.Contents // [] | .[].Key | select(endswith(".jsonl"))' | sort
}
list_event_keys > "${LOG_DIR}/event-keys-before"
set +e
as_deny_role node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --force > "${LOG_DIR}/deny-destroy.log" 2>&1
DENY_RC=$?
set -e
# The role is not needed again. Still flagged until confirmed gone, so a
# failure here leaves `cleanup` to retry the delete.
delete_deny_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${DENY_RC}" -eq 0 ]; then
  echo "FAIL: the destroy as ${DENY_ROLE} SUCCEEDED -- the DELETE never reached a denied API Gateway write" >&2
  exit 1
fi
list_event_keys > "${LOG_DIR}/event-keys-after"
FAILED_EVENTS="${LOG_DIR}/failed-events.jsonl"
: > "${FAILED_EVENTS}"
while IFS= read -r event_key || [ -n "${event_key}" ]; do
  [ -n "${event_key}" ] || continue
  aws s3 cp "s3://${STATE_BUCKET}/${event_key}" - --quiet \
    | jq -c 'select(.eventType == "RESOURCE_FAILED" and .resourceType == "AWS::ApiGatewayV2::Api")' >> "${FAILED_EVENTS}"
done < <(comm -13 "${LOG_DIR}/event-keys-before" "${LOG_DIR}/event-keys-after")
# The last MESSAGE, not the last line: a StatusMessage may hold a newline.
FAILED_MSG="$(jq -rs 'map(.error.message // empty) | last // empty' "${FAILED_EVENTS}")"
if [ -z "${FAILED_MSG}" ]; then
  echo "FAIL: premise not met -- the deny destroy wrote no RESOURCE_FAILED event with an error message for the AWS::ApiGatewayV2::Api under s3://${STATE_BUCKET}/${EVENTS_PREFIX} (the #2319 checks below would pass for free)" >&2
  exit 1
fi
case "${FAILED_MSG}" in
  *"DELETE failed for "*) ;;
  *)
    echo "FAIL: premise not met -- the RESOURCE_FAILED message does not carry Cloud Control's 'DELETE failed for <logicalId>: <StatusMessage>' text" >&2
    exit 1
    ;;
esac
# Masks every identity spelling this phase can produce, for the one FAIL that
# prints AWS text.
scrub_identity() {
  sed -E \
    -e 's#arn:aws[a-z-]*:(sts|iam)::[^[:space:]"'"'"',)]*#<principal-arn>#g' \
    -e 's/[0-9]{12}/<account>/g' \
    -e "s/${DENY_ROLE}/<deny-role>/g" \
    -e "s/${DENY_SESSION}/<deny-session>/g" \
    -e 's/(AROA|AIDA|ASIA|AKIA)[A-Z0-9]{12,}/<unique-id>/g'
}
# A FAIL names only the needle class that matched: echoing the message would
# print what it leaked.
# `case`, not `printf | grep -q`: no pipe, so no SIGPIPE false negative.
leak_class() { # usage: leak_class <message>; prints the first needle class it holds
  case "$1" in
    *"${ACCOUNT_ID}"*) echo "this account's id" ;;
    *"assumed-role/"*) echo "an assumed-role ARN" ;;
    *"${DENY_ROLE}"*) echo "the deny role's name" ;;
    *"${DENY_SESSION}"*) echo "the deny role's session name" ;;
    *"${DENY_ROLE_ID}"*) echo "the deny role's unique id" ;;
    *AROA*) echo "a role unique id (AROA...)" ;;
  esac
}
# EVERY RESOURCE_FAILED message for the API, not only the last: a retried
# attempt writes its own event, and each one is persisted.
FAILED_COUNT="$(jq -s 'length' "${FAILED_EVENTS}")"
for i in $(seq 0 $((FAILED_COUNT - 1))); do
  each_msg="$(jq -rs --argjson i "${i}" '.[$i].error.message // empty' "${FAILED_EVENTS}")"
  LEAK="$(leak_class "${each_msg}")"
  if [ -n "${LEAK}" ]; then
    echo "FAIL: persisted RESOURCE_FAILED message $((i + 1)) of ${FAILED_COUNT} quotes the caller: it contains ${LEAK} (#2319)" >&2
    exit 1
  fi
done
unset each_msg
case "${FAILED_MSG}" in *"<caller-principal>"*) HAS_MASK=1 ;; *) HAS_MASK="" ;; esac
if [ -z "${HAS_MASK}" ]; then
  if printf '%s\n' "${FAILED_MSG}" | grep -qiF "not authorized"; then
    echo "FAIL: premise not met: handler text quoted no principal (it does say 'not authorized'; read ${STACK}'s denial wording with --verbose and widen the mask or this arm)" >&2
  else
    echo "FAIL: premise not met: handler text quoted no principal (and says no 'not authorized'; the handler may not have reached the denied write)" >&2
  fi
  # Only here, where the checks above found no identity: show the handler's
  # real wording, and the destroy log's tail, so the next run can re-pin the
  # arm. Scrubbed first anyway, belt and braces.
  echo "    persisted RESOURCE_FAILED message (scrubbed):" >&2
  printf '%s\n' "${FAILED_MSG}" | scrub_identity | sed 's/^/      /' >&2
  echo "    deny destroy log (--verbose), last 40 failure-related lines (scrubbed):" >&2
  sed $'s/\x1b\\[[0-9;]*m//g' "${LOG_DIR}/deny-destroy.log" \
    | grep -iE 'fail|error|denied|authoriz|exception|DeleteResource|ProgressEvent|StatusMessage' \
    | tail -n 40 | scrub_identity | sed 's/^/      /' >&2 || true
  exit 1
fi
rm -f "${FAILED_EVENTS}"
echo "    OK: the denied DELETE's RESOURCE_FAILED message keeps the handler text with <caller-principal> and no account id, role or session (#2319)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy via CC delete path"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "HTTP API ${API_ID} still exists after destroy" aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}"
echo "    OK: HTTP API is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> cc-api-fallback test passed (silent-drop closed by CC auto-route, Body edited in place, denied DELETE masked the caller, clean destroy)"
