#!/usr/bin/env bash
# ELBv2 listener rules with path / host conditions update in place when only
# their action or priority changes, and drift --revert restores an
# out-of-band change (go-to-k/cdkd#6663).
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

cd "$(dirname "$0")"
STACK="CdkdAlbListenerRuleUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LB_ARN=""
VPC_ID=""
CLEANED_UP=0
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    fi
    :
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -n "${STATE_BUCKET:-}" ] || { echo "FAIL: STATE_BUCKET is required" >&2; exit 1; }
[ -f "${LOCAL_DIST}" ] || { echo "FAIL: run vp run build first" >&2; exit 1; }
if [ ! -d node_modules ]; then pnpm install --ignore-workspace --prefer-offline; fi
state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" --only-show-errors
}
deploy_phase() { # CDKD_TEST_UPDATE
  CDKD_TEST_UPDATE="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
}
# A rule's ARN (its physical id), by construct path, asserted unique.
rule_arn() { # RuleA|RuleB
  local arns
  arns=$(state_json | jq -r --arg p "${STACK}/$1/Resource" \
    '[.resources[] | select(.constructPath == $p) | .physicalId]') || return 1
  [ "$(jq 'length' <<<"${arns}")" = 1 ] || { echo "FAIL: expected one $1 record, got ${arns}" >&2; exit 1; }
  jq -r '.[0]' <<<"${arns}"
}
# "<priority> <message body> <conditions as sorted config values>" of one live rule.
live_rule() { # rule ARN
  aws elbv2 describe-rules --region "${REGION}" --rule-arns "$1" --output json |
    jq -r '.Rules[0] | "\(.Priority) \(.Actions[0].FixedResponseConfig.MessageBody) \(
      [.Conditions[] | (.PathPatternConfig.Values // .HostHeaderConfig.Values // .HttpHeaderConfig.Values // [])[]] | sort | join(","))"'
}
expect_rule() { # rule ARN, expected live_rule line, label
  local got
  got=$(live_rule "$1") || { echo "FAIL: describe-rules failed for $3" >&2; exit 1; }
  [ "${got}" = "$2" ] || { echo "FAIL: $3: live rule is '${got}', expected '$2'" >&2; exit 1; }
  echo "    OK: $3 is '${got}'"
}
# cdkd drift --json for this stack; prints the drifted logical ids, sorted.
drifted_ids() {
  local report
  report=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || true
  jq -r --arg stack "${STACK}" '
    [.[] | select(.stack == $stack)] as $r |
    if ($r | length) != 1 then error("no single report for the stack") else
    ([$r[0].drifted[].logicalId] | sort | join(",")) + "|" + ($r[0].notCompared | length | tostring) end
  ' <<<"${report}" || { echo "FAIL: unreadable drift report: ${report}" >&2; exit 1; }
}

cleanup
CLEANED_UP=0

echo "==> Deploy the ALB with two listener rules"
deploy_phase false
LB_ARN=$(state_json | jq -r '.outputs.LoadBalancerArn')
case "${LB_ARN}" in arn:aws*:elasticloadbalancing:*:loadbalancer/app/?*) ;; *) echo "FAIL: no load balancer ARN" >&2; exit 1 ;; esac
VPC_ID=$(state_json | jq -r '.outputs.VpcId')
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: no VPC id" >&2; exit 1 ;; esac
RULE_A=$(rule_arn RuleA) || exit 1
RULE_B=$(rule_arn RuleB) || exit 1
expect_rule "${RULE_A}" "10 rule-a-v1 /a*,yes" "RuleA after the create"
expect_rule "${RULE_B}" "20 rule-b /b*,b.example.com" "RuleB after the create"

echo "==> Change RuleA's action and RuleB's priority, conditions unchanged (#6663)"
# Before the fix both updates failed: "You cannot provide both Values and
# 'PathPatternConfig' for a condition of type 'path-pattern'".
deploy_phase true
[ "$(rule_arn RuleA)" = "${RULE_A}" ] || { echo "FAIL: RuleA was replaced" >&2; exit 1; }
[ "$(rule_arn RuleB)" = "${RULE_B}" ] || { echo "FAIL: RuleB was replaced" >&2; exit 1; }
expect_rule "${RULE_A}" "10 rule-a-v2 /a*,yes" "RuleA after the update"
expect_rule "${RULE_B}" "25 rule-b /b*,b.example.com" "RuleB after the update"
[ "$(drifted_ids)" = "|0" ] || { echo "FAIL: drift not clean after the update: $(drifted_ids)" >&2; exit 1; }
echo "    OK: drift is clean after the update"

echo "==> Change RuleA out of band, then drift --revert"
aws elbv2 set-rule-priorities --region "${REGION}" \
  --rule-priorities "RuleArn=${RULE_A},Priority=55" >/dev/null
aws elbv2 modify-rule --region "${REGION}" --rule-arn "${RULE_A}" \
  --actions '[{"Type":"fixed-response","FixedResponseConfig":{"StatusCode":"201","ContentType":"text/plain","MessageBody":"oob"}}]' >/dev/null
RULE_A_ID=$(state_json | jq -r --arg p "${STACK}/RuleA/Resource" '.resources | to_entries[] | select(.value.constructPath == $p) | .key')
[ "$(drifted_ids)" = "${RULE_A_ID}|0" ] || { echo "FAIL: drift did not report exactly RuleA: $(drifted_ids)" >&2; exit 1; }
echo "    OK: drift reports RuleA"
node "${LOCAL_DIST}" drift "${STACK}" --revert --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}"
expect_rule "${RULE_A}" "10 rule-a-v2 /a*,yes" "RuleA after drift --revert"
[ "$(drifted_ids)" = "|0" ] || { echo "FAIL: drift not clean after --revert: $(drifted_ids)" >&2; exit 1; }
echo "    OK: drift is clean after --revert"

echo "==> Destroy and verify resources and state are gone"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
assert_gone "load balancer still exists" aws elbv2 describe-load-balancers --region "${REGION}" --load-balancer-arns "${LB_ARN}"
assert_gone "VPC still exists" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "state still exists" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CLEANED_UP=1
trap - EXIT INT TERM
echo "[verify] PASS: listener rule updates with unchanged conditions applied in place, drift --revert restored an out-of-band change, clean destroy (#6663)"
