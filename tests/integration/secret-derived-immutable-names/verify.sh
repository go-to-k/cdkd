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
#   2. Deploy. The nested QueueReaderChild receives SecretQueue's ARN as its
#      QueueArn parameter: its `Resolved Ref to parameter: QueueArn` line is in
#      the log, the queue name is not, and the child's SSM parameter holds the
#      ARN (go-to-k/cdkd#3869). Cloud Control's create line withholds SecretFilter's id
#      (go-to-k/cdkd#3869), and the log names neither the queue name nor the
#      policy path that SecretQueueReaderPolicy and PlainScheduleRole read by
#      Ref / Fn::GetAtt (go-to-k/cdkd#3869: a value read from a resource named
#      from a secret is no recorded secret).
#   3. PREMISE: state records each secret-derived property as the
#      {{resolve:secretsmanager: expression, and each resource lives under the
#      name (path, description) the secret holds. SecretQueueReaderPolicy's
#      `Queues` holds the queue's URL in plaintext, its physical id, although
#      the policy's literal reference puts the queue name into its secrets bag
#      (go-to-k/cdkd#4810: the save rewrote it, and step 6's destroy failed).
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
#      With --recursive, so the nested QueueReaderChild's parameter lines
#      are swept too: the diff's child walk masks them with the parent row's
#      reads (its QueueUrl is SecretQueue's URL, in plaintext in state).
#   5c. SDIN_MOVE_FILTER=true moves MovingFilter from SecretNamedGroup (named
#      from the secret) to FilterLogGroup, which nothing else reads: a
#      replacement of its create-only LogGroupName, never deployed.
#      `cdkd diff --verbose` and `cdkd deploy --dry-run --verbose` each print
#      the replacement line, and neither log names the group: its OLD side is
#      the record's copy of the name, which no read of either diff pass
#      records (go-to-k/cdkd#3869).
#   5d. The same move, DEPLOYED: the replacement's `Deleting old MovingFilter
#      (<old id>)` line and Cloud Control's delete line print the old id,
#      `<LogGroupName>|<FilterName>`, and neither may name the group
#      (go-to-k/cdkd#3869). The filter then lives on FilterLogGroup, which the
#      destroy below deletes with it. The same deploy updates SecretQueue's
#      VisibilityTimeout (45), so its readers resolve its ARN from the provider.
#      LOAD-BEARING (go-to-k/cdkd#4802): step 4 updated the queue and the nested
#      row in one deploy, and the row and the child's SSM parameter stored the
#      ARN in reference form, as a reader of an unchanged queue does, so this
#      deploy does not update the row. Before, they stored the plaintext ARN
#      and this deploy updated the row once more.
#   5e. SDIN_ROLLBACK=true updates SecretQueue and SecretQueueReaderPolicy,
#      then RollbackBreaker's create fails (SSM refuses a Standard-tier value
#      over 4096 characters), WITHOUT --no-rollback. LOAD-BEARING: the
#      automatic rollback restores the policy with its `Queues` and
#      `cdkd:WrittenQueues` holding the queue's URL in plaintext; the replay
#      resolved the queue name from the policy's literal reference, and the
#      restore rewrote both into the reference, so step 6's destroy failed
#      (go-to-k/cdkd#4801).
#   5f. LOAD-BEARING (go-to-k/cdkd#4800): step 5d's template redeployed after
#      5e's rollback restored that state, with SDIN_READER_EDIT=true editing the
#      nested child's parameter so its row is UPDATEd, while SecretQueue is
#      NO_CHANGE and its readers resolve its ARN from the record, which holds it as
#      `arn:...:{{resolve:secretsmanager:...}}`. The reader that discriminates
#      is the nested QueueReaderChild row (its `QueueArn` parameter): it was
#      sent that spelling and the child's SSM parameter refused it, so the
#      deploy failed. Now the deploy exits 0 and the SSM parameter holds the
#      real ARN. The nested ChildQueuePolicy, whose bag now carries the queue
#      name, keeps its parent-passed `Queues` URL in plaintext
#      (go-to-k/cdkd#4819). (SecretQueueReaderPolicy no longer discriminates: its literal
#      reference, go-to-k/cdkd#4810, makes it store the reference whatever the
#      fix.) A second redeploy is expected to change nothing (a NOTE otherwise).
#      LOAD-BEARING (go-to-k/cdkd#4805): AssembledNameQueue, named by an
#      Fn::Join around a parameter naming the secret, is NO_CHANGE and its SSM
#      reader AssembledQueueReader is edited: no literal token proved the
#      region of the queue's recorded ARN reference, so the reader was sent its
#      `{{resolve:` spelling and SSM refused it. Now it holds the live ARN, and
#      its record the reference form. (The reader stored the plaintext ARN on
#      the step-2 create, so step 4's update already takes this path; before
#      the fix that deploy is where it failed.)
#   5g. LOAD-BEARING (go-to-k/cdkd#4838): rotate the secret's aqueue field and
#      respell AssembledNameQueue's token (SDIN_AQ_RESPELL=true), so the queue
#      is REPLACED under the rotated name. AssembledQueueReader spells the
#      original token in a tag, so the new ARN redacted to the reference it
#      stored for the old queue and the reader was skipped, left on the deleted
#      queue's ARN. Now its SSM value is the new queue's ARN. AqSubscription,
#      whose create-only Endpoint reads the ARN and whose filter policy spells
#      the token, is REPLACED onto the new queue.
#   5h. LOAD-BEARING (go-to-k/cdkd#4852, an INTERRUPTED deploy): SDIN_PH=true
#      adds PromoQueue (named from the secret's pqueue field) and PromoReader
#      (an SSM parameter storing its ARN, spelling the field in a tag); a
#      settle deploy edits the reader so its record holds the version it read.
#      Then rotate pqueue to a `.fifo` name and flip the queue to FIFO
#      (SDIN_PH_FIFO=true), a create-only change that REPLACES it under the
#      rotated name while its template spelling stays the same, with
#      SDIN_PH_FAULT=true setting an AllowedPattern the reader's value cannot
#      meet, under --no-rollback: the queue is replaced, the reader's update
#      fails. The fault cleared, `cdkd diff` labels the reader's Value
#      `[read value moved upstream]`, and the redeploy sends it (its `is sent`
#      info line): its SSM value is the new queue's ARN. Before, the reader
#      equalled its record and stayed on the deleted queue's ARN.
#   5i. LOAD-BEARING (go-to-k/cdkd#4852, a NESTED child): the same pattern
#      through the nested PromoChild, whose row passes NestQueue's ARN (the
#      nqueue field) to the child's PromoChildReader; the CHILD reader's
#      AllowedPattern fails the child, and so the row. `cdkd diff --recursive`
#      labels both the row's Parameters and the child reader's Value, and the
#      redeploy sends both: the child's SSM value is the new queue's ARN.
#   5j. LOAD-BEARING (go-to-k/cdkd#4852, a producer updated IN PLACE in an
#      earlier run): PromoValueProducer (an SSM parameter whose Value is the
#      pjvalue field) and PromoValueReader (its `Fn::GetAtt Value`). Rotate
#      pjvalue and edit the producer's Description only (SDIN_PJ_EDIT=true):
#      the producer is updated in place at the new version, the reader is
#      left NO_CHANGE by that run. The unchanged redeploy sends the reader,
#      which then holds the rotated value.
#      After each of 5h-5j, one more deploy with the same flags must neither
#      update nor send the promoted resources (steady state).
#   6. Destroy. Its --verbose log does not name SecretFilter's FilterName,
#      SecretQueue's name or SecretPolicy's path (go-to-k/cdkd#3869):
#      Cloud Control's delete line withholds the id (go-to-k/cdkd#3869).
#      LOAD-BEARING for the Schedules: each delete runs through the recorded
#      identity (the --verbose line naming it is asserted).
#   6b. A failed-CREATE orphan named from the secret (go-to-k/cdkd#3869): deploy
#      CdkdSecretDerivedOrphan with --no-rollback and SDIN_ORPHAN_STREAM=true
#      (Kinesis makes the stream, then rejects its retention, so the journal
#      records it with its creation identity), then destroy that stack: it
#      deletes the stream from the journal, and its --verbose log, the
#      provider's DELETE line included, does not name it.
#   6c. The ECR variant (ECR makes the repository, then rejects its lifecycle
#      policy), then a plain `cdkd rollback`: the repository journals no
#      creation identity, so it is kept (exit 2, go-to-k/cdkd#4658) and the
#      fixture deletes it by hand; the log does not name it either (the
#      failed-op replay's warning, go-to-k/cdkd#3869),
#      nor SecretRollbackQueue, the completed CREATE each rollback deletes
#      (the completed-op replay); 6d checks the same queue.
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
# a secret-named resource in plaintext: ${POLICY_PATH}": the `resolved to` line
# of PlainScheduleRole's Ref prints SecretPolicy's ARN, path and all, raw (not
# yet measured on real AWS). ${QUEUE_NAME} no longer discriminates that probe:
# SecretQueueReaderPolicy's literal reference (go-to-k/cdkd#4810) records the
# queue name as a secret of the policy's own resolution, which may mask its
# Ref / Fn::GetAtt lines with or without the go-to-k/cdkd#3869 fix.
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
# Revert the `withPrintingSecrets` wrap around `replayRollback` in
# src/cli/commands/rollback.ts (step 6c) or src/deployment/deploy-engine/rollback.ts
# (step 6d) ALONE and that step fails naming ${RB_QUEUE_NAME} on the SQS
# provider's delete line (not yet measured on real AWS).
# Revert go-to-k/cdkd#4801's src changes (src/deployment/rollback-executor/
# replay-secrets.ts and its callers, src/deployment/deploy-engine/rollback.ts,
# which imports the keep) and step 5e fails "SecretQueueReaderPolicy's
# restored Queues": the record holds `https://sqs.../{{resolve:secretsmanager:...}}`
# (not yet measured on real AWS).
# Revert the `secretNameNeedles` / `secretNameSink` lines of
# src/cli/commands/diff-recursive.ts ALONE and step 5b fails naming
# ${QUEUE_NAME}; revert the `withPrintingSecrets` wrap in
# src/cli/commands/destroy-runner.ts ALONE and step 6 fails naming
# ${QUEUE_NAME} on the 'Deleting SQS queue SecretQueue' line (neither yet
# measured on real AWS).
# Revert the `rowPrintingRegistry` argument of printNestedStackReadsOnly in
# src/deployment/deploy-engine/resolver-context.ts (pass a fresh Map) ALONE
# (go-to-k/cdkd#3869) and step 2 fails naming ${QUEUE_NAME} on the nested
# child's `Resolved Ref to parameter: QueueArn` line, and step 4 the same on
# the update (not yet measured on real AWS).
# Revert the `withPrintingSecrets` wrap around the nested child's
# `buildDiffTree` in src/cli/commands/diff-recursive.ts ALONE
# (go-to-k/cdkd#3869) and step 5b fails naming ${QUEUE_NAME} on the child's
# `Parameter QueueUrl:` line (not yet measured on real AWS).
# Revert the `stateNames` bag of computeStackDiff in
# src/cli/commands/diff-recursive.ts ALONE (go-to-k/cdkd#3869) and step 5c fails
# naming ${LOG_GROUP_NAME} on the diff's --verbose replacement line (the
# rendered row prints `[requires replacement]` with no old value); revert
# diffLogMasker's state-record judge in src/deployment/deploy-engine/masking.ts
# ALONE and step 5c fails the same way on the dry-run deploy's replacement
# line; revert the non-DELETE arm of the old-record reads in
# src/deployment/deploy-engine/provision.ts ALONE and step 5d fails naming it
# on the `Deleting old MovingFilter` line (none yet measured on real AWS).
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
# The nested QueueReaderChild (go-to-k/cdkd#3869): its own state key is a
# SIBLING prefix of the parent's, swept by its own prefix.
CHILD_STACK="${STACK}~QueueReaderChild"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"
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
# Step 6b's orphan, a Kinesis stream (SDIN_ORPHAN_STREAM=true).
STREAM_NAME="sdin-stream-${SUFFIX}"
# The orphan stack's completed CREATE, which each rollback deletes.
RB_QUEUE_NAME="sdin-rbq-${SUFFIX}"
# go-to-k/cdkd#4805: AssembledNameQueue, named by an Fn::Join around the secret.
AQ_QUEUE_NAME="sdin-aq-${SUFFIX}"
# go-to-k/cdkd#4838: the name step 5g rotates aqueue to; the queue is replaced under it.
AQ_QUEUE_NAME_2="sdin-aq2-${SUFFIX}"
# go-to-k/cdkd#4838: the topic AqSubscription subscribes the queue to, named per run.
export SDIN_AQ_TOPIC_NAME="cdkd-integ-sdin-aqt-${SUFFIX}"
AQ_TOPIC_NAME="${SDIN_AQ_TOPIC_NAME}"
# Step 5c's log group, named from the secret (go-to-k/cdkd#3869).
LOG_GROUP_NAME="sdin-lg-${SUFFIX}"
GROUP_NAME="sdin-grp-${SUFFIX}"
SCHEDULE_NAME="CdkdSdinSchedule"
PLAIN_SCHEDULE_NAME="CdkdSdinSchedulePlainTarget"
export SDIN_SECRET_NAME="cdkd-integ-sdin-secret-${SUFFIX}"
# The nested QueueReaderChild's SSM parameter, NAMED per run (go-to-k/cdkd#3869)
# so cleanup can delete it on every path, a child create that wrote no state
# included.
export SDIN_CHILD_PARAM_NAME="/cdkd-integ/sdin-${SUFFIX}/child-queue-arn"
CHILD_PARAM_NAME="${SDIN_CHILD_PARAM_NAME}"
# AssembledQueueReader's SSM parameter, named per run the same way (go-to-k/cdkd#4805).
export SDIN_AQ_PARAM_NAME="/cdkd-integ/sdin-${SUFFIX}/assembled-queue-arn"
AQ_PARAM_NAME="${SDIN_AQ_PARAM_NAME}"
# go-to-k/cdkd#4852 (steps 5h-5j): each arm's queue names (the second one is
# the rotated name, `.fifo` because the queue turns FIFO to be replaced), and
# its SSM parameters, named per run so cleanup can delete them by name.
PQ_NAME="sdin-pq-${SUFFIX}"
PQ_NAME_2="sdin-pq2-${SUFFIX}.fifo"
NQ_NAME="sdin-nq-${SUFFIX}"
NQ_NAME_2="sdin-nq2-${SUFFIX}.fifo"
PJ_VALUE_1="sdin-pjv-${SUFFIX}"
PJ_VALUE_2="sdin-pjv2-${SUFFIX}"
export SDIN_PH_PARAM_NAME="/cdkd-integ/sdin-${SUFFIX}/promo-reader"
export SDIN_PI_PARAM_NAME="/cdkd-integ/sdin-${SUFFIX}/promo-child-reader"
export SDIN_PJ_PRODUCER_NAME="/cdkd-integ/sdin-${SUFFIX}/promo-value-producer"
export SDIN_PJ_READER_NAME="/cdkd-integ/sdin-${SUFFIX}/promo-value-reader"
# Step 5i's nested child: its own state key is another SIBLING prefix.
PROMO_CHILD_STACK="${STACK}~PromoChild"
PROMO_CHILD_STATE_KEY="cdkd/${PROMO_CHILD_STACK}/${REGION}/state.json"
PROMO_CHILD_PREFIX="$(s3_stack_prefix "${PROMO_CHILD_STACK}" "${REGION}")"
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
    # The nested child's SSM parameter, by its per-run name (known before
    # any deploy, so a child create that wrote no state is covered), and the
    # child's state (its resources are gone by now, or deleted just here).
    aws ssm delete-parameter --region "${REGION}" --name "${CHILD_PARAM_NAME}" >/dev/null 2>&1
    # go-to-k/cdkd#4805's queue and reader, by their per-run names.
    aws ssm delete-parameter --region "${REGION}" --name "${AQ_PARAM_NAME}" >/dev/null 2>&1
    LEFT_AQ_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME}" \
      --query QueueUrl --output text 2>/dev/null)"
    if [ -n "${LEFT_AQ_QUEUE_URL}" ] && [ "${LEFT_AQ_QUEUE_URL}" != "None" ]; then
      aws sqs delete-queue --region "${REGION}" --queue-url "${LEFT_AQ_QUEUE_URL}" >/dev/null 2>&1
    fi
    # The topic by its per-run name; deleting it removes AqSubscription too.
    LEFT_AQ_TOPIC_ARN="$(aws sns list-topics --region "${REGION}" \
      --query "Topics[?ends_with(TopicArn, ':${AQ_TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null)"
    if [ -n "${LEFT_AQ_TOPIC_ARN}" ] && [ "${LEFT_AQ_TOPIC_ARN}" != "None" ]; then
      aws sns delete-topic --region "${REGION}" --topic-arn "${LEFT_AQ_TOPIC_ARN}" >/dev/null 2>&1
    fi
    LEFT_AQ2_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME_2}" \
      --query QueueUrl --output text 2>/dev/null)"
    if [ -n "${LEFT_AQ2_QUEUE_URL}" ] && [ "${LEFT_AQ2_QUEUE_URL}" != "None" ]; then
      aws sqs delete-queue --region "${REGION}" --queue-url "${LEFT_AQ2_QUEUE_URL}" >/dev/null 2>&1
    fi
    # SecretNamedGroup, by its per-run name; deleting it takes MovingFilter.
    aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP_NAME}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET:-}/${CHILD_STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${CHILD_STACK}/${REGION}/lock.json" >/dev/null 2>&1
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${CHILD_PREFIX}" noncurrent || true
    # go-to-k/cdkd#4852's parameters and queues (steps 5h-5j), by their
    # per-run names, and the nested PromoChild's state.
    for param in "${SDIN_PH_PARAM_NAME}" "${SDIN_PI_PARAM_NAME}" "${SDIN_PJ_PRODUCER_NAME}" "${SDIN_PJ_READER_NAME}"; do
      aws ssm delete-parameter --region "${REGION}" --name "${param}" >/dev/null 2>&1
    done
    for left_name in "${PQ_NAME}" "${PQ_NAME_2}" "${NQ_NAME}" "${NQ_NAME_2}"; do
      LEFT_PROMO_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${left_name}" \
        --query QueueUrl --output text 2>/dev/null)"
      if [ -n "${LEFT_PROMO_QUEUE_URL}" ] && [ "${LEFT_PROMO_QUEUE_URL}" != "None" ]; then
        aws sqs delete-queue --region "${REGION}" --queue-url "${LEFT_PROMO_QUEUE_URL}" >/dev/null 2>&1
      fi
    done
    aws s3 rm "s3://${STATE_BUCKET:-}/${PROMO_CHILD_STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${PROMO_CHILD_STACK}/${REGION}/lock.json" >/dev/null 2>&1
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${PROMO_CHILD_PREFIX}" noncurrent || true
  fi
  if [ "${ORPHAN_DEPLOYED}" = "1" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${ORPHAN_STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${ORPHAN_STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    aws ecr delete-repository --region "${REGION}" --repository-name "${REPO_NAME}" --force >/dev/null 2>&1
    aws kinesis delete-stream --region "${REGION}" --stream-name "${STREAM_NAME}" --enforce-consumer-deletion >/dev/null 2>&1
    LEFT_RB_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${RB_QUEUE_NAME}" \
      --query QueueUrl --output text 2>/dev/null)"
    if [ -n "${LEFT_RB_QUEUE_URL}" ] && [ "${LEFT_RB_QUEUE_URL}" != "None" ]; then
      aws sqs delete-queue --region "${REGION}" --queue-url "${LEFT_RB_QUEUE_URL}" >/dev/null 2>&1
    fi
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
printf '{"stage":"%s","service":"%s","path":"%s","policydesc":"%s","api":"%s","datasource":"%s","queue":"%s","filter":"%s","group":"%s","repo":"%s","rbqueue":"%s","stream":"%s","loggroup":"%s","aqueue":"%s"}' \
  "${STAGE_NAME}" "${SERVICE_NAME}" "${POLICY_PATH}" "${POLICY_DESC}" "${GQL_API_NAME}" "${DS_NAME}" "${QUEUE_NAME}" "${FILTER_NAME}" "${GROUP_NAME}" "${REPO_NAME}" "${RB_QUEUE_NAME}" "${STREAM_NAME}" "${LOG_GROUP_NAME}" "${AQ_QUEUE_NAME}" \
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

# The nested QueueReaderChild's read of its parent-passed QueueArn
# (go-to-k/cdkd#3869). A sentinel: a zero match would otherwise read as "the
# child printed nothing to mask".
expect_child_read_line() {
  local log="$1" which="$2"
  if ! grep -qF -- "Resolved Ref to parameter: QueueArn resolved to " "${log}"; then
    echo "FAIL: premise: the ${which} log has no 'Resolved Ref to parameter: QueueArn resolved to ' line (the nested child was not deployed, or the wording drifted)" >&2
    log_tail
    exit 1
  fi
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
# The nested child's SSM parameter (an SSM parameter's physical id is its
# name): the child's state must record the per-run name cleanup deletes.
CHILD_PARAM_RECORDED="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - \
  | jq -r '.resources.ChildQueueArn.physicalId // empty')"
if [ "${CHILD_PARAM_RECORDED}" != "${CHILD_PARAM_NAME}" ]; then
  echo "FAIL: ${CHILD_STATE_KEY} records ChildQueueArn as '${CHILD_PARAM_RECORDED}', not ${CHILD_PARAM_NAME}" >&2
  exit 1
fi

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
# go-to-k/cdkd#3869: the nested QueueReaderChild reads the parent-passed ARN.
# PREMISE: the child resolved it (its --verbose line is in the log), and AWS
# holds the real ARN, so the queue-name absence below covers that line.
expect_child_read_line "${DEPLOY_LOG}" "deploy"
CHILD_PARAM_VALUE="$(aws ssm get-parameter --region "${REGION}" --name "${CHILD_PARAM_NAME}" \
  --query Parameter.Value --output text)"
if [ "${CHILD_PARAM_VALUE##*:}" != "${QUEUE_NAME}" ]; then
  echo "FAIL: premise: QueueReaderChild's SSM parameter does not hold SecretQueue's ARN (the parameter did not reach the child)" >&2
  exit 1
fi
for needle_var in QUEUE_NAME POLICY_PATH; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    HIT_LINES="$(grep -nF -- "${!needle_var}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the deploy log names a value read from a secret-named resource in plaintext: \${${needle_var}} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the deploy log withholds what its readers read from SecretQueue and SecretPolicy"

echo "==> Step 3 (PREMISE): state records the names as the redacted expression"
for field in stage service path policydesc api datasource queue filter group loggroup; do
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
# go-to-k/cdkd#4810: SecretQueueReaderPolicy's literal reference put the queue
# name into its own secrets bag, and the save rewrote its copy of the queue's
# URL into `https://sqs.../{{resolve:...}}`; step 6's destroy then sent that to
# AWS. The copy is the queue's physical id, which state stores in plaintext.
expect_eq "SecretQueueReaderPolicy's recorded Queues (go-to-k/cdkd#4810)" "${QUEUE_URL}" \
  "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r '.resources.SecretQueueReaderPolicy.properties.Queues[0] // empty')"
expect_eq "SecretQueue's URL ends with the secret's queue name" "${QUEUE_NAME}" "${QUEUE_URL##*/}"
expect_eq "SecretNamedGroup lives under the secret's log group name" "${LOG_GROUP_NAME}" \
  "$(state_physical_id SecretNamedGroup)"
expect_eq "MovingFilter's recorded LogGroupName is the group's name, in plaintext" "${LOG_GROUP_NAME}" \
  "$(state_property MovingFilter LogGroupName)"
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
printf '{"stage":"%s","service":"%s","path":"%s","policydesc":"%s","api":"%s","datasource":"%s","queue":"%s","filter":"%s","group":"%s","repo":"%s","rbqueue":"%s","stream":"%s","loggroup":"%s","aqueue":"%s"}' \
  "${STAGE_NAME}" "${SERVICE_NAME}" "${POLICY_PATH}" "${POLICY_DESC}" "${GQL_API_NAME}" "${DS_NAME}" "${QUEUE_NAME}" "${FILTER_NAME_ROTATED}" "${GROUP_NAME}" "${REPO_NAME}" "${RB_QUEUE_NAME}" "${STREAM_NAME}" "${LOG_GROUP_NAME}" "${AQ_QUEUE_NAME}" \
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
  if awk 'index($0, "AssembledQueueReader") && index($0, "{{") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
    echo "FAIL: AssembledQueueReader's update failed on a {{ value: it was likely sent AssembledNameQueue's recorded {{resolve: ARN (go-to-k/cdkd#4805)" >&2
  fi
  echo "FAIL: update deploy exited ${UPDATE_RC}" >&2
  log_tail
  exit 1
fi
echo "    OK: update deploy exited 0"
# go-to-k/cdkd#4805: AssembledQueueReader stored the plaintext ARN on create,
# so this deploy updates it from AssembledNameQueue's record (the path 5f
# asserts too). Its absence would mean step 4 no longer exercises it.
if ! awk 'index($0, "AssembledQueueReader") && index($0, "(AWS::SSM::Parameter)") && index($0, "updated") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "NOTE: step 4 did not update AssembledQueueReader; go-to-k/cdkd#4805 is exercised by step 5f alone"
fi
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
expect_child_read_line "${DEPLOY_LOG}" "update"
for needle_var in STAGE_NAME SERVICE_NAME POLICY_PATH POLICY_DESC GQL_API_NAME DS_NAME QUEUE_NAME FILTER_NAME_ROTATED GROUP_NAME AQ_QUEUE_NAME; do
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
# The same template the update deployed, but the diff still resolves every
# reader's Ref / Fn::GetAtt against state, where SecretQueue's QueueName and
# SecretPolicy's Path are their {{resolve: references. PREMISE: each read's
# --verbose line is in the diff's log. --recursive: without it the diff never
# walks into QueueReaderChild.
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" --recursive \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose > "${DEPLOY_LOG}" 2>&1
DIFF_RC=$?
set -e
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: cdkd diff exited ${DIFF_RC}" >&2
  log_tail
  exit 1
fi
expect_read_lines "${DEPLOY_LOG}" "diff"
# `cdkd diff`'s walk into QueueReaderChild binds the child's parameters and
# prints them: masked by the needles of the parent row's reads
# (go-to-k/cdkd#3869). QueueUrl is the one that carries the queue name in
# plaintext (the row's `Ref SecretQueue`, the physical id); QueueArn arrives
# in its `{{resolve:` spelling. PREMISE: the child's lines are in the log, so
# the sweep below reads them too.
for child_line in "Resolved Ref to parameter: QueueArn" "Parameter QueueArn: " "Parameter QueueUrl: "; do
  if ! grep -qF -- "${child_line}" "${DEPLOY_LOG}"; then
    echo "FAIL: the cdkd diff log has no '${child_line}' line, so it cannot show QueueReaderChild's parameter is masked (premise; go-to-k/cdkd#3869)" >&2
    log_tail
    exit 1
  fi
done
for needle_var in QUEUE_NAME POLICY_PATH; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    HIT_LINES="$(grep -nF -- "${!needle_var}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the cdkd diff log names a value read from a secret-named resource in plaintext: \${${needle_var}} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the cdkd diff log withholds what its readers read from SecretQueue and SecretPolicy"

echo "==> Step 5c: a replacement whose OLD side is a secret-derived name no read names (go-to-k/cdkd#3869)"
# SDIN_MOVE_FILTER=true moves MovingFilter to FilterLogGroup, so nothing in the
# template reads SecretNamedGroup: only the state records can say the filter's
# recorded LogGroupName is a name derived from the secret. PREMISE: each log
# has the replacement line, naming the property and its NEW side (FilterLogGroup)
# in the clear, so the absence below is about a printed OLD side.
REPLACE_MARKER="Property LogGroupName of AWS::Logs::MetricFilter requires replacement (from "
# PREMISE for the new-side check below: an empty FilterLogGroup id would make
# that grep match every line.
if [ -z "${FILTER_LOG_GROUP}" ]; then
  echo "FAIL: premise: FILTER_LOG_GROUP is empty, so the replacement line's new side cannot be checked" >&2
  exit 1
fi
expect_move_replacement() { # usage: expect_move_replacement <which>
  local line
  line="$(grep -F -- "${REPLACE_MARKER}" "${DEPLOY_LOG}" || true)"
  if [ -z "${line}" ]; then
    echo "FAIL: premise: the $1 log has no '${REPLACE_MARKER}' line (MovingFilter did not move, the --verbose debug stream is missing, or the wording drifted)" >&2
    log_tail
    exit 1
  fi
  if ! grep -qF -- "${FILTER_LOG_GROUP}" <<< "${line}"; then
    echo "FAIL: premise: the $1 log's replacement line does not show the new side (FilterLogGroup) in the clear" >&2
    exit 1
  fi
  if grep -qF -- "${LOG_GROUP_NAME}" "${DEPLOY_LOG}"; then
    HIT_LINES="$(grep -nF -- "${LOG_GROUP_NAME}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the $1 log names SecretNamedGroup, a secret-derived name only the OLD state value holds, in plaintext: \${LOG_GROUP_NAME} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
  echo "    OK: the $1 log withholds the replaced filter's old, secret-derived log group name"
}
set +e
SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose > "${DEPLOY_LOG}" 2>&1
MOVE_DIFF_RC=$?
set -e
if [ "${MOVE_DIFF_RC}" -ne 0 ]; then
  echo "FAIL: the moved cdkd diff exited ${MOVE_DIFF_RC}" >&2
  log_tail
  exit 1
fi
expect_move_replacement "cdkd diff"
set +e
SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --dry-run \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
MOVE_DEPLOY_RC=$?
set -e
if [ "${MOVE_DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: the moved cdkd deploy --dry-run exited ${MOVE_DEPLOY_RC}" >&2
  log_tail
  exit 1
fi
expect_move_replacement "cdkd deploy --dry-run"
# PREMISE: the dry run changed nothing, so step 5d's deploy is the one that
# moves the filter.
expect_eq "MovingFilter's recorded LogGroupName after the dry run" "${LOG_GROUP_NAME}" \
  "$(state_property MovingFilter LogGroupName)"

echo "==> Step 5d: the same move, deployed: the replacement's delete lines withhold the old group (go-to-k/cdkd#3869)"
# PREMISE: the old filter's id embeds the group's name (`<LogGroupName>|<FilterName>`),
# so the old-id lines below WOULD name it unmasked. Otherwise the absence
# check passes whatever cdkd masks.
MOVING_FILTER_OLD_ID="$(state_physical_id MovingFilter)"
case "${MOVING_FILTER_OLD_ID}" in
  "${LOG_GROUP_NAME}|"?*) ;;
  *)
    echo "FAIL: premise: MovingFilter's physical id does not start with \${LOG_GROUP_NAME}| (the old-id lines would not carry the group's name)" >&2
    exit 1
    ;;
esac
set +e
SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
MOVE_REAL_RC=$?
set -e
if [ "${MOVE_REAL_RC}" -ne 0 ]; then
  echo "FAIL: the moved cdkd deploy exited ${MOVE_REAL_RC}" >&2
  log_tail
  exit 1
fi
# PREMISE: the replacement ran and named the old filter, so the absence below
# is about a printed old id.
if ! grep -qF -- "Deleting old MovingFilter (" "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the moved deploy's log has no 'Deleting old MovingFilter (' line (MovingFilter was not replaced, or the wording drifted)" >&2
  log_tail
  exit 1
fi
if grep -qF -- "${LOG_GROUP_NAME}" "${DEPLOY_LOG}"; then
  HIT_LINES="$(grep -nF -- "${LOG_GROUP_NAME}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the moved deploy's log names SecretNamedGroup in plaintext: \${LOG_GROUP_NAME} on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
echo "    OK: the moved deploy's log withholds the replaced filter's old, secret-derived log group name"
# PREMISE for the go-to-k/cdkd#4802 checks below: the queue WAS updated in this deploy.
expect_eq "SecretQueue's VisibilityTimeout after the move" "45" \
  "$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
    --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text)"
expect_eq "MovingFilter's recorded LogGroupName after the move" "${FILTER_LOG_GROUP}" \
  "$(state_property MovingFilter LogGroupName)"
# LOAD-BEARING (go-to-k/cdkd#4802): step 4's update deploy updated the queue
# and the nested row together, so the row was served the provider's fresh ARN
# in plaintext. It now records the queue's own secret pairs the value carries
# and stores the reference form, as a reader of an unchanged queue does;
# before, it stored the plaintext ARN, and this deploy (which updates the
# queue again) updated the row once more. Both halves: no row update in this
# deploy (the symptom), and the reference form in state.
if awk 'index($0, "QueueReaderChild") && index($0, "(AWS::CloudFormation::Stack)") && index($0, "updated") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: step 5d updated QueueReaderChild again: step 5's deploy, which updated SecretQueue, left its reader unsettled (go-to-k/cdkd#4802)" >&2
  log_tail
  exit 1
fi
for reader_check in \
  "QueueReaderChild's recorded QueueArn parameter|${STATE_KEY}|.resources.QueueReaderChild.properties.Parameters.QueueArn" \
  "ChildQueueArn's recorded Value|${CHILD_STATE_KEY}|.resources.ChildQueueArn.properties.Value"; do
  IFS='|' read -r reader_what reader_key reader_path <<< "${reader_check}"
  reader_value="$(aws s3 cp "s3://${STATE_BUCKET}/${reader_key}" - | jq -r "${reader_path} // empty")"
  case "${reader_value}" in
    arn:*"{{resolve:secretsmanager:"*) ;;
    *)
      echo "FAIL: ${reader_what} after step 5d does not hold the {{resolve:secretsmanager: reference form (go-to-k/cdkd#4802)" >&2
      exit 1
      ;;
  esac
done
echo "    OK: the readers of the queue updated in this deploy store its ARN in reference form (go-to-k/cdkd#4802)"

echo "==> Step 5e: an automatic rollback restores SecretQueueReaderPolicy with its queue URL in plaintext (go-to-k/cdkd#4801)"
# SDIN_ROLLBACK=true updates SecretQueue (VisibilityTimeout 50) and the policy
# (a new Sid), then creates RollbackBreaker after the policy, which SSM refuses.
# The deploy runs WITHOUT --no-rollback, so the automatic rollback reverts the
# policy. Its replay re-resolves the policy's literal reference, which puts the
# queue name into the op's secrets; the restore then rewrote the plaintext
# `Queues` URL into the reference, and step 6's destroy sent that to AWS.
set +e
SDIN_ROLLBACK=true SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
ROLLBACK_RC=$?
set -e
if [ "${ROLLBACK_RC}" -eq 0 ]; then
  echo "FAIL: premise: the SDIN_ROLLBACK deploy exited 0 (RollbackBreaker was not refused, so nothing rolled back)" >&2
  log_tail
  exit 1
fi
# PREMISE: the policy was updated, the breaker failed, and the rollback
# restored the policy, so the record read below is the restore's. The
# breaker's needle is the SSM provider's own failure line, the shape
# noecho-parameter-masking's NoEchoReject asserts: the bare logical id is also
# in the plan output, which a deploy that never created it prints too.
for marker in "Failed to create SSM parameter RollbackBreaker" \
  "Rollback: SecretQueueReaderPolicy restored successfully" \
  "The automatic rollback restored the pre-deploy state."; do
  if ! grep -qF -- "${marker}" "${DEPLOY_LOG}"; then
    echo "FAIL: premise: the SDIN_ROLLBACK deploy's log has no '${marker}' line (the rollback did not restore the policy, or the wording drifted)" >&2
    log_tail
    exit 1
  fi
done
# The revert reached AWS: the live policy carries the pre-deploy Sid again.
LIVE_READER_POLICY="$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
  --attribute-names Policy --query 'Attributes.Policy' --output text)"
case "${LIVE_READER_POLICY}" in
  *SdinReaderUpdated*) ;;
  *)
    echo "FAIL: premise: the live queue policy does not carry the pre-deploy Sid 'SdinReaderUpdated' after the rollback" >&2
    exit 1
    ;;
