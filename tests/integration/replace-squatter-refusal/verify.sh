#!/usr/bin/env bash
# verify.sh — `cdkd deploy --replace` must not delete the old resource for a
# collision it cannot show the old resource caused (issue #3979, deploy arm).
#
# A replacement creates the new resource first; when that create collides on a
# name, `--replace` deletes the OLD resource and re-creates. Before the fix the
# delete ran whenever the template named no explicit name, so a collision with
# an orphan, a retried create or a resource made outside the stack deleted a
# live old resource that never held the name — and the re-create collided
# again. Now the old resource must hold the name the create actually SENT.
#
# Phases (one ECR repository, `Repo`; see the stack for the env knobs):
#   A. Deploy nameless: cdkd generates the name G (captured from state) at name
#      generation 0. On a new stack G carries the stack instance suffix
#      (go-to-k/cdkd#5064); the run checks it against the suffix it derives
#      from state.json's stackInstanceId, which phase C's derivation relies on.
#   B. REPO_NAME=N deploy: a replacement to the explicit name N; G is deleted.
#      A replacement moves the record to the next name generation (1).
#   C. THE ARM. A nameless deploy is a replacement of N whose create sends the
#      name of the NEXT generation, G' (go-to-k/cdkd#5064 phase 2: derived from
#      the stack instance id, the logical id and max(nameGeneration,
#      nameGenerationHigh) + 1, read from state). Create a squatter repository
#      under G' out of band, then deploy nameless — plain, then with --replace.
#      Each create sends G' and collides with the squatter. Each deploy must
#      FAIL naming G' as the next-generation name, and delete NOTHING (N keeps
#      its createdAt, the squatter survives, state still records N at the same
#      generation). Before the #3979 fix --replace deleted N.
#   D. NEGATIVE CONTROL. Remove the squatter, then REPO_NAME=N REPO_KMS=true
#      deploy --replace: a replacement KEEPING the name, whose create collides
#      with N itself. N provably holds it, so delete-first must still run and
#      the deploy succeed (N re-created with KMS encryption).
#   E. Destroy; N, G, G' and the state file are gone.
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

STACK="CdkdReplaceSquatterRefusalExample"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
NAMED_REPO="cdkd-integ-rsq-named"
# What cdkd generates for the nameless `Repo` of this stack starts with this
# prefix and ends with the 12-hex stack instance suffix (go-to-k/cdkd#5064).
# The full name G is read from state in phase A (set below); phase C derives
# the next generation's name G' from it. Phase A asserts G's SHAPE and its
# suffix, so a drift in the generation fails loudly instead of aiming the
# squatter elsewhere.
GENERATED_PREFIX="$(printf '%s' "${STACK}-Repo-" | tr '[:upper:]' '[:lower:]')"
GENERATED_REPO=""
SQUATTER_REPO=""

LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rsq.XXXXXX")"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "[verify] FAIL: ${LOCAL_DIST} not found — run 'vp run build' at the repo root first" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

delete_repo_best_effort() { # usage: delete_repo_best_effort <name>
  (
  set +eu
  aws ecr delete-repository --repository-name "$1" --force --region "${REGION}" >/dev/null 2>&1 || true
  )
}

# The repository's creation time, or a hard failure when it cannot be read.
repo_created_at() { # usage: repo_created_at <name>
  aws ecr describe-repositories --repository-names "$1" --region "${REGION}" \
    --query 'repositories[0].createdAt' --output text
}

repo_encryption() { # usage: repo_encryption <name>
  aws ecr describe-repositories --repository-names "$1" --region "${REGION}" \
    --query 'repositories[0].encryptionConfiguration.encryptionType' --output text
}

state_repo_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.Repo.physicalId'
}

# The record's name generation (absent = 0) and the generation its next
# replacement creates at: max(nameGeneration, nameGenerationHigh) + 1
# (go-to-k/cdkd#5064 phase 2).
state_repo_generation() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.Repo.nameGeneration // 0'
}
state_repo_next_generation() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r '[.resources.Repo.nameGeneration // 0, .resources.Repo.nameGenerationHigh // 0] | max + 1'
}

