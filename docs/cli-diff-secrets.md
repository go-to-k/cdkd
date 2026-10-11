---
title: "cdkd diff: secrets and NoEcho values"
description: "Why cdkd diff prints *** or withholds a value, what it shows for secret references and NoEcho parameters, and what a hidden value can hide."
---

# cdkd diff: secrets and NoEcho values

`cdkd diff` does not print a secret that reaches your template as a secret
reference or a `NoEcho` parameter, and it does not look such a secret up. In
its place the output shows the reference, the mask `***`, or a placeholder.
This page explains each thing you can see there, and what a hidden value means
for the changes the diff reports.

> [!WARNING]
> There is one exception. An attribute that is itself a credential, such as a
> Cognito user pool client's `ClientSecret`, can be printed in clear text: in
> the rows, in `--json`, and in the `--verbose` log. Read
> [An attribute that is a credential](#an-attribute-that-is-a-credential)
> before you send diff output to a log other people can read.

## Secrets and `NoEcho` values in the output

A secret reaches a template in two ways, and the diff shows them differently.

A **secret reference** is a `{{resolve:...}}` string that names a secret in
Secrets Manager or SSM. The diff prints the reference itself on both sides and
does not look the secret up:

```text
  [~] Database (AWS::RDS::DBInstance)
      - MasterUserPassword:
          old: "{{resolve:secretsmanager:prod/db-old:SecretString:password::}}"
          new: "{{resolve:secretsmanager:prod/db:SecretString:password::}}"
```

A **`NoEcho` parameter** is a template parameter declared with
`NoEcho: true`. Wherever its value is used, the diff prints `***`. That covers
resource properties, outputs, export names, `--json`, and the `--verbose`
log.

### What each placeholder means

| You see | Meaning |
| --- | --- |
| `***` | A `NoEcho` parameter supplied the value. |
| `(previous NoEcho value)` | The old value is hidden. |
| A placeholder that points at `cdkd scrub` | An output's old value is withheld. |
| `app-*** (name masked: it contains a secret)` | An export name contains a secret. |
| `<name withheld: contains a secret>` | An export name is hidden entirely. |

The three in the middle need a sentence each:

- `(previous NoEcho value)` appears as the old side of a change when the state
  record was written before state schema `version: 11`. Such a record still
  holds the old value, and the diff prints neither side.
- The `cdkd scrub` placeholder appears when an output's stored value may be
  secret plaintext that an older cdkd wrote. The change is still reported.
  Running [`cdkd scrub`](cli-scrub.md)
  repairs the state record, and the value is shown again.
- An export name is withheld entirely when masking part of it would not hide
  the secret.

The rules that decide when a value is withheld are in
[cdkd diff internals](cli-diff-internals.md#withheld-previous-values).

## A changed `NoEcho` value is not shown as a change

cdkd state stores `***` wherever a `NoEcho` parameter supplied a value, and
the diff does not read AWS. So when you change the value of a `NoEcho`
parameter, the diff has nothing to compare and reports no change for the
resources that use it.

The deploy does make the comparison. The diff tells you so with one line per
stack:

```text
N unchanged resource(s) read a NoEcho parameter, whose value state holds only as ***: the deploy compares it with AWS, and updates a resource whose value changed.
```

That line is informational. `--fail` does not count it as a change.

How state stores these values is under
[Secrets in state](state-management-secrets.md#noecho-parameters).

## Values that are masked although they are not secret

The diff decides what to mask by comparing values. Any value equal to a
`NoEcho` parameter's value is printed as `***`, wherever it appears.

With a short `NoEcho` value such as `1` or `true`, unrelated properties that
happen to hold the same value are masked too. A line whose new side is masked
also hides its old side.

The limits of this masking are in
[cdkd diff internals](cli-diff-internals.md#withheld-previous-values).

## A property stored as `***`

Some properties carry a secret in a form that cdkd cannot store as a
reference. The usual example is EC2 `UserData` that wraps a `{{resolve:...}}`
reference in `Fn::Base64`: the encoded text is no longer a reference, so state
stores `***` for the whole property.

The diff cannot compare the values of such a property. It can still see when
the template around the secret changed, and it marks the line:

```text
      - UserData: [masked input or expression changed]
          old: "***"
          new: "***"
```

The note appears when the expression around the reference changed, or when a
non-secret input the expression reads changed. The deploy sends the property
again.

## An attribute that is a credential

One case prints a credential in clear text. It applies when the diff reads an
attribute from AWS because the state record lacks it, and the attribute is
itself a credential that AWS returns unmasked. A Cognito user pool client's
`ClientSecret` is an example. The value appears in the rows, in `--json`, and
in the `--verbose` log.

This affects records an older cdkd wrote and records imported with
`--migrate-from-cloudformation`, because those can lack the attribute. See the
warning under
[A state record missing an attribute](cli-diff-state-records.md#a-state-record-missing-an-attribute).

## Related

- [`cdkd diff`](cli-diff.md): the text output, the exit codes and the options
- [cdkd diff: nested stacks](cli-diff-nested-stacks.md): nested-stack parameters that hold a secret
- [`cdkd scrub`](cli-scrub.md): repair state records holding plaintext secrets
- [State Store](state-management.md): how state stores secret values
