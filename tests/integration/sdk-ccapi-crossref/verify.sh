#!/usr/bin/env bash
# verify.sh — cdkd SDK-provider <-> Cloud Control API cross-reference
# boundary integ test.
#
# One stack, heterogeneous routing, Ref / Fn::GetAtt crossing the SDK <-> CC
# boundary in BOTH directions, against two kinds of CC-provisioned resource:
#
#   - Discoverer (AWS::EventSchemas::Discoverer) -> cc-api: the type has NO
#       SDK Provider, so it is pure Cloud Control fallback on a plain fresh
#       deploy.
#   - CcLambda (AWS::Lambda::Function) -> sdk in Phase 1, cc-api in Phase 2:
#       an SDK-registered type moved to Cloud Control by the explicit
#       `--recreate-via-cc-api CcLambda` flag.
#   - ExecRole (AWS::IAM::Role), Bus (AWS::Events::EventBus) and the three
#       AWS::SSM::Parameter resources -> sdk.
#
# NEITHER CC mechanism depends on a property the SDK Provider leaves
# unhandled. The fixture used to (Kinesis `DesiredShardLevelMetrics`, Lambda
# `RuntimeManagementConfig`); both were later wired into their providers and
# the run failed at its baseline. See lib/sdk-ccapi-crossref-stack.ts.
#
# Cross-refs asserted on AWS (consumer -> producer):
#   (A) SDK -> CC GetAtt: /cdkd/crossref/discoverer-id  = GetAtt(Discoverer,'DiscovererId')
#   (B) SDK -> CC Ref:    /cdkd/crossref/discoverer-arn = Ref(Discoverer)
#   (C) CC -> SDK GetAtt: Discoverer.SourceArn          = GetAtt(Bus,'Arn')
#   (D) CC -> SDK Ref:    Discoverer.Description embeds Ref(Bus)
#   (E) CC -> SDK GetAtt: CcLambda.Role               = GetAtt(ExecRole,'Arn')
#   (F) SDK -> CC GetAtt: /cdkd/crossref/fn-arn       = GetAtt(CcLambda,'Arn')
#       (E)/(F) are asserted in Phase 2, once the Lambda is on Cloud Control.
#
# Cloud Control routing BYPASSES the SDK Provider's delete() entirely, so the
# clean destroy of the CC-routed Lambda + discoverer is itself a boundary check.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD/macOS-portable: no `grep -P`, no `date -d`. Real exit codes are
# captured to variables; the script prints `[verify] PASS` ONLY on full
# success.

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

STACK="CdkdSdkCcApiCrossrefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

BUS_NAME="cdkd-crossref-bus"
FN_NAME="cdkd-crossref-fn"
ROLE_NAME="cdkd-crossref-exec-role"
DISCOVERER_ID_PARAM="/cdkd/crossref/discoverer-id"
DISCOVERER_ARN_PARAM="/cdkd/crossref/discoverer-arn"
FN_ARN_PARAM="/cdkd/crossref/fn-arn"
# Pre-repair resources. Swept (never asserted) so a leftover from a run of an
# older fixture shape cannot outlive this one (the stream shape, then the
# archive shape before go-to-k/cdkd#6578).
LEGACY_STREAM_NAME="cdkd-crossref-stream"
LEGACY_PARAM="/cdkd/crossref/stream-arn"
LEGACY_ARCHIVE_NAME="cdkd-crossref-archive"
LEGACY_ARCHIVE_PARAMS=("/cdkd/crossref/archive-arn" "/cdkd/crossref/archive-name")

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
AWS_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/cdkd-crossref-awserr.XXXXXX")"

# The bus ARN the fixture's bus has (or had): the discoverer's SourceArn.
bus_arn() {
  local account
  account=$(aws sts get-caller-identity --query Account --output text) || return 1
  printf 'arn:aws:events:%s:%s:event-bus/%s' "${REGION}" "${account}" "${BUS_NAME}"
}