esac
# LOAD-BEARING (go-to-k/cdkd#4801): what the queue-policy provider deletes by.
expect_eq "SecretQueueReaderPolicy's restored Queues (go-to-k/cdkd#4801)" "${QUEUE_URL}" \
  "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r '.resources.SecretQueueReaderPolicy.properties.Queues[0] // empty')"
expect_eq "SecretQueueReaderPolicy's restored cdkd:WrittenQueues (go-to-k/cdkd#4801)" "${QUEUE_URL}" \
  "$(state_attribute SecretQueueReaderPolicy 'cdkd:WrittenQueues')"
expect_eq "SecretQueue's VisibilityTimeout after the rollback" "45" \
  "$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
    --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text)"

echo "==> Step 5f: step 5d's template again: SecretQueue's readers resolve its recorded ARN (go-to-k/cdkd#4800)"
# PREMISE: the record holds SecretQueue's ARN as its `{{resolve:` spelling, so
# the readers of the now NO_CHANGE queue are served it from the record.
QUEUE_ARN_RECORDED="$(state_attribute SecretQueue Arn)"
case "${QUEUE_ARN_RECORDED}" in
  arn:*"{{resolve:secretsmanager:"*) ;;
  *)
    echo "FAIL: premise: SecretQueue's recorded Arn does not carry a {{resolve:secretsmanager: spelling (go-to-k/cdkd#4800 needs it)" >&2
    exit 1
    ;;
