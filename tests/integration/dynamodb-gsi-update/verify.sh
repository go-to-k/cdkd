#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB "add a Global Secondary Index" in-place UPDATE integ.
#
# Regression coverage for the bug where adding a GSI to an existing table grew
# AttributeDefinitions, which cdkd misclassified as an immutable-property change
# and tried to REPLACE the table (CreateTable on the same name -> "Table already
# exists" -> deploy fails + rollback). The fix routes the GSI add through
# UpdateTable's GlobalSecondaryIndexUpdates so the table is updated in place.
#
# It ALSO carries the live coverage for issue #1767 (the GSI / LSI readback was
# forwarded VERBATIM off `DescribeTable`, so its AWS-managed members took part in
# drift detection) — see the Phase 2b block below for what that arm proves and
# why each half of it is shaped the way it is.
#
# Phases:
#   1. Deploy the table with only the `pk` partition key; capture its
#      CreationDateTime + assert no GSI.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds GSI `gsi1` on `gsipk`).
#      Assert: deploy succeeds, the table's CreationDateTime is UNCHANGED (no
#      replacement), GSI `gsi1` exists and reaches ACTIVE, and the table routes
#      via the SDK provider (provisionedBy=sdk).
#   2a. Assert (issue #1768): the deploy SUCCEEDED although the template
#      declares a WarmThroughput below what AWS holds, cdkd said why it skipped
#      the call, and AWS's value is unchanged.
#   2d. Assert (issue #1768, EMIT half): the per-index WarmThroughput the
#      template declares on gsi1 actually reached AWS (12001/4000, which the
#      AWS default 12000/4000 cannot produce).
#   2b. Put real items into the table, then assert (issue #1767): the
#      deploy-written `observedProperties` index entry carries ONLY the CFn
#      members, `cdkd drift` reports the table CLEAN (not "drift unknown"), and
#      it stays clean against the TEMPLATE baseline once `observedProperties` is
#      stripped.
#   2e. Assert (issue #1782): the per-index ContributorInsightsSpecification
#      declared on gsi1 — an index this very update ADDED — reached AWS.
#   I1-I5. The per-index Contributor Insights arms (issue #1782) on their OWN
#      stack and table — enable at create with an undeclared sibling as the
#      negative control, no phantom drift, an out-of-band toggle detected and
#      reverted, removal + enable-with-Mode on update, destroy. See that block.
#   3a. Race an out-of-band GSI CREATE into the table immediately before the
#      destroy (issue #1931), so AWS refuses the DeleteTable with
#      `Cannot delete table while indexes are being created, updated, or
#      deleted` and cdkd has to absorb it. Armed up to twice: a destroy that
#      exits 0 without the refusal means the window was missed, never that the
#      retry broke (that case aborts the run at the destroy itself).
#   3. Destroy + assert the table is gone and the cdkd state file is removed.
#   3b. Assert (issue #1931): AWS really refused, cdkd really retried, and the
#      destroy still succeeded.
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

STACK="CdkdDynamodbGsiUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-gsi-update-test-table"
GSI_NAME="gsi1"
# Issue #1782: the per-index Contributor Insights arms run on their OWN stack
# and table (same CDK app), so they neither wait on nor disturb the arms above.
INSIGHTS_STACK="CdkdDynamodbGsiInsightsExample"
INSIGHTS_STATE_KEY="cdkd/${INSIGHTS_STACK}/${REGION}/state.json"
INSIGHTS_TABLE="cdkd-gsi-insights-test-table"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Scratch files, declared HERE so `cleanup` can sweep them on EVERY exit path.
# Each assertion below can `exit 1` between the write and its own `rm -f`, and
# a PID-suffixed leftover in TMPDIR is invisible until it accumulates.
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-1768-deploy.$$.log"
STATE_JSON="${TMPDIR:-/tmp}/cdkd-1767-state.$$.json"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-1767-drift.$$.json"
# The Phase 3 destroy log, read by the issue #1931 assertions below. Declared
# here so `cleanup` sweeps it on every exit path, including the ones that never
# reach Phase 3.
DESTROY_LOG="${TMPDIR:-/tmp}/cdkd-1931-destroy.$$.log"

# Re-entrancy guard for `cleanup`. The INT / TERM traps run `cleanup` and then
# `exit`, and that `exit` re-fires the EXIT trap — so without this flag every
# Ctrl-C paid the teardown TWICE. That is not a cosmetic double echo: the
# `state destroy` below now retries the same index-busy refusal this fixture
# arms (up to ~18 min since issue #1950 raised this type's budget,
# `TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`, to 14), and the delete loop under it is
# bounded at ~19 min, so a second pass costs ~40 min of teardown after the user
# has already asked the run to stop.
CLEANED_UP=0

# Delete one table BY NAME, retrying. A subshell under `set +eu` so calling it
# from the `set +eu` trap never re-arms strict mode mid-sweep.
#
# RETRIED, not fired once: the issue #1931 arm below deliberately leaves an
# index mid-CREATE, and AWS refuses `DeleteTable` for as long as it builds. A
# single `|| true` attempt against a transitioning index reports success to
# nobody and LEAKS the table, which is the one outcome an integ must never
# produce. Bounded at ~10 min.
# The loop keys on the DELETE's own outcome, never on a blind read: a probe
# that treated any describe-table failure as "gone" would stop retrying on a
# throttle and leak exactly the table it is here to reap. Only an explicit
# not-found ends the loop early; the index-busy refusal (and anything else)
# keeps retrying.
reap_table() { # usage: reap_table <table-name>
  (
    set +eu
    # EXACT names, accepting arm first: a prefix glob would also reap a
    # `cdkd-gsi-*` table some other fixture owns.
    case "${1:-}" in
      cdkd-gsi-update-test-table | cdkd-gsi-insights-test-table) ;;
      *)
        echo "WARN: teardown sweep refused — '${1:-}' is not one of this fixture's table names" >&2
        exit 0
        ;;
    esac
    DELETE_DONE=""
    DELETE_ERR=""
    for _ in $(seq 1 40); do
      DELETE_ERR="$(aws dynamodb delete-table --table-name "$1" --region "${REGION}" 2>&1 >/dev/null)" && { DELETE_DONE=1; break; }
      grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${DELETE_ERR}" && { DELETE_DONE=1; break; }
      sleep 15
    done
    # SAY SO on exhaustion. Falling out of this loop silently is the worst
    # outcome an integ can produce: a terminal error (expired credentials,
    # AccessDenied) burns all 40 attempts and then LEAKS a real table with
    # nothing in the log to attribute it to. The loop cannot fail the run -- it
    # is teardown -- so a loud message is the only signal available.
    if [ -z "${DELETE_DONE}" ]; then
      echo "WARN: cleanup could not delete $1 after 40 attempts (~10 min) — it may still exist and MUST be checked. Last AWS error: ${DELETE_ERR}" >&2
    fi
  )
}

