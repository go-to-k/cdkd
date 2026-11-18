#!/usr/bin/env bash
# verify.sh -- cdkd AWS::ECS::Cluster: capacity providers and ClusterSettings
# changed in the same update (issue #6562).
#
# `PutClusterCapacityProviders` leaves the cluster's attachments
# `UPDATE_IN_PROGRESS` for a few seconds, and ECS refuses the `UpdateCluster`
# cdkd sent right after it for the settings: the deploy rolled back,
# intermittently (3 of 7 on the issue's repro). cdkd now waits for the
# attachments between the two calls (`waitForClusterAttachments` in
# `src/provisioning/providers/ecs/cluster-attachments.ts`) and sends the Put
# only when `CapacityProviders` / `DefaultCapacityProviderStrategy` changed.
#
# Phases:
#   1. Deploy an L1 cluster: [FARGATE], a FARGATE strategy, containerInsights
#      disabled. Assert all three via describe-clusters.
#   2. UPDATE A (CDKD_TEST_UPDATE=true): [FARGATE, FARGATE_SPOT], a two-entry
#      strategy, containerInsights enabled, in ONE deploy. Assert the deploy
#      passed, cdkd sent the Put (its `--verbose` line), the providers, the
#      strategy and the setting reached AWS, the attachments settled, and the
#      cluster ARN is unchanged. Then `cdkd diff` is clean.
#   3. Settings only (A's providers, containerInsights enhanced). Assert the
#      setting reached AWS and cdkd sent NO PutClusterCapacityProviders.
#   4. Back to the base shape: providers AND the setting change together again.
#   5. UPDATE A again: a third providers + settings change. Phases 2, 4 and 5
#      are the race the issue hit; pre-fix each failed about half the time.
#   6. Remove BOTH properties (and set containerInsights disabled). Assert
#      cdkd sent the Put and both lists are empty, as CloudFormation leaves
#      them (measured: a raw CFn stack read back [] and []).
#   7. Destroy. Assert the cluster is INACTIVE and the state file is gone.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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
export AWS_PAGER=""

STACK="CdkdEcsClusterCapacitySettings"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CLUSTER_LOGICAL="Cluster"
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-6562-deploy.$$.log"
# cdkd's own debug line after a PutClusterCapacityProviders
# (`updateCluster` in src/provisioning/providers/ecs/cluster-task-definition.ts).
PUT_NEEDLE="Updated capacity providers for ECS cluster"

# ECS answers a deleted cluster with rc 0 and an INACTIVE status or a MISSING
# failure, never a not-found error, so the canonical gone_probe cannot read
# it. Same contract: 0 gone, 1 present, hard FAIL undetermined.
ecs_cluster_gone_probe() { # usage: ecs_cluster_gone_probe <cluster>
  local out state rc
  out=$(aws ecs describe-clusters --clusters "$1" --region "${REGION}" --output json 2>&1) && rc=0 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: gone-probe undetermined (cluster $1): ${out}" >&2
    exit 1
  fi
  state=$(jq -r '.clusters[0].status // .failures[0].reason // "UNDETERMINED"' <<<"${out}")
  case "${state}" in
    INACTIVE | MISSING) return 0 ;;
    ACTIVE | DRAINING | PROVISIONING | DEPROVISIONING) return 1 ;;
    *) echo "FAIL: gone-probe undetermined (cluster $1): ${out}" >&2; exit 1 ;;
  esac
}

