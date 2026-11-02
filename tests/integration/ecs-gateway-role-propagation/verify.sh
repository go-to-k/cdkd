#!/usr/bin/env bash
# verify.sh — cdkd AWS::ECS::Gateway + its infrastructure role in ONE deploy
# (issue #5661).
#
# Cloud Control's gateway create runs seconds after the role's, and ECS
# rejects it while the role propagates: "Could not assume the infrastructure
# role ...", then "Access denied: AWS was not able to validate the provided
# access credentials (Service: Ecs, ...)". Before #5661 either failed the
# deploy; now both ride the IAM-propagation retry schedule.
#
#   Phase 1 (create):  one deploy, no head start, `--verbose`. It must
#                      succeed (THE assertion: pre-fix it fails at the gateway
#                      CREATE). Then: the gateway is on Cloud Control, ACTIVE,
#                      and bound to the role this deploy created (its
#                      CreateDate is after this run started, so the race was
#                      against a FRESH role). The retries per wording are
#                      REPORTED, not asserted: a role that propagates in time
#                      needs none.
#   Phase 2 (destroy): `cdkd destroy`; the gateway, the role, the VPC and the
#                      state file are gone.
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

STACK="CdkdEcsGatewayRolePropagationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
# Fixed in lib/ecs-gateway-role-propagation-stack.ts. The pre-flight refuses to
# deploy over a live gateway of this name.
GATEWAY_NAME="cdkd-ecs-gw-role-propagation"
# Per-run nonce, tagged onto the gateway (`cdkd-integ-run-id`): the teardown
# sweep deletes ONLY a gateway carrying THIS run's tag. Exported so the deploy's
# synth sees it.
RUN_ID="$(date +%s)-$$"
export CDKD_INTEG_RUN_ID="${RUN_ID}"
RUN_TAG_KEY="cdkd-integ-run-id"
# Whole seconds, compared against the role's CreateDate in phase 1.
RUN_STARTED_EPOCH="$(date +%s)"
# Set right before the deploy. Until then cleanup touches nothing: a state
# record or a same-named gateway found before that belongs to someone else.
DEPLOY_STARTED=0

LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t cdkd-ecs-gw-role-propagation.XXXXXX)"

# Ownership-gated teardown sweep for a gateway (an ALB, billed) Cloud Control
# created but state never recorded (a run that died mid-create): `state
# destroy` cannot see it. Touches the fixed-name gateway ONLY when it carries
# this run's tag, and never before this run's deploy. A subshell, so the
# best-effort `set +eu` never leaks into a strict-mode caller.
sweep_owned() { (
  set +eu
  [ "${DEPLOY_STARTED}" = "1" ] || exit 0
  # Scope guard: the listing below keys on this name and this nonce.
  case "${GATEWAY_NAME}|${RUN_ID}" in
    "cdkd-ecs-gw-role-propagation|"?*) ;;
    *)
      echo "WARN: teardown sweep refused: unexpected gateway name '${GATEWAY_NAME}' or empty run id" >&2
      exit 0
      ;;
  esac
  local gw gw_tags i
  for gw in $(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json 2>/dev/null \
    | jq -r --arg n "${GATEWAY_NAME}" '.gateways[]? | select(.name == $n and .status != "DELETED") | .gatewayArn'); do
    # A failed tag read leaves the gateway alone: ownership is never assumed.
    gw_tags=$(aws ecs list-tags-for-resource --resource-arn "${gw}" --region "${REGION}" --output json 2>/dev/null)
    if ! printf '%s' "${gw_tags}" | jq -e --arg k "${RUN_TAG_KEY}" --arg v "${RUN_ID}" \
      '[.tags[]? | select((.key // .Key) == $k and (.value // .Value) == $v)] | length > 0' >/dev/null; then
      echo "    sweep: leaving gateway ${gw} alone (no ${RUN_TAG_KEY}=${RUN_ID} tag)"
      continue
    fi
    echo "    sweep: deleting gateway ${gw}"
    for i in $(seq 1 60); do
      aws ecs delete-gateway --no-cli-auto-prompt --gateway "${gw}" --region "${REGION}" >/dev/null 2>&1
      [ "$(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json 2>/dev/null \
        | jq -r --arg a "${gw}" '[.gateways[]? | select(.gatewayArn == $a and .status != "DELETED")] | length')" = "0" ] && break
      sleep 10
    done
  done
) }

