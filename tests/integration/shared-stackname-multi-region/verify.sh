#!/usr/bin/env bash
# verify.sh - cdkd shared-stackname-multi-region integ (issue #5176).
#
# One CDK Stage per region (RegionA, RegionB), each holding the SAME two
# stackNames: a producer (CdkdSharedName5176) and a consumer
# (CdkdSharedConsumer5176) that reads the producer through a CDK cross-stack
# reference. The AWS CDK CLI deploys all four stacks; before #5176 cdkd kept
# one stack per physical name, so `cdkd deploy '**'` deployed only RegionA's.
#
# Both regions' producers publish the SAME export name
# (`CdkdSharedName5176:ExportsOutputRef...`), and the run's one exports index
# keeps the later deploy's entry. Each consumer must still read its OWN
# region's producer.
#
# Phases:
#   1. `deploy '**'`: all four stacks, each in its own region; each consumer
#      holds `v1:<its own region's producer parameter name>`.
#   2. `list '**'`: all four display paths.
#   3. `deploy '**'` again: a no-op for all four stacks.
#   4. The index arm: read which region's producer the exports index holds,
#      then UPDATE only the OTHER region's consumer. Its import must bind its
#      own region's producer (`v2:/cdkd-5176/producer-<own region>`), never the
#      index entry's.
#   5. `destroy 'RegionB/Consumer'`: only us-west-2's consumer goes; RegionA's
#      consumer, which shares its name, and RegionB's producer stay.
#   6. `destroy '**'`: everything else goes; every name is probed in BOTH
#      regions, every state file is gone, and the exports index holds no
#      entry of the producer.
#
# Required env vars:
#   STATE_BUCKET  - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION    - region A, defaults to us-east-1
#   SECOND_REGION - region B, defaults to us-west-2 (flipped if it equals A)

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

REGION_A="${AWS_REGION:-us-east-1}"
REGION_B="${SECOND_REGION:-us-west-2}"
if [ "${REGION_A}" = "${REGION_B}" ]; then
  # The whole point is the region difference, so pick one that differs from A.
  if [ "${REGION_A}" = "us-east-1" ]; then REGION_B="us-west-2"; else REGION_B="us-east-1"; fi
fi
export AWS_REGION="${REGION_A}"
export CDKD_IT_5176_REGION_A="${REGION_A}"
export CDKD_IT_5176_REGION_B="${REGION_B}"

PRODUCER="CdkdSharedName5176"
CONSUMER="CdkdSharedConsumer5176"
CONSUMER_PARAM="/cdkd-5176/consumer"
EXPORT_NAME_PREFIX="${PRODUCER}:ExportsOutputRef"
INDEX_KEY="cdkd/_index/${REGION_A}/exports.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
OUT_LOG="${TMPDIR:-/tmp}/cdkd-5176-verify.$$.log"
CLEANED_UP=0

producer_param() { echo "/cdkd-5176/producer-$1"; }
stage_of() { if [ "$1" = "${REGION_A}" ]; then echo RegionA; else echo RegionB; fi; }
other_region() { if [ "$1" = "${REGION_A}" ]; then echo "${REGION_B}"; else echo "${REGION_A}"; fi; }

# Every name this fixture creates, deleted BY EXACT NAME in <region>. Names are
# literals built from the two regions, never a listing, so no sweep can widen.
reap_region() { # usage: reap_region <region>
  (
    set +eu
    local r="$1"
    aws ssm delete-parameters --region "${r}" \
      --names "${CONSUMER_PARAM}" "$(producer_param "${REGION_A}")" "$(producer_param "${REGION_B}")" \
      >/dev/null 2>&1
    true
  )
}

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping leftover state + AWS resources in ${REGION_A} and ${REGION_B}"
  set +eu
  rm -f "${OUT_LOG}"
  reap_region "${REGION_A}"
  reap_region "${REGION_B}"
  for r in "${REGION_A}" "${REGION_B}"; do
    for s in "${CONSUMER}" "${PRODUCER}"; do
      if [ -f "${LOCAL_DIST}" ]; then
        node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" \
          --region "${r}" --yes >/dev/null 2>&1
      fi
      if [ -n "${STATE_BUCKET:-}" ]; then
        aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${r}/state.json" >/dev/null 2>&1
        aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${r}/lock.json" >/dev/null 2>&1
        # Literal stack names and regions, so this prefix can never widen.
        aws s3 rm --recursive "s3://${STATE_BUCKET}/cdkd/${s}/${r}/deployments/" >/dev/null 2>&1
      fi
    done
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

echo "[verify] region-a=${REGION_A} region-b=${REGION_B}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
CLEANED_UP=0

