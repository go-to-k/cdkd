#!/usr/bin/env bash
# verify.sh - secret-derived-immutable-names: an in-place update of resources
# whose immutable NAMES come from a Secrets Manager secret
# (go-to-k/cdkd#4264, go-to-k/cdkd#4275).
#
# cdkd records a secret-derived value as its `{{resolve:secretsmanager:...}}`
# expression, while a provider's update() receives the resolved value. The
# ApiGatewayV2 Stage and ECS Service providers compared the two, saw a rename
# that never happened, and refused every in-place update (the ECS row is
# go-to-k/cdkd#4263); so did the AppSync GraphQLApi and DataSource providers,
# and the IAM ManagedPolicy provider REPLACED the policy instead (a create under
# the same name and path, which IAM refuses). The Cloud Control provider, which
# a Logs MetricFilter routes to, put an op on the create-only FilterName path
# in every update's JSON Patch. The Scheduler provider refused every update of a
# schedule whose GroupName is secret-derived, and its destroy skipped it: the
# schedule's ARN embeds the group, so nothing in the record named it. cdkd now
# records the schedule's creation date (`cdkd:CreationDate`), confirms against
# it before the update, and finds the schedule by it to delete it.
#
# Steps (each echoed as `Step N`):
#   1. Seed the secret naming the stage, the service, the policy's path and
#      description, the GraphQL API, the data source and the queue.
#   2. Deploy. Cloud Control's create line withholds SecretFilter's id
#      (go-to-k/cdkd#3869), and the log names neither the queue name nor the
#      policy path that SecretQueueReaderPolicy and PlainScheduleRole read by
#      Ref / Fn::GetAtt (go-to-k/cdkd#3869: a value read from a resource named
#      from a secret is no recorded secret).
#   3. PREMISE: state records each secret-derived property as the
#      {{resolve:secretsmanager: expression, and each resource lives under the
#      name (path, description) the secret holds.
#   3b. ROTATE the secret's `filter` field only (every other field keeps its
#      value), so the update's resolved FilterName differs from the live one.
#   4. LOAD-BEARING: the update (CDKD_TEST_UPDATE=true: only the Stages'
#      Description, the Service's EnableECSManagedTags, the Policy's document,
#      the API's XrayEnabled, the DataSource's Description and the Queue's
#      VisibilityTimeout, the Filter's FilterPattern and the Schedule's
#      Description change) EXITS 0.
#      This is what discriminates the fix; the refusals it replaced are named
#      in the failure message. No secret-derived value appears in its
#      --verbose log.
#   5. LOAD-BEARING: the update was IN PLACE: each resource's AWS creation time
#      (the Policy's ARN and a new default version; the API's id) is unchanged
#      and the new value reached AWS. The literal-named PlainStage
#      is the positive control: the same update on a name no secret feeds,
#      which passes with or without the fix and shows the update path is sound.
#   5b. `cdkd diff --verbose` of the updated stack: its log names neither the
#      queue name nor the policy path its readers resolve (go-to-k/cdkd#3869).
#   6. Destroy. Its --verbose log does not name SecretFilter's FilterName,
#      SecretQueue's name or SecretPolicy's path (go-to-k/cdkd#3869):
#      Cloud Control's delete line withholds the id (go-to-k/cdkd#3869).
#      LOAD-BEARING for the Schedules: each delete runs through the recorded
#      identity (the --verbose line naming it is asserted).
#   6b. A failed-CREATE orphan named from the secret (go-to-k/cdkd#3869): deploy
#      CdkdSecretDerivedOrphan with --no-rollback (ECR makes the repository,
#      then rejects its lifecycle policy, so the journal records it), then
#      destroy that stack: its --verbose log does not name the repository,
#      whose delete runs from the journal alone.
#   6c. The same failed deploy again, then a plain `cdkd rollback`: its log
#      does not name the repository either (its failed-op replay, go-to-k/cdkd#3869).
#   6d. The same deploy WITHOUT --no-rollback: the automatic rollback deletes the
#      orphan, and the deploy's --verbose log does not name the repository.
#   7. Remove the secret; assert 0 orphans.
#   8. Sweep every object version under both stacks' state prefixes.
#
# Discrimination (for a mutation probe on real AWS): revert
# src/provisioning/providers/apigatewayv2-provider.ts ALONE and step 4 fails
# naming "StageName is immutable"; revert src/provisioning/providers/ecs-provider.ts
# ALONE and it fails naming "Cannot update ServiceName"; revert
# src/provisioning/providers/appsync-provider.ts ALONE and it fails naming
# "GraphqlApi.Name is immutable" or "DataSource.Name is immutable"; revert
# src/provisioning/providers/iam-managed-policy-provider.ts ALONE and the
# policy is replaced: IAM refuses the create under the same name and path
# (cdkd prints "A policy called ... already exists", not the
# EntityAlreadyExists code -- measured by that probe). PlainStage
# updates either way. Revert src/utils/logger.ts ALONE (go-to-k/cdkd#2177) and
# step 4 fails "SecretQueue's 'Updating SQS queue' line carries no '***'
# mask": that provider debug line prints the queue URL, name and all, raw.
# Revert the go-to-k/cdkd#4275 hunk of src/provisioning/cloud-control-provider.ts
# (the `unchangedBehindSecretReference` loop in update()) ALONE and step 4 fails
# "update deploy exited 1": Cloud Control refuses the patch op on the
# create-only /FilterName, now carrying the ROTATED name, with
# NotUpdatableException "Invalid patch update: createOnlyProperties
# [/properties/FilterName] cannot be updated" (measured by that probe, read
# from the run's persisted deployment event).
# Revert src/deployment/intrinsic-resolver/{refs,getatt}.ts ALONE
# (go-to-k/cdkd#3869) and step 2 fails "the deploy log names a value read from
# a secret-named resource in plaintext: ${QUEUE_NAME}": the `resolved to` line
# of SecretQueueReaderPolicy's Ref / Fn::GetAtt prints the queue URL and ARN
# raw (not yet measured on real AWS).
# Revert the `withPrintingSecrets` wrap in
# src/deployment/rollback-executor/journaled-orphans.ts ALONE (go-to-k/cdkd#3869)
# and step 6b fails naming the repository on the ECR provider's
# "Deleting ECR Repository SecretOrphanRepo: <name>" line (not yet measured on
# real AWS).
# Revert the `withPrintingSecrets` wrap around the failed-op replay in
# src/cli/commands/rollback.ts ALONE (go-to-k/cdkd#3869) and step 6c fails the
# same way on the rollback's log (not yet measured on real AWS).
# Revert the `withPrintingSecrets` wrap around the orphan replay in
# src/deployment/deploy-engine/rollback.ts ALONE and step 6d fails the same way
# on the deploy's log (not yet measured on real AWS).
# Revert the `secretNameNeedles` / `secretNameSink` lines of
# src/cli/commands/diff-recursive.ts ALONE and step 5b fails naming
# ${QUEUE_NAME}; revert the `withPrintingSecrets` wrap in
# src/cli/commands/destroy-runner.ts ALONE and step 6 fails naming
# ${QUEUE_NAME} on the 'Deleting SQS queue SecretQueue' line (neither yet
# measured on real AWS).
# With the fix the patch leaves FilterName out, so the filter keeps its
# pre-rotation name, as CloudFormation leaves an unchanged reference alone.
# Revert the IdScrubLog in cloud-control-provider.ts and step 2 fails
# "SecretFilter's 'Created resource' line does not withhold its physical id"
# (with create()'s sink kept, step 6 fails the same way for its
# 'Deleting resource' line).
# Revert src/provisioning/providers/scheduler-schedule-provider.ts ALONE and
# step 4 fails naming "GroupName addresses the schedule" (go-to-k/cdkd#4275);
# with only its delete arm reverted, step 6 fails: the destroy skips the
# schedule ("redacted") and exits non-zero.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdSecretDerivedImmutableNames"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ORPHAN_STACK="CdkdSecretDerivedOrphan"
ORPHAN_STATE_KEY="cdkd/${ORPHAN_STACK}/${REGION}/state.json"
ORPHAN_JOURNAL_KEY="cdkd/${ORPHAN_STACK}/${REGION}/rollback-journal.json"
ORPHAN_PREFIX="$(s3_stack_prefix "${ORPHAN_STACK}" "${REGION}")"
DEPLOY_LOG="$(mktemp -t secret-derived-immutable-names.XXXXXX)"
ORPHAN_LOG="$(mktemp -t secret-derived-immutable-names-orphan.XXXXXX)"
API_NAME="CdkdSecretDerivedImmutableNamesApi"