esac
QUEUE_ARN_LIVE="$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
if [ "${QUEUE_ARN_LIVE##*:}" != "${QUEUE_NAME}" ]; then
  echo "FAIL: premise: SecretQueue's live ARN '${QUEUE_ARN_LIVE}' does not end in its name" >&2
  exit 1
fi
# PREMISE: the readers hold the reference form step 5d wrote (5e's rollback
# restored that state; go-to-k/cdkd#4802), so nothing in them differs from
# today's template: SDIN_READER_EDIT=true edits the nested child's parameter
# so the row is UPDATEd and resolves SecretQueue's ARN from the record.
CHILD_VALUE_AFTER_5D="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - \
  | jq -r '.resources.ChildQueueArn.properties.Value // empty')"
case "${CHILD_VALUE_AFTER_5D}" in
  arn:*"{{resolve:secretsmanager:"*) ;;
  *)
    echo "FAIL: premise: ChildQueueArn's recorded Value after step 5e is not the reference form (go-to-k/cdkd#4802)" >&2
    exit 1
    ;;
esac
# PREMISE: the queue is NO_CHANGE in this deploy, so its readers resolve its ARN
# from the record. An UPDATE would serve the provider's fresh ARN, and every
# check below would pass with the fix reverted.
expect_eq "premise: SecretQueue's recorded VisibilityTimeout after step 5e's rollback (5f needs the queue NO_CHANGE)" \
  "45" "$(state_property SecretQueue VisibilityTimeout)"
