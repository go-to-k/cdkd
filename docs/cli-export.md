---
title: cdkd export
description: "Hand a cdkd-managed stack over to CloudFormation with cdkd export."
---

# cdkd export

`cdkd export <stack>` is the mirror of [`cdkd import`](import.md): it hands a
cdkd-managed stack over to CloudFormation. It builds a CloudFormation
`ChangeSetType=IMPORT` changeset from cdkd state plus the synthesized template,
executes it, and deletes cdkd state on success. AWS resources are unchanged
across the migration. From then on the stack is managed by `cdk deploy` /
`aws cloudformation`.

```bash
cdkd export MyStack                              # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn # name the destination stack
cdkd export MyStack --dry-run                    # print the import plan, make no CFn calls
cdkd export MyStack --template path.json         # pre-rendered template (JSON or YAML), skip synth
cdkd export MyStack --include-non-importable     # 2-phase run: IMPORT, then CFn-CREATE Custom Resources
cdkd export                                      # auto-detected for single-stack apps
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | — | Stack to export. Auto-detected when the app defines a single stack. |
| `--cfn-stack-name <name>` | the cdkd stack name | Name of the destination CloudFormation stack. |
| `--cfn-child-stack-name <pair...>` | `~` replaced by `-` | Per-nested-child destination name, `'<cdkdName>=<cfnName>'`. Repeatable. |
| `--template <path>` | — | Pre-rendered CloudFormation template (JSON or YAML, format auto-detected). Skips synth. |
| `--stack-region <region>` | — | Region of the cdkd state record. Required when the same stack name has state in several regions. |
| `--dry-run` | off | Print the import plan and exit. No lock, no changeset, no AWS writes. |
| `--include-non-importable` | off | Run the 2-phase migration for Custom Resources instead of refusing. |
| `--parameter <key=value...>` | template `Default` | Template Parameter override. Repeatable. |
| `--accept-transient-context` | off | Allow CLI `-c` overrides at export time (default: refuse). |
| `--strict-cross-stack` | off | Refuse when sibling cdkd stacks reference this one via `Fn::GetStackOutput` (default: warn). |
| `--skip-import-support-preflight` | off | Skip the registry pre-flight that refuses types CloudFormation cannot import. |
| `--no-recreate-import-unsupported` | off | Block on IMPORT-unsupported types instead of the delete-and-re-create handling. |
| `-y`, `--yes` | off | Answer the confirmation prompts automatically. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. Refused unless `--accept-transient-context` is also passed. |
| `--verbose` | off | Verbose logging. |

## How the export runs

1. Synthesize the CDK app, or read `--template <path>`.
2. Refuse if a CloudFormation stack with the destination name already exists.
3. Load cdkd state for the target stack and build the
   `(logicalId, physicalId, resourceType)` map.
4. **Build the import plan**: classify every template resource as importable,
   blocked, a Custom Resource, an IMPORT-unsupported type, or a nested-stack
   row, and resolve each importable resource's CloudFormation identifier.
5. Acquire the stack lock, so a concurrent `cdkd deploy` cannot race.
6. Ask for confirmation (skipped by `-y` / `--yes`).
7. Preprocess the phase-1 template, then
   `CreateChangeSet --change-set-type IMPORT`, wait, `ExecuteChangeSet`, wait
   for the import to complete.
8. If the stack has Custom Resources or IMPORT-unsupported types, delete the
   IMPORT-unsupported AWS resources and submit the phase-2 UPDATE changeset
   carrying the full template.
9. Delete cdkd state for the migrated stack and release the lock.

**The whole plan is built before the lock is acquired** (step 4 precedes step
5). A stack that cannot be exported says so without first locking out
concurrent `cdkd deploy` / `cdkd destroy`, and planning issues no AWS write —
it reads cdkd state and the CloudFormation type registry.

When the changeset fails, cdkd fetches `DescribeStackEvents` and surfaces the
per-resource failure reasons; the waiter alone reports only the high-level
rollback state.

## What blocks an export

Each of these is reported before anything is locked or submitted, and every
offending resource is named in one message so you can fix them in one pass.

| Blocked | Why | Remedy |
| --- | --- | --- |
| A template resource with no cdkd state entry | Nothing to hand over — cdkd does not know its physical id. | Import it first, or remove it from the stack. |
| A resource whose recorded properties hold the redaction mask `***` | A `NoEcho` Custom Resource value cdkd cannot re-derive. | See below. |
| An `AWS::CloudFormation::Stack` row with no matching nested-stack entry in cdkd state | The child's state record is missing, so its resources cannot be imported. | Repair or re-import the child's state. |
| A resource type CloudFormation cannot import | See [Resource types CloudFormation cannot import](#resource-types-cloudformation-cannot-import). | Remove the resource, or destroy it and let CloudFormation create it fresh. |
| A composite-id type with no registered identifier mapping | cdkd cannot turn its physical id into the field map CloudFormation expects. | Remove the resource before exporting. |
| A Custom Resource, without `--include-non-importable` | CloudFormation cannot import `Custom::*` at all. | Pass [`--include-non-importable`](#custom-resources-and-include-non-importable). |
| CLI `-c` overrides, without `--accept-transient-context` | The overrides are not persisted, so a later `cdk deploy` would synthesize a different template. | See [Context values passed with `-c`](#context-values-passed-with-c). |
| A Parameter with neither a `--parameter` override nor a template `Default` | The changeset would be rejected. | Pass `--parameter Key=Value`. |
| An identifier property the template carries in an unrepresentable shape | A list containing an intrinsic, a nested list, or an empty list. | Declare the scalar the message names. |

**About the `***` mask.** Forcing the Custom Resource to update does not clear
the block: the handler supplies the value to the *deploy*, and cdkd re-masks it
on the way into state — which is what the export reads. Either stop setting
`NoEcho` on that response and re-deploy, then export again, or export the stack
without that resource and adopt it into CloudFormation by hand.

## Resource types CloudFormation cannot import

A type whose CloudFormation registry schema declares no `read` handler **and**
reports `ProvisioningType: NON_PROVISIONABLE` is rejected by `CreateChangeSet`
with `ResourceTypes [<T>] are not supported for Import`. `AWS::Glue::Table`,
`AWS::Route53::RecordSet`, `AWS::Route53::RecordSetGroup`,
`AWS::AppSync::ApiKey`, `AWS::EC2::NetworkAclEntry`, `AWS::SQS::QueuePolicy`
and `AWS::SNS::TopicPolicy` are all in this class.

cdkd surfaces them from the schema it already fetches for the identifier and
names **every** offending resource in one message — AWS's own error is not
exhaustive. Both signals must agree before cdkd refuses, so a partial or
unusual registry response falls back to letting AWS answer.

Remove the resource from the stack before exporting — it stays in AWS and can
be re-declared in CloudFormation afterwards — or destroy it first and let
CloudFormation create it fresh.

The verdict is a registry **heuristic**, not AWS's published
supported-for-import list. `--skip-import-support-preflight` is the escape
hatch when AWS has since made a type importable: the changeset is then
submitted and CloudFormation answers for itself.

## Types cdkd re-creates instead of importing

A second class is importable in principle but has no schema handler
CloudFormation can look the resource up with. cdkd handles these automatically:
it skips the resource from phase 1, deletes the AWS-side resource between
phases, and lets CloudFormation re-`CREATE` it in phase 2.

| Resource type | Why | What the re-create costs |
| --- | --- | --- |
| `AWS::ApiGatewayV2::Stage` | The schema declares no handlers at all. CDK's `HttpApi` construct auto-emits the `$default` stage. | About 10 seconds of unavailability. The HttpApi endpoint URL is unchanged — it embeds the API id, not the stage name. |
| `AWS::IAM::Policy` | No `read` or `list` handler: an inline policy attachment has no first-class AWS resource id. CDK L2 grants emit these (ECS task execution role ECR pull, Lambda execution role inline policies). | The attachment is dropped from its role / user / group between phases, so any in-flight call relying on the granted permission fails with `AccessDenied` until phase 2 completes. |

Pass `--no-recreate-import-unsupported` to block instead. The pre-delete is
fatal on failure — phase 2 would otherwise collide with the still-present AWS
resource — and cdkd state plus the post-phase-1 CloudFormation stack are
preserved so you can fix the cause (usually permissions) and re-run.

## How cdkd resolves each resource's identifier

Every imported resource needs the `ResourceIdentifier` map CloudFormation
expects. cdkd resolves each type's primary identifier property names from
`cloudformation:DescribeType`, with a built-in fallback table covering about
thirty single-key types.

### Composite identifiers

Types whose CloudFormation `primaryIdentifier` names more than one field are
mapped by a per-type splitter. It reads cdkd's `physicalId` — plus the
resource's recorded `properties` for sub-resource types where the parent
identifier (`ApiId`, `FunctionName`, `RestApiId`) lives in `properties` rather
than in the id — and produces the field map:

- `AWS::ApiGateway::Method`
- `AWS::ApiGateway::Resource`
- `AWS::ApiGateway::Deployment`
- `AWS::ApiGateway::Stage`
- `AWS::ApiGateway::Authorizer`
- `AWS::ApiGateway::Model`
- `AWS::ApiGateway::RequestValidator`
- `AWS::ApiGatewayV2::Integration`
- `AWS::ApiGatewayV2::Route`
- `AWS::EC2::VPCGatewayAttachment`
- `AWS::EC2::VPCCidrBlock`
- `AWS::EC2::Route`
- `AWS::EC2::EIP`
- `AWS::S3Tables::Namespace`
- `AWS::Lambda::EventInvokeConfig`
- `AWS::Lambda::Permission`

Sub-resource types whose identifier includes an AWS-generated id
(`IntegrationId`, `RouteId`, `AWS::Lambda::Permission`'s `Id`) narrow the
`Properties` overlay to the writable subset, so CloudFormation does not reject
the changeset with "Encountered unsupported property". A composite type not in
the list is refused with a message naming it.

### Identifiers cdkd reads from recorded attributes

Four types have a **single-field** CloudFormation identifier while cdkd's
physical id is a pipe-joined composite — and the identifier is not a segment of
that composite, so no splitter can produce it. cdkd reads the value from the
resource's recorded `attributes` instead.

| Resource type | CloudFormation identifier | cdkd physical id |
| --- | --- | --- |
| `AWS::S3Tables::Table` | `TableARN` | `<tableBucketARN>\|<namespace>\|<name>` |
| `AWS::AppSync::DataSource` | `DataSourceArn` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `ResolverArn` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::EC2::SecurityGroupIngress` | `Id` (the `sgr-...` rule id) | `<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>` |

