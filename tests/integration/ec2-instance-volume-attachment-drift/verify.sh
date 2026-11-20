#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6384.
#
# An AWS::EC2::VolumeAttachment attaches its volume after the instance
# settles, and DescribeInstances lists it under the instance's
# BlockDeviceMappings. Before the fix `cdkd drift` reported on a fresh stack
#   ~ Plain... (AWS::EC2::Instance)  BlockDeviceMappings: [/dev/xvda] -> [/dev/xvda, /dev/sdf]
# and `cdkd drift --revert -y` printed "reverted" while changing nothing.
#
# Phases:
#   1. Deploy two instances (`Plain` declares no BlockDeviceMappings,
#      `Declared` declares its root device), each with a VolumeAttachment on
#      /dev/sdf; assert both volumes are attached.
#   2. `cdkd drift` exits 0 and compares every resource.
#   3. Flip DeleteOnTermination on the Declared root device OUT OF BAND.
#   4. `cdkd drift` exits 1, reports the Declared instance's
#      BlockDeviceMappings with /dev/xvda and never /dev/sdf, and nothing on
#      the Plain instance (a declared list is still compared).
#   5. `cdkd drift --revert -y` restores DeleteOnTermination=true and leaves
#      /dev/sdf attached; `cdkd drift` exits 0 again.
#   6. Destroy; assert instances, volumes and the state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

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
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh

STACK="CdkdEc2InstanceVolumeAttachmentDrift"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
REVERT_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${REVERT_DIR:-/nonexistent}"/revert-ids-* "${REVERT_DIR:-/nonexistent}"/revert.log 2>/dev/null
  rmdir "${REVERT_DIR:-/nonexistent}" 2>/dev/null
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy two instances, each with a sibling VolumeAttachment"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
output_of() { # usage: output_of <OutputKey>
  local v
  v="$(node -e 'const s=JSON.parse(process.argv[1]); const v=(s.outputs||{})[process.argv[2]]; if (typeof v !== "string" || v === "") process.exit(1); process.stdout.write(v);' "${STATE_JSON}" "$1")" || {
    echo "FAIL: state output $1 missing" >&2
    exit 1
  }
  printf '%s' "${v}"
}
PLAIN_ID="$(output_of PlainInstanceId)"
DECLARED_ID="$(output_of DeclaredInstanceId)"
PLAIN_VOL="$(output_of PlainVolumeId)"
DECLARED_VOL="$(output_of DeclaredVolumeId)"

for pair in "${PLAIN_ID}:${PLAIN_VOL}" "${DECLARED_ID}:${DECLARED_VOL}"; do
  iid="${pair%%:*}"
  vol="${pair##*:}"
  attached="$(aws ec2 describe-volumes --region "${REGION}" --volume-ids "${vol}" \
    --query 'Volumes[0].Attachments[0].[InstanceId,Device,State]' --output text)"
  if [ "${attached}" != "${iid}	/dev/sdf	attached" ]; then
    echo "FAIL: ${vol} is not attached to ${iid} on /dev/sdf: ${attached}" >&2
    exit 1
  fi
done
echo "    both volumes attached on /dev/sdf"

# cdkd colours its report; compare against the plain text.
strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

drift_clean() { # usage: drift_clean <phase label>
  local out rc=0
  out="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || rc=$?
  out="$(printf '%s\n' "${out}" | strip_ansi)"
  if [ "${rc}" -ne 0 ]; then
    printf '%s\n' "${out}" >&2
    echo "FAIL: #6384 ($1): cdkd drift exited ${rc} on a stack with no out-of-band change" >&2
    exit 1
  fi
  # The fully-compared clean row only: a `⚠ ... no drift detected, but ...`
  # row means something went uncompared and the check is vacuous.
  if ! grep -qE "✓ ${STACK} \(${REGION}\): no drift detected \([0-9]+ resources checked, 0 unsupported\)" <<<"${out}"; then
    printf '%s\n' "${out}" >&2
    echo "FAIL: ($1) cdkd drift printed no fully-compared clean row (wording changed, or a resource went unsupported?)" >&2
    exit 1
  fi
}

# --- Phase 2: drift on the untouched stack -----------------------------------
echo "==> Phase 2: cdkd drift reports no drift on the untouched stack (#6384)"
drift_clean "Phase 2"
echo "    no drift: the attached /dev/sdf is not read as either instance's BlockDeviceMappings"

