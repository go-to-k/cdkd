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
#   A. Deploy nameless: cdkd generates the name G (captured from state).
#   B. REPO_NAME=N deploy: a replacement to the explicit name N; G is deleted.
#   C. THE ARM. Create a squatter repository under G out of band, then deploy
#      nameless again with --replace. The create sends G and collides with the
#      squatter. The deploy must FAIL naming G, delete NOTHING (N keeps its
#      createdAt, the squatter survives, state still records N). Before the
#      fix N was deleted.
#   D. NEGATIVE CONTROL. Remove the squatter, then REPO_NAME=N REPO_KMS=true
#      deploy --replace: a replacement KEEPING the name, whose create collides
#      with N itself. N provably holds it, so delete-first must still run and
#      the deploy succeed (N re-created with KMS encryption).
#   E. Destroy; N, G and the state file are gone.
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
# What cdkd generates for the nameless `Repo` of this stack: the name every
# phase's squatter and sweep use. Phase A asserts the live name EQUALS it, so a
# drift in the generation fails loudly instead of aiming the squatter elsewhere.
GENERATED_REPO="$(printf '%s' "${STACK}-Repo" | tr '[:upper:]' '[:lower:]')"

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

cleanup() {
  rc=$?
  echo "[verify] cleanup (rc=${rc})"
  (
  set +eu
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
    --region "${REGION}" --yes >/dev/null 2>&1 || true
  delete_repo_best_effort "${NAMED_REPO}"
  delete_repo_best_effort "${GENERATED_REPO}"
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
for name in "${NAMED_REPO}" "${GENERATED_REPO}"; do
  if ! gone_probe aws ecr describe-repositories --repository-names "${name}" --region "${REGION}"; then
    echo "[verify] FAIL: repository ${name} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
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
if [ "${A_ID}" != "${GENERATED_REPO}" ]; then
  echo "[verify] FAIL: state records Repo as '${A_ID}', expected the generated '${GENERATED_REPO}'" >&2
  exit 1
fi
repo_created_at "${GENERATED_REPO}" >/dev/null
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
echo "[verify] phase B ok: ${NAMED_REPO} is the stack's repository, ${GENERATED_REPO} deleted"

# ---------------------------------------------------------------------------
# PHASE C: THE ARM — a squatter on the generated name
# ---------------------------------------------------------------------------
echo "[verify] phase C: squatter ${GENERATED_REPO} out of band, then a nameless deploy --replace (expect REFUSAL)"
NAMED_CREATED_AT="$(repo_created_at "${NAMED_REPO}")"
aws ecr create-repository --repository-name "${GENERATED_REPO}" --region "${REGION}" >/dev/null
SQUATTER_CREATED_AT="$(repo_created_at "${GENERATED_REPO}")"
set +e
deploy "${LOG_DIR}/c.log" '' '' --replace --force-stateful-recreation
C_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/c.log" || true
if [ "${C_RC}" -eq 0 ]; then
  echo "[verify] FAIL: deploy --replace SUCCEEDED over a squatter on ${GENERATED_REPO}" >&2
  exit 1
fi
# The parsed marker names the SENT name; the sentinel is the refusal's own
# closing clause, independent of it. Sentinel without marker = the wording
# drifted or a different name was sent — never read as "no refusal".
C_SENTINEL="--replace was NOT applied and nothing was deleted"
C_MARKER="cdkd's rule generates RepositoryName \"${GENERATED_REPO}\""
if ! grep -qF -- "${C_SENTINEL}" "${LOG_DIR}/c.log"; then
  echo "[verify] FAIL: deploy --replace exited ${C_RC} without the #3979 holder refusal (output above)" >&2
  exit 1
fi
if ! grep -F -- "${C_SENTINEL}" "${LOG_DIR}/c.log" | grep -qF -- "${C_MARKER}"; then
  echo "[verify] FAIL: the refusal is present but does not name the sent ${GENERATED_REPO} (wording drifted, or a different name was sent):" >&2
  grep -F -- "${C_SENTINEL}" "${LOG_DIR}/c.log" | sed 's/^/  /' >&2
  exit 1
fi
if grep -qF 'deleting old Repo' "${LOG_DIR}/c.log"; then
  echo "[verify] FAIL: the --replace delete-first engaged for the squatter's collision" >&2
  exit 1
fi
C_NAMED_AT="$(repo_created_at "${NAMED_REPO}")"
if [ "${C_NAMED_AT}" != "${NAMED_CREATED_AT}" ]; then
  echo "[verify] FAIL: ${NAMED_REPO} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
C_SQUATTER_AT="$(repo_created_at "${GENERATED_REPO}")"
if [ "${C_SQUATTER_AT}" != "${SQUATTER_CREATED_AT}" ]; then
  echo "[verify] FAIL: the squatter ${GENERATED_REPO} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_repo_id)" != "${NAMED_REPO}" ]; then
  echo "[verify] FAIL: state no longer records Repo as ${NAMED_REPO} after the refused deploy" >&2
  exit 1
fi
aws ecr delete-repository --repository-name "${GENERATED_REPO}" --force --region "${REGION}" >/dev/null
assert_gone "the squatter ${GENERATED_REPO} survived its own delete" \
  aws ecr describe-repositories --repository-names "${GENERATED_REPO}" --region "${REGION}"
echo "[verify] phase C ok: refused naming ${GENERATED_REPO}, ${NAMED_REPO} and the squatter untouched"

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
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS — deploy --replace refused a squatter's collision and kept the genuine same-name delete-first"
