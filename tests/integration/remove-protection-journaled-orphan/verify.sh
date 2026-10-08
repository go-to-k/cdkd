#!/usr/bin/env bash
# go-to-k/cdkd#4678: `cdkd destroy --remove-protection` clears a
# deletion-protected resource that only the rollback journal records.
#
#   1. Deploy the network stack (VPC, two subnets, a security group).
#   2. `--no-rollback` deploy of the orphan stack: OrphanLb's CREATE fails after
#      CreateLoadBalancer with deletion protection already on, its cleanup is
#      refused, and the journal holds the ARN as a proven orphan.
#   3. `cdkd destroy` WITHOUT the flag: the orphan's delete is refused, the
#      destroy exits non-zero, and the journal, the load balancer and its
#      protection are all still there.
#   4. `cdkd destroy --remove-protection`: exits 0, the load balancer is gone,
#      and so are the journal and the state. Before #4678 the sweep dropped the
#      flag and this step failed exactly like step 3.
#   5. Inject the same orphan again (step 2's deploy).
#   6. `cdkd rollback` WITHOUT the flag: non-zero, the orphan and its journal
#      entry are kept.
#   7. `cdkd rollback --remove-protection`: exits 0, the load balancer and the
#      journal are gone.
#   8. `--no-rollback` deploy with COMPLETED_LB=1: CompletedLb's CREATE
#      COMPLETES with deletion protection on, then FailLater fails, so state
#      records the load balancer and the journal holds its completed CREATE.
#   9. `cdkd rollback` WITHOUT the flag: non-zero, the load balancer, its
#      protection, its state record and the journal are kept.
#  10. `cdkd rollback --remove-protection`: exits 0, the load balancer, its
#      state record and the journal are gone. Before the completed-CREATE half
#      of #4678 the rollback's delete of a completed CREATE dropped the flag and
#      this step failed exactly like step 9.
#  11. Destroy the network stack.
#
# The run lives under its OWN state prefix (STATE_PREFIX, unique per run): the
# foreign-holder scan `--remove-protection` asks before stripping reads every
# record under the prefix, and an unreadable one (a peer's newer state schema,
# a legacy key) keeps the protection on. Here it sees only this run's two
# stacks. The trap deletes this prefix's objects, never anything under `cdkd/`.
#
# Run via: /run-integ remove-protection-journaled-orphan
#         or: bash tests/integration/remove-protection-journaled-orphan/verify.sh

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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
NET_STACK="CdkdRpJournaledOrphanNet"
STACK="CdkdRpJournaledOrphanExample"
LB_NAME="cdkd-4678-orphan"
COMPLETED_LB_NAME="cdkd-4678-completed"
STATE_PREFIX="${STATE_PREFIX:-cdkd-rpjo-$(date +%s)-$$}"
STATE_KEY="${STATE_PREFIX}/${STACK}/${REGION}/state.json"
JOURNAL_KEY="${STATE_PREFIX}/${STACK}/${REGION}/rollback-journal.json"
NET_STATE_KEY="${STATE_PREFIX}/${NET_STACK}/${REGION}/state.json"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found -- run 'vp run build' first" >&2
  exit 1
fi

# Set only from what THIS run's AWS calls returned; the trap acts on nothing else.
ORPHAN_LB_ARN=""
# CompletedLb's ARN as this run's state recorded it (step 8).
COMPLETED_LB_ARN=""
# What the journal records for OrphanLb: the trap deletes it too, so cleanup
# does not hang on the warning cdkd printed (the code under test) alone.
JOURNALED_ARN=""
ORPHAN_SUBNETS=""
ORPHAN_SECURITY_GROUP=""
RUN_LOG=""
# Set just before this run's own deploy of each stack: a pre-flight FAIL (a
# peer's run holding these keys) must leave the peer's stacks alone.
DEPLOYED_NET=""
DEPLOYED_ORPHAN=""

lb_protection() { # usage: lb_protection <arn>
  aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$1" --region "${REGION}" \
    --query "Attributes[?Key=='deletion_protection.enabled'].Value | [0]" --output text
}

