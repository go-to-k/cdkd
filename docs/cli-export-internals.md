---
title: cdkd export internals
description: "How cdkd export builds its changesets: step order, the import-support pre-flight, identifier overlays, nested-stack adoption, and the edge cases of its warnings."
unlisted: true
---

# cdkd export internals

Implementation detail behind [`cdkd export`](cli-export.md), for someone
changing the command. The user-facing behaviour is on that page and the
sub-pages it lists under "In this section"; this one records the mechanics and
the edge cases they summarize.

## Step order

1. Synthesize the CDK app, or read `--template <path>`.
2. Refuse if a CloudFormation stack with the destination name already exists.
3. Load cdkd state for the target stack and build the
   `(logicalId, physicalId, resourceType)` map.
4. Build the import plan: classify every template resource as importable,
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

The whole plan is built before the lock is acquired (step 4 precedes step 5).
A stack that cannot be exported says so without first locking out concurrent
`cdkd deploy` / `cdkd destroy`, and planning issues no AWS write: it reads
cdkd state and the CloudFormation type registry.

When the changeset fails, cdkd fetches `DescribeStackEvents` and surfaces the
per-resource failure reasons; the waiter alone reports only the high-level
rollback state.

## Damaged state records

A record whose `resources` map, or a resource entry's `properties` map, is not
a JSON object (`null`, absent, a list, a string, a number or a boolean) is
refused by name:

- for the root stack at the state load, before any lock;
- for every nested child before any child stack is planned or locked, after
  the root's plan and, on a real run, under the root lock, which it releases;
- under `--dry-run` too.

The export reads the `properties` map to build an import identifier, to check
for the mask, and to find what a phase-2 pre-delete removes, and it deletes the
record once the migration succeeds.

## The redaction mask

cdkd stores only `***` where a `NoEcho` template parameter fills a property,
and the record names those positions. That mask is no block: the exported
template still reads the parameter, and CloudFormation receives its value as a
stack parameter. It blocks only where the export itself reads the position.

For the other sources of a mask in `properties` (a `NoEcho` Custom Resource
value, the `Fn::Base64` encoding of a secret, a mask copied from another
record) the record does not say which one put the mask there. Forcing a Custom
Resource to update does not clear its mask: the handler supplies the value to
the deploy, and cdkd re-masks it on the way into state, which is what the
export reads. cdkd never records the `Fn::Base64` encoding of a secret, so
re-deploying the same template does not clear that mask either.

A mask in a record's `attributes` is a different population. A deploy and
`cdkd import` both write the mask there for every Cloud Control model key they
cannot certify as an `Fn::GetAtt` attribute (an import masks the whole model
when `cloudformation:DescribeType` was unavailable), so a Cloud Control record
routinely carries masked attributes, and those records export normally. The
export reads `attributes` at exactly one position, the recorded identifier of
the few types whose cdkd physical id is not CloudFormation's identifier. Only
a mask at that position blocks, because it would become the resource's
identity in the import changeset. A deploy that does not update the resource
leaves the mask in place. Whatever produced the identifier, a value equal to
the mask is refused before the changeset is built.

## The import-support pre-flight

A type whose CloudFormation registry schema declares no `read` handler and
reports `ProvisioningType: NON_PROVISIONABLE` is rejected by `CreateChangeSet`
with `ResourceTypes [<T>] are not supported for Import`. cdkd surfaces these
from the schema it already fetches for the identifier and names every offending
resource in one message; AWS's own error is not exhaustive. Both signals must
agree before cdkd refuses, so a partial or unusual registry response falls back
to letting AWS answer.

The registry heuristic is necessary but not sufficient: a type can declare a
read handler and still be refused. `AWS::AppSync::GraphQLApi` is the measured
case (us-east-1, September 2026: registry `FULLY_MUTABLE` with a full handler
set, changeset rejected all the same), so cdkd also blocks it up front from a
short list of dated measurements, with the same remedies.

`AWS::AppSync::ApiKey` left the non-importable class in September 2026, when
AWS re-published the type with a read handler. It imports, and cdkd resolves
its composite `[ApiId, ApiKeyId]` identifier from the `apiId|apiKeyId` physical
id. AWS moved `AWS::AppSync::GraphQLApi`'s identifier from `ApiId` to `Arn` in
the same month; a registry that still reports `ApiId` is accepted as-is,
because cdkd's physical id already is that value.

## Identifiers

### Composite identifiers

