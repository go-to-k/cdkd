#!/usr/bin/env bash
# verify.sh — `cdkd orphan` after an out-of-band NAME takeover (issue #4186).
#
# `cdkd orphan` rewrites every sibling `Fn::GetAtt` to the orphaned resource
# into a literal. It used to take that literal from a LIVE
# `provider.getAttribute(...)`, which most SDK providers address by the
# recorded NAME: once the resource was deleted out of band and another one took
# its name, the rewrite planted the NEWCOMER's attribute into the sibling's
# state. It now takes the orphan's RECORDED attribute whenever the resolver
# would, and reads live only otherwise.
#
# Phases:
#   1. Deploy an IAM role with a fixed name and an SSM parameter whose value is
#      `Fn::GetAtt [Role, RoleId]`. Assert the recorded RoleId equals the live
#      one and the parameter holds it.
#   1b. A deploy persists RESOLVED properties, so the parameter row holds the
#      id, not the intrinsic. The rewrite acts on a row whose intrinsic
#      SURVIVED (a `cdkd import` that could not resolve it, a pre-v3 record),
#      so the row is put in that shape by hand: its `Value` becomes
#      `{"Fn::GetAtt": [<role>, "RoleId"]}` again. The log-group-ARN
#      parameter's row likewise, and the log group's recorded `Arn` is
#      removed (a record that predates the attribute).
#   1c. The two subnet-attribute parameters' rows likewise get a surviving
#      `Fn::GetAtt [<subnet>, Ipv6CidrBlocks]` / `[..., NetworkAclAssociationId]`
#      (issue #5968). Phase 1 already asserted the deployed values equal the
#      live ones (the deploy resolver's read, #5944).
#   2. Take the name over: delete the role out of band and create another under
#      the same name. Assert its RoleId DIFFERS from the recorded one (premise).
#   3. `cdkd orphan <stack>/Role`.
#   4. LOAD-BEARING: the parameter's state row holds the RECORDED RoleId as a
#      literal, never the newcomer's.
#   4b. LOAD-BEARING (issue #4937): `cdkd orphan <stack>/LogGroup` with the
#      shell's AWS_REGION pointed at ANOTHER region. Phase 1b stripped the log
#      group's recorded `Arn`, so the rewrite reads it live; the provider
#      builds the ARN from its client's region, which before the fix was the
#      shell's. The second parameter's state row must hold the deployed ARN,
#      in the stack's region.
#   4c. LOAD-BEARING (issue #5968): `cdkd orphan <stack>/V6Subnet`. The
#      provider's `getAttribute` answered neither attribute, so the rewrite
#      aborted as unresolvable. Each parameter row must hold the LIVE value:
#      the associated IPv6 blocks as a list, and the subnet's default-ACL
#      association id.
#   5. Delete the orphaned subnet out of band (the VPC cannot go while it
#      exists), destroy, delete the takeover role and the orphaned log group,
#      assert nothing is left.
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

STACK="CdkdOrphanGetattTakeoverExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="cdkd-orphan-getatt-takeover-role"
PARAMETER_NAME="/cdkd-integ/orphan-getatt-takeover/role-id"
LOG_GROUP_NAME="/cdkd-integ/orphan-getatt-takeover/region-probe"
LG_PARAMETER_NAME="/cdkd-integ/orphan-getatt-takeover/log-group-arn"
SN_BLOCKS_PARAMETER_NAME="/cdkd-integ/orphan-getatt-takeover/subnet-ipv6-blocks"
SN_NACL_PARAMETER_NAME="/cdkd-integ/orphan-getatt-takeover/subnet-nacl-association"
# Phase 4b's shell region: any region other than the stack's (issue #4937).
if [ "${REGION}" = "us-west-2" ]; then OTHER_REGION="us-east-1"; else OTHER_REGION="us-west-2"; fi
TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="${TMPDIR:-/tmp}/cdkd-4186-orphan.$$.log"

DEPLOYED=0
# Set only once the pre-flight proved the role name free, so an early exit
# never deletes a role this run did not create (a concurrent run's included).
ROLE_OWNED=0
# Likewise for the log group: `cdkd orphan` leaves it in AWS, so the fixture
# deletes it.
LOG_GROUP_OWNED=0
# The stack's subnet, once phase 1 read it from state. After phase 4c it is in
# no state record, so the fixture deletes it BEFORE any destroy: the VPC's
# delete fails while it exists.
SUBNET_ID=""