# The parameter's value in <region>, strictly (a failed read fails the run).
param_value() { # usage: param_value <region> <name>
  aws ssm get-parameter --region "$1" --name "$2" --query Parameter.Value --output text
}

# Every resource of <region>'s Stage is in <region>, its producer is absent from
# the other region, and its consumer holds <prefix>:<its own producer name>.
assert_region() { # usage: assert_region <region> <v1|v2>
  local r="$1" prefix="$2" other got
  other="$(other_region "${r}")"
  got="$(param_value "${r}" "$(producer_param "${r}")")" || {
    echo "FAIL: could not read $(producer_param "${r}") in ${r}" >&2
    exit 1
  }
  if [ "${got}" != "producer" ]; then
    echo "FAIL: $(producer_param "${r}") in ${r} is '${got}', expected 'producer'" >&2
    exit 1
  fi
  assert_gone "producer parameter $(producer_param "${r}") ALSO exists in ${other} (deployed in the wrong region)" \
    aws ssm get-parameter --region "${other}" --name "$(producer_param "${r}")"
  got="$(param_value "${r}" "${CONSUMER_PARAM}")" || {
    echo "FAIL: could not read ${CONSUMER_PARAM} in ${r}" >&2
    exit 1
  }
  if [ "${got}" != "${prefix}:$(producer_param "${r}")" ]; then
    echo "FAIL: ${CONSUMER_PARAM} in ${r} is '${got}', expected '${prefix}:$(producer_param "${r}")' — the consumer imported another region's export" >&2
    exit 1
  fi
  for s in "${PRODUCER}" "${CONSUMER}"; do
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${s}/${r}/state.json" >/dev/null
  done
  echo "    $(stage_of "${r}"): producer and consumer in ${r}, consumer reads '${got}'"
}

# --- Phase 1: deploy every stack ---------------------------------------------
echo "==> Phase 1: deploy '**' (both regions' stacks under the shared names)"
env -u CDKD_TEST_UPDATE CDKD_NO_LIVE=1 node "${LOCAL_DIST}" deploy '**' \
  --state-bucket "${STATE_BUCKET}" --yes 2>&1 | tee "${OUT_LOG}"
assert_region "${REGION_A}" v1
assert_region "${REGION_B}" v1

# --- Phase 2: list ---------------------------------------------------------------
echo "==> Phase 2: list '**' shows all four stacks"
LIST_OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" list '**')"
printf '%s\n' "${LIST_OUT}"
for line in "RegionA/Producer (${PRODUCER})" "RegionA/Consumer (${CONSUMER})" \
  "RegionB/Producer (${PRODUCER})" "RegionB/Consumer (${CONSUMER})"; do
  if ! grep -qxF "${line}" <<<"${LIST_OUT}"; then
    echo "FAIL: 'cdkd list **' does not print '${line}'" >&2
    exit 1
  fi
done
if [ "$(printf '%s\n' "${LIST_OUT}" | grep -c .)" != "4" ]; then
  echo "FAIL: 'cdkd list **' printed $(printf '%s\n' "${LIST_OUT}" | grep -c .) line(s), expected 4" >&2
  exit 1
fi

# --- Phase 3: redeploy is a no-op --------------------------------------------
echo "==> Phase 3: deploy '**' again is a no-op for all four stacks"
REDEPLOY_OUT="$(env -u CDKD_TEST_UPDATE CDKD_NO_LIVE=1 node "${LOCAL_DIST}" deploy '**' \
  --state-bucket "${STATE_BUCKET}" --yes 2>&1)"
printf '%s\n' "${REDEPLOY_OUT}"
NOOPS="$(grep -c 'No changes detected. Stack is up to date.' <<<"${REDEPLOY_OUT}" || true)"
# Sentinel: one `Deploying stack:` line per stack, so a reworded no-op line is
# told apart from a stack that did not run.
STARTED="$(grep -c 'Deploying stack:' <<<"${REDEPLOY_OUT}" || true)"
if [ "${STARTED}" != "4" ]; then
  echo "FAIL: the redeploy started ${STARTED} stack(s), expected 4" >&2
  exit 1
fi
if [ "${NOOPS}" != "4" ]; then
  echo "FAIL: the redeploy reported 'No changes detected' for ${NOOPS} of 4 stacks" >&2
  exit 1
fi

# --- Phase 4: the exports-index arm ------------------------------------------
echo "==> Phase 4: update the consumer whose region the exports index does NOT hold"
INDEX_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" -)"
HELD_REGION="$(printf '%s' "${INDEX_JSON}" | EXPORT_NAME_PREFIX="${EXPORT_NAME_PREFIX}" PRODUCER="${PRODUCER}" node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const exportsMap = JSON.parse(s).exports ?? {};
    const hits = Object.entries(exportsMap).filter(
      ([name, e]) => name.startsWith(process.env.EXPORT_NAME_PREFIX) && e.producerStack === process.env.PRODUCER
    );
    if (hits.length !== 1) { console.error(`expected 1 index entry, found ${hits.length}`); process.exit(1); }
    console.log(hits[0][1].producerRegion);
  });')"
