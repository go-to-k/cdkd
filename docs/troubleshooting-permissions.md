---
title: Credential and permission errors
description: "Fix cdkd errors about missing or expired credentials, assuming a role, a Step Functions log destination, and permissions a template does not imply."
---

# Credential and permission errors

These entries cover credentials cdkd cannot use and permission problems
beyond the common one. For a plain `is not authorized to perform` or
`AccessDenied` on a deploy, and for the policy every deploy needs, start at
["Access Denied" Error](troubleshooting.md#access-denied-error) on the main
Troubleshooting page.

On this page:

- [STS cannot report the account](#sts-cannot-report-the-account)
- ["not authorized to perform: sts:AssumeRole"](#not-authorized-to-perform-sts-assumerole)
- ["The state machine IAM Role is not authorized to access the Log Destination"](#the-state-machine-iam-role-is-not-authorized-to-access-the-log-destination)
- [Set C: permissions the template does not imply](#set-c-permissions-the-template-does-not-imply)
- [What you lose without `cloudformation:DescribeType`](#what-you-lose-without-cloudformation-describetype)

## STS cannot report the account

```
Cannot determine the AWS account id: STS GetCallerIdentity failed (ExpiredToken. Re-run with --verbose for AWS's own message.). cdkd does not substitute a placeholder account, because AWS::AccountId, AWS::StackId and every ARN built from it would look valid while naming a different account. Fix the AWS credentials (`aws sts get-caller-identity` must succeed), or set AWS_ACCOUNT_ID to this deploy's 12-digit account id, and re-run.
```

cdkd asks STS which account it is deploying to, and that call failed. The
credentials are missing, expired, or not allowed to call
`sts:GetCallerIdentity`. cdkd stops because it will not guess the account.

Fix the credentials, and check them with:

```bash
aws sts get-caller-identity
```

Some environments cannot reach STS at all, such as an emulated endpoint or a
locked-down network. There, set `AWS_ACCOUNT_ID` to the deploy's 12-digit
account id. cdkd warns and uses it, and refuses a value that is not 12 digits.

The refusal comes from anything in the template that needs the account id:
`Ref: AWS::AccountId`, `AWS::StackId`, a custom resource (its request carries
a `StackId`), and an `Fn::GetAtt` whose value embeds the account.

### When the account is needed only for a record or a delete

- Sometimes cdkd needs the account only to record an ARN for a resource that
  already exists. Then it warns and leaves that attribute out of the state
  record, and the create succeeds. The attribute is filled in the next time
  the resource is updated.
- When a custom resource is being deleted, cdkd keeps asking STS for about 17
  seconds. If STS still does not answer, the resource is reported as skipped
  and its state record is kept.

## "not authorized to perform: sts:AssumeRole"

```
AccessDenied: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::210987654321:role/CdkdDeploy
```

You are not allowed to assume the role cdkd was told to use. cdkd assumes a
role only when something asked it to:

| Trigger | What cdkd does with the role |
| --- | --- |
| `--role-arn` or `CDKD_ROLE_ARN` | Assumes it for every AWS call |
| A cross-account `Fn::GetStackOutput` with a `RoleArn` | Assumes it to read the producer stack's state |
| `--assume-role` on a `cdkd local` command | Assumes it to give the locally-run function or task its credentials |

Do not point cdkd at a CDK bootstrap role such as
`cdk-hnb659fds-deploy-role-*`. That role is built for a deploy that goes
through CloudFormation. cdkd calls the service APIs itself, so the role does
not carry the permissions cdkd needs, and adding yourself to its trust policy
does not fix this error.

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

3. Grant the role the permissions from ["Access Denied" Error](troubleshooting.md#access-denied-error)

   The permissions go on the role being assumed, and granting them to your
   own principal has no effect here. Scope Set B to the services your stacks use rather
   than attaching `AdministratorAccess`.
:::

### Edge cases

For a cross-account `Fn::GetStackOutput`, the trust policy belongs on the role
in the account that owns the producer stack. It must allow the principal that
the consuming deploy makes its calls as. If that deploy passes `--role-arn`,
the principal is the assumed role and not the profile behind it. See
[Use Another Stack's Outputs](cross-stack-references.md).

## "The state machine IAM Role is not authorized to access the Log Destination"

A Step Functions state machine with `LoggingConfiguration` fails to create or
update with:

```text
The state machine IAM Role is not authorized to access the Log Destination
```

AWS uses this one sentence for three different problems, and cdkd cannot tell
them apart from the message. The first problem clears by itself, so cdkd
retries for about 48 seconds before it reports the error. With the other two
the retry cannot help, and you see a short hang followed by the error.

| Cause | Fix |
| --- | --- |
| The role's log-delivery grants have not propagated yet | None. cdkd retries this for you |
| The execution role lacks the grants | Add the policy below |
| The account's CloudWatch Logs resource policies are at a quota | See "Resource-policy quotas" below |

### Missing grants

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

### Resource-policy quotas

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

## Set C: permissions the template does not imply

This section and the next are reference for setting up an identity. The policy
under ["Access Denied" Error](troubleshooting.md#access-denied-error)
has two sets: Set A, which every deploy needs, and Set B, the actions of the
services in your template. Two CDK features need permissions that neither set
shows.

### A CDK context lookup

`Vpc.fromLookup`, an AMI lookup and a hosted-zone lookup read from AWS while
the app synthesizes, so the identity needs the matching read actions. The
typical ones are `ec2:DescribeVpcs`, `DescribeSubnets`,
`DescribeAvailabilityZones`, `DescribeImages`, `ssm:GetParameter`,
`route53:ListHostedZonesByName` and `kms:ListAliases`.

A denied context lookup fails before any provisioning starts.

### A macro (`Transform`)

A template that declares a macro (`Transform` / `Fn::Transform`, for example
SAM) needs `cloudformation:CreateChangeSet`, `DescribeChangeSet`,
`GetTemplate` and `DeleteStack` on `cdkd-macro-expand-*`. That is the name of
the temporary CloudFormation stack cdkd uses to expand the macro.

If the macro is your own function and not an AWS-managed transform, the
identity also needs `lambda:InvokeFunction` on that function.

## What you lose without `cloudformation:DescribeType`

On an ordinary deploy cdkd reads the schema of each resource type from the
CloudFormation registry, and that read needs `cloudformation:DescribeType`.
Without the permission cdkd prints a warning and falls back. Three things get
worse:

- **Replacement decisions in `deploy` and `diff`.** cdkd uses the schema to
  decide that a property change forces a replacement. Without it cdkd uses a
  schema snapshot bundled with the binary, which can lag AWS. For a type with
  no snapshot, a replacement can be misclassified as an in-place update.
- **Write-only properties in a Cloud Control update.** cdkd uses the schema to
  re-include them. Without it they may be dropped on update, for example
  `VolumeConfigurations` on `AWS::ECS::Service`.
- **`cdkd export`.** The export takes primary identifiers from the schema and
  uses it to check for types CloudFormation cannot import. Without it the
  export runs off a fallback table, and a type that cannot be imported
  surfaces later as `ResourceTypes [<T>] are not supported for Import`.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
