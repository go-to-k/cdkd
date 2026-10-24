#!/usr/bin/env bash
# verify.sh — `cdkd refactor` moving resources between stacks (go-to-k/cdkd#5202).
#
# Generation "a": the table (explicit name, holds a data item) and the queue
# (cdkd-generated name) live in CdkdRefactorMoveSource. Generation "b"
# (CDKD_TEST_UPDATE=true) declares them in CdkdRefactorMoveDest instead, and the
# source's SSM parameter imports them across stacks. Without a refactor the
# source's deploy deletes both and the destination's creates new ones. With
# `cdkd refactor --all` both records move, and `cdkd deploy --all` keeps them.
#
# The run uses a NON-default --state-prefix.
#
# Phases:
#   1. Deploy generation "a" (both stacks); record physical ids; write an item.
#   2. Under generation "b":
#      a. `cdkd refactor --all --dry-run` plans both moves, writes nothing.
#      b. The records a refactor KILLED mid-move leaves are written by hand
#         (go-to-k/cdkd#5212): the table after the first write, the queue
#         after the second.
#      c. `cdkd deploy` / `cdkd destroy` of the source refuse and `cdkd diff`
#         exits 3; the table and its item are untouched.
#      d. `cdkd refactor --all --yes` finishes both moves.
#      e. The destination holds them under the same physical ids; the source
#         holds neither and records no unfinished move.
#      f. `cdkd deploy --all` keeps every physical id, the queue's creation
#         time, the data item and the parameter's Version.
#      g. `cdkd diff --all --fail` reports no change.
#   3. Destroy both stacks; everything and both state records are gone.
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

SRC="CdkdRefactorMoveSource"
DST="CdkdRefactorMoveDest"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="cdkd-integ-refactor-move"
SRC_KEY="${PREFIX}/${SRC}/${REGION}/state.json"
DST_KEY="${PREFIX}/${DST}/${REGION}/state.json"
MARKER_KEY="${PREFIX}/_refactor/pending.json"
PFX="cdkd-refactor-move"
TABLE="${PFX}-data"
PARAM_NAME="/cdkd-integ/${PFX}/wiring"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cdkd() { node "${LOCAL_DIST}" "$@"; }

STATE_FLAGS=(--state-bucket "${STATE_BUCKET:-}" --state-prefix "${PREFIX}" --region "${REGION}")

# A state object's ETag (quotes included), or "absent".
state_etag() { # usage: state_etag <key>
  local out
  if out="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "$1" \
      --query ETag --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    printf 'absent'
    return 0
  fi
  echo "FAIL: head-object undetermined: ${out}" >&2
  return 1
}

