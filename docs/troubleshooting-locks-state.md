---
title: Lock and state errors
description: "Fix a stale cdkd lock, a corrupted state file, state that disagrees with AWS, state bucket region errors, and a stack name that two state prefixes record."
---

# Lock and state errors

cdkd keeps one state file and one lock for each stack and region in the
state bucket. The entries here are for a lock nobody holds any more, for a
state file that is broken or out of step with AWS, and for a stack name that
two state prefixes record.

On this page:

- [Where cdkd keeps a stack's files](#where-cdkd-keeps-a-stack-s-files)
- [Reading the lock file](#reading-the-lock-file)
- [A lock left behind by Ctrl-C](#a-lock-left-behind-by-ctrl-c)
- [Stale lock after a cancelled CI job](#stale-lock-after-a-cancelled-ci-job)
- [State File is Corrupted](#state-file-is-corrupted)
- [State and Resources Don't Match](#state-and-resources-don-t-match)
- [Cross-region state bucket ("is in a different region", `PermanentRedirect`)](#cross-region-state-bucket-is-in-a-different-region-permanentredirect)
- ["Refusing to deploy stack X: it is already recorded under another state prefix"](#refusing-to-deploy-stack-x-it-is-already-recorded-under-another-state-prefix)
- ["X would be created with the cdkd-generated name N, which an existing resource already holds"](#x-would-be-created-with-the-cdkd-generated-name-n-which-an-existing-resource-already-holds)

The lock error itself, and the two steps that fix it, are under
["Failed to acquire lock" Error](troubleshooting.md#failed-to-acquire-lock-error)
on the main Troubleshooting page. The decision is the one in this diagram.
[State Store](state-management.md) describes how the lock works.

```text diagram=troubleshooting-lock-held
            ┌──────────────────────────────┐
            │ Lock error names the holder  │
            └───────┬──────────────┬───────┘
                    ▼              ▼
  ┌───────────────────────┐  ┌───────────────────────────┐
  │ Holder still running  │  │ Holder is gone            │
  │ Wait, then re-run     │  │ Cancelled CI job, killed  │
  │                       │  │ process                   │
  └───────────────────────┘  └─────────────┬─────────────┘
                                           ▼
                             ┌───────────────────────────┐
                             │ cdkd force-unlock         │
                             │ As the message prints it  │
                             └───────────────────────────┘
```

## Where cdkd keeps a stack's files

Everything cdkd records for a stack is under one prefix of the state bucket.
By default the bucket is `cdkd-state-<account>` and the prefix is `cdkd`.

```text
s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/
├── state.json                # the stack's record
├── lock.json                 # present while a command holds the lock
├── rollback-journal.json     # present after a deploy that was not rolled back
└── deployments/
    ├── index.json            # the most recent runs
    └── <runId>.jsonl         # one run's events
```

[State Store](state-management.md) and
[Deployment Event Format](deployment-events-format.md#where-events-are-stored) describe these files.

## Reading the lock file

The lock is a file named `lock.json` beside the stack's state. To look at it
yourself:

```bash
aws s3api get-object \
  --bucket cdkd-state-123456789012 \
  --key cdkd/MyStack/us-east-1/lock.json \
  /dev/stdout
```

The `expiresAt` field in that file decides when the lock expires, and the
`expires in` part of the error message is computed from it.

To remove a lock, use `cdkd force-unlock` and do not delete `lock.json` by
hand. `force-unlock` finds the same state bucket the deploy would use, and it
also removes the file's older versions from the versioned bucket.

The retry count, the retry delay and the 30-minute expiry are not
configurable. `cdkd state orphan '<stack>' --force` also deletes a held lock,
including a live one.

### Lock messages that name no holder

Two variants of the lock error do not say who holds the lock.

- `No lock could be read after the last failed attempt` means the holder
  released the lock between cdkd's attempts, or `lock.json` cannot be read.
  Re-run the command. Use `force-unlock` only if the message repeats.
- `another cdkd process holds it` means cdkd could not read who the holder is,
  because of an S3 permission gap. Find the running process before you unlock.

## A lock left behind by Ctrl-C

Pressing {kbd:ctrl+c} once does not leave a lock. During `cdkd deploy`,
`cdkd destroy`, `cdkd state destroy` or `cdkd rollback`, the first
{kbd:ctrl+c} lets the operations already in flight finish, saves state and
releases the lock, so a re-run starts at once.

Pressing {kbd:ctrl+c} a second time force-quits with exit `130`, and that can
leave the lock behind. What happens depends on the command:

| Command | On the second signal | It prints |
| --- | --- | --- |
| `cdkd destroy`, `cdkd state destroy` | Attempts a release without waiting for it | The first message below |
| `cdkd deploy` | Does not attempt a release | The second message below |
| `cdkd rollback` | Keeps running; it cannot be force-quit this way | Nothing |

```text
Force-quit: stack lock may not be released. If the next run reports a lock, run: cdkd force-unlock MyStack --stack-region us-east-1
```

```text
Force-quit: stack locks may not be released. If the next run reports a lock, run this for EACH stack it names (the region-qualified form — see the message that run prints): cdkd force-unlock <stackName> --stack-region <region>
```

After a destroy force-quit the release usually lands and no lock is left.
After a deploy force-quit, expect one and clear it with the printed command.

## Stale lock after a cancelled CI job

A CI job running `cdkd deploy` was cancelled, and the next run fails with
`Failed to acquire lock` although no deploy is in progress. This GitHub
Actions setup for per-PR environments hits it, because consecutive pushes
target the same stack:

```yaml
concurrency:
  group: pr-env-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

cdkd releases its lock when it receives `SIGINT` or `SIGTERM`, but only after
the AWS operations already in flight finish. A CI cancellation ends in
`SIGKILL`, which no process can handle. GitHub Actions sends `SIGINT`, then
`SIGTERM`, then `SIGKILL`, all within about 10 seconds. A job whose in-flight
operation takes longer than that is killed while it still holds the lock.
Kubernetes (30 s grace) and `docker stop` (10 s) send `SIGTERM` first and then
kill the same way.

Pick one:

- **Wait.** The lock expires 30 minutes after the killed job's last renewal,
  and the next run then succeeds without intervention.
- **Clear it now.**

  ```bash
  cdkd force-unlock MyStack
  ```

- **Clear it at the start of every job.** This is safe only when the workflow
  runs one job per stack at a time, as the `concurrency` group above does. No
  other run of that group can then hold the lock legitimately:

  ```yaml
  - run: npm i -g @go-to-k/cdkd
  # only safe when runs are serialized per stack
  - run: cdkd force-unlock MyStack || true
  - run: cdkd deploy MyStack --yes
  ```

> [!WARNING]
> Do not add an unconditional `force-unlock` where two jobs can operate on the
> same stack at once. It breaks the lock protecting the running deploy.

Apart from the lock, a killed deploy is rarely a problem. cdkd saves state
after each completed resource, so a re-run resumes from there. The exception
is a resource whose create was in flight when the job was killed. That
resource can exist in AWS without a state record, and the next run then fails
with an already-exists error. See
["Resource already exists" Error](troubleshooting.md#resource-already-exists-error).
[Create Per-PR Environments in CI](ci-per-pr.md) has the full workflow.

## State File is Corrupted

```
StateError: State file for stack MyStack is not valid JSON: Unexpected token } in JSON at position 123
Caused by: Unexpected token } in JSON at position 123
```

The state file is not valid JSON. Either an upload of `state.json` was
interrupted, or a manual edit broke it. A state bucket created by
`cdkd bootstrap` keeps every version of the file, so restore the last good
one.

::: steps
1. List the versions of the state file

   ```bash
   aws s3api list-object-versions \
     --bucket cdkd-state-123456789012 \
     --prefix cdkd/MyStack/us-east-1/state.json \
     --query 'Versions[].{VersionId:VersionId,LastModified:LastModified}'
   ```

2. Download the version you want and check it

   ```bash
   aws s3api get-object \
     --bucket cdkd-state-123456789012 \
     --key cdkd/MyStack/us-east-1/state.json \
     --version-id def456 \
     state-backup.json
   jq . state-backup.json > /dev/null   # fails if it is not valid JSON
   ```

3. Put it back

   ```bash
   aws s3 cp state-backup.json \
     s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
   ```
:::

If no usable version survives, rebuild state from the live resources instead
of redeploying. `cdkd import` records them without changing them:

```bash
aws s3 rm s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

### A message that names a schema version

This message does not mean the file is damaged. A newer cdkd wrote the state,
and the fix is to upgrade cdkd. Do not restore a backup.

```
StateError: Unsupported state schema version 12 for stack MyStack. This cdkd binary supports versions 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11. Upgrade cdkd to a version that supports schema 12.
```

## State and Resources Don't Match

Someone deleted or changed a resource outside cdkd, for example in the AWS
console. cdkd now tries to update a resource that is gone, or does not know
about one that exists. Start by listing what cdkd tracks:

```bash
cdkd state resources MyStack          # LogicalID, Type, PhysicalID
cdkd state resources MyStack --long   # plus dependencies and attributes
```

Then pick the case that matches.

### The resource is gone from AWS but still in state

Drop its record, and the next deploy plans the resource as a create. Both
commands below remove the record from state and never touch AWS:

```bash
# by construct path; needs the CDK app
cdkd orphan MyStack/MyTable

# by logical id; no CDK app
cdkd state orphan MyStack --stack-region us-east-1 --resource MyTable1234ABCD
```

Use `cdkd state orphan --resource` when the construct is already gone from the
app. Only `cdkd orphan` accepts `--dry-run`. Without `--resource`,
`cdkd state orphan MyStack` drops the whole stack record. Do not do that to a
stack with other live resources, because the next deploy re-creates or collides
with all of them. [Orphan Instead of Destroy](orphan-vs-destroy.md) compares the
commands.

### The resource exists in AWS but is missing from state

Adopt it. `cdkd import` records the resource without changing it.

```bash
cdkd import MyStack --dry-run   # preview; writes no state
cdkd import MyStack
```

See [Import Existing Resources](import.md) for the flags.

### You want to start over

Delete the stack through cdkd, then deploy it again:

```bash
cdkd state destroy MyStack --yes   # deletes the AWS resources AND the state
cdkd deploy MyStack
```

> [!CAUTION]
> Do not delete `state.json` and redeploy. It is not a reset. See
> [Q: What happens if I delete the state file?](troubleshooting-faq.md#q-what-happens-if-i-delete-the-state-file)

## Cross-region state bucket ("is in a different region", `PermanentRedirect`)

```
StateError: Failed to verify state bucket 'my-bucket': Bucket 'my-bucket' (in ap-northeast-1) is in a different region than the client. cdkd resolves this automatically; if you see this message, please report it.
```

The lock path reports the same condition as S3's raw redirect:

```
LockError: Failed to acquire lock for stack MyStack (ap-northeast-1):
The bucket you are attempting to access must be addressed using the
specified endpoint. Please send all future requests to this endpoint.
```

The state bucket is in a different region from the one your credentials
default to. That setup is supported. cdkd looks up the bucket's region and
talks to the bucket there for state, locks and custom-resource responses, so
you do not need to set the region to match the bucket.

Seeing either message therefore means the lookup did not take effect, which is
a bug in cdkd. Please
[open an issue](https://github.com/go-to-k/cdkd/issues) with the output of the
command re-run under `--verbose`.

`AWS_REGION` or your AWS profile sets the region resources are provisioned in.
`--region` is an option of `cdkd bootstrap`, where it picks the new bucket's
region; on other commands it is deprecated but still honored.

## "Refusing to deploy stack X: it is already recorded under another state prefix"

A command stops with one of these, and names a bucket and a prefix:

```text
Refusing to deploy stack ... recorded under another state prefix of bucket ...
Refusing to destroy stack ... recorded under another state prefix of bucket ...
Refusing to roll back stack ... recorded under another state prefix of bucket ...
```

`cdkd deploy` refuses this way on a stack's first deploy under a prefix, and
on a deploy that deletes or replaces resources. `cdkd destroy`,
`cdkd state destroy` and `cdkd rollback` refuse every time. No resource of
the stack is created, changed, reverted or deleted. Assets may already have
been published.

The same stack name and region is recorded under another `--state-prefix` of
the state bucket. A stack name is one deployment per account and region, as
in CloudFormation. Two deployments of one name share every generated resource
name, so each can delete the other's resources.
[One stack name per account and region](state-store.md#one-stack-name-per-account-and-region)
explains the rule.

Keep one deployment for each stack name and region:

| You were | Do this |
| --- | --- |
| Deploying | Use the prefix that already records the stack, or give this stack another name |
| Deploying, and the other deployment is unwanted | Remove it first with the `cdkd state destroy` or `cdkd state orphan` command the message prints |
| Destroying or rolling back | Decide which record you keep, drop the other with the `cdkd state orphan ... --state-prefix <prefix>` command the message prints, and run the command again |

`cdkd state destroy` deletes the other deployment's resources.
`cdkd state orphan` drops only its record and never deletes a resource.

### A note about a record that owns no resource

Only a record that can own a resource causes the refusal. A failed first
deploy that created nothing leaves an empty record under its prefix. cdkd
does not refuse for that record. It prints a note that names the prefix and
the `cdkd state orphan` command that removes it.

## "X would be created with the cdkd-generated name N, which an existing resource already holds"

`cdkd deploy` stops with this message, error code `GENERATED_NAME_HELD`,
before it creates a queue, topic, log group, alarm, EventBridge rule, S3
bucket, ECS cluster, load balancer, target group or state machine. Nothing
was created for that resource.

For these types, a create call under a taken name does not fail. It hands
back the existing resource, or overwrites it. A resource already holds the
name cdkd generated, and nothing this stack records names that resource.

Most often, the same stack name is also deployed under another state backend:
another `--state-prefix`, another `--state-bucket` or another account's
bucket. That deployment generates the same names.

| Whose resource it is | Do this |
| --- | --- |
| Another deployment's | Deploy this stack under that backend only, or give this stack another name |
| This stack's own | Adopt it with the `cdkd import` command the message prints, then deploy again |

The message prints the import command with the names filled in:

```bash
cdkd import MyStack --resource MyQueue=<physicalId>
```

A resource is "this stack's own" without a record when, for example, a
destroy kept it before this check existed, or it was kept under another
prefix. [Name check before a create](state-store-name-check.md) lists what
cdkd counts as a record.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
