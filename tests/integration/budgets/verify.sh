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
#      delete-old + create-new), a second email subscriber, and ResourceTags
#      env=dev, team=platform -> env=prod (team untagged; issue #3989). Assert
#      all four reached AWS and that the budget was NOT replaced (its
#      LastUpdatedTime moves but the budget name-addressed entity persists;
#      replacement would be visible as a delete+create window and a reset
#      notification set — asserted via the exact expected notification set).
#   3. Destroy + assert the budget is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdBudgetsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BUDGET_NAME="cdkd-budgets-integ-budget"
QUEUE_NAME="cdkd-budgets-drift-sibling"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  rm -f "${DRIFT_OUT:-}"
  aws budgets delete-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" >/dev/null 2>&1 || true
  local qurl
  qurl=$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)
  if [ -n "${qurl}" ] && [ "${qurl}" != "None" ]; then
    aws sqs delete-queue --queue-url "${qurl}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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

BUDGET_ARN="arn:aws:budgets::${ACCOUNT_ID}:budget/${BUDGET_NAME}"
resource_tags() {
  # Every tag on the budget as sorted key=value pairs (issue #3989).
  aws budgets list-tags-for-resource --resource-arn "${BUDGET_ARN}" \
    --query 'sort_by(ResourceTags, &Key)[].join(`=`, [Key, Value])' --output json | tr -d ' \n'
}
TAGS_P1="$(resource_tags)"
if [ "${TAGS_P1}" != '["env=dev","team=platform"]' ]; then
  echo "FAIL: expected ResourceTags [env=dev, team=platform] after Phase 1, got ${TAGS_P1}" >&2
  exit 1
fi
echo "    ResourceTags env=dev, team=platform present"

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

TAGS_P2="$(resource_tags)"
if [ "${TAGS_P2}" != '["env=prod"]' ]; then
  echo "FAIL: expected ResourceTags [env=prod] after Phase 2 (team untagged), got ${TAGS_P2}" >&2
  exit 1
fi
echo "    ResourceTags reconciled: env=prod, team untagged"

# The budget must route via the SDK provider (catch a silent routing flip).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::Budgets::Budget");if(!k){process.stdout.write("MISSING");return;}process.stdout.write(r[k].provisionedBy||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected budget provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    budget routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2b: drift over a type with NO Cloud Control READ handler --------
# Issues go-to-k/cdkd#2151 / go-to-k/cdkd#2154, moved here from the
# cloudwatch-anomaly-detector fixture once AWS gave that type Cloud Control
# handlers (go-to-k/cdkd#4668). `AWS::Budgets::Budget` is NON_PROVISIONABLE in
# the CloudFormation registry and its SDK provider implements no
# `readCurrentState`, so drift takes the Cloud Control fallback, which has no
# READ handler to call. Beside it sits an SQS queue drift CAN compare. Before
# #2151 that fallback's throw escaped the command with exit 1 and no report.
echo "==> Phase 2b: drift completes despite a resource with no Cloud Control READ handler"
# Removed by `cleanup`: a second `trap ... EXIT` would REPLACE the teardown.
DRIFT_OUT="$(mktemp)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" > "${DRIFT_OUT}" 2>&1
DRIFT_RC=$?
set -e
cat "${DRIFT_OUT}"

# 1. The command produced a per-resource report for the budget.
if ! grep -q '? CostBudget (AWS::Budgets::Budget)' "${DRIFT_OUT}"; then
  echo "FAIL: drift printed no drift-unknown line for CostBudget (go-to-k/cdkd#2151)" >&2
  exit 1
fi
echo "    OK: CostBudget reported as drift unknown rather than aborting the run"

# 2. The sibling was compared. The FULL parenthetical: a bare
#    `1 resource checked` is a substring of #2154's `0 of 1 resource checked`.
if ! grep -qF '(1 resource checked, 1 unsupported)' "${DRIFT_OUT}"; then
  echo "FAIL: the SQS sibling was not compared -- expected '(1 resource checked, 1 unsupported)' (go-to-k/cdkd#2151)" >&2
  exit 1
fi
echo "    OK: the sibling SQS queue was still compared"

# 3. Exit 0: a type with no READ handler is permanent, not actionable.
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: drift exited ${DRIFT_RC}, expected 0 -- a type with no READ handler is not an actionable failure (go-to-k/cdkd#2151)" >&2
  exit 1
fi
echo "    OK: exit 0"

# 4. Not misreported as the actionable read-failure cause.
if grep -q 'NOT fully compared' "${DRIFT_OUT}"; then
  echo "FAIL: CostBudget was reported as a read FAILURE; a type with no READ handler must report drift unknown (go-to-k/cdkd#2151)" >&2
  exit 1
fi
echo "    OK: classified as drift unknown, not as a read failure"

# 5. go-to-k/cdkd#2154's negative control: something WAS compared.
if grep -q 'NOTHING was compared' "${DRIFT_OUT}"; then
  echo "FAIL: the stack warned 'NOTHING was compared' although the queue was compared (go-to-k/cdkd#2154)" >&2
  exit 1
fi
echo "    OK: the glyph is kept for a stack where something WAS compared"

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "budget ${BUDGET_NAME} still exists after destroy" aws budgets describe-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}"
echo "    budget deleted from AWS"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    drift sibling queue deleted from AWS"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    state file removed"

trap - EXIT INT TERM
echo "[verify] PASS — AWS::Budgets::Budget create / in-place update (notification + subscriber reconcile) / destroy all verified"
