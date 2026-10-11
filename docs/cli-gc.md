---
title: cdkd gc
description: "Delete unreferenced assets and abandoned custom-resource response placeholders from cdkd-owned storage with cdkd gc."
---

# cdkd gc

`cdkd gc` deletes assets no stack references any more from one region's
cdkd-owned asset storage, the asset bucket and ECR repository that
[`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap) creates. Run it when the
asset bucket has grown. `cdkd destroy` never deletes assets, because another
stack or a later rollback may reference the same content hash.

```bash
cdkd gc --dry-run                  # print what would be deleted
cdkd gc                            # delete, after a confirmation prompt
cdkd gc --yes                      # delete without prompting (CI)
cdkd gc --region us-west-2         # collect another region's asset storage
cdkd gc --older-than 7d            # also collect assets between 7 and 30 days old
```

CDK bootstrap storage (`cdk-hnb659fds-*`) is never touched. That stays the job
of `cdk gc`, which in turn cannot reach cdkd-owned storage.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--region <region>` | see [Which region is collected](#which-region-is-collected) | Region whose asset storage to collect. |
| `--older-than <duration>` | `30d` | Never delete an object or image newer than this, even when unreferenced. Accepts `<n>d` and `<n>h`. |
| `--dry-run` | `false` | Print the plan and exit, without prompting or deleting. |
| `-y`, `--yes` | `false` | Skip the confirmation prompt. |
| `--state-bucket <bucket>` | `cdkd-state-{accountId}` | The bucket holding cdkd state. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | `false` | Debug-level logging. |

## What gc collects

| What | Where | Scope |
| --- | --- | --- |
| Unreferenced file assets | The region's asset bucket | One region per run |
| Unreferenced container images | The region's ECR repository | One region per run |
| [Abandoned custom-resource response placeholders](#custom-resource-response-placeholders) | The state bucket | The whole account |

An asset is unreferenced when no state file in the state bucket mentions it.
gc reads every state file, so stacks deployed under any `--state-prefix` and
nested stacks are all covered.

## Guards

gc deletes data, so when something is unclear it does not delete.

| Guard | What it does |
| --- | --- |
| Lock | Any stack lock in the state bucket aborts the run, listing the locked stacks. A deploy in progress may have published assets its state does not record yet. |
| Unreadable state | A state file that is not valid JSON aborts the run. gc does not delete on partial knowledge. |
| Age | An object or image newer than `--older-than` is kept, even when unreferenced. |
| Ownership | Every S3 call names the expected bucket owner. A bucket this account does not own is refused, never emptied. |

The age guard protects publishes in progress and recent rollback targets. It
reads an object's `LastModified` and an image's `imagePushedAt`. A missing
timestamp counts as new, and an item exactly at the cutoff is kept.

The lock guard runs before the region's marker is read, so it also applies in
a region with no asset storage.

## The plan and the confirmation

gc prints the plan first: every item with its key, or tag and digest, its size
and its age, followed by the byte totals.

| Situation | What happens |
| --- | --- |
| `--dry-run` | The plan is printed. Nothing is deleted. |
| Interactive run | A `Continue? (y/N)` prompt, default no. |
| `--yes` | Deleted without a prompt. |
| No terminal and no `--yes` | Refused with `NON_INTERACTIVE_CONFIRM`. |
| Nothing to collect | An info line and exit `0`, with no prompt. |

If any item fails to delete, the run ends with an error. gc does not report
success while objects remain.

> [!NOTE]
> "Nothing to collect" includes the account's response placeholders. A cron
> job that runs a bare `cdkd gc` in an idle-looking account can still find
> some and be refused. Pass `--yes` to collect, or `--dry-run` to report only.

## Which region is collected

gc collects one region per run: the first of `--region`, `AWS_REGION`,
`AWS_DEFAULT_REGION`, your profile's region and `us-east-1`. A region inferred
from your profile gives way to asset storage that already exists elsewhere, as
described under
[`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command).
The plan names the region.

The asset bucket and repository names come from the region's bootstrap marker,
not from the naming convention, so custom names work.

| The region's marker | What gc does |
| --- | --- |
| Present | Collects the asset storage it names, then the placeholders. |
| Absent | Says the region has no asset storage, then still collects the placeholders. |
| Corrupt: unparseable, or naming an invalid bucket or repository | Stops before collecting anything. The error names the remedy. |

The region is lower-cased before use, and the marker is looked up under the
lower-case key first and the spelling you passed second. `--region US-EAST-1`
therefore finds a marker written under either.

## What counts as a reference

gc collects references from each resource's `properties`,
`observedProperties` and `attributes`, and from the stack's `outputs`. These
shapes protect an asset:

| Shape | Example |
| --- | --- |
| A bucket and key pair | Lambda `Code: { S3Bucket, S3Key }`, or `{ Bucket, Key }` |
| Any object holding the asset bucket name as a value | Every sibling string in that object is protected. |
| An `s3://` URI | `s3://cdkd-assets-123456789012-us-east-1/<hash>.zip` |
| An S3 `https://` URL, virtual-hosted or path style | Query strings are ignored. |
| An ECR image URI | By `:tag`, by `@sha256:digest`, or both |
| A content-addressed `<sha256>.<ext>` token anywhere in a string | Protects keys embedded in joined lists. |
| Any of the above inside a base64 value, one level deep | EC2 or Auto Scaling `UserData` that fetches an asset at boot |

URLs and image URIs are recognized for every AWS partition, and ECR hosts also
in their FIPS and dual-stack forms.
[`cdkd gc` internals](cli-gc-internals.md) has the exact matching rules.

### Known limitation

An untagged child manifest of a referenced multi-architecture or attestation
image index is not protected on its own, because references point at the
index. cdkd publishes single-manifest images, so this affects only images you
pushed into the cdkd repository by hand. Keep those out of the repository, or
reference them by digest from a deployed stack.

## Custom-resource response placeholders

Before it invokes a custom resource handler, cdkd writes an empty object to
`custom-resource-responses/{requestId}.json` in the state bucket. The handler
writes its response there through a pre-signed URL, and cdkd deletes the object
afterwards. Three things leave one behind:

- a deploy interrupted between the write and the cleanup, by {kbd:ctrl+c},
  SIGTERM or a cancelled CI job;
- an error on a path that does not reach the cleanup;
- a handler response that arrives after cdkd stopped polling.

The last case matters most, because the leftover object then holds the
handler's response data, not an empty body.

Every `cdkd gc` run collects the placeholders older than `--older-than`. They
appear in the plan marked `[abandoned custom-resource response]` and are
covered by `--dry-run` and the confirmation prompt.

| Property | Behaviour |
| --- | --- |
| Scope | The whole account. Placeholder keys carry no region, so any run collects those written by deploys into every region. |
| A deploy in progress | Safe. The lock guard stops the run while any stack is locked, and the age guard applies to the placeholder's own write time. |
| What is matched | Only keys of the form `cdkd-{epoch}-{suffix}.json`. A stack deployed with `--state-prefix custom-resource-responses` keeps its `state.json`. |
| A non-default response prefix | Not collected. gc cannot discover one, so it leaves those objects alone. |

This is the only place gc deletes from the state bucket. Everywhere else it
only reads it.

### Earlier versions of a collected placeholder

The state bucket is versioned, so a plain delete leaves the object's body
readable by version id. gc therefore purges each collected key's noncurrent
versions after deleting it. The purge also runs when the collection partly
failed.

| Situation | Result |
| --- | --- |
| No `s3:ListBucketVersions` or `s3:DeleteObjectVersion` on the state bucket | The collection still succeeds. A warning counts and names the affected keys and the two permissions, and the bodies stay readable by version id. |
| The state bucket is replicated | The destination keeps its own copies. gc warns when it detects this. |

The least-privilege policy is under
[State Management](state-management.md#security-and-best-practices), and
[S3 replication defeats the purge](state-management.md#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you)
covers the replicated case.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The plan was printed (`--dry-run`), nothing was collectable, the prompt was declined, or every candidate was deleted. |
| `1` | Hard error: a refusal below, or an auth or AWS failure. |

| Refusal | When |
| --- | --- |
| `GC_LOCKED` | A stack in the state bucket holds an active lock. Wait for it, or clear a stale one with [`cdkd force-unlock`](cli-force-unlock.md). |
| `GC_STATE_UNREADABLE` | A state file is not valid JSON, so its references cannot be read. Repair or remove it, then run again. |
| `ASSET_STORAGE_FOREIGN_BUCKET` | The asset bucket exists but is not owned by this account, or access is denied. Nothing is touched. |
| `GC_DELETE_FAILED` | One or more objects or images could not be deleted. |
| `NON_INTERACTIVE_CONFIRM` | The confirmation prompt was reached without a terminal. Pass `-y` / `--yes`, or `--dry-run` to report only. |
| Corrupt bootstrap marker | The region's marker exists but does not parse, or names an invalid bucket or repository. The error names the remedy. |

The table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd bootstrap`](cli-bootstrap.md): creates the storage this command collects
- [`cdkd rollback`](cli-rollback.md): the replay whose asset references the age guard protects
- [State Management](state-management.md): the state bucket, its layout and the least-privilege policy
- [CLI Reference](cli-reference.md): every command and the exit-code table