cleanup() {
  # Every exit path still cleans up exactly ONCE: the first caller (EXIT, INT,
  # TERM, or the explicit pre-run sweep) does the work and latches the flag; a
  # re-entry returns immediately.
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}" "${STATE_JSON}" "${STATE_JSON}.stripped" "${DRIFT_JSON}" "${DESTROY_LOG}"
  # The tables are swept BY NAME first and the state records dropped second, so
  # a `state destroy` that dies half way is never the only thing standing
  # between a table and a leak. (`state destroy` then finds the table already
  # gone, which it treats as deleted.)
  reap_table "${TABLE_NAME}"
  reap_table "${INSIGHTS_TABLE}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${INSIGHTS_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${INSIGHTS_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${INSIGHTS_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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
# The pre-run sweep is NOT this run's teardown, so hand the once-only budget
# back to the traps. Without this the EXIT trap would see the latch already set
# and skip the teardown entirely — the opposite failure from the double run the
# latch exists to stop.
CLEANED_UP=0

# --- Phase 1: deploy baseline (no GSI) --------------------------------
echo "==> Phase 1: deploy baseline table (pk only, no GSI)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

GSI_COUNT_P1="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'length(Table.GlobalSecondaryIndexes || `[]`)' --output text)"
if [ "${GSI_COUNT_P1}" != "0" ]; then
  echo "FAIL: expected 0 GSIs after Phase 1, got ${GSI_COUNT_P1}" >&2
  exit 1
fi

CREATION_P1="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
echo "    baseline table CreationDateTime=${CREATION_P1}"

# Issue #1768: what AWS holds for warm throughput BEFORE the update that asks
# for less. Read as the pair rather than a hardcoded 12000/4000 so the
# assertion stays true on an account whose table has grown past the floor.
WARM_P1="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'join(`/`, [to_string(Table.WarmThroughput.ReadUnitsPerSecond), to_string(Table.WarmThroughput.WriteUnitsPerSecond)])' \
  --output text)"
case "${WARM_P1}" in
  *null* | '' )
    # AWS reports a WarmThroughput for EVERY table, so an absent one means the
    # probe broke — and a "null/null" on both sides would let the Phase 2a
    # comparison pass without measuring anything.
    echo "FAIL (issue #1768): could not read the table's WarmThroughput ('${WARM_P1}') — the Phase 2a assertion would be vacuous" >&2
    exit 1
    ;;
esac
echo "    baseline WarmThroughput=${WARM_P1}"

# --- Phase 2: add a GSI (in-place UPDATE, must NOT replace) ------------
echo "==> Phase 2: re-deploy adding GSI ${GSI_NAME} (in-place UpdateTable)"
# The template also declares a WarmThroughput BELOW the value AWS holds (issue
# #1768). Pre-fix that made this very deploy FAIL, so the tee'd log is both the
# evidence for the skip and the reason the deploy still succeeds.
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"

# The table must be the SAME table (no replacement): CreationDateTime unchanged.
CREATION_P2="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: table was REPLACED (CreationDateTime ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    table identity preserved (CreationDateTime unchanged) — no replacement"

