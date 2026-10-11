---
title: cdkd export
description: "Hand a cdkd-managed stack over to CloudFormation with cdkd export: a worked example, what blocks it, how the run proceeds, and every flag."
---

# cdkd export

`cdkd export` hands a stack that cdkd manages over to CloudFormation. It is
the opposite direction of [`cdkd import`](import.md).

The AWS resources are not modified. CloudFormation adopts them into a new
CloudFormation stack, and cdkd then deletes its own state record for the
stack. From then on you change the stack with `cdk deploy` or
`aws cloudformation`.

```text diagram=export-ownership
┌──────────────────────────────────────┐
│ Before: cdkd owns the stack          │
│  state record in S3, cdkd deploy     │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ cdkd export                          │  The AWS resources
│  IMPORT changeset from the state     │  are not modified
│  record + the synthesized template   │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ After: CloudFormation owns the stack │
│  same resources in a CFn stack,      │
│  cdkd state deleted, cdk deploy      │
└──────────────────────────────────────┘
```

```bash
# print the import plan, change nothing
cdkd export MyStack --dry-run

# export; the CloudFormation stack is named MyStack
cdkd export MyStack

# name the CloudFormation stack yourself
cdkd export MyStack --cfn-stack-name MyStack-CFn

# also migrate Custom Resources (two phases)
cdkd export MyStack --include-non-importable

# use this template instead of synthesizing
cdkd export MyStack --template template.yaml

# single-stack app: the stack is detected
cdkd export
```

[Exporting to CloudFormation](export.md) is the short guide to deciding
whether a stack is ready. This page is the reference.

## Export a stack

This example exports a stack with one S3 bucket and one DynamoDB table. The
output is abridged to the lines you act on.

::: steps
1. Preview the plan

   ```bash
   cdkd export MyStack --dry-run
   ```

   ```text
   Migrating cdkd stack 'MyStack' ('us-east-1') → CloudFormation stack 'MyStack'

   Import plan for CloudFormation stack 'MyStack':
     UploadsBucket5E5E9B33 (AWS::S3::Bucket) ← BucketName=mystack-uploadsbucket5e5e9b33-k2j4h8x1
     JobsTable1A2B3C4D (AWS::DynamoDB::Table) ← TableName=MyStack-JobsTable1A2B3C4D-9QK2M

   --dry-run: no CloudFormation changeset will be created.
   ```

   The plan lists each resource with the identifier CloudFormation will adopt
   it by. It also reports anything that blocks the export. `--dry-run` takes
   no lock, creates no changeset and writes nothing.

2. Run the export

   ```bash
   cdkd export MyStack
   ```

   ```text
   ✓ Phase 1: CloudFormation stack 'MyStack' created via IMPORT. 2 resource(s) imported.
   cdkd state for 'MyStack' ('us-east-1') removed. Manage the stack with 'cdk deploy' or 'aws cloudformation' from here on.

   Next steps — manage the stack with CDK CLI from now on:
     cdk diff MyStack    # verify synth matches what CFn now holds
     cdk deploy MyStack  # subsequent updates
   ```

   cdkd prints the same plan, asks for confirmation, imports the resources and
   deletes its state record.