# One run's names: unique, so a leftover from a failed run cannot be mistaken
# for this one's, and DISJOINT: neither name occurs inside the secret's id or
# the other name, so the recorded reference cannot carry a name's plaintext and
# a plaintext grep over the logs means what it says.
SUFFIX="$(date +%s)-$$"
STAGE_NAME="sdin-stg-${SUFFIX}"
SERVICE_NAME="sdin-svc-${SUFFIX}"
POLICY_PATH="/sdin-path-${SUFFIX}/"
POLICY_DESC="sdin-pdesc-${SUFFIX}"
# AppSync names take no `-`: a data source name is `[_A-Za-z][_0-9A-Za-z]*`.
GQL_API_NAME="sdin_gql_${SUFFIX//-/_}"
DS_NAME="sdin_ds_${SUFFIX//-/_}"
QUEUE_NAME="sdin-q-${SUFFIX}"
FILTER_NAME="sdin-mf-${SUFFIX}"
FILTER_NAME_ROTATED="sdin-mfr-${SUFFIX}"
# ECR repository names are lower-case.
REPO_NAME="sdin-repo-${SUFFIX}"
GROUP_NAME="sdin-grp-${SUFFIX}"
SCHEDULE_NAME="CdkdSdinSchedule"
PLAIN_SCHEDULE_NAME="CdkdSdinSchedulePlainTarget"
export SDIN_SECRET_NAME="cdkd-integ-sdin-secret-${SUFFIX}"
SEEDED_SECRET=0
# Set just before the first deploy: the stack name is fixed, so a run refused by
# the pre-flight must not destroy (or sweep the state history of) a stack an
# earlier or concurrent run left behind.
DEPLOYED=0
# The same for the orphan stack, set just before its deploy.
ORPHAN_DEPLOYED=0

log_tail() {
  tail -60 "${DEPLOY_LOG}" >&2
}

