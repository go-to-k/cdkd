#!/usr/bin/env bash
# Deploy / redeploy / destroy timing of two cdkd builds side by side, for
# go-to-k/cdkd#4705's cross-prefix check (and reusable for any later change:
# the two builds are env-selected).
#
#   OLD: OLD_REF (a git ref of this repository, default: the merge base of
#        origin/main and HEAD), built in a scratch dir; or OLD_CDKD_VERSION (an
#        npm release) when set.
#   NEW: NEW_REF built the same way when set; otherwise this tree's dist/.
#
# Arms (every run uses a FRESH stack name and its own state prefix, so each
# timed deploy is a real first deploy, as docs/benchmarks.md requires; runs
# alternate OLD/NEW, then NEW/OLD, ...):
#   1. single stack, N runs per build: first deploy, NO_CHANGE redeploy, destroy;
#   2. scaling: `deploy --all` / `destroy --all` of PERF_SCALE_STACKS stacks,
#      PERF_SCALE_RUNS runs per build;
#   3. prefix count: NEW's first deploy with and without PERF_SEED_PREFIXES
#      dummy top-level prefixes (`cdkd-perf-<run>-<i>/x`) in the state bucket,
#      PERF_PREFIX_RUNS runs each (the scan HEADs once per top-level prefix);
#   4. name-adopting mix: one stack of 20 resources whose generated names NEW
#      looks up before creating them (4 queues, 4 topics, 4 log groups, 3
#      EventBridge rules, 2 alarms, 2 target groups, 1 ECS cluster): first
#      deploy, NO_CHANGE redeploy (no lookup), destroy; PERF_ADOPT_RUNS runs
#      per build (default 5). NEW also runs, untimed, one verbose NO_CHANGE
#      redeploy that must print no lookup and one verbose first deploy of its
#      own stack that must (the positive control);
#   5. CloudWatch-heavy: one stack of PERF_ALARMS alarms (default 200),
#      PERF_LOG_GROUPS log groups (default 50), 3 queues and 3 topics: first
#      deploy and destroy; PERF_CW_RUNS runs per build (default 3).
# PERF_ARMS selects the arms (default "1 2 3 4 5"; e.g. PERF_ARMS="4 5").
# Diagnostics: PERF_KEEP_LOGS=1 keeps every cdkd command's full output, one
# numbered file per command, under PERF_LOG_DIR (default a fresh directory
# under TMPDIR, printed at the start and the end, never removed by the
# cleanup). PERF_VERBOSE=1 adds --verbose to every cdkd command, OLD and NEW
# alike, so each line carries an ISO timestamp with milliseconds; the timings
# then include the extra logging on both sides. Arm 5 always runs --verbose,
# counts each command's throttled-call lines ("Rate exceeded" / Throttling)
# beside its timing, and waits PERF_CW_COOLDOWN seconds (default 120; 0 skips)
# before every cw run after the first: CloudWatch throttles per account, so
# the build that follows another's burst would otherwise time the throttle.
# A phase with any throttled call reads THROTTLED (not comparable).
#
# Output: per arm, phase and build, median / min / max seconds, a final table,
# and a verdict: "no difference" only where the OLD and NEW ranges overlap or
# the medians differ by less than 0.3s; otherwise the delta. Exits non-zero
# only on a failed cdkd command or leftovers, never on timing.
#
# Cost: arms 1-3 a few cents (SQS, SNS, SSM, on-demand DynamoDB; nothing
# billed by the hour). Arms 4-5 add CloudWatch alarms, billed USD 0.10 per
# alarm-month prorated by the hour: with the defaults about 1,220 alarm-hours
# (6 x 200 + 10 x 2), so at most about USD 0.20; log groups (no data), target
# groups (no load balancer), ECS clusters (no tasks) and EventBridge rules
# (no events) are free. Duration: roughly 20-30 minutes for arms 1-3 and
# 25-40 minutes for arms 4-5 with the defaults, plus the OLD build.
#
# Run via: /run-integ perf-cross-backend-check
#         or: bash tests/integration/perf-cross-backend-check/verify.sh

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
REPO_ROOT="$(cd ../../.. && pwd)"

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
RUNS="${PERF_RUNS:-5}"
SCALE_STACKS="${PERF_SCALE_STACKS:-10}"
SCALE_RUNS="${PERF_SCALE_RUNS:-3}"
SEED_PREFIXES="${PERF_SEED_PREFIXES:-100}"
PREFIX_RUNS="${PERF_PREFIX_RUNS:-3}"
ADOPT_RUNS="${PERF_ADOPT_RUNS:-5}"
CW_RUNS="${PERF_CW_RUNS:-3}"
ARMS="${PERF_ARMS:-1 2 3 4 5}"
CW_COOLDOWN="${PERF_CW_COOLDOWN:-120}"
THROTTLES=0
KEEP_LOGS="${PERF_KEEP_LOGS:-0}"
VERBOSE="${PERF_VERBOSE:-0}"
LOG_DIR=""
LOG_SEQ=0
arm_on() { case " ${ARMS} " in *" $1 "*) return 0 ;; esac; return 1; }
# <epoch>-<pid>: every name and prefix below is built from it, and the sweeps'
# guards match that shape. The separator keeps two runs' ids from reading as
# one another's prefix.
RUN_ID="$(date +%s)-$$"
STACK_BASE="CdkdPerf${RUN_ID}"
SEED_BASE="cdkd-perf-${RUN_ID}"
RUN_PREFIX_BASE="cdkd-perfrun-${RUN_ID}"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi

