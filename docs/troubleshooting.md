---
title: Troubleshooting
description: "How to read a cdkd error, the fix for the problems most people meet first, and where to find every other error message by what you were doing."
---

# cdkd Troubleshooting Guide

This page explains how to read a cdkd error and gives the fix for the problems
most people meet first. The other entries are on the pages listed under
[In this section](#in-this-section), grouped by what you were doing when it
went wrong. Every entry is headed by its message or symptom, so searching the
site for a distinctive part of your error text finds it.

## Contents

- [Start here](#start-here)
- [How to read a cdkd error](#how-to-read-a-cdkd-error)
  - [Get more detail with `--verbose`](#get-more-detail-with-verbose)
- [Common problems](#common-problems)
  - ["Access Denied" Error](#access-denied-error)
  - ["Failed to acquire lock" Error](#failed-to-acquire-lock-error)
  - ["State has been modified by another process"](#state-has-been-modified-by-another-process)
  - ["Resource already exists" Error](#resource-already-exists-error)
  - ["self-signed certificate in certificate chain" on the very first command](#self-signed-certificate-in-certificate-chain-on-the-very-first-command)
- [In this section](#in-this-section)
  - [Credentials and permissions](#credentials-and-permissions)
  - [Locks and state](#locks-and-state)
  - [A template cdkd refuses](#a-template-cdkd-refuses)
  - [A deploy that fails on one resource](#a-deploy-that-fails-on-one-resource)
  - [A reference cdkd cannot resolve](#a-reference-cdkd-cannot-resolve)
  - [A slow deploy, throttling and retries](#a-slow-deploy-throttling-and-retries)
  - [A deploy that succeeds with the wrong result](#a-deploy-that-succeeds-with-the-wrong-result)
  - [Assets](#assets)
  - [Destroying a stack](#destroying-a-stack)
  - [After a failed or interrupted deploy](#after-a-failed-or-interrupted-deploy)
  - [A warning about a possible duplicate](#a-warning-about-a-possible-duplicate)
  - [Proxies and corporate networks](#proxies-and-corporate-networks)
  - [Questions before you start](#questions-before-you-start)
- [Collecting information for a bug report](#collecting-information-for-a-bug-report)
  - [What to include in an issue](#what-to-include-in-an-issue)
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
| `is not authorized to perform`, `AccessDenied` | A missing permission | ["Access Denied" Error](#access-denied-error) |
| `Cannot determine the AWS account id`, `ExpiredToken` | Missing or expired credentials | [STS cannot report the account](troubleshooting-permissions.md#sts-cannot-report-the-account) |
| `Failed to acquire lock`, `Could not acquire lock` | Another run holds the stack, or a killed run left its lock | ["Failed to acquire lock" Error](#failed-to-acquire-lock-error) |
| `State has been modified by another process` | Two runs wrote the same stack | ["State has been modified by another process"](#state-has-been-modified-by-another-process) |
| `already exists`, `EntityAlreadyExists`, `ResourceInUseException` | The name is taken by a resource cdkd does not track | ["Resource already exists" Error](#resource-already-exists-error) |
| `The following resource types are not supported by cdkd` | cdkd cannot provision the type | [An unsupported resource type](troubleshooting-templates.md#an-unsupported-resource-type) |
| `s3:PutObject` denied, `ECR login failed`, `Docker push failed` | Asset storage is missing or not writable | ["Asset publishing failed"](troubleshooting-assets.md#asset-publishing-failed) |
| `self-signed certificate in certificate chain` | cdkd is not using your proxy | ["self-signed certificate in certificate chain" on the very first command](#self-signed-certificate-in-certificate-chain-on-the-very-first-command) |
| A deploy stopped partway and the stack's state is unclear | A failed or interrupted deploy | [After a failed or interrupted deploy](troubleshooting-failed-deploy.md) |

## How to read a cdkd error

A failed deploy prints two lines for the resource that failed. The first line
is cdkd's and names the resource. The `Caused by:` line is the AWS service's
own message. It says what went wrong, so it is usually the line to search for.

```text
ProvisioningError: Failed to create resource MyBucket
Caused by: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::my-bucket-name"
```

Here `MyBucket` is the resource's logical ID in the template, and the second
line says that the user `myuser` lacks `s3:CreateBucket`.

### Get more detail with `--verbose`

When the two lines are not enough, re-run the command with `--verbose`.

## Common problems

### "Access Denied" Error

```
ProvisioningError: Failed to create resource MyBucket
Caused by: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::my-bucket-name"
```

cdkd calls each AWS service API directly, as the identity that runs the
command or as the role you pass with `--role-arn`. No CloudFormation execution
role stands in between, so that identity needs every permission the deploy
uses. The `Caused by:` line names the action that was denied and the resource
it was denied on.

To fix one error, grant the action the message names. To set an identity up
for cdkd, grant it the three things below: Set A, Set B and `iam:PassRole`.
CDK context lookups and macros need a few more permissions, listed as
[Set C](troubleshooting-permissions.md#set-c-permissions-the-template-does-not-imply)
on the permissions page.

#### Set A: what every deploy needs

Replace `cdkd-state-123456789012` with the name of your state bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudControlApi",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateResource", "cloudformation:UpdateResource",
        "cloudformation:DeleteResource", "cloudformation:GetResource",
        "cloudformation:GetResourceRequestStatus",
        "cloudformation:ListResources"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RegistryAndCrossStackReads",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeType", "cloudformation:ListExports",
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
        "s3:GetObject", "s3:PutObject",
        "s3:DeleteObject", "s3:DeleteObjectVersion"
      ],
      "Resource": "arn:aws:s3:::cdkd-state-123456789012/*"
    },
    {
      "Sid": "StateBucketMetadata",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket", "s3:ListBucketVersions",
        "s3:GetBucketLocation", "s3:GetReplicationConfiguration"
      ],
      "Resource": "arn:aws:s3:::cdkd-state-123456789012"
    }
  ]
}
```

The Cloud Control API's IAM actions use the `cloudformation:` prefix. No
`cloudcontrol:` prefix exists, so an action spelled `cloudcontrol:*` grants
nothing. Cloud Control supports neither resource-level permissions nor
service-specific condition keys, so its six actions must stay on
`"Resource": "*"`.

Without `cloudformation:DescribeType` cdkd warns and carries on. See
[What you lose without `cloudformation:DescribeType`](troubleshooting-permissions.md#what-you-lose-without-cloudformation-describetype).

#### Set B: the services your template provisions

Set B is the service actions for whatever your stacks contain. A template
with a bucket and a queue needs the `s3:` and `sqs:` actions for those
operations, on top of Set A. This holds for a resource that goes through the
Cloud Control API too, because Cloud Control makes its calls as you and has
no service role of its own.

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

### "Failed to acquire lock" Error

```
LockError: Failed to acquire lock for stack MyStack (us-east-1) after 4 attempts. Locked by: alice@host-1:12345, operation: deploy, expires in 4m12s. If you are certain no other process is active, run: cdkd force-unlock MyStack --stack-region us-east-1
```

Another cdkd process is working on the same stack, or a process that was
killed left its lock behind. cdkd takes a lock for each stack and region
before it writes, so that two runs cannot change one stack at the same time.

`cdkd deploy`, `cdkd rollback` and `cdkd scrub` print the message above after
retrying a held lock 3 times at 2-second intervals. The other commands that
write state fail on the first attempt, with a different message:

```text
Could not acquire lock for stack MyStack (us-east-1) — held by alice@host:4242, operation: deploy, expires in 12m4s. That process is still running — wait for it to finish. Only if you are certain it is gone, run: cdkd force-unlock MyStack --stack-region us-east-1
```

Those commands are `cdkd destroy`, `cdkd state destroy`, `cdkd import`,
`cdkd export`, `cdkd orphan`, `cdkd drift --accept`, `cdkd drift --revert` and
`cdkd state refresh-observed`. A nested stack's child stack has its own lock,
so `cdkd deploy` or `cdkd rollback` can print the second message too, when it
tears down a child stack.

::: steps
1. Read the holder named in the message

   cdkd removes an expired lock by itself, so a lock that produces this
   message has not expired. The holder renews its lock every 2 minutes, and
   the lock expires only after 30 minutes without a renewal. If the named
   process is still running, wait for it and re-run.

2. If you know the holder is gone, run the printed command as printed

   ```bash
   cdkd force-unlock MyStack --stack-region us-east-1
   ```

   The printed command carries `--stack-region`, plus `--profile`,
   `--state-bucket` and `--state-prefix` when you passed them. Those flags
   decide which lock is cleared. A shortened command can clear the lock of a
   stack with the same name in a different account.
:::

> [!WARNING]
> `force-unlock` on a live lock lets a second writer into the same stack. Use
> it only when the named process is gone (a crashed CI job, a killed terminal).

[Lock and state errors](troubleshooting-locks-state.md) covers a lock left by
a cancelled CI job or by {kbd:ctrl+c}, and how to read the lock file.

### "State has been modified by another process"

```
StateError: State has been modified by another process. Expected ETag: "abc123", but state has changed.
```

Something else wrote this stack's `state.json` after cdkd read it and before
cdkd saved it. cdkd saves only if the file is still the version it read, so
the other write is kept and cdkd's save is refused. cdkd does not retry the
save, because a correct retry would have to read state and plan again.

1. Re-run the command.

   ```bash
   cdkd deploy MyStack
   ```

2. If it happens again, a second process really is writing this stack. Find
   it by reading the lock file, which names the owner and the operation:

   ```bash
   aws s3api get-object \
     --bucket cdkd-state-123456789012 \
     --key cdkd/MyStack/us-east-1/lock.json \
     /dev/stdout
   ```

Waiting for a lock to expire does not help, because this error comes from the
save of `state.json` and has nothing to do with the lock.

### "Resource already exists" Error

A name collision shows up as the AWS service's own error under `Caused by:`:

```
ProvisioningError: Failed to create resource MyBucket
Caused by: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.
```

The wording differs per service: IAM raises `EntityAlreadyExists`, DynamoDB
`ResourceInUseException`, and so on. In every case a resource with that name
exists in AWS and is not in this stack's state. Either something else owns
the name, or an earlier deploy created the resource and ended before
recording it.

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
[Recovering from Orphaned Resources](troubleshooting-failed-deploy.md#recovering-from-orphaned-resources).
[Importing Existing Resources](import.md) has the import flags.

#### Types that do not fail on a collision

For two groups of types the deploy succeeds where you might expect this
error:

- `AWS::S3::Bucket`, `AWS::Logs::LogGroup` and `AWS::SNS::Topic` adopt the
  existing resource, and cdkd re-applies your configuration to it. An S3
  bucket you own in a different region is refused instead of adopted.
- A type whose id AWS assigns (a VPC, an EC2 instance, an ACM certificate, a
  CloudFront distribution) gets a second resource, and nothing tracks the
  first one any more.

### "self-signed certificate in certificate chain" on the very first command

```
$ cdkd bootstrap --profile my-sso-profile
Starting cdkd bootstrap...
No --state-bucket specified, resolving default bucket name...
CredentialsProviderError: Error: self-signed certificate in certificate chain
```

On a network whose only way out is a corporate proxy, this usually means cdkd
is not using the proxy. The direct route is the one that gets intercepted, so
cdkd sees the interceptor's certificate where it expects Amazon's.

cdkd reads the proxy environment variables. Export them in the shell that
runs cdkd:

```bash
export HTTPS_PROXY=http://proxy.corp.example:8080
cdkd bootstrap --profile my-sso-profile
```

The AWS CLI and `npm` working in the same shell does not prove that the
environment carries a proxy. They can be configured through `~/.aws/config`
and `~/.npmrc`.

If the error survives correct variables, the proxy terminates TLS: see
[A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`](troubleshooting-proxy.md#a-tls-terminating-proxy-still-needs-node-extra-ca-certs).

## In this section

### Credentials and permissions

[Credential and permission errors](troubleshooting-permissions.md): missing
or expired credentials, a failed `sts:AssumeRole`, and less common grants.

### Locks and state

[Lock and state errors](troubleshooting-locks-state.md): a lock nobody holds
any more, a corrupted state file, state that disagrees with AWS, and a stack
name that two state prefixes record.

### A template cdkd refuses

[Templates cdkd refuses](troubleshooting-templates.md): an unsupported
resource type, and the checks that stop a deploy before any AWS call.

### A deploy that fails on one resource

[Failures during a deploy](troubleshooting-deploy.md): a refused replacement,
a Lambda function, an ACM certificate, a custom resource.

### A reference cdkd cannot resolve

[References cdkd cannot resolve](troubleshooting-references.md): an
unsupported intrinsic, `Refusing to resolve`, `Cannot resolve` on a GetAtt.

### A slow deploy, throttling and retries

[Slow deploys, throttling and retries](troubleshooting-slow-deploys.md): what
limits a deploy's speed, what cdkd retries, and the `gave up after` line.

### A deploy that succeeds with the wrong result

[A deploy succeeds but AWS does not match the template](troubleshooting-mismatch.md):
a property that never reached AWS, a removal that changed nothing.

### Assets

[Asset publishing errors](troubleshooting-assets.md): the asset bucket or ECR
repository is missing, or the identity cannot write to it.

### Destroying a stack

[Problems destroying a stack](troubleshooting-destroy.md): a bucket that is
not empty, a refused snapshot delete, skipped resources, leftover backups.

### After a failed or interrupted deploy

[After a failed or interrupted deploy](troubleshooting-failed-deploy.md):
reverting with `cdkd rollback`, and finding and adopting orphaned resources.

### A warning about a possible duplicate

[Possible duplicates after a server error](troubleshooting-duplicates.md):
warnings that a failed create may have left a resource behind.

### Proxies and corporate networks

[Proxies and corporate networks](troubleshooting-proxy.md): the variables cdkd
reads, how `NO_PROXY` matches, extra CA certificates, Docker.

### Questions before you start

[Frequently asked questions](troubleshooting-faq.md): CloudFormation and cdkd,
deleting the state file, rollback, custom resources.

## Collecting information for a bug report

### What to include in an issue

An issue is quickest to act on when it has the cdkd version, the failing
command with its `--verbose` output, and the resource type involved:

```bash
cdkd --version

# debug log, including AWS's own error text
cdkd deploy MyStack --verbose

# state bucket, its region, schema version
cdkd state info

# what cdkd tracks for the stack
cdkd state resources MyStack

# the stack's recorded runs
cdkd events MyStack

# one run's events
cdkd events MyStack --run <runId>
```

Read the output before you post it. `--verbose` prints AWS error text that
quotes your account, role and session, and `cdkd state show` prints resource
properties. [Lock and state errors](troubleshooting-locks-state.md#where-cdkd-keeps-a-stack-s-files)
shows where cdkd keeps a stack's files.

### Adjust Log Level

```bash
cdkd deploy MyStack --verbose        # debug logging
CDKD_NO_LIVE=1 cdkd deploy MyStack   # plain line-by-line output, for CI logs
```

`--verbose` is the only way to raise the log level, and every command accepts
it. No environment variable sets the log level. `--verbose` also turns off
the live progress display, which `CDKD_NO_LIVE=1` does by itself.

`cdkd diff --json` lowers the level to `warn` so that debug output cannot
corrupt the JSON on stdout. There, `--json` wins over `--verbose`.

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

If nothing in this section matches, open a
[GitHub Issue](https://github.com/go-to-k/cdkd/issues) with the output listed
above. Questions are welcome there too.

## Related

- [CLI Reference](cli-reference.md): every command and the exit codes
- [State Management](state-management.md): the state record, the lock and the
  bucket layout
- [Troubleshooting internals](troubleshooting-internals.md): retry schedules
  and other mechanisms behind the entries in this section
