# cr-log-groups.sh - shared Lambda LOG-GROUP sweep for cdkd integ fixtures.
#
# Source it from a verify.sh, after the `cd "$(dirname "$0")"` that puts the
# shell in the fixture directory:
#
#     . ../cr-log-groups.sh
#
# A flat file, not a directory, for the same reason as `s3-versions.sh`: the
# coverage-matrix generators treat every DIRECTORY under tests/integration/ as
# a fixture.
#
# WHY THIS FILE EXISTS
# --------------------
# Lambda creates `/aws/lambda/<function-name>` the first time a function runs,
# and the group is NOT a stack resource, so `cdkd destroy` never deletes it.
# Every fixture with `autoDeleteObjects: true` runs CDK's
# `Custom::S3AutoDeleteObjects` handler (on create during DEPLOY, and again on
# delete during destroy), so each run left
# `/aws/lambda/<stack>-CustomS3AutoDeleteObjects...-<hash>` behind (#3885). A
# fixture whose own Lambdas are invoked leaks their groups the same way
# (`custom-resource-provider`'s five provider-framework handlers).
#
# cdkd names an auto-named Lambda `<stack>-<logicalId>` truncated to 64 chars
# with an 8-hex hash suffix (src/provisioning/resource-name.ts), so every such
# group starts with `/aws/lambda/<stack>-` as long as the stack name is at most
# 55 characters. The whole prefix is swept, not just the auto-delete handler's
# groups: the fixture owns every function under its stack name, and a filter on
# `CustomS3AutoDeleteObjects` would miss the handler itself once truncation
# cuts its logical id (`CdkdLocalInvokeAgentcoreFromStateFixture-CustomS3AutoDe-<hash>`).
#
# sweep_stack_lambda_log_groups <stack> <region>
#   Best-effort: deletes every log group under `/aws/lambda/<stack>-` in
#   <region> and prints how many it deleted. Never fails its caller (it runs
#   from `cleanup` under `set +eu` too), so a fixture that must PROVE zero
#   asserts that separately.
#
#   The trailing `-` is load-bearing: without it, sweeping `CdkdFoo` would also
#   delete `CdkdFooBar`'s groups. A stack name that itself contains `-` still
#   shares its prefix with any stack named `<stack>-<more>`; no fixture stack
#   has that shape.
#
#   The scope is guarded BEFORE the listing: an empty or short stack name would
#   collapse the prefix to `/aws/lambda/` - every Lambda log group in the
#   region, cdkd's and everyone else's. A refused scope warns on stderr with
#   `teardown sweep refused` (.claude/rules/testing.md) and deletes nothing.
sweep_stack_lambda_log_groups() {
  (
    set +eu
    # Byte-wise ranges: in a UTF-8 locale bash's `[a-z]` can match upper-case
    # and other letters, which would let the guards below accept `US-east-1`.
    LC_ALL=C
    stack="$1"
    region="$2"
    # Accepting arm FIRST; `[A-Za-z]???*` cannot match empty or a name shorter
    # than 4 characters, and the catch-all leaves the subshell.
    case "${stack}" in
      [A-Za-z]???*) ;;
      *)
        echo "    WARN: teardown sweep refused a stack scope shorter than 4 characters: '${stack:-<empty>}'" >&2
        exit 0
        ;;
    esac
    # A CloudFormation stack name is letters, digits and `-` only; anything
    # else (a glob character, a `/`) is not a stack scope.
    case "${stack}" in
      *[!A-Za-z0-9-]*)
        echo "    WARN: teardown sweep refused a stack scope with a character outside [A-Za-z0-9-]: '${stack}'" >&2
        exit 0
        ;;
    esac
    case "${region}" in
      [a-z][a-z]-?*-[0-9] | [a-z][a-z]-?*-[0-9][0-9]) ;;
      *)
        echo "    WARN: teardown sweep refused a region that is not an AWS region code: '${region:-<empty>}'" >&2
        exit 0
        ;;
    esac
    case "${region}" in
      *[!a-z0-9-]*)
        echo "    WARN: teardown sweep refused a region with a character outside [a-z0-9-]: '${region}'" >&2
        exit 0
        ;;
    esac

    prefix="/aws/lambda/${stack}-"
    # A failed listing must not read as "nothing to sweep".
    if ! names=$(aws logs describe-log-groups --log-group-name-prefix "${prefix}" --region "${region}" \
      --query 'logGroups[].logGroupName' --output text 2>/dev/null); then
      echo "    WARN: could not list Lambda log groups under ${prefix} in ${region}; nothing swept" >&2
      exit 0
    fi
    deleted=0
    for lg in ${names}; do
      # Re-check each name against the prefix: the listing is the only input
      # the delete trusts, so a name outside the scope (or a literal `None`) is
      # never deleted.
      case "${lg}" in
        "${prefix}"?*) ;;
        *) continue ;;
      esac
      if aws logs delete-log-group --log-group-name "${lg}" --region "${region}" >/dev/null 2>&1; then
        deleted=$((deleted + 1))
      fi
    done
    echo "    swept ${deleted} Lambda log group(s) under ${prefix}"
  )
}
