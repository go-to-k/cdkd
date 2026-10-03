#!/usr/bin/env bash
# verify.sh -- two copies of one stack in one account and region each get their
# OWN EFS file system and CloudFront origin access identity (go-to-k/cdkd#4428).
#
# bin/app.ts instantiates the same stack class as CdkdTokenScopeA and
# CdkdTokenScopeB: same logical ids, same create-only inputs. The create tokens
# (EFS CreationToken, OAI CallerReference) used to carry no stack scope, so:
#   - EFS refused copy B's file system with FileSystemAlreadyExists, failing
#     the deploy where the AWS CDK CLI succeeds;
#   - CloudFront answered copy B's OAI create with copy A's identity, which
#     copy B then recorded, and a destroy of copy B deleted.
#
# Phases:
#   1. deploy A, then deploy B -- B must succeed;
#   2. B's file system and OAI are NOT A's, and the two file systems carry
#      different creation tokens;
#   3. destroy B -- A's file system and OAI must survive it;
#   4. destroy A -- everything gone;
#   5. RETAIN arm: deploy A with a RETAINed file system, destroy (it is kept),
#      redeploy -- the redeploy must create a NEW file system (#4438), leaving
#      the kept one untouched; 5b, the same after `cdkd orphan`;
#   6. FSx arm: copy A's first deploy is killed mid-create and re-run -- the
#      re-run must take the file system the killed run made (#4438); then two
#      copies of a Lustre SCRATCH_2 file system on one shared subnet and
#      security group -- copy B must get its own file system, and destroying
#      it must leave copy A's.
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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

STACK_A="CdkdTokenScopeA"
STACK_B="CdkdTokenScopeB"
STACK_NET="CdkdTokenScopeNet"
STACK_FSX_A="CdkdTokenScopeFsxA"
STACK_FSX_B="CdkdTokenScopeFsxB"
REGION="${AWS_REGION:-us-east-1}"
# The fixture's own resources, by what nothing else in the account carries:
# the file systems' creation-token prefix (`cdkd-<logicalId>-`) and the OAIs'
# comment. Literals, so neither filter can collapse to the empty string.
FS_TOKEN_PREFIX="cdkd-TokenScopeFs-"
OAI_COMMENT="cdkd-token-scope-4428"
FSX_TAG_VALUE="stack-copy-create-tokens"
# Scratch file for deploy logs, removed on exit.
DEPLOY_LOG="$(mktemp)"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

state_key() { printf 'cdkd/%s/%s/state.json' "$1" "${REGION}"; }
ledger_key() { printf 'cdkd/%s/%s/create-tokens.json' "$1" "${REGION}"; }

# Best-effort orphan sweep, for a run that died between a create and its state
# write (or a pre-fix run, where copy B's rollback can act on copy A's OAI).
sweep_orphans() {
  (
    set +eu
    for fs in $(aws efs describe-file-systems --region "${REGION}" \
      --query "FileSystems[?starts_with(CreationToken, '${FS_TOKEN_PREFIX}')].FileSystemId" \
      --output text 2>/dev/null); do
      [ "${fs}" = "None" ] && continue
      echo "    sweeping file system ${fs}"
      aws efs delete-file-system --file-system-id "${fs}" --region "${REGION}" >/dev/null 2>&1
    done
    for oai in $(aws cloudfront list-cloud-front-origin-access-identities \
      --query "CloudFrontOriginAccessIdentityList.Items[?Comment=='${OAI_COMMENT}'].Id" \
      --output text 2>/dev/null); do
      [ "${oai}" = "None" ] && continue
      etag=$(aws cloudfront get-cloud-front-origin-access-identity --id "${oai}" \
        --query ETag --output text 2>/dev/null)
      [ -n "${etag}" ] || continue
      echo "    sweeping origin access identity ${oai}"
      aws cloudfront delete-cloud-front-origin-access-identity --id "${oai}" \
        --if-match "${etag}" >/dev/null 2>&1
    done
  )
}

