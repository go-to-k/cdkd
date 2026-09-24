#!/usr/bin/env bash
# verify.sh - cdkd cross-region-concurrent-stacks integ (issue #1981).
#
# Two stacks, one per region, deployed by ONE `cdkd deploy --all` at the
# DEFAULT `--stack-concurrency` (4), so both are in flight at once.
#
# Before #1981 the deploy re-pointed the process-global AWS client singleton
# (`setAwsClients`) and `process.env.AWS_REGION` per stack, restoring both in
# each stack's `finally`. The stack that started LAST won both for every stack,
# so a provider call made after an `await` in the OTHER stack ran against the
# wrong region. Each stack now runs inside its own AsyncLocalStorage scope
# (src/utils/stack-aws-scope.ts).
#
# Phases:
#   0. Seed SOURCE_PARAM in both regions with DIFFERENT values (source-<region>).
#   1. Concurrent deploy (A declared first). Assert the two runs' recorded
#      windows (`cdkd events`) overlap, every resource of each stack exists in
#      ITS region and NONE in the other, the topic carries its own stack's
#      policy statement, the `{{resolve:ssm:...}}` echo resolved its OWN
#      region's value, and each state file sits under its own region's key.
#   2. Concurrent UPDATE with the declaration order FLIPPED (CDKD_IT_XRC_ORDER=ba),
#      so the stack that lost the race in phase 1 is now the one started first.
#      Assert the updated policy statement and queue attribute landed in each
#      stack's own region.
#   3. Destroy, then assert every resource is gone from BOTH regions and both
#      state files are removed.
#
# Every name carries the stack's letter and NOT its region, so a resource the
# race created in the wrong region is found by the negative probes AND swept by
# `cleanup`, which deletes by exact name in both regions.
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

# The echo parameter is a literal `{{resolve:ssm:...}}`, so this fixture sweeps
# its state versions like every other dynamic-reference fixture
# (testing.md, "A secret-seeding fixture sweeps S3 OBJECT VERSIONS").
. ../s3-versions.sh

REGION_A="${AWS_REGION:-us-east-1}"
REGION_B="${SECOND_REGION:-us-west-2}"
if [ "${REGION_A}" = "${REGION_B}" ]; then
  # The whole point is the region difference, so pick one that differs from A.
  if [ "${REGION_A}" = "us-east-1" ]; then REGION_B="us-west-2"; else REGION_B="us-east-1"; fi
fi
export AWS_REGION="${REGION_A}"
export CDKD_IT_XRC_REGION_A="${REGION_A}"
export CDKD_IT_XRC_REGION_B="${REGION_B}"
# Seeded in BOTH regions with a region-specific value; each stack's echo
# parameter resolves it, so the echoed value names the region that answered.
SOURCE_PARAM="/cdkd-xrc/source"
export CDKD_IT_XRC_SOURCE_PARAM="${SOURCE_PARAM}"

STACK_A="CdkdCrossRegionConcurrentAExample"
STACK_B="CdkdCrossRegionConcurrentBExample"
PREFIX_A="$(s3_stack_prefix "${STACK_A}" "${REGION_A}")"
PREFIX_B="$(s3_stack_prefix "${STACK_B}" "${REGION_B}")"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-1981-deploy.$$.log"
CLEANED_UP=0

# The region the stack with this letter belongs in, and the one it must NOT be in.
home_region() { if [ "$1" = "a" ]; then echo "${REGION_A}"; else echo "${REGION_B}"; fi; }
other_region() { if [ "$1" = "a" ]; then echo "${REGION_B}"; else echo "${REGION_A}"; fi; }

