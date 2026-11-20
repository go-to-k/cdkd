#!/usr/bin/env bash
# verify.sh — cdkd Route 53 drift and auto import against real AWS.
#
# Phase 2 asserts a clean deploy reads back clean through `cdkd drift`.
#
# Phase 3 edits the zone out of band and asserts drift (#6660, #6661):
#   - `gone` (a RecordSet) deleted      -> reported `deleted`, drift exits 1.
#   - `g2` deleted, `g1` changed (the RecordSetGroup's two members)
#                                       -> the group reported `drifted`.
#   - `*` switched to an alias          -> reported `drifted`.
#   Before #6660 both deletions read as "drift unknown", which exits 0 and
#   hides the other member's change.
#
# Phase 4 runs `cdkd drift --revert` and asserts AWS holds the recorded
# records again: `*` a simple A record (#6661 re-sent the alias), `g2`
# re-created, `g1` restored. `gone` is re-created by hand, then drift is
# clean.
#
# Phase 5 drops the stack's state and runs a plain `cdkd import` (#6662):
# every record names the zone by `Ref`, so each is found against the zone
# imported in the same run, by Name + Type + SetIdentifier, and recorded under
# cdkd's composite id. Before #6662 only the zone was imported. Drift is clean
# afterwards and a redeploy keeps every id.
#
# Phase 6 destroys the stack and asserts the zone and the state are gone.
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

STACK="Route53DriftImportStack"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ZONE_NAME="cdkd-r53di-${ACCOUNT_ID}.internal"
export CDKD_TEST_ZONE_NAME="${ZONE_NAME}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON=""
IMPORT_LOG=""

cdkd() { node "${LOCAL_DIST}" "$@"; }

# The zone this fixture names, when it is live: `ListHostedZonesByName` starts
# AT the name, so the first entry is it or a later zone.
live_zone_id() {
  aws route53 list-hosted-zones-by-name --dns-name "${ZONE_NAME}" --max-items 1 \
    --query "HostedZones[?Name=='${ZONE_NAME}.'].Id | [0]" --output text | sed 's#^/hostedzone/##'
}

# One record set as JSON (`null` when absent): name, type, optional SetIdentifier.
record_json() {
  local zone="$1" name="$2" type="$3"
  aws route53 list-resource-record-sets --hosted-zone-id "${zone}" \
    --start-record-name "${name}" --start-record-type "${type}" --max-items 5 --output json \
    | jq -c --arg n "${name}" --arg t "${type}" \
      '[.ResourceRecordSets[] | select(.Name == $n and .Type == $t)][0]'
}

change_batch() { # usage: change_batch <zoneId> <changes-json-array>
  aws route53 change-resource-record-sets --hosted-zone-id "$1" \
    --change-batch "{\"Changes\": $2}" --query 'ChangeInfo.Status' --output text >/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  rm -f "${DRIFT_JSON:-}" "${IMPORT_LOG:-}" 2>/dev/null || true
  set +eu
  local destroy_rc=0
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Phase 5 drops the state before it re-imports, so a run stopped between
  # the two leaves the zone in no state at all: delete it by its exact name.
  case "${ZONE_NAME}" in
    cdkd-r53di-?*.internal)
      local zone
      zone=$(live_zone_id 2>/dev/null)
      if [ -n "${zone}" ] && [ "${zone}" != "None" ]; then
        local changes
        changes=$(aws route53 list-resource-record-sets --hosted-zone-id "${zone}" --output json 2>/dev/null \
          | jq -c '[.ResourceRecordSets[] | select(.Type != "NS" and .Type != "SOA")
              | {Action: "DELETE", ResourceRecordSet: .}]')
        if [ -n "${changes}" ] && [ "${changes}" != "[]" ]; then
          change_batch "${zone}" "${changes}" 2>/dev/null || echo "WARN: could not empty zone ${zone}" >&2
        fi
        aws route53 delete-hosted-zone --id "${zone}" >/dev/null 2>&1 \
          || echo "WARN: could not delete zone ${zone}" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: unexpected zone name '${ZONE_NAME}'" >&2
      ;;
  esac
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

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy"
cdkd deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
ZONE_ID=$(jq -r --arg n "${ZONE_NAME}" \
  '.resources | to_entries[] | select(.value.resourceType == "AWS::Route53::HostedZone"
    and (.value.properties.Name == $n or .value.properties.Name == ($n + "."))) | .value.physicalId' <<<"${STATE}")