SCRATCH=""
OLD_BIN=""
NEW_BIN=""
LOCAL_DIST=""
RESULTS=""
RUN_LOG=""
SEEDED=""
# One line per stack this run deployed: "<stack>\t<prefix>".
DEPLOYED_LIST=""

now() { perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'printf "%.3f", clock_gettime(CLOCK_MONOTONIC)'; }

# Build a git ref of this repository into <dir>; prints the cli.js path.
build_ref() { # usage: build_ref <ref> <dir>
  local ref="$1" dir="$2"
  mkdir -p "${dir}"
  git -C "${REPO_ROOT}" archive "${ref}" | tar -x -C "${dir}" || return 1
  (cd "${dir}" && pnpm install --frozen-lockfile >/dev/null 2>&1 && vp run build >/dev/null 2>&1) || return 1
  [ -f "${dir}/dist/cli.js" ] || return 1
  printf '%s' "${dir}/dist/cli.js"
}

sweep_seeds() {
  local i payload
  case "${SEED_BASE:-}" in
    cdkd-perf-[0-9]*-[0-9]*) ;;
    *)
      echo "WARN: teardown sweep refused: seed base '${SEED_BASE:-}' is not cdkd-perf-<digits>-<digits>" >&2
      return 0
      ;;
  esac
  payload='{"Objects":['
  for i in $(seq 1 "${SEED_PREFIXES}"); do
    payload="${payload}{\"Key\":\"${SEED_BASE}-${i}/x\"},"
  done
  payload="${payload%,}],\"Quiet\":true}"
  aws s3api delete-objects --bucket "${STATE_BUCKET}" --delete "${payload}" >/dev/null
}

seed_prefixes() {
  local dir i
  dir="$(mktemp -d)"
  for i in $(seq 1 "${SEED_PREFIXES}"); do
    mkdir -p "${dir}/${SEED_BASE}-${i}"
    printf 'x' >"${dir}/${SEED_BASE}-${i}/x"
  done
  SEEDED=1
  aws s3 cp "${dir}" "s3://${STATE_BUCKET}/" --recursive --only-show-errors
  rm -rf "${dir}"
}

# Delete this run's generated-name resources: names carrying exactly STACK_BASE.
sweep_named() {
  local url arn param table
  case "${STACK_BASE:-}" in
    CdkdPerf[0-9]*-[0-9]*) ;;
    *)
      echo "WARN: teardown sweep refused: stack base '${STACK_BASE:-}' is not CdkdPerf<digits>-<digits>" >&2
      return 0
      ;;
  esac
  for url in $(aws sqs list-queues --queue-name-prefix "${STACK_BASE}" --region "${REGION}" --query 'QueueUrls' --output text 2>/dev/null); do
    case "${url##*/}" in
      "${STACK_BASE}"?*) aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  for arn in $(aws sns list-topics --region "${REGION}" --query "Topics[?contains(TopicArn, ':${STACK_BASE}')].TopicArn" --output text 2>/dev/null); do
    case "${arn##*:}" in
      "${STACK_BASE}"?*) aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  for param in $(aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=/${STACK_BASE}" --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null); do
    case "${param}" in
      "/${STACK_BASE}"?*) aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  for table in $(aws dynamodb list-tables --region "${REGION}" --query "TableNames[?starts_with(@, '${STACK_BASE}')]" --output text 2>/dev/null); do
    case "${table}" in
      "${STACK_BASE}"?*) aws dynamodb delete-table --table-name "${table}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  # Arms 4-5. delete-alarms takes at most 100 names per call.
  local alarms=() name lg rule tg cluster
  for name in $(aws cloudwatch describe-alarms --alarm-name-prefix "${STACK_BASE}" --region "${REGION}" --query 'MetricAlarms[].AlarmName' --output text 2>/dev/null); do
    case "${name}" in "${STACK_BASE}"?*) alarms+=("${name}") ;; esac
  done
  while [ "${#alarms[@]}" -gt 0 ]; do
    aws cloudwatch delete-alarms --alarm-names "${alarms[@]:0:100}" --region "${REGION}" >/dev/null 2>&1
    alarms=("${alarms[@]:100}")
  done
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "/cdkd/${STACK_BASE}" --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    case "${lg}" in
      "/cdkd/${STACK_BASE}"?*) aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  for rule in $(aws events list-rules --name-prefix "${STACK_BASE}" --region "${REGION}" --query 'Rules[].Name' --output text 2>/dev/null); do
    case "${rule}" in
      "${STACK_BASE}"?*) aws events delete-rule --name "${rule}" --force --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
  for tg in $(aws elbv2 describe-target-groups --region "${REGION}" --query "TargetGroups[?starts_with(TargetGroupName, '${STACK_BASE}')].TargetGroupArn" --output text 2>/dev/null); do
    aws elbv2 delete-target-group --target-group-arn "${tg}" --region "${REGION}" >/dev/null 2>&1
  done
  for cluster in $(aws ecs list-clusters --region "${REGION}" --query 'clusterArns' --output text 2>/dev/null); do
    case "${cluster##*/}" in
      "${STACK_BASE}"?*) aws ecs delete-cluster --cluster "${cluster}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
}