# Delete every resource of stack <letter> BY EXACT NAME in <region>. Names are
# literals built from the letter, never a listing, so no sweep can widen.
reap_letter() { # usage: reap_letter <a|b> <region>
  (
    set +eu
    local l="$1" r="$2" url
    case "${l}" in
      a | b) ;;
      *)
        echo "WARN: teardown sweep refused — '${l}' is not one of this fixture's stack letters" >&2
        exit 0
        ;;
    esac
    aws sns delete-topic --region "${r}" \
      --topic-arn "arn:aws:sns:${r}:${ACCOUNT_ID}:cdkd-xrc-${l}-topic" >/dev/null 2>&1
    url="$(aws sqs get-queue-url --region "${r}" --queue-name "cdkd-xrc-${l}-queue" \
      --query QueueUrl --output text 2>/dev/null)"
    [ -n "${url}" ] && aws sqs delete-queue --region "${r}" --queue-url "${url}" >/dev/null 2>&1
    aws ssm delete-parameters --region "${r}" \
      --names "/cdkd-xrc/${l}/p1" "/cdkd-xrc/${l}/p2" "/cdkd-xrc/${l}/p3" \
      "/cdkd-xrc/${l}/echo" >/dev/null 2>&1
    aws ecr delete-repository --region "${r}" --force \
      --repository-name "cdkd-xrc-${l}-repo" >/dev/null 2>&1
    aws logs delete-log-group --region "${r}" --log-group-name "/cdkd-xrc/${l}" >/dev/null 2>&1
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
  rm -f "${DEPLOY_LOG}"
  if [ -n "${ACCOUNT_ID:-}" ]; then
    # BOTH letters in BOTH regions: a wrong-region resource is exactly what the
    # pre-fix race leaves behind.
    for l in a b; do
      reap_letter "${l}" "${REGION_A}"
      reap_letter "${l}" "${REGION_B}"
    done
  fi
  aws ssm delete-parameter --region "${REGION_A}" --name "${SOURCE_PARAM}" >/dev/null 2>&1
  aws ssm delete-parameter --region "${REGION_B}" --name "${SOURCE_PARAM}" >/dev/null 2>&1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK_A}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION_A}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK_B}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION_B}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK_A}/${REGION_A}/state.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK_A}/${REGION_A}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK_B}/${REGION_B}/state.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK_B}/${REGION_B}/lock.json" >/dev/null 2>&1
    # The per-run deployment events the overlap check reads. Literal stack
    # names, so this prefix can never widen.
    aws s3 rm --recursive "s3://${STATE_BUCKET}/cdkd/${STACK_A}/${REGION_A}/deployments/" >/dev/null 2>&1
    aws s3 rm --recursive "s3://${STATE_BUCKET}/cdkd/${STACK_B}/${REGION_B}/deployments/" >/dev/null 2>&1
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX_A:-}" noncurrent || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX_B:-}" noncurrent || true
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

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "[verify] region-a=${REGION_A} region-b=${REGION_B}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
CLEANED_UP=0

