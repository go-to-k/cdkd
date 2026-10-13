---
title: "cdkd destroy: confirmation prompts"
description: "What cdkd destroy asks before deleting, why it refuses to run unattended without --yes, and the other commands that follow the same rule."
---

# cdkd destroy: confirmation prompts

`cdkd destroy` lists what it will delete and asks you to confirm. In a script
or a CI job nobody can answer, so the command refuses to run unless you pass
`--yes`. This page is part of [cdkd destroy](cli-destroy.md).

## The destroy prompt

```text
Resources to be deleted (3):
  - Queue (AWS::SQS::Queue)
  - Handler (AWS::Lambda::Function)
  - Uploads (AWS::S3::Bucket)

Are you sure you want to destroy stack MyStack and delete all 3 resources? (Y/n):
```

cdkd asks once per stack. The default answer is yes, so pressing
{kbd:enter} confirms. Answer `n` and cdkd has locked nothing and deleted
nothing.

These flags skip the prompt:

| Command | Flags that skip the prompt |
| --- | --- |
| `cdkd destroy` | `-y` / `--yes`, `-f` / `--force` |
| `cdkd state destroy` | `-y` / `--yes` only |

`cdkd state destroy` does not accept `-f` / `--force`.

### With `--remove-protection`

Under `--remove-protection` the prompt says how many resources will lose their
deletion protection, and the default answer changes to no (`y/N`):

```text
About to destroy 12 resources from stack MyStack, REMOVING DELETION PROTECTION on 2 of them. Continue? (y/N):
```

### Edge cases

- **Nested stacks** are destroyed as part of their parent and never prompt
  separately.
- **A stack with resources that only the rollback journal lists.** The prompt
  adds `and J recorded only in its rollback journal` after the resource count,
  and the count of protected resources includes them. See
  [Resources only the rollback journal records](cli-destroy-skipped.md#resources-only-the-rollback-journal-records).
- **An unusual stack name.** A stack name that is not a plain identifier is
  shown JSON-quoted, with its control characters removed.

## Non-interactive runs

When standard input is not a terminal (a piped, redirected or CI run), cdkd
refuses instead of asking. The error code is `NON_INTERACTIVE_CONFIRM` and the
exit code is `1`. Pass `--yes` / `-y`, or `-f` / `--force`:

```bash
cdkd destroy MyStack --yes   # CI
```

Piping `y` into the command does not work, because cdkd refuses before it
creates the prompt.

`cdkd deploy` behaves differently: without a terminal it assumes yes, because
a deploy is recoverable. A destroy refuses, because answering yes for someone
who is not there would delete every resource in the stack.

A refused run has locked nothing and deleted nothing. It has read other
stacks' state records, to check that no stack still imports an output of this
one.

### Edge cases

- **A stack with no resources.** A stack whose state record lists zero
  resources never reaches the prompt. cdkd takes the lock and deletes the
  empty record, so an unattended run of it succeeds without `--yes`.

## Other commands that prompt before a change

Ten more commands ask before they change something, and all of them follow the
rule above. Without a terminal each one refuses before it creates the prompt,
with `NON_INTERACTIVE_CONFIRM` and exit `1`. The message names the command and
the flag that avoids the prompt. Piping `y` in does not work.

| Command | Prompt | Flag that avoids it |
| --- | --- | --- |
| `cdkd rollback` | `Roll back <stack> (<region>)?` | `--force`, or `-y` / `--yes` |
| `cdkd state orphan` | `Remove state for <refs> from s3://...?` | `-y` / `--yes`, or `-f` / `--force` |
| `cdkd state orphan --resource` | `Remove the record(s) of <ids> from state for <stack> (<region>)?` | `-y` / `--yes` |
| `cdkd state refresh-observed` | `Refresh observedProperties for N stack(s)...?` | `-y` / `--yes` |
| `cdkd state refresh-observed --accept-refused` | `Accepting the refused observed baseline of <id> ... Accept it?` | `-y` / `--yes` |
| `cdkd orphan` | `Orphan N resource(s) from cdkd state...?` | `-y` / `--yes`, or `-f` / `--force` |
| `cdkd import` | `Write state for <stack> with N resource(s)?` | `-y` / `--yes` |
| `cdkd export` | Three prompts, described below | `-y` / `--yes` |
| `cdkd drift --accept` / `--revert` | `Update cdkd state...?` / `Push cdkd state values back into AWS...?` | `-y` / `--yes` |
| `cdkd import --migrate-from-cloudformation` | `Set DeletionPolicy=Retain ... delete the stack once cdkd state is written?` | `-y` / `--yes` |
| `cdkd state migrate` | `Copy N object(s) from <bucket> to <bucket>...?` | `-y` / `--yes` |
| `cdkd events prune` | `Prune deployment-event history for <stack> (<region>): <scope>?` | `-y` / `--yes` |

Two rows need more than a cell:

- **`cdkd export`** has three prompts: one to override an existing rollback
  journal, one to confirm the migration, and one to confirm a whole tree of
  nested stacks.
- **`cdkd state orphan --resource`** also accepts `-f` / `--force`, but there
  the flag does a second thing: it enables the cached-attribute fallback.

### Previews and the one exception

`cdkd state refresh-observed --dry-run` and `cdkd state migrate --dry-run`
return before the prompt. A preview therefore needs no flag and runs
unattended.

`cdkd deploy` has one prompt, which offers to create the asset storage. It is
the exception to the rule: without a terminal it assumes yes, because a deploy
is recoverable.

### What survives a refusal

A refused prompt leaves no partial change and no held lock. Two commands need
a closer look.

**Commands that hold the stack lock while they ask.** Four commands take the
stack lock before they ask: `cdkd orphan`, `cdkd import`, `cdkd export` (at
its migration and nested-tree prompts) and `cdkd rollback`. Each one releases
the lock when it refuses. A re-run with the flag is therefore not blocked by
the run that refused.

**`cdkd import --migrate-from-cloudformation`.** Its retirement prompt fires
before cdkd writes state and before it changes the CloudFormation stack, so a
refusal leaves both as they were. The message says so. Child templates the
command uploaded to `cdkd-migrate-tmp/` are deleted when it refuses, as they
are when you answer `n`.

Every other prompt refuses after read-only work only.

## Related

- [cdkd destroy](cli-destroy.md) — the command, its options and what can stop it
- [CLI Reference](cli-reference.md) — the exit codes of every command