# A failed --remove-protection run whose foreign-holder scan met an unreadable
# record is environmental, not a regression: say so beside the FAIL. Under this
# run's own prefix the scan should see only its two stacks.
explain_unreadable_scan() {
  if grep -q "leaves open whether another stack holds it" "${RUN_LOG}"; then
    echo "      environmental: an unreadable record under s3://${STATE_BUCKET}/${STATE_PREFIX}/ kept the protection on (see the 'leaves open whether another stack holds it' warning above); this run's prefix should hold only its own two stacks, so check what else wrote there" >&2
  fi
}

# The journaled OrphanLb op, compact JSON, or empty when the journal holds none.
journaled_orphan_op() {
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)" || return 1
  printf '%s' "${body}" | jq -c \
    '[.segments[]?.failedOperations[]? | select(.logicalId == "OrphanLb")] | last // empty'
}

# Delete this run's own prefix (its events, exports index, any leftover
# object), only once neither stack's record NOR the rollback journal is left: a
# record or journal that survived a failed teardown is the one way back to its
# resources. Only the default per-run shape is swept (an override naming
# another run's prefix, or one carrying a `/`, is refused). Never under `cdkd/`.
sweep_run_prefix() {
  case "${STATE_PREFIX:-}" in
    */*)
      echo "WARN: teardown sweep refused: STATE_PREFIX '${STATE_PREFIX}' contains '/'" >&2
      ;;
    cdkd-rpjo-[0-9]*-[0-9]*)
      if ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) &&
        ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NET_STATE_KEY}" ) &&
        ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" ); then
        aws s3 rm "s3://${STATE_BUCKET}/${STATE_PREFIX}/" --recursive >/dev/null 2>&1
      else
        echo "WARN: teardown incomplete; records kept under s3://${STATE_BUCKET:-}/${STATE_PREFIX}/ (pass --state-prefix ${STATE_PREFIX} to cdkd state destroy)" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STATE_PREFIX '${STATE_PREFIX:-}' is not this fixture's cdkd-rpjo-* prefix" >&2
      ;;
  esac
}

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors tolerated)"
  rm -f "${RUN_LOG:-}"
  # Only the ARNs THIS run captured, never one found by name: clear the
  # protection and delete each BEFORE the network stack, whose subnets and
  # security group it holds.
  for arn in "${ORPHAN_LB_ARN:-}" "${JOURNALED_ARN:-}" "${COMPLETED_LB_ARN:-}"; do
    case "${arn}" in
      arn:*:loadbalancer/app/*)
        aws elbv2 modify-load-balancer-attributes --load-balancer-arn "${arn}" \
          --attributes Key=deletion_protection.enabled,Value=false --region "${REGION}" >/dev/null 2>&1
        aws elbv2 delete-load-balancer --load-balancer-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
        aws elbv2 wait load-balancers-deleted --load-balancer-arns "${arn}" --region "${REGION}" >/dev/null 2>&1
        ;;
    esac
  done
  # A record the run already destroyed is not there to destroy again; a journal
  # left without its state record still needs the destroy's journal sweep.
  if [ "${DEPLOYED_ORPHAN:-}" = "1" ] && { ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) ||
    ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" ); }; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${STATE_PREFIX}" --region "${REGION}" \
      --remove-protection --yes >/dev/null 2>&1
  fi
  # A deleted load balancer's ENIs can outlive it for a few minutes.
  if [ "${DEPLOYED_NET:-}" = "1" ] && ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NET_STATE_KEY}" ); then
    for _ in 1 2 3; do
      node "${LOCAL_DIST}" state destroy "${NET_STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${STATE_PREFIX}" --region "${REGION}" \
        --yes >/dev/null 2>&1 && break
      sleep 30
    done
  fi
  sweep_run_prefix
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight"
for key in "${STATE_KEY}" "${JOURNAL_KEY}" "${NET_STATE_KEY}"; do
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"; then
    echo "FAIL: s3://${STATE_BUCKET}/${key} already exists -- clean up a previous run first" >&2
    exit 1
  fi
done
# A load balancer of this name from an earlier run would be handed back by
# CreateLoadBalancer (same name and settings) or collide with it. Never
# deleted by name here: it is not this run's.
for name in "${LB_NAME}" "${COMPLETED_LB_NAME}"; do
  if ! gone_probe aws elbv2 describe-load-balancers --names "${name}" --region "${REGION}"; then
    echo "FAIL: a load balancer named ${name} already exists -- delete it by hand first" >&2
    exit 1
  fi
done

echo ""
echo "==> Step 1: deploy ${NET_STACK}"
DEPLOYED_NET=1
node "${LOCAL_DIST}" deploy "${NET_STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --yes
NET_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${NET_STATE_KEY}" -)"
SUBNET_A="$(printf '%s' "${NET_STATE}" | jq -r '.outputs.SubnetAId // ""')"
SUBNET_B="$(printf '%s' "${NET_STATE}" | jq -r '.outputs.SubnetBId // ""')"
ORPHAN_SECURITY_GROUP="$(printf '%s' "${NET_STATE}" | jq -r '.outputs.SgId // ""')"
case "${SUBNET_A}/${SUBNET_B}/${ORPHAN_SECURITY_GROUP}" in
  subnet-?*/subnet-?*/sg-?*) ;;
  *)
    echo "FAIL: ${NET_STACK} outputs are not subnet / security group ids: '${SUBNET_A}' '${SUBNET_B}' '${ORPHAN_SECURITY_GROUP}'" >&2
    exit 1
    ;;
