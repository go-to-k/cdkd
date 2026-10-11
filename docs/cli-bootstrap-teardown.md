---
title: Tearing down asset storage
description: "What cdkd bootstrap --destroy deletes, the checks it runs first, how it finds a region's marker, and when --include-state-bucket is refused."
---

# Tearing down asset storage

`cdkd bootstrap --destroy` removes one region's cdkd-owned asset storage: the
asset bucket, the container-asset ECR repository, and the bootstrap marker
that records their names. It is the cdkd equivalent of deleting the CDK CLI's
`CDKToolkit` stack. The state bucket is kept unless you ask for it to be
deleted too.

```bash
cdkd bootstrap --destroy --region us-west-2          # asks for confirmation
cdkd bootstrap --destroy --region us-west-2 --yes    # no prompt (CI)
cdkd bootstrap --destroy --region us-west-2 --include-state-bucket
```

The flags are listed under [`cdkd bootstrap`](cli-bootstrap.md#options).

## What the teardown does, in order

1. It reads the asset bucket and repository names from the region's marker, so
   custom names work.
2. It refuses with `ASSET_STORAGE_IN_USE` while the state of any deployed
   stack still references the bucket or repository. `--force` overrides this
   check.
3. It prints the deletion plan and asks for confirmation (`y/N`, default no).
4. It empties and deletes the asset bucket, including all versions and delete
   markers.
5. It force-deletes the ECR repository.
6. It deletes the marker last, so a crash partway through leaves the region
   opted in.

> [!NOTE]
> The next `cdkd deploy` into the region creates the storage again, unless you
> opt out with `--no-auto-asset-storage` or
> `context.cdkd.autoAssetStorage: false`.

## The in-use check

Step 2 protects stacks that still depend on the storage. It covers every state
file in the state bucket, whatever `--state-prefix` each stack was deployed
under.

If you override the check with `--force`, Lambda functions that are already
running keep working after the storage is deleted. A later deploy or rollback
of those stacks would break, because the assets they reference are gone.

## Edge cases

- **No terminal.** Without `--yes`, cdkd refuses a run that has no terminal to
  confirm on.
- **Pieces that are already missing.** cdkd skips each with an info line. A
  region that has no marker is a no-op.
- **A bucket another account holds under the same name.** Every S3 call
  passes `ExpectedBucketOwner`, so cdkd refuses that bucket and does not
  delete it.
- **An interrupted teardown.** Deploys into the region then fail with a hint
  to bootstrap again. They do not fall back to legacy mode.

## Finding the marker for a region

cdkd lower-cases the region before the region reaches an AWS client or the
marker key. It looks for the marker under the lower-case key first, and under
the spelling you passed second, as [`cdkd gc`](cli-gc.md) does. The marker it
deletes is the one it read the names from.

### A region bootstrapped under two spellings

A region that was bootstrapped under more than one spelling of its name, such
as `us-west-2` and `US-WEST-2`, has more than one marker. The teardown then:

- deletes one marker and the storage that marker names;
- warns about each remaining marker, naming its key and the `--region`
  spelling that reaches it;
- leaves in place the storage that the remaining markers name, because each
  marker is the only record of its names.

cdkd runs the same search when it finds no marker under either spelling, so a
marker under a third spelling is reported. In that case cdkd does not suggest
running `cdkd bootstrap` again, because that would write a second marker with
the default names.

The search lists the state bucket, which needs `s3:ListBucket`. Without that
permission, a plain `--destroy` proceeds and warns that it could not search.

## Deleting the state bucket

The teardown keeps the state bucket by default. `--include-state-bucket`
deletes it too. cdkd refuses the flag while the bucket still holds something
that another stack or region needs:

| The bucket still holds | Refusal | What to do |
| --- | --- | --- |
| Any stack's state, under any `--state-prefix` | `STATE_BUCKET_NOT_EMPTY` | Destroy every stack first. `--force` does not override this. |
| Another region's marker | `STATE_BUCKET_HOLDS_MARKERS` | Tear those regions down first. |
| A marker for this region under another spelling | `STATE_BUCKET_HOLDS_SIBLING_MARKERS` | Tear it down with the spelling the refusal names. |
| Markers cdkd cannot list | `STATE_BUCKET_MARKER_SCAN_FAILED` | Grant `s3:ListBucket` on the state bucket. |

The second row exists because deleting another region's marker along with the
bucket would switch that region back to legacy mode without notice.

## Related

- [`cdkd bootstrap`](cli-bootstrap.md): creating the storage, and the refusal codes
- [`cdkd gc`](cli-gc.md): deleting unreferenced assets and keeping the storage
- [Region resolution](cli-reference-region.md): which region a bare `--destroy` acts on
- [State Management](state-management.md): what the state bucket holds