# Count what this run left: prints one WARN per leftover family and returns 1
# when there was any (or a listing failed).
# This run's stack registry markers (`_cdkd-registry/<region>/<stack>.json`):
# exactly the stacks DEPLOYED_LIST names, and only a marker naming one of this
# run's prefixes is removed. A destroy releases its own; this catches a run
# that failed before its destroy.
run_markers() {
  [ -n "${DEPLOYED_LIST:-}" ] && [ -f "${DEPLOYED_LIST}" ] || return 0
  cut -f1 "${DEPLOYED_LIST}" | sort -u | while IFS= read -r stack; do
    case "${stack}" in
      "${STACK_BASE}"?*) printf '_cdkd-registry/%s/%s.json\n' "${REGION}" "${stack}" ;;
    esac
  done
}

sweep_markers() {
  local key prefix
  for key in $(run_markers); do
    prefix="$( (aws s3 cp "s3://${STATE_BUCKET}/${key}" - 2>/dev/null || true) | jq -r '.prefix // ""' 2>/dev/null || true)"
    case "${prefix}" in
      "${RUN_PREFIX_BASE}"-?*) aws s3 rm "s3://${STATE_BUCKET}/${key}" --only-show-errors ;;
    esac
  done
}

rescan() {
  local left found=0
  if left="$(aws sqs list-queues --queue-name-prefix "${STACK_BASE}" --region "${REGION}" --query 'QueueUrls' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: queues left (a just-deleted queue can list for 60s): ${left}" >&2; }
  else
    echo "WARN: could not list queues: ${left}" >&2
    found=1
  fi
  if left="$(aws sns list-topics --region "${REGION}" --query "Topics[?contains(TopicArn, ':${STACK_BASE}')].TopicArn" --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: topics left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list topics: ${left}" >&2
    found=1
  fi
  if left="$(aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=/${STACK_BASE}" --region "${REGION}" --query 'Parameters[].Name' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: parameters left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list parameters: ${left}" >&2
    found=1
  fi
  if left="$(aws dynamodb list-tables --region "${REGION}" --query "TableNames[?starts_with(@, '${STACK_BASE}')]" --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: tables left (deletion is asynchronous): ${left}" >&2; }
  else
    echo "WARN: could not list tables: ${left}" >&2
    found=1
  fi
  if left="$(aws cloudwatch describe-alarms --alarm-name-prefix "${STACK_BASE}" --region "${REGION}" --query 'MetricAlarms[].AlarmName' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: alarms left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list alarms: ${left}" >&2
    found=1
  fi
  if left="$(aws logs describe-log-groups --log-group-name-prefix "/cdkd/${STACK_BASE}" --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: log groups left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list log groups: ${left}" >&2
    found=1
  fi
  if left="$(aws events list-rules --name-prefix "${STACK_BASE}" --region "${REGION}" --query 'Rules[].Name' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: EventBridge rules left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list EventBridge rules: ${left}" >&2
    found=1
  fi
  if left="$(aws elbv2 describe-target-groups --region "${REGION}" --query "TargetGroups[?starts_with(TargetGroupName, '${STACK_BASE}')].TargetGroupName" --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: target groups left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list target groups: ${left}" >&2
    found=1
  fi
  if left="$(aws ecs list-clusters --region "${REGION}" --query 'clusterArns' --output text 2>&1)"; then
    left="$(printf '%s\n' ${left} | grep -F ":cluster/${STACK_BASE}" || true)"
    if [ -n "${left}" ]; then
      # A deleted cluster lists as INACTIVE for a while: only ACTIVE ones count.
      if left="$(aws ecs describe-clusters --clusters ${left} --region "${REGION}" --query "clusters[?status=='ACTIVE'].clusterName" --output text 2>&1)"; then
        [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: ECS clusters left: ${left}" >&2; found=1; }
      else
        echo "WARN: could not describe ECS clusters: ${left}" >&2
        found=1
      fi
    fi
  else
    echo "WARN: could not list ECS clusters: ${left}" >&2
    found=1
  fi
  if left="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${SEED_BASE}-" --query 'Contents[].Key' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: seed objects left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list seed objects: ${left}" >&2
    found=1
  fi
  if left="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${RUN_PREFIX_BASE}-" --query 'Contents[?ends_with(Key, `state.json`)].Key' --output text 2>&1)"; then
    [ -z "${left}" ] || [ "${left}" = "None" ] || { echo "WARN: state records left: ${left}" >&2; found=1; }
  else
    echo "WARN: could not list state records: ${left}" >&2
    found=1
  fi
  local key
  for key in $(run_markers); do
    if ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" ); then
      echo "WARN: stack registry marker left: s3://${STATE_BUCKET}/${key}" >&2
      found=1
    fi
  done
  return "${found}"
}

