#!/usr/bin/env bash
# Integration test for List<...> parameter coercion (issue #2373, the live arm
# of go-to-k/cdkd#2347).
#
# A nested child declares `SubnetIds: List<AWS::EC2::Subnet::Id>` and a control
# `SubnetIdsCsv: CommaDelimitedList`, and the parent hands BOTH the same
# comma-joined string of two real subnet ids. What it asserts:
#
#   Phase 1 (deploy)   - a bare `Ref SubnetIds` reaches the RDS DBSubnetGroup's
#                        `SubnetIds` as a list AWS accepts (the wire shape no
#                        unit test can settle); `Fn::Select` and `Fn::Join` over
#                        it deploy and render the right values; `Fn::Sub`
#                        renders `subnets=<a>,<b>`; the CommaDelimitedList
#                        control renders identically.
#   Phase 2 (refusal)  - a separate stack whose `Fn::Split` reads a List<...>
#                        parameter is REFUSED, and creates nothing.
#   Phase 3 (destroy)  - every resource and state file is gone.

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

export AWS_PAGER=""

STACK="CdkdListParametersExample"
CHILD_STACK="${STACK}~Child"
PROBE_STACK="CdkdListParametersSplitProbe"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PROBE_STATE_KEY="cdkd/${PROBE_STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Must match lib/list-parameters-stack.ts.
PARAM_PREFIX="/cdkd-integ/list-parameters"
PARAMS="select join sub csvselect csvjoin split"
SUBNET_GROUP="cdkd-integ-list-parameters"
VPC_TAG="cdkd-integ-list-parameters"

strip_ansi() { sed -e $'s/\033\\[[0-9;]*m//g'; }

cleanup() {
  (
    set +eu
    echo "=== cleanup ==="
    node "${LOCAL_DIST}" destroy "${STACK}" \
      --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --force
    CDKD_TEST_SPLIT_PROBE=true node "${LOCAL_DIST}" destroy "${PROBE_STACK}" \
      --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --force
    for s in "${CHILD_STACK}" "${STACK}" "${PROBE_STACK}"; do
      node "${LOCAL_DIST}" state destroy "${s}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    done
    for p in ${PARAMS}; do
      aws ssm delete-parameter --name "${PARAM_PREFIX}/${p}" --region "${REGION}" >/dev/null 2>&1
    done
    aws rds delete-db-subnet-group --db-subnet-group-name "${SUBNET_GROUP}" \
      --region "${REGION}" >/dev/null 2>&1
    for vpc in $(aws ec2 describe-vpcs --region "${REGION}" \
      --filters "Name=tag:Name,Values=${VPC_TAG}" --query 'Vpcs[].VpcId' --output text); do
      case "${vpc}" in
        vpc-?*)
          for sn in $(aws ec2 describe-subnets --region "${REGION}" \
            --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text); do
            aws ec2 delete-subnet --subnet-id "${sn}" --region "${REGION}"
          done
          aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}"
          ;;
        *)
          echo "WARN: teardown sweep refused -- '${vpc}' is not a VPC id" >&2
          ;;
      esac
    done
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found -- run 'vp run build' first" >&2
  exit 1
fi

echo "=== pre-run cleanup ==="
cleanup

# ---------------------------------------------------------------------------
# Phase 1: deploy and read every reader's result back from AWS
# ---------------------------------------------------------------------------
echo "=== Phase 1: deploying ${STACK} ==="
env -u CDKD_TEST_SPLIT_PROBE node "${LOCAL_DIST}" deploy "${STACK}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}"

subnet_id() { # usage: subnet_id <index>
  local rows
  rows="$(aws ec2 describe-subnets --region "${REGION}" \
    --filters "Name=tag:Name,Values=${VPC_TAG}-$1" --query 'Subnets[].SubnetId' --output text)" || return 1
  if [ "$(printf '%s\n' ${rows} | grep -c .)" != "1" ]; then
    echo "FAIL: expected exactly one subnet tagged ${VPC_TAG}-$1, got '${rows}'" >&2
    return 1
  fi
  printf '%s' "${rows}"
}
SUBNET_A="$(subnet_id 0)"
SUBNET_B="$(subnet_id 1)"
VPC_ID="$(aws ec2 describe-subnets --subnet-ids "${SUBNET_A}" --region "${REGION}" \
  --query 'Subnets[0].VpcId' --output text)"
echo "subnets: ${SUBNET_A} ${SUBNET_B} in ${VPC_ID}"

param_value() { # usage: param_value <name>
  aws ssm get-parameter --name "${PARAM_PREFIX}/$1" --region "${REGION}" \
    --query Parameter.Value --output text
}
expect_param() { # usage: expect_param <name> <expected> <what>
  local got
  got="$(param_value "$1")"
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $3: ${PARAM_PREFIX}/$1 is '${got}', expected '$2'" >&2
    exit 1
  fi
  echo "PASS: $3 (${got})"
}

