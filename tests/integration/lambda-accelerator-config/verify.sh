#!/usr/bin/env bash
# verify.sh — cdkd Lambda Function AcceleratorConfig integ (issue #6352).
#
# `AcceleratorConfig` sets the GPU memory of a container-image function on a
# GPU Lambda Managed Instances capacity provider. Before the backfill the SDK
# provider did not wire it, so the function auto-routed to Cloud Control.
# This fixture proves the SDK route delivers it, changes it in place, and
# refuses its removal (UpdateFunctionConfiguration has no value that removes
# it) without touching AWS.
#
# Prerequisite: the account's EC2 vCPU quota for On-Demand G instances
# ("Running On-Demand G and VT instances", L-DB2E81BA) in the region must
# hold the provider's GPU instances. A preflight reads it and stops the run
# before any deploy when it is below MIN_G_VCPU.
#
# Phases:
#   1. Deploy: AcceleratorMemorySize 12. Assert AWS reports it on $LATEST and
#      $LATEST.PUBLISHED (read through the fixture's own SDK client), the
#      function routed through the SDK provider (provisionedBy=sdk), and
#      `cdkd drift` clean (the readback emits what the create sent).
#   2. CDKD_TEST_UPDATE=true: 6. Assert AWS holds 6 on both qualifiers, the
#      function keeps its physical id (in place), still SDK-routed, drift clean.
#   3. CDKD_TEST_REMOVAL=true: no AcceleratorConfig. Assert the deploy fails
#      with the refusal, and AWS and state still hold 6.
#   4. Destroy; assert the function, the capacity provider, the VPC and the
#      state file are gone, and no instance is left in the VPC.
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
# DeleteFunction / DeleteCapacityProvider are acknowledged before the read
# stops answering.
assert_gone_eventually() { # usage: assert_gone_eventually <timeout-s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s)" >&2
      exit 1
    fi
    sleep 5
  done
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="CdkdLmiGpuAcceleratorExample"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PROVIDER_NAME="${STACK}-gpu"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp)"
# Three AZs at one 8-vCPU GPU instance each.
MIN_G_VCPU=24
FUNCTION_NAME=""
VPC_ID=""

fetch_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}
state_function() { # -> "<physicalId> <provisionedBy> <recorded AcceleratorMemorySize|none>"
  local state
  state="$(fetch_state)" || return 1
  printf '%s' "${state}" | node -e "
let s='';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const fns = Object.values(JSON.parse(s).resources ?? {}).filter(
    (r) => r?.resourceType === 'AWS::Lambda::Function'
  );
  if (fns.length !== 1) { process.stderr.write('want 1 function in state, got ' + fns.length + '\n'); process.exit(1); }
  const r = fns[0];
  const size = r.properties?.AcceleratorConfig?.AcceleratorMemorySize ?? 'none';
  process.stdout.write([r.physicalId, r.provisionedBy ?? 'sdk', size].join(' '));
});
"
}
state_vpc_id() {
  local state
  state="$(fetch_state)" || return 1
  printf '%s' "${state}" | node -e "
let s='';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const v = Object.values(JSON.parse(s).resources ?? {}).find((r) => r?.resourceType === 'AWS::EC2::VPC');
  process.stdout.write(v?.physicalId ?? '');
});
"
}
assert_accelerator() { # $1 = qualifier ('' for \$LATEST), $2 = expected size
  local got
  got="$(node fncfg.mjs "${FUNCTION_NAME}" ${1:+"$1"})"
  local want="{\"AcceleratorConfig\":{\"AcceleratorMemorySize\":$2}"
  case "${got}" in
    "${want}",*) ;;
    *) echo "FAIL: ${FUNCTION_NAME}${1:+:$1} AcceleratorConfig: want size $2, got '${got}'" >&2; exit 1 ;;
  esac
}
assert_state() { # $1 = expected physical id, $2 = expected recorded size
  local pid pb size
  read -r pid pb size < <(state_function)
  if [ "${pid}" != "$1" ]; then
    echo "FAIL: function physical id changed: want ${1}, got '${pid}' (replaced, not updated in place)" >&2; exit 1
  fi
  if [ "${pb}" != "sdk" ]; then
    echo "FAIL: ${pid} not provisioned by the SDK provider (provisionedBy='${pb}')" >&2; exit 1
  fi
  if [ "${size}" != "$2" ]; then
    echo "FAIL: state records AcceleratorMemorySize '${size}', want $2" >&2; exit 1
  fi
}

