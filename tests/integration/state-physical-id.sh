# state-physical-id.sh - read a cdkd-GENERATED physical resource name out of
# cdkd's own state, instead of a verify.sh PREDICTING it.
#
# Source it from a verify.sh, after the `cd "$(dirname "$0")"` that puts the
# shell in the fixture directory:
#
#     . ../state-physical-id.sh
#
# A flat file, not a directory, for the same reason as `s3-versions.sh` /
# `cr-log-groups.sh`: the coverage-matrix generators treat every DIRECTORY
# under tests/integration/ as a fixture.
#
# WHY THIS FILE EXISTS
# --------------------
# Today cdkd auto-names an unnamed resource deterministically:
# `{stack}-{logicalId}` (src/provisioning/resource-name.ts). A verify.sh that
# PREDICTS that name ahead of time (`PROJECT_NAME="${STACK}-batch"`, then
# `aws ... --names "${PROJECT_NAME}"`) hard-codes today's naming scheme into
# the test. go-to-k/cdkd#5064 plans to append a random 12-hex suffix for NEW
# stacks, so two deploys of the "same" fixture stack name no longer collide on
# physical names while a prior run's resource is still draining. Once that
# lands, every verify.sh still predicting the pre-#5064 name breaks even
# though cdkd's behavior is correct — it never had a name to predict from.
# Read the name cdkd actually assigned, from state, instead.
#
# state_physical_id <stack> <state-bucket> <resourceType> [<logicalIdPrefix>]
#   Prints (on stdout, no trailing newline) the physicalId of the ONE
#   resource in `<stack>`'s cdkd state whose resourceType equals
#   <resourceType> (a CloudFormation type, e.g.
#   "AWS::Batch::ComputeEnvironment") and, when <logicalIdPrefix> is given,
#   whose logicalId starts with it. Returns 1 and prints NOTHING on stdout —
#   only a FAIL to stderr — when zero or more than one resource matches, or
#   when the match has no physicalId: an empty name hanging off an
#   `aws ... --names ""` call can hang rather than fail
#   (testing.md "empty AWS CLI arg" trap), so this helper never lets a blank
#   result pass as a value.
#
#   Resolves the cdkd invocation the SAME way the calling verify.sh already
#   does, trying (in order) ${CDKD}, ${CLI}, then ${LOCAL_DIST} (invoked as
#   `node "${LOCAL_DIST}"`) — so a fixture that already defines any ONE of
#   these needs no new variable, and this file does not invent a fourth
#   convention. Resolves the stack's region from ${REGION} or ${AWS_REGION}
#   when either is set, passed as the non-deprecated `--stack-region` (never
#   `--region`, which state subcommands warn on stderr for).
state_physical_id() {
  local stack="$1" bucket="$2" resource_type="$3" logical_prefix="${4:-}"
  local region="${REGION:-${AWS_REGION:-}}"
  local json rc=0

  if [ -z "${stack}" ] || [ -z "${bucket}" ] || [ -z "${resource_type}" ]; then
    echo "FAIL: state_physical_id: needs <stack> <state-bucket> <resourceType>" >&2
    return 1
  fi

  if [ -n "${CDKD:-}" ]; then
    if [ -n "${region}" ]; then
      json="$(${CDKD} state show "${stack}" --state-bucket "${bucket}" --stack-region "${region}" --json 2>/dev/null)" || rc=$?
    else
      json="$(${CDKD} state show "${stack}" --state-bucket "${bucket}" --json 2>/dev/null)" || rc=$?
    fi
  elif [ -n "${CLI:-}" ]; then
    if [ -n "${region}" ]; then
      json="$(${CLI} state show "${stack}" --state-bucket "${bucket}" --stack-region "${region}" --json 2>/dev/null)" || rc=$?
    else
      json="$(${CLI} state show "${stack}" --state-bucket "${bucket}" --json 2>/dev/null)" || rc=$?
    fi
  elif [ -n "${LOCAL_DIST:-}" ]; then
    if [ -n "${region}" ]; then
      json="$(node "${LOCAL_DIST}" state show "${stack}" --state-bucket "${bucket}" --stack-region "${region}" --json 2>/dev/null)" || rc=$?
    else
      json="$(node "${LOCAL_DIST}" state show "${stack}" --state-bucket "${bucket}" --json 2>/dev/null)" || rc=$?
    fi
  else
    echo "FAIL: state_physical_id: no \${CDKD} / \${CLI} / \${LOCAL_DIST} cdkd invocation in scope" >&2
    return 1
  fi

  if [ "${rc}" -ne 0 ] || [ -z "${json}" ]; then
    echo "FAIL: state_physical_id: 'state show ${stack}' failed or returned nothing" >&2
    return 1
  fi

  printf '%s' "${json}" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let j;
  try {
    j = JSON.parse(s);
  } catch (e) {
    process.stderr.write("FAIL: state_physical_id: could not parse state show output as JSON\n");
    process.exit(1);
  }
  const resources = (j.state && j.state.resources) || {};
  const resourceType = process.argv[1];
  const logicalPrefix = process.argv[2] || "";
  const matches = Object.keys(resources).filter((logicalId) => {
    const r = resources[logicalId];
    if (!r || r.resourceType !== resourceType) return false;
    if (logicalPrefix && !logicalId.startsWith(logicalPrefix)) return false;
    return true;
  });
  if (matches.length === 0) {
    process.stderr.write(
      "FAIL: state_physical_id: no resource of type " + resourceType +
      (logicalPrefix ? " with logicalId prefix \"" + logicalPrefix + "\"" : "") +
      " found in state\n"
    );
    process.exit(1);
  }
  if (matches.length > 1) {
    process.stderr.write(
      "FAIL: state_physical_id: " + matches.length + " resources of type " + resourceType +
      (logicalPrefix ? " with logicalId prefix \"" + logicalPrefix + "\"" : "") +
      " found in state (ambiguous, need a narrower logicalIdPrefix): " + matches.join(", ") + "\n"
    );
    process.exit(1);
  }
  const physicalId = resources[matches[0]].physicalId;
  if (!physicalId) {
    process.stderr.write("FAIL: state_physical_id: matched resource " + matches[0] + " has no physicalId\n");
    process.exit(1);
  }
  process.stdout.write(physicalId);
});
' "${resource_type}" "${logical_prefix}" || return 1
}
