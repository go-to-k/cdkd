---
title: Import internals
description: "How cdkd import walks nested stacks, reads older baseline-refusal markers, and re-imports Cloud Control resources."
unlisted: true
---

# Import internals

Detail behind [Import Existing Resources](import.md) and its sub-pages
([Import options and the import plan](import-reference.md),
[Importing by resource type](import-resource-types.md) and
[After an import](import-after.md)) that you need only when debugging an
import or changing `cdkd import` itself.

## Nested-stack migration

`--migrate-from-cloudformation` walks a CloudFormation stack that contains
`AWS::CloudFormation::Stack` children recursively.

- **Reading ids.** For every nested-stack row, cdkd calls
  `DescribeStackResources(<child ARN>)` to enumerate the child's resources,
  and so on to arbitrary depth. Children at every level are fetched in
  parallel.
- **Writing state.** After the root state is written, cdkd writes one
  v6-keyed state file per nested child at
  `cdkd/<parent>~<childLogicalId>/<region>/state.json`, with `parentStack` /
  `parentLogicalId` / `parentRegion` populated. Grandchildren get
  `cdkd/<parent>~<child>~<grand>/<region>/state.json`. Per-child locks are
  acquired before the write and released in reverse on success or failure.
- **The parent's row.** The root parent's state entry for each nested-stack
  row carries the synthesized cdkd-local ARN
  (`arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<logicalId>`), not
  the real AWS child stack ARN. This matches what a `cdkd deploy` writes for a
  nested stack, so an import followed by a deploy shows no phantom property
  change.
- **Retain injection.** For every nested-stack row in the parent template,
  cdkd fetches the child's template with `GetTemplate`, injects Retain on
  every non-nested-stack resource at every depth, uploads the modified child
  template to the cdkd state bucket, and rewrites the parent's
  `Properties.TemplateURL` to point at it. The parent-side `DeleteStack`
  cascades into each child: every leaf resource is retained, and the child
  stack record is deleted as a side effect.

The synthesized template and the AWS shape are validated up front. A
nested-stack row in the template with no matching AWS child, or the reverse,
is an error before any state write and names the logical id.

### Template format and size

The Retain injection parses the source template through cdkd's
CloudFormation-aware codec, which preserves every shorthand intrinsic (`!Ref`,
`!Sub`, `!GetAtt`, `!Join`) across the parse, inject and re-serialize round
trip. The update submits the template in the same format as the source: a
YAML-authored stack stays YAML, with a `.yaml` key suffix and an
`application/x-yaml` content type when uploaded.

Templates up to the 51,200-byte inline `TemplateBody` limit are submitted
directly. Larger templates are uploaded to the state bucket under
`cdkd-migrate-tmp/<stack>/<timestamp>.json` and submitted with `TemplateURL`;
the object is deleted right after `UpdateStack`. Templates over the 1 MB
`TemplateURL` limit cannot be submitted. The same limit applies independently
to every uploaded nested-child template.

## Stacks imported with cdkd 0.290.35

cdkd 0.290.35 recorded a baseline refusal without its reason. cdkd 0.290.35
and 0.290.36 both clear a marker that has no reason. If a stack imported with
0.290.35 has since had one of these resources updated by either version, or
re-imported by either after the CloudFormation stack was gone, the marker is
already gone and the deployed parameter value may be in that resource's
`observedProperties` in `state.json`, and in older S3 object versions of
`state.json`, which stay after the current one is fixed. No cdkd version can
detect this afterwards: the record looks like any other. If that can apply to
you, in this order:

1. Rotate the secret.
2. Fix the current `state.json`. When the value comes from a `{{resolve:...}}`
   reference, write that reference in the template in place of the parameter
   and deploy, so the next baseline is recorded as the reference. Otherwise no
   cdkd command removes a recorded baseline in place, and the
   `observedProperties` entry has to be removed from `state.json` by hand.
3. Last, delete the noncurrent object versions under the stack's state prefix.
   The deploy in step 2 saves state more than once, and each save turns the
   previous object, still holding the old value, into a new noncurrent
   version, so a purge done earlier has to be done again.

`cdkd state refresh-observed` is not a remedy: it reads the value from AWS
again. [`cdkd scrub`](cli-scrub.md) finds a value only through a reference the
template spells, so it finds nothing while the parameter is bound to its
placeholder.

## A refusal marker with no reason

Stacks imported with cdkd 0.290.35 carry baseline refusals without the reason.
No other refusal recorded one at the time either, so a marker with no reason
does not say which kind it is. cdkd reads it cautiously.

When the resource's definition in the template being deployed (or re-imported)
reads a template parameter, directly, through a condition, or through an
attribute of a resource that does, the refusal is treated as an
`unverifiable-parameter` one. The same holds when cdkd cannot tell: the
template cannot be read, or the definition uses an intrinsic function cdkd
does not know in a template where something reads a declared parameter. In
all of those cases `cdkd deploy` records the reason on its next state write.

The cost is that an older refusal of the other kind on such a resource also
stays until the resource is replaced or re-imported against a proving
CloudFormation stack, or until you
[accept the refusal yourself](cli-state-writing.md#accepting-a-refused-baseline).
A marker with no reason on a resource that provably reads no parameter is
cleared by an update. Every refusal now records a reason
(`incomplete-resolution` for the other kind), so the cautious reading applies
only to those older records.

Known gap: if you replace the parameter reference with its literal value
before the first deploy or re-import with a fixed cdkd that writes state (a
`--dry-run` or a deploy with no changes does not), the template no longer
shows the dependence and the marker clears.

This protects future deploys only; see
[Stacks imported with cdkd 0.290.35](#stacks-imported-with-cdkd-0-290-35) for
a value that may already be recorded.

## Re-importing a Cloud Control resource

A re-import of a resource already in state (same physical id) never replaces
an unmasked attribute value that record holds with the mask: it keeps the
recorded value and says so, naming each key, since that value is what the last
deploy recorded and may be stale. Certified attributes still take the freshly
read value. When a re-import produces no value for a key the record already
masks (`GetResource` returned no readable model, the key is masked again, or
the import omits it), the mask is kept rather than dropped. The import warns,
naming the key, only when the template reads it through `Fn::GetAtt` or a
`${Resource.Attribute}` in `Fn::Sub`, since that read is refused at deploy.
Every other kept mask is listed at `--verbose`: a deploy masks every model key
that is not an `Fn::GetAtt` attribute, so those keys are masked by design.

### Records that say `sdk` for a Cloud Control resource

An earlier cdkd version recorded every imported resource `provisionedBy: sdk`,
including each one it read through Cloud Control. Such a record still routes
through Cloud Control, and `--recreate-via-cc-api` refuses a type with no SDK
provider whatever its record says, so it needs no action.

To correct one anyway, first check with `cdkd diff` that the resource has no
pending change (the re-import records the current template's properties, so a
pending one would read as already applied). Then re-import it by its recorded
physical id, quoted since a composite id contains `|`:

```bash
cdkd import MyStack --resource '<logicalId>=<physicalId>' --force
```
