---
title: After an import
description: "What to check after cdkd import: the first diff, a cdkd-assets region, a pending rollback, the drift baseline the import recorded, and how to remove a secret that reached state."
---

# After an import

After `cdkd import`, compare the adopted state with your template and then
deploy. The rest of this page covers what the import recorded and the cases
where that needs your attention.

```bash
cdkd diff MyStack      # what the next deploy will change
cdkd deploy MyStack
cdkd drift MyStack     # later: has anything changed outside cdkd?
```

To start an import, see [Import Existing Resources](import.md).

## Check the first diff

`cdkd diff MyStack` shows two kinds of rows after an import:

- A property that differs between AWS and your template shows as a change.
  The next `cdkd deploy` applies it.
- A resource you did not import shows as `to create`.

Read the diff before you deploy. An import changes nothing in AWS, but the
first deploy after it does.

## A region that uses cdkd-owned asset storage

In a region opted into cdkd-owned asset storage with `cdkd bootstrap`, cdkd
publishes assets such as Lambda code and container images to its own storage
(`cdkd-assets-*`), and rewrites the template's asset references to match. The
resources you adopt still point at the CDK bootstrap storage
(`cdk-<qualifier>-assets-*`).

cdkd records in state the values the resources hold today, and prints an info
line with the count. Two things follow:

- The first `cdkd diff` shows a change for every asset reference: Lambda
  `Code`, container image URIs, and the IAM grants CDK generates on the asset
  bucket.
- The first `cdkd deploy` repoints the resources at cdkd's storage. Do not
  skip it. Until it runs, an IAM policy that grants read on the asset bucket
  still names the CDK bootstrap bucket, while the custom resource that
  `s3deploy.BucketDeployment` generates reads from the cdkd bucket and fails
  with `AccessDenied`.

To keep using the CDK bootstrap storage, with no change after the import, pass
`--use-cdk-bootstrap-assets` or set `context.cdkd.useCdkBootstrapAssets` in
`cdk.json`.

## A stack with a failed deploy still to roll back

A failed `cdkd deploy` leaves a rollback journal: a file in the state bucket
that lists what the deploy did, so that `cdkd rollback` can undo it. If you
import into a stack that still has one, a later rollback must not undo a
resource you have since adopted.

The import therefore marks each resource it adopts on the journal before it
writes state. A later `cdkd rollback` then skips the journal's existing
entries for those logical IDs. It warns when an entry recorded a different
resource under the same logical ID. Entries that a later deploy adds are still
rolled back as usual.

If the import cannot read or write the journal, it refuses and writes no
state. See [`cdkd rollback`](cli-rollback.md).

An older cdkd binary that does not write these marks leaves the journal
untouched, so a rollback would still act on the adopted resources. Run the
import again with a current binary and `--force` before you roll back.

## The drift baseline an import records

For each resource it adopts, cdkd reads the resource's current properties from
AWS and stores a copy in state. This copy is the **drift baseline**:
`cdkd drift` compares it with AWS later to find changes made outside cdkd. In
`state.json` it is the `observedProperties` field.

Because the baseline is a copy of what AWS holds, it can contain a secret.
cdkd keeps secrets out of it where it can, as the next section describes, and
skips the baseline altogether where it cannot do that safely.

> [!WARNING]
> Treat an imported `state.json` as sensitive. cdkd puts a secret reference
> back by matching positions between your template and what AWS returned.
> Where the two cannot be matched, a decrypted value can remain in the record.

### Secret references are stored as references

Suppose your template sets a property to `{{resolve:secretsmanager:...}}`.
AWS returns that property decrypted. cdkd finds the same position in what AWS
returned and writes the reference there, so the baseline holds the reference
and not the secret.

Where cdkd cannot match the position, it writes the mask `***` there instead.
A masked position affects `cdkd drift` in two ways:

- While the mask is the only difference, `cdkd drift` reports the position as
  not compared and exits `2`.
- If anything else at that position changed, `cdkd drift` reports drift, and
  `--accept` refuses it.

A deploy that changes nothing can clear a mask, when the resource's own secret
references are enough to confirm the value. [`cdkd drift`](cli-drift.md) lists
the property shapes that end up masked.

### Resources that get no baseline