# Cleanup order: the STACK, then the secret, then the non-current state
# versions (safe on any path: a live state.json a later `cdkd state destroy`
# needs survives).
cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +eu
  if [ "${DEPLOYED}" = "1" ] && [ -f "${LOCAL_DIST}" ]; then
    CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    # A destroy that skipped the schedule (a pre-fix probe run) leaves it in its
    # group; deleting the group deletes the schedules in it.
    aws scheduler delete-schedule-group --region "${REGION}" --name "${GROUP_NAME}" >/dev/null 2>&1
    # The schedule's role and target queue, by their recorded or known names, so
    # an aborted run (a pre-fix probe whose destroy skipped) leaves no orphan.
    for role in "${SCHEDULE_ROLE:-}" "${PLAIN_SCHEDULE_ROLE:-}"; do
      [ -n "${role}" ] || continue
      aws iam delete-role-policy --role-name "${role}" --policy-name send >/dev/null 2>&1
      # PlainScheduleRole attaches SecretPolicy (go-to-k/cdkd#3869).
      if [ -n "${POLICY_ARN:-}" ]; then
        aws iam detach-role-policy --role-name "${role}" --policy-arn "${POLICY_ARN}" >/dev/null 2>&1
      fi
      aws iam delete-role --role-name "${role}" >/dev/null 2>&1
    done
    # SecretPolicy, once detached above, with its non-default versions
    # (the update adds one), so a destroy that failed part-way leaves no
    # orphan policy (go-to-k/cdkd#3869 added its attachment).
    if [ -n "${POLICY_ARN:-}" ]; then
      for version in $(aws iam list-policy-versions --policy-arn "${POLICY_ARN}" \
        --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
        aws iam delete-policy-version --policy-arn "${POLICY_ARN}" --version-id "${version}" >/dev/null 2>&1
      done
      aws iam delete-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1
    fi
    if [ -n "${PLAIN_TARGET_QUEUE_URL:-}" ]; then
      aws sqs delete-queue --region "${REGION}" --queue-url "${PLAIN_TARGET_QUEUE_URL}" >/dev/null 2>&1
    fi
    LEFT_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${QUEUE_NAME}" \
      --query QueueUrl --output text 2>/dev/null)"
    if [ -n "${LEFT_QUEUE_URL}" ] && [ "${LEFT_QUEUE_URL}" != "None" ]; then
      aws sqs delete-queue --region "${REGION}" --queue-url "${LEFT_QUEUE_URL}" >/dev/null 2>&1
    fi
  fi
  if [ "${ORPHAN_DEPLOYED}" = "1" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${ORPHAN_STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${ORPHAN_STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    aws ecr delete-repository --region "${REGION}" --repository-name "${REPO_NAME}" --force >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET:-}/${ORPHAN_JOURNAL_KEY}" >/dev/null 2>&1
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${ORPHAN_PREFIX}" noncurrent || true
  fi
  if [ "${SEEDED_SECRET}" = "1" ]; then
    aws secretsmanager delete-secret --region "${REGION}" --secret-id "${SDIN_SECRET_NAME}" \
      --force-delete-without-recovery >/dev/null 2>&1
  fi
  if [ "${DEPLOYED}" = "1" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${PREFIX}" noncurrent || true
  fi
  rm -f "${DEPLOY_LOG}" "${ORPHAN_LOG}" "${SECRET_FILE:-}" 2>/dev/null || true
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} - clean up first." >&2
  exit 1
fi
for key in "${ORPHAN_STATE_KEY}" "${ORPHAN_JOURNAL_KEY}"; do
  if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" >/dev/null 2>&1; then
    echo "FAIL: ${key} already exists - clean up first." >&2
    exit 1
  fi
done
LEFTOVER_APIS="$(aws apigatewayv2 get-apis --region "${REGION}" \
  --query "Items[?Name=='${API_NAME}'].ApiId" --output text)"
if [ -n "${LEFTOVER_APIS}" ] && [ "${LEFTOVER_APIS}" != "None" ]; then
  echo "FAIL: an API named ${API_NAME} already exists (${LEFTOVER_APIS}) - clean up first." >&2
  exit 1
fi
# The managed policy's NAME is derived from the fixed stack name and logical
# id, and IAM policy names are unique per account whatever the path, so a
# policy a failed run leaked would make step 2's create fail with
# EntityAlreadyExists. Every run's path starts `/sdin-path-`.
# Filtered client-side: `--path-prefix` must end with `/`, and each run's path differs.
LEFTOVER_POLICIES="$(aws iam list-policies --scope Local \
  --query "Policies[?starts_with(Path, '/sdin-path-')].Arn" --output text)"
if [ -n "${LEFTOVER_POLICIES}" ] && [ "${LEFTOVER_POLICIES}" != "None" ]; then
  echo "FAIL: a managed policy from an earlier run still exists (${LEFTOVER_POLICIES}) - clean up first." >&2
  exit 1
fi

echo "==> Step 1: seed the secret naming every secret-derived property"
# From a file, not argv, so the value never shows in the host's process list.
SECRET_FILE="$(mktemp -t secret-derived-immutable-names-secret.XXXXXX)"
printf '{"stage":"%s","service":"%s","path":"%s","policydesc":"%s","api":"%s","datasource":"%s","queue":"%s","filter":"%s","group":"%s","repo":"%s"}' \
  "${STAGE_NAME}" "${SERVICE_NAME}" "${POLICY_PATH}" "${POLICY_DESC}" "${GQL_API_NAME}" "${DS_NAME}" "${QUEUE_NAME}" "${FILTER_NAME}" "${GROUP_NAME}" "${REPO_NAME}" \
  > "${SECRET_FILE}"
aws secretsmanager create-secret --region "${REGION}" --name "${SDIN_SECRET_NAME}" \
  --secret-string "file://${SECRET_FILE}" >/dev/null
SEEDED_SECRET=1
rm -f "${SECRET_FILE}"
echo "    OK: seeded"

state_holds() { # usage: state_holds <literal> -> 0 when the current state.json contains it
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>&1)" || {
    echo "FAIL: could not read ${STATE_KEY}" >&2
    exit 1
  }
  # A here-string, not `printf | grep -q`: grep exits at the first match, so a
  # body larger than the pipe buffer takes SIGPIPE in printf and pipefail turns
  # a MATCH into "no match" -- a vacuous pass for every absence check.
  grep -qF -- "$1" <<< "${body}"
}
state_property() { # usage: state_property <logical-id> <property> -> the recorded value
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r --arg id "$1" --arg p "$2" '.resources[$id].properties[$p] // empty'
}
state_attribute() { # usage: state_attribute <logical-id> <attribute> -> the recorded value
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r --arg id "$1" --arg a "$2" '.resources[$id].attributes[$a] // empty'
}
schedule_field() { # usage: schedule_field <field> [schedule-name] (a strict capture: a failed read aborts)
  aws scheduler get-schedule --region "${REGION}" --name "${2:-${SCHEDULE_NAME}}" \
    --group-name "${GROUP_NAME}" --query "$1" --output text
}
state_physical_id() { # usage: state_physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r --arg id "$1" '.resources[$id].physicalId // empty'
}
stage_field() { # usage: stage_field <stage-name> <field>
  aws apigatewayv2 get-stage --region "${REGION}" --api-id "${API_ID}" --stage-name "$1" \
    --query "$2" --output text
}
policy_field() { # usage: policy_field <field> (a strict capture: a failed read aborts)
  aws iam get-policy --policy-arn "${POLICY_ARN}" --query "Policy.$1" --output text
}
gql_field() { # usage: gql_field <field>
  aws appsync get-graphql-api --region "${REGION}" --api-id "${GQL_API_ID}" \
    --query "graphqlApi.$1" --output text
}
ds_field() { # usage: ds_field <field>
  aws appsync get-data-source --region "${REGION}" --api-id "${GQL_API_ID}" --name "${DS_NAME}" \
    --query "dataSource.$1" --output text
}
service_field() { # usage: service_field <field> (a strict capture: a failed read aborts)
  aws ecs describe-services --region "${REGION}" --cluster "${CLUSTER_ID}" \
    --services "${SERVICE_ARN}" --query "services[0].$1" --output text
}
filter_field() { # usage: filter_field <field> (a strict capture: a failed read aborts)
  aws logs describe-metric-filters --region "${REGION}" --log-group-name "${FILTER_LOG_GROUP}" \
    --filter-name-prefix "${FILTER_NAME}" --query "metricFilters[?filterName=='${FILTER_NAME}'] | [0].$1" \
    --output text
}
expect_eq() { # usage: expect_eq <what> <want> <got>
  if [ "$3" != "$2" ]; then
    echo "FAIL: $1: want '$2', got '$3'" >&2
    exit 1
  fi
  echo "    OK: $1"
}

# go-to-k/cdkd#3869: each read of a secret-named resource must have its
# --verbose 'resolved to' line in the log (usage: expect_read_lines <log file>
# <which deploy>); the callers then assert the names are absent from it.
expect_read_lines() {
  local log="$1" which="$2" marker
  for marker in "Ref to resource: SecretQueue resolved to " "SecretQueue.Arn resolved to " \
    "Ref to resource: SecretPolicy resolved to "; do
    if ! grep -qF -- "${marker}" "${log}"; then
      echo "FAIL: premise: the ${which} log has no '${marker}' line (the --verbose debug stream is missing, the reader was not resolved, or the wording drifted)" >&2
      log_tail
      exit 1
    fi
  done
}

echo "==> Step 2: deploy"
DEPLOYED=1
set +e
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  log_tail
  exit 1
fi
echo "    OK: deploy exited 0"
# Read right after the deploy, BEFORE the log assertions below: cleanup()'s
# fallback sweep (SecretPolicy, the schedule roles, the target queue) needs
# these ids on exactly the failure path those assertions catch.
API_ID="$(state_physical_id Api)"
# A Cluster's physical id is its NAME, which --cluster / --clusters accept.
CLUSTER_ID="$(state_physical_id Cluster)"
SERVICE_ARN="$(state_physical_id SecretService)"
TASK_DEF_ARN="$(state_physical_id TaskDef)"
POLICY_ARN="$(state_physical_id SecretPolicy)"
GQL_API_ID="$(state_physical_id SecretApi)"
QUEUE_URL="$(state_physical_id SecretQueue)"
FILTER_LOG_GROUP="$(state_physical_id FilterLogGroup)"
FILTER_ID="$(state_physical_id SecretFilter)"
# An IAM role's physical id is its name, which --role-name takes.
SCHEDULE_ROLE="$(state_physical_id ScheduleRole)"
PLAIN_SCHEDULE_ROLE="$(state_physical_id PlainScheduleRole)"
PLAIN_TARGET_QUEUE_URL="$(state_physical_id PlainTargetQueue)"
for v in API_ID CLUSTER_ID SERVICE_ARN TASK_DEF_ARN POLICY_ARN GQL_API_ID QUEUE_URL FILTER_LOG_GROUP FILTER_ID SCHEDULE_ROLE PLAIN_SCHEDULE_ROLE PLAIN_TARGET_QUEUE_URL; do
  if [ -z "${!v}" ]; then echo "FAIL: ${v} not found in ${STATE_KEY}" >&2; exit 1; fi
done

# go-to-k/cdkd#3869: Cloud Control's create line names the identifier it
# returned, `<LogGroupName>|<FilterName>`; the desired FilterName is the
# secret's, so the whole id is withheld (before, only the FilterName part was
# masked, as the literal secret). PREMISE first: the line must be in the log.
CREATE_FILTER_LINE="$(grep -F "Created resource SecretFilter, physical ID: " "${DEPLOY_LOG}" || true)"
if [ -z "${CREATE_FILTER_LINE}" ]; then
  echo "FAIL: premise: the deploy log has no 'Created resource SecretFilter' line (the --verbose debug stream is missing, or the wording drifted)" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "physical ID: ***" <<< "${CREATE_FILTER_LINE}"; then
  echo "FAIL: SecretFilter's 'Created resource' line does not withhold its physical id (go-to-k/cdkd#3869)" >&2
  exit 1
fi
if grep -qF -- "${FILTER_NAME}" "${DEPLOY_LOG}"; then
  echo "FAIL: the deploy log names SecretFilter's FilterName in plaintext: \${FILTER_NAME} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
echo "    OK: the deploy log withholds SecretFilter's physical id"
# go-to-k/cdkd#3869: SecretQueueReaderPolicy reads SecretQueue by Ref and
# Fn::GetAtt, and PlainScheduleRole attaches SecretPolicy by Ref. Each value
# embeds a secret-derived name (the queue name, the policy path) and is no
# recorded secret. PREMISE: each read's --verbose line is in the log, so the
# absence below is about a printed value, not a missing line.
expect_read_lines "${DEPLOY_LOG}" "deploy"
for needle_var in QUEUE_NAME POLICY_PATH; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    HIT_LINES="$(grep -nF -- "${!needle_var}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the deploy log names a value read from a secret-named resource in plaintext: \${${needle_var}} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the deploy log withholds what its readers read from SecretQueue and SecretPolicy"

echo "==> Step 3 (PREMISE): state records the names as the redacted expression"
for field in stage service path policydesc api datasource queue filter group; do
  if ! state_holds "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:${field}::}}"; then
    echo "FAIL: state does not record the {{resolve:secretsmanager: expression for the ${field}; the name is not secret-derived, so the update below would not exercise the guard" >&2
    exit 1
  fi
done
expect_eq "SecretStage's recorded StageName" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:stage::}}" "$(state_property SecretStage StageName)"
expect_eq "SecretStage lives under the secret's stage name" "${STAGE_NAME}" "$(state_physical_id SecretStage)"
expect_eq "SecretService's recorded ServiceName" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:service::}}" "$(state_property SecretService ServiceName)"
expect_eq "SecretService's ARN ends with the secret's service name" "${SERVICE_NAME}" "${SERVICE_ARN##*/}"
expect_eq "SecretService's EnableECSManagedTags after deploy" "False" "$(service_field enableECSManagedTags)"
expect_eq "SecretStage's Description after deploy" "cdkd integ: initial" "$(stage_field "${STAGE_NAME}" Description)"
expect_eq "SecretPolicy's recorded Path" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:path::}}" "$(state_property SecretPolicy Path)"
expect_eq "SecretPolicy's recorded Description" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:policydesc::}}" "$(state_property SecretPolicy Description)"
expect_eq "SecretPolicy's Path" "${POLICY_PATH}" "$(policy_field Path)"
expect_eq "SecretPolicy's Description" "${POLICY_DESC}" "$(policy_field Description)"
expect_eq "SecretPolicy's default version after deploy" "v1" "$(policy_field DefaultVersionId)"
expect_eq "SecretApi's recorded Name" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:api::}}" "$(state_property SecretApi Name)"
expect_eq "SecretApi's name" "${GQL_API_NAME}" "$(gql_field name)"
expect_eq "SecretApi's XrayEnabled after deploy" "False" "$(gql_field xrayEnabled)"
expect_eq "SecretDataSource's recorded Name" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:datasource::}}" "$(state_property SecretDataSource Name)"
expect_eq "SecretDataSource's physical id carries the secret's name" \
  "${GQL_API_ID}|${DS_NAME}" "$(state_physical_id SecretDataSource)"
