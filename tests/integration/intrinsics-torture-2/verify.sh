#!/usr/bin/env bash
# verify.sh — Intrinsics Torture Test #2.
#
# Surfaces intrinsic-resolution bugs in the HARDER arg-shapes that the
# sibling `intrinsics-torture` fixture (which found bug #838) did not cover.
# Each torture intrinsic feeds a real `AWS::SSM::Parameter.Value`; this
# script deploys, reads each parameter back, and asserts it equals the
# concrete value computed in-script from account/region. A wrong/failed
# resolution FAILS the run naming the offending intrinsic.
#
# If `cdkd deploy` itself fails (the LIKELY outcome — surfacing a real
# resolver bug), the trap prints triage context (cdkd state + the synth
# template's intrinsic blocks) so the failing resource + error are visible.
#
# BSD-portable (no `grep -P`, no `date -d`), captures the real exit code,
# and prints an explicit "All N checks passed" line on success.
#
# Run via: /run-integ intrinsics-torture-2
#      or:  bash tests/integration/intrinsics-torture-2/verify.sh

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="CdkdIntrinsicsTorture2Example"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"
NAME_PREFIX="/cdkd-integ/intrinsics-torture-2"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo "    PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}
fail() {
  echo "    FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  # Best-effort direct SSM cleanup in case a partial deploy left parameters.
  for n in select-getazs select-split findinmap-refkey findinmap-default \
           getatt-refattr sub-escape base64-intrinsic nested-if-sub-join \
           cidr-ipv6 cidr-ipv4; do
    aws ssm delete-parameter --region "${AWS_REGION}" --name "${NAME_PREFIX}/${n}" >/dev/null 2>&1 || true
  done
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Triage helper: dump state + synth on a deploy failure so the failing
# resource + error are visible for diagnosis.
triage() {
  echo ""
  echo "==> TRIAGE: deploy failed — dumping cdkd state + synth intrinsic blocks"
  echo "--- cdkd state (if any) ---"
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || echo "(no state written)"
  echo "--- synth template (intrinsic Values) ---"
  npx cdk synth --app "node bin/app.ts" 2>/dev/null | grep -E "Fn::|Ref:|DefaultValue" || true
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo ""
echo "==> Pre-flight: stale state check"
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: stack state already exists at ${STATE_KEY} — clean up first."
  exit 1
fi
echo "    no stale state (the SSM params are managed by the stack)"

# ---- Compute expected values in-script ----
echo ""
echo "==> Computing expected concrete values"

# 1a) Fn::Select[1, Fn::GetAZs('')] -> the resolver sorts AZ names, so the
#     2nd entry of the sorted available-AZ list in this region.
EXPECT_SELECT_GETAZS=$(aws ec2 describe-availability-zones \
  --region "${AWS_REGION}" \
  --filters "Name=region-name,Values=${AWS_REGION}" "Name=state,Values=available" \
  --query 'AvailabilityZones[].ZoneName' --output text \
  | tr '\t' '\n' | sort | sed -n '2p')
echo "    select-getazs   -> ${EXPECT_SELECT_GETAZS}"

# 1b) Fn::Select[0, Fn::Split(',', 'alpha,bravo,charlie')] -> alpha
EXPECT_SELECT_SPLIT="alpha"
echo "    select-split    -> ${EXPECT_SELECT_SPLIT}"

# 2a) FindInMap[RegionMap, {Ref: AWS::Region}, theKey] in us-east-1 -> hit.
#     The map only carries us-east-1 + ap-northeast-1 entries, so this is a
#     HIT only when running in us-east-1; otherwise the 4th-arg default test
#     (2b) is the meaningful one. Compute from the region.
case "${AWS_REGION}" in
  us-east-1) EXPECT_FINDINMAP_REFKEY="nvirginia-hit" ;;
  ap-northeast-1) EXPECT_FINDINMAP_REFKEY="tokyo-hit" ;;
  *) EXPECT_FINDINMAP_REFKEY="__MISS__" ;;  # no map entry -> would be a real miss
esac
echo "    findinmap-refkey-> ${EXPECT_FINDINMAP_REFKEY}"

# 2b) FindInMap[..., 'eu-west-3', ..., {DefaultValue: 'fallback-value'}] ->
#     eu-west-3 is absent -> the enhanced 4th-arg default fires.
EXPECT_FINDINMAP_DEFAULT="fallback-value"
echo "    findinmap-default-> ${EXPECT_FINDINMAP_DEFAULT}"

# 3) GetAtt[Topic, {Ref: AttrNameParam='TopicArn'}] -> the topic ARN. The
#    physical id is unknown pre-deploy; the stack also exports it as
#    TopicArn, so we read it from state outputs after deploy (set below).
echo "    getatt-refattr  -> (topic ARN, read from deploy outputs)"

# 4) Fn::Sub 'before-${!NotAVar}-after' -> literal ${} survives the escape.
EXPECT_SUB_ESCAPE='before-${NotAVar}-after'
echo "    sub-escape      -> ${EXPECT_SUB_ESCAPE}"

# 5) Fn::Base64 of 'cdkd-base64-source'
EXPECT_BASE64=$(printf '%s' 'cdkd-base64-source' | base64)
echo "    base64-intrinsic-> ${EXPECT_BASE64}"

