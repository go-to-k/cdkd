#!/usr/bin/env bash
# verify.sh — cdkd EventBridge custom bus + EventBusPolicy integ.
#
# First AWS::Events::EventBusPolicy coverage in the integ suite (Cloud
# Control fallback — no SDK provider). Asserts the policy statement reaches
# AWS, a pure key ADDITION (a Condition block) is applied in place WITHOUT
# dropping the untouched statement keys, the `cdkd diff` for that addition
# renders symmetrically (issue #1608 regression guard: the old side must be
# `{}`, not the full statement), and destroy removes policy-then-bus cleanly.
#
# Phases:
#   1. Deploy; assert the policy statement carries Sid/Action and NO
#      Condition.
#   2. `cdkd diff` under CDKD_TEST_UPDATE=true; assert the #1608 symmetric
#      shape (old: {} / new: only the added Condition, no Principal echo).
#   3. Re-deploy with CDKD_TEST_UPDATE=true; assert the deployed statement
#      keeps Sid/Principal/Action/Resource AND gains the Condition. The bus's
#      Description changes in the same deploy (issue #6323).
#   3a. `cdkd drift` reports no drift (the bus does not declare Policy, so
#      the sibling-written policy is not compared) and `drift --revert`
#      leaves the Condition live (issue #6323).
#   3b. Re-deploy adding CDKD_TEST_BUS_POLICY_UPDATE=true; assert the second
#      bus's EventBus `Policy` (issue #5044, asserted live since Phase 1) now
#      carries the new Sid and no longer the old one (whole-document replace).
#   4. Destroy + assert bus is gone and the cdkd state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""

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
REVERT_DIR=""

STACK="CdkdEventbusPolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BUS_NAME="cdkd-integ-buspolicy-bus"
POLICY_BUS_NAME="cdkd-integ-buspolicy-prop-bus"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${REVERT_DIR:-}" ] && rm -rf "${REVERT_DIR}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws events remove-permission --statement-id 'cdkd-integ-buspolicy-stmt' --event-bus-name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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
REVERT_DIR="$(mktemp -d)"

# go-to-k/cdkd#6609 (slice C): the baseline captured right after cdkd's own
# write must hold the member the deploy just wrote. `cdkd drift` alone cannot
# see a stale baseline while the live member is the declared one (the drift
# heal rule skips the key then), so this reads the baseline itself: the state
# record's observed member must be exactly what AWS holds now, key order
# aside ('<absent>' when neither holds one).
state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }
state_lids() { # usage: state_lids <resourceType> -- every logical id of that type
  state_json | jq -r --arg t "$1" '.resources | to_entries[] | select(.value.resourceType == $t) | .key'
}
assert_observed_member() { # usage: assert_observed_member <logical-id> <jq path into observedProperties> <live JSON, '' for none> <label>
  local recorded live
  recorded=$(state_json | jq -cS --arg l "$1" \
    ".resources[\$l].observedProperties as \$o | if \$o == null then \"<no baseline>\" else ((\$o | $2) // \"<absent>\") end") \
    || { echo "FAIL: cannot read the state record of $1 after $4" >&2; exit 1; }
  if [ -z "$3" ]; then live='"<absent>"'; else live=$(jq -cS . <<<"$3"); fi
  if [ "${recorded}" != "${live}" ]; then
    echo "FAIL: $1's recorded baseline $2 is not what AWS holds after $4 (#6609)" >&2
    echo "  recorded: ${recorded}" >&2
    echo "  live:     ${live}" >&2
    exit 1
  fi
  echo "    OK: $1's baseline $2 is the live value after $4 (#6609)"
}

