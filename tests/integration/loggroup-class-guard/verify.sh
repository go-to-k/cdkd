#!/usr/bin/env bash
# verify.sh — cdkd LogGroupClass update-guard integ.
#
# Regression coverage for the bug where changing a log group's LogGroupClass
# (STANDARD <-> INFREQUENT_ACCESS) on redeploy was silently dropped: the CFn
# doc marks the property "Update requires: Updates are not supported" (no
# CloudWatch Logs API can change the class after creation; a CFn stack update
# carrying the change FAILS), but cdkd's logs-loggroup-provider.update()
# ignored it — the deploy reported success while AWS kept the old class, and
# state recorded the new one so the next diff saw no change and it could
# never self-heal. The fix throws ResourceUpdateNotSupportedError with an
# actionable message.
#
# Phases:
#   1. Deploy a STANDARD log group. Assert AWS reports STANDARD.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (INFREQUENT_ACCESS) WITHOUT
#      --replace: expect FAILURE with the actionable "cannot be changed after
#      creation" + "--replace" message, AND assert AWS is unchanged.
#   3. Re-deploy the same change with --replace --force-stateful-recreation:
#      expect success and the log group recreated as INFREQUENT_ACCESS.
#   4. Destroy + assert the log group is gone and the cdkd state removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLoggroupClassGuardExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
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

lg_name() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["LgName"])'
}

lg_class() {
  # logGroupClass may be omitted for STANDARD groups — treat absent as STANDARD.
  local cls
  cls="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query 'logGroups[0].logGroupClass' --output text)"
  if [ "${cls}" = "None" ]; then
    echo "STANDARD"
  else
    echo "${cls}"
  fi
}

# --- Phase 1: deploy baseline (STANDARD) ---------------------------------
echo "==> Phase 1: deploy STANDARD log group"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LG="$(lg_name)"
echo "    log group: ${LG}"

CLASS_P1="$(lg_class "${LG}")"
echo "    AWS log group class (Phase 1): ${CLASS_P1}"
if [ "${CLASS_P1}" != "STANDARD" ]; then
  echo "FAIL: expected STANDARD after Phase 1, got '${CLASS_P1}'" >&2
  exit 1
fi

# --- Phase 2: class change WITHOUT --replace must FAIL actionably ---------
echo "==> Phase 2: re-deploy as INFREQUENT_ACCESS without --replace (expect actionable failure)"
set +e
P2_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
P2_RC=$?
set -e
echo "${P2_OUT}" | tail -4

if [ "${P2_RC}" -eq 0 ]; then
  echo "FAIL: class change without --replace exited 0 (CLI exit-code contract broken?)" >&2
  exit 1
fi
if echo "${P2_OUT}" | grep -q "Deployment completed successfully"; then
  echo "FAIL: class change without --replace unexpectedly succeeded (silent drop regressed?)" >&2
  exit 1
fi
if ! echo "${P2_OUT}" | grep -q "cannot be changed after creation"; then
  echo "FAIL: expected the actionable LogGroupClass message, got rc=${P2_RC} without it" >&2
  exit 1
fi
if ! echo "${P2_OUT}" | grep -q -- "--replace"; then
  echo "FAIL: expected the --replace remediation hint in the error message" >&2
  exit 1
fi

CLASS_P2="$(lg_class "${LG}")"
if [ "${CLASS_P2}" != "STANDARD" ]; then
  echo "FAIL: AWS class changed despite the guard (expected STANDARD, got '${CLASS_P2}')" >&2
  exit 1
fi
echo "    guard fired with actionable message; AWS unchanged (STANDARD)"

# --- Phase 3: --replace --force-stateful-recreation recreates the group ---
echo "==> Phase 3: re-deploy with --replace --force-stateful-recreation (expect recreate as INFREQUENT_ACCESS)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --replace --force-stateful-recreation

CLASS_P3="$(lg_class "${LG}")"
echo "    AWS log group class (Phase 3): ${CLASS_P3}"
if [ "${CLASS_P3}" != "INFREQUENT_ACCESS" ]; then
  echo "FAIL: expected INFREQUENT_ACCESS after --replace recreate, got '${CLASS_P3}'" >&2
  exit 1
fi
echo "    log group recreated under the new class"

# --- Phase 4: destroy ------------------------------------------------------
echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FOUND="$(aws logs describe-log-groups --log-group-name-prefix "${LG}" --region "${REGION}" \
  --query 'length(logGroups)' --output text)"
if [ "${FOUND}" != "0" ]; then
  echo "FAIL: log group ${LG} still exists after destroy" >&2
  exit 1
fi
echo "    log group deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — LogGroupClass guard (actionable failure without --replace, recreate with --replace), all 4 phases passed"
