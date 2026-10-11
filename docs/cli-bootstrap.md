---
title: cdkd bootstrap
description: "Create the cdkd state bucket and per-region asset storage with cdkd bootstrap, and tear a region's asset storage down with --destroy."
---

# cdkd bootstrap

`cdkd bootstrap` creates the AWS resources cdkd needs in an account: an S3
bucket for stack state, and per-region storage for the file and container
assets your stacks publish. Run it once per account. With `--destroy` it
removes a region's asset storage again.

```bash
cdkd bootstrap                                    # state bucket + asset storage for the region
cdkd bootstrap --region us-west-2                 # asset storage for another region
cdkd bootstrap --no-assets                        # state bucket only
cdkd bootstrap --asset-bucket my-org-cdkd-assets  # a custom asset bucket name
cdkd bootstrap --destroy --region us-west-2       # remove that region's asset storage
```

You do not have to bootstrap every region by hand. The first `cdkd deploy`
into a region [creates its asset storage](#auto-create-on-first-deploy).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--region <region>` | see below | Region to bootstrap, or to tear down with `--destroy`. |
| `--state-bucket <bucket>` | `cdkd-state-{accountId}` | Name of the state bucket to create. |
| `--no-assets` | off | Skip the asset storage: no asset bucket, ECR repository or marker. |
| `--asset-bucket <name>` | `cdkd-assets-{accountId}-{region}` | Custom asset bucket name, recorded in the region's marker. |
| `--container-repo <name>` | `cdkd-container-assets-{accountId}-{region}` | Custom container-asset ECR repository name, recorded in the region's marker. |
| `--force` | `false` | Create: reconfigure existing buckets and repository. Destroy: skip the check for stacks that still use the storage. |
| `--destroy` | `false` | Tear down the region's asset storage. |
| `--include-state-bucket` | `false` | With `--destroy`: also delete the state bucket. |
| `-y`, `--yes` | `false` | Skip the teardown confirmation. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | `false` | Debug-level logging. |

The region is the first of `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, your
profile's region and `us-east-1`. Name it explicitly: the region decides which
marker is written, and a bootstrap that lands in the wrong region opts that
region in. [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command)
has the full rules.

## What bootstrap creates

| Resource | Default name | Scope | Configuration |
| --- | --- | --- | --- |
| State bucket | `cdkd-state-{accountId}` | One per account | Versioned, AES-256 encrypted, account-only bucket policy |
| Asset bucket | `cdkd-assets-{accountId}-{region}` | One per region | AES-256 encrypted, account-only policy, no versioning |
| Container-asset ECR repository | `cdkd-container-assets-{accountId}-{region}` | One per region | Immutable tags |
| Bootstrap marker | `s3://{stateBucket}/cdkd-bootstrap/{region}.json` | One per region | Records the asset bucket and repository names |

The **bootstrap marker** is what opts a region into cdkd-owned asset storage.
It is written last, so a crash partway through leaves the region not opted in.

`cdkd state info` shows which regions are opted in, on its `Asset storage:`
line or in the `assetStorage` JSON field.

## Asset destinations after opt-in (cdkd-assets mode)

Whether a region has a marker decides where assets go.

```text diagram=cli-asset-destinations
        Read the region's bootstrap marker
        cdkd-bootstrap/{region}.json
                |
       +--------+-----------------------+
       | no marker                      | marker exists
       v                                v
  Offer to create the     created     cdkd-owned storage
  asset storage         ----------->  (asset bucket + ECR repository,
  (cdkd deploy only)                   collected by cdkd gc)
       |
       | declined, failed, or opted out
       v
  Legacy mode
  (CDK bootstrap bucket + repository,
   within reach of cdk gc)
```

| Mode | When | Where assets go |
| --- | --- | --- |
| **cdkd-assets mode** | The region has a marker | The cdkd-owned asset bucket and ECR repository |
| **Legacy mode** | The region has no marker | The destinations in the app's asset manifest, unchanged |

In cdkd-assets mode, cdkd redirects only the default CDK bootstrap
destinations for this account and region: `cdk-<qualifier>-assets-...` and
`cdk-<qualifier>-container-assets-...`. It also rewrites the template
references to them, such as `Code.S3Bucket`, `Code.ImageUri`, `s3.Asset` URLs
in environment variables and a nested stack's `TemplateURL`. The object key
and image tag, which are content hashes, do not change.

Storage you chose yourself is never redirected. That covers a custom
`fileAssetsBucketName` or `imageAssetsRepositoryName`, `AppStagingSynthesizer`
staging buckets, and destinations in another region.

| Command | In cdkd-assets mode |
| --- | --- |
| `deploy` | Redirects publishes and rewrites templates, nested stacks included. Fails any resource whose resolved properties still name CDK bootstrap storage. |
| `diff` (and `--recursive`) | Rewrites, so the plan matches what deploy will do. |
| `import` | Rewrites the template but records the original references in state. |
| `publish-assets` | Redirects. Falls back to legacy mode with an info line when no state bucket resolves. |
| `synth`, `export` | No rewrite. `synth` prints the app's template, and `export` returns the stack to CloudFormation. |
| `destroy`, `state`, `drift`, `events` | Work from state, unchanged. |

The first deploy after a region opts in updates every resource that has an
asset. It is an ordinary in-place update that points `Code` or `Image` at
cdkd storage, with the same content and no replacement. The first deploy after
a `cdkd import` shows the same update, for the reason in the `import` row.

In legacy mode, a deploy prints a one-line notice naming the region and
`cdk gc`.

### Keeping CDK bootstrap destinations

`--use-cdk-bootstrap-assets`, on `deploy`, `diff`, `import` and
`publish-assets`, publishes to the CDK bootstrap destinations for one run even
when the region is opted in. It also suppresses the legacy-mode notice. Use it
for an app deployed through both CloudFormation and cdkd during a migration.

```bash
cdkd deploy MyStack --use-cdk-bootstrap-assets
```

To set it for an app, put this in `cdk.json`:

```json
{
  "context": {
    "cdkd": { "useCdkBootstrapAssets": true }
  }
}
```

### Why cdkd owns its asset storage

`cdk gc` decides which assets are in use by scanning CloudFormation stack
templates. A stack cdkd deployed has no CloudFormation stack, so its assets in
the CDK bootstrap bucket look unreferenced to `cdk gc` and get deleted.

Storage cdkd owns is out of `cdk gc`'s reach, and
[`cdkd gc`](cli-gc.md) collects it from cdkd's own state files. The
[asset-storage design note](design/1002-cdkd-asset-storage.md) has the full
reasoning.

## Auto-create on first deploy

`cdkd deploy` into a region with no marker offers to create the asset bucket,
ECR repository and marker, the same way `cdkd bootstrap` does.

| Situation | What happens |
| --- | --- |
| Interactive run | One prompt per region (`[Y/n]`, default yes). |
| `--yes`, or no terminal | Created at once, with an info line. |
| Prompt declined, or creation failed | The deploy continues in legacy mode with a warning. |
| `--dry-run` | Nothing is created. |
| `--use-cdk-bootstrap-assets` | Nothing is created, and the marker is not read. |

To opt out, pass `--no-auto-asset-storage`, or set
`context.cdkd.autoAssetStorage: false` in `cdk.json`.

Only `deploy` creates storage. `diff`, `import` and `publish-assets` never
create resources. Auto-create always uses the default names; custom names need
an explicit `cdkd bootstrap`.

## Custom asset-storage names

`--asset-bucket` and `--container-repo` replace the default names.

```bash
cdkd bootstrap --region us-west-2 \
  --asset-bucket my-org-cdkd-assets-usw2 \
  --container-repo my-org/cdkd-container-assets
```

Use them when an organization's naming policy requires a particular shape, or
because S3 bucket names are global and another account can take the
predictable default name first.

Names are validated before any AWS call:

| Name | Rule |
| --- | --- |
| S3 bucket | 3-63 characters of lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit. |
| ECR repository | 2-256 characters of lowercase letters and digits, optionally separated by single `.`, `_`, `-` or `/`, with no leading, trailing or doubled separator. |

The names are written into the marker, and every command reads them from
there afterwards. What follows from that:

| You do | Result |
| --- | --- |
| Re-run `cdkd bootstrap` with no name flags | The marker's existing names are kept. |
| Re-bootstrap with names that differ from the marker | Refused with `ASSET_STORAGE_NAME_CONFLICT`. Run `cdkd bootstrap --destroy` for the region first. |
| Pass a name flag with `--no-assets` or `--destroy` | Refused. Teardown reads the names from the marker. |

A marker that names a bucket or repository these rules reject is treated as
malformed. A re-run of `cdkd bootstrap` warns, says what the marker recorded,
and rewrites it with the default names. Every other command refuses it.

### Ownership checks

| Situation | Result |
| --- | --- |
| The asset bucket name is owned by another account | Refused. Every asset-bucket S3 call also passes `ExpectedBucketOwner`. |
| The bucket is yours but in another region | Refused with `ASSET_STORAGE_FOREIGN_REGION_BUCKET`. `--force` does not override it. |
| The asset bucket or repository was deleted while the marker exists | Deploys fail with a hint to bootstrap again. cdkd does not fall back to CDK bootstrap storage. |

The second row is reachable when you bootstrap two regions under one custom
bucket name, because a custom name carries no region.

## Re-running bootstrap

Re-running `cdkd bootstrap` is safe. Without `--force` it leaves existing
resources untouched and creates what is missing, which makes it the way to add
asset storage for a region to an account that is already bootstrapped.

`--force` reconfigures existing resources: it applies encryption, the bucket
policy and ECR tag immutability again.

An account bootstrapped by an older cdkd needs no manual step. The first
deploy into each region creates the storage, and upgrading or downgrading the
binary is safe in either mode. Older binaries ignore the marker, and both
storages hold the same content-addressed objects.

## Teardown (`cdkd bootstrap --destroy`)

`cdkd bootstrap --destroy` removes one region's asset storage. It is the cdkd
equivalent of deleting the CDK CLI's `CDKToolkit` stack.

```bash
cdkd bootstrap --destroy --region us-west-2          # asks for confirmation
cdkd bootstrap --destroy --region us-west-2 --yes    # no prompt (CI)
```

What it does, in order:

1. Reads the asset bucket and repository names from the region's marker, so
   custom names work.
2. Refuses with `ASSET_STORAGE_IN_USE` while any deployed stack's state still
   references the bucket or repository. `--force` overrides this.
3. Prints the deletion plan and asks for confirmation (`y/N`, default no).
4. Empties and deletes the asset bucket, all versions and delete markers
   included.
5. Force-deletes the ECR repository.
6. Deletes the marker last, so a crash partway through leaves the region opted
   in.

Things to know:

- The in-use check covers every state file in the bucket, whatever
  `--state-prefix` each stack was deployed under. Running Lambdas keep working
  after the storage is deleted, but a later deploy or rollback of those stacks
  would break.
- Without `--yes`, a non-interactive run is refused.
- Pieces that are already missing are skipped with an info line, and a region
  with no marker is a no-op.
- Every S3 call passes `ExpectedBucketOwner`, so a bucket another account
  holds under the same name is refused, not deleted.
- If a teardown is interrupted, deploys into the region fail with a hint to
  bootstrap again. They do not fall back to legacy mode.

> [!NOTE]
> The next `cdkd deploy` into the region creates the storage again unless you
> opt out with `--no-auto-asset-storage` or
> `context.cdkd.autoAssetStorage: false`.

### Finding the marker for a region

cdkd lower-cases the region before it reaches an AWS client or the marker key.
It looks for the marker under the lower-case key first and the spelling you
passed second, as [`cdkd gc`](cli-gc.md) does. The marker it deletes is the one
it read the names from.

A region bootstrapped under more than one spelling of its name, such as
`us-west-2` and `US-WEST-2`, has more than one marker. The teardown then:

- deletes one marker and the storage it names;
- warns about each remaining marker, naming its key and the `--region`
  spelling that reaches it;
- leaves the storage those markers name in place, because each marker is the
  only record of its names.

The same check runs when no marker is found under either spelling, so a marker
under a third spelling is reported. In that case cdkd does not suggest running
`cdkd bootstrap` again, which would write a second marker with default names.

The check lists the state bucket, which needs `s3:ListBucket`. Without that
permission a plain `--destroy` proceeds and warns that the check could not be
made.

### Deleting the state bucket

The state bucket is kept by default. `--include-state-bucket` deletes it too,
and is refused while:

| The bucket still holds | Refusal | What to do |
| --- | --- | --- |
| Any stack's state, under any `--state-prefix` | `STATE_BUCKET_NOT_EMPTY` | Destroy every stack first. `--force` does not override this. |
| Another region's marker | `STATE_BUCKET_HOLDS_MARKERS` | Tear those regions down first. |
| A marker for this region under another spelling | `STATE_BUCKET_HOLDS_SIBLING_MARKERS` | Tear it down with the spelling the refusal names. |
| Markers cdkd cannot list | `STATE_BUCKET_MARKER_SCAN_FAILED` | Grant `s3:ListBucket` on the state bucket. |

Deleting another region's marker along with the bucket would switch that
region back to legacy mode without notice, which is why the second row
refuses.

## Relationship with `cdk bootstrap`

cdkd does not use CDK's bootstrap roles; it deploys with the caller's
credentials. It also does not resolve the template's `BootstrapVersion`
parameter. A region `cdk bootstrap` never touched therefore works.

After `cdkd export` hands a stack back to CloudFormation, `cdk bootstrap` is
the CDK CLI's own prerequisite again.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The requested storage exists (create), or is gone (teardown). Includes the cases where there was nothing to do. |
| `1` | Hard error: a refusal below, or an auth or AWS failure. |

| Refusal | When |
| --- | --- |
| `ASSET_STORAGE_NAME_CONFLICT` | Re-bootstrapping a region with `--asset-bucket` / `--container-repo` names that differ from the ones its marker records. |
| `ASSET_STORAGE_FOREIGN_REGION_BUCKET` | The named asset bucket is owned by this account but is in another region. |
| `ASSET_STORAGE_FOREIGN_BUCKET` | The named asset bucket is owned by another account, or access to it is denied. |
| `INVALID_ASSET_STORAGE_NAME` | An `--asset-bucket` / `--container-repo` name fails the validation rules. |
| `INVALID_OPTIONS` | Contradictory flags: `--asset-bucket` / `--container-repo` with `--destroy` or `--no-assets`, or `--include-state-bucket` without `--destroy`. |
| `ASSET_STORAGE_IN_USE` | Teardown: a deployed stack's state still references the region's asset storage. `--force` overrides. |
| `STATE_BUCKET_MARKER_SCAN_FAILED` | `--destroy --include-state-bucket` could not list the state bucket, so other markers cannot be checked. |
| `STATE_BUCKET_NOT_EMPTY` | `--include-state-bucket` with stack state still in the bucket. |
| `STATE_BUCKET_HOLDS_MARKERS` / `STATE_BUCKET_HOLDS_SIBLING_MARKERS` | `--include-state-bucket` while another region, or another spelling of this one, still has a marker. |
| `NON_INTERACTIVE_CONFIRM` | The teardown confirmation was reached without a terminal. Pass `-y` / `--yes`. |

The table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Getting Started](getting-started.md): where bootstrap fits in a first run
- [`cdkd gc`](cli-gc.md): collecting the storage this command creates
- [`cdkd publish-assets`](cli-publish-assets.md): publishing assets without deploying
- [State Management](state-management.md): what the state bucket holds
- [CLI Reference](cli-reference.md): every command and the exit-code table