# Remove the per-run prefixes, once no state record is left under them.
sweep_run_prefixes() {
  local left
  case "${RUN_PREFIX_BASE:-}" in
    cdkd-perfrun-[0-9]*-[0-9]*) ;;
    *)
      echo "WARN: teardown sweep refused: prefix base '${RUN_PREFIX_BASE:-}' is not cdkd-perfrun-<digits>-<digits>" >&2
      return 0
      ;;
  esac
  if ! left="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "${RUN_PREFIX_BASE}-" --query 'Contents[?ends_with(Key, `state.json`)].Key' --output text 2>&1)"; then
    echo "WARN: could not list this run's prefixes: ${left}" >&2
    return 0
  fi
  if [ -n "${left}" ] && [ "${left}" != "None" ]; then
    echo "WARN: records kept under ${RUN_PREFIX_BASE}-*: ${left}" >&2
    return 0
  fi
  aws s3 rm "s3://${STATE_BUCKET}/" --recursive --exclude '*' --include "${RUN_PREFIX_BASE}-*" --only-show-errors
}

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors tolerated)"
  rm -f "${RUN_LOG:-}"
  if [ -n "${DEPLOYED_LIST:-}" ] && [ -f "${DEPLOYED_LIST}" ] && [ -n "${LOCAL_DIST:-}" ]; then
    while IFS="$(printf '\t')" read -r stack prefix; do
      [ -n "${stack}" ] && [ -n "${prefix}" ] || continue
      if ! ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${prefix}/${stack}/${REGION}/state.json" ); then
        node "${LOCAL_DIST}" state destroy "${stack}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${prefix}" \
          --region "${REGION}" --yes >/dev/null 2>&1
      fi
    done <"${DEPLOYED_LIST}"
  fi
  sweep_named
  if [ -n "${SEEDED:-}" ]; then
    sweep_seeds
  fi
  sweep_run_prefixes
  sweep_markers
  rescan || rc=1
  rm -f "${DEPLOYED_LIST:-}" "${RESULTS:-}"
  if [ -n "${SCRATCH:-}" ] && [ -d "${SCRATCH}" ]; then
    rm -rf "${SCRATCH}"
  fi
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

SCRATCH="$(mktemp -d)"
RESULTS="$(mktemp)"
RUN_LOG="$(mktemp)"
DEPLOYED_LIST="$(mktemp)"
if [ "${KEEP_LOGS}" = 1 ]; then
  LOG_DIR="${PERF_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/perf-cross-backend-logs.XXXXXX")}"
  mkdir -p "${LOG_DIR}"
  echo "==> Keeping every cdkd command's output in ${LOG_DIR}"
fi