When state does not carry the attribute, the resource is blocked with an
actionable message. For the first three, that means a record written before
cdkd started recording the ARN — re-deploy the stack once to heal it, as
[State Management](state-management.md#the-composite-id-is-not-what-ref-returns)
describes.

### `AWS::EC2::SecurityGroupIngress`

The ingress row's remedies differ, because there are two ways to lack the rule
id, and a re-deploy heals neither:

- **A rule declaring more than one source** (both `CidrIp` and `CidrIpv6` on one
  resource) makes AWS mint one rule per source, and cdkd records neither id —
  neither is *the* identifier. Split it into one ingress resource per source.
- **A record predating that recording** carries no `Id` at all, and a no-op
  re-deploy does not heal it either: AWS returns the rule id only from
  `AuthorizeSecurityGroupIngress` itself.

**`cdkd export` recovers it for you.** A row with no usable recorded `Id`
triggers a paginated `DescribeSecurityGroupRules` on the group the physical id
names, and the rule is adopted only when exactly one ingress rule on that group
carries the composite's `(protocol, port range)` tuple:

| Matches | Outcome |
| --- | --- |
| Exactly one | Adopted. |
| Zero | Refused, naming the row and the tuple cdkd searched for. Nothing matched, so there are no candidates to name. |
| More than one | Refused, naming the row and every candidate `sgr-…` id — two rules sharing that tuple are two rules cdkd's own physical id cannot tell apart either. |

Matching rules are counted **before** any is set aside, so a rule AWS reports
without a usable `sgr-…` id refuses too, rather than letting its sibling pass
as "exactly one". A "more than one" refusal has two causes: the multi-source
rule above (split the resource), or two distinct ingress resources differing
only by source, which the composite carries none of — those are already one
resource per source, so repair the row's `attributes.Id` or remove the row
before exporting.

The lookup needs `ec2:DescribeSecurityGroupRules`; without that permission the
row is blocked with a message saying so, while a throttled lookup is retried
with backoff and reported as a throttle rather than as a missing permission. A
row whose state already records the `Id` — everything a current cdkd deploys —
issues no live read at all.

## Template preprocessing

cdkd rewrites the phase-1 template automatically. The CloudFormation IMPORT
contract requires all three changes.

### Outputs are stripped

CloudFormation rejects an IMPORT changeset that declares any `Outputs` ("you
cannot modify or add [Outputs]"). The phase-2 UPDATE re-submits the full synth
template and restores `Outputs` along with the non-importable resources.

### `DeletionPolicy: Delete` is injected

CloudFormation IMPORT requires a `DeletionPolicy` on every imported resource,
and CDK synth emits one only when `RemovalPolicy` is set explicitly. cdkd
injects `Delete` rather than `Retain`, so the post-export template matches the
CloudFormation type default — the same thing plain CloudFormation would have
applied — and the post-export `cdk diff` carries no `DeletionPolicy` noise.
`UpdateReplacePolicy` is deliberately not injected; only `DeletionPolicy` is
required for IMPORT.

### The `ResourceIdentifier` overlay is conditional

cdkd mirrors upstream `cdk import`: it passes the synth template through and
lets CloudFormation match resources via the changeset's
`ResourcesToImport[].ResourceIdentifier` alone — except when the template
carries a *literal* value for the identifier field that *differs* from it.
Four cases:

| Template value | What cdkd does | Post-export `cdk diff` |
| --- | --- | --- |
| **Absent** — an auto-generated name, no physical name declared in CDK code | Leaves `Properties[<NameField>]` absent. CloudFormation accepts the changeset on `ResourceIdentifier` alone. | Clean: both sides have the property absent. |
| **An intrinsic** — a composite-id sub-resource referencing its parent via `{Ref: ...}` / `{Fn::GetAtt: ...}` | Preserves the intrinsic. CloudFormation resolves it during changeset processing against the parent's own `ResourceIdentifier`, since the parent is imported in the same changeset. | Clean: both sides keep the intrinsic. |
| **A mismatched literal** — the legacy name-prefixing case below | Overwrites the property with the value cdkd recorded, which is the authority on what the resource is. Without this, AWS rejects with `The Identifier [<Field>] ... does not match the identifier value for the resource in the template`. | The overlay persists; see [After the export](#after-the-export). |
| **Unrepresentable** — a list carrying an intrinsic, a nested list, or an empty list | Refuses, naming the resource, the property and the scalar to declare instead. | n/a |

A plain literal — a string, number, boolean, or an array of those — is
overwritten with the scalar identifier. Only the unrepresentable shapes are
refused, because preserving any of them reproduces an opaque CloudFormation
rejection, while what makes overwriting wrong differs per shape: only a list
that actually carries an object element has an intrinsic to discard. The
message says which reason applies.

## Nested stacks

A cdkd nested-stack tree is exported by a **leaf-first per-stack IMPORT loop**.
cdkd walks the cdkd state tree recursively and submits one IMPORT changeset per
cdkd-managed stack:

- **Leaf stacks** get a single CREATE-via-IMPORT changeset.
- **Non-leaf parents** get two. Phase 1A is a CREATE-via-IMPORT covering the
  parent's own leaf resources; phase 1B is an UPDATE-via-IMPORT against the
  now-existing parent that adopts the already-imported children, following
  AWS's "Nest an existing stack" pattern.

Phase 1B injects `DeletionPolicy: Retain`, `ResourceIdentifier: { StackId:
<child arn> }`, a `TemplateURL` rewritten to point at the child's
AWS-canonicalized template (fetched with `GetTemplate(Processed)` after the
import), and the child's tags forwarded from `DescribeStacks` — AWS's nested
stack import validation rejects tag mismatches.

Between phases each non-root stack is flipped from `IMPORT_COMPLETE` to
`UPDATE_COMPLETE` by a no-op tag-only `UpdateStack`, because AWS rejects
`IMPORT_COMPLETE` as a non-importable status for nesting. The flip adds a
transient `cdkd:nested-export-flip` tag, which phase 1B then forwards verbatim
into the parent template.

There is no single-changeset alternative: AWS rejects `IncludeNestedStacks` on
an IMPORT changeset outright (`ValidationError: IncludeNestedStacks is not
supported for changeSet type: IMPORT`).

### Child stack names

Each cdkd child stack `<parent>~<childLogicalId>` becomes its own
CloudFormation stack named `<parent>-<childLogicalId>` by default, because `~`
is illegal in a CloudFormation stack name. Override per child, repeatably:

```bash
cdkd export MyApp --cfn-child-stack-name 'MyApp~Database=my-app-db'
```

### Child Parameters

Per-child Parameters are forwarded from the parent template's
`AWS::CloudFormation::Stack.Properties.Parameters` block. Literal string,
number and boolean values pass through. Intrinsic-valued Parameters
(`{Ref: <ParentParam>}`, `{Fn::GetAtt: [ParentResource, Attr]}`) are resolved
at import time against the parent's resolved Parameters and cdkd state, in a
root-first pre-pass — a child's Parameters resolve against its parent's. A
value cdkd cannot resolve degrades to a warning, and the child template's
Parameter `Default` must then cover it.

### Failure and re-runs

On a per-stack failure, cdkd state is preserved for the failed stack and every
stack not yet imported. The error names which stacks moved and which remain, so
`cdkd export <parent>` can be re-run after the cause is fixed — already
imported children are re-adopted as nested references on the retry.

`--dry-run` prints the per-stack plan summary without acquiring child locks or
submitting any changeset.

The design rationale is in the
[nested-stack export/import design note](design/464-nested-stacks-export-import.md).

## Custom Resources and `--include-non-importable`

Lambda-backed Custom Resources — both `Custom::*` and
`AWS::CloudFormation::CustomResource`, the latter being what
`new cdk.CustomResource(...)` synthesizes when no `resourceType` is passed —
are not CloudFormation-importable. Without `--include-non-importable` their
presence aborts the command — except under `--dry-run`, where the missing flag
is downgraded to a warning so you still see the full plan and the gate you
would need to flip.

With the flag, cdkd runs the 2-phase migration: phase 1 imports the importable
resources, and phase 2 submits an UPDATE changeset carrying the full template,
so CloudFormation `CREATE`s the Custom Resources. That re-invokes each backing
Lambda's `onCreate` handler, which must be:

1. **Idempotent** — the same `PhysicalResourceId` and `Data` on every event
   type; and
2. **Correct about the cfn-response protocol** — it must `PUT` a
   Status / PhysicalResourceId payload to `event.ResponseURL`.

cdkd's own deploy path also accepts a return-value fast path for handler
responses, but the phase-2 UPDATE, any later rollback, and every future
`cdk deploy` against the imported stack all require the real `ResponseURL`
post. A Custom Resource backed by a return-only Lambda will hang until
CloudFormation's one-hour Custom Resource ceiling.

On a phase-2 failure, cdkd state is preserved and the error message carries the
recovery procedure: an
`aws cloudformation create-change-set --change-set-type UPDATE ...` invocation
followed by `cdkd state orphan`.

## Template Parameters

Parameters in the synthesized template are forwarded to both the phase-1 and
phase-2 changesets. Each one resolves in order:

1. a `--parameter Key=Value` override (repeatable), then
2. the template's `Default`.

A Parameter with neither aborts with an error listing the missing keys, and a
`--parameter` override naming a key the template does not declare is rejected
too, which catches typos. CDK-generated templates typically carry only
`BootstrapVersion`, with a default — `cdkd export` needs no `--parameter` for
those.

## Context values passed with `-c`

CDK reads context from `cdk.json` and `cdk.context.json` on every synth. CLI
`-c key=value` overrides are **not** persisted to either file; they apply only
to the current invocation. So if you run `cdkd export -c env=prod` and later
run `cdk deploy` without the same `-c env=prod`, CDK synthesizes a different
template, which CloudFormation sees as drift or a replacement on the first
post-migration deploy.

`cdkd export` therefore refuses by default when CLI `-c` overrides are present.
Two ways forward:

- **Recommended.** Move the overrides into `cdk.json`'s `"context": { ... }`
  field and re-run `cdkd export` without `-c`. Later `cdk deploy` invocations
  read `cdk.json` automatically.
- **Escape hatch.** Pass `--accept-transient-context`. cdkd proceeds and warns,
  naming every override. You are then responsible for passing the same `-c`
  flags to every future `cdk deploy` for this stack, or for moving them into
  `cdk.json` before then. On success cdkd prints the exact `cdk diff` /
  `cdk deploy` commands including the captured flags.

## Cross-stack consumers

When other stacks in the same CDK app reference the exporting stack via
`Fn::GetStackOutput`, cdkd scans for them at synth time.

Those consumers keep resolving after the migration through the CloudFormation
fallback: the exported stack's outputs move to CloudFormation, and a consumer's
next resolve reads them from there (`DescribeStacks`) after missing in cdkd
state. The reference is weak either way. By default cdkd warns that the
references become fallback-dependent; `--strict-cross-stack` refuses instead.

They break only for consumers deployed with `--no-cfn-fallback`. Plan
multi-stack migrations from the leaves up in that case.

Without `Fn::GetStackOutput` — or with consumer stacks outside the CDK app — no
scan can run, and checking is up to you.

## Drift baseline

cdkd warns when state lacks `observedProperties` for one or more resources.
Without that baseline `cdkd drift` cannot reliably compare against AWS, so the
first `cdk deploy` after the migration may surface unexpected changes if AWS
has drifted from the synth template. Run `cdkd state refresh-observed <stack>`
(or any redeploy) before exporting, then `cdkd drift <stack>` to verify. The
warning is non-blocking by design — you decide whether to proceed.

## Confirmation prompts

`cdkd export` asks before it changes anything. `-y` / `--yes` skips all three.

| Prompt | Raised when |
| --- | --- |
| `Export anyway?` | The stack has a rollback journal — a previous deploy failed or was interrupted and has not been reverted. |
| Migration confirm | Before submitting the changeset for a single stack. |
| Tree-wide confirm | Before submitting the per-stack IMPORT loop for a nested-stack tree. |

Exporting a half-deployed state to CloudFormation is almost certainly
unintended, which is why the journal case prompts on its own: run
`cdkd rollback <stack>` to revert, or `cdkd deploy` to fix forward, first.
`--dry-run` never prompts.

All three prompts are **interactive-only**. On a non-TTY stdin each refuses
before creating the prompt, exiting 1 — see
[Destroy flags & guards](cli-destroy.md#every-other-mutating-confirmation-prompt-is-interactive-only-too).
The migration and tree-wide prompts hold the stack lock; each releases it on
the way out, so a refusal leaks no lock.

## After the export

cdkd prints the `cdk diff` and `cdk deploy` commands to run next. Post-export
`cdk diff` is clean for auto-generated names and for composite-id
sub-resources.

One case still proposes a **replacement** on the next `cdk deploy`: a stack
carrying names prefixed by cdkd's legacy user-supplied-name prefixing —
`cdkd deploy --prefix-user-supplied-names`, or a stack deployed before that
stopped being the default. There, `roleName: 'my-role'` in CDK code became
`MyStack-my-role` on AWS. Phase-1 preprocessing rewrites the template's name
field to the prefixed value, or CloudFormation IMPORT would reject the
identifier mismatch, and that prefixed value persists into the post-import
template. The next `cdk deploy` sees `MyStack-my-role` (recorded by
CloudFormation) against `my-role` (declared in CDK) as a change to an immutable
name field, and proposes a replacement.

Before your first post-export deploy, either change the CDK code to the
prefixed value (`roleName: 'MyStack-my-role'`) or accept the replacement. The
export's prefix-migration pre-flight is meant to surface this beforehand, and
inspecting the post-import changeset is the way to be sure:

```bash
aws cloudformation create-change-set --change-set-type UPDATE ...
```

Changed in v0.94.0: user-supplied physical names are no longer prefixed by
default, so stacks deployed since are not in this case.

## Limitations

- **Inline `TemplateBody` only**, capped at 51,200 bytes. A larger template
  needs an S3 upload via `TemplateURL`, which `cdkd export` does not do.
- **The synth template is used verbatim.** cdkd does not substitute
  `observedProperties` into it, so if the CDK code has drifted from the
  AWS-current state, the next `cdk deploy` after the migration updates the
  resource. Run `cdkd drift` before exporting if that matters.
- **Nested-stack Parameters that cdkd cannot resolve** degrade to a warning;
  the child template's `Default` has to cover them.

JSON and YAML are both supported. Templates round-trip through cdkd's
CloudFormation-aware codec, which preserves every shorthand intrinsic (`!Ref`,
`!Sub`, `!GetAtt`, `!Join`, …) across the parse, preprocess and re-serialize
cycle. The phase-1 IMPORT and phase-2 UPDATE changesets are emitted in the same
format as the source template, so a YAML-authored stack stays YAML on the wire.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The stack was handed over and cdkd state was deleted. |
| `1` | Any failure — a blocked resource, a rejected changeset, an AWS auth error, lock contention, or a prompt refused on a non-interactive stdin. |

cdkd state is deleted **only** after the import changeset completes
successfully. A mid-flow failure leaves cdkd state intact, so the command can
be re-run. The full cross-command table is in the
[CLI Reference](cli-reference.md).

## Related

- [Exporting to CloudFormation](export.md) — the short guide to this command
- [`cdkd import`](import.md) — the opposite direction, CloudFormation to cdkd
- [State Management](state-management.md) — state records, composite physical ids, locks
- [Cross-stack references](cross-stack-references.md) — what happens to `Fn::GetStackOutput` consumers
- [Destroy flags & guards](cli-destroy.md#every-other-mutating-confirmation-prompt-is-interactive-only-too) — the non-interactive prompt rule
