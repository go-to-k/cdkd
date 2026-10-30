#!/usr/bin/env bash
# verify.sh — cdkd in-place UPDATE of an IAM role whose user-supplied name
# starts with the stack name (`${stackName}-role`).
#
# Regression for the `--no-prefix-user-supplied-names` migration-check false
# positive: the check blindly stripped the `${stackName}-` prefix from the
# recorded physicalId, mis-predicted a rename (`MyStack-role` -> `role`), and
# raised a spurious REPLACEMENT confirm prompt that BLOCKED every routine
# in-place UPDATE in non-interactive runs. Post-fix the check only flags a
# genuine legacy auto-prefix (`physicalId === ${stackName}-${userName}`), so a
# verbatim user name that merely starts with the stack name is left alone.
#
# Phases (the first three deploys intentionally omit -y — the absence of an
# auto-confirm flag is the regression guard: pre-fix Phase 2 hard-fails with
# the migration prompt's non-interactive error; post-fix it succeeds with no
# prompt):
#   1. Deploy baseline (role with 1 inline-policy statement). Capture RoleId.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds a 2nd statement) — an in-place
#      IAM update. Assert it succeeds WITHOUT -y, the RoleId is UNCHANGED (no
#      replacement), and the new statement reached AWS.
#   3. Re-deploy with CDKD_TEST_REMOVAL=true (keeps the phase-2 policy, DROPS
#      description + maxSessionDuration — issue #1160 iam-role batch). Assert
#      Description resets to '' (CloudFormation resets it) while
#      MaxSessionDuration is RETAINED at 7200 (CloudFormation keeps it, issue
#      #5004 A/B; IAM UpdateRole merges absent fields and cdkd sends none).
#   4. Re-deploy with CDKD_TEST_ROLE_PATH=true (issues #4739, go-to-k/cdkd#5064):
#      the unnamed PathRole, whose name cdkd generates, moves from `/` to
#      `/cdkd-4739/`. `Path` is createOnly, so this is a REPLACEMENT, and on a
#      stack with a stackInstanceId it creates the new role at the NEXT name
#      generation (1) — a NEW name — FIRST, then deletes the old one. So a
#      plain deploy (no --replace) must SUCCEED: the new role carries the name
#      derived from state.json's stackInstanceId at generation 1, its record
#      says `nameGeneration: 1`, the old role is gone, the function runs as the
#      new ARN, and the DefaultPolicy and the customer managed policy attached
#      by name follow it (go-to-k/cdkd#4461). (Before #5064 phase 2 the same
#      name collided: refused without --replace, delete-first with it.)
#   5. The same deploy again, no flags: the replaced role is stable (same
#      RoleId and name, still generation 1) — no --replace is needed, and
#      nothing replaces it a second time.
#   6. Destroy + assert the roles, the function and cdkd state are gone.
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

STACK="CdkdIamRolePrefixedNameUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="${STACK}-role"
FN_NAME="${STACK}-path-fn"
# cdkd's generated name for the unnamed PathRole: `${STACK}-<logicalId>` (CDK
# suffixes the logical id with a hash) cut to 64 - 13 characters, then `-` and
# the 12-hex stack instance suffix of the record's name generation
# (go-to-k/cdkd#5064). The cut keeps this prefix.
PATH_ROLE_PREFIX="${STACK}-PathRole"
# The customer managed policy attached to PathRole through its own `Roles`.
PATH_MANAGED_NAME="${STACK}-path-managed"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

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

# One field of PathRole's state record (`physicalId`, `nameGeneration`, ...),
# `none` when absent.
path_role_record() { # usage: path_role_record <field>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r --arg k "${PATH_ROLE_LID}" --arg f "$1" '.resources[$k][$f] // "none"'
}

delete_role() {
  for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" \
    --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
}