cleanup() {
  echo "==> Cleanup: dropping this run's state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  if [ "${DEPLOY_STARTED}" != "1" ]; then
    echo "    nothing deployed by this run; leaving state and resources alone"
    set -eu
    return 0
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET:-}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
  fi
  # After EVERY destroy, whatever its rc: a gateway Cloud Control created but
  # state never recorded is reachable only by name, and only ours is touched.
  sweep_owned
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

# Pre-flight, with no sweep before it: this run owns nothing yet, so a live
# gateway of this name, a state record or a lock found now is someone else's.
PREFLIGHT_GATEWAYS=$(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json \
  | jq -r --arg n "${GATEWAY_NAME}" '[.gateways[]? | select(.name == $n and .status != "DELETED")] | length')
if [ "${PREFLIGHT_GATEWAYS}" != "0" ]; then
  echo "FAIL: pre-flight: ECS gateway ${GATEWAY_NAME} already exists (not DELETED); delete it before running this fixture" >&2
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "FAIL: pre-flight: state ${STATE_KEY} already exists (another run, or a leftover); destroy it before running this fixture" >&2
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"; then
  echo "FAIL: pre-flight: ${LOCK_KEY} exists (a live peer run, or a leftover lock); clear it with: node dist/cli.js force-unlock ${STACK} --stack-region ${REGION} --state-bucket ${STATE_BUCKET}" >&2
  exit 1
fi

# --- Phase 1: role + gateway in one deploy ----------------------------------
echo "==> Phase 1: deploy the infrastructure role and the gateway together (no head start)"
DEPLOY_STARTED=1
# `--verbose` so the retry loop's per-attempt line reaches the log. Only LOG
# lines are read out of it (the retry line and Cloud Control's poll line),
# never a rendered progress row. `pipefail` keeps the deploy's rc.
if ! env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: phase 1: the deploy failed. If the gateway CREATE was rejected with 'Could not assume the infrastructure role' or 'AWS was not able to validate the provided access credentials (Service: Ecs,', the IAM-propagation retry for go-to-k/cdkd#5661 did not cover it" >&2
  exit 1
fi

DEPLOY_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${DEPLOY_LOG}")"
DEBUG_LINES="$(grep -ciE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z +debug ' <<< "${DEPLOY_PLAIN}" || true)"
[ "${DEBUG_LINES}" -gt 0 ] ||
  { echo "FAIL: phase 1 deploy log holds no debug lines -- the retry report below would be vacuous" >&2; exit 1; }
# Sentinel for the report below (testing.md: a fixture grepping cdkd's own
# output fails loudly on drift). Cloud Control's poll line records a failed
# attempt as `CREATE Gateway: FAILED` (src/provisioning/cloud-control-provider.ts);
# a failed attempt in a deploy that still SUCCEEDED was retried, so the retry
# loop's own `Retrying Gateway in ... (attempt N/M` line (src/deployment/retry.ts)
# must be there too. One without the other means that line's wording drifted.
if grep -qE "CREATE Gateway: FAILED" <<< "${DEPLOY_PLAIN}" &&
  ! grep -qE "Retrying Gateway in .*\(attempt [0-9]+/[0-9]+" <<< "${DEPLOY_PLAIN}"; then
  echo "FAIL: the phase 1 log shows a failed gateway create but no retry line for it -- the retry line's wording changed; update this fixture" >&2
  exit 1
fi
# Reported PER WORDING, not asserted: the race is intermittent, and a role that
# propagated in time needs no retry. A run with zeros here exercised nothing
# #5661 added (the mutation probe -- the pre-fix build failing phase 1 -- is
# what proves the arm discriminates). The spellings are the entries in
# src/deployment/retryable-errors/patterns.ts, matched with `grep -F`.
RETRY_LINES="$(grep -E 'Retrying Gateway in .*\(attempt [0-9]+/[0-9]+' <<< "${DEPLOY_PLAIN}" || true)"
RETRY_LINE_COUNT="$(grep -c . <<< "${RETRY_LINES}" || true)"
echo "    gateway retry lines during phase 1: ${RETRY_LINE_COUNT} (debug lines captured: ${DEBUG_LINES})"
while IFS= read -r wording; do
  [ -n "${wording}" ] || continue
  echo "      $(grep -cF "${wording}" <<< "${RETRY_LINES}" || true)  ${wording}"
