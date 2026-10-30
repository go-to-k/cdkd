#!/usr/bin/env bash
# verify.sh — ALB integ + ListenerAttributes backfill assertion (#609)
#
# Deploys the ALB stack (VPC + ALB + TargetGroup + Listener), asserts the
# Listener's `routing.http.response.server.enabled` attribute the fixture sets
# via the L1 escape hatch actually reached AWS (cdkd applies it through a
# post-create ModifyListenerAttributes call), asserts the #609 LB+TG
# silent-drop batch baseline (TG IpAddressType, TargetGroupAttributes,
# Targets registration), re-deploys with CDKD_TEST_UPDATE=true (attribute
# diff + target swap via RegisterTargets+DeregisterTargets), re-deploys with
# CDKD_TEST_REMOVAL=true (issue #1160) and asserts what a CloudFormation
# update does with each removal (CFn A/B us-east-1 2026-10-17): the custom
# HealthCheckPort of the HTTP and the GENEVE target group resets to
# `traffic-port`, the ALB's dropped `IpAddressType: dualstack` resets to
# `ipv4`, and a key dropped from TargetGroupAttributes (deregistration_delay
# 60) or LoadBalancerAttributes (idle_timeout 180) keeps its live value.
# Then destroys and verifies clean.
#
# The removal phase also drops the Listener's ListenerAttributes, whose
# removed key keeps its live value too (routing.http.response.server.enabled
# stays false, #1160), and keeps routing.http2.enabled templated as 'false' so
# the readback shows the LB update did not reset the whole list (#1609 item 1).
# Phase 3.5 then drops the listener's Port and Protocol: both keep their live
# values, as CloudFormation keeps them (CFn A/B us-east-1 2026-10-20), and the
# warning says so. A restore deploy puts them back before Phase 4.
# MinimumLoadBalancerCapacity is unit-only: the integ account lacks the LCU
# capacity-reservation entitlement (see the note in lib/alb-stack.ts).
#
# PLUS issue #4606 (Phase 4): a `--no-rollback` deploy whose load balancer
# CREATE fails after AWS made it (and whose cleanup cannot delete it), then a
# fix-forward under the same logical id: that successful deploy deletes the
# earlier load balancer and exits 0.
#
# PLUS issue #4679 (Phase 2.5): the listener record is seeded to
# provisionedBy=cc-api, and the removal redeploy must return it to the SDK
# provider on the same ARN.
#
# PLUS issue #4689 (Phase 5): a `--recreate-via-cc-api` of the listener must
# REPLACE its HealthRule onto the new listener (the rule's create-only
# `ListenerArn` is also write-only), not update the rule AWS already deleted.
#
# PLUS issue #4690 (Phase 6): a `--recreate-via-sdk-provider` of the listener
# followed by a failure in the same deploy; the automatic rollback must delete
# the new listener before re-creating the old one on the same port.
#
# Run via: /run-integ alb
#         or: bash tests/integration/alb/verify.sh

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="AlbStack"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"
EXPECTED_ATTR_KEY="routing.http.response.server.enabled"
EXPECTED_ATTR_VAL="false"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors tolerated)"
  rm -f "${FF_LOG:-}" "${REMOVAL_LOG:-}" "${P35_LOG:-}" "${P5_LOG:-}" "${P6_LOG:-}"
  # go-to-k/cdkd#4606: the Phase 4 injection's load balancer is created with
  # deletion protection on, and unfixed, the fix-forward settle drops it from
  # the rollback journal, so nothing else reaches it. Clear the protection and
  # delete it BEFORE the destroy (it holds the stack's security group). Only
  # the ARN THIS run captured, never one found by name.
  case "${ORPHAN_LB_ARN:-}" in
    arn:*:loadbalancer/*)
      aws elbv2 modify-load-balancer-attributes --load-balancer-arn "${ORPHAN_LB_ARN}" \
        --attributes Key=deletion_protection.enabled,Value=false --region "${AWS_REGION}" >/dev/null 2>&1 || true
      aws elbv2 delete-load-balancer --load-balancer-arn "${ORPHAN_LB_ARN}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
      ;;
  esac
  # go-to-k/cdkd#4689: a Phase 5 recreate that failed mid-way can leave a
  # listener state no longer records, forwarding to the target group, so the
  # destroy's target-group delete would fail in use. Delete every listener on
  # this run's load balancer (by the ARN this run captured) BEFORE the
  # destroy; a listener's rules go with it, and the destroy reads a listener
  # or rule already gone as deleted.
  # Best-effort, as the rest of this cleanup: `set +e` for the remainder.
  set +e
  if [ -n "${P5_OLD_LISTENER:-}" ]; then
    case "${LB_ARN:-}" in
      arn:*:loadbalancer/app/*)
        for arn in $(aws elbv2 describe-listeners --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
          --query 'Listeners[].ListenerArn' --output text 2>/dev/null); do
          case "${arn}" in
            arn:*:listener/app/*)
              aws elbv2 delete-listener --listener-arn "${arn}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
              ;;
          esac
        done
        ;;
    esac
  fi
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight orphan scan"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: state ${STATE_KEY} already exists — clean up first."
  exit 1
} || true

echo ""
echo "==> Deploy ${STACK}"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Assert ListenerAttributes reached AWS (#609 backfill)"
# Resolve the Listener ARN from cdkd state (the Listener physicalId IS its ARN).
STATE_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
LISTENER_ARN=$(echo "${STATE_BODY}" | python3 -c '
import sys, json
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::ElasticLoadBalancingV2::Listener":
        print(v["physicalId"]); break
')
if [[ -z "${LISTENER_ARN}" ]]; then
  echo "FAIL: could not find Listener ARN in cdkd state"
  exit 1
fi
echo "    listener: ${LISTENER_ARN}"

ATTR_VAL=$(aws elbv2 describe-listener-attributes --listener-arn "${LISTENER_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='${EXPECTED_ATTR_KEY}'].Value | [0]" --output text 2>/dev/null)
if [[ "${ATTR_VAL}" != "${EXPECTED_ATTR_VAL}" ]]; then
  echo "FAIL: listener attribute ${EXPECTED_ATTR_KEY} is '${ATTR_VAL}', expected '${EXPECTED_ATTR_VAL}'"
  echo "    (this is the #609 ListenerAttributes backfill — a wrong/missing value means the post-create ModifyListenerAttributes did not apply)"
  exit 1
fi
echo "    ${EXPECTED_ATTR_KEY}=${ATTR_VAL} reached AWS (✓)"

echo ""
echo "==> Assert TargetGroup baseline HealthCheckPort (issue #1160 elbv2 batch)"
TG_ARN=$(echo "${STATE_BODY}" | python3 -c '
import sys, json
s = json.load(sys.stdin)
# GeneveTargetGroup is a TargetGroup too: select the HTTP one by logical id.
for k, v in s["resources"].items():
    if v["resourceType"] == "AWS::ElasticLoadBalancingV2::TargetGroup" and k.startswith("TargetGroup"):
        print(v["physicalId"]); break
')
if [[ -z "${TG_ARN}" ]]; then
  echo "FAIL: could not find TargetGroup ARN in cdkd state"
  exit 1
fi
HC_PORT_P1=$(aws elbv2 describe-target-groups --target-group-arns "${TG_ARN}" --region "${AWS_REGION}" \
  --query 'TargetGroups[0].HealthCheckPort' --output text)
if [[ "${HC_PORT_P1}" != "8080" ]]; then
  echo "FAIL: baseline HealthCheckPort is '${HC_PORT_P1}', expected '8080'"
  exit 1
fi
echo "    baseline HealthCheckPort=8080 reached AWS (✓)"
GENEVE_TG_ARN=$(echo "${STATE_BODY}" | jq -r '.resources.GeneveTargetGroup.physicalId // empty')
if [[ -z "${GENEVE_TG_ARN}" ]]; then
  echo "FAIL: could not find GeneveTargetGroup ARN in cdkd state"
  exit 1
fi
GENEVE_HC_PORT_P1=$(aws elbv2 describe-target-groups --target-group-arns "${GENEVE_TG_ARN}" --region "${AWS_REGION}" \
  --query 'TargetGroups[0].HealthCheckPort' --output text)
if [[ "${GENEVE_HC_PORT_P1}" != "8080" ]]; then
  echo "FAIL: baseline GENEVE HealthCheckPort is '${GENEVE_HC_PORT_P1}', expected '8080'"
  exit 1
fi
echo "    baseline GENEVE HealthCheckPort=8080 reached AWS (✓)"

echo ""
echo "==> Assert #609 LB+TG batch baseline (IpAddressType / TargetGroupAttributes / Targets)"
TG_IP_TYPE=$(aws elbv2 describe-target-groups --target-group-arns "${TG_ARN}" --region "${AWS_REGION}" \
  --query 'TargetGroups[0].IpAddressType' --output text)
if [[ "${TG_IP_TYPE}" != "ipv4" ]]; then
  echo "FAIL: TargetGroup IpAddressType is '${TG_IP_TYPE}', expected 'ipv4' (CreateTargetGroup wiring)"
  exit 1
fi
DEREG_P1=$(aws elbv2 describe-target-group-attributes --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" --output text)
if [[ "${DEREG_P1}" != "45" ]]; then
  echo "FAIL: deregistration_delay is '${DEREG_P1}', expected '45' (post-create ModifyTargetGroupAttributes)"
  exit 1
fi
BASE_TARGET=$(aws elbv2 describe-target-health --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "TargetHealthDescriptions[?Target.Id=='10.0.0.100'].Target.Id | [0]" --output text)
if [[ "${BASE_TARGET}" != "10.0.0.100" ]]; then
  echo "FAIL: target 10.0.0.100 not registered (post-create RegisterTargets)"
  exit 1
fi
echo "    IpAddressType=ipv4, deregistration_delay=45, target 10.0.0.100 registered (✓)"

echo ""
echo "==> Assert LoadBalancerAttributes baseline (issue #1609 item 1)"
# The LB attribute diff arm (ModifyLoadBalancerAttributes) had never been
# exercised by an integ removal phase, and its sibling
# ModifyTargetGroupAttributes was live-proven to REJECT the Value:'' reset
# both arms shipped with. Baseline must be live before the removal phase can
# assert it is gone (the REMOVAL-testing convention).
LB_ARN=$(echo "${STATE_BODY}" | python3 -c '
import sys, json
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::ElasticLoadBalancingV2::LoadBalancer":
        print(v["physicalId"]); break
')
if [[ -z "${LB_ARN}" ]]; then
  echo "FAIL: could not find LoadBalancer ARN in cdkd state"
  exit 1
fi
IDLE_P1=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" --output text)
if [[ "${IDLE_P1}" != "120" ]]; then
  echo "FAIL: idle_timeout.timeout_seconds is '${IDLE_P1}', expected '120' (post-create ModifyLoadBalancerAttributes)"
  exit 1
fi
HTTP2_P1=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='routing.http2.enabled'].Value | [0]" --output text)
if [[ "${HTTP2_P1}" != "false" ]]; then
  echo "FAIL: routing.http2.enabled is '${HTTP2_P1}', expected the templated 'false' (AWS default is 'true')"
  exit 1
fi
echo "    idle_timeout.timeout_seconds=120, routing.http2.enabled=false reached AWS (✓)"
LB_IP_TYPE_P1=$(aws elbv2 describe-load-balancers --load-balancer-arns "${LB_ARN}" --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].IpAddressType' --output text)
if [[ "${LB_IP_TYPE_P1}" != "dualstack" ]]; then
  echo "FAIL: ALB IpAddressType is '${LB_IP_TYPE_P1}', expected the templated 'dualstack'"
  exit 1
fi
echo "    ALB IpAddressType=dualstack reached AWS (✓)"

echo ""
echo "==> Update redeploy: attribute diff + target swap (#609)"
CDKD_TEST_UPDATE=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

DEREG_P2=$(aws elbv2 describe-target-group-attributes --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" --output text)
if [[ "${DEREG_P2}" != "60" ]]; then
  echo "FAIL: deregistration_delay is '${DEREG_P2}' after update, expected '60' (ModifyTargetGroupAttributes diff)"
  exit 1
fi
NEW_TARGET=$(aws elbv2 describe-target-health --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "TargetHealthDescriptions[?Target.Id=='10.0.0.101'].Target.Id | [0]" --output text)
if [[ "${NEW_TARGET}" != "10.0.0.101" ]]; then
  echo "FAIL: target 10.0.0.101 not registered after update (RegisterTargets on update)"
  exit 1
fi
# The swapped-out target must be gone or draining (deregistration is async).
OLD_TARGET_STATE=$(aws elbv2 describe-target-health --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "TargetHealthDescriptions[?Target.Id=='10.0.0.100'].TargetHealth.State | [0]" --output text)
if [[ "${OLD_TARGET_STATE}" != "None" && "${OLD_TARGET_STATE}" != "draining" && "${OLD_TARGET_STATE}" != "unused" ]]; then
  echo "FAIL: target 10.0.0.100 is '${OLD_TARGET_STATE}' after update, expected gone/draining (DeregisterTargets on update)"
  exit 1
fi
# MinimumLoadBalancerCapacity is NOT asserted here — the integ account lacks
# the LCU capacity-reservation entitlement (ModifyCapacityReservation is
# rejected account-wide; live-verified 2026-08-11). Unit-only coverage.
IDLE_P2=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" --output text)
if [[ "${IDLE_P2}" != "180" ]]; then
  echo "FAIL: idle_timeout.timeout_seconds is '${IDLE_P2}' after update, expected '180' (ModifyLoadBalancerAttributes diff)"
  exit 1
fi
echo "    deregistration_delay=60, idle_timeout=180, target swapped to 10.0.0.101 (✓)"

# --- Phase 2.5: seed a cc-api listener record (go-to-k/cdkd#4679) ------------
# A listener first deployed while tagged, before go-to-k/cdkd#4673, was created
# through Cloud Control and its record says provisionedBy=cc-api, which the
# sticky rule kept on Cloud Control even after its type gained full SDK
# coverage. The listener is now an 'sdk-coverage' sticky exemption (the SDK
# path is faster), so the removal redeploy below must move the record back to
# the SDK provider ON THE SAME ARN.
#
# The record is SEEDED to cc-api (the go-to-k/cdkd#4117 precedent in
# lambda-event-invoke-config-update), not recreated through Cloud Control: this
# binary has no Cloud Control route for a fresh listener, and a
# --recreate-via-cc-api would give the listener a new ARN, which the readbacks
# below address by the old one (Phase 5 runs that recreate last). The flip
# reads only the record's layer and its template property bag, which do not
# depend on the layer that created the listener.
listener_record() { # usage: listener_record <jq path under the resource>; "" when absent
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  printf '%s' "${state}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ElasticLoadBalancingV2::Listener") | .value'"$1"'] | first // ""'
}
LISTENER_LOGICAL=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ElasticLoadBalancingV2::Listener") | .key] | first // ""')
[ -n "${LISTENER_LOGICAL}" ] || { echo "FAIL: #4679: no Listener record in cdkd state"; exit 1; }
SEED_ARN=$(listener_record .physicalId)
[ "${SEED_ARN}" = "${LISTENER_ARN}" ] || {
  echo "FAIL: #4679 premise: the listener record holds '${SEED_ARN}', expected ${LISTENER_ARN}"
  exit 1
}
PRE_LAYER=$(listener_record .provisionedBy)
[ "${PRE_LAYER}" = "sdk" ] || {
  echo "FAIL: #4679 premise: the listener is provisionedBy '${PRE_LAYER}' before seeding, expected sdk"
  exit 1
}
# Cloud Control addresses the listener by the ARN cdkd stored. This is the
# physicalId parity the exemption needs: a record Cloud Control wrote holds
# the identifier it returns here.
CC_IDENTIFIER=$(aws cloudcontrol get-resource --type-name AWS::ElasticLoadBalancingV2::Listener \
  --identifier "${LISTENER_ARN}" --region "${AWS_REGION}" --query 'ResourceDescription.Identifier' --output text)
[ "${CC_IDENTIFIER}" = "${LISTENER_ARN}" ] || {
  echo "FAIL: #4679: Cloud Control's identifier '${CC_IDENTIFIER}' differs from cdkd's physicalId '${LISTENER_ARN}'"
  exit 1
}
echo "    Cloud Control addresses ${LISTENER_LOGICAL} by cdkd's physicalId (✓)"

echo ""
echo "==> Phase 2.5: seed the ${LISTENER_LOGICAL} record to provisionedBy=cc-api (#4679)"
# Assignments, not argument substitutions, so a failed read or jq aborts here
# under `set -e` instead of uploading an empty state file.
SEED_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
SEEDED=$(printf '%s' "${SEED_STATE}" | jq --arg id "${LISTENER_LOGICAL}" '.resources[$id].provisionedBy = "cc-api"')
# An empty read exits 0 and jq prints nothing: never upload that over the state.
[ -n "${SEEDED}" ] || { echo "FAIL: #4679: the seeded state is empty -- not uploading it"; exit 1; }
printf '%s\n' "${SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
SEEDED_LAYER=$(listener_record .provisionedBy)
[ "${SEEDED_LAYER}" = "cc-api" ] || {
  echo "FAIL: #4679: seeding the listener record to cc-api did not stick (got '${SEEDED_LAYER}') -- every assertion below would be vacuous"
  exit 1
}
echo "    ${LISTENER_LOGICAL} recorded as cc-api (✓)"

echo ""
echo "==> Assert the plan announces the listener's return to the SDK provider (#4679)"
# Pre-fix, this is the first assertion to go red: the diff tags the listener
# `sticky` instead.
REMOVAL_DIFF=$(CDKD_TEST_REMOVAL=true ${CDKD} diff ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 || true)
if ! grep -F "${LISTENER_LOGICAL}" <<<"${REMOVAL_DIFF}" | grep -qF 'returning to SDK provider'; then
  echo "FAIL: #4679: cdkd diff does not announce '${LISTENER_LOGICAL} ... [returning to SDK provider]'"
  printf '%s\n' "${REMOVAL_DIFF}"
  exit 1
fi
echo "    diff: ${LISTENER_LOGICAL} [returning to SDK provider] (✓)"

echo ""
echo "==> Removal redeploy: drop HealthCheckPort (issue #1160 elbv2 batch)"
REMOVAL_LOG=$(mktemp)
if ! CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" \
  >"${REMOVAL_LOG}" 2>&1; then
  cat "${REMOVAL_LOG}"
  echo "FAIL: the removal redeploy failed"
  exit 1
fi
REMOVAL_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${REMOVAL_LOG}")"
rm -f "${REMOVAL_LOG}"
REMOVAL_LOG=""
printf '%s\n' "${REMOVAL_PLAIN}"

# go-to-k/cdkd#4679: the cc-api listener record returned to the SDK provider
# in place.
POST_LAYER=$(listener_record .provisionedBy)
POST_ARN=$(listener_record .physicalId)
[ "${POST_LAYER}" = "sdk" ] || {
  echo "FAIL: #4679: the removal redeploy left the listener record on '${POST_LAYER}', expected it to return to sdk"
  exit 1
}
# The listener ARN ends in an id AWS mints per create, so an unchanged ARN is
# the identity witness: a replacement would have minted another.
[ "${POST_ARN}" = "${LISTENER_ARN}" ] || {
  echo "FAIL: #4679: the return to the SDK provider changed the listener ARN (${LISTENER_ARN} -> ${POST_ARN})"
  exit 1
}
# No `-q`: an early exit would SIGPIPE the first grep and, under pipefail,
# read as "no match".
if grep -F "${LISTENER_LOGICAL}" <<<"${REMOVAL_PLAIN}" | grep -i 'replac' >/dev/null; then
  echo "FAIL: #4679: the removal redeploy REPLACED ${LISTENER_LOGICAL} instead of updating it in place:"
  grep -F "${LISTENER_LOGICAL}" <<<"${REMOVAL_PLAIN}" | grep -i 'replac'
  exit 1
fi
if ! grep -qF "${LISTENER_LOGICAL} (AWS::ElasticLoadBalancingV2::Listener): returning to the SDK provider" <<<"${REMOVAL_PLAIN}"; then
  echo "FAIL: #4679: the record flipped, but no 'returning to the SDK provider' line names ${LISTENER_LOGICAL} -- the wording drifted"
  exit 1
fi
echo "    ${LISTENER_LOGICAL} returned to the SDK provider on the same ARN (✓)"
# Issue #1160: the listener warns when a property ModifyListener keeps is
# removed. This redeploy drops only ListenerAttributes, whose kept key matches
# CloudFormation, so neither that warning nor the shared caller's may name it.
if grep -F "${LISTENER_LOGICAL} (AWS::ElasticLoadBalancingV2::Listener)" <<<"${REMOVAL_PLAIN}" \
  | grep -E 'removed from the template|absent from the state being restored' >/dev/null; then
  echo "FAIL: #1160: the removal redeploy warned about a removed listener property:"
  grep -F "${LISTENER_LOGICAL} (AWS::ElasticLoadBalancingV2::Listener)" <<<"${REMOVAL_PLAIN}"
  exit 1
fi
echo "    no left-in-place warning for ${LISTENER_LOGICAL}'s ListenerAttributes (✓)"

# Pre-fix the provider passed the absent field through and ModifyTargetGroup
# merged (port stayed 8080); post-fix the removal sends the explicit
# `traffic-port` reset — the one health-check field CloudFormation itself
# resets on removal (live CFn A/B 2026-08-10; the other HC fields are
# retained by CFn and stay pass-through).
HC_PORT_P2=$(aws elbv2 describe-target-groups --target-group-arns "${TG_ARN}" --region "${AWS_REGION}" \
  --query 'TargetGroups[0].HealthCheckPort' --output text)
if [[ "${HC_PORT_P2}" != "traffic-port" ]]; then
  echo "FAIL: HealthCheckPort is '${HC_PORT_P2}' after the removal redeploy, expected the CFn-parity reset 'traffic-port'"
  exit 1
fi
echo "    HealthCheckPort reset to traffic-port on removal (✓)"

# Issue #1160: the GENEVE group resets to `traffic-port` too, not to its
# protocol's create default 80. Before #1160 the provider sent nothing for a
# GENEVE group and the port stayed 8080.
GENEVE_HC_PORT_P2=$(aws elbv2 describe-target-groups --target-group-arns "${GENEVE_TG_ARN}" --region "${AWS_REGION}" \
  --query 'TargetGroups[0].HealthCheckPort' --output text)
if [[ "${GENEVE_HC_PORT_P2}" != "traffic-port" ]]; then
  echo "FAIL: GENEVE HealthCheckPort is '${GENEVE_HC_PORT_P2}' after the removal redeploy, expected the CFn-parity reset 'traffic-port'"
  exit 1
fi
echo "    GENEVE HealthCheckPort reset to traffic-port on removal (✓)"

# Issue #1160: the dropped `IpAddressType: dualstack` resets to `ipv4`.
# Before #1160 SetIpAddressType was never called and it stayed dualstack.
LB_IP_TYPE_P3=$(aws elbv2 describe-load-balancers --load-balancer-arns "${LB_ARN}" --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].IpAddressType' --output text)
if [[ "${LB_IP_TYPE_P3}" != "ipv4" ]]; then
  echo "FAIL: ALB IpAddressType is '${LB_IP_TYPE_P3}' after the removal redeploy, expected the CFn-parity reset 'ipv4'"
  exit 1
fi
echo "    ALB IpAddressType reset to ipv4 on removal (✓)"

echo ""
echo "==> Assert TargetGroupAttributes removal keeps the live value (issue #1160)"
# The removal phase drops deregistration_delay (the L2's own stickiness entry
# is all the list holds then). A CloudFormation update leaves a removed key at
# its live value, so it stays 60. Before #1160 the provider reset it to 300.
DEREG_P3=$(aws elbv2 describe-target-group-attributes --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" --output text)
if [[ "${DEREG_P3}" != "60" ]]; then
  echo "FAIL: deregistration_delay is '${DEREG_P3}' after removal, expected the live '60' kept (CloudFormation leaves a removed key)"
  exit 1
fi
echo "    deregistration_delay kept at 60 (✓)"

echo ""
echo "==> Assert LB + Listener attribute removal arms (issues #1160, #1609 item 1)"
# A key dropped from LoadBalancerAttributes keeps its live value, as a
# CloudFormation update leaves it (#1160). Before #1160 the provider reset
# idle_timeout to 60.
IDLE_P3=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" --output text)
if [[ "${IDLE_P3}" != "180" ]]; then
  echo "FAIL: idle_timeout.timeout_seconds is '${IDLE_P3}' after removal, expected the live '180' kept (CloudFormation leaves a removed key)"
  exit 1
fi
echo "    idle_timeout.timeout_seconds kept at 180 (✓)"

# The RETAINED SIBLING. routing.http2.enabled is templated 'false' in every
# phase while AWS's default is 'true', so this assertion shows the update did
# not reset the whole attribute list — a check the earlier
# deletion_protection.enabled sibling could not perform, because its templated
# value equalled its default and an over-broad reset read identically.
HTTP2_P3=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='routing.http2.enabled'].Value | [0]" --output text)
if [[ "${HTTP2_P3}" != "false" ]]; then
  echo "FAIL: routing.http2.enabled is '${HTTP2_P3}' after removal, expected the templated 'false' to be RETAINED"
  echo "    (a kept key was reset — the removal arm cleared more than the dropped key)"
  exit 1
fi
echo "    routing.http2.enabled retained as false (✓)"

LISTENER_ATTR_P3=$(aws elbv2 describe-listener-attributes --listener-arn "${LISTENER_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='${EXPECTED_ATTR_KEY}'].Value | [0]" --output text)
# Issue #1160: a removed listener attribute key keeps its live value, as a
# CloudFormation update leaves it. Before #1160 the provider reset it to true.
if [[ "${LISTENER_ATTR_P3}" != "false" ]]; then
  echo "FAIL: listener attribute ${EXPECTED_ATTR_KEY} is '${LISTENER_ATTR_P3}' after removal, expected the live 'false' kept (CloudFormation leaves a removed key)"
  exit 1
fi
echo "    ${EXPECTED_ATTR_KEY} kept at false (✓)"

# --- Phase 3.5: drop the listener's Port and Protocol (issue #1160) ----------
# A CloudFormation update keeps a removed Port / Protocol (CFn A/B us-east-1
# 2026-10-20, removed alone and beside a DefaultActions change). cdkd keeps
# both too and warns once, saying CloudFormation leaves them. Before this
# change the warning said nothing about CloudFormation, so the wording
# assertion below is the one that goes red on the old code. A second deploy
# restores both, so Phase 4 starts from the template it expects.
echo ""
echo "==> Phase 3.5: removal redeploy dropping the listener's Port and Protocol (#1160)"
P35_LOG=$(mktemp)
if ! CDKD_TEST_REMOVAL=true CDKD_TEST_LISTENER_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" >"${P35_LOG}" 2>&1; then
  cat "${P35_LOG}"
  echo "FAIL: #1160: the Port / Protocol removal redeploy failed"
  exit 1
fi
P35_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${P35_LOG}")"
rm -f "${P35_LOG}"
P35_LOG=""
printf '%s\n' "${P35_PLAIN}" | sed 's/^/  /'
[ "$(listener_record .provisionedBy)" = "sdk" ] || {
  echo "FAIL: #1160 premise: the listener is not on the SDK provider, so updateListener did not run"
  exit 1
}
[ "$(listener_record .physicalId)" = "${LISTENER_ARN}" ] || {
  echo "FAIL: #1160: dropping Port / Protocol replaced the listener instead of updating it in place"
  exit 1
}
P35_EXPECTED="${LISTENER_LOGICAL} (AWS::ElasticLoadBalancingV2::Listener): properties Port, Protocol were removed from the template and keep their current AWS value, as CloudFormation leaves them;"
if ! grep -qF "${P35_EXPECTED}" <<<"${P35_PLAIN}"; then
  echo "FAIL: #1160: no warning saying the removed Port / Protocol keep their value as CloudFormation leaves them. Expected:"
  echo "  ${P35_EXPECTED}"
  echo "Listener lines in the output:"
  grep -F "${LISTENER_LOGICAL} (AWS::ElasticLoadBalancingV2::Listener)" <<<"${P35_PLAIN}" || true
  exit 1
fi
echo "    warning names Port, Protocol and CloudFormation's keep (✓)"
P35_LIVE=$(aws elbv2 describe-listeners --listener-arns "${LISTENER_ARN}" --region "${AWS_REGION}" \
  --query 'Listeners[0].[Port,Protocol]' --output text)
if [ "${P35_LIVE}" != "$(printf '80\tHTTP')" ]; then
  echo "FAIL: #1160: the listener reads '${P35_LIVE}' after Port / Protocol were removed, expected the live 80 / HTTP kept (CloudFormation keeps both)"
  exit 1
fi
echo "    Port 80 / Protocol HTTP kept (✓)"

echo "==> Phase 3.5: restore the listener's Port and Protocol"
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

# --- Phase 4: the fix-forward of a failed CREATE (go-to-k/cdkd#4606) ---------
# A `--no-rollback` deploy whose OrphanLb CREATE fails after CreateLoadBalancer,
# with a cleanup that cannot delete it, journals it as a proven orphan. The
# fix-forward redeploy keeps the logical id with a valid shape under another
# name, so the CREATE succeeds and the record under that id holds a NEW load
# balancer. `ELBv2Provider.isSameResource` proves the earlier one is another
# resource: the deploy deletes it, keeps the new one, exits 0 and drops the
# journal. Before #4606 it warned, named the earlier one, exited 2 and left it.
# Every Phase 4 deploy keeps CDKD_TEST_REMOVAL=true, so OrphanLb is the only
# difference from the deployed template.
JOURNAL_KEY="cdkd/${STACK}/${AWS_REGION}/rollback-journal.json"
FF_LOG=$(mktemp)

state_physical_id() { # usage: state_physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg id "$1" '.resources[$id].physicalId // "<absent>"'
}

lb_attr() { # usage: lb_attr <arn> <key>
  aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$1" --region "${AWS_REGION}" \
    --query "Attributes[?Key=='$2'].Value | [0]" --output text
}

echo ""
echo "==> Phase 4: --no-rollback deploy whose OrphanLb CREATE fails after CreateLoadBalancer (#4606)"
set +e
CDKD_TEST_REMOVAL=true INJECT_LB_ORPHAN=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" --yes --no-rollback >"${FF_LOG}" 2>&1
LB_FAIL_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
# Captured BEFORE any FAIL below, from the cleanup warning, so the trap can
# clear the protection on and delete a load balancer no later check reached.
ORPHAN_LB_ARN="$(sed -n 's/.*Failed to clean up partially-created LoadBalancer OrphanLb (\(arn:[^)]*\)).*/\1/p' "${FF_LOG}" | head -1)"
if [ "${LB_FAIL_RC}" -eq 0 ]; then
  # Then state holds a deletion-protected OrphanLb, which the trap's destroy
  # (no --remove-protection) cannot delete: hand its ARN to the trap first.
  ORPHAN_LB_ARN="$(state_physical_id OrphanLb || true)"
  echo "FAIL: the OrphanLb injection deploy unexpectedly SUCCEEDED (SetSecurityGroups should reject the malformed enforce flag)" >&2
  exit 1