# go-to-k/cdkd#6609: `cdkd drift --json` compares at least one resource of the
# type, none is left uncompared, and no drifted change sits on the member's
# path. The phase's env goes after the label, as `env` arguments.
check_member_baseline() { # usage: check_member_baseline <type> <key> <phase label> [env args...]
  local type="$1" key="$2" label="$3" report rc=0
  shift 3
  report=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${report}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report after ${label}" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  if ! jq -e --arg stack "${STACK}" --arg type "${type}" --arg key "${key}" '
    def member: .path == $key or (.path | startswith($key + ".")) or (.path | startswith($key + "["));
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[], ($reports[0].drifted // [])[] | select(.type == $type)] | length) >= 1 and
    ([($reports[0].drifted // [])[] | select(.type == $type) | .changes[] | select(member)] | length) == 0 and
    ([($reports[0].notCompared // [])[] | select(.type == $type)] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: ${type} ${key} is drifted, or a ${type} is not compared, after ${label} (#6609)" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: every ${type} ${key} is drift-clean after ${label} (#6609)"
}

# --- Phase 1: deploy baseline (statement without Condition) ---------------
echo "==> Phase 1: deploy custom bus + bus policy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_P1="$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
if ! grep -q '"Sid":"cdkd-integ-buspolicy-stmt"' <<<"${POLICY_P1}"; then
  echo "FAIL: bus policy statement missing after Phase 1: ${POLICY_P1}" >&2
  exit 1
fi
if ! grep -q '"Action":"events:PutEvents"' <<<"${POLICY_P1}"; then
  echo "FAIL: bus policy Action missing after Phase 1: ${POLICY_P1}" >&2
  exit 1
fi
if grep -q '"Condition"' <<<"${POLICY_P1}"; then
  echo "FAIL: bus policy unexpectedly has a Condition after Phase 1: ${POLICY_P1}" >&2
  exit 1
fi
echo "    bus policy statement live (no Condition yet)"

# Issue #5044: the EventBus `Policy` property reaches AWS on create.
PROP_POLICY_P1="$(aws events describe-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
if ! grep -qF '"Sid":"cdkd-integ-buspolicy-prop-v1"' <<<"${PROP_POLICY_P1}"; then
  echo "FAIL: EventBus Policy property not applied on create (issue 5044): ${PROP_POLICY_P1}" >&2
  exit 1
fi
echo "    EventBus Policy property applied on create"
assert_observed_member PolicyPropBus .Policy "${PROP_POLICY_P1}" "Phase 1 (create)"
check_member_baseline AWS::Events::EventBus Policy "Phase 1 (create)" -u CDKD_TEST_UPDATE -u CDKD_TEST_BUS_POLICY_UPDATE

# --- Phase 2: diff for the Condition addition must render symmetrically ---
echo "==> Phase 2: cdkd diff for the pure key addition (#1608 shape)"
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}")"
printf '%s\n' "${DIFF_OUT}"
if ! grep -qF 'old: {}' <<<"${DIFF_OUT}"; then
  echo "FAIL: diff old side is not '{}' for a pure key addition (issue 1608 regression)" >&2
  exit 1
fi
if ! grep -q '"Condition"' <<<"${DIFF_OUT}"; then
  echo "FAIL: diff new side does not show the added Condition" >&2
  exit 1
fi
if grep -q '"Principal"' <<<"${DIFF_OUT}"; then
  echo "FAIL: diff echoes unchanged statement keys (issue 1608 regression: reads as removal)" >&2
  exit 1
fi
echo "    diff renders the addition as old: {} / new: {Condition}"

# --- Phase 3: apply the Condition addition (in-place UPDATE) --------------
echo "==> Phase 3: re-deploy with the Condition added"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POLICY_P3="$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
for token in '"Sid":"cdkd-integ-buspolicy-stmt"' '"Action":"events:PutEvents"' '"Principal"' '"Resource"' '"Condition"' 'cdkd.integ'; do
  if ! grep -qF "${token}" <<<"${POLICY_P3}"; then
    echo "FAIL: bus policy statement lost ${token} after the Condition update: ${POLICY_P3}" >&2
    exit 1
  fi
done
echo "    full statement retained WITH the added Condition"
# go-to-k/cdkd#7009: the Description update is in place, and its result used to
# carry `attributes: {}`, which erased the Bus record's Arn / Name.
BUS_ARN_LIVE="$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" \
  --query 'Arn' --output text)"
BUS_ATTRS_P3="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources;const k=Object.keys(r).find(x=>x.startsWith("Bus")&&!x.startsWith("BusPolicy")&&r[x].resourceType==="AWS::Events::EventBus");const a=(k&&r[k].attributes)||{};process.stdout.write(`${a.Arn??"<absent>"} ${a.Name??"<absent>"}`)})')"
if [ "${BUS_ATTRS_P3}" != "${BUS_ARN_LIVE} ${BUS_NAME}" ]; then
  echo "FAIL: after the in-place bus update the record's Arn / Name expected '${BUS_ARN_LIVE} ${BUS_NAME}', got '${BUS_ATTRS_P3}' (issue #7009)" >&2
  exit 1
fi
echo "    bus record keeps its Arn / Name across the in-place update"

# --- Phase 3a: drift on the sibling-written bus policy (issue #6323) -------
# Phase 3 updated the bus (Description) and the BusPolicy statement together,
# so the bus's re-captured baseline holds the policy WITHOUT the Condition.
# The bus does not declare Policy, so drift must not compare it, and
# --revert must not write the stale document back.
echo "==> Phase 3a: cdkd drift does not report the sibling-written bus policy (#6323)"
DRIFT_RC=0
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || DRIFT_RC=$?
printf '%s\n' "${DRIFT_OUT}"
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: #6323: cdkd drift exited ${DRIFT_RC} on the untouched stack" >&2
  exit 1
fi
if grep -qF 'Policy.Statement' <<<"${DRIFT_OUT}"; then
  echo "FAIL: #6323: cdkd drift reported the sibling-written bus policy as drift" >&2
  exit 1
fi
# The fully-compared clean row only: the `⚠ ... no drift detected, but ...`
# rows also exit 0 when a resource was skipped or unreadable, which would
# leave the bus uncompared and this phase vacuous.
if grep -qF '⚠' <<<"${DRIFT_OUT}"; then
  echo "FAIL: cdkd drift did not compare every resource (a ⚠ row): the #6323 check is vacuous" >&2
  exit 1
fi
# All three resources compared (Bus, BusPolicy, PolicyPropBus), none unsupported.
if ! grep -qF "✓ ${STACK} (${REGION}): no drift detected (3 resources checked, 0 unsupported)" <<<"${DRIFT_OUT}"; then
  echo "FAIL: cdkd drift printed no clean row comparing all 3 resources (wording changed, or one went unsupported?)" >&2
  exit 1
fi

echo "==> Phase 3a: cdkd drift --revert keeps the live Condition (#6323)"
# The revert compares all three resources (Bus, BusPolicy, PolicyPropBus); the
# Bus is an L2, so its logical id is `Bus<hash>`: the EventBus that is not PolicyPropBus.
BUS_LID="$(state_lids AWS::Events::EventBus | grep -vx PolicyPropBus || true)"
case "${BUS_LID}" in Bus?*) ;; *) echo "FAIL: #6323: no Bus<hash> EventBus logical id in state: '${BUS_LID}'" >&2; exit 1 ;; esac
revert_identity_snapshot "${REVERT_DIR}/revert-ids-3a-before" "${STACK}" "${BUS_LID}" BusPolicy PolicyPropBus || exit 1
REVERT_3A_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes \
  >"${REVERT_DIR}/revert-3a.log" 2>&1 || REVERT_3A_RC=$?
cat "${REVERT_DIR}/revert-3a.log"
revert_identity_verify "${REVERT_DIR}/revert-ids-3a-before" "${REVERT_DIR}/revert-ids-3a-after" 3 "${REVERT_DIR}/revert-3a.log" || exit 1
[ "${REVERT_3A_RC}" -eq 0 ] || { echo "FAIL: #6323: cdkd drift --revert exited ${REVERT_3A_RC}, want 0" >&2; exit 1; }
POLICY_P3A="$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
for token in '"Condition"' 'cdkd.integ'; do
  if ! grep -qF "${token}" <<<"${POLICY_P3A}"; then
    echo "FAIL: #6323: drift --revert dropped ${token} from the bus policy: ${POLICY_P3A}" >&2
    exit 1
  fi
done
echo "    drift clean and --revert left the sibling's Condition in place"

# --- Phase 3b: change the EventBus Policy property (issue #5044) ----------
echo "==> Phase 3b: re-deploy with a changed EventBus Policy Sid"
CDKD_TEST_UPDATE=true CDKD_TEST_BUS_POLICY_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PROP_POLICY_P3B="$(aws events describe-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
if ! grep -qF '"Sid":"cdkd-integ-buspolicy-prop-v2"' <<<"${PROP_POLICY_P3B}"; then
  echo "FAIL: changed EventBus Policy property not applied on update (issue 5044): ${PROP_POLICY_P3B}" >&2
  exit 1
fi
if grep -qF 'cdkd-integ-buspolicy-prop-v1' <<<"${PROP_POLICY_P3B}"; then
  echo "FAIL: old EventBus Policy statement survived the whole-document update (issue 5044): ${PROP_POLICY_P3B}" >&2
  exit 1
fi
echo "    EventBus Policy property replaced with the new document"
assert_observed_member PolicyPropBus .Policy "${PROP_POLICY_P3B}" "Phase 3b (replace)"
check_member_baseline AWS::Events::EventBus Policy "Phase 3b (replace)" CDKD_TEST_UPDATE=true CDKD_TEST_BUS_POLICY_UPDATE=true

# go-to-k/cdkd#6609: `cdkd drift --revert` acts on what the capture recorded,
# so an out-of-band change of a member must report, revert to the template in
# place (same physical id, no delete / create), and leave drift clean.
revert_drift_json() { # usage: revert_drift_json [env args...] -- prints `cdkd drift --json`; exit 0..2 is a report
  local out rc=0
  out=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${out}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report (#6609 revert arm)" >&2
    printf '%s\n' "${out}" >&2
    return 1
  fi
  printf '%s' "${out}"
}
assert_member_drifted() { # usage: assert_member_drifted <drift JSON> <type> <member key> <label>
  jq -e --arg t "$2" --arg k "$3" '
    def member: .path == $k or (.path | startswith($k + ".")) or (.path | startswith($k + "["));
    [.[] | (.drifted // [])[] | select(.type == $t) | .changes[] | select(member)] | length > 0
  ' <<<"$1" >/dev/null || {
    echo "FAIL: cdkd drift does not report the out-of-band $2 $3 after $4 (#6609)" >&2
    printf '%s\n' "$1" >&2
    exit 1
  }
  echo "    OK: cdkd drift reports the out-of-band $2 $3 after $4 (#6609)"
}
assert_drift_clean() { # usage: assert_drift_clean <label> [env args...]
  local rc=0 label="$1"
  shift
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || rc=$?
  [ "${rc}" -eq 0 ] || { echo "FAIL: cdkd drift exited ${rc} after ${label}, want 0 (#6609)" >&2; exit 1; }
  echo "    OK: cdkd drift is clean after ${label} (#6609)"
}
run_revert() { # usage: run_revert [env args...]
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
}
assert_same() { # usage: assert_same <label> <before> <after>
  [ -n "$2" ] && [ "$2" = "$3" ] || { echo "FAIL: $1 changed across the revert: '$2' -> '$3' (#6609: a delete / create)" >&2; exit 1; }
  echo "    OK: $1 unchanged across the revert ($2)"
}

echo "==> Phase 3c: an out-of-band bus Policy is reverted in place (#6609)"
P3C_ENV=(CDKD_TEST_UPDATE=true CDKD_TEST_BUS_POLICY_UPDATE=true)
BUS_ID_BEFORE="$(aws events describe-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}" \
  --query '[Arn, CreationTime]' --output text)"
PID_BEFORE="$(state_json | jq -r '.resources.PolicyPropBus.physicalId')"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
OOB_POLICY="$(jq -cn --arg a "${ACCOUNT_ID}" --arg r "${REGION}" --arg b "${POLICY_BUS_NAME}" '{
  Version: "2012-10-17",
  Statement: [{ Sid: "cdkd-6609-oob", Effect: "Allow", Principal: { AWS: ("arn:aws:iam::" + $a + ":root") },
    Action: "events:PutRule", Resource: ("arn:aws:events:" + $r + ":" + $a + ":event-bus/" + $b) }]
}')"
aws events put-permission --event-bus-name "${POLICY_BUS_NAME}" --region "${REGION}" --policy "${OOB_POLICY}"
DRIFT_3C="$(revert_drift_json "${P3C_ENV[@]}")" || exit 1
assert_member_drifted "${DRIFT_3C}" AWS::Events::EventBus Policy "an out-of-band put-permission"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-3c-before" "${STACK}" PolicyPropBus || exit 1
REVERT_3C_RC=0
run_revert "${P3C_ENV[@]}" >"${REVERT_DIR}/revert-3c.log" 2>&1 || REVERT_3C_RC=$?
cat "${REVERT_DIR}/revert-3c.log"
revert_identity_verify "${REVERT_DIR}/revert-ids-3c-before" "${REVERT_DIR}/revert-ids-3c-after" 1 "${REVERT_DIR}/revert-3c.log" || exit 1
[ "${REVERT_3C_RC}" -eq 0 ] || { echo "FAIL: Phase 3c: cdkd drift --revert exited ${REVERT_3C_RC}, want 0" >&2; exit 1; }
PROP_POLICY_P3C="$(aws events describe-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}" \
  --query 'Policy' --output text)"
[ "$(jq -cS . <<<"${PROP_POLICY_P3C}")" = "$(jq -cS . <<<"${PROP_POLICY_P3B}")" ] \
  || { echo "FAIL: the reverted bus Policy is not the template's: ${PROP_POLICY_P3C}" >&2; exit 1; }
echo "    OK: the revert put the template's bus Policy back"
assert_same "${POLICY_BUS_NAME}'s ARN and CreationTime" "${BUS_ID_BEFORE}" \
  "$(aws events describe-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}" --query '[Arn, CreationTime]' --output text)"
assert_same "PolicyPropBus's state physical id" "${PID_BEFORE}" "$(state_json | jq -r '.resources.PolicyPropBus.physicalId')"
assert_drift_clean "the phase 3c revert" "${P3C_ENV[@]}"

# --- Phase 4: destroy -----------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "event bus ${BUS_NAME} still exists after destroy" aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"
assert_gone "event bus ${POLICY_BUS_NAME} still exists after destroy" aws events describe-event-bus --name "${POLICY_BUS_NAME}" --region "${REGION}"
echo "    bus policy + bus deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — EventBusPolicy deploy/diff/update/destroy, all phases passed"
