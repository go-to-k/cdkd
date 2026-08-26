#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local run-task --from-state`
# Tier 2 ECR Repository resolution (PR #267, closes #264).
#
# Why this exists: the existing `tests/integration/local-run-task/` and
# `local-run-task-multi-container/` integs only use public images
# (`public.ecr.aws/nginx/nginx:alpine` etc.), so the `--from-state` path
# is unit-tested but never exercised against real AWS. This integ closes
# that gap by deploying a same-stack `AWS::ECR::Repository`, pushing a
# tiny image to it, and running the task whose `Image` is a `Fn::Sub`
# reference to that repository's deployed physical id.
#
# Critical design decision (see lib/local-run-task-from-state-stack.ts):
# the synthesized `Image` is shaped as the 1-arg `Fn::Sub` form, NOT
# `Fn::Join`. CDK 2.x's `ContainerImage.fromEcrRepository(repo)`
# synthesizes a `Fn::Join` with nested `Fn::Select` / `Fn::Split` /
# `Fn::GetAtt`, which the Tier 2 resolver does NOT yet handle (issue
# #271). The fixture uses `CfnTaskDefinition` directly with an explicit
# `cdk.Fn.sub(...)` so the round-trip exercises the actually-supported
# `Fn::Sub` path.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. cdkd deploy CdkdLocalRunTaskFromStateFixture (creates the ECR
#      repository)
#   3. push a tiny nginx image to the deployed repository
#   4. cdkd local run-task --from-state — verify Tier 2 substituted the
#      `${MyRepo}` placeholder with the deployed physical name, the
#      container started against the pushed image, and the host port is
#      reachable
#   4d. issue #2189: run the JsonKeyTaskDef, whose `:json-key:` ValueFrom
#       points at a NON-JSON secret -- assert the refusal fires and withholds
#       the secret plaintext
#   5. clean up: docker rm + docker network rm via trap; aws ecr
#      batch-delete-image to empty the repo (cdkd destroy fails if a repo
#      has images); cdkd destroy --force
#
# Run via `/run-integ local-run-task-from-state` (recommended) or directly:
#
#     bash tests/integration/local-run-task-from-state/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalRunTaskFromStateFixture"
# Four TaskDefs:
#   - NginxTaskDef   : Fn::Sub-shape Image (L1 CfnTaskDefinition)        → port 18082
#   - NginxTaskDefL2 : Fn::Join-shape Image (L2 fromEcrRepository)       → port 18083
#   - EnvTaskDef     : intrinsic env vars + Ref secret (busybox printer) → no port (echoes)
#   - JsonKeyTaskDef : `:json-key:` ref to a NON-JSON secret (issue #2189)  → refuses, never starts
# The first two share the deployed ECR repository (single deploy + push);
# EnvTaskDef uses busybox to focus on the env/secret resolver path (#291).
TASK_PATH_SUB="${STACK}/NginxTaskDef"
TASK_PATH_JOIN="${STACK}/NginxTaskDefL2"
TASK_PATH_ENV="${STACK}/EnvTaskDef"
TASK_PATH_JSONKEY="${STACK}/JsonKeyTaskDef"
# Issue #2189: the literal this fixture's PlainSecret holds. verify.sh greps
# for its ABSENCE from the refusal output, and for the absence of the 10-char
# prefix V8 actually emitted -- asserting only the whole value passes WITHOUT
# the fix, because V8 never emitted more than the prefix.
PLAIN_SECRET_VALUE="cdkd2189plaintextnotjson-abcdefghijklmnop"
PLAIN_SECRET_PREFIX="${PLAIN_SECRET_VALUE:0:10}"
HOST_PORT_SUB=18082
HOST_PORT_JOIN=18083
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-run-task-from-state"
CDKD="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# Shared S3 VERSION-sweep helpers (issue #2096). This fixture seeds TWO secrets
# whose values land in the deployed state record: MySecret's generated JSON, and
# PlainSecret's literal (added for issue #2189, whose branch needs a secret that
# is deliberately NOT valid JSON). The state bucket is VERSIONED, so `aws s3 rm`
# writes a delete marker and removes nothing -- every state.json this fixture has
# ever written stays readable through GetObjectVersion. Sweeping the whole
# `cdkd/<stack>/<region>/` PREFIX rather than state.json alone is load-bearing:
# state.json carries BOTH secrets' values, and the prefix also covers
# lock.json / rollback-journal.json / deployments/**. (The #2189 arm's own
# failure writes no rollback journal -- `cdkd local run-task` never deploys --
# so the prefix form is justified by the state record, not by that arm.)
# Sourced by ABSOLUTE path, not `. ../s3-versions.sh`: the `cd "${TEST_DIR}"`
# below is seven lines later, so a relative source resolves against the
# CALLER's cwd. This script's own header documents running it as
# `bash tests/integration/local-run-task-from-state/verify.sh` from the repo
# root, and that spelling aborts at this line under `set -e`. The real runs
# passed only because the runner cds in first. docdb-neptune/verify.sh already
# hit this and uses the absolute form for the same reason.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${NGINX_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

