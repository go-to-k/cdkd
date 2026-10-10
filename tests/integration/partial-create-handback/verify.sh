#!/usr/bin/env bash
# verify.sh — a provider's partial-create cleanup must not delete a resource
# that a name-idempotent create HANDED BACK (issue #4403).
#
# ELBv2 CreateTargetGroup (identical settings) and SNS CreateTopic answer
# success with the resource already holding the name, and EventBridge PutRule
# overwrites it. When a later step of the same create failed, the provider's
# cleanup deleted whatever the create returned: someone else's resource. The
# stack names nothing, so cdkd sends its generated `CdkdPcHandback-<id>`, and
# each mode declares a wiring step AWS rejects.
#
# Per MODE (tg, topic, rule):
#   H. HOLDER ARM. Create the generated name out of band, then deploy. Since
#      go-to-k/cdkd#4705 the deploy looks the generated name up first and
#      REFUSES the create (GENERATED_NAME_HELD: nothing this stack records
#      names the holder), so the create, its wiring step and the provider's
#      cleanup never run: the deploy MUST fail with that refusal naming the
#      holder, the out-of-band resource MUST survive, and no state record may
#      name it. (Before #4705 the create ran, the wiring failed, and #4403's
#      cleanup kept the holder with an "already existed before this create"
#      warning; before #4403 the cleanup deleted it.)
#   C. CONTROL. Remove the holder and deploy again (--verbose). The deploy
#      fails the same way and the cleanup DELETES what this create made: the
#      provider's own "Cleaned up partially-created" line is printed (proof
#      that the create AND the failing wiring step ran), the name is free
#      afterwards, and no "existed before" warning is printed.
# Then the load balancer, in two phases, since its holder needs the stack's
# subnet: L0 deploys MODE=lbvpc (a VPC and a subnet, MUST succeed); H/lb
# creates the holder load balancer in that subnet and deploys MODE=lb, which
# adds the stack's own; C/lb is the control. Each deleted load balancer's
# network interfaces must leave the subnet before the state destroy deletes
# it.
# Then the stack's state is destroyed; its file, VPC and subnet asserted gone.
#
# After a run killed with SIGKILL (no trap runs), delete by hand the target
# group, topic, rule and load balancer named `CdkdPcHandback-Tg` / `-Topic` /
# `-Rule` / `-Lb`, then the VPC with CIDR 10.89.0.0/24.
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

STACK="CdkdPcHandback"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
# The stack registry marker the first deploy claims (go-to-k/cdkd#4705).
MARKER_KEY="_cdkd-registry/${REGION}/${STACK}.json"
TG_NAME="${STACK}-Tg"
TOPIC_NAME="${STACK}-Topic"
RULE_NAME="${STACK}-Rule"
LB_NAME="${STACK}-Lb"
# The lb phases' VPC and subnet, read from state after phase L0.
VPC_ID=""
SUBNET_ID=""
# The sentinel the skipped cleanup prints (src/provisioning/providers/create-ownership.ts):
# a control must never print it, and a refused create can no longer reach it.
HELD_SENTINEL="already existed before this create"
# The refusal of a create onto a held generated name (src/deployment/deploy-engine/create.ts,
# go-to-k/cdkd#4705 GENERATED_NAME_HELD).
REFUSAL_NEEDLE="nothing this stack records names that resource"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pch.XXXXXX")"
ACCOUNT_ID="" PARTITION=""
read -r ACCOUNT_ID PARTITION < <(aws sts get-caller-identity --query '[Account, Arn]' --output text \
  | awk '{ split($2, a, ":"); print $1, a[2] }') || true
if [ -z "${ACCOUNT_ID}" ] || [ -z "${PARTITION}" ]; then
  echo "[verify] FAIL: could not read the account id and partition from sts get-caller-identity" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
TOPIC_ARN="arn:${PARTITION}:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "[verify] FAIL: ${LOCAL_DIST} not found — run 'vp run build' at the repo root first" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

