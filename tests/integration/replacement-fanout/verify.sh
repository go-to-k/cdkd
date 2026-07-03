#!/usr/bin/env bash
# verify.sh — cdkd replacement FAN-OUT propagation integ test (issue #807).
#
# #807 fixed the basic replacement-propagation case on ECS (a replaced
# TaskDefinition's new revision is picked up by the dependent Service). This
# fixture stresses the SAME propagation at FAN-OUT scale: ONE base resource
# that gets a NEW physical id on replacement, referenced by MANY dependents.
# A fan-out gap (any single dependent left pointing at the STALE phase-a value)
# is exactly the class of bug a narrow 1-dependent ECS test cannot surface.
#
# Topology:
#   Base       AWS::SNS::Topic        TopicName cdkd-replacement-fanout-{region}-a
#              -> phase b renames it -b  -> REPLACEMENT (new topic ARN; SNS Ref
#                 resolves to the ARN). TopicName is in the SNS replacement set.
#   Dependents 10x AWS::SSM::Parameter Value = "arn=<topicArn>|idx=N" via Fn::Sub
#              of Ref(topic). Auto-named -> SAME parameter physical id across the
#              flip; only the embedded ARN changes (an in-place Value update).
#   Extra dep  1x AWS::SNS::TopicPolicy Resource = Ref(topic) ARN. Must re-point
#              at the new topic on phase b.
#
# Flow:
#   Phase a   deploy `-c phase=a` -> capture base topic ARN + every dependent's
#             AWS-resolved Value (must all embed the phase-a ARN).
#   Phase b   redeploy `-c phase=b` -> base REPLACED (new ARN, old topic gone).
#             Assert EVERY dependent's AWS Value now embeds the NEW ARN (not the
#             stale phase-a ARN) AND each parameter kept its physical id. The
#             TopicPolicy must reference the new topic ARN too. If ANY dependent
#             still carries the phase-a ARN -> FAIL naming it (a #807 fan-out gap).
#   Destroy   -> assert state gone, topic gone, every parameter gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# Portability notes (committed-file BSD/macOS rules):
#   - no `grep -P` / `date -d`; field comparisons use jq, not PCRE.
#   - real rc is captured to a var, never trusted through a pipe.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdReplacementFanoutExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # Sidecar deployment events live in a separate key family from state.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/deployments/" --recursive >/dev/null 2>&1 || true
  fi
  # Belt-and-suspenders: the base topic name is fully predictable
  # (cdkd-replacement-fanout-{region}-a / -b). If a deploy crashed
  # MID-REPLACEMENT — after the -b topic was created but before state caught
  # up — `state destroy` may not know about both names, so directly delete both
  # predictable topics so a re-run is not blocked by a leftover topic.
  cleanup_acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  if [ -n "${cleanup_acct}" ] && [ "${cleanup_acct}" != "None" ]; then
    for sfx in a b; do
      topic_arn="arn:aws:sns:${REGION}:${cleanup_acct}:cdkd-replacement-fanout-${REGION}-${sfx}"
      aws sns delete-topic --topic-arn "${topic_arn}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  set -eu
}

trap cleanup EXIT

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

echo "==> Pre-run cleanup"
cleanup

# --- Phase a: deploy (-c phase=a) -------------------------------------
echo "==> Phase a: deploy with the local binary (-c phase=a)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c phase=a \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after phase-a deploy" >&2
  exit 1
fi

TOPIC_ARN_A=$(echo "${STATE}" | jq -r '.outputs.BaseTopicArn // empty')
DEP_COUNT=$(echo "${STATE}" | jq -r '.outputs.DependentCount // empty')
if [ -z "${TOPIC_ARN_A}" ] || [ -z "${DEP_COUNT}" ]; then
  echo "FAIL: BaseTopicArn / DependentCount missing from state after phase-a deploy" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
echo "    captured: baseTopicArn(phase a)=${TOPIC_ARN_A} dependents=${DEP_COUNT}"

# Sanity: the phase-a topic ARN must end with the -a suffix and exist on AWS.
case "${TOPIC_ARN_A}" in
  *cdkd-replacement-fanout-${REGION}-a) ;;
  *) echo "FAIL: phase-a topic ARN '${TOPIC_ARN_A}' does not end with the expected '-a' suffix" >&2; exit 1 ;;
esac
if ! aws sns get-topic-attributes --topic-arn "${TOPIC_ARN_A}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: phase-a base topic '${TOPIC_ARN_A}' does not exist on AWS after deploy" >&2
  exit 1
fi
echo "    OK (baseline): base topic exists (phase a)"

