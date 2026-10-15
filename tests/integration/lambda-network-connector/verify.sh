#!/usr/bin/env bash
# verify.sh — cdkd Lambda network connector SDK provider integ (go-to-k/cdkd#4928).
#
# The previous release (Cloud Control) creates the connector, so its record
# starts pinned to cc-api. This build's next deploy changes only the tag (a new
# key, so the old one is untagged): the 'sdk-coverage' sticky exemption moves
# the record to the SDK provider, which must address the connector Cloud
# Control created (same ARN, the witness). A later deploy moves the connector
# to another subnet pair through UpdateNetworkConnector (a new connector
# version; AWS refuses a change of AssociatedComputeResourceTypes on an
# existing connector, measured), `cdkd drift` compares it, and destroy deletes
# it through the SDK provider. A last phase creates a fresh connector through
# the SDK provider and destroys it again.
#
# The connector lives in the account's default VPC; its subnets and default
# security group are looked up here, so the stack creates no VPC resource.

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

STACK="CdkdLambdaNetworkConnectorExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="cdkd-integ-nc-operator-${REGION}"
# Per run: a connector that ends FAILED was measured to stay DELETING for over
# an hour, holding its name, so a fixed name would block the next run.
CONNECTOR_NAME="cdkd-integ-nc-$(date +%s)"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
OLD_CDKD_VERSION="${OLD_CDKD_VERSION:-0.299.7}"
OLD_TMPDIR=""

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # Best effort; the delete settles in seconds and nothing below depends on it.
  aws lambda-core delete-network-connector --identifier "${CONNECTOR_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name eni >/dev/null 2>&1
  for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  if [ -n "${OLD_TMPDIR:-}" ] && [ -d "${OLD_TMPDIR}" ]; then
    rm -rf "${OLD_TMPDIR}"
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

echo "==> Default VPC subnets and security group"
VPC_ID="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --region "${REGION}" --query 'Vpcs[0].VpcId' --output text)"
case "${VPC_ID}" in vpc-*) ;; *) echo "FAIL: no default VPC in ${REGION} (${VPC_ID})" >&2; exit 1 ;; esac
SUBNET_IDS="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" --region "${REGION}" \
  --query 'sort_by(Subnets, &SubnetId)[0:2].SubnetId' --output text | tr '\t' ',')"
case "${SUBNET_IDS}" in subnet-*,subnet-*) ;; *) echo "FAIL: need two subnets in ${VPC_ID} (${SUBNET_IDS})" >&2; exit 1 ;; esac
# The pair phase 3 moves the connector to: the second and third subnets.
SUBNET_IDS_ALT="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" --region "${REGION}" \
  --query 'sort_by(Subnets, &SubnetId)[1:3].SubnetId' --output text | tr '\t' ',')"
case "${SUBNET_IDS_ALT}" in subnet-*,subnet-*) ;; *) echo "FAIL: need three subnets in ${VPC_ID} (${SUBNET_IDS_ALT})" >&2; exit 1 ;; esac
SECURITY_GROUP_ID="$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${VPC_ID}" Name=group-name,Values=default \
  --region "${REGION}" --query 'SecurityGroups[0].GroupId' --output text)"
case "${SECURITY_GROUP_ID}" in sg-*) ;; *) echo "FAIL: no default security group in ${VPC_ID}" >&2; exit 1 ;; esac
echo "    ${VPC_ID}: ${SUBNET_IDS} / ${SECURITY_GROUP_ID}"

deploy() { # usage: deploy <cli.js> [VAR=value ...]
  local cli="$1"
  shift
  env CONNECTOR_NAME="${CONNECTOR_NAME}" SUBNET_IDS="${SUBNET_IDS}" SECURITY_GROUP_ID="${SECURITY_GROUP_ID}" "$@" \
    node "${cli}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1
}

# A field of the connector's state record.
record() { # usage: record <jq-expression-over-the-resource-object>
  local json
  json="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${json}" | jq -r ".resources.Connector | $1"
}

# A field of the live connector the state record names, read through Cloud
# Control: the installed AWS CLI's lambda-core model does not return
# LatestVersionArn (measured), while the Cloud Control read handler does.
live() { # usage: live <jq-expression-over-the-properties>
  local arn props
  arn="$(record '.physicalId')" || return 1
  props="$(aws cloudcontrol get-resource --type-name AWS::Lambda::NetworkConnector --identifier "${arn}" \
    --region "${REGION}" --query 'ResourceDescription.Properties' --output text)" || return 1
  printf '%s' "${props}" | jq -r "$1"
}

