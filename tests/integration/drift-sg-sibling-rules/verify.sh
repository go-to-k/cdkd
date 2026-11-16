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

STACK="CdkdDriftSgSiblingRulesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Phase 3 sets the mode; an inherited value would deploy it early.
unset CDKD_TEST_UPDATE
DRIFT_LOG=""
GROUP_A=""
GROUP_B=""
VPC_ID=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
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
run_drift --revert -y
expect_drift_rc 0 "Phase 5"
read_ports
expect_ports "SgA ingress (after revert)" "${A_IN}" "443 5432 8443"
expect_ports "SgA egress (after revert)" "${A_OUT}" "443 8080"
expect_ports "SgB ingress (after revert)" "${B_IN}" "22 8080"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "security group ${GROUP_A} leaked" aws ec2 describe-security-groups --group-ids "${GROUP_A}"
assert_gone "security group ${GROUP_B} leaked" aws ec2 describe-security-groups --group-ids "${GROUP_B}"
assert_gone "VPC ${VPC_ID} leaked" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}"
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
echo "PASS: drift-sg-sibling-rules"