# FSx file systems the fixture made but no state records (a run that died
# mid-create): delete them and WAIT until each is gone, because a live one
# holds a network interface in the Net stack's subnet and its security group,
# and the Net destroy cannot remove them until it is.
sweep_fsx_and_wait() {
  (
    set +eu
    local ids fsx_id _i out
    ids=$(aws fsx describe-file-systems --region "${REGION}" \
      --query "FileSystems[?Tags[?Key=='cdkd-integ' && Value=='${FSX_TAG_VALUE}']].FileSystemId" \
      --output text 2>/dev/null)
    [ "${ids}" = "None" ] && ids=""
    for fsx_id in ${ids}; do
      echo "    sweeping FSx file system ${fsx_id}"
      # A file system still CREATING refuses the delete; retry until accepted.
      for _i in $(seq 1 60); do
        aws fsx delete-file-system --file-system-id "${fsx_id}" --region "${REGION}" >/dev/null 2>&1 && break
        out=$(aws fsx describe-file-systems --file-system-ids "${fsx_id}" --region "${REGION}" \
          --query 'FileSystems[0].Lifecycle' --output text 2>&1)
        printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' && break
        [ "${out}" = "DELETING" ] && break
        sleep 20
      done
    done
    for fsx_id in ${ids}; do
      for _i in $(seq 1 120); do
        out=$(aws fsx describe-file-systems --file-system-ids "${fsx_id}" --region "${REGION}" 2>&1)
        printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' && break
        sleep 10
      done
    done
  )
}