# Cleanup trap: empty ECR repo (cdkd destroy fails if it has images),
# cdkd destroy, then docker rm orphan containers + networks. Runs on
# every exit path (including SIGINT and FAIL).
DEPLOYED_REPO=""
# NOTE: `docker ps -a`, not `docker ps`. The step-4c env/secret container is a
# busybox that prints and EXITS, so by teardown time it is already `Exited` and
# a running-only `docker ps` never lists it — it survived every run until the
# issue 2183 pre-merge integs caught it twice in a row.
cleanup() {
  rc=$?
  set +e
  echo "[verify] cleanup (exit ${rc}) — emptying repo + destroying stack + tearing down docker"

  # Sweep local docker containers + networks first (cheap, low-risk).
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true

  # Empty the ECR repository so cdkd destroy can remove it. If we never
  # resolved the deployed repo name (stack failed before step 2b), best
  # effort: pull it from state.
  if [ -z "${DEPLOYED_REPO}" ]; then
    DEPLOYED_REPO="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::ECR::Repository"){console.log(r.physicalId);process.exit(0)}}}catch(e){}process.exit(1)})' 2>/dev/null)"
  fi
  if [ -n "${DEPLOYED_REPO}" ]; then
    IMAGE_IDS_JSON="$(aws ecr list-images --repository-name "${DEPLOYED_REPO}" --region "${REGION}" --query 'imageIds' --output json 2>/dev/null || echo '[]')"
    if [ "${IMAGE_IDS_JSON}" != "[]" ] && [ -n "${IMAGE_IDS_JSON}" ]; then
      aws ecr batch-delete-image --repository-name "${DEPLOYED_REPO}" --region "${REGION}" --image-ids "${IMAGE_IDS_JSON}" >/dev/null 2>&1 || true
    fi
  fi

  ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1 | tail -5 || true

  # State-version sweep (issue #2096), INSIDE cleanup on purpose. `cleanup`
  # ends with `exit "${rc}"`, so calling it from the success path terminates
  # the script -- an earlier revision of this arm put the sweep after an
  # explicit `cleanup` call and the sweep never ran, which the first real-AWS
  # run of this arm is what revealed. Here it runs on EVERY exit path, which is
  # also the right scope: a FAILED run seeds state too.
  #
  # Mode matters. `all` is correct only once the stack is gone for good; on a
  # failed path the destroy above is best-effort and a live state.json may still
  # be needed by a later `cdkd state destroy`, so that path purges only
  # NONCURRENT versions (where a seeded plaintext lives) and does not assert.
  if [ "${rc}" -eq 0 ]; then
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
    s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "local-run-task-from-state state teardown"
  else
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent || true
  fi

  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy ${STACK}"
