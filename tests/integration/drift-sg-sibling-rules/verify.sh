#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6418.
#
# A rule a sibling standalone AWS::EC2::SecurityGroupIngress / Egress
# authorizes on a security group is that resource's, not the group's. Before
# the fix, on a group declaring an inline rule list, `cdkd drift` reported it
# on a fresh stack as
#   ~ SgA... (AWS::EC2::SecurityGroup)  SecurityGroupIngress: [443] -> [443, 5432]
# and `cdkd drift --revert -y` REVOKED it, printing success.
#
# Phases:
#   1. Deploy SgA (inline 443 ingress + inline 443 egress) and SgB (inline 22
#      ingress) plus three standalone rules: SgA ingress 5432 from SgB, SgA
#      egress 8080 to SgB, SgB ingress 8080 from SgA. Assert all live.
#   2. `cdkd drift` exits 0: no drift on either group.
#   3. UPDATE SgA (CDKD_TEST_UPDATE=inline adds an inline 8443 ingress) while
#      the sibling rules exist; its re-captured baseline must not record them,
#      and `cdkd drift` still exits 0.
#   4. Authorize a 9999 ingress on SgA OUT OF BAND: `cdkd drift` exits 1 and
#      names 9999, never the sibling's 5432.
#   5. `cdkd drift --revert -y` revokes 9999 ONLY: every sibling rule stays.
#   6. `cdkd drift` exits 0 again.
#   6b. (go-to-k/cdkd#6420) Plant the sibling's 5432 rule in SgA's recorded
#      baseline (what a pre-#6418 binary recorded on a group UPDATE), then
#      remove the standalone 5432 rule (CDKD_TEST_UPDATE=inline,nofrom). The
#      deploy drops the rule from the baseline, `cdkd drift` exits 0 and
#      `--revert -y` does not re-authorize 5432.
#   7. Destroy + gone-probes.
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

cd "$(dirname "$0")"
. ../revert-identity.sh
REVERT_DIR=""

STACK="CdkdDriftSgSiblingRulesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Phase 3 sets the mode; an inherited value would deploy it early.
unset CDKD_TEST_UPDATE
DRIFT_LOG=""
PLANT_FILE=""
GROUP_A=""
GROUP_B=""
VPC_ID=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}" "${PLANT_FILE:-}"
  [ -n "${REVERT_DIR:-}" ] && rm -rf "${REVERT_DIR}"
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
REVERT_DIR="$(mktemp -d)"