case "${HELD_REGION}" in
  "${REGION_A}" | "${REGION_B}") ;;
  *)
    echo "FAIL: the exports index entry names region '${HELD_REGION}', neither ${REGION_A} nor ${REGION_B}" >&2
    exit 1
    ;;
esac
TARGET_REGION="$(other_region "${HELD_REGION}")"
echo "    index holds ${HELD_REGION}'s producer; updating $(stage_of "${TARGET_REGION}")/Consumer in ${TARGET_REGION}"
CDKD_TEST_UPDATE=true CDKD_NO_LIVE=1 node "${LOCAL_DIST}" deploy "$(stage_of "${TARGET_REGION}")/Consumer" \
  --exclusively --state-bucket "${STATE_BUCKET}" --yes 2>&1 | tee "${OUT_LOG}"
GOT="$(param_value "${TARGET_REGION}" "${CONSUMER_PARAM}")"
if [ "${GOT}" != "v2:$(producer_param "${TARGET_REGION}")" ]; then
  echo "FAIL: ${CONSUMER_PARAM} in ${TARGET_REGION} is '${GOT}', expected 'v2:$(producer_param "${TARGET_REGION}")' — the import bound the exports index's ${HELD_REGION} entry" >&2
  exit 1
fi
GOT="$(param_value "${HELD_REGION}" "${CONSUMER_PARAM}")"
if [ "${GOT}" != "v1:$(producer_param "${HELD_REGION}")" ]; then
  echo "FAIL: ${CONSUMER_PARAM} in ${HELD_REGION} changed to '${GOT}' although only ${TARGET_REGION}'s consumer was deployed" >&2
  exit 1
fi
echo "    ${TARGET_REGION} consumer reads its own region's producer"

# --- Phase 5: destroy one region's consumer by its CDK path --------------------
echo "==> Phase 5: destroy 'RegionB/Consumer' only"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy 'RegionB/Consumer' \
  --state-bucket "${STATE_BUCKET}" --force
assert_gone "consumer parameter still exists in ${REGION_B} after destroying RegionB/Consumer" \
  aws ssm get-parameter --region "${REGION_B}" --name "${CONSUMER_PARAM}"
assert_gone "state file for ${CONSUMER} in ${REGION_B} still exists after destroying RegionB/Consumer" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${CONSUMER}/${REGION_B}/state.json"
# The same-named stack in the other region, and RegionB's own producer, are
# untouched: a destroy that took either would be a wrong-target deletion.
param_value "${REGION_A}" "${CONSUMER_PARAM}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${CONSUMER}/${REGION_A}/state.json" >/dev/null
param_value "${REGION_B}" "$(producer_param "${REGION_B}")" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${PRODUCER}/${REGION_B}/state.json" >/dev/null
echo "    RegionB/Consumer gone; RegionA/Consumer (same name, ${REGION_A}) and RegionB/Producer intact"

# --- Phase 6: destroy everything --------------------------------------------
echo "==> Phase 6: destroy '**'"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy '**' \
  --state-bucket "${STATE_BUCKET}" --force --purge-events

for r in "${REGION_A}" "${REGION_B}"; do
  for name in "${CONSUMER_PARAM}" "$(producer_param "${REGION_A}")" "$(producer_param "${REGION_B}")"; do
    assert_gone "parameter ${name} still exists in ${r} after destroy" \
      aws ssm get-parameter --region "${r}" --name "${name}"
  done
  for s in "${PRODUCER}" "${CONSUMER}"; do
    assert_gone "state file for ${s} in ${r} still exists after destroy" \
      aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${s}/${r}/state.json"
  done
done

# The exports index drops both producers' entries with their stacks. The index
# file may itself be gone once empty, which is the same answer.
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INDEX_KEY}"; then
  LEFT="$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - | PRODUCER="${PRODUCER}" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const left = Object.values(JSON.parse(s).exports ?? {}).filter(
        (e) => e.producerStack === process.env.PRODUCER
      );
      console.log(left.map((e) => e.producerRegion).join(" "));
    });')"
  if [ -n "${LEFT}" ]; then
    echo "FAIL: the exports index still holds ${PRODUCER} entries for: ${LEFT}" >&2
    exit 1
  fi
fi

trap - EXIT INT TERM
rm -f "${OUT_LOG}"
echo "[verify] PASS — shared-stackname-multi-region: both regions' stacks under one stackName deployed, listed, re-deployed as a no-op, imported their own region's export, and were destroyed region by region"