# The 12-hex suffix cdkd gives a generated name at name generation <g> of
# <logicalId> (go-to-k/cdkd#5064): sha256(id NUL logicalId)[:12] at 0,
# sha256(id NUL logicalId NUL g)[:12] above, the id being state.json's
# stackInstanceId. Read from S3 into node's stdin: the id is never printed.
state_name_suffix() { # usage: state_name_suffix <logicalId> <generation>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | node -e '
const { createHash } = require("node:crypto");
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const [logicalId, generation] = process.argv.slice(1);
  const id = JSON.parse(raw).stackInstanceId;
  if (typeof id !== "string" || id === "" || !/^(0|[1-9][0-9]*)$/.test(generation ?? "")) {
    process.stderr.write("state.json carries no stackInstanceId, or the generation is not a number\n");
    process.exit(1);
  }
  const hash = createHash("sha256").update(id).update("\0").update(logicalId);
  if (generation !== "0") hash.update("\0").update(generation);
  process.stdout.write(hash.digest("hex").slice(0, 12));
});' "$1" "$2"
}

cleanup() {
  rc=$?
  echo "[verify] cleanup (rc=${rc})"
  (
  set +eu
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
    --region "${REGION}" --yes >/dev/null 2>&1 || true
  delete_repo_best_effort "${NAMED_REPO}"
  [ -n "${GENERATED_REPO}" ] && delete_repo_best_effort "${GENERATED_REPO}"
  [ -n "${SQUATTER_REPO}" ] && delete_repo_best_effort "${SQUATTER_REPO}"
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  rm -rf "${LOG_DIR}"
  )
  exit "${rc}"
}

# A leftover repository (an interrupted run, or a CONCURRENT one) would turn
# phase C into a false collision. Checked BEFORE the trap is armed, so a
# refusal here never sweeps what it refused to touch.
if ! gone_probe aws ecr describe-repositories --repository-names "${NAMED_REPO}" --region "${REGION}"; then
  echo "[verify] FAIL: repository ${NAMED_REPO} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
# The generated name is unknown before phase A: refuse on any repository
# under its prefix (a leftover of an earlier lifetime of this stack).
LEFTOVER_GENERATED="$(aws ecr describe-repositories --region "${REGION}" \
  --query "repositories[?starts_with(repositoryName, '${GENERATED_PREFIX}')].repositoryName" \
  --output text)"
if [ -n "${LEFTOVER_GENERATED}" ] && [ "${LEFTOVER_GENERATED}" != "None" ]; then
  echo "[verify] FAIL: repository ${LEFTOVER_GENERATED} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "[verify] FAIL: s3://${STATE_BUCKET}/${STATE_KEY} already exists before the run — nothing was touched" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

# Every phase sets REPO_NAME / REPO_KMS itself, so a value in the caller's
# environment can never leak into a phase that means "no name".
deploy() { # usage: deploy <log> <REPO_NAME or ''> <REPO_KMS or ''> [extra flags...]
  local log="$1" name="$2" kms="$3"
  shift 3
  env -u REPO_NAME -u REPO_KMS ${name:+REPO_NAME="${name}"} ${kms:+REPO_KMS="${kms}"} \
    node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --yes "$@" > "${log}" 2>&1
}

# ---------------------------------------------------------------------------
# PHASE A: nameless deploy — cdkd generates the name
# ---------------------------------------------------------------------------
echo "[verify] phase A: deploy ${STACK} with no repository name"
deploy "${LOG_DIR}/a.log" '' '' \
  || { sed 's/^/  /' "${LOG_DIR}/a.log"; echo "[verify] FAIL: phase A deploy failed" >&2; exit 1; }
A_ID="$(state_repo_id)"
if ! printf '%s' "${A_ID}" | grep -qE "^${GENERATED_PREFIX}[0-9a-f]{12}\$"; then
  echo "[verify] FAIL: state records Repo as '${A_ID}', expected a generated '${GENERATED_PREFIX}<12 hex>'" >&2
  exit 1
fi
GENERATED_REPO="${A_ID}"
repo_created_at "${GENERATED_REPO}" >/dev/null
# The derivation phase C aims its squatter with must reproduce the name cdkd
# minted at generation 0; a mismatch here is the derivation, not the arm.
A_SUFFIX="$(state_name_suffix Repo 0)"
if [ "${GENERATED_REPO}" != "${GENERATED_PREFIX}${A_SUFFIX}" ]; then
  echo "[verify] FAIL: ${GENERATED_REPO} does not end in the generation-0 suffix derived from state.json's stackInstanceId (got ${A_SUFFIX}) — the go-to-k/cdkd#5064 suffix derivation drifted" >&2
  exit 1
fi
if [ "$(state_repo_generation)" != "0" ]; then
  echo "[verify] FAIL: the first create recorded a name generation other than 0" >&2
  exit 1
fi
echo "[verify] phase A ok: ${GENERATED_REPO} deployed"