# The FromPort list of one direction of a group, sorted numerically,
# space-joined. `-1` stands for an all-ports rule.
ports() { # usage: ports <group-id> IpPermissions|IpPermissionsEgress
  local out
  out="$(aws ec2 describe-security-groups --group-ids "$1" \
    --query "SecurityGroups[0].$2[].[FromPort || \`-1\`]" --output text)" || return 1
  printf '%s\n' "${out}" | tr -s ' \t' '\n' | grep -v '^$' | sort -n | tr '\n' ' ' | sed 's/ $//'
}
read_ports() { # sets A_IN / A_OUT / B_IN; top level only, so a failed read ends the RUN
  if ! A_IN="$(ports "${GROUP_A}" IpPermissions)"; then
    echo "FAIL: describe-security-groups ${GROUP_A} failed" >&2
    exit 1
  fi
  if ! A_OUT="$(ports "${GROUP_A}" IpPermissionsEgress)"; then
    echo "FAIL: describe-security-groups ${GROUP_A} (egress) failed" >&2
    exit 1
  fi
  if ! B_IN="$(ports "${GROUP_B}" IpPermissions)"; then
    echo "FAIL: describe-security-groups ${GROUP_B} failed" >&2
    exit 1
  fi
}
expect_ports() { # usage: expect_ports <label> <got> <want>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 ports: want [$3], got [$2]" >&2
    exit 1
  fi
  echo "    ok: $1 ports [$2]"
}
run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
expect_drift_rc() { # usage: expect_drift_rc <want> <phase label>
  if [ "${DRIFT_RC}" != "$1" ]; then
    echo "FAIL: $2: cdkd drift exited ${DRIFT_RC}, want $1" >&2
    exit 1
  fi
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
GROUP_A="$(jq -r '.outputs.GroupA // empty' <<<"${STATE_JSON}")"
GROUP_B="$(jq -r '.outputs.GroupB // empty' <<<"${STATE_JSON}")"
VPC_ID="$(jq -r '.outputs.VpcId // empty' <<<"${STATE_JSON}")"
case "${GROUP_A}" in sg-?*) ;; *) echo "FAIL: GroupA output is not a group id: '${GROUP_A}'" >&2; exit 1 ;; esac
case "${GROUP_B}" in sg-?*) ;; *) echo "FAIL: GroupB output is not a group id: '${GROUP_B}'" >&2; exit 1 ;; esac
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: VpcId output is not a VPC id: '${VPC_ID}'" >&2; exit 1 ;; esac
read_ports
expect_ports "SgA ingress" "${A_IN}" "443 5432"
expect_ports "SgA egress" "${A_OUT}" "443 8080"
expect_ports "SgB ingress" "${B_IN}" "22 8080"
# go-to-k/cdkd#6609: the baseline captured right after the create holds each
# group's own written rules (the sibling-owned 5432 / 8080 stripped), read off
# the state record itself: drift alone cannot see a stale baseline while the
# live rules are the declared ones.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
baseline_ports() { # usage: baseline_ports <group id> <member key>
  jq -r --arg g "$1" --arg k "$2" \
    '[.resources[] | select(.resourceType == "AWS::EC2::SecurityGroup" and .physicalId == $g)
      | .observedProperties[$k][]? | .FromPort // .IpProtocol] | map(tostring) | sort | join(" ")' \
    <<<"${STATE_JSON}"
}
expect_ports "SgA ingress baseline after the create (#6609)" "$(baseline_ports "${GROUP_A}" SecurityGroupIngress)" "443"
expect_ports "SgA egress baseline after the create (#6609)" "$(baseline_ports "${GROUP_A}" SecurityGroupEgress)" "443"
expect_ports "SgB ingress baseline after the create (#6609)" "$(baseline_ports "${GROUP_B}" SecurityGroupIngress)" "22"
expect_ports "SgB egress baseline after the create (#6609)" "$(baseline_ports "${GROUP_B}" SecurityGroupEgress)" "-1"

echo "==> Phase 2: cdkd drift on the fresh stack reports no drift"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: UPDATE SgA while the sibling rules exist"
CDKD_TEST_UPDATE=inline node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
read_ports
expect_ports "SgA ingress (after update)" "${A_IN}" "443 5432 8443"
expect_ports "SgA egress (after update)" "${A_OUT}" "443 8080"
expect_ports "SgB ingress (after update)" "${B_IN}" "22 8080"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
SG_A_LID="$(jq -r --arg g "${GROUP_A}" \
  '.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup" and .value.physicalId == $g) | .key' \
  <<<"${STATE_JSON}")"
if [ -z "${SG_A_LID}" ]; then
  echo "FAIL: no AWS::EC2::SecurityGroup record holds ${GROUP_A}" >&2
  exit 1
fi
BASE_IN="$(jq -r --arg l "${SG_A_LID}" \
  '[.resources[$l].observedProperties.SecurityGroupIngress[]?.FromPort] | sort | map(tostring) | join(" ")' \
  <<<"${STATE_JSON}")"
BASE_OUT="$(jq -r --arg l "${SG_A_LID}" \
  '[.resources[$l].observedProperties.SecurityGroupEgress[]?.FromPort] | sort | map(tostring) | join(" ")' \
  <<<"${STATE_JSON}")"
expect_ports "SgA re-captured ingress baseline" "${BASE_IN}" "443 8443"
expect_ports "SgA re-captured egress baseline" "${BASE_OUT}" "443"
run_drift
expect_drift_rc 0 "Phase 3"

echo "==> Phase 4: an out-of-band 9999 ingress on SgA is drift"
aws ec2 authorize-security-group-ingress --group-id "${GROUP_A}" \
  --ip-permissions 'IpProtocol=tcp,FromPort=9999,ToPort=9999,IpRanges=[{CidrIp=10.9.0.0/16}]' >/dev/null
run_drift
expect_drift_rc 1 "Phase 4"
# Sentinel: the drifted block must be the group's (its header line), so a
# reworded report cannot pass the port greps below vacuously.
if ! grep -q "(AWS::EC2::SecurityGroup)" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: no AWS::EC2::SecurityGroup drift block — the report wording drifted" >&2
  exit 1
fi
if ! grep -q '"FromPort":9999' "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: the drift report does not name the out-of-band 9999 rule" >&2
  exit 1
fi
if grep -qE '"FromPort":(5432|8080)' "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: the drift report names a sibling-owned rule (5432 / 8080)" >&2
  exit 1
fi

echo "==> Phase 5: cdkd drift --revert -y revokes only the out-of-band rule"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-5-before" "${STACK}" "${SG_A_LID}" || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_DIR}/revert-ids-5-before" "${REVERT_DIR}/revert-ids-5-after" 1 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 5"
read_ports
expect_ports "SgA ingress (after revert)" "${A_IN}" "443 5432 8443"
expect_ports "SgA egress (after revert)" "${A_OUT}" "443 8080"
expect_ports "SgB ingress (after revert)" "${B_IN}" "22 8080"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

# go-to-k/cdkd#6609: `cdkd drift --revert` acts on what the capture recorded,
# so an out-of-band change of a member must report, revert to the template in
# place (same physical id, no delete / create), and leave drift clean.
revert_drift_json() { # usage: revert_drift_json [env args...] -- prints `cdkd drift --json`; exit 0..2 is a report
  local out rc=0
  out=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${out}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report (#6609 revert arm)" >&2
    printf '%s\n' "${out}" >&2
    return 1
  fi
  printf '%s' "${out}"
}
assert_member_drifted() { # usage: assert_member_drifted <drift JSON> <type> <member key> <label>
  jq -e --arg t "$2" --arg k "$3" '
    def member: .path == $k or (.path | startswith($k + ".")) or (.path | startswith($k + "["));
    [.[] | (.drifted // [])[] | select(.type == $t) | .changes[] | select(member)] | length > 0
  ' <<<"$1" >/dev/null || {
    echo "FAIL: cdkd drift does not report the out-of-band $2 $3 after $4 (#6609)" >&2
    printf '%s\n' "$1" >&2
    exit 1
  }
  echo "    OK: cdkd drift reports the out-of-band $2 $3 after $4 (#6609)"
}
assert_drift_clean() { # usage: assert_drift_clean <label> [env args...]
  local rc=0 label="$1"
  shift
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || rc=$?
  [ "${rc}" -eq 0 ] || { echo "FAIL: cdkd drift exited ${rc} after ${label}, want 0 (#6609)" >&2; exit 1; }
  echo "    OK: cdkd drift is clean after ${label} (#6609)"
}
run_revert() { # usage: run_revert [env args...]
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
}
assert_same() { # usage: assert_same <label> <before> <after>
  [ -n "$2" ] && [ "$2" = "$3" ] || { echo "FAIL: $1 changed across the revert: '$2' -> '$3' (#6609: a delete / create)" >&2; exit 1; }
  echo "    OK: $1 unchanged across the revert ($2)"
}

echo "==> Phase 6a: a revoked DECLARED SgA rule is reverted in place (#6609)"
SG_A_PID_BEFORE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "${SG_A_LID}" '.resources[$l].physicalId')"
aws ec2 revoke-security-group-ingress --group-id "${GROUP_A}" --region "${REGION}" \
  --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=10.0.0.0/16}]' >/dev/null
read_ports
expect_ports "SgA ingress (443 revoked out of band)" "${A_IN}" "5432 8443"
DRIFT_6A="$(revert_drift_json)" || exit 1
assert_member_drifted "${DRIFT_6A}" AWS::EC2::SecurityGroup SecurityGroupIngress "an out-of-band revoke"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-6a-before" "${STACK}" "${SG_A_LID}" || exit 1
REVERT_6A_RC=0
run_revert >"${REVERT_DIR}/revert-6a.log" 2>&1 || REVERT_6A_RC=$?
sed 's/^/    | /' "${REVERT_DIR}/revert-6a.log"
revert_identity_verify "${REVERT_DIR}/revert-ids-6a-before" "${REVERT_DIR}/revert-ids-6a-after" 1 "${REVERT_DIR}/revert-6a.log" || exit 1
[ "${REVERT_6A_RC}" -eq 0 ] || { echo "FAIL: Phase 6a: cdkd drift --revert exited ${REVERT_6A_RC}, want 0" >&2; exit 1; }
read_ports
expect_ports "SgA ingress (after the revert)" "${A_IN}" "443 5432 8443"
expect_ports "SgA egress (after the revert)" "${A_OUT}" "443 8080"
expect_ports "SgB ingress (after the revert)" "${B_IN}" "22 8080"
assert_same "SgA's state physical id" "${SG_A_PID_BEFORE}" \
  "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "${SG_A_LID}" '.resources[$l].physicalId')"
assert_same "SgA's group id" "${GROUP_A}" "${SG_A_PID_BEFORE}"
aws ec2 describe-security-groups --group-ids "${GROUP_A}" --region "${REGION}" >/dev/null \
  || { echo "FAIL: ${GROUP_A} is gone after the revert (#6609)" >&2; exit 1; }
assert_drift_clean "the phase 6a revert"

echo "==> Phase 6b: plant the sibling's 5432 rule in SgA's recorded baseline (go-to-k/cdkd#6420)"
# The capture leaves sibling rules out since #6418, so a baseline holding one
# is what an older binary recorded on a group UPDATE. Planted so the arm does
# not depend on that binary.
PLANT_FILE="$(mktemp)"
if ! aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
      const s = JSON.parse(d);
      const g = Object.values(s.resources).find(
        (r) => r.resourceType === "AWS::EC2::SecurityGroup" && r.physicalId === process.argv[1]);
      const rules = g && g.observedProperties && g.observedProperties.SecurityGroupIngress;
      if (!Array.isArray(rules)) { process.stderr.write("group has no baseline SecurityGroupIngress\n"); process.exit(1); }
      rules.push({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: process.argv[2],
        SourceSecurityGroupOwnerId: process.argv[3], Description: "from B" });
      process.stdout.write(JSON.stringify(s));
    });' "${GROUP_A}" "${GROUP_B}" "$(aws sts get-caller-identity --query Account --output text)" >"${PLANT_FILE}"; then
  rm -f "${PLANT_FILE}"
  echo "FAIL: premise: could not plant the 5432 rule in ${GROUP_A}'s recorded baseline" >&2
  exit 1
fi
aws s3 cp "${PLANT_FILE}" "s3://${STATE_BUCKET}/${STATE_KEY}" --content-type application/json >/dev/null
rm -f "${PLANT_FILE}"
# While the sibling record exists, #6418's strip already hides the planted rule.
run_drift
expect_drift_rc 0 "Phase 6b (planted, sibling still recorded)"
echo "==> Phase 6b: remove the standalone 5432 ingress"
CDKD_TEST_UPDATE=inline,nofrom node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
read_ports
expect_ports "SgA ingress (sibling removed)" "${A_IN}" "443 8443"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
BASE_IN="$(jq -r --arg l "${SG_A_LID}" \
  '[.resources[$l].observedProperties.SecurityGroupIngress[]?.FromPort] | sort | map(tostring) | join(" ")' \
  <<<"${STATE_JSON}")"
expect_ports "SgA baseline after the sibling's removal" "${BASE_IN}" "443 8443"
run_drift
expect_drift_rc 0 "Phase 6b (sibling removed)"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-6b-before" "${STACK}" "${SG_A_LID}" || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_DIR}/revert-ids-6b-before" "${REVERT_DIR}/revert-ids-6b-after" 1 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 6b (--revert)"
read_ports
expect_ports "SgA ingress (after --revert)" "${A_IN}" "443 8443"

echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "security group ${GROUP_A} leaked" aws ec2 describe-security-groups --group-ids "${GROUP_A}"
assert_gone "security group ${GROUP_B} leaked" aws ec2 describe-security-groups --group-ids "${GROUP_B}"
assert_gone "VPC ${VPC_ID} leaked" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}"
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
rm -rf "${REVERT_DIR}"
echo "PASS: drift-sg-sibling-rules"
