#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route parity integ for eleven more common types (issue 6454, batch 2).
#
# Admission evidence for each type's `'sdk-coverage'` sticky exemption. Every
# phase acts on all eleven resources at once. Phases: deploy on the SDK route ->
# force each resource onto Cloud Control (--recreate-via-cc-api) -> the plan
# announces each return -> --pin-cc-api declines them -> redeploy with a real
# change: each id unchanged, each record flipped to 'sdk', each update reached
# AWS on the same resource -> no drift -> the two function URLs (one on the
# function, one on an alias) deleted alone by their recorded ids -> destroy.

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

STACK="CdkdCcToSdkRerouteCommonTypes2Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The resources under test, by the logical ids the stack fixes with
# overrideLogicalId. Every per-type helper below has an arm for each.
SUBJECTS=(
  RerouteVpc
  RerouteInternetGateway
  RerouteNetworkAcl
  RerouteUser
  RerouteGroup
  RerouteInstanceProfile
  RerouteStateMachine
  RerouteFunctionUrl
  RerouteQualifiedFunctionUrl
  RerouteUserPool
  RerouteOriginAccessControl
  RerouteAlias
)

STATE_JSON=""
load_state() {
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${STATE_JSON}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
}

# The state record for one resource under test, read from the last load_state.
# A missing record would make every assertion below read `null` and pass
# vacuously, so an empty match hard-fails.
record() { # usage: record <logicalId> <jq-expression-over-the-resource-object>
  printf '%s' "${STATE_JSON}" | jq -e --arg k "$1" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource $1" >&2
    exit 1
  }
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

output() { # usage: output <OutputKey>
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" '.outputs[$k]'
}

# What the template declares for a resource in a phase whose value is <a|b>.
expected() { # usage: expected <logicalId> <a|b>
  case "$1" in
    RerouteGroup) printf '/phase-%s/' "$2" ;;
    RerouteInstanceProfile) [ "$2" = a ] && output ProfileRoleAName || output ProfileRoleBName ;;
    RerouteFunctionUrl | RerouteQualifiedFunctionUrl) [ "$2" = a ] && printf '100' || printf '200' ;;
    RerouteAlias) [ "$2" = a ] && output AliasKeyAId || output AliasKeyBId ;;
    *) printf 'phase-%s' "$2" ;;
  esac
}

# The value AWS holds for that property, read through the recorded id.
live_value() { # usage: live_value <logicalId> <physicalId>
  local definition
  case "$1" in
    RerouteVpc)
      aws ec2 describe-vpcs --vpc-ids "$2" --region "${REGION}" \
        --query "Vpcs[0].Tags[?Key=='cdkd-phase'].Value | [0]" --output text ;;
    RerouteInternetGateway)
      aws ec2 describe-internet-gateways --internet-gateway-ids "$2" --region "${REGION}" \
        --query "InternetGateways[0].Tags[?Key=='cdkd-phase'].Value | [0]" --output text ;;
    RerouteNetworkAcl)
      aws ec2 describe-network-acls --network-acl-ids "$2" --region "${REGION}" \
        --query "NetworkAcls[0].Tags[?Key=='cdkd-phase'].Value | [0]" --output text ;;
    RerouteUser)
      aws iam list-user-tags --user-name "$2" --query "Tags[?Key=='cdkd-phase'].Value | [0]" --output text ;;
    RerouteGroup)
      aws iam get-group --group-name "$2" --query 'Group.Path' --output text ;;
    RerouteInstanceProfile)
      aws iam get-instance-profile --instance-profile-name "$2" \
        --query 'InstanceProfile.Roles[0].RoleName' --output text ;;
    RerouteStateMachine)
      definition=$(aws stepfunctions describe-state-machine --state-machine-arn "$2" --region "${REGION}" \
        --query 'definition' --output text) || return 1
      printf '%s' "${definition}" | jq -r '.States.Done.Result' ;;
    RerouteFunctionUrl | RerouteQualifiedFunctionUrl)
      aws lambda get-function-url-config --function-name "$2" --region "${REGION}" \
        --query 'Cors.MaxAge' --output text ;;
    RerouteUserPool)
      aws cognito-idp describe-user-pool --user-pool-id "$2" --region "${REGION}" \
        --query 'UserPool.UserPoolTags."cdkd-phase"' --output text ;;
    RerouteOriginAccessControl)
      aws cloudfront get-origin-access-control --id "$2" \
        --query 'OriginAccessControl.OriginAccessControlConfig.Description' --output text ;;
    RerouteAlias)
      aws kms describe-key --key-id "$2" --region "${REGION}" --query 'KeyMetadata.KeyId' --output text ;;
    *) echo "FAIL: live_value has no arm for $1" >&2; return 1 ;;
  esac
}