echo "==> Installing the previous release (@go-to-k/cdkd@${OLD_CDKD_VERSION})"
OLD_TMPDIR="$(mktemp -d)"
(cd "${OLD_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${OLD_CDKD_VERSION}" >/dev/null)
OLD_BIN="${OLD_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${OLD_BIN}" ]; then
  echo "FAIL: the previous release was not installed at ${OLD_BIN}" >&2
  exit 1
fi
OLD_REPORTED="$(node "${OLD_BIN}" --version)"
case "${OLD_REPORTED}" in
  *"${OLD_CDKD_VERSION}"*) ;;
  *)
    echo "FAIL: the installed old binary reports '${OLD_REPORTED}', not ${OLD_CDKD_VERSION}" >&2
    exit 1
    ;;
esac

echo "==> Phase 1: create the connector with the previous release (Cloud Control)"
OUT="$(deploy "${OLD_BIN}")" || { echo "${OUT}"; echo "FAIL: phase 1 deploy" >&2; exit 1; }
echo "${OUT}"
ARN1="$(record '.physicalId')"
ROUTE="$(record '.provisionedBy')"
[ "${ROUTE}" = "cc-api" ] || { echo "FAIL: phase 1 recorded provisionedBy=${ROUTE}, expected cc-api" >&2; exit 1; }
[ "$(live .State)" = "ACTIVE" ] || { echo "FAIL: the connector is not ACTIVE after phase 1" >&2; exit 1; }
echo "    OK: ${ARN1} ACTIVE, recorded on cc-api"

echo "==> Phase 2: a tags-only change with this build moves the record to the SDK provider"
T0="$(date +%s)"
OUT="$(deploy "${LOCAL_DIST}" TAG_KEY=cdkd-integ-2 TAG_VALUE=v2)" || { echo "${OUT}"; echo "FAIL: phase 2 deploy" >&2; exit 1; }
echo "${OUT}"
echo "    phase 2 deploy took $(($(date +%s) - T0)) s"
ROUTE="$(record '.provisionedBy')"
[ "${ROUTE}" = "sdk" ] || { echo "FAIL: phase 2 recorded provisionedBy=${ROUTE}, expected sdk" >&2; exit 1; }
# The witness (provisioning-sticky-routing.md): the SDK provider updated the
# connector Cloud Control created, so the AWS-minted ARN is unchanged.
ARN2="$(record '.physicalId')"
[ "${ARN2}" = "${ARN1}" ] || { echo "FAIL: the connector was recreated on the route change (${ARN1} -> ${ARN2})" >&2; exit 1; }
TAGS="$(aws lambda list-tags --resource "${ARN1}" --region "${REGION}" --output json | jq -c '.Tags | with_entries(select(.key | startswith("aws:") | not))')"
[ "${TAGS}" = '{"cdkd-integ-2":"v2"}' ] || { echo "FAIL: the connector's tags are ${TAGS}, expected only cdkd-integ-2=v2" >&2; exit 1; }
echo "    OK: same ARN, recorded on sdk, old tag key removed and new one set"

echo "==> Phase 3: move the connector to another subnet pair (UpdateNetworkConnector, a new version)"
# GetNetworkConnector returns the qualified LatestVersionArn but no
# LatestVersion number (measured), so the version is its `:<n>` suffix.
version_of() { printf '%s' "${1##*:}"; }
V_BEFORE="$(version_of "$(live .LatestVersionArn)")"
T0="$(date +%s)"
OUT="$(deploy "${LOCAL_DIST}" TAG_KEY=cdkd-integ-2 TAG_VALUE=v2 SUBNET_IDS="${SUBNET_IDS_ALT}")" || { echo "${OUT}"; echo "FAIL: phase 3 deploy" >&2; exit 1; }
echo "${OUT}"
echo "    phase 3 deploy took $(($(date +%s) - T0)) s"
V_AFTER="$(version_of "$(live .LatestVersionArn)")"
[ "${V_AFTER}" -gt "${V_BEFORE}" ] || { echo "FAIL: LatestVersion stayed ${V_BEFORE} after the configuration change" >&2; exit 1; }
LIVE_SUBNETS="$(live '.Configuration.VpcEgressConfiguration.SubnetIds | sort | join(",")')"
[ "${LIVE_SUBNETS}" = "${SUBNET_IDS_ALT}" ] || { echo "FAIL: live SubnetIds is ${LIVE_SUBNETS}, expected ${SUBNET_IDS_ALT}" >&2; exit 1; }
[ "$(live .State)" = "ACTIVE" ] || { echo "FAIL: the connector is not ACTIVE after the update" >&2; exit 1; }
RECORDED_V="$(record '.attributes.LatestVersion')"
[ "${RECORDED_V}" = "${V_AFTER}" ] || { echo "FAIL: state records LatestVersion ${RECORDED_V}, live is ${V_AFTER}" >&2; exit 1; }
echo "    OK: version ${V_BEFORE} -> ${V_AFTER}, subnets moved, recorded"