expect_eq "SecretDataSource's Description after deploy" "cdkd integ: initial" "$(ds_field description)"
expect_eq "SecretQueue's URL ends with the secret's queue name" "${QUEUE_NAME}" "${QUEUE_URL##*/}"
expect_eq "SecretFilter's recorded FilterName" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:filter::}}" "$(state_property SecretFilter FilterName)"
expect_eq "SecretFilter's FilterPattern after deploy" "WARN" "$(filter_field filterPattern)"
FILTER_CREATED="$(filter_field creationTime)"
SECRET_STAGE_CREATED="$(stage_field "${STAGE_NAME}" CreatedDate)"
PLAIN_STAGE_CREATED="$(stage_field plain CreatedDate)"
SERVICE_CREATED="$(service_field createdAt)"
expect_eq "SecretSchedule's recorded GroupName" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:group::}}" "$(state_property SecretSchedule GroupName)"
expect_eq "SecretSchedule's Description after deploy" "cdkd integ: initial" "$(schedule_field Description)"
SCHEDULE_CREATED="$(schedule_field CreationDate)"
SCHEDULE_RECORDED_CREATED="$(state_attribute SecretSchedule 'cdkd:CreationDate')"
# Raw, so a precision mismatch between the CLI's rendering and cdkd's ISO form
# is visible in the run log (go-to-k/cdkd#4275).
echo "    SecretSchedule creation date: AWS '${SCHEDULE_CREATED}', recorded '${SCHEDULE_RECORDED_CREATED}'"
# PREMISE for the full identity match: PlainTargetSchedule's recorded target
# and role are plain ARNs. Both schedules target PlainTargetQueue, so only
# their roles tell them apart; a redacted recorded target is unit-tested only.
PLAIN_RECORDED_TARGET="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -r '.resources.PlainTargetSchedule.properties.Target.Arn // empty')"
PLAIN_RECORDED_ROLE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -r '.resources.PlainTargetSchedule.properties.Target.RoleArn // empty')"
case "${PLAIN_RECORDED_TARGET}${PLAIN_RECORDED_ROLE}" in
  *'{{resolve:'*|*'***'*|'') echo "FAIL: premise: PlainTargetSchedule's recorded target or role is redacted or missing, so its identity match would skip them" >&2; exit 1 ;;