# The physical id of the ONE state resource whose logical id starts with $1.
physical_id_of() { # usage: physical_id_of <logical-id-prefix> <resources-listing>
  local matches
  matches="$(printf '%s\n' "$2" | awk -v p="$1" 'index($1, p) == 1 { print $3 }')"
  if [ "$(printf '%s\n' "${matches}" | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one state resource starting with $1, got: ${matches:-<none>}" >&2
    return 1
  fi
  printf '%s' "${matches}"
}

# The logical id of the ONE state resource whose logical id starts with $1.
logical_id_of() { # usage: logical_id_of <logical-id-prefix> <resources-listing>
  local matches
  matches="$(printf '%s\n' "$2" | awk -v p="$1" 'index($1, p) == 1 { print $1 }')"
  if [ "$(printf '%s\n' "${matches}" | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one logical id starting with $1, got: ${matches:-<none>}" >&2
    return 1
  fi
  printf '%s' "${matches}"
}

assert_table_deleted() { # usage: assert_table_deleted <table-name> <context>
  local table="$1" ctx="$2" status
  if gone_probe aws dynamodb describe-table --table-name "${table}" --region "${REGION}"; then
    status="GONE"
  elif ! status="$(aws dynamodb describe-table --table-name "${table}" --region "${REGION}" \
      --query 'Table.TableStatus' --output text 2>&1)"; then
    # TOCTOU: the table can vanish between gone_probe and this requery.
    printf '%s' "${status}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && status="GONE" \
      || { echo "FAIL: describe-table requery undetermined (${ctx}): ${status}" >&2; exit 1; }
  fi
  if [ "${status}" != "GONE" ] && [ "${status}" != "DELETING" ]; then
    echo "FAIL: table ${table} still exists (status ${status}) ${ctx}" >&2
    exit 1
  fi
  echo "    table ${table} deleted (status: ${status})"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    for s in "${SRC}" "${DST}"; do
      node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" \
        --state-prefix "${PREFIX}" --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1
  for s in "${SRC}" "${DST}"; do
    for url in $(aws sqs list-queues --queue-name-prefix "${s}-" --region "${REGION}" \
        --query 'QueueUrls[]' --output text 2>/dev/null); do
      [ "${url}" != "None" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
    done
  done
  for arn in $(aws sns list-topics --region "${REGION}" --query 'Topics[].TopicArn' --output text 2>/dev/null); do
    case "${arn}" in
      *":${DST}-"?*) aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    for s in "${SRC}" "${DST}"; do
      aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/${s}/${REGION}/state.json" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/${s}/${REGION}/lock.json" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/${s}/${REGION}/create-tokens.json" >/dev/null 2>&1 || true
    done
    aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/_refactor/pending.json" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy generation "a" ------------------------------------------
echo "==> Phase 1: deploy generation a"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy --all \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${PREFIX}" --region "${REGION}" --yes

RES_SRC_A="$(cdkd state resources "${SRC}" "${STATE_FLAGS[@]}")"
TABLE_ID="$(logical_id_of Table "${RES_SRC_A}")"
QUEUE_ID="$(logical_id_of Queue "${RES_SRC_A}")"
TABLE_PID="$(physical_id_of Table "${RES_SRC_A}")"
QUEUE_PID="$(physical_id_of Queue "${RES_SRC_A}")"
[ "${TABLE_PID}" = "${TABLE}" ] || { echo "FAIL: table physical id ${TABLE_PID} != ${TABLE}" >&2; exit 1; }
[ -n "${QUEUE_PID}" ] || { echo "FAIL: QUEUE_PID is empty" >&2; exit 1; }
echo "    source holds table ${TABLE_PID} (${TABLE_ID}) and queue ${QUEUE_PID} (${QUEUE_ID})"

aws dynamodb put-item --table-name "${TABLE}" --region "${REGION}" \
  --item '{"pk":{"S":"keep-me"},"v":{"S":"survives the move"}}'
PARAM_VERSION_A="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Version' --output text)"
QUEUE_CREATED_A="$(aws sqs get-queue-attributes --queue-url "${QUEUE_PID}" --region "${REGION}" \
  --attribute-names CreatedTimestamp --query 'Attributes.CreatedTimestamp' --output text)"

# --- Phase 2: generation "b" -------------------------------------------------
export CDKD_TEST_UPDATE=true

echo "==> Phase 2a0: diff --all names the stack each moved resource reappears in"
set +e
OUT_DIFF="$(cdkd diff --all "${STATE_FLAGS[@]}" 2>&1)"
set -e
printf '%s\n' "${OUT_DIFF}"
for id in "${TABLE_ID}" "${QUEUE_ID}"; do
  # Sentinel: the removal row must be there before its hint is judged.
  row="$(printf '%s\n' "${OUT_DIFF}" | grep -F "[-] ${id} (" || true)"
  [ -n "${row}" ] || { echo "FAIL: diff shows no removal row for ${id}" >&2; exit 1; }
  printf '%s' "${row}" | grep -qF "(moved to ${DST}." \
    || { echo "FAIL: the removal of ${id} does not name ${DST} (go-to-k/cdkd#5203)" >&2; exit 1; }
  printf '%s' "${row}" | grep -qF "run 'cdkd refactor' to keep it)" \
    || { echo "FAIL: the hint for ${id} does not name cdkd refactor" >&2; exit 1; }
done
echo "    both removals name ${DST}"

echo "==> Phase 2a: refactor --dry-run plans both moves and writes nothing"
SRC_ETAG="$(state_etag "${SRC_KEY}")"
DST_ETAG="$(state_etag "${DST_KEY}")"
OUT_2A="$(cdkd refactor --all "${STATE_FLAGS[@]}" --dry-run 2>&1)"
printf '%s\n' "${OUT_2A}"
for pair in "${SRC}.${TABLE_ID} -> ${DST}." "${SRC}.${QUEUE_ID} -> ${DST}."; do
  printf '%s\n' "${OUT_2A}" | grep -qF "  ${pair}" || { echo "FAIL: plan lacks the move ${pair}" >&2; exit 1; }
done
if printf '%s\n' "${OUT_2A}" | grep -qE '^  (Not moved|Not refactored|Refused|Ambiguous|Warning:)'; then
  echo "FAIL: the move plan carries a warning or refusal" >&2
  exit 1
fi
printf '%s' "${OUT_2A}" | grep -q 'state was NOT written' \
  || { echo "FAIL: dry run did not say it wrote nothing" >&2; exit 1; }
[ "$(state_etag "${SRC_KEY}")" = "${SRC_ETAG}" ] || { echo "FAIL: source state changed during a dry run" >&2; exit 1; }
[ "$(state_etag "${DST_KEY}")" = "${DST_ETAG}" ] || { echo "FAIL: destination state changed during a dry run" >&2; exit 1; }

# --- Phase 2b: an interrupted move (go-to-k/cdkd#5212) ------------------------
# Write, by hand, the records a refactor killed mid-move leaves. Both moves
# are listed in the shared marker (the FIRST write of a move):
#   - the table: interrupted right after that first write (the source neither
#     marks nor drops it; the destination knows nothing);
#   - the queue: interrupted after the destination write (the source marks
#     and still holds it; the destination holds it too).
echo "==> Phase 2b: simulate a refactor killed mid-move"
DST_TABLE_ID="$(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ids = Object.keys(t.Resources).filter((id) => t.Resources[id].Type === "AWS::DynamoDB::Table");
  if (ids.length !== 1) { console.error(`expected one table, got ${ids}`); process.exit(1); }
  process.stdout.write(ids[0]);
' "$(cdkd synth "${DST}" --region "${REGION}" >/dev/null && echo "cdk.out/${DST}.template.json")")"
DST_QUEUE_ID="$(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ids = Object.keys(t.Resources).filter((id) => t.Resources[id].Type === "AWS::SQS::Queue");
  if (ids.length !== 1) { console.error(`expected one queue, got ${ids}`); process.exit(1); }
  process.stdout.write(ids[0]);
' "cdk.out/${DST}.template.json")"
[ -n "${DST_TABLE_ID}" ] && [ -n "${DST_QUEUE_ID}" ] || { echo "FAIL: destination ids not found" >&2; exit 1; }
WORK="$(mktemp -d)"
aws s3 cp "s3://${STATE_BUCKET}/${SRC_KEY}" "${WORK}/src.json" --only-show-errors
aws s3 cp "s3://${STATE_BUCKET}/${DST_KEY}" "${WORK}/dst.json" --only-show-errors
node -e '
  const fs = require("fs");
  const [srcPath, dstPath, dst, region, tableId, queueId, dstTable, dstQueue] = process.argv.slice(1);
  const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  const dstState = JSON.parse(fs.readFileSync(dstPath, "utf8"));
  src.pendingMovesOut = [
    { from: queueId, toStack: dst, toRegion: region, to: dstQueue, startedAt: Date.now() },
  ];
  dstState.resources[dstQueue] = src.resources[queueId];
  fs.writeFileSync(srcPath, JSON.stringify(src));
  fs.writeFileSync(dstPath, JSON.stringify(dstState));
  const move = (from, to) => ({ fromStack: src.stackName, fromRegion: region, from, toStack: dst, toRegion: region, to, startedAt: Date.now() });
  fs.writeFileSync(
    srcPath.replace(/src\.json$/, "marker.json"),
    JSON.stringify({ moves: [move(tableId, dstTable), move(queueId, dstQueue)] })
  );
' "${WORK}/src.json" "${WORK}/dst.json" "${DST}" "${REGION}" "${TABLE_ID}" "${QUEUE_ID}" "${DST_TABLE_ID}" "${DST_QUEUE_ID}"
aws s3 cp "${WORK}/src.json" "s3://${STATE_BUCKET}/${SRC_KEY}" --only-show-errors --content-type application/json
aws s3 cp "${WORK}/dst.json" "s3://${STATE_BUCKET}/${DST_KEY}" --only-show-errors --content-type application/json
aws s3 cp "${WORK}/marker.json" "s3://${STATE_BUCKET}/${MARKER_KEY}" --only-show-errors --content-type application/json
rm -rf "${WORK}"

echo "==> Phase 2c: deploy, destroy and diff of the source refuse while the move is unfinished"
set +e
OUT_DEPLOY="$(cdkd deploy "${SRC}" "${STATE_FLAGS[@]}" --yes 2>&1)"; rc_deploy=$?
OUT_DESTROY="$(cdkd destroy "${SRC}" "${STATE_FLAGS[@]}" --force 2>&1)"; rc_destroy=$?
OUT_DEPLOY_DST="$(cdkd deploy "${DST}" "${STATE_FLAGS[@]}" --yes 2>&1)"; rc_deploy_dst=$?
cdkd diff "${SRC}" "${STATE_FLAGS[@]}" >/dev/null 2>&1; rc_diff=$?
cdkd diff "${DST}" "${STATE_FLAGS[@]}" >/dev/null 2>&1; rc_diff_dst=$?
set -e
[ "${rc_deploy}" -ne 0 ] || { echo "FAIL: deploy of the source ran over an unfinished move" >&2; exit 1; }
[ "${rc_destroy}" -ne 0 ] || { echo "FAIL: destroy of the source ran over an unfinished move" >&2; exit 1; }
[ "${rc_diff}" -eq 3 ] || { echo "FAIL: diff of the source exited ${rc_diff}, not 3" >&2; exit 1; }
[ "${rc_deploy_dst}" -ne 0 ] || { echo "FAIL: deploy of the destination ran over an unfinished move" >&2; exit 1; }
[ "${rc_diff_dst}" -eq 3 ] || { echo "FAIL: diff of the destination exited ${rc_diff_dst}, not 3" >&2; exit 1; }
# The destination must refuse BEFORE creating anything: no create was tried.
for out in "${OUT_DEPLOY}" "${OUT_DEPLOY_DST}"; do
  if printf '%s' "${out}" | grep -qiE 'Failed to create|ResourceInUseException|already exists'; then
    echo "FAIL: a deploy tried to create a moved resource: ${out}" >&2
    exit 1
  fi
done
for out in "${OUT_DEPLOY}" "${OUT_DESTROY}" "${OUT_DEPLOY_DST}"; do
  printf '%s' "${out}" | grep -q "did not finish" \
    || { echo "FAIL: a refusal does not name the unfinished move: ${out}" >&2; exit 1; }
done
# Nothing was deleted: the table still answers, with its item.
ITEM_2C="$(aws dynamodb get-item --table-name "${TABLE}" --region "${REGION}" \
  --key '{"pk":{"S":"keep-me"}}' --query 'Item.v.S' --output text)"
[ "${ITEM_2C}" = "survives the move" ] || { echo "FAIL: the refused commands touched the table" >&2; exit 1; }
echo "    deploy and destroy refused, diff exited 3, the table and its item are intact"

echo "==> Phase 2d: refactor finishes both interrupted moves"
OUT_2D="$(cdkd refactor --all "${STATE_FLAGS[@]}" --yes 2>&1)"
printf '%s\n' "${OUT_2D}"
for pair in "${SRC}.${TABLE_ID} -> ${DST}.${DST_TABLE_ID}" "${SRC}.${QUEUE_ID} -> ${DST}.${DST_QUEUE_ID}"; do
  printf '%s' "${OUT_2D}" | grep -qF "Finished an interrupted move: ${pair}" \
    || { echo "FAIL: refactor did not finish ${pair}" >&2; exit 1; }
done
if node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.exit(s.pendingMovesOut === undefined ? 1 : 0);
' < <(aws s3 cp "s3://${STATE_BUCKET}/${SRC_KEY}" - --only-show-errors); then
  echo "FAIL: the source still records an unfinished move" >&2
  exit 1
fi
assert_gone "the refactor marker ${MARKER_KEY} is still listed after the moves finished" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"

echo "==> Phase 2e: the destination holds both records under the same physical ids"
RES_SRC_B="$(cdkd state resources "${SRC}" "${STATE_FLAGS[@]}")"
RES_DST_B="$(cdkd state resources "${DST}" "${STATE_FLAGS[@]}")"
[ "$(physical_id_of Table "${RES_DST_B}")" = "${TABLE_PID}" ] || { echo "FAIL: table did not move" >&2; exit 1; }
[ "$(physical_id_of Queue "${RES_DST_B}")" = "${QUEUE_PID}" ] || { echo "FAIL: queue did not move" >&2; exit 1; }
for id in "${TABLE_ID}" "${QUEUE_ID}"; do
  if printf '%s\n' "${RES_SRC_B}" | awk '{ print $1 }' | grep -qxF "${id}"; then
    echo "FAIL: the source still holds ${id}" >&2
    exit 1
  fi
done
logical_id_of Wiring "${RES_SRC_B}" >/dev/null

echo "==> Phase 2f: deploy generation b keeps every resource"
cdkd deploy --all "${STATE_FLAGS[@]}" --yes
RES_DST_D="$(cdkd state resources "${DST}" "${STATE_FLAGS[@]}")"
[ "$(physical_id_of Queue "${RES_DST_D}")" = "${QUEUE_PID}" ] || { echo "FAIL: deploy replaced the queue" >&2; exit 1; }
[ "$(physical_id_of Table "${RES_DST_D}")" = "${TABLE_PID}" ] || { echo "FAIL: deploy replaced the table" >&2; exit 1; }
QUEUE_CREATED_D="$(aws sqs get-queue-attributes --queue-url "${QUEUE_PID}" --region "${REGION}" \
  --attribute-names CreatedTimestamp --query 'Attributes.CreatedTimestamp' --output text)"
[ "${QUEUE_CREATED_D}" = "${QUEUE_CREATED_A}" ] || { echo "FAIL: queue was re-created" >&2; exit 1; }
ITEM="$(aws dynamodb get-item --table-name "${TABLE}" --region "${REGION}" \
  --key '{"pk":{"S":"keep-me"}}' --query 'Item.v.S' --output text)"
[ "${ITEM}" = "survives the move" ] || { echo "FAIL: table data lost (got ${ITEM})" >&2; exit 1; }
PARAM_VERSION_D="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Version' --output text)"
[ "${PARAM_VERSION_D}" = "${PARAM_VERSION_A}" ] \
  || { echo "FAIL: SSM parameter was updated (Version ${PARAM_VERSION_A} -> ${PARAM_VERSION_D})" >&2; exit 1; }
echo "    queue, table, data item and parameter Version unchanged"

echo "==> Phase 2g: diff reports no change"
cdkd diff --all "${STATE_FLAGS[@]}" --fail

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
cdkd destroy --all "${STATE_FLAGS[@]}" --force
assert_table_deleted "${TABLE}" "after destroy"
assert_gone "queue ${QUEUE_PID} still exists after destroy" \
  aws sqs get-queue-attributes --queue-url "${QUEUE_PID}" --region "${REGION}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${SRC_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${SRC_KEY}"
assert_gone "state file ${DST_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${DST_KEY}"
echo "    all resources + both state records removed"

echo "[verify] PASS — cdkd refactor: table and queue moved between stacks in state only, deploy kept both, destroy clean"