${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

echo "[verify] step 2b: reading deployed ECR repository name from cdkd state"
DEPLOYED_REPO="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::ECR::Repository"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
echo "[verify]   deployed repo: ${DEPLOYED_REPO}"
[ -n "${DEPLOYED_REPO}" ] || { echo "[verify] FAIL: could not read deployed repo name from state"; exit 1; }

REPO_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${DEPLOYED_REPO}"

echo "[verify] step 3: tag + push nginx into ${REPO_URI}:latest"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null
docker tag "${NGINX_IMAGE}" "${REPO_URI}:latest"
docker push "${REPO_URI}:latest"

# Helper: run-task + curl + per-task cleanup for one TaskDef path.
# Used twice — once for the Fn::Sub fixture (NginxTaskDef:18082), once
# for the Fn::Join fixture (NginxTaskDefL2:18083). Both share the same
# deployed ECR repository + pushed `:latest` image — only the resolver
# path differs.
run_and_curl_task() {
  local task_path="$1"
  local host_port="$2"
  local shape_label="$3"

  echo "[verify] cdkd local run-task --from-state ${task_path} (shape: ${shape_label})"
  ${CDKD} local run-task "${task_path}" \
    --from-state \
    --detach \
    --no-pull \
    --container-host 127.0.0.1 \
    --state-bucket "${STATE_BUCKET}"

  echo "[verify]   curl http://127.0.0.1:${host_port}/ (allow ~5s for nginx to listen)"
  sleep 5
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${host_port}/" || true)
  echo "[verify]   HTTP code: ${http_code}"
  if [ "${http_code}" != "200" ]; then
    echo "[verify] FAIL (${shape_label}): expected 200, got ${http_code}"
    exit 1
  fi

  # Tear down THIS task's containers + network before moving on so the
  # next task can claim the 169.254.170.0/24 subnet.
  echo "[verify]   tearing down ${shape_label} task containers + network"
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
}

echo "[verify] step 4a: Tier 2 via Fn::Sub shape (L1 CfnTaskDefinition)"
run_and_curl_task "${TASK_PATH_SUB}" "${HOST_PORT_SUB}" "Fn::Sub"

echo "[verify] step 4b: Tier 2 via Fn::Join shape (L2 ContainerImage.fromEcrRepository)"
run_and_curl_task "${TASK_PATH_JOIN}" "${HOST_PORT_JOIN}" "Fn::Join"

# ─── Issue #291: env vars + secret substitution via state ─────────────
#
# The EnvTaskDef container echoes 4 env vars + the length of the
# secret-derived DB_SECRET to stdout. cdkd's `--from-state` should:
#   - Substitute TABLE_NAME from the deployed DDB table's physicalId
#     (Ref against AWS::DynamoDB::Table = the table name).
#   - Substitute TABLE_ARN from state.attributes.Arn (Fn::GetAtt).
#   - Substitute ENDPOINT's Fn::Sub interpolation against the table name
#     and AWS::Region (pseudo parameter from sts:GetCallerIdentity).
#   - Substitute JOINED's Fn::Join over a Ref(MyTable) + literal.
#   - Resolve Secrets[].ValueFrom = `Ref: MySecret` to the deployed
#     secret ARN, then fetch the JSON value via SecretsManager and
#     inject the JSON blob as DB_SECRET (length > 0).
#
# We capture container output via `docker logs` (the EnvTaskDef
# container has no port; it prints + exits naturally). cdkd's local
# run-task waits for the essential container's exit, so a non-detach
# invocation blocks until the printer finishes.
echo "[verify] step 4c: Issue #291 — env vars + Ref secret via --from-state"
echo "[verify]   reading deployed DDB table name from cdkd state"
DEPLOYED_TABLE="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::DynamoDB::Table"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
[ -n "${DEPLOYED_TABLE}" ] || { echo "[verify] FAIL: could not read deployed table name from state"; exit 1; }

# Run the env task in detached mode so the container ID is recorded for
# `docker logs` lookup; the printer exits within ~1s, then we read its
# captured stdout.
ENV_RUN_OUT="$(${CDKD} local run-task "${TASK_PATH_ENV}" \
  --from-state \
  --detach \
  --no-pull \
  --container-host 127.0.0.1 \
  --state-bucket "${STATE_BUCKET}" 2>&1)"
echo "${ENV_RUN_OUT}"

# Give the container time to print and exit (busybox echo + exit is
# basically instant, but the metadata sidecar may delay a beat).
sleep 3

ENV_CONTAINER_ID="$(docker ps -a --filter "name=cdkd-local-cdkd-local-run-task-from-state-env-fixture-printer-" --format '{{.ID}}' | head -n 1)"
[ -n "${ENV_CONTAINER_ID}" ] || { echo "[verify] FAIL: env-task container not found"; exit 1; }

ENV_LOGS="$(docker logs "${ENV_CONTAINER_ID}" 2>&1)"
echo "[verify]   env task container output:"
echo "${ENV_LOGS}" | sed 's/^/[verify]     /'

assert_in_logs() {
  local needle="$1"
  if ! echo "${ENV_LOGS}" | grep -qF "${needle}"; then
    echo "[verify] FAIL: expected '${needle}' in env-task container output"
    exit 1
  fi
}

assert_in_logs "TABLE_NAME=${DEPLOYED_TABLE}"
assert_in_logs "TABLE_ARN=arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DEPLOYED_TABLE}"
assert_in_logs "ENDPOINT=local-${REGION}-${DEPLOYED_TABLE}"
assert_in_logs "JOINED=${DEPLOYED_TABLE}|literal"
# The generated secret is JSON like {"user":"cdkd","password":"<16char>"}
# (~38-45 chars); assert a non-trivial DB_SECRET_LEN was injected. Cheap
# regex: at least two digits, i.e. >= 10 chars resolved.
if ! echo "${ENV_LOGS}" | grep -qE 'DB_SECRET_LEN=[0-9]{2,}'; then
  echo "[verify] FAIL: DB_SECRET was not resolved to a non-empty value"
  exit 1
fi

# Teardown the env task before moving on.
docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true

# Assert the teardown actually swept — the reason the exited env-task container
# survived every run before this was that NOTHING checked afterwards. Mirrors
# local-run-task-awsvpc/verify.sh. `-a` is load-bearing: the env container
# prints and exits, so a running-only check passes while the orphan remains.
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "[verify] FAIL: ${LEFTOVER_CONTAINERS} container(s) still present after teardown"
  docker ps -a --filter "name=cdkd-local-"
  exit 1
fi
LEFTOVER_NETWORKS=$(docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETWORKS}" -ne 0 ]]; then
  echo "[verify] FAIL: ${LEFTOVER_NETWORKS} network(s) still present after teardown"
  docker network ls --filter "name=cdkd-local-task-"
  exit 1
fi
echo "[verify]   teardown clean: 0 containers (incl. exited), 0 task networks"

# --- Issue #2189: a `:json-key:` ref to a NON-JSON secret must refuse -----
#
# The refusal is the POINT of this arm, so the run is EXPECTED to exit
# non-zero and that non-zero rc is asserted as a positive marker. Reading
# only "the plaintext is absent" would be a confluence point: an arm that
# died before ever reaching the resolver satisfies it just as well.
#
# The premise is proved first, in its own step, so a green result cannot come
# from an arm that never reached the branch:
#   (a) the secret really is non-JSON (read back from AWS), and
#   (b) the run really did reach the json-key branch (the message names the
#       container, the env var and the requested key).
echo "[verify] step 4d: issue #2189 - :json-key: against a NON-JSON secret must refuse without echoing it"

PLAIN_SECRET_ARN="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::SecretsManager::Secret"&&/PlainSecret/i.test(r.physicalId||"")){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
[ -n "${PLAIN_SECRET_ARN}" ] || { echo "[verify] FAIL: could not read PlainSecret from state"; exit 1; }

# Premise (a): AWS holds exactly the non-JSON literal this arm assumes. If a
# future edit makes it valid JSON the branch stops being reachable and the
# whole arm silently stops testing anything - so fail loudly here instead.
LIVE_PLAIN="$(aws secretsmanager get-secret-value --secret-id "${PLAIN_SECRET_ARN}" \
  --region "${REGION}" --query SecretString --output text)"
if [ "${LIVE_PLAIN}" != "${PLAIN_SECRET_VALUE}" ]; then
  echo "[verify] FAIL: PlainSecret does not hold the expected fixture literal"
  exit 1
fi
if echo "${LIVE_PLAIN}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d.trim());process.exit(0)}catch(e){process.exit(1)}})'; then
  echo "[verify] FAIL: PlainSecret parses as JSON - the #2189 branch is unreachable, this arm tests nothing"
  exit 1
fi
echo "[verify]   premise ok: PlainSecret is present and is NOT valid JSON"

set +e
JSONKEY_OUT="$(${CDKD} local run-task "${TASK_PATH_JSONKEY}" \
  --from-state \
  --no-pull \
  --container-host 127.0.0.1 \
  --state-bucket "${STATE_BUCKET}" 2>&1)"
JSONKEY_RC=$?
set -e

# Never echo ${JSONKEY_OUT} raw: if the fix regressed, printing it here would
# put the plaintext into the CI log this arm exists to keep it out of.
echo "[verify]   run-task exited rc=${JSONKEY_RC} (${#JSONKEY_OUT} bytes of output, withheld)"

# Positive marker 1: it REFUSED. A zero rc means resolution succeeded, which
# for a non-JSON secret under a json-key reference is itself the bug.
if [ "${JSONKEY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: json-key against a non-JSON secret exited 0 - expected a refusal"
  exit 1
fi
if echo "${JSONKEY_OUT}" | grep -qF "UNEXPECTED_RESOLUTION_SUCCEEDED"; then
  echo "[verify] FAIL: the container ran - resolution did not refuse"
  exit 1
fi

# Positive marker 2: it refused for the RIGHT reason, in the json-key branch.
# Without these, any unrelated failure (bad credentials, missing state) would
# satisfy the absence assertions below.
# The last entry is the CONTIGUOUS message, not another loose token: each of
# the four tokens above occurs elsewhere (`not valid JSON` alone appears at
# eight other src sites), so only the whole phrase pins the message to THIS
# branch. It is byte-identical before and after the fix and the error path does
# no wrapping, so asserting it costs nothing and is strictly stronger.
for needle in "jsonkey" "DB_PASS" "password" "not valid JSON" \
  "secret 'DB_PASS' specified json-key 'password' but the secret value is not valid JSON"; do
  if ! echo "${JSONKEY_OUT}" | grep -qF "${needle}"; then
    # Plain single quotes: they are literal inside a double-quoted string. The
    # `'"'"'` idiom escapes a quote inside SINGLE quotes, and using it here
    # closed the double quoting and left ${needle} unquoted -- a needle holding
    # a glob character expanded against the cwd (measured).
    echo "[verify] FAIL: refusal message did not name '${needle}' - it did not reach the json-key branch"
    exit 1
  fi
done
echo "[verify]   refusal reached the json-key branch and named the container, env var and key"

# The actual issue #2189 assertion: no secret-derived text in the output.
if echo "${JSONKEY_OUT}" | grep -qF "${PLAIN_SECRET_VALUE}"; then
  echo "[verify] FAIL: the refusal echoed the WHOLE secret plaintext"
  exit 1
fi
if echo "${JSONKEY_OUT}" | grep -qF "${PLAIN_SECRET_PREFIX}"; then
  echo "[verify] FAIL: the refusal echoed the secret plaintext prefix (the #2189 leak)"
  exit 1
fi
echo "[verify]   no secret plaintext (whole or 10-char prefix) in the refusal output"

# Negative control: the ORDINARY secret path still resolves. Step 4c above
# already asserted DB_SECRET_LEN > 0 on the same run, so a refusal that fired
# on everything would have been caught there rather than here - this line
# records that the control exists and where it lives.
echo "[verify]   negative control: step 4c resolved MySecret normally on this same run"

# The refusal happens before any container starts (ecs-task-runner resolves
# secrets before createTaskNetwork and before any boot), so nothing should be
# left. COUNT FIRST, then sweep: an earlier revision swept and then counted,
# which cannot fail -- `docker rm -f` had already removed whatever it was
# supposed to detect.
JSONKEY_LEFTOVER=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
JSONKEY_NET_LEFTOVER=$(docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | wc -l | tr -d ' ')
docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
if [[ "${JSONKEY_LEFTOVER}" -ne 0 ]]; then
  echo "[verify] FAIL: ${JSONKEY_LEFTOVER} container(s) left after the refusal arm"
  exit 1
fi
# Networks too, mirroring step 4c. This is not symmetry for its own sake: the
# arm's premise is that the refusal fires BEFORE createTaskNetwork, so a
# surviving cdkd-local-task-* network is exactly the regression that would show
# the refusal had moved later in the path.
if [[ "${JSONKEY_NET_LEFTOVER}" -ne 0 ]]; then
  echo "[verify] FAIL: ${JSONKEY_NET_LEFTOVER} task network(s) left after the refusal arm"
  exit 1
fi

# NOTE: no explicit `cleanup` call here. It ends with `exit "${rc}"`, so calling
# it would terminate the script before anything after it ran -- the trap is what
# invokes it, and the state-version sweep lives inside it.
echo ""
echo "[verify] All checks passed: --from-state substituted ECR Repository ref (Fn::Sub + Fn::Join), env-var / Ref-secret intrinsics (issue #291), the issue #2189 json-key refusal withheld the secret plaintext, and zero state versions survived - all against deployed cdkd state."
