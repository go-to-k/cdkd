---
title: cdkd scrub
description: "cdkd scrub replaces secret values that cdkd's state files hold in plaintext with their {{resolve:...}} references, and checks state for them as a CI gate, without redeploying."
---

# cdkd scrub

`cdkd scrub` finds secret values that cdkd's state files hold in plaintext and
replaces each one with the `{{resolve:...}}` reference it came from. It only
writes to the state bucket, so it creates, updates and deletes no AWS
resource. Run it after upgrading cdkd on a stack you do not want to redeploy,
and keep its check mode in CI.

```bash
# report what would change, write nothing
cdkd scrub MyStack --dry-run

# replace plaintext secrets in MyStack's state
cdkd scrub MyStack

# every stack in the app
cdkd scrub --all

# CI gate: exit 1 if a secret is in plaintext
cdkd scrub --all --dry-run --fail

# also delete old S3 versions of unchanged state files
cdkd scrub MyStack --purge-history

# explain why a stack reports clean
cdkd scrub MyStack --verbose
```

## The problem scrub solves

Suppose a Lambda function reads its database password from Secrets Manager:

```ts
new lambda.Function(this, 'Api', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('dist'),
  environment: {
    DB_PASSWORD: SecretValue.secretsManager('prod/db', {
      jsonField: 'password',
    }).unsafeUnwrap(),
  },
});
```

The synthesized template does not contain the password. It contains a
CloudFormation dynamic reference:

```json
"DB_PASSWORD": "{{resolve:secretsmanager:prod/db:SecretString:password::}}"
```

cdkd calls the Lambda API itself, so during a deploy it looks the secret up
and sends the real value. A current cdkd then saves the reference in the
stack's state file, `state.json`. A state file written by an older cdkd can
hold the real value instead, readable by anyone who can read the state bucket:

```json
"ApiFunction1A2B3C4D": {
  "resourceType": "AWS::Lambda::Function",
  "properties": {
    "Environment": { "Variables": { "DB_PASSWORD": "Xk9vQ2pLm4Rt" } }
  }
}
```

`cdkd scrub` puts the reference back, without a deploy:

```json
"Environment": {
  "Variables": {
    "DB_PASSWORD": "{{resolve:secretsmanager:prod/db:SecretString:password::}}"
  }
}
```

Scrub works out which stored values are secrets by reading your CDK app. It
synthesizes the app, looks up the current value of every `{{resolve:...}}`
reference in the templates, and searches state for those values. The values
stay in memory and are never printed.

```text diagram=scrub-touches
 Synthesize the CDK app       only the template says which values are
   │                          {{resolve:...}} references
   ▼
 Look up each reference       the secret's current value, kept in memory
   │
   ▼
 Rewrite state.json           each stack you named and its nested stacks:
   │                          resource properties and attributes,
   │                          stack outputs, names read from other stacks
   ▼
 Update the exports index     the per-region list of exported values
   │  versioned bucket
   ▼
 Delete earlier S3 versions   only of the files this run rewrote

 Never changed: AWS resources, resource names and IDs,
                values the template does not reference
```

[cdkd scrub: what it covers](cli-scrub-what-it-covers.md) lists every place scrub
looks and every value it leaves alone.

## Check, clean, and gate in CI

Scrub has two modes. With `--dry-run` it reports and writes nothing. Without
it, scrub rewrites state.

### Check what a run would change

```text
$ cdkd scrub --all --dry-run
No plaintext secrets found in ApiStack (scrub checks only values the template names through a {{resolve:...}} reference)
Would scrub 2 resource record(s) in DbStack

Plan: 1 stack(s) hold plaintext secrets and would be scrubbed (--dry-run, no state
written). ROTATE any exposed secret in Secrets Manager.
```

`ApiStack` is clean. `DbStack` has two resources whose stored properties
contain a secret value.

### Clean a stack

```text
$ cdkd scrub DbStack
Scrubbed 2 resource record(s) in DbStack

Done: scrubbed 1 stack(s). The rewritten state.json no longer holds the plaintext, and
on a VERSIONED state bucket its earlier versions were purged, unless a warning above
says otherwise. A value that was ever persisted must still be treated as compromised —
ROTATE it in Secrets Manager (scrub matches the current value, so scrub BEFORE
rotating); rotation is what makes any copy cdkd cannot reach harmless.
```

Scrub asks for no confirmation. It holds the stack's lock while it rewrites
that stack's state, the same lock a deploy takes.