set +e
SDIN_READER_EDIT=true SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
NOOP_RC=$?
set -e
if [ "${NOOP_RC}" -ne 0 ]; then
  echo "FAIL: the redeploy over a NO_CHANGE SecretQueue exited ${NOOP_RC}: a reader was likely sent its recorded {{resolve: ARN (go-to-k/cdkd#4800)" >&2
  log_tail
  exit 1
fi
# PREMISE: this deploy updated the nested row, so the value below was sent now.
if ! awk 'index($0, "QueueReaderChild") && index($0, "(AWS::CloudFormation::Stack)") && index($0, "updated") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the redeploy's log has no 'QueueReaderChild (AWS::CloudFormation::Stack) updated' line (the reader was not re-sent, or the wording drifted)" >&2
  log_tail
  exit 1
fi
# ...and the queue itself was NOT updated (the line format is the one asserted
# present for QueueReaderChild above, so its absence is not vacuous).
if awk 'index($0, "SecretQueue") && index($0, "(AWS::SQS::Queue)") && index($0, "updated") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the redeploy UPDATED SecretQueue, so its readers were served the provider's fresh ARN rather than the record's (go-to-k/cdkd#4800 is not exercised)" >&2
  log_tail
  exit 1
fi
expect_eq "QueueReaderChild's SSM parameter after the redeploy" "${QUEUE_ARN_LIVE}" \
  "$(aws ssm get-parameter --region "${REGION}" --name "${CHILD_PARAM_NAME}" \
    --query 'Parameter.Value' --output text)"
# go-to-k/cdkd#4805: AssembledNameQueue's name is an Fn::Join, so no literal
# token proved the region of its recorded ARN's reference. PREMISES: this
# deploy updated its reader and not the queue, so the reader was served the
# record.
if ! awk 'index($0, "AssembledQueueReader") && index($0, "(AWS::SSM::Parameter)") && index($0, "updated") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the redeploy's log has no 'AssembledQueueReader (AWS::SSM::Parameter) updated' line" >&2
  log_tail
  exit 1
fi
if awk 'index($0, "AssembledNameQueue") && index($0, "(AWS::SQS::Queue)") && index($0, "updated") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the redeploy UPDATED AssembledNameQueue, so its reader was served the provider's ARN (go-to-k/cdkd#4805 is not exercised)" >&2
  log_tail
  exit 1
fi
AQ_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME}" \
  --query QueueUrl --output text)"
AQ_ARN_LIVE="$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${AQ_QUEUE_URL}" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
if [ "${AQ_ARN_LIVE##*:}" != "${AQ_QUEUE_NAME}" ]; then
  echo "FAIL: premise: AssembledNameQueue's live ARN does not end with the secret's aqueue value" >&2
  exit 1
fi
# PREMISE: the queue's record stores its ARN in reference form, the shape a
# reader of it was sent as is.
case "$(state_attribute AssembledNameQueue Arn)" in
  arn:*'{{resolve:secretsmanager:'*) ;;
  *) echo "FAIL: premise: AssembledNameQueue's recorded Arn is not in {{resolve: reference form" >&2; exit 1 ;;
esac
# LOAD-BEARING: the reader was sent the real ARN (SSM refused the reference
# spelling, and the deploy failed above), and stores the reference form.
expect_eq "AssembledQueueReader's SSM parameter after the redeploy (go-to-k/cdkd#4805)" "${AQ_ARN_LIVE}" \
  "$(aws ssm get-parameter --region "${REGION}" --name "${AQ_PARAM_NAME}" \
    --query 'Parameter.Value' --output text)"
if grep -qF -- "${AQ_QUEUE_NAME}" "${DEPLOY_LOG}"; then
  echo "FAIL: the redeploy's log names AssembledNameQueue in plaintext (go-to-k/cdkd#3869)" >&2
  exit 1
fi
case "$(state_property AssembledQueueReader Value)" in
  arn:*'{{resolve:secretsmanager:'*) ;;
  *) echo "FAIL: AssembledQueueReader's recorded Value is not in {{resolve: reference form (go-to-k/cdkd#4805)" >&2; exit 1 ;;
esac
# go-to-k/cdkd#4819: ChildQueuePolicy reads the parent-passed URL and ARN.
# PREMISE: its bag carried the queue name (the ARN it read is recorded in its
# reference form), so the save's value scan met the URL. Since go-to-k/cdkd#4802
# the pair is carried from step 4, the update that kept the queue's physical
# id, so the record checked here may be that save's rather than this deploy's;
# either way the URL met the scan beside the name.
CHILD_POLICY_RESOURCE="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - \
  | jq -r '.resources.ChildQueuePolicy.properties.PolicyDocument.Statement[0].Resource // empty')"
case "${CHILD_POLICY_RESOURCE}" in
  arn:*'{{resolve:secretsmanager:'*) ;;
  *) echo "FAIL: premise: ChildQueuePolicy's recorded Resource is '${CHILD_POLICY_RESOURCE}', not the ARN's reference form (its bag did not carry the queue name)" >&2; exit 1 ;;
esac
# LOAD-BEARING: the URL, the queue's physical id, stays as the id is; the save
# rewrote it into `https://sqs.../{{resolve:...}}` and step 6's destroy failed.
expect_eq "ChildQueuePolicy's recorded Queues URL after the redeploy (go-to-k/cdkd#4819)" "${QUEUE_URL}" \
  "$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - \
    | jq -r '.resources.ChildQueuePolicy.properties.Queues[0] // empty')"
# Not load-bearing for go-to-k/cdkd#4800 (the policy's literal reference makes
# it store and send the right ARN whatever the fix): a regression guard only.
expect_eq "SecretQueueReaderPolicy's live Resource after the redeploy" "${QUEUE_ARN_LIVE}" \
  "$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
    --attribute-names Policy --query 'Attributes.Policy' --output text \
    | jq -r '.Statement[0].Resource')"
expect_eq "SecretQueue's VisibilityTimeout after the redeploy" "45" \
  "$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${QUEUE_URL}" \
    --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text)"
if grep -qF -- "${QUEUE_NAME}" "${DEPLOY_LOG}"; then
  HIT_LINES="$(grep -nF -- "${QUEUE_NAME}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the redeploy's log names SecretQueue in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
echo "    OK: the readers of a NO_CHANGE secret-named queue got its real ARN"
set +e
SDIN_READER_EDIT=true SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
NOOP2_RC=$?
set -e
if [ "${NOOP2_RC}" -ne 0 ]; then
  echo "FAIL: the second redeploy exited ${NOOP2_RC}" >&2
  log_tail
  exit 1
fi
if grep -qF -- "${QUEUE_NAME}" "${DEPLOY_LOG}"; then
  echo "FAIL: the second redeploy's log names SecretQueue in plaintext (go-to-k/cdkd#3869)" >&2
  exit 1
fi
if grep -qF -- "${AQ_QUEUE_NAME}" "${DEPLOY_LOG}"; then
  echo "FAIL: the second redeploy's log names AssembledNameQueue in plaintext (go-to-k/cdkd#3869)" >&2
  exit 1
fi
# A NOTE until a real run shows this fixture can reach a no-op at all (the
# nested QueueReaderChild row may redeploy on its own); the unit test
# deploy-engine-getatt-recorded-dynamic-reference-4800 pins the settled readers.
if grep -qF "No changes detected" "${DEPLOY_LOG}"; then
  echo "    OK: a second redeploy changed nothing"
else
  echo "    NOTE: the second redeploy was not a no-op (go-to-k/cdkd#4800 expects the readers to be settled)"
fi

echo "==> Step 5g: AssembledNameQueue replaced under a rotated secret; its reader spells the secret (go-to-k/cdkd#4838)"
# Rotate the secret's aqueue field (every other field keeps step 3b's value)
# and respell the queue's token by version stage (SDIN_AQ_RESPELL=true): a
# create-only change, so the queue is REPLACED under the rotated name.
# AssembledQueueReader's own tag spells the ORIGINAL token, so its bag maps
# the rotated name to it: the new ARN redacted to the reference it stored for
# the old queue, the no-change re-check compared equal, and the reader kept the
# deleted queue's ARN.
SECRET_FILE="$(mktemp -t secret-derived-immutable-names-secret.XXXXXX)"
printf '{"stage":"%s","service":"%s","path":"%s","policydesc":"%s","api":"%s","datasource":"%s","queue":"%s","filter":"%s","group":"%s","repo":"%s","rbqueue":"%s","stream":"%s","loggroup":"%s","aqueue":"%s"}' \
  "${STAGE_NAME}" "${SERVICE_NAME}" "${POLICY_PATH}" "${POLICY_DESC}" "${GQL_API_NAME}" "${DS_NAME}" "${QUEUE_NAME}" "${FILTER_NAME_ROTATED}" "${GROUP_NAME}" "${REPO_NAME}" "${RB_QUEUE_NAME}" "${STREAM_NAME}" "${LOG_GROUP_NAME}" "${AQ_QUEUE_NAME_2}" \
  > "${SECRET_FILE}"
aws secretsmanager put-secret-value --region "${REGION}" --secret-id "${SDIN_SECRET_NAME}" \
  --secret-string "file://${SECRET_FILE}" >/dev/null
rm -f "${SECRET_FILE}"
set +e
SDIN_AQ_RESPELL=true SDIN_READER_EDIT=true SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
ROTATE_RC=$?
set -e
if [ "${ROTATE_RC}" -ne 0 ]; then
  echo "FAIL: the rotated-secret redeploy exited ${ROTATE_RC}" >&2
  log_tail
  exit 1
fi
# PREMISE: the queue was replaced, under the rotated name.
if ! awk 'index($0, "AssembledNameQueue") && index($0, "(AWS::SQS::Queue)") && index($0, "replaced") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the redeploy's log has no 'AssembledNameQueue (AWS::SQS::Queue) replaced' line" >&2
  log_tail
  exit 1
fi
AQ2_QUEUE_URL="$(aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME_2}" \
  --query QueueUrl --output text)"
AQ2_ARN_LIVE="$(aws sqs get-queue-attributes --region "${REGION}" --queue-url "${AQ2_QUEUE_URL}" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
if [ "${AQ2_ARN_LIVE##*:}" != "${AQ_QUEUE_NAME_2}" ]; then
  echo "FAIL: premise: the replacement queue's live ARN does not end with the rotated aqueue value" >&2
  exit 1
fi
assert_gone "the replaced AssembledNameQueue still exists" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME}"
# LOAD-BEARING: the reader holds the NEW queue's ARN; before the fix it was
# skipped and kept the deleted queue's.
expect_eq "AssembledQueueReader's SSM parameter after the replacement (go-to-k/cdkd#4838)" "${AQ2_ARN_LIVE}" \
  "$(aws ssm get-parameter --region "${REGION}" --name "${AQ_PARAM_NAME}" \
    --query 'Parameter.Value' --output text)"
