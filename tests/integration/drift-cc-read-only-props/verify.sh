#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6485.
#
# A Cloud Control routed resource's drift baseline is its whole Cloud Control
# model, read-only properties included. Before the fix, an out-of-band
# `Description` edit on an AWS::Location::Tracker also reported its read-only
# `UpdateTime` as drift, and `cdkd drift --revert -y` failed:
#   UPDATE failed for Tracker: Invalid patch update: readOnlyProperties
#   [/properties/UpdateTime] cannot be updated
# leaving the real drift in place.
#
# Phases:
#   1. Deploy a GeofenceCollection + Tracker (+ TrackerConsumer). Premise: the
#      Tracker's recorded baseline holds UpdateTime, so the run discriminates.
#   2. `cdkd drift` exits 0.
#   3. Change both descriptions OUT OF BAND.
#   4. `cdkd drift` exits 1, names Description on both, never UpdateTime.
#   5. `cdkd drift --revert -y` exits 0; both live descriptions are back.
#   6. `cdkd drift` exits 0 again.
#   7. go-to-k/cdkd#7007: after a sync deploy (Phase 5's revert left the
#      reader stale), an in-place Description change moves the Tracker's
#      UpdateTime; the SSM parameter reading it must hold the LIVE value
#      (before the fix it stayed NO_CHANGE on the previous one).
#   8. go-to-k/cdkd#7007: with a consumer stack importing the UpdateTime
#      export, a tag-only edit is refused only if it moved UpdateTime (the
#      guard judges the export after the update, as CloudFormation does).
#   9. Destroy + gone-probes.
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

STACK="CdkdDriftCcReadOnlyPropsExample"
CONSUMER="CdkdDriftCcReadOnlyPropsConsumer"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TRACKER="CdkdIntegDriftRoTracker"
COLLECTION="CdkdIntegDriftRoGeo"
DRIFT_LOG=""
REVERT_WORK=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
  if [ -n "${REVERT_WORK:-}" ]; then
    rm -f "${REVERT_WORK}/revert-ids-5-before" "${REVERT_WORK}/revert-ids-5-after"
    rmdir "${REVERT_WORK}" 2>/dev/null
  fi
  # The consumer first: it imports the producer's export.
  local s
  for s in "${CONSUMER}" "${STACK}"; do
    if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" destroy "${s}" --state-bucket "${STATE_BUCKET}" \
        --region "${REGION}" --force >/dev/null 2>&1
    fi
    if [ -x "${LOCAL_DIST}" ]; then
      node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    fi
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/state.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/lock.json" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    fi
  done
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

run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  rm -f "${DRIFT_LOG:-}"
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
expect_descriptions() { # usage: expect_descriptions <want> <phase label>
  local t g
  t="$(aws location describe-tracker --tracker-name "${TRACKER}" --query Description --output text)" || return 1
  g="$(aws location describe-geofence-collection --collection-name "${COLLECTION}" \
    --query Description --output text)" || return 1
  if [ "${t}" != "$1" ] || [ "${g}" != "$1" ]; then
    echo "FAIL: $2: want both descriptions '$1', got tracker '${t}', collection '${g}'" >&2
    exit 1
  fi
  echo "    ok: $2: both descriptions '$1'"
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
expect_descriptions integ "Phase 1"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
# Premise: the Tracker is Cloud Control routed and its recorded baseline holds
# the read-only UpdateTime. Without it this run proves nothing.
if [ "$(jq -r '.resources.Tracker.provisionedBy // empty' <<<"${STATE_JSON}")" != "cc-api" ]; then
  echo "FAIL: premise: the Tracker record is not Cloud Control provisioned" >&2
  exit 1
fi
if [ -z "$(jq -r '.resources.Tracker.observedProperties.UpdateTime // empty' <<<"${STATE_JSON}")" ]; then
  echo "FAIL: premise: the Tracker baseline records no UpdateTime" >&2
  exit 1
fi

echo "==> Phase 2: cdkd drift on the fresh stack reports no drift"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: change both descriptions out of band"
aws location update-tracker --tracker-name "${TRACKER}" --description oob >/dev/null
aws location update-geofence-collection --collection-name "${COLLECTION}" --description oob >/dev/null
expect_descriptions oob "Phase 3"

echo "==> Phase 4: cdkd drift reports Description, never UpdateTime"
run_drift
expect_drift_rc 1 "Phase 4"
# Sentinel: the drift blocks must be there, so a reworded report cannot pass
# the UpdateTime grep below vacuously.
for type in AWS::Location::Tracker AWS::Location::GeofenceCollection; do
  if ! grep -qF "(${type})" "${DRIFT_LOG}"; then
    echo "FAIL: Phase 4: no ${type} drift block — the report wording drifted" >&2
    exit 1
  fi
done
if [ "$(grep -c 'Description: oob' "${DRIFT_LOG}")" != "2" ]; then
  echo "FAIL: Phase 4: the report does not name both out-of-band descriptions" >&2
  exit 1
fi
if grep -q 'UpdateTime' "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: the report names the read-only UpdateTime" >&2
  exit 1
fi

echo "==> Phase 5: cdkd drift --revert -y reverts both descriptions"
REVERT_WORK="$(mktemp -d)"
revert_identity_snapshot "${REVERT_WORK}/revert-ids-5-before" "${STACK}" Tracker Geo || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_WORK}/revert-ids-5-before" "${REVERT_WORK}/revert-ids-5-after" 2 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 5"
expect_descriptions integ "Phase 5"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

