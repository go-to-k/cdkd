---
title: Frequently asked questions
description: "Short answers about how cdkd relates to CloudFormation, what the state file is for, rollback and custom resources."
---

# Frequently asked questions

Short answers to the questions people ask before or soon after their first deploy.

On this page:

- [Q: Is a CloudFormation stack created?](#q-is-a-cloudformation-stack-created)
- [Q: Can I use CloudFormation and cdkd for the same stack?](#q-can-i-use-cloudformation-and-cdkd-for-the-same-stack)
- [Q: What happens if I delete the state file?](#q-what-happens-if-i-delete-the-state-file)
- [Q: Is there a rollback feature?](#q-is-there-a-rollback-feature)
- [Q: Are custom resources supported?](#q-are-custom-resources-supported)

## Q: Is a CloudFormation stack created?

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

## Q: Can I use CloudFormation and cdkd for the same stack?

Not at the same time. One stack has one owner at a time, but you can hand a
stack over in either direction, and neither handover changes the AWS
resources.

```bash
# CloudFormation -> cdkd
cdkd import MyStack --migrate-from-cloudformation

# cdkd -> CloudFormation: print the plan
cdkd export MyStack --dry-run
cdkd export MyStack
```

- **To cdkd**: the import adopts the resources and retires the CloudFormation
  stack record. It needs a CDK app that synthesizes the stack. Nested stacks
  are walked recursively. See [Import Existing Resources](import.md).
- **To CloudFormation**: the export builds an IMPORT change set, executes it
  and deletes cdkd state. It is all-or-nothing. It refuses up front on a
  resource with no state entry, a masked value in the recorded properties, a
  type CloudFormation cannot import, or a custom resource without
  `--include-non-importable`. See [`cdkd export`](cli-export.md).

Different stacks can stay on different engines. A cdkd-deployed stack resolves
`Fn::ImportValue` / `Fn::GetStackOutput` against a CloudFormation-managed
producer with no change on the producer side.

## Q: What happens if I delete the state file?

cdkd no longer knows any of the stack's resources, so the next `cdkd deploy`
plans every one as a create. What happens then depends on the type:

| Types | Result of the create |
| --- | --- |
| Most types | Fails with an already-exists error |
| `AWS::S3::Bucket`, `AWS::Logs::LogGroup`, `AWS::SNS::Topic` | Adopts the existing resource and re-applies your configuration over it |
| Types with an AWS-assigned id: VPC, EC2 instance, ACM certificate, CloudFront distribution | Creates a second resource and orphans the first, once per attempt |

To recover, leave the AWS resources in place and adopt them back into
state:

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
[Import Existing Resources](import.md).

## Q: Is there a rollback feature?

Yes. cdkd rolls back on failure by default. `--no-rollback` keeps the partial
state instead, and the next deploy applies the remaining changes. To return a
`--no-rollback` or interrupted deploy to its pre-deploy state, run
`cdkd rollback MyStack`. See [Roll Back a Failed Deploy](rollback.md).

## Q: Are custom resources supported?

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

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