fi
# The injection's mechanism: the cleanup's DeleteLoadBalancer was refused, so
# the create marked the ARN for the journal. Any other failure would not
# exercise the fix-forward at all.
if ! grep -q "Failed to clean up partially-created LoadBalancer OrphanLb" "${FF_LOG}"; then
  echo "FAIL: the OrphanLb deploy failed, but not by a cleanup that could not delete the load balancer (output above)" >&2
  exit 1
fi
if [ "$(state_physical_id OrphanLb)" != "<absent>" ]; then
  echo "FAIL: state records OrphanLb after a CREATE that threw (expected no record)" >&2
  exit 1
fi
if ! JOURNAL_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"; then
  echo "FAIL: no rollback journal after the --no-rollback deploy of Phase 4" >&2
  exit 1
fi
ORPHAN_OP="$(printf '%s' "${JOURNAL_BODY}" | jq -c \
  '[.segments[]?.failedOperations[]? | select(.logicalId == "OrphanLb")] | last // empty')"
if [ -z "${ORPHAN_OP}" ] || [ "$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ]; then
  echo "FAIL: the journal does not carry OrphanLb as a proven orphan (op: ${ORPHAN_OP:-<none>})" >&2
  exit 1
fi
JOURNALED_LB_ARN="$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalId // ""')"
case "${JOURNALED_LB_ARN}" in
  arn:*:loadbalancer/app/*) ;;
  *) echo "FAIL: journaled OrphanLb id is not a load balancer ARN: '${JOURNALED_LB_ARN}'" >&2; exit 1;;
esac
if [ "${JOURNALED_LB_ARN}" != "${ORPHAN_LB_ARN}" ]; then
  echo "FAIL: the journal holds OrphanLb as '${JOURNALED_LB_ARN}', not the '${ORPHAN_LB_ARN}' the cleanup warning named" >&2
  exit 1
fi
if [ "$(lb_attr "${ORPHAN_LB_ARN}" deletion_protection.enabled)" != "true" ]; then
  echo "FAIL: the journaled ${ORPHAN_LB_ARN} is not deletion-protected (the injection did not fire as designed)" >&2
  exit 1
fi
echo "    OK: OrphanLb ${ORPHAN_LB_ARN} is journaled as a proven orphan, no state record"

# The settle's delete passes no --remove-protection, so a protected orphan
# stays journaled whatever the identity read says. Clear it out of band (the
# user's own fix), leaving the identity read as the one thing deciding.
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "${ORPHAN_LB_ARN}" \
  --attributes Key=deletion_protection.enabled,Value=false --region "${AWS_REGION}" >/dev/null
if [ "$(lb_attr "${ORPHAN_LB_ARN}" deletion_protection.enabled)" != "false" ]; then
  echo "FAIL: could not clear deletion protection on ${ORPHAN_LB_ARN}" >&2
  exit 1
fi

echo "==> Phase 4: the fix-forward deploy (same logical id, another name, valid shape)"
set +e
CDKD_TEST_REMOVAL=true INJECT_LB_ORPHAN=true LB_FIX_FORWARD=true ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes >"${FF_LOG}" 2>&1
LB_FF_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
if [ "${LB_FF_RC}" -ne 0 ]; then
  echo "FAIL: the OrphanLb fix-forward deploy exited ${LB_FF_RC} (expected 0: the earlier load balancer is proven another resource and deleted -- output above)" >&2
  echo "      (before go-to-k/cdkd#4606 it exited 2 and left the earlier OrphanLb)" >&2
  exit 1
fi
if ! grep -q "deleting partially-created OrphanLb" "${FF_LOG}"; then
  echo "FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanLb (output above)" >&2
  exit 1
fi
if grep -q "Skipping failed CREATE of OrphanLb" "${FF_LOG}"; then
  echo "FAIL: the fix-forward deploy still warned about the earlier OrphanLb instead of deleting it (output above)" >&2
  exit 1
fi
assert_gone "rollback journal s3://${STATE_BUCKET}/${JOURNAL_KEY} still present after the OrphanLb fix-forward deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
# DeleteLoadBalancer returns before the load balancer leaves the describe list.
for _ in $(seq 1 24); do
  gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${AWS_REGION}" && break
  sleep 5
done
assert_gone "the earlier attempt's ${ORPHAN_LB_ARN} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${AWS_REGION}"
FF_LB_ARN="$(state_physical_id OrphanLb)"
case "${FF_LB_ARN}" in
  arn:*:loadbalancer/app/*) ;;
  *) echo "FAIL: state records OrphanLb as '${FF_LB_ARN}' after the fix-forward (expected a load balancer ARN)" >&2; exit 1;;
esac
if [ "${FF_LB_ARN}" = "${ORPHAN_LB_ARN}" ]; then
  echo "FAIL: state records OrphanLb as the earlier attempt's ${ORPHAN_LB_ARN}" >&2
  exit 1
fi
# The new load balancer is the record's: deleting the earlier one must not touch it.
if gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${FF_LB_ARN}" --region "${AWS_REGION}"; then
  echo "FAIL: the fix-forward load balancer ${FF_LB_ARN} is gone (the settle must not delete the record's load balancer)" >&2
  exit 1
fi
echo "    OK: the fix-forward deleted ${ORPHAN_LB_ARN}, kept ${FF_LB_ARN}, exited 0 and dropped the journal"

# The fix-forward load balancer is a normal state resource: the next plain
# deploy removes it from the template and deletes it.
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes
for _ in $(seq 1 24); do
  gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${FF_LB_ARN}" --region "${AWS_REGION}" && break
  sleep 5
done
assert_gone "the fix-forward ${FF_LB_ARN} still exists after the deploy that removed it" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${FF_LB_ARN}" --region "${AWS_REGION}"
rm -f "${FF_LOG}"
echo "    OK: Phase 4 passed"

# --- Phase 5: recreate the listener WITH its rule (go-to-k/cdkd#4689) --------
# The live ListenerRule schema lists `ListenerArn` as create-only AND
# write-only, and the schema fallback leaves a write-only create-only property
# out, so a recreate of the listener promoted HealthRule as an in-place UPDATE.
# AWS deletes a listener's rules with it, and that update failed `NotFound`.
# The rule must be REPLACED onto the new listener. Late in the run: the
# recreate leaves the listener record on cc-api and under a new ARN, which
# Phase 2.5 and the listener-attribute readbacks must not see.
echo ""
echo "==> Phase 5: --recreate-via-cc-api ${LISTENER_LOGICAL} with its HealthRule (#4689)"
P5_OLD_LISTENER="$(state_physical_id "${LISTENER_LOGICAL}")"
P5_OLD_RULE="$(state_physical_id HealthRule)"
case "${P5_OLD_LISTENER}" in
  arn:*:listener/app/*) ;;
  *) echo "FAIL: #4689 premise: the listener record holds '${P5_OLD_LISTENER}', not a listener ARN" >&2; exit 1;;
esac
case "${P5_OLD_RULE}" in
  arn:*:listener-rule/app/*) ;;
  *) echo "FAIL: #4689 premise: the HealthRule record holds '${P5_OLD_RULE}', not a listener-rule ARN" >&2; exit 1;;
esac
[ "$(listener_record .provisionedBy)" = "sdk" ] || {
  echo "FAIL: #4689 premise: the listener is not on the SDK provider, so --recreate-via-cc-api would be refused" >&2
  exit 1
}
P5_LOG=$(mktemp)
set +e
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" \
  --recreate-via-cc-api "${LISTENER_LOGICAL}" --yes >"${P5_LOG}" 2>&1
P5_RC=$?
set -e
P5_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${P5_LOG}")"
rm -f "${P5_LOG}"
P5_LOG=""
printf '%s\n' "${P5_PLAIN}" | sed 's/^/  /'
# Pre-fix, this is the first assertion to go red: the pre-flight's replaced
# list is empty, since the rule's create-only reference is write-only.
if ! grep -qF -- "- HealthRule (AWS::ElasticLoadBalancingV2::ListenerRule) reads ${LISTENER_LOGICAL} via ListenerArn" <<<"${P5_PLAIN}"; then
  echo "FAIL: #4689: the --recreate-via-cc-api pre-flight does not list HealthRule as replaced through ListenerArn (output above)" >&2
  exit 1
fi
if grep -iE 'rules? not found|HandlerErrorCode: NotFound' <<<"${P5_PLAIN}" >/dev/null; then
  echo "FAIL: #4689: the recreate hit NotFound (output above) -- the rule was updated in place after AWS deleted it" >&2
  exit 1
fi
if [ "${P5_RC}" -ne 0 ]; then
  echo "FAIL: #4689: the --recreate-via-cc-api deploy of ${LISTENER_LOGICAL} exited ${P5_RC} (output above)" >&2
  exit 1
fi
if ! grep -qF 'Replacing HealthRule (AWS::ElasticLoadBalancingV2::ListenerRule) - immutable properties changed: ListenerArn' <<<"${P5_PLAIN}"; then
  echo "FAIL: #4689: the deploy did not plan HealthRule as a replacement through ListenerArn (output above)" >&2
  exit 1
fi
if ! grep -qF 'HealthRule (AWS::ElasticLoadBalancingV2::ListenerRule) replaced' <<<"${P5_PLAIN}"; then
  echo "FAIL: #4689: no 'HealthRule ... replaced' progress line (output above)" >&2
  exit 1
fi
P5_NEW_LISTENER="$(state_physical_id "${LISTENER_LOGICAL}")"
P5_NEW_RULE="$(state_physical_id HealthRule)"
case "${P5_NEW_LISTENER}" in
  arn:*:listener/app/*) ;;
  *) echo "FAIL: #4689: after the recreate the listener record holds '${P5_NEW_LISTENER}'" >&2; exit 1;;
esac
[ "${P5_NEW_LISTENER}" != "${P5_OLD_LISTENER}" ] || {
  echo "FAIL: #4689 premise: the recreate kept the listener ARN ${P5_OLD_LISTENER}, so nothing moved the rule" >&2
  exit 1
}
[ "${P5_NEW_RULE}" != "${P5_OLD_RULE}" ] || {
  echo "FAIL: #4689: state still records HealthRule as the deleted ${P5_OLD_RULE}" >&2
  exit 1
}
assert_gone "#4689: the recreated listener's predecessor ${P5_OLD_LISTENER} still exists" \
  aws elbv2 describe-listeners --listener-arns "${P5_OLD_LISTENER}" --region "${AWS_REGION}"
# The live rule on the NEW listener: the recorded ARN, priority 1, the
# /health path condition and the whole fixed response (200, text/plain, OK).
P5_RULE_JSON="$(aws elbv2 describe-rules --listener-arn "${P5_NEW_LISTENER}" --region "${AWS_REGION}" \
  --query "Rules[?IsDefault==\`false\`]" --output json)"
P5_RULE_SHAPE="$(printf '%s' "${P5_RULE_JSON}" | jq -r '
  if length != 1 then "count=\(length)" else .[0] |
    "\(.RuleArn) \(.Priority) \([.Conditions[] | select(.Field == "path-pattern") | (.PathPatternConfig.Values // .Values)[]] | join(",")) \(.Actions[0].Type) \(.Actions[0].FixedResponseConfig.StatusCode) \(.Actions[0].FixedResponseConfig.ContentType) \(.Actions[0].FixedResponseConfig.MessageBody)"
  end')"
if [ "${P5_RULE_SHAPE}" != "${P5_NEW_RULE} 1 /health fixed-response 200 text/plain OK" ]; then
  echo "FAIL: #4689: the new listener's rule is '${P5_RULE_SHAPE}', expected '${P5_NEW_RULE} 1 /health fixed-response 200 text/plain OK'" >&2
  exit 1
fi
# The record must hold the NEW listener: one keeping the old ARN would make
# the next ordinary deploy see a create-only change and replace the rule again.
P5_RECORDED_REF="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.HealthRule.properties.ListenerArn // "<absent>"')"
if [ "${P5_RECORDED_REF}" != "${P5_NEW_LISTENER}" ]; then
  echo "FAIL: #4689: state records HealthRule's ListenerArn as '${P5_RECORDED_REF}', expected the new ${P5_NEW_LISTENER}" >&2
  exit 1
fi
echo "    OK: HealthRule replaced onto ${P5_NEW_LISTENER} (priority 1, /health -> 200), no NotFound"

# --- Phase 6: roll back a delete-first recreate of the listener (go-to-k/cdkd#4690)
# `--recreate-via-sdk-provider` deletes the cc-api listener Phase 5 left, then
# creates an SDK one on the same port. HealthRule's replacement onto it then
# fails (ALB_RULE_BAD_PRIORITY), and the automatic rollback reverses the
# listener recreate. Before #4690 it re-created the old listener FIRST, which
# collided on the port the new one still held ("A listener already exists on
# this port"), and the reversal refused with `cdkd rollback --orphan`. It must
# now delete the new listener first, then re-create the old one.
# Not covered here: HealthRule's record still names the rule AWS deleted
# with Phase 5's listener (its replacement is the op that failed), which the
# destroy reads as already gone.
echo ""
echo "==> Phase 6: --recreate-via-sdk-provider ${LISTENER_LOGICAL}, a later failure, and its rollback (#4690)"
P6_OLD_LISTENER="$(state_physical_id "${LISTENER_LOGICAL}")"
[ "${P6_OLD_LISTENER}" = "${P5_NEW_LISTENER}" ] || {
  echo "FAIL: #4690 premise: the listener record holds '${P6_OLD_LISTENER}', not Phase 5's ${P5_NEW_LISTENER}" >&2
  exit 1
}
[ "$(listener_record .provisionedBy)" = "cc-api" ] || {
  echo "FAIL: #4690 premise: the listener is not on cc-api, so --recreate-via-sdk-provider would be refused" >&2
  exit 1
}
P6_LOG=$(mktemp)
set +e
CDKD_TEST_REMOVAL=true ALB_RULE_BAD_PRIORITY=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" --recreate-via-sdk-provider "${LISTENER_LOGICAL}" --yes >"${P6_LOG}" 2>&1
P6_RC=$?
set -e
P6_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${P6_LOG}")"
rm -f "${P6_LOG}"
P6_LOG=""
printf '%s\n' "${P6_PLAIN}" | sed 's/^/  /'
if [ "${P6_RC}" -eq 0 ]; then
  echo "FAIL: #4690 premise: the deploy with ALB_RULE_BAD_PRIORITY succeeded, so nothing was rolled back" >&2
  exit 1
fi
# Premise: the listener recreate COMPLETED (the old listener was deleted
# first), and the rollback reached its reversal.
if ! grep -qF "Reversing replacement of ${LISTENER_LOGICAL} " <<<"${P6_PLAIN}"; then
  echo "FAIL: #4690 premise: the rollback did not reverse the ${LISTENER_LOGICAL} recreate (output above)" >&2
  exit 1
fi
# Pre-fix, this is the first assertion to go red.
if grep -qF "Cannot reverse the replacement of ${LISTENER_LOGICAL}" <<<"${P6_PLAIN}" \
  || grep -qF "Rollback failed for ${LISTENER_LOGICAL}" <<<"${P6_PLAIN}"; then
  echo "FAIL: #4690: the rollback could not reverse the delete-first recreate of ${LISTENER_LOGICAL} (output above)" >&2
  exit 1
fi
if ! grep -qF "the replacement deleted the old resource before creating the new one — deleting the new resource" <<<"${P6_PLAIN}"; then
  echo "FAIL: #4690: the reversal did not delete the new listener first (output above)" >&2
  exit 1
fi
if ! grep -qF "${LISTENER_LOGICAL} replacement reversed (old resource re-created as" <<<"${P6_PLAIN}"; then
  echo "FAIL: #4690: no 'replacement reversed' line for ${LISTENER_LOGICAL} (output above)" >&2
  exit 1
fi
P6_RESTORED="$(state_physical_id "${LISTENER_LOGICAL}")"
case "${P6_RESTORED}" in
  arn:*:listener/app/*) ;;
  *) echo "FAIL: #4690: after the rollback the listener record holds '${P6_RESTORED}'" >&2; exit 1;;
esac
[ "${P6_RESTORED}" != "${P6_OLD_LISTENER}" ] || {
  echo "FAIL: #4690: the listener record still names ${P6_OLD_LISTENER}, which the recreate deleted" >&2
  exit 1
}
[ "$(listener_record .provisionedBy)" = "cc-api" ] || {
  echo "FAIL: #4690: the restored listener record is not back on cc-api (the old resource's layer)" >&2
  exit 1
}
# Exactly one listener on the load balancer, and it is the recorded one on port 80:
# the SDK listener the recreate made is gone.
P6_LIVE="$(aws elbv2 describe-listeners --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query 'Listeners[].[ListenerArn,Port]' --output text)"
if [ "${P6_LIVE}" != "$(printf '%s\t80' "${P6_RESTORED}")" ]; then
  echo "FAIL: #4690: the load balancer's listeners are '${P6_LIVE}', expected only ${P6_RESTORED} on port 80" >&2
  exit 1
fi
echo "    OK: the rollback deleted the recreated listener first and restored ${P6_RESTORED} on port 80"

echo ""
echo "==> Destroy ${STACK}"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Final cleanup verification"
assert_gone "state ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    state file removed (✓)"

echo ""
echo "==> All alb checks passed (incl. #609 ListenerAttributes backfill assertion)"
trap - EXIT INT TERM