# The id of every discoverer reading the fixture's bus, one per line.
discoverer_ids() {
  local arn
  arn=$(bus_arn) || return 1
  local out
  out=$(aws schemas list-discoverers --source-arn-prefix "${arn}" --region "${REGION}" \
    --query 'Discoverers[].DiscovererId' --output text) || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true
}

cleanup() {
  echo "==> Cleanup: sweeping named AWS resources, then any leftover state"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first expansion — best-effort cleanup runs with the env
  # it has.
  set +eu
  # Name sweep FIRST, state destroy after: every physical name is a fixed
  # literal above, so the sweep needs no state and still works when the state
  # record is the thing that is broken. Order: consumers before producers
  # (the discoverer's managed rule lives on the bus; the role is the Lambda's).
  # The discoverer has no name: it is found by the bus ARN it reads.
  for param in "${DISCOVERER_ID_PARAM}" "${DISCOVERER_ARN_PARAM}" "${FN_ARN_PARAM}" "${LEGACY_PARAM}" "${LEGACY_ARCHIVE_PARAMS[@]}"; do
    aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  for id in $(discoverer_ids 2>/dev/null); do
    aws schemas delete-discoverer --discoverer-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws events delete-archive --archive-name "${LEGACY_ARCHIVE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${LEGACY_STREAM_NAME}" --enforce-consumer-deletion --region "${REGION}" >/dev/null 2>&1 || true
  # DeleteRole refuses a role with an attached managed policy.
  aws iam detach-role-policy --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  : >"${AWS_ERR_FILE}" 2>/dev/null || true
  set -eu
}

trap 'cleanup; rm -f "${AWS_ERR_FILE}"' EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  exit 1
}

if [ -z "${STATE_BUCKET:-}" ]; then
  fail "STATE_BUCKET env var is required"
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  fail "local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first"
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

STATE=""
read_state() {
  STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null) || STATE=""
  if [ -z "${STATE}" ]; then
    fail "no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy"
  fi
}

