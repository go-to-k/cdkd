---
title: cdkd export
description: "Hand a cdkd-managed stack over to CloudFormation with cdkd export: what it changes, what blocks it, and every flag."
---

# cdkd export

`cdkd export` hands a stack that cdkd manages over to CloudFormation. It is the
opposite direction of [`cdkd import`](import.md). The AWS resources are not
modified: CloudFormation adopts them into a new stack, and cdkd deletes its
state record once that has succeeded. From then on you change the stack with
`cdk deploy` or `aws cloudformation`.

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
cdkd export MyStack --dry-run                    # print the import plan, change nothing
cdkd export MyStack                              # export; the CloudFormation stack is named MyStack
cdkd export MyStack --cfn-stack-name MyStack-CFn # name the CloudFormation stack yourself
cdkd export MyStack --include-non-importable     # also migrate Custom Resources (two phases)
cdkd export MyStack --template template.yaml     # use this template instead of synthesizing
cdkd export                                      # single-stack app: the stack is detected
```

## Export a stack

::: steps
1. Preview the plan

   `--dry-run` takes no lock, creates no changeset and writes nothing. It lists
   each resource with the identifier CloudFormation will adopt it by, and
   reports anything that blocks the export.

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

2. Run the export

   cdkd prints the same plan, asks for confirmation, imports the resources and
   deletes its state record.

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

3. Check the result with the CDK CLI

   ```bash
   cdk diff MyStack
   ```

   The diff is empty for resources whose names AWS generated. The one case that
   is not is described under [After the export](#after-the-export).
:::

The output above is abridged to the lines you act on.

## What cannot be exported

cdkd builds the whole plan before it takes the stack lock or submits anything.
A stack that cannot be exported is reported with every offending resource named
in one message, and nothing has changed.

These are the blocks you are likely to meet:

| Blocked | Remedy |
| --- | --- |
| A CloudFormation stack with the destination name already exists | Pick another name with `--cfn-stack-name`, or delete that stack. |
| A Custom Resource (`Custom::*` or `AWS::CloudFormation::CustomResource`) | Pass [`--include-non-importable`](#custom-resources-and-include-non-importable). |
| A resource type CloudFormation cannot import | See [Resource types CloudFormation cannot import](#resource-types-cloudformation-cannot-import). |
| `-c` context overrides on the command line | See [Context values passed with `-c`](#context-values-passed-with-c). |
| A template Parameter with no value | Pass `--parameter Key=Value`. See [Template Parameters](#template-parameters). |
| A stack with a failed or interrupted deploy | Not a block but a prompt. See [Confirmation prompts](#confirmation-prompts). |

### Resource types CloudFormation cannot import

CloudFormation rejects an IMPORT changeset containing one of these types with
`ResourceTypes [<T>] are not supported for Import`:

| Resource type |
| --- |
| `AWS::Glue::Table` |
| `AWS::Route53::RecordSet` |
| `AWS::Route53::RecordSetGroup` |
| `AWS::AppSync::GraphQLSchema` |
| `AWS::AppSync::GraphQLApi` |
| `AWS::EC2::NetworkAclEntry` |
| `AWS::SQS::QueuePolicy` |
| `AWS::SNS::TopicPolicy` |

For each of them, do one of these before exporting:

- Remove the resource from the stack. It stays in AWS, and you can declare it
  in CloudFormation afterwards.
- Destroy it and let CloudFormation create it fresh after the export.

The table is not what cdkd checks against. cdkd refuses a type when its
CloudFormation registry schema declares no `read` handler and reports
`ProvisioningType: NON_PROVISIONABLE`. So the check covers types not listed
here and stops applying once AWS makes a type importable.
`AWS::AppSync::GraphQLApi` is the exception: its registry schema looks
importable but CloudFormation refuses it, so cdkd blocks it by name.

Neither check is AWS's published list of importable types. If AWS has since
made a type importable, `--skip-import-support-preflight` skips both checks and
lets CloudFormation answer.

### Less common blocks

| Blocked | Why | Remedy |
| --- | --- | --- |
| A template resource with no cdkd state entry | cdkd does not know its physical id. | Import it first, or remove it from the stack. |
| A nested stack whose state record is missing | The child's resources cannot be imported. | Repair or re-import the child's state. |
| A type with a multi-field identifier that cdkd has no mapping for | cdkd cannot build the identifier CloudFormation expects. See [Composite identifiers](#composite-identifiers). | Remove the resource before exporting. |
| Two resources with the same import identifier | An import adopts an AWS resource into one logical id. Two `AWS::EC2::SecurityGroupIngress` resources resolving to one rule share one `sgr-…` id. | Keep one in the app, export, then add the others back with a CloudFormation stack update. |
| An identifier property the template declares as a list containing an intrinsic, a nested list, or an empty list | The value cannot be overwritten with the recorded identifier. | Declare the scalar the message names. |
| A recorded value that is the redaction mask `***` | cdkd cannot re-derive the real value. | See [When a recorded value is `***`](#when-a-recorded-value-is). |
| A state record whose `resources` map, or a resource's `properties` map, is not a JSON object | A hand edit or a truncation. The export reads those maps and deletes the record at the end. | Repair the record by hand, or re-import the named resources with a selective `cdkd import --force`. |

Removing a damaged record does not unblock the export. Without the root record
there is nothing to migrate, and without a nested child's record the export
refuses the tree as missing that child.

### When a recorded value is `***`

cdkd stores `***` in state where the real value is a secret. Most masks do not
block an export. A mask blocks only where the export has to read the value:

| Where the mask is | Remedy |
| --- | --- |
| A property a `NoEcho` template parameter fills | None needed. The exported template still reads the parameter, and CloudFormation receives its value. |
| A resource's import identifier, or an `AWS::IAM::Policy`'s principals or name, filled by a `NoEcho` parameter | Export without the resource and adopt it into CloudFormation by hand, passing the value yourself. |
| A longer identifier value with `***` embedded in it | Same. |
| A nested stack's Parameter that resolves to or embeds `***` (`EXPORT_MASKED_CHILD_PARAMETER`) | Export without that nested stack, or adopt it by hand, passing the value yourself. |
| The recorded attribute cdkd uses as the identifier (see [Identifiers read from recorded attributes](#identifiers-read-from-recorded-attributes)) | Re-import with `cdkd import MyStack --resource '<logicalId>=<physicalId>' --force` and `cloudformation:DescribeType` granted, or export without the resource. |
| Any other recorded property | Depends on what wrote the mask. See the next table. |

For a mask in any other recorded property, the record does not say what wrote
it. There are three sources:

| Source of the mask | Remedy |
| --- | --- |
| A Custom Resource response sets `NoEcho` | Stop setting `NoEcho` on the response, re-deploy, then export. Forcing the Custom Resource to update does not help: cdkd masks the value again when it writes state. |
| A secret under `Fn::Base64`, such as a `{{resolve:...}}` reference in EC2 `UserData` | Have the resource read the secret at run time, re-deploy, then export. Do not put the plaintext in the template: cdkd would record it in state. |
| A mask copied from another record by `cdkd orphan --force` (older releases) or by a `cdkd import` resolving a `Ref` or `Fn::GetAtt` | Repair the record that holds the mask with a selective `cdkd import --force`, then re-run the command that wrote this property. |

In every case you can also export the stack without that resource and adopt it
into CloudFormation by hand.

A record imported through Cloud Control routinely carries `***` in its
`attributes`. Those records export normally, because the export reads
`attributes` only for the few types in
[Identifiers read from recorded attributes](#identifiers-read-from-recorded-attributes).

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

The lock keeps a concurrent `cdkd deploy` or `cdkd destroy` out for the
duration. cdkd state is deleted only after the last changeset completes, so a
failure before that leaves the state record intact.

When a changeset fails, cdkd fetches the stack events and prints the
per-resource failure reasons.

Plans and error messages carry commands to paste, so a stack name, physical id
or context value that is not a plain identifier is printed there as
`(not shown: it is not a plain identifier)`. `cdkd state show` prints the
stored value.

## Custom Resources and `--include-non-importable`

CloudFormation cannot import a Lambda-backed Custom Resource. That covers
`Custom::*` and `AWS::CloudFormation::CustomResource`, which is what
`new cdk.CustomResource(...)` synthesizes when no `resourceType` is passed.

Without `--include-non-importable` a stack containing one is refused. Under
`--dry-run` the refusal becomes a warning, so you still see the full plan.

With the flag, phase 1 imports everything else and phase 2 submits the full
template, so CloudFormation creates the Custom Resources. That invokes each
backing Lambda's `onCreate` handler again. The handler must:

1. Be idempotent: return the same `PhysicalResourceId` and `Data` on every
   event type.
2. Answer through the response URL: `PUT` its status payload to
   `event.ResponseURL`.

> [!WARNING]
> cdkd's own deploy also accepts a handler that only returns a value.
> CloudFormation does not. A Custom Resource backed by such a Lambda hangs
> phase 2, and every later `cdk deploy`, until CloudFormation's one-hour
> Custom Resource timeout.

If phase 2 fails, cdkd state is kept and the error prints the recovery: an
`aws cloudformation create-change-set --change-set-type UPDATE` command to
finish phase 2, then `cdkd state orphan` to remove the state record.

## `AWS::IAM::Policy` is deleted and re-created

CloudFormation has no way to look up an existing inline policy, so it cannot
import `AWS::IAM::Policy`. CDK grants emit this type often (a Lambda execution
role's inline policy, an ECS task execution role's ECR pull policy). cdkd
handles it without a flag:

1. Phase 1 leaves the policy out.
2. cdkd deletes the inline policy from its roles, users and groups.
3. Phase 2 has CloudFormation create it again from the template.

> [!WARNING]
> Between steps 2 and 3 the permission does not exist. A call that relies on
> it fails with `AccessDenied` until phase 2 completes.

The plan printed before the confirmation lists each such policy and the roles,
users and groups it is removed from. Pass `--no-recreate-import-unsupported` to
refuse instead.

### The policy is checked against the template first

The principals to detach come from cdkd state. The principals phase 2 attaches
come from the template. cdkd compares the two before anything changes and
stops the export, with no AWS change, when they disagree:

| cdkd state records | What the error tells you to run |
| --- | --- |
| A principal the template does not name, or a policy name other than the template's `PolicyName` | `cdkd diff`, then `cdkd deploy`. This is usually a template change not yet deployed. If the value comes from a root Parameter, re-run the export with the `--parameter` values the stack was deployed with. |
| No principal list, a value that is not a list of IAM names, or a physical id that is not the policy name | `cdkd import ... --force`, to re-import the policy so its record matches the template. |
| More than 100 principals | Nothing. Check the record and the template against AWS. Do not destroy the resource or remove it from the app, which removes the policy from every recorded principal. |

cdkd can check a template principal that is a literal name, a `Ref` to a role,
user or group in the same template, or a `Ref` to a template Parameter. It
cannot check any other value, such as `Fn::ImportValue`, or a missing
`PolicyName`. The plan marks each one it could not check and the export
proceeds.

> [!IMPORTANT]
> Under `--yes` nobody reads those marks. A principal that the template names
> only through an uncheckable value is detached and may not be re-attached.
> Read a `--dry-run` plan before exporting such a stack unattended.

### If deleting the policy fails

The export stops. cdkd state and the CloudFormation stack that phase 1 created
are both kept. Re-running `cdkd export` does not resume, because the
CloudFormation stack now exists. The error gives the steps to finish by hand:

1. Delete the remaining inline policies.
2. Run the phase-2 UPDATE yourself.
3. Remove the state record with `cdkd state orphan`.

The usual cause is a missing permission: `iam:DeleteRolePolicy`,
`iam:DeleteUserPolicy` or `iam:DeleteGroupPolicy`, depending on what the policy
is attached to.

## Nested stacks

A nested-stack tree is exported one stack at a time, leaves first. Each cdkd
stack in the tree becomes its own CloudFormation stack, and each parent then
adopts its children as nested stacks. CloudFormation offers no single changeset
for this: it rejects `IncludeNestedStacks` on an IMPORT changeset.

```bash
cdkd export MyApp --dry-run   # per-stack plan for the whole tree
cdkd export MyApp
```

### Child stack names

A cdkd child stack is named `<parent>~<childLogicalId>`. `~` is not allowed in a
CloudFormation stack name, so the child becomes `<parent>-<childLogicalId>`.
Override it per child:

```bash
cdkd export MyApp --cfn-child-stack-name 'MyApp~Database=my-app-db'
```

### Child Parameters

Each child receives the Parameters its parent's template passes to it.

| Value the parent passes | What the child's changeset receives |
| --- | --- |
| A literal string, number or boolean | The value. |
| A `Ref` to a parent Parameter, or `Fn::GetAtt` on a parent resource | The resolved value, from the parent's Parameters and cdkd state. |
| A value cdkd cannot resolve | Nothing, with a warning. The child template's `Default` must cover it. |
| A value that resolves to or embeds `***` | The export refuses with `EXPORT_MASKED_CHILD_PARAMETER`. |
| A parent's SSM-typed Parameter (`AWS::SSM::Parameter::Value<...>`) | The value stored in SSM, which cdkd reads with `ssm:GetParameter`, without decryption. |

For the SSM case `cdkd export` needs `ssm:GetParameter` on each parameter a
child's row mentions. If the read fails, or the parameter is not a `String` or
`StringList`, the export refuses before it locks any nested stack or submits
any changeset. `--dry-run` warns instead.

### When one stack of the tree fails

cdkd state is kept for the failed stack and for every stack not yet imported.
The error names the stacks that moved and the ones that remain.

Re-running `cdkd export` does not resume. It refuses the tree while any of its
CloudFormation stacks exists, and every stack imported before the failure has
one. The error gives the recovery by hand instead:

- `cdkd state orphan <stack> --stack-region <region>` for each stack that
  finished, and for the failed stack once you complete the steps the error
  names for it.
- The inline-policy deletes to run before the failed stack's phase 2, when it
  has one.
- The stacks not yet imported, which you migrate with CloudFormation IMPORT by
  hand, adopting nested children as AWS's "Nest an existing stack" procedure
  describes.

If the first stack's import fails, nothing was imported. Delete the
CloudFormation stack the failed import left, after confirming with the printed
`aws cloudformation list-stack-resources` command that it holds no resources,
and re-run the export.

The changeset sequence cdkd submits per stack is described in
[cdkd export internals](cli-export-internals.md#nested-stack-changesets).

## Template Parameters

Parameters in the template are passed to both changesets. Each one takes its
value from `--parameter Key=Value` if given, otherwise from the template's
`Default`.

```bash
cdkd export MyStack --parameter Environment=prod --parameter InstanceCount=2
```

A Parameter with neither is an error listing the missing keys. A `--parameter`
naming a key the template does not declare is also an error, which catches
typos. A CDK-generated template usually declares only `BootstrapVersion`, which
has a default, so most exports need no `--parameter`.

## Context values passed with `-c`

`-c key=value` applies to one invocation and is not saved to `cdk.json`. If you
export with `-c env=prod` and later run `cdk deploy` without it, CDK
synthesizes a different template, and CloudFormation updates or replaces
resources on that deploy. `cdkd export` therefore refuses `-c` overrides.

Move the values into `cdk.json` and export without `-c`:

```json
{
  "app": "npx ts-node bin/app.ts",
  "context": {
    "env": "prod"
  }
}
```

Or pass `--accept-transient-context`. cdkd warns, naming every override, and
on success prints the `cdk diff` and `cdk deploy` commands with the same `-c`
flags. You then have to pass them on every later `cdk` invocation for this
stack.

## Cross-stack consumers

cdkd checks whether other stacks in the same CDK app read this stack's outputs
through `Fn::GetStackOutput`.

Those consumers keep working after the export. The outputs now live in
CloudFormation, and a consumer that does not find them in cdkd state reads them
from the CloudFormation stack. cdkd warns that the references now depend on
that fallback. `--strict-cross-stack` refuses instead.

A consumer deployed with `--no-cfn-fallback` does break. Plan a multi-stack
migration from the leaves up in that case.

cdkd cannot see consumers outside the CDK app. Checking those is up to you.
See [Cross-Stack References](cross-stack-references.md).

## Drift baseline

The export submits the synthesized template as it is. If a resource in AWS has
drifted from the template, the first `cdk deploy` after the export changes it
back. To find drift before exporting:

```bash
cdkd state refresh-observed MyStack   # record what AWS holds now
cdkd drift MyStack                    # compare
```

`cdkd export` warns when the state record has no drift baseline for some
resources, because `cdkd drift` cannot compare those reliably. The warning does
not stop the export.

Resources whose baseline a `cdkd import` run refused are listed separately in
the warning, grouped by remedy, because `cdkd state refresh-observed` skips
them too. [`cdkd import`](import.md) explains the refusal.

The warning also names any resource entry in the record that is not an object
or has no resource type. Inspect such a record before exporting:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

## Confirmation prompts

`cdkd export` asks before it changes anything. `-y` / `--yes` answers all of
them, and `--dry-run` never prompts.

| Prompt | Raised when |
| --- | --- |
| `Export anyway?` | A previous deploy of the stack failed or was interrupted and has not been rolled back. |
| Migration confirmation | Before the changeset for a single stack is submitted. |
| Tree-wide confirmation | Before the per-stack loop for a nested-stack tree starts. |

Exporting a half-deployed stack is rarely what you want. Run
`cdkd rollback MyStack` to revert, or `cdkd deploy` to finish, first.

The prompts need a terminal. When stdin is not a TTY, each one refuses with
exit code `1` instead of waiting, and releases the stack lock if it holds it.
Pass `--yes` in CI.

## After the export

cdkd prints the `cdk diff` and `cdk deploy` commands to run next. `cdk diff` is
empty for resources with generated names and for sub-resources that reference
their parent.

One case proposes a replacement on the next `cdk deploy`: a stack whose
physical names carry cdkd's stack-name prefix. That happens with
`cdkd deploy --prefix-user-supplied-names`, and with stacks deployed before
v0.94.0, when prefixing was the default.

```ts
// In the CDK app
new iam.Role(this, 'Role', {
  roleName: 'my-role', // the role in AWS is named MyStack-my-role
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
```

The export records the real name, `MyStack-my-role`, in CloudFormation. The
next `cdk deploy` then sees the template's `my-role` as a change to an
immutable name and proposes to replace the role.

Before the first deploy after the export, either change the CDK code to the
prefixed name (`roleName: 'MyStack-my-role'`) or accept the replacement. To see
what the deploy would do without running it:

```bash
aws cloudformation create-change-set \
  --stack-name MyStack \
  --change-set-name post-export-check \
  --change-set-type UPDATE \
  --template-body file://cdk.out/MyStack.template.json \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-change-set \
  --stack-name MyStack --change-set-name post-export-check
```

## How cdkd identifies each resource

Each imported resource needs the identifier CloudFormation knows it by. cdkd
reads the identifier's property names from the type's CloudFormation registry
schema (`cloudformation:DescribeType`), with a built-in table for about thirty
common single-field types as a fallback. For most types the identifier is
cdkd's physical id and there is nothing to know.

### Composite identifiers

These types have an identifier with more than one field. cdkd builds it from
the physical id and, where the parent's id is a property (`ApiId`,
`FunctionName`, `RestApiId`), from the recorded properties.

| Service | Resource types |
| --- | --- |
| API Gateway (REST) | `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Stage`, `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Model`, `AWS::ApiGateway::RequestValidator` |
| API Gateway (HTTP) | `AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Stage` |
| EC2 | `AWS::EC2::VPCGatewayAttachment`, `AWS::EC2::VPCCidrBlock`, `AWS::EC2::Route`, `AWS::EC2::EIP` |
| Lambda | `AWS::Lambda::EventInvokeConfig`, `AWS::Lambda::Permission` |
| AppSync | `AWS::AppSync::ApiKey` |
| S3 Tables | `AWS::S3Tables::Namespace` |

A type with a multi-field identifier that is not in this table is refused with
a message naming it.

### Identifiers read from recorded attributes

For five types the CloudFormation identifier is a single value that is not
cdkd's physical id. cdkd reads it from the attributes it recorded at deploy
time.

| Resource type | CloudFormation identifier | cdkd physical id |
| --- | --- | --- |
| `AWS::S3Tables::Table` | `TableARN` | `<tableBucketARN>\|<namespace>\|<name>` |
| `AWS::AppSync::DataSource` | `DataSourceArn` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `ResolverArn` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::AppSync::GraphQLApi` | `Arn` | `<apiId>` |
| `AWS::EC2::SecurityGroupIngress` | `Id` (the `sgr-…` rule id) | `<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>` |

`AWS::AppSync::GraphQLApi` reaches this table only under
`--skip-import-support-preflight`, because it is blocked by default.

A resource whose record lacks the attribute is blocked with a message saying
so. For the four ARN-identified types, deploy the stack once: an older record
did not store the ARN, and a deploy adds it.
[State Management](state-management.md) describes these composite ids.

### `AWS::EC2::SecurityGroupIngress` without a recorded rule id

A deploy does not add a missing rule id. When the record has none, the export
looks the rule up itself with `DescribeSecurityGroupRules`, which needs
`ec2:DescribeSecurityGroupRules`. It searches the security group for ingress
rules with the same protocol and port range:

| Rules that match | Outcome |
| --- | --- |
| Exactly one | Adopted. |
| None | Refused, naming the resource and what cdkd searched for. |
| More than one | Refused, naming the resource and every candidate `sgr-…` id. |

More than one match has two causes:

- One ingress resource declares both `CidrIp` and `CidrIpv6`. AWS creates one
  rule per source. Split it into one resource per source.
- Two ingress resources differ only by source. Repair the resource's recorded
  `Id` attribute, or remove the resource before exporting.

A record that already has the rule id, which is everything a current cdkd
deploys, triggers no lookup.

## What cdkd changes in the template

The phase-1 template is the synthesized template with three changes that an
IMPORT changeset requires.

| Change | Why |
| --- | --- |
| `Outputs` are removed in phase 1 | An IMPORT changeset may not declare outputs. Phase 2 restores them. |
| `DeletionPolicy: Delete` is added to resources that have none | An IMPORT requires a `DeletionPolicy` on every resource. `Delete` is what CloudFormation applies by default, so `cdk diff` stays empty. |
| An identifier property is overwritten when the template's literal value differs from the real one | CloudFormation rejects a template whose identifier does not match the resource. This is the prefixed-name case in [After the export](#after-the-export). |

An identifier property that the template leaves out, or sets with `Ref` or
`Fn::GetAtt`, is left as it is.

Templates are JSON or YAML. YAML shorthand intrinsics (`!Ref`, `!Sub`,
`!GetAtt`, `!Join`) are preserved, and the changesets are submitted in the
same format as the source template.

## Limitations

- A template larger than 51,200 bytes is uploaded to the state bucket for the
  duration of the changeset call. A template larger than 1 MB cannot be
  submitted to CloudFormation at all, and the export refuses it, naming the
  largest inline payloads. Move inline Lambda code to
  `lambda.Code.fromAsset(...)` or split the stack.
- The synthesized template is used as written. cdkd does not copy the values
  AWS currently holds into it. See [Drift baseline](#drift-baseline).
- A nested-stack Parameter that cdkd cannot resolve becomes a warning, and the
  child template's `Default` has to cover it.

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
