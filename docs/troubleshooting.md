---
title: Troubleshooting
description: "Find a cdkd error message or symptom and get its cause and fix: permissions, locks, state, deploy and destroy failures, assets, and proxies."
---

# cdkd Troubleshooting Guide

Each entry is headed by the message or symptom, then says why it happens and
gives the fix. Search this page for a distinctive part of your error text, or
start from the table under [Start here](#start-here).

## Contents

- [Start here](#start-here)
- [Credentials and permissions](#credentials-and-permissions)
  - ["Access Denied" Error](#access-denied-error)
  - ["not authorized to perform: sts:AssumeRole"](#not-authorized-to-perform-sts-assumerole)
  - [STS cannot report the account](#sts-cannot-report-the-account)
  - ["The state machine IAM Role is not authorized to access the Log Destination"](#the-state-machine-iam-role-is-not-authorized-to-access-the-log-destination)
- [Locks](#locks)
  - ["Failed to acquire lock" Error](#failed-to-acquire-lock-error)
  - [Stale lock after a cancelled CI job](#stale-lock-after-a-cancelled-ci-job)
- [State](#state)
  - ["State has been modified by another process"](#state-has-been-modified-by-another-process)
  - [State File is Corrupted](#state-file-is-corrupted)
  - [State and Resources Don't Match](#state-and-resources-don-t-match)
  - [Cross-region state bucket ("is in a different region", `PermanentRedirect`)](#cross-region-state-bucket-is-in-a-different-region-permanentredirect)
- [Templates cdkd refuses](#templates-cdkd-refuses)
  - [An unsupported resource type](#an-unsupported-resource-type)
  - ["The following resources declare mutually exclusive properties"](#the-following-resources-declare-mutually-exclusive-properties)
  - ["The following resources declare a nested property block without a member it requires"](#the-following-resources-declare-a-nested-property-block-without-a-member-it-requires)
  - ["Properties validation failed": a list where an object is expected, or the reverse](#properties-validation-failed-a-list-where-an-object-is-expected-or-the-reverse)
  - ["The following custom resources pass a secure dynamic reference"](#the-following-custom-resources-pass-a-secure-dynamic-reference)
  - ["OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table](#opentableformatinput-iceberginput-icebergtableinput-cannot-be-deployed-on-a-glue-table)
  - ["SelfManagedKafkaEventSourceConfig.ConsumptionMode cannot be sent by cdkd yet"](#selfmanagedkafkaeventsourceconfig-consumptionmode-cannot-be-sent-by-cdkd-yet)
- [Failures during a deploy](#failures-during-a-deploy)
  - ["Resource already exists" Error](#resource-already-exists-error)
  - [Replacing a resource, and the refusal that guards it](#replacing-a-resource-and-the-refusal-that-guards-it)
  - [Lambda Deployment Fails](#lambda-deployment-fails)
  - [an ACM certificate deploy fails with "did not reach ISSUED status"](#an-acm-certificate-deploy-fails-with-did-not-reach-issued-status)
  - ["Custom resource X: Y resolved to the value of a secret"](#custom-resource-x-y-resolved-to-the-value-of-a-secret)
  - [A changed custom-resource ServiceToken is refused](#a-changed-custom-resource-servicetoken-is-refused)
  - ["Unresolved intrinsic function" Error](#unresolved-intrinsic-function-error)
  - ["Refusing to resolve" a reference whose service cdkd does not resolve](#refusing-to-resolve-a-reference-whose-service-cdkd-does-not-resolve)
  - ["Refusing to resolve" a reference whose name was built from a secret](#refusing-to-resolve-a-reference-whose-name-was-built-from-a-secret)
  - ["Cannot resolve" a GetAtt on a resource an older cdkd deployed](#cannot-resolve-a-getatt-on-a-resource-an-older-cdkd-deployed)
- [Slow deploys, throttling and retries](#slow-deploys-throttling-and-retries)
  - [Deployment is Slow](#deployment-is-slow)
  - [Cloud Control API Rate Limit](#cloud-control-api-rate-limit)
  - [A name is still held by the resource you just deleted](#a-name-is-still-held-by-the-resource-you-just-deleted)
  - ["cdkd stopped waiting for it" — a network outage during a Cloud Control operation](#cdkd-stopped-waiting-for-it-a-network-outage-during-a-cloud-control-operation)
- [A deploy succeeds but AWS is not what the template says](#a-deploy-succeeds-but-aws-is-not-what-the-template-says)
  - [A property you set in the template never reaches AWS](#a-property-you-set-in-the-template-never-reaches-aws)
  - [`cdkd diff` shows `[returning to SDK provider]`](#cdkd-diff-shows-returning-to-sdk-provider)
  - [deleting a Cognito `Policies` sub-key changes nothing on the pool](#deleting-a-cognito-policies-sub-key-changes-nothing-on-the-pool)
- [Assets](#assets)
  - ["Asset publishing failed"](#asset-publishing-failed)
- [Destroying a stack](#destroying-a-stack)
  - ["bucket is not empty" / "still contains images" on destroy](#bucket-is-not-empty-still-contains-images-on-destroy)
  - ["has DeletionPolicy: Snapshot, but ..." refusal on delete](#has-deletionpolicy-snapshot-but-refusal-on-delete)
  - ["Backing Lambda for custom resource X no longer exists" on destroy](#backing-lambda-for-custom-resource-x-no-longer-exists-on-destroy)
  - [destroy reports `N skipped` and exits 2](#destroy-reports-n-skipped-and-exits-2)
  - [Known Leftover: EFS Automatic Backups](#known-leftover-efs-automatic-backups)
  - [Known Leftover: FSx Final Backups](#known-leftover-fsx-final-backups)
- [After a failed or interrupted deploy](#after-a-failed-or-interrupted-deploy)
  - [Reverting a failed `--no-rollback` / interrupted deploy: `cdkd rollback`](#reverting-a-failed-no-rollback-interrupted-deploy-cdkd-rollback)
  - [Detecting Orphaned Resources](#detecting-orphaned-resources)
  - [Recovering from Orphaned Resources](#recovering-from-orphaned-resources)
- [Possible duplicates after a server error](#possible-duplicates-after-a-server-error)
  - [A warning that a KMS key, Cognito user pool or AppSync API may be an orphan](#a-warning-that-a-kms-key-cognito-user-pool-or-appsync-api-may-be-an-orphan)
  - [A warning that an API Gateway API, authorizer, integration or deployment may be an orphan](#a-warning-that-an-api-gateway-api-authorizer-integration-or-deployment-may-be-an-orphan)
  - [A warning that an EMR cluster, instance fleet or instance group may be an orphan](#a-warning-that-an-emr-cluster-instance-fleet-or-instance-group-may-be-an-orphan)
  - [A warning that a Lambda layer version or event source mapping may be an orphan](#a-warning-that-a-lambda-layer-version-or-event-source-mapping-may-be-an-orphan)
  - [A warning that a DLM lifecycle policy or ECS task definition revision may be an orphan](#a-warning-that-a-dlm-lifecycle-policy-or-ecs-task-definition-revision-may-be-an-orphan)
  - [A warning that an EC2 VPC, subnet, internet gateway or Elastic IP may be an orphan](#a-warning-that-an-ec2-vpc-subnet-internet-gateway-or-elastic-ip-may-be-an-orphan)
  - [`EntityAlreadyExists` on an IAM create after a server error](#entityalreadyexists-on-an-iam-create-after-a-server-error)
  - [An "already exists" on a Lambda, EventBridge bus or ECR create after a server error](#an-already-exists-on-a-lambda-eventbridge-bus-or-ecr-create-after-a-server-error)
  - [`DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for](#distributionalreadyexists-on-a-cloudfront-deploy-and-a-distribution-you-did-not-ask-for)
- [Proxy / Corporate Network](#proxy-corporate-network)
  - ["self-signed certificate in certificate chain" on the very first command](#self-signed-certificate-in-certificate-chain-on-the-very-first-command)
  - [Variables cdkd honours](#variables-cdkd-honours)
  - [`NO_PROXY` matching is EXACT, unlike curl](#no-proxy-matching-is-exact-unlike-curl)
  - [A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`](#a-tls-terminating-proxy-still-needs-node-extra-ca-certs)
  - [The Docker daemon has its own egress](#the-docker-daemon-has-its-own-egress)
  - [Verifying that traffic is routed](#verifying-that-traffic-is-routed)
- [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)
  - [Q: Is a CloudFormation stack created?](#q-is-a-cloudformation-stack-created)
  - [Q: Can I use CloudFormation and cdkd for the same stack?](#q-can-i-use-cloudformation-and-cdkd-for-the-same-stack)
  - [Q: What happens if I delete the state file?](#q-what-happens-if-i-delete-the-state-file)
  - [Q: Is there a rollback feature?](#q-is-there-a-rollback-feature)
  - [Q: Are custom resources supported?](#q-are-custom-resources-supported)
- [Collecting information for a bug report](#collecting-information-for-a-bug-report)
  - [Adjust Log Level](#adjust-log-level)
  - [Check State File](#check-state-file)
  - [Check Execution Plan with Dry Run](#check-execution-plan-with-dry-run)
  - [Check API Calls with AWS CloudTrail](#check-api-calls-with-aws-cloudtrail)
- [Getting help](#getting-help)
- [Related](#related)

## Start here

Most first-week problems are one of these.

| You see | Usual cause | Entry |
| --- | --- | --- |
| `is not authorized to perform`, `AccessDenied` | The identity running cdkd lacks a permission | ["Access Denied" Error](#access-denied-error) |
| `Cannot determine the AWS account id`, `ExpiredToken` | The credentials are missing or expired | [STS cannot report the account](#sts-cannot-report-the-account) |
| `Failed to acquire lock` / `Could not acquire lock` | Another cdkd run holds the stack, or a killed run left its lock | ["Failed to acquire lock" Error](#failed-to-acquire-lock-error) |
| `already exists`, `EntityAlreadyExists`, `ResourceInUseException` | A resource with that name is in AWS but not in cdkd's state | ["Resource already exists" Error](#resource-already-exists-error) |
| `The following resource types are not supported by cdkd` | Neither an SDK provider nor Cloud Control can manage the type | [An unsupported resource type](#an-unsupported-resource-type) |
| `s3:PutObject` denied, `ECR login failed`, `Docker push failed` | Asset storage is missing or the identity cannot write to it | ["Asset publishing failed"](#asset-publishing-failed) |

A deploy error has two lines. The first is cdkd's and names the resource. The
`Caused by:` line is the AWS service's own message, and it is usually the one
to search for:

```text
ProvisioningError: Failed to create resource MyBucket
Caused by: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::my-bucket-name"
```

If a deploy failed partway and you are not sure what state the stack is in,
go to [After a failed or interrupted deploy](#after-a-failed-or-interrupted-deploy).

## Credentials and permissions

### "Access Denied" Error

```
ProvisioningError: Failed to create resource MyBucket
Caused by: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::my-bucket-name"
```

cdkd calls each service API directly, as the identity running the command (or
the role given to `--role-arn`). There is no CloudFormation execution role, so
that identity needs every permission the deploy uses. The `Caused by:` line
names the missing action and the resource.

Grant the permissions in the three groups below, plus `iam:PassRole`.

#### Set A: what every deploy needs

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudControlApi",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateResource",
        "cloudformation:UpdateResource",
        "cloudformation:DeleteResource",
        "cloudformation:GetResource",
        "cloudformation:GetResourceRequestStatus",
        "cloudformation:ListResources"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RegistryAndCrossStackReads",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeType",
        "cloudformation:ListExports",
        "cloudformation:DescribeStacks"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Identity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "StateBucketObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion"
      ],
      "Resource": "arn:aws:s3:::cdkd-state-123456789012/*"
    },
    {
      "Sid": "StateBucketMetadata",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketLocation",
        "s3:GetReplicationConfiguration"
      ],
      "Resource": "arn:aws:s3:::cdkd-state-123456789012"
    }
  ]
}
```

The Cloud Control API's IAM actions carry the `cloudformation:` prefix. There
is no `cloudcontrol:` prefix, so an action spelled `cloudcontrol:*` grants
nothing. Cloud Control supports neither resource-level permissions nor
service-specific condition keys, so its six actions must stay on
`"Resource": "*"`.

#### Set B: the services your template provisions

This set is whatever your stacks contain. A template with a bucket and a queue
needs the `s3:` and `sqs:` actions for those operations on top of Set A. The
Cloud Control API also executes as you, with no service role of its own.
[Supported Resources](supported-resources.md) says which layer handles a type.

#### Set C: permissions the template does not imply

| When | Needs |
| --- | --- |
| The app does a CDK context lookup (`Vpc.fromLookup`, an AMI or hosted-zone lookup) | Read actions at synth time, typically `ec2:DescribeVpcs`, `DescribeSubnets`, `DescribeAvailabilityZones`, `DescribeImages`, `ssm:GetParameter`, `route53:ListHostedZonesByName`, `kms:ListAliases` |
| The template declares a macro (`Transform` / `Fn::Transform`, for example SAM) | `cloudformation:CreateChangeSet`, `DescribeChangeSet`, `GetTemplate` and `DeleteStack` on `cdkd-macro-expand-*` |
| The macro is your own function, not an AWS-managed transform | `lambda:InvokeFunction` on that function |

A denied context lookup fails before any provisioning starts.

#### `iam:PassRole` for roles the template hands to a service

The deploy identity needs `iam:PassRole` for every role the template hands to
a service: a Lambda function's `Role`, ECS task and execution roles, CodeBuild
and EMR service roles, Step Functions, Glue, Firehose, EventBridge targets, RDS
monitoring roles, EC2 instance profiles.

```json
{
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::123456789012:role/MyLambdaRole"
}
```

#### What you lose without `cloudformation:DescribeType`

cdkd reads the CloudFormation registry schema of each resource type on an
ordinary deploy. Without the permission it warns and falls back:

| cdkd uses the schema for | Without the permission |
| --- | --- |
| Deciding that a property change forces a replacement (`deploy`, `diff`) | Uses a bundled schema snapshot, which can lag AWS; for a type with no snapshot a replacement can be misclassified as an in-place update |
| Re-including write-only properties in a Cloud Control update | Write-only properties may be dropped on update (for example `AWS::ECS::Service` `VolumeConfigurations`) |
| `cdkd export`: primary identifiers and the check for types CloudFormation cannot import | Export runs off a fallback table; a non-importable type surfaces later as `ResourceTypes [<T>] are not supported for Import` |

### "not authorized to perform: sts:AssumeRole"

```
AccessDenied: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::210987654321:role/CdkdDeploy
```

cdkd assumes a role only when something asked it to:

| Trigger | What cdkd does with the role |
| --- | --- |
| `--role-arn` or `CDKD_ROLE_ARN` | Assumes it for every AWS call |
| A cross-account `Fn::GetStackOutput` with a `RoleArn` | Assumes it to read the producer stack's state |
| `--assume-role` on a `cdkd local` command | Assumes it to give the locally-run function or task its credentials |

CDK bootstrap roles such as `cdk-hnb659fds-deploy-role-*` do not work here.
cdkd makes raw service API calls instead of routing through CloudFormation, so
a CDK CLI deploy role does not carry what cdkd needs. Adding yourself to a
bootstrap role's trust policy does not fix this error.

::: steps
1. Confirm which role is being assumed

   ```bash
   aws sts get-caller-identity          # who you are before the hop
   echo "${CDKD_ROLE_ARN:-<unset>}"     # what cdkd will try to assume
   ```

2. Add your principal to that role's trust policy

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::123456789012:user/myuser" },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   ```

3. Grant the role the permissions from ["Access Denied" Error](#access-denied-error)

   They go on the assumed role, not on your own principal. Scope Set B to the
   services your stacks use rather than attaching `AdministratorAccess`.
:::

For the cross-account `Fn::GetStackOutput` case the trust policy belongs on the
producer account's role, and it must allow the principal the consumer run
issues calls as. When that run passes `--role-arn`, that principal is the
assumed role, not the profile behind it. See
[Cross-Stack References](cross-stack-references.md).

### STS cannot report the account

```
Cannot determine the AWS account id: STS GetCallerIdentity failed (ExpiredToken. Re-run with --verbose for AWS's own message.). cdkd does not substitute a placeholder account, because AWS::AccountId, AWS::StackId and every ARN built from it would look valid while naming a different account. Fix the AWS credentials (`aws sts get-caller-identity` must succeed), or set AWS_ACCOUNT_ID to this deploy's 12-digit account id, and re-run.
```

The credentials are missing, expired, or cannot call `sts:GetCallerIdentity`.
cdkd resolves `AWS::AccountId` from that call and refuses rather than guess.
The refusal is raised by anything that needs the account: `Ref: AWS::AccountId`,
`AWS::StackId`, a custom resource (its request carries a `StackId`), and an
`Fn::GetAtt` whose value embeds the account.

Fix the credentials and check them:

```bash
aws sts get-caller-identity
```

Where STS cannot be reached at all (an emulated endpoint, a locked-down
network), set `AWS_ACCOUNT_ID` to the deploy's 12-digit account id. cdkd warns
and uses it. A value that is not 12 digits is refused.

Two related behaviours:

- Where cdkd would only record an ARN for a resource that already exists, it
  warns and leaves that attribute out instead of failing the create. The record
  heals on the resource's next update.
- A custom resource's Delete asks STS again for about 17 seconds, and is
  otherwise reported skipped with its record kept.

### "The state machine IAM Role is not authorized to access the Log Destination"

A Step Functions state machine with `LoggingConfiguration` fails to create or
update with:

```text
The state machine IAM Role is not authorized to access the Log Destination
```

AWS emits this sentence for three different problems, and cdkd cannot tell
them apart from the message. It retries for about 48 seconds first, so the
two permanent causes look like a short hang before the error.

| Cause | Fix |
| --- | --- |
| The role's log-delivery grants have not propagated yet | None. cdkd retries this for you |
| The execution role lacks the grants | Add the policy below |
| The account's CloudWatch Logs resource policies are at a quota | See "Resource-policy quotas" below |

#### Missing grants

The role the state machine runs as needs these actions on `"Resource": "*"`.
They do not support resource types, so scoping them to the log group's ARN
produces the same error.

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogDelivery",
    "logs:GetLogDelivery",
    "logs:UpdateLogDelivery",
    "logs:DeleteLogDelivery",
    "logs:ListLogDeliveries",
    "logs:PutResourcePolicy",
    "logs:DescribeResourcePolicies",
    "logs:DescribeLogGroups"
  ],
  "Resource": "*"
}
```

The CDK Step Functions L2 attaches this to the role it creates. If you passed
your own `role:`, check that it carries them. A role imported with
`mutable: false` has the grant silently dropped, and the state machine still
synthesizes with logging enabled.

#### Resource-policy quotas

Step Functions records log delivery in CloudWatch Logs resource policies. A
policy document is limited to 5120 characters, and an account to ten policies
per Region. Either limit produces this error. Inspect both with:

```bash
aws logs describe-resource-policies --region us-east-1
```

- **Size limit**: name the log group with the prefix `/aws/vendedlogs/`, which
  one wildcard entry covers. The name is immutable, so this replaces the log
  group. See the
  [stateful-resource guard](cli-deploy-safety.md#stateful-resource-guard) for
  when cdkd refuses that replacement.
- **Ten-policy limit**: it is account-wide across every service that writes a
  policy. AWS documents consolidating the existing policies.

> [!WARNING]
> There is no per-entry API for these policies. `aws logs put-resource-policy`
> rewrites a whole document and `aws logs delete-resource-policy` removes one
> outright, which revokes log delivery for every identity in it.

## Locks

cdkd takes a per-stack, per-region lock in the state bucket before it writes.
[State Management](state-management.md) describes the lock itself; the entries
below are the fixes.

```text diagram=troubleshooting-lock-held
            ┌──────────────────────────────┐
            │ Lock error names the holder  │
            └───────┬──────────────┬───────┘
                    ▼              ▼
  ┌───────────────────────┐  ┌───────────────────────────┐
  │ Holder still running  │  │ Holder is gone            │
  │ Wait, then re-run     │  │ Cancelled CI job, killed  │
  │                       │  │ process                   │
  └───────────────────────┘  └─────────────┬─────────────┘
                                           ▼
                             ┌───────────────────────────┐
                             │ cdkd force-unlock         │
                             │ As the message prints it  │
                             └───────────────────────────┘
```

### "Failed to acquire lock" Error

```
LockError: Failed to acquire lock for stack MyStack (us-east-1) after 4 attempts. Locked by: alice@host-1:12345, operation: deploy, expires in 4m12s. If you are certain no other process is active, run: cdkd force-unlock MyStack --stack-region us-east-1
```

Another cdkd process is working on the same stack, or a process that was
killed left its lock behind. `cdkd deploy`, `cdkd rollback` and `cdkd scrub`
print this after retrying a held lock 3 times at 2-second intervals.

The commands that write state without deploying fail on the first attempt,
with a different message:

```text
Could not acquire lock for stack MyStack (us-east-1) — held by alice@host:4242, operation: deploy, expires in 12m4s. That process is still running — wait for it to finish. Only if you are certain it is gone, run: cdkd force-unlock MyStack --stack-region us-east-1
```

Those are `cdkd destroy`, `cdkd state destroy`, `cdkd import`, `cdkd export`,
`cdkd orphan`, `cdkd drift --accept`, `cdkd drift --revert` and
`cdkd state refresh-observed`. A nested stack's child is locked separately, so
a child teardown reached from `cdkd deploy` or `cdkd rollback` can fail this
way too.

::: steps
1. Read the holder named in the message

   cdkd removes an expired lock by itself, so a lock that produces this
   message has not expired. The holder renews its lock every 2 minutes, and the
   lock expires only after 30 minutes without a renewal. If the named process
   is still running, wait for it and re-run.

2. If you know the holder is gone, run the printed command as printed

   ```bash
   cdkd force-unlock MyStack --stack-region us-east-1
   ```

   The printed command carries `--stack-region`, plus `--profile`,
   `--state-bucket` and `--state-prefix` when you passed them. Those flags
   decide which lock is cleared. A shortened command can clear a same-named
   stack's lock in a different account.
:::

> [!WARNING]
> `force-unlock` on a live lock lets a second writer into the same stack. Use
> it only when the named process is gone (a crashed CI job, a killed terminal).

To look at the lock yourself:

```bash
aws s3api get-object \
  --bucket cdkd-state-123456789012 \
  --key cdkd/MyStack/us-east-1/lock.json \
  /dev/stdout
```

`expiresAt` in that object is what the expiry check and the `expires in`
clause read. Prefer `cdkd force-unlock` to deleting `lock.json` by hand: it
resolves the same state bucket the deploy would and purges the key's
noncurrent versions.

| The message says | Meaning | Do |
| --- | --- | --- |
| `No lock could be read after the last failed attempt` | The holder released the lock between attempts, or `lock.json` is unreadable | Re-run; use `force-unlock` only if it repeats |
| `another cdkd process holds it` | cdkd could not read the holder (an S3 permission gap) | Find the running process before unlocking |

The retry count, the retry delay and the 30-minute expiry are not
configurable. `cdkd state orphan '<stack>' --force` also deletes a held lock,
including a live one.

#### A lock left behind by Ctrl-C

A first {kbd:ctrl+c} during `cdkd deploy`, `cdkd destroy`, `cdkd state destroy`
or `cdkd rollback` finishes the in-flight operations, saves state and releases
the lock. A re-run starts at once.

A second {kbd:ctrl+c} force-quits with exit `130`:

| Command | On the second signal | It prints |
| --- | --- | --- |
| `cdkd destroy`, `cdkd state destroy` | Attempts a release without waiting for it | The first message below |
| `cdkd deploy` | Does not attempt a release | The second message below |
| `cdkd rollback` | Keeps running; it cannot be force-quit this way | Nothing |

```text
Force-quit: stack lock may not be released. If the next run reports a lock, run: cdkd force-unlock MyStack --stack-region us-east-1
```

```text
Force-quit: stack locks may not be released. If the next run reports a lock, run this for EACH stack it names (the region-qualified form — see the message that run prints): cdkd force-unlock <stackName> --stack-region <region>
```

After a destroy force-quit the release usually lands and no lock is left.
After a deploy force-quit, expect one and clear it with the printed command.

### Stale lock after a cancelled CI job

A CI job running `cdkd deploy` was cancelled, and the next run fails with
`Failed to acquire lock` although no deploy is in progress. This GitHub
Actions setup for per-PR environments hits it, because consecutive pushes
target the same stack:

```yaml
concurrency:
  group: pr-env-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

cdkd releases its lock on `SIGINT` and `SIGTERM`, after the in-flight AWS
operations finish. A CI cancellation ends in `SIGKILL`, which no process can
handle. GitHub Actions escalates `SIGINT` to `SIGTERM` to `SIGKILL` within
about 10 seconds, so a job whose in-flight operation takes longer is killed
with the lock still held. Kubernetes (30 s grace) and `docker stop` (10 s) send
`SIGTERM` first and then kill the same way.

Pick one:

- **Wait.** The lock expires 30 minutes after the killed job's last renewal,
  and the next run then succeeds without intervention.
- **Clear it now.**

  ```bash
  cdkd force-unlock MyStack
  ```

- **Clear it at the start of every job**, when the workflow serializes runs
  per stack as the `concurrency` group above does. No other run of the group
  can hold the lock legitimately:

  ```yaml
  - run: npm i -g @go-to-k/cdkd
  - run: cdkd force-unlock MyStack || true  # only safe when runs are serialized per stack
  - run: cdkd deploy MyStack --yes
  ```

> [!WARNING]
> Do not add an unconditional `force-unlock` where two jobs can operate on the
> same stack at once. It breaks the lock protecting the running deploy.

A killed deploy is rarely a problem beyond the lock. cdkd saves state after
each completed resource, so a re-run resumes from there. The exception is a
resource whose create was in flight at the kill: it can exist in AWS without
a state record, and the next run then fails with an already-exists error. See
["Resource already exists" Error](#resource-already-exists-error).
[Per-PR Environments in CI](ci-per-pr.md) has the full workflow.

## State

### "State has been modified by another process"

```
StateError: State has been modified by another process. Expected ETag: "abc123", but state has changed.
```

Something else wrote this stack's `state.json` between cdkd reading it and
saving it. The save is conditional on the version cdkd read, so the
conflicting write is refused instead of overwritten. cdkd does not retry the
save, because a retry must re-read state and plan again.

1. Re-run the command.

   ```bash
   cdkd deploy MyStack
   ```

2. If it happens again, a second process really is writing this stack. Find
   it by reading the lock, which names the owner and the operation:

   ```bash
   aws s3api get-object \
     --bucket cdkd-state-123456789012 \
     --key cdkd/MyStack/us-east-1/lock.json \
     /dev/stdout
   ```

Waiting for a lock to expire does not help here: this error is the condition
on `state.json`, not the lock.

### State File is Corrupted

```
StateError: State file for stack MyStack is not valid JSON: Unexpected token } in JSON at position 123
Caused by: Unexpected token } in JSON at position 123
```

The upload of `state.json` was interrupted, or a manual edit left invalid
JSON. A state bucket created by `cdkd bootstrap` is versioned, so restore the
last good version.

::: steps
1. List the versions of the state file

   ```bash
   aws s3api list-object-versions \
     --bucket cdkd-state-123456789012 \
     --prefix cdkd/MyStack/us-east-1/state.json \
     --query 'Versions[].{VersionId:VersionId,LastModified:LastModified}'
   ```

2. Download the version you want and check it

   ```bash
   aws s3api get-object \
     --bucket cdkd-state-123456789012 \
     --key cdkd/MyStack/us-east-1/state.json \
     --version-id def456 \
     state-backup.json
   jq . state-backup.json > /dev/null   # fails if it is not valid JSON
   ```

3. Put it back

   ```bash
   aws s3 cp state-backup.json \
     s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
   ```
:::

If no usable version survives, rebuild state from the live resources instead
of redeploying. `cdkd import` records them without changing them:

```bash
aws s3 rm s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

A different message names a schema version, and its fix is to upgrade cdkd,
not to restore a backup:

```
StateError: Unsupported state schema version 12 for stack MyStack. This cdkd binary supports versions 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11. Upgrade cdkd to a version that supports schema 12.
```

### State and Resources Don't Match

Someone deleted or changed a resource in the AWS console, and cdkd now tries
to update a resource that is gone, or does not know about one that exists.
Start by listing what cdkd tracks:

```bash
cdkd state resources MyStack          # LogicalID, Type, PhysicalID
cdkd state resources MyStack --long   # plus dependencies and attributes
```

| Situation | Fix |
| --- | --- |
| The resource is gone from AWS but still in state | Drop its record; the next deploy plans it as a create |
| The resource exists in AWS but is missing from state | Adopt it with `cdkd import` |
| You want to start over | `cdkd state destroy`, then deploy |

**Drop a record.** Both commands remove state only and never touch AWS:

```bash
cdkd orphan MyStack/MyTable                                                    # by construct path; needs the CDK app
cdkd state orphan MyStack --stack-region us-east-1 --resource MyTable1234ABCD  # by logical id; no CDK app
```

Use `cdkd state orphan --resource` when the construct is already gone from the
app. Only `cdkd orphan` accepts `--dry-run`. Without `--resource`,
`cdkd state orphan MyStack` drops the whole stack record. Do not do that to a
stack with other live resources, because the next deploy re-creates or collides
with all of them. [Orphan vs Destroy](orphan-vs-destroy.md) compares the
commands.

**Adopt a resource.**

```bash
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

See [Importing Existing Resources](import.md) for the flags.

**Start over**, through cdkd rather than by hand:

```bash
cdkd state destroy MyStack --yes   # deletes the AWS resources AND the state
cdkd deploy MyStack
```

> [!CAUTION]
> Do not delete `state.json` and redeploy. It is not a reset. See
> [Q: What happens if I delete the state file?](#q-what-happens-if-i-delete-the-state-file)

### Cross-region state bucket ("is in a different region", `PermanentRedirect`)

```
StateError: Failed to verify state bucket 'my-bucket': Bucket 'my-bucket' (in ap-northeast-1) is in a different region than the client. cdkd resolves this automatically; if you see this message, please report it.
```

The lock path reports the same condition as S3's raw redirect:

```
LockError: Failed to acquire lock for stack MyStack (ap-northeast-1):
The bucket you are attempting to access must be addressed using the
specified endpoint. Please send all future requests to this endpoint.
```

The state bucket is in a different region from the one your credentials
default to. That is a supported setup: cdkd looks up the bucket's region and
talks to it there for state, locks and custom-resource responses. You do not
need to set the region to match the bucket.

Seeing either message means that lookup did not take effect. Please
[open an issue](https://github.com/go-to-k/cdkd/issues) with the output of the
command re-run under `--verbose`.

`AWS_REGION` or your AWS profile sets the region resources are provisioned in.
`--region` is an option of `cdkd bootstrap`, where it picks the new bucket's
region; on other commands it is deprecated but still honored.

## Templates cdkd refuses

cdkd refuses these templates instead of deploying something other than what
they declare. The fix is in the CDK app. Only the unsupported-type refusal has
a flag that overrides it.

### An unsupported resource type

```
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

A type that slips past pre-flight fails at provisioning time instead:

```
No provider available for resource type: AWS::CustomService::Resource. This
resource type is not supported by Cloud Control API and no SDK provider is
registered.
```

cdkd provisions a resource through one of its SDK providers or, failing that,
the Cloud Control API. This error means neither is available: AWS reports the
type as `NON_PROVISIONABLE`, or cdkd blocks it on Cloud Control until it has a
dedicated provider, or it is not an `AWS::` type at all.

- **Request the type.** The message carries a link that opens a pre-filled
  issue for exactly this type.
- **Deploy now, if the type is only blocked by cdkd.**

  ```bash
  cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh
  ```

  The flag routes the named type through Cloud Control. It takes type names,
  so each one is an explicit choice. For a `NON_PROVISIONABLE` type Cloud
  Control cannot manage it either, and the deploy still fails.
- **Check coverage.** [Supported Resources](supported-resources.md) lists
  cdkd's per-type coverage, and AWS lists
  [what Cloud Control supports](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html).

[Deploy: safety & compatibility flags](cli-deploy-safety.md) documents
`--allow-unsupported-types`.

### "The following resources declare mutually exclusive properties"

```
The following resources declare mutually exclusive properties:
  - BadRoute (AWS::EC2::Route) declares DestinationCidrBlock and DestinationIpv6CidrBlock
      CloudFormation and the EC2 CreateRoute API accept exactly one destination per route.
      cdkd would send only DestinationCidrBlock; DestinationIpv6CidrBlock would be dropped.
      Deleting the dropped keys changes nothing cdkd sends — but if the LIVE resource was
      created from one of them, making DestinationCidrBlock the sole value is a create-only
      change that REPLACES it.
      Declare at most one of: DestinationCidrBlock / DestinationIpv6CidrBlock / DestinationPrefixListId
```

The template declares two or more properties of which AWS accepts only one.
CloudFormation rejects the same template, so there is no `--allow-*` flag. The
check runs at pre-flight on every deploy, before any AWS call, including a
deploy where the resource is unchanged.

`cdkd diff` reports no change for this shape, but warns that part of the
declared properties cannot be sent as declared.

Remove every key except the one the message says cdkd would send:

```typescript
new ec2.CfnRoute(this, 'Route', {
  routeTableId: rt.ref,
  gatewayId: igw.ref,
  destinationCidrBlock: '0.0.0.0/0',
  // destinationIpv6CidrBlock: '::/0',  <- delete; only one destination is allowed
});
```

> [!WARNING]
> Check what the live resource was created from first. If it was created from
> one of the dropped keys, making a different key the sole value is a
> create-only change and replaces the resource.

If the resource needs a different property per environment, put each behind a
condition whose other arm is `AWS::NoValue`. cdkd does not refuse a key behind
an unresolved intrinsic, and exactly one of the two survives resolution:

```json
{
  "DestinationCidrBlock":     { "Fn::If": ["IsV4", "0.0.0.0/0", { "Ref": "AWS::NoValue" }] },
  "DestinationIpv6CidrBlock": { "Fn::If": ["IsV4", { "Ref": "AWS::NoValue" }, "::/0"] }
}
```

### "The following resources declare a nested property block without a member it requires"

```
The following resources declare a nested property block without a member it requires:
  - Service (AWS::ECS::Service): DeploymentConfiguration.DeploymentCircuitBreaker is missing required member Rollback
```

A nested block is present in the template but omits a member the resource
type's schema requires there. Sent as is, the service API may accept the
partial block and replace the live one, resetting the omitted member. The
block above would switch a live rollback off.

Declare the missing members:

```typescript
new ecs.CfnService(this, 'Service', {
  // ...
  deploymentConfiguration: {
    deploymentCircuitBreaker: { enable: true, rollback: true },
  },
});
```

The check runs at pre-flight on every deploy, before any AWS call.
CloudFormation refuses the same template, so there is no `--allow-*` flag.

- An absent block is never refused, only a present and incomplete one.
- A block, element or member behind an unresolved intrinsic (`Fn::If`, `Ref`)
  is not refused.
- The check covers the resource types CloudFormation enforces these lists on.
- Array elements are named by index (`Policies[1]`).

### "Properties validation failed": a list where an object is expected, or the reverse

```
Properties validation failed: the following resources declare a property whose kind contradicts the resource type's schema:
  - Queue (AWS::SQS::Queue): #/Tags: expected type: JSONArray, found: JSONObject
```

A template property is an object where the schema requires a list, or a list
where it requires an object. The usual source is an `addPropertyOverride` that
wrote the wrong kind. Give the property the kind the schema declares:

```typescript
(queue.node.defaultChild as sqs.CfnQueue).addPropertyOverride('Tags', [
  { Key: 'team', Value: 'platform' }, // a list, not { Key, Value }
]);
```

The check runs at pre-flight on every deploy, before any AWS call.
CloudFormation refuses the same template with the same words, so there is no
`--allow-*` flag.

- Only a list against an object is refused. A scalar mismatch is left to
  CloudFormation's and the service's own checks.
- A property is checked only where the schema admits exactly one of the two
  kinds.
- A value that is an unresolved intrinsic (`Ref`, `Fn::If`, `Fn::Split`) is
  not refused.
- Array elements are named by index (`Tags[1]`).

### "The following custom resources pass a secure dynamic reference"

```
The following custom resources pass a secure dynamic reference ({{resolve:secretsmanager:...}} / {{resolve:ssm-secure:...}}) in their properties:
  - DbInit: Password
```

A custom resource (`Custom::*` or `AWS::CloudFormation::CustomResource`) has a
property holding a `{{resolve:secretsmanager:...}}` or
`{{resolve:ssm-secure:...}}` reference, directly or inside an intrinsic.
CloudFormation does not support secure dynamic references in custom resources.
cdkd refuses before resolving anything, so the secret never reaches the
handler's event.

- Pass the secret's name or ARN instead, and have the handler read the value
  (grant its role `secretsmanager:GetSecretValue` or `ssm:GetParameter`).
- For a value that is not secret, use a plain `{{resolve:ssm:...}}` parameter.

The check runs on every deploy, including one where the resource is
unchanged, and has no `--allow-*` flag. `cdkd destroy` does not run it, so a
stack that already carries such a resource can still be torn down. A plain `{{resolve:ssm:...}}` that names a
SecureString parameter passes this check and is refused later, when the
handler would be invoked: see
["Custom resource X: Y resolved to the value of a secret"](#custom-resource-x-y-resolved-to-the-value-of-a-secret).

### "OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table

```text
AWS::Glue::Table IcebergTable: OpenTableFormatInput.IcebergInput.IcebergTableInput
cannot be deployed by AWS in any shape, so cdkd refuses it before calling Glue
(issue #1454).
```

AWS accepts no shape of this property: `glue:CreateTable` rejects it, and
CloudFormation rolls the same template back. cdkd refuses a create that
declares it, before calling Glue.

Move the table metadata into `TableInput` and leave `IcebergInput` carrying
only the create-time directive:

```yaml
TableInput:
  Name: events_iceberg
  TableType: EXTERNAL_TABLE          # required for Iceberg
  StorageDescriptor:
    Location: s3://your-bucket/iceberg/events/
    Columns:
      - Name: event_id
        Type: string
OpenTableFormatInput:
  IcebergInput:
    MetadataOperation: CREATE        # Version: '2' is also accepted
```

Glue writes the Iceberg metadata itself. The created table comes back with
`Parameters.table_type = ICEBERG` and a populated `Parameters.metadata_location`.

Two paths warn instead of refusing:

- **An update.** Adding `IcebergTableInput` to an already-deployed table
  produces a warning and a successful deploy. cdkd forwards nothing for it, so
  the property is ignored.
- **A `cdkd rollback`.** A rollback replays cdkd's state, not your template,
  so a refusal there would leave no remedy.

See "Glue table Iceberg support" in
[Supported Resources](supported-resources.md) for the background.

### "SelfManagedKafkaEventSourceConfig.ConsumptionMode cannot be sent by cdkd yet"

```text
AWS::Lambda::EventSourceMapping MyMapping: SelfManagedKafkaEventSourceConfig.ConsumptionMode
cannot be sent by cdkd yet — the AWS SDK for JavaScript does not model the member, so it
would be dropped from the CreateEventSourceMapping request without an error (issue #3848).
Remove ConsumptionMode from SelfManagedKafkaEventSourceConfig to deploy the mapping without it.
```

The CloudFormation schema declares `ConsumptionMode` (`Stream` or `Queue`) on a
self-managed Kafka event source mapping, but the AWS SDK cdkd calls Lambda
through drops it from the request. cdkd refuses a create that declares it, and
an update that adds or changes it, rather than deploy a mapping without the
mode you asked for.

Remove `ConsumptionMode` from `SelfManagedKafkaEventSourceConfig`.

Routing the resource through Cloud Control does not help: Lambda rejects the
member there too (`Unsupported 'ConsumptionMode' parameter for given event
source mapping type`). A `cdkd rollback` or `cdkd drift --revert` only warns,
because those replay a recorded configuration.

## Failures during a deploy

### "Resource already exists" Error

A name collision surfaces as the AWS service's own error under `Caused by:`:

```
ProvisioningError: Failed to create resource MyBucket
Caused by: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.
```

The wording differs per service: IAM raises `EntityAlreadyExists`, DynamoDB
`ResourceInUseException`, and so on.

A resource with that name exists in AWS and is not in this stack's state.
Either something else owns the name, or an earlier deploy created the resource
and ended before recording it.

Not every type fails on a collision. Check which behaviour applies before
choosing a fix:

| Behaviour | Types | What you see |
| --- | --- | --- |
| Fails the create | IAM roles, users and groups, DynamoDB tables, Lambda functions, SQS queues, ELBv2 load balancers | The error above |
| Adopts the existing resource | `AWS::S3::Bucket`, `AWS::Logs::LogGroup`, `AWS::SNS::Topic` | A successful deploy that re-applies your configuration to it |
| Creates a second resource | Types with an AWS-assigned id: VPC, EC2 instance, ACM certificate, CloudFront distribution | A successful deploy, and an orphan nothing tracks |

An S3 bucket you own in a different region is refused rather than adopted.

Pick the fix that matches who owns the existing resource:

- **It is this stack's resource: adopt it.**

  ```bash
  cdkd import MyStack --resource MyBucket=my-bucket-name
  ```

- **It is not needed: delete it**, then re-deploy.

  ```bash
  aws s3 rb s3://my-bucket-name --force
  ```

- **It belongs to something else: rename yours.**

  ```typescript
  new s3.Bucket(this, 'MyBucket', {
    bucketName: `my-app-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
  });
  ```

When the colliding name is one cdkd generated, the error is followed by a
message that prints the adoption command. See
[Recovering from Orphaned Resources](#recovering-from-orphaned-resources).
[Importing Existing Resources](import.md) has the import flags.

### Replacing a resource, and the refusal that guards it

Changing a property AWS cannot update in place makes cdkd delete the old
resource and create a new one. It needs no flag, and the deploy says so:

```
Replacing MyBucket (AWS::S3::Bucket) - immutable properties changed: BucketName
```

Two refusals interrupt a replacement.

#### The resource holds data

```
ProvisioningError: Failed to update resource MyBucket
Caused by: MyBucket (AWS::S3::Bucket) requires replacement (immutable property changed: BucketName) but it is a stateful resource — S3 bucket is not provably empty. Re-run with --force-stateful-recreation to confirm the data loss, or change the resource definition to avoid the immutable-property change.
```

Replacing means deleting, so cdkd asks for confirmation on a stateful
resource. Revert the immutable-property change, or accept the data loss:

```bash
cdkd deploy MyStack --force-stateful-recreation
```

The guard is skipped for a resource carrying `UpdateReplacePolicy: Retain`.
See the
[stateful-resource guard](cli-deploy-safety.md#stateful-resource-guard).

#### The type cannot be updated in place at all

```
ResourceUpdateNotSupportedError: AWS::EC2::NatGateway (MyNat) cannot be updated in place: use cdkd deploy with --replace, or change the resource definition to create a new version.
```

Any change to such a type is a replacement. The message names the remedy for
that type, and its tail varies per type. This failure exits `2` rather than
`1`.

```bash
cdkd deploy MyStack --replace
```

### Lambda Deployment Fails

```
ProvisioningError: Failed to create resource MyFunction
Caused by: Failed to create Lambda function MyFunction: <the AWS error>
```

The AWS error on the `Caused by:` line is the diagnosis. The two common ones:

| AWS error | Cause | Fix |
| --- | --- | --- |
| `Error occurred while GetObject. S3 Error Code: NoSuchKey.` | The code asset was never published: the deploy ran with `--skip-assets`, or the asset bucket was emptied | Deploy without `--skip-assets`; check the bucket as below |
| `The role defined for the function cannot be assumed by Lambda.` | The new execution role has not propagated in IAM. cdkd already retried for about 48 seconds | Re-run the deploy |

```bash
jq '.files' cdk.out/MyStack.assets.json                 # what the stack expects
aws s3 ls s3://cdkd-assets-123456789012-us-east-1/      # what was published
```

Use `cdk-hnb659fds-assets-123456789012-us-east-1` when the region publishes to
the CDK bootstrap bucket (see ["Asset publishing failed"](#asset-publishing-failed)).

A template missing `Code` or `Role` is caught before any AWS call, with
`Code is required for Lambda function MyFunction`.

cdkd orders the role before the function because the function references it.
Passing `role: role` to `lambda.Function` is enough. `addDependency` is not
needed.

### an ACM certificate deploy fails with "did not reach ISSUED status"

```
ACM certificate SiteCert (arn:aws:acm:us-east-1:123456789012:certificate/...) did not reach
ISSUED status within 600s.
```

A DNS-validated certificate reaches `ISSUED` only once its validation records
are live in your DNS zone. On a first deploy they usually do not exist yet, so
the 10-minute wait runs out. cdkd prints the records on its first
`PENDING_VALIDATION` poll, and deletes the certificate it requested before
reporting the error, so failed attempts leave nothing behind.

Add the printed CNAME records to your DNS zone, then re-run:

```bash
cdkd deploy MyStack
```

The records stay valid for the next attempt. ACM derives a domain's validation
CNAME from the domain and the account, not from the certificate, and
[documents](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
that a replacement certificate does not need validation repeated.

To change how long the deploy waits:

| Goal | Command |
| --- | --- |
| Wait up to 20 minutes | `CDKD_ACM_POLL_ATTEMPTS=120 cdkd deploy MyStack` |
| Do not wait | `cdkd deploy MyStack --no-wait` |

- `CDKD_ACM_POLL_ATTEMPTS` (default 60) is the number of polls, and
  `CDKD_ACM_POLL_INTERVAL_MS` (default 10000) the gap between them.
- With `--no-wait` the certificate is created and recorded in state, and the
  deploy returns at once. Resources that use the certificate fail until it
  issues.

`--resource-timeout` does not lengthen this wait by itself. The effective wait
is the shorter of the poll cap and the per-resource deadline, which defaults to
30 minutes. To poll past 30 minutes, raise both:

```bash
CDKD_ACM_POLL_ATTEMPTS=270 cdkd deploy MyStack \
  --resource-timeout AWS::CertificateManager::Certificate=50m   # 45 min of polling
```

Do not set the deadline below the poll cap. The deadline abandons the create
without cancelling it, so the cleanup that deletes the certificate may not run.

If the message also says the certificate could NOT be deleted, the cleanup
failed (a throttle, a permissions gap). cdkd is not tracking that certificate,
so `cdkd destroy` will not remove it. The message names the ARN and the
command:

```bash
aws acm delete-certificate --certificate-arn <arn> --region us-east-1
```

### "Custom resource X: Y resolved to the value of a secret"

```
Custom resource DbInit: Password resolved to the value of a secret (a Secrets Manager secret, or an SSM SecureString parameter -- including one read through a plain {{resolve:ssm:...}} reference or a nested stack parameter). CloudFormation does not support secure dynamic references in custom resources, so cdkd does not send the secret's value to the handler. Pass the secret's name or ARN instead and have the handler read it.
```

A property of the custom resource resolved to a secret's value by a route the
template does not show, so the pre-flight check
(["The following custom resources pass a secure dynamic reference"](#the-following-custom-resources-pass-a-secure-dynamic-reference))
could not catch it. cdkd refuses before the handler runs.

| Route | Fix |
| --- | --- |
| A plain `{{resolve:ssm:...}}` that names a SecureString parameter | Pass the parameter's name or ARN; have the handler read it |
| A nested stack's child reading a parameter the parent filled from a secret | Pass the name down as the parameter, not the resolved value |

A value derived from a secret (base64-encoded, a fragment) is refused too.

A rollback that re-resolves an older record is refused the same way. That
includes `cdkd rollback --revert-failed`, which sends a failed update's
attempted properties as the event's `OldResourceProperties`; the message then
names the property as `OldResourceProperties.<path>`.

### A changed custom-resource ServiceToken is refused

```
Refusing to deploy S: a custom resource's ServiceToken changes, which CloudFormation does not allow ("Modifying service token is not allowed") (issue #4749). Nothing was sent to either handler.
  - Cr: ServiceToken changes to arn:aws:lambda:...:function:new, away from the handler its record names.
```

The custom resource now points at a different handler. Its `serviceToken`
names another provider, or the backing Lambda was renamed or moved under a new
construct id, so its ARN changed. CloudFormation refuses this too, and an
in-place update would orphan whatever the old handler created.

| You want | Do |
| --- | --- |
| The new handler | Give the custom resource a new logical id (a new construct id, or `overrideLogicalId`). The deploy creates it through the new handler and deletes the old one through its old handler |
| The existing resource | Deploy its previous `ServiceToken` |

A row reading `its recorded ServiceToken is ...` means the state record holds
no comparable token, so cdkd cannot tell whether it changed. If the handler did
not change, set `ServiceToken` in `state.json` to the ARN of the handler that
created this resource (the one it was last deployed with) and re-deploy.

### "Unresolved intrinsic function" Error

```
ProvisioningError: Failed to create resource MyResource
Caused by: Unsupported CloudFormation intrinsic function "Fn::ToJsonString": cdkd does not support resolving it yet. Deploying this template would produce a broken value. Please request support by opening an issue: https://github.com/go-to-k/cdkd/issues/new?title=Support%20intrinsic%20Fn%3A%3AToJsonString&labels=intrinsic-support
```

The template uses a CloudFormation intrinsic function cdkd does not resolve.
The error appears at provision time, not in `cdkd diff`, because diff leaves
anything it cannot resolve as written.

cdkd resolves `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Sub`, `Fn::Select`,
`Fn::Split`, `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`,
`Fn::ImportValue`, `Fn::GetStackOutput` (cdkd-specific), `Fn::FindInMap`,
`Fn::GetAZs`, `Fn::Base64`, `Fn::Cidr` and `Fn::Transform`.

- **The intrinsic is not in that list** (`Fn::ToJsonString` and `Fn::ForEach`
  are the likely ones): use the link in the message to request it. No flag
  works around it.
- **It is in the list**: the installed cdkd predates its support. Upgrade:

<pm>
npm i -g @go-to-k/cdkd
</pm>

### "Refusing to resolve" a reference whose service cdkd does not resolve

```
Refusing to resolve {{resolve:***}}: its service is not one cdkd resolves (secretsmanager, ssm, ssm-secure), and the reference was assembled from a secret value, so leaving it as written would send that value to AWS and record it in state in the clear.
```

An `Fn::Sub` or `Fn::Join` builds a `{{resolve:...}}` token around a value
that is itself a resolved secret, and the secret lands where the service name
goes:

```yaml
Value:
  Fn::Sub:
    - '{{resolve:${Pw}}}'
    - Pw: '{{resolve:secretsmanager:MySecret:SecretString:password}}'
```

cdkd leaves a token of an unknown service as written. Here the token's text
holds the secret, so cdkd refuses instead of sending it to AWS and writing it
to `state.json`.

Reference the secret directly, or spell the service literally and substitute
only the name:
`{{resolve:secretsmanager:${SecretName}:SecretString:password}}`.

Where the refusal lands:

| Position | Result |
| --- | --- |
| A resource property | The resource fails before its provider is called, and the deploy rolls back |
| A stack Output | The deploy warns `Failed to resolve output <name>: ...`, skips the output and exits 0 |
| A stack Output under `--strict-getatt` | The deploy fails |

#### If such a value was already deployed

The secret may be stored in AWS and in the stack's state record. Clean up in
this order:

1. Deploy the corrected template, so AWS stops holding the secret.
2. Run [`cdkd scrub`](cli-scrub.md), which replaces the secret inside the
   stored `{{resolve:...}}` text with its reference.
3. Rotate the secret.

Scrubbing first leaves the record holding text no service can resolve while
AWS still holds the old value. `cdkd drift` then skips that property, and a
`cdkd rollback` or `cdkd drift --revert` that touches the resource writes the
unresolvable text to it.

When another stack imports the value, scrub the producer stack before
deploying the consumer. A consumer reads the producer's stored output as
written.

### "Refusing to resolve" a reference whose name was built from a secret

```
Refusing to resolve {{resolve:ssm:/app/***}}: the reference was assembled from a secret value and resolves to a secret, so recording it would write that value into state inside the reference. Build the reference name from non-secret values.
```

An `Fn::Sub` or `Fn::Join` puts a secret value into a `secretsmanager`, `ssm`
or `ssm-secure` reference (its name, a JSON key, a version stage), and the
reference itself resolves to a secret:

```yaml
Value:
  Fn::Sub:
    - '{{resolve:ssm:/app/${Name}}}'
    - Name: '{{resolve:secretsmanager:MySecret:SecretString:name}}'
```

cdkd stores a resolved secret in `state.json` as the reference that resolved
it. Here that reference contains the other secret, so storing it would write
that secret into state.

Build the reference name from values that are not secrets: a literal, or a
plain parameter.

A second shape masks the whole reference (`Refusing to resolve ***: ...`).
There a secret's whole value is itself `{{resolve:...}}` text, for example an
`ssm` parameter holding `{{resolve:ssm:/app/pin}}` used through `Fn::Sub`, and
cdkd would resolve that text again. Write the reference to the target in the
template instead of storing `{{resolve:...}}` text as a secret's value.

What is and is not refused:

| Reference | Result |
| --- | --- |
| `secretsmanager` or `ssm-secure`, name built from a secret | Refused before any lookup, so the name is never sent to AWS |
| `ssm`, resolves to a `SecureString` | Looked up, then refused |
| `ssm`, resolves to a `String` or `StringList`, or to nothing | Resolved |
| `ssm`, lookup fails | Reports the lookup's own error, with the name masked |
| A name that literally spells a secret of 4+ characters a parent stack passed in as a decrypted parameter | Refused |

Two references to one secret in the same stack both resolve, even when the
first one's value also appears in the second one's literal text. `cdkd drift`
and a rollback replay read what state already holds and are not refused.
`cdkd import` warns `Failed to resolve intrinsics in Properties for imported
resource '<id>' ...` with this message and records that resource's properties
in their template form.

If such a template was already deployed, the state record can hold the other
secret inside the stored reference. [`cdkd scrub`](cli-scrub.md) does not
remove it. Deploy the corrected template, which rewrites the record, and
rotate the secret.

### "Cannot resolve" a GetAtt on a resource an older cdkd deployed

```
Cannot resolve Fn::GetAtt [MyParam, Arn] for AWS::SSM::Parameter: the state
record holds no value for it, and the physical ID fallback "/app/config" is not
an ARN (arn:...). ... cdkd tried to re-read the attributes from AWS to heal the
record, but the provider read failed (AccessDeniedException, HTTP 403); re-run
with --verbose for the AWS error text.
```

cdkd answers `Fn::GetAtt` from the attributes it recorded when the resource
was created or last updated. A record can lack one:

| Record | Missing attribute |
| --- | --- |
| Written by a cdkd release that did not record it yet | For example `AWS::SSM::Parameter` `Arn`, `AWS::RDS::DBSubnetGroup` `DBSubnetGroupArn` |
| Written while AWS had not assigned the value | `Endpoint.Address` / `Endpoint.Port` of a `--no-wait` `DBInstance` |
| Holds a wildcard placeholder ARN from an old release | The ARN of an `AWS::AppSync::*` child |

When `cdkd deploy` meets such a reference it re-reads the resource's
attributes from AWS once, uses the value and adds it to the record. The
resource itself is not updated. The error above appears only when that re-read
could not help, and the message says why:

| The message says | Meaning | Fix |
| --- | --- | --- |
| `the provider read failed (<ErrorClass>, HTTP <n>)` | The read was denied, throttled or failed | Grant the read permission (or retry) and deploy again |
| `AWS reports no resource behind the recorded physical id` | The resource was deleted outside cdkd | Check with `cdkd drift`, then re-create it or remove it from state |
| `cdkd re-read the resource ... reports none by that name` | The resource type does not supply this attribute | Avoid the `Fn::GetAtt`, or file an issue |
| `re-read the resource through Cloud Control, but withheld the value` | The value came back masked, so cdkd would not use it | Grant the deploy role `cloudformation:DescribeType` and deploy again |

For the last row, if the role already has the permission, the name is a
writable property and not an attribute. Reference the template's own value.

Changing any property of the resource, or re-importing it with `cdkd import`,
also rewrites the record. `--verbose` prints the AWS error text, which is
withheld by default because a denied call quotes the caller's account, role
and session.

How the other commands treat the same record:

| Command | Behaviour |
| --- | --- |
| `cdkd deploy --dry-run` | Re-reads, records nothing |
| `cdkd diff` | Re-reads and previews the value, never writes it; its message starts `This preview re-read the attributes from AWS, but ...` |
| `cdkd drift`, `cdkd export` | Never re-read; report an `*Arn` / `*Url` reference as unresolved, and resolve any other attribute to the physical ID with a warning |

## Slow deploys, throttling and retries

### Deployment is Slow

A handful of independent resources takes well over a minute, or adding
resources that do not depend on each other lengthens the deploy roughly
linearly. [Benchmarks](benchmarks.md) has the figures to compare against.

| Cause | Check | Fix |
| --- | --- | --- |
| A long dependency chain | The DAG depth, below | Remove dependencies the template does not need |
| A resource on the Cloud Control route | `cdkd state show MyStack` | See "Resources on the Cloud Control route" below |
| Cloud Control throttling | `Rate exceeded` under `--verbose` | [Cloud Control API Rate Limit](#cloud-control-api-rate-limit) |
| Asset publishing | The asset steps before provisioning starts | The asset concurrency flags under [Cloud Control API Rate Limit](#cloud-control-api-rate-limit) |

#### Inspect the dependency graph

A dry-run deploy with `--verbose` builds the graph and stops before touching
AWS:

```bash
cdkd deploy MyStack --dry-run --verbose
```

```text
... DEBUG [DagBuilder] Dependency graph built: 4 nodes, 3 edges
... DEBUG [DagBuilder] Level 0: 2 resources - Bucket, Table
... DEBUG [DagBuilder] Level 1: 1 resources - Role
... DEBUG [DagBuilder] Level 2: 1 resources - Function
... DEBUG [DagBuilder] Execution levels computed: 3 levels
✓ Dry run completed - no actual changes made
```

The depth bounds how much can run at once, so a deep, narrow graph is what
caps a deploy. A real deploy prints the same figure in one line:
`Deploying 4 resource(s) (DAG: 3 levels, max parallel: 10)`.

Each resource starts as soon as its own dependencies complete, so a deploy
does not wait for a whole level. Destroy deletes level by level, in reverse.

#### Remove dependencies the template does not need

cdkd derives the order from `Ref` and `Fn::GetAtt`. An explicit
`addDependency` between unrelated resources only serializes them:

```typescript
const bucket = new s3.Bucket(this, 'Bucket');
const role = new iam.Role(this, 'Role', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
role.node.addDependency(bucket); // delete this line: the role does not use the bucket
```

#### Resources on the Cloud Control route

```bash
cdkd state show MyStack
```

```text
MyTopic
  Type: AWS::SNS::Topic
  PhysicalID: arn:aws:sns:us-east-1:123456789012:MyTopic
  ProvisionedBy: cc-api
```

`ProvisionedBy: cc-api` means the resource goes through the Cloud Control API,
which is slower than an SDK provider. A resource lands there when its template
carries a top-level property the SDK provider does not send, and it stays
there on later deploys. Whether you need to act depends on the type:

| Type | What happens |
| --- | --- |
| cdkd now covers every property the resource uses, and the type is exempt from staying on Cloud Control | The next deploy that changes the resource moves it back in place. See [`cdkd diff` shows `[returning to SDK provider]`](#cdkd-diff-shows-returning-to-sdk-provider) |
| Any other type | Move it yourself with `--recreate-via-sdk-provider <LogicalId>`, which destroys and recreates the resource |

`--recreate-via-sdk-provider` refuses while the template still carries the
property that sent the resource to Cloud Control. Remove the property, or
accept that it is dropped with `--prefer-sdk-route <Type>:<Prop>`.
[Provisioning Layers](provisioning-layers.md) explains the two layers, and
[Deploy: safety & compatibility flags](cli-deploy-safety.md) the flags.

### Cloud Control API Rate Limit

```
ProvisioningError: Failed to create resource MyTopic
Caused by: CREATE failed for MyTopic: Rate exceeded
```

Cloud Control throttled the request (`ThrottlingException`). AWS publishes no
rate quota for the Cloud Control API, but it throttles when the request rate
is too high. A wide stack of independent resources issues many calls at once.

cdkd retries throttling by itself, so you normally see this only under
`--verbose` or after the retries are spent. If it fails the deploy, lower the
concurrency:

```bash
cdkd deploy MyStack --concurrency 4        # default 10, concurrent resource operations
cdkd deploy --all --stack-concurrency 2    # default 4, concurrent stacks
```

Asset publishing has its own limits: `--asset-publish-concurrency` (default 8)
and `--image-build-concurrency` (default 4).

#### What cdkd retries

cdkd retries create, update and delete operations during `cdkd deploy`, and
the replays `cdkd rollback` and `cdkd drift --revert` perform. The schedule
depends on the kind of error:

| Kind of error | Examples | Retries | Total wait |
| --- | --- | --- | --- |
| Throttling and transient | Rate limits, a resource still leaving `Pending`, HTTP 500 / 502 / 503 / 504 | 8, backing off 1s to 8s | 47s |
| IAM propagation | `cannot be assumed`, `not authorized to perform`, `Invalid IAM Instance Profile`, `not authorized to access the Log Destination` | 26, every 0.25s to 2s | 47.75s |
| A name still held by a deleted resource | `QueueDeletedRecently`, Step Functions `StateMachineDeleting` | 8, backing off 2s to 10s | 64s |

`Custom::*` / `AWS::CloudFormation::CustomResource` and
`AWS::CloudFormation::Stack` are outside this retry. A custom resource retries
internally instead: `CDKD_CR_AUTHZ_MAX_RETRIES` (default 2, at most 10) is the
number of times cdkd re-invokes your handler after it returns `FAILED` with an
authorization-shaped reason, and `0` disables those re-invocations.

#### Reading the "gave up after" line

When the retries run out, cdkd prints one line at the default log level:

```text
MyFunction: gave up after 26 IAM-propagation retries over 47.75s of propagation backoff (the full propagation budget) - The role defined for the function cannot be assumed by Lambda.
```

When cdkd can see how the AWS SDK parsed the failing response, the line ends
with a bracketed summary:

```text
MyQueuePolicy: gave up after 5 IAM-propagation retries over 5.75s of propagation backoff - Failed to create SQS queue policy MyQueuePolicy: UnknownError [name=InternalFailure http=500 requestId=ebf581cc-6072-5ffc-943a-e33312488615]
```

| The line shows | Meaning | Do |
| --- | --- | --- |
| `(the full propagation budget)` | The retries ran to the end. Usually IAM took longer than 47.75s | Re-run. If it recurs, open an issue with the line |
| The same, on a message that is also emitted for permanent problems | A real misconfiguration, such as the Step Functions [log-destination](#the-state-machine-iam-role-is-not-authorized-to-access-the-log-destination) error | Fix what the AWS message names; re-running never succeeds |
| No budget note and a low count | Something terminal ended the retries early: an explicit deny, or an error cdkd could not classify | Read the bracket. Report it if the status is a 5xx other than 500 / 502 / 503 / 504, or the bracket shows `no-$metadata` |
| `transient server-error retries (HTTP 5xx)` | The retries were spent on transient server errors, not on propagation | Re-run |
| No such line at all | The retry never started: cdkd did not recognise the error, or the resource is a custom resource or nested stack | Report the unrecognised wording, unless the resource is one of those two types |

Notes for reading the line:

- `UnknownError` is the AWS SDK's placeholder for a response with no message
  text. The bracket is then the whole diagnosis: `name` and `http` are what
  cdkd classifies on, and `requestId` is what AWS support needs.
- `no-$metadata` in place of `http=` means the failure never reached the SDK's
  error parsing: a network or protocol failure.
- The seconds count propagation backoff only. A throttle in between uses an
  attempt without counting, so the retry count on a full-budget line can be
  below 26.
- `--verbose` prints each attempt with its running total
  (`attempt 15/26, 25.75s backoff through this attempt`).
- The line can appear during `cdkd rollback` and an automatic rollback as well
  as during `cdkd deploy`.

[Troubleshooting internals](troubleshooting-internals.md) has the exact
schedules and the custom-resource retry rules.

### A name is still held by the resource you just deleted

A destroy followed straight away by a deploy fails on a name that looks free:

```
ProvisioningError: Failed to create resource MyQueue
Caused by: You must wait 60 seconds after deleting a queue before you can create another with the same name.
```

Some services release a name some time after the delete returns. cdkd retries
this for 64 seconds, so usually you never see it.

| Type | Window |
| --- | --- |
| `AWS::SQS::Queue` | 60s, stated by the service |
| `AWS::StepFunctions::StateMachine` | About 23s of `status: DELETING` on an idle machine |
| `AWS::S3::Bucket` | Bucket names are global and released asynchronously |

Wait and re-run. When the retries run out, the line says so:

```
MyQueue: gave up after 8 name-cooldown retries over 64.00s waiting for the name to be released (the full name-cooldown budget) - <the AWS message>
```

The Step Functions case is easy to hit without knowing it. Any CDK app using
`custom_resources.Provider` with an `isCompleteHandler` carries a waiter state
machine.

cdkd does not retry these, so do not wait for them:

- ELBv2 `DuplicateLoadBalancerName` and DynamoDB's create-side refusal, which
  mean the resource still exists.
- A Secrets Manager name scheduled for deletion, which can be held for 7 to 30
  days.

During a `--replace` the retry runs once per replacement attempt, so a
custom-named SQS queue can appear to hang for up to about 11 minutes.

### "cdkd stopped waiting for it" — a network outage during a Cloud Control operation

```text
CREATE of Dbwriter9B286E50 was accepted by Cloud Control API, but cdkd stopped
waiting for it (cdkd could not reach Cloud Control API for 121s: connect
ECONNREFUSED 100.72.0.178:443). The operation may still be running in AWS, and
cdkd has NO state record for it, so any resource it creates is untracked by
rollback and by cdkd destroy. Check what it did with:
  aws cloudcontrol get-resource-request-status --request-token <token> --region ap-northeast-1
```

Your connection dropped while a Cloud Control operation was in flight. A VPN
reconnecting is the usual cause. Cloud Control runs the operation in AWS
whether or not cdkd can reach it, and cdkd polls a request token for the
result. cdkd rides out about two minutes without a connection. After that it
cannot learn the outcome.

Run the command the error prints and read `OperationStatus`:

| `OperationStatus` | Meaning | Do |
| --- | --- | --- |
| `SUCCESS` | AWS did the operation; for a create, cdkd has no record of the resource | Adopt it with [`cdkd import`](import.md) using the response's `Identifier`, or delete it in AWS |
| `FAILED` | Nothing was created | Re-run `cdkd deploy` |
| `IN_PROGRESS` | Still running | Run the status command again until it settles |

A `RequestTokenNotFoundException` means the request has aged out of Cloud
Control's status history. Look for the resource in the console or through the
service's API, then import or delete it.

Only a create can leave a resource without a record. After an update or a
delete the resource still has its state record, so re-running `cdkd deploy` or
`cdkd destroy` finishes the job once the network is back.

If the same deploy also reported `Failed to save partial state before
rollback` or `Failed to write rollback journal`, the outage took those too. See
[After a failed or interrupted deploy](#after-a-failed-or-interrupted-deploy).

## A deploy succeeds but AWS is not what the template says

### A property you set in the template never reaches AWS

The deploy succeeds and `cdkd diff` reports the change, but the field is
absent from the live resource.

cdkd's SDK providers send only the properties they handle. To avoid dropping
the rest, cdkd routes a resource whose template carries any other top-level
property through the Cloud Control API, which forwards every property. The
deploy says so:

```
MyAlarm (AWS::CloudWatch::Alarm): routing via Cloud Control API (cdkd's SDK Provider does not yet wire EvaluationWindow — CC API will forward the full property map. Override via --prefer-sdk-route AWS::CloudWatch::Alarm:EvaluationWindow.)
```

So a missing field means that routing did not happen. Check which layer
handled the resource:

```bash
cdkd state show MyStack    # ProvisionedBy: sdk | cc-api
```

`cc-api` means every property was forwarded, so cdkd did not drop the field.
`sdk` means one of these:

| Cause | Fix |
| --- | --- |
| You passed `--prefer-sdk-route <Type>:<Prop>`, which keeps the resource on the SDK provider and accepts the drop | Stop passing the flag; the next deploy routes the resource and applies the property |
| cdkd's bundled schema does not know the property, and the resource already carries it with the same value | Change the value so the next deploy routes it, or pass `--recreate-via-cc-api <LogicalId>` |
| The property is nested, not top-level | None here: the routing check covers top-level properties only, and a missing nested key is a different problem |

For the second row cdkd warns on the deploy. A read-only property never
routes, and neither does a property on a type Cloud Control cannot manage.

You do not need `--recreate-via-cc-api` merely because a deployed resource
gained such a property. The next deploy re-routes it and normally applies the
property in place.

#### `CREATE_ONLY_DROP_NEEDS_REPLACEMENT`

Dropping `--prefer-sdk-route` is refused with this code when the dropped
property is create-only, because applying it to a live resource needs a
replacement. The refusal names the remedies:

| Remedy | Effect |
| --- | --- |
| `--recreate-via-cc-api <LogicalId>` or `--replace` | Replaces the resource with the property applied; inside a nested stack only `--replace` reaches it |
| `--force-stateful-recreation` | Also required when the type is stateful |
| `--prefer-sdk-route` with the list the refusal prints | Keeps dropping the property; the list can name more than your original flag did |

[Deploy: safety & compatibility flags](cli-deploy-safety.md) says what each
remedy costs, and [Provisioning Layers](provisioning-layers.md) how to choose a
flag.

### `cdkd diff` shows `[returning to SDK provider]`

```
  [~] MyTopic (AWS::SNS::Topic) [returning to SDK provider]
```

The resource was deployed through the Cloud Control API, and cdkd's SDK
provider now covers every property it uses. The next deploy that changes the
resource moves it back to the faster SDK provider. This is an update in place:
the physical id is kept, so references to the resource survive. The deploy
names the move:

```
MyTopic (AWS::SNS::Topic): returning to the SDK provider — cdkd now covers every property this resource uses. The physical id is preserved; pass --pin-cc-api MyTopic to decline this for a deploy.
```

Usually there is nothing to do. To keep the resource on Cloud Control for one
deploy, for example while investigating something else:

```bash
cdkd deploy MyStack --pin-cc-api MyTopic
```

The flag applies to that deploy only. A resource of a type Cloud Control
cannot manage correctly moves back regardless, logs a different line and
ignores `--pin-cc-api`. See [Provisioning Layers](provisioning-layers.md).

### deleting a Cognito `Policies` sub-key changes nothing on the pool

You remove `Policies.SignInPolicy` from an `AWS::Cognito::UserPool`, typically
to revoke a passwordless first-auth factor such as `EMAIL_OTP`. The deploy
succeeds, but the pool still allows it, and `cdkd drift` and `cdkd diff` report
nothing. The same happens for `Policies.PasswordPolicy` and for deleting the
whole `Policies` block.

The only signal is a warning on the deploy that carries the removal. It
begins:

```text
UserPool us-east-1_xxxxxxxxx: the desired configuration no longer declares
Policies.SignInPolicy, and no UpdateUserPool input can express that removal
```

`UpdateUserPool` treats an omitted `Policies` sub-key as "keep the live value".
No input expresses a removal, and CloudFormation behaves the same on the same
edit. `cdkd drift` is silent because the deploy refreshes its baseline from
the live pool, which still holds the sub-key.

Declare the sub-key with the configuration you want instead of deleting it:

```yaml
Policies:
  SignInPolicy:
    AllowedFirstAuthFactors:
      - PASSWORD          # revokes EMAIL_OTP by stating the intended set
```

The AWS defaults are `AllowedFirstAuthFactors: [PASSWORD]` for `SignInPolicy`.
For `PasswordPolicy` they are `MinimumLength: 8`, every character-class
requirement enabled, and `TemporaryPasswordValidityDays: 7`.

A related refusal: if the same edit sets `MfaConfiguration: ON` while the
retained list still allows `EMAIL_OTP` or `SMS_OTP`, the deploy is refused
before any change is sent, with a message naming the pool's live
`AllowedFirstAuthFactors`. `WEB_AUTHN` is refused the same way unless
`WebAuthnFactorConfiguration` is `MULTI_FACTOR_WITH_USER_VERIFICATION`. The fix
is the same explicit declaration.

## Assets

### "Asset publishing failed"

A denied S3 upload surfaces as the AWS SDK's own error:

```
AccessDenied: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::cdkd-assets-123456789012-us-east-1/abc123.zip"
```

The check that runs before the upload names the bucket and key:

```
Error: Failed to check S3 object s3://cdkd-assets-123456789012-us-east-1/abc123.zip: AccessDenied: Access Denied
```

Docker image assets raise `AssetError`:

```
AssetError: ECR login failed: <docker output>
AssetError: Docker push failed: <docker output>
AssetError: Refusing to publish a Docker image asset: the destination region <region> is not a valid AWS region id
AssetError: Refusing to publish a Docker image asset: <account> is not a 12-digit AWS account id
```

| Cause | Fix |
| --- | --- |
| The asset bucket or ECR repository does not exist | [Create the asset storage](#create-the-asset-storage) |
| The identity cannot write to it | [Grant the publishing permissions](#grant-the-publishing-permissions) |
| A `Refusing to publish` error | [Fix the Docker asset's region or account](#fix-the-docker-asset-s-region-or-account) |

#### Create the asset storage

```bash
cdkd bootstrap --region us-east-1
```

`cdkd bootstrap` creates the state bucket and cdkd's own asset storage for the
region: the `cdkd-assets-*` bucket and the `cdkd-container-assets-*` ECR
repository. No `cdk bootstrap` is needed.

The first `cdkd deploy` into a region normally creates this storage by
itself. So this error usually means the auto-create was turned off
(`--no-auto-asset-storage`), failed (look for its warning in the deploy
output), or someone deleted the bucket or repository afterwards.

A region without cdkd's storage publishes to the destinations in the asset
manifest, which is the CDK bootstrap bucket (`cdk-hnb659fds-assets-*`). The
same happens when `--use-cdk-bootstrap-assets` or `cdk.json`
`context.cdkd.useCdkBootstrapAssets` is set. cdkd does not create that bucket:

```bash
npx cdk bootstrap aws://123456789012/us-east-1
```

A custom bootstrap qualifier works: cdkd reads the destinations from the
manifest. See [`cdkd bootstrap`](cli-bootstrap.md).

To deploy without publishing assets:

```bash
cdkd deploy MyStack --skip-assets
```

#### Grant the publishing permissions

cdkd publishes with the caller's credentials. It never assumes CDK's
`cdk-hnb659fds-file-publishing-role-*`. Adjust the bucket ARN if the region
was bootstrapped with a custom `--asset-bucket` name.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FileAssetObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-123456789012-*/*",
        "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-*/*"
      ]
    },
    {
      "Sid": "FileAssetBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-123456789012-*",
        "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-*"
      ]
    },
    {
      "Sid": "EcrAuthTokenMustBeStar",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "DockerAssetRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": [
        "arn:aws:ecr:*:123456789012:repository/cdkd-container-assets-*",
        "arn:aws:ecr:*:123456789012:repository/cdk-hnb659fds-container-assets-*"
      ]
    }
  ]
}
```

Three parts of that policy are easy to get wrong:

- `ecr:GetAuthorizationToken` works only on `"Resource": "*"`. It cannot be
  narrowed to a repository ARN.
- The layer-upload actions are needed although cdkd makes no SDK call for
  them. The push is a `docker push` authenticated with a token minted from
  your credentials.
- `s3:ListBucket` goes on the bucket ARN, not the `/*` object ARN. The storage
  check before the upload needs it, and without it the deploy fails before any
  upload.

The identity that creates the storage needs more. That is `cdkd bootstrap`,
and also the first `cdkd deploy` into a region unless you pass
`--no-auto-asset-storage`:

```json
{
  "Sid": "CreateAssetStorage",
  "Effect": "Allow",
  "Action": [
    "s3:CreateBucket",
    "s3:PutEncryptionConfiguration",
    "s3:PutBucketPublicAccessBlock",
    "s3:PutBucketPolicy",
    "ecr:CreateRepository",
    "ecr:PutImageTagMutability"
  ],
  "Resource": [
    "arn:aws:s3:::cdkd-assets-123456789012-*",
    "arn:aws:ecr:*:123456789012:repository/cdkd-container-assets-*"
  ]
}
```

Without it the auto-create fails, the deploy warns and publishes to the CDK
bootstrap bucket instead, and the upload then fails if that bucket does not
exist.

#### Fix the Docker asset's region or account

cdkd refuses to publish when it cannot build a safe ECR registry host,
because the ECR password would be sent to that host.

- **Region**: it comes from `<StackName>.assets.json` in `cdk.out`, under
  `dockerImages.<hash>.destinations.<id>.region`. It must be a plain region id
  such as `us-east-1`. Fix the stack's `env.region` and re-synthesize.
- **Account**: it comes from your credentials
  (`aws sts get-caller-identity`), or from `accountId` when you call cdkd as a
  library, and must be the 12-digit id.

## Destroying a stack

### "bucket is not empty" / "still contains images" on destroy

```text
Failed to delete S3 bucket MyBucket: bucket my-bucket is not empty. Matching
CloudFormation, cdkd does not delete a non-empty bucket unless it opted into
automatic emptying (CDK's autoDeleteObjects: true, i.e. the
'aws-cdk:auto-delete-objects' tag).
```

```text
Failed to delete S3 Express Directory Bucket my-bucket--use1-az4--x-s3: bucket
my-bucket--use1-az4--x-s3 is not empty. Matching CloudFormation, cdkd does not
delete a non-empty directory bucket without an explicit opt-in.
```

```text
Failed to delete ECR Repository MyRepo: repository my-repo still contains
images. Matching CloudFormation, cdkd does not force-delete an image-carrying
repository unless it opted in via EmptyOnDelete: true (CDK's emptyOnDelete) or
the 'aws-cdk:auto-delete-images' tag (CDK's autoDeleteImages).
```

Like CloudFormation, `cdkd destroy` does not delete a bucket that still holds
objects or a repository that still holds images, unless the resource opted in.

Either opt in from the CDK app, redeploy, then destroy:

| Resource | Opt-in |
| --- | --- |
| S3 bucket | `autoDeleteObjects: true` with `removalPolicy: RemovalPolicy.DESTROY` |
| S3 Express directory bucket | The tag on the L1: `tags: [{ key: 'aws-cdk:auto-delete-objects', value: 'true' }]` |
| ECR repository | `emptyOnDelete: true`, or the older `autoDeleteImages: true` |

Or empty the data by hand and re-run the destroy:

```bash
aws s3 rm s3://my-bucket --recursive   # a versioned bucket also needs its versions and delete markers removed
aws ecr batch-delete-image --repository-name my-repo \
  --image-ids "$(aws ecr list-images --repository-name my-repo --query 'imageIds' --output json)"
```

[Destroy flags & guards](cli-destroy.md) has the full rules.

### "has DeletionPolicy: Snapshot, but ..." refusal on delete

```text
MyDb (AWS::RDS::DBInstance) has DeletionPolicy: Snapshot, but the resource is
managed via the Cloud Control API route (provisionedBy: cc-api), which has no
final-snapshot delete parameter — deleting it now would destroy its data WITHOUT
the final snapshot the policy promises.
```

cdkd takes a final snapshot before deleting a `DeletionPolicy: Snapshot`
resource, as CloudFormation does. It refuses the delete only when it cannot
take one: the resource is managed through the Cloud Control API, whose delete
has no final-snapshot parameter, or the template puts `Snapshot` on a type that
does not support it.

Take the snapshot yourself, then do one of:

- Re-run with `--skip-final-snapshot`, which deletes without a snapshot.

  ```bash
  aws rds create-db-snapshot --db-instance-identifier mydb --db-snapshot-identifier mydb-final
  cdkd destroy MyStack --skip-final-snapshot
  ```

- Change the policy to `Retain` and delete the resource by hand afterwards.

[Destroy flags & guards](cli-destroy.md) has the per-type behaviour.

### "Backing Lambda for custom resource X no longer exists" on destroy

```
Backing Lambda for custom resource X no longer exists (arn:aws:lambda:...), so its Delete handler cannot be invoked and cdkd cannot confirm the resource was deleted; skipping deletion — anything this custom resource manages may still be LIVE.
```

The row reads `skipped (backing Lambda function is gone — Delete handler not
invoked)`, the state record is kept, and `cdkd destroy` exits `2`.

The function named by the custom resource's `ServiceToken` is gone, so its
Delete handler cannot run and cdkd cannot tell whether what it manages still
exists. The two usual routes are a shared provider stack destroyed before the
stacks that use it, and an earlier destroy that skipped this resource and then
deleted the function in the same run.

- **The function can come back at the same ARN** (redeploy the shared provider
  stack): do that, then re-run `cdkd destroy`.
- **It cannot**: confirm by hand that what the handler manages is gone, or
  tear it down. Then drop the stack's records:

  ```bash
  cdkd state orphan MyStack --stack-region us-east-1
  ```

  This drops every record for the stack in that region, not only this one.

During a `cdkd deploy` the same situation only warns and drops the record,
because CloudFormation ignores delete failures in an update's cleanup phase.

### destroy reports `N skipped` and exits 2

```text
⚠ MyGlueTable (AWS::Glue::Table) skipped (malformed physicalId in state — no delete issued)
⚠ Stack MyStack partially destroyed (4 deleted, 1 skipped, 0 errors). cdkd did not confirm the skipped resource(s) were deleted, so they may still exist in AWS.
```

The state record's `physicalId` does not have the shape cdkd needs to address
the resource. Some types need more than one value, so cdkd joins them with `|`
(`<databaseName>|<tableName>` for `AWS::Glue::Table`,
`<apiId>|<typeName>|<fieldName>` for `AWS::AppSync::Resolver`). A hand-edited
`state.json` or a record from an older cdkd can have the wrong number of
segments.

cdkd issued no AWS call for that resource, so it may still exist. It keeps the
state record, because without it you would have neither the resource deleted
nor an id to delete it with. The warning for each resource names the shape it
expected.

Inspect the record, then fix it one of two ways:

```bash
cdkd state show MyStack
```

- **Repair the id and re-run.**

  ```bash
  aws s3 cp s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json .
  # edit the record: "physicalId": "mydb|mytable"
  aws s3 cp state.json s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
  cdkd destroy MyStack
  ```

- **Delete the resource by hand and drop the record.**

  ```bash
  aws glue delete-table --database-name mydb --name mytable
  cdkd state orphan MyStack   # removes state only, never AWS resources
  ```

Do not re-run with the record deleted and the resource still in AWS. That
leaves the resource with nothing tracking it.

### Known Leftover: EFS Automatic Backups

A successful `cdkd destroy` of an `AWS::EFS::FileSystem` deletes the file
system but not the AWS Backup recovery points taken while it existed. With
automatic backups on (`BackupPolicy: { Status: ENABLED }`), they stay in the
vault `aws/efs/automatic-backup-vault` for the 35-day default retention. They
remain restorable and are billed.

List and delete them with `aws backup list-recovery-points-by-backup-vault`
and `aws backup delete-recovery-point`. "EFS automatic backups survive
destroy" in [Supported Resources](supported-resources.md) has the full
commands.

### Known Leftover: FSx Final Backups

A successful `cdkd destroy` of an `AWS::FSx::FileSystem` can leave a billed
final backup. cdkd calls `DeleteFileSystem` with the API defaults, as
CloudFormation does, and those take a final backup for Windows and ONTAP file
systems (observed on OpenZFS too).

The backup is usually untagged, so find it by its `FileSystem.FileSystemId`
with `aws fsx describe-backups`, and remove it with `aws fsx delete-backup`.
"FSx final backup on destroy" in [Supported Resources](supported-resources.md)
has the full commands.

## After a failed or interrupted deploy

By default cdkd rolls a failed deploy back. With `--no-rollback`, after
{kbd:ctrl+c}, or when the rollback itself dies, the stack is left partly
deployed, and cdkd keeps the state it saved plus a rollback journal recording
which operations completed. [Rollback](rollback.md) describes the mechanism.

```text diagram=troubleshooting-after-failed-deploy
                  ┌────────────────────────────┐
                  │ Deploy fails or is stopped │
                  └──────┬──────────────┬──────┘
                         ▼              ▼
  ┌─────────────────────────┐  ┌──────────────────────────────────┐
  │ Automatic rollback      │  │ --no-rollback, Ctrl+C, or a      │
  │ (default)               │  │ rollback that died               │
  │ Reverts what the deploy │  │ Partial state and a journal are  │
  │ completed               │  │ kept                             │
  └─────────────────────────┘  └────┬───────────┬───────────┬─────┘
                                    ▼           ▼           ▼
                        ┌─────────────┐ ┌───────────────┐ ┌──────────────┐
                        │ cdkd deploy │ │ cdkd rollback │ │ cdkd destroy │
                        │ Fix forward │ │ Revert        │ │ Clean up     │
                        └─────────────┘ └───────────────┘ └──────────────┘
```

An orphaned resource is one that exists in AWS but is in no cdkd state file.
cdkd saves state after every completed resource, so orphans are rare. They
come from a create that was in flight when the process was killed, from a
resource a rollback retained, and from the ambiguous server errors under
[Possible duplicates after a server error](#possible-duplicates-after-a-server-error).

### Reverting a failed `--no-rollback` / interrupted deploy: `cdkd rollback`

```bash
cdkd rollback MyStack                        # revert to the pre-deploy state
cdkd rollback MyStack --yes                  # skip the confirmation (--force also works)
cdkd rollback MyStack --revert-failed        # also revert the resource that failed mid-deploy
cdkd rollback MyStack --orphan MyQueue       # leave one resource alone (repeatable)
cdkd rollback MyStack --stack-region us-west-2
```

`cdkd rollback` replays the rollback journal, with no synth and no CDK app.
The prompt refuses a non-interactive stdin, so CI needs `--yes` or `--force`.

| Outcome | Meaning | Do |
| --- | --- | --- |
| Exit `2`, journal kept | One or more operations failed | Re-run `cdkd rollback`; already-reverted resources are skipped |
| Exit `2`, an operation skipped with a warning | It cannot be reverted (its physical id changed, or the delete is unrecoverable) | Read the `ROLLBACK_RESOURCE_SKIPPED` event with `cdkd events MyStack` |
| Exit `2`, a reverted operation left a resource cdkd no longer tracks | A copy retained by `UpdateReplacePolicy: Retain`, or one whose delete failed | Its `ROLLBACK_RESOURCE_SUCCEEDED` event carries the id and a `reason` |
| `Nothing to roll back` | No journal: a later deploy succeeded, or the process was killed before writing it | `cdkd deploy` to resume, or `cdkd destroy` to clean up |

A resource whose properties use `{{resolve:secretsmanager:...}}`, or
`{{resolve:ssm:...}}` pointing at a SecureString, is stored as the reference.
Reverting it resolves the reference again during the rollback. If the secret
was deleted or your credentials can no longer read it, that revert fails with
exit `2` and the journal kept. Restore access and re-run, or skip the resource
with `--orphan`.

Storing the reference is a redaction pass, not a guarantee. Treat a secret
that was ever persisted in plaintext as compromised and rotate it.

See [`cdkd rollback`](cli-rollback.md) for every flag and the known
limitations.

### Detecting Orphaned Resources

List what cdkd tracks, then compare it with AWS:

```bash
cdkd state list                         # which stacks have state
cdkd state resources MyStack            # LogicalID, Type, PhysicalID
cdkd state resources MyStack --json     # machine-readable
cdkd state show MyStack                 # the full record, including properties
```

```bash
aws cloudcontrol list-resources --type-name AWS::S3::Bucket
aws cloudcontrol list-resources --type-name AWS::Lambda::Function
```

Pass `--stack-region <region>` when the same stack name has state in more than
one region.

### Recovering from Orphaned Resources

If state was saved, which is the usual case, run `cdkd deploy` again. Existing
resources are in state and are handled as updates or no-ops.

If a resource exists in AWS without a state record, adopt it. Do not delete
`state.json`, and do not edit it by hand.

::: steps
1. See what cdkd tracks

   ```bash
   cdkd state resources MyStack
   ```

2. Preview the adoption

   ```bash
   cdkd import MyStack --dry-run   # writes no state
   ```

3. Adopt

   ```bash
   cdkd import MyStack
   cdkd import MyStack --resource MyBucket=mystack-mybucket   # anything reported "not found"
   ```
:::

Read a resource's exact name off AWS instead of constructing it. A name cdkd
generates is `<StackName>-<LogicalId>` only when that fits the type's length
limit. Otherwise cdkd truncates it and appends `-` plus 8 hex characters. A
`--resource` import merges into existing state and needs no `--force` while
the resource is absent from it.

To start over instead, delete the resources through cdkd:

```bash
cdkd state destroy MyStack --yes   # deletes the AWS resources AND the state
cdkd deploy MyStack
```

#### A rollback left a `Retain` resource behind

A resource carrying `DeletionPolicy: Retain` stays in AWS when a deploy rolls
back, and its state record is dropped, as with CloudFormation. With cdkd the
next deploy then fails with an already-exists error. cdkd's generated names
have no random part, so the deploy asks for the name the retained resource
still holds. Re-running does not clear it.

When the colliding name is one cdkd generated, the failure is followed by a
message that ends with the adoption command on its own line:

```text
ApiGatewayAccountCloudWatchRole: the name AWS reports as taken (mystack-apigatewayaccountcl-19184149) is one cdkd DERIVED from the logical id, and that derivation has no random component — so this is most likely a resource an earlier cdkd run left behind.
Adopt with: cdkd import MyStack --resource 'ApiGatewayAccountCloudWatchRole=mystack-apigatewayaccountcl-19184149'
```

The same message covers a resource the failing create made itself, when an
earlier attempt ended without a clear verdict and the retry found the name
taken. It then opens with `... is most likely held by a resource THIS create
made`. That resource is in no state file, so no rollback or `cdkd destroy`
removes it.

> [!IMPORTANT]
> Confirm the resource is yours before adopting it. A generated name is
> predictable. For a globally unique name it can belong to another account,
> and the same stack in another region generates the same name. Importing
> that leaves two stacks sharing one resource.

If you do not want to keep the resource, delete it in AWS after confirming it
holds nothing you need, then re-deploy.

cdkd tells you to delete instead of printing the import command in three
cases: the type cannot be imported, the resource is in a nested stack, or its
name contains characters that would change what the printed command means. A
name holding whitespace or shell characters is printed as a quoted placeholder
(`'<stack>'`, `'<logicalId=physicalId>'`) to replace with your own quoted
value.

## Possible duplicates after a server error

Some AWS create calls carry no idempotency token. When one fails with HTTP
500 / 502 / 503 / 504, AWS may have created the resource and lost only the
response, and a retry then creates a second one or collides with the first.

For the calls below cdkd turns off the AWS SDK's own retry of a 5xx. Before
its own retry it looks for what the failed attempt may have made, and reports
each candidate as a warning with a read command. It never adopts or deletes a
candidate, and then creates the resource again.

What to do with such a warning:

1. Inspect each id with the read command the warning gives.
2. Delete it only after confirming it is this deploy's orphan and not another
   deploy's resource.

Four things apply to every warning below:

- **A reset connection or a timeout** is as ambiguous as a 5xx, and the AWS
  SDK retries it inside one call. If that retry also fails, cdkd looks before
  its own retry as above. If it succeeds, cdkd looks right after the create
  and the warning says the call "succeeded only after the AWS SDK sent it
  again". It never names the resource the create returned.
- **A clean lookup is not proof.** The list APIs are eventually consistent, so
  a duplicate may not be listed yet.
- **Without the lookup permission** cdkd warns that it could not look, and the
  deploy proceeds.
- **Some types report no creation time** (AppSync, API Gateway authorizers and
  integrations, the EC2 lookups). A candidate of such a type may be another
  stack's resource of the same name, and the warning says so. A throttled
  request the SDK retried triggers the same lookup, and for these types it can
  name an unrelated resource.

### A warning that a KMS key, Cognito user pool or AppSync API may be an orphan

| Call | Candidate cdkd reports | Read command | Lookup permission |
| --- | --- | --- | --- |
| `CreateKey` | A key with the same settings, created during the failed attempt | `describe-key` | `kms:ListKeys`, `kms:DescribeKey` |
| `CreateUserPool` | A pool with the same name, created during the failed attempt | `describe-user-pool` | `cognito-idp:ListUserPools` |
| `CreateGraphqlApi` | An API with the same name that this deploy did not record | `get-graphql-api` | `appsync:ListGraphqlApis` |
| `CreateApiKey` | A key on the same API with the same description that this deploy did not record | `list-api-keys` | `appsync:ListApiKeys` |

- After the warning a user pool name is shared by two pools. Before deleting
  one, check that it has no users, that it was created during the failed
  attempt, and that it carries no tags another stack sets.
- A KMS key cannot be deleted at once. `aws kms schedule-key-deletion` puts it
  in a 7-to-30-day pending window.
- An AppSync API key's id is the credential clients send, so the warning names
  a key only by its last four characters and its expiry. Find it in the
  `list-api-keys` output.

A related KMS warning, "KMS key ... was created for ..., but a follow-up call
failed", means `CreateKey` succeeded and a later call on the key
(`EnableKeyRotation`, `DisableKey`) did not. The retry reuses that key, so
leave it alone while the deploy is running. Only if the deploy then fails is
the key left out of cdkd state.

### A warning that an API Gateway API, authorizer, integration or deployment may be an orphan

The calls are `CreateAuthorizer` and `CreateDeployment` (REST API), and
`CreateApi`, `CreateIntegration` and `CreateAuthorizer` (HTTP / WebSocket API).

| Candidate cdkd reports | Delete command in the warning |
| --- | --- |
| An API with the same name and protocol, created during the failed attempt | Yes |
| A deployment of the same REST API with the same description, created during the failed attempt | Yes |
| An authorizer with the same name and type in the same API that this deploy did not record | No |
| An integration with the same type and URI in the same API that this deploy did not record | No |

An orphaned authorizer, integration or deployment is deleted with its API.
The lookup needs `apigateway:GET` on the API, or on the API list for
`CreateApi`.

### A warning that an EMR cluster, instance fleet or instance group may be an orphan

The calls are `RunJobFlow`, `AddInstanceFleet` and `AddInstanceGroups`. A
duplicate here is billed per instance-hour.

| Candidate cdkd reports | Commands in the warning |
| --- | --- |
| A cluster with the same name, created during the failed attempt, not terminating or terminated | `aws emr describe-cluster`, then `aws emr terminate-clusters` |
| A TASK instance fleet or group with the same name in the same cluster (any name, when the template sets none) | `list-instance-fleets` / `list-instance-groups`, then `modify-instance-fleet` / `modify-instance-groups` to scale it to zero |

- EMR cannot remove a fleet or group from a running cluster. Scaling it to
  zero stops the billing, and it goes away with its cluster.
- A candidate cluster with termination protection needs
  `modify-cluster-attributes --no-termination-protected` first. The warning
  does not chain that command, since the cluster may be another deploy's.
- A MASTER or CORE fleet or group is not looked up: a cluster holds at most
  one of each.

The cluster lookup needs `elasticmapreduce:ListClusters`.

### A warning that a Lambda layer version or event source mapping may be an orphan

| Call | Candidate cdkd reports | Commands in the warning | Lookup permission |
| --- | --- | --- | --- |
| `PublishLayerVersion` | A version of the same layer published during the failed attempt | `aws lambda get-layer-version`, then `aws lambda delete-layer-version` | `lambda:ListLayerVersions` |
| `CreateEventSourceMapping` | A mapping between the same function and event source that this deploy did not record | `aws lambda get-event-source-mapping`; no delete command | `lambda:ListEventSourceMappings` |

For a self-managed Kafka source the mapping is matched on the function only.
A mapping last modified before the failed attempt is not reported.

Where Lambda refuses a second mapping between the same function and source, as
it does for an SQS queue, the retry fails with `ResourceConflictException`
naming the orphan's UUID. Confirm the mapping is this deploy's, delete it and
re-run the deploy:

```bash
aws lambda delete-event-source-mapping --uuid <uuid>
```

### A warning that a DLM lifecycle policy or ECS task definition revision may be an orphan

| Call | Candidate cdkd reports | Commands in the warning | Lookup permission |
| --- | --- | --- | --- |
| `CreateLifecyclePolicy` | A policy with the same description and the same default or custom kind, created during the failed attempt, that this deploy did not record | `aws dlm get-lifecycle-policy`, then `aws dlm delete-lifecycle-policy` | `dlm:GetLifecyclePolicies`, `dlm:GetLifecyclePolicy` |
| `RegisterTaskDefinition` | An ACTIVE revision of the same family, registered during the failed attempt, that this deploy did not register | `aws ecs describe-task-definition`, then `aws ecs deregister-task-definition` | `ecs:ListTaskDefinitions`, `ecs:DescribeTaskDefinition` |

A policy with no description matches a create with none. Run the second
command only after confirming the candidate is this deploy's: another deploy
can create a policy with the same description, or register a revision of the
same family, in the same window.

### A warning that an EC2 VPC, subnet, internet gateway or Elastic IP may be an orphan

cdkd tags these resources only after the create returns, so an orphan has no
tags. It reports each untagged match this deploy did not record:

| Call | Candidate cdkd reports | Read command | Lookup permission |
| --- | --- | --- | --- |
| `CreateVpc` | A VPC with the same CIDR that is not a default VPC | `describe-vpcs` | `ec2:DescribeVpcs` |
| `CreateSubnet` | A subnet with the same CIDR in the same VPC | `describe-subnets` | `ec2:DescribeSubnets` |
| `CreateInternetGateway` | An internet gateway attached to no VPC | `describe-internet-gateways` | `ec2:DescribeInternetGateways` |
| `AllocateAddress` | An Elastic IP of the same domain, associated with nothing | `describe-addresses` | `ec2:DescribeAddresses` |

EC2 reports no creation time for these, so the warning gives no delete
command. For an Elastic IP the match also considers the network border group
or pool when the template sets one. An unassociated Elastic IP is billed until
released.

Two creates fail on the retry instead of duplicating:

- **Subnet.** A CIDR cannot repeat in a VPC, so the retry fails with
  `InvalidSubnet.Conflict`. Confirm the subnet the warning named is this
  deploy's, delete it and re-run:

  ```bash
  aws ec2 delete-subnet --subnet-id <id>
  ```

- **Security group.** A name cannot repeat in a VPC, so a replayed
  `CreateSecurityGroup` fails with `InvalidGroup.Duplicate`. No lookup runs
  for it.

### `EntityAlreadyExists` on an IAM create after a server error

`CreateRole`, `CreateUser`, `CreateGroup`, `CreateInstanceProfile` and
`CreatePolicy` failed with a 5xx although IAM had created the entity, so
cdkd's retry fails with `EntityAlreadyExists` against it. For a name cdkd
generated, the error says the entity is most likely what this create's earlier
attempt made.

That entity is in no state file. Confirm it is this deploy's, then either
adopt it or delete it, and re-run the deploy:

```bash
cdkd import MyStack --resource MyRole=mystack-myrole   # adopt
aws iam delete-role --role-name mystack-myrole          # or delete
```

After a reset connection or a timeout the request may never have reached IAM,
so the holder can be another resource. Confirm before deleting or importing.

#### Access keys

`CreateAccessKey` is handled differently, because a duplicate key is a
credential whose secret nobody received.

- After a failure, cdkd lists the user's keys and deletes the one that attempt
  minted: a key the user did not have before, created after the attempt
  started, and not recorded by this process. It then creates a new key.
- After an SDK retry that succeeded following a reset or timeout, it does the
  same right after the create and keeps the key the create returned. It does
  not do this after a throttle or a refused connection, which minted nothing.
- A key it declines to delete is reported as a warning with the
  `aws iam delete-access-key` command.

`ListAccessKeys` is eventually consistent. A key IAM does not list yet is
neither deleted nor reported, and the retry mints a second one. After such a
failure, compare the user's keys with the key in cdkd state:

```bash
aws iam list-access-keys --user-name my-user
cdkd state show MyStack
```

### An "already exists" on a Lambda, EventBridge bus or ECR create after a server error

The create failed with a 5xx although AWS had created the resource, so cdkd's
retry fails against it. For a name cdkd generated, the error says the
resource is most likely what this create's earlier attempt made.

| Call | Error on the retry | Delete with |
| --- | --- | --- |
| `CreateFunction` | `ResourceConflictException` | `aws lambda delete-function` |
| `CreateFunctionUrlConfig` | `ResourceConflictException` | `aws lambda delete-function-url-config` |
| `AddPermission` | `ResourceConflictException` | `aws lambda remove-permission` |
| `CreateEventBus` | `ResourceAlreadyExistsException` | `aws events delete-event-bus` |
| `CreateRepository` | `RepositoryAlreadyExistsException` | `aws ecr delete-repository` |

That resource is in no state file. Confirm it is this deploy's, then delete it
or adopt it with `cdkd import`, and re-run the deploy.

After a reset connection or a timeout the request may never have reached the
service, so the holder can be another resource. Confirm before deleting or
importing.

### `DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for

A `CreateDistribution` answered with a 5xx, cdkd retried it, and CloudFront
refused the retry. The first request had succeeded and only its response was
lost. cdkd sends the same `CallerReference` on every attempt of one create, so
CloudFront refuses the replay instead of creating a second distribution.

The deploy fails and the first attempt's distribution is live, in no state
file. CloudFront offers no way to adopt it, so the cleanup is manual.

::: steps
1. Find the distribution by its origin domain or comment

   ```bash
   aws cloudfront list-distributions \
     --query "DistributionList.Items[].{Id:Id,Status:Status,Enabled:Enabled,Domain:DomainName,Origins:Origins.Items[].DomainName,Comment:Comment}"
   ```

   Do not filter with `contains(Origins.Items[0].DomainName, ...)`. JMESPath
   raises a TypeError on any distribution that has no origins.

2. Disable it and wait for the change to deploy (typically about 15 minutes)

   ```bash
   aws cloudfront get-distribution-config --id <ID>    # note the ETag; set Enabled=false in the config
   aws cloudfront update-distribution --id <ID> --if-match <ETag> --distribution-config file://disabled.json
   aws cloudfront wait distribution-deployed --id <ID>
   ```

3. Delete it

   ```bash
   aws cloudfront delete-distribution --id <ID> --if-match <NewETag>
   ```

4. Re-run the deploy

   ```bash
   cdkd deploy MyStack
   ```

   The next run uses a fresh caller reference, so it does not collide with the
   deleted distribution.
:::

## Proxy / Corporate Network

### "self-signed certificate in certificate chain" on the very first command

```
$ cdkd bootstrap --profile my-sso-profile
Starting cdkd bootstrap...
No --state-bucket specified, resolving default bucket name...
CredentialsProviderError: Error: self-signed certificate in certificate chain
```

On a network whose only way out is a corporate proxy, this usually means cdkd
is not using the proxy. The direct route is the one that gets intercepted, so
cdkd sees the interceptor's certificate instead of Amazon's.

cdkd honours the proxy environment variables. Export them in the shell that
runs cdkd:

```bash
export HTTPS_PROXY=http://proxy.corp.example:8080
cdkd bootstrap --profile my-sso-profile
```

The AWS CLI and `npm` working in the same shell does not prove the environment
carries a proxy. They can be configured through `~/.aws/config` and `~/.npmrc`.

If the error survives correct variables, the proxy terminates TLS: see
[A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`](#a-tls-terminating-proxy-still-needs-node-extra-ca-certs).

### Variables cdkd honours

| Variable | Effect |
| --- | --- |
| `HTTPS_PROXY` / `https_proxy` | Proxy for `https://` requests, which is all AWS traffic in practice |
| `HTTP_PROXY` / `http_proxy` | Proxy for plain `http://` requests |
| `ALL_PROXY` / `all_proxy` | Fallback for either scheme |
| `NO_PROXY` / `no_proxy` | Hosts to reach directly, bypassing the proxy |

- **Spelling.** Both work, and the lower-case one wins where both are set.
  Other tools differ, so do not rely on the two agreeing.
- **Scheme.** Always include it: `HTTPS_PROXY=http://proxy.corp.example:8080`.
  The scheme says how to reach the proxy, not what is being proxied. A value
  without one inherits the request's scheme, so cdkd speaks TLS to the proxy
  and fails with an error that names neither the variable nor the scheme.
- **Per request.** `HTTPS_PROXY` and `HTTP_PROXY` may name different proxies.
- **Whitespace only.** cdkd refuses to start and names the variable. Unset it
  or give it a URL.

### `NO_PROXY` matching is EXACT, unlike curl

An entry that does not start with `.` or `*` matches only that exact
hostname. curl treats a bare entry as a suffix; cdkd does not.

| `NO_PROXY` | `example.com` | `api.example.com` |
| --- | --- | --- |
| `example.com` | direct | **proxied** |
| `.example.com` | **proxied** | direct |
| `*.example.com` | **proxied** | direct |
| `example.com,.example.com` | direct | direct |

Covering a domain and its subdomains takes two entries. For a VPC-endpoint
setup that sends AWS traffic direct:

```bash
export NO_PROXY=.amazonaws.com,amazonaws.com
```

| Entry | Behaviour |
| --- | --- |
| A CIDR range (`10.0.0.0/8`) | Ignored without a warning; list IP addresses literally (`10.1.2.3`) |
| A trailing wildcard (`172.16.*`) | Does not work; only a leading `*` is a wildcard |
| A lone `*` | Bypasses the proxy for every host |
| An entry with a port (`example.com:443`) | Applies to that port only |

Entries may be separated by commas or whitespace, and matching is
case-insensitive. Instance-metadata (IMDS) and ECS container credentials
always bypass the proxy, so no entry for `169.254.169.254` is needed.

### A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`

A proxy that opens a CONNECT tunnel passes Amazon's own certificate through,
and needs no extra CA. A proxy that terminates TLS presents its own
certificate, and cdkd must be told to trust it:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem
```

The file must be PEM and readable by the cdkd process. This is a Node.js
variable, so it does not affect the AWS CLI, which uses `AWS_CA_BUNDLE`.

### The Docker daemon has its own egress

`cdkd deploy` builds and pushes container image assets through the Docker
daemon, and `cdkd local` runs containers through it. The daemon is a separate
process, and the variables above do not reach it.

If image pulls or pushes fail behind a proxy while everything else works,
configure the daemon and restart it:

- Linux: a systemd drop-in with `Environment="HTTPS_PROXY=..."`.
- Docker Desktop: Settings → Resources → Proxies.

### Verifying that traffic is routed

Point cdkd at a proxy that cannot work. If the variable is honoured, the
command fails. If it succeeds anyway, the variable is not reaching the
process:

```bash
HTTPS_PROXY=http://127.0.0.1:1 cdkd state list --profile my-profile
```

## Frequently Asked Questions (FAQ)

### Q: Is a CloudFormation stack created?

No. `cdkd deploy` provisions each resource directly, through an SDK provider
or the Cloud Control API. There is no CloudFormation stack, change set or
stack events. The equivalents are `cdkd state show` and `cdkd events`. See
[Provisioning Layers](provisioning-layers.md).

Two cases do touch CloudFormation:

- A template declaring a macro (`Transform` / `Fn::Transform`, for example
  SAM) is expanded by CloudFormation. cdkd creates a temporary
  `cdkd-macro-expand-*` stack, reads the processed template and deletes the
  stack before provisioning anything.
- [`cdkd export`](cli-export.md) creates a real CloudFormation stack, because
  that is how it hands a stack over.

### Q: Can I use CloudFormation and cdkd for the same stack?

One stack has one owner at a time, and you can hand it over in either
direction. The AWS resources are not changed by either.

```bash
cdkd import MyStack --migrate-from-cloudformation   # CloudFormation -> cdkd
cdkd export MyStack --dry-run                       # cdkd -> CloudFormation: print the plan
cdkd export MyStack
```

- **To cdkd**: the import adopts the resources and retires the CloudFormation
  stack record. It needs a CDK app that synthesizes the stack. Nested stacks
  are walked recursively. See [Importing Existing Resources](import.md).
- **To CloudFormation**: the export builds an IMPORT change set, executes it
  and deletes cdkd state. It is all-or-nothing. It refuses up front on a
  resource with no state entry, a masked value in the recorded properties, a
  type CloudFormation cannot import, or a custom resource without
  `--include-non-importable`. See [`cdkd export`](cli-export.md).

Different stacks can stay on different engines. A cdkd-deployed stack resolves
`Fn::ImportValue` / `Fn::GetStackOutput` against a CloudFormation-managed
producer with no change on the producer side.

### Q: What happens if I delete the state file?

cdkd no longer knows any of the stack's resources, so the next `cdkd deploy`
plans every one as a create. What happens then depends on the type:

| Types | Result of the create |
| --- | --- |
| Most types | Fails with an already-exists error |
| `AWS::S3::Bucket`, `AWS::Logs::LogGroup`, `AWS::SNS::Topic` | Adopts the existing resource and re-applies your configuration over it |
| Types with an AWS-assigned id: VPC, EC2 instance, ACM certificate, CloudFront distribution | Creates a second resource and orphans the first, once per attempt |

Do not delete the AWS resources. Adopt them back:

```bash
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

`cdkd import` finds each resource by the name in the template, then through a
CloudFormation stack of the same name. A resource whose name cdkd generated
has no name in the template and is reported `not found`. Name those
explicitly, copying the name AWS reports:

```bash
cdkd import MyStack --resource MyBucket=mystack-mybucket
```

A generated name is `<StackName>-<LogicalId>` when that fits the type's length
limit. Otherwise it is truncated with `-` and 8 hex characters appended
(`mystack-averylongconstructna-19184149`). See
[Importing Existing Resources](import.md).

### Q: Is there a rollback feature?

Yes. cdkd rolls back on failure by default. `--no-rollback` keeps the partial
state instead, and the next deploy applies the remaining changes. To return a
`--no-rollback` or interrupted deploy to its pre-deploy state, run
`cdkd rollback MyStack`. See [Rollback](rollback.md).

### Q: Are custom resources supported?

Yes. Both type spellings work (`Custom::<Name>` and
`AWS::CloudFormation::CustomResource`), and both `ServiceToken` forms:

- **Lambda-backed**: cdkd invokes the function. The handler returns the
  response directly or PUTs it to the pre-signed `ResponseURL`.
- **SNS-backed**: cdkd publishes the request to the topic and polls for the
  response.

CDK's Provider framework (`onEventHandler` + `isCompleteHandler`) is detected
automatically and gets a longer timeout, one hour by default. Change it with:

```bash
cdkd deploy MyStack --resource-timeout AWS::CloudFormation::CustomResource=2h
```

`cdkd export` cannot hand a custom resource to CloudFormation without
`--include-non-importable`.

## Collecting information for a bug report

An issue is quickest to act on with the cdkd version, the failing command and
its `--verbose` output, and the resource type involved:

```bash
cdkd --version
cdkd deploy MyStack --verbose        # debug log, including AWS's own error text
cdkd state info                      # state bucket, its region, schema version
cdkd state resources MyStack         # what cdkd tracks for the stack
cdkd events MyStack                  # the stack's recorded runs
cdkd events MyStack --run <runId>    # one run's events
```

Read the output before posting it. `--verbose` prints AWS error text that
quotes your account, role and session, and `cdkd state show` prints resource
properties.

Everything cdkd records for a stack is under one prefix of the state bucket
(`cdkd-state-<account>` and the prefix `cdkd` by default):

```text
s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/
├── state.json                  # the stack's record
├── lock.json                   # present while a command holds the lock
├── rollback-journal.json       # present after a deploy that was not rolled back
└── deployments/
    ├── index.json              # the most recent runs
    └── <runId>.jsonl           # one run's events
```

[State Management](state-management.md) and
[Deployment Events](deployment-events.md) describe these files.

### Adjust Log Level

```bash
cdkd deploy MyStack --verbose        # debug logging
CDKD_NO_LIVE=1 cdkd deploy MyStack   # plain line-by-line output, for CI logs
```

`--verbose` is the only way to raise the log level, and every command accepts
it. There is no log-level environment variable. `--verbose` also turns off the
live progress display, which `CDKD_NO_LIVE=1` does by itself.

`cdkd diff --json` lowers the level to `warn` so that debug output cannot
corrupt the JSON on stdout. `--json` wins over `--verbose` there.

### Check State File

```bash
cdkd state show MyStack           # readable
cdkd state show MyStack --json    # the full record as JSON
```

To read the raw file:

```bash
aws s3 cp s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json - \
  | jq '.resources.MyBucket'
```

### Check Execution Plan with Dry Run

```bash
cdkd deploy MyStack --dry-run   # show the plan; no AWS changes
```

### Check API Calls with AWS CloudTrail

cdkd calls service APIs directly, so each call is in CloudTrail under the
identity that ran cdkd:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=CreateBucket \
  --max-results 10
```

## Getting help

Nothing above matching? Open a
[GitHub Issue](https://github.com/go-to-k/cdkd/issues) with what
[Collecting information for a bug report](#collecting-information-for-a-bug-report)
lists. Questions are welcome there too.

## Related

- [CLI Reference](cli-reference.md): every command, the output streams and the
  exit codes
- [State Management](state-management.md): the state record, the lock and the
  bucket layout
- [Rollback](rollback.md): what a rollback undoes and what it can leave behind
- [Provisioning Layers](provisioning-layers.md): SDK providers and the Cloud
  Control API
- [Supported Resources](supported-resources.md): which layer handles a type
- [Troubleshooting internals](troubleshooting-internals.md): retry schedules
  and other mechanisms behind the entries on this page