# Last resort when the Net stack's destroy failed: its VPC, by the fixture tag.
sweep_net_vpc() {
  (
    set +eu
    local vpc sg subnet igw rtb
    for vpc in $(aws ec2 describe-vpcs --region "${REGION}" \
      --filters "Name=tag:cdkd-integ,Values=${FSX_TAG_VALUE}" \
      --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
      [ "${vpc}" = "None" ] && continue
      echo "    sweeping VPC ${vpc}"
      for sg in $(aws ec2 describe-security-groups --region "${REGION}" \
        --filters "Name=vpc-id,Values=${vpc}" \
        --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
        aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
      done
      for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
        --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
        aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
      done
      for igw in $(aws ec2 describe-internet-gateways --region "${REGION}" \
        --filters "Name=attachment.vpc-id,Values=${vpc}" \
        --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null); do
        aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
        aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
      done
      for rtb in $(aws ec2 describe-route-tables --region "${REGION}" \
        --filters "Name=vpc-id,Values=${vpc}" \
        --query 'RouteTables[?!(Associations[?Main])].RouteTableId' --output text 2>/dev/null); do
        aws ec2 delete-route-table --route-table-id "${rtb}" --region "${REGION}" >/dev/null 2>&1
      done
      aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
    done
  )
}

state_destroy() { # usage: state_destroy <stack>; returns the destroy's rc
  local rc=1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "$1" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/$(state_key "$1")" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/$1/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # The create-token ledger (#4438): a killed first deploy leaves one with no
  # state record, which `state destroy` cannot see.
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/$(ledger_key "$1")" >/dev/null 2>&1 || true
  fi
  return "${rc}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${KILLED_PID:-}" ] && kill -9 "${KILLED_PID}" 2>/dev/null
  local stack
  # FSx copies first, then any FSx file system no state records, and only
  # then the network they sit in.
  state_destroy "${STACK_FSX_B}"
  state_destroy "${STACK_FSX_A}"
  sweep_fsx_and_wait
  if ! state_destroy "${STACK_NET}"; then
    state_destroy "${STACK_NET}" || sweep_net_vpc
  fi
  for stack in "${STACK_B}" "${STACK_A}"; do
    state_destroy "${stack}"
  done
  sweep_orphans
  rm -f "${DEPLOY_LOG}"
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

output_of() { # usage: output_of <stack> <output key>
  local state value
  state=$(aws s3 cp "s3://${STATE_BUCKET}/$(state_key "$1")" -) || return 1
  value=$(printf '%s' "${state}" | jq -r --arg k "$2" '.outputs[$k] // empty')
  if [ -z "${value}" ]; then
    echo "FAIL: output $2 missing from ${1}'s state" >&2
    exit 1
  fi
  printf '%s' "${value}"
}

creation_token_of() { # usage: creation_token_of <file system id>
  local token
  token=$(aws efs describe-file-systems --file-system-id "$1" --region "${REGION}" \
    --query 'FileSystems[0].CreationToken' --output text) || return 1
  if [ -z "${token}" ] || [ "${token}" = "None" ]; then
    echo "FAIL: no CreationToken read back for file system $1" >&2
    exit 1
  fi
  printf '%s' "${token}"
}

# --- Phase 1: deploy both copies ---------------------------------------
echo "==> Phase 1: deploy ${STACK_A}, then ${STACK_B} (same logical ids, same inputs)"
node "${LOCAL_DIST}" deploy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
FS_A=$(output_of "${STACK_A}" FileSystemId)
OAI_A=$(output_of "${STACK_A}" OaiId)
echo "    ${STACK_A}: file system ${FS_A}, OAI ${OAI_A}"

if ! node "${LOCAL_DIST}" deploy "${STACK_B}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}"; then
  if grep -q 'FileSystemAlreadyExists\|already exists with creation token' "${DEPLOY_LOG}"; then
    echo "FAIL: deploying the second copy ${STACK_B} failed -- EFS refused its file system: its creation token collided with ${STACK_A}'s (issue #4428 NOT closed)" >&2
  else
    echo "FAIL: deploying the second copy ${STACK_B} failed (see the deploy output above)" >&2
  fi
  exit 1
fi
FS_B=$(output_of "${STACK_B}" FileSystemId)
OAI_B=$(output_of "${STACK_B}" OaiId)
echo "    ${STACK_B}: file system ${FS_B}, OAI ${OAI_B}"

# --- Phase 2: each copy owns its own resources --------------------------
if [ "${FS_A}" = "${FS_B}" ]; then
  echo "FAIL: both copies recorded file system ${FS_A}" >&2
  exit 1
fi
if [ "${OAI_A}" = "${OAI_B}" ]; then
  echo "FAIL: ${STACK_B} was handed ${STACK_A}'s origin access identity ${OAI_A} (OAI CallerReference NOT stack-scoped)" >&2
  exit 1
fi
TOKEN_A=$(creation_token_of "${FS_A}")
TOKEN_B=$(creation_token_of "${FS_B}")
case "${TOKEN_A}" in "${FS_TOKEN_PREFIX}"*) ;; *)
  echo "FAIL: ${STACK_A}'s creation token '${TOKEN_A}' lacks the ${FS_TOKEN_PREFIX} prefix the orphan sweep relies on" >&2
  exit 1 ;;
esac
if [ "${TOKEN_A}" = "${TOKEN_B}" ]; then
  echo "FAIL: both file systems carry creation token ${TOKEN_A}" >&2
  exit 1
fi
echo "    OK: each copy owns its own file system and OAI, with distinct creation tokens"

# --- Phase 3: destroying copy B leaves copy A alone ----------------------
echo "==> Phase 3: destroy ${STACK_B}"
node "${LOCAL_DIST}" destroy "${STACK_B}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "file system ${FS_B} still exists after destroying ${STACK_B}" aws efs describe-file-systems --file-system-id "${FS_B}" --region "${REGION}"
assert_gone "OAI ${OAI_B} still exists after destroying ${STACK_B}" aws cloudfront get-cloud-front-origin-access-identity --id "${OAI_B}"
# Strict existence reads: a failure here is the leak this fixture exists for.
aws efs describe-file-systems --file-system-id "${FS_A}" --region "${REGION}" >/dev/null
aws cloudfront get-cloud-front-origin-access-identity --id "${OAI_A}" >/dev/null
echo "    OK: ${STACK_A}'s file system and OAI survived ${STACK_B}'s destroy"