if [ -z "${ZONE_ID}" ]; then
  echo "FAIL: no hosted zone ${ZONE_NAME} in state" >&2
  exit 1
fi
# The logical id of the record set whose Name is `$1` (and SetIdentifier `$2`).
record_logical_id() {
  jq -r --arg n "$1.${ZONE_NAME}." --arg s "${2:-}" \
    '.resources | to_entries[] | select(.value.resourceType == "AWS::Route53::RecordSet"
      and .value.properties.Name == $n and ((.value.properties.SetIdentifier // "") == $s)) | .key' <<<"${STATE}"
}
GONE_ID=$(record_logical_id gone)
WILDCARD_ID=$(record_logical_id '*')
for v in GONE_ID WILDCARD_ID; do
  if [ -z "${!v}" ]; then
    echo "FAIL: could not find ${v} in state" >&2
    exit 1
  fi
done
echo "    zone ${ZONE_ID}; gone=${GONE_ID}; wildcard=${WILDCARD_ID}"

DRIFT_JSON=$(mktemp)
run_drift() { # usage: run_drift [extra args...]; sets DRIFT_RC, writes DRIFT_JSON
  set +e
  cdkd drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json "$@" >"${DRIFT_JSON}"
  DRIFT_RC=$?
  set -e
}

# --- Phase 2: drift is clean after deploy ------------------------------------
echo "==> Phase 2: drift is clean after deploy"
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: drift after a clean deploy exited ${DRIFT_RC}:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi

# --- Phase 3: out-of-band edits are reported --------------------------------
echo "==> Phase 3: delete / change / switch records out of band"
GONE_LIVE=$(record_json "${ZONE_ID}" "gone.${ZONE_NAME}." A)
G1_LIVE=$(record_json "${ZONE_ID}" "g1.${ZONE_NAME}." A)
G2_LIVE=$(record_json "${ZONE_ID}" "g2.${ZONE_NAME}." TXT)
WILDCARD_LIVE=$(record_json "${ZONE_ID}" "\\052.${ZONE_NAME}." A)
for v in GONE_LIVE G1_LIVE G2_LIVE WILDCARD_LIVE; do
  if [ "${!v}" = "null" ] || [ -z "${!v}" ]; then
    echo "FAIL: ${v} is not live after deploy" >&2
    exit 1
  fi
done
change_batch "${ZONE_ID}" "$(jq -nc \
  --argjson gone "${GONE_LIVE}" --argjson g1 "${G1_LIVE}" --argjson g2 "${G2_LIVE}" \
  --argjson wild "${WILDCARD_LIVE}" --arg zone "${ZONE_ID}" --arg target "target.${ZONE_NAME}." \
  '[{Action: "DELETE", ResourceRecordSet: $gone},
    {Action: "DELETE", ResourceRecordSet: $g2},
    {Action: "UPSERT", ResourceRecordSet: ($g1 | .ResourceRecords = [{Value: "192.0.2.99"}])},
    {Action: "DELETE", ResourceRecordSet: $wild},
    {Action: "CREATE", ResourceRecordSet: {Name: $wild.Name, Type: "A",
      AliasTarget: {HostedZoneId: $zone, DNSName: $target, EvaluateTargetHealth: false}}}]')"

run_drift
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: drift after out-of-band edits exited ${DRIFT_RC}, expected 1 (#6660):" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
check_listed() { # usage: check_listed <array> <logicalId> <what>
  if ! jq -e --arg id "$2" --arg k "$1" '.[0][$k] | any(.logicalId == $id)' "${DRIFT_JSON}" >/dev/null; then
    echo "FAIL: $3 — ${2} is not under '${1}':" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
}
check_listed deleted "${GONE_ID}" "a record deleted out of band must read as deleted (#6660)"
check_listed drifted Group "a group missing a member must read as drifted (#6660)"
check_listed drifted "${WILDCARD_ID}" "a record switched to an alias must read as drifted"
if ! jq -e '.[0].notSupported | length == 0' "${DRIFT_JSON}" >/dev/null; then
  echo "FAIL: a Route 53 record read as drift unknown (#6660):" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
# The group's other member is still compared: its changed value is reported.
if ! jq -e '.[0].drifted[] | select(.logicalId == "Group") | .changes | tostring | contains("192.0.2.99")' \
  "${DRIFT_JSON}" >/dev/null; then
  echo "FAIL: the group's changed member g1 is not reported (#6660):" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    OK: deleted record, group member loss + change, and alias switch reported (exit 1)"

# --- Phase 4: revert ----------------------------------------------------------
echo "==> Phase 4: drift --revert"
set +e
cdkd drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
REVERT_RC=$?
set -e
echo "    revert exited ${REVERT_RC} (the deleted record is not revertable)"
WILDCARD_AFTER=$(record_json "${ZONE_ID}" "\\052.${ZONE_NAME}." A)
if ! jq -e '.AliasTarget == null and .ResourceRecords == [{"Value": "192.0.2.3"}]' <<<"${WILDCARD_AFTER}" >/dev/null; then
  echo "FAIL: revert left the wildcard record as '${WILDCARD_AFTER}', expected the simple A 192.0.2.3 (#6661)" >&2
  exit 1
fi
if [ "$(record_json "${ZONE_ID}" "g2.${ZONE_NAME}." TXT)" = "null" ]; then
  echo "FAIL: revert did not re-create the group's deleted member g2 (#6660)" >&2
  exit 1
fi
if ! jq -e '.ResourceRecords == [{"Value": "192.0.2.10"}]' <<<"$(record_json "${ZONE_ID}" "g1.${ZONE_NAME}." A)" >/dev/null; then
  echo "FAIL: revert did not restore the group member g1" >&2
  exit 1
fi
change_batch "${ZONE_ID}" "$(jq -nc --argjson gone "${GONE_LIVE}" '[{Action: "CREATE", ResourceRecordSet: $gone}]')"
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: drift after the revert exited ${DRIFT_RC}:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    OK: revert restored the simple record and the group; drift clean"

# --- Phase 5: auto import ----------------------------------------------------
echo "==> Phase 5: drop the state and re-import with no --resource (#6662)"
EXPECTED_IDS=$(jq -cS '.resources | to_entries | map({key, value: .value.physicalId}) | from_entries' <<<"${STATE}")
cdkd state orphan "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
IMPORT_LOG=$(mktemp)
cdkd import "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes | tee "${IMPORT_LOG}"
IMPORTED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -cS '.resources | to_entries | map({key, value: .value.physicalId}) | from_entries')
# The group is no AWS object: an import names it by its logical id, where a
# deploy generated a name. Every other id is the deployed one.
if [ "$(jq -cS --arg z "${ZONE_ID}" '.Group = $z + "|Group"' <<<"${EXPECTED_IDS}")" != "${IMPORTED}" ]; then
  echo "FAIL: the import recorded ${IMPORTED}, expected the deployed ids ${EXPECTED_IDS} (#6662)" >&2
  exit 1
fi
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: drift after the import exited ${DRIFT_RC}:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
# A redeploy over the imported state replaces nothing: every id survives.
cdkd deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
REDEPLOYED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -cS '.resources | to_entries | map({key, value: .value.physicalId}) | from_entries')
if [ "${REDEPLOYED}" != "${IMPORTED}" ]; then
  echo "FAIL: a redeploy after the import changed ids: ${IMPORTED} -> ${REDEPLOYED}" >&2
  exit 1
fi
echo "    OK: every record and the group imported under the deployed ids; drift clean; redeploy kept every id"

# --- Phase 6: destroy ----------------------------------------------------------
echo "==> Phase 6: destroy"
cdkd destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "hosted zone ${ZONE_ID} survived destroy" aws route53 get-hosted-zone --id "${ZONE_ID}"
assert_gone "state ${STATE_KEY} survived destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "==> route53-drift-import test passed (#6660 deleted records + group members, #6661 alias revert, #6662 auto import)"
