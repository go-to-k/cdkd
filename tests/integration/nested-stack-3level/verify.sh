#!/usr/bin/env bash
# verify.sh — deep (4-level) recursive nested-stack deploy / diff / state-tree /
# destroy-cascade, exercising the `nested-stack-deep-deploy-cascade` scenario.
#
# This fixture is a strictly DEEPER + WIDER + BIDIRECTIONAL superset of the
# existing `nested-stack-deep` fixture (3 levels, 1 resource/level, bottom-up
# Fn::GetAtt only). Here:
#
#   CdkdNestedStack3LevelExample (root, depth=0)
#   ├─ RootTopic   (AWS::SNS::Topic)           -- DOWNWARD ref source
#   ├─ RootRef     (AWS::SSM::Parameter)       -- UP via Fn::GetAtt(Child)
#   └─ Child       (AWS::CloudFormation::Stack, depth=1)
#      ├─ Param    (AWS::SSM::Parameter)       -- UP via Fn::GetAtt(Grandchild)
#      └─ Grandchild (AWS::CloudFormation::Stack, depth=2)
#         ├─ Topic (AWS::SNS::Topic)           -- sibling of the nested node
#         ├─ Param (AWS::SSM::Parameter)       -- UP via GetAtt + sibling topic
#         └─ GreatGrandchild (AWS::CloudFormation::Stack, depth=3)  <-- DEEPER
#            └─ Param (AWS::SSM::Parameter)     -- DOWN via Parameters (root topic)
#
# What this verify.sh asserts that `nested-stack-deep`'s does NOT:
#   - one state file per level at `cdkd/<parent>~<...>~<childLogicalId>/<region>/state.json`,
#     each carrying the correct v6 `parentStack` / `parentLogicalId` fields;
#   - every level's REAL AWS resource (SSM Parameter / SNS Topic) exists post-deploy;
#   - `cdkd state list --tree` renders the full 4-level hierarchy;
#   - the destroy cascade removes every level's AWS resource AND state file.
# It ALSO keeps the `nested-stack-deep` coverage: `cdkd diff --recursive` is
# clean post-deploy, and a deep changed value surfaces under the great-
# grandchild's nested-stack header.
#
#   #3094 - a SECRET through a THREE-level chain. The root hands two SPELLINGS
#           of one secretsmanager reference (`:handoff::` and
#           `:handoff:AWSCURRENT:`, one plaintext) to the child as literal
#           strings; the child forwards them to the grandchild as `{Ref}`;
#           the grandchild consumes each in its own SSM parameter. The child
#           engine's bag holds inherited ENTRIES but no PAIRS, and its own
#           nested-stack row is an INTRINSIC source -- the shape whose
#           per-parameter carry regressed in go-to-k/cdkd#3093's review with
#           no live signal. Each level's record and each grandchild leaf must
#           hold ITS OWN expression (the loser's named, both directions), the
#           live values the plaintext, the tree diff-clean, and every state
#           version swept.
#
#   #3156 - a 2-character secret in each intrinsic frame the sub-floor carry
#           used to REFUSE, on a SEPARATE branch (root -> Framed ->
#           FramedGrandchild) whose middle owns nothing but its nested-stack
#           row: `MidPinSsm` spells an `ssm` SecureString token with the
#           account `Ref` inside it, `MidPinOut` a secretsmanager token with
#           the region `Ref` OUTSIDE it. The middle hands each down PASS-THROUGH
#           (`{Ref}`) and RE-WRAPPED (`m-` + the `Ref`). The root row, the
#           middle row and every grandchild leaf must hold the framed
#           EXPRESSION, the grandchild's parameter and `Ref` debug lines must
#           be present and masked whole, and no line may carry a framed
#           plaintext (its `Fn::Join` lines included). Before the fix the root
#           row kept `MidPinOut` in plaintext, and the middle row and the
#           grandchild kept both.
#
#   #3306 - the same SecureString in the three frames the #3156 fix still
#           refused, on the same branch and handed down PASS-THROUGH:
#           `MidPinNest` holds its token inside a nested `Fn::Sub` part,
#           `MidPinVar` in a used `Fn::Sub` string variable, `MidPinIf` inside
#           an `Fn::If` around the frame. The same records and lines are
#           asserted for each.
#
#   #4094 - `cdkd diff --recursive` resolves a nested row's `Parameters`
#           against the parent's BOUND parameters and evaluated conditions:
#           the child's description reads the root's `Stage4094` Default, and
#           `MidPinIf`'s condition is the root's. Step 4 stays clean.
#
#   #1989 - a DELETE the great-grandchild skips (an injected state record)
#           reaches the ROOT's `Skipped (not deleted)` row, verdict line and
#           exit 2 through three nested-stack hops (Step 4c).
#   #4453 - an UNCHANGED redeploy re-attempts that kept DELETE and exits 2
#           again; once it is gone the markers clear and a redeploy is quiet.
#
# Run via: /run-integ nested-stack-3level
#         or: bash tests/integration/nested-stack-3level/verify.sh

set -euo pipefail
export AWS_PAGER=""

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

# Shared S3 VERSION-sweep helpers (issue #2096): the state bucket is VERSIONED,
# and this fixture now seeds a secret whose plaintext must not outlive the run
# in any state.json version of any level.
. ../s3-versions.sh

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

STACK="CdkdNestedStack3LevelExample"
CHILD="${STACK}~Child"
GRANDCHILD="${STACK}~Child~Grandchild"
GREATGRANDCHILD="${STACK}~Child~Grandchild~GreatGrandchild"
FRAMED="${STACK}~Framed"
FRAMED_GC="${STACK}~Framed~FramedGrandchild"
CHANGED_VALUE="cdkd-3level-ggc-CHANGED"
LEVELS=("${STACK}" "${CHILD}" "${GRANDCHILD}" "${GREATGRANDCHILD}" "${FRAMED}" "${FRAMED_GC}")

# The #3094 secret. Created OUT OF BAND (cdkd never manages it); the name is
# kept in sync with `lib/nested-stack-3level.ts`. The plaintext is UNUSUAL on
# purpose: every "appears nowhere" grep below would otherwise collide with
# ordinary state text.
SECRET_NAME="cdkd-3level-secret-${ACCOUNT_ID}"
HANDOFF_PW_VALUE="h4ndoff-3level-pl4intext-3094"
HANDOFF_EXPR_A="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:handoff::}}"
HANDOFF_EXPR_B="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:handoff:AWSCURRENT:}}"