# --- Phase 4: destroy copy A ---------------------------------------------
echo "==> Phase 4: destroy ${STACK_A}"
node "${LOCAL_DIST}" destroy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "file system ${FS_A} still exists after destroy" aws efs describe-file-systems --file-system-id "${FS_A}" --region "${REGION}"
assert_gone "OAI ${OAI_A} still exists after destroy" aws cloudfront get-cloud-front-origin-access-identity --id "${OAI_A}"
for stack in "${STACK_A}" "${STACK_B}"; do
  assert_gone "state file for ${stack} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${stack}")"
  assert_gone "create-token ledger for ${stack} still exists after destroy (#4438)" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(ledger_key "${stack}")"
done
echo "    OK: both copies destroyed cleanly"

# Delete an EFS file system this run left outside cdkd state, and wait until
# it is gone (the delete is asynchronous).
delete_efs_and_wait() { # usage: delete_efs_and_wait <file system id>
  aws efs delete-file-system --file-system-id "$1" --region "${REGION}"
  local _i
  for _i in $(seq 1 30); do
    if gone_probe aws efs describe-file-systems --file-system-id "$1" --region "${REGION}"; then
      return 0
    fi
    sleep 5
  done
  echo "FAIL: file system $1 is still present 150s after its delete" >&2
  exit 1
}

efs_state_of() { # usage: efs_state_of <file system id>
  aws efs describe-file-systems --file-system-id "$1" --region "${REGION}" \
    --query 'FileSystems[0].LifeCycleState' --output text
}

# --- Phase 5: RETAIN arm (go-to-k/cdkd#4438) --------------------------------
# A destroy keeps a RETAINed file system, which still holds the create token
# the stack sent for it. The destroy deletes the stack's create-token ledger,
# so the redeploy sends a NEW token and creates a new file system -- as the
# AWS CDK CLI does -- and the kept one stays untouched and unrecorded.
echo "==> Phase 5: deploy ${STACK_A} with a RETAINed file system, destroy, redeploy"
CDKD_TEST_RETAIN=true node "${LOCAL_DIST}" deploy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
FS_KEPT=$(output_of "${STACK_A}" FileSystemId)
CDKD_TEST_RETAIN=true node "${LOCAL_DIST}" destroy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
if [ "$(efs_state_of "${FS_KEPT}")" != "available" ]; then
  echo "FAIL: the RETAINed file system ${FS_KEPT} is not available after destroy (premise)" >&2
  exit 1
fi

if ! node "${LOCAL_DIST}" deploy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}"; then
  if grep -q "NOT recorded in cdkd state" "${DEPLOY_LOG}"; then
    echo "FAIL: the redeploy after a RETAIN destroy refused the kept file system ${FS_KEPT}: the create token was NOT renewed (issue #4438 NOT closed)" >&2
  else
    echo "FAIL: the redeploy after a RETAIN destroy failed (see the deploy output above)" >&2
  fi
  exit 1
fi
FS_NEW=$(output_of "${STACK_A}" FileSystemId)
if [ "${FS_NEW}" = "${FS_KEPT}" ]; then
  echo "FAIL: the redeploy recorded the kept file system ${FS_KEPT} as new" >&2
  exit 1
fi
if [ "$(efs_state_of "${FS_KEPT}")" != "available" ]; then
  echo "FAIL: the kept file system ${FS_KEPT} is not available after the redeploy" >&2
  exit 1
fi
echo "    OK: the redeploy created ${FS_NEW}; the kept ${FS_KEPT} is untouched"

node "${LOCAL_DIST}" destroy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
assert_gone "file system ${FS_NEW} still exists after destroy" aws efs describe-file-systems --file-system-id "${FS_NEW}" --region "${REGION}"
assert_gone "create-token ledger for ${STACK_A} still exists after the RETAIN arm's final destroy (#4438)" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(ledger_key "${STACK_A}")"
delete_efs_and_wait "${FS_KEPT}"
echo "    OK: RETAIN arm cleaned up"