delete_provider() { ( set +eu # usage: delete_provider <name>; deletes and waits, best effort
  local name="$1" err gone="" accepted=""
  local not_found='not ?found|no ?such|does ?not ?exist|non ?existent|\(404'
  for _ in $(seq 1 40); do
    if err="$(aws lambda delete-capacity-provider --capacity-provider-name "${name}" --region "${REGION}" 2>&1 >/dev/null)"; then
      accepted=1; break
    fi
    if grep -qiE "${not_found}" <<< "${err}"; then gone=1; break; fi
    grep -qiE 'AccessDenied|UnrecognizedClient|ExpiredToken|Unable to locate credentials' <<< "${err}" && break
    sleep 15
  done
  if [ -n "${accepted}" ]; then
    for _ in $(seq 1 60); do
      if err="$(aws lambda get-capacity-provider --capacity-provider-name "${name}" --region "${REGION}" 2>&1 >/dev/null)"; then
        sleep 5; continue
      fi
      if grep -qiE "${not_found}" <<< "${err}"; then gone=1; break; fi
      sleep 5
    done
  fi
  [ -n "${gone}" ] || echo "WARN: cleanup could not confirm capacity provider ${name} is gone (delete accepted: ${accepted:-no}); it MUST be checked. Last AWS error: ${err:-none}" >&2
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  if [ -z "${VPC_ID}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    VPC_ID="$(state_vpc_id 2>/dev/null)"
  fi
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${STACK}" in
    CdkdLmiGpu?*)
      # Functions first: deleting one deletes every version, which frees the
      # provider it runs on.
      for fn in $(aws lambda list-functions --region "${REGION}" \
        --query "Functions[?starts_with(FunctionName, '${STACK}-')].FunctionName" --output text 2>/dev/null); do
        [ "${fn}" = "None" ] && continue
        aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      delete_provider "${PROVIDER_NAME}"
      for lg in $(aws logs describe-log-groups --region "${REGION}" \
        --log-group-name-prefix "/aws/lambda/${STACK}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
        aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdLmiGpu?*" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # A failed run must not leave GPU capacity billing unnoticed.
  if [ -n "${VPC_ID}" ]; then
    LEFT_INSTANCES="$(aws ec2 describe-instances --region "${REGION}" \
      --filters "Name=vpc-id,Values=${VPC_ID}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
      --query 'Reservations[].Instances[].InstanceId' --output text 2>&1)" \
      && [ -n "${LEFT_INSTANCES}" ] && echo "WARN: GPU instances left in ${VPC_ID}: ${LEFT_INSTANCES}" >&2
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Preflight: EC2 On-Demand G vCPU quota in ${REGION}"
G_QUOTA="$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-DB2E81BA \
  --region "${REGION}" --query 'Quota.Value' --output text)"
if ! awk -v q="${G_QUOTA}" -v m="${MIN_G_VCPU}" 'BEGIN { exit !(q + 0 >= m) }'; then
  trap - EXIT INT TERM
  echo "FAIL: 'Running On-Demand G and VT instances' quota is ${G_QUOTA} vCPU in ${REGION}; this fixture needs ${MIN_G_VCPU}. Request an increase (quota code L-DB2E81BA) and re-run." >&2
  exit 1
fi
echo "    quota ${G_QUOTA} vCPU (need ${MIN_G_VCPU})"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: create with AcceleratorConfig ----------------------------------
echo "==> Phase 1: deploy with AcceleratorMemorySize 12"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

read -r FUNCTION_NAME _ _ < <(state_function)
VPC_ID="$(state_vpc_id)"
case "${FUNCTION_NAME}" in
  "${STACK}-"?*) ;;
  *) echo "FAIL: function physical id '${FUNCTION_NAME}' is not a generated ${STACK}- name" >&2; exit 1 ;;
esac
assert_state "${FUNCTION_NAME}" 12
assert_accelerator '' 12
assert_accelerator '$LATEST.PUBLISHED' 12
echo "    AcceleratorConfig live (12) on \$LATEST and \$LATEST.PUBLISHED, provisionedBy=sdk"

env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    cdkd drift clean"

# --- Phase 2: size change in place ---------------------------------------------
echo "==> Phase 2: re-deploy with AcceleratorMemorySize 6"
env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_state "${FUNCTION_NAME}" 6
assert_accelerator '' 6
assert_accelerator '$LATEST.PUBLISHED' 6
echo "    AcceleratorConfig live (6), same physical id, provisionedBy=sdk"

env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    cdkd drift clean"

# --- Phase 3: removal is refused -------------------------------------------------
echo "==> Phase 3: re-deploy without AcceleratorConfig (expected to be refused)"
if CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_LOG}" 2>&1; then
  cat "${DEPLOY_LOG}" >&2
  echo "FAIL: the deploy removing AcceleratorConfig succeeded; update() must refuse it" >&2; exit 1
fi
if ! grep -q 'cannot lose its AcceleratorConfig' "${DEPLOY_LOG}"; then
  cat "${DEPLOY_LOG}" >&2
  echo "FAIL: the removal deploy failed without the AcceleratorConfig refusal" >&2; exit 1
fi
assert_state "${FUNCTION_NAME}" 6
assert_accelerator '' 6
assert_accelerator '$LATEST.PUBLISHED' 6
echo "    removal refused; AWS and state still hold 6"

# --- Phase 4: destroy -------------------------------------------------------------
echo "==> Phase 4: destroy"
env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone_eventually 120 "function ${FUNCTION_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}"
assert_gone_eventually 600 "capacity provider ${PROVIDER_NAME} still exists after destroy" \
  aws lambda get-capacity-provider --capacity-provider-name "${PROVIDER_NAME}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
INSTANCES_LEFT="$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "${INSTANCES_LEFT}" ]; then
  echo "FAIL: GPU instances left in ${VPC_ID} after destroy: ${INSTANCES_LEFT}" >&2; exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    function, capacity provider, VPC and cdkd state removed; no instance left"

# Lambda creates the function's log groups; destroy does not own them.
for lg in $(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "/aws/lambda/${STACK}" --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null
done
LEFT_LG="$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" \
  --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
if [ -n "${LEFT_LG}" ]; then
  echo "FAIL: log group(s) left after teardown: ${LEFT_LG}" >&2; exit 1
fi

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
echo "[verify] PASS — Lambda Function AcceleratorConfig (issue #6352), all 4 phases passed"
