# revert-identity.sh - prove `cdkd drift --revert` kept every resource it
# touched: no replacement, no re-create.
#
# Source it from a verify.sh, after the `cd "$(dirname "$0")"` that puts the
# shell in the fixture directory:
#
#     . ../revert-identity.sh
#
# A flat file, not a directory, for the same reason as `s3-versions.sh`: the
# coverage-matrix generators treat every DIRECTORY under tests/integration/ as
# a fixture.
#
# WHY THIS FILE EXISTS
# --------------------
# A drift revert updates a resource IN PLACE; it never replaces one
# (go-to-k/cdkd#6638). A fixture that only re-reads the reverted PROPERTY
# passes just as well when the provider deleted the resource and created a new
# one carrying the template's value. Comparing cdkd's state physical id is not
# enough either: cdkd names an unnamed resource `{stack}-{logicalId}` with no
# random suffix, so a name-keyed replacement keeps the same physical id. Each
# row therefore also carries an AWS-SIDE identity that a delete + create
# changes (go-to-k/cdkd#6639).
#
# USAGE (around every `drift --revert` call)
#
#     revert_identity_snapshot "${WORK}/ids-before" "${STACK}" LidA LidB
#     <out-of-band drift, then: cdkd drift ... --revert ... >"${LOG}" 2>&1>
#     revert_output_assert_no_replacement "${LOG}"
#     revert_identity_snapshot "${WORK}/ids-after" "${STACK}" LidA LidB
#     revert_identity_assert_unchanged "${WORK}/ids-before" "${WORK}/ids-after" 2
#
# The expected count is a LITERAL the caller writes, never derived from the
# list it passes: an emptied list would otherwise compare 0 rows to 0 rows.
#
# revert_identity_snapshot <out-file> <stack> <logicalId>...
#   Writes one tab-separated row per logical id:
#     <logicalId> <resourceType> <state physicalId> <AWS identity>
#   The AWS identity comes from the per-TYPE probe table in
#   `_revert_identity_probe` below. Returns 1 (with a FAIL on stderr) when a
#   logical id is missing from state, has no physical id, has a type with no
#   probe, or its probe fails or reads empty. The state record is read with
#   `cdkd state show --json`, resolving the invocation from ${CDKD}, ${CLI} or
#   ${LOCAL_DIST} like `state-physical-id.sh`, and the bucket from
#   ${STATE_BUCKET}. The region is ${REVERT_IDENTITY_REGION}, else ${REGION},
#   else ${AWS_REGION} (set REVERT_IDENTITY_REGION for a stack in another
#   region; it is passed as `--stack-region` and as the AWS probe's
#   `--region`).
#
# revert_identity_assert_unchanged <before-file> <after-file> <expected-count>
#   Returns 1 (FAIL on stderr) unless both files hold exactly <expected-count>
#   (> 0) rows, no row has an empty field or a no-probe marker, and the two
#   files are identical row for row.
#
# revert_output_assert_no_replacement <log-file> [--expect-refusal]
#   Returns 1 when cdkd's revert output (ANSI stripped) reports a replacement:
#   any line matching `replac|re-?creat` (case-insensitive), aws-cdk-lib's own
#   synth WARNING lines aside. With --expect-refusal (a fixture whose revert
#   is REFUSED on purpose) the lines of cdkd's own refusal and remedy wording
#   are allowed too, and at least one of them must be present: a refusal the
#   fixture expects that carries none of that wording means the wording
#   drifted, and the check fails rather than pass on nothing. The provider-
#   REPLACED backstop line (src/cli/commands/drift/revert-apply.ts) FAILs in
#   both modes.
#
# AWS IDENTITY CLASSES (the probe table)
#   unique   an AWS-assigned value a delete + create always changes: an IAM
#            unique id, a table id, a cluster resource id, a creation time.
#   gen-id   the physical id itself is AWS-generated (sg-..., a subscription
#            ARN's UUID, an event source mapping UUID), so the state compare
#            already catches a replacement; the probe re-reads it from AWS so a
#            row also proves the resource still exists.
#   no-id    the type exposes no AWS-side value that distinguishes a re-create
#            under the same name (no creation time, no unique id). The probe
#            re-reads the ARN / name from AWS, which proves only existence; the
#            row says `no-id:` so the gap is visible in the log. Each such type
#            names why in the table.

