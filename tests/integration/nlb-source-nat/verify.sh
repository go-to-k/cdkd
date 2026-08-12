#!/usr/bin/env bash
# verify.sh — NLB flag-OMISSION A/B (issue #1619, split out of #1609 item 2)
#
# The two NLB-only flags below have no API of their own; they ride on
# SetSubnets / SetSecurityGroups. When ONLY the flag is removed cdkd issues no
# call at all and the live value is retained — settled. This fixture pins the
# COMBINED case: the flag is dropped in the SAME deploy that changes
# Subnets / SecurityGroups, so the Set* call IS issued, WITHOUT the member.
#
# Measured us-east-1 2026-08-12: AWS RETAINS the live value on omission for
# both flags, so cdkd omitting the member is correct. That is a SERVICE
# behavior, not a cdkd one, which is why it needs a live fixture rather than a
# mocked test — a unit test agrees with whatever wire assumption the provider
# happens to hold, which is what left this unverified for so long.
#
# Each flag gets its own load balancer so the two probes cannot cross-talk
# (the issue requires them A/B'd SEPARATELY).
#
# The load-bearing subtlety: BOTH flags are templated at their NON-DEFAULT
# value (`on` for source-NAT, whose absence reads as off; `off` for enforce,
# which AWS defaults to `on`). A flag templated at its default cannot
# distinguish "retained" from "reset to default" — the readback is identical
# either way, and the assertion would pass no matter which way AWS went.
#
# Equally load-bearing: each phase-2 assertion pairs the flag readback with a
# COMPANION-PROPERTY readback proving the Set* call actually fired (3 subnets /
# 2 security groups). Without that, a cdkd regression that skipped the call
# entirely would leave the flag untouched and the retain assertion would pass
# vacuously.
#
# Run via: /run-integ nlb-source-nat
#         or: bash tests/integration/nlb-source-nat/verify.sh

set -euo pipefail

# A pager invoked non-interactively is its own route to a hang; cheap insurance
# for a new fixture (see the `verify.sh` aws-verb rule in .claude/rules/testing.md).
export AWS_PAGER=""

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
STACK="NlbSourceNatStack"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Resolve a load balancer's ARN out of cdkd state by its logical id.
lb_arn_by_logical_id() { # usage: lb_arn_by_logical_id "<state json>" <LogicalIdPrefix>
  echo "$1" | python3 -c '
import sys, json
prefix = sys.argv[1]
s = json.load(sys.stdin)
for k, v in s["resources"].items():
    if v["resourceType"] == "AWS::ElasticLoadBalancingV2::LoadBalancer" and k.startswith(prefix):
        print(v["physicalId"]); break
' "$2"
}

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight orphan scan"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: state ${STATE_KEY} already exists — clean up first."
  exit 1
} || true

echo ""
echo "==> Phase 1: deploy ${STACK} (baseline, both flags at their NON-default)"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

STATE_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
SOURCENAT_ARN=$(lb_arn_by_logical_id "${STATE_BODY}" "NlbSourceNat")
ENFORCE_ARN=$(lb_arn_by_logical_id "${STATE_BODY}" "NlbEnforce")
if [[ -z "${SOURCENAT_ARN}" || -z "${ENFORCE_ARN}" ]]; then
  echo "FAIL: could not resolve both NLB ARNs from cdkd state"
  echo "    NlbSourceNat='${SOURCENAT_ARN}' NlbEnforce='${ENFORCE_ARN}'"
  exit 1
fi
echo "    source-nat NLB: ${SOURCENAT_ARN}"
echo "    enforce NLB:    ${ENFORCE_ARN}"

echo ""
echo "==> Assert phase-1 baseline reached AWS"
SN_P1=$(aws elbv2 describe-load-balancers --load-balancer-arns "${SOURCENAT_ARN}" --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].EnablePrefixForIpv6SourceNat' --output text)
if [[ "${SN_P1}" != "on" ]]; then
  echo "FAIL: baseline EnablePrefixForIpv6SourceNat is '${SN_P1}', expected 'on'"
  echo "    (the flag must be live and NON-default before the omission phase can prove retention)"
  exit 1
fi
SN_SUBNETS_P1=$(aws elbv2 describe-load-balancers --load-balancer-arns "${SOURCENAT_ARN}" --region "${AWS_REGION}" \
  --query 'length(LoadBalancers[0].AvailabilityZones)' --output text)
if [[ "${SN_SUBNETS_P1}" != "2" ]]; then
  echo "FAIL: baseline source-nat NLB has ${SN_SUBNETS_P1} subnets, expected 2"
  exit 1