# go-to-k/cdkd#7007 helpers. Both sides are ISO-8601 timestamps that may be
# spelled differently (Cloud Control `...Z`, the CLI `...+00:00`): compare the
# instants.
live_update_time() {
  aws location describe-tracker --tracker-name "${TRACKER}" --query UpdateTime --output text
}
reader_value() {
  local id
  id="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.TimeReader.physicalId // empty')"
  [ -n "${id}" ] || { echo "FAIL: no TimeReader record" >&2; return 1; }
  aws ssm get-parameter --name "${id}" --query Parameter.Value --output text
}
same_instant() { # usage: same_instant <a> <b>
  python3 -c 'import sys,datetime as d
p=lambda s: d.datetime.fromisoformat(s.replace("Z","+00:00"))
sys.exit(0 if p(sys.argv[1])==p(sys.argv[2]) else 1)' "$1" "$2"
}

echo "==> Phase 7: an in-place Description change moves the UpdateTime reader (#7007)"
# Phase 5's revert moved UpdateTime out of band, so the reader is stale
# already and ANY deploy promotes it on its own value. Sync it first with an
# unchanged template: the Description deploy below then starts from a reader
# that equals the live (and recorded) UpdateTime, and only the fix promotes it.
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
LIVE_6="$(live_update_time)"
READER_6="$(reader_value)"
if ! same_instant "${READER_6}" "${LIVE_6}"; then
  echo "FAIL: Phase 7 premise: the sync deploy left the reader at '${READER_6}', live is '${LIVE_6}'" >&2
  exit 1
fi
CDKD_INTEG_TRACKER_DESCRIPTION=integ-7007 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
LIVE_7="$(live_update_time)"
READER_7="$(reader_value)"
echo "    reader before '${READER_6}', after '${READER_7}', live '${LIVE_7}'"
# Premise: the update moved UpdateTime, so a stale reader shows.
if same_instant "${LIVE_6}" "${LIVE_7}"; then
  echo "FAIL: Phase 7 premise: the Description update did not move UpdateTime" >&2
  exit 1
fi
if ! same_instant "${READER_7}" "${LIVE_7}"; then
  echo "FAIL: Phase 7: the UpdateTime reader holds '${READER_7}', live is '${LIVE_7}'" >&2
  exit 1
fi
echo "    ok: Phase 7: the reader follows the live UpdateTime"

echo "==> Phase 8: a tag-only edit is refused only if it moved the imported UpdateTime (#7007)"
CDKD_INTEG_TRACKER_DESCRIPTION=integ-7007 \
  node "${LOCAL_DIST}" deploy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
set +e
TAG_OUT="$(CDKD_INTEG_TRACKER_DESCRIPTION=integ-7007 CDKD_INTEG_TRACKER_TAG=on \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
TAG_RC=$?
set -e
sed 's/^/    | /' <<<"${TAG_OUT}"
LIVE_8="$(live_update_time)"
REFUSAL="  - ${CONSUMER} (${REGION}): imports export '.*', which this deploy would change"
if same_instant "${LIVE_7}" "${LIVE_8}"; then
  echo "NOTE: Phase 8: a tag edit left the Tracker's UpdateTime unchanged"
  if [ "${TAG_RC}" != "0" ]; then
    echo "FAIL: Phase 8: the tag edit moved nothing, but the deploy exited ${TAG_RC}" >&2
    exit 1
  fi
else
  echo "NOTE: Phase 8: a tag edit moved the Tracker's UpdateTime"
  if [ "${TAG_RC}" = "0" ] || ! grep -q "${REFUSAL}" <<<"${TAG_OUT}"; then
    echo "FAIL: Phase 8: the imported UpdateTime moved, but the deploy was not refused (rc ${TAG_RC})" >&2
    exit 1
  fi
fi
echo "    ok: Phase 8: the export guard judged the moved value"

echo "==> Phase 9: destroy"
node "${LOCAL_DIST}" destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "tracker ${TRACKER} leaked" aws location describe-tracker --tracker-name "${TRACKER}"
assert_gone "geofence collection ${COLLECTION} leaked" \
  aws location describe-geofence-collection --collection-name "${COLLECTION}"
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "consumer state leaked" aws s3api head-object --bucket "${STATE_BUCKET}" \
  --key "cdkd/${CONSUMER}/${REGION}/state.json"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
echo "PASS: drift-cc-read-only-props"