# The #3156 arm. Two 2-character secrets, each in a frame kept in sync with
# `lib/nested-stack-3level.ts`: the `pin` key of the secret above, and an
# out-of-band SecureString parameter. Their bare values are ungreppable, so
# every scan greps the FRAMED plaintext instead.
PIN_SSM_PARAM_NAME="cdkd-3level-pinssm-${ACCOUNT_ID}"
PIN_SSM_VALUE="Jx"
PIN_OUT_VALUE="Zq"
PIN_SSM_FRAMED="pin3156s:${PIN_SSM_VALUE}"
PIN_OUT_FRAMED="pin3156o:${PIN_OUT_VALUE}@${AWS_REGION}"
PIN_SSM_EXPR="pin3156s:{{resolve:ssm:${PIN_SSM_PARAM_NAME}}}"
PIN_OUT_EXPR="pin3156o:{{resolve:secretsmanager:${SECRET_NAME}:SecretString:pin}}@${AWS_REGION}"
# The #3306 arm: the ssm secret in three more frames, each its own prefix so
# no two share a value (the carry records one frame per value in a row).
PIN_NEST_FRAMED="pin3306n:${PIN_SSM_VALUE}"
PIN_VAR_FRAMED="pin3306v:${PIN_SSM_VALUE}"
PIN_IF_FRAMED="pin3306i:${PIN_SSM_VALUE}"
PIN_NEST_EXPR="pin3306n:{{resolve:ssm:${PIN_SSM_PARAM_NAME}}}"
PIN_VAR_EXPR="pin3306v:{{resolve:ssm:${PIN_SSM_PARAM_NAME}}}"
PIN_IF_EXPR="pin3306i:{{resolve:ssm:${PIN_SSM_PARAM_NAME}}}"
FRAMED_PLAINTEXTS=("${PIN_SSM_FRAMED}" "${PIN_OUT_FRAMED}" "${PIN_NEST_FRAMED}" "${PIN_VAR_FRAMED}" "${PIN_IF_FRAMED}")
for v in "${PIN_SSM_VALUE}" "${PIN_OUT_VALUE}"; do
  if [[ -z "${v}" || ${#v} -ge 4 ]]; then
    echo "FAIL: premise: a #3156 secret must be 1-3 characters, or the needle mask covers it and the arm tests nothing" >&2
    exit 1
  fi
done
if [[ "${PIN_SSM_VALUE}" == "${PIN_OUT_VALUE}" ]]; then
  echo "FAIL: premise: the two #3156 secrets must differ, or one frame's entry masks the other and that half is vacuous" >&2
  exit 1
fi

# The #4543 arm. The child's `W1Script` holds the base64 of a script joining
# the root-passed `Input4543` and the `w1` key of the secret above; both names
# are kept in sync with `lib/nested-stack-3level.ts`. Every scan covers the
# plaintext AND both encodings of the script, which decode to it.
W1_PARAM_NAME="cdkd-3level-w1-${ACCOUNT_ID}"
W1_PW_VALUE="w1nput-3level-pl4intext-4543"
w1_script() { printf '#!/bin/bash\nINPUT=%s\nPW=%s\n' "$1" "${W1_PW_VALUE}"; }
W1_ONE_B64=$(w1_script one | base64 | tr -d '\n')
W1_TWO_B64=$(w1_script two | base64 | tr -d '\n')
if [[ -z "${W1_ONE_B64}" || -z "${W1_TWO_B64}" || "${W1_ONE_B64}" == "${W1_TWO_B64}" ]] \
  || [[ "$(printf '%s' "${W1_TWO_B64}" | base64 --decode)" != "$(w1_script two)" ]]; then
  echo "FAIL: premise: could not derive two distinct, round-tripping encodings of the #4543 script -- the arm would be vacuous" >&2
  exit 1
fi
W1_PLAINTEXTS=("${W1_PW_VALUE}" "${W1_ONE_B64}" "${W1_TWO_B64}")

# Collected physical ids (filled during the post-deploy state read) so the
# post-destroy sweep can confirm each one is gone on AWS.
SSM_PARAM_NAMES=()
SNS_TOPIC_ARNS=()

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  remove_injected_1989 >/dev/null 2>&1 || true
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${AWS_REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PIN_SSM_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
  # The #4543 arm's fixed-name parameter holds the base64 of a script carrying
  # the w1 plaintext: swept here in case a destroy left it standing.
  aws ssm delete-parameter --name "${W1_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
  # NONCURRENT-only here: this runs from the failure / INT / TERM traps, where
  # a live state.json may be the only record of standing resources. The
  # success path below does the full sweep once the cascade is asserted.
  local lvl
  for lvl in "${LEVELS[@]}"; do
    s3_purge_prefix_versions "${STATE_BUCKET}" "$(s3_stack_prefix "${lvl}" "${AWS_REGION}")" noncurrent || true
  done
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# state_key_uri <stackName> -> the s3 URI of that level's state.json
state_key_uri() {
  echo "s3://${STATE_BUCKET}/cdkd/$1/${AWS_REGION}/state.json"
}

# fetch_state <stackName> -> prints the state JSON to stdout (fails if absent)
fetch_state() {
  aws s3 cp "$(state_key_uri "$1")" - 2>/dev/null
}

# Step 4c (#1989): add / remove a record the great-grandchild's template does
# not declare. Defined up here so `cleanup` can always remove it: a destroy
# would SKIP the record too, keep that level's state and fail the teardown.
INJECTED_1989="Cdkd1989Injected"
# write_ggc_state_1989 <json>: refuses an EMPTY document. A failed `jq` piped
# straight into `aws s3 cp -` would upload empty stdin over the level's
# state.json (pipefail changes only the status), orphaning every resource it
# records, cleanup's destroy included.
write_ggc_state_1989() {
  [[ -n "$1" ]] || { echo "refusing to write an empty ${GREATGRANDCHILD} state.json" >&2; return 1; }
  aws s3 cp - "$(state_key_uri "${GREATGRANDCHILD}")" >/dev/null <<<"$1" || return 1
}
inject_1989() {
  local ggc_json new_json
  ggc_json=$(fetch_state "${GREATGRANDCHILD}") || return 1
  [[ -n "${ggc_json}" ]] || return 1
  new_json=$(jq --arg id "${INJECTED_1989}" '.resources[$id] = {
      physicalId: "cdkd-1989-not-composite",
      resourceType: "AWS::AppSync::Resolver",
      properties: {},
      attributes: {},
      dependencies: [],
      provisionedBy: "sdk"
    }' <<<"${ggc_json}") || return 1
  write_ggc_state_1989 "${new_json}" || return 1
}
remove_injected_1989() {
  local ggc_json new_json
  ggc_json=$(fetch_state "${GREATGRANDCHILD}") || return 1
  [[ -n "${ggc_json}" ]] || return 1
  new_json=$(jq --arg id "${INJECTED_1989}" 'del(.resources[$id])' <<<"${ggc_json}") || return 1
  write_ggc_state_1989 "${new_json}" || return 1
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo ""
echo "==> Building cdkd"
(cd ../../.. && vp run build) >/dev/null

# --------------------------------------------------------------------
# Step 0: the out-of-band secret the #3094 arm hands down.
# --------------------------------------------------------------------
echo ""
echo "==> Step 0: create the out-of-band secret ${SECRET_NAME}"
aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
  --force-delete-without-recovery --region "${AWS_REGION}" >/dev/null 2>&1 || true
# A force-delete is asynchronous; a secret a KILLED prior run left behind can
# still be "scheduled for deletion" for a few seconds, so the create retries.
created=0
create_err=""
for attempt in 1 2 3 4 5 6; do
  if create_err=$(aws secretsmanager create-secret --name "${SECRET_NAME}" \
       --secret-string "{\"handoff\":\"${HANDOFF_PW_VALUE}\",\"pin\":\"${PIN_OUT_VALUE}\",\"w1\":\"${W1_PW_VALUE}\"}" \
       --region "${AWS_REGION}" 2>&1 >/dev/null); then
    created=1
    break
  fi
  [[ ${attempt} -lt 6 ]] && sleep 5
done
if [[ ${created} -ne 1 ]]; then
  echo "FAIL: could not create the out-of-band secret ${SECRET_NAME} after 6 attempts; last error: ${create_err}" >&2
  exit 1
fi
# The #3156 arm's SecureString. A plain `String` would be public config the
# resolver keeps resolved, and the `ssm` half of the arm would test nothing.
aws ssm put-parameter --name "${PIN_SSM_PARAM_NAME}" --type SecureString \
  --value "${PIN_SSM_VALUE}" --overwrite --region "${AWS_REGION}" >/dev/null
PIN_SSM_TYPE=$(aws ssm get-parameter --name "${PIN_SSM_PARAM_NAME}" --region "${AWS_REGION}" \
  --query 'Parameter.Type' --output text)
if [[ "${PIN_SSM_TYPE}" != "SecureString" ]]; then
  echo "FAIL: premise: ${PIN_SSM_PARAM_NAME} is a ${PIN_SSM_TYPE}, not a SecureString" >&2
  exit 1
fi

# --------------------------------------------------------------------
# Step 1: deploy the 4-level tree.
# --------------------------------------------------------------------
echo ""
echo "==> Step 1: deploy ${STACK} (root -> Child -> Grandchild -> GreatGrandchild)"
# Captured, and at --verbose, so the deploy's own DISPLAY readers (the
# resolver's parameter debug lines, the per-resource summaries) are scanned
# for the plaintext before anything is echoed (#3094 review). The sentinel
# says the capture holds the deploy at all -- a plaintext-free EMPTY string
# would otherwise pass the scan.
# The rc is captured and judged AFTER the scan and the echo, so a failed
# deploy still leaves its output in the log (scanned first) instead of
# aborting with nothing to read.
scan_output() { # scan_output <label> <text> -- FAIL (without echoing) on the plaintext
  local plaintext
  for plaintext in "${HANDOFF_PW_VALUE}" "${FRAMED_PLAINTEXTS[@]}" "${W1_PLAINTEXTS[@]}"; do
    if grep -qF "${plaintext}" <<<"$2"; then
      echo "FAIL: $1 printed a secret plaintext" >&2
      exit 1
    fi
  done
}
set +e
DEPLOY_OUT=$(${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes --verbose 2>&1)
DEPLOY_RC=$?
set -e
scan_output "cdkd deploy --verbose" "${DEPLOY_OUT}"
# #3156: masked_whole <text> <prefix> -- 0 when some line holds <prefix> and
# EVERY line holding it ends in exactly `<prefix>***`; 1 when one does not; 2
# when none holds it. Prints nothing: a line that is not masked whole may
# carry a bare 2-character secret, which the framed-value scan above cannot
# see. Every such line is checked BEFORE the output is echoed below.
masked_whole() {
  awk -v p="$2" 'index($0, p) { n++; if (substr($0, length($0) - length(p) - 2) != p "***") bad = 1 }
    END { exit n == 0 ? 2 : (bad ? 1 : 0) }' <<<"$1"
}
GC_LINE_PREFIXES=()
for name in GcSsmPass GcSsmWrap GcOutPass GcOutWrap GcNestPass GcVarPass GcIfPass; do
  GC_LINE_PREFIXES+=("Parameter ${name}: using user-provided value " "Resolved Ref to parameter: ${name} resolved to ")
done
for prefix in "${GC_LINE_PREFIXES[@]}"; do
  rc=0
  masked_whole "${DEPLOY_OUT}" "${prefix}" || rc=$?
  if [[ ${rc} -eq 1 ]]; then
    echo "FAIL: #3156: a '${prefix}...' line is not masked whole (output withheld: it may carry the secret)" >&2
    exit 1
  fi
done
echo "${DEPLOY_OUT}"
if [[ ${DEPLOY_RC} -ne 0 ]]; then
  echo "FAIL: cdkd deploy exited ${DEPLOY_RC}" >&2
  exit 1
fi
if ! grep -qF "${STACK}" <<<"${DEPLOY_OUT}"; then
  echo "FAIL: premise: the captured deploy output does not mention ${STACK} (nothing was captured)" >&2
  exit 1
fi
echo "  OK: the deploy's --verbose output carries no plaintext"
# #4543: W1Script's version as Step 1 left it. Step 4d compares it with the
# version just before its own deploy: Step 4c's deploys re-run the child
# engine with Input4543 unchanged, so an equal version there is the arm's
# no-churn evidence.
W1_VERSION_STEP1=$(aws ssm get-parameter --name "${W1_PARAM_NAME}" --region "${AWS_REGION}" \
  --query 'Parameter.Version' --output text)
case "${W1_VERSION_STEP1}" in
  '' | *[!0-9]*)
    echo "FAIL: premise: ${W1_PARAM_NAME}'s version after Step 1 did not read as a number (${W1_VERSION_STEP1})" >&2
    exit 1
    ;;
esac

# #3156: the grandchild's lines per framed parameter, PRESENT and masked whole
# -- the whole-value entry the root's carry records reaches the grandchild
# through the middle's bag. Presence is what keeps the scan above from passing
# on a grandchild that stopped logging them. Its `Fn::Join` lines are masked
# whole too, so they name nothing this arm could anchor a presence check on;
# the negative scan above is what covers their text.
for prefix in "${GC_LINE_PREFIXES[@]}"; do
  rc=0
  masked_whole "${DEPLOY_OUT}" "${prefix}" || rc=$?
  if [[ ${rc} -ne 0 ]]; then
    echo "FAIL: #3156: no '${prefix}***' line in the deploy's --verbose output (masked_whole rc=${rc})" >&2
    exit 1
  fi
done
echo "  OK: #3156: the grandchild's parameter and Ref lines are present and masked whole"

# --------------------------------------------------------------------
# Step 2: one state file per level with correct parentStack/parentLogicalId.
# --------------------------------------------------------------------
echo ""
echo "==> Step 2: per-level state files + v6 parent fields"

# Format: "<stateKey> <expectedParentStack> <expectedParentLogicalId>"
# Root has no parent (parentStack must be absent/null).
assert_level() {
  local key="$1" expectedParent="$2" expectedLogicalId="$3"
  local json
  if ! json=$(fetch_state "${key}"); then
    echo "FAIL: missing state file at $(state_key_uri "${key}")"
    exit 1
  fi
  # stackName field must match the state key.
  local actualName
  actualName=$(echo "${json}" | jq -r '.stackName')
  if [[ "${actualName}" != "${key}" ]]; then
    echo "FAIL: state ${key} has stackName='${actualName}' (expected '${key}')"
    exit 1
  fi
  local actualParent actualLogicalId
  actualParent=$(echo "${json}" | jq -r 'if has("parentStack") then .parentStack else "null" end')
  actualLogicalId=$(echo "${json}" | jq -r 'if has("parentLogicalId") then .parentLogicalId else "null" end')
  if [[ "${actualParent}" != "${expectedParent}" ]]; then
    echo "FAIL: state ${key} parentStack='${actualParent}' (expected '${expectedParent}')"
    exit 1
  fi
  if [[ "${actualLogicalId}" != "${expectedLogicalId}" ]]; then
    echo "FAIL: state ${key} parentLogicalId='${actualLogicalId}' (expected '${expectedLogicalId}')"
    exit 1
  fi
  echo "  OK: ${key} (parentStack='${actualParent}', parentLogicalId='${actualLogicalId}')"

  # Collect this level's AWS physical ids so Step 3 / Step 6 can check them.
  local ssm sns
  while IFS= read -r ssm; do
    [[ -n "${ssm}" ]] && SSM_PARAM_NAMES+=("${ssm}")
  done < <(echo "${json}" | jq -r '.resources | to_entries[] | select(.value.resourceType=="AWS::SSM::Parameter") | .value.physicalId')
  while IFS= read -r sns; do
    [[ -n "${sns}" ]] && SNS_TOPIC_ARNS+=("${sns}")
  done < <(echo "${json}" | jq -r '.resources | to_entries[] | select(.value.resourceType=="AWS::SNS::Topic") | .value.physicalId')
}

assert_level "${STACK}"           "null"            "null"
assert_level "${CHILD}"           "${STACK}"        "Child"
assert_level "${GRANDCHILD}"      "${CHILD}"        "Grandchild"
assert_level "${GREATGRANDCHILD}" "${GRANDCHILD}"   "GreatGrandchild"
assert_level "${FRAMED}"          "${STACK}"        "Framed"
assert_level "${FRAMED_GC}"       "${FRAMED}"       "FramedGrandchild"

# Sanity: we should have collected 14 SSM params (RootRef, Child.Param,
# Child.W1Script, Grandchild.Param, Grandchild.SecretA, Grandchild.SecretB,
# GreatGrandchild.Param, and the #3156 / #3306 grandchild's seven consumers)
# and 2 SNS topics (RootTopic, Grandchild.Topic) across the tree.
if [[ ${#SSM_PARAM_NAMES[@]} -ne 14 ]]; then
  echo "FAIL: expected 14 SSM parameters across the tree, found ${#SSM_PARAM_NAMES[@]}: ${SSM_PARAM_NAMES[*]}"
  exit 1
fi
if [[ ${#SNS_TOPIC_ARNS[@]} -ne 2 ]]; then
  echo "FAIL: expected 2 SNS topics across the tree, found ${#SNS_TOPIC_ARNS[@]}: ${SNS_TOPIC_ARNS[*]}"
  exit 1
fi
echo "  OK: 6 state files, 14 SSM params + 2 SNS topics collected across all levels"

# --------------------------------------------------------------------
# Step 3: every level's REAL AWS resource exists.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3: each level's AWS resource exists"
for name in "${SSM_PARAM_NAMES[@]}"; do
  if ! aws ssm get-parameter --name "${name}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "FAIL: SSM parameter '${name}' not found on AWS after deploy"
    exit 1
  fi
  echo "  OK: SSM parameter exists: ${name}"
done
for arn in "${SNS_TOPIC_ARNS[@]}"; do
  if ! aws sns get-topic-attributes --topic-arn "${arn}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "FAIL: SNS topic '${arn}' not found on AWS after deploy"
    exit 1
  fi
  echo "  OK: SNS topic exists: ${arn}"
done

# Verify the DOWNWARD reference actually threaded the root topic name into the
# great-grandchild's parameter value (top-down Parameters forwarding). The
# great-grandchild Param value is `cdkd-3level-ggc-uses-root-topic:<rootTopicName>`.
GGC_JSON=$(fetch_state "${GREATGRANDCHILD}")
GGC_VALUE=$(echo "${GGC_JSON}" | jq -r '.resources | to_entries[] | select(.value.resourceType=="AWS::SSM::Parameter") | .value.properties.Value')
if [[ "${GGC_VALUE}" != cdkd-3level-ggc-uses-root-topic:* ]]; then
  echo "FAIL: great-grandchild param value '${GGC_VALUE}' did not carry the downward root-topic Parameter"
  exit 1
fi
echo "  OK: downward Parameters forwarding reached depth=3 (value='${GGC_VALUE}')"

# --------------------------------------------------------------------
# Step 3b (#3094): the secret's two spellings keep their OWN expression at
# every level, and the plaintext appears in no state file.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3b: #3094 -- a secret through three levels, each leaf its own spelling"
ROOT_JSON=$(fetch_state "${STACK}")
CHILD_JSON=$(fetch_state "${CHILD}")
GC_JSON=$(fetch_state "${GRANDCHILD}")
jq_of() { # jq_of <json> <expr> -> raw value
  echo "$1" | jq -r "$2"
}
assert_eq() { # assert_eq <label> <actual> <expected> (values MASKED on mismatch)
  # LENGTHS only: the #3156 secrets are two characters, so any prefix of a
  # mismatched value can be the whole plaintext.
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1" >&2
    echo "      expected: ***(len=${#3})" >&2
    echo "      actual:   ***(len=${#2})" >&2
    exit 1
  fi
  echo "  OK: $1"
}
# The ROOT's own row: literal string sources, each its own token.
assert_eq "root row keeps HandoffSecretA as its OWN expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Child.properties.Parameters.HandoffSecretA')" "${HANDOFF_EXPR_A}"
assert_eq "root row keeps HandoffSecretB as its OWN expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Child.properties.Parameters.HandoffSecretB')" "${HANDOFF_EXPR_B}"
# The CHILD's own row: `{Ref}` sources positioned by the inherited
# per-parameter association -- the depth-2 half of the chain.
assert_eq "child row keeps HandoffSecretA ({Ref}) as its OWN expression" \
  "$(jq_of "${CHILD_JSON}" '.resources.Grandchild.properties.Parameters.HandoffSecretA')" "${HANDOFF_EXPR_A}"
assert_eq "child row keeps HandoffSecretB ({Ref}) as its OWN expression" \
  "$(jq_of "${CHILD_JSON}" '.resources.Grandchild.properties.Parameters.HandoffSecretB')" "${HANDOFF_EXPR_B}"
# The GRANDCHILD's leaves: the depth-3 carry. THE NAMED DEFECT FIRST, in both
# directions -- which spelling lost the parent's plaintext slot is a
# resolution-order accident, and the pre-#3093 recorder (unscoped refusal 5)
# handed the loser the survivor's expression.
GC_A="$(jq_of "${GC_JSON}" '.resources.SecretA.properties.Value')"
GC_B="$(jq_of "${GC_JSON}" '.resources.SecretB.properties.Value')"
if [[ "${GC_A}" == "${HANDOFF_EXPR_B}" || "${GC_B}" == "${HANDOFF_EXPR_A}" ]]; then
  echo "FAIL: a grandchild leaf persisted the OTHER spelling -- the three-level per-parameter carry collapsed onto the survivor (issue #3094 / #3093)" >&2
  exit 1
fi
if [[ "${GC_A}" == "${HANDOFF_PW_VALUE}" || "${GC_B}" == "${HANDOFF_PW_VALUE}" ]]; then
  echo "FAIL: a grandchild leaf persisted the secret PLAINTEXT (issue #3094)" >&2
  exit 1
fi
assert_eq "grandchild SecretA persists spelling A" "${GC_A}" "${HANDOFF_EXPR_A}"
assert_eq "grandchild SecretB persists spelling B" "${GC_B}" "${HANDOFF_EXPR_B}"
assert_eq "grandchild SecretA's observedProperties readback holds spelling A" \
  "$(jq_of "${GC_JSON}" '.resources.SecretA.observedProperties.Value // "<no readback>"')" "${HANDOFF_EXPR_A}"
assert_eq "grandchild SecretB's observedProperties readback holds spelling B" \
  "$(jq_of "${GC_JSON}" '.resources.SecretB.observedProperties.Value // "<no readback>"')" "${HANDOFF_EXPR_B}"
# The LIVE values are the plaintext -- what AWS must hold.
GC_A_NAME="$(jq_of "${GC_JSON}" '.resources.SecretA.physicalId')"
GC_B_NAME="$(jq_of "${GC_JSON}" '.resources.SecretB.physicalId')"
assert_eq "live SecretA holds the resolved plaintext" \
  "$(aws ssm get-parameter --name "${GC_A_NAME}" --region "${AWS_REGION}" --query 'Parameter.Value' --output text)" \
  "${HANDOFF_PW_VALUE}"
assert_eq "live SecretB holds the resolved plaintext" \
  "$(aws ssm get-parameter --name "${GC_B_NAME}" --region "${AWS_REGION}" --query 'Parameter.Value' --output text)" \
  "${HANDOFF_PW_VALUE}"
# No state file at any level carries the plaintext (here-strings, not
# `printf | grep -q`: issue #2582's SIGPIPE race).
# A STRICT capture first: a `$(fetch_state ...)` inside the here-string
# would turn a failed fetch into an empty input and a false "no plaintext"
# (#3102 review, the gone-probe shape one layer over).
for lvl in "${LEVELS[@]}"; do
  lvl_json=$(fetch_state "${lvl}") || { echo "FAIL: could not fetch the state file of '${lvl}' for the plaintext scan" >&2; exit 1; }
  for plaintext in "${HANDOFF_PW_VALUE}" "${FRAMED_PLAINTEXTS[@]}" "${W1_PLAINTEXTS[@]}"; do
    if grep -qF "${plaintext}" <<<"${lvl_json}"; then
      echo "FAIL: state.json of '${lvl}' carries a secret plaintext" >&2
      exit 1
    fi
  done
done
echo "  OK: no level's state.json carries the plaintext"

# --------------------------------------------------------------------
# Step 3c (#3156): each refused frame is carried, root row -> middle row ->
# grandchild leaf, pass-through and re-wrapped.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3c: #3156 -- sub-floor secrets in the intrinsic frames the carry used to refuse"
# `cdkd deploy` re-synthesized `cdk.out`, so these read what Step 1 deployed.
ROOT_TEMPLATE="cdk.out/${STACK}.template.json"
[[ -f "${ROOT_TEMPLATE}" ]] || { echo "FAIL: premise: ${ROOT_TEMPLATE} is missing after the deploy" >&2; exit 1; }
# PREMISES, from the synthesized templates: the two spellings are the refused
# ones, and the middle's nested-stack row spells no reference of its own, so
# its bag holds nothing the root's carry did not hand it.
assert_eq "premise: the root's Framed row passes down exactly the five framed parameters" \
  "$(jq -c '.Resources.Framed.Properties.Parameters | keys' "${ROOT_TEMPLATE}")" \
  '["MidPinIf","MidPinNest","MidPinOut","MidPinSsm","MidPinVar"]'
assert_eq "premise: MidPinSsm is an Fn::Join whose ONE token spells ssm: with the account Ref inside it" \
  "$(jq -c '.Resources.Framed.Properties.Parameters.MidPinSsm' "${ROOT_TEMPLATE}")" \
  '{"Fn::Join":["",["pin3156s:{{resolve:ssm:cdkd-3level-pinssm-",{"Ref":"AWS::AccountId"},"}}"]]}'
assert_eq "premise: MidPinOut is an Fn::Join whose token is followed by a region Ref OUTSIDE it" \
  "$(jq -c '.Resources.Framed.Properties.Parameters.MidPinOut' "${ROOT_TEMPLATE}")" \
  '{"Fn::Join":["",["pin3156o:{{resolve:secretsmanager:cdkd-3level-secret-",{"Ref":"AWS::AccountId"},":SecretString:pin}}@",{"Ref":"AWS::Region"}]]}'
# The #3306 shapes, each the one the carry used to refuse.
assert_eq "premise: MidPinNest is an Fn::Join whose token sits in a NESTED Fn::Sub part" \
  "$(jq -c '.Resources.Framed.Properties.Parameters.MidPinNest' "${ROOT_TEMPLATE}")" \
  '{"Fn::Join":["",["pin3306n:",{"Fn::Sub":"{{resolve:ssm:cdkd-3level-pinssm-${AWS::AccountId}}}"}]]}'
assert_eq "premise: MidPinVar is an Fn::Sub whose token a used STRING variable holds" \
  "$(jq -c '.Resources.Framed.Properties.Parameters.MidPinVar' "${ROOT_TEMPLATE}")" \
  "{\"Fn::Sub\":[\"pin3306v:\${V}\",{\"V\":\"{{resolve:ssm:${PIN_SSM_PARAM_NAME}}}\"}]}"
assert_eq "premise: MidPinIf is an Fn::If around an Fn::Join frame, on a condition true in every region" \
  "$(jq -c '[.Resources.Framed.Properties.Parameters.MidPinIf, .Conditions.Always3306]' "${ROOT_TEMPLATE}")" \
  '[{"Fn::If":["Always3306",{"Fn::Join":["",["pin3306i:{{resolve:ssm:cdkd-3level-pinssm-",{"Ref":"AWS::AccountId"},"}}"]]},"none"]},{"Fn::Not":[{"Fn::Equals":[{"Ref":"AWS::Region"},"none"]}]}]'
FRAMED_TEMPLATE="cdk.out/$(jq -r '.Resources.Framed.Metadata["aws:asset:path"] // empty' "${ROOT_TEMPLATE}")"
[[ -f "${FRAMED_TEMPLATE}" ]] || { echo "FAIL: premise: the Framed nested template was not found (${FRAMED_TEMPLATE})" >&2; exit 1; }
assert_eq "premise: the middle stack owns only its nested-stack row (and CDK metadata)" \
  "$(jq -c '[.Resources | to_entries[] | select(.value.Type != "AWS::CDK::Metadata") | .key]' "${FRAMED_TEMPLATE}")" \
  '["FramedGrandchild"]'
# Its row's Parameters are EXACTLY the seven hand-offs, each a `Ref` to a
# middle parameter or `m-` joined to one: nothing else in the middle can put a
# pair into that row's bag.
assert_eq "premise: the middle's nested-stack row passes down only Refs to its own parameters, bare or m- joined" \
  "$(jq -c '.Resources.FramedGrandchild.Properties.Parameters' "${FRAMED_TEMPLATE}")" \
  '{"GcSsmPass":{"Ref":"MidPinSsm"},"GcSsmWrap":{"Fn::Join":["",["m-",{"Ref":"MidPinSsm"}]]},"GcOutPass":{"Ref":"MidPinOut"},"GcOutWrap":{"Fn::Join":["",["m-",{"Ref":"MidPinOut"}]]},"GcNestPass":{"Ref":"MidPinNest"},"GcVarPass":{"Ref":"MidPinVar"},"GcIfPass":{"Ref":"MidPinIf"}}'
# ...and its only OTHER property is CDK's asset `TemplateURL`, in its exact
# shape up to the content hash -- the engine resolves the whole row into that
# bag, so any other property could hold a reference of its own. CDK renders the
# asset bucket with the account folded in when the stack's env names one (the
# `cdkd deploy` synth) and through `Fn::Sub` otherwise; both are pinned.
assert_eq "premise: the middle's nested-stack row carries nothing but Parameters and CDK's asset TemplateURL" \
  "$(jq --arg region "${AWS_REGION}" --arg account "${ACCOUNT_ID}" '(.Resources.FramedGrandchild.Properties | keys == ["Parameters", "TemplateURL"]) and (.Resources.FramedGrandchild.Properties.TemplateURL["Fn::Join"] as $j | ($j | length == 2) and $j[0] == "" and ($j[1][0:2] == ["https://s3.\($region).", {"Ref": "AWS::URLSuffix"}]) and ((($j[1] | length == 3) and ($j[1][2] | type == "string" and test("^/cdk-hnb659fds-assets-\($account)-\($region)/[0-9a-f]{64}\\.json$"))) or (($j[1] | length == 5) and $j[1][2] == "/" and $j[1][3] == {"Fn::Sub": "cdk-hnb659fds-assets-${AWS::AccountId}-\($region)"} and ($j[1][4] | type == "string" and test("^/[0-9a-f]{64}\\.json$")))))' "${FRAMED_TEMPLATE}")" "true"
FRAMED_JSON=$(fetch_state "${FRAMED}")
FRAMED_GC_JSON=$(fetch_state "${FRAMED_GC}")
# The ROOT's row: the ssm frame the frame arm already positioned, and the
# outside-the-token frame only the carry's entry positions.
assert_eq "root row keeps MidPinSsm as its framed expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Framed.properties.Parameters.MidPinSsm')" "${PIN_SSM_EXPR}"
assert_eq "root row keeps MidPinOut (Ref outside the token) as its framed expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Framed.properties.Parameters.MidPinOut')" "${PIN_OUT_EXPR}"
# The #3306 frames on the ROOT's row: only the carry's entry positions them.
assert_eq "root row keeps MidPinNest (token in a nested part) as its framed expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Framed.properties.Parameters.MidPinNest')" "${PIN_NEST_EXPR}"
assert_eq "root row keeps MidPinVar (token in a Sub variable) as its framed expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Framed.properties.Parameters.MidPinVar')" "${PIN_VAR_EXPR}"
assert_eq "root row keeps MidPinIf (Fn::If around the frame) as its framed expression" \
  "$(jq_of "${ROOT_JSON}" '.resources.Framed.properties.Parameters.MidPinIf')" "${PIN_IF_EXPR}"
# The MIDDLE's row, pass-through and re-wrapped.
assert_eq "middle row keeps GcSsmPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcSsmPass')" "${PIN_SSM_EXPR}"
assert_eq "middle row keeps GcSsmWrap (m- + {Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcSsmWrap')" "m-${PIN_SSM_EXPR}"
assert_eq "middle row keeps GcOutPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcOutPass')" "${PIN_OUT_EXPR}"
assert_eq "middle row keeps GcOutWrap (m- + {Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcOutWrap')" "m-${PIN_OUT_EXPR}"
assert_eq "middle row keeps GcNestPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcNestPass')" "${PIN_NEST_EXPR}"
assert_eq "middle row keeps GcVarPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcVarPass')" "${PIN_VAR_EXPR}"
assert_eq "middle row keeps GcIfPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcIfPass')" "${PIN_IF_EXPR}"
# The GRANDCHILD's leaves, and the live values they resolved to.
for name in SsmPass SsmWrap OutPass OutWrap NestPass VarPass IfPass; do
  case "${name}" in
    SsmPass) expr="${PIN_SSM_EXPR}"; plain="${PIN_SSM_FRAMED}" ;;
    SsmWrap) expr="m-${PIN_SSM_EXPR}"; plain="m-${PIN_SSM_FRAMED}" ;;
    OutPass) expr="${PIN_OUT_EXPR}"; plain="${PIN_OUT_FRAMED}" ;;
    OutWrap) expr="m-${PIN_OUT_EXPR}"; plain="m-${PIN_OUT_FRAMED}" ;;
    NestPass) expr="${PIN_NEST_EXPR}"; plain="${PIN_NEST_FRAMED}" ;;
    VarPass) expr="${PIN_VAR_EXPR}"; plain="${PIN_VAR_FRAMED}" ;;
    IfPass) expr="${PIN_IF_EXPR}"; plain="${PIN_IF_FRAMED}" ;;
    *) echo "FAIL: no expected value for Framed${name}" >&2; exit 1 ;;
  esac
  assert_eq "grandchild Framed${name} persists gc- + the framed expression" \
    "$(jq_of "${FRAMED_GC_JSON}" ".resources.Framed${name}.properties.Value")" "gc-${expr}"
  live_name="$(jq_of "${FRAMED_GC_JSON}" ".resources.Framed${name}.physicalId")"
  assert_eq "live Framed${name} holds gc- + the resolved framed value" \
    "$(aws ssm get-parameter --name "${live_name}" --region "${AWS_REGION}" --query 'Parameter.Value' --output text)" \
    "gc-${plain}"
done

# --------------------------------------------------------------------
# Step 3d (#4094): the child reads a ROOT template parameter bound from its
# Default. The PREMISES make Step 4 discriminate: the root's Child row hands
# it down as `{Ref: Stage4094}` with nothing supplying a value, and MidPinIf
# (asserted above) is an `Fn::If` on the root's own condition. Before the fix
# `cdkd diff --recursive` resolved both rows without the root's bound
# parameters and conditions, and Step 4 printed the child's description and
# the framed IfPass leaf as UPDATEs.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3d: #4094 -- a child fed by a root parameter's Default"
assert_eq "premise: Stage4094 is a root parameter bound from its Default alone" \
  "$(jq -c '.Parameters.Stage4094' "${ROOT_TEMPLATE}")" '{"Type":"String","Default":"stage-4094"}'
assert_eq "premise: the root's Child row hands Stage4094 down as a Ref in exactly one parameter" \
  "$(jq -c '[.Resources.Child.Properties.Parameters[] | select(. == {"Ref": "Stage4094"})] | length' "${ROOT_TEMPLATE}")" '1'
assert_eq "the child's Param description persisted the root parameter's Default" \
  "$(jq_of "${CHILD_JSON}" '[.resources[] | select(.resourceType == "AWS::SSM::Parameter") | .properties.Description | strings | select(endswith("(stage stage-4094)"))] | length')" '1'

# --------------------------------------------------------------------
# Step 4: recursive diff against the just-deployed tree must be clean.
# --------------------------------------------------------------------
echo ""
echo "==> Step 4: 'cdkd diff ${STACK} --recursive' must report no changes"
CLEAN_OUT=$(${CDKD} diff ${STACK} --recursive --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
scan_output "cdkd diff --recursive" "${CLEAN_OUT}"
echo "${CLEAN_OUT}"
if ! echo "${CLEAN_OUT}" | grep -q "No changes detected"; then
  echo "FAIL: recursive diff of a freshly-deployed tree reported spurious changes"
  exit 1
fi
if echo "${CLEAN_OUT}" | grep -qE "\[~\]|\[\+\]|\[-\]"; then
  echo "FAIL: recursive diff of a freshly-deployed tree printed change markers"
  exit 1
fi
echo "  OK: clean recursive diff across every level (the #3094 chain and the #3156 branch included: by construction a leaf holding the OTHER spelling reports a change here -- the control run stopped at Step 3b, so this half is unmeasured)"

# Changed deep value -> '--recursive --fail' must exit 1 and surface the
# great-grandchild under its own Nested stack header (deepest-level diff).
echo ""
echo "==> Step 4b: changed great-grandchild value surfaces under its nested header"
set +e
CHANGED_OUT=$(CDKD_INTEG_GGC_VALUE="${CHANGED_VALUE}" ${CDKD} diff ${STACK} --recursive --fail --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
CHANGED_RC=$?
set -e
scan_output "cdkd diff --recursive --fail (changed)" "${CHANGED_OUT}"
echo "${CHANGED_OUT}"
if [[ ${CHANGED_RC} -ne 1 ]]; then
  echo "FAIL: --recursive --fail exited ${CHANGED_RC} after a great-grandchild change (expected 1)"
  exit 1
fi
if ! echo "${CHANGED_OUT}" | grep -q "Nested stack: ${GREATGRANDCHILD}"; then
  echo "FAIL: recursive diff did not print a 'Nested stack: ${GREATGRANDCHILD}' block"
  exit 1
fi
if ! echo "${CHANGED_OUT}" | grep -q "\[~\]"; then
  echo "FAIL: recursive diff did not print an UPDATE ([~]) line for the changed great-grandchild"
  exit 1
fi
echo "  OK: depth=3 UPDATE surfaced under its Nested stack header"

# --------------------------------------------------------------------
# Step 4c (#1989): a resource the GREAT-GRANDCHILD leaves unaddressed reaches
# the ROOT's summary and exit code, three nested-stack hops up.
# --------------------------------------------------------------------
# The skip is induced without any AWS resource: a record of a composite-id type
# whose physicalId is NOT composite is injected into the great-grandchild's
# state. The template does not declare it, so the deploy issues a template-
# removal DELETE, and the AppSync provider skips it with no AWS call (the
# record is KEPT). The changed great-grandchild value is the ORDINARY
# difference that makes every level's row an UPDATE: with no template change
# the root's Child row diffs NO_CHANGE and the child deploys never run.
# Before #1989 the child result was discarded: the run printed the skip
# warning from the great-grandchild and still exited 0 with a clean summary.
echo ""
echo "==> Step 4c: #1989 -- a great-grandchild's skipped DELETE fails the root's exit code"
inject_1989
assert_eq "premise: the injected record is in the great-grandchild's state" \
  "$(jq_of "$(fetch_state "${GREATGRANDCHILD}")" ".resources | has(\"${INJECTED_1989}\")")" 'true'
set +e
SKIP_OUT=$(CDKD_INTEG_GGC_VALUE="${CHANGED_VALUE}" ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)
SKIP_RC=$?
set -e
scan_output "cdkd deploy (#1989 skip)" "${SKIP_OUT}"
echo "${SKIP_OUT}"
SKIP_TXT=$(printf '%s\n' "${SKIP_OUT}" | sed $'s/\033\[[0-9;]*m//g')
# Premise sentinel, independent of the summary rows under test: the
# great-grandchild's own skip warning names the injected record. Without it a
# red below would mean the injection never reached a DELETE, not that the
# count was lost on the way up.
if ! grep -F "${INJECTED_1989}" <<<"${SKIP_TXT}" | grep -qF "Skipping the delete"; then
  echo "FAIL: premise: no skip warning for ${INJECTED_1989} -- the great-grandchild never attempted its DELETE" >&2
  exit 1
fi
if [[ ${SKIP_RC} -ne 2 ]]; then
  echo "FAIL: #1989: the deploy exited ${SKIP_RC}; a run whose great-grandchild left a resource unaddressed must exit 2" >&2
  exit 1
fi
if ! grep -qE 'Skipped \(not deleted\): 1$' <<<"${SKIP_TXT}"; then
  echo "FAIL: #1989: the root's summary has no 'Skipped (not deleted): 1' row" >&2
  exit 1
fi
if ! grep -qF "Stack ${STACK} deployed, but 1 resource(s) were left unaddressed" <<<"${SKIP_TXT}"; then
  echo "FAIL: #1989: no unaddressed verdict line for ${STACK}" >&2
  exit 1
fi
if grep -qF "Deployment completed successfully" <<<"${SKIP_TXT}"; then
  echo "FAIL: #1989: the root still reports 'Deployment completed successfully'" >&2
  exit 1
fi
assert_eq "the skipped DELETE kept its record in the great-grandchild's state" \
  "$(jq_of "$(fetch_state "${GREATGRANDCHILD}")" ".resources | has(\"${INJECTED_1989}\")")" 'true'
echo "  OK: the depth-3 skip reached the root's summary row, verdict line and exit 2"

# #4453: the SAME tree redeployed, nothing changed in any template. Each
# level's nested-stack row records `cdkd:PendingChildDeletes` while a
# descendant holds a skipped DELETE, so the next diff re-runs the chain down to
# the great-grandchild, which re-attempts its kept DELETE and skips again. Before
# #4453 every row diffed NO_CHANGE, no child ran, and this deploy exited 0 over
# the record it still holds.
pending_marker_of() { # pending_marker_of <stack> <nested row id> -> the recorded count, or null
  local json
  json=$(fetch_state "$1") || return 1
  [[ -n "${json}" ]] || return 1
  jq -r --arg id "$2" '.resources[$id].properties["cdkd:PendingChildDeletes"]' <<<"${json}"
}
assert_eq "#4453: the root's Child row records one pending child DELETE" \
  "$(pending_marker_of "${STACK}" Child)" '1'
assert_eq "#4453: the child's Grandchild row records one pending child DELETE" \
  "$(pending_marker_of "${CHILD}" Grandchild)" '1'
assert_eq "#4453: the grandchild's GreatGrandchild row records one pending child DELETE" \
  "$(pending_marker_of "${GRANDCHILD}" GreatGrandchild)" '1'
# The rows carrying the marker were written through the provider's own
# record bag rather than the engine's; the #3094 secret those same rows hand
# down must still be recorded as its expression, and no level may hold any
# plaintext (Step 3b's scan, re-run on the state this deploy wrote).
MARKED_ROOT_JSON=$(fetch_state "${STACK}") || { echo "FAIL: could not fetch ${STACK} state for the #4453 secret check" >&2; exit 1; }
MARKED_CHILD_JSON=$(fetch_state "${CHILD}") || { echo "FAIL: could not fetch ${CHILD} state for the #4453 secret check" >&2; exit 1; }
assert_eq "#4453: the marked root row keeps HandoffSecretA as its expression" \
  "$(jq_of "${MARKED_ROOT_JSON}" '.resources.Child.properties.Parameters.HandoffSecretA')" "${HANDOFF_EXPR_A}"
assert_eq "#4453: the marked root row keeps HandoffSecretB as its expression" \
  "$(jq_of "${MARKED_ROOT_JSON}" '.resources.Child.properties.Parameters.HandoffSecretB')" "${HANDOFF_EXPR_B}"
assert_eq "#4453: the marked child row keeps HandoffSecretA as its expression" \
  "$(jq_of "${MARKED_CHILD_JSON}" '.resources.Grandchild.properties.Parameters.HandoffSecretA')" "${HANDOFF_EXPR_A}"
assert_eq "#4453: the marked child row keeps HandoffSecretB as its expression" \
  "$(jq_of "${MARKED_CHILD_JSON}" '.resources.Grandchild.properties.Parameters.HandoffSecretB')" "${HANDOFF_EXPR_B}"
for lvl in "${LEVELS[@]}"; do
  lvl_json=$(fetch_state "${lvl}") || { echo "FAIL: could not fetch the state file of '${lvl}' for the #4453 plaintext scan" >&2; exit 1; }
  for plaintext in "${HANDOFF_PW_VALUE}" "${FRAMED_PLAINTEXTS[@]}" "${W1_PLAINTEXTS[@]}"; do
    if grep -qF "${plaintext}" <<<"${lvl_json}"; then
      echo "FAIL: #4453: state.json of '${lvl}' carries a secret plaintext while a pending marker is recorded" >&2
      exit 1
    fi
  done
done
echo "  OK: #4453: the marked rows keep their secret expressions and no level holds plaintext"
set +e
RETRY_OUT=$(CDKD_INTEG_GGC_VALUE="${CHANGED_VALUE}" ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)
RETRY_RC=$?
set -e
scan_output "cdkd deploy (#4453 re-attempt)" "${RETRY_OUT}"
echo "${RETRY_OUT}"
RETRY_TXT=$(printf '%s\n' "${RETRY_OUT}" | sed $'s/\033\[[0-9;]*m//g')
# Premise sentinel, independent of the exit code under test: the
# great-grandchild's skip warning is printed only when its DELETE ran again.
if ! grep -F "${INJECTED_1989}" <<<"${RETRY_TXT}" | grep -qF "Skipping the delete"; then
  echo "FAIL: #4453: the unchanged redeploy never re-attempted the great-grandchild's kept DELETE (exit ${RETRY_RC})" >&2
  exit 1
fi
if [[ ${RETRY_RC} -ne 2 ]]; then
  echo "FAIL: #4453: the unchanged redeploy exited ${RETRY_RC}; the still-skipped DELETE must exit 2 again" >&2
  exit 1
fi
if ! grep -qE 'Skipped \(not deleted\): 1$' <<<"${RETRY_TXT}"; then
  echo "FAIL: #4453: the unchanged redeploy's summary has no 'Skipped (not deleted): 1' row" >&2
  exit 1
fi
echo "  OK: #4453: an unchanged redeploy re-attempted the depth-3 DELETE and exited 2 again"

# Negative control: the record removed, the same tree redeployed (the value
# changed back, so every level runs again) exits 0 with a clean summary -- the
# exit 2 above came from the injected skip, not from the changed value.
remove_injected_1989
set +e
CLEAN_DEPLOY_OUT=$(${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)
CLEAN_DEPLOY_RC=$?
set -e
scan_output "cdkd deploy (#1989 control)" "${CLEAN_DEPLOY_OUT}"
echo "${CLEAN_DEPLOY_OUT}"
CLEAN_DEPLOY_TXT=$(printf '%s\n' "${CLEAN_DEPLOY_OUT}" | sed $'s/\033\[[0-9;]*m//g')
if [[ ${CLEAN_DEPLOY_RC} -ne 0 ]]; then
  echo "FAIL: #1989 control: the deploy without the injected record exited ${CLEAN_DEPLOY_RC}" >&2
  exit 1
fi
if ! grep -qF "Deployment completed successfully" <<<"${CLEAN_DEPLOY_TXT}"; then
  echo "FAIL: #1989 control: no success line after the injected record was removed" >&2
  exit 1
fi
if grep -qF "Skipped (not deleted)" <<<"${CLEAN_DEPLOY_TXT}"; then
  echo "FAIL: #1989 control: a 'Skipped (not deleted)' row without any skip" >&2
  exit 1
fi
echo "  OK: #1989 control: the same tree without the skip exits 0"
for row in "${STACK}:Child" "${CHILD}:Grandchild" "${GRANDCHILD}:GreatGrandchild"; do
  assert_eq "#4453 control: ${row#*:} no longer records a pending child DELETE" \
    "$(pending_marker_of "${row%%:*}" "${row#*:}")" 'null'
done
# And with nothing pending, an unchanged redeploy is quiet again: the marker is
# cleared, not left to re-run the chain on every deploy. The needle below is
# live: the control deploy above re-ran every level and printed it.
if ! grep -qF "Updating nested stack" <<<"${CLEAN_DEPLOY_OUT}"; then
  echo "FAIL: premise: the control deploy printed no 'Updating nested stack' line, so its absence below would prove nothing" >&2
  exit 1
fi
set +e
QUIET_OUT=$(${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)
QUIET_RC=$?
set -e
scan_output "cdkd deploy (#4453 quiet)" "${QUIET_OUT}"
echo "${QUIET_OUT}"
if [[ ${QUIET_RC} -ne 0 ]]; then
  echo "FAIL: #4453 control: an unchanged redeploy with nothing pending exited ${QUIET_RC}" >&2
  exit 1
fi
if grep -qF "Updating nested stack" <<<"${QUIET_OUT}"; then
  echo "FAIL: #4453 control: an unchanged redeploy with nothing pending still re-ran a nested stack" >&2
  exit 1
fi
echo "  OK: #4453 control: the markers cleared and an unchanged redeploy re-runs nothing"

# --------------------------------------------------------------------
# Step 4d (#4543): a new value the ROOT passes reaches a masked property in
# the child. `W1Script` is `Fn::Base64` over a script joining `{Ref:
# Input4543}` (a plain root parameter the root hands down, so the root
# classifies it clean) and a secretsmanager reference the child resolves
# itself, so the child records the value as `***`. Before the fix only the
# template TEXT was fingerprinted, so a new `Input4543` behind unchanged text
# compared `***` with `***` and the child kept the old script under a green
# deploy. `CDKD_TEST_4543_INPUT` moves only the root parameter's `Default`.
# The send is proven on the parameter AWS holds (value and version); the live
# value is compared, never printed (it decodes to the w1 plaintext).
# --------------------------------------------------------------------
echo ""
echo "==> Step 4d: #4543 -- a new root-passed value reaches the child's masked script"
w1_live() { # w1_live <Value|Version>
  aws ssm get-parameter --name "${W1_PARAM_NAME}" --region "${AWS_REGION}" \
    --query "Parameter.$1" --output text
}
w1_record() { # w1_record <child state json> <jq path under .resources.W1Script>
  jq -r ".resources.W1Script.$2 // \"<absent>\"" <<<"$1"
}
w1_scan_states() { # w1_scan_states <label>: no level's state.json holds the w1 plaintext or an encoding
  local lvl lvl_json plaintext
  for lvl in "${LEVELS[@]}"; do
    lvl_json=$(fetch_state "${lvl}") || { echo "FAIL: could not fetch the state file of '${lvl}' for the #4543 scan ($1)" >&2; exit 1; }
    for plaintext in "${W1_PLAINTEXTS[@]}"; do
      if grep -qF "${plaintext}" <<<"${lvl_json}"; then
        echo "FAIL: #4543: state.json of '${lvl}' carries the w1 plaintext or an encoding of its script ($1)" >&2
        exit 1
      fi
    done
  done
}
assert_eq "premise: Input4543 is a plain root parameter whose Default is \"one\"" \
  "$(jq -c '.Parameters.Input4543' "${ROOT_TEMPLATE}")" '{"Type":"String","Default":"one"}'
assert_eq "premise: the root's Child row hands Input4543 down as its Ref" \
  "$(jq -c '.Resources.Child.Properties.Parameters.Input4543' "${ROOT_TEMPLATE}")" '{"Ref":"Input4543"}'
W1_JSON_ONE=$(fetch_state "${CHILD}") || { echo "FAIL: could not fetch ${CHILD} state for the #4543 premise" >&2; exit 1; }
W1_TEXT_ONE=$(w1_record "${W1_JSON_ONE}" 'maskedPropertyFingerprints.Value')
W1_INPUT_ONE=$(w1_record "${W1_JSON_ONE}" 'maskedPropertyInputFingerprints.Value')
assert_eq "premise: the child records W1Script's Value as the mask" \
  "$(w1_record "${W1_JSON_ONE}" 'properties.Value')" '***'
if [[ "${W1_TEXT_ONE}" != sha256:* || "${W1_INPUT_ONE}" != inputs-sha256:* \
  || "${W1_INPUT_ONE#*+}" != "${W1_TEXT_ONE}" ]]; then
  echo "FAIL: premise: W1Script carries no text fingerprint with an input fingerprint bound to it (read '${W1_TEXT_ONE}' / '${W1_INPUT_ONE}') -- the child stamped no input fingerprint for a value its parent classified clean (issue #4543)" >&2
  exit 1
fi
if [[ "$(w1_live Value)" != "${W1_ONE_B64}" ]]; then
  echo "FAIL: premise: ${W1_PARAM_NAME} does not hold the script for INPUT=one before the change (value withheld)" >&2
  exit 1
fi
W1_VERSION_ONE=$(w1_live Version)
echo "  OK: premise: W1Script is recorded '***' with a bound input fingerprint, and AWS holds INPUT=one (version ${W1_VERSION_ONE})"
# The no-churn half. Step 4c's three deploys (the changed great-grandchild
# value, its re-attempt and the control) each made the root's Child row an
# UPDATE, so the child engine ran with Input4543 unchanged and compared
# W1Script's input fingerprint each time. Its version is still Step 1's: none
# of them re-sent it.
assert_eq "#4543: W1Script was not re-sent by Step 4c's child deploys (version ${W1_VERSION_STEP1})" \
  "${W1_VERSION_ONE}" "${W1_VERSION_STEP1}"

set +e
W1_DEPLOY_OUT=$(CDKD_TEST_4543_INPUT=two ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes --verbose 2>&1)
W1_DEPLOY_RC=$?
set -e
scan_output "cdkd deploy --verbose (#4543 new root value)" "${W1_DEPLOY_OUT}"
echo "${W1_DEPLOY_OUT}"
if [[ ${W1_DEPLOY_RC} -ne 0 ]]; then
  echo "FAIL: #4543: the deploy with the new root value exited ${W1_DEPLOY_RC}" >&2
  exit 1
fi
# Premise: that deploy moved only the root parameter's Default.
assert_eq "premise: the #4543 deploy synthesized Input4543's Default as \"two\"" \
  "$(jq -c '.Parameters.Input4543.Default' "${ROOT_TEMPLATE}")" '"two"'
if [[ "$(w1_live Value)" != "${W1_TWO_B64}" ]]; then
  echo "FAIL: #4543: after a green deploy with the new root value, ${W1_PARAM_NAME} does not hold the script for INPUT=two -- the child never sent its masked property (value withheld)" >&2
  exit 1
fi
W1_VERSION_TWO=$(w1_live Version)
case "${W1_VERSION_ONE}${W1_VERSION_TWO}" in
  '' | *[!0-9]*)
    echo "FAIL: premise: ${W1_PARAM_NAME}'s version did not read as a number (${W1_VERSION_ONE} / ${W1_VERSION_TWO})" >&2
    exit 1
    ;;
esac
if [[ ${W1_VERSION_TWO} -le ${W1_VERSION_ONE} ]]; then
  echo "FAIL: #4543: ${W1_PARAM_NAME}'s version did not advance with the new root value (${W1_VERSION_ONE} -> ${W1_VERSION_TWO})" >&2
  exit 1
fi
W1_JSON_TWO=$(fetch_state "${CHILD}") || { echo "FAIL: could not fetch ${CHILD} state after the #4543 deploy" >&2; exit 1; }
W1_TEXT_TWO=$(w1_record "${W1_JSON_TWO}" 'maskedPropertyFingerprints.Value')
W1_INPUT_TWO=$(w1_record "${W1_JSON_TWO}" 'maskedPropertyInputFingerprints.Value')
assert_eq "#4543: the child still records W1Script's Value as the mask" \
  "$(w1_record "${W1_JSON_TWO}" 'properties.Value')" '***'
# The text half stays (the child's template text did not change); the input
# half moves with the passed value.
if [[ "${W1_TEXT_TWO}" != "${W1_TEXT_ONE}" || "${W1_INPUT_TWO#*+}" != "${W1_TEXT_TWO}" \
  || "${W1_INPUT_TWO}" == "${W1_INPUT_ONE}" || "${W1_INPUT_TWO}" != inputs-sha256:* ]]; then
  echo "FAIL: #4543: W1Script's fingerprints after the new root value are not 'same text, new bound input' (text ${W1_TEXT_ONE} -> ${W1_TEXT_TWO}, input ${W1_INPUT_ONE} -> ${W1_INPUT_TWO})" >&2
  exit 1
fi
w1_scan_states "after the new root value"
echo "  OK: #4543: the new root value reached the child's masked script (version ${W1_VERSION_ONE} -> ${W1_VERSION_TWO}); the input half moved, the text half did not"

# A guard only, NOT churn coverage: with the same new value the root's Child
# row diffs NO_CHANGE, so the child engine does not run here (the no-churn
# check is the Step 4c comparison above).
set +e
W1_SAME_OUT=$(CDKD_TEST_4543_INPUT=two ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)
W1_SAME_RC=$?
set -e
scan_output "cdkd deploy (#4543 unchanged redeploy)" "${W1_SAME_OUT}"
echo "${W1_SAME_OUT}"
if [[ ${W1_SAME_RC} -ne 0 ]]; then
  echo "FAIL: #4543: the unchanged redeploy with the new root value exited ${W1_SAME_RC}" >&2
  exit 1
fi
assert_eq "#4543: an unchanged root redeploy does not touch W1Script" "$(w1_live Version)" "${W1_VERSION_TWO}"
w1_scan_states "after the unchanged redeploy"

# --------------------------------------------------------------------
# Step 5: 'cdkd state list --tree' renders the 4-level hierarchy.
# --------------------------------------------------------------------
echo ""
echo "==> Step 5: 'cdkd state list --tree' renders the 4-level hierarchy"
TREE_OUT=$(${CDKD} state list --tree --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
scan_output "cdkd state list --tree" "${TREE_OUT}"
echo "${TREE_OUT}"
# Root row appears unindented; each deeper level renders with a box-drawing
# branch prefix. Assert the full ~-joined name shows at each level AND that the
# tree nesting (box-drawing chars) is present.
for lvl in "${LEVELS[@]}"; do
  if ! echo "${TREE_OUT}" | grep -qF "${lvl}"; then
    echo "FAIL: 'state list --tree' did not render level '${lvl}'"
    exit 1
  fi
done
if ! echo "${TREE_OUT}" | grep -qE '(└──|├──)'; then
  echo "FAIL: 'state list --tree' rendered no box-drawing branches (hierarchy not shown)"
  exit 1
fi
# The great-grandchild is the deepest leaf: its branch must be indented under a
# continuation prefix (it cannot be a top-level root row). Confirm at least one
# branch line carries the great-grandchild's own logical-id segment.
if ! echo "${TREE_OUT}" | grep -E '(└──|├──)' | grep -qF "GreatGrandchild"; then
  echo "FAIL: 'state list --tree' did not nest GreatGrandchild under a branch"
  exit 1
fi
echo "  OK: 4-level hierarchy rendered with box-drawing branches"

# --------------------------------------------------------------------
# Step 6: destroy + verify the full cascade (every AWS resource + state gone).
# --------------------------------------------------------------------
echo ""
echo "==> Step 6: cdkd destroy (cascade)"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

# 6a: no state file for ANY level remains.
for lvl in "${LEVELS[@]}"; do
  assert_gone "state file for '${lvl}' still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${lvl}/${AWS_REGION}/state.json"
  echo "  OK: state gone: ${lvl}"
done
if ${CDKD} state list --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 | grep -q "${STACK}"; then
  echo "FAIL: 'cdkd state list' still shows ${STACK} after destroy"
  exit 1
fi

# 6b: every level's AWS resource is gone.
for name in "${SSM_PARAM_NAMES[@]}"; do
  assert_gone "SSM parameter '${name}' still exists on AWS after destroy (cascade leak)" aws ssm get-parameter --name "${name}" --region "${AWS_REGION}"
  echo "  OK: SSM parameter gone: ${name}"
done
for arn in "${SNS_TOPIC_ARNS[@]}"; do
  assert_gone "SNS topic '${arn}' still exists on AWS after destroy (cascade leak)" aws sns get-topic-attributes --topic-arn "${arn}" --region "${AWS_REGION}"
  echo "  OK: SNS topic gone: ${arn}"
done

# 6c: the out-of-band secret is not cdkd's to delete; it must still exist,
# then this script removes it.
if ! aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "FAIL: destroy removed the out-of-band secret '${SECRET_NAME}', which cdkd does not manage" >&2
  exit 1
fi
aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
  --force-delete-without-recovery --region "${AWS_REGION}" >/dev/null
if ! aws ssm get-parameter --name "${PIN_SSM_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "FAIL: destroy removed the out-of-band SecureString '${PIN_SSM_PARAM_NAME}', which cdkd does not manage" >&2
  exit 1
fi
aws ssm delete-parameter --name "${PIN_SSM_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null
echo "  OK: out-of-band secret and SecureString left intact by destroy, removed by the fixture"
# The #4543 arm's fixed-name parameter, by its name too (6b reads the names
# from state, which a lost record would hide).
assert_gone "SSM parameter '${W1_PARAM_NAME}' (base64 of a script carrying the w1 plaintext) still exists after destroy" \
  aws ssm get-parameter --name "${W1_PARAM_NAME}" --region "${AWS_REGION}"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH (issue #2096) -----------
# 6a's head-object is on the CURRENT object; the bucket is VERSIONED, so every
# state.json this run wrote at every level stays readable behind a delete
# marker until swept. The traps' noncurrent-only purge is not enough here.
echo ""
echo "==> Step 7: state-version sweep across all four levels"
trap - EXIT INT TERM
for lvl in "${LEVELS[@]}"; do
  prefix="$(s3_stack_prefix "${lvl}" "${AWS_REGION}")"
  s3_purge_prefix_versions "${STATE_BUCKET}" "${prefix}" all || true
  s3_assert_versions_swept "${STATE_BUCKET}" "${prefix}" "nested-stack-3level state teardown (${lvl})"
done

echo ""
echo "==> PASS: 4-level nested-stack deploy / parent-link / state-tree / destroy-cascade verified, the #3094 secret chain per leaf, the #3156 and #3306 framed carries, the #4543 root-passed input of a masked child property, zero surviving state versions"