# The GSI must exist and be ACTIVE.
GSI_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='${GSI_NAME}'].IndexStatus | [0]" --output text)"
if [ "${GSI_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: GSI ${GSI_NAME} expected ACTIVE, got '${GSI_STATUS}'" >&2
  exit 1
fi
echo "    GSI ${GSI_NAME} is ACTIVE"

# The table must route via the SDK provider (catch a silent-drop routing flip).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::DynamoDB::Table");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected DynamoDB table provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    table routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2a: the unrevertable WarmThroughput decrease (issue #1768) --------
# `set -o pipefail` already failed the run if the deploy itself errored, which
# IS the pre-fix behavior (the doomed UpdateTable is rejected with
# `decreasing WarmThroughput is not supported`). These two assertions pin that
# the deploy succeeded for the RIGHT reason — cdkd skipped the call and said so
# — rather than because AWS quietly accepted a lower value.
if ! grep -q 'decreasing WarmThroughput is not supported' "${DEPLOY_LOG}"; then
  echo "FAIL (issue #1768): the deploy did not report skipping the WarmThroughput decrease" >&2
  grep -i 'warmthroughput' "${DEPLOY_LOG}" >&2 || echo "  (no WarmThroughput line at all)" >&2
  rm -f "${DEPLOY_LOG}"
  exit 1
fi
WARM_P2="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'join(`/`, [to_string(Table.WarmThroughput.ReadUnitsPerSecond), to_string(Table.WarmThroughput.WriteUnitsPerSecond)])' \
  --output text)"
if [ "${WARM_P2}" != "${WARM_P1}" ]; then
  echo "FAIL (issue #1768): AWS WarmThroughput changed ${WARM_P1} -> ${WARM_P2}; nothing should have been sent" >&2
  rm -f "${DEPLOY_LOG}"
  exit 1
fi
rm -f "${DEPLOY_LOG}"
echo "    WarmThroughput decrease skipped with a warning; AWS still holds ${WARM_P2}"

# --- Phase 2d: the per-index WarmThroughput EMIT arm (issue #1768) -----------
# Phase 2a covers the SKIP. This covers the opposite half: a per-index
# WarmThroughput cdkd must actually put on the wire. `applyGsiUpdates` used to
# send only ProvisionedThroughput / OnDemandThroughput, so a template declaring
# a per-index WarmThroughput had it silently dropped — `cdkd drift` then
# reported the difference forever and `--revert` emitted no op at all while
# exiting 0. Nothing but a real deploy proves the value reaches AWS.
#
# The stack declares 12001/4000 on gsi1 (see the stack file for the cost note).
# 12001 is the discriminator: an index created with NO WarmThroughput reports
# exactly 12000/4000 (AWS's floor, measured us-east-1 2026-08-13 on a sibling
# index in the same table), so this assertion fails the moment the emit stops
# happening — it cannot pass on the default.
#
# Read WITHOUT waiting for the warm status to settle. Measured on the same run:
# the units report the REQUESTED value from the first poll (t=5s, while
# IndexStatus is still CREATING) whereas WarmThroughput.Status stays UPDATING
# for minutes — and cdkd deliberately does not gate its index wait on that
# status, so a "wait for ACTIVE warm status" assertion here would block on
# something the provider never waits for. The bounded poll below is for
# eventual consistency of the READ, not for the warm update to finish.
GSI_WARM_EXPECTED_READ=12001
GSI_WARM_EXPECTED_WRITE=4000
GSI_WARM_DEFAULT_READ=12000
gsi_warm_units() { # -> "<read>/<write>" for ${GSI_NAME}
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query "join(\`/\`, [to_string(Table.GlobalSecondaryIndexes[?IndexName=='${GSI_NAME}'].WarmThroughput.ReadUnitsPerSecond | [0]), to_string(Table.GlobalSecondaryIndexes[?IndexName=='${GSI_NAME}'].WarmThroughput.WriteUnitsPerSecond | [0])])" \
    --output text || return 1
}
GSI_WARM=""
for _ in $(seq 1 12); do
  # `if !` rather than a bare assignment: under `set -e` a failing command
  # substitution ABORTS the whole verify, which is the opposite of what the
  # retry loop is for — a throttled / transient describe must be retried, not
  # fatal. (`gsi_warm_units`'s own `|| return 1` propagates the failure here.)
  if ! GSI_WARM="$(gsi_warm_units)"; then
    GSI_WARM=""
  fi
  [ "${GSI_WARM}" = "${GSI_WARM_EXPECTED_READ}/${GSI_WARM_EXPECTED_WRITE}" ] && break
  sleep 5
done
if [ "${GSI_WARM}" != "${GSI_WARM_EXPECTED_READ}/${GSI_WARM_EXPECTED_WRITE}" ]; then
  echo "FAIL (issue #1768): GSI ${GSI_NAME} WarmThroughput is '${GSI_WARM}', expected ${GSI_WARM_EXPECTED_READ}/${GSI_WARM_EXPECTED_WRITE} — the per-index WarmThroughput the template declares never reached AWS" >&2
  case "${GSI_WARM}" in
    "${GSI_WARM_DEFAULT_READ}/"*)
      echo "  (it reports AWS's default floor, which is exactly what an index created with NO declared WarmThroughput looks like)" >&2
      ;;
  esac
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='${GSI_NAME}'].WarmThroughput" --output json >&2
  exit 1
fi
echo "    per-index WarmThroughput reached AWS: ${GSI_WARM} (not the ${GSI_WARM_DEFAULT_READ}/4000 default)"

# --- Per-index Contributor Insights helpers (issue #1782) --------------------
# `describe-contributor-insights --index-name` is the ONLY place AWS reports the
# per-index setting: `describe-table`'s index description has no counterpart.
insights_field() { # usage: insights_field <table> <index> <Field> -> value ("None" when absent)
  aws dynamodb describe-contributor-insights --table-name "$1" --index-name "$2" \
    --region "${REGION}" --query "$3" --output text || return 1
}
# The toggle is ASYNC (ENABLING / DISABLING for a while) and cdkd deliberately
# does not wait for it, so every status assertion POLLS — a single probe right
# after a deploy false-FAILs on the transient. Bounded at ~10 min. A failed
# probe (throttle, eventual consistency right after the write) is retried, not
# fatal: `if !` keeps `set -e` from aborting on the substitution.
wait_insights_status() { # usage: wait_insights_status <table> <index> <ENABLED|DISABLED> <label>
  local status=""
  for _ in $(seq 1 60); do
    if ! status="$(insights_field "$1" "$2" 'ContributorInsightsStatus')"; then
      status=""
    fi
    [ "${status}" = "$3" ] && break
    sleep 10
  done
  if [ "${status}" != "$3" ]; then
    echo "FAIL (issue #1782): $4 — Contributor Insights on index $2 of $1 is '${status}', expected $3" >&2
    aws dynamodb describe-contributor-insights --table-name "$1" --index-name "$2" \
      --region "${REGION}" --output json >&2 || true
    exit 1
  fi
  echo "    Contributor Insights on index $2: ${status} ($4)"
}

# --- Phase 2e: per-index Contributor Insights on an index the update ADDED ----
# The block is not a member of the SDK's `GlobalSecondaryIndex`, so it cannot
# ride the `Create` action that added gsi1: cdkd has to wait for the index to
# reach ACTIVE and then call `UpdateContributorInsights` with `IndexName`.
# Pre-fix nothing was sent at all and the deploy was green — this index reports
# DISABLED forever and the poll below times out.
echo "==> Phase 2e: per-index Contributor Insights reached the newly added ${GSI_NAME} (issue #1782)"
wait_insights_status "${TABLE_NAME}" "${GSI_NAME}" ENABLED "declared {Enabled: true} on an index added by this update"