# Best-effort, subshell under `set +eu` so the trap never re-arms strict mode.
delete_role_best_effort() {
  (
    set +eu
    aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
    true
  )
}

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +eu
  if [ -n "${SUBNET_ID}" ]; then
    aws ec2 delete-subnet --region "${REGION}" --subnet-id "${SUBNET_ID}" >/dev/null 2>&1
  fi
  if [ "${DEPLOYED}" = "1" ] && [ -f "${LOCAL_DIST}" ]; then
    AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    aws ssm delete-parameter --region "${REGION}" --name "${PARAMETER_NAME}" >/dev/null 2>&1
    aws ssm delete-parameter --region "${REGION}" --name "${LG_PARAMETER_NAME}" >/dev/null 2>&1
    aws ssm delete-parameter --region "${REGION}" --name "${SN_BLOCKS_PARAMETER_NAME}" >/dev/null 2>&1
    aws ssm delete-parameter --region "${REGION}" --name "${SN_NACL_PARAMETER_NAME}" >/dev/null 2>&1
  fi
  # The fixed name covers the stack's role AND the takeover role: at most one
  # of them exists at a time.
  [ "${ROLE_OWNED}" = "1" ] && delete_role_best_effort
  [ "${LOG_GROUP_OWNED}" = "1" ] &&
    aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP_NAME}" >/dev/null 2>&1
  rm -f "${LOG}" 2>/dev/null
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

# Read one value out of the stack's state.json. `$1` is a JS expression over
# `st` (the parsed state); an empty string prints for undefined.
state_query() {
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" || return 1
  printf '%s' "${body}" | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const st = JSON.parse(s);
      const v = (0, eval)("(st) => (" + process.argv[1] + ")")(st);
      process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}
# The logical id CDK generated for each resource, found by type.
logical_id_of_type() {
  state_query "Object.keys(st.resources).find((k) => st.resources[k].resourceType === '$1')"
}
# The stack holds two parameters, so each is found by its NAME.
logical_id_of_parameter() {
  state_query "Object.keys(st.resources).find((k) => st.resources[k].resourceType === 'AWS::SSM::Parameter' && st.resources[k].properties?.Name === '$1')"
}
# How many log groups carry exactly LOG_GROUP_NAME in REGION. A failed call
# fails the run (set -e), never reads as zero.
log_group_count() {
  aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "${LOG_GROUP_NAME}" \
    --query "length(logGroups[?logGroupName=='${LOG_GROUP_NAME}'])" --output text
}
# The subnet's ASSOCIATED IPv6 blocks, sorted and comma-joined (issue #5968).
live_subnet_blocks() {
  aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
    --query "join(',', sort(Subnets[0].Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State=='associated'].Ipv6CidrBlock || \`[]\`))" \
    --output text
}
# The subnet's network ACL association id.
live_subnet_nacl_association() {
  aws ec2 describe-network-acls --region "${REGION}" \
    --filters "Name=association.subnet-id,Values=${SUBNET_ID}" \
    --query "NetworkAcls[].Associations[] | [?SubnetId=='${SUBNET_ID}'].NetworkAclAssociationId | [0]" \
    --output text
}

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "FAIL: state already exists at ${STATE_KEY} - clean up first." >&2
  exit 1
fi
if ! gone_probe aws iam get-role --role-name "${ROLE_NAME}"; then
  echo "FAIL: role ${ROLE_NAME} already exists - clean up first." >&2
  exit 1
fi
# Before `DEPLOYED=1`, so a leftover or concurrent same-named parameter makes
# the run exit without `cleanup` deleting it.
if ! gone_probe aws ssm get-parameter --region "${REGION}" --name "${PARAMETER_NAME}"; then
  echo "FAIL: parameter ${PARAMETER_NAME} already exists - clean up first." >&2
  exit 1
fi
if ! gone_probe aws ssm get-parameter --region "${REGION}" --name "${LG_PARAMETER_NAME}"; then
  echo "FAIL: parameter ${LG_PARAMETER_NAME} already exists - clean up first." >&2
  exit 1
fi
for name in "${SN_BLOCKS_PARAMETER_NAME}" "${SN_NACL_PARAMETER_NAME}"; do
  if ! gone_probe aws ssm get-parameter --region "${REGION}" --name "${name}"; then
    echo "FAIL: parameter ${name} already exists - clean up first." >&2
    exit 1
  fi