# --- Phase 3: out-of-band change on the DECLARED device ----------------------
echo "==> Phase 3: flip DeleteOnTermination on the Declared root device out of band"
aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${DECLARED_ID}" \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"DeleteOnTermination":false}}]'
root_dot() {
  aws ec2 describe-instances --region "${REGION}" --instance-ids "${DECLARED_ID}" \
    --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/xvda'].Ebs.DeleteOnTermination | [0]" \
    --output text
}
if [ "$(root_dot)" != "False" ]; then
  echo "FAIL: the out-of-band DeleteOnTermination flip did not land: $(root_dot)" >&2
  exit 1
fi

# --- Phase 4: drift reports the declared device only -------------------------
echo "==> Phase 4: cdkd drift reports the Declared root device, never /dev/sdf"
DRIFT_RC=0
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || DRIFT_RC=$?
DRIFT_OUT="$(printf '%s\n' "${DRIFT_OUT}" | strip_ansi)"
if [ "${DRIFT_RC}" -ne 1 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift exited ${DRIFT_RC}, expected 1 after the out-of-band change" >&2
  exit 1
fi
if ! grep -qE "drift detected on 1 resource$" <<<"${DRIFT_OUT}"; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: expected drift on exactly 1 resource (the Declared instance)" >&2
  exit 1
fi
if ! grep -qE '~ Declared[A-Z0-9]+ \(AWS::EC2::Instance\)' <<<"${DRIFT_OUT}"; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: the Declared instance was not reported as drifted" >&2
  exit 1
fi
if ! grep -q 'BlockDeviceMappings' <<<"${DRIFT_OUT}" || ! grep -q '/dev/xvda' <<<"${DRIFT_OUT}"; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: the drift did not name BlockDeviceMappings /dev/xvda" >&2
  exit 1
fi
if grep -q '/dev/sdf' <<<"${DRIFT_OUT}"; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: #6384: drift reported the sibling-attached /dev/sdf" >&2
  exit 1
fi
echo "    drift names the declared root device only"

# --- Phase 5: revert ---------------------------------------------------------
echo "==> Phase 5: cdkd drift --revert restores the root device, keeps /dev/sdf"
# The Declared instance (an L2: Declared<hash>) is the drifted resource; its
# sibling-attached volume must come through the revert untouched too.
DECLARED_LID="$(jq -r --arg id "${DECLARED_ID}" '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::Instance" and .value.physicalId == $id) | .key] | if length == 1 then .[0] else "" end' <<<"${STATE_JSON}")"
if [ -z "${DECLARED_LID}" ]; then
  echo "FAIL: no single AWS::EC2::Instance state record for ${DECLARED_ID}" >&2
  exit 1
fi
revert_identity_snapshot "${REVERT_DIR}/revert-ids-before" "${STACK}" "${DECLARED_LID}" DeclaredVolume || exit 1
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes 2>&1 | tee "${REVERT_DIR}/revert.log"
revert_output_assert_no_replacement "${REVERT_DIR}/revert.log" || exit 1
revert_identity_snapshot "${REVERT_DIR}/revert-ids-after" "${STACK}" "${DECLARED_LID}" DeclaredVolume || exit 1
revert_identity_assert_unchanged "${REVERT_DIR}/revert-ids-before" "${REVERT_DIR}/revert-ids-after" 2 || exit 1
if [ "$(root_dot)" != "True" ]; then
  echo "FAIL: drift --revert did not restore DeleteOnTermination=true: $(root_dot)" >&2
  exit 1
fi
attached="$(aws ec2 describe-volumes --region "${REGION}" --volume-ids "${DECLARED_VOL}" \
  --query 'Volumes[0].Attachments[0].State' --output text)"
if [ "${attached}" != "attached" ]; then
  echo "FAIL: drift --revert detached ${DECLARED_VOL}: ${attached}" >&2
  exit 1
fi
drift_clean "Phase 5"
echo "    reverted; drift clean again"

# --- Phase 6: destroy --------------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for iid in "${PLAIN_ID}" "${DECLARED_ID}"; do
  st="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${iid}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)"
  case "${st}" in
    shutting-down | terminated) ;;
    *)
      echo "FAIL: instance ${iid} is ${st} after destroy" >&2
      exit 1
      ;;
  esac
done
assert_gone "volume ${PLAIN_VOL} still exists after destroy" aws ec2 describe-volumes --region "${REGION}" --volume-ids "${PLAIN_VOL}"
assert_gone "volume ${DECLARED_VOL} still exists after destroy" aws ec2 describe-volumes --region "${REGION}" --volume-ids "${DECLARED_VOL}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "PASS: ec2-instance-volume-attachment-drift"
