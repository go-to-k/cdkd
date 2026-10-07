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
# CDKD_TEST_REMOVAL=true (drops the TargetGroup's custom HealthCheckPort —
# issue #1160 elbv2 batch — plus the TargetGroupAttributes list) and asserts
# the live TG resets to the CFn-parity default `traffic-port` and the
# attribute resets to 300, then destroys and verifies clean.
#
# Issue #1609 item 1 extends the removal phase to the two attribute arms it
# never covered: the fixture now also templates a LoadBalancerAttributes entry
# (idle_timeout 120 -> 180 -> dropped) and drops the Listener's
# ListenerAttributes. Both arms USED to push a removed key back as `Value: ''`;
# the live A/B those assertions performed proved AWS REJECTS that for a
# BOOLEAN key on both APIs, so the provider now sends the documented default
# for those and keeps '' only for numeric / free-form keys. The removal
# readbacks assert the resulting defaults (idle_timeout 60,
# routing.http.response.server.enabled true) plus the RETENTION of
# routing.http2.enabled, which is what distinguishes a per-key reset from a
# list-wide wipe.
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
# provider on the same ARN, which resets the dropped listener attribute.
#
# PLUS issue #4689 (Phase 5): a `--recreate-via-cc-api` of the listener must
# REPLACE its HealthRule onto the new listener (the rule's create-only
# `ListenerArn` is also write-only), not update the rule AWS already deleted.
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
  rm -f "${FF_LOG:-}" "${REMOVAL_LOG:-}" "${P5_LOG:-}"
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
for v in s["resources"].values():
    if v["resourceType"] == "AWS::ElasticLoadBalancingV2::TargetGroup":
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
# coverage -- and Cloud Control's update leaves a removed ListenerAttributes key
# live. The listener is now an 'sdk-coverage' sticky exemption, so the removal
# redeploy below must move the record back to the SDK provider ON THE SAME ARN
# and reset the key.
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
# in place, and the listener-attribute readback further down reads the reset.
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

echo ""
echo "==> Assert #609 removal semantics (attribute reset)"
# Dropping the TargetGroupAttributes list resets the removed key to AWS's
# documented default. ModifyTargetGroupAttributes REJECTS an empty Value
# ("A target group attribute value must be specified", live-verified
# 2026-08-11), so the provider sends the default from
# TARGET_GROUP_ATTRIBUTE_DEFAULTS explicitly — deregistration_delay -> 300.
DEREG_P3=$(aws elbv2 describe-target-group-attributes --target-group-arn "${TG_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" --output text)
if [[ "${DEREG_P3}" != "300" ]]; then
  echo "FAIL: deregistration_delay is '${DEREG_P3}' after removal, expected the AWS default '300' (documented-default reset)"
  exit 1
fi
echo "    deregistration_delay reset to 300 (✓)"

echo ""
echo "==> Assert LB + Listener attribute removal arms (issue #1609 item 1)"
# THE A/B THIS FIXTURE EXTENSION EXISTS FOR. Both arms originally pushed a
# removed key back as `Value: ''` and neither had ever run against real AWS.
# The first run of these assertions is what proved the empty string is
# REJECTED for a boolean key on both APIs (it failed the removal deploy AND
# its rollback), which is why the provider now sends documented defaults for
# those keys. A non-default readback here would mean the reset never
# reached AWS.
IDLE_P3=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "${LB_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" --output text)
if [[ "${IDLE_P3}" != "60" ]]; then
  echo "FAIL: idle_timeout.timeout_seconds is '${IDLE_P3}' after removal, expected the AWS default '60'"
  echo "    (ModifyLoadBalancerAttributes removal arm — Value:'' did not clear the override)"
  exit 1
fi
echo "    idle_timeout.timeout_seconds reset to 60 (✓)"

# The RETAINED SIBLING. routing.http2.enabled is templated 'false' in every
# phase while AWS's default is 'true', so this assertion is what distinguishes
# "reset the removed key" from "wiped the whole attribute list" — a check the
# earlier deletion_protection.enabled sibling could not perform, because its
# templated value equalled its default and an over-broad reset read identically.
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
if [[ "${LISTENER_ATTR_P3}" != "true" ]]; then
  echo "FAIL: listener attribute ${EXPECTED_ATTR_KEY} is '${LISTENER_ATTR_P3}' after removal, expected the AWS default 'true'"
  echo "    (ModifyListenerAttributes removal arm — Value:'' did not clear the override)"
  exit 1
fi
echo "    ${EXPECTED_ATTR_KEY} reset to true (✓)"

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
# The rule must be REPLACED onto the new listener. Last before the destroy:
# the recreate leaves the listener record on cc-api and under a new ARN, which
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
# /health path condition and the fixed 200 response.
P5_RULE_JSON="$(aws elbv2 describe-rules --listener-arn "${P5_NEW_LISTENER}" --region "${AWS_REGION}" \
  --query "Rules[?IsDefault==\`false\`]" --output json)"
P5_RULE_SHAPE="$(printf '%s' "${P5_RULE_JSON}" | jq -r '
  if length != 1 then "count=\(length)" else .[0] |
    "\(.RuleArn) \(.Priority) \([.Conditions[] | select(.Field == "path-pattern") | (.PathPatternConfig.Values // .Values)[]] | join(",")) \(.Actions[0].Type) \(.Actions[0].FixedResponseConfig.StatusCode)"
  end')"
if [ "${P5_RULE_SHAPE}" != "${P5_NEW_RULE} 1 /health fixed-response 200" ]; then
  echo "FAIL: #4689: the new listener's rule is '${P5_RULE_SHAPE}', expected '${P5_NEW_RULE} 1 /health fixed-response 200'" >&2
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
