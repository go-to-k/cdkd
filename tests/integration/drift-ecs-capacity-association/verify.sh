#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6610
# (ECS cluster <- AWS::ECS::ClusterCapacityProviderAssociations).
#
# The capacity providers an association attaches are that resource's, not the
# cluster's. Once a cluster UPDATE re-captured its baseline with them, a later
# change to the association read as
#   ~ Cluster (AWS::ECS::Cluster)  CapacityProviders: [FARGATE] -> [FARGATE, FARGATE_SPOT]
# and `cdkd drift --revert -y` sent the stale list through
# PutClusterCapacityProviders, detaching FARGATE_SPOT.
#
# Phases:
#   1. Deploy the cluster + an association attaching FARGATE. `cdkd drift` exits 0.
#   2. CDKD_TEST_UPDATE=tag UPDATES the cluster (a tag) while the association
#      exists, so its re-captured baseline records FARGATE. `cdkd drift` exits 0.
#   3. CDKD_TEST_UPDATE=tag,spot makes the association attach FARGATE_SPOT too;
#      the cluster is unchanged. `cdkd drift` exits 0.
#   4. Enable containerInsights OUT OF BAND: `cdkd drift` exits 1 and names
#      ClusterSettings, never CapacityProviders; `cdkd drift --revert -y`
#      disables it again and leaves both capacity providers attached.
#   5. CDKD_TEST_UPDATE=tag,spot,noassoc removes the association, whose delete
#      detaches both; the cluster is unchanged. The deploy empties the cluster's
#      recorded lists, and `cdkd drift` exits 0.
#   6. Destroy + gone-probes.
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
. ../revert-identity.sh

STACK="CdkdDriftEcsCapacityAssociationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The phases set the mode; an inherited value would deploy one early.
unset CDKD_TEST_UPDATE
DRIFT_LOG=""
CLUSTER=""
REVERT_WORK=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
  if [ -n "${REVERT_WORK:-}" ]; then
    rm -f "${REVERT_WORK}/revert-ids-4-before" "${REVERT_WORK}/revert-ids-4-after"
    rmdir "${REVERT_WORK}" 2>/dev/null
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
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

# The cluster's live capacity providers, sorted and space-joined.
expect_providers() { # usage: expect_providers <label> <want>
  local out got
  if ! out="$(aws ecs describe-clusters --clusters "${CLUSTER}" \
    --query 'clusters[0].capacityProviders' --output text)"; then
    echo "FAIL: describe-clusters ${CLUSTER} failed" >&2
    exit 1
  fi
  # `|| true`: grep exits 1 on an EMPTY list, which under pipefail would end
  # the run at this assignment, before the comparison that expects it empty.
  got="$(printf '%s\n' "${out}" | tr -s ' \t' '\n' | { grep -v -e '^$' -e '^None$' || true; } | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1 capacity providers: want [$2], got [${got}]" >&2
    exit 1
  fi
  echo "    ok: $1 capacity providers [${got}]"
}
expect_insights() { # usage: expect_insights <label> <want>
  local got
  if ! got="$(aws ecs describe-clusters --clusters "${CLUSTER}" --include SETTINGS \
    --query "clusters[0].settings[?name=='containerInsights'].value | [0]" --output text)"; then
    echo "FAIL: describe-clusters ${CLUSTER} failed" >&2
    exit 1
  fi
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1 containerInsights: want $2, got ${got}" >&2
    exit 1
  fi
  echo "    ok: $1 containerInsights ${got}"
}
# The cluster record's recorded CapacityProviders, sorted and space-joined.
expect_baseline() { # usage: expect_baseline <label> <want>
  local state got
  if ! state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"; then
    echo "FAIL: could not read ${STATE_KEY}" >&2
    exit 1
  fi
  # MISSING when the record or its recorded list is absent, so an empty
  # want ("") is the recorded list being EMPTY, never the key being gone.
  got="$(jq -r '[.resources[] | select(.resourceType == "AWS::ECS::Cluster")] as $c
    | if ($c | length) != 1 or (($c[0].observedProperties.CapacityProviders | type) != "array")
      then "MISSING" else ($c[0].observedProperties.CapacityProviders | sort | join(" ")) end' <<<"${state}")"
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1 recorded CapacityProviders: want [$2], got [${got}]" >&2
    exit 1
  fi
  echo "    ok: $1 recorded CapacityProviders [${got}]"
}
run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
expect_drift_rc() { # usage: expect_drift_rc <want> <phase label>
  if [ "${DRIFT_RC}" != "$1" ]; then
    echo "FAIL: $2: cdkd drift exited ${DRIFT_RC}, want $1" >&2
    exit 1
  fi
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
CLUSTER="$(jq -r '.outputs.ClusterName // empty' <<<"${STATE_JSON}")"
if [ -z "${CLUSTER}" ]; then
  echo "FAIL: no ClusterName output" >&2
  exit 1
fi
expect_providers "Phase 1" "FARGATE"
run_drift
expect_drift_rc 0 "Phase 1"

echo "==> Phase 2: UPDATE the cluster while the association exists"
CDKD_TEST_UPDATE=tag node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
expect_providers "Phase 2" "FARGATE"
expect_baseline "Phase 2" "FARGATE"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: the association attaches FARGATE_SPOT too (cluster unchanged)"
CDKD_TEST_UPDATE=tag,spot node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
expect_providers "Phase 3" "FARGATE FARGATE_SPOT"
expect_baseline "Phase 3" "FARGATE"
run_drift
expect_drift_rc 0 "Phase 3"

echo "==> Phase 4: an out-of-band containerInsights change is drift"
aws ecs update-cluster-settings --cluster "${CLUSTER}" \
  --settings name=containerInsights,value=enabled >/dev/null
expect_insights "Phase 4 (out-of-band)" "enabled"
run_drift
expect_drift_rc 1 "Phase 4"
# Sentinel: the drifted block must be the cluster's, so a reworded report
# cannot pass the key greps below vacuously.
if ! grep -q "(AWS::ECS::Cluster)" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: no AWS::ECS::Cluster drift block — the report wording drifted" >&2
  exit 1
fi
if ! grep -q "ClusterSettings" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: the drift report does not name ClusterSettings" >&2
  exit 1
fi
if grep -qE "CapacityProviders|DefaultCapacityProviderStrategy" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: the drift report names the association-owned capacity providers" >&2
  exit 1
fi
REVERT_WORK="$(mktemp -d)"
revert_identity_snapshot "${REVERT_WORK}/revert-ids-4-before" "${STACK}" Cluster || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_WORK}/revert-ids-4-before" "${REVERT_WORK}/revert-ids-4-after" 1 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 4 (--revert)"
expect_insights "Phase 4 (after --revert)" "disabled"
expect_providers "Phase 4 (after --revert)" "FARGATE FARGATE_SPOT"

echo "==> Phase 5: remove the association (cluster unchanged)"
CDKD_TEST_UPDATE=tag,spot,noassoc node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
expect_providers "Phase 5" ""
expect_baseline "Phase 5" ""
run_drift
expect_drift_rc 0 "Phase 5"

echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
# A deleted cluster lists as INACTIVE for a while, so "gone" is its status.
STATUS="$(aws ecs describe-clusters --clusters "${CLUSTER}" --query 'clusters[0].status' --output text)"
case "${STATUS}" in
  INACTIVE | None) echo "    ok: cluster ${CLUSTER} is ${STATUS}" ;;
  *) echo "FAIL: cluster ${CLUSTER} leaked (status ${STATUS})" >&2; exit 1 ;;
esac
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
echo "PASS: drift-ecs-capacity-association"