tg_arn() { # usage: tg_arn — the target group's ARN, or a hard failure
  aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${REGION}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text
}
lb_arn() { # usage: lb_arn — the load balancer's ARN, or a hard failure
  aws elbv2 describe-load-balancers --names "${LB_NAME}" --region "${REGION}" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text
}
state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}
recorded_id() { # usage: recorded_id <logical id> — its recorded physical id, or "absent" (no record either)
  if ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ); then
    echo "absent"
    return 0
  fi
  state_field ".resources.$1.physicalId // \"absent\""
}
# The held-name refusal, as #4705 prints it: before the create, naming the
# holder; and no trace of the create or its cleanup.
assert_refused_before_create() { # usage: assert_refused_before_create <phase> <log> <logical id> <holder id>
  local phase="$1" log="$2" logical="$3" holder="$4"
  if ! grep -F -- "${REFUSAL_NEEDLE}" "${log}" | grep -qF -- "${holder}"; then
    echo "[verify] FAIL: phase ${phase}: no held-name refusal ('${REFUSAL_NEEDLE}') naming the holder ${holder}" >&2
    exit 1
  fi
  if grep -qF -- "${HELD_SENTINEL}" "${log}" || grep -qF -- "Cleaned up partially-created" "${log}"; then
    echo "[verify] FAIL: phase ${phase}: the create ran (a cleanup line was printed) -- it must be refused before it is sent" >&2
    exit 1
  fi
  if [ "$(recorded_id "${logical}")" != "absent" ]; then
    echo "[verify] FAIL: phase ${phase}: state records ${logical} after the refused create" >&2
    exit 1
  fi
}
# A network load balancer's interfaces leave its subnet minutes after its
# delete; until they do, the subnet cannot be deleted. Returns 1 on a failed
# read or the timeout.
wait_lb_enis_released() { # usage: wait_lb_enis_released <timeout seconds>
  local deadline ids
  deadline=$(( $(date +%s) + $1 ))
  while :; do
    ids="$(aws ec2 describe-network-interfaces --region "${REGION}" \
      --filters "Name=description,Values=ELB net/${LB_NAME}/*" \
      --query 'NetworkInterfaces[].NetworkInterfaceId' --output text)" || return 1
    [ -z "${ids}" ] && return 0
    [ "$(date +%s)" -ge "${deadline}" ] && return 1
    sleep 15
  done
}
rule_arn() { # usage: rule_arn — the rule's ARN, or a hard failure
  aws events describe-rule --name "${RULE_NAME}" --region "${REGION}" --query Arn --output text
}
probe_for() { # usage: probe_for <mode> — the read-probe argv for that mode's resource
  case "$1" in
    tg) echo "aws elbv2 describe-target-groups --names ${TG_NAME} --region ${REGION}" ;;
    topic) echo "aws sns get-topic-attributes --topic-arn ${TOPIC_ARN} --region ${REGION}" ;;
    rule) echo "aws events describe-rule --name ${RULE_NAME} --region ${REGION}" ;;
    lb) echo "aws elbv2 describe-load-balancers --names ${LB_NAME} --region ${REGION}" ;;
  esac
}
# A deleted topic or rule can answer for a moment, so "gone" is polled.
assert_mode_gone() { # usage: assert_mode_gone <mode> <description>
  local deadline
  deadline=$(( $(date +%s) + 300 ))
  # shellcheck disable=SC2046
  while ! gone_probe $(probe_for "$1"); do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "[verify] FAIL: $2" >&2
      exit 1
    fi
    sleep 5
  done
}
delete_holders_best_effort() {
  (
  set +eu
  arn="$(aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${REGION}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)"
  [ -n "${arn}" ] && [ "${arn}" != "None" ] \
    && aws elbv2 delete-target-group --target-group-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
  aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1
  ids="$(aws events list-targets-by-rule --rule "${RULE_NAME}" --region "${REGION}" \
    --query 'Targets[].Id' --output json 2>/dev/null)"
  [ -n "${ids}" ] && [ "${ids}" != "[]" ] \
    && aws events remove-targets --rule "${RULE_NAME}" --ids "${ids}" --region "${REGION}" >/dev/null 2>&1
  aws events delete-rule --name "${RULE_NAME}" --region "${REGION}" >/dev/null 2>&1
  arn="$(aws elbv2 describe-load-balancers --names "${LB_NAME}" --region "${REGION}" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null)"
  if [ -n "${arn}" ] && [ "${arn}" != "None" ]; then
    aws elbv2 delete-load-balancer --load-balancer-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
    aws elbv2 wait load-balancers-deleted --load-balancer-arns "${arn}" --region "${REGION}" >/dev/null 2>&1
  fi
  true
  )
}

# Remove the stack's registry marker, but only when it names this fixture's
# prefix (`cdkd`) and the stack has no record left there: a marker naming
# another prefix, or one whose record survived, is not this run's to drop.
sweep_marker() {
  local prefix
  ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) || return 0
  prefix="$( (aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true) | jq -r '.prefix // ""' 2>/dev/null || true)"
  if [ "${prefix}" = "cdkd" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  rc=$?
  echo "[verify] cleanup (rc=${rc})"
  (
  set +eu
  # Load balancers first, then their interfaces, so the state destroy can
  # delete the subnet; a subnet or VPC it still left goes by id.
  delete_holders_best_effort
  wait_lb_enis_released 600 >/dev/null 2>&1
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
    --region "${REGION}" --yes >/dev/null 2>&1 || true
  delete_holders_best_effort
  case "${SUBNET_ID}" in
    subnet-?*) aws ec2 delete-subnet --subnet-id "${SUBNET_ID}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  case "${VPC_ID}" in
    vpc-?*) aws ec2 delete-vpc --vpc-id "${VPC_ID}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  sweep_marker
  if ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}" ); then
    echo "[verify] WARN: stack registry marker left: s3://${STATE_BUCKET}/${MARKER_KEY}" >&2
  fi
  rm -rf "${LOG_DIR}"
  )
  exit "${rc}"
}

# A leftover (an interrupted run, or a CONCURRENT one) would turn a control
# into a holder arm. Checked BEFORE the trap is armed, so a refusal here never
# sweeps what it refused to touch.
for m in tg topic rule lb; do
  # shellcheck disable=SC2046
  if ! gone_probe $(probe_for "${m}"); then
    echo "[verify] FAIL: the ${m} name already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "[verify] FAIL: s3://${STATE_BUCKET}/${STATE_KEY} already exists before the run — nothing was touched" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

deploy_expect_failure() { # usage: deploy_expect_failure <mode> <log> [extra flags...]
  local rc=0 mode="$1" log="$2"
  shift 2
  env MODE="${mode}" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --yes "$@" > "${log}" 2>&1 || rc=$?
  sed 's/^/  /' "${log}" || true
  if [ "${rc}" -eq 0 ]; then
    echo "[verify] FAIL: the ${mode} deploy SUCCEEDED — its wiring step was meant to fail" >&2
    exit 1
  fi
}

for m in tg topic rule; do
  case "${m}" in
    tg) logical="Tg" ;;
    topic) logical="Topic" ;;
    rule) logical="Rule" ;;
  esac

  # -------------------------------------------------------------------------
  # PHASE H (${m}): the generated name is held out of band
  # -------------------------------------------------------------------------
  echo "[verify] phase H/${m}: hold the generated name out of band, then deploy (expect the create refused before it is sent, the holder kept)"
  case "${m}" in
    tg)
      HOLDER_ID="$(aws elbv2 create-target-group --name "${TG_NAME}" --target-type lambda \
        --region "${REGION}" --query 'TargetGroups[0].TargetGroupArn' --output text)"
      ;;
    topic)
      HOLDER_ID="$(aws sns create-topic --name "${TOPIC_NAME}" --region "${REGION}" \
        --query TopicArn --output text)"
      ;;
    rule)
      HOLDER_ID="$(aws events put-rule --name "${RULE_NAME}" --schedule-expression 'rate(7 days)' \
        --state DISABLED --region "${REGION}" --query RuleArn --output text)"
      ;;
  esac
  deploy_expect_failure "${m}" "${LOG_DIR}/h-${m}.log"
  assert_refused_before_create "H/${m}" "${LOG_DIR}/h-${m}.log" "${logical}" "${HOLDER_ID}"
  case "${m}" in
    tg) STILL="$(tg_arn)" ;;
    topic)
      aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null \
        || { echo "[verify] FAIL: phase H/${m}: the out-of-band topic is gone" >&2; exit 1; }
      STILL="${HOLDER_ID}"
      ;;
    rule) STILL="$(rule_arn)" ;;
  esac
  if [ "${STILL}" != "${HOLDER_ID}" ]; then
    echo "[verify] FAIL: phase H/${m}: the out-of-band resource is gone or replaced (${STILL} != ${HOLDER_ID})" >&2
    exit 1
  fi
  delete_holders_best_effort
  assert_mode_gone "${m}" "phase H/${m}: the out-of-band resource survived its own delete"
  echo "[verify] phase H/${m} ok: the create was refused before it was sent and ${HOLDER_ID} survived"

  # -------------------------------------------------------------------------
  # PHASE C (${m}): CONTROL — a free name; the cleanup deletes what it made
  # -------------------------------------------------------------------------
  echo "[verify] phase C/${m}: deploy onto the free name (expect a failure whose cleanup deletes the new resource)"
  deploy_expect_failure "${m}" "${LOG_DIR}/c-${m}.log" --verbose
  if grep -qF -- "${HELD_SENTINEL}" "${LOG_DIR}/c-${m}.log"; then
    echo "[verify] FAIL: phase C/${m}: a free name was read as held" >&2
    exit 1
  fi
  # Proof that the create AND its failing wiring step ran: only the provider's
  # cleanup arm prints this, and only after both.
  case "${m}" in
    tg) cleaned="Cleaned up partially-created TargetGroup ${logical}" ;;
    topic) cleaned="Cleaned up partially-created SNS topic ${logical}" ;;
    rule) cleaned="Cleaned up partially-created EventBridge rule ${logical}" ;;
  esac
  if ! grep -qF -- "${cleaned}" "${LOG_DIR}/c-${m}.log"; then
    echo "[verify] FAIL: phase C/${m}: no '${cleaned}' line — the create or its wiring step did not run as designed" >&2
    exit 1
  fi
  assert_mode_gone "${m}" "phase C/${m}: the partially-created resource survived the cleanup"
  echo "[verify] phase C/${m} ok: the cleanup deleted the partially-created resource"
done

# ---------------------------------------------------------------------------
# PHASE L0: the load balancer's VPC and subnet (MODE=lbvpc, MUST SUCCEED)
# ---------------------------------------------------------------------------
echo "[verify] phase L0: deploy the VPC and subnet the load balancer phases share"
env MODE=lbvpc node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes > "${LOG_DIR}/l0.log" 2>&1 \
  || { sed 's/^/  /' "${LOG_DIR}/l0.log"; echo "[verify] FAIL: phase L0 deploy failed" >&2; exit 1; }
VPC_ID="$(state_field '.resources.Vpc.physicalId')"
SUBNET_ID="$(state_field '.resources.Subnet.physicalId')"
case "${VPC_ID}:${SUBNET_ID}" in
  vpc-?*:subnet-?*) ;;
  *) echo "[verify] FAIL: state records no VPC / subnet id after phase L0 (got '${VPC_ID}' / '${SUBNET_ID}')" >&2; exit 1 ;;
esac
echo "[verify] phase L0 ok: ${VPC_ID} / ${SUBNET_ID}"

# ---------------------------------------------------------------------------
# PHASE H/lb: the generated load balancer name is held in the stack's subnet
# ---------------------------------------------------------------------------
echo "[verify] phase H/lb: hold ${LB_NAME} out of band, then deploy MODE=lb (expect the create refused before it is sent, the holder kept)"
# The settings the stack's load balancer sends, so the create hands it back.
LB_HOLDER_ARN="$(aws elbv2 create-load-balancer --name "${LB_NAME}" --type network --scheme internal \
  --subnets "${SUBNET_ID}" --region "${REGION}" --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
deploy_expect_failure lb "${LOG_DIR}/h-lb.log"
assert_refused_before_create "H/lb" "${LOG_DIR}/h-lb.log" Lb "${LB_HOLDER_ARN}"
if [ "$(lb_arn)" != "${LB_HOLDER_ARN}" ]; then
  echo "[verify] FAIL: phase H/lb: the out-of-band load balancer is gone or replaced" >&2
  exit 1
fi
aws elbv2 delete-load-balancer --load-balancer-arn "${LB_HOLDER_ARN}" --region "${REGION}"
assert_mode_gone lb "phase H/lb: the out-of-band load balancer survived its own delete"
wait_lb_enis_released 600 \
  || { echo "[verify] FAIL: phase H/lb: the holder's network interfaces are still in the subnet (or unreadable)" >&2; exit 1; }
echo "[verify] phase H/lb ok: the create was refused before it was sent and ${LB_HOLDER_ARN} survived"

# ---------------------------------------------------------------------------
# PHASE C/lb: CONTROL — a free name; the cleanup deletes what it made
# ---------------------------------------------------------------------------
echo "[verify] phase C/lb: deploy MODE=lb onto the free name (expect a failure whose cleanup deletes the new load balancer)"
deploy_expect_failure lb "${LOG_DIR}/c-lb.log" --verbose
if grep -qF -- "${HELD_SENTINEL}" "${LOG_DIR}/c-lb.log"; then
  echo "[verify] FAIL: phase C/lb: a free name was read as held" >&2
  exit 1
fi
if ! grep -qF -- "Cleaned up partially-created LoadBalancer Lb" "${LOG_DIR}/c-lb.log"; then
  echo "[verify] FAIL: phase C/lb: no cleanup line — the create or its wiring step did not run as designed" >&2
  exit 1
fi
assert_mode_gone lb "phase C/lb: the partially-created load balancer survived the cleanup"
wait_lb_enis_released 600 \
  || { echo "[verify] FAIL: phase C/lb: the deleted load balancer's network interfaces are still in the subnet (or unreadable)" >&2; exit 1; }
echo "[verify] phase C/lb ok: the cleanup deleted the partially-created load balancer"

# ---------------------------------------------------------------------------
# PHASE F: tear the stack's state down
# ---------------------------------------------------------------------------
echo "[verify] phase F: destroy ${STACK}'s state"
# A failed first deploy may or may not leave a state file: destroy one only
# when it is there, then require it gone.
FINAL_DESTROY=""
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
  FINAL_DESTROY=1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
for m in tg topic rule lb; do
  assert_mode_gone "${m}" "the ${m} resource still exists after the run"
done
assert_gone "subnet ${SUBNET_ID} still exists after destroy" \
  aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
# The stack registry marker (go-to-k/cdkd#4705), observed BEFORE the sweep:
# a successful state destroy releases it; with no destroy (no record was ever
# written -- the H arms refuse before any create), the first deploy's claim is
# legitimately left, and must name this fixture's prefix.
MARKER_NOW="absent"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"; then
  MARKER_NOW="$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - | jq -r '.prefix // "<no prefix>"')"
fi
echo "OBSERVE: registry-marker=${MARKER_NOW} final-destroy=${FINAL_DESTROY:-none}"
if [ -n "${FINAL_DESTROY}" ]; then
  if [ "${MARKER_NOW}" != "absent" ]; then
    echo "[verify] FAIL: the state destroy did not release the stack registry marker ${MARKER_KEY} (it names '${MARKER_NOW}')" >&2
    exit 1
  fi
elif [ "${MARKER_NOW}" != "absent" ]; then
  echo "OBSERVE: no record was destroyed, so the first deploy's claim is left by design"
  if [ "${MARKER_NOW}" != "cdkd" ]; then
    echo "[verify] FAIL: the left registry marker ${MARKER_KEY} names '${MARKER_NOW}', not this fixture's prefix cdkd" >&2
    exit 1
  fi
fi
# Then the cleanup: remove a marker the run legitimately left.
sweep_marker

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS — a partial-create cleanup deleted only what its own create made"