delete_path_roles() {
  # A destructive prefix sweep: refuse a scope that is empty or wider than this
  # fixture's generated PathRole names.
  case "${PATH_ROLE_PREFIX}" in
    "${STACK}-PathRole") ;;
    *) echo "WARN: teardown sweep refused (unexpected prefix '${PATH_ROLE_PREFIX}')" >&2; return 0 ;;
  esac
  for r in $(aws iam list-roles \
    --query "Roles[?starts_with(RoleName, '${PATH_ROLE_PREFIX}')].RoleName" --output text 2>/dev/null); do
    [ "${r}" = "None" ] && continue
    for p in $(aws iam list-role-policies --role-name "${r}" --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${r}" --policy-name "${p}" >/dev/null 2>&1 || true
    done
    for a in $(aws iam list-attached-role-policies --role-name "${r}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${r}" --policy-arn "${a}" >/dev/null 2>&1 || true
    done
    aws iam delete-role --role-name "${r}" >/dev/null 2>&1 \
      || echo "WARN: could not delete leftover role ${r}; delete it by hand" >&2
  done
}

delete_path_managed_policy() {
  # A destructive delete by name: refuse a name that is empty or not this
  # fixture's own.
  case "${PATH_MANAGED_NAME}" in
    "${STACK}-path-managed") ;;
    *) echo "WARN: teardown sweep refused (unexpected policy name '${PATH_MANAGED_NAME}')" >&2; return 0 ;;
  esac
  local arn
  arn="$(aws iam list-policies --scope Local \
    --query "Policies[?PolicyName=='${PATH_MANAGED_NAME}'].Arn | [0]" --output text 2>/dev/null)" || return 0
  [ -n "${arn}" ] && [ "${arn}" != "None" ] || return 0
  for r in $(aws iam list-entities-for-policy --policy-arn "${arn}" \
    --query 'PolicyRoles[].RoleName' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${r}" --policy-arn "${arn}" >/dev/null 2>&1 || true
  done
  for v in $(aws iam list-policy-versions --policy-arn "${arn}" \
    --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "${arn}" --version-id "${v}" >/dev/null 2>&1 || true
  done
  aws iam delete-policy --policy-arn "${arn}" >/dev/null 2>&1 \
    || echo "WARN: could not delete leftover policy ${PATH_MANAGED_NAME}; delete it by hand" >&2
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_role
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  delete_path_managed_policy
  delete_path_roles
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (NO -y) ---------------------------------
echo "==> Phase 1: deploy baseline role (name starts with stack name)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL -u CDKD_TEST_ROLE_PATH node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
echo "    role created, RoleId=${ROLE_ID_P1}"
DESC_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Description' --output text)"
MAX_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.MaxSessionDuration' --output text)"
if [ "${DESC_P1}" != "cdkd f1160 removal-reset probe" ] || [ "${MAX_P1}" != "7200" ]; then
  echo "FAIL: expected Description='cdkd f1160 removal-reset probe' / MaxSessionDuration=7200 after Phase 1, got '${DESC_P1}' / '${MAX_P1}'" >&2
  exit 1
fi
echo "    description + maxSessionDuration set (7200)"
STMTS_P1="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name own \
  --query 'length(PolicyDocument.Statement)' --output text)"
if [ "${STMTS_P1}" != "1" ]; then
  echo "FAIL: expected 1 inline-policy statement after Phase 1, got ${STMTS_P1}" >&2
  exit 1
fi

# The unnamed PathRole the function runs as, on the default path.
FN_ROLE_P1="$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'Role' --output text)" || exit 1
PATH_ROLE_NAME="${FN_ROLE_P1##*/}"
case "${PATH_ROLE_NAME}" in
  "${PATH_ROLE_PREFIX}"*) ;;
  *) echo "FAIL: ${FN_NAME} runs as '${FN_ROLE_P1}', expected a role named ${PATH_ROLE_PREFIX}*" >&2; exit 1 ;;
esac
ROLE_P1="$(aws iam get-role --role-name "${PATH_ROLE_NAME}" \
  --query '[Role.Path, Role.Arn, Role.RoleId]' --output text)" || exit 1