# --- Phase 2b: no phantom drift on an in-use table with a GSI (issue #1767) ---
# `readCurrentState` used to forward the `DescribeTable` index descriptions
# VERBATIM, so `IndexStatus`, `Backfilling`, `ItemCount`, `IndexSizeBytes`,
# `IndexArn`, the on-demand `{0, 0}` `ProvisionedThroughput` placeholder and the
# AWS-computed per-index `WarmThroughput` all reached the drift comparison. They
# are members of an ARRAY the baseline carries, and arrays are compared
# positionally by `deepEqual`, so every one of them participated — the
# state-keys-only walk that filters an AWS-only TOP-LEVEL key never reaches
# them. Two failures came out of that, and this phase defends both.
#
# The items are written FIRST so the index holds real data and its AWS-managed
# members are genuinely populated rather than the all-zero shape a fresh table
# reports. Note the counters themselves are NOT the load-bearing signal here:
# DynamoDB refreshes `ItemCount` / `IndexSizeBytes` roughly every six hours, so
# a run cannot rely on them moving within its own lifetime. The two assertions
# below are the deterministic ones, and each FAILS against the pre-fix code:
#
#   1. the `observedProperties` entry cdkd wrote from a REAL `DescribeTable`
#      must carry only the CFn members. Pre-fix it carried all of the above,
#      which is the necessary condition for the traffic-driven drift: once the
#      moving members are not in the baseline, they cannot drift out of it.
#   2. with `observedProperties` stripped, the TEMPLATE `properties` baseline
#      must compare clean. That is failure 1 of the issue, and it is the arm
#      that BINDS: with the observed baseline present both comparison sides come
#      from the same `readCurrentState`, so they move together and a reverted fix
#      would still report "no drift" (the vacuous-pass shape
#      `apigatewayv2-update-removal` documents).
echo "==> Phase 2b: write items, then assert no phantom drift on the GSI table (issue #1767)"

ITEM_PAYLOAD="$(printf 'x%.0s' $(seq 1 512))"
for i in 1 2 3 4 5; do
  aws dynamodb put-item --table-name "${TABLE_NAME}" --region "${REGION}" \
    --item "{\"pk\":{\"S\":\"p${i}\"},\"gsipk\":{\"S\":\"g${i}\"},\"payload\":{\"S\":\"${ITEM_PAYLOAD}\"}}" \
    >/dev/null
done
echo "    wrote 5 items — the GSI now holds real entries"

aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_JSON}" --region "${REGION}" >/dev/null

TABLE_LID="$(jq -r '[.resources | to_entries[]
  | select(.value.resourceType == "AWS::DynamoDB::Table") | .key] | first // ""' "${STATE_JSON}")"
if [ -z "${TABLE_LID}" ]; then
  echo "FAIL: no AWS::DynamoDB::Table resource in the cdkd state record" >&2
  exit 1
fi

# Vacuity guard: without a deploy-time capture there is nothing to assert the
# shape of, and the strip below would be a no-op.
if [ "$(jq -r --arg l "${TABLE_LID}" '.resources[$l].observedProperties | type' "${STATE_JSON}")" != "object" ]; then
  echo "FAIL: ${TABLE_LID} has no observedProperties — the issue #1767 assertions would be vacuous" >&2
  exit 1
fi

# `keys` is sorted, so the expected value is alphabetical. Asserting the WHOLE
# key set rather than probing for named members is deliberate: the reverse map
# is an allow-list, and a deny-list-shaped assertion misses whatever member AWS
# adds next (`Backfilling` is already one the issue's own sample omitted).
OBSERVED_GSI_KEYS="$(jq -r --arg l "${TABLE_LID}" \
  '((.resources[$l].observedProperties.GlobalSecondaryIndexes // [])[0] // {}) | keys | join(",")' \
  "${STATE_JSON}")"
if [ -z "${OBSERVED_GSI_KEYS}" ]; then
  echo "FAIL: the observed baseline for ${TABLE_LID} captured no GlobalSecondaryIndexes entry — the issue #1767 assertion would be vacuous" >&2
  exit 1
fi
# `WarmThroughput` belongs in this set BECAUSE the template declares one for
# this index (the Phase 2d emit arm) — the reverse-map emits a throughput block
# the desired bag declares and drops the AWS-managed members either way, so this
# key set asserts BOTH halves at once: the declared block survived, the
# `IndexStatus` / `Backfilling` / `ItemCount` / `IndexSizeBytes` / `IndexArn` /
# on-demand `{0,0}` `ProvisionedThroughput` noise did not.
# `ContributorInsightsSpecification` joined it with issue #1782, for the same
# reason: gsi1 declares one, and the gated per-index read-back emits it.
EXPECTED_GSI_KEYS="ContributorInsightsSpecification,IndexName,KeySchema,Projection,WarmThroughput"
if [ "${OBSERVED_GSI_KEYS}" != "${EXPECTED_GSI_KEYS}" ]; then
  echo "FAIL (issues #1767 / #1782): the observed GSI baseline has the wrong member set — got '${OBSERVED_GSI_KEYS}', expected '${EXPECTED_GSI_KEYS}'" >&2
  jq --arg l "${TABLE_LID}" '.resources[$l].observedProperties.GlobalSecondaryIndexes' "${STATE_JSON}" >&2
  exit 1
fi
echo "    observed GSI baseline carries only the CFn members (${OBSERVED_GSI_KEYS})"

# `cdkd drift` exits non-zero when it DETECTS drift, so the exit status cannot
# be the assertion on its own — and a resource reported as "drift unknown"
# exits ZERO, which would read as clean. Parse the report instead and require
# the table to be in the `clean` bucket by name.
run_drift_json() { # $1 = label, $2 = stack (default ${STACK}) -> writes ${DRIFT_JSON}
  node "${LOCAL_DIST}" drift "${2:-${STACK}}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null || true
  if ! jq empty "${DRIFT_JSON}" >/dev/null 2>&1; then
    echo "FAIL: cdkd drift --json ($1) produced no parseable JSON report:" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
  # `jq empty` accepts an EMPTY file (no input satisfies it), so a crashed run
  # that printed nothing would pass the parse check and then satisfy every
  # "no drift on this path" assertion vacuously. Require a real stack report.
  # Compared as a string rather than via `jq -e`, which exits non-zero on a
  # `false` RESULT and would be indistinguishable from a jq failure.
  if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}")" != "yes" ]; then
    echo "FAIL: cdkd drift --json ($1) reported no stacks — the assertions below would be vacuous:" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
}
table_outcome_count() { # $1 = bucket (clean|drifted|notSupported)
  jq --arg b "$1" '[.[][$b][] | select(.type == "AWS::DynamoDB::Table")] | length' "${DRIFT_JSON}"
}