echo "==> Building the two cdkd builds"
if [ -n "${OLD_CDKD_VERSION:-}" ]; then
  (cd "${SCRATCH}" && mkdir old && cd old && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${OLD_CDKD_VERSION}" >/dev/null)
  OLD_BIN="${SCRATCH}/old/node_modules/@go-to-k/cdkd/dist/cli.js"
  OLD_DESC="npm @go-to-k/cdkd@${OLD_CDKD_VERSION}"
else
  OLD_REF_RESOLVED="${OLD_REF:-$(git -C "${REPO_ROOT}" merge-base origin/main HEAD)}"
  OLD_SHA="$(git -C "${REPO_ROOT}" rev-parse "${OLD_REF_RESOLVED}^{commit}")"
  OLD_BIN="$(build_ref "${OLD_SHA}" "${SCRATCH}/old")" || { echo "FAIL: could not build OLD ${OLD_SHA}" >&2; exit 1; }
  OLD_DESC="git ${OLD_SHA}"
fi
if [ -n "${NEW_REF:-}" ]; then
  NEW_SHA="$(git -C "${REPO_ROOT}" rev-parse "${NEW_REF}^{commit}")"
  NEW_BIN="$(build_ref "${NEW_SHA}" "${SCRATCH}/new")" || { echo "FAIL: could not build NEW ${NEW_SHA}" >&2; exit 1; }
  NEW_DESC="git ${NEW_SHA}"
else
  NEW_BIN="${REPO_ROOT}/dist/cli.js"
  # This tree's dist must BE HEAD: no uncommitted src, and no src file newer
  # than the build.
  if [ -n "$(git -C "${REPO_ROOT}" status --porcelain -- src)" ]; then
    echo "FAIL: src has uncommitted changes; commit them or pass NEW_REF" >&2
    exit 1
  fi
  if [ ! -f "${NEW_BIN}" ] || [ -n "$(find "${REPO_ROOT}/src" -type f -newer "${NEW_BIN}" | head -1)" ]; then
    echo "FAIL: ${NEW_BIN} is missing or older than src -- run 'vp run build' (or pass NEW_REF)" >&2
    exit 1
  fi
  NEW_DESC="this tree's dist (HEAD $(git -C "${REPO_ROOT}" rev-parse HEAD))"
fi
# The NEW build also tears down what a failed run left (the cleanup trap).
LOCAL_DIST="${NEW_BIN}"
for bin in "${OLD_BIN}" "${NEW_BIN}"; do
  if [ -z "${bin}" ] || [ ! -f "${bin}" ]; then
    echo "FAIL: a cdkd build is missing ('${bin}')" >&2
    exit 1
  fi
done
echo "    OLD: $(node "${OLD_BIN}" --version) -- ${OLD_DESC}"
echo "    NEW: $(node "${NEW_BIN}" --version) -- ${NEW_DESC}"

# Time one cdkd command; a failure FAILs the run. Sets ELAPSED.
timed() { # usage: timed <label> <cli.js> <args...>
  local label="$1" start end rc arg wall add_verbose=0 kept
  shift
  if [ "${VERBOSE}" = 1 ]; then
    add_verbose=1
    for arg in "$@"; do
      if [ "${arg}" = --verbose ]; then add_verbose=0; fi
    done
  fi
  wall="$(perl -MTime::HiRes=time -MPOSIX=strftime -e '$t = time; printf "%s.%03dZ", strftime("%Y-%m-%dT%H:%M:%S", gmtime($t)), ($t - int($t)) * 1000')"
  start="$(now)"
  set +e
  if [ "${add_verbose}" = 1 ]; then
    node "$@" --verbose >"${RUN_LOG}" 2>&1
  else
    node "$@" >"${RUN_LOG}" 2>&1
  fi
  rc=$?
  set -e
  end="$(now)"
  ELAPSED="$(perl -e "printf '%.3f', ${end} - ${start}")"
  # Throttled API calls the run retried (visible only with --verbose: the
  # retry lines are debug). Account-level CloudWatch throttling outlasts a
  # run, so a count here means the timing measured the throttle, not cdkd.
  THROTTLES="$(grep -ciE 'rate exceeded|throttl' "${RUN_LOG}" || true)"
  if [ "${KEEP_LOGS}" = 1 ]; then
    LOG_SEQ=$((LOG_SEQ + 1))
    kept="${LOG_DIR}/$(printf '%03d' "${LOG_SEQ}")-$(printf '%s' "${label}" | tr -c 'A-Za-z0-9.-' '_').log"
    {
      printf '# %s\n# started %s, elapsed %ss, exit %s\n# node' "${label}" "${wall}" "${ELAPSED}" "${rc}"
      printf ' %q' "$@"
      if [ "${add_verbose}" = 1 ]; then printf ' --verbose'; fi
      printf '\n'
      cat "${RUN_LOG}"
    } >"${kept}"
  fi
  if [ "${rc}" -ne 0 ]; then
    sed 's/^/  /' "${RUN_LOG}"
    echo "FAIL: ${label} exited ${rc} (output above)" >&2
    exit 1
  fi
  if [ "${THROTTLES}" -gt 0 ]; then
    echo "    ${label}: ${ELAPSED}s (${THROTTLES} throttled-call lines)"
  else
    echo "    ${label}: ${ELAPSED}s"
  fi
}

# usage: record <arm> <phase> <build> <seconds> [throttled-call lines]
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-}" >>"${RESULTS}"; }

# One single-stack run: first deploy, NO_CHANGE redeploy, destroy.
single_run() { # usage: single_run <OLD|NEW> <run#>
  export PERF_VARIANT=basic
  local which="$1" n="$2" bin stack prefix
  [ "${which}" = OLD ] && bin="${OLD_BIN}" || bin="${NEW_BIN}"
  stack="${STACK_BASE}${which}${n}"
  prefix="${RUN_PREFIX_BASE}-single-${which}${n}"
  printf '%s\t%s\n' "${stack}" "${prefix}" >>"${DEPLOYED_LIST}"
  export PERF_STACK_BASE="${stack}" PERF_STACK_COUNT=1
  timed "single ${which} #${n} deploy" "${bin}" deploy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes
  record single deploy "${which}" "${ELAPSED}"
  timed "single ${which} #${n} redeploy" "${bin}" deploy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes
  record single redeploy "${which}" "${ELAPSED}"
  timed "single ${which} #${n} destroy" "${bin}" destroy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --force
  record single teardown "${which}" "${ELAPSED}"
  assert_gone "state of ${stack} still exists after its destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${prefix}/${stack}/${REGION}/state.json"
}