read -r PATH_P1 PATH_ROLE_ARN_P1 PATH_ROLE_ID_P1 <<<"${ROLE_P1}"
if [ "${PATH_P1}" != "/" ] || [ "${PATH_ROLE_ARN_P1}" != "${FN_ROLE_P1}" ]; then
  echo "FAIL: expected ${PATH_ROLE_NAME} on path / with the function's ARN, got '${PATH_P1}' / '${PATH_ROLE_ARN_P1}' (function: ${FN_ROLE_P1})" >&2
  exit 1
fi
# PathRole's logical id, from the ONE IAM::Role record naming it.
PATH_ROLE_LID="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg n "${PATH_ROLE_NAME}" \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role" and .value.physicalId == $n) | .key]
   | if length == 1 then .[0] else error("expected exactly one AWS::IAM::Role record named \($n), found \(length)") end')" || exit 1
# The derivation phase 4 predicts the replacement's name with must reproduce
# the name cdkd minted at generation 0; a mismatch here is the derivation, not
# the replacement.
PATH_ROLE_SUFFIX_G0="$(state_name_suffix "${PATH_ROLE_LID}" 0)" || exit 1
if [ "${PATH_ROLE_NAME##*-}" != "${PATH_ROLE_SUFFIX_G0}" ] || [ "$(path_role_record nameGeneration)" != "none" ]; then
  echo "FAIL: ${PATH_ROLE_NAME} is not ${PATH_ROLE_LID}'s generation-0 name (suffix derived from state.json's stackInstanceId: ${PATH_ROLE_SUFFIX_G0}; recorded nameGeneration: $(path_role_record nameGeneration))" >&2
  exit 1
fi
# What is attached to the role by name from the outside, which Phase 4's
# replacement must move onto the new role: the DefaultPolicy (a separate
# AWS::IAM::Policy) and the customer managed policy whose `Roles` names the role.
assert_path_role_attachments() { # usage: assert_path_role_attachments <phase>
  local inline managed
  inline="$(aws iam list-role-policies --role-name "${PATH_ROLE_NAME}" \
    --query "PolicyNames[?starts_with(@, 'PathRoleDefaultPolicy')] | length(@)" --output text)" || return 1
  managed="$(aws iam list-attached-role-policies --role-name "${PATH_ROLE_NAME}" \
    --query "AttachedPolicies[?PolicyName=='${PATH_MANAGED_NAME}'] | length(@)" --output text)" || return 1
  if [ "${inline}" != "1" ] || [ "${managed}" != "1" ]; then
    echo "FAIL ($1): ${PATH_ROLE_NAME} has ${inline} PathRoleDefaultPolicy* inline / ${managed} ${PATH_MANAGED_NAME} attached, expected 1 / 1" >&2
    exit 1
  fi
}
assert_path_role_attachments "Phase 1"
echo "    ${FN_NAME} runs as ${PATH_ROLE_NAME} on path /, with its DefaultPolicy and ${PATH_MANAGED_NAME}"

# --- Phase 2: in-place UPDATE (NO -y — regression guard) --------------
echo "==> Phase 2: re-deploy adding an inline-policy statement (in-place, NO -y)"
# Pre-fix this hard-fails: "--no-prefix-user-supplied-names migration confirm
# prompt cannot run in a non-interactive environment. Pass --yes ...".
env -u CDKD_TEST_REMOVAL -u CDKD_TEST_ROLE_PATH CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P2="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ "${ROLE_ID_P1}" != "${ROLE_ID_P2}" ]; then
  echo "FAIL: role was REPLACED (RoleId ${ROLE_ID_P1} -> ${ROLE_ID_P2})" >&2
  exit 1
fi
echo "    role identity preserved (RoleId unchanged) — no replacement"

STMTS_P2="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name own \
  --query 'length(PolicyDocument.Statement)' --output text)"