# Assert every resource of stack <letter> is in its home region and absent from
# the other. <phase> is `created` or `updated`: what the policy Sid, the queue's
# visibility timeout and the parameter values must say.
assert_placement() { # usage: assert_placement <a|b> <created|updated>
  local l="$1" phase="$2" home other sid expected_vt got
  home="$(home_region "${l}")"
  other="$(other_region "${l}")"
  sid="CdkdXrc$(printf '%s' "${l}" | tr '[:lower:]' '[:upper:]')$([ "${phase}" = updated ] && echo Updated || echo Created)"
  expected_vt="$([ "${phase}" = updated ] && echo 45 || echo 30)"

  # SNS: the topic, and the policy the CALL-TIME client wrote onto it.
  got="$(aws sns get-topic-attributes --region "${home}" \
    --topic-arn "arn:aws:sns:${home}:${ACCOUNT_ID}:cdkd-xrc-${l}-topic" \
    --query Attributes.Policy --output text)" || return 1
  if ! printf '%s' "${got}" | grep -F -q "\"${sid}\""; then
    echo "FAIL: topic cdkd-xrc-${l}-topic in ${home} does not carry policy statement ${sid}" >&2
    exit 1
  fi
  assert_gone "topic cdkd-xrc-${l}-topic ALSO exists in ${other} (created in the wrong region)" \
    aws sns get-topic-attributes --region "${other}" \
    --topic-arn "arn:aws:sns:${other}:${ACCOUNT_ID}:cdkd-xrc-${l}-topic"

  # SQS.
  got="$(aws sqs get-queue-attributes --region "${home}" \
    --queue-url "$(aws sqs get-queue-url --region "${home}" --queue-name "cdkd-xrc-${l}-queue" --query QueueUrl --output text)" \
    --attribute-names VisibilityTimeout --query Attributes.VisibilityTimeout --output text)" || return 1
  if [ "${got}" != "${expected_vt}" ]; then
    echo "FAIL: queue cdkd-xrc-${l}-queue in ${home} has VisibilityTimeout=${got}, expected ${expected_vt}" >&2
    exit 1
  fi
  assert_gone "queue cdkd-xrc-${l}-queue ALSO exists in ${other}" \
    aws sqs get-queue-url --region "${other}" --queue-name "cdkd-xrc-${l}-queue"

  # SSM: the value names the region the TEMPLATE was synthesized for; it must
  # also be the region it is stored in.
  for n in 1 2 3; do
    got="$(aws ssm get-parameter --region "${home}" --name "/cdkd-xrc/${l}/p${n}" \
      --query Parameter.Value --output text)" || return 1
    if [ "${got}" != "${l}-${home}-${phase}" ]; then
      echo "FAIL: /cdkd-xrc/${l}/p${n} in ${home} is '${got}', expected '${l}-${home}-${phase}'" >&2
      exit 1
    fi
    assert_gone "parameter /cdkd-xrc/${l}/p${n} ALSO exists in ${other}" \
      aws ssm get-parameter --region "${other}" --name "/cdkd-xrc/${l}/p${n}"
  done

  # The dynamic reference: resolved against the stack's OWN region's copy of
  # SOURCE_PARAM (issue #1957's default-concurrency criterion).
  got="$(aws ssm get-parameter --region "${home}" --name "/cdkd-xrc/${l}/echo" \
    --query Parameter.Value --output text)" || return 1
  if [ "${got}" != "source-${home}" ]; then
    echo "FAIL: /cdkd-xrc/${l}/echo in ${home} resolved '${got}', expected 'source-${home}'" >&2
    exit 1
  fi
  assert_gone "parameter /cdkd-xrc/${l}/echo ALSO exists in ${other}" \
    aws ssm get-parameter --region "${other}" --name "/cdkd-xrc/${l}/echo"

  # ECR: the provider whose captured region moved from the env to the scope.
  aws ecr describe-repositories --region "${home}" --repository-names "cdkd-xrc-${l}-repo" >/dev/null
  assert_gone "repository cdkd-xrc-${l}-repo ALSO exists in ${other}" \
    aws ecr describe-repositories --region "${other}" --repository-names "cdkd-xrc-${l}-repo"

  # Logs: the log group (SDK) and its metric filter (Cloud Control). A listing,
  # so compare the exact-name projection rather than probing for an error.
  got="$(aws logs describe-metric-filters --region "${home}" --log-group-name "/cdkd-xrc/${l}" \
    --query "metricFilters[?filterName=='cdkd-xrc-${l}-filter'].filterName" --output text)" || return 1
  if [ "${got}" != "cdkd-xrc-${l}-filter" ]; then
    echo "FAIL: metric filter cdkd-xrc-${l}-filter not found on /cdkd-xrc/${l} in ${home} (got '${got}')" >&2
    exit 1
  fi
  got="$(aws logs describe-log-groups --region "${other}" --log-group-name-prefix "/cdkd-xrc/${l}" \
    --query "logGroups[?logGroupName=='/cdkd-xrc/${l}'].logGroupName" --output text)" || return 1
  if [ -n "${got}" ] && [ "${got}" != "None" ]; then
    echo "FAIL: log group /cdkd-xrc/${l} ALSO exists in ${other}" >&2
    exit 1
  fi

  echo "    stack ${l}: every resource in ${home}, none in ${other} (${phase})"
}

# The deploy must really have run the two stacks CONCURRENTLY, or phases 1-2
# prove nothing about the race. The console cannot show it: with more than one
# stack, deploy.ts buffers each stack's output and prints it as one block when
# that stack ends. So read each stack's newest run window from cdkd's own
# deployment-events index and require the two windows to intersect.
run_window() { # usage: run_window <stack> <region>  ->  "<startedAt> <finishedAt>"
  local json
  json="$(node "${LOCAL_DIST}" events "$1" --stack-region "$2" \
    --state-bucket "${STATE_BUCKET}" --json)" || return 1
  printf '%s' "${json}" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const run = JSON.parse(s).runs[0];
      if (!run || run.command !== "deploy") { console.error("no deploy run recorded"); process.exit(1); }
      console.log(`${run.startedAt} ${run.finishedAt}`);
    });' || return 1
}
assert_overlapped() {
  local wa wb sa fa sb fb
  wa="$(run_window "${STACK_A}" "${REGION_A}")" || return 1
  wb="$(run_window "${STACK_B}" "${REGION_B}")" || return 1
  read -r sa fa <<<"${wa}"
  read -r sb fb <<<"${wb}"
  # ISO-8601 UTC timestamps of one fixed format compare correctly as strings.
  if [[ ! "${sa}" < "${fb}" || ! "${sb}" < "${fa}" ]]; then
    echo "FAIL: the two stacks' deploy runs did not overlap (A ${sa}..${fa}, B ${sb}..${fb}) — the race was never exercised" >&2
    exit 1
  fi
  echo "    runs overlapped: A ${sa}..${fa}, B ${sb}..${fb}"
}