# One scaling run: `deploy --all` and `destroy --all` of SCALE_STACKS stacks.
scale_run() { # usage: scale_run <OLD|NEW> <run#>
  export PERF_VARIANT=basic
  local which="$1" n="$2" bin base prefix i
  [ "${which}" = OLD ] && bin="${OLD_BIN}" || bin="${NEW_BIN}"
  base="${STACK_BASE}Sc${which}${n}"
  prefix="${RUN_PREFIX_BASE}-scale-${which}${n}"
  for i in $(seq 1 "${SCALE_STACKS}"); do
    printf '%s\t%s\n' "${base}S${i}" "${prefix}" >>"${DEPLOYED_LIST}"
  done
  export PERF_STACK_BASE="${base}" PERF_STACK_COUNT="${SCALE_STACKS}"
  timed "scale ${which} #${n} deploy --all" "${bin}" deploy --all --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes
  record scale deploy "${which}" "${ELAPSED}"
  timed "scale ${which} #${n} destroy --all" "${bin}" destroy --all --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --force
  record scale teardown "${which}" "${ELAPSED}"
}

# One prefix-count run of NEW's first deploy; <with|without> seeded prefixes.
prefix_run() { # usage: prefix_run <with|without> <run#>
  export PERF_VARIANT=basic
  local mode="$1" n="$2" stack prefix
  if [ "${mode}" = with ]; then seed_prefixes; else [ -z "${SEEDED}" ] || { sweep_seeds; SEEDED=""; }; fi
  stack="${STACK_BASE}Px${mode}${n}"
  prefix="${RUN_PREFIX_BASE}-prefix-${mode}${n}"
  printf '%s\t%s\n' "${stack}" "${prefix}" >>"${DEPLOYED_LIST}"
  export PERF_STACK_BASE="${stack}" PERF_STACK_COUNT=1
  timed "prefixes ${mode} #${n} NEW deploy" "${NEW_BIN}" deploy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes
  record prefixes deploy "${mode}" "${ELAPSED}"
  timed "prefixes ${mode} #${n} NEW destroy" "${NEW_BIN}" destroy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --force
}

# One run of arm 4 (adopt) or 5 (cw): first deploy, (arm 4) NO_CHANGE
# redeploy, destroy of one stack of that variant.
variant_run() { # usage: variant_run <adopt|cw> <OLD|NEW> <run#>
  local arm="$1" which="$2" n="$3" bin stack prefix vflag=""
  [ "${which}" = OLD ] && bin="${OLD_BIN}" || bin="${NEW_BIN}"
  # Arm 5 always runs --verbose (both builds), so its throttle retries are
  # counted beside its timings.
  if [ "${arm}" = cw ]; then vflag="--verbose"; fi
  stack="${STACK_BASE}${arm}${which}${n}"
  prefix="${RUN_PREFIX_BASE}-${arm}-${which}${n}"
  printf '%s\t%s\n' "${stack}" "${prefix}" >>"${DEPLOYED_LIST}"
  [ "${arm}" = adopt ] && export PERF_VARIANT=adopting || export PERF_VARIANT=cloudwatch
  export PERF_STACK_BASE="${stack}" PERF_STACK_COUNT=1
  timed "${arm} ${which} #${n} deploy" "${bin}" deploy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes ${vflag:+"${vflag}"}
  record "${arm}" deploy "${which}" "${ELAPSED}" "${THROTTLES}"
  if [ "${arm}" = adopt ]; then
    timed "${arm} ${which} #${n} redeploy" "${bin}" deploy "${stack}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes
    record "${arm}" redeploy "${which}" "${ELAPSED}"
    if [ "${which}" = NEW ]; then
      # G9: a NO_CHANGE redeploy makes zero generated-name lookups. Untimed,
      # --verbose so the check's debug line would show; the "No changes"
      # line proves the run reached the plan.
      timed "${arm} ${which} #${n} redeploy (verbose, untimed)" "${bin}" deploy "${stack}" \
        --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --yes --verbose
      grep -q 'No changes detected' "${RUN_LOG}" || {
        echo "FAIL: the verbose NO_CHANGE redeploy of ${stack} printed no 'No changes detected'" >&2
        exit 1
      }
      if grep -q 'Generated-name check: looking up' "${RUN_LOG}"; then
        echo "FAIL: the NO_CHANGE redeploy of ${stack} looked generated names up (go-to-k/cdkd#4705)" >&2
        exit 1
      fi
    fi
  fi
  if [ "${arm}" = adopt ] && [ "${which}" = NEW ] && [ "${n}" = 1 ]; then
    # D-8, the positive control: on a verbose FIRST deploy (untimed, its own
    # stack and prefix) the same line DOES appear, so its absence above means
    # no lookup rather than a line that never prints.
    local pstack="${STACK_BASE}adoptPos" pprefix="${RUN_PREFIX_BASE}-adopt-pos"
    printf '%s\t%s\n' "${pstack}" "${pprefix}" >>"${DEPLOYED_LIST}"
    export PERF_STACK_BASE="${pstack}"
    timed "${arm} positive control: verbose first deploy (untimed)" "${bin}" deploy "${pstack}" \
      --region "${REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${pprefix}" --yes --verbose
    grep -q 'Generated-name check: looking up 20 planned create(s)' "${RUN_LOG}" || {
      echo "FAIL: the verbose first deploy of ${pstack} printed no 'Generated-name check: looking up 20 planned create(s)'" >&2
      exit 1
    }
    # Through the CLI name the integ fences read.
    local CLI="${bin}"
    timed "${arm} positive control: destroy (untimed)" "${CLI}" destroy "${pstack}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET}" --state-prefix "${pprefix}" --force
    export PERF_STACK_BASE="${stack}"
  fi
  timed "${arm} ${which} #${n} destroy" "${bin}" destroy "${stack}" --region "${REGION}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${prefix}" --force ${vflag:+"${vflag}"}
  record "${arm}" teardown "${which}" "${ELAPSED}" "${THROTTLES}"
  assert_gone "state of ${stack} still exists after its destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${prefix}/${stack}/${REGION}/state.json"
}