# LOAD-BEARING: AqSubscription's create-only Endpoint read the queue's ARN,
# so it is REPLACED onto the new queue: one subscription, to the new ARN.
if ! awk 'index($0, "AqSubscription") && index($0, "(AWS::SNS::Subscription)") && index($0, "replaced") { found = 1 } END { exit !found }' "${DEPLOY_LOG}"; then
  echo "FAIL: the redeploy's log has no 'AqSubscription (AWS::SNS::Subscription) replaced' line: the subscription was skipped, or updated in place (go-to-k/cdkd#4838)" >&2
  log_tail
  exit 1
fi
AQ_TOPIC_ARN="$(state_physical_id AqTopic)"
if [ -z "${AQ_TOPIC_ARN}" ]; then
  echo "FAIL: premise: the state records no AqTopic" >&2
  exit 1
fi
expect_eq "AqTopic's subscription endpoints after the replacement (go-to-k/cdkd#4838)" "${AQ2_ARN_LIVE}" \
  "$(aws sns list-subscriptions-by-topic --region "${REGION}" --topic-arn "${AQ_TOPIC_ARN}" \
    --query 'Subscriptions[].Endpoint' --output text)"
for needle_var in AQ_QUEUE_NAME AQ_QUEUE_NAME_2; do
  if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
    echo "FAIL: the rotated-secret redeploy's log carries \${${needle_var}} in plaintext (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
done
echo "    OK: the reader of a queue replaced under a rotated secret got the new queue's ARN"

# --- go-to-k/cdkd#4852 (steps 5h-5j): read-provenance promotion -------------
# Every deploy from here on carries step 5g's flags (so nothing earlier moves)
# plus each arm's own, which stay set once added: a flag dropped from a later
# deploy would DELETE that arm's resources.
PROMO_ENV=(SDIN_AQ_RESPELL=true SDIN_READER_EDIT=true SDIN_MOVE_FILTER=true CDKD_TEST_UPDATE=true)
# The secret's pqueue / nqueue / pjvalue values, rotated one at a time.
PQ_CUR="${PQ_NAME}"
NQ_CUR="${NQ_NAME}"
PJ_CUR="${PJ_VALUE_1}"
promo_put_secret() { # writes step 5g's values plus PQ_CUR / NQ_CUR / PJ_CUR: a new secret version
  SECRET_FILE="$(mktemp -t secret-derived-immutable-names-secret.XXXXXX)"
  printf '{"stage":"%s","service":"%s","path":"%s","policydesc":"%s","api":"%s","datasource":"%s","queue":"%s","filter":"%s","group":"%s","repo":"%s","rbqueue":"%s","stream":"%s","loggroup":"%s","aqueue":"%s","pqueue":"%s","nqueue":"%s","pjvalue":"%s"}' \
    "${STAGE_NAME}" "${SERVICE_NAME}" "${POLICY_PATH}" "${POLICY_DESC}" "${GQL_API_NAME}" "${DS_NAME}" "${QUEUE_NAME}" "${FILTER_NAME_ROTATED}" "${GROUP_NAME}" "${REPO_NAME}" "${RB_QUEUE_NAME}" "${STREAM_NAME}" "${LOG_GROUP_NAME}" "${AQ_QUEUE_NAME_2}" "${PQ_CUR}" "${NQ_CUR}" "${PJ_CUR}" \
    > "${SECRET_FILE}"
  aws secretsmanager put-secret-value --region "${REGION}" --secret-id "${SDIN_SECRET_NAME}" \
    --secret-string "file://${SECRET_FILE}" >/dev/null
  rm -f "${SECRET_FILE}"
}
promo_deploy() { # usage: promo_deploy [--no-rollback] [VAR=value ...] -> DEPLOY_LOG, PROMO_RC
  local no_rollback=""
  if [ "${1:-}" = "--no-rollback" ]; then
    no_rollback="--no-rollback"
    shift
  fi
  set +e
  env "${PROMO_ENV[@]}" "$@" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes ${no_rollback} > "${DEPLOY_LOG}" 2>&1
  PROMO_RC=$?
  set -e
}
promo_expect_deployed() { # usage: promo_expect_deployed <which>: PROMO_RC must be 0
  if [ "${PROMO_RC}" -ne 0 ]; then
    echo "FAIL: the $1 deploy exited ${PROMO_RC}" >&2
    log_tail
    exit 1
  fi
}
promo_token() { # usage: promo_token <json field> -> the {{resolve: spelling the stack's fromSecret writes
  printf '{{resolve:secretsmanager:%s:SecretString:%s::}}' "${SDIN_SECRET_NAME}" "$1"
}
promo_versions() { # usage: promo_versions <state key> <logical id> <token> <versions|readVersions> -> a JSON array, [] when absent
  aws s3 cp "s3://${STATE_BUCKET}/$1" - \
    | jq -c --arg id "$2" --arg t "$3" --arg f "$4" '((.resources[$id].referenceProvenance // {})[$t] // {})[$f] // []'
}
promo_subset() { # usage: promo_subset <json array a> <json array b> -> "true" when a is non-empty and every member is in b
  jq -n -r --argjson a "$1" --argjson b "$2" '($a | length) > 0 and (($a - $b) | length) == 0'
}
promo_moved() { # usage: promo_moved <read versions> <upstream versions> -> "true" when both are non-empty and a read version is not upstream
  jq -n -r --argjson a "$1" --argjson b "$2" '($a | length) > 0 and ($b | length) > 0 and (($a - $b) | length) > 0'
}
promo_log_has() { # usage: promo_log_has <logical id> <(type)> <verb> -> 0 when one DEPLOY_LOG line holds all three
  # Three separate index() checks: the resource line puts colour codes between them.
  awk -v a="$1" -v b="$2" -v c="$3" 'index($0, a) && index($0, b) && index($0, c) { found = 1 } END { exit !found }' \
    "${DEPLOY_LOG}"
}
promo_diff_labelled() { # usage: promo_diff_labelled <logical id> <property>: the diff in DEPLOY_LOG labels it [read value moved upstream]
  awk -v id="$1" -v prop="$2" '
    /\[[~+-]\] / { cur = (index($0, "[~] " id " (") > 0) ? id : ""; next }
    cur != "" && index($0, "- " prop ":") && index($0, "[read value moved upstream]") { found = 1 }
    END { exit !found }' "${DEPLOY_LOG}"
}
promo_assert_masked() { # usage: promo_assert_masked <which> <VAR>... (by NAME: a red never prints the value)
  local which="$1" needle_var
  shift
  for needle_var in "$@"; do
    if grep -qF -- "${!needle_var}" "${DEPLOY_LOG}"; then
      HIT_LINES="$(grep -nF -- "${!needle_var}" "${DEPLOY_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
      echo "FAIL: the ${which} log carries \${${needle_var}} in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
      exit 1
    fi
  done
}
promo_queue_arn() { # usage: promo_queue_arn <queue name> (a strict capture: a failed read aborts)
  local url
  url="$(aws sqs get-queue-url --region "${REGION}" --queue-name "$1" --query QueueUrl --output text)" || return 1
  aws sqs get-queue-attributes --region "${REGION}" --queue-url "${url}" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text
}
promo_param_value() { # usage: promo_param_value <parameter name> (a strict capture)
  aws ssm get-parameter --region "${REGION}" --name "$1" --query Parameter.Value --output text
}
promo_capture() { # usage: promo_capture <VAR> <what> <command...>: a failed or EMPTY read fails the run naming it
  # errexit does not reach a read inside `[ "$(...)" ]` or `jq --argjson`, so every
  # read is captured here first (a value never printed: only <what> is named).
  local var="$1" what="$2" out
  shift 2
  if ! out="$("$@")" || [ -z "${out}" ]; then
    echo "FAIL: could not read ${what} (the read failed or returned nothing)" >&2
    exit 1
  fi
  printf -v "${var}" '%s' "${out}"
}
promo_assert_settled() { # usage: promo_assert_settled <which> <logical id>|<(type)>...
  # One more deploy with the same flags: a promoted reader whose record was
  # rewritten at the version it was sent must be settled, never sent again.
  local which="$1" pair id type
  shift
  promo_deploy
  promo_expect_deployed "${which} steady-state"
  # Sentinel: the log was captured (the absences below are about this deploy).
  if ! grep -qF -- "${STACK}" "${DEPLOY_LOG}"; then
    echo "FAIL: the ${which} steady-state deploy's log does not name ${STACK} - the output was not captured" >&2
    exit 1
  fi
  for pair in "$@"; do
    id="${pair%%|*}"
    type="${pair#*|}"
    if promo_log_has "${id}" "${type}" "updated" || grep -qF -- "${id} is sent: " "${DEPLOY_LOG}"; then
      echo "FAIL: ${id} was promoted again on the next deploy (go-to-k/cdkd#4852): the ${which} steady-state deploy updated or sent it although nothing upstream moved since it was sent" >&2
      log_tail
      exit 1
    fi
  done
  echo "    OK: the ${which} steady-state deploy left $* alone"
}
promo_assert_none_sent() { # usage: promo_assert_none_sent <which> [allowed logical id...]
  # Rotation-alone parity (go-to-k/cdkd#4852): after a version bump of the
  # secret, a reader whose OWN key did not rotate is never sent. Every
  # `<Id> is sent:` line in DEPLOY_LOG must name an allowed id. Sentinel: the
  # log names the stack, so it was captured; the arms assert the same line
  # PRESENT where a send is due, so a reworded line fails there.
  local which="$1" sent id allowed ok
  shift
  if ! grep -qF -- "${STACK}" "${DEPLOY_LOG}"; then
    echo "FAIL: the ${which} deploy's log does not name ${STACK} - the output was not captured, so the absence below would be vacuous" >&2
    exit 1
  fi
  sent="$(awk '{ i = index($0, " is sent: "); if (i) { n = split(substr($0, 1, i - 1), w, /[ \t]+/); print w[n] } }' "${DEPLOY_LOG}")" || {
    echo "FAIL: could not scan the ${which} deploy's log for 'is sent:' lines" >&2
    exit 1
  }
  for id in ${sent}; do
    ok=0
    for allowed in "$@"; do
      if [ "${id}" = "${allowed}" ]; then ok=1; fi
    done
    if [ "${ok}" != "1" ]; then
      echo "FAIL: ${id} was sent after a rotation of another key (go-to-k/cdkd#4852 rotation-alone parity): the ${which} deploy" >&2
      log_tail
      exit 1
    fi
  done
}
promo_wait_queue_gone() { # usage: promo_wait_queue_gone <what> <queue name>: SQS may answer for a deleted queue for up to 60 seconds
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
    if gone_probe aws sqs get-queue-url --region "${REGION}" --queue-name "$2"; then
      return 0
    fi
    [ "${attempt}" = 14 ] || sleep 5
  done
  echo "FAIL: premise: $1 still exists 65s after its replacement deleted it" >&2
  exit 1
}

echo "==> Step 5h: a reader left on a replaced queue by an INTERRUPTED deploy is sent on the next one (go-to-k/cdkd#4852)"
PQ_TOKEN="$(promo_token pqueue)"
# Every promo field enters the secret now (one new version); each arm rotates
# its own field later.
promo_put_secret
PROMO_ENV+=(SDIN_PH=true)
promo_deploy
promo_expect_deployed "step 5h create"
promo_assert_none_sent "step 5h create (after the promo fields entered the secret)"
# A settle deploy: the reader is edited while PromoQueue is NO_CHANGE, so it is
# served the queue's RECORDED ARN on the read route and records that version.
PROMO_ENV+=(SDIN_PH_SETTLE=true)
promo_deploy
promo_expect_deployed "step 5h settle"
if ! promo_log_has "PromoReader" "(AWS::SSM::Parameter)" "updated"; then
  echo "FAIL: premise: the step 5h settle deploy has no 'PromoReader (AWS::SSM::Parameter) updated' line (the reader was not written, or the wording drifted)" >&2
  log_tail
  exit 1
fi
promo_capture PQ_ARN_1 "PQ_ARN_1 (promo_queue_arn)" promo_queue_arn "${PQ_NAME}"
if [ "${PQ_ARN_1##*:}" != "${PQ_NAME}" ]; then
  echo "FAIL: premise: PromoQueue's live ARN does not end with the secret's pqueue value" >&2
  exit 1
fi
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PH_PARAM_NAME}" promo_param_value "${SDIN_PH_PARAM_NAME}"
if [ "${PROMO_GOT}" != "${PQ_ARN_1}" ]; then
  echo "FAIL: premise: PromoReader's SSM value is not PromoQueue's ARN after the settle deploy" >&2
  exit 1