# 6) Join('-', ['head', Sub('seg-${V=mid}'), If(true,'yes','no')]) -> head-seg-mid-yes
EXPECT_NESTED="head-seg-mid-yes"
echo "    nested-if-sub-join-> ${EXPECT_NESTED}"

# 7a) Fn::Cidr IPv6 ['2001:db8::/56', 4, 64] Select[0] (uncompressed groups)
EXPECT_CIDR_IPV6="2001:db8:0:0:0:0:0:0/64"
echo "    cidr-ipv6       -> ${EXPECT_CIDR_IPV6}"

# 7b) Fn::Cidr IPv4 ['10.0.0.0/24', 4, 4] Select[2] -> 10.0.0.32/28
EXPECT_CIDR_IPV4="10.0.0.32/28"
echo "    cidr-ipv4       -> ${EXPECT_CIDR_IPV4}"

# ---- Deploy ----
echo ""
echo "==> Step 1: Deploy stack"
set +e
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
DEPLOY_RC=$?
set -e
if [[ ${DEPLOY_RC} -ne 0 ]]; then
  triage
  echo ""
  echo "==> Deploy FAILED (rc=${DEPLOY_RC}). This likely surfaced a real intrinsic-resolution bug."
  echo "==> intrinsics-torture-2 result: FAIL (deploy)"
  exit 1
fi

# ---- Read each SSM parameter back + assert ----
echo ""
echo "==> Step 2: Read each SSM parameter back and assert"

getp() {
  aws ssm get-parameter --region "${AWS_REGION}" --name "${NAME_PREFIX}/$1" \
    --query 'Parameter.Value' --output text 2>/dev/null
}

assert_eq() {
  # $1 = intrinsic label, $2 = expected, $3 = actual
  if [[ "$3" == "$2" ]]; then
    pass "$1 = '$3'"
  else
    fail "$1: expected '$2' but got '$3'"
  fi
}

# GetAtt-Ref-attr expected = topic ARN from state outputs.
EXPECT_GETATT=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.outputs&&j.outputs.TopicArn)||"")}catch(e){process.stdout.write("")}})')
if [[ -z "${EXPECT_GETATT}" ]]; then
  # Fallback: derive the canonical SNS ARN shape (arn:aws:sns:region:account:<name>).
  EXPECT_GETATT="(unresolved-topic-arn)"
fi

assert_eq "Fn::Select[1, Fn::GetAZs('')]"            "${EXPECT_SELECT_GETAZS}"  "$(getp select-getazs)"
assert_eq "Fn::Select[0, Fn::Split(',', Ref)]"       "${EXPECT_SELECT_SPLIT}"   "$(getp select-split)"
if [[ "${EXPECT_FINDINMAP_REFKEY}" != "__MISS__" ]]; then
  assert_eq "Fn::FindInMap[Map, {Ref: AWS::Region}, k]" "${EXPECT_FINDINMAP_REFKEY}" "$(getp findinmap-refkey)"
else
  echo "    SKIP: findinmap-refkey (region ${AWS_REGION} not in RegionMap — run in us-east-1)"
fi
assert_eq "Fn::FindInMap[...4th-arg DefaultValue]"   "${EXPECT_FINDINMAP_DEFAULT}" "$(getp findinmap-default)"
assert_eq "Fn::GetAtt[Topic, {Ref: AttrNameParam}]"  "${EXPECT_GETATT}"         "$(getp getatt-refattr)"
assert_eq "Fn::Sub '\${!Literal}' escape"            "${EXPECT_SUB_ESCAPE}"     "$(getp sub-escape)"
assert_eq "Fn::Base64 of {Ref: ...}"                 "${EXPECT_BASE64}"         "$(getp base64-intrinsic)"
assert_eq "Fn::Join[If[Sub]] triple-nest"            "${EXPECT_NESTED}"         "$(getp nested-if-sub-join)"
assert_eq "Fn::Cidr IPv6 Select[0]"                  "${EXPECT_CIDR_IPV6}"      "$(getp cidr-ipv6)"
assert_eq "Fn::Cidr IPv4 (cidrBits=4) Select[2]"     "${EXPECT_CIDR_IPV4}"      "$(getp cidr-ipv4)"

# ---- Destroy + verify clean ----
echo ""
echo "==> Step 3: cdkd destroy ${STACK} --force"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Step 3a: Verify cdkd state cleared"
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  pass "cdkd state cleared"
else
  fail "cdkd state still exists at ${STATE_KEY} after destroy"
fi

echo ""
echo "==> Step 3b: Verify SSM parameters gone"
STILL_THERE=0
for n in select-getazs select-split findinmap-default getatt-refattr \
         sub-escape base64-intrinsic nested-if-sub-join cidr-ipv6 cidr-ipv4; do
  if ! gone_probe aws ssm get-parameter --region "${AWS_REGION}" --name "${NAME_PREFIX}/${n}"; then
    fail "SSM parameter ${n} survived destroy (orphan)"
    STILL_THERE=$((STILL_THERE + 1))
  fi
done
if [[ ${STILL_THERE} -eq 0 ]]; then
  pass "all SSM parameters deleted (no orphans)"
fi

# ---- Summary ----
echo ""
echo "==> Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
if [[ ${FAIL_COUNT} -ne 0 ]]; then
  echo "==> intrinsics-torture-2 result: FAIL"
  exit 1
fi
echo "==> All ${PASS_COUNT} checks passed"
echo "==> intrinsics-torture-2 result: PASS"
trap - EXIT INT TERM