# --- Phase 5b: cdkd orphan arm (go-to-k/cdkd#4438) --------------------------
# `cdkd orphan` drops the file system from state while it still holds the
# stack's create token; it rotates the ledger's nonce, so the next deploy
# creates a new file system instead of being refused.
echo "==> Phase 5b: deploy ${STACK_A}, orphan its file system, redeploy"
node "${LOCAL_DIST}" deploy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
FS_ORPHANED=$(output_of "${STACK_A}" FileSystemId)
node "${LOCAL_DIST}" orphan "${STACK_A}/TokenScopeFs" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" \
  --yes
if ! node "${LOCAL_DIST}" deploy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: the redeploy after orphaning ${FS_ORPHANED} failed (see the deploy output above)" >&2
  exit 1
fi
FS_AFTER_ORPHAN=$(output_of "${STACK_A}" FileSystemId)
if [ "${FS_AFTER_ORPHAN}" = "${FS_ORPHANED}" ]; then
  echo "FAIL: the redeploy recorded the orphaned file system ${FS_ORPHANED} again" >&2
  exit 1
fi
echo "    OK: the redeploy created ${FS_AFTER_ORPHAN}; the orphaned ${FS_ORPHANED} was left alone"
node "${LOCAL_DIST}" destroy "${STACK_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
delete_efs_and_wait "${FS_ORPHANED}"
assert_gone "state file for ${STACK_A} still exists after the orphan arm" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${STACK_A}")"
assert_gone "create-token ledger for ${STACK_A} still exists after the orphan arm (#4438)" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(ledger_key "${STACK_A}")"
echo "    OK: orphan arm cleaned up"

# --- Phase 6: FSx arm ----------------------------------------------------
echo "==> Phase 6: deploy ${STACK_NET}, then ${STACK_FSX_A} and ${STACK_FSX_B} (shared subnet + security group)"
node "${LOCAL_DIST}" deploy "${STACK_NET}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# go-to-k/cdkd#4438: the FIRST deploy of copy A is killed (SIGKILL) while its
# file system is being created -- AWS made it, cdkd never recorded it. The
# re-run must send the same token (from the ledger's pending marker) and take
# that file system, not create a second one nor refuse it.
fsx_ids_tagged() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='cdkd-integ' && Value=='${FSX_TAG_VALUE}']].FileSystemId" \
    --output text
}
node "${LOCAL_DIST}" deploy "${STACK_FSX_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes > "${DEPLOY_LOG}" 2>&1 &
KILLED_PID=$!
FSX_INTERRUPTED=""
for _i in $(seq 1 60); do
  FSX_INTERRUPTED=$(fsx_ids_tagged)
  [ "${FSX_INTERRUPTED}" = "None" ] && FSX_INTERRUPTED=""
  [ -n "${FSX_INTERRUPTED}" ] && break
  if ! kill -0 "${KILLED_PID}" 2>/dev/null; then
    cat "${DEPLOY_LOG}"
    echo "FAIL: the deploy of ${STACK_FSX_A} ended before its file system appeared (premise)" >&2
    exit 1
  fi
  sleep 5
done
if [ -z "${FSX_INTERRUPTED}" ]; then
  kill -9 "${KILLED_PID}" 2>/dev/null || true
  echo "FAIL: no file system appeared within 300s of deploying ${STACK_FSX_A} (premise)" >&2
  exit 1
fi
kill -9 "${KILLED_PID}"
wait "${KILLED_PID}" 2>/dev/null || true
unset KILLED_PID
echo "    killed the deploy of ${STACK_FSX_A} while ${FSX_INTERRUPTED} was being created"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${STACK_FSX_A}")"; then
  echo "FAIL: the killed first deploy of ${STACK_FSX_A} left a state record (premise: the file system is unrecorded)" >&2
  exit 1
