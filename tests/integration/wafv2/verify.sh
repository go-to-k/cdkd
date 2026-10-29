#!/bin/bash
# cdkd integration test: AWS::WAFv2::WebACL (issue #2762 property backfill).
#
# The fixture used to run the standard deploy/destroy flow, which proves the
# Rules-tree conversions (issue #1389: a pre-fix CreateWebACL fails) but reads
# nothing back. This script keeps that deploy and destroy, and adds the
# read-backs issue #2762 needs for two of the web ACL members it wires into the
# SDK provider:
#
#   DataProtectionConfig, OnSourceDDoSProtectionConfig
#
# Before #2762 each was a silent drop that routed the WHOLE web ACL through
# Cloud Control, which configures the same live web ACL -- so the
# `provisionedBy=sdk` assertion, the first check after the deploy, is what
# tells the fix from that fallback.
#
# Phases:
#   1  deploy; assert the SDK route, then both members on GetWebACL; drift of
#      the two against their TEMPLATED values must be clean
#   2  CDKD_TEST_WAF_UPDATE=true: data protection changed, the DDoS mode
#      unchanged. UpdateWebACL replaces the web ACL whole, so the unchanged
#      OnSourceDDoSProtectionConfig must still read ALWAYS_ON (re-sent)
#   3  CDKD_TEST_WAF_REMOVAL=true: both dropped from the template. Data
#      protection is cleared and the DDoS mode leaves ALWAYS_ON (whole
#      replacement)
#   4  destroy; assert every resource and the state file are gone
#
# ApplicationConfig and MonetizationConfig are wired too but unit-tested only
# (see lib/wafv2-stack.ts). For ApplicationConfig, AWS refuses arbitrary
# attribute names and publishes no allowed set. Measured 2026-10-30: the create
# was refused with a 400 `WAFInvalidParameterException` naming
# `ApplicationAttribute` on both the Cloud Control and SDK routes, and on three
# shapes sent directly with the AWS CLI. MonetizationConfig needs account-level
# payment setup.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="Wafv2Stack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
WEB_ACL_NAME="cdkd-test-webacl-${ACCOUNT_ID}"
IP_SET_NAME="cdkd-test-blocked-ips-${ACCOUNT_ID}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Delete a REGIONAL WAFv2 entity by name (best effort). WAFv2 deletes need the
# id and a fresh lock token, so a name alone is resolved through list + get.
# The CLI does not paginate WAFv2 lists (100 per page), so NextMarker is
# followed: on a shared account the entity can sit past the first page.
sweep_waf() { # usage: sweep_waf <web-acl|ip-set> <name>
  local kind="$1" name="$2" list_key listing id="" token marker="" pages=0
  case "${kind}" in
    web-acl) list_key="WebACLs" ;;
    ip-set) list_key="IPSets" ;;
  esac
  while [ "${pages}" -lt 50 ]; do
    pages=$((pages + 1))
    if [ -n "${marker}" ]; then
      listing="$(aws wafv2 "list-${kind}s" --scope REGIONAL --region "${REGION}" \
        --next-marker "${marker}" --output json)" || return 0
    else
      listing="$(aws wafv2 "list-${kind}s" --scope REGIONAL --region "${REGION}" --output json)" || return 0
    fi
    id="$(printf '%s' "${listing}" \
      | jq -r --arg n "${name}" --arg k "${list_key}" 'first(.[$k][]? | select(.Name == $n) | .Id) // empty')"
    [ -n "${id}" ] && break
    marker="$(printf '%s' "${listing}" | jq -r '.NextMarker // empty')"
    [ -n "${marker}" ] || return 0
  done
  [ -n "${id}" ] || return 0
  token="$(aws wafv2 "get-${kind}" --scope REGIONAL --region "${REGION}" --name "${name}" --id "${id}" \
    --query LockToken --output text 2>/dev/null)"
  [ -n "${token}" ] || return 0
  aws wafv2 "delete-${kind}" --scope REGIONAL --region "${REGION}" --name "${name}" --id "${id}" \
    --lock-token "${token}" >/dev/null 2>&1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  state_destroy_rc=1
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    # `--state-bucket` is REQUIRED: without it the command resolves cdk.json's
    # placeholder `cdkd-state-test` and a torn run leaks every resource.
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    state_destroy_rc=$?
  fi
  # Belt-and-braces for a torn run: the web ACL first, since an IP set a web
  # ACL references cannot be deleted. The association goes with its stage.
  sweep_waf web-acl "${WEB_ACL_NAME}"
  sweep_waf ip-set "${IP_SET_NAME}"
  rm -f "${STATE_TMP_IN:-}" "${STATE_TMP_OUT:-}"
  if [ -n "${STATE_BUCKET:-}" ]; then
    # state.json is gated on the destroy SUCCEEDING: it is the only pointer to
    # resources a failed destroy left behind.
    if [ "${state_destroy_rc:-1}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    # lock.json is swept UNCONDITIONALLY: it points at nothing, and a stranded
    # lock makes `state destroy` itself exit non-zero.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} -- run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# The web ACL's ARN as the state records it (its physical id). Read fresh each
# time: it never changes across these phases, but a missing record must fail
# here rather than send an empty id to GetWebACL (an empty CLI arg can hang);
# its callers must test its status (see acl_field).
web_acl_id() {
  local arn
  arn="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r '.resources.WebAcl.physicalId // empty')"
  if [ -z "${arn}" ]; then
    echo "FAIL: the state has no physical id for WebAcl" >&2
    exit 1
  fi
  printf '%s' "${arn##*/}"
}

# `get-web-acl` ERRORS (WAFNonexistentItemException) on a missing web ACL, so
# under `set -e` an unreachable web ACL aborts rather than reading as "absent".
acl_field() { # usage: acl_field <jq-path>
  local id
  # `|| return 1`: `set -e` is off inside the `$(acl_field ...)` that
  # assert_acl runs this in, so web_acl_id's exit alone would not stop it.
  id="$(web_acl_id)" || return 1
  aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" \
    --name "${WEB_ACL_NAME}" --id "${id}" --output json \
    | jq -c "(.WebACL | $1)"
}

assert_acl() { # usage: assert_acl <description> <jq-path> <expected compact JSON>
  local desc="$1" path="$2" want="$3" got
  got="$(acl_field "${path}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${desc}: expected '${want}', got '${got}'" >&2
    exit 1
  fi
  echo "    ok: ${desc} = ${got}"
}

assert_sdk_route() {
  local by
  by="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r '.resources.WebAcl.provisionedBy // "<absent>"')"
  if [ "${by}" != "sdk" ]; then
    echo "FAIL: AWS::WAFv2::WebACL routing layer is '${by}', expected 'sdk' (a #2762 property still routes it to Cloud Control)" >&2
    exit 1
  fi
  echo "    ok: web ACL stayed on the SDK route"
}

drift_clean() { # usage: drift_clean <description> [env assignments...]
  local desc="$1"
  shift
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}"
  echo "    ok: ${desc}"
}


# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 1: assert the #2762 members reached AWS"
assert_sdk_route
assert_acl "DataProtections count" '(.DataProtectionConfig.DataProtections | length)' '2'
assert_acl "DataProtections[0] header field" \
  '.DataProtectionConfig.DataProtections[0].Field | {FieldType, FieldKeys}' \
  '{"FieldType":"SINGLE_HEADER","FieldKeys":["authorization"]}'
assert_acl "DataProtections[0] action" '.DataProtectionConfig.DataProtections[0].Action' '"HASH"'
assert_acl "DataProtections[0] ExcludeRuleMatchDetails" \
  '.DataProtectionConfig.DataProtections[0].ExcludeRuleMatchDetails' 'true'
assert_acl "DataProtections[1] field type" \
  '.DataProtectionConfig.DataProtections[1].Field.FieldType' '"QUERY_STRING"'
assert_acl "DataProtections[1] action" '.DataProtectionConfig.DataProtections[1].Action' '"SUBSTITUTION"'
assert_acl "ALBLowReputationMode" '.OnSourceDDoSProtectionConfig.ALBLowReputationMode' '"ALWAYS_ON"'

echo "==> Phase 1: drift of the #2762 members against their TEMPLATE values must be clean"
# With the deploy-time observedProperties as the baseline, both sides come from
# the same readCurrentState and the check could not fail. So the two members'
# baseline is overwritten with their TEMPLATED values: a reordered list, or an
# echoed Exclude* default the read-back failed to drop (the second
# data-protection entry leaves both booleans out), then shows up as drift.
# Only these two are swapped, so the rest of the web ACL keeps its observed
# baseline and cannot fail this phase for a reason that predates #2762.
STATE_TMP_IN="${TMPDIR:-/tmp}/cdkd-2762-waf-state-in.$$.json"
STATE_TMP_OUT="${TMPDIR:-/tmp}/cdkd-2762-waf-state-out.$$.json"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_TMP_IN}" --region "${REGION}" >/dev/null
if [ "$(jq -r '.resources.WebAcl.observedProperties | type' "${STATE_TMP_IN}")" != "object" ]; then
  echo "FAIL: the WebAcl record has no observedProperties to overwrite -- the drift assertion would be vacuous" >&2
  rm -f "${STATE_TMP_IN}" "${STATE_TMP_OUT}"
  exit 1