done <<'PROPAGATION_WORDINGS'
Could not assume the infrastructure role
AWS was not able to validate the provided access credentials (Service: Ecs,
PROPAGATION_WORDINGS
if [ "${RETRY_LINE_COUNT}" = "0" ]; then
  echo "    NOTE: go-to-k/cdkd#5661: the gateway create was not rejected this run (the role propagated in time), so this run did not exercise the retry"
fi

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
read_state() { # $1 = python expression over `s` (the state in STATE_JSON)
  printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print($1)"
}
GATEWAY_ARN="$(read_state "s['resources']['Gateway']['physicalId']")"
GATEWAY_ROUTE="$(read_state "s['resources']['Gateway'].get('provisionedBy', '')")"
ROLE_NAME="$(read_state "s['resources']['GatewayInfraRole920B8030']['physicalId']")"

# The race is on the Cloud Control route; an SDK provider would be a
# different create path, and this fixture would no longer test #5661's.
if [ "${GATEWAY_ROUTE}" != "cc-api" ]; then
  echo "FAIL: phase 1: Gateway provisionedBy='${GATEWAY_ROUTE}', expected cc-api" >&2
  exit 1
fi
echo "    OK: Gateway is on Cloud Control (${GATEWAY_ARN})"

ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text)"
ROLE_CREATED="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.CreateDate' --output text)"
ROLE_CREATED_EPOCH="$(python3 -c "import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00')).timestamp()))" "${ROLE_CREATED}")"
if [ "${ROLE_CREATED_EPOCH}" -lt "${RUN_STARTED_EPOCH}" ]; then
  echo "FAIL: phase 1: role ${ROLE_NAME} was created at ${ROLE_CREATED}, before this run started -- the gateway did not race a fresh role" >&2
  exit 1
fi
echo "    OK: infrastructure role ${ROLE_NAME} was created by this deploy (${ROLE_CREATED})"

GATEWAY_JSON="$(aws ecs describe-gateway --gateway "${GATEWAY_ARN}" --region "${REGION}" --output json)"
GATEWAY_ROLE="$(jq -r '.gateway.infrastructureRoleArn // "MISSING"' <<< "${GATEWAY_JSON}")"
GATEWAY_STATUS="$(jq -r '.gateway.status // "MISSING"' <<< "${GATEWAY_JSON}")"
if [ "${GATEWAY_ROLE}" != "${ROLE_ARN}" ]; then
  echo "FAIL: phase 1: gateway infrastructureRoleArn '${GATEWAY_ROLE}' != this deploy's role '${ROLE_ARN}'" >&2
  exit 1
fi
if [ "${GATEWAY_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: phase 1: gateway status '${GATEWAY_STATUS}', expected ACTIVE" >&2
  exit 1
fi
echo "    OK: gateway is ACTIVE and bound to the fresh role"

# --- Phase 2: destroy -------------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# DeleteGateway is asynchronous and a deleted gateway stays listed as DELETED
# for a while, so read the listing rather than a not-found probe. Strict
# captures: a failed read fails the run instead of reading as "gone".
REMAINING=""
for _ in $(seq 1 30); do
  LISTING="$(aws ecs list-gateways --names "${GATEWAY_NAME}" --region "${REGION}" --output json)"
  REMAINING="$(jq -r --arg a "${GATEWAY_ARN}" '[.gateways[]? | select(.gatewayArn == $a and .status != "DELETED")] | length' <<< "${LISTING}")"
  [ "${REMAINING}" = "0" ] && break
  sleep 10
done
if [ "${REMAINING}" != "0" ]; then
  echo "FAIL: gateway ${GATEWAY_ARN} is not DELETED 5 minutes after destroy" >&2
  exit 1
fi
echo "    OK: gateway deleted"
assert_gone "infrastructure role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
VPC_ID="$(printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print(s['resources']['Vpc8378EB38']['physicalId'])")"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
echo "[verify] PASS — ecs-gateway-role-propagation (gateway created in the same deploy as its infrastructure role, then destroyed)"