_revert_identity_cdkd_cmd() {
  if [ -n "${CDKD:-}" ]; then
    printf '%s' "${CDKD}"
  elif [ -n "${CLI:-}" ]; then
    printf '%s' "${CLI}"
  elif [ -n "${LOCAL_DIST:-}" ]; then
    printf 'node %s' "${LOCAL_DIST}"
  else
    return 1
  fi
}

_revert_identity_aws() {
  AWS_CLI_AUTO_PROMPT=off AWS_PAGER= aws "$@" --output text
}

# _revert_identity_probe <type> <physicalId> <region>
#   Prints the AWS identity for one resource, prefixed with its class. Returns
#   2 for a type with no probe, 1 for a failed or empty read.
_revert_identity_probe() {
  local type="$1" pid="$2" region="$3" cls="" val="" rc=0
  case "${type}" in
    # --- unique -----------------------------------------------------------
    AWS::IAM::Role)
      cls=unique; val="$(_revert_identity_aws iam get-role --role-name "${pid}" --query 'Role.RoleId')" || rc=$? ;;
    AWS::IAM::ManagedPolicy)
      cls=unique; val="$(_revert_identity_aws iam get-policy --policy-arn "${pid}" --query 'Policy.PolicyId')" || rc=$? ;;
    AWS::IAM::User)
      cls=unique; val="$(_revert_identity_aws iam get-user --user-name "${pid}" --query 'User.UserId')" || rc=$? ;;
    AWS::IAM::InstanceProfile)
      cls=unique; val="$(_revert_identity_aws iam get-instance-profile --instance-profile-name "${pid}" --query 'InstanceProfile.InstanceProfileId')" || rc=$? ;;
    AWS::DynamoDB::Table | AWS::DynamoDB::GlobalTable)
      cls=unique; val="$(_revert_identity_aws dynamodb describe-table --region "${region}" --table-name "${pid}" --query 'Table.TableId')" || rc=$? ;;
    AWS::SQS::Queue)
      cls=unique; val="$(_revert_identity_aws sqs get-queue-attributes --region "${region}" --queue-url "${pid}" --attribute-names CreatedTimestamp --query 'Attributes.CreatedTimestamp')" || rc=$? ;;
    AWS::S3::Bucket)
      cls=unique; val="$(_revert_identity_aws s3api list-buckets --query "Buckets[?Name=='${pid}'].CreationDate | [0]")" || rc=$? ;;
    AWS::ECR::Repository)
      cls=unique; val="$(_revert_identity_aws ecr describe-repositories --region "${region}" --repository-names "${pid}" --query 'repositories[0].createdAt')" || rc=$? ;;
    AWS::Lambda::Url)
      # physicalId is the function URL's owning function ARN / name.
      cls=unique; val="$(_revert_identity_aws lambda get-function-url-config --region "${region}" --function-name "${pid}" --query 'CreationTime')" || rc=$? ;;
    AWS::RDS::DBCluster)
      cls=unique; val="$(_revert_identity_aws rds describe-db-clusters --region "${region}" --db-cluster-identifier "${pid}" --query 'DBClusters[0].DbClusterResourceId')" || rc=$? ;;
    AWS::RDS::DBInstance)
      cls=unique; val="$(_revert_identity_aws rds describe-db-instances --region "${region}" --db-instance-identifier "${pid}" --query 'DBInstances[0].DbiResourceId')" || rc=$? ;;
    AWS::AutoScaling::AutoScalingGroup)
      cls=unique; val="$(_revert_identity_aws autoscaling describe-auto-scaling-groups --region "${region}" --auto-scaling-group-names "${pid}" --query 'AutoScalingGroups[0].CreatedTime')" || rc=$? ;;
    AWS::ImageBuilder::InfrastructureConfiguration)
      cls=unique; val="$(_revert_identity_aws imagebuilder get-infrastructure-configuration --region "${region}" --infrastructure-configuration-arn "${pid}" --query 'infrastructureConfiguration.dateCreated')" || rc=$? ;;
    AWS::Logs::LogGroup)
      cls=unique; val="$(_revert_identity_aws logs describe-log-groups --region "${region}" --log-group-name-prefix "${pid}" --query "logGroups[?logGroupName=='${pid}'].creationTime | [0]")" || rc=$? ;;
    AWS::SecretsManager::Secret)
      cls=unique; val="$(_revert_identity_aws secretsmanager describe-secret --region "${region}" --secret-id "${pid}" --query 'CreatedDate')" || rc=$? ;;
    # --- gen-id -----------------------------------------------------------
    AWS::SNS::Subscription)
      cls=gen-id; val="$(_revert_identity_aws sns get-subscription-attributes --region "${region}" --subscription-arn "${pid}" --query 'Attributes.SubscriptionArn')" || rc=$? ;;
    AWS::Lambda::EventSourceMapping)
      cls=gen-id; val="$(_revert_identity_aws lambda get-event-source-mapping --region "${region}" --uuid "${pid}" --query 'UUID')" || rc=$? ;;
    AWS::EC2::SecurityGroup)
      cls=gen-id; val="$(_revert_identity_aws ec2 describe-security-groups --region "${region}" --group-ids "${pid}" --query 'SecurityGroups[0].GroupId')" || rc=$? ;;
    AWS::EC2::VPC)
      cls=gen-id; val="$(_revert_identity_aws ec2 describe-vpcs --region "${region}" --vpc-ids "${pid}" --query 'Vpcs[0].VpcId')" || rc=$? ;;
    AWS::EC2::Subnet)
      cls=gen-id; val="$(_revert_identity_aws ec2 describe-subnets --region "${region}" --subnet-ids "${pid}" --query 'Subnets[0].SubnetId')" || rc=$? ;;
    AWS::EC2::Instance)
      cls=gen-id; val="$(_revert_identity_aws ec2 describe-instances --region "${region}" --instance-ids "${pid}" --query 'Reservations[0].Instances[0].InstanceId')" || rc=$? ;;
    AWS::EC2::Volume)
      cls=gen-id; val="$(_revert_identity_aws ec2 describe-volumes --region "${region}" --volume-ids "${pid}" --query 'Volumes[0].VolumeId')" || rc=$? ;;
    AWS::EC2::LaunchTemplate)
      cls=gen-id; val="$(_revert_identity_aws ec2 describe-launch-templates --region "${region}" --launch-template-ids "${pid}" --query 'LaunchTemplates[0].LaunchTemplateId')" || rc=$? ;;
    AWS::GuardDuty::Detector)
      cls=gen-id; val="$(_revert_identity_aws guardduty get-detector --region "${region}" --detector-id "${pid}" --query 'CreatedAt')" || rc=$? ;;
    AWS::ApiGateway::RestApi)
      cls=gen-id; val="$(_revert_identity_aws apigateway get-rest-api --region "${region}" --rest-api-id "${pid}" --query 'id')" || rc=$? ;;
    AWS::ElasticLoadBalancingV2::TargetGroup)
      cls=gen-id; val="$(_revert_identity_aws elbv2 describe-target-groups --region "${region}" --target-group-arns "${pid}" --query 'TargetGroups[0].TargetGroupArn')" || rc=$? ;;
    AWS::KMS::Key)
      cls=gen-id; val="$(_revert_identity_aws kms describe-key --region "${region}" --key-id "${pid}" --query 'KeyMetadata.KeyId')" || rc=$? ;;
    # --- no-id --------------------------------------------------------------
    AWS::SNS::Topic)
      # GetTopicAttributes carries no creation time or unique id.
      cls=no-id; val="$(_revert_identity_aws sns get-topic-attributes --region "${region}" --topic-arn "${pid}" --query 'Attributes.TopicArn')" || rc=$? ;;
    AWS::Lambda::Function)
      # GetFunction carries no creation time; LastModified / RevisionId move on
      # every in-place update too.
      cls=no-id; val="$(_revert_identity_aws lambda get-function --region "${region}" --function-name "${pid}" --query 'Configuration.FunctionArn')" || rc=$? ;;
    *)
      return 2 ;;
  esac
  if [ "${rc}" -ne 0 ] || [ -z "${val}" ] || [ "${val}" = "None" ]; then
    echo "FAIL: revert_identity: the ${type} probe of '${pid}' failed or read empty (rc=${rc}, got '${val}')" >&2
    return 1
  fi
  printf '%s:%s' "${cls}" "${val}"
}