# ---------------------------------------------------------------------------
# PHASE B: replace to the explicit name N
# ---------------------------------------------------------------------------
echo "[verify] phase B: REPO_NAME=${NAMED_REPO} deploy (replacement to the explicit name)"
deploy "${LOG_DIR}/b.log" "${NAMED_REPO}" '' --force-stateful-recreation \
  || { sed 's/^/  /' "${LOG_DIR}/b.log"; echo "[verify] FAIL: phase B deploy failed" >&2; exit 1; }
if [ "$(state_repo_id)" != "${NAMED_REPO}" ]; then
  echo "[verify] FAIL: state does not record Repo as ${NAMED_REPO} after phase B" >&2
  exit 1
fi
assert_gone "the old generated repository ${GENERATED_REPO} survived the phase B replacement" \
  aws ecr describe-repositories --repository-names "${GENERATED_REPO}" --region "${REGION}"
if [ "$(state_repo_generation)" != "1" ]; then
  echo "[verify] FAIL: the phase B replacement did not move Repo's record to name generation 1 (go-to-k/cdkd#5064 phase 2)" >&2
  exit 1
fi
echo "[verify] phase B ok: ${NAMED_REPO} is the stack's repository, ${GENERATED_REPO} deleted"

# ---------------------------------------------------------------------------
# PHASE C: THE ARM — a squatter on the next generation's generated name
# ---------------------------------------------------------------------------
C_GENERATION="$(state_repo_next_generation)"
C_SUFFIX="$(state_name_suffix Repo "${C_GENERATION}")"
SQUATTER_REPO="${GENERATED_PREFIX}${C_SUFFIX}"
if [ "${SQUATTER_REPO}" = "${GENERATED_REPO}" ]; then
  echo "[verify] FAIL: generation ${C_GENERATION}'s name equals generation 0's (${GENERATED_REPO}) — the derivation is wrong" >&2
  exit 1
fi
if ! gone_probe aws ecr describe-repositories --repository-names "${SQUATTER_REPO}" --region "${REGION}"; then
  echo "[verify] FAIL: ${SQUATTER_REPO} exists before phase C planted it" >&2
  exit 1
fi
echo "[verify] phase C: squatter ${SQUATTER_REPO} (name generation ${C_GENERATION}) out of band, then a nameless deploy, plain and with --replace (expect REFUSAL)"
NAMED_CREATED_AT="$(repo_created_at "${NAMED_REPO}")"
aws ecr create-repository --repository-name "${SQUATTER_REPO}" --region "${REGION}" >/dev/null
SQUATTER_CREATED_AT="$(repo_created_at "${SQUATTER_REPO}")"

# The parsed markers name the SENT name — the holder diagnosis and the
# next-generation advice; the sentinel is each refusal's own closing clause,
# independent of both. Sentinel without marker = the wording drifted or a
# different name was sent — never read as "no refusal".
C_MARKER="the cdkd naming rule generates RepositoryName \"${SQUATTER_REPO}\""
C_ADVICE="The colliding name ${SQUATTER_REPO} is the one this replacement generates for its next name generation"
assert_squatter_refusal() { # usage: assert_squatter_refusal <log> <rc> <sentinel> <what>
  local log="$1" rc="$2" sentinel="$3" what="$4"
  if [ "${rc}" -eq 0 ]; then
    echo "[verify] FAIL: ${what} SUCCEEDED over a squatter on ${SQUATTER_REPO}" >&2
    exit 1
  fi
  if ! grep -qF -- "${sentinel}" "${log}"; then
    echo "[verify] FAIL: ${what} exited ${rc} without the #3979 holder refusal (output above)" >&2
    exit 1
  fi
  if ! grep -F -- "${sentinel}" "${log}" | grep -F -- "${C_MARKER}" | grep -qF -- "${C_ADVICE}"; then
    echo "[verify] FAIL: the refusal of ${what} is present but does not name the sent ${SQUATTER_REPO} as the next-generation name (wording drifted, or a different name was sent):" >&2
    grep -F -- "${sentinel}" "${log}" | sed 's/^/  /' >&2
    exit 1
  fi
  if grep -qF 'deleting old Repo' "${log}"; then
    echo "[verify] FAIL: the delete-first engaged for the squatter's collision (${what})" >&2
    exit 1
  fi
  local named_at squatter_at generation next
  named_at="$(repo_created_at "${NAMED_REPO}")" || return 1
  if [ "${named_at}" != "${NAMED_CREATED_AT}" ]; then
    echo "[verify] FAIL: ${NAMED_REPO} was deleted or re-created by the refused ${what}" >&2
    exit 1
  fi
  squatter_at="$(repo_created_at "${SQUATTER_REPO}")" || return 1
  if [ "${squatter_at}" != "${SQUATTER_CREATED_AT}" ]; then
    echo "[verify] FAIL: the squatter ${SQUATTER_REPO} was deleted or re-created by the refused ${what}" >&2
    exit 1
  fi
  if [ "$(state_repo_id)" != "${NAMED_REPO}" ]; then
    echo "[verify] FAIL: state no longer records Repo as ${NAMED_REPO} after the refused ${what}" >&2
    exit 1
  fi
  generation="$(state_repo_generation)" || return 1
  next="$(state_repo_next_generation)" || return 1
  if [ "${generation}" != "1" ] || [ "${next}" != "${C_GENERATION}" ]; then
    echo "[verify] FAIL: the refused ${what} moved Repo's name generation (now ${generation}, next ${next}; expected 1, next ${C_GENERATION})" >&2
    exit 1
  fi
}