# The wire-shape arm. Sorted because AWS does not preserve submitted order.
got_group="$(aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" \
  --region "${REGION}" \
  --query "join(' ', sort(DBSubnetGroups[0].Subnets[].SubnetIdentifier || \`[]\`))" --output text)"
want_group="$(printf '%s\n' "${SUBNET_A}" "${SUBNET_B}" | sort | tr '\n' ' ' | sed 's/ $//')"
if [ "${got_group}" != "${want_group}" ]; then
  echo "FAIL: DBSubnetGroup SubnetIds are '${got_group}', expected '${want_group}'" >&2
  exit 1
fi
echo "PASS: a bare Ref to List<AWS::EC2::Subnet::Id> reached RDS as a two-element list"

expect_param select "${SUBNET_B}" "Fn::Select over the List<> parameter"
expect_param join "${SUBNET_A}|${SUBNET_B}" "Fn::Join over the List<> parameter"
expect_param sub "subnets=${SUBNET_A},${SUBNET_B}" "Fn::Sub over the List<> parameter"
expect_param csvselect "${SUBNET_B}" "CommaDelimitedList control, Fn::Select"
expect_param csvjoin "${SUBNET_A}|${SUBNET_B}" "CommaDelimitedList control, Fn::Join"

# ---------------------------------------------------------------------------
# Phase 2: Fn::Split over a List<> parameter is refused and creates nothing
# ---------------------------------------------------------------------------
echo "=== Phase 2: deploying ${PROBE_STACK} (expected to be REFUSED) ==="
rc=0
probe_out="$(CDKD_TEST_SPLIT_PROBE=true node "${LOCAL_DIST}" deploy "${PROBE_STACK}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)" || rc=$?
probe_out="$(printf '%s\n' "${probe_out}" | strip_ansi)"
printf '%s\n' "${probe_out}"
if [ "${rc}" -eq 0 ]; then
  echo "FAIL: a Fn::Split over a List<AWS::EC2::Subnet::Id> parameter deployed" >&2
  exit 1
fi
# Sentinel: an `Fn::Split:` error whose wording drifted must fail loudly here,
# not read as "the refusal did not happen".
if ! printf '%s' "${probe_out}" | grep -qF 'is ALREADY a list'; then
  if printf '%s' "${probe_out}" | grep -qF 'Fn::Split:'; then
    echo "FAIL: an Fn::Split error was printed but its wording drifted -- update this fixture" >&2
  else
    echo "FAIL: the deploy failed (rc=${rc}) for a reason other than the Fn::Split refusal" >&2
  fi
  exit 1
fi
if ! printf '%s' "${probe_out}" | grep -qF 'List<AWS::EC2::Subnet::Id>'; then
  echo "FAIL: the refusal does not name the list-typed parameter remedy" >&2
  exit 1
fi
echo "PASS: Fn::Split over a List<> parameter was refused (rc=${rc})"
assert_gone "the refused probe still created ${PARAM_PREFIX}/split" \
  aws ssm get-parameter --name "${PARAM_PREFIX}/split" --region "${REGION}"
echo "PASS: the refused probe created nothing"

# ---------------------------------------------------------------------------
# Phase 3: destroy
# ---------------------------------------------------------------------------
echo "=== Phase 3: destroying ==="
node "${LOCAL_DIST}" destroy "${STACK}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force
# The refused deploy created nothing, so it may or may not have left a state
# record; destroy only what exists.
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PROBE_STATE_KEY}"; then
  CDKD_TEST_SPLIT_PROBE=true node "${LOCAL_DIST}" destroy "${PROBE_STACK}" \
    --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force
fi

assert_gone "DBSubnetGroup ${SUBNET_GROUP} still exists after destroy" \
  aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
for p in ${PARAMS}; do
  assert_gone "SSM parameter ${PARAM_PREFIX}/${p} still exists after destroy" \
    aws ssm get-parameter --name "${PARAM_PREFIX}/${p}" --region "${REGION}"
done
for sn in "${SUBNET_A}" "${SUBNET_B}"; do
  assert_gone "subnet ${sn} still exists after destroy" \
    aws ec2 describe-subnets --subnet-ids "${sn}" --region "${REGION}"
done
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
for key in "${STATE_KEY}" "${CHILD_STATE_KEY}" "${PROBE_STATE_KEY}"; do
  assert_gone "state file ${key} still exists after destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done

trap - EXIT INT TERM
echo "[verify] PASS — List<...> parameters reach AWS as lists; Fn::Split over one is refused"
