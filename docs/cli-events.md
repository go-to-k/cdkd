---
title: cdkd events
description: "Read deployment-event history with cdkd events, and delete old history with cdkd events prune."
---

# cdkd events

`cdkd events` shows what past `cdkd deploy`, `cdkd destroy`,
`cdkd state destroy` and `cdkd rollback` runs did to a stack. Use it to find
out why a run failed, including a run whose stack no longer exists.
`cdkd events prune` deletes old history.

```bash
# list runs, newest first
cdkd events MyStack

# one run's events, in order
cdkd events MyStack --run '<runId>'

# machine-readable output
cdkd events MyStack --json

# when history exists in several regions
cdkd events MyStack --stack-region us-west-2

# keep the newest 5 runs
cdkd events prune MyStack --keep 5
```

The command reads from the state bucket. It does not synthesize the app and
takes no stack lock. [Deployment Events](deployment-events.md) explains what
is recorded and how to read a run.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<stack>` | required | Stack name (the physical CloudFormation name). |
| `--run <runId>` | | Print one run's events instead of the run listing. |
| `--stack-region <region>` | discovered | Region whose history to read. Needed when the stack has history in more than one. |
| `--json` | `false` | Print JSON. |
| `--format <format>` | | `--format json` is the same as `--json`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json` | Bucket holding the event history. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix for state files. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | `false` | Skip the `prune` confirmation. Reading asks nothing. |
| `--verbose` | `false` | Debug-level logging. |

## `--stack-region`

You rarely need this flag. cdkd finds the region by looking at the event
files stored for the stack, and it does not need `state.json` to do so. That
is why the history of a destroyed stack is still found.

When a stack has history in more than one region, cdkd stops with an error
until you name one:

```bash
cdkd events MyStack --stack-region us-west-2
```

## Output

The default output is meant for reading in a terminal. `--json` and
`--format json` print the stored events for a tool to parse.

| Output | How stored values are printed |
| --- | --- |
| Default | Cleaned: each control character is replaced with a space before printing. |
| `--json` | Unchanged in content, with control characters written as `\uXXXX` escapes. |

### Why the default output cleans values

An event holds text that cdkd did not write: a logical ID from your
template, a reason that includes a physical name, an AWS error message. Such
text can contain a terminal escape sequence, which could clear the screen or
repaint a line. The default output cleans every stored value before printing
it, so that cannot happen.

