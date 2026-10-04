#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd drift` + `cdkd drift --revert`
# against VPC-requiring resource types (EFS / ServiceDiscovery
# PrivateDnsNamespace / ELBv2 ALB).
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftRevertVpcExample
#   3. inject drift via direct AWS SDK calls, and edit the standalone
#      ingress rule's description out of band
#   4. cdkd drift  -> assert exit 1 (drift detected)
#   5. cdkd drift --revert -y  -> assert exit 0
#   5b. the revert re-created the ingress rule under a new id, and the record's
#       attributes.Id names the live rule, not the revoked one (#4476)
#   6. cdkd drift  -> assert exit 0 (clean)
#   6b. attach tg2 out-of-band, rewrite the recorded TargetGroupARNs to an
#       import-style [{Ref}], cdkd deploy -> tg1 and tg2 stay attached, the
#       retained-entries warning prints, the record heals (#3948)
#   6c. the ALL group metrics are live; a legacy ALL baseline compares clean,
#       and an out-of-band GroupMinSize disable is reported (#4021)
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
  # A planted #4021 state record goes back before destroy reads it.
  if [ "${STATE_PLANTED:-0}" = 1 ] && [ -s "${STATE_ORIG:-}" ]; then
    aws s3 cp "${STATE_ORIG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  rm -f "${STATE_TMP:-}" "${DEPLOY_LOG:-}" "${STATE_ORIG:-}" "${STATE_PLANT:-}" "${DRIFT_JSON:-}"
  [ -n "${DRIFT_JSON:-}" ] && rm -f "${DRIFT_JSON}.err"
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

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# Issue #4021: the ASG enables ALL group metrics. Check the live set right after
# the first deploy, BEFORE anything reads it: the deploy-time observed capture
# and step 5's revert both depend on it. KNOWN_METRICS mirrors
# ALL_GROUP_METRICS in src/provisioning/providers/asg-provider.ts, a LOWER
# bound (observed live on 2026-09-28): AWS may enable more, so the live set
# must be a SUPERSET of it, not equal to it.
KNOWN_METRICS="GroupAndWarmPoolDesiredCapacity GroupAndWarmPoolTotalCapacity GroupDesiredCapacity GroupInServiceCapacity GroupInServiceInstances GroupMaxSize GroupMinSize GroupPendingCapacity GroupPendingInstances GroupStandbyCapacity GroupStandbyInstances GroupTerminatingCapacity GroupTerminatingInstances GroupTerminatingRetainedCapacity GroupTerminatingRetainedInstances GroupTotalCapacity GroupTotalInstances WarmPoolDesiredCapacity WarmPoolMinSize WarmPoolPendingCapacity WarmPoolPendingRetainedCapacity WarmPoolTerminatingCapacity WarmPoolTerminatingRetainedCapacity WarmPoolTotalCapacity WarmPoolWarmedCapacity"
asg_metrics() {
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${METRICS_ASG_NAME}" \
    --region "${REGION}" --query "join(' ', sort(AutoScalingGroups[0].EnabledMetrics[].Metric || \`[]\`))" --output text
}
# $1 = metrics a live set must hold, $2 = metrics it must NOT hold, $3 = label.
wait_asg_metrics() {
  local got="" i m ok
  for i in $(seq 1 24); do
    got="$(asg_metrics)" || return 1
    ok=1
    for m in $1; do case " ${got} " in *" ${m} "*) ;; *) ok=0 ;; esac; done
    for m in $2; do case " ${got} " in *" ${m} "*) ok=0 ;; esac; done
    [ "${ok}" = 1 ] && return 0
    sleep 5
  done
  echo "[verify] FAIL: $3: EnabledMetrics never held '$1' without '$2' (last '${got}')"
  return 1
}
STATE_AFTER_DEPLOY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
METRICS_ASG_NAME="$(printf '%s' "${STATE_AFTER_DEPLOY}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['resources']['DriftAsg']['physicalId'])")"
wait_asg_metrics "${KNOWN_METRICS}" "" "step 2 (ALL group metrics live after the first deploy, #4021)"
LIVE_METRICS="$(asg_metrics)"
# The deploy-time observed capture must hold the SAME set AWS reports: a
# capture taken before AWS reflected the enable would make step 5's revert
# disable metrics.
OBSERVED_METRICS="$(printf '%s' "${STATE_AFTER_DEPLOY}" | python3 -c "
import json, sys
mc = json.load(sys.stdin)['resources']['DriftAsg'].get('observedProperties', {}).get('MetricsCollection') or []
print(' '.join(sorted(m for e in mc for m in (e.get('Metrics') or []))))")"
if [ "${OBSERVED_METRICS}" != "${LIVE_METRICS}" ]; then
  echo "[verify] FAIL: step 2: the deploy-time observed MetricsCollection '${OBSERVED_METRICS}' is not the live set '${LIVE_METRICS}' (#4021)"
  exit 1
fi
echo "[verify] step 2 ok: EnabledMetrics holds every known metric, and the observed capture matches the live set"

echo "[verify] step 3: inject drift"
node inject-drift.ts

# go-to-k/cdkd#4476: the standalone ingress rule (port 8443 on Sg2). Its
# recorded id must be the live rule's before the edit, or step 5b's comparison
# proves nothing.
ingress_record() { # prints "<groupId> <recorded attributes.Id>"
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | python3 -c "
import json, sys
r = json.load(sys.stdin)['resources']['DriftSgIngress']
print(r['properties']['GroupId'], (r.get('attributes') or {}).get('Id', ''))"
}
live_ingress_ids() { # $1 = group id -> the live port-8443 ingress rule ids
  aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$1" --region "${REGION}" \
    --query "SecurityGroupRules[?IsEgress==\`false\` && FromPort==\`8443\`].SecurityGroupRuleId" \
    --output text
}
# Assigned first, so a failed state read aborts here under `set -e` rather
# than reading as an empty id.
INGRESS_REC="$(ingress_record)"
read -r INGRESS_SG OLD_INGRESS_ID <<<"${INGRESS_REC}"
LIVE_INGRESS_ID="$(live_ingress_ids "${INGRESS_SG}")"
if [ -z "${OLD_INGRESS_ID}" ] || [ "${LIVE_INGRESS_ID}" != "${OLD_INGRESS_ID}" ]; then
  echo "[verify] FAIL: step 3: the recorded ingress Id '${OLD_INGRESS_ID}' is not the one live rule '${LIVE_INGRESS_ID}'"
  exit 1
fi
aws ec2 update-security-group-rule-descriptions-ingress --group-id "${INGRESS_SG}" \
  --security-group-rule-descriptions "SecurityGroupRuleId=${OLD_INGRESS_ID},Description=drift-revert-vpc-DRIFTED" \
  --region "${REGION}" >/dev/null

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

# go-to-k/cdkd#4476: reverting the description revokes and re-authorizes the
# rule, so AWS holds a NEW id; the record must name it. Before the fix the
# record kept the revoked one.
echo "[verify] step 5b: the record's ingress Id follows the re-created rule"
INGRESS_REC="$(ingress_record)"
read -r _ RECORDED_INGRESS_ID <<<"${INGRESS_REC}"
# EC2 reads lag a revoke + re-authorize: right after the revert the rule list
# can be empty, or still carry the old rule beside the new one. Poll until it
# holds exactly one rule that is not the old one.
wait_new_ingress_id() { # $1 = group id, $2 = old rule id -> the one new rule id
  local ids="" n i
  for i in $(seq 1 12); do
    ids="$(live_ingress_ids "$1")" || return 1
    n=$(printf '%s\n' ${ids} | grep -c . || true)
    if [ "${n}" = 1 ] && [ "${ids}" != "$2" ]; then
      printf '%s\n' "${ids}"
      return 0
    fi
    sleep 5
  done
  if [ -z "${ids}" ]; then
    echo "[verify] FAIL: step 5b: no live port-8443 ingress rule on $1 after the revert" >&2
  elif [ "${n}" -gt 1 ]; then
    echo "[verify] FAIL: step 5b: ${n} live port-8443 ingress rules on $1 after the revert (${ids}); expected the old one revoked" >&2
  else
    echo "[verify] FAIL: step 5b: expected the revert to re-create the rule under a new id; the live rule is still '$2'" >&2
  fi
  return 1
}
LIVE_INGRESS_ID="$(wait_new_ingress_id "${INGRESS_SG}" "${OLD_INGRESS_ID}")"
if [ "${RECORDED_INGRESS_ID}" != "${LIVE_INGRESS_ID}" ]; then
  echo "[verify] FAIL: step 5b: the record names '${RECORDED_INGRESS_ID}', the live rule is '${LIVE_INGRESS_ID}' (#4476)"
  exit 1
fi
LIVE_INGRESS_DESC="$(aws ec2 describe-security-group-rules --security-group-rule-ids "${LIVE_INGRESS_ID}" \
  --region "${REGION}" --query 'SecurityGroupRules[0].Description' --output text)"
if [ "${LIVE_INGRESS_DESC}" != "drift-revert-vpc standalone ingress (templated)" ]; then
  echo "[verify] FAIL: step 5b: the re-created rule's description is '${LIVE_INGRESS_DESC}'"
  exit 1
fi
echo "[verify] step 5b ok: the record names the live rule ${LIVE_INGRESS_ID} (was ${OLD_INGRESS_ID})"

# Known intermittent failure (go-to-k/cdkd#4147): AWS returns the ALB's
# undeclared `ddos_protection.syn_cookie.mode` attribute only some of the time.
# If step 2's observed capture lacked it and a later read returns it, step 5's
# revert leaves it in place (no ELBv2 call removes a key; the revert warns) and
# this step reports it as LoadBalancerAttributes drift, since one read cannot
# tell it from an out-of-band value. Re-run the fixture. The opposite direction
# (captured, then absent) is not drift (#4144).
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

# Issue #4021: the ASG's MetricsCollection is ALL (`{Granularity: 1Minute}`
# with no Metrics). The live set must hold every metric cdkd knows ALL enables
# (a superset: AWS may add more); the drift pair rule reads an ALL baseline as
# known UNION live, so a missing KNOWN metric is drift and an extra one is not.
echo "[verify] step 6c: ALL group metrics — legacy-baseline drift, out-of-band disable (#4021)"
wait_asg_metrics "${KNOWN_METRICS}" "" "step 6c (ALL still enabled after steps 3-6b)"

# The legacy record: no observedProperties, so drift compares the ALL template
# value in `properties` against the per-metric readback. Other templated keys
# may differ on that path, so only MetricsCollection is asserted, and the ASG
# must have been compared at all.
STATE_ORIG="$(mktemp)"
STATE_PLANT="$(mktemp)"
DRIFT_JSON="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_ORIG}" --region "${REGION}" >/dev/null
python3 - "${STATE_ORIG}" "${STATE_PLANT}" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
asg = s['resources']['DriftAsg']
asg.pop('observedProperties', None)
asg['properties']['MetricsCollection'] = [{'Granularity': '1Minute'}]
json.dump(s, open(sys.argv[2], 'w'))
PY
python3 - "${STATE_PLANT}" <<'PY'
import json, sys
asg = json.load(open(sys.argv[1]))['resources']['DriftAsg']
assert 'observedProperties' not in asg and asg['properties']['MetricsCollection'] == [{'Granularity': '1Minute'}], asg
PY
STATE_PLANTED=1
aws s3 cp "${STATE_PLANT}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
metrics_drift() { # $1 = label -> prints the number of MetricsCollection changes on the ASG
  ${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" --json >"${DRIFT_JSON}" 2>/dev/null || true
  python3 - "${DRIFT_JSON}" "$1" <<'PY'
import json, sys
try:
    report = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(f"[verify] FAIL: {sys.argv[2]}: cdkd drift --json produced no parseable report ({e})")
if not isinstance(report, list) or not report:
    sys.exit(f"[verify] FAIL: {sys.argv[2]}: cdkd drift --json reported no stacks")
compared = [r for st in report for bucket in ('clean', 'drifted') for r in st.get(bucket, [])
            if r.get('logicalId') == 'DriftAsg']
if len(compared) != 1:
    sys.exit(f"[verify] FAIL: {sys.argv[2]}: the ASG was not compared: {json.dumps(report)}")
changes = [c for st in report for r in st.get('drifted', []) if r.get('logicalId') == 'DriftAsg'
           for c in r.get('changes', []) if c.get('path', '').startswith('MetricsCollection')]
print(len(changes))
PY
}
N=$(metrics_drift "step 6c (legacy ALL baseline)")
if [ "${N}" != "0" ]; then
  echo "[verify] FAIL: step 6c: cdkd drift reported MetricsCollection drift for ALL against the per-metric readback (#4021)"
  exit 1
fi
echo "[verify] step 6c ok: legacy ALL baseline compares clean against the per-metric readback"

# Still reported when a metric is disabled out of band.
aws autoscaling disable-metrics-collection --auto-scaling-group-name "${ASG_NAME}" \
  --metrics GroupMinSize --region "${REGION}"
wait_asg_metrics "" "GroupMinSize" "step 6c (out-of-band disable)"
N=$(metrics_drift "step 6c (legacy ALL baseline, GroupMinSize disabled)")
if [ "${N}" = "0" ]; then
  echo "[verify] FAIL: step 6c: cdkd drift did not report GroupMinSize disabled out of band under an ALL baseline"
  exit 1
fi
echo "[verify] step 6c ok: an out-of-band disable under ALL is reported as drift"

# ...and reverted, still on the legacy ALL record: the revert must re-enable
# GroupMinSize (sent as AWS's ALL) and disable nothing.
if ! ${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}" 2>"${DRIFT_JSON}.err"; then
  echo "[verify] FAIL: step 6c: cdkd drift --revert of the legacy ALL record failed:"
  tail -30 "${DRIFT_JSON}.err"
  exit 1
fi
rm -f "${DRIFT_JSON}.err"
wait_asg_metrics "${KNOWN_METRICS}" "" "step 6c (drift --revert re-enabled every known metric, #4021)"
echo "[verify] step 6c ok: drift --revert of the legacy ALL record restored every known metric"
aws s3 cp "${STATE_ORIG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
STATE_PLANTED=0
rm -f "${STATE_ORIG}" "${STATE_PLANT}" "${DRIFT_JSON}"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