if [ "${STMTS_P2}" != "2" ]; then
  echo "FAIL: expected 2 inline-policy statements after the in-place UPDATE, got ${STMTS_P2}" >&2
  exit 1
fi
echo "    in-place UPDATE reached AWS (inline policy now has 2 statements), no migration prompt"

# --- Phase 3: removal-reset (issue #1160 iam-role batch) ----------------
echo "==> Phase 3: re-deploy dropping description + maxSessionDuration (description reset, maxSessionDuration retained)"
env -u CDKD_TEST_ROLE_PATH CDKD_TEST_REMOVAL=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P3="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ "${ROLE_ID_P1}" != "${ROLE_ID_P3}" ]; then
  echo "FAIL: role was REPLACED during the removal redeploy (RoleId ${ROLE_ID_P1} -> ${ROLE_ID_P3})" >&2
  exit 1
fi
# Cleared Description comes back as absent (text output 'None'); MaxSessionDuration
# must still be the phase-1 7200: CloudFormation keeps it on removal (issue
# #5004 A/B), so cdkd must not reset it to 3600.
DESC_P3="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Description' --output text)"
MAX_P3="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.MaxSessionDuration' --output text)"
if { [ "${DESC_P3}" != "None" ] && [ -n "${DESC_P3}" ]; } || [ "${MAX_P3}" != "7200" ]; then
  echo "FAIL: expected Description cleared / MaxSessionDuration retained at 7200 after removal redeploy, got '${DESC_P3}' / '${MAX_P3}'" >&2
  exit 1
fi
echo "    removal reset reached AWS (description cleared, maxSessionDuration retained at 7200), role identity preserved"

# --- Phase 4: Path change replaces PathRole create-first, under a new name --
# Issues #4739 and go-to-k/cdkd#5064 phase 2. The replacement's name is
# PREDICTED before the deploy: the generation-0 name's base (everything before
# its 12-hex suffix) plus the generation-1 suffix derived from state.json.
PATH_ROLE_NAME_G0="${PATH_ROLE_NAME}"
PATH_ROLE_SUFFIX_G1="$(state_name_suffix "${PATH_ROLE_LID}" 1)" || exit 1
PATH_ROLE_NAME_G1="${PATH_ROLE_NAME_G0%-*}-${PATH_ROLE_SUFFIX_G1}"
if [ "${PATH_ROLE_NAME_G1}" = "${PATH_ROLE_NAME_G0}" ]; then
  echo "FAIL: generation 1's name equals generation 0's (${PATH_ROLE_NAME_G0}) — the derivation is wrong" >&2
  exit 1
fi
if ! gone_probe aws iam get-role --role-name "${PATH_ROLE_NAME_G1}"; then
  echo "FAIL: ${PATH_ROLE_NAME_G1} exists before the replacement that should create it" >&2
  exit 1
fi
echo "==> Phase 4: re-deploy moving ${PATH_ROLE_NAME_G0} to /cdkd-4739/ (no --replace) — replaced create-first as ${PATH_ROLE_NAME_G1}"
# Pre-#5064-phase-2 this was REFUSED (the same generated name collided), and
# before #4739 it failed from the provider's in-place update. A plain deploy
# must now succeed; no --replace is passed.
CDKD_TEST_ROLE_PATH=true CDKD_TEST_REMOVAL=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ "$(path_role_record physicalId)" != "${PATH_ROLE_NAME_G1}" ] || [ "$(path_role_record nameGeneration)" != "1" ]; then
  echo "FAIL: state records ${PATH_ROLE_LID} as '$(path_role_record physicalId)' at nameGeneration '$(path_role_record nameGeneration)', expected ${PATH_ROLE_NAME_G1} at 1" >&2
  exit 1
fi
assert_gone "the replaced role ${PATH_ROLE_NAME_G0} still exists after the replacement" \
  aws iam get-role --role-name "${PATH_ROLE_NAME_G0}"