fi
# The mechanism, not only the outcome: the killed run recorded its send of the
# file system's create token before it was killed.
if ! aws s3 cp "s3://${STATE_BUCKET}/$(ledger_key "${STACK_FSX_A}")" - | jq -e '.sent.TokenScopeFsx.token' >/dev/null; then
  echo "FAIL: the killed deploy of ${STACK_FSX_A} left no create-token ledger entry for TokenScopeFsx (premise)" >&2
  exit 1
fi
# The killed run held the stack lock; release it as an operator would.
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK_FSX_A}/${REGION}/lock.json" >/dev/null

if ! node "${LOCAL_DIST}" deploy "${STACK_FSX_A}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}"; then
  if grep -q "predates this create" "${DEPLOY_LOG}"; then
    echo "FAIL: the re-run refused ${FSX_INTERRUPTED}, the file system its own interrupted run made (issue #4438 NOT closed)" >&2
  else
    echo "FAIL: the re-run of ${STACK_FSX_A} failed (see the deploy output above)" >&2
  fi
  exit 1
fi
FSX_A=$(output_of "${STACK_FSX_A}" FileSystemId)
if [ "${FSX_A}" != "${FSX_INTERRUPTED}" ]; then
  echo "FAIL: the re-run recorded ${FSX_A}, not ${FSX_INTERRUPTED} the interrupted run made" >&2
  exit 1
fi
if [ "$(fsx_ids_tagged | wc -w | tr -d ' ')" != "1" ]; then
  echo "FAIL: the re-run created a second file system: $(fsx_ids_tagged)" >&2
  exit 1
fi
echo "    OK: the re-run took ${FSX_A}, the file system its interrupted run made"
if ! node "${LOCAL_DIST}" deploy "${STACK_FSX_B}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: deploying the second FSx copy ${STACK_FSX_B} failed (see the deploy output above)" >&2
  exit 1
fi
FSX_B=$(output_of "${STACK_FSX_B}" FileSystemId)
echo "    ${STACK_FSX_A}: ${FSX_A}; ${STACK_FSX_B}: ${FSX_B}"
if [ "${FSX_A}" = "${FSX_B}" ]; then
  echo "FAIL: ${STACK_FSX_B} was handed ${STACK_FSX_A}'s FSx file system ${FSX_A} (ClientRequestToken NOT stack-scoped)" >&2
  exit 1
fi

node "${LOCAL_DIST}" destroy "${STACK_FSX_B}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
assert_gone "FSx file system ${FSX_B} still exists after destroying ${STACK_FSX_B}" aws fsx describe-file-systems --file-system-ids "${FSX_B}" --region "${REGION}"
FSX_A_STATE=$(aws fsx describe-file-systems --file-system-ids "${FSX_A}" --region "${REGION}" \
  --query 'FileSystems[0].Lifecycle' --output text)
if [ "${FSX_A_STATE}" != "AVAILABLE" ]; then
  echo "FAIL: ${STACK_FSX_A}'s file system ${FSX_A} is '${FSX_A_STATE}' after destroying ${STACK_FSX_B}" >&2
  exit 1
fi
echo "    OK: ${STACK_FSX_A}'s file system survived ${STACK_FSX_B}'s destroy"

for stack in "${STACK_FSX_A}" "${STACK_NET}"; do
  node "${LOCAL_DIST}" destroy "${stack}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --force
done
assert_gone "FSx file system ${FSX_A} still exists after destroy" aws fsx describe-file-systems --file-system-ids "${FSX_A}" --region "${REGION}"
for stack in "${STACK_FSX_A}" "${STACK_FSX_B}" "${STACK_NET}"; do
  assert_gone "state file for ${stack} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${stack}")"
  assert_gone "create-token ledger for ${stack} still exists after destroy (#4438)" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(ledger_key "${stack}")"
done
echo "    OK: FSx arm destroyed cleanly"

echo "[verify] PASS -- two copies of one stack each own their EFS file system, CloudFront OAI and FSx file system (#4428); a redeploy after a RETAIN destroy or a cdkd orphan creates anew, and a re-run after a killed create takes what it made (#4438)"