cdkd records no baseline for a resource when it cannot place the secret
references safely. Storing what AWS returned would risk storing a decrypted
secret. The import says so at `--verbose`, and `cdkd state show` prints an
`ObservedBaseline: REFUSED` line for the resource.

For such a resource:

- `cdkd drift` compares AWS against the properties recorded from your template
  instead. That can report drift that is not real.
- `cdkd drift --accept` and `--revert` decline the resource.
- The decision is stored on the resource (`observedBaselineRefused`), and
  every command that would otherwise record a baseline respects it: the
  refresh at the start of a deploy, `cdkd state refresh-observed`,
  `cdkd drift --accept` and `--revert`, and a later import that leaves the
  resource in place.
- When an import that lists other resources leaves this one in place, it also
  removes a baseline an earlier run recorded for it.

There are two causes, and the stored decision names which one applies.

#### `incomplete-resolution`

The recorded properties no longer spell the template's dynamic reference, or
resolution discarded part of the template (such as the untaken branch of an
`Fn::If` an import cannot bind).

This clears when a deploy creates, updates or replaces the resource, because
cdkd then rebuilds the record from your template and records a real baseline.
Importing the resource again clears it too. A deploy that does not change the
resource does not clear it, and neither does `cdkd state refresh-observed`.

#### `unverifiable-parameter`

The resource depends on a template parameter, and cdkd cannot prove that the
deployed value equals the parameter's `Default`. The next section explains the
situation and how it clears.

### Parameters deployed with a non-default value

`cdkd import` takes no parameter values, so it records every template
parameter at its `Default`. A CloudFormation stack may have been deployed with
a different value. If cdkd then stored what AWS returned as the baseline, it
could store the real value of a parameter that was meant to stay secret.

So, when a CloudFormation stack backs the import, cdkd reads that stack's
deployed parameter values with `DescribeStacks` and compares them with the
defaults. The backing stack is the `--migrate-from-cloudformation` source and
each of its nested stacks. On any other import it is a CloudFormation stack
with the cdkd stack's name. cdkd only compares the deployed values. It never
records or logs them.

cdkd cannot confirm a parameter when:

- the deployed value differs from the `Default`;
- the value was deployed as a `{{resolve:...}}` reference over a placeholder
  `Default`;
- the parameter is `NoEcho`, because CloudFormation returns `****` for it.

These resources then get no baseline:

- every resource whose properties depend on such a parameter, through `Ref`,
  `Fn::Sub` or a condition;
- every resource that reads an attribute of one of those with `Fn::GetAtt`;
- any resource cdkd cannot check for the dependence.

cdkd warns once per stack and names the parameters.

> [!IMPORTANT]
> For such a resource, state holds the template `Default` and not the value
> that was deployed. A deploy that rewrites the property sends that `Default`
> to AWS. Before you deploy, put the real value in the template: replace the
> parameter with the `{{resolve:...}}` reference, or make the value the
> parameter's `Default`. Then review `cdkd diff`.

#### How this clears

Deploying a change to the resource does not clear it. `cdkd deploy` binds the
same `Default`, and an update that leaves the parameter-bound property alone
does not rewrite it in AWS. A baseline recorded afterwards would hold the
deployed value, so an in-place update keeps the resource without a baseline.
There are three ways out:

- A deploy replaces the resource, or deletes and creates it again. The new
  resource is built from the properties cdkd sent, so it gets a normal
  baseline.
- A later `cdkd import` adopts the resource again while a CloudFormation stack
  can prove the parameter was deployed at its `Default`. After
  `--migrate-from-cloudformation` that stack is gone, so importing the same
  physical id again keeps the resource without a baseline.