done
LG_COUNT="$(log_group_count)"
if [ "${LG_COUNT}" != "0" ]; then
  echo "FAIL: log group ${LOG_GROUP_NAME} already exists (count '${LG_COUNT}') - clean up first." >&2
  exit 1
fi

echo "==> Phase 1: deploy"
DEPLOYED=1
ROLE_OWNED=1
LOG_GROUP_OWNED=1
AWS_REGION="${REGION}" env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}" > "${LOG}" 2>&1 || {
  echo "FAIL: deploy failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
ROLE_LID="$(logical_id_of_type 'AWS::IAM::Role')"
PARAM_LID="$(logical_id_of_parameter "${PARAMETER_NAME}")"
LG_LID="$(logical_id_of_type 'AWS::Logs::LogGroup')"
LG_PARAM_LID="$(logical_id_of_parameter "${LG_PARAMETER_NAME}")"
if [ -z "${ROLE_LID}" ] || [ -z "${PARAM_LID}" ] || [ -z "${LG_LID}" ] || [ -z "${LG_PARAM_LID}" ]; then
  echo "FAIL: state lacks a row (role='${ROLE_LID}', param='${PARAM_LID}', log group='${LG_LID}', log-group-arn param='${LG_PARAM_LID}')" >&2
  exit 1
fi
RECORDED_ID="$(state_query "st.resources['${ROLE_LID}'].attributes?.RoleId")"
LIVE_ID="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ -z "${RECORDED_ID}" ] || [ "${RECORDED_ID}" != "${LIVE_ID}" ]; then
  echo "FAIL: premise: recorded RoleId '${RECORDED_ID}' is not the live '${LIVE_ID}'" >&2
  exit 1
fi
PARAM_VALUE="$(aws ssm get-parameter --region "${REGION}" --name "${PARAMETER_NAME}" \
  --query 'Parameter.Value' --output text)"
if [ "${PARAM_VALUE}" != "${RECORDED_ID}" ]; then
  echo "FAIL: the parameter holds '${PARAM_VALUE}', expected the role's id '${RECORDED_ID}'" >&2
  exit 1
fi
echo "    OK: RoleId ${RECORDED_ID} recorded, live, and deployed into the parameter"
# Phase 4b's expected value: the ARN the stack deployed, which names REGION.
RECORDED_LG_ARN="$(state_query "st.resources['${LG_LID}'].attributes?.Arn")"
case "${RECORDED_LG_ARN}" in
  arn:*:logs:"${REGION}":*:log-group:"${LOG_GROUP_NAME}":*) ;;
  *)
    echo "FAIL: premise: the log group's recorded Arn '${RECORDED_LG_ARN}' is not in ${REGION}" >&2
    exit 1
    ;;
esac
LG_PARAM_VALUE="$(aws ssm get-parameter --region "${REGION}" --name "${LG_PARAMETER_NAME}" \
  --query 'Parameter.Value' --output text)"
if [ "${LG_PARAM_VALUE}" != "${RECORDED_LG_ARN}" ]; then
  echo "FAIL: ${LG_PARAMETER_NAME} holds '${LG_PARAM_VALUE}', expected '${RECORDED_LG_ARN}'" >&2
  exit 1
fi
echo "    OK: log group Arn ${RECORDED_LG_ARN} recorded and deployed into the second parameter"
SUBNET_LID="$(logical_id_of_type 'AWS::EC2::Subnet')"
VPC_ID="$(state_query "Object.values(st.resources).find((r) => r.resourceType === 'AWS::EC2::VPC')?.physicalId")"
SN_BLOCKS_LID="$(logical_id_of_parameter "${SN_BLOCKS_PARAMETER_NAME}")"
SN_NACL_LID="$(logical_id_of_parameter "${SN_NACL_PARAMETER_NAME}")"
if [ -z "${SUBNET_LID}" ] || [ -z "${VPC_ID}" ] || [ -z "${SN_BLOCKS_LID}" ] || [ -z "${SN_NACL_LID}" ]; then
  echo "FAIL: state lacks a row (subnet='${SUBNET_LID}', vpc='${VPC_ID}', blocks param='${SN_BLOCKS_LID}', nacl param='${SN_NACL_LID}')" >&2
  exit 1
fi
# Checked before it becomes SUBNET_ID, which the trap deletes.
SUBNET_PHYSICAL_ID="$(state_query "st.resources['${SUBNET_LID}'].physicalId")"
case "${SUBNET_PHYSICAL_ID}" in
  subnet-*) SUBNET_ID="${SUBNET_PHYSICAL_ID}" ;;
  *)
    echo "FAIL: premise: the subnet's physical id '${SUBNET_PHYSICAL_ID}' is not a subnet id" >&2
    exit 1
    ;;
