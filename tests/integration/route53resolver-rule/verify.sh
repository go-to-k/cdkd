#!/usr/bin/env bash
# verify.sh — issue #7070: a DomainName change on an
# AWS::Route53Resolver::ResolverRule. Its registry schema lists only RuleType
# as create-only, so cdkd used to send the change as a Cloud Control in-place
# update, which AWS refuses (NotUpdatable) and the deploy failed. CloudFormation
# replaces the rule. Phases:
#   1. deploy a SYSTEM rule for domain a  -> the rule exists with domain a
#   2. move it to domain b                -> the deploy succeeds, a NEW rule holds
#                                            domain b, and the old rule is gone
#   3. destroy                            -> rule and state gone

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

STACK="CdkdRoute53ResolverRuleExample"
# Per run, so this run's sweep never deletes a peer run's rule (resolver rule
# names need not be unique). The stack reads the same id.
RUN_ID="$(date +%s)-$$"
export CDKD_INTEG_RUN_ID="${RUN_ID}"
RULE_NAME="cdkd-integ-resolver-rule-7070-${RUN_ID}"
DOMAIN_A="cdkd-integ-7070-a.example.internal"
DOMAIN_B="cdkd-integ-7070-b.example.internal"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR=""

# The rule ids named RULE_NAME (resolver rule names need not be unique).
rule_ids() {
  aws route53resolver list-resolver-rules --region "${REGION}" \
    --filters "Name=Name,Values=${RULE_NAME}" --query 'ResolverRules[].Id' --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  case "${RULE_NAME}" in
    cdkd-integ-resolver-rule-7070-?*)
      for id in $(rule_ids 2>/dev/null); do
        aws route53resolver delete-resolver-rule --resolver-rule-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: RULE_NAME '${RULE_NAME}' is outside this fixture's scope" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  [ -n "${LOG_DIR:-}" ] && rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG_DIR="$(mktemp -d)"

# The rule id state records for the logical id `Rule`.
recorded_rule_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const r = JSON.parse(s).resources.Rule;
      console.log(r ? r.physicalId : "<no record>");
    });'
}

# The rule's domain, without the trailing dot Route 53 Resolver may add.
rule_domain() {
  aws route53resolver get-resolver-rule --resolver-rule-id "$1" --region "${REGION}" \
    --query 'ResolverRule.DomainName' --output text | sed 's/\.$//'
}

echo "==> Phase 1: deploy a SYSTEM rule for ${DOMAIN_A}"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
OLD_ID="$(recorded_rule_id)"
case "${OLD_ID}" in
  rslvr-rr-?*) ;;
  *) echo "FAIL: Phase 1: state records rule id '${OLD_ID}', expected rslvr-rr-..." >&2; exit 1 ;;
esac
[ "$(rule_domain "${OLD_ID}")" = "${DOMAIN_A}" ] \
  || { echo "FAIL: Phase 1: rule ${OLD_ID} has domain '$(rule_domain "${OLD_ID}")', expected ${DOMAIN_A}" >&2; exit 1; }
echo "    OK: rule ${OLD_ID} holds ${DOMAIN_A}"

echo "==> Phase 2: move the rule to ${DOMAIN_B}"
# Before #7070 this deploy failed: Cloud Control answered NotUpdatable.
if ! CDKD_TEST_UPDATE=domain node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes >"${LOG_DIR}/phase2.log" 2>&1; then
  cat "${LOG_DIR}/phase2.log" >&2
  echo "FAIL: Phase 2: the DomainName change failed the deploy; CloudFormation replaces the rule" >&2
  exit 1
fi
cat "${LOG_DIR}/phase2.log"
# ANSI colour is stripped before matching; a diff-planned replacement prints
# `↻ Rule (AWS::Route53Resolver::ResolverRule) replaced`.
PHASE2_PLAIN="$(sed -E 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/phase2.log")"
if ! grep -qF 'Rule (AWS::Route53Resolver::ResolverRule) replaced' <<<"${PHASE2_PLAIN}"; then
  echo "FAIL: Phase 2: the DomainName change was not a replacement (no 'Rule (AWS::Route53Resolver::ResolverRule) replaced' line)" >&2
  exit 1
fi
echo "    OK: Phase 2 replaced the rule"
NEW_ID="$(recorded_rule_id)"
[ "${NEW_ID}" != "${OLD_ID}" ] \
  || { echo "FAIL: Phase 2: state still records rule ${OLD_ID}; the rule was not replaced" >&2; exit 1; }
[ "$(rule_domain "${NEW_ID}")" = "${DOMAIN_B}" ] \
  || { echo "FAIL: Phase 2: new rule ${NEW_ID} has domain '$(rule_domain "${NEW_ID}")', expected ${DOMAIN_B}" >&2; exit 1; }
assert_gone "Phase 2: the replaced rule ${OLD_ID} still exists" \
  aws route53resolver get-resolver-rule --resolver-rule-id "${OLD_ID}" --region "${REGION}"
echo "    OK: replaced ${OLD_ID} by ${NEW_ID}, which holds ${DOMAIN_B}"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "rule ${NEW_ID} remains" aws route53resolver get-resolver-rule --resolver-rule-id "${NEW_ID}" --region "${REGION}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
LEFT="$(rule_ids)"
[ -z "${LEFT}" ] || { echo "FAIL: rules named ${RULE_NAME} remain: ${LEFT}" >&2; exit 1; }
echo "    OK: rule and state gone"
trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo ""
echo "[verify] PASS — route53resolver-rule: a DomainName change replaced the rule"
