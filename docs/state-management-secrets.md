---
title: Secrets in state
description: "Which secret values cdkd keeps out of a state record, which it stores in the clear, and what a value stored as *** changes for later deploys, drift, rollback and export."
---

# Secrets in state

cdkd keeps a secret value out of the state record when it can tell that the
value is secret. In place of the value, the record holds either the reference
that names the secret or the mask `***`. AWS always receives the real value;
only what cdkd writes down changes.

```json
{
  "MasterUsername": "admin",
  "MasterUserPassword":
    "{{resolve:secretsmanager:prod/db:SecretString:password}}",
  "LicenseKey": "***"
}
```

This page covers what the record stores. To remove secrets from records that
already hold them, use [`cdkd scrub`](cli-scrub.md). This page is part of
[State Store](state-management.md).

## What cdkd stores for a secret

| Where the value comes from | What the record holds |
| --- | --- |
| A `{{resolve:secretsmanager:...}}` or `{{resolve:ssm-secure:...}}` reference | The reference text |
| A template parameter declared `NoEcho: true` | `***` |
| A custom resource response declared `NoEcho` | `***` |
| The `Fn::Base64` encoding of a secret reference, such as EC2 `UserData` | `***` |

A reference can be resolved again on the next deploy, so storing it costs
nothing. A mask cannot be turned back into the value, and the rest of this
page describes what follows from that.

## Values that are stored in the clear

Treat `state.json` as sensitive, and limit who can read the state bucket and
its earlier object versions. cdkd cannot recognise every secret, and
`cdkd scrub` detects none of the following:

- Values that AWS reported, including ones your template never mentions.
  cdkd records what AWS reports in `observedProperties`, which is the baseline
  `cdkd drift` compares against. For a resource provisioned through Cloud
  Control it also records the reported values in `attributes`.
  [Import Existing Resources](import.md) describes this case.
- A credential that a provider records in `attributes` so that `Fn::GetAtt`
  can return it, such as the `SecretAccessKey` of an `AWS::IAM::AccessKey`.
- A `NoEcho` parameter's value in a record written before schema version 11.
  It stays until the next `cdkd deploy`, and it stays in every earlier object
  version of the record.
- A custom resource's response `Data`, unless the handler sets
  `NoEcho: true`.
- A resource name built from a secret, described next.

### A resource named after a secret keeps that name in state

Suppose a secret's value is used as a resource's name:

```ts
new sqs.Queue(this, 'Queue', {
  queueName: SecretValue.secretsManager('prod/tenant').unsafeUnwrap(),
});
```

The queue's name is now the secret's value. A name cannot be hidden, because
cdkd needs it to find the queue again and every resource that refers to the
queue receives it. The same applies to a `NoEcho` parameter used as a name.
The value is stored in:

- the queue's `physicalId`;
- another resource's resolved copy of the name, or of an identifier that
  contains it, such as the `Resource` ARN in an IAM policy. A copy of an
  attribute other than the physical ID (the queue's ARN) that was resolved
  while the queue was unchanged stores the reference in place of the name;
- stack outputs, the exports index, `rollback-journal.json`, and the queue's
  `orphans` entry if a rollback keeps the queue;
- the `physicalId` field of a [deployment event](deployment-events.md).

The queue's own `properties` still hold the reference, or `***` for a `NoEcho`
parameter. When the name comes from a `NoEcho` parameter, the deploy warns.

A copy of the physical ID itself that another resource in the same stack
reads with `Ref` or `Fn::GetAtt`, such as a queue policy's `Queues` URL, can be
stored as the ID is, so that cdkd can address the queue through it. This can
hold even where the name is a secret's whole value, and even in a property of
that resource that is itself read from the secret: those characters are
already in the queue's `physicalId`. A leaf the template spells as the
reference itself stays the reference. A copy read from another stack or
through a nested stack's parameter, one of a `NoEcho` value (still `***`), a
record an older cdkd wrote, and a `cdkd rollback` replay are not covered yet.

cdkd masks the name in its logs and in `cdkd diff` output where it recognises
that the value was read from a secret. Commands that print a stored record,
such as `cdkd state show` and `cdkd events`, print the name as stored.

CloudFormation behaves the same way and
[advises against](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html)
putting sensitive data in an identifier property. The fix is in your CDK code:
do not use a secret as a name.

## `NoEcho` parameters

Where a template parameter declared `NoEcho: true` supplies a value, cdkd
stores `***` in every part of the record that would hold the value:

| Part of the record | What is stored |
| --- | --- |
| `properties`, `observedProperties` | `***` at every position the parameter fills, whatever the type or length |
| `attributes` | `***` for an attribute declared `NoEcho`, and for one that echoes the value back, such as an SSM parameter's `Value` |
| `outputs`, the exports index | `***` for an output whose value reads the parameter |
| `rollback-journal.json` | The same masks |

A string that contains the value is stored as `***` whole, so the text around
the value is not in the record either.

A resource's physical ID is never masked. See
[A resource named after a secret](#a-resource-named-after-a-secret-keeps-that-name-in-state).

### How a deploy compares a masked value

The record only says `***`, so a deploy cannot compare the new value with the
stored one. cdkd resolves the parameter again on every deploy and then decides
for each property that reads it. The decision depends on two things: whether
the property can be updated in place or is create-only (changing it replaces
the resource), and whether AWS reports the property's current value.

| The property | What the deploy does |
| --- | --- |
| Updatable, and AWS reports it | Reads the resource; skips an unchanged value, updates a changed one |
| Updatable, and AWS does not report it | Sends the value on every deploy, with one info line per resource |
| Create-only, and AWS was seen to report it exactly | Reads the resource; a changed value replaces the resource |
| Create-only otherwise | Never replaces; warns on every deploy while it cannot confirm the value |
| Create-only, and the read failed | The resource fails with a message to re-run |

An RDS `MasterUserPassword` is an example of the second row: AWS never returns
a password.

A stack whose only difference is that its resources read a `NoEcho` parameter
is reported as `No changes`.

**Applying a new value that cdkd will not replace for.** In the fourth row,
cdkd keeps the resource because it cannot tell whether the value changed. To
apply a new value, replace the resource yourself with
`--recreate-via-cc-api <logicalId>` or
`--recreate-via-sdk-provider <logicalId>`.

**Approving a replacement.** A replacement found by reading the resource goes
through the usual guard for stateful resources
(`--force-stateful-recreation`). The approval prompt before the deploy cannot
see this replacement, because the prompt is built without reading AWS. So
under `--require-approval=destructive` or `any-change` the deploy asks again
when it reaches the replacement. `--yes` approves it.

### What `cdkd diff` shows

`cdkd diff` cannot read AWS, so it compares the masks. It prints one note per
stack saying how many unchanged resources read a `NoEcho` parameter. That note
does not count as a change for `--fail`.

### What other commands do with a masked value

- **`cdkd drift`** reports a masked position in its own group and prints
  neither the stored nor the live value. The position does not affect the exit
  code, and `--accept` and `--revert` leave it alone.
- **`cdkd rollback`** reads a masked position back from AWS and sends that
  value. It refuses when it cannot read the position.
- **`cdkd import` and `cdkd scrub`** store `***` at every position that
  today's template fills from a `NoEcho` parameter.
- **`cdkd export`** exports the record. The exported template reads the
  parameter.

### Edge cases

**A delete needs a property that a `NoEcho` parameter fills.** The record
holds `***` where the delete needs the value, so cdkd cannot address the
resource. `cdkd destroy`, or a deploy that removes the resource, skips the
delete, keeps the record and exits non-zero. Delete the resource by hand, then
run `cdkd state orphan` to drop the record.

**Another stack reads an output that a `NoEcho` parameter serves.** This works
only when both stacks deploy in one run, for example `cdkd deploy --all`. A
separate run of the consuming stack reads `***` and is refused.

**A nested stack's parameter is filled from a `NoEcho` source.** The child
stack treats the parameter as `NoEcho`, whatever the child template declares.

**An `Export.Name` holds a `NoEcho` value.** The export is not published, and
the deploy warns.

**Values that still reach the record in plain text:**

- a value shorter than 4 characters, or a number, that lands somewhere the
  template does not name directly, such as inside a longer string read through
  an attribute;
- the record of a resource the template no longer names, such as a resource
  being deleted or an `orphans` entry;
- outputs saved after the deploy failed while resolving outputs.

The contributor page
[State schema internals](state-schema-internals.md#version-11-stores-noecho-values-as-current-writers)
has every case.

### Upgrading from a record written before version 11

There is nothing to run. Schema version 11 is the version that introduced the
masks. The first `cdkd deploy` after you upgrade compares each value with the
plaintext the old record still holds. For an unchanged value it updates and
replaces nothing, and it saves `***`.

> [!WARNING]
> Rotate any `NoEcho` value a stack held before the upgrade. Earlier object
> versions of `state.json` still contain it, and cdkd does not purge them.

Only a `cdkd deploy` masks a record. A command that has no template, such as
`cdkd state refresh-observed` or `cdkd drift --accept`, saves the record as
`version: 11` without masking anything. So the version number alone does not
tell you that a record's values are masked.

## Custom resources that read a `NoEcho` parameter

cdkd cannot read a custom resource back from AWS, so it cannot tell whether
the value changed. It therefore calls the handler on every deploy.

| Request | What the handler receives |
| --- | --- |
| `Update` | `ResourceProperties` holds the real value; `OldResourceProperties` holds `***` at that position |
| `Delete` | The real value when cdkd can resolve it again from the template; otherwise cdkd skips the delete |

If your handler's `Update` is not idempotent, or it compares the old and new
properties, pass it the name or ARN of a secret and have it read the value
itself.

### When the delete is sent

`cdkd destroy` run with the CDK app resolves the value again from the template
and sends the delete. So does `cdkd deploy --recreate-via-cc-api <logicalId>`.

The handler receives the value the parameter has today. If the parameter
changed since the last deploy, the handler gets the new value.

### When the delete is skipped

cdkd skips the delete and keeps the record when it cannot resolve the value
again. That happens when:

- the command has no template. This covers `cdkd state destroy`, a deploy that
  removed the resource from the template, and a rollback;
- the property read an attribute that a custom resource or a nested stack
  declared `NoEcho`;
- the template changed in a way that makes the stored position unreliable. The
  template no longer reads a `NoEcho` parameter there, the property's template
  text or resolved inputs changed since the last deploy, the resource changed
  type, the template carries a `Transform`, or the template was synthesized
  for another region;
- on `cdkd destroy`, the expression reads anything other than parameters,
  pseudo parameters and literals, or a parameter cannot be bound;
- the record holds `***` at a position it does not list as `NoEcho`, as a
  record from an earlier cdkd does. Run `cdkd deploy` or `cdkd scrub` once to
  record the positions, then destroy.

After a skipped delete, remove what the handler manages by hand and drop the
record with `cdkd state orphan`.

## Custom resource responses marked `NoEcho`

A custom resource handler can mark its response `Data` as sensitive by setting
`NoEcho: true` on the response:

```js
// in the handler
return {
  PhysicalResourceId: id,
  Data: { Token: mintedToken },
  NoEcho: true,
};
```

cdkd then stores every string in that `Data` as `***`. The mask appears in
three places: the custom resource's own `attributes`, the `properties` of
every resource that read the value through `Fn::GetAtt`, and `outputs`. A
longer string built around the value is stored as `***` whole.

Resources that depend on the value are still created with the real one, as in
CloudFormation. Without `NoEcho: true`, the record holds the handler's values
in the clear.

### A later deploy cannot recover the value

The handler generated the value, so there is no reference cdkd could resolve
again. Once the mask is in the record, the only way to get the value back is
to run the handler.

**A later deploy must write the value, but the custom resource is unchanged.**
An unchanged custom resource's handler does not run, so cdkd has only the mask
and refuses the write. Change one of the custom resource's properties so that
its handler runs again in the same deploy.

**The handler runs and returns the same value.** cdkd cannot tell that the
value is the same, so each resource that reads it takes one redundant update.
A reader that is itself a custom resource has its own handler called again.

**The value sits in a create-only property of a reader.** cdkd reads the
reader from AWS first. It replaces the reader only when AWS cannot confirm
that the reader already holds the new value.

**The reader is in another stack.** It gets the value only when both stacks
deploy in one `cdkd deploy` run. Redeploying the producing stack alone does
not help, because the value is masked again on its way into that stack's
record.

### What other commands do with the mask

| Command | Behaviour |
| --- | --- |
| `cdkd drift` | Masks the live value; `--accept` refuses to write it into the baseline |
| `cdkd rollback` | Refuses to replay a record that holds the mask |
| `cdkd export` | Blocks a resource whose properties hold the mask |

### The `Fn::Base64` encoding of a secret reference

cdkd masks the `Fn::Base64` encoding of a secret reference in the same way,
because the encoding decodes straight back to the secret. The same commands
refuse it in the same places.

No custom resource is involved, so forcing one to run changes nothing. A
deploy that changes the resource sends the encoding again. If another resource
needs the value, have that resource build it from the secret's own reference,
so that it does not read the encoded copy from the first resource.

The full rules, including which longer strings are kept, are on the
contributor page
[State schema internals](state-schema-internals.md#noecho-custom-resource-responses).

## Related

- [`cdkd scrub`](cli-scrub.md): remove secrets from existing records and
  audit a stack
- [State backup and bucket security](state-management-backup-and-security.md):
  who can read the bucket, and what earlier object versions keep
- [State Store](state-management.md): where state lives and what a
  record contains