esac
expect_eq "PlainTargetSchedule's recorded target is its live target" "${PLAIN_RECORDED_TARGET}" \
  "$(schedule_field Target.Arn "${PLAIN_SCHEDULE_NAME}")"
expect_eq "PlainTargetSchedule's recorded role is its live role" "${PLAIN_RECORDED_ROLE}" \
  "$(schedule_field Target.RoleArn "${PLAIN_SCHEDULE_NAME}")"
# The same PREMISE for SecretSchedule: its target is PlainTargetQueue too, so a
# redacted recording here would silently fall back to a date-only match.
SECRET_RECORDED_TARGET="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -r '.resources.SecretSchedule.properties.Target.Arn // empty')"
SECRET_RECORDED_ROLE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -r '.resources.SecretSchedule.properties.Target.RoleArn // empty')"
for v in "${SECRET_RECORDED_TARGET}" "${SECRET_RECORDED_ROLE}"; do
  case "${v}" in
    *'{{resolve:'*|*'***'*|'') echo "FAIL: premise: SecretSchedule's recorded target or role is redacted or missing, so its identity match would skip them" >&2; exit 1 ;;
  esac
done
expect_eq "SecretSchedule's recorded target is its live target" "${SECRET_RECORDED_TARGET}" \
  "$(schedule_field Target.Arn)"
expect_eq "SecretSchedule's recorded role is its live role" "${SECRET_RECORDED_ROLE}" \
  "$(schedule_field Target.RoleArn)"
PLAIN_SCHEDULE_CREATED="$(schedule_field CreationDate "${PLAIN_SCHEDULE_NAME}")"
PLAIN_SCHEDULE_RECORDED_CREATED="$(state_attribute PlainTargetSchedule 'cdkd:CreationDate')"
for v in SECRET_STAGE_CREATED PLAIN_STAGE_CREATED SERVICE_CREATED FILTER_CREATED SCHEDULE_CREATED SCHEDULE_RECORDED_CREATED PLAIN_SCHEDULE_CREATED PLAIN_SCHEDULE_RECORDED_CREATED; do
  if [ -z "${!v}" ] || [ "${!v}" = "None" ]; then echo "FAIL: ${v} unreadable" >&2; exit 1; fi
done

echo "==> Step 3b: rotate the secret's filter field only"
SECRET_FILE="$(mktemp -t secret-derived-immutable-names-secret.XXXXXX)"
printf '{"stage":"%s","service":"%s","path":"%s","policydesc":"%s","api":"%s","datasource":"%s","queue":"%s","filter":"%s","group":"%s","repo":"%s"}' \
  "${STAGE_NAME}" "${SERVICE_NAME}" "${POLICY_PATH}" "${POLICY_DESC}" "${GQL_API_NAME}" "${DS_NAME}" "${QUEUE_NAME}" "${FILTER_NAME_ROTATED}" "${GROUP_NAME}" "${REPO_NAME}" \
  > "${SECRET_FILE}"
aws secretsmanager put-secret-value --region "${REGION}" --secret-id "${SDIN_SECRET_NAME}" \
  --secret-string "file://${SECRET_FILE}" >/dev/null
rm -f "${SECRET_FILE}"
echo "    OK: rotated"

echo "==> Step 4 (LOAD-BEARING): update - only ordinary in-place properties change"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
UPDATE_RC=$?
set -e
if [ "${UPDATE_RC}" -ne 0 ]; then
  for refusal in "StageName is immutable" "Cannot update ServiceName" \
    "GraphqlApi.Name is immutable" "DataSource.Name is immutable" \
    "A policy called" "createOnlyProperties [/properties/FilterName] cannot be updated" \
    "GroupName addresses the schedule" "GroupName of Schedule"; do
    if grep -qF "${refusal}" "${DEPLOY_LOG}"; then
      echo "FAIL: the update failed with '${refusal}': the recorded secret reference was compared with the resolved value (go-to-k/cdkd#4275)" >&2
    fi
  done
  echo "FAIL: update deploy exited ${UPDATE_RC}" >&2
  log_tail
  exit 1
fi
echo "    OK: update deploy exited 0"
# The log must not be empty, or the absence checks below certify nothing; the
# Service's updating line is one this fix made reachable.
if [ ! -s "${DEPLOY_LOG}" ] || ! grep -qF "Updating ECS service" "${DEPLOY_LOG}"; then
  echo "FAIL: the update log is empty or has no 'Updating ECS service' line (the --verbose debug stream is missing, or the wording drifted)" >&2
  log_tail
  exit 1
fi
UPDATE_LOG_BODY="$(cat "${DEPLOY_LOG}")"
# go-to-k/cdkd#2177 PREMISE: SecretQueue's provider update line must be in the
# log, MASKED, or the queue-name absence below proves nothing (the queue was
# not updated, or the wording drifted). That line has no per-site masker.
QUEUE_UPDATE_LINE="$(grep -F "Updating SQS queue SecretQueue: " <<< "${UPDATE_LOG_BODY}" || true)"
if [ -z "${QUEUE_UPDATE_LINE}" ]; then
  echo "FAIL: premise: the update log has no 'Updating SQS queue SecretQueue: ' line (the queue was not updated, or the wording drifted)" >&2
  log_tail
  exit 1
fi
if ! grep -qF '***' <<< "${QUEUE_UPDATE_LINE}"; then
  echo "FAIL: SecretQueue's 'Updating SQS queue' line carries no '***' mask (go-to-k/cdkd#2177)" >&2
  exit 1
fi
# Over the WHOLE log, engine progress lines included: a hit there is a loud
# FAIL, never a vacuous pass, but look at the engine's lines before the
# providers' when it fires (a Stage's physical id IS its name).
# FILTER_NAME is the PRE-rotation value, which this deploy's masker never
# resolved; it is reported below rather than asserted.
# By NAME, with indirect expansion, so a red names the variable that hit and the
# log lines it is on (never its value, which is the secret-derived plaintext).
# go-to-k/cdkd#3869: the readers of SecretQueue and SecretPolicy resolve on
# the update too, so the QUEUE_NAME and POLICY_PATH needles below cover what
# they read. PlainScheduleRole does not change on the update, so its
# 'Ref to resource: SecretPolicy' line comes from the DIFF pass alone, and the
# QueuePolicy's from both passes (its Sid changes).
expect_read_lines "${DEPLOY_LOG}" "update"
for needle_var in STAGE_NAME SERVICE_NAME POLICY_PATH POLICY_DESC GQL_API_NAME DS_NAME QUEUE_NAME FILTER_NAME_ROTATED GROUP_NAME; do
  # A here-string, not a pipe: see state_holds.
  if grep -qF -- "${!needle_var}" <<< "${UPDATE_LOG_BODY}"; then
    HIT_LINES="$(grep -nF -- "${!needle_var}" <<< "${UPDATE_LOG_BODY}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the update log carries a secret-derived value in plaintext: \${${needle_var}} on log line(s) ${HIT_LINES}" >&2
    exit 1
  fi
