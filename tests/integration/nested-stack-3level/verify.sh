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

# Collected physical ids (filled during the post-deploy state read) so the
# post-destroy sweep can confirm each one is gone on AWS.
SSM_PARAM_NAMES=()
SNS_TOPIC_ARNS=()

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${AWS_REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PIN_SSM_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
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
       --secret-string "{\"handoff\":\"${HANDOFF_PW_VALUE}\",\"pin\":\"${PIN_OUT_VALUE}\"}" \
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
  for plaintext in "${HANDOFF_PW_VALUE}" "${PIN_SSM_FRAMED}" "${PIN_OUT_FRAMED}"; do
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
for name in GcSsmPass GcSsmWrap GcOutPass GcOutWrap; do
  GC_LINE_PREFIXES+=("Parameter ${name}: using user-provided value " "Resolved Ref to parameter: ${name} -> ")
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

# Sanity: we should have collected 10 SSM params (RootRef, Child.Param,
# Grandchild.Param, Grandchild.SecretA, Grandchild.SecretB,
# GreatGrandchild.Param, and the #3156 grandchild's four consumers) and 2 SNS
# topics (RootTopic, Grandchild.Topic) across the tree.
if [[ ${#SSM_PARAM_NAMES[@]} -ne 10 ]]; then
  echo "FAIL: expected 10 SSM parameters across the tree, found ${#SSM_PARAM_NAMES[@]}: ${SSM_PARAM_NAMES[*]}"
  exit 1
fi
if [[ ${#SNS_TOPIC_ARNS[@]} -ne 2 ]]; then
  echo "FAIL: expected 2 SNS topics across the tree, found ${#SNS_TOPIC_ARNS[@]}: ${SNS_TOPIC_ARNS[*]}"
  exit 1
fi
echo "  OK: 6 state files, 10 SSM params + 2 SNS topics collected across all levels"

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
  for plaintext in "${HANDOFF_PW_VALUE}" "${PIN_SSM_FRAMED}" "${PIN_OUT_FRAMED}"; do
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
assert_eq "premise: the root's Framed row passes down exactly MidPinSsm and MidPinOut" \
  "$(jq -c '.Resources.Framed.Properties.Parameters | keys' "${ROOT_TEMPLATE}")" '["MidPinOut","MidPinSsm"]'
assert_eq "premise: MidPinSsm is an Fn::Join whose ONE token spells ssm: with the account Ref inside it" \
  "$(jq -c '.Resources.Framed.Properties.Parameters.MidPinSsm' "${ROOT_TEMPLATE}")" \
  '{"Fn::Join":["",["pin3156s:{{resolve:ssm:cdkd-3level-pinssm-",{"Ref":"AWS::AccountId"},"}}"]]}'
assert_eq "premise: MidPinOut is an Fn::Join whose token is followed by a region Ref OUTSIDE it" \
  "$(jq -c '.Resources.Framed.Properties.Parameters.MidPinOut' "${ROOT_TEMPLATE}")" \
  '{"Fn::Join":["",["pin3156o:{{resolve:secretsmanager:cdkd-3level-secret-",{"Ref":"AWS::AccountId"},":SecretString:pin}}@",{"Ref":"AWS::Region"}]]}'
FRAMED_TEMPLATE="cdk.out/$(jq -r '.Resources.Framed.Metadata["aws:asset:path"] // empty' "${ROOT_TEMPLATE}")"
[[ -f "${FRAMED_TEMPLATE}" ]] || { echo "FAIL: premise: the Framed nested template was not found (${FRAMED_TEMPLATE})" >&2; exit 1; }
assert_eq "premise: the middle stack owns only its nested-stack row (and CDK metadata)" \
  "$(jq -c '[.Resources | to_entries[] | select(.value.Type != "AWS::CDK::Metadata") | .key]' "${FRAMED_TEMPLATE}")" \
  '["FramedGrandchild"]'
# Its row's Parameters are EXACTLY the four hand-offs, each a `Ref` to a
# middle parameter or `m-` joined to one: nothing else in the middle can put a
# pair into that row's bag.
assert_eq "premise: the middle's nested-stack row passes down only Refs to its own parameters, bare or m- joined" \
  "$(jq -c '.Resources.FramedGrandchild.Properties.Parameters' "${FRAMED_TEMPLATE}")" \
  '{"GcSsmPass":{"Ref":"MidPinSsm"},"GcSsmWrap":{"Fn::Join":["",["m-",{"Ref":"MidPinSsm"}]]},"GcOutPass":{"Ref":"MidPinOut"},"GcOutWrap":{"Fn::Join":["",["m-",{"Ref":"MidPinOut"}]]}}'
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
# The MIDDLE's row, pass-through and re-wrapped.
assert_eq "middle row keeps GcSsmPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcSsmPass')" "${PIN_SSM_EXPR}"
assert_eq "middle row keeps GcSsmWrap (m- + {Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcSsmWrap')" "m-${PIN_SSM_EXPR}"
assert_eq "middle row keeps GcOutPass ({Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcOutPass')" "${PIN_OUT_EXPR}"
assert_eq "middle row keeps GcOutWrap (m- + {Ref}) as the framed expression" \
  "$(jq_of "${FRAMED_JSON}" '.resources.FramedGrandchild.properties.Parameters.GcOutWrap')" "m-${PIN_OUT_EXPR}"
# The GRANDCHILD's leaves, and the live values they resolved to.
for name in SsmPass SsmWrap OutPass OutWrap; do
  case "${name}" in
    SsmPass) expr="${PIN_SSM_EXPR}"; plain="${PIN_SSM_FRAMED}" ;;
    SsmWrap) expr="m-${PIN_SSM_EXPR}"; plain="m-${PIN_SSM_FRAMED}" ;;
    OutPass) expr="${PIN_OUT_EXPR}"; plain="${PIN_OUT_FRAMED}" ;;
    OutWrap) expr="m-${PIN_OUT_EXPR}"; plain="m-${PIN_OUT_FRAMED}" ;;
  esac
  assert_eq "grandchild Framed${name} persists gc- + the framed expression" \
    "$(jq_of "${FRAMED_GC_JSON}" ".resources.Framed${name}.properties.Value")" "gc-${expr}"
  live_name="$(jq_of "${FRAMED_GC_JSON}" ".resources.Framed${name}.physicalId")"
  assert_eq "live Framed${name} holds gc- + the resolved framed value" \
    "$(aws ssm get-parameter --name "${live_name}" --region "${AWS_REGION}" --query 'Parameter.Value' --output text)" \
    "gc-${plain}"
done

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
echo "==> PASS: 4-level nested-stack deploy / parent-link / state-tree / destroy-cascade verified, the #3094 secret chain per leaf, the #3156 framed carries, zero surviving state versions"
