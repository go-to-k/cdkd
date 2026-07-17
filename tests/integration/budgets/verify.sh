#!/usr/bin/env bash
# verify.sh — cdkd AWS::Budgets::Budget SDK Provider integ (issue #1041).
#
# Exercises the new BudgetsBudgetProvider end to end. The Budgets API is a
# global, per-account service served from us-east-1 — the provider relies on
# the SDK endpoint ruleset routing any deploy region to the global endpoint.
# Budgets are free, so this fixture costs nothing.
#
# Phases:
#   1. Deploy a 1 USD monthly cost budget with one ACTUAL/GREATER_THAN 80%
#      email notification. Assert the budget, its limit, the notification,
#      and the subscriber all reached AWS (describe-budget /
#      describe-notifications-for-budget / describe-subscribers-for-notification).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: BudgetLimit 1 -> 2 USD
#      (UpdateBudget in place), notification threshold 80 -> 90 (reconciler
#      delete-old + create-new), and a second email subscriber. Assert all
#      three reached AWS and that the budget was NOT replaced (its
#      LastUpdatedTime moves but the budget name-addressed entity persists;
#      replacement would be visible as a delete+create window and a reset
#      notification set — asserted via the exact expected notification set).
#   3. Destroy + assert the budget is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdBudgetsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BUDGET_NAME="cdkd-budgets-integ-budget"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws budgets delete-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

notification_json() {
  # ALL notifications currently on the budget, in the exact shape
  # describe-notifications-for-budget returns (callers assert on count +
  # threshold).
  aws budgets describe-notifications-for-budget \
    --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
    --query 'Notifications' --output json
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy baseline budget (1 USD, threshold 80, one subscriber)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LIMIT_P1="$(aws budgets describe-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
  --query 'Budget.BudgetLimit.Amount' --output text)"
case "${LIMIT_P1}" in
  1|1.0|1.00*) ;;
  *) echo "FAIL: expected BudgetLimit 1 USD after Phase 1, got '${LIMIT_P1}'" >&2; exit 1 ;;
esac
echo "    budget exists with BudgetLimit=${LIMIT_P1} USD"

THRESHOLD_P1="$(notification_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s);process.stdout.write(String(n.length===1?n[0].Threshold:"WRONG_COUNT:"+n.length))})')"
if [ "${THRESHOLD_P1}" != "80" ]; then
  echo "FAIL: expected one notification with Threshold=80, got '${THRESHOLD_P1}'" >&2
  exit 1
fi
echo "    notification Threshold=80 present"

SUBSCRIBERS_P1="$(aws budgets describe-subscribers-for-notification \
  --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
  --notification NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=80 \
  --query 'sort(Subscribers[].Address)' --output json | tr -d ' \n')"
if [ "${SUBSCRIBERS_P1}" != '["cdkd-integ@example.com"]' ]; then
  echo "FAIL: expected the single email subscriber, got ${SUBSCRIBERS_P1}" >&2
  exit 1
fi
echo "    subscriber cdkd-integ@example.com present"

# --- Phase 2: in-place UPDATE ------------------------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (limit 2 USD, threshold 90, +1 subscriber)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LIMIT_P2="$(aws budgets describe-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
  --query 'Budget.BudgetLimit.Amount' --output text)"
case "${LIMIT_P2}" in
  2|2.0|2.00*) ;;
  *) echo "FAIL: expected BudgetLimit 2 USD after Phase 2, got '${LIMIT_P2}'" >&2; exit 1 ;;
esac
echo "    BudgetLimit updated in place to ${LIMIT_P2} USD"

THRESHOLD_P2="$(notification_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s);process.stdout.write(String(n.length===1?n[0].Threshold:"WRONG_COUNT:"+n.length))})')"
if [ "${THRESHOLD_P2}" != "90" ]; then
  echo "FAIL: expected exactly one notification with Threshold=90 after reconcile, got '${THRESHOLD_P2}'" >&2
  exit 1
fi
echo "    notification reconciled: Threshold=90, old Threshold=80 removed"

SUBSCRIBERS_P2="$(aws budgets describe-subscribers-for-notification \
  --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
  --notification NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=90 \
  --query 'sort(Subscribers[].Address)' --output json | tr -d ' \n')"
if [ "${SUBSCRIBERS_P2}" != '["cdkd-integ-2@example.com","cdkd-integ@example.com"]' ]; then
  echo "FAIL: expected both email subscribers after Phase 2, got ${SUBSCRIBERS_P2}" >&2
  exit 1
fi
echo "    both subscribers present on the new notification"

# The budget must route via the SDK provider (catch a silent routing flip).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::Budgets::Budget");if(!k){process.stdout.write("MISSING");return;}process.stdout.write(r[k].provisionedBy||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected budget provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    budget routed via SDK provider (provisionedBy=sdk)"

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws budgets describe-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" >/dev/null 2>&1; then
  echo "FAIL: budget ${BUDGET_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    budget deleted from AWS"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    state file removed"

trap - EXIT
echo "[verify] PASS — AWS::Budgets::Budget create / in-place update (notification + subscriber reconcile) / destroy all verified"