esac
ORPHAN_SUBNETS="${SUBNET_A},${SUBNET_B}"
export ORPHAN_SUBNETS ORPHAN_SECURITY_GROUP
echo "    OK: subnets ${ORPHAN_SUBNETS}, security group ${ORPHAN_SECURITY_GROUP}"

# Steps 2 and 5: a `--no-rollback` deploy whose OrphanLb CREATE fails after
# CreateLoadBalancer, journaling a deletion-protected load balancer.
inject_orphan() { # usage: inject_orphan <step label>
echo ""
echo "==> Step $1: --no-rollback deploy of ${STACK} (OrphanLb fails after CreateLoadBalancer)"
ORPHAN_LB_ARN=""
JOURNALED_ARN=""
DEPLOYED_ORPHAN=1
set +e
node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" \
  --yes --no-rollback >"${RUN_LOG}" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
# Captured BEFORE any FAIL below, so the trap can clear the protection on and
# delete a load balancer no later check reached.
ORPHAN_LB_ARN="$(sed -n 's/.*Failed to clean up partially-created LoadBalancer OrphanLb (\(arn:[^)]*\)).*/\1/p' "${RUN_LOG}" | head -1)"
if [ "${DEPLOY_RC}" -eq 0 ]; then
  # Then state holds a protected OrphanLb: hand its ARN to the trap first.
  ORPHAN_LB_ARN="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.OrphanLb.physicalId // ""' || true)"
  echo "FAIL: the OrphanLb deploy unexpectedly SUCCEEDED (SetSecurityGroups should reject the malformed enforce flag)" >&2
  exit 1
fi
# The injection's mechanism: the cleanup's DeleteLoadBalancer was refused, so
# the create marked the ARN for the journal. Any other failure journals no
# orphan and exercises nothing below.
if ! grep -q "Failed to clean up partially-created LoadBalancer OrphanLb" "${RUN_LOG}"; then
  # A reworded warning still journals the ARN: hand that to the trap.
  JOURNALED_ARN="$( (journaled_orphan_op || true) | jq -r '.physicalId // ""' 2>/dev/null || true)"
  echo "FAIL: the OrphanLb deploy failed, but not by a cleanup that could not delete the load balancer (output above)" >&2
  exit 1
fi
if ! ORPHAN_OP="$(journaled_orphan_op)"; then
  echo "FAIL: no rollback journal after the --no-rollback deploy" >&2
  exit 1
fi
# Before any FAIL below: the trap deletes what the journal names too.
JOURNALED_ARN="$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalId // ""' 2>/dev/null || true)"
if [ -z "${ORPHAN_OP}" ] || [ "$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ]; then
  echo "FAIL: the journal does not carry OrphanLb as a proven orphan (op: ${ORPHAN_OP:-<none>})" >&2
  exit 1
fi
if [ -z "${ORPHAN_LB_ARN}" ] || [ "${JOURNALED_ARN}" != "${ORPHAN_LB_ARN}" ]; then
  echo "FAIL: the journal holds OrphanLb as '${JOURNALED_ARN}', not the '${ORPHAN_LB_ARN}' the cleanup warning named" >&2
  exit 1
fi
if [ "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.OrphanLb.physicalId // "<absent>"')" != "<absent>" ]; then
  echo "FAIL: state records OrphanLb after a CREATE that threw (expected the journal to be its only record)" >&2
  exit 1
fi
if [ "$(lb_protection "${ORPHAN_LB_ARN}")" != "true" ]; then
  echo "FAIL: the journaled ${ORPHAN_LB_ARN} is not deletion-protected (the injection did not fire as designed)" >&2
  exit 1
fi
echo "    OK: OrphanLb ${ORPHAN_LB_ARN} is journaled as a proven orphan, deletion-protected, with no state record"
}

RUN_LOG="$(mktemp)"
inject_orphan 2

echo ""
echo "==> Step 3: cdkd destroy WITHOUT --remove-protection keeps the protected orphan"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force >"${RUN_LOG}" 2>&1
PLAIN_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${PLAIN_RC}" -eq 0 ]; then
  echo "FAIL: the destroy without --remove-protection exited 0 with a deletion-protected orphan in the journal" >&2
  exit 1
fi
if ! grep -q "deleting partially-created OrphanLb" "${RUN_LOG}"; then
  echo "FAIL: the destroy did not attempt the journaled OrphanLb (output above)" >&2
  exit 1
fi
if gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${REGION}"; then
  echo "FAIL: ${ORPHAN_LB_ARN} is gone after a destroy without --remove-protection (it must not strip protection)" >&2
  exit 1
fi
if [ "$(lb_protection "${ORPHAN_LB_ARN}")" != "true" ]; then
  echo "FAIL: the destroy without --remove-protection turned off deletion protection on ${ORPHAN_LB_ARN}" >&2
  exit 1
fi
if ! ORPHAN_OP="$(journaled_orphan_op)" || [ "$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalId // ""')" != "${ORPHAN_LB_ARN}" ]; then
  echo "FAIL: the journal no longer holds OrphanLb ${ORPHAN_LB_ARN} after a destroy whose delete was refused" >&2
  exit 1
fi
echo "    OK: exit ${PLAIN_RC}; the load balancer, its protection and its journal entry are kept"

echo ""
echo "==> Step 4: cdkd destroy --remove-protection clears it (go-to-k/cdkd#4678)"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" \
  --force --remove-protection >"${RUN_LOG}" 2>&1
RP_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${RP_RC}" -ne 0 ]; then
  echo "FAIL: cdkd destroy --remove-protection exited ${RP_RC} (expected 0: the flag reaches the journaled orphan's delete -- output above)" >&2
  echo "      (before go-to-k/cdkd#4678 the sweep dropped the flag and AWS refused the delete)" >&2
  explain_unreadable_scan
  exit 1
fi
# DeleteLoadBalancer returns before the load balancer leaves the describe list.
for _ in $(seq 1 24); do
  gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${REGION}" && break
  sleep 5
done
assert_gone "${ORPHAN_LB_ARN} still exists after cdkd destroy --remove-protection (go-to-k/cdkd#4678)" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${REGION}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_gone "state ${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: the orphan, the journal and the state are gone"

inject_orphan 5

echo ""
echo "==> Step 6: cdkd rollback WITHOUT --remove-protection keeps the protected orphan"
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force >"${RUN_LOG}" 2>&1
PLAIN_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${PLAIN_RC}" -eq 0 ]; then
  echo "FAIL: the rollback without --remove-protection exited 0 with a deletion-protected orphan in the journal" >&2
  exit 1
fi
if ! grep -q "deleting partially-created OrphanLb" "${RUN_LOG}"; then
  echo "FAIL: the rollback did not attempt the journaled OrphanLb (output above)" >&2
  exit 1
fi
if [ "$(lb_protection "${ORPHAN_LB_ARN}")" != "true" ]; then
  echo "FAIL: the rollback without --remove-protection turned off deletion protection on ${ORPHAN_LB_ARN}" >&2
  exit 1
fi
if ! ORPHAN_OP="$(journaled_orphan_op)" || [ "$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalId // ""')" != "${ORPHAN_LB_ARN}" ]; then
  echo "FAIL: the journal no longer holds OrphanLb ${ORPHAN_LB_ARN} after a rollback whose delete was refused" >&2
  exit 1
fi
echo "    OK: exit ${PLAIN_RC}; the load balancer, its protection and its journal entry are kept"

echo ""
echo "==> Step 7: cdkd rollback --remove-protection clears it (go-to-k/cdkd#4678)"
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force --remove-protection >"${RUN_LOG}" 2>&1
RP_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${RP_RC}" -ne 0 ]; then
  echo "FAIL: cdkd rollback --remove-protection exited ${RP_RC} (expected 0: the flag reaches the journaled orphan's delete -- output above)" >&2
  explain_unreadable_scan
  exit 1
fi
for _ in $(seq 1 24); do
  gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${REGION}" && break
  sleep 5
done
assert_gone "${ORPHAN_LB_ARN} still exists after cdkd rollback --remove-protection (go-to-k/cdkd#4678)" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${ORPHAN_LB_ARN}" --region "${REGION}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after the rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
# The rollback also undid Anchor's CREATE; a state record it left (empty) goes too.
node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${STATE_PREFIX}" --region "${REGION}" --yes >/dev/null 2>&1 || true
assert_gone "state ${STATE_KEY} still exists after the rollback and its record cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: the orphan and the journal are gone"

echo ""
echo "==> Step 8: --no-rollback deploy of ${STACK} with COMPLETED_LB=1 (CompletedLb completes, FailLater fails)"
set +e
COMPLETED_LB=1 node "${LOCAL_DIST}" deploy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" \
  --yes --no-rollback >"${RUN_LOG}" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
# Captured BEFORE any FAIL below, so the trap can clear the protection on and
# delete the load balancer no later check reached.
COMPLETED_LB_ARN="$( (aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - || true) | jq -r '.resources.CompletedLb.physicalId // ""' 2>/dev/null || true)"
# A state save that failed after the deploy still leaves the journal's
# completed CREATE: fall back to it so the trap can always reach the LB.
if [ -z "${COMPLETED_LB_ARN}" ]; then
  COMPLETED_LB_ARN="$( (aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - || true) | jq -r '[.segments[]?.operations[]? | select(.logicalId == "CompletedLb")] | last | .physicalId // ""' 2>/dev/null || true)"
fi
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the COMPLETED_LB deploy unexpectedly SUCCEEDED (SSM should refuse FailLater's value against its AllowedPattern)" >&2
  exit 1
fi
case "${COMPLETED_LB_ARN}" in
  arn:*:loadbalancer/app/${COMPLETED_LB_NAME}/*) ;;
  *)
    echo "FAIL: state does not record CompletedLb as a completed CREATE of ${COMPLETED_LB_NAME} (got '${COMPLETED_LB_ARN}'; output above)" >&2
    exit 1
    ;;
esac
# The failure point: FailLater is the journal's failed CREATE and state has no
# record of it, so the deploy stopped after CompletedLb completed.
if [ "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.FailLater.physicalId // "<absent>"')" != "<absent>" ] ||
  [ "$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - | jq -r \
    '[.segments[]?.failedOperations[]? | select(.logicalId == "FailLater" and .changeType == "CREATE")] | length')" = "0" ]; then
  echo "FAIL: the deploy failed, but not at FailLater's CREATE (output above)" >&2
  exit 1
fi
if [ "$(lb_protection "${COMPLETED_LB_ARN}")" != "true" ]; then
  echo "FAIL: CompletedLb ${COMPLETED_LB_ARN} is not deletion-protected (the injection did not fire as designed)" >&2
  exit 1
fi
if ! COMPLETED_OP="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - | jq -c \
  '[.segments[]?.operations[]? | select(.logicalId == "CompletedLb" and .changeType == "CREATE")] | last // empty')" ||
  [ "$(printf '%s' "${COMPLETED_OP}" | jq -r '.physicalId // ""')" != "${COMPLETED_LB_ARN}" ]; then
  echo "FAIL: the journal does not hold CompletedLb's completed CREATE of ${COMPLETED_LB_ARN} (op: ${COMPLETED_OP:-<none>})" >&2
  exit 1
fi
echo "    OK: CompletedLb ${COMPLETED_LB_ARN} is a completed, deletion-protected CREATE in state and in the journal"

echo ""
echo "==> Step 9: cdkd rollback WITHOUT --remove-protection keeps the completed protected load balancer"
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force >"${RUN_LOG}" 2>&1
PLAIN_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${PLAIN_RC}" -eq 0 ]; then
  echo "FAIL: the rollback without --remove-protection exited 0 with a deletion-protected completed CREATE to revert" >&2
  exit 1
fi
if ! grep -q "Deleting created resource CompletedLb" "${RUN_LOG}"; then
  echo "FAIL: the rollback did not attempt CompletedLb's delete (output above)" >&2
  exit 1
fi
if gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${COMPLETED_LB_ARN}" --region "${REGION}"; then
  echo "FAIL: ${COMPLETED_LB_ARN} is gone after a rollback without --remove-protection (it must not strip protection)" >&2
  exit 1
fi
if [ "$(lb_protection "${COMPLETED_LB_ARN}")" != "true" ]; then
  echo "FAIL: the rollback without --remove-protection turned off deletion protection on ${COMPLETED_LB_ARN}" >&2
  exit 1
fi
if [ "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.CompletedLb.physicalId // ""')" != "${COMPLETED_LB_ARN}" ]; then
  echo "FAIL: state no longer records CompletedLb ${COMPLETED_LB_ARN} after a rollback whose delete was refused" >&2
  exit 1
fi
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "FAIL: the rollback journal is gone after a rollback whose delete was refused" >&2
  exit 1
fi
echo "    OK: exit ${PLAIN_RC}; the load balancer, its protection, its state record and the journal are kept"

echo ""
echo "==> Step 10: cdkd rollback --remove-protection deletes the completed protected load balancer (go-to-k/cdkd#4678)"
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force --remove-protection >"${RUN_LOG}" 2>&1
RP_RC=$?
set -e
sed 's/^/  /' "${RUN_LOG}"
if [ "${RP_RC}" -ne 0 ]; then
  echo "FAIL: cdkd rollback --remove-protection exited ${RP_RC} (expected 0: the flag reaches a completed CREATE's delete -- output above)" >&2
  echo "      (before the completed-CREATE half of go-to-k/cdkd#4678 that delete dropped the flag and AWS refused it)" >&2
  exit 1
fi
for _ in $(seq 1 24); do
  gone_probe aws elbv2 describe-load-balancers --load-balancer-arns "${COMPLETED_LB_ARN}" --region "${REGION}" && break
  sleep 5
done
assert_gone "${COMPLETED_LB_ARN} still exists after cdkd rollback --remove-protection (go-to-k/cdkd#4678)" \
  aws elbv2 describe-load-balancers --load-balancer-arns "${COMPLETED_LB_ARN}" --region "${REGION}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after the rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
if [ "$( (aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || true) | jq -r '.resources.CompletedLb.physicalId // ""' 2>/dev/null || true)" != "" ]; then
  echo "FAIL: state still records CompletedLb after cdkd rollback --remove-protection deleted it" >&2
  exit 1
fi
node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${STATE_PREFIX}" --region "${REGION}" --yes >/dev/null 2>&1 || true
assert_gone "state ${STATE_KEY} still exists after the rollback and its record cleanup" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: the completed load balancer, its state record and the journal are gone"

echo ""
echo "==> Step 11: destroy ${NET_STACK}"
node "${LOCAL_DIST}" destroy "${NET_STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force
assert_gone "state ${NET_STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NET_STATE_KEY}"
assert_gone "security group ${ORPHAN_SECURITY_GROUP} still exists after the destroy" \
  aws ec2 describe-security-groups --group-ids "${ORPHAN_SECURITY_GROUP}" --region "${REGION}"

rm -f "${RUN_LOG}"
trap - EXIT INT TERM
sweep_run_prefix
echo "[verify] PASS — cdkd destroy / rollback --remove-protection cleared the protected journaled orphan, and cdkd rollback --remove-protection the protected completed CREATE (#4678)"