revert_identity_snapshot() {
  local out="${1:-}" stack="${2:-}"
  local region="${REVERT_IDENTITY_REGION:-${REGION:-${AWS_REGION:-}}}"
  local cdkd_cmd="" json="" rows="" errfile="" err="" rc=0
  local lid type pid ident prc
  local -a cmd=()
  if [ -z "${out}" ] || [ -z "${stack}" ] || [ "$#" -lt 3 ]; then
    echo "FAIL: revert_identity_snapshot: needs <out-file> <stack> <logicalId>..." >&2
    return 1
  fi
  shift 2
  if [ -z "${region}" ] || [ -z "${STATE_BUCKET:-}" ]; then
    echo "FAIL: revert_identity_snapshot: needs a region (REVERT_IDENTITY_REGION / REGION / AWS_REGION) and STATE_BUCKET" >&2
    return 1
  fi
  cdkd_cmd="$(_revert_identity_cdkd_cmd)" || {
    echo "FAIL: revert_identity_snapshot: no \${CDKD} / \${CLI} / \${LOCAL_DIST} cdkd invocation in scope" >&2
    return 1
  }
  # Word-split on purpose: ${CLI} is `node <path>` in most fixtures.
  # shellcheck disable=SC2206
  cmd=(${cdkd_cmd} state show "${stack}" --state-bucket "${STATE_BUCKET}" --stack-region "${region}" --json)
  errfile="$(mktemp)" || return 1
  json="$("${cmd[@]}" 2>"${errfile}")" || rc=$?
  err="$(cat "${errfile}" 2>/dev/null)"
  rm -f "${errfile}"
  if [ "${rc}" -ne 0 ] || [ -z "${json}" ]; then
    echo "FAIL: revert_identity_snapshot: 'state show ${stack}' failed (rc=${rc})${err:+: ${err}}" >&2
    return 1
  fi
  # One `<logicalId>\t<type>\t<physicalId>` line per requested id, in the
  # caller's order; a missing record or physical id fails here.
  rows="$(printf '%s' "${json}" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch (e) {
    process.stderr.write("FAIL: revert_identity_snapshot: state show output is not JSON\n");
    process.exit(1);
  }
  const resources = (j.state && j.state.resources) || {};
  const out = [];
  for (const lid of process.argv.slice(1)) {
    const r = resources[lid];
    if (!r || !r.resourceType || !r.physicalId) {
      process.stderr.write("FAIL: revert_identity_snapshot: " + lid + " has no state record with a type and physicalId\n");
      process.exit(1);
    }
    if (/[\t\n]/.test(String(r.physicalId))) {
      process.stderr.write("FAIL: revert_identity_snapshot: " + lid + "'"'"'s physicalId holds a tab or newline\n");
      process.exit(1);
    }
    out.push(lid + "\t" + r.resourceType + "\t" + r.physicalId);
  }
  process.stdout.write(out.join("\n") + "\n");
});
' "$@")" || return 1
  : >"${out}" || return 1
  while IFS="$(printf '\t')" read -r lid type pid; do
    [ -n "${lid}" ] || continue
    prc=0
    ident="$(_revert_identity_probe "${type}" "${pid}" "${region}")" || prc=$?
    if [ "${prc}" -eq 2 ]; then
      echo "FAIL: revert_identity_snapshot: no AWS identity probe for ${type} (${lid}); add one to tests/integration/revert-identity.sh" >&2
      printf '%s\t%s\t%s\t%s\n' "${lid}" "${type}" "${pid}" "NO-PROBE" >>"${out}"
      return 1
    fi
    [ "${prc}" -eq 0 ] || return 1
    printf '%s\t%s\t%s\t%s\n' "${lid}" "${type}" "${pid}" "${ident}" >>"${out}" || return 1
    echo "    revert-identity: ${lid} (${type}) ${pid} -> ${ident}"
  done <<EOF
