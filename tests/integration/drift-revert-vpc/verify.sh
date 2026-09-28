#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd drift` + `cdkd drift --revert`
# against VPC-requiring resource types (EFS / ServiceDiscovery
# PrivateDnsNamespace / ELBv2 ALB).
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftRevertVpcExample
#   3. inject drift via direct AWS SDK calls
#   4. cdkd drift  -> assert exit 1 (drift detected)
#   5. cdkd drift --revert -y  -> assert exit 0
#   6. cdkd drift  -> assert exit 0 (clean)
#   6b. attach tg2 out-of-band, rewrite the recorded TargetGroupARNs to an
#       import-style [{Ref}], cdkd deploy -> tg1 and tg2 stay attached, the
#       retained-entries warning prints, the record heals (#3948)
#   7. cdkd destroy --force
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
#
# VPC integ tests can leak hyperplane ENIs / NAT gateways if cleanup
# fails — every AWS resource carries removalPolicy: DESTROY and the
# cleanup trap re-attempts destroy on any failure exit.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDriftRevertVpcExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/drift-revert-vpc"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  rm -f "${STATE_TMP:-}" "${DEPLOY_LOG:-}"
  if [ "${TG2_ATTACHED:-0}" = 1 ]; then
    aws autoscaling detach-load-balancer-target-groups --auto-scaling-group-name "${ASG_NAME}" \
      --target-group-arns "${TG2_ARN}" --region "${REGION}" || true
    # Wait for the detach to land, or destroy can meet tg2 still attached.
    wait_asg_tgs "${TG1_ARN}" || true
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: inject drift"
node inject-drift.ts

echo "[verify] step 4: cdkd drift (expect exit 1)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: expected drift exit 1, got ${rc}"
  exit 1
fi
echo "[verify] step 4 ok: exit ${rc}"

echo "[verify] step 5: cdkd drift --revert -y (expect exit 0)"
${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

echo "[verify] step 6: cdkd drift again (expect exit 0)"
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"

# go-to-k/cdkd#3948: `cdkd import`'s raw-template fallback can record an
# unresolved intrinsic in a list. A malformed RECORDED TargetGroupARNs must be
# read from the live group ADD-only: not refused (that would wedge every later
# deploy), not read as empty (no warning, nothing known about live extras), and
# not taken whole (that would detach live entries the template never named).
# tg2 is attached out-of-band first, so the three readings differ: ADD-only
# keeps tg2 AND warns; read-as-empty keeps tg2 silently; whole detaches tg2.
echo "[verify] step 6b: import-style recorded TargetGroupARNs [{Ref}] -> deploy reads live ADD-only"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_TMP="$(mktemp)"
DEPLOY_LOG="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_TMP}" --region "${REGION}" >/dev/null
ASG_NAME="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['resources']['DriftAsg']['physicalId'])" "${STATE_TMP}")"
TG1_ARN="$(python3 -c "import json,sys; v=json.load(open(sys.argv[1]))['resources']['DriftAsg']['properties']['TargetGroupARNs']; assert isinstance(v,list) and len(v)==1 and isinstance(v[0],str), v; print(v[0])" "${STATE_TMP}")"
TG1_LOGICAL_ID="$(python3 - "${STATE_TMP}" "${TG1_ARN}" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
ids = [k for k, r in s['resources'].items()
       if r.get('resourceType') == 'AWS::ElasticLoadBalancingV2::TargetGroup'
       and r.get('physicalId') == sys.argv[2]]
assert len(ids) == 1, ids
print(ids[0])
PY
)"
TG2_ARN="$(python3 - "${STATE_TMP}" "${TG1_ARN}" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
arns = [r['physicalId'] for r in s['resources'].values()
        if r.get('resourceType') == 'AWS::ElasticLoadBalancingV2::TargetGroup'
        and r.get('physicalId') != sys.argv[2]]
assert len(arns) == 1 and arns[0].startswith('arn:'), arns
print(arns[0])
PY
)"
asg_tgs() {
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${ASG_NAME}" \
    --region "${REGION}" --query "join(' ', sort(AutoScalingGroups[0].TargetGroupARNs || \`[]\`))" --output text
}
wait_asg_tgs() {
  local want="$1" got="" i
  for i in $(seq 1 30); do
    got="$(asg_tgs)" || return 1
    [ "${got}" = "${want}" ] && return 0
    sleep 5
  done
  echo "[verify] FAIL: ASG target groups never became '${want}' (last '${got}')"
  return 1
}
# Set BEFORE the call: an attach that lands but then errors must still be
# detached by the trap (whose detach tolerates "not attached").
TG2_ATTACHED=1
aws autoscaling attach-load-balancer-target-groups --auto-scaling-group-name "${ASG_NAME}" \
  --target-group-arns "${TG2_ARN}" --region "${REGION}"
WANT_BOTH="$(printf '%s\n%s\n' "${TG1_ARN}" "${TG2_ARN}" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
wait_asg_tgs "${WANT_BOTH}"
python3 - "${STATE_TMP}" "${TG1_LOGICAL_ID}" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s['resources']['DriftAsg']['properties']['TargetGroupARNs'] = [{'Ref': sys.argv[2]}]
json.dump(s, open(p, 'w'))
PY
aws s3 cp "${STATE_TMP}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
rm -f "${STATE_TMP}"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${DEPLOY_LOG}"
LIVE_TGS="$(asg_tgs)"
if [ "${LIVE_TGS}" != "${WANT_BOTH}" ]; then
  echo "[verify] FAIL: step 6b expected tg1 AND the out-of-band tg2 still attached, got '${LIVE_TGS}'"
  exit 1
fi
# Parsed marker plus an independent sentinel on the same warning line, so a
# reworded warning fails loudly instead of reading as "no warning".
WARN_LINES="$(grep -F 'left them attached' "${DEPLOY_LOG}" || true)"
SENTINEL_LINES="$(grep -F 'TargetGroupARNs of AutoScalingGroup' "${DEPLOY_LOG}" | grep -F 'read it from Auto Scaling' || true)"
if [ -z "${WARN_LINES}" ] || [ -z "${SENTINEL_LINES}" ]; then
  echo "[verify] FAIL: step 6b expected the retained-entries warning (marker: '${WARN_LINES}', sentinel: '${SENTINEL_LINES}')"
  exit 1
fi
rm -f "${DEPLOY_LOG}"
RECORDED_TGS="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['resources']['DriftAsg']['properties']['TargetGroupARNs']))")"
if [ "${RECORDED_TGS}" != "[\"${TG1_ARN}\"]" ]; then
  echo "[verify] FAIL: step 6b expected the record to heal to [\"${TG1_ARN}\"], got ${RECORDED_TGS}"
  exit 1
fi
# tg2 is not a dependency of the ASG in the template, so destroy could delete it
# while still attached: detach it and wait before step 7.
aws autoscaling detach-load-balancer-target-groups --auto-scaling-group-name "${ASG_NAME}" \
  --target-group-arns "${TG2_ARN}" --region "${REGION}"
wait_asg_tgs "${TG1_ARN}"
TG2_ATTACHED=0
echo "[verify] step 6b ok: tg1 and tg2 attached after deploy, warning printed, record healed"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