# IDENTITY WITNESS: a value AWS mints for the live resource, so a recreate
# changes it and an in-place update keeps it. That is what lets "the witness
# survived" in phase 5 mean "the resource was never replaced". Where AWS mints
# the id itself, the id is the witness.
witness() { # usage: witness <logicalId> <physicalId>
  local target
  case "$1" in
    RerouteUser) aws iam get-user --user-name "$2" --query 'User.UserId' --output text ;;
    RerouteGroup) aws iam get-group --group-name "$2" --query 'Group.GroupId' --output text ;;
    RerouteInstanceProfile)
      aws iam get-instance-profile --instance-profile-name "$2" \
        --query 'InstanceProfile.InstanceProfileId' --output text ;;
    RerouteStateMachine)
      aws stepfunctions describe-state-machine --state-machine-arn "$2" --region "${REGION}" \
        --query 'creationDate' --output text ;;
    RerouteFunctionUrl | RerouteQualifiedFunctionUrl)
      aws lambda get-function-url-config --function-name "$2" --region "${REGION}" \
        --query 'CreationTime' --output text ;;
    RerouteAlias)
      # Listed by the target key, so the answer is one page: a --query over
      # an account-wide listing applies per page.
      target=$(aws kms describe-key --key-id "$2" --region "${REGION}" --query 'KeyMetadata.KeyId' --output text) || return 1
      aws kms list-aliases --key-id "${target}" --region "${REGION}" \
        --query "Aliases[?AliasName=='$2'].CreationDate | [0]" --output text ;;
    *) printf '%s' "$2" ;;
  esac
}

# The id form BOTH layers must record. Phase 1 checks it on the SDK provider's
# record and phase 2 on Cloud Control's, so a type whose layers disagree (an
# ARN against a name, a composite against a bare id) fails here.
form_ok() { # usage: form_ok <logicalId> <physicalId>
  local iam_name='^[A-Za-z0-9+=,.@_-]+$'
  case "$1" in
    RerouteVpc) grep -qE '^vpc-[0-9a-f]+$' <<<"$2" ;;
    RerouteInternetGateway) grep -qE '^igw-[0-9a-f]+$' <<<"$2" ;;
    RerouteNetworkAcl) grep -qE '^acl-[0-9a-f]+$' <<<"$2" ;;
    RerouteUser | RerouteGroup | RerouteInstanceProfile) grep -qE "${iam_name}" <<<"$2" ;;
    RerouteStateMachine) grep -qE '^arn:aws[a-z-]*:states:[^:]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]+$' <<<"$2" ;;
    RerouteFunctionUrl) grep -qE '^arn:aws[a-z-]*:lambda:[^:]+:[0-9]{12}:function:[A-Za-z0-9_-]+$' <<<"$2" ;;
    # A URL on an alias: both layers must record the alias-qualified ARN, the
    # one the SDK provider then addresses it by.
    RerouteQualifiedFunctionUrl) grep -qE '^arn:aws[a-z-]*:lambda:[^:]+:[0-9]{12}:function:[A-Za-z0-9_-]+:live$' <<<"$2" ;;
    RerouteUserPool) grep -qE '^[a-z]{2}(-[a-z]+)+-[0-9]_[A-Za-z0-9]+$' <<<"$2" ;;
    RerouteOriginAccessControl) grep -qE '^[A-Z0-9]+$' <<<"$2" ;;
    RerouteAlias) grep -qE '^alias/[A-Za-z0-9/_-]+$' <<<"$2" ;;
    *) echo "FAIL: form_ok has no arm for $1" >&2; return 1 ;;
  esac
}

# Every resource's live value must be the phase's.
assert_live_values() { # usage: assert_live_values <phase-label> <a|b>
  local id pid got want
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    got=$(live_value "${id}" "${pid}")
    want=$(expected "${id}" "$2")
    [ "${got}" = "${want}" ] || { echo "FAIL: $1: ${id} (${pid}) holds '${got}', expected '${want}'" >&2; exit 1; }
  done
}

assert_layers() { # usage: assert_layers <phase-label> <sdk|cc-api>
  local id layer
  for id in "${SUBJECTS[@]}"; do
    layer=$(record "${id}" '.provisionedBy')
    [ "${layer}" = "$2" ] || { echo "FAIL: $1: ${id} recorded provisionedBy=${layer}, expected $2" >&2; exit 1; }
  done
}