> [!IMPORTANT]
> Scrubbing does not undo the exposure of a secret that was already stored in
> plaintext. Scrub first, then rotate the secret. See
> [Rotate the secret after scrubbing](#rotate-the-secret-after-scrubbing).

### Fail a CI build when state holds a secret

Add `--fail` to the check so that a finding becomes exit code `1`:

```yaml
# Fail the build if a cdkd state file holds a referenced secret in plaintext.
- run: cdkd scrub --all --dry-run --fail
```

```text
$ cdkd scrub --all --dry-run --fail
No plaintext secrets found in ApiStack (scrub checks only values the template names through a {{resolve:...}} reference)
No plaintext secrets found in DbStack (scrub checks only values the template names through a {{resolve:...}} reference)

No plaintext secrets found in any target stack state (scrub checks only values the template names through a {{resolve:...}} reference). Nothing to scrub.
```

A normal `cdkd deploy` stores references in the same way, so a passing gate is
the expected result on every build.

A passing gate describes the current `state.json` only. It says nothing about
earlier S3 versions of that file; see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stacks to scrub, by physical name or CDK display path. Their nested stacks are scrubbed too. |
| `--all` | off | Scrub every stack in the synthesized app, including stacks inside a CDK Stage. |
| `--dry-run` | off | Report what would change. Write nothing. |
| `--fail` | off | Exit `1` when a finding remains. See [`--fail`](#fail). |
| `--purge-history` | off | Also delete earlier S3 versions of state files the run examined but did not rewrite. Not allowed with `--dry-run`. |
| `--stack <name>` | — | One stack name, as an alternative to the positional argument. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket that holds the state files. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Accepted so scripts can pass it to every command. Scrub never prompts, so it changes nothing. |
| `--verbose` | off | Verbose logging, including why a stack was reported clean. |

`--region` is deprecated in favour of `AWS_REGION` or your AWS profile. Scrub
still honours it when you pass it.

Scrub needs the CDK app, which the `cdkd state ...` commands do not. A state
file stores a value with no marker of whether it is a secret, so the template
is the only place that says which values came from a `{{resolve:...}}`
reference.

Scrub has no `--parameters` flag. It reads the template with each parameter's
`Default` value, which limits what it can find; see
[What scrub cannot see](cli-scrub-what-it-covers.md#what-scrub-cannot-see).

A stack argument that matches no stack is refused, and the message lists the
stacks the app has.

## `--fail`

`--fail` turns a finding into exit code `1`. What counts as a finding depends
on whether the run can write.

| Run | Exits `1` when |
| --- | --- |
| `--dry-run --fail` | State holds a referenced secret in plaintext, or scrub would remove a leftover output. |
| `--fail` without `--dry-run` | A leak remains that scrub cannot rewrite. |

The leaks a real run cannot rewrite are listed in
[Findings scrub reports but cannot rewrite](cli-scrub-findings.md#findings-scrub-reports-but-cannot-rewrite).
The leftover outputs are described in
[Outputs the template no longer declares](cli-scrub-what-it-covers.md#outputs-the-template-no-longer-declares).

### Edge cases

- **A resource named after a secret is not a finding.** State has to store a
  resource's name, so scrub does not count it. See
  [A resource named after a secret keeps that name in state](cli-scrub-what-it-covers.md#a-resource-named-after-a-secret-keeps-that-name-in-state).
- **A passing `--dry-run --fail` can still have skipped a resource.** When
  scrub cannot check a resource, it prints a warning that names the resource,
  without `--verbose`. Read the warnings of a passing run.

## Rotate the secret after scrubbing

Treat any value that was ever stored in plaintext as compromised, and rotate
it in Secrets Manager. Scrub stops the value being read out of state from now
on, and nothing more.

The order matters. Scrub finds a secret in state by comparing state with the
secret's current value. After a rotation, the old value in state no longer
matches anything, so scrub cannot find it.

::: steps
1. Scrub

   ```bash
   cdkd scrub MyStack
   ```

2. Rotate the secret in Secrets Manager

   Rotation is what makes any copy that cdkd cannot reach harmless.

3. Redeploy, if you rotated before scrubbing

   ```bash
   cdkd deploy MyStack
   ```

   The rotation has already made the old value useless. The redeploy then
   rewrites the stored value with the reference.
:::

If you rotated first, scrub usually reports nothing to scrub. One case is
still reported: a name read from another stack that was built around the old
value. See
[A name built around a secret that has since been rotated](cli-scrub-multi-stack.md#a-name-built-around-a-secret-that-has-since-been-rotated).

## What a real run removes, and what it cannot

A real run rewrites the current state file and, on a versioned bucket, deletes
the earlier versions of every file it rewrote. Earlier versions of files it
did not rewrite stay unless you pass `--purge-history`.

The earlier versions matter because `cdkd bootstrap` turns on S3 versioning
for the state bucket. With versioning on, S3 keeps the previous content of a
file when the file is overwritten. So after scrub rewrites `state.json`, the
old content, plaintext included, is still stored as a noncurrent version.
Anyone who can call `GetObject` with a `VersionId` can read it.

Scrub therefore deletes the noncurrent versions of two kinds of file:

- each `state.json` it rewrote,
- the exports index (`exports.json`, the per-region list of exported values)
  in each region where it changed an entry.

On an unversioned bucket there is nothing to delete. If you supplied your own
bucket, check whether versioning is on:

```bash
aws s3api get-bucket-versioning --bucket <state-bucket>
```

### What the purge does not reach

The closing `Done: scrubbed ...` line does not cover the following cases.

- **A state file scrub did not rewrite.** Scrub does not write a file that is
  already clean, so its earlier versions are kept as recovery history. This is
  the situation after a current cdkd has redeployed a stack that an older cdkd
  wrote. Run `cdkd scrub MyStack --purge-history`.
- **A stack with no current state file.** A stack that was destroyed, removed
  from state with `cdkd state orphan`, or removed from the app is not examined, with or without
  `--purge-history`. Use the `aws s3api` commands below.
- **A stack scrub refused.** Its versions are never deleted. Fix what the
  refusal names and run scrub again.
- **A purge that failed.** Deleting versions needs `s3:ListBucketVersions` and
  `s3:DeleteObjectVersion`. Without them scrub still succeeds, and a warning
  names the file. Grant the permissions and run scrub again, or delete the
  versions by hand.
- **The destination of a replicated bucket.** S3 does not replicate the
  deletion of a version, so the copy keeps the plaintext. Scrub warns about
  this only when it can read the bucket's replication configuration
  (`s3:GetReplicationConfiguration`). [State Store](state-management.md)
  covers replicated state buckets.
- **Anything under `--dry-run`.** A dry run writes and deletes nothing.

`--purge-history` covers every state file the run examined: each stack you
named and each of its nested stacks that has a readable state file. It does
not delete more of the exports index's versions than a plain run does.

> [!WARNING]
> The noncurrent versions of `state.json` are also what you restore from when
> a state file is damaged. `--purge-history` and the commands below delete
> that history.

### List and delete versions by hand

```bash
# List the noncurrent versions of one stack's state file. `cdkd` is the default
# --state-prefix; substitute yours if you set one. For a nested stack, <stack>
# is `<Parent>~<Child>`.
aws s3api list-object-versions --bucket <state-bucket> \
  --prefix "<state-prefix>/<stack>/<region>/state.json" \
  --query 'Versions[?IsLatest==`false`].{
    Key:Key,Id:VersionId,Modified:LastModified}' \
  --output table

# Delete one, after confirming it is not the version you want to recover from.
aws s3api delete-object --bucket <state-bucket> \
  --key "<state-prefix>/<stack>/<region>/state.json" --version-id <VersionId>
```

The same commands work for the exports index, whose key is
`<state-prefix>/_index/<region>/exports.json`. Every cdkd stack in the region
shares that file, so its deleted history includes other stacks' earlier
entries. Nothing is lost by that, because cdkd rebuilds the index from the
state files.

### Edge cases

- **A state file in the old key layout.** Before state keys carried a region,
  a state file lived at `<state-prefix>/<stack>/state.json`. Scrub writes such
  a file to the region-scoped key, deletes the old key and deletes the old
  key's earlier versions. If the old key cannot be deleted, or scrub cannot
  confirm that it was, the stack fails with `SCRUB_LEGACY_STATE_KEY_SURVIVES`
  or `SCRUB_LEGACY_STATE_KEY_UNVERIFIED`. Delete the old key yourself and
  purge its versions with the commands above, using the old key in place of
  the region-scoped one. A second run does not check the old key again.
- **A write that failed.** When writing `state.json` fails, scrub deletes the
  file's earlier versions only if the write may have reached S3. The rule is
  in
  [cdkd scrub internals](cli-scrub-internals.md#how-the-version-purge-decides).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | State was scrubbed, or there was nothing to scrub. |
| `1` | `--fail` was set and a finding remains. See [`--fail`](#fail). |
| `2` | Scrub could not examine a stack, or could not finish a write. See [Refusals](cli-scrub-findings.md#refusals). |

The two failure codes call for different responses. Code `1` means scrub
looked and found a leak, so rotate the secret. Code `2` means scrub did not
finish looking, so fix what the message names and run it again. A CI gate
should read `2` as "not checked" and never as "plaintext found".

Exit code `2` does not depend on `--fail`. A run without the flag still exits
`2` when a stack is refused.

The table for every command is in the
[CLI Reference](cli-reference-exit-codes.md).

## In this section

- [cdkd scrub: what it covers](cli-scrub-what-it-covers.md): which values scrub
  treats as secrets, where in a state file it looks, what it leaves alone, and
  what it cannot see.
- [cdkd scrub: across stacks](cli-scrub-multi-stack.md): `--all`, nested
  stacks, values one stack reads from another, and the exports index.
- [cdkd scrub: findings and refusals](cli-scrub-findings.md): each message
  behind exit code `1`, and each `SCRUB_...` code behind exit code `2`, with
  what to do.

## Related

- [State Store](state-management.md): the state files scrub rewrites, and how a deploy stores secrets
- [`cdkd drift`](cli-drift.md): how state that holds a reference is compared against AWS
- [`cdkd diff`](cli-diff.md): which stored output values it withholds, and why
- [Use Another Stack's Outputs](cross-stack-references.md): how one stack reads another's exported values
- [CLI Reference](cli-reference.md): every command and the full exit-code table