esac
# Phase 4c tests the SDK provider's getAttribute; a Cloud Control record would
# read through another provider and pass without exercising it.
SUBNET_ROUTE="$(state_query "st.resources['${SUBNET_LID}'].provisionedBy")"
if [ "${SUBNET_ROUTE}" != "sdk" ]; then
  echo "FAIL: premise: ${SUBNET_LID} records provisionedBy '${SUBNET_ROUTE}', not the SDK provider ('sdk')" >&2
  exit 1
fi
LIVE_BLOCKS="$(live_subnet_blocks)"
case "${LIVE_BLOCKS}" in
  *::/64) ;;
  *)
    echo "FAIL: premise: ${SUBNET_ID} has no associated IPv6 /64 ('${LIVE_BLOCKS}')" >&2
    exit 1
    ;;
esac
LIVE_NACL="$(live_subnet_nacl_association)"
case "${LIVE_NACL}" in
  aclassoc-*) ;;
  *)
    echo "FAIL: premise: ${SUBNET_ID} has no network ACL association ('${LIVE_NACL}')" >&2
    exit 1
    ;;
esac
SN_BLOCKS_VALUE="$(aws ssm get-parameter --region "${REGION}" --name "${SN_BLOCKS_PARAMETER_NAME}" \
  --query 'Parameter.Value' --output text)"
SN_NACL_VALUE="$(aws ssm get-parameter --region "${REGION}" --name "${SN_NACL_PARAMETER_NAME}" \
  --query 'Parameter.Value' --output text)"
if [ "${SN_BLOCKS_VALUE}" != "${LIVE_BLOCKS}" ] || [ "${SN_NACL_VALUE}" != "${LIVE_NACL}" ]; then
  echo "FAIL: the subnet parameters hold '${SN_BLOCKS_VALUE}' / '${SN_NACL_VALUE}', expected the live '${LIVE_BLOCKS}' / '${LIVE_NACL}'" >&2
  exit 1
fi
echo "    OK: ${SUBNET_ID} Ipv6CidrBlocks ${LIVE_BLOCKS} and NetworkAclAssociationId ${LIVE_NACL} deployed into the subnet parameters"

echo "==> Phase 1b: put the parameter row back into its unresolved-intrinsic shape"
STATE_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
printf '%s' "${STATE_BODY}" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const st = JSON.parse(s);
    st.resources[process.argv[1]].properties.Value = { "Fn::GetAtt": [process.argv[2], "RoleId"] };
    st.resources[process.argv[3]].properties.Value = { "Fn::GetAtt": [process.argv[4], "Arn"] };
    delete st.resources[process.argv[4]].attributes.Arn;
    process.stdout.write(JSON.stringify(st));
  });' "${PARAM_LID}" "${ROLE_LID}" "${LG_PARAM_LID}" "${LG_LID}" > "${LOG}"
aws s3 cp "${LOG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
PARAM_BEFORE="$(state_query "JSON.stringify(st.resources['${PARAM_LID}'].properties.Value)")"
case "${PARAM_BEFORE}" in
  *Fn::GetAtt*) ;;
  *)
    echo "FAIL: premise: the parameter's state row holds no Fn::GetAtt (${PARAM_BEFORE})" >&2
    exit 1
    ;;
esac
echo "    OK: ${PARAM_LID}.Value = ${PARAM_BEFORE}"
LG_PARAM_BEFORE="$(state_query "JSON.stringify(st.resources['${LG_PARAM_LID}'].properties.Value)")"
LG_ARN_LEFT="$(state_query "st.resources['${LG_LID}'].attributes?.Arn")"
case "${LG_PARAM_BEFORE}" in
  *Fn::GetAtt*) ;;
  *)
    echo "FAIL: premise: the log-group-arn parameter's row holds no Fn::GetAtt (${LG_PARAM_BEFORE})" >&2
    exit 1
    ;;
esac
if [ -n "${LG_ARN_LEFT}" ]; then
  echo "FAIL: premise: the log group's recorded Arn survived the strip (${LG_ARN_LEFT})" >&2
  exit 1
fi
echo "    OK: ${LG_PARAM_LID}.Value = ${LG_PARAM_BEFORE}; ${LG_LID} records no Arn"