3. Check the result with the CDK CLI

   ```bash
   cdk diff MyStack
   ```

   The diff is empty for resources whose names AWS generated, and for
   sub-resources that reference their parent. One case is not empty; see
   [Stacks with prefixed physical names](cli-export-template.md#stacks-with-prefixed-physical-names).
:::

## What blocks an export

cdkd builds the whole plan before it locks the stack or submits anything to
CloudFormation. When a stack cannot be exported, one message names every
offending resource, and nothing has changed. You can fix them all and run the
command again.

These are the blocks you are likely to meet:

| The stack has | What to do |
| --- | --- |
| A destination stack name that already exists in CloudFormation | Pick another name with `--cfn-stack-name`, or delete that stack. |
| A Custom Resource | Pass [`--include-non-importable`](cli-export-two-phase.md#custom-resources-and-include-non-importable). |
| A [resource type CloudFormation cannot import](cli-export-blocks.md#resource-types-cloudformation-cannot-import) | Remove or destroy the resource first. |
| Context passed with `-c` | [Move it into `cdk.json`](cli-export-template.md#context-values-passed-with-c). |
| A template Parameter with no value | Pass [`--parameter Key=Value`](cli-export-template.md#template-parameters). |

A Custom Resource is a resource of type `Custom::*` or
`AWS::CloudFormation::CustomResource`.

A stack whose last deploy failed or was interrupted is not blocked. cdkd asks
before it exports such a stack; see
[Confirmation prompts](#confirmation-prompts).

[cdkd export: what blocks an export](cli-export-blocks.md) has the rarer
blocks, including a damaged state record and a recorded value of `***`.

## In this section

- [cdkd export: what blocks an export](cli-export-blocks.md): every reason an
  export is refused, and the remedy for each.
- [cdkd export: Custom Resources and IAM policies](cli-export-two-phase.md):
  the two kinds of resource that need a second phase, and what that phase
  does to them.
- [cdkd export: nested stacks](cli-export-nested-stacks.md): how a tree of
  nested stacks is exported, named, and recovered after a failure.
- [cdkd export: the template CloudFormation receives](cli-export-template.md):
  Parameters, `-c` context, the changes cdkd makes to the template, and what
  the first `cdk deploy` afterwards may change.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to export. Detected when the app defines a single stack. |
| `--dry-run` | off | Print the import plan and exit. No lock, no changeset, no AWS writes. |
| `--cfn-stack-name <name>` | the cdkd stack name | Name of the destination CloudFormation stack. |
| `--cfn-child-stack-name <pair...>` | `~` replaced by `-` | Name for a nested child, as `'<cdkdName>=<cfnName>'`. Repeatable. |
| `--template <path>` | — | Use this CloudFormation template (JSON or YAML) and skip synthesis. |
| `--stack-region <region>` | — | Region of the cdkd state record. Required when the stack name has state in several regions. |
| `--include-non-importable` | off | Migrate Custom Resources in a second phase instead of refusing. |
| `--no-recreate-import-unsupported` | off | Refuse on `AWS::IAM::Policy` instead of deleting and re-creating it. |
| `--parameter <key=value...>` | template `Default` | Template Parameter value. Repeatable. |
| `--accept-transient-context` | off | Allow `-c` overrides at export time. |
| `--strict-cross-stack` | off | Refuse when other stacks in the app read this one through `Fn::GetStackOutput`. |
| `--skip-import-support-preflight` | off | Skip the checks for types CloudFormation cannot import. |
| `-y`, `--yes` | off | Answer the confirmation prompts automatically. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `-c`, `--context <key=value...>` | — | Context values. Refused without `--accept-transient-context`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

## How the export runs

An export is a plan, a lock, one or two CloudFormation changesets, and a
cleanup. A changeset is the unit in which CloudFormation applies a change to a
stack. An IMPORT changeset adopts existing resources into a stack without
modifying them.

```text diagram=export-run
┌────────────────────────────────────┐
│ Build the import plan              │  No lock, no AWS writes.
│  synthesize or read --template,    │  Blocked resources are
│  classify, resolve identifiers     │  reported here.
└─────────────────┬──────────────────┘
                  ▼
┌────────────────────────────────────┐
│ Lock the stack, ask to confirm     │  --dry-run stops before this
└─────────────────┬──────────────────┘
                  ▼
┌────────────────────────────────────┐
│ Phase 1: IMPORT changeset          │
│  creates the CloudFormation stack  │
└─────────────────┬──────────────────┘
                  ▼
┌────────────────────────────────────┐
│ Phase 2: UPDATE changeset          │  A failure here leaves the
│  only with Custom Resources or     │  CloudFormation stack and
│  AWS::IAM::Policy                  │  the cdkd state in place
└─────────────────┬──────────────────┘
                  ▼
┌────────────────────────────────────┐
│ Delete cdkd state, release lock    │
└────────────────────────────────────┘
```

The lock keeps a concurrent `cdkd deploy` or `cdkd destroy` out of the stack
for the whole run.

Most stacks need only phase 1. Phase 2 runs when the stack has Custom
Resources or `AWS::IAM::Policy` resources, which CloudFormation cannot import
and has to create instead.
[cdkd export: Custom Resources and IAM policies](cli-export-two-phase.md)
describes it.

cdkd deletes its state record only after the last changeset completes. A
failure before that point leaves the record intact.

### When a changeset fails

cdkd fetches the CloudFormation stack events and prints the failure reason for
each resource. The cdkd state record is kept.

Two failures print recovery steps of their own:
[a failed phase 2](cli-export-two-phase.md#if-phase-2-fails), and
[a failure inside a nested-stack tree](cli-export-nested-stacks.md#when-one-stack-of-the-tree-fails).

### Values printed as `(not shown: it is not a plain identifier)`

Plans and error messages contain commands for you to paste. A stack name,
physical id or context value that is not a plain identifier is not safe to
paste, so cdkd prints `(not shown: it is not a plain identifier)` in its
place. `cdkd state show` prints the stored value.

## Confirmation prompts

`cdkd export` asks before it changes anything. `-y` / `--yes` answers every
prompt, and `--dry-run` never prompts.

| Prompt | Raised when |
| --- | --- |
| `Export anyway?` | A previous deploy of the stack failed or was interrupted and has not been rolled back. |
| Migration confirmation | Before the changeset for a single stack is submitted. |
| Tree-wide confirmation | Before the per-stack loop for a nested-stack tree starts. |

`Export anyway?` deserves a pause. Exporting a half-deployed stack is rarely
what you want. Run `cdkd rollback MyStack` to revert the deploy, or
`cdkd deploy` to finish it, and then export.

The prompts need a terminal. When stdin is not a terminal, each prompt refuses
with exit code `1` instead of waiting, and cdkd releases the stack lock if it
holds it. Pass `--yes` in CI.

## How cdkd identifies each resource

To adopt a resource, CloudFormation needs the identifier it knows that
resource by: a bucket's `BucketName`, a table's `TableName`. For most types
that identifier is the physical id cdkd already recorded, and you have nothing
to do.

cdkd reads the identifier's property names from the type's CloudFormation
registry schema, through `cloudformation:DescribeType`. A built-in table for
about thirty common single-field types is the fallback.

### Composite identifiers

Some types have an identifier with more than one field. cdkd builds it from
the physical id. Where a field is the parent's id (`ApiId`, `FunctionName`,
`RestApiId`), cdkd takes it from the recorded properties.

| Service | Resource types |
| --- | --- |
| API Gateway (REST) | `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Stage`, `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Model`, `AWS::ApiGateway::RequestValidator` |
| API Gateway (HTTP) | `AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Stage` |
| EC2 | `AWS::EC2::VPCGatewayAttachment`, `AWS::EC2::VPCCidrBlock`, `AWS::EC2::Route`, `AWS::EC2::EIP` |
| Lambda | `AWS::Lambda::EventInvokeConfig`, `AWS::Lambda::Permission` |
| AppSync | `AWS::AppSync::ApiKey` |
| S3 Tables | `AWS::S3Tables::Namespace` |

A type with a multi-field identifier that is not in this table is refused, and
the message names the type.

Five more types use an identifier that cdkd reads from what it recorded at
deploy time. See
[Identifiers read from recorded attributes](cli-export-blocks.md#identifiers-read-from-recorded-attributes).

## Cross-stack consumers

Other stacks in the same CDK app may read this stack's outputs through
`Fn::GetStackOutput`. Those consumers keep working after the export.

The reason is a fallback in the consumer's deploy. After the export the
outputs live in CloudFormation. A consumer that does not find them in cdkd
state reads them from the CloudFormation stack instead. `cdkd export` checks
for such consumers and warns that their references now depend on that
fallback. Pass `--strict-cross-stack` to refuse instead.

### Edge cases

- **A consumer deployed with `--no-cfn-fallback`.** That consumer breaks,
  because it does not read from CloudFormation. Plan a multi-stack migration
  from the leaves up in that case.
- **Consumers outside the CDK app.** cdkd cannot see them. Check those
  yourself.

[Cross-Stack References](cross-stack-references.md) describes the fallback.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The stack was handed over and cdkd state was deleted. A declined prompt and `--dry-run` also exit `0`. |
| `1` | Any failure: a blocked resource, a rejected changeset, an AWS authentication error, a held lock, or a prompt on a non-interactive stdin. |

## Related

- [Exporting to CloudFormation](export.md): the short guide to this command
- [`cdkd import`](import.md): the opposite direction, CloudFormation to cdkd
- [State Management](state-management.md): state records, composite physical ids, locks
- [Cross-Stack References](cross-stack-references.md): what happens to `Fn::GetStackOutput` consumers
- [CLI Reference](cli-reference.md): every command and the full exit-code table
- [cdkd export internals](cli-export-internals.md): changeset mechanics, for contributors