# C1: no flag. The replacement creates first under the new name and refuses
# on the collision — no --replace is needed for a nameless replacement now,
# and none could help, since the old repository never held this name.
set +e
deploy "${LOG_DIR}/c1.log" '' '' --force-stateful-recreation
C1_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/c1.log" || true
assert_squatter_refusal "${LOG_DIR}/c1.log" "${C1_RC}" \
  "Nothing was deleted, and \`cdkd deploy --replace\` would refuse the same way rather than delete it." \
  "the plain nameless deploy"

# C2: --replace. It cannot prove the old repository holds the next
# generation's name, so it deletes nothing either.
set +e
deploy "${LOG_DIR}/c2.log" '' '' --replace --force-stateful-recreation
C2_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/c2.log" || true
assert_squatter_refusal "${LOG_DIR}/c2.log" "${C2_RC}" \
  "--replace was NOT applied and nothing was deleted" \
  "the nameless deploy --replace"

aws ecr delete-repository --repository-name "${SQUATTER_REPO}" --force --region "${REGION}" >/dev/null
assert_gone "the squatter ${SQUATTER_REPO} survived its own delete" \
  aws ecr describe-repositories --repository-names "${SQUATTER_REPO}" --region "${REGION}"
echo "[verify] phase C ok: both deploys refused naming ${SQUATTER_REPO}, ${NAMED_REPO} and the squatter untouched"

# ---------------------------------------------------------------------------
# PHASE D: NEGATIVE CONTROL — a same-name replacement still deletes first
# ---------------------------------------------------------------------------
echo "[verify] phase D: REPO_NAME=${NAMED_REPO} REPO_KMS=true deploy --replace (same-name replacement, MUST SUCCEED)"
deploy "${LOG_DIR}/d.log" "${NAMED_REPO}" true --replace --force-stateful-recreation \
  || { sed 's/^/  /' "${LOG_DIR}/d.log"; echo "[verify] FAIL: the same-name --replace deploy failed — the holder proof refused the genuine holder" >&2; exit 1; }
sed 's/^/  /' "${LOG_DIR}/d.log" || true
if ! grep -qF 'deleting old Repo' "${LOG_DIR}/d.log"; then
  echo "[verify] FAIL: phase D succeeded without the delete-first fallback — it proves nothing about the holder proof" >&2
  exit 1
fi
if [ "$(repo_encryption "${NAMED_REPO}")" != "KMS" ]; then
  echo "[verify] FAIL: ${NAMED_REPO} is not KMS-encrypted after the same-name replacement" >&2
  exit 1
fi
# Assigned first: a failed read here stops the run under `set -e`, where a
# `$( )` inside the test would read as an empty, different value.
D_CREATED_AT="$(repo_created_at "${NAMED_REPO}")"
if [ "${D_CREATED_AT}" = "${NAMED_CREATED_AT}" ]; then
  echo "[verify] FAIL: ${NAMED_REPO} keeps its old createdAt — it was not re-created" >&2
  exit 1
fi
echo "[verify] phase D ok: the genuine holder was deleted first and re-created"

# ---------------------------------------------------------------------------
# PHASE E: destroy
# ---------------------------------------------------------------------------
echo "[verify] phase E: destroy ${STACK}"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "repository ${NAMED_REPO} still exists after destroy" \
  aws ecr describe-repositories --repository-names "${NAMED_REPO}" --region "${REGION}"
assert_gone "repository ${GENERATED_REPO} still exists after destroy" \
  aws ecr describe-repositories --repository-names "${GENERATED_REPO}" --region "${REGION}"
assert_gone "repository ${SQUATTER_REPO} still exists after destroy" \
  aws ecr describe-repositories --repository-names "${SQUATTER_REPO}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS — a nameless replacement (plain and --replace) refused a squatter on its next-generation name, and --replace kept the genuine same-name delete-first"