# provisionedBy of the ONE record of type $1 whose AWS name (state property
# $2) is $3. Keyed on the AWS name, never the logical id. Prints '' when no
# record matches and 'AMBIGUOUS' when more than one does.
layer_of() { # usage: layer_of <resourceType> <nameProperty> <awsName>
  jq -r --arg t "$1" --arg k "$2" --arg n "$3" \
    '[.resources | to_entries[] | select(.value.resourceType == $t and .value.properties[$k] == $n) | .value.provisionedBy // ""]
     | if length > 1 then "AMBIGUOUS" else (first // "") end' <<<"${STATE}"
}

assert_layer() { # usage: assert_layer <label> <resourceType> <nameProperty> <awsName> <expected> <diagnosis>
  local got
  got=$(layer_of "$2" "$3" "$4")
  if [ "${got}" != "$5" ]; then
    jq '.resources | map_values({resourceType, physicalId, provisionedBy})' <<<"${STATE}" >&2 || true
    fail "$1 ($2 '$4') provisionedBy='${got}', expected '$5'. $6"
  fi
  echo "    OK: $1 provisionedBy == '$5'"
}

SDK_DIAG="This resource sets no property outside its SDK Provider's coverage, so it should stay on the SDK layer. Likely cause: a schema refresh made one of its template properties an SDK-unwired property, so the fresh deploy auto-routed it to Cloud Control -- look in the deploy output above for an 'Auto-routing ... via Cloud Control' line naming the property, then wire the property (src/provisioning/providers/) or drop it from lib/sdk-ccapi-crossref-stack.ts."

assert_sdk_side() {
  assert_layer "IAM Role" "AWS::IAM::Role" "RoleName" "${ROLE_NAME}" "sdk" "${SDK_DIAG}"
  assert_layer "EventBus" "AWS::Events::EventBus" "Name" "${BUS_NAME}" "sdk" "${SDK_DIAG}"
  assert_layer "SSM Parameter discoverer-id" "AWS::SSM::Parameter" "Name" "${DISCOVERER_ID_PARAM}" "sdk" "${SDK_DIAG}"
  assert_layer "SSM Parameter discoverer-arn" "AWS::SSM::Parameter" "Name" "${DISCOVERER_ARN_PARAM}" "sdk" "${SDK_DIAG}"
}

assert_discoverer_layer() {
  # Keyed on the bus ARN it reads: a discoverer has no name property.
  assert_layer "EventSchemas Discoverer" "AWS::EventSchemas::Discoverer" "SourceArn" "$(bus_arn)" "cc-api" \
    "AWS::EventSchemas::Discoverer is here BECAUSE it has no SDK Provider (pure Cloud Control fallback); this baseline does NOT depend on any property being unhandled. Likely cause: an SDK Provider for AWS::EventSchemas::Discoverer was registered in src/provisioning/register-providers.ts. Fix the FIXTURE, not the product: swap Discoverer for another cheap type that is absent from register-providers.ts, is not NON_PROVISIONABLE, consumes an ARN and exposes a read-only GetAtt attribute (lib/sdk-ccapi-crossref-stack.ts explains the requirements)."
}

# aws_text <description> aws ... : run a read, print its text output; FAIL on
# a failed read or an empty / 'None' value instead of comparing against it.
# stderr goes to a file, not into the value: a CLI warning on stderr must not
# become part of the string an equality check compares.
aws_text() {
  local desc="$1" out
  shift
  if ! out=$("$@" --output text 2>"${AWS_ERR_FILE}"); then
    fail "could not read ${desc} from AWS: $(cat "${AWS_ERR_FILE}" 2>/dev/null)"
  fi
  if [ -z "${out}" ] || [ "${out}" = "None" ]; then
    fail "${desc} is empty on AWS"
  fi
  printf '%s' "${out}"
}

assert_discoverer_crossrefs() {
  local real_bus_arn ids id real_discoverer_arn got
  real_bus_arn=$(aws_text "event bus ARN" aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" --query 'Arn')
  ids=$(discoverer_ids)
  if [ "$(printf '%s\n' "${ids}" | grep -c .)" != "1" ]; then
    fail "expected exactly one discoverer on ${real_bus_arn}, found: '${ids}'"
  fi
  id="${ids}"
  real_discoverer_arn=$(aws_text "discoverer ARN" aws schemas describe-discoverer --discoverer-id "${id}" --region "${REGION}" --query 'DiscovererArn')

  # (A) SDK -> CC GetAtt. `DiscovererId` is a read-only attribute: it reaches
  # state only through the Cloud Control read-back, and a miss resolves to the
  # bare physical id (the discoverer ARN), which this equality rejects.
  got=$(aws_text "SSM parameter ${DISCOVERER_ID_PARAM}" aws ssm get-parameter --name "${DISCOVERER_ID_PARAM}" --region "${REGION}" --query 'Parameter.Value')
  if [ "${got}" != "${id}" ]; then
    fail "cross-ref A (SDK->CC GetAtt) wrong: ${DISCOVERER_ID_PARAM}='${got}', expected DiscovererId='${id}'. A value equal to the discoverer ARN means Fn::GetAtt fell back to the physical id: the Cloud Control read-back did not record 'DiscovererId' (src/provisioning/cloud-control-provider.ts mergeSparseModelReadback / the resolver's GetAtt miss path)."
  fi
  echo "    OK: cross-ref A (SDK->CC) Fn::GetAtt(Discoverer,'DiscovererId') == the real discoverer id"

  # (B) SDK -> CC Ref.
  got=$(aws_text "SSM parameter ${DISCOVERER_ARN_PARAM}" aws ssm get-parameter --name "${DISCOVERER_ARN_PARAM}" --region "${REGION}" --query 'Parameter.Value')
  if [ "${got}" != "${real_discoverer_arn}" ]; then
    fail "cross-ref B (SDK->CC Ref) wrong: ${DISCOVERER_ARN_PARAM}='${got}', expected Ref(Discoverer)='${real_discoverer_arn}'"
  fi
  echo "    OK: cross-ref B (SDK->CC) Ref(Discoverer) == the discoverer ARN"

  # (C) CC -> SDK GetAtt.
  got=$(aws_text "discoverer SourceArn" aws schemas describe-discoverer --discoverer-id "${id}" --region "${REGION}" --query 'SourceArn')
  if [ "${got}" != "${real_bus_arn}" ]; then
    fail "cross-ref C (CC->SDK GetAtt) wrong: discoverer SourceArn='${got}', expected bus Arn='${real_bus_arn}'"
  fi
  echo "    OK: cross-ref C (CC->SDK) Fn::GetAtt(Bus,'Arn') == the real event bus ARN"

  # (D) CC -> SDK Ref.
  got=$(aws_text "discoverer Description" aws schemas describe-discoverer --discoverer-id "${id}" --region "${REGION}" --query 'Description')
  if [ "${got}" != "discoverer of ${BUS_NAME}" ]; then
    fail "cross-ref D (CC->SDK Ref) wrong: discoverer Description='${got}', expected 'discoverer of ${BUS_NAME}'"
  fi
  echo "    OK: cross-ref D (CC->SDK) Ref(Bus) == the event bus name"
}

# --- Phase 1: plain deploy ------------------------------------------------
echo "==> Phase 1: plain deploy (Discoverer -> Cloud Control fallback, everything else -> SDK)"
CDKD_INTEG_PHASE=base node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

read_state
assert_discoverer_layer
assert_sdk_side
assert_layer "Lambda (Phase 1)" "AWS::Lambda::Function" "FunctionName" "${FN_NAME}" "sdk" \
  "Phase 2's --recreate-via-cc-api seed is refused for a resource already on cc-api, so the Lambda must start on the SDK layer. ${SDK_DIAG}"
echo "    OK: heterogeneous routing in one plain deploy (1x cc-api, 5x sdk)"
assert_discoverer_crossrefs

LAST_MOD_1=$(aws_text "Lambda LastModified" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified')

# --- Phase 2: move the Lambda to Cloud Control ------------------------------
# The seed template carries a real property delta (RuntimeManagementConfig),
# the AWS-side witness of the recreate. (Before go-to-k/cdkd#2651 was fixed it
# was also what made the recreate flag act at all.)
echo "==> Phase 2: re-deploy with --recreate-via-cc-api CcLambda (SDK-registered type onto Cloud Control) + add FnArnParam"
CDKD_INTEG_PHASE=seed node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api CcLambda \
  --yes

read_state
assert_layer "Lambda (Phase 2)" "AWS::Lambda::Function" "FunctionName" "${FN_NAME}" "cc-api" \
  "The --recreate-via-cc-api seed did not seed, so cross-refs E/F below would be vacuous. Likely cause: --recreate-via-cc-api regressed, including a return of go-to-k/cdkd#2651 (run the recreate-via-cc-api and cc-to-sdk-reroute fixtures). This step does NOT depend on any property being unhandled by the SDK provider."
assert_discoverer_layer
assert_sdk_side
assert_layer "SSM Parameter fn-arn" "AWS::SSM::Parameter" "Name" "${FN_ARN_PARAM}" "sdk" "${SDK_DIAG}"
echo "    OK: heterogeneous routing (2x cc-api, 5x sdk)"

LAST_MOD_2=$(aws_text "Lambda LastModified" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified')
if [ "${LAST_MOD_2}" = "${LAST_MOD_1}" ]; then
  fail "Lambda LastModified unchanged across --recreate-via-cc-api ('${LAST_MOD_1}'): expected a destroy + recreate to produce a new function"
fi
echo "    OK: Lambda was destroyed + recreated (LastModified changed)"

# The record says cc-api AND the Cloud Control create really carried the
# property map to AWS.
RTM_UPDATE_ON=$(aws_text "Lambda UpdateRuntimeOn" aws lambda get-runtime-management-config --function-name "${FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn')
if [ "${RTM_UPDATE_ON}" != "FunctionUpdate" ]; then
  fail "Lambda RuntimeManagementConfig.UpdateRuntimeOn='${RTM_UPDATE_ON}', expected 'FunctionUpdate' (the Cloud Control create did not carry the property to AWS)"
fi
echo "    OK: Lambda RuntimeManagementConfig.UpdateRuntimeOn == 'FunctionUpdate' on AWS"

# (E) CC -> SDK GetAtt, SDK-registered type on CC.
REAL_ROLE_ARN=$(aws_text "IAM role ARN" aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn')
FN_ROLE=$(aws_text "Lambda role" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'Role')
if [ "${FN_ROLE}" != "${REAL_ROLE_ARN}" ]; then
  fail "cross-ref E (CC->SDK GetAtt) wrong: Lambda role='${FN_ROLE}', expected role Arn='${REAL_ROLE_ARN}'"
fi
echo "    OK: cross-ref E (CC->SDK) Fn::GetAtt(ExecRole,'Arn') == the real role ARN"

# (F) SDK -> CC GetAtt, SDK-registered type on CC. Under Cloud Control the
# Lambda's physical id is the function NAME and no SDK create() wrote a typed
# `Arn` attribute, so a miss shows up here as the bare name.
REAL_FN_ARN=$(aws_text "Lambda ARN" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'FunctionArn')
FN_ARN_VALUE=$(aws_text "SSM parameter ${FN_ARN_PARAM}" aws ssm get-parameter --name "${FN_ARN_PARAM}" --region "${REGION}" --query 'Parameter.Value')
if [ "${FN_ARN_VALUE}" != "${REAL_FN_ARN}" ]; then
  fail "cross-ref F (SDK->CC GetAtt) wrong: ${FN_ARN_PARAM}='${FN_ARN_VALUE}', expected function Arn='${REAL_FN_ARN}'. A value equal to the function NAME means Fn::GetAtt fell back to the physical id of the Cloud-Control-created record."
fi
echo "    OK: cross-ref F (SDK->CC) Fn::GetAtt(CcLambda,'Arn') == the real function ARN"

# The discoverer's cross-refs must survive a deploy that did not touch it.
assert_discoverer_crossrefs

# --- Phase 3: destroy -------------------------------------------------------
# Cloud Control routing bypasses the SDK delete() entirely: the Lambda and the
# discoverer both leave through the CC delete path.
echo "==> Phase 3: destroy"
CDKD_INTEG_PHASE=seed node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

LEFT_DISCOVERERS=$(discoverer_ids) || fail "could not list discoverers after destroy"
if [ -n "${LEFT_DISCOVERERS}" ]; then
  fail "EventSchemas discoverer(s) still exist after destroy: ${LEFT_DISCOVERERS}"
fi
echo "    OK: EventSchemas discoverer is gone"

assert_gone "Event bus ${BUS_NAME} still exists after destroy" aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"
echo "    OK: Event bus is gone"

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: Lambda function is gone"

assert_gone "IAM role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
echo "    OK: IAM role is gone"

for param in "${DISCOVERER_ID_PARAM}" "${DISCOVERER_ARN_PARAM}" "${FN_ARN_PARAM}"; do
  assert_gone "SSM parameter ${param} still exists after destroy" aws ssm get-parameter --name "${param}" --region "${REGION}"
  echo "    OK: SSM parameter ${param} is gone"
done

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS: sdk-ccapi-crossref (heterogeneous routing + bidirectional Ref/GetAtt cross-ref resolution + clean CC-path destroy)"
