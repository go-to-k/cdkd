---
title: "cdkd drift: secrets and redacted values"
description: "How cdkd drift compares a property that holds a secret, why some properties show *** in the report, and what --accept and --revert do with them."
---

# cdkd drift: secrets and redacted values

cdkd avoids storing secret values in its state file, so drift cannot compare a
secret property by reading state alone. For a property that refers to a
secret, drift fetches the secret to compare it. For a property that state
holds only as the mask `***`, drift cannot compare it at all. This page covers
both, and what `--accept` and `--revert` do in each case.

It applies to a stack with properties like this one:

```ts
new lambda.Function(this, 'Handler', {
  // ...
  environment: {
    API_KEY: SecretValue.secretsManager('prod/api-key').unsafeUnwrap(),
  },
});
```

## A property that refers to a secret

CloudFormation templates refer to a secret with a dynamic reference, a string
of the form `{{resolve:...}}`. cdkd state stores that string in place of the
value behind it. This covers `{{resolve:secretsmanager:...}}`,
`{{resolve:ssm-secure:...}}`, and `{{resolve:ssm:...}}` when it names a
`SecureString` parameter.

To compare such a property, `cdkd drift` fetches the secret, holds the value
in memory, and compares it with what AWS reports. A run without `--accept` or
`--revert` writes nothing back.

When AWS holds a different value, the report shows the property as drifted and
hides the AWS side:

```text
  ~ Handler (AWS::Lambda::Function)
    - Environment.Variables.API_KEY: {{resolve:secretsmanager:prod/api-key:SecretString:::}}
    + Environment.Variables.API_KEY: ***
```

The most common cause is a Secrets Manager rotation: the secret has a new
version and the deployed resource still carries the previous one. An edit
someone made by hand looks the same, and cdkd cannot tell the two apart, so it
prints neither value.

### What each result means

| AWS holds at the property | Reported as |
| --- | --- |
| The value the reference resolves to | Clean |
| Any other value | Drifted, AWS side `***` |
| Nothing, for this one property | Neither clean nor drifted |
| Nothing, for the whole block | Drifted |

The third row is a write-only credential such as `MasterUserPassword`. AWS
never returns it, so its absence means "cannot be checked" and cdkd does not
call that drift.

The fourth row is a whole block disappearing, for example when someone removes
all of a function's environment variables. That is reported. `--accept`
declines it, because accepting would delete the reference from state. Use
`--revert`.

### Permissions drift needs

Fetching the secret needs read access to it: `secretsmanager:GetSecretValue`,
or `ssm:GetParameter` with `kms:Decrypt` on the parameter's key.

Without that access, or when the secret has been deleted, cdkd warns and
carries on. The secret properties of that one resource are listed as
[not compared](cli-drift-not-compared.md), and every other resource is checked
as usual.

### `--accept` and `--revert` on a secret property

`--accept` declines a drifted secret property and says so in the plan. It will
not write `***` into state, and it will not write a value it cannot identify.
The drift keeps being reported.

`--revert` fetches the secret first, so the resource receives the secret
value. It does not receive the `{{resolve:...}}` text.

### Finding out whether state holds a secret in plaintext

`cdkd drift` does not answer that question. Use
[`cdkd scrub`](cli-scrub.md):

```bash
cdkd scrub --dry-run --fail
```

## Redacted (`NoEcho`) baselines

Some properties in state hold the literal mask `***` with no reference behind
it. cdkd writes the mask when a value is secret but there is no
`{{resolve:...}}` string it could store in its place. Drift has nothing to
compare against at such a property.

How drift reports it depends on where the mask came from:

| Source of the mask | Effect on drift |
| --- | --- |
| A `NoEcho` custom-resource response value used in a property | Drifted on every run |
| The `Fn::Base64` encoding of a secret, such as `UserData` | Drifted on every run |
| A `NoEcho` template parameter | Listed as `noEchoParameter` |

### A mask that is reported as drift on every run

This applies to the first two rows. State holds the mask and AWS holds the
real value, so the two never match. The report prints `***` on both sides:

```text
  ~ Handler (AWS::Lambda::Function)
    - Environment.Variables.TOKEN: ***
    + Environment.Variables.TOKEN: ***
```

A run without `--accept` or `--revert` exits `1` every time, and no deploy
clears it. cdkd reports the property because the live value is readable and
cdkd cannot say whether it is the right one.

The two flags treat the masked property like this:

- `--accept` declines it.
- `--revert` keeps the value AWS has there.
- `--revert` refuses the whole resource, and exits `2`, in two cases: AWS
  reports nothing at the property, or the mask sits in a list whose elements
  cdkd cannot match to the recorded ones.

If a stack like this has to pass a drift check in CI, you have two choices.
Stop marking the custom resource's response `NoEcho`, or check the `--json`
output and filter the known property out.

When `--revert` refused because AWS reports nothing at the property, the
custom resource has to supply the value again. Change a property of the custom
resource and redeploy, so that its handler runs. A nonce property is the usual
way.

A property whose real value is the string `***` is treated the same way; see
[Secrets in state](state-management-secrets.md#custom-resource-responses-marked-noecho). How
cdkd matches list elements, and the remaining refusal cases, are in
[cdkd drift internals](cli-drift-internals.md#redacted-noecho-baselines).

### A mask from a `NoEcho` template parameter

The third row behaves differently. The resource is listed as not compared,
with the cause `noEchoParameter` and the path of the property. Every other
property of the resource is compared, and the exit code is not affected.

## A masked position cdkd could not certify

A mask can also appear where the template did use a `{{resolve:...}}`
reference. A stack adopted with `cdkd import` can show this on its first
`cdkd drift`.

It comes from how cdkd records the snapshot of a resource. AWS returns the
decrypted secret, and cdkd replaces it with the reference from the template,
matching the two by position. When cdkd cannot line the AWS response up with
the reference, it writes `***` so that no secret can end up in state. That
happens in these situations:

- AWS restructures or reorders the property.
- AWS changes the case of a name, such as `db` returned as `DB`.
- A `cdkd import` recorded a raw `Fn::Join` object.

### What drift reports

When the mask is the only difference at that position, the resource is listed
as not compared with the cause `uncertifiedBaseline`, and a run without
`--accept` or `--revert` exits `2`. `--accept` writes nothing there, and
`--revert` sends AWS its own value back unchanged.

When anything else differs there, such as an edited neighbouring value or a
list that was resized or reordered, the property is reported as drifted with
the AWS side masked. `--accept` declines it, and `--revert` often refuses the
whole resource.

The rest of the resource is compared as usual. A secret that changed exactly
at a masked position cannot be seen.

### Clearing the mask

Run `cdkd deploy`, even one that changes nothing:

```bash
cdkd deploy MyStack
```

At the start of every deploy, cdkd reads each such resource again. Where the
value AWS holds is exactly what the reference resolves to, cdkd replaces the
mask with the reference.

Three limits apply:

- A secret that was rotated since the resource was last deployed keeps its
  mask. It clears on a deploy that creates or updates that resource.
- `cdkd state refresh-observed` does not clear a mask.
- A resource whose only snapshot is a raw `Fn::Join` or `Fn::Sub` object is
  refused by `--revert`, which exits `2`. The same `cdkd deploy` fixes it.

The property shapes that produce the mask, and the rules of the re-read, are
in
[cdkd drift internals](cli-drift-internals.md#a-masked-position-cdkd-could-not-certify).

## Tokens that are not references

A `{{resolve:...}}` string that cdkd does not resolve is either text that only
looks like a reference, or a reference to a service AWS added after this cdkd
release. Drift cannot compare the property. It lists the resource as not
compared with the cause `unresolvedToken`, and a warning names the string once
per resource. The exit code is not affected.

`--revert` meets such a string when another property of the same resource
drifted. It then does one of two things at the string's position: it leaves
the live value unchanged, or it writes the string literally, as `cdkd deploy`
would. The warning printed before the confirmation prompt says which. The
rules are in
[cdkd drift internals](cli-drift-internals.md#tokens-that-are-not-references).

### Literal `ssm-secure` text left in AWS by an older cdkd

Older cdkd releases did not resolve `ssm-secure` references. A resource one of
them deployed can hold the literal `{{resolve:ssm-secure:...}}` text in AWS.

`cdkd drift` reports it for a property it can read back, and `--revert` writes
the resolved value. A write-only property such as `MasterUserPassword` cannot
be read back, so it needs one deploy that updates it.

## Related

- [`cdkd drift`](cli-drift.md): the report, the exit codes and the options
- [cdkd drift: what was not compared](cli-drift-not-compared.md): the `noEchoParameter`, `uncertifiedBaseline` and `unresolvedToken` causes
- [`cdkd scrub`](cli-scrub.md): finding and removing secret plaintext in state
- [State Store](state-management.md): how state stores secret values
- [cdkd drift internals](cli-drift-internals.md): the rules behind the edge cases
