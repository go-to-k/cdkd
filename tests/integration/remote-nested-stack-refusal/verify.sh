#!/usr/bin/env bash
#
# End-to-end real-AWS test for go-to-k/cdkd#6385: a nested stack with a remote
# TemplateURL is refused before anything is published or provisioned.
#
# The fixture's only nested stack is the one CDK's HostedRotation generates:
# the `AWS::SecretsManager-2024-09-16` transform expands the rotation into an
# `AWS::CloudFormation::Stack` whose TemplateURL is an AWS-hosted Serverless
# Application Repository template. Before the fix the deploy created the
# secret, failed on the nested row with a message about
# Metadata['aws:asset:path'], and rolled the secret back.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. precondition: no secret of the fixture's name exists
#   3. cdkd deploy must exit non-zero with the #6385 refusal, after macro
#      expansion and with no resource created
#   4. no state.json and no lock.json were written
#   5. no secret was created
#
# Wall-clock budget: ~1 min (one macro round-trip; nothing is provisioned).
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdIntegRemoteNested"
# Must match bin/app.ts.
SECRET_NAME="cdkd-integ-remote-nested-${REGION}"
NESTED_ROW="SRotF0CA8387HostedRotationLambda"
SECRET_ROW="S509448A1"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/remote-nested-stack-refusal"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_PREFIX="cdkd/${STACK}/${REGION}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

DEPLOY_LOG="$(mktemp -t cdkd-remote-nested-deploy.XXXXXX.log)"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

list_macro_expand_stacks() {
  aws cloudformation list-stacks --region "${REGION}" \
    --stack-status-filter REVIEW_IN_PROGRESS \
    --query "StackSummaries[?starts_with(StackName,'cdkd-macro-expand-')].StackName" \
    --output text
}

cleanup() {
  rc=$?
  # Best-effort cleanup: tolerate probe errors + unset vars (the handler exits).
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — sweeping anything a regressed deploy created"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    # The resource policy CDK adds denies DeleteSecret; drop it first.
    aws secretsmanager delete-resource-policy --secret-id "${SECRET_NAME}" --region "${REGION}" || true
    aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" --force-delete-without-recovery --region "${REGION}" || true
    # The transient macro-expand stack is deleted by cdkd's expander; sweep
    # one a crash mid-expansion left behind. Only stacks that appeared after
    # the snapshot taken before the deploy: a concurrent macro fixture in this
    # region owns the others. No snapshot, no sweep.
    if [ -n "${MACRO_SNAPSHOT_TAKEN:-}" ]; then
      for orphan in $(list_macro_expand_stacks); do
        case " ${PRE_MACRO_STACKS} " in *" ${orphan} "*) continue ;; esac
        aws cloudformation delete-stack --stack-name "${orphan}" --region "${REGION}" || true
      done
    fi
  fi
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: precondition — no secret named ${SECRET_NAME}"
assert_gone "secret ${SECRET_NAME} exists before the run (a previous run leaked it; force-delete it first)" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"
echo "[verify]   ✓ no secret of that name"

echo "[verify] step 3: cdkd deploy ${STACK} must be refused pre-flight"
# A failed listing leaves no snapshot, so cleanup sweeps nothing.
# `--output text` separates names with TABS; the cleanup's match wants spaces.
PRE_MACRO_STACKS="$(list_macro_expand_stacks | tr '\t\n' '  ')"
MACRO_SNAPSHOT_TAKEN=1
set +e
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
cat "${DEPLOY_LOG}"
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: deploy unexpectedly succeeded"
  exit 1
fi
if ! grep -F "[macros] Expanding CloudFormation macros" "${DEPLOY_LOG}" > /dev/null; then
  echo "[verify] FAIL: expected the macro expansion to run before the refusal"
  exit 1
fi
# The pre-fix path's message; its presence means the nested row reached the
# provider, i.e. the deploy started.
if grep -F "Nested template file not found" "${DEPLOY_LOG}" > /dev/null; then
  echo "[verify] FAIL: the nested row reached NestedStackProvider (refused mid-deploy, not pre-flight)"
  exit 1
fi
for needle in \
  "AWS::CloudFormation::Stack ${NESTED_ROW} in stack ${STACK} has no template in the cloud assembly" \
  "A nested stack with a remote TemplateURL is not supported." \
  "addRotationSchedule's rotationLambda" \
  "Refusing to start the deploy; nothing has been published or provisioned."; do
  if ! grep -F -- "${needle}" "${DEPLOY_LOG}" > /dev/null; then
    echo "[verify] FAIL: refusal text missing: ${needle}"
    exit 1
  fi
done
if grep -E "${SECRET_ROW}.*created|Rolling back" "${DEPLOY_LOG}" > /dev/null; then
  echo "[verify] FAIL: a resource was created (or rolled back) before the refusal"
  exit 1
fi
echo "[verify]   ✓ refused after macro expansion, before any resource"

echo "[verify] step 4: no state.json / lock.json was written"
assert_gone "state written at s3://${STATE_BUCKET}/${STATE_PREFIX}/state.json" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_PREFIX}/state.json"
assert_gone "lock left at s3://${STATE_BUCKET}/${STATE_PREFIX}/lock.json" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_PREFIX}/lock.json"
echo "[verify]   ✓ no state, no lock"

echo "[verify] step 5: no secret was created"
assert_gone "secret ${SECRET_NAME} was created by the refused deploy" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"
echo "[verify]   ✓ no secret"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
echo "[verify] PASS"