Types whose CloudFormation `primaryIdentifier` names more than one field are
mapped by a per-type splitter (`COMPOSITE_ID_SPLITTERS` in
`src/cli/commands/export.ts`; the public page's table is checked against its
keys). Sub-resource types whose identifier includes an AWS-generated id
(`IntegrationId`, `RouteId`, `AWS::Lambda::Permission`'s `Id`,
`AWS::AppSync::ApiKey`'s `ApiKeyId`) narrow the `Properties` overlay to the
writable subset, so CloudFormation does not reject the changeset with
"Encountered unsupported property".

### The `ResourceIdentifier` overlay

cdkd mirrors upstream `cdk import`: it passes the synth template through and
lets CloudFormation match resources via the changeset's
`ResourcesToImport[].ResourceIdentifier` alone, except when the template
carries a literal value for the identifier field that differs from it.

| Template value | What cdkd does | Post-export `cdk diff` |
| --- | --- | --- |
| Absent: an auto-generated name | Leaves `Properties[<NameField>]` absent. CloudFormation accepts the changeset on `ResourceIdentifier` alone. | Clean. |
| An intrinsic: a sub-resource referencing its parent | Preserves the intrinsic. CloudFormation resolves it against the parent's own `ResourceIdentifier`, since the parent is imported in the same changeset. | Clean. |
| A mismatched literal: the legacy name-prefixing case | Overwrites the property with the value cdkd recorded. Without this, AWS rejects with `The Identifier [<Field>] ... does not match the identifier value for the resource in the template`. | The overlay persists. |
| Unrepresentable: a list carrying an intrinsic, a nested list, or an empty list | Refuses, naming the resource, the property and the scalar to declare instead. | n/a |

A plain literal (a string, number, boolean, or an array of those) is
overwritten with the scalar identifier. Only the unrepresentable shapes are
refused, because preserving any of them reproduces an opaque CloudFormation
rejection, while what makes overwriting wrong differs per shape: only a list
that actually carries an object element has an intrinsic to discard. The
message says which reason applies.

`UpdateReplacePolicy` is deliberately not injected alongside
`DeletionPolicy: Delete`; only `DeletionPolicy` is required for IMPORT.

### The `AWS::EC2::SecurityGroupIngress` rule-id lookup

A row with no usable recorded `Id` triggers a paginated
`DescribeSecurityGroupRules` on the group the physical id names. A rule
declaring more than one source (both `CidrIp` and `CidrIpv6`) makes AWS mint
one rule per source, and cdkd records neither id. A record predating the
recording carries no `Id` at all, and a no-op re-deploy does not heal it: AWS
returns the rule id only from `AuthorizeSecurityGroupIngress` itself.

Matching rules are counted before any is set aside, so a rule AWS reports
without a usable `sgr-…` id refuses too, rather than letting its sibling pass
as "exactly one". A throttled lookup is retried with backoff and reported as a
throttle rather than as a missing permission.

## The `AWS::IAM::Policy` pre-delete check

The names to detach come from cdkd state, which recorded them at deploy time,
while phase 2 re-attaches the policy to the principals the template names.

- A legacy `policyName:roleName` record that records no principal list at all
  (not even an empty one) uses the id's role, when that role is an IAM name, as
  `cdkd destroy` does, and is then checked like any other.
- A `Ref` to a Parameter is read from the value the export submits to that
  stack's changeset. For the root stack that is `--parameter` or a `Default`.
  For a nested stack it is what the parent row passes, so the check sees the
  same value phase 2 uses.
- A stack's own SSM-typed Parameter (`AWS::SSM::Parameter::Value<...>`) is
  never read as known: its value is the SSM parameter's name, not the name
  CloudFormation substitutes. A nested stack passed a parent's SSM-typed
  Parameter is checked against the stored value, which is what it is handed.
- `PolicyName` is checked when it is a literal or such a Parameter `Ref`.

The pre-delete is fatal on failure, because phase 2 would otherwise collide
with the still-present AWS resource.

## Nested-stack changesets

cdkd walks the cdkd state tree recursively and submits one IMPORT changeset per
cdkd-managed stack:

- Leaf stacks get a single CREATE-via-IMPORT changeset.
- Non-leaf parents get two. Phase 1A is a CREATE-via-IMPORT covering the
  parent's own leaf resources; phase 1B is an UPDATE-via-IMPORT against the
  now-existing parent that adopts the already-imported children, following
  AWS's "Nest an existing stack" pattern.

Phase 1B injects `DeletionPolicy: Retain`, `ResourceIdentifier: { StackId:
<child arn> }`, a `TemplateURL` rewritten to point at the child's
AWS-canonicalized template (fetched with `GetTemplate(Processed)` after the
import), and the child's tags forwarded from `DescribeStacks`. AWS's nested
stack import validation rejects tag mismatches.

Between phases each non-root stack is flipped from `IMPORT_COMPLETE` to
`UPDATE_COMPLETE` by a no-op tag-only `UpdateStack`, because AWS rejects
`IMPORT_COMPLETE` as a non-importable status for nesting. The flip adds a
transient `cdkd:nested-export-flip` tag, which phase 1B then forwards verbatim
into the parent template.

There is no single-changeset alternative: AWS rejects `IncludeNestedStacks` on
an IMPORT changeset outright (`ValidationError: IncludeNestedStacks is not
supported for changeSet type: IMPORT`).

### Child Parameter resolution

Intrinsic-valued Parameters (`{Ref: <ParentParam>}`,
`{Fn::GetAtt: [ParentResource, Attr]}`) are resolved at import time against the
parent's resolved Parameters and cdkd state, in a root-first pre-pass: a
child's Parameters resolve against its parent's.

When a parent passes one of its SSM-typed Parameters to a child,
CloudFormation hands the nested stack the value stored under the SSM
parameter, not its name. After the export the child is a standalone
CloudFormation stack, so cdkd reads that value and submits it to the child's
changeset. The parent's own changeset still submits the SSM parameter's name,
which CloudFormation resolves. A list type is a list to the child row's `Ref`,
so `Fn::Join` and `Fn::Select` over it resolve, and a bare `Ref` hands it over
comma-joined. Only a parameter the child's row mentions is read. A
`SecureString` is never read decrypted, and CloudFormation does not accept one
for an SSM-typed Parameter.

`--dry-run` prints the per-stack plan summary without acquiring child locks or
submitting any changeset. It still resolves each child's Parameters, which can
read other stacks' outputs from cdkd state or CloudFormation. When an SSM read
fails under `--dry-run` it plans without the nested stacks' Parameter values,
so their principals read as unconfirmed.

### Failure handling

When any step from a stack's IMPORT (phase 1A) through its phase 2 fails, a
failed parent's by-hand IMPORT, or its redone adoption, must adopt its
already-imported nested children; the error names those steps.

The design rationale is in the
[nested-stack export/import design note](design/464-nested-stacks-export-import.md).

## The drift-baseline warning

A resource whose baseline a `cdkd import` run refused is listed apart, grouped
by remedy. Deploying a change to the resource restores its baseline, unless the
refusal was over a template parameter whose deployed value cdkd could not
prove; then only replacing the resource, or re-importing it while a
CloudFormation stack can prove the value, clears it. A refusal recorded by an
older cdkd without its reason is treated this way when the resource reads a
template parameter in the template the CDK app synthesizes, the same reading
the next deploy applies. With `--template`, or for a resource that template no
longer defines, the warning cannot tell and says so.

A `resources` entry that is not an object, or carries no resource type, gets
its own warning, naming the logical ids, and is left out of the baseline tally
rather than counted as a resource missing one. Most rows that reach this
warning are ones the import plan does not read a state entry for: an id the
synth template does not declare at all, an `AWS::CDK::Metadata` row, and a
Custom Resource row, which cdkd plans as a fresh create in the second phase. A
templated resource of any other type whose row has no physical id is refused
earlier, by name, with the rest of the resources cdkd cannot import, and so is
a nested stack whose row carries no type. Any other templated resource whose
row is an object with a physical id but no type is planned from the template's
type and still named in the warning.

When the stack's records are unreadable in that way, the `refresh-observed`
advice changes: that command refuses a record holding such a row, so the
warning says to repair the record first.

### Which commands the warning prints

Because `refresh-observed` rewrites state, its command is printed only when the
stack name and region render exactly as loaded. When sanitizing or the length
cap would change either, the warning names the command in prose and prints no
command to paste, since a near-match could rewrite a different stack's
baseline. It is withheld the same way for a stack whose name begins with `-`,
which the CLI reads as an option however it is quoted.

The commands are built from the stack and region `cdkd export` loaded the
record from, not the values stored inside it, and name that region so the
command selects one record when the same stack name holds state in several. A
legacy record, whose key carries no region, gets no `--stack-region` and no
`refresh-observed` command: that command refuses a record with no region, so
the warning says to migrate it first (any cdkd write does). The read-only
`cdkd state show` command is still printed when rendering altered the name.

## Values printed in messages

A plan row, a failure message and the nested-stack lists print a physical id,
a stack name or a `-c` value only when it is a plain value inert on a command
line; any other prints as "(not shown: it is not a plain identifier)", since
those messages also carry commands to paste. In the post-export `cdk` commands
such a context value prints as the quoted hole `'<context>'`.
