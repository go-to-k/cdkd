---
title: cdkd gc
description: "Delete unreferenced assets and abandoned custom-resource response placeholders from cdkd-owned storage with cdkd gc."
---

# cdkd gc

`cdkd gc` deletes the assets that no stack references any more from one
region's cdkd-owned asset storage. That storage is the asset bucket and ECR
repository that [`cdkd bootstrap`](cli-bootstrap.md) creates. Run `cdkd gc`
when the asset bucket has grown.

```bash
# print what would be deleted
cdkd gc --dry-run

# delete, after a confirmation prompt
cdkd gc

# delete without prompting (CI)
cdkd gc --yes

# collect another region's asset storage
cdkd gc --region us-west-2

# also collect assets between 7 and 30 days old
cdkd gc --older-than 7d
```

Assets pile up because `cdkd destroy` never deletes them. Another stack, or a
later rollback, may reference the same content hash.

`cdkd gc` never touches CDK bootstrap storage (`cdk-hnb659fds-*`). That stays
the job of `cdk gc`, which in turn cannot reach cdkd-owned storage.

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
gc reads every state file, so it sees the stacks deployed under any
`--state-prefix`, and nested stacks as well.
[What counts as a reference](#what-counts-as-a-reference) lists the forms it
recognizes.

## The plan and the confirmation

gc prints a plan before it deletes anything. The plan lists every item with
its key, or its tag and digest, its size and its age, followed by the byte
totals. It also names the region.

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

## Guards

gc deletes data, so it stops or keeps the item whenever something is unclear.

- **A stack is locked.** Any stack lock in the state bucket aborts the run,
  and gc lists the locked stacks. A deploy in progress may have published
  assets that its state does not record yet.
- **A state file cannot be read.** A state file that is not valid JSON aborts
  the run, because gc cannot know what that file references.
- **An item is recent.** gc keeps an object or image newer than
  `--older-than`, even when it is unreferenced. This protects publishes in
  progress and the assets a recent rollback may need.
- **The bucket belongs to someone else.** Every S3 call names the expected
  bucket owner. gc refuses a bucket that this account does not own, and never
  empties it.

### Edge cases

- **How age is measured.** gc reads an object's `LastModified` and an image's
  `imagePushedAt`. A missing timestamp counts as new, and an item exactly at
  the cutoff is kept.
- **A region with no asset storage.** The lock check runs before gc reads the
  region's bootstrap marker, so it applies in such a region too.

## Which region is collected

gc collects one region per run. The region is the first of `--region`,
`AWS_REGION`, `AWS_DEFAULT_REGION`, your profile's region and `us-east-1`.

gc finds the asset bucket and repository through the region's **bootstrap
marker**, the file in the state bucket where `cdkd bootstrap` recorded their
names. Custom names therefore work.

| The region's marker | What gc does |
| --- | --- |
| Present | Collects the asset storage it names, then the placeholders. |
| Absent | Says the region has no asset storage, then still collects the placeholders. |
| Corrupt: unparseable, or naming an invalid bucket or repository | Stops before collecting anything. The error names the remedy. |

### Edge cases

- **A region inferred from your profile.** When asset storage already exists
  in another region, gc uses that region and says so. See
  [An inferred region yields to existing asset storage](cli-reference-region.md#an-inferred-region-yields-to-existing-asset-storage).
- **An upper-cased region.** gc lower-cases the region before use. It looks
  the marker up under the lower-case key first and under the spelling you
  passed second, so `--region US-EAST-1` finds a marker written under either.

## What counts as a reference

gc looks for references in each resource's recorded properties and
attributes, and in the stack's outputs. In the state file those are the
`properties`, `observedProperties`, `attributes` and `outputs` fields. An
asset is protected when it appears there in any of these forms:

| Form | Example |
| --- | --- |
| A bucket and key pair | Lambda `Code: { S3Bucket, S3Key }`, or `{ Bucket, Key }` |
| Any object holding the asset bucket name as a value | Every sibling string in that object is protected. |
| An `s3://` URI | `s3://cdkd-assets-123456789012-us-east-1/<hash>.zip` |
| An S3 `https://` URL, virtual-hosted or path style | Query strings are ignored. |
| An ECR image URI | By `:tag`, by `@sha256:digest`, or both |
| A content-addressed `<sha256>.<ext>` token anywhere in a string | Protects keys embedded in joined lists. |
| Any of the above inside a base64 value, one level deep | EC2 or Auto Scaling `UserData` that fetches an asset at boot |

gc recognizes URLs and image URIs for every AWS partition, and ECR hosts in
their FIPS and dual-stack forms as well.
[`cdkd gc` internals](cli-gc-internals.md) has the exact matching rules.

### Known limitation

A multi-architecture image, or an image with attestations, is stored as an
index that points at child manifests. References point at the index, so an
untagged child manifest is not protected on its own.

cdkd publishes single-manifest images, so this affects only images that you
pushed into the cdkd repository by hand. Keep those out of the repository, or
reference them by digest from a deployed stack.

## Custom-resource response placeholders

A response placeholder is a small object that cdkd leaves in the state bucket
for a custom resource handler to write its answer into. gc deletes the ones
that a deploy abandoned.

Before cdkd invokes a custom resource handler, it writes an empty object to
`custom-resource-responses/{requestId}.json` in the state bucket. The handler
writes its response there through a pre-signed URL, and cdkd deletes the
object afterwards. Three things leave one behind:

- a deploy that was interrupted between the write and the cleanup, by
  {kbd:ctrl+c}, SIGTERM or a cancelled CI job;
- an error on a path that does not reach the cleanup;
- a handler response that arrives after cdkd stopped polling.

The last case matters most, because the leftover object then holds the
handler's response data and not an empty body.

Every `cdkd gc` run collects the placeholders older than `--older-than`. They
appear in the plan marked `[abandoned custom-resource response]`, and
`--dry-run` and the confirmation prompt cover them.

This is the only place where gc deletes from the state bucket. Everywhere else
it only reads the bucket.

### What the collection covers

- **The whole account.** Placeholder keys carry no region, so any run collects
  the placeholders written by deploys into every region.
- **Only keys of the form `cdkd-{epoch}-{suffix}.json`.** A stack deployed
  with `--state-prefix custom-resource-responses` keeps its `state.json`.
- **Only the default response prefix.** gc cannot discover a non-default one,
  so it leaves those objects alone.

A deploy in progress is safe. The lock guard stops the run while any stack is
locked, and the age guard applies to the placeholder's own write time.

### Earlier versions of a collected placeholder

The state bucket is versioned, so a plain delete leaves the object's body
readable by version id. gc therefore removes the older versions of each key it
collects, after it deletes the key. It does so even when the collection partly
failed.

Two situations limit that cleanup:

- **Missing permissions.** Without `s3:ListBucketVersions` or
  `s3:DeleteObjectVersion` on the state bucket, the collection still
  succeeds. gc prints a warning that counts and names the affected keys and
  names the two permissions. The bodies stay readable by version id.
- **A replicated state bucket.** The replication destination keeps its own
  copies. gc warns when it detects this.

The least-privilege policy is under
[State backup and bucket security](state-management-backup-and-security.md#iam-actions-cdkd-needs-on-the-bucket), and
[S3 replication keeps copies cdkd cannot delete](state-management-backup-and-security.md#s3-replication-keeps-copies-cdkd-cannot-delete)
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

[Exit codes](cli-reference-exit-codes.md) has the table for every command.

## Related

- [`cdkd bootstrap`](cli-bootstrap.md): creates the storage this command collects
- [`cdkd rollback`](cli-rollback.md): the replay whose asset references the age guard protects
- [State Management](state-management.md): the state bucket, its layout and the least-privilege policy
- [CLI Reference](cli-reference.md): every command and the shared options