- You deploy a template that no longer reads the parameter at this resource,
  then clear the refusal yourself with
  [`cdkd state refresh-observed --accept-refused`](cli-state-writing.md#accepting-a-refused-baseline).

Editing the template alone does not help: an import clears this only by
proving the parameter's value.

#### Edge cases

- **No `cloudformation:DescribeStacks` permission.** The import still
  succeeds. It warns and treats every parameter as unconfirmed.
- **Nothing references a declared parameter.** cdkd makes no `DescribeStacks`
  call. CDK's own `BootstrapVersion` parameter is referenced only by `Rules`,
  so it does not count.
- **No CloudFormation stack of that name.** There is nothing to compare, and
  the import behaves as it would without this check.

### Stacks imported with cdkd 0.290.35

cdkd 0.290.35 stored the "no baseline" decision without its cause, and cdkd
0.290.35 and 0.290.36 both remove a decision that has no cause. If a stack
imported with 0.290.35 has since had one of these resources updated by either
version, the deployed parameter value may be in `state.json`. Rotate the
secret, then follow
[Import internals](import-internals.md#stacks-imported-with-cdkd-0-290-35).

## A secret set outside your template

cdkd can keep a secret out of the baseline only where your template spells a
`{{resolve:...}}` reference for it. A secret with no reference in the template
is recorded exactly as AWS returned it.
[A value your template never references](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it)
lists the ways that happens and why cdkd does not prevent it.

Two details add to that summary:

- Inside a property that does carry a reference, AWS can return a field or
  list element the template does not have. cdkd records it as returned. Where
  that leaves a reference in the property unmatched, the position may be
  masked as `***` instead.
- CloudFormation behaves the same way for a property the template sets. Its
  drift detection reports the actual value (`ActualProperties` in
  `DescribeStackResourceDrifts`), leaving out only a value the service never
  returns. cdkd's baseline also holds the properties the template never sets,
  and it is stored in `state.json`.

### Remove a secret that reached state

::: steps
1. Rotate the secret through a reference

   Store the new value in Secrets Manager, write
   `{{resolve:secretsmanager:...}}` at that property in the template, and
   deploy. The deploy sends the new value to AWS, and the next baseline
   records the reference. Confirm with:

   ```bash
   cdkd scrub MyStack --dry-run --fail
   ```

   Do not rotate in the console. That sets another value outside the template,
   which cdkd records the next time it reads the resource.

2. If the template has no property to put a reference on

   This is the case for a field AWS added, or for a property of a Cloud
   Control resource that the template never sets. No cdkd command removes such
   a value in place. Rotate the secret at its source first, then remove the
   value as described under
   [Where the value sits](#where-the-value-sits).

   Check any stack output that publishes the value as well. An output is
   stored in the stack's `outputs`, and an exported output is also stored in
   the region's exports index, the file cdkd uses to resolve cross-stack
   references.

3. Delete the earlier versions of the state file, last

   ```bash
   cdkd scrub MyStack --purge-history
   ```

   The state bucket is versioned, so earlier copies of `state.json` still hold
   the old value. This command deletes the earlier versions of every
   `state.json` it examines, including one it does not rewrite. It does not
   delete the exports index's earlier versions unless the same run rewrote
   that index. [`cdkd scrub`](cli-scrub.md) describes what the purge does not
   reach.
:::

### Where the value sits

For a value the template has no property for, the removal depends on where it
is in the record.

| Where | How to remove it |
| --- | --- |
| A nested field or list element inside a property | Remove it from the AWS resource, then run `cdkd state refresh-observed MyStack` or `cdkd drift MyStack --accept`. |
| A top-level key | Remove it from the AWS resource, or delete that key from the record's `observedProperties` in `state.json` by hand. |
| A Cloud Control resource's `attributes` | Also delete the key from `attributes` by hand. Neither command rewrites `attributes`. |

Two rules for editing `state.json` by hand:

- Do not delete a nested field from `observedProperties`. `cdkd drift`
  compares nested fields against what AWS returns, so every later run would
  report the field and print the value.
- For a top-level key, delete only that key. If you delete the whole
  `observedProperties` object, any `cdkd deploy` fills it again from AWS.

A hand edit lasts only while AWS no longer holds the value. cdkd records it
again the next time it reads the resource: on a deploy that updates the
resource, on `cdkd state refresh-observed`, or on `cdkd drift --accept`. An
edit to `attributes` lasts until the next deploy that updates the resource,
which records it again (for a Cloud Control resource: its `Fn::GetAtt`
attributes in the clear and every other property as `***`).

## Related

- [Import Existing Resources](import.md): the walkthroughs
- [`cdkd drift`](cli-drift.md): how the baseline is compared
- [`cdkd scrub`](cli-scrub.md): finding and removing secrets in state
- [State Store](state-management.md): who can read the state bucket
- [Import internals](import-internals.md): older baseline decisions and
  re-importing a Cloud Control resource