run_drift_json "observed baseline"
if [ "$(table_outcome_count notSupported)" != "0" ]; then
  echo "FAIL (issue #1767): the table was reported as drift UNKNOWN — a provider that stopped reading back reads as clean on the exit code alone" >&2
  exit 1
fi
if [ "$(table_outcome_count drifted)" != "0" ]; then
  echo "FAIL (issue #1767): cdkd drift reported drift on the in-use GSI table against its own deploy-time capture:" >&2
  jq '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table")]' "${DRIFT_JSON}" >&2
  exit 1
fi
if [ "$(table_outcome_count clean)" != "1" ]; then
  echo "FAIL: the table appears in no drift outcome bucket — the assertion checked nothing" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    observed baseline: table reported CLEAN"

# Now the binding half. Dropping the capture makes the comparison run against
# the TEMPLATE `properties` baseline — the real user condition after a
# reverse-replacement rollback (which strips observedProperties) or on a record
# written before observed-capture existed. Pre-fix the template's GSI entry
# (IndexName / KeySchema / Projection) could NEVER equal the readback.
# A plain `cdkd drift` is read-only (only --accept / --revert write state), so
# the stripped record stays stripped for this assertion.
jq --arg l "${TABLE_LID}" 'del(.resources[$l].observedProperties)' "${STATE_JSON}" > "${STATE_JSON}.stripped"
aws s3 cp "${STATE_JSON}.stripped" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null

run_drift_json "properties baseline"
INDEX_DRIFT_PATHS="$(jq -r '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table") | .changes[].path
  | select(startswith("GlobalSecondaryIndexes") or startswith("LocalSecondaryIndexes"))] | join(" ")' \
  "${DRIFT_JSON}")"
if [ -n "${INDEX_DRIFT_PATHS}" ]; then
  echo "FAIL (issue #1767): the TEMPLATE baseline still drifts on the index list (${INDEX_DRIFT_PATHS}) — the readback does not round-trip to the CFn shape:" >&2
  jq '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table")]' "${DRIFT_JSON}" >&2
  exit 1
fi
# Any OTHER template-baseline difference is out of this arm's scope (it defends
# the index lists), so it is reported rather than failed — silence would hide it.
OTHER_DRIFT_PATHS="$(jq -r '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table") | .changes[].path]
  | join(" ")' "${DRIFT_JSON}")"
if [ -n "${OTHER_DRIFT_PATHS}" ]; then
  echo "    note: template baseline differs on non-index paths (out of scope for issue #1767): ${OTHER_DRIFT_PATHS}"
fi
echo "    properties baseline: no GlobalSecondaryIndexes / LocalSecondaryIndexes drift"

rm -f "${STATE_JSON}" "${STATE_JSON}.stripped" "${DRIFT_JSON}"

# --- Phases I1-I5: per-index ContributorInsightsSpecification (issue #1782) ---
# CFn's `GlobalSecondaryIndex.ContributorInsightsSpecification` is not a member
# of the SDK's `GlobalSecondaryIndex`, so cdkd dropped it on the wire — a
# template asking for per-index Contributor Insights deployed GREEN with the
# feature OFF — and had no read-back for it, so such a template could never
# converge against a `properties` drift baseline. Both halves are asserted ON
# AWS here, on a dedicated stack whose two indexes are created WITH the table
# and never change shape (no phase pays an index build):
#
#   I1. create: giA declares {Enabled: true} -> ENABLED. giB declares nothing
#       and must stay off — the NEGATIVE CONTROL, without which "everything got
#       enabled" would pass.
#   I2. `cdkd drift` is CLEAN against the deploy-time capture, and the capture
#       carries the block on giA ONLY (the read-back gate).
#   I3. an out-of-band DISABLE of giA IS reported as drift on the index list,
#       `drift --revert` really re-enables it, and drift is clean again.
#   I4. with `observedProperties` stripped, the TEMPLATE baseline shows no
#       index-list drift — the arm that binds the read-back SHAPE (with the
#       capture present both sides come from the same read and move together).
#   I5. update: giA's block is REMOVED -> DISABLED (the removal arm); giB gains
#       {Enabled: true, Mode: THROTTLED_KEYS} -> ENABLED in that Mode, which
#       AWS's default (ACCESSED_AND_THROTTLED_KEYS) cannot produce. The table is
#       the SAME table and both indexes stay ACTIVE. Drift clean; destroy.
#
# Discrimination: with the write half reverted, I1 times out on giA (it reports
# DISABLED forever); with the read half reverted, I2's key-set assertion fails
# and I3 reports no drift.
insights_table_outcome_paths() { # -> the drifted change paths of the insights table
  jq -r '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table") | .changes[].path] | join(" ")' "${DRIFT_JSON}"
}
assert_insights_drift_clean() { # $1 = label
  run_drift_json "$1" "${INSIGHTS_STACK}"
  if [ "$(table_outcome_count notSupported)" != "0" ] || [ "$(table_outcome_count drifted)" != "0" ] \
    || [ "$(table_outcome_count clean)" != "1" ]; then
    echo "FAIL (issue #1782): expected the insights table CLEAN ($1); drifted paths: '$(insights_table_outcome_paths)'" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
  echo "    $1: insights table reported CLEAN"
}

echo "==> Phase I1: deploy the insights table (giA declares Contributor Insights, giB does not)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${INSIGHTS_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
INSIGHTS_CREATION_I1="$(aws dynamodb describe-table --table-name "${INSIGHTS_TABLE}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
wait_insights_status "${INSIGHTS_TABLE}" giA ENABLED "declared {Enabled: true} at table create"
# The negative control. Read AFTER giA settled, so "nothing was sent for giB" is
# not confused with "giB's toggle had not started yet". Anything that is not an
# enabled-or-enabling status passes: AWS is free to spell "never configured"
# as DISABLED or as an absent status.
GIB_STATUS_I1="$(insights_field "${INSIGHTS_TABLE}" giB 'ContributorInsightsStatus')"
case "${GIB_STATUS_I1}" in
  ENABLED | ENABLING)
    echo "FAIL (issue #1782): giB declares no ContributorInsightsSpecification but reports ${GIB_STATUS_I1}" >&2
    exit 1
    ;;