done
echo "    OK: the update log carries no secret-derived value"
# The pre-rotation value reaches the log only through a line that prints the
# previous physical id; update()'s debug line withholds it (go-to-k/cdkd#3869).
if grep -qF -- "${FILTER_NAME}" <<< "${UPDATE_LOG_BODY}"; then
  echo "FAIL: the update log names SecretFilter's pre-rotation FilterName in plaintext (go-to-k/cdkd#3869):" >&2
  grep -nF -- "${FILTER_NAME}" <<< "${UPDATE_LOG_BODY}" | sed "s/${FILTER_NAME}/<FILTER_NAME>/g" >&2
  exit 1
fi
echo "    OK: the update log does not name SecretFilter's pre-rotation FilterName"

echo "==> Step 5 (LOAD-BEARING): the update landed IN PLACE"
expect_eq "SecretStage's Description after the update" "cdkd integ: updated" "$(stage_field "${STAGE_NAME}" Description)"
expect_eq "SecretStage's creation time (not replaced)" "${SECRET_STAGE_CREATED}" "$(stage_field "${STAGE_NAME}" CreatedDate)"
expect_eq "PlainStage's Description after the update (positive control)" "cdkd integ: updated" "$(stage_field plain Description)"
expect_eq "PlainStage's creation time (positive control)" "${PLAIN_STAGE_CREATED}" "$(stage_field plain CreatedDate)"
expect_eq "SecretService's EnableECSManagedTags after the update" "True" "$(service_field enableECSManagedTags)"
expect_eq "SecretService's creation time (not replaced)" "${SERVICE_CREATED}" "$(service_field createdAt)"
expect_eq "SecretService's physical id" "${SERVICE_ARN}" "$(state_physical_id SecretService)"
expect_eq "SecretPolicy's ARN (not replaced)" "${POLICY_ARN}" "$(state_physical_id SecretPolicy)"
expect_eq "SecretPolicy's default version after the update (the document changed in place)" "v2" "$(policy_field DefaultVersionId)"
expect_eq "SecretPolicy's Description after the update" "${POLICY_DESC}" "$(policy_field Description)"
expect_eq "SecretApi's id (not replaced)" "${GQL_API_ID}" "$(state_physical_id SecretApi)"
expect_eq "SecretApi's XrayEnabled after the update" "True" "$(gql_field xrayEnabled)"
expect_eq "SecretApi's name after the update" "${GQL_API_NAME}" "$(gql_field name)"
expect_eq "SecretDataSource's Description after the update" "cdkd integ: updated" "$(ds_field description)"
expect_eq "SecretQueue's VisibilityTimeout after the update" "60" \
  "$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
    --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text)"
expect_eq "SecretQueue's URL (not replaced)" "${QUEUE_URL}" "$(state_physical_id SecretQueue)"
expect_eq "SecretFilter's FilterPattern after the update" "ERROR" "$(filter_field filterPattern)"
expect_eq "no filter took the rotated name" "None" \
  "$(aws logs describe-metric-filters --region "${REGION}" --log-group-name "${FILTER_LOG_GROUP}" \
    --filter-name-prefix "${FILTER_NAME_ROTATED}" --query 'metricFilters[0].filterName' --output text)"
expect_eq "SecretFilter's creation time (not replaced)" "${FILTER_CREATED}" "$(filter_field creationTime)"
expect_eq "SecretFilter's physical id" "${FILTER_ID}" "$(state_physical_id SecretFilter)"
expect_eq "SecretSchedule's Description after the update" "cdkd integ: updated" "$(schedule_field Description)"
expect_eq "SecretSchedule's creation time (not replaced)" "${SCHEDULE_CREATED}" "$(schedule_field CreationDate)"
expect_eq "SecretSchedule's recorded creation date after the update (carried)" \
  "${SCHEDULE_RECORDED_CREATED}" "$(state_attribute SecretSchedule 'cdkd:CreationDate')"
expect_eq "PlainTargetSchedule's Description after the update" "cdkd integ: updated" \
  "$(schedule_field Description "${PLAIN_SCHEDULE_NAME}")"
expect_eq "PlainTargetSchedule's creation time (not replaced)" "${PLAIN_SCHEDULE_CREATED}" \
  "$(schedule_field CreationDate "${PLAIN_SCHEDULE_NAME}")"
expect_eq "PlainTargetSchedule's recorded creation date after the update (carried)" \
  "${PLAIN_SCHEDULE_RECORDED_CREATED}" "$(state_attribute PlainTargetSchedule 'cdkd:CreationDate')"
expect_eq "SecretStage's recorded StageName after the update" \
  "{{resolve:secretsmanager:${SDIN_SECRET_NAME}:SecretString:stage::}}" "$(state_property SecretStage StageName)"

echo "==> Step 5b: cdkd diff --verbose withholds the names its readers read (go-to-k/cdkd#3869)"
# The same template the update deployed, so the diff is NO_CHANGE, but the
# diff still resolves every reader's Ref / Fn::GetAtt against state, where
# SecretQueue's QueueName and SecretPolicy's Path are their {{resolve:
# references. PREMISE: each read's --verbose line is in the diff's log.
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose > "${DEPLOY_LOG}" 2>&1
DIFF_RC=$?
set -e
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: cdkd diff exited ${DIFF_RC}" >&2
  log_tail
  exit 1
fi
expect_read_lines "${DEPLOY_LOG}" "diff"
for needle_var in QUEUE_NAME POLICY_PATH; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    HIT_LINES="$(grep -nF -- "${!needle_var}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the cdkd diff log names a value read from a secret-named resource in plaintext: \${${needle_var}} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the cdkd diff log withholds what its readers read from SecretQueue and SecretPolicy"

echo "==> Step 6: destroy"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  log_tail
  exit 1
fi
echo "    OK: destroy exited 0"
# go-to-k/cdkd#3869: Cloud Control's delete line names the physical id, which
# carries SecretFilter's PRE-rotation FilterName; the record keeps that name
# as its {{resolve: reference, which withholds the id. PREMISE first: the line
# must be in the log, masked, or the absence below proves nothing.
DESTROY_FILTER_LINE="$(grep -F "Deleting resource SecretFilter (AWS::Logs::MetricFilter), physical ID: " "${DEPLOY_LOG}" || true)"
if [ -z "${DESTROY_FILTER_LINE}" ]; then
  echo "FAIL: premise: the destroy log has no 'Deleting resource SecretFilter' line (the --verbose debug stream is missing, or the wording drifted)" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "physical ID: ***" <<< "${DESTROY_FILTER_LINE}"; then
  echo "FAIL: SecretFilter's 'Deleting resource' line does not withhold its physical id (go-to-k/cdkd#3869)" >&2
  exit 1