fi
if [ "$(jq -r '.resources.WebAcl.properties | [.DataProtectionConfig, .OnSourceDDoSProtectionConfig] | map(type) | join(",")' "${STATE_TMP_IN}")" != "object,object" ]; then
  echo "FAIL: the WebAcl record's templated properties lack a #2762 member -- the drift assertion would be vacuous" >&2
  rm -f "${STATE_TMP_IN}" "${STATE_TMP_OUT}"
  exit 1
fi
jq '.resources.WebAcl.observedProperties += (.resources.WebAcl.properties | {DataProtectionConfig, OnSourceDDoSProtectionConfig})' \
  "${STATE_TMP_IN}" > "${STATE_TMP_OUT}"
aws s3 cp "${STATE_TMP_OUT}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
rm -f "${STATE_TMP_IN}" "${STATE_TMP_OUT}"
drift_clean "template-baseline drift clean with the #2762 members"

# --- Phase 2: update ---------------------------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_WAF_UPDATE=true (data protection changed)"
CDKD_TEST_WAF_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route
assert_acl "DataProtections count after update" '(.DataProtectionConfig.DataProtections | length)' '1'
assert_acl "DataProtections[0] action after update" \
  '.DataProtectionConfig.DataProtections[0].Action' '"SUBSTITUTION"'
# The whole-replacement hazard: an unchanged member the update failed to
# re-send would be reset by AWS.
assert_acl "ALBLowReputationMode re-sent unchanged" \
  '.OnSourceDDoSProtectionConfig.ALBLowReputationMode' '"ALWAYS_ON"'
drift_clean "drift clean after the update" CDKD_TEST_WAF_UPDATE=true

# --- Phase 3: removal --------------------------------------------------------
echo "==> Phase 3: redeploy with CDKD_TEST_WAF_REMOVAL=true (both dropped)"
CDKD_TEST_WAF_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_acl "DataProtectionConfig cleared" '.DataProtectionConfig' 'null'
DDOS_MODE="$(acl_field '.OnSourceDDoSProtectionConfig.ALBLowReputationMode')"
if [ "${DDOS_MODE}" = '"ALWAYS_ON"' ]; then
  echo "FAIL: ALBLowReputationMode is still ALWAYS_ON after its removal from the template" >&2
  exit 1
fi
echo "    ok: ALBLowReputationMode left ALWAYS_ON (now ${DDOS_MODE})"
drift_clean "drift clean after the removal" CDKD_TEST_WAF_REMOVAL=true

# --- Phase 4: destroy --------------------------------------------------------
WEB_ACL_ID="$(web_acl_id)"
REST_API_ID="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGateway::RestApi") | .value.physicalId] | first // empty')"
if [ -z "${REST_API_ID}" ]; then
  echo "FAIL: the state has no AWS::ApiGateway::RestApi physical id" >&2
  exit 1
fi
# The IP set's id, read from its state record: an ARN (`.../ipset/<name>/<id>`)
# on the SDK route, or CloudFormation's `<name>|<id>|<scope>` on Cloud Control.
IP_SET_PHYSICAL_ID="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::WAFv2::IPSet") | .value.physicalId] | first // empty')"
case "${IP_SET_PHYSICAL_ID}" in
  *"|"*) IP_SET_ID="$(printf '%s' "${IP_SET_PHYSICAL_ID}" | cut -d'|' -f2)" ;;
  arn:*) IP_SET_ID="${IP_SET_PHYSICAL_ID##*/}" ;;
  *) IP_SET_ID="" ;;
esac
if [ -z "${IP_SET_ID}" ]; then
  echo "FAIL: cannot read the IP set id from its state physical id '${IP_SET_PHYSICAL_ID}'" >&2
  exit 1
fi
echo "==> Phase 4: destroy"
CDKD_TEST_WAF_REMOVAL=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

echo "==> Phase 4: assert every resource is gone"
assert_gone "web ACL ${WEB_ACL_NAME} survived destroy" \
  aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" \
  --name "${WEB_ACL_NAME}" --id "${WEB_ACL_ID}"
assert_gone "IP set ${IP_SET_NAME} survived destroy" \
  aws wafv2 get-ip-set --scope REGIONAL --region "${REGION}" \
  --name "${IP_SET_NAME}" --id "${IP_SET_ID}"
echo "    ok: IP set gone"
assert_gone "REST API ${REST_API_ID} survived destroy" \
  aws apigateway get-rest-api --rest-api-id "${REST_API_ID}" --region "${REGION}"
echo "    ok: REST API gone"

echo "==> Phase 4: assert state was removed"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: WAFv2 web ACL DataProtectionConfig / OnSourceDDoSProtectionConfig verified on create, update and removal"