# Every per-run prefix exists from the start (one placeholder object each), so
# every timed first deploy, OLD or NEW, early or late, sees the same number of
# top-level prefixes in the bucket.
echo ""
echo "==> Pre-creating every per-run prefix"
PLACEHOLDER_DIR="${SCRATCH}/placeholders"
mkdir -p "${PLACEHOLDER_DIR}"
for n in $(seq 1 "${RUNS}"); do for w in OLD NEW; do mkdir -p "${PLACEHOLDER_DIR}/${RUN_PREFIX_BASE}-single-${w}${n}"; done; done
for n in $(seq 1 "${SCALE_RUNS}"); do for w in OLD NEW; do mkdir -p "${PLACEHOLDER_DIR}/${RUN_PREFIX_BASE}-scale-${w}${n}"; done; done
for n in $(seq 1 "${PREFIX_RUNS}"); do for m in with without; do mkdir -p "${PLACEHOLDER_DIR}/${RUN_PREFIX_BASE}-prefix-${m}${n}"; done; done
for n in $(seq 1 "${ADOPT_RUNS}"); do for w in OLD NEW; do mkdir -p "${PLACEHOLDER_DIR}/${RUN_PREFIX_BASE}-adopt-${w}${n}"; done; done
for n in $(seq 1 "${CW_RUNS}"); do for w in OLD NEW; do mkdir -p "${PLACEHOLDER_DIR}/${RUN_PREFIX_BASE}-cw-${w}${n}"; done; done
for d in "${PLACEHOLDER_DIR}"/*; do printf 'x' >"${d}/.perf-placeholder"; done
aws s3 cp "${PLACEHOLDER_DIR}" "s3://${STATE_BUCKET}/" --recursive --only-show-errors

if arm_on 1; then
  echo ""
  echo "==> Arm 1: single stack, ${RUNS} runs per build (OLD/NEW alternating)"
  for n in $(seq 1 "${RUNS}"); do
    if [ $((n % 2)) -eq 1 ]; then single_run OLD "${n}"; single_run NEW "${n}"; else single_run NEW "${n}"; single_run OLD "${n}"; fi
  done
fi

if arm_on 2; then
  echo ""
  echo "==> Arm 2: --all over ${SCALE_STACKS} stacks, ${SCALE_RUNS} runs per build"
  for n in $(seq 1 "${SCALE_RUNS}"); do
    if [ $((n % 2)) -eq 1 ]; then scale_run OLD "${n}"; scale_run NEW "${n}"; else scale_run NEW "${n}"; scale_run OLD "${n}"; fi
  done
fi

if arm_on 3; then
  echo ""
  echo "==> Arm 3: NEW first deploy with/without ${SEED_PREFIXES} seeded top-level prefixes, ${PREFIX_RUNS} runs each"
  for n in $(seq 1 "${PREFIX_RUNS}"); do
    if [ $((n % 2)) -eq 1 ]; then prefix_run without "${n}"; prefix_run with "${n}"; else prefix_run with "${n}"; prefix_run without "${n}"; fi
  done
  if [ -n "${SEEDED}" ]; then sweep_seeds; SEEDED=""; fi
fi

if arm_on 4; then
  echo ""
  echo "==> Arm 4: one stack of 20 name-adopting resources, ${ADOPT_RUNS} runs per build"
  for n in $(seq 1 "${ADOPT_RUNS}"); do
    if [ $((n % 2)) -eq 1 ]; then variant_run adopt OLD "${n}"; variant_run adopt NEW "${n}"; else variant_run adopt NEW "${n}"; variant_run adopt OLD "${n}"; fi
  done
fi

if arm_on 5; then
  echo ""
  echo "==> Arm 5: one stack of ${PERF_ALARMS:-200} alarms + ${PERF_LOG_GROUPS:-50} log groups + 3 queues + 3 topics, ${CW_RUNS} runs per build"
  # CloudWatch's throttling is account-level and outlasts a run: the build
  # that runs right after another's 200-alarm deploy and destroy inherits the
  # throttle. So every cw run after the first waits PERF_CW_COOLDOWN seconds
  # (default 120), and each timing carries its throttled-call count.
  cw_run() { # usage: cw_run <OLD|NEW> <run#>
    if [ -n "${CW_STARTED:-}" ] && [ "${CW_COOLDOWN}" -gt 0 ]; then
      echo "    (cooldown ${CW_COOLDOWN}s before cw ${1} #${2})"
      sleep "${CW_COOLDOWN}"
    fi
    CW_STARTED=1
    variant_run cw "$1" "$2"
  }
  for n in $(seq 1 "${CW_RUNS}"); do
    if [ $((n % 2)) -eq 1 ]; then cw_run OLD "${n}"; cw_run NEW "${n}"; else cw_run NEW "${n}"; cw_run OLD "${n}"; fi
  done
fi

echo ""
echo "==> Results (seconds)"
python3 - "${RESULTS}" <<'PY'
import sys, statistics
from collections import defaultdict
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1]) if l.strip()]
data = defaultdict(list)
throttled = defaultdict(int)
for row in rows:
    arm, phase, which, secs = row[:4]
    data[(arm, phase, which)].append(float(secs))
    if len(row) > 4 and row[4].strip().isdigit():
        throttled[(arm, phase, which)] += int(row[4])
print(f"{'arm':<9} {'phase':<9} {'build':<8} {'n':>2} {'median':>8} {'min':>8} {'max':>8}")
for key in sorted(data):
    v = data[key]
    print(f"{key[0]:<9} {key[1]:<9} {key[2]:<8} {len(v):>2} {statistics.median(v):>8.2f} {min(v):>8.2f} {max(v):>8.2f}")
print()
pairs = {('single', 'deploy'): ('OLD', 'NEW'), ('single', 'redeploy'): ('OLD', 'NEW'),
         ('single', 'teardown'): ('OLD', 'NEW'), ('scale', 'deploy'): ('OLD', 'NEW'),
         ('scale', 'teardown'): ('OLD', 'NEW'), ('prefixes', 'deploy'): ('without', 'with'),
         ('adopt', 'deploy'): ('OLD', 'NEW'), ('adopt', 'redeploy'): ('OLD', 'NEW'),
         ('adopt', 'teardown'): ('OLD', 'NEW'), ('cw', 'deploy'): ('OLD', 'NEW'),
         ('cw', 'teardown'): ('OLD', 'NEW')}
for (arm, phase), (a, b) in pairs.items():
    va, vb = data.get((arm, phase, a)), data.get((arm, phase, b))
    if not va or not vb:
        continue
    ma, mb = statistics.median(va), statistics.median(vb)
    overlap = min(va) <= max(vb) and min(vb) <= max(va)
    delta = mb - ma
    verdict = 'no difference' if overlap or abs(delta) < 0.3 else 'DIFFERENT'
    ta, tb = throttled[(arm, phase, a)], throttled[(arm, phase, b)]
    note = ''
    if ta or tb:
        # A throttled run measured the account's throttle: not a comparison.
        verdict = 'THROTTLED (not comparable)'
        note = f"; throttled-call lines {a} {ta}, {b} {tb}"
    print(f"VERDICT {arm} {phase}: {verdict} (median {b} - {a} = {delta:+.2f}s; {a} {ma:.2f}s, {b} {mb:.2f}s{note})")
PY

rm -f "${RUN_LOG}"
trap - EXIT INT TERM
sweep_named
sweep_run_prefixes
sweep_markers
LEFTOVERS=0
rescan || LEFTOVERS=1
rm -f "${DEPLOYED_LIST}" "${RESULTS}"
rm -rf "${SCRATCH}"
if [ "${LEFTOVERS}" -ne 0 ]; then
  echo "FAIL: leftovers after the timing run (WARN lines above)" >&2
  exit 1
fi
echo "[verify] PASS — timing harness completed; read the VERDICT lines above (OLD: ${OLD_DESC}; NEW: ${NEW_DESC})"
