#!/usr/bin/env bash
# verify.sh -- an un-named resource gets the same generated name on the SDK
# provider and Cloud Control routes (issue #5095).
#
# `AWS::CodeCommit::Repository` requires `RepositoryName` in its CloudFormation
# schema, and before #5095 only its SDK provider generated one: a Cloud Control
# create of the un-named repository failed. Phases:
#   1. deploy on the SDK provider: the repository is named
#      `{stack}-Repo-{suffix}` from state's stackInstanceId and the record's
#      nameGeneration;
#   2. `--recreate-via-cc-api Repo` (with --force-stateful-recreation, a
#      repository is stateful): the Cloud Control create succeeds and the
#      repository it creates carries the same formula's name, read again from
#      state; on a pre-fix tree this phase FAILS (the create has no name);
#   3. destroy: no repository of this stack is left.

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

STACK="CdkdCcRequiredNameGenerationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOGICAL="Repo"
# CreateRepository: 1-100 characters.
MAX_LENGTH=100
REPO_PREFIX="${STACK}-${LOGICAL}-"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Every repository of this stack's un-named Repo, by its generated-name prefix.
stack_repos() { # usage: stack_repos -- names, one per line, or a hard failure
  # The prefix EXACTLY: it ends at the `-` before the suffix, and an empty or
  # other value would widen the sweep below.
  case "${REPO_PREFIX}" in
    CdkdCcRequiredNameGenerationExample-Repo-) ;;
    *) echo "WARN: teardown sweep refused: unexpected prefix '${REPO_PREFIX}'" >&2; return 1 ;;
  esac
  local listed
  listed="$(aws codecommit list-repositories --region "${REGION}" \
    --query 'repositories[].repositoryName' --output text)" || return 1
  printf '%s\n' "${listed}" | tr '\t' '\n' | awk -v p="${REPO_PREFIX}" 'index($0, p) == 1'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  for repo in $(stack_repos); do
    case "${repo}" in
      "${REPO_PREFIX}"?*) aws codecommit delete-repository --repository-name "${repo}" --region "${REGION}" >/dev/null 2>&1 || true ;;
    esac
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}
# The name cdkd generates for the un-named Repo (go-to-k/cdkd#5064): the
# `{stack}-{logicalId}` part cut to maxLength - 13, then `-` and the first 12
# hex of sha256(id NUL logicalId), with NUL and the generation appended for a
# generation past 0. The id is read from the raw record and never printed.
expected_name() { # usage: expected_name -- from state's id and the record's generation
  local id generation
  id="$(state_field '.stackInstanceId // ""')" || return 1
  [ -n "${id}" ] || { echo "FAIL: the stack's record carries no stackInstanceId" >&2; return 1; }
  generation="$(state_field ".resources.${LOGICAL}.nameGeneration // 0")" || return 1
  [ -n "${generation}" ] || { echo "FAIL: ${LOGICAL}'s nameGeneration could not be read" >&2; return 1; }
  ID="${id}" node -e '
    const [stack, logical, max, generation] = process.argv.slice(1);
    const hash = require("crypto").createHash("sha256")
      .update(process.env.ID).update("\u0000").update(logical);
    if (generation !== "0") hash.update("\u0000").update(generation);
    const suffix = hash.digest("hex").slice(0, 12);
    const base = `${stack}-${logical}`.slice(0, Number(max) - 13).replace(/-+$/, "");
    process.stdout.write(`${base}-${suffix}`);
  ' "${STACK}" "${LOGICAL}" "${MAX_LENGTH}" "${generation}"
}
repo_id() { # usage: repo_id <name> -- its repositoryId, or a hard failure
  aws codecommit get-repository --repository-name "$1" --region "${REGION}" \
    --query 'repositoryMetadata.repositoryId' --output text
}

