---
title: "cdkd scrub: what it covers"
description: "Which stored values cdkd scrub treats as secrets, where in a state file it looks, which values it leaves alone and why, and which secrets it cannot see."
---

# cdkd scrub: what it covers

[`cdkd scrub`](cli-scrub.md) rewrites a stored value only when your template
names that value through a `{{resolve:...}}` reference. It learns the secret
values by looking those references up, and then replaces each value it finds
in state with the reference. A secret that reached state some other way is
outside its reach, and a clean result does not cover it.

This page lists what scrub rewrites, what it leaves alone, and what it cannot
see.

## Which values count as secrets

Scrub handles the two kinds of CloudFormation dynamic reference that cdkd
resolves to a secret value, and one kind of parameter.

| In the template | What state should hold |
| --- | --- |
| `{{resolve:secretsmanager:...}}` | The reference |
| `{{resolve:ssm:...}}` naming a `SecureString` parameter | The reference |
| A value filled from a `NoEcho` parameter | `***` |

A `{{resolve:ssm:...}}` reference to a `String` or `StringList` parameter is
not a secret. cdkd stores its resolved value, because that value is public
configuration and storing it lets cdkd see that nothing changed between
deploys.

Storing the reference matches CloudFormation, which keeps the reference in
the template and resolves it inside the service. Two things follow from it:

- When you rotate a secret and leave the reference unchanged, the next deploy
  sees no change.
- `cdkd diff` compares references and does not fetch the secret.

[State Store](state-management.md) describes what a deploy stores and
masks.

## Where scrub looks in a state file

Scrub checks every part of `state.json` that can hold a value from the
template.

- `properties` of each resource: the values the template set.
- `attributes` of each resource: values AWS returned, which `Fn::GetAtt`
  reads.
- `observedProperties` of each resource: the copy of the resource's live
  configuration that cdkd keeps for `cdkd drift`.
- `orphans`: records of resources that a rollback left in AWS because their
  `DeletionPolicy` is `Retain`. Scrub checks these even when you have since
  removed the resource from the app.