echo "==> Phase 1c: the subnet parameters' rows read the subnet through a surviving Fn::GetAtt"
STATE_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
printf '%s' "${STATE_BODY}" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const st = JSON.parse(s);
    st.resources[process.argv[1]].properties.Value = { "Fn::GetAtt": [process.argv[3], "Ipv6CidrBlocks"] };
    st.resources[process.argv[2]].properties.Value = { "Fn::GetAtt": [process.argv[3], "NetworkAclAssociationId"] };
    process.stdout.write(JSON.stringify(st));
  });' "${SN_BLOCKS_LID}" "${SN_NACL_LID}" "${SUBNET_LID}" > "${LOG}"
aws s3 cp "${LOG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
for lid in "${SN_BLOCKS_LID}" "${SN_NACL_LID}"; do
  BEFORE="$(state_query "JSON.stringify(st.resources['${lid}'].properties.Value)")"
  case "${BEFORE}" in
    *Fn::GetAtt*"${SUBNET_LID}"*) ;;
    *)
      echo "FAIL: premise: ${lid}'s state row holds no Fn::GetAtt on ${SUBNET_LID} (${BEFORE})" >&2
      exit 1
      ;;
  esac
  echo "    OK: ${lid}.Value = ${BEFORE}"
done

echo "==> Phase 2: take the role's name over out of band"
aws iam delete-role --role-name "${ROLE_NAME}"
# IAM is eventually consistent: the name can read as taken for a moment after
# the delete. Retried a bounded number of times, then the last error stands.
for attempt in 1 2 3 4 5; do
  if aws iam create-role --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" >/dev/null 2>"${LOG}"; then
    break
  fi
  if [ "${attempt}" = "5" ]; then
    echo "FAIL: could not re-create ${ROLE_NAME}: $(cat "${LOG}")" >&2
    exit 1
  fi
  sleep 5
done
NEW_ID="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ -z "${NEW_ID}" ] || [ "${NEW_ID}" = "${RECORDED_ID}" ]; then
  echo "FAIL: premise: the takeover role's id '${NEW_ID}' does not differ from '${RECORDED_ID}'" >&2
  exit 1
fi
echo "    OK: ${ROLE_NAME} is now held by ${NEW_ID}"

echo "==> Phase 3: cdkd orphan ${STACK}/Role"
AWS_REGION="${REGION}" env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" orphan "${STACK}/Role" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes > "${LOG}" 2>&1 || {
  echo "FAIL: cdkd orphan failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
if [ -n "$(logical_id_of_type 'AWS::IAM::Role')" ]; then
  echo "FAIL: the role row is still in state after 'cdkd orphan'" >&2
  exit 1
fi

echo "==> Phase 4 (LOAD-BEARING, issue #4186): the parameter row holds the RECORDED RoleId"
PARAM_AFTER="$(state_query "st.resources['${PARAM_LID}'].properties.Value")"
if [ "${PARAM_AFTER}" = "${NEW_ID}" ]; then
  echo "FAIL: 'cdkd orphan' planted the TAKEOVER role's id ${NEW_ID} into ${PARAM_LID}" >&2
  exit 1
fi
if [ "${PARAM_AFTER}" != "${RECORDED_ID}" ]; then
  echo "FAIL: ${PARAM_LID}'s Value is '${PARAM_AFTER}', expected the recorded '${RECORDED_ID}'" >&2
  exit 1
fi
echo "    OK: ${PARAM_LID}.Value = ${PARAM_AFTER}"

echo "==> Phase 4b (LOAD-BEARING, issue #4937): cdkd orphan ${STACK}/LogGroup with AWS_REGION=${OTHER_REGION}"
# The shell's region points AWAY from the stack's; `--stack-region` selects
# the record. Before the fix the rewrite's providers were built on the
# shell-region clients, so the live `Arn` read named ${OTHER_REGION}.
AWS_REGION="${OTHER_REGION}" AWS_DEFAULT_REGION="${OTHER_REGION}" env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" orphan "${STACK}/LogGroup" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes > "${LOG}" 2>&1 || {
  echo "FAIL: cdkd orphan of the log group failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
if [ -n "$(logical_id_of_type 'AWS::Logs::LogGroup')" ]; then
  echo "FAIL: the log group row is still in state after 'cdkd orphan'" >&2
  exit 1
fi
LG_PARAM_AFTER="$(state_query "st.resources['${LG_PARAM_LID}'].properties.Value")"
case "${LG_PARAM_AFTER}" in
  *":${OTHER_REGION}:"*)
    echo "FAIL: 'cdkd orphan' read the log group's Arn in the shell's region: ${LG_PARAM_AFTER}" >&2
    exit 1
    ;;