${rows}
EOF
}

revert_identity_assert_unchanged() {
  local before="${1:-}" after="${2:-}" want="${3:-}" f n bad
  case "${want}" in
    '' | *[!0-9]* | 0)
      echo "FAIL: revert_identity_assert_unchanged: <expected-count> must be a positive integer, got '${want}'" >&2
      return 1 ;;
  esac
  for f in "${before}" "${after}"; do
    if [ -z "${f}" ] || [ ! -f "${f}" ]; then
      echo "FAIL: revert_identity_assert_unchanged: snapshot file '${f}' is missing" >&2
      return 1
    fi
    n="$(grep -c . "${f}")" || n=0
    if [ "${n}" -ne "${want}" ]; then
      echo "FAIL: revert_identity_assert_unchanged: ${f} holds ${n} row(s), want ${want}" >&2
      return 1
    fi
    # Four non-empty tab-separated fields, and a real probe result.
    bad="$(awk -F '\t' 'NF != 4 || $1 == "" || $2 == "" || $3 == "" || $4 == "" || $4 == "NO-PROBE" || $4 ~ /:$/' "${f}")"
    if [ -n "${bad}" ]; then
      echo "FAIL: revert_identity_assert_unchanged: ${f} has an empty or unprobed row:" >&2
      printf '%s\n' "${bad}" >&2
      return 1
    fi
  done
  if ! cmp -s "${before}" "${after}"; then
    echo "FAIL: the drift revert REPLACED or re-created a resource (its identity changed; go-to-k/cdkd#6639):" >&2
    diff "${before}" "${after}" >&2 || true
    return 1
  fi
  echo "    OK: drift --revert kept the identity of all ${want} resource(s) it touched"
}