CLEANED_UP=0
PRE_RUN=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  # `state destroy` throws when there is no state, as before any run and after a
  # PASS, so its failure means something only for a state that exists. Anything
  # but a clean not-found counts as existing: keeping a record costs nothing.
  STATE_LEFT=0
  if [ -n "${STATE_BUCKET:-}" ]; then
    if STATE_HEAD="$(aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" 2>&1 >/dev/null)"; then
      STATE_LEFT=1
    elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${STATE_HEAD}"; then
      STATE_LEFT=1
    fi
  fi
  if [ "${STATE_LEFT}" = "1" ] && [ -f "${LOCAL_DIST}" ] &&
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1; then
    STATE_LEFT=0
  fi
  # A deploy that failed before state recorded the cluster leaves a name
  # nothing here knows, and the generated name starts with the stack. The
  # account is shared and a peer may be running this fixture, so only this
  # run's own teardown deletes by prefix: before the run, a match is reported
  # and stops it.
  LEFT_BY_PREFIX=""
  case "${STACK}" in
    CdkdEcsCluster?*)
      if SWEPT="$(aws ecs list-clusters --region "${REGION}" \
        --query "clusterArns[?contains(@, ':cluster/${STACK}-')]" --output text 2>&1)"; then
        for arn in ${SWEPT}; do
          [ "${arn}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} cluster:${arn##*/}"
          else
            aws ecs delete-cluster --cluster "${arn}" --region "${REGION}" >/dev/null 2>&1 ||
              echo "WARN: could not delete cluster ${arn}" >&2
          fi
        done
      else
        echo "WARN: could not list clusters of ${STACK}: ${SWEPT}" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdEcsCluster?*" >&2
      ;;
  esac
  if [ "${STATE_LEFT}" = "1" ]; then
    echo "WARN: state destroy failed: s3://${STATE_BUCKET:-}/${STATE_KEY} is kept, and the cluster of ${STACK} may remain" >&2
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
  if [ -n "${LEFT_BY_PREFIX}" ]; then
    echo "FAIL: ${STACK} resources exist before this run, possibly a peer's live run:${LEFT_BY_PREFIX}" >&2
    exit 1
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
PRE_RUN=1
cleanup
PRE_RUN=0
CLEANED_UP=0

describe_cluster() { # the cluster with its settings and attachments, as JSON
  aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --include SETTINGS ATTACHMENTS \
    --region "${REGION}" --query 'clusters[0]' --output json
}
cluster_field() { # usage: cluster_field <jq filter over describe_cluster>
  jq -r "$1" <<<"$(describe_cluster)"
}
# $1 = phase label, $2 = expected sorted providers, $3 = expected strategy
# (`provider:weight:base` entries, sorted), $4 = expected containerInsights.
assert_cluster() {
  local json providers strategy insights arn status
  json="$(describe_cluster)"
  providers="$(jq -r '[(.capacityProviders // [])[]] | sort | join(" ")' <<<"${json}")"
  strategy="$(jq -r '[(.defaultCapacityProviderStrategy // [])[] | "\(.capacityProvider):\(.weight):\(.base // 0)"] | sort | join(" ")' <<<"${json}")"
  insights="$(jq -r '[(.settings // [])[] | select(.name == "containerInsights") | .value] | join(" ")' <<<"${json}")"
  arn="$(jq -r '.clusterArn' <<<"${json}")"
  status="$(jq -r '.status' <<<"${json}")"
  [ "${status}" = "ACTIVE" ] ||
    { echo "FAIL: $1: cluster status '${status}', expected ACTIVE" >&2; exit 1; }
  [ "${providers}" = "$2" ] ||
    { echo "FAIL: $1: capacityProviders '${providers}', expected '$2'" >&2; exit 1; }
  [ "${strategy}" = "$3" ] ||
    { echo "FAIL: $1: defaultCapacityProviderStrategy '${strategy}', expected '$3'" >&2; exit 1; }
  [ "${insights}" = "$4" ] ||
    { echo "FAIL: $1: containerInsights '${insights}', expected '$4'" >&2; exit 1; }
  [ "${arn}" = "${CLUSTER_ARN}" ] ||
    { echo "FAIL: $1: the cluster was replaced ('${CLUSTER_ARN}' -> '${arn}')" >&2; exit 1; }
  echo "    $1: providers '${providers}', strategy '${strategy}', containerInsights ${insights}, same ARN"
}
# usage: deploy_logged env [-u VAR | VAR=value]... -- the deploy runs under that env.
deploy_logged() {
  if ! "$@" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --yes --verbose >"${DEPLOY_LOG}" 2>&1; then
    echo "FAIL: the deploy failed. Tail:" >&2
    tail -30 "${DEPLOY_LOG}" >&2
    exit 1
  fi
}
assert_put_sent() { # $1 = phase label, $2 = yes | no
  if grep -qF "${PUT_NEEDLE}" "${DEPLOY_LOG}"; then
    [ "$2" = "yes" ] ||
      { echo "FAIL: $1: cdkd sent PutClusterCapacityProviders although the providers did not change (#6562)" >&2; exit 1; }
  else
    [ "$2" = "no" ] ||
      { echo "FAIL: $1: cdkd sent no PutClusterCapacityProviders although the providers changed. Tail:" >&2; tail -30 "${DEPLOY_LOG}" >&2; exit 1; }
  fi
}
assert_attachments_settled() { # $1 = phase label
  local att
  att="$(cluster_field '.attachmentsStatus // "NONE"')"
  # cdkd waited for the attachments before its UpdateCluster; ECS keeps the
  # last status, so a settled update reads UPDATE_COMPLETE.
  [ "${att}" = "UPDATE_COMPLETE" ] ||
    { echo "FAIL: $1: attachmentsStatus '${att}', expected UPDATE_COMPLETE" >&2; exit 1; }
}

BASE_PROVIDERS="FARGATE"
BASE_STRATEGY="FARGATE:1:0"
A_PROVIDERS="FARGATE FARGATE_SPOT"
A_STRATEGY="FARGATE:1:1 FARGATE_SPOT:2:0"

# --- Phase 1: deploy the base shape -----------------------------------------
echo "==> Phase 1: deploy ([FARGATE], containerInsights disabled)"
deploy_logged env -u CDKD_TEST_NO_PROVIDERS -u CDKD_TEST_UPDATE -u CDKD_TEST_SETTINGS_ONLY

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
CLUSTER_NAME="$(jq -r ".resources.${CLUSTER_LOGICAL}.physicalId" <<<"${STATE_JSON}")"
CLUSTER_ROUTE="$(jq -r ".resources.${CLUSTER_LOGICAL}.provisionedBy // \"sdk\"" <<<"${STATE_JSON}")"
case "${CLUSTER_NAME}" in
  "${STACK}-"?*) ;;
  *) echo "FAIL: ${CLUSTER_LOGICAL} physicalId '${CLUSTER_NAME}' does not start with ${STACK}-" >&2; exit 1 ;;