fi
promo_capture PQ_ARN_RECORDED "PQ_ARN_RECORDED (state_attribute)" state_attribute PromoQueue Arn
case "${PQ_ARN_RECORDED}" in
  arn:*"${PQ_TOKEN}") ;;
  *) echo "FAIL: premise: PromoQueue's recorded Arn does not end with its pqueue {{resolve: token" >&2; exit 1 ;;
esac
# PREMISE (vacuity): the reader recorded the version it READ, and the queue
# holds it, so nothing is promoted yet.
promo_capture PH_READ_1 "PH_READ_1 (promo_versions)" promo_versions "${STATE_KEY}" PromoReader "${PQ_TOKEN}" readVersions
promo_capture PH_UP_1 "PH_UP_1 (promo_versions)" promo_versions "${STATE_KEY}" PromoQueue "${PQ_TOKEN}" versions
promo_capture PROMO_VERDICT "the promo_subset verdict" promo_subset "${PH_READ_1}" "${PH_UP_1}"
if [ "${PROMO_VERDICT}" != "true" ]; then
  echo "FAIL: premise: PromoReader's record holds no readVersions for the pqueue token within PromoQueue's versions (read ${PH_READ_1}, queue ${PH_UP_1}): state schema v12's read provenance is not recorded, so nothing below can be promoted" >&2
  exit 1
fi
echo "    OK: PromoReader recorded the queue version it read"
# Rotate pqueue to a `.fifo` name and flip the queue to FIFO: a create-only
# change, so it is REPLACED under the rotated name, and the reader's update
# then fails on its AllowedPattern. --no-rollback leaves that state.
PQ_CUR="${PQ_NAME_2}"
promo_put_secret
PROMO_ENV+=(SDIN_PH_FIFO=true)
promo_deploy --no-rollback SDIN_PH_FAULT=true
promo_assert_none_sent "step 5h fault (after the pqueue rotation)" PromoReader
if [ "${PROMO_RC}" -eq 0 ]; then
  echo "FAIL: premise: the step 5h fault deploy exited 0 (SSM accepted PromoReader's value against its AllowedPattern, so nothing was interrupted)" >&2
  log_tail
  exit 1
fi
if ! promo_log_has "PromoQueue" "(AWS::SQS::Queue)" "replaced"; then
  echo "FAIL: premise: the step 5h fault deploy has no 'PromoQueue (AWS::SQS::Queue) replaced' line" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "Failed to update SSM parameter PromoReader" "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the step 5h fault deploy has no 'Failed to update SSM parameter PromoReader' line (the deploy failed elsewhere, or the wording drifted)" >&2
  log_tail
  exit 1
fi
promo_assert_masked "step 5h fault deploy" PQ_NAME PQ_NAME_2
promo_wait_queue_gone "the replaced PromoQueue" "${PQ_NAME}"
promo_capture PQ_ARN_2 "PQ_ARN_2 (promo_queue_arn)" promo_queue_arn "${PQ_NAME_2}"
if [ "${PQ_ARN_2##*:}" != "${PQ_NAME_2}" ]; then
  echo "FAIL: premise: the replacement PromoQueue's live ARN does not end with the rotated pqueue value" >&2
  exit 1
fi
# PREMISES (vacuity), each one a reason the pre-fix diff calls the reader
# NO_CHANGE: the queue's recorded ARN is the SAME string as before (its
# template spelling did not change); the reader's record still holds the
# version it read; the queue's record no longer holds it; and AWS still holds
# the deleted queue's ARN in the reader.
promo_capture PROMO_GOT "PromoQueue's recorded Arn" state_attribute PromoQueue Arn
expect_eq "premise: PromoQueue's recorded Arn after its replacement (the same reference spelling)" \
  "${PQ_ARN_RECORDED}" "${PROMO_GOT}"
promo_capture PH_READ_2 "PH_READ_2 (promo_versions)" promo_versions "${STATE_KEY}" PromoReader "${PQ_TOKEN}" readVersions
promo_capture PH_UP_2 "PH_UP_2 (promo_versions)" promo_versions "${STATE_KEY}" PromoQueue "${PQ_TOKEN}" versions
expect_eq "premise: PromoReader's recorded readVersions after its failed update (unchanged)" "${PH_READ_1}" "${PH_READ_2}"
promo_capture PROMO_VERDICT "the promo_moved verdict" promo_moved "${PH_READ_2}" "${PH_UP_2}"
if [ "${PROMO_VERDICT}" != "true" ]; then
  echo "FAIL: premise: the replaced PromoQueue's record still holds the version PromoReader read (read ${PH_READ_2}, queue ${PH_UP_2}), so no promotion is expected" >&2
  exit 1
fi
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PH_PARAM_NAME}" promo_param_value "${SDIN_PH_PARAM_NAME}"
if [ "${PROMO_GOT}" != "${PQ_ARN_1}" ]; then
  echo "FAIL: premise: PromoReader's SSM value is not the deleted queue's ARN after the failed deploy (the interruption did not leave it stale)" >&2
  exit 1
fi
echo "    OK: the interrupted deploy replaced PromoQueue and left PromoReader on the deleted queue's ARN"
# The fault cleared: `cdkd diff` must name the reason. Its verdict is kept and
# asserted AFTER the redeploy's red line, so a pre-fix binary fails on the
# live value, the symptom.
set +e
env "${PROMO_ENV[@]}" node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${DEPLOY_LOG}" 2>&1
PH_DIFF_RC=$?
set -e
PH_DIFF_LABELLED=0
if [ "${PH_DIFF_RC}" -eq 0 ] && promo_diff_labelled PromoReader Value; then PH_DIFF_LABELLED=1; fi
promo_assert_masked "step 5h cdkd diff" PQ_NAME PQ_NAME_2
promo_deploy
promo_expect_deployed "step 5h redeploy"
# LOAD-BEARING (the red line): the reader was sent the replacement's ARN.
promo_capture PH_LIVE "PH_LIVE (promo_param_value)" promo_param_value "${SDIN_PH_PARAM_NAME}"
if [ "${PH_LIVE}" != "${PQ_ARN_2}" ]; then
  if [ "${PH_LIVE}" = "${PQ_ARN_1}" ]; then PH_HELD="the deleted queue's ARN"; else PH_HELD="neither queue's ARN"; fi
  echo "FAIL: reader NO_CHANGE: PromoReader's SSM value is ${PH_HELD} after the redeploy, not the replacement PromoQueue's (go-to-k/cdkd#4852)" >&2
  log_tail
  exit 1
fi
if [ "${PH_DIFF_LABELLED}" != "1" ]; then
  echo "FAIL: cdkd diff (exit ${PH_DIFF_RC}) did not label PromoReader's Value '[read value moved upstream]' before the redeploy (go-to-k/cdkd#4852)" >&2
  exit 1
fi
if ! grep -qF -- "PromoReader is sent: Value read a secret-derived value at a newer version than PromoReader was deployed with" "${DEPLOY_LOG}"; then
  echo "FAIL: the step 5h redeploy has no 'PromoReader is sent: Value read a secret-derived value ...' info line (go-to-k/cdkd#4852 decision 5, or the wording drifted)" >&2
  log_tail
  exit 1
fi
promo_assert_masked "step 5h redeploy" PQ_NAME PQ_NAME_2
echo "    OK: the interrupted reader was promoted and sent the replacement queue's ARN"
promo_assert_settled "step 5h" "PromoReader|(AWS::SSM::Parameter)"

echo "==> Step 5i: a nested child reader left on a replaced queue is sent through its row (go-to-k/cdkd#4852)"
NQ_TOKEN="$(promo_token nqueue)"
PROMO_ENV+=(SDIN_PI=true)
promo_deploy
promo_expect_deployed "step 5i create"
PROMO_ENV+=(SDIN_PI_SETTLE=true)
promo_deploy
promo_expect_deployed "step 5i settle"
if ! promo_log_has "PromoChild" "(AWS::CloudFormation::Stack)" "updated"; then
  echo "FAIL: premise: the step 5i settle deploy has no 'PromoChild (AWS::CloudFormation::Stack) updated' line (the row was not written, or the wording drifted)" >&2
  log_tail
  exit 1
fi
promo_capture NQ_ARN_1 "NQ_ARN_1 (promo_queue_arn)" promo_queue_arn "${NQ_NAME}"
if [ "${NQ_ARN_1##*:}" != "${NQ_NAME}" ]; then
  echo "FAIL: premise: NestQueue's live ARN does not end with the secret's nqueue value" >&2
  exit 1
fi
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PI_PARAM_NAME}" promo_param_value "${SDIN_PI_PARAM_NAME}"
if [ "${PROMO_GOT}" != "${NQ_ARN_1}" ]; then
  echo "FAIL: premise: PromoChildReader's SSM value is not NestQueue's ARN after the settle deploy" >&2
  exit 1
fi
promo_capture NQ_ARN_RECORDED "NQ_ARN_RECORDED (state_attribute)" state_attribute NestQueue Arn
case "${NQ_ARN_RECORDED}" in
  arn:*"${NQ_TOKEN}") ;;
  *) echo "FAIL: premise: NestQueue's recorded Arn does not end with its nqueue {{resolve: token" >&2; exit 1 ;;
esac
# PREMISE (vacuity): the row and the child reader each recorded the version
# they read, and NestQueue holds it.
promo_capture PI_ROW_READ_1 "PI_ROW_READ_1 (promo_versions)" promo_versions "${STATE_KEY}" PromoChild "${NQ_TOKEN}" readVersions
promo_capture PI_CHILD_READ_1 "PI_CHILD_READ_1 (promo_versions)" promo_versions "${PROMO_CHILD_STATE_KEY}" PromoChildReader "${NQ_TOKEN}" readVersions
promo_capture PI_UP_1 "PI_UP_1 (promo_versions)" promo_versions "${STATE_KEY}" NestQueue "${NQ_TOKEN}" versions
for pair in "PromoChild|${PI_ROW_READ_1}" "PromoChildReader|${PI_CHILD_READ_1}"; do
  promo_capture PROMO_VERDICT "the promo_subset verdict" promo_subset "${pair#*|}" "${PI_UP_1}"
  if [ "${PROMO_VERDICT}" != "true" ]; then
    echo "FAIL: premise: ${pair%%|*}'s record holds no readVersions for the nqueue token within NestQueue's versions (read ${pair#*|}, queue ${PI_UP_1})" >&2
    exit 1
  fi
done
echo "    OK: the row and the child reader recorded the queue version they read"
NQ_CUR="${NQ_NAME_2}"
promo_put_secret
PROMO_ENV+=(SDIN_PI_FIFO=true)
promo_deploy --no-rollback SDIN_PI_FAULT=true
promo_assert_none_sent "step 5i fault (after the nqueue rotation)" PromoChild PromoChildReader
if [ "${PROMO_RC}" -eq 0 ]; then
  echo "FAIL: premise: the step 5i fault deploy exited 0 (SSM accepted PromoChildReader's value against its AllowedPattern, so nothing was interrupted)" >&2
  log_tail
  exit 1
fi
if ! promo_log_has "NestQueue" "(AWS::SQS::Queue)" "replaced"; then
  echo "FAIL: premise: the step 5i fault deploy has no 'NestQueue (AWS::SQS::Queue) replaced' line" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "Failed to update SSM parameter PromoChildReader" "${DEPLOY_LOG}"; then
  echo "FAIL: premise: the step 5i fault deploy has no 'Failed to update SSM parameter PromoChildReader' line (the deploy failed elsewhere, or the wording drifted)" >&2
  log_tail
  exit 1
fi
promo_assert_masked "step 5i fault deploy" NQ_NAME NQ_NAME_2
promo_wait_queue_gone "the replaced NestQueue" "${NQ_NAME}"
promo_capture NQ_ARN_2 "NQ_ARN_2 (promo_queue_arn)" promo_queue_arn "${NQ_NAME_2}"
if [ "${NQ_ARN_2##*:}" != "${NQ_NAME_2}" ]; then
  echo "FAIL: premise: the replacement NestQueue's live ARN does not end with the rotated nqueue value" >&2
  exit 1
fi
promo_capture PROMO_GOT "NestQueue's recorded Arn" state_attribute NestQueue Arn
expect_eq "premise: NestQueue's recorded Arn after its replacement (the same reference spelling)" \
  "${NQ_ARN_RECORDED}" "${PROMO_GOT}"