fi
for needle_var in FILTER_NAME FILTER_NAME_ROTATED; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    echo "FAIL: the destroy log names a SecretFilter FilterName in plaintext: \${${needle_var}} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the destroy log does not name SecretFilter's FilterName"
# go-to-k/cdkd#3869: a destroy resolves nothing, so SecretQueue's own delete
# line (its URL), the queue policy reading it, and PlainScheduleRole detaching
# SecretPolicy (its ARN carries the path) printed the names in plaintext.
# PREMISE: the lines naming them are in the log.
if ! grep -qF -- "Deleting SQS queue SecretQueue: " "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the destroy log has no 'Deleting SQS queue SecretQueue: ' line (the --verbose debug stream is missing, or the wording drifted)" >&2
  log_tail
  exit 1
fi
# PlainScheduleRole attaches only SecretPolicy, so its detach line is the one.
if ! awk 'index($0, "Detached managed policy ") && index($0, " from role ") && index($0, "PlainScheduleRole") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the destroy log has no 'Detached managed policy ... from role ...PlainScheduleRole' line (the --verbose debug stream is missing, or the wording drifted)" >&2
  log_tail
  exit 1
fi
for needle_var in QUEUE_NAME POLICY_PATH; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    HIT_LINES="$(grep -nF -- "${!needle_var}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the destroy log names a secret-derived name in plaintext: \${${needle_var}} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the destroy log withholds SecretQueue's name and SecretPolicy's path"
# The schedule went through its own delete, found by the recorded creation
# date: not only through the group's deletion, which takes its schedules too.
if ! grep -qF "Deleted Schedule SecretSchedule (found by its recorded creation date)" "${DEPLOY_LOG}"; then
  echo "FAIL: the destroy log has no 'Deleted Schedule SecretSchedule (found by its recorded creation date)' line (go-to-k/cdkd#4275)" >&2
  log_tail
  exit 1
fi
echo "    OK: SecretSchedule was deleted by its recorded creation date"
if ! grep -qF "Deleted Schedule PlainTargetSchedule (found by its recorded creation date)" "${DEPLOY_LOG}"; then
  echo "FAIL: the destroy log has no 'Deleted Schedule PlainTargetSchedule (found by its recorded creation date)' line: the full identity (date, target, role) did not match (go-to-k/cdkd#4275)" >&2
  log_tail
  exit 1
fi
echo "    OK: PlainTargetSchedule was deleted by its recorded identity"

# Deploys the orphan stack, which must FAIL after ECR made the repository, and
# checks the journal records it as a proven orphan (no state record holds it).
# Used by step 6b (destroy) and step 6c (rollback).
orphan_deploy_failing() {
  ORPHAN_DEPLOYED=1
  set +e
  node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --yes --no-rollback > "${ORPHAN_LOG}" 2>&1
  ORPHAN_DEPLOY_RC=$?
  set -e
  if [ "${ORPHAN_DEPLOY_RC}" -eq 0 ]; then
    echo "FAIL: premise: the orphan stack's deploy exited 0; ECR accepted the invalid lifecycle policy" >&2
    tail -40 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  # PREMISE: ECR made the repository, and the journal records it as a proven
  # orphan (no state record holds it).
  if ! aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}" >/dev/null; then
    echo "FAIL: premise: the failed deploy left no repository ${REPO_NAME} (ECR refused the create itself?)" >&2
    tail -40 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  # `|| echo`: a missing or unparseable journal must reach the FAIL below, not
  # end the run at the assignment with no diagnostic.
  ORPHAN_PROVEN="$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_JOURNAL_KEY}" - \
    | jq -r '[.segments[].failedOperations[]? | select(.logicalId == "SecretOrphanRepo" and .physicalIdRecoveredFromError == true)] | length' 2>&1 \
    || echo "unreadable journal")"
  if [ "${ORPHAN_PROVEN}" != "1" ]; then
    echo "FAIL: premise: the journal holds ${ORPHAN_PROVEN} proven SecretOrphanRepo orphan(s), expected 1" >&2
    tail -40 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  echo "    OK: the failed deploy journaled the repository as a proven orphan"
}