fi
EN_P1=$(aws elbv2 describe-load-balancers --load-balancer-arns "${ENFORCE_ARN}" --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic' --output text)
if [[ "${EN_P1}" != "off" ]]; then
  echo "FAIL: baseline EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic is '${EN_P1}', expected 'off'"
  echo "    (AWS defaults this to 'on'; the fixture templates 'off' so retention is decisive)"
  exit 1
fi
EN_SGS_P1=$(aws elbv2 describe-load-balancers --load-balancer-arns "${ENFORCE_ARN}" --region "${AWS_REGION}" \
  --query 'length(LoadBalancers[0].SecurityGroups)' --output text)
if [[ "${EN_SGS_P1}" != "1" ]]; then
  echo "FAIL: baseline enforce NLB has ${EN_SGS_P1} security groups, expected 1"
  exit 1
fi
echo "    EnablePrefixForIpv6SourceNat=on (2 subnets), Enforce...PrivateLinkTraffic=off (1 SG) (✓)"

echo ""
echo "==> Phase 2: re-deploy with CDKD_TEST_REMOVAL=true"
echo "    (each flag DROPPED in the same deploy that changes its companion property,"
echo "     so Set* fires with the member omitted)"
CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Assert the Set* calls actually FIRED (non-vacuity guard)"
# A retain assertion is worthless if no call was issued at all: the flag would
# be untouched either way. These two readbacks are what prove the omission arm
# was really exercised.
SN_SUBNETS_P2=$(aws elbv2 describe-load-balancers --load-balancer-arns "${SOURCENAT_ARN}" --region "${AWS_REGION}" \
  --query 'length(LoadBalancers[0].AvailabilityZones)' --output text)
if [[ "${SN_SUBNETS_P2}" != "3" ]]; then
  echo "FAIL: source-nat NLB has ${SN_SUBNETS_P2} subnets after the removal deploy, expected 3"
  echo "    (SetSubnets did not fire — the omission arm was never exercised, so the"
  echo "     retention assertion below would pass vacuously)"
  exit 1
fi
EN_SGS_P2=$(aws elbv2 describe-load-balancers --load-balancer-arns "${ENFORCE_ARN}" --region "${AWS_REGION}" \
  --query 'length(LoadBalancers[0].SecurityGroups)' --output text)
if [[ "${EN_SGS_P2}" != "2" ]]; then
  echo "FAIL: enforce NLB has ${EN_SGS_P2} security groups after the removal deploy, expected 2"
  echo "    (SetSecurityGroups did not fire — see the note above)"
  exit 1
fi
echo "    SetSubnets fired (2 -> 3 subnets), SetSecurityGroups fired (1 -> 2 SGs) (✓)"

echo ""
echo "==> Assert AWS RETAINED both flags on omission (the #1619 A/B)"
SN_P2=$(aws elbv2 describe-load-balancers --load-balancer-arns "${SOURCENAT_ARN}" --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].EnablePrefixForIpv6SourceNat' --output text)
if [[ "${SN_P2}" != "on" ]]; then
  echo "FAIL: EnablePrefixForIpv6SourceNat is '${SN_P2}' after a SetSubnets that omitted it, expected 'on'"
  echo ""
  echo "    AWS's omission semantics CHANGED: it now RESETS instead of retaining."
  echo "    cdkd must start re-sending the retained value with the SetSubnets call"
  echo "    (see updateLoadBalancer in src/provisioning/providers/elbv2-provider.ts)."
  echo "    Until then an unrelated subnet change silently flips a live NLB's IPv6"
  echo "    source-NAT off."
  exit 1
fi
EN_P2=$(aws elbv2 describe-load-balancers --load-balancer-arns "${ENFORCE_ARN}" --region "${AWS_REGION}" \
  --query 'LoadBalancers[0].EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic' --output text)
if [[ "${EN_P2}" != "off" ]]; then
  echo "FAIL: EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic is '${EN_P2}' after a"
  echo "    SetSecurityGroups that omitted it, expected 'off'"
  echo ""
  echo "    AWS's omission semantics CHANGED: it now RESETS instead of retaining."
  echo "    This one is SECURITY-relevant — a reset to the 'on' default silently starts"
  echo "    enforcing security-group inbound rules on PrivateLink traffic for a live NLB"
  echo "    on an unrelated security-group change. cdkd must re-send the retained value."
  exit 1
fi
echo "    both flags RETAINED on omission — cdkd's omit-the-member behavior is correct (✓)"

echo ""
echo "==> Destroy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Verify clean"
assert_gone "source-nat NLB ${SOURCENAT_ARN} still exists after destroy" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${SOURCENAT_ARN}" --region "${AWS_REGION}"
assert_gone "enforce NLB ${ENFORCE_ARN} still exists after destroy" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${ENFORCE_ARN}" --region "${AWS_REGION}"
assert_gone "state ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    both NLBs gone, state removed (✓)"

echo ""
echo "PASS: nlb-source-nat (#1619 flag-omission A/B: AWS retains both flags)"