Cleaning can leave nothing to print.
[Placeholders in the output](deployment-events.md#placeholders-in-the-output)
lists what you see then.

The run listing is stricter, because it sits above a command you may copy. It
prints each field only as one token of at most 64 printable characters, and
it names the stack and region in its header only when each is a plain
identifier. A stored value that contained spaces could otherwise imitate the
command line. Values cdkd writes itself always pass.

### Error messages are folded onto one line

The default output prints an error message on one line, even when the stored
message has line breaks. A provider's own line break could otherwise produce
a line that looks like one of cdkd's.

One kind of message keeps its line breaks: a rollback refusal that cdkd wrote
itself, marked `error.ownLines: true` in the event. It prints one line per
line, indented deeper than any event row, so its `To orphan it:` command
stays on a line apart from the provider's text.

### `--json`

JSON output is not cleaned, because replacing characters would corrupt what a
tool reads. cdkd escapes instead. Every control, format and line-separator
character is written as a `\uXXXX` escape: C0, DEL, C1, `U+2028`, `U+2029`,
the bidi controls and the zero-width characters. The output parses back to
exactly the stored values, and printing it cannot run a control sequence.

Neither format verifies the events. Someone who can write to the state bucket
can forge a whole event, the `ownLines` mark included.

## `cdkd events prune`

`cdkd events prune` deletes old runs of one stack. cdkd already removes runs
beyond the newest 20 as new runs finish, so you need this command to keep
fewer, or to remove the history of a stack you destroyed. `cdkd destroy` and
`cdkd state destroy` keep event history on purpose.

```bash
# keep the newest 20 (the default)
cdkd events prune MyStack

# keep the newest 5
cdkd events prune MyStack --keep 5

# delete runs older than 24 hours
cdkd events prune MyStack --older-than 24h

# delete everything, index included
cdkd events prune MyStack --all

# no confirmation (CI)
cdkd events prune MyStack --all --yes
```

| Flag | What is deleted |
| --- | --- |
| none | Runs beyond the newest 20. |
| `--keep <N>` | Runs beyond the newest N. N is a non-negative integer. |
| `--older-than <duration>` | Runs older than the duration. Units are `s`, `m` and `h`, as in `90m` or `24h`. |
| `--keep` with `--older-than` | Only runs that are both beyond the newest N and older than the duration. |
| `--all` | Every run and `index.json`, the summary of recent runs. |

`--all` cannot be combined with `--keep` or `--older-than`. With
`--older-than`, a run whose id has no readable timestamp is kept.

`prune` takes `<stack>` and inherits `--stack-region`, `--state-bucket`,
`--state-prefix`, `--profile`, `--role-arn`, `-y` / `--yes` and `--verbose`
from `cdkd events`, with the same meaning.

The command asks before it deletes, and the prompt names what it is about to
delete:

```text
Prune deployment-event history for <stack> (<region>): <scope>?
```

Any answer but yes deletes nothing and exits `0`. After deleting run files,
cdkd rewrites `index.json`, or removes it when no runs remain. Unlike the
automatic cleanup after a run, which only warns, `prune` reports a failure as
an error.

### Earlier versions on the versioned state bucket

`cdkd bootstrap` turns versioning on for the state bucket. On a versioned
bucket, deleting an object only hides it: every earlier version stays
readable to anyone who asks for it by version id. A run file is rewritten in
full each time cdkd saves events, so one run leaves several earlier versions.

Every delete of event history therefore deletes earlier versions too. How far
it reaches depends on the delete:

| Delete | Earlier versions removed |
| --- | --- |
| `cdkd events prune --all`, `cdkd destroy --purge-events` | Every earlier version under the stack's `deployments/` prefix, including those of run files deleted before. |
| `cdkd events prune --keep` / `--older-than`, and the automatic cleanup after a run | Only those of the run files this delete removes. |

On a bucket without versioning, nothing extra is deleted.

The `--all` sweep covers exactly the
`<state-prefix>/<stack>/<region>/deployments/` prefix, so a stack whose name
starts with this stack's name (`MyStack2`) is untouched. It keeps each key's
current version, so a run that a concurrent deploy is still writing loses
only its earlier saves.

#### Permissions

Removing earlier versions needs `s3:ListBucketVersions` and
`s3:DeleteObjectVersion` on the state bucket.
[State Management](state-management.md) has a bucket policy that grants them.

Without them the prune or destroy still succeeds, and a warning that names
the two actions prints before the summary line. The automatic cleanup after a
run removes earlier versions too, so a deploy or destroy of a stack with more
than 20 runs can print the same warning each time.

#### What a prune does not reach

- **Run files that a partial prune deleted earlier.** `--keep`,
  `--older-than` and the automatic cleanup find run files by an ordinary
  listing, which does not show a deleted file. Its earlier versions stay
  until you run `--all` or `cdkd destroy --purge-events`.
- **A region where no history is current.** The sweep covers one region, and
  cdkd finds the region from current files only. For a region where all of
  the stack's history has been deleted, pass `--stack-region <region>`.
  Without it, the prune stops with "No deployment-event history found", or
  sweeps only another region that still has current history.
- **Earlier versions of `index.json` after a partial prune.** A partial prune
  rewrites the index, so its earlier versions survive. They hold run
  summaries and never event contents. `--all` deletes the index and removes
  them.
- **The destination of a replicated bucket**, which keeps its own copies. See
  [State Management](state-management.md).

After an `--all` prune that found no current run, the summary line reads
`No runs matched`. It adds that it found no earlier versions, and names the
region, when the sweep removed none with content. A mistyped `--stack-region`
shows up this way. It says instead that the versions could not be removed
when the sweep could not finish.

#### Check what is left, and remove it yourself

```bash
# cdkd is the default --state-prefix; substitute yours if you set one.
aws s3api list-object-versions --bucket <state-bucket> \
  --prefix "<state-prefix>/<stack>/<region>/deployments/" \
  --query 'Versions[?IsLatest==`false`].{Key:Key,Id:VersionId,Size:Size}' \
  --output table

aws s3api delete-object --bucket <state-bucket> \
  --key "<state-prefix>/<stack>/<region>/deployments/<runId>.jsonl" \
  --version-id <VersionId>
```

> [!IMPORTANT]
> Pruning does not make a quoted secret safe. If a run's events quoted a
> secret, rotate the secret: the events were readable until the prune, and a
> replica or an earlier copy may still hold them.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The listing or the run's events were printed, or the prune finished. That includes a prune that matched nothing and a declined prompt. |
| `1` | Hard error. |

The refusals behind exit `1`:

| Refusal | When |
| --- | --- |
| No deployment-event history for the stack | The stack was deployed by a cdkd version that recorded none, or its history was already pruned. |
| History in multiple regions | Run again with `--stack-region <region>`. |
| No such run id | `--run <runId>` names a run this stack's history does not hold. |
| `--all` with `--keep` / `--older-than` | `--all` deletes everything, so a retention window contradicts it. |
| `NON_INTERACTIVE_CONFIRM` | The prune confirmation was reached without a terminal. Pass `-y` / `--yes`. Piping `y` in does not work. |

The codes of every command are listed in [Exit codes](cli-reference-exit-codes.md).

## Related

- [Deployment Events](deployment-events.md): event types, how to read a run,
  and where history is stored
- [Destroy flags & guards](cli-destroy.md#purge-events-also-delete-deployment-event-history-on-destroy): `--purge-events`, the destroy-time equivalent of a full prune
- [CLI Reference](cli-reference.md): every command and the exit-code table