# Capture each dependent parameter's physical id (Name) + AWS-resolved Value.
# The verify queries AWS directly (get-parameter), not state, so it proves the
# value actually REACHED AWS — not just that cdkd recorded it.
DEP_NAMES=()
for i in $(seq 0 $((DEP_COUNT - 1))); do
  pname=$(echo "${STATE}" | jq -r ".outputs.Dependent${i}Name // empty")
  if [ -z "${pname}" ]; then
    echo "FAIL: state output Dependent${i}Name is missing after phase-a deploy" >&2
    exit 1
  fi
  DEP_NAMES+=("${pname}")
  val=$(aws ssm get-parameter --name "${pname}" --region "${REGION}" --output json 2>/dev/null | jq -r '.Parameter.Value // empty')
  if [ -z "${val}" ]; then
    echo "FAIL: dependent ${i} parameter '${pname}' has no Value on AWS after phase-a deploy" >&2
    exit 1
  fi
  # Baseline: every dependent must embed the phase-a topic ARN.
  case "${val}" in
    "arn=${TOPIC_ARN_A}|idx=${i}") ;;
    *) echo "FAIL: dependent ${i} ('${pname}') phase-a Value '${val}' does not match the expected 'arn=${TOPIC_ARN_A}|idx=${i}'" >&2; exit 1 ;;
  esac
done
echo "    OK (baseline): all ${DEP_COUNT} dependents embed the phase-a topic ARN"

# Baseline: the TopicPolicy references the phase-a topic ARN.
POLICY_A=$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN_A}" --region "${REGION}" --output json 2>/dev/null \
  | jq -r '.Attributes.Policy // empty')
if [ -z "${POLICY_A}" ]; then
  echo "FAIL: phase-a base topic has no Policy attribute after deploy (TopicPolicy did not attach)" >&2
  exit 1
fi
HAS_A_IN_POLICY=$(echo "${POLICY_A}" | jq -r --arg arn "${TOPIC_ARN_A}" '[.. | strings] | any(. == $arn or (. | contains($arn)))')
if [ "${HAS_A_IN_POLICY}" != "true" ]; then
  echo "FAIL: phase-a TopicPolicy does not reference the phase-a topic ARN '${TOPIC_ARN_A}'" >&2
  echo "${POLICY_A}" | jq '.'
  exit 1
fi
echo "    OK (baseline): TopicPolicy references the phase-a topic ARN"

# --- Phase b: redeploy (-c phase=b) -> base REPLACED ------------------
echo "==> Phase b: redeploy with -c phase=b (forces base topic replacement)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c phase=b \
  --yes

STATE_B=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_B}" ]; then
  echo "FAIL: no state file after the phase-b deploy" >&2
  exit 1
fi

TOPIC_ARN_B=$(echo "${STATE_B}" | jq -r '.outputs.BaseTopicArn // empty')
if [ -z "${TOPIC_ARN_B}" ]; then
  echo "FAIL: BaseTopicArn missing from state after phase-b deploy" >&2
  exit 1
fi

# --- Replacement assertion: base topic ARN CHANGED -------------------
if [ "${TOPIC_ARN_B}" = "${TOPIC_ARN_A}" ]; then
  echo "FAIL: base topic ARN is still '${TOPIC_ARN_A}' after a TopicName change — expected a REPLACEMENT (new ARN)" >&2
  exit 1
fi
case "${TOPIC_ARN_B}" in
  *cdkd-replacement-fanout-${REGION}-b) ;;
  *) echo "FAIL: new base topic ARN '${TOPIC_ARN_B}' does not end with the expected '-b' suffix" >&2; exit 1 ;;
esac
# New topic must exist...
if ! aws sns get-topic-attributes --topic-arn "${TOPIC_ARN_B}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: new base topic '${TOPIC_ARN_B}' does not exist on AWS after replacement" >&2
  exit 1
fi
# ...and the old topic must be GONE (replacement deletes the original).
if aws sns get-topic-attributes --topic-arn "${TOPIC_ARN_A}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: old base topic '${TOPIC_ARN_A}' still exists after replacement — old physical resource was not cleaned up" >&2
  exit 1
fi
echo "    OK (replacement): base topic ARN CHANGED ${TOPIC_ARN_A} -> ${TOPIC_ARN_B}, old gone, new present"