esac
if [ "${LG_PARAM_AFTER}" != "${RECORDED_LG_ARN}" ]; then
  echo "FAIL: ${LG_PARAM_LID}'s Value is '${LG_PARAM_AFTER}', expected '${RECORDED_LG_ARN}'" >&2
  exit 1
fi
echo "    OK: ${LG_PARAM_LID}.Value = ${LG_PARAM_AFTER}"

echo "==> Phase 4c (LOAD-BEARING, issue #5968): cdkd orphan ${STACK}/V6Subnet"
AWS_REGION="${REGION}" env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" orphan "${STACK}/V6Subnet" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes > "${LOG}" 2>&1 || {
  echo "FAIL: cdkd orphan of the subnet failed (before #5968: unresolvable Ipv6CidrBlocks / NetworkAclAssociationId)" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
if [ -n "$(logical_id_of_type 'AWS::EC2::Subnet')" ]; then
  echo "FAIL: the subnet row is still in state after 'cdkd orphan'" >&2
  exit 1
fi
# Read live again: the expected value is what AWS holds NOW.
LIVE_BLOCKS="$(live_subnet_blocks)"
LIVE_NACL="$(live_subnet_nacl_association)"
# A list, never a string that happens to print the same.
SN_BLOCKS_AFTER="$(state_query "((v) => Array.isArray(v) ? [...v].sort().join(',') : 'NOT-A-LIST:' + JSON.stringify(v))(st.resources['${SN_BLOCKS_LID}'].properties.Value)")"
if [ "${SN_BLOCKS_AFTER}" != "${LIVE_BLOCKS}" ]; then
  echo "FAIL: ${SN_BLOCKS_LID}'s Value is '${SN_BLOCKS_AFTER}', expected the live list '${LIVE_BLOCKS}'" >&2
  exit 1
fi
SN_NACL_AFTER="$(state_query "st.resources['${SN_NACL_LID}'].properties.Value")"
if [ "${SN_NACL_AFTER}" != "${LIVE_NACL}" ]; then
  echo "FAIL: ${SN_NACL_LID}'s Value is '${SN_NACL_AFTER}', expected the live '${LIVE_NACL}'" >&2
  exit 1
fi
echo "    OK: ${SN_BLOCKS_LID}.Value = [${SN_BLOCKS_AFTER}]; ${SN_NACL_LID}.Value = ${SN_NACL_AFTER}"

echo "==> Phase 5: delete the orphaned subnet, destroy, then remove the takeover role and the orphaned log group"
# Left in AWS by `cdkd orphan`; the VPC's delete fails while it exists.
aws ec2 delete-subnet --region "${REGION}" --subnet-id "${SUBNET_ID}"
AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --force > "${LOG}" 2>&1 || {
  echo "FAIL: destroy failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
DEPLOYED=0
# `cdkd orphan` leaves the role in AWS by design; this one is the takeover.
aws iam delete-role --role-name "${ROLE_NAME}"
# The orphaned log group, left in AWS by design.
aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "parameter ${PARAMETER_NAME} still exists after destroy" \
  aws ssm get-parameter --region "${REGION}" --name "${PARAMETER_NAME}"
assert_gone "parameter ${LG_PARAMETER_NAME} still exists after destroy" \
  aws ssm get-parameter --region "${REGION}" --name "${LG_PARAMETER_NAME}"
for name in "${SN_BLOCKS_PARAMETER_NAME}" "${SN_NACL_PARAMETER_NAME}"; do
  assert_gone "parameter ${name} still exists after destroy" \
    aws ssm get-parameter --region "${REGION}" --name "${name}"
done
assert_gone "subnet ${SUBNET_ID} still exists" \
  aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
SUBNET_ID=""
assert_gone "role ${ROLE_NAME} still exists" aws iam get-role --role-name "${ROLE_NAME}"
LG_COUNT="$(log_group_count)"
if [ "${LG_COUNT}" != "0" ]; then
  echo "FAIL: log group ${LOG_GROUP_NAME} still exists (count '${LG_COUNT}')" >&2
  exit 1
fi

trap - EXIT INT TERM
rm -f "${LOG}"
echo "[verify] PASS — cdkd orphan substituted the recorded RoleId after a name takeover, read a live Arn in the stack's region, and read a subnet's Ipv6CidrBlocks / NetworkAclAssociationId live"
