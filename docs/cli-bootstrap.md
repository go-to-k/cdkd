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
# state bucket + asset storage for the region
cdkd bootstrap

# asset storage for another region
cdkd bootstrap --region us-west-2

# state bucket only
cdkd bootstrap --no-assets

# a custom asset bucket name
cdkd bootstrap --asset-bucket my-org-cdkd-assets

# remove that region's asset storage
cdkd bootstrap --destroy --region us-west-2
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

The region is the first of `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`,
your profile's region and `us-east-1`. Name it explicitly. The region decides
which marker cdkd writes, so a bootstrap that lands in the wrong region opts
that region in. [Region resolution](cli-reference-region.md) has the full
rules.

## What bootstrap creates

| Resource | Default name | Scope |
| --- | --- | --- |
| State bucket | `cdkd-state-{accountId}` | One per account |
| Asset bucket | `cdkd-assets-{accountId}-{region}` | One per region |
| Container-asset ECR repository | `cdkd-container-assets-{accountId}-{region}` | One per region |
| Bootstrap marker | `s3://{stateBucket}/cdkd-bootstrap/{region}.json` | One per region |

cdkd configures them as follows:

- The state bucket is versioned, encrypted with AES-256, and has a bucket
  policy that admits this account only.
- The asset bucket is encrypted with AES-256 and has the same account-only
  policy. It is not versioned.
- The ECR repository has immutable tags.

The **bootstrap marker** is a small file in the state bucket that records the
names of a region's asset bucket and ECR repository. A region that has a
marker is opted in to cdkd-owned asset storage. cdkd writes the marker last,
so a crash partway through a bootstrap leaves the region not opted in.

To see which regions are opted in, run `cdkd state info`. It reports them on
its `Asset storage:` line, or in the `assetStorage` field of its JSON output.

## Asset destinations after opt-in (cdkd-assets mode)

Whether a region has a marker decides where a deploy publishes its assets.

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

In legacy mode, a deploy prints a one-line notice that names the region and
`cdk gc`.

### What cdkd redirects in cdkd-assets mode

A CDK app writes its asset destinations into its asset manifest, and by
default they are the CDK bootstrap bucket and repository. In cdkd-assets mode,
cdkd redirects those default destinations for this account and region:
`cdk-<qualifier>-assets-...` and `cdk-<qualifier>-container-assets-...`.

cdkd also rewrites the references to them in the template, so that resources
point at the storage the assets went to. Examples are `Code.S3Bucket`,
`Code.ImageUri`, `s3.Asset` URLs in environment variables, and a nested
stack's `TemplateURL`. The object key and the image tag are content hashes,
and they do not change.

cdkd never redirects storage you chose yourself. That covers a custom
`fileAssetsBucketName` or `imageAssetsRepositoryName`, the staging buckets of
`AppStagingSynthesizer`, and destinations in another region.

### What each command does in cdkd-assets mode

- **`deploy`** redirects publishes and rewrites templates, nested stacks
  included. It fails any resource whose resolved properties still name CDK
  bootstrap storage.
- **`diff`**, with or without `--recursive`, rewrites the template, so that
  the plan matches what deploy will do.
- **`import`** rewrites the template, but records the original references in
  state.
- **`publish-assets`** redirects. When no state bucket resolves, it falls back
  to legacy mode and prints an info line.
- **`synth`** and **`export`** do not rewrite. `synth` prints the app's
  template, and `export` returns the stack to CloudFormation.
- **`destroy`**, **`state`**, **`drift`** and **`events`** work from state and
  are unchanged.

### The first deploy after a region opts in

The first deploy after a region opts in updates every resource that has an
asset. It is an ordinary in-place update that points `Code` or `Image` at cdkd
storage. The content is the same and nothing is replaced.

The first deploy after a `cdkd import` shows the same update, because `import`
recorded the original references.

### Keeping CDK bootstrap destinations

`--use-cdk-bootstrap-assets` publishes to the CDK bootstrap destinations for
one run, even when the region is opted in. It also suppresses the legacy-mode
notice. `deploy`, `diff`, `import` and `publish-assets` accept it. Use it for
an app that is deployed through both CloudFormation and cdkd during a
migration.

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
templates. A stack that cdkd deployed has no CloudFormation stack. Its assets
in the CDK bootstrap bucket therefore look unreferenced to `cdk gc`, and
`cdk gc` deletes them.