esac
echo "    Contributor Insights on index giB: ${GIB_STATUS_I1} (declares nothing — negative control)"

echo "==> Phase I2: no phantom drift, and the capture carries the block on giA only"
aws s3 cp "s3://${STATE_BUCKET}/${INSIGHTS_STATE_KEY}" "${STATE_JSON}" --region "${REGION}" >/dev/null
INSIGHTS_LID="$(jq -r '[.resources | to_entries[]
  | select(.value.resourceType == "AWS::DynamoDB::Table") | .key] | first // ""' "${STATE_JSON}")"
if [ -z "${INSIGHTS_LID}" ]; then
  echo "FAIL: no AWS::DynamoDB::Table resource in the insights stack's state record" >&2
  exit 1
fi
# "<IndexName>=<block as compact JSON, or null>" per index, sorted by name: AWS
# does not promise the list order, and the assertion is about WHICH entry
# carries the block, not where it sits.
OBSERVED_INSIGHTS="$(jq -r --arg l "${INSIGHTS_LID}" \
  '[(.resources[$l].observedProperties.GlobalSecondaryIndexes // [])[]
    | "\(.IndexName)=\(.ContributorInsightsSpecification | tojson)"] | sort | join(" ")' "${STATE_JSON}")"
if [ "${OBSERVED_INSIGHTS}" != 'giA={"Enabled":true} giB=null' ]; then
  echo "FAIL (issue #1782): the observed baseline's per-index blocks are '${OBSERVED_INSIGHTS}', expected 'giA={\"Enabled\":true} giB=null' (giA read back WITHOUT the undeclared Mode; giB not read at all)" >&2
  exit 1
fi
echo "    observed baseline: ${OBSERVED_INSIGHTS}"
assert_insights_drift_clean "observed baseline"

echo "==> Phase I3: an out-of-band DISABLE of giA is detected, and --revert undoes it"
aws dynamodb update-contributor-insights --table-name "${INSIGHTS_TABLE}" --index-name giA \
  --contributor-insights-action DISABLE --region "${REGION}" >/dev/null
wait_insights_status "${INSIGHTS_TABLE}" giA DISABLED "out-of-band DISABLE"
run_drift_json "after out-of-band DISABLE" "${INSIGHTS_STACK}"
INSIGHTS_DRIFT_PATHS="$(insights_table_outcome_paths)"
case " ${INSIGHTS_DRIFT_PATHS} " in
  *" GlobalSecondaryIndexes"*) ;;
  *)
    echo "FAIL (issue #1782): an out-of-band per-index Contributor Insights DISABLE was not reported as drift on GlobalSecondaryIndexes (drifted paths: '${INSIGHTS_DRIFT_PATHS}')" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
    ;;
esac
echo "    out-of-band DISABLE reported as drift on: ${INSIGHTS_DRIFT_PATHS}"
node "${LOCAL_DIST}" drift "${INSIGHTS_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --revert --yes
wait_insights_status "${INSIGHTS_TABLE}" giA ENABLED "re-enabled by drift --revert"
assert_insights_drift_clean "after --revert"

echo "==> Phase I4: the TEMPLATE baseline shows no index-list drift"
aws s3 cp "s3://${STATE_BUCKET}/${INSIGHTS_STATE_KEY}" "${STATE_JSON}" --region "${REGION}" >/dev/null
jq --arg l "${INSIGHTS_LID}" 'del(.resources[$l].observedProperties)' "${STATE_JSON}" > "${STATE_JSON}.stripped"
aws s3 cp "${STATE_JSON}.stripped" "s3://${STATE_BUCKET}/${INSIGHTS_STATE_KEY}" --region "${REGION}" >/dev/null
run_drift_json "insights properties baseline" "${INSIGHTS_STACK}"
# Floors first: "no index path among the drifted entries" is also what a table
# reported as drift UNKNOWN, or missing from the report, looks like.
if [ "$(table_outcome_count notSupported)" != "0" ] \
  || [ "$(( $(table_outcome_count clean) + $(table_outcome_count drifted) ))" != "1" ]; then
  echo "FAIL (issue #1782): the insights table was not COMPARED against the template baseline — the assertion below would be vacuous:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
INSIGHTS_DRIFT_PATHS="$(insights_table_outcome_paths)"
case " ${INSIGHTS_DRIFT_PATHS} " in
  *" GlobalSecondaryIndexes"* | *" LocalSecondaryIndexes"*)
    echo "FAIL (issue #1782): the TEMPLATE baseline drifts on the index list (${INSIGHTS_DRIFT_PATHS}) — the per-index read-back does not round-trip to the declared block" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
    ;;
esac
if [ -n "${INSIGHTS_DRIFT_PATHS}" ]; then
  echo "    note: template baseline differs on non-index paths (out of scope for issue #1782): ${INSIGHTS_DRIFT_PATHS}"
fi
echo "    properties baseline: no index-list drift"

