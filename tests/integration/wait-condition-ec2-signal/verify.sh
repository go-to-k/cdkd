#!/usr/bin/env bash
# verify.sh — WaitCondition signalled from EC2 user data (issue #6694).
# Phases: deploy (the instance signals the handle URL twice, cfn-signal + curl;
# the WaitCondition with Count 2 completes; Data reaches the output) ->
# destroy (the handle's signal object versions are removed with it).

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

STACK="CdkdWaitConditionEc2Signal"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Every version of one key, delete markers included, counted as rows.
signal_versions() { # usage: signal_versions <key>
  local out
  out=$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "$1" \
    --region "${REGION}" --output json) || return 1
  printf '%s' "${out}" | KEY="$1" node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const r = d.trim() === "" ? {} : JSON.parse(d);
      const all = (r.Versions ?? []).concat(r.DeleteMarkers ?? []);
      process.stdout.write(String(all.filter((v) => v.Key === process.env.KEY).length));
    });'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Phase 1: Deploy (user data signals the handle; WaitCondition Count 2; --concurrency 1)"
# --concurrency 1 (issue #6704): the template has no DependsOn from the wait to
# the instance, so only the implicit signaller edge stops the wait from taking
# the one slot first and timing out.
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --concurrency 1 --yes

STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
read_state() { # usage: read_state <js expression over s>
  printf '%s' "${STATE_JSON}" | EXPR="$1" node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const s = JSON.parse(d);
      const v = eval(process.env.EXPR);
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });'
}
HANDLE_URL=$(read_state 's.resources.Handle && s.resources.Handle.physicalId')
case "${HANDLE_URL}" in
  https://*X-Amz-Signature=*) echo "    OK: handle physical id is a pre-signed URL" ;;
  *) echo "FAIL: handle physical id is not a pre-signed URL" >&2; exit 1 ;;
esac
SIGNAL_KEY=$(printf '%s' "${HANDLE_URL}" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const p = decodeURIComponent(new URL(d).pathname);
    const at = p.indexOf("/wait-condition-signals/");
    process.stdout.write(at < 0 ? "" : p.slice(at + 1));
  });')
case "${SIGNAL_KEY}" in
  wait-condition-signals/Handle-*.json) echo "    OK: signal key ${SIGNAL_KEY}" ;;
  *) echo "FAIL: unexpected signal key '${SIGNAL_KEY}'" >&2; exit 1 ;;
esac

WAIT_DATA=$(read_state 's.outputs && s.outputs.WaitData')
DATA_OK=$(printf '%s' "${WAIT_DATA}" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    let o; try { o = JSON.parse(d); } catch { o = {}; }
    process.stdout.write(o.boot === "booted" && o.app === "ready" && Object.keys(o).length === 2 ? "yes" : "no");
  });')
[ "${DATA_OK}" = "yes" ] || { echo "FAIL: WaitData output is '${WAIT_DATA}'" >&2; exit 1; }
echo "    OK: WaitCondition completed with both signals (${WAIT_DATA})"

VERSIONS=$(signal_versions "${SIGNAL_KEY}")
[ "${VERSIONS}" = "2" ] || { echo "FAIL: expected 2 signal versions, found ${VERSIONS}" >&2; exit 1; }
echo "    OK: two signal versions stored under the handle key"

# The signature must not appear in cdkd's own state display.
SHOWN=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
grep -q 'wait-condition-signals/Handle-' <<<"${SHOWN}" \
  || { echo "FAIL: state show does not list the handle URL (sentinel)" >&2; exit 1; }
if grep -q 'X-Amz-Signature=' <<<"${SHOWN}"; then
  echo "FAIL: state show prints the handle URL's signature" >&2
  exit 1
fi
grep -qE 'wait-condition-signals/Handle-[^ ]*\.json\?\*\*\*\*' <<<"${SHOWN}" \
  || { echo "FAIL: state show does not print the handle URL in its masked form" >&2; exit 1; }
echo "    OK: state show masks the handle URL's signature"

echo "==> Phase 2: Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

INSTANCE_ID=$(read_state 'Object.values(s.resources).find((r) => r.resourceType === "AWS::EC2::Instance").physicalId')
STATE_OUT=$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
case "${STATE_OUT}" in
  terminated | shutting-down) echo "    OK: instance ${INSTANCE_ID} ${STATE_OUT}" ;;
  *) echo "FAIL: instance ${INSTANCE_ID} is ${STATE_OUT} after destroy" >&2; exit 1 ;;
esac
VERSIONS=$(signal_versions "${SIGNAL_KEY}")
[ "${VERSIONS}" = "0" ] || { echo "FAIL: ${VERSIONS} signal version(s) or marker(s) left after destroy" >&2; exit 1; }
echo "    OK: signal versions and the delete marker removed with the handle"
VPC_ID=$(read_state 'Object.values(s.resources).find((r) => r.resourceType === "AWS::EC2::VPC").physicalId')
[ -n "${VPC_ID}" ] || { echo "FAIL: no VPC in the recorded state" >&2; exit 1; }
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: VPC ${VPC_ID} gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "    OK: state gone"

trap - EXIT INT TERM
echo ""
echo "==> wait-condition-ec2-signal test passed"