# --- FAN-OUT assertion: EVERY dependent picks up the NEW ARN ----------
# This is the core of the test. A #807 fan-out gap = ANY single dependent left
# pointing at the stale phase-a ARN. We attribute the failure to the exact
# dependent index so a partial-propagation bug is pinpointed, not just detected.
STALE_DEPENDENTS=()
for i in $(seq 0 $((DEP_COUNT - 1))); do
  pname="${DEP_NAMES[$i]}"
  # Dependent must keep its physical id (auto-named -> in-place Value update).
  pname_after=$(echo "${STATE_B}" | jq -r ".outputs.Dependent${i}Name // empty")
  if [ "${pname_after}" != "${pname}" ]; then
    echo "FAIL: dependent ${i} physical id changed ('${pname}' -> '${pname_after}') — expected an in-place Value update, not a replacement" >&2
    exit 1
  fi
  val=$(aws ssm get-parameter --name "${pname}" --region "${REGION}" --output json 2>/dev/null | jq -r '.Parameter.Value // empty')
  if [ -z "${val}" ]; then
    echo "FAIL: dependent ${i} parameter '${pname}' has no Value on AWS after phase-b deploy" >&2
    exit 1
  fi
  expected="arn=${TOPIC_ARN_B}|idx=${i}"
  if [ "${val}" != "${expected}" ]; then
    # Distinguish "kept the stale phase-a ARN" (the #807 fan-out gap) from any
    # other unexpected value, so the failure message is precise.
    case "${val}" in
      "arn=${TOPIC_ARN_A}|idx=${i}")
        echo "FAIL (#807 fan-out gap): dependent ${i} ('${pname}') STILL points at the STALE phase-a ARN '${TOPIC_ARN_A}' — replacement was NOT propagated to this dependent" >&2
        STALE_DEPENDENTS+=("${i}")
        ;;
      *)
        echo "FAIL: dependent ${i} ('${pname}') Value '${val}' does not match the expected '${expected}'" >&2
        STALE_DEPENDENTS+=("${i}")
        ;;
    esac
  fi
done
if [ "${#STALE_DEPENDENTS[@]}" -ne 0 ]; then
  echo "FAIL: ${#STALE_DEPENDENTS[@]} of ${DEP_COUNT} dependents did NOT pick up the new base ARN (indices: ${STALE_DEPENDENTS[*]}) — #807 replacement propagation does not fully fan out" >&2
  exit 1
fi
echo "    OK (fan-out): all ${DEP_COUNT} dependents re-resolved to the NEW base ARN ${TOPIC_ARN_B}"

# --- Extra dependent: TopicPolicy re-points at the new topic ----------
POLICY_B=$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN_B}" --region "${REGION}" --output json 2>/dev/null \
  | jq -r '.Attributes.Policy // empty')
if [ -z "${POLICY_B}" ]; then
  echo "FAIL: new base topic has no Policy attribute after phase-b deploy (TopicPolicy did not re-attach)" >&2
  exit 1
fi
HAS_B_IN_POLICY=$(echo "${POLICY_B}" | jq -r --arg arn "${TOPIC_ARN_B}" '[.. | strings] | any(. == $arn or (. | contains($arn)))')
if [ "${HAS_B_IN_POLICY}" != "true" ]; then
  echo "FAIL: phase-b TopicPolicy does not reference the new topic ARN '${TOPIC_ARN_B}'" >&2
  echo "${POLICY_B}" | jq '.'
  exit 1
fi
# And it must NOT still reference the stale phase-a ARN.
HAS_STALE_IN_POLICY=$(echo "${POLICY_B}" | jq -r --arg arn "${TOPIC_ARN_A}" '[.. | strings] | any(. == $arn or (. | contains($arn)))')
if [ "${HAS_STALE_IN_POLICY}" = "true" ]; then
  echo "FAIL (#807 fan-out gap): phase-b TopicPolicy STILL references the stale phase-a ARN '${TOPIC_ARN_A}'" >&2
  echo "${POLICY_B}" | jq '.'
  exit 1
fi
echo "    OK (extra dependent): TopicPolicy re-points at the new topic ARN, stale ARN gone"

# --- Destroy ----------------------------------------------------------
echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# The (replaced) base topic must be gone.
if aws sns get-topic-attributes --topic-arn "${TOPIC_ARN_B}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: base topic '${TOPIC_ARN_B}' still exists after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: base topic is gone after destroy"

# Every dependent parameter must be NOT-FOUND in AWS after destroy. The
# parameters are auto-named (logical-id derived), so a lingering parameter is a
# true orphan that no topic-gone check would surface.
ORPHAN_PARAMS=()
for i in $(seq 0 $((DEP_COUNT - 1))); do
  pname="${DEP_NAMES[$i]}"
  if aws ssm get-parameter --name "${pname}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: dependent ${i} parameter '${pname}' still exists after destroy (orphan)" >&2
    ORPHAN_PARAMS+=("${i}")
  fi
done
if [ "${#ORPHAN_PARAMS[@]}" -ne 0 ]; then
  echo "FAIL: ${#ORPHAN_PARAMS[@]} dependent parameter(s) orphaned after destroy (indices: ${ORPHAN_PARAMS[*]})" >&2
  exit 1
fi
echo "    OK: all ${DEP_COUNT} dependent parameters are gone after destroy"

echo ""
echo "==> replacement-fanout test passed (base SNS topic replacement propagated to all ${DEP_COUNT} SSM-parameter dependents + the TopicPolicy + clean destroy)"
echo "[verify] PASS"