promo_capture PI_ROW_READ_2 "PI_ROW_READ_2 (promo_versions)" promo_versions "${STATE_KEY}" PromoChild "${NQ_TOKEN}" readVersions
promo_capture PI_CHILD_READ_2 "PI_CHILD_READ_2 (promo_versions)" promo_versions "${PROMO_CHILD_STATE_KEY}" PromoChildReader "${NQ_TOKEN}" readVersions
promo_capture PI_UP_2 "PI_UP_2 (promo_versions)" promo_versions "${STATE_KEY}" NestQueue "${NQ_TOKEN}" versions
expect_eq "premise: PromoChild's recorded readVersions after the failed child (unchanged)" "${PI_ROW_READ_1}" "${PI_ROW_READ_2}"
expect_eq "premise: PromoChildReader's recorded readVersions after its failed update (unchanged)" "${PI_CHILD_READ_1}" "${PI_CHILD_READ_2}"
promo_capture PROMO_VERDICT "the promo_moved verdict" promo_moved "${PI_ROW_READ_2}" "${PI_UP_2}"
if [ "${PROMO_VERDICT}" != "true" ]; then
  echo "FAIL: premise: the replaced NestQueue's record still holds the version PromoChild read (read ${PI_ROW_READ_2}, queue ${PI_UP_2}), so no promotion is expected" >&2
  exit 1
fi
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PI_PARAM_NAME}" promo_param_value "${SDIN_PI_PARAM_NAME}"
if [ "${PROMO_GOT}" != "${NQ_ARN_1}" ]; then
  echo "FAIL: premise: PromoChildReader's SSM value is not the deleted queue's ARN after the failed deploy (the interruption did not leave it stale)" >&2
  exit 1
fi
echo "    OK: the interrupted deploy replaced NestQueue and left the row and its child reader on the deleted queue's ARN"
set +e
env "${PROMO_ENV[@]}" node "${LOCAL_DIST}" diff "${STACK}" --recursive \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${DEPLOY_LOG}" 2>&1
PI_DIFF_RC=$?
set -e
PI_DIFF_ROW=0
PI_DIFF_CHILD=0
if [ "${PI_DIFF_RC}" -eq 0 ] && promo_diff_labelled PromoChild Parameters; then PI_DIFF_ROW=1; fi
if [ "${PI_DIFF_RC}" -eq 0 ] && promo_diff_labelled PromoChildReader Value; then PI_DIFF_CHILD=1; fi
promo_assert_masked "step 5i cdkd diff --recursive" NQ_NAME NQ_NAME_2
promo_deploy
promo_expect_deployed "step 5i redeploy"
# LOAD-BEARING (the red line): the child reader holds the replacement's ARN.
promo_capture PI_LIVE "PI_LIVE (promo_param_value)" promo_param_value "${SDIN_PI_PARAM_NAME}"
if [ "${PI_LIVE}" != "${NQ_ARN_2}" ]; then
  if [ "${PI_LIVE}" = "${NQ_ARN_1}" ]; then PI_HELD="the deleted queue's ARN"; else PI_HELD="neither queue's ARN"; fi
  echo "FAIL: child reader NO_CHANGE: PromoChildReader holds ${PI_HELD} after the redeploy, not the replacement NestQueue's (go-to-k/cdkd#4852)" >&2
  log_tail
  exit 1
fi
if [ "${PI_DIFF_ROW}" != "1" ] || [ "${PI_DIFF_CHILD}" != "1" ]; then
  echo "FAIL: cdkd diff --recursive (exit ${PI_DIFF_RC}) did not label both PromoChild's Parameters (${PI_DIFF_ROW}) and PromoChildReader's Value (${PI_DIFF_CHILD}) '[read value moved upstream]' before the redeploy (go-to-k/cdkd#4852)" >&2
  exit 1
fi
if ! promo_log_has "PromoChild" "(AWS::CloudFormation::Stack)" "updated"; then
  echo "FAIL: the step 5i redeploy has no 'PromoChild (AWS::CloudFormation::Stack) updated' line: the row was not sent (go-to-k/cdkd#4852)" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "PromoChildReader is sent: Value read a secret-derived value at a newer version than PromoChildReader was deployed with" "${DEPLOY_LOG}"; then
  echo "FAIL: the step 5i redeploy has no 'PromoChildReader is sent: Value read a secret-derived value ...' info line (go-to-k/cdkd#4852 decision 5, or the wording drifted)" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "PromoChild is sent: Parameters read a secret-derived value at a newer version than PromoChild was deployed with" "${DEPLOY_LOG}"; then
  echo "    NOTE: the step 5i redeploy sent PromoChild without its own 'is sent' info line (the row's skip term did not name the read; the child reader's line above shows it was sent)"
fi
promo_assert_masked "step 5i redeploy" NQ_NAME NQ_NAME_2
echo "    OK: the row and its child reader were promoted and the child holds the replacement queue's ARN"
promo_assert_settled "step 5i" "PromoChild|(AWS::CloudFormation::Stack)" "PromoChildReader|(AWS::SSM::Parameter)"

echo "==> Step 5j: a reader of a producer updated in place in an EARLIER run is sent (go-to-k/cdkd#4852)"
PJ_TOKEN="$(promo_token pjvalue)"
PROMO_ENV+=(SDIN_PJ=true)
promo_deploy
promo_expect_deployed "step 5j create"
PROMO_ENV+=(SDIN_PJ_SETTLE=true)
promo_deploy
promo_expect_deployed "step 5j settle"
if ! promo_log_has "PromoValueReader" "(AWS::SSM::Parameter)" "updated"; then
  echo "FAIL: premise: the step 5j settle deploy has no 'PromoValueReader (AWS::SSM::Parameter) updated' line (the reader was not written, or the wording drifted)" >&2
  log_tail
  exit 1
fi
# Compared, never printed: these are the secret's values.
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PJ_READER_NAME}" promo_param_value "${SDIN_PJ_READER_NAME}"
if [ "${PROMO_GOT}" != "${PJ_VALUE_1}" ]; then
  echo "FAIL: premise: PromoValueReader's SSM value is not the secret's pjvalue after the settle deploy" >&2
  exit 1
fi
promo_capture PJ_READ_1 "PJ_READ_1 (promo_versions)" promo_versions "${STATE_KEY}" PromoValueReader "${PJ_TOKEN}" readVersions
promo_capture PJ_UP_1 "PJ_UP_1 (promo_versions)" promo_versions "${STATE_KEY}" PromoValueProducer "${PJ_TOKEN}" versions
promo_capture PROMO_VERDICT "the promo_subset verdict" promo_subset "${PJ_READ_1}" "${PJ_UP_1}"
if [ "${PROMO_VERDICT}" != "true" ]; then
  echo "FAIL: premise: PromoValueReader's record holds no readVersions for the pjvalue token within PromoValueProducer's versions (read ${PJ_READ_1}, producer ${PJ_UP_1})" >&2
  exit 1
fi
echo "    OK: PromoValueReader recorded the producer version it read"
# Rotate pjvalue, then edit the producer's Description only: an in-place
# update, which resolves its spelled Value at the new version. The reader's
# template and record are unchanged, so this run leaves it NO_CHANGE.
PJ_CUR="${PJ_VALUE_2}"
promo_put_secret
PROMO_ENV+=(SDIN_PJ_EDIT=true)
promo_deploy
promo_expect_deployed "step 5j producer edit"
promo_assert_none_sent "step 5j producer edit (after the pjvalue rotation)"
if ! promo_log_has "PromoValueProducer" "(AWS::SSM::Parameter)" "updated"; then
  echo "FAIL: premise: the step 5j producer-edit deploy has no 'PromoValueProducer (AWS::SSM::Parameter) updated' line" >&2
  log_tail
  exit 1
fi
# PREMISE: the run under test is the NEXT one. The line format is the one just
# asserted present for the producer, so this absence is not vacuous.
if promo_log_has "PromoValueReader" "(AWS::SSM::Parameter)" "updated"; then
  echo "FAIL: premise: the step 5j producer-edit deploy also updated PromoValueReader, so the earlier-run case is not exercised (the in-place attribute pass promoted it in the same run)" >&2
  log_tail
  exit 1
fi
promo_assert_masked "step 5j producer-edit deploy" PJ_VALUE_1 PJ_VALUE_2
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PJ_PRODUCER_NAME}" promo_param_value "${SDIN_PJ_PRODUCER_NAME}"
if [ "${PROMO_GOT}" != "${PJ_VALUE_2}" ]; then
  echo "FAIL: premise: PromoValueProducer's SSM value is not the rotated pjvalue after its in-place update (the update did not resolve its Value at the new version)" >&2
  exit 1
fi
promo_capture PROMO_GOT "the live value of SSM parameter ${SDIN_PJ_READER_NAME}" promo_param_value "${SDIN_PJ_READER_NAME}"
if [ "${PROMO_GOT}" != "${PJ_VALUE_1}" ]; then
  echo "FAIL: premise: PromoValueReader's SSM value is not the pre-rotation pjvalue after the producer edit (it was not left stale)" >&2
  exit 1
fi
promo_capture PJ_READ_2 "PJ_READ_2 (promo_versions)" promo_versions "${STATE_KEY}" PromoValueReader "${PJ_TOKEN}" readVersions
promo_capture PJ_UP_2 "PJ_UP_2 (promo_versions)" promo_versions "${STATE_KEY}" PromoValueProducer "${PJ_TOKEN}" versions
promo_capture PROMO_VERDICT "the promo_moved verdict" promo_moved "${PJ_READ_2}" "${PJ_UP_2}"
if [ "${PROMO_VERDICT}" != "true" ]; then
  echo "FAIL: premise: PromoValueProducer's record still holds the version PromoValueReader read (read ${PJ_READ_2}, producer ${PJ_UP_2}), so no promotion is expected" >&2
  exit 1
fi
echo "    OK: the producer was updated in place at the rotated version and its reader left stale"
# The same template again.
promo_deploy
promo_expect_deployed "step 5j unchanged redeploy"
# LOAD-BEARING (the red line): compared, never printed.
promo_capture PJ_LIVE "PJ_LIVE (promo_param_value)" promo_param_value "${SDIN_PJ_READER_NAME}"
if [ "${PJ_LIVE}" != "${PJ_VALUE_2}" ]; then
  if [ "${PJ_LIVE}" = "${PJ_VALUE_1}" ]; then PJ_HELD="the pre-rotation value"; else PJ_HELD="neither pjvalue"; fi
  echo "FAIL: reader NO_CHANGE: PromoValueReader holds ${PJ_HELD} after the unchanged redeploy, not the value its producer holds now (go-to-k/cdkd#4852)" >&2
  log_tail
  exit 1
fi
if ! grep -qF -- "PromoValueReader is sent: Value read a secret-derived value at a newer version than PromoValueReader was deployed with" "${DEPLOY_LOG}"; then
  echo "FAIL: the step 5j redeploy has no 'PromoValueReader is sent: Value read a secret-derived value ...' info line (go-to-k/cdkd#4852 decision 5, or the wording drifted)" >&2
  log_tail
  exit 1
fi
promo_assert_masked "step 5j redeploy" PJ_VALUE_1 PJ_VALUE_2
echo "    OK: the reader of a producer updated in an earlier run was promoted and holds the rotated value"
promo_assert_settled "step 5j" "PromoValueReader|(AWS::SSM::Parameter)"

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
for needle_var in QUEUE_NAME POLICY_PATH AQ_QUEUE_NAME AQ_QUEUE_NAME_2; do
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

# SQS refuses to re-create a queue under a name deleted less than 60 seconds
# ago (QueueDeletedRecently). SecretRollbackQueue's name is fixed for the run,
# and each step before a re-deploy deletes it, so wait the cooldown out rather
# than ride the provider's name-cooldown retry (whose failure would surface as
# a missing-repository premise, since the repository depends on the queue).
# A no-op before the first deploy (QUEUE_DELETED_AT unset).
wait_queue_name_cooldown() {
  if [ -n "${QUEUE_DELETED_AT:-}" ]; then
    local left=$((QUEUE_DELETED_AT + 65 - $(date +%s)))
    if [ "${left}" -gt 0 ]; then sleep "${left}"; fi
  fi
}