# The per-resource routing flags, one per resource under test.
RECREATE_FLAGS=()
PIN_FLAGS=()
for id in "${SUBJECTS[@]}"; do
  RECREATE_FLAGS+=(--recreate-via-cc-api "${id}")
  PIN_FLAGS+=(--pin-cc-api "${id}")
done

# Per-phase ids and witnesses, indexed like SUBJECTS (bash 3.2 has no
# associative arrays).
P0=()
P1=()
W0=()
W1=()

cleanup() {
  echo "==> Cleanup"
  set +eu
  local destroy_rc=1 destroy_out=""
  if [ -f "${LOCAL_DIST}" ]; then
    destroy_out=$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)
    destroy_rc=$?
    # No state is the normal pre-run and post-destroy answer, not a failed teardown.
    if [ "${destroy_rc}" -ne 0 ] && ! grep -q 'No state found' <<<"${destroy_out}"; then
      echo "WARN: cdkd state destroy exited ${destroy_rc}; state was kept, so check the account for leftovers" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# `--recreate-via-cc-api` validates its arguments against the template's own
# logical ids, so a SUBJECTS entry the stack does not declare fails here, not as
# a confusing refusal mid-run.
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
for id in "${SUBJECTS[@]}"; do
  jq -e --arg k "${id}" '.Resources[$k]' "${TEMPLATE}" >/dev/null || { echo "FAIL: ${TEMPLATE} declares no ${id}" >&2; exit 1; }
done
echo "==> Phase 1: Deploy (SDK route by default -- no type under test has SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layers "phase 1 (fresh deploy)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  P0[$i]=$(record "${id}" '.physicalId')
  form_ok "${id}" "${P0[$i]}" || { echo "FAIL: the SDK provider recorded ${id} as '${P0[$i]}', not the expected id form" >&2; exit 1; }
  W0[$i]=$(witness "${id}" "${P0[$i]}")
  [ -n "${W0[$i]}" ] && [ "${W0[$i]}" != "None" ] || { echo "FAIL: no identity witness for ${id}" >&2; exit 1; }
done
assert_live_values "phase 1 (SDK create)" a
echo "    OK: all ${#SUBJECTS[@]} created on the SDK route"

echo "==> Phase 2: force each resource onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${RECREATE_FLAGS[@]}" --force-stateful-recreation --yes
load_state
# Without this every assertion below would be vacuous.
assert_layers "phase 2 (after --recreate-via-cc-api)" cc-api
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  P1[$i]=$(record "${id}" '.physicalId')
  form_ok "${id}" "${P1[$i]}" || {
    echo "FAIL: Cloud Control recorded ${id} as '${P1[$i]}', not the form the SDK provider records ('${P0[$i]}')" >&2
    exit 1
  }
  W1[$i]=$(witness "${id}" "${P1[$i]}")
  [ -n "${W1[$i]}" ] && [ "${W1[$i]}" != "None" ] || { echo "FAIL: no identity witness for ${id} after the recreate" >&2; exit 1; }
  [ "${W1[$i]}" != "${W0[$i]}" ] || {
    echo "FAIL: the recreate kept ${id}'s witness (${W0[$i]}); it was not recreated, so the witness cannot prove phase 5" >&2
    exit 1
  }
done
assert_live_values "phase 2 (CC recreate)" b
echo "    OK: all ${#SUBJECTS[@]} pinned to Cloud Control with fresh witnesses"