echo "==> Step 6b: a failed-CREATE orphan named from the secret, destroyed from the journal"
orphan_deploy_failing
set +e
node "${LOCAL_DIST}" destroy "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --verbose > "${ORPHAN_LOG}" 2>&1
ORPHAN_DESTROY_RC=$?
set -e
if [ "${ORPHAN_DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: the orphan stack's destroy exited ${ORPHAN_DESTROY_RC}" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
# PREMISE: the provider's delete line for the orphan is in the log.
if ! grep -qF -- "Deleting ECR Repository SecretOrphanRepo: " "${ORPHAN_LOG}"; then
  echo "FAIL: premise: the destroy log has no 'Deleting ECR Repository SecretOrphanRepo: ' line (the --verbose debug stream is missing, the orphan was not deleted, or the wording drifted)" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
if grep -qF -- "${REPO_NAME}" "${ORPHAN_LOG}"; then
  HIT_LINES="$(grep -nF -- "${REPO_NAME}" "${ORPHAN_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the orphan stack's destroy log names the secret-derived repository name in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
assert_gone "orphan repository ${REPO_NAME} still exists after destroy" \
  aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}"
for key in "${ORPHAN_STATE_KEY}" "${ORPHAN_JOURNAL_KEY}"; do
  assert_gone "${key} still exists after the orphan stack's destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
echo "    OK: the journaled orphan was deleted, and the destroy log withholds its name"

echo "==> Step 6c: the same orphan, deleted by a plain cdkd rollback from the journal"
# go-to-k/cdkd#3869: a plain rollback replays the journal's proven orphans
# through its own failed-op replay, which ran under no printing bag. The stack
# is gone after step 6b, so this deploy is an initial one and the rollback
# removes state.json and the journal with it.
orphan_deploy_failing
set +e
node "${LOCAL_DIST}" rollback "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" \
  --force --verbose > "${ORPHAN_LOG}" 2>&1
ORPHAN_ROLLBACK_RC=$?
set -e
if [ "${ORPHAN_ROLLBACK_RC}" -ne 0 ]; then
  echo "FAIL: the orphan stack's rollback exited ${ORPHAN_ROLLBACK_RC}" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
# PREMISE: the provider's delete line for the orphan is in the log.
if ! grep -qF -- "Deleting ECR Repository SecretOrphanRepo: " "${ORPHAN_LOG}"; then
  echo "FAIL: premise: the rollback log has no 'Deleting ECR Repository SecretOrphanRepo: ' line (the --verbose debug stream is missing, the orphan was not deleted, or the wording drifted)" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
if grep -qF -- "${REPO_NAME}" "${ORPHAN_LOG}"; then
  HIT_LINES="$(grep -nF -- "${REPO_NAME}" "${ORPHAN_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the orphan stack's rollback log names the secret-derived repository name in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
assert_gone "orphan repository ${REPO_NAME} still exists after the rollback" \
  aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}"
for key in "${ORPHAN_STATE_KEY}" "${ORPHAN_JOURNAL_KEY}"; do
  assert_gone "${key} still exists after the orphan stack's initial-deploy rollback" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
echo "    OK: the rollback deleted the journaled orphan, and its log withholds the name"

echo "==> Step 6d: the same failed deploy WITHOUT --no-rollback: the automatic rollback deletes the orphan"
# go-to-k/cdkd#3869: the deploy engine's own rollback replays the orphan
# through its failed-op replay, which ran under no printing bag.
set +e
node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --yes --verbose > "${ORPHAN_LOG}" 2>&1
ORPHAN_AUTO_RC=$?
set -e
if [ "${ORPHAN_AUTO_RC}" -eq 0 ]; then
  echo "FAIL: premise: the orphan stack's deploy exited 0; ECR accepted the invalid lifecycle policy" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
# PREMISE: the automatic rollback's delete line for the orphan is in the log.
if ! grep -qF -- "Deleting ECR Repository SecretOrphanRepo: " "${ORPHAN_LOG}"; then
  echo "FAIL: premise: the deploy log has no 'Deleting ECR Repository SecretOrphanRepo: ' line (the automatic rollback did not delete the orphan, the --verbose debug stream is missing, or the wording drifted)" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
if grep -qF -- "${REPO_NAME}" "${ORPHAN_LOG}"; then
  HIT_LINES="$(grep -nF -- "${REPO_NAME}" "${ORPHAN_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the failed deploy's log (its automatic rollback included) names the secret-derived repository name in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
assert_gone "orphan repository ${REPO_NAME} still exists after the automatic rollback" \
  aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}"
echo "    OK: the automatic rollback deleted the orphan, and the deploy log withholds its name"

echo "==> Step 7: remove the secret; assert 0 orphans"
aws secretsmanager delete-secret --region "${REGION}" --secret-id "${SDIN_SECRET_NAME}" \
  --force-delete-without-recovery >/dev/null
SEEDED_SECRET=0

assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "API ${API_ID} still exists after destroy" \
  aws apigatewayv2 get-api --region "${REGION}" --api-id "${API_ID}"
assert_gone "managed policy ${POLICY_ARN} still exists after destroy" \
  aws iam get-policy --policy-arn "${POLICY_ARN}"
assert_gone "GraphQL API ${GQL_API_ID} still exists after destroy" \
  aws appsync get-graphql-api --region "${REGION}" --api-id "${GQL_API_ID}"
assert_gone "schedule ${SCHEDULE_NAME} still exists after destroy" \
  aws scheduler get-schedule --region "${REGION}" --name "${SCHEDULE_NAME}" --group-name "${GROUP_NAME}"
assert_gone "schedule group ${GROUP_NAME} still exists after destroy" \
  aws scheduler get-schedule-group --region "${REGION}" --name "${GROUP_NAME}"
assert_gone "schedule role ${SCHEDULE_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${SCHEDULE_ROLE}"
assert_gone "schedule ${PLAIN_SCHEDULE_NAME} still exists after destroy" \
  aws scheduler get-schedule --region "${REGION}" --name "${PLAIN_SCHEDULE_NAME}" --group-name "${GROUP_NAME}"
assert_gone "schedule role ${PLAIN_SCHEDULE_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${PLAIN_SCHEDULE_ROLE}"
# The log group's deletion takes its metric filters with it. A prefix listing
# does not error for a missing group, so a STRICT capture of the exact-name
# match is the probe (a throttle aborts under set -e).
LEFTOVER_LOG_GROUP="$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "${FILTER_LOG_GROUP}" \
  --query "logGroups[?logGroupName=='${FILTER_LOG_GROUP}'].logGroupName" --output text)"
if [ -n "${LEFTOVER_LOG_GROUP}" ] && [ "${LEFTOVER_LOG_GROUP}" != "None" ]; then
  echo "FAIL: log group ${FILTER_LOG_GROUP} (and its metric filter) still exists after destroy" >&2
  exit 1
fi
# SQS may answer for a deleted queue for up to 60 seconds.
for q in "${QUEUE_URL}" "${PLAIN_TARGET_QUEUE_URL}"; do
  QUEUE_GONE=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
    if gone_probe aws sqs get-queue-attributes --region "${REGION}" --queue-url "${q}" \
      --attribute-names QueueArn; then
      QUEUE_GONE=1
      break
    fi
    [ "${attempt}" = 14 ] || sleep 5
  done
  if [ "${QUEUE_GONE}" != "1" ]; then
    echo "FAIL: queue ${q} still exists 65s after destroy" >&2
    exit 1
  fi
done
# `describe-services` / `describe-clusters` do not error for a deleted one:
# they report it INACTIVE (or not at all), so a gone_probe cannot apply. A
# STRICT capture of the status is the probe (a throttle aborts under set -e).
SERVICE_STATUS="$(aws ecs describe-services --region "${REGION}" --cluster "${CLUSTER_ID}" \
  --services "${SERVICE_ARN}" --query 'services[0].status' --output text)"
if [ "${SERVICE_STATUS}" != "None" ] && [ "${SERVICE_STATUS}" != "INACTIVE" ] && [ "${SERVICE_STATUS}" != "DRAINING" ]; then
  echo "FAIL: service status after destroy is '${SERVICE_STATUS}', expected gone/DRAINING/INACTIVE" >&2
  exit 1
fi
CLUSTER_STATUS="$(aws ecs describe-clusters --region "${REGION}" --clusters "${CLUSTER_ID}" \
  --query 'clusters[0].status' --output text)"
if [ "${CLUSTER_STATUS}" != "None" ] && [ "${CLUSTER_STATUS}" != "INACTIVE" ]; then
  echo "FAIL: cluster status after destroy is '${CLUSTER_STATUS}', expected gone/INACTIVE" >&2
  exit 1
fi
# A deregistered task definition stays describable; its status is the probe.
TASK_DEF_STATUS="$(aws ecs describe-task-definition --region "${REGION}" \
  --task-definition "${TASK_DEF_ARN}" --query 'taskDefinition.status' --output text)"
if [ "${TASK_DEF_STATUS}" = "ACTIVE" ]; then
  echo "FAIL: task definition ${TASK_DEF_ARN} is still ACTIVE after destroy" >&2
  exit 1
fi
echo "    OK: 0 orphans (state, API with both stages, ECS service, cluster and task definition, managed policy, GraphQL API with its data source, queue, log group with its metric filter, both schedules with their group, roles and the second target queue)"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}" "${ORPHAN_LOG}" 2>/dev/null || true

echo "==> Step 8: sweep every object version under both stacks' state prefixes"
# On the SUCCESS path, after the disarm: a sweep living only in `cleanup` never
# runs here, and `noncurrent` would leave the delete marker behind.
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${ORPHAN_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${ORPHAN_PREFIX}" "orphan stack state teardown"
echo ""
echo "[verify] PASS - an in-place update of a Stage, an ECS Service, a managed policy, a GraphQL API, a data source, a Cloud Control-routed metric filter and a schedule whose immutable values come from a secret succeeded, in place, and destroy was clean"