echo "==> Phase I5: update — remove giA's block, enable giB with Mode THROTTLED_KEYS"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${INSIGHTS_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_insights_status "${INSIGHTS_TABLE}" giA DISABLED "block REMOVED from the template"
wait_insights_status "${INSIGHTS_TABLE}" giB ENABLED "block ADDED to an existing index"
GIB_MODE_I5="$(insights_field "${INSIGHTS_TABLE}" giB 'ContributorInsightsMode')"
if [ "${GIB_MODE_I5}" != "THROTTLED_KEYS" ]; then
  echo "FAIL (issue #1782): giB's ContributorInsightsMode is '${GIB_MODE_I5}', expected THROTTLED_KEYS — the declared Mode never reached AWS" >&2
  exit 1
fi
echo "    giB Mode: ${GIB_MODE_I5}"
# Neither toggle may cost a replacement or an index rebuild.
INSIGHTS_CREATION_I5="$(aws dynamodb describe-table --table-name "${INSIGHTS_TABLE}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
if [ "${INSIGHTS_CREATION_I1}" != "${INSIGHTS_CREATION_I5}" ]; then
  echo "FAIL (issue #1782): the insights table was REPLACED (CreationDateTime ${INSIGHTS_CREATION_I1} -> ${INSIGHTS_CREATION_I5})" >&2
  exit 1
fi
INSIGHTS_INDEX_STATES="$(aws dynamodb describe-table --table-name "${INSIGHTS_TABLE}" --region "${REGION}" \
  --query "join(' ', sort(Table.GlobalSecondaryIndexes[].join('=', [IndexName, IndexStatus]) || \`[]\`))" --output text)"
if [ "${INSIGHTS_INDEX_STATES}" != "giA=ACTIVE giB=ACTIVE" ]; then
  echo "FAIL (issue #1782): expected both indexes ACTIVE and untouched, got '${INSIGHTS_INDEX_STATES}'" >&2
  exit 1
fi
assert_insights_drift_clean "after the update"

echo "==> Phase I5: destroy the insights stack"
node "${LOCAL_DIST}" destroy "${INSIGHTS_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
# DeleteTable is ASYNC — accept GONE or DELETING, exactly as Phase 3 does below.
if gone_probe aws dynamodb describe-table --table-name "${INSIGHTS_TABLE}" --region "${REGION}"; then
  insights_table_status="GONE"
elif ! insights_table_status="$(aws dynamodb describe-table --table-name "${INSIGHTS_TABLE}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>&1)"; then
  # TOCTOU: the table can vanish between gone_probe and this requery.
  if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${insights_table_status}"; then
    insights_table_status="GONE"
  else
    echo "FAIL: describe-table requery undetermined: ${insights_table_status}" >&2
    exit 1
  fi
fi
if [ "${insights_table_status}" != "GONE" ] && [ "${insights_table_status}" != "DELETING" ]; then
  echo "FAIL: table ${INSIGHTS_TABLE} still exists (status ${insights_table_status}) after destroy" >&2
  exit 1
fi
echo "    insights table deleted (status: ${insights_table_status})"
assert_gone "state file ${INSIGHTS_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INSIGHTS_STATE_KEY}"
echo "    insights stack state removed"
rm -f "${STATE_JSON}" "${STATE_JSON}.stripped" "${DRIFT_JSON}"

# --- Phase 3a: issue #1931 — arm the index-busy DeleteTable refusal ------
# `AWS::DynamoDB::Table`'s `delete()` had no retry for AWS's transient refusal
#
#   Attempt to change a resource which is still in use: Cannot delete table
#   while indexes are being created, updated, or deleted.
#
# so a table whose GSI was mid-update when destroy reached it failed the whole
# destroy with a `PartialFailureError`, state preserved, for a condition that
# clears itself in seconds. (Fixed for the sibling `AWS::DynamoDB::GlobalTable`
# type by issue #1830 / PR #1930; this is the arm for the `Table` type.)
#
# WHY THIS SHAPE, and why it is not the sibling fixture's log-keyed driver.
# That driver fires INSIDE `delete()` because the GlobalTable provider polls the
# index state just before `DeleteTable` (the issue #1521 gate) and would
# otherwise wait the race out — the arm would pass with the fix REVERTED. This
# provider has no such index-settle gate: the only thing that can precede its
# `DeleteTable` is the remove-protection flip (an `UpdateTable` plus a <=60s
# wait for ACTIVE), which this destroy does not request — so an index that is
# transitioning when the destroy STARTS is still transitioning when the call
# lands. Arming before the destroy is therefore both sufficient and honest here.
#
# WHY A CREATE rather than a capacity change: measured on the sibling fixture
# 2026-08-18, a provisioned-capacity `Update` on an empty index settles in well
# under a second and the index was ACTIVE again before `DeleteTable` arrived, so
# AWS never refused and the arm passed with the fix reverted twice in a row. An
# index CREATE holds the index in `CREATING` through the backfill, which is
# literally the condition the refusal names.
#
# No `ProvisionedThroughput` on the Create: this table is PAY_PER_REQUEST, and
# AWS rejects a provisioned throughput on an on-demand table's index. The
# sibling fixture's driver carries one because ITS table is PROVISIONED.
#
# The index is never cleaned up on purpose — the table it hangs off is deleted
# seconds later by the destroy under test (and `cleanup` retries that delete if
# this run dies first).
#
# WHY THE ARM IS RE-TRIED ONCE, and how a MISSED WINDOW is told apart from a
# BROKEN RETRY. This is the load-bearing half: the arm is a race, so it can be
# missed on a run where cdkd behaved perfectly, and reporting that as FAILED
# marks a correct binary broken. The two outcomes are distinguished by the
# destroy's EXIT STATUS, not by anything softer:
#
#   - RETRY GENUINELY BROKEN (the fix reverted): AWS refuses, the provider turns
#     the refusal into a `ProvisioningError`, `cdkd destroy` exits non-zero with
#     `PartialFailureError`, and `set -o pipefail` + `set -e` abort this script
#     INSIDE the loop, at the destroy itself. The re-arm branch below is never
#     reached, so it can never absorb this case.
#   - RACE WINDOW MISSED: the destroy exits 0 AND AWS's refusal text is absent
#     from the log. AWS accepting a `DeleteTable` is itself the observation that
#     `raceIdx` had reached ACTIVE — that acceptance is exactly the rule the
#     refusal enforces — and it is a stronger reading than a post-hoc
#     describe-table, which by then races the table's own deletion.
#
# So the re-arm fires only on the second. It waits the table out, re-deploys the
# Phase 1 baseline, rewrites the items and races the index CREATE once more; if
# the second arm misses too, the run FAILS loudly. The assertion below is NOT
# weakened — it still demands AWS's own refusal text, so a run with the retry
# absent can never reach a PASS.
ARM_MAX=2
ARM_HIT=""
RACE_INDEX_STATUS=""
for ARM in $(seq 1 ${ARM_MAX}); do
  echo "==> Phase 3a (Issue #1931), arm ${ARM}/${ARM_MAX}: create a GSI out of band so DeleteTable is refused"
  if ! RACE_ERR="$(aws dynamodb update-table \
    --table-name "${TABLE_NAME}" \
    --attribute-definitions AttributeName=raceKey,AttributeType=S \
    --global-secondary-index-updates \
    '[{"Create":{"IndexName":"raceIdx","KeySchema":[{"AttributeName":"raceKey","KeyType":"HASH"}],"Projection":{"ProjectionType":"KEYS_ONLY"}}}]' \
    --region "${REGION}" 2>&1 >/dev/null)"; then
    echo "FAIL: issue #1931 — AWS refused the out-of-band UpdateTable, so no index ever entered a transitional state and the retry path cannot be reached. AWS said: ${RACE_ERR}" >&2
    exit 1
  fi

  # The index state as last observed BEFORE the destroy. Recorded rather than
  # asserted on: an already-ACTIVE `raceIdx` here means this arm cannot be
  # refused, which is the same missed-window outcome the loop already handles —
  # one re-arm mechanism, not two. It is carried into the final failure message
  # so a run that exhausts both arms still names the cause.
  RACE_INDEX_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.GlobalSecondaryIndexes[?IndexName==`raceIdx`].IndexStatus | [0]' --output text)"
  echo "    raceIdx is ${RACE_INDEX_STATUS} — the DeleteTable below has to be refused"

  # --- Phase 3: destroy --------------------------------------------------
  echo "==> Phase 3: destroy (arm ${ARM}/${ARM_MAX})"
  # `--verbose` and the tee are load-bearing for the 3b assertions: AWS's refusal
  # and cdkd's retry are announced through `withRetry`'s debug line. `set -o
  # pipefail` is already on, so a destroy that FAILS (which is exactly what the
  # pre-fix binary does here) still aborts this script — see the discrimination
  # note above, which depends on that abort.
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose 2>&1 | tee "${DESTROY_LOG}"

  if grep -qF "Cannot delete table while indexes are being" "${DESTROY_LOG}"; then
    ARM_HIT="yes"
    break
  fi

  # Reaching here means the destroy exited 0 with no refusal: the window was
  # missed (never a broken retry — that path aborted above).
  if [ "${ARM}" -lt "${ARM_MAX}" ]; then
    echo "    note: AWS accepted the DeleteTable, so raceIdx had reached ACTIVE before it landed (last status observed before the destroy: ${RACE_INDEX_STATUS}); re-arming"
    # The delete is ASYNC, so the re-deploy has to wait the table out or its
    # CreateTable races a still-DELETING table of the same name.
    aws dynamodb wait table-not-exists --table-name "${TABLE_NAME}" --region "${REGION}"
    env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
    # Same 5 items Phase 2b wrote, so the second arm is no weaker than the
    # first. (They are not what holds the index in CREATING — AWS's own index
    # build latency is — but a re-arm that silently changed the conditions
    # would make the two attempts incomparable.)
    for i in 1 2 3 4 5; do
      aws dynamodb put-item --table-name "${TABLE_NAME}" --region "${REGION}" \
        --item "{\"pk\":{\"S\":\"p${i}\"},\"gsipk\":{\"S\":\"g${i}\"},\"payload\":{\"S\":\"${ITEM_PAYLOAD}\"}}" \
        >/dev/null
    done
  fi
done

echo "==> Phase 3b (Issue #1931): assert the destroy ABSORBED an index-busy DeleteTable refusal"
# Discrimination, spelled out because it is the whole point of the arm:
#   - with the fix REVERTED the refusal is a hard `ProvisioningError`, `cdkd
#     destroy` exits non-zero with `PartialFailureError`, and `set -o pipefail`
#     aborts this script at Phase 3 — the run cannot reach here;
#   - with the fix present the destroy exits 0 AND every string below is in the
#     log. Requiring AWS's own refusal text is what stops the arm passing
#     vacuously on a run where the index settled before the delete landed.
if [ -z "${ARM_HIT}" ]; then
  echo "FAIL: issue #1931 — ${ARM_MAX} armed destroys ran and AWS never refused a DeleteTable, so the retry path was not exercised (last raceIdx status observed before a destroy: ${RACE_INDEX_STATUS}). AWS is settling index creates faster than it did when this arm was written; the driver needs a slower-settling condition." >&2
  exit 1
fi
if ! grep -qF "Retrying GsiTable" "${DESTROY_LOG}"; then
  echo "FAIL: issue #1931 — AWS refused the DeleteTable but cdkd logged no retry for GsiTable; the delete did not go through withRetry" >&2
  exit 1
fi
if ! grep -qF "AWS refused DeleteTable on ${TABLE_NAME}" "${DESTROY_LOG}"; then
  echo "FAIL: issue #1931 — cdkd retried but printed no warning naming the cause; withRetry announces only at debug level, so a default-verbosity run would have shown nothing while the delete spent minutes re-polling" >&2
  exit 1
fi
if grep -qF "Failed to delete DynamoDB table GsiTable" "${DESTROY_LOG}"; then
  echo "FAIL: issue #1931 — the retry did not recover: destroy reported a failure for GsiTable" >&2
  exit 1
fi
rm -f "${DESTROY_LOG}"
echo "    AWS refused the DeleteTable and cdkd retried it to success"

# DeleteTable is ASYNC: cdkd's destroy returns once DeleteTable is accepted, at
# which point describe-table still reports the table in DELETING state for a
# while. Accept GONE (ResourceNotFound) OR DELETING as success; only a table
# still in a live state (ACTIVE / UPDATING) means the delete never happened.
# (No polling/sleep — DeleteTable transitions the table to DELETING
# synchronously, so a single check right after destroy is sufficient.)
if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
  status="GONE"
elif ! status="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>&1)"; then
  # TOCTOU: the table can vanish between gone_probe and this requery.
  printf '%s' "${status}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && status="GONE" \
    || { echo "FAIL: describe-table requery undetermined: ${status}" >&2; exit 1; }
fi
if [ "${status}" != "GONE" ] && [ "${status}" != "DELETING" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists (status ${status}) after destroy" >&2
  exit 1
fi
echo "    table deleted (status: ${status})"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — DynamoDB GSI add is an in-place UPDATE (no replacement), an in-use table with a GSI reports no phantom drift (issue #1767), a per-index ContributorInsightsSpecification is applied, read back, reverted and removed (issue #1782), and destroy absorbs the index-busy DeleteTable refusal (issue #1931); all phases passed"