Storage that cdkd owns is out of `cdk gc`'s reach, and
[`cdkd gc`](cli-gc.md) collects it by reading cdkd's own state files. The
[asset-storage design note](design/1002-cdkd-asset-storage.md) has the full
reasoning.

## Auto-create on first deploy

When `cdkd deploy` runs in a region that has no marker, it offers to create
the asset bucket, the ECR repository and the marker, the same way
`cdkd bootstrap` does.

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
create resources. Auto-create always uses the default names, so custom names
need an explicit `cdkd bootstrap`.

## Custom asset-storage names

`--asset-bucket` and `--container-repo` replace the default names.

```bash
cdkd bootstrap --region us-west-2 \
  --asset-bucket my-org-cdkd-assets-usw2 \
  --container-repo my-org/cdkd-container-assets
```

There are two reasons to use them. An organization's naming policy may require
a particular shape. And S3 bucket names are global, so another account can
take the predictable default name before you do.

cdkd validates the names before any AWS call:

| Name | Rule |
| --- | --- |
| S3 bucket | 3-63 characters of lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit. |
| ECR repository | 2-256 characters of lowercase letters and digits, optionally separated by single `.`, `_`, `-` or `/`, with no leading, trailing or doubled separator. |

cdkd writes the names into the region's marker, and every command reads them
from the marker afterwards. Three things follow from that:

- Running `cdkd bootstrap` again with no name flags keeps the names in the
  marker.
- Bootstrapping again with names that differ from the marker is refused with
  `ASSET_STORAGE_NAME_CONFLICT`. Run `cdkd bootstrap --destroy` for the region
  first.
- Passing a name flag with `--no-assets` or `--destroy` is refused. Teardown
  reads the names from the marker.

### Edge cases

- **The asset bucket name is owned by another account.** cdkd refuses. Every
  S3 call on the asset bucket also passes `ExpectedBucketOwner`.
- **The bucket is yours but in another region.** cdkd refuses with
  `ASSET_STORAGE_FOREIGN_REGION_BUCKET`, and `--force` does not override it.
  You can reach this by bootstrapping two regions under one custom bucket
  name, because a custom name carries no region.
- **The asset bucket or repository was deleted while the marker exists.**
  Deploys fail with a hint to bootstrap again. cdkd does not fall back to CDK
  bootstrap storage.
- **The marker names a bucket or repository that the rules above reject.**
  cdkd treats such a marker as malformed. Running `cdkd bootstrap` again
  warns, says what the marker recorded, and rewrites it with the default
  names. Every other command refuses the marker.

## Re-running bootstrap

Running `cdkd bootstrap` again is safe. Without `--force`, it leaves existing
resources untouched and creates what is missing. That makes it the way to add
asset storage for a new region to an account that is already bootstrapped.

With `--force`, it reconfigures existing resources: it applies encryption, the
bucket policy and ECR tag immutability again.

An account that was bootstrapped by an older cdkd needs no manual step. The
first deploy into each region creates the storage. Upgrading or downgrading
the binary is safe in either mode, because older binaries ignore the marker,
and both storages hold the same content-addressed objects.

## Teardown (`cdkd bootstrap --destroy`)

`cdkd bootstrap --destroy` removes one region's asset storage: the asset
bucket, the ECR repository and the marker. It asks for confirmation first, and
it refuses while a deployed stack still uses the storage.

```bash
cdkd bootstrap --destroy --region us-west-2          # asks for confirmation
cdkd bootstrap --destroy --region us-west-2 --yes    # no prompt (CI)
```

[Tearing down asset storage](cli-bootstrap-teardown.md) describes the steps,
the checks, and how to delete the state bucket as well.

## Relationship with `cdk bootstrap`

cdkd does not need `cdk bootstrap`. It deploys with the caller's credentials
and does not use CDK's bootstrap roles. It also does not resolve the
template's `BootstrapVersion` parameter. A region that `cdk bootstrap` never
touched therefore works.

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

[Exit codes](cli-reference-exit-codes.md) has the table for every command.

## Related

- [Getting Started](getting-started.md): where bootstrap fits in a first run
- [Tearing down asset storage](cli-bootstrap-teardown.md): `--destroy` in full
- [`cdkd gc`](cli-gc.md): collecting the storage this command creates
- [`cdkd publish-assets`](cli-publish-assets.md): publishing assets without deploying
- [State Store](state-management.md): what the state bucket holds