# cdkd's own refusal / remedy wording that carries `replace` / `recreate`
# without reporting one (allowed only with --expect-refusal):
#   - src/provisioning/revert-no-replace.ts and the IAM providers: "... a drift
#     revert never replaces ..."
#   - src/cli/commands/drift/revert.ts: "cannot be reverted in place — re-deploy
#     the stack with `cdkd deploy --replace` ..."
#   - src/cli/commands/drift/command.ts: "... it cannot recreate one."
#   - ResourceUpdateNotSupportedError (src/utils/error-handler/deploy-errors.ts):
#     "<Type> (<id>) cannot be updated in place: use cdkd deploy with --replace ..."
_REVERT_IDENTITY_REFUSAL_RE='never replaces|cannot be (reverted|updated) in place|cannot recreate one'

revert_output_assert_no_replacement() {
  local log="${1:-}" mode="${2:-}" plain hits backstop refusals
  if [ -z "${log}" ] || [ ! -s "${log}" ]; then
    echo "FAIL: revert_output_assert_no_replacement: revert log '${log}' is missing or empty" >&2
    return 1
  fi
  case "${mode}" in
    '' | --expect-refusal) ;;
    *) echo "FAIL: revert_output_assert_no_replacement: unknown option '${mode}'" >&2; return 1 ;;
  esac
  plain="$(sed $'s/\x1b\\[[0-9;]*m//g' "${log}")" || return 1
  backstop="$(grep -E 'the provider REPLACED the resource' <<<"${plain}" || true)"
  if [ -n "${backstop}" ]; then
    echo "FAIL: cdkd's revert backstop reports a provider REPLACED a resource (go-to-k/cdkd#6638):" >&2
    printf '%s\n' "${backstop}" >&2
    return 1
  fi
  # aws-cdk-lib's synth-time deprecation / validation lines are not cdkd's.
  hits="$(grep -iE 'replac|re-?creat' <<<"${plain}" | grep -vE '\[WARNING\] aws-cdk-lib|aws-cdk-lib\.' || true)"
  if [ "${mode}" = "--expect-refusal" ]; then
    refusals="$(grep -E "${_REVERT_IDENTITY_REFUSAL_RE}" <<<"${hits}" || true)"
    if [ -z "${refusals}" ]; then
      echo "FAIL: revert_output_assert_no_replacement: the revert was expected to be refused, but its output carries none of cdkd's refusal wording (${_REVERT_IDENTITY_REFUSAL_RE}); the wording may have drifted" >&2
      return 1
    fi
    hits="$(grep -vE "${_REVERT_IDENTITY_REFUSAL_RE}" <<<"${hits}" || true)"
  fi
  if [ -n "${hits}" ]; then
    echo "FAIL: the drift revert output reports a replacement or re-create (go-to-k/cdkd#6639):" >&2
    printf '%s\n' "${hits}" >&2
    return 1
  fi
  echo "    OK: the drift revert output reports no replacement"
}