# Deploys the orphan stack, which must FAIL after AWS made the orphan, and
# checks the journal records it as a proven orphan (no state record holds it).
# `orphan_deploy_failing` makes the ECR repository (steps 6c, 6d's premise);
# `orphan_deploy_failing stream` makes the Kinesis stream (step 6b).
orphan_deploy_failing() {
  local kind="${1:-repo}" lid="SecretOrphanRepo"
  [ "${kind}" = "stream" ] && lid="SecretOrphanStream"
  ORPHAN_DEPLOYED=1
  wait_queue_name_cooldown
  set +e
  if [ "${kind}" = "stream" ]; then
    SDIN_ORPHAN_STREAM=true node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes --no-rollback > "${ORPHAN_LOG}" 2>&1
  else
    node "${LOCAL_DIST}" deploy "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
      --yes --no-rollback > "${ORPHAN_LOG}" 2>&1
  fi
  ORPHAN_DEPLOY_RC=$?
  set -e
  if [ "${ORPHAN_DEPLOY_RC}" -eq 0 ]; then
    echo "FAIL: premise: the orphan stack's deploy exited 0; AWS accepted the ${kind}'s invalid follow-up" >&2
    tail -40 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  # PREMISE: AWS made the orphan, and the journal records it as a proven
  # orphan (no state record holds it).
  if [ "${kind}" = "stream" ]; then
    if ! aws kinesis describe-stream-summary --region "${REGION}" --stream-name "${STREAM_NAME}" >/dev/null; then
      echo "FAIL: premise: the failed deploy left no stream ${STREAM_NAME} (Kinesis refused the create itself?)" >&2
      tail -40 "${ORPHAN_LOG}" >&2
      exit 1
    fi
  elif ! aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}" >/dev/null; then
    echo "FAIL: premise: the failed deploy left no repository ${REPO_NAME} (ECR refused the create itself?)" >&2
    tail -40 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  # `|| echo`: a missing or unparseable journal must reach the FAIL below, not
  # end the run at the assignment with no diagnostic.
  ORPHAN_PROVEN="$(aws s3 cp "s3://${STATE_BUCKET}/${ORPHAN_JOURNAL_KEY}" - \
    | jq -r --arg lid "${lid}" '[.segments[].failedOperations[]? | select(.logicalId == $lid and .physicalIdRecoveredFromError == true)] | length' 2>&1 \
    || echo "unreadable journal")"
  if [ "${ORPHAN_PROVEN}" != "1" ]; then
    echo "FAIL: premise: the journal holds ${ORPHAN_PROVEN} proven ${lid} orphan(s), expected 1" >&2
    tail -40 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  echo "    OK: the failed deploy journaled the ${kind} as a proven orphan"
}

# Asserts a rollback log deleted SecretRollbackQueue (the orphan stack's
# completed CREATE) without naming it (go-to-k/cdkd#3869), and that the queue
# is gone. SQS may answer for a deleted queue name for up to 60 seconds.
assert_rollback_queue_deleted() { # usage: assert_rollback_queue_deleted <which>
  if ! grep -qF -- "Deleting SQS queue SecretRollbackQueue: " "${ORPHAN_LOG}"; then
    echo "FAIL: premise: the $1 log has no 'Deleting SQS queue SecretRollbackQueue: ' line (the completed CREATE was not reverted, the --verbose debug stream is missing, or the wording drifted)" >&2
    tail -60 "${ORPHAN_LOG}" >&2
    exit 1
  fi
  if grep -qF -- "${RB_QUEUE_NAME}" "${ORPHAN_LOG}"; then
    HIT_LINES="$(grep -nF -- "${RB_QUEUE_NAME}" "${ORPHAN_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
    echo "FAIL: the $1 log names the secret-derived queue name of the completed CREATE in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
    exit 1
  fi
  local gone=0 attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
    if gone_probe aws sqs get-queue-url --region "${REGION}" --queue-name "${RB_QUEUE_NAME}"; then
      gone=1
      break
    fi
    [ "${attempt}" = 14 ] || sleep 5
  done
  if [ "${gone}" != "1" ]; then
    echo "FAIL: queue ${RB_QUEUE_NAME} still exists 65s after the $1" >&2
    exit 1
  fi
  QUEUE_DELETED_AT="$(date +%s)"
}

echo "==> Step 6b: a failed-CREATE orphan named from the secret, deleted by a destroy from the journal"
# go-to-k/cdkd#3869: the journal-path delete runs under the batch's printing
# bag, so the provider's DELETE line must not name the stream. A Kinesis
# stream journals its creation identity, so the destroy proves it is the one
# the failed deploy made and deletes it (go-to-k/cdkd#4658); step 6c keeps the
# ECR repository, which journals none.
orphan_deploy_failing stream
set +e
SDIN_ORPHAN_STREAM=true node "${LOCAL_DIST}" destroy "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force --verbose > "${ORPHAN_LOG}" 2>&1
ORPHAN_DESTROY_RC=$?
set -e
if [ "${ORPHAN_DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: the orphan stack's destroy exited ${ORPHAN_DESTROY_RC}" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
# PREMISE: the provider's delete line for the orphan is in the log.
if ! grep -qF -- "Deleting Kinesis stream SecretOrphanStream: " "${ORPHAN_LOG}"; then
  echo "FAIL: premise: the destroy log has no 'Deleting Kinesis stream SecretOrphanStream: ' line (the --verbose debug stream is missing, the orphan was not deleted, or the wording drifted)" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
if grep -qF -- "${STREAM_NAME}" "${ORPHAN_LOG}"; then
  HIT_LINES="$(grep -nF -- "${STREAM_NAME}" "${ORPHAN_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the orphan stack's destroy log names the secret-derived stream name in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
# DeleteStream is asynchronous: the stream sits in DELETING first.
for _i in $(seq 1 30); do
  gone_probe aws kinesis describe-stream-summary --region "${REGION}" --stream-name "${STREAM_NAME}" && break
  sleep 5
done
assert_gone "orphan stream ${STREAM_NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --region "${REGION}" --stream-name "${STREAM_NAME}"
for key in "${ORPHAN_STATE_KEY}" "${ORPHAN_JOURNAL_KEY}"; do
  assert_gone "${key} still exists after the orphan stack's destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
# The destroy deleted SecretRollbackQueue as a state resource.
QUEUE_DELETED_AT="$(date +%s)"
echo "    OK: the journaled orphan was deleted, and the destroy log withholds its name"

echo "==> Step 6c: the same orphan, kept by a plain cdkd rollback from the journal"
# go-to-k/cdkd#3869: a plain rollback replays the journal's proven orphans
# through its own failed-op replay, which ran under no printing bag. The stack
# is gone after step 6b, so this deploy is an initial one and the rollback
# removes state.json and the journal with it. go-to-k/cdkd#4658: it keeps the
# unproven repository (exit 2) and warns naming it, masked; the fixture
# deletes it by hand.
orphan_deploy_failing
set +e
node "${LOCAL_DIST}" rollback "${ORPHAN_STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --force --verbose > "${ORPHAN_LOG}" 2>&1
ORPHAN_ROLLBACK_RC=$?
set -e
if [ "${ORPHAN_ROLLBACK_RC}" -ne 2 ]; then
  echo "FAIL: the orphan stack's rollback exited ${ORPHAN_ROLLBACK_RC} (expected 2: the unproven repository is kept)" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
# PREMISE: the warning that keeps the orphan is in the log.
if ! grep -q -- "Skipping failed CREATE of SecretOrphanRepo.*the journal recorded no identity for it" "${ORPHAN_LOG}"; then
  echo "FAIL: premise: the rollback log has no warning keeping SecretOrphanRepo (the orphan was deleted, or the wording drifted)" >&2
  tail -60 "${ORPHAN_LOG}" >&2
  exit 1
fi
if grep -qF -- "${REPO_NAME}" "${ORPHAN_LOG}"; then
  HIT_LINES="$(grep -nF -- "${REPO_NAME}" "${ORPHAN_LOG}" | cut -d: -f1 | paste -sd ' ' -)"
  echo "FAIL: the orphan stack's rollback log names the secret-derived repository name in plaintext on log line(s) ${HIT_LINES} (go-to-k/cdkd#3869)" >&2
  exit 1
fi
if ! aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}" >/dev/null; then
  echo "FAIL: orphan repository ${REPO_NAME} is gone after the rollback that warned it was kept" >&2
  exit 1
fi
for key in "${ORPHAN_STATE_KEY}" "${ORPHAN_JOURNAL_KEY}"; do
  assert_gone "${key} still exists after the orphan stack's initial-deploy rollback" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
assert_rollback_queue_deleted rollback
aws ecr delete-repository --region "${REGION}" --repository-name "${REPO_NAME}" --force >/dev/null
assert_gone "orphan repository ${REPO_NAME} still exists after the fixture deleted it" \
  aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO_NAME}"
echo "    OK: the rollback kept the unproven orphan, deleted the completed CREATE, and its log withholds both names"

echo "==> Step 6d: the same failed deploy WITHOUT --no-rollback: the automatic rollback deletes the orphan"
# go-to-k/cdkd#3869: the deploy engine's own rollback replays the orphan
# through its failed-op replay, which ran under no printing bag. This is also
# the first check of the failing deploy's OWN lines (create, failure summary):
# no earlier step greps that log, so read HIT_LINES to tell which phase leaked.
# State and journal are not asserted gone: the automatic rollback never deletes
# state.json, and cleanup / step 8 sweep the prefix.
wait_queue_name_cooldown
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
assert_rollback_queue_deleted "automatic rollback"
echo "    OK: the automatic rollback deleted the orphan and the completed CREATE, and the deploy log withholds both names"

echo "==> Step 7: remove the secret; assert 0 orphans"
aws secretsmanager delete-secret --region "${REGION}" --secret-id "${SDIN_SECRET_NAME}" \
  --force-delete-without-recovery >/dev/null
SEEDED_SECRET=0

assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "QueueReaderChild's state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
assert_gone "QueueReaderChild's SSM parameter ${CHILD_PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --region "${REGION}" --name "${CHILD_PARAM_NAME}"
assert_gone "AssembledQueueReader's SSM parameter ${AQ_PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --region "${REGION}" --name "${AQ_PARAM_NAME}"
assert_gone "AssembledNameQueue still exists after destroy" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME}"
assert_gone "AssembledNameQueue's replacement still exists after destroy" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${AQ_QUEUE_NAME_2}"
assert_gone "AqTopic still exists after destroy" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${AQ_TOPIC_ARN}"
# go-to-k/cdkd#4852 (steps 5h-5j): the replacement queues, the readers, the
# producer and the nested PromoChild's state. The replaced queues were
# asserted gone when they were replaced.
assert_gone "PromoChild's state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PROMO_CHILD_STATE_KEY}"
for promo_param in "${SDIN_PH_PARAM_NAME}" "${SDIN_PI_PARAM_NAME}" "${SDIN_PJ_PRODUCER_NAME}" "${SDIN_PJ_READER_NAME}"; do
  assert_gone "SSM parameter ${promo_param} (go-to-k/cdkd#4852 steps) still exists after destroy" \
    aws ssm get-parameter --region "${REGION}" --name "${promo_param}"
done
assert_gone "PromoQueue's replacement still exists after destroy" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${PQ_NAME_2}"
assert_gone "NestQueue's replacement still exists after destroy" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${NQ_NAME_2}"
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
LEFTOVER_SECRET_GROUP="$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "${LOG_GROUP_NAME}" \
  --query "logGroups[?logGroupName=='${LOG_GROUP_NAME}'].logGroupName" --output text)"
if [ -n "${LEFTOVER_SECRET_GROUP}" ] && [ "${LEFTOVER_SECRET_GROUP}" != "None" ]; then
  echo "FAIL: log group \${LOG_GROUP_NAME} (SecretNamedGroup, and MovingFilter in it) still exists after destroy" >&2
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
echo "    OK: 0 orphans (state, API with both stages, ECS service, cluster and task definition, managed policy, GraphQL API with its data source, queue, both log groups with their metric filters, both schedules with their group, roles and the second target queue)"

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}" "${ORPHAN_LOG}" 2>/dev/null || true

echo "==> Step 8: sweep every object version under both stacks' and the nested child's state prefixes"
# On the SUCCESS path, after the disarm: a sweep living only in `cleanup` never
# runs here, and `noncurrent` would leave the delete marker behind.
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${ORPHAN_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${ORPHAN_PREFIX}" "orphan stack state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "QueueReaderChild state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${PROMO_CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PROMO_CHILD_PREFIX}" "PromoChild state teardown"
echo ""
echo "[verify] PASS - an in-place update of a Stage, an ECS Service, a managed policy, a GraphQL API, a data source, a Cloud Control-routed metric filter and a schedule whose immutable values come from a secret succeeded, in place, and destroy was clean"