echo "==> Phase 4: cdkd drift compares the connector and finds nothing"
DRIFT_OUT="$(env CONNECTOR_NAME="${CONNECTOR_NAME}" SUBNET_IDS="${SUBNET_IDS_ALT}" SECURITY_GROUP_ID="${SECURITY_GROUP_ID}" TAG_KEY=cdkd-integ-2 TAG_VALUE=v2 \
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || {
  echo "${DRIFT_OUT}"
  echo "FAIL: cdkd drift reported drift (or failed) right after a deploy" >&2
  exit 1
}
echo "${DRIFT_OUT}"
# Exit 0 also covers a resource drift could not compare, so require both
# resources of the stack (the role and the connector) to have been compared.
if ! sed $'s/\x1b\\[[0-9;]*m//g' <<<"${DRIFT_OUT}" | grep -qF '(2 resources checked, 0 unsupported)'; then
  echo "FAIL: drift did not compare both resources -- expected '(2 resources checked, 0 unsupported)'" >&2
  exit 1
fi
echo "    OK: no drift, both resources compared"

echo "==> Destroy"
T0="$(date +%s)"
env CONNECTOR_NAME="${CONNECTOR_NAME}" SUBNET_IDS="${SUBNET_IDS_ALT}" SECURITY_GROUP_ID="${SECURITY_GROUP_ID}" TAG_KEY=cdkd-integ-2 TAG_VALUE=v2 \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
echo "    destroy took $(($(date +%s) - T0)) s"

assert_gone "connector ${ARN1} still exists after destroy" \
  aws lambda-core get-network-connector --identifier "${ARN1}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: connector, role and state gone"

echo "==> Phase 5: a fresh connector created through the SDK provider"
# The role first, then a wait: a connector created right after its operator
# role can end FAILED when the role's ENI permissions have not propagated to
# the provisioning step (measured once; the synchronous check, which the
# engine retries, had already passed). That race is the role's, not the
# provider's, and is not what this phase measures.
OUT="$(deploy "${LOCAL_DIST}" ROLE_ONLY=1)" || { echo "${OUT}"; echo "FAIL: phase 5 role deploy" >&2; exit 1; }
sleep 30
T0="$(date +%s)"
OUT="$(deploy "${LOCAL_DIST}")" || { echo "${OUT}"; echo "FAIL: phase 5 deploy" >&2; exit 1; }
echo "${OUT}"
echo "    phase 5 deploy took $(($(date +%s) - T0)) s"
ROUTE="$(record '.provisionedBy')"
[ "${ROUTE}" = "sdk" ] || { echo "FAIL: phase 5 recorded provisionedBy=${ROUTE}, expected sdk" >&2; exit 1; }
ARN5="$(record '.physicalId')"
[ "${ARN5}" != "${ARN1}" ] || { echo "FAIL: phase 5 recorded the destroyed connector ${ARN1}" >&2; exit 1; }
[ "$(live .State)" = "ACTIVE" ] || { echo "FAIL: the SDK-created connector is not ACTIVE" >&2; exit 1; }
TAG="$(aws lambda list-tags --resource "${ARN5}" --region "${REGION}" --query 'Tags."cdkd-integ"' --output text)"
[ "${TAG}" = "v1" ] || { echo "FAIL: the SDK-created connector's tag is '${TAG}', expected v1" >&2; exit 1; }
echo "    OK: ${ARN5} ACTIVE, recorded on sdk, tagged"
env CONNECTOR_NAME="${CONNECTOR_NAME}" SUBNET_IDS="${SUBNET_IDS}" SECURITY_GROUP_ID="${SECURITY_GROUP_ID}" \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "connector ${ARN5} still exists after the second destroy" \
  aws lambda-core get-network-connector --identifier "${ARN5}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after the second destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state remains after the second destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: second connector, role and state gone"
trap - EXIT INT TERM
rm -rf "${OLD_TMPDIR}"
echo ""
echo "[verify] PASS — lambda-network-connector: a connector created on Cloud Control moves to the SDK provider, updates its tags and subnets, reports no drift and is deleted; a fresh one is created and deleted through the SDK provider (#4928)"