esac
[ "${CLUSTER_ROUTE}" = "sdk" ] ||
  { echo "FAIL: ${CLUSTER_LOGICAL} provisionedBy='${CLUSTER_ROUTE}', expected sdk" >&2; exit 1; }
CLUSTER_ARN="$(cluster_field '.clusterArn')"
assert_cluster "after the create" "${BASE_PROVIDERS}" "${BASE_STRATEGY}" "disabled"

# --- Phase 2: providers + settings in one update ----------------------------
echo "==> Phase 2: update ([FARGATE, FARGATE_SPOT] + containerInsights enabled, one deploy)"
deploy_logged env -u CDKD_TEST_NO_PROVIDERS -u CDKD_TEST_SETTINGS_ONLY CDKD_TEST_UPDATE=true
assert_put_sent "update A" yes
assert_cluster "after update A" "${A_PROVIDERS}" "${A_STRATEGY}" "enabled"
assert_attachments_settled "after update A"

DIFF_OUT="$(env -u CDKD_TEST_NO_PROVIDERS -u CDKD_TEST_SETTINGS_ONLY CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || true
# cdkd's own line (src/cli/commands/diff.ts), naming this stack.
grep -qF "No changes detected for stack ${STACK}" <<<"${DIFF_OUT}" ||
  { echo "FAIL: diff after update A is not clean: ${DIFF_OUT}" >&2; exit 1; }
echo "    diff after update A reports no changes"

# --- Phase 3: settings only -------------------------------------------------
echo "==> Phase 3: settings-only update (containerInsights enhanced, providers unchanged)"
deploy_logged env -u CDKD_TEST_NO_PROVIDERS CDKD_TEST_UPDATE=true CDKD_TEST_SETTINGS_ONLY=true
assert_put_sent "settings-only update" no
assert_cluster "after the settings-only update" "${A_PROVIDERS}" "${A_STRATEGY}" "enhanced"

# --- Phase 4: back to the base shape (providers + settings again) -----------
echo "==> Phase 4: update back to [FARGATE] + containerInsights disabled"
deploy_logged env -u CDKD_TEST_NO_PROVIDERS -u CDKD_TEST_UPDATE -u CDKD_TEST_SETTINGS_ONLY
assert_put_sent "update back to base" yes
assert_cluster "after the update back to base" "${BASE_PROVIDERS}" "${BASE_STRATEGY}" "disabled"
assert_attachments_settled "after the update back to base"

# --- Phase 5: update A again ------------------------------------------------
echo "==> Phase 5: update A again"
deploy_logged env -u CDKD_TEST_NO_PROVIDERS -u CDKD_TEST_SETTINGS_ONLY CDKD_TEST_UPDATE=true
assert_put_sent "update A again" yes
assert_cluster "after update A again" "${A_PROVIDERS}" "${A_STRATEGY}" "enabled"
assert_attachments_settled "after update A again"

# --- Phase 6: remove both properties ---------------------------------------
echo "==> Phase 6: update declaring no capacity providers (containerInsights disabled)"
deploy_logged env -u CDKD_TEST_UPDATE -u CDKD_TEST_SETTINGS_ONLY CDKD_TEST_NO_PROVIDERS=true
assert_put_sent "removing both properties" yes
assert_cluster "after removing both properties" "" "" "disabled"

# --- Phase 7: destroy -------------------------------------------------------
echo "==> Phase 7: destroy"
CDKD_TEST_NO_PROVIDERS=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if ! ecs_cluster_gone_probe "${CLUSTER_NAME}"; then
  echo "FAIL: cluster ${CLUSTER_NAME} still exists after destroy" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

cleanup
trap - EXIT INT TERM
echo "[verify] PASS — capacity providers and settings changed together three times, a settings-only update sent no Put, removing both cleared them, destroy left nothing"