- `outputs`: the stack's output values. See [Stack outputs](#stack-outputs).
- The names of exports and outputs the stack read from other stacks. See
  [Names of values read from another stack](cli-scrub-multi-stack.md#names-of-values-read-from-another-stack).

Beyond the stack's own state file, scrub also rewrites:

- the state file of each [nested stack](cli-scrub-multi-stack.md#nested-stacks)
  under a stack you named,
- the stack's entries in
  [the exports index](cli-scrub-multi-stack.md#the-exports-index),
- on a versioned bucket, the
  [earlier S3 versions](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot)
  of each file it rewrote, which it deletes.

How scrub matches a value in the less common shapes (two references to one
secret, a secret inside a list, a reference embedded in a longer string) is in
[cdkd scrub internals](cli-scrub-internals.md#what-gets-redacted-inside-a-record).

### Edge cases

- **A leftover record with no reference in it.** An `orphans` record for a
  resource you removed from the app can hold a plaintext and no
  `{{resolve:...}}` reference. If no resource still in the app uses the same
  secret, scrub has nothing to match the plaintext against, and the stack
  reports clean. `cdkd diff` still shows the record and `cdkd state show`
  prints it.

## What scrub leaves alone

- **Every AWS resource.** Scrub writes only to the state bucket.
- **A resource's name, and copies of that name.** See
  [A resource named after a secret keeps that name in state](#a-resource-named-after-a-secret-keeps-that-name-in-state).
- **A value your template never references.** Scrub learns a secret only by
  looking up a reference. See [What scrub cannot see](#what-scrub-cannot-see).
- **A reference you edited but have not deployed.** See
  [A reference you edited but have not deployed](#a-reference-you-edited-but-have-not-deployed).
- **Earlier S3 versions of a file it did not rewrite.** They are kept as
  recovery history unless you pass `--purge-history`.
- **A stack's `rollback-journal.json`.** This file in the state bucket lists
  what a failed deploy completed. Scrub does not rewrite it. A nested stack
  keeps its journal until its top-level stack's deploy succeeds, so a value
  scrub repaired in `state.json` can remain in the journal until then.

## A resource named after a secret keeps that name in state

When a secret's value is used as a resource's name, the name is the secret:

```ts
new sqs.Queue(this, 'Queue', {
  queueName: SecretValue.secretsManager('prod/tenant').unsafeUnwrap(),
});
```

cdkd has to store that name to find the queue again, and every resource that
refers to the queue receives it. `cdkd scrub` therefore leaves the name alone
wherever it is stored, and reports the stack as clean. The one place it still
cleans is the queue's own `QueueName` property, which it replaces with the
`{{resolve:...}}` reference. The same applies when a `NoEcho` parameter
supplies the name; the resource's own property then holds `***`.

[Secrets in state](state-management-secrets.md#a-resource-named-after-a-secret-keeps-that-name-in-state)
lists every place the name is stored. The fix is in your CDK code: do not
build a name or another identifier from a secret.

### Edge cases

Three kinds of leftover that carry such a name are handled:

- **An output the template no longer declares.** Where its value holds or
  embeds the secret's value, scrub rewrites that part to the reference.
  Otherwise the output is handled like any other
  [output the template no longer declares](#outputs-the-template-no-longer-declares).
- **An `orphans` record of another resource.** Scrub rewrites its stored
  properties and attributes in the same way. It does not rewrite the record's
  `physicalId`.
- **An exports index entry whose output is gone.** Scrub reports it when it
  holds a secret value this run looked up.

## Stack outputs

Scrub rewrites a stack's stored outputs like resource properties. For an
output the template declares, scrub knows which reference the value came
from, and it replaces the value with that reference.

`state.json` stores an exported output twice: once under the output's name,
and once under its export name (`Export.Name`). Scrub treats both keys as
declared when it can work out the export name from the template.

### Outputs the template no longer declares

State can hold an output key that today's template does not produce. The
usual cause is an output you deleted from the app. Scrub handles such a key in
one of two ways.

When the key's value contains a secret value that this run looked up, scrub
rewrites that part of the value to the secret's reference. This works even
when only a resource still uses the secret.

When scrub cannot identify the value, it removes the key from the stored
outputs. The value may be a plaintext that an older cdkd stored, and a deploy
of today's template would not write the key either. Scrub names each removed
key and never prints its value:

```text
Dropped 1 output key(s) from MyStack that its template no longer declares: OldDbUrl. ...
```

Under `--dry-run` the line starts with `Would drop`, and the stack counts as
one that would be scrubbed. `--dry-run --fail` therefore exits `1` until a
real run or a deploy removes the key.

Scrub removes keys only from a stack in which this run looked up at least one
secret. A stack whose template references no secret is not rewritten, and its
leftover keys stay.

Scrub never guesses that an unidentified value is a secret. Output values are
passed to other stacks exactly as stored, so a value wrongly rewritten to a
`{{resolve:...}}` reference would arrive in another stack's AWS call as that
literal text.

### Leftover output keys that scrub keeps

Scrub keeps a leftover key in these cases.

- **Scrub rewrote the value, fully or in part.** The key now holds the
  reference, and scrub sets its exports index entry to match.
- **The value holds no string that could be a plaintext.** There is nothing to
  protect.
- **The key's name contains a secret this run looked up.** Scrub cannot rename
  a key. It reports the key as a
  [finding](cli-scrub-findings.md#an-output-key-contains-a-secret).
- **The key may be an export name that scrub could not work out.** Scrub
  cannot tell it from a deleted output, so it keeps the key and warns
  `... were LEFT as they are`. The stack is not reported clean and `--fail`
  exits `1`. A deploy rewrites the outputs.
- **Another stack still reads the key.** Scrub keeps the key and names the
  reading stack. The stack is not reported clean and `--fail` exits `1`. Stop
  the other stack reading the key, or declare the output again, then deploy
  and run scrub again.

To find readers, scrub reads every state file in the bucket once per run. If
it cannot list the bucket or read one of the files, it removes no key from
that stack. It still scrubs the rest of the stack, and the run ends with
`SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED` (exit `2`, with or without
`--fail`).

### Edge cases

- **An export name built from a parameter.** Scrub has no `--parameters` flag.
  An `Export.Name` that needs a parameter value can come out here as
  `prefix-${Foo}`, which is not the key your deploy wrote. Scrub then treats
  the real key as a leftover. To avoid that, write the export name as a
  literal or give the parameter a `Default`.
- **A short, common secret value.** A secret such as `admin` can match text
  inside an unrelated leftover key, which scrub then rewrites. The matching
  rules and this cost are in
  [cdkd scrub internals](cli-scrub-internals.md#what-scrub-deliberately-does-not-do).
- **One old state file keeps every stack's leftover keys.** A state file
  written before cdkd recorded cross-stack reads cannot show who reads what,
  so scrub keeps all leftover keys until that stack is redeployed. This rule
  and the exact test for an export name are in
  [cdkd scrub internals](cli-scrub-internals.md#a-key-the-template-can-no-longer-name).

## What scrub cannot see

Scrub learns which values are secrets by reading today's template with
default parameter values. A clean result is only as complete as that reading.

### A value your template never references

Scrub cannot find a secret that no `{{resolve:...}}` reference in the template
names. Examples are a value someone set on the resource outside cdkd, and a
value AWS returns in a field the template never sets. The stack reports clean,
and every clean line says what was checked:

```text
No plaintext secrets found in MyStack (scrub checks only values the template names through a {{resolve:...}} reference)
```

cdkd records such a value in `observedProperties` as AWS returned it, so that
`cdkd drift` can compare against it. [`cdkd import`](import.md) describes how
to remove one. The last step is `cdkd scrub <stack> --purge-history`.

Two more kinds of value are outside the check:

- **A credential AWS generates for the resource.** cdkd stores it in
  `attributes` so that `Fn::GetAtt` can read it. Examples are the
  `SecretAccessKey` of an `AWS::IAM::AccessKey` and the `ClientSecret` of a
  Cognito user pool client. It is stored as AWS returned it.
- **A `NoEcho` parameter's value.** No reference names it, so scrub does not
  search for it. Scrub writes `***` at every position that today's template
  fills from the parameter, which is what a deploy stores. The rules for each
  position are in
  [cdkd scrub internals](cli-scrub-internals.md#how-a-noecho-parameter-value-is-masked).

### A reference built from a parameter

A reference can take part of its text from a parameter, for example an
`Fn::Sub` of `{{resolve:secretsmanager:${SecretName}}}`. Scrub fills the parameter from
today's template: its `Default`, or for an SSM-typed parameter the value
Parameter Store holds now.

If the deploy used a different value, scrub looks up a different secret than
the deploy did. The plaintext the deploy wrote can then stay in state while
the stack reports clean. This happens when, after the last deploy:

- the parameter's `Default` changed,
- an SSM-typed parameter's value changed,
- the `Default` was removed. Scrub then cannot look the reference up at all,
  and only warns.

No flag changes this. In any of these cases, inspect the stack with
`cdkd state show` and do not rely on a clean result.

### Which `Fn::If` branch scrub evaluates

Scrub evaluates conditions with default parameter values too, and it treats a
condition it cannot evaluate as false. So scrub can follow a branch that your
deploy never took.

When that branch is in a resource's properties and reads a value from
another stack, scrub can refuse your stack over a producing stack that does not exist for the parameters you
deployed with. To clear the refusal, make the read work: deploy or scrub the
stack that the branch names. `cdkd scrub --all` does that in one run.

### A placeholder scrub cannot fill

An `Fn::Sub` placeholder inside a reference can name a parameter that has no
`Default`, or a resource. Scrub cannot fill such a placeholder, so it never
looks the reference up. The only sign is a warning that contains
`keeping placeholder`, and the stack can still print
`No plaintext secrets found`.

Run `cdkd scrub --verbose` when a stack you expected findings from reports
clean.

### A reference you edited but have not deployed

Suppose state holds a reference ending in `:AWSPREVIOUS` and you changed the
template to `:AWSCURRENT` without deploying. Scrub leaves the stored reference
alone and reports nothing to scrub.

If scrub wrote the new reference into state, the next `cdkd deploy` would
compare the template with state, see no change, and never send the edit to
AWS.

## A current deploy can still store a plaintext

cdkd replaces a secret with its reference only at positions it can match
against the template. Where it cannot match, it stores the value it was given.
This can happen in three places:

- when a deploy refreshes the `observedProperties` of a resource that did not
  change,
- in `cdkd state refresh-observed`,
- in the `attributes` that `cdkd import` reads from a live resource.

So keep `cdkd scrub --all --dry-run --fail` as a standing check, and rotate
any secret that was ever stored in plaintext.

A deploy by a current cdkd replaces a state file that an older cdkd wrote. On
a versioned bucket the old content remains as an earlier S3 version; see
[What a real run removes, and what it cannot](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot).

## Commands that still handle the resolved secret

Two commands work with the secret's value where a deploy would store the
reference. Both apply to `{{resolve:secretsmanager:...}}` and to a
`SecureString` parameter.

- **`cdkd diff --recursive` on a nested stack.** A parent stack resolves a
  secret reference that it passes as a nested stack's parameter, and hands the
  child the value. So `cdkd diff --recursive` decrypts the secret when it
  plans. The deploy still stores the reference in the child's state.
- **[`cdkd export`](cli-export.md).** It writes the resolved value into the
  parameter value of the CloudFormation template it produces, so the plaintext
  is in the template handed to CloudFormation.

## Related

- [`cdkd scrub`](cli-scrub.md): the commands, options and exit codes
- [cdkd scrub: across stacks](cli-scrub-multi-stack.md): `--all`, nested stacks and values read from other stacks
- [cdkd scrub: findings and refusals](cli-scrub-findings.md): each message and code, with what to do
- [State Store](state-management.md): what a state file stores