PATH_ROLE_NAME="${PATH_ROLE_NAME_G1}"
ROLE_P4="$(aws iam get-role --role-name "${PATH_ROLE_NAME}" \
  --query '[Role.Path, Role.Arn, Role.RoleId]' --output text)" || exit 1
read -r PATH_P4 PATH_ROLE_ARN_P4 PATH_ROLE_ID_P4 <<<"${ROLE_P4}"
if [ "${PATH_P4}" != "/cdkd-4739/" ]; then
  echo "FAIL: expected ${PATH_ROLE_NAME} on path /cdkd-4739/ after the replacement, got '${PATH_P4}'" >&2
  exit 1
fi
if [ "${PATH_ROLE_ID_P4}" = "${PATH_ROLE_ID_P1}" ]; then
  echo "FAIL: ${PATH_ROLE_NAME} carries the old RoleId ${PATH_ROLE_ID_P1}: it was not created anew" >&2
  exit 1
fi
case "${PATH_ROLE_ARN_P4}" in
  *":role/cdkd-4739/${PATH_ROLE_NAME}") ;;
  *) echo "FAIL: the new role's ARN '${PATH_ROLE_ARN_P4}' does not carry the new path and name" >&2; exit 1 ;;
esac
FN_ROLE_P4="$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'Role' --output text)" || exit 1
if [ "${FN_ROLE_P4}" != "${PATH_ROLE_ARN_P4}" ]; then
  echo "FAIL: ${FN_NAME} runs as '${FN_ROLE_P4}', expected the new role '${PATH_ROLE_ARN_P4}'" >&2
  exit 1
fi
assert_path_role_attachments "Phase 4"
echo "    ${PATH_ROLE_NAME_G0} replaced by ${PATH_ROLE_NAME} on /cdkd-4739/ (RoleId ${PATH_ROLE_ID_P1} -> ${PATH_ROLE_ID_P4}, nameGeneration 1); ${FN_NAME} runs as the new ARN"

# --- Phase 5: the same deploy again — the replaced role is stable -----------
echo "==> Phase 5: the same deploy again, no flags (no --replace needed; nothing replaced twice)"
CDKD_TEST_ROLE_PATH=true CDKD_TEST_REMOVAL=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PATH_ROLE_ID_P5="$(aws iam get-role --role-name "${PATH_ROLE_NAME}" --query 'Role.RoleId' --output text)" || exit 1
FN_ROLE_P5="$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'Role' --output text)" || exit 1
if [ "${PATH_ROLE_ID_P5}" != "${PATH_ROLE_ID_P4}" ] || [ "${FN_ROLE_P5}" != "${PATH_ROLE_ARN_P4}" ]; then
  echo "FAIL: the repeat deploy replaced ${PATH_ROLE_NAME} again (RoleId ${PATH_ROLE_ID_P4} -> ${PATH_ROLE_ID_P5}, function role '${FN_ROLE_P5}')" >&2
  exit 1
fi
if [ "$(path_role_record physicalId)" != "${PATH_ROLE_NAME}" ] || [ "$(path_role_record nameGeneration)" != "1" ]; then
  echo "FAIL: the repeat deploy moved ${PATH_ROLE_LID}'s record off ${PATH_ROLE_NAME} at nameGeneration 1" >&2
  exit 1
fi
echo "    ${PATH_ROLE_NAME} unchanged (RoleId ${PATH_ROLE_ID_P5}, nameGeneration 1)"

# --- Phase 6: destroy --------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
echo "    role deleted"
assert_gone "role ${PATH_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${PATH_ROLE_NAME}"
assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" || exit 1
assert_gone "policy ${PATH_MANAGED_NAME} still exists after destroy" aws iam get-policy \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${PATH_MANAGED_NAME}"
echo "    path role + function + ${PATH_MANAGED_NAME} deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — in-place UPDATE of an IAM role whose name starts with the stack name is NOT blocked by a spurious prefix-migration replacement prompt; a Path change on an unnamed role replaces it create-first under its generation-1 name with no --replace"