echo "==> Phase 1: deploy (SDK provider)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ROUTE="$(state_field ".resources.${LOGICAL}.provisionedBy // \"sdk\"")"
[ "${ROUTE}" != "cc-api" ] || { echo "FAIL: phase 1 premise: ${LOGICAL} was created on Cloud Control" >&2; exit 1; }
SDK_NAME="$(expected_name)"
[ -n "${SDK_NAME}" ] || { echo "FAIL: phase 1: empty expected name" >&2; exit 1; }
RECORDED="$(state_field ".resources.${LOGICAL}.physicalId // \"\"")"
[ "${RECORDED}" = "${SDK_NAME}" ] || {
  echo "FAIL: phase 1: the SDK provider named the repository '${RECORDED}', not '${SDK_NAME}'" >&2
  exit 1
}
SDK_REPO_ID="$(repo_id "${SDK_NAME}")" || { echo "FAIL: phase 1: no repository named '${SDK_NAME}'" >&2; exit 1; }
[ -n "${SDK_REPO_ID}" ] || { echo "FAIL: phase 1: empty repository id for '${SDK_NAME}'" >&2; exit 1; }
echo "    OK: the SDK provider created ${SDK_NAME}"

echo "==> Phase 2: --recreate-via-cc-api ${LOGICAL} (the Cloud Control create of an un-named repository)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --recreate-via-cc-api "${LOGICAL}" --force-stateful-recreation --yes || {
  echo "FAIL: phase 2: the Cloud Control create of the un-named repository failed (go-to-k/cdkd#5095: it needs the generated RepositoryName)" >&2
  exit 1
}

ROUTE="$(state_field ".resources.${LOGICAL}.provisionedBy // \"\"")"
[ "${ROUTE}" = "cc-api" ] || { echo "FAIL: phase 2 premise: ${LOGICAL} is recorded on '${ROUTE}', not cc-api" >&2; exit 1; }
CC_NAME="$(expected_name)"
[ -n "${CC_NAME}" ] || { echo "FAIL: phase 2: empty expected name" >&2; exit 1; }
CC_PHYSICAL="$(state_field ".resources.${LOGICAL}.physicalId // \"\"")"
[ -n "${CC_PHYSICAL}" ] || { echo "FAIL: phase 2: no recorded physical id" >&2; exit 1; }
# Cloud Control records the repository id; the repository under the formula's
# name must be that one.
CC_REPO_ID="$(repo_id "${CC_NAME}")" || {
  echo "FAIL: phase 2: no repository named '${CC_NAME}' (the SDK provider's formula) after the Cloud Control create" >&2
  stack_repos >&2
  exit 1
}
[ "${CC_REPO_ID}" = "${CC_PHYSICAL}" ] || {
  echo "FAIL: phase 2: state records repository id '${CC_PHYSICAL}', but '${CC_NAME}' is '${CC_REPO_ID}'" >&2
  exit 1
}
# A NEW repository: phase 1's surviving under an unchanged name would match too.
[ "${CC_REPO_ID}" != "${SDK_REPO_ID}" ] || {
  echo "FAIL: phase 2: '${CC_NAME}' is still phase 1's repository (${SDK_REPO_ID}); Cloud Control created nothing" >&2
  exit 1
}
if [ "${CC_NAME}" != "${SDK_NAME}" ]; then
  assert_gone "phase 2: the SDK-created repository ${SDK_NAME} survived the recreate" \
    aws codecommit get-repository --repository-name "${SDK_NAME}" --region "${REGION}"
fi
echo "    OK: Cloud Control created ${CC_NAME}, the SDK provider's formula"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "repository ${CC_NAME} still exists after destroy" \
  aws codecommit get-repository --repository-name "${CC_NAME}" --region "${REGION}"
LEFT="$(stack_repos)"
[ -z "${LEFT}" ] || { echo "FAIL: repositories of this stack left after destroy: ${LEFT}" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: nothing left"

echo ""
echo "[verify] PASS — the Cloud Control create of an un-named CodeCommit repository got the SDK provider's generated name"