echo "==> Phase 3: the plan ANNOUNCES each return"
# `pinned`, not `flip`: the seed already declares flip's values, and cdkd diff
# renders the routing token only on a changed resource.
DIFF_OUT=$(env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
for id in "${SUBJECTS[@]}"; do
  # The change row names the logical id and its type; the token rides on it.
  # A row without the token is the routing annotation missing or reworded.
  row=$(grep -F "] ${id} (AWS::" <<<"${DIFF_OUT}" || true)
  [ -n "${row}" ] || { echo "FAIL: cdkd diff shows no change row for ${id}" >&2; printf '%s\n' "${DIFF_OUT}" >&2; exit 1; }
  grep -qF '[returning to SDK provider]' <<<"${row}" || {
    echo "FAIL: cdkd diff did not announce ${id}'s return: ${row}" >&2
    exit 1
  }
done
if grep -q 'via CC API: sticky' <<<"${DIFF_OUT}"; then
  echo "FAIL: cdkd diff still renders the sticky tag for a resource about to leave Cloud Control" >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
fi
echo "    OK: plan says 'returning to SDK provider' for all ${#SUBJECTS[@]}"

echo "==> Phase 4: --pin-cc-api DECLINES each flip"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${PIN_FLAGS[@]}" --yes
load_state
assert_layers "phase 4 (--pin-cc-api)" cc-api
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  [ "$(record "${id}" '.physicalId')" = "${P1[$i]}" ] || { echo "FAIL: the pinned deploy changed ${id}'s id" >&2; exit 1; }
  [ "$(witness "${id}" "${P1[$i]}")" = "${W1[$i]}" ] || {
    echo "FAIL: the pinned Cloud Control update replaced ${id} (its witness changed)" >&2
    exit 1
  }
done
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
assert_live_values "phase 4 (CC update)" a
echo "    OK: all ${#SUBJECTS[@]} still on Cloud Control, updates applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; each flip must be churn-free"
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layers "phase 5 (flip)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  p2=$(record "${id}" '.physicalId')
  [ "${p2}" = "${P1[$i]}" ] || {
    echo "FAIL: PHYSICAL ID CHURN across ${id}'s flip: ${P1[$i]} -> ${p2}. This type must not carry an 'sdk-coverage' exemption." >&2
    exit 1
  }
  w2=$(witness "${id}" "${p2}")
  [ "${w2}" = "${W1[$i]}" ] || {
    echo "FAIL: ${id}'s witness changed across the flip (${W1[$i]} -> ${w2}); the SDK provider replaced it" >&2
    exit 1
  }
done
# The update reached AWS through the id Cloud Control recorded.
assert_live_values "phase 5 (SDK update)" b
[ "$(output HostVpcId)" != "null" ] || { echo "FAIL: no HostVpcId output after the flip" >&2; exit 1; }
echo "    OK: same ids and witnesses, all ${#SUBJECTS[@]} records flipped to sdk, updates applied in place"

echo "==> Phase 6: no drift on the flipped records"
# Both: rc 0 alone would also pass a read that missed a resource, so the
# report must place each one in the clean bucket.
DRIFT_JSON=$(mktemp)
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --stack-region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null
DRIFT_RC=$?
set -e
for id in "${SUBJECTS[@]}"; do
  bucket=$(jq -r --arg id "${id}" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
    "${DRIFT_JSON}" 2>/dev/null || true)
  if [ "${DRIFT_RC}" -ne 0 ] || [ "${bucket}" != "clean" ]; then
    echo "FAIL: cdkd drift did not report ${id} clean after the flip (bucket '${bucket}', rc=${DRIFT_RC}):" >&2
    cat "${DRIFT_JSON}" >&2
    rm -f "${DRIFT_JSON}"
    exit 1
  fi
done
rm -f "${DRIFT_JSON}"
echo "    OK: cdkd drift reported all ${#SUBJECTS[@]} clean (rc=0)"

echo "==> Phase 7: the SDK provider deletes each flipped function URL by its recorded id"
# Through destroy the URLs would vanish with their function anyway, so a delete
# sent to the wrong id would pass a gone-probe there. Removing only the URLs
# from the template deletes them while the function still exists.
URL_ARN=$(record RerouteFunctionUrl '.physicalId')
QUALIFIED_URL_ARN=$(record RerouteQualifiedFunctionUrl '.physicalId')
HANDLER_NAME=$(output HandlerName)
env CDKD_TEST_PHASE=urls-removed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
for id in RerouteFunctionUrl RerouteQualifiedFunctionUrl; do
  if printf '%s' "${STATE_JSON}" | jq -e --arg k "${id}" '.resources[$k]' >/dev/null; then
    echo "FAIL: ${id} is still recorded after its removal deploy" >&2
    exit 1
  fi
done
aws lambda get-function --function-name "${HANDLER_NAME}" --region "${REGION}" >/dev/null || {
  echo "FAIL: function ${HANDLER_NAME} is gone, so the URL probes below cannot tell a wrong delete from a right one" >&2
  exit 1
}
assert_gone "function url ${URL_ARN} survived its removal deploy" \
  aws lambda get-function-url-config --function-name "${URL_ARN}" --region "${REGION}"
assert_gone "function url ${QUALIFIED_URL_ARN} survived its removal deploy" \
  aws lambda get-function-url-config --function-name "${QUALIFIED_URL_ARN}" --region "${REGION}"
echo "    OK: both function URLs deleted by their recorded ids, function intact"

echo "==> Phase 8: Destroy + gone-probes"
VPC_ID=$(record RerouteVpc '.physicalId')
IGW_ID=$(record RerouteInternetGateway '.physicalId')
ACL_ID=$(record RerouteNetworkAcl '.physicalId')
USER_NAME=$(record RerouteUser '.physicalId')
GROUP_NAME=$(record RerouteGroup '.physicalId')
PROFILE_NAME=$(record RerouteInstanceProfile '.physicalId')
STATE_MACHINE_ARN=$(record RerouteStateMachine '.physicalId')
USER_POOL_ID=$(record RerouteUserPool '.physicalId')
OAC_ID=$(record RerouteOriginAccessControl '.physicalId')
ALIAS_NAME=$(record RerouteAlias '.physicalId')
HOST_VPC_ID=$(output HostVpcId)
ROLE_A=$(output ProfileRoleAName)
ROLE_B=$(output ProfileRoleBName)
STATES_ROLE=$(output StatesRoleName)
KEY_A=$(output AliasKeyAId)
KEY_B=$(output AliasKeyBId)
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# Deletes AWS accepts before the resource stops answering reads: a state
# machine stays describable while DELETING. Each poll still goes through
# gone_probe, so a throttle or auth error hard-fails instead of reading as gone.
assert_gone_within() { # usage: assert_gone_within "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  for _ in $(seq 1 12); do
    gone_probe "$@" && return 0
    sleep 5
  done
  echo "FAIL: ${desc} (still readable 60s after destroy)" >&2
  exit 1
}
assert_gone "vpc ${VPC_ID} survived destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "internet gateway ${IGW_ID} survived destroy" \
  aws ec2 describe-internet-gateways --internet-gateway-ids "${IGW_ID}" --region "${REGION}"
assert_gone "network acl ${ACL_ID} survived destroy" \
  aws ec2 describe-network-acls --network-acl-ids "${ACL_ID}" --region "${REGION}"
assert_gone "host vpc ${HOST_VPC_ID} survived destroy" \
  aws ec2 describe-vpcs --vpc-ids "${HOST_VPC_ID}" --region "${REGION}"
assert_gone "user ${USER_NAME} survived destroy" aws iam get-user --user-name "${USER_NAME}"
assert_gone "group ${GROUP_NAME} survived destroy" aws iam get-group --group-name "${GROUP_NAME}"
assert_gone "instance profile ${PROFILE_NAME} survived destroy" \
  aws iam get-instance-profile --instance-profile-name "${PROFILE_NAME}"
assert_gone "role ${ROLE_A} survived destroy" aws iam get-role --role-name "${ROLE_A}"
assert_gone "role ${ROLE_B} survived destroy" aws iam get-role --role-name "${ROLE_B}"
assert_gone "role ${STATES_ROLE} survived destroy" aws iam get-role --role-name "${STATES_ROLE}"
assert_gone_within "state machine ${STATE_MACHINE_ARN} survived destroy" \
  aws stepfunctions describe-state-machine --state-machine-arn "${STATE_MACHINE_ARN}" --region "${REGION}"
assert_gone "function ${HANDLER_NAME} survived destroy" \
  aws lambda get-function --function-name "${HANDLER_NAME}" --region "${REGION}"
assert_gone "user pool ${USER_POOL_ID} survived destroy" \
  aws cognito-idp describe-user-pool --user-pool-id "${USER_POOL_ID}" --region "${REGION}"
assert_gone "origin access control ${OAC_ID} survived destroy" \
  aws cloudfront get-origin-access-control --id "${OAC_ID}"
assert_gone "alias ${ALIAS_NAME} survived destroy" \
  aws kms describe-key --key-id "${ALIAS_NAME}" --region "${REGION}"
# A deleted KMS key stays readable through its pending window; 7 days is the
# AWS minimum, so PendingDeletion is the terminal state of a deleted key.
for key in "${KEY_A}" "${KEY_B}"; do
  key_state=$(aws kms describe-key --key-id "${key}" --region "${REGION}" --query 'KeyMetadata.KeyState' --output text)
  [ "${key_state}" = "PendingDeletion" ] || { echo "FAIL: key ${key} is ${key_state} after destroy, expected PendingDeletion" >&2; exit 1; }
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-common-types-2 (physicalId parity observed on ${#SUBJECTS[@]} live resources)"