# --- Phase 0: seed the dynamic-reference source in both regions ------------
echo "==> Phase 0: seed ${SOURCE_PARAM} in ${REGION_A} and ${REGION_B}"
aws ssm put-parameter --region "${REGION_A}" --name "${SOURCE_PARAM}" --type String \
  --value "source-${REGION_A}" --overwrite >/dev/null
aws ssm put-parameter --region "${REGION_B}" --name "${SOURCE_PARAM}" --type String \
  --value "source-${REGION_B}" --overwrite >/dev/null

# --- Phase 1: concurrent deploy -------------------------------------------
echo "==> Phase 1: deploy both stacks concurrently (default --stack-concurrency)"
env -u CDKD_TEST_UPDATE -u CDKD_IT_XRC_ORDER CDKD_NO_LIVE=1 node "${LOCAL_DIST}" deploy --all \
  --state-bucket "${STATE_BUCKET}" --yes 2>&1 | tee "${DEPLOY_LOG}"
assert_overlapped
assert_placement a created
assert_placement b created

# State lives under each stack's OWN region key.
aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_A}/${REGION_A}/state.json" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_B}/${REGION_B}/state.json" >/dev/null

# --- Phase 2: concurrent UPDATE, declaration order flipped ------------------
echo "==> Phase 2: update both stacks concurrently, B declared first"
CDKD_TEST_UPDATE=true CDKD_IT_XRC_ORDER=ba CDKD_NO_LIVE=1 node "${LOCAL_DIST}" deploy --all \
  --state-bucket "${STATE_BUCKET}" --yes 2>&1 | tee "${DEPLOY_LOG}"
assert_overlapped
assert_placement a updated
assert_placement b updated

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy both stacks"
env -u CDKD_TEST_UPDATE -u CDKD_IT_XRC_ORDER node "${LOCAL_DIST}" destroy --all \
  --state-bucket "${STATE_BUCKET}" --force --purge-events

for l in a b; do
  for r in "${REGION_A}" "${REGION_B}"; do
    assert_gone "topic cdkd-xrc-${l}-topic still exists in ${r} after destroy" \
      aws sns get-topic-attributes --region "${r}" \
      --topic-arn "arn:aws:sns:${r}:${ACCOUNT_ID}:cdkd-xrc-${l}-topic"
    assert_gone "queue cdkd-xrc-${l}-queue still exists in ${r} after destroy" \
      aws sqs get-queue-url --region "${r}" --queue-name "cdkd-xrc-${l}-queue"
    for n in p1 p2 p3 echo; do
      assert_gone "parameter /cdkd-xrc/${l}/${n} still exists in ${r} after destroy" \
        aws ssm get-parameter --region "${r}" --name "/cdkd-xrc/${l}/${n}"
    done
    assert_gone "repository cdkd-xrc-${l}-repo still exists in ${r} after destroy" \
      aws ecr describe-repositories --region "${r}" --repository-names "cdkd-xrc-${l}-repo"
    got="$(aws logs describe-log-groups --region "${r}" --log-group-name-prefix "/cdkd-xrc/${l}" \
      --query "logGroups[?logGroupName=='/cdkd-xrc/${l}'].logGroupName" --output text)"
    if [ -n "${got}" ] && [ "${got}" != "None" ]; then
      echo "FAIL: log group /cdkd-xrc/${l} still exists in ${r} after destroy" >&2
      exit 1
    fi
  done
done
assert_gone "state file for ${STACK_A} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_A}/${REGION_A}/state.json"
assert_gone "state file for ${STACK_B} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_B}/${REGION_B}/state.json"

aws ssm delete-parameter --region "${REGION_A}" --name "${SOURCE_PARAM}" >/dev/null
aws ssm delete-parameter --region "${REGION_B}" --name "${SOURCE_PARAM}" >/dev/null

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX_A}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX_B}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX_A}" "cross-region-concurrent-stacks ${STACK_A} state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX_B}" "cross-region-concurrent-stacks ${STACK_B} state teardown"
echo "[verify] PASS — cross-region-concurrent-stacks: two regions deployed and updated concurrently, each stack stayed in its own region"
