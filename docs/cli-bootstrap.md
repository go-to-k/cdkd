---
title: cdkd bootstrap
description: "Provision the cdkd state bucket and per-region cdkd-owned asset storage with cdkd bootstrap."
---

# cdkd bootstrap

`cdkd bootstrap` gives cdkd the two pieces of AWS infrastructure it needs to
work in an account: an S3 bucket to keep stack state in, and per-region storage
it owns for the file and container assets your stacks publish. Run it once per
account, plus once per additional region you deploy into. With `--destroy` it
runs in reverse, tearing a region's asset storage back down.

```bash
cdkd bootstrap                                    # state bucket + asset storage for the region
cdkd bootstrap --region us-west-2                 # opt another region into asset storage
cdkd bootstrap --no-assets                        # state bucket only
cdkd bootstrap --asset-bucket my-org-cdkd-assets  # custom asset-storage names
cdkd bootstrap --destroy --region us-west-2       # tear that region's asset storage down
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--region <region>` | `AWS_REGION`, else `us-east-1` | Region to bootstrap, or to tear down with `--destroy`. Not deprecated on this command. |
| `--state-bucket <name>` | `cdkd-state-{accountId}` | Name of the state bucket to create. |
| `--no-assets` | off | Skip the asset storage entirely — no asset bucket, ECR repo or marker. |
| `--asset-bucket <name>` | `cdkd-assets-{accountId}-{region}` | Custom asset-bucket name, recorded in the region's marker. |
| `--container-repo <name>` | `cdkd-container-assets-{accountId}-{region}` | Custom container-asset ECR repo name, recorded in the region's marker. |
| `--force` | off | Create: reconfigure existing buckets / repo. Destroy: skip the deployed-stack reference scan. |
| `--destroy` | off | Tear down the region's asset storage instead of creating it. |
| `--include-state-bucket` | off | With `--destroy` only: also delete the state bucket. |
| `-y`, `--yes` | off | Answer the teardown confirmation automatically. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

## What bootstrap creates

1. The S3 **state bucket** (`cdkd-state-{accountId}`, or `--state-bucket
   <name>`) — versioned, AES-256 encrypted, with an account-only bucket policy.
   One per account.
2. cdkd-owned **asset storage** for `--region`:
   - the **asset bucket** (default `cdkd-assets-{accountId}-{region}`) —
     AES-256, account-only policy, no versioning, since assets are immutable
     content-addressed blobs;
   - the **container-asset ECR repo** (default
     `cdkd-container-assets-{accountId}-{region}`) with immutable tags;
   - the per-region bootstrap **marker**
     `s3://{stateBucket}/cdkd-bootstrap/{region}.json`, which opts the region
     into cdkd-assets mode. The marker is written **last**, so a crash partway
     through leaves the region consistently not-yet-opted-in.

`cdkd state info` shows which regions are opted in (the `Asset storage:` line,
or the `assetStorage` JSON field).

### Why cdkd owns its asset storage

`cdk gc` decides which assets are "in use" by scanning CloudFormation stack
templates. A cdkd-deployed stack has no CloudFormation stack, so assets it
published into the CDK bootstrap bucket or repo look unreferenced to `cdk gc`
and get deleted out from under it. Storage cdkd owns is structurally out of
`cdk gc`'s reach — and cdkd can collect it precisely, because its state files
record exactly which assets are in use (see [`cdkd gc`](cli-gc.md)). The full
rationale is in the [asset-storage design note](design/1002-cdkd-asset-storage.md).

Deploys in a region that has **not** opted in stay in **legacy mode**: assets go
to the `assets.json` destinations verbatim, byte-identical to older cdkd
versions, plus a one-line `cdk gc` notice naming the region. `--no-assets` is
the explicit opt-out, for users who keep CDK bootstrap storage or use a custom
synthesizer with its own asset destinations.

## Custom asset-storage names

`--asset-bucket` and `--container-repo` replace the default names above. Two
reasons to use them: S3 bucket names are global, so the predictable default can
be squatted by another account; and org-wide naming policies may require a
particular shape. ECR repository names are account-scoped, so the ECR half is
purely about naming policy.

- Names are **validated before any AWS call**. An S3 bucket name must be 3-63
  characters of lowercase letters, digits, dots and hyphens, starting and ending
  with a letter or digit. An ECR repository name must be 2-256 characters of
  lowercase letters and digits, optionally separated by single `.`, `_`, `-` or
  `/` characters, with no leading, trailing or doubled separators.
- The names are written into the bootstrap marker, and every consumer — the
  deploy-time redirect and template rewrite, publishing, verification,
  `cdkd state info`, teardown — reads them from the marker from then on.
- A plain re-run of `cdkd bootstrap` keeps the marker's existing names.
- Re-bootstrapping a region with names that **differ** from its marker is a hard
  error (`ASSET_STORAGE_NAME_CONFLICT`): changing names would strand the
  existing storage and everything published to it. Run
  `cdkd bootstrap --destroy --region <r>` first, then re-bootstrap with the new
  names.
- Both flags are rejected together with `--no-assets` (which skips the storage
  they name) and with `--destroy` (teardown reads the names from the marker).
- The deploy-time auto-create always uses the default names. Custom names
  require an explicit `cdkd bootstrap`.
- Custom bucket names get the same squatting defense as the defaults.

## Re-running bootstrap

Re-running `cdkd bootstrap` on an already-bootstrapped account does **not**
require `--force` to add asset storage: the state bucket is left as-is, and the
asset bucket, repo and marker are created. Re-running is idempotent, and it is
the supported way to opt an existing account's region into asset storage.

`--force` reconfigures existing resources — re-applying encryption, bucket
policy and ECR tag immutability. Without it, existing resources are left
untouched.

Accounts bootstrapped by an older cdkd need no manual step at all: the first
`cdkd deploy` into each region auto-creates the storage (see
[Auto-create on first deploy](#auto-create-on-first-deploy)); the explicit
re-run is just the pre-provisioning alternative. Nothing breaks by upgrading the
binary alone, and downgrading is safe in either mode — old binaries ignore the
marker, and both storages hold the same content-addressed objects.

## Relationship with `cdk bootstrap`

cdkd never uses CDK's bootstrap roles (it deploys with the caller's
credentials) and does not resolve the template's `BootstrapVersion` parameter,
so a region never touched by `cdk bootstrap` works fine. `cdkd export` hands a
stack back to the CloudFormation / CDK CLI world, where `cdk bootstrap` becomes
the CDK CLI's own prerequisite again.

## Bucket-squatting defense

- Bootstrap refuses to adopt an asset bucket owned by **another account**, and
  every cdkd asset-bucket S3 call passes `ExpectedBucketOwner`.
- It also refuses a bucket this account owns that lives in **another region**
  (`ASSET_STORAGE_FOREIGN_REGION_BUCKET`). S3 bucket names are globally unique,
  so both `BucketAlreadyOwnedByYou` and a cross-region `HeadBucket` redirect
  report account ownership rather than the bucket's region. The default name
  embeds the region, but `--asset-bucket <name>` is caller-chosen and
  region-free, so bootstrapping two regions under one custom name reaches this.
  Unlike the state bucket — one per account, so bootstrap re-points its client
  at the bucket's own region — asset storage is per-region by design, and
  `--force` does not license adopting one from elsewhere.
- Deleting the asset bucket or repo while the marker still exists makes deploys
  fail with a re-bootstrap hint. cdkd never silently falls back to CDK bootstrap
  storage once a region is opted in.

## Asset destinations after opt-in (cdkd-assets mode)

Once a region's bootstrap marker exists, every asset-consuming command redirects
**default-bootstrap-shaped** destinations (`cdk-<qualifier>-assets-…` /
`cdk-<qualifier>-container-assets-…` for this account and region — exactly the
population `cdk gc` can delete) to the cdkd-owned storage, and rewrites the
matching template references (`Code.S3Bucket`, `Code.ImageUri`, `s3.Asset` URLs
in environment variables, nested-stack `TemplateURL`, and so on) to the cdkd
names. `objectKey` and `imageTag` — the content hashes — are unchanged.

User-chosen storage (a custom `fileAssetsBucketName` /
`imageAssetsRepositoryName`, `AppStagingSynthesizer` staging buckets) and
cross-region destinations are never touched, because `cdk gc` cannot reach those
either.

| Command | cdkd-assets mode |
| --- | --- |
| `deploy` | Redirect publishes and rewrite templates, nested children included. A post-resolution audit fails any resource whose resolved properties still name the CDK bootstrap storage. |
| `diff` (including `--recursive`) | Rewrite, so the shown plan matches what deploy will do — including the one-time migration diff. |
| `import` | Rewrite the template, but record the **pre-rewrite** values in state, so the first post-import `cdkd deploy` repoints the live resources. |
| `publish-assets` | Redirect via the same table. Reads the marker from the state bucket, and falls back to legacy with an info line when no state bucket resolves. |
| `synth` / `export` | **Unrewritten** — synth prints the CDK app's template, and export returns the stack to the CloudFormation / cdk-assets world. |
| `destroy` / `state *` / `drift` / `events` | State-driven, unchanged. |

The first deploy after opting in shows a one-time "everything with assets
updates" diff: an ordinary in-place UPDATE repointing `Code` / `Image` at cdkd
storage, with identical content and no replacement. The first deploy after a
`cdkd import` shows the same diff for the same reason — state deliberately
records the pre-rewrite references, so that deploy is what repoints the imported
resources.

`--use-cdk-bootstrap-assets` (on `deploy`, `diff`, `import` and
`publish-assets`) pins legacy destinations for one invocation even after the
region is opted in. `cdk.json` `context.cdkd.useCdkBootstrapAssets: true` pins
it per app, for apps deployed via both CloudFormation and cdkd during a
migration window. The pin also suppresses the legacy-mode `cdk gc` notice.

## Auto-create on first deploy

`cdkd deploy` into a region that has **no** bootstrap marker auto-creates the
per-region asset storage — asset bucket, container-asset ECR repo and marker, by
the same path `cdkd bootstrap` uses, squatting defense and marker-written-last
ordering included — instead of falling back to legacy mode. That is what keeps
`cdkd bootstrap` a true once-per-account step.

- Interactive runs are prompted once per region (`[Y/n]`, default yes). `--yes`
  and non-TTY runs create immediately with an info line.
- A declined prompt or a failed creation (S3 / ECR create denied, say) falls back
  to legacy mode with an actionable warning, so a deploy that worked before never
  starts hard-failing.
- Opt out per invocation with `--no-auto-asset-storage`, or per app with
  `cdk.json` `context.cdkd.autoAssetStorage: false`. The
  `--use-cdk-bootstrap-assets` pin also disables it (the marker is never read),
  as does `--dry-run`, since a dry run creates nothing.
- Only `deploy` auto-creates. `diff`, `import` and `publish-assets` never create
  resources.

## Teardown (`cdkd bootstrap --destroy`)

`cdkd bootstrap --destroy --region <r>` is the reverse of bootstrap for ONE
region's asset storage — the cdkd equivalent of deleting the CDK CLI's
`CDKToolkit` stack, replacing a manual `aws s3 rb` / `aws ecr
delete-repository` / marker-delete sequence.

1. Empty (all versions and delete markers) and delete the region's **asset
   bucket**, force-delete the **container-asset ECR repo**, then delete the
   region's bootstrap **marker LAST** — the mirror of the create side's
   ordering, so a crash mid-teardown leaves the region consistently opted in.
   Deploys then hard-error with a re-bootstrap hint rather than silently
   dropping back to legacy mode.
2. Read the asset bucket and repo **names from the marker**, never from the
   naming convention, so custom names work. See
   [Finding the marker for a region](#finding-the-marker-for-a-region) below.
3. Refuse while any deployed stack's state still references the region's asset
   bucket or repo (`ASSET_STORAGE_IN_USE`). Running Lambdas keep working after
   deletion, but a future re-deploy or rollback of those stacks would break. The
   scan covers every state file in the bucket, whatever `--state-prefix` each
   stack was deployed under. `--force` overrides it.
4. Prompt for confirmation with the full deletion plan (`y/N`, default No).
   `--yes` / `-y` skips the prompt; a non-TTY stdin without it is a hard error.
5. Skip already-missing pieces with info lines, so the teardown is idempotent.
   Every S3 call passes `ExpectedBucketOwner`, so a foreign bucket squatting the
   name is refused rather than deleted.

A region with no bootstrap marker is a no-op. Note that auto-create-on-first-deploy
will re-create the storage on the next `cdkd deploy` into the region unless you
opt out (`--no-auto-asset-storage`, or `context.cdkd.autoAssetStorage: false`).

### Finding the marker for a region

The region named by `--region` or by `AWS_REGION` is lower-cased before it
reaches any AWS client or the marker key, and both spellings of the key are
probed — as in [`cdkd gc`](cli-gc.md#cdkd-gc-garbage-collect-cdkd-owned-storage).
The marker deleted in step 1 is the key the names were actually read from, so
the teardown cannot delete the wrong one.

A region bootstrapped under **more than one spelling** of its name has more than
one marker, and the teardown deletes exactly one of them. Each survivor is
reported with a warning naming its own key and the `--region` spelling that
reaches it — only that spelling does, since the canonical key is gone by then.
The asset storage those survivors name is left standing on purpose: two markers
can name two different sets of custom names, and the marker is the only record
of them.

The same listing runs when **no** marker is found under either probed spelling,
so a region whose only marker carries a third spelling is reported rather than
dismissed as "nothing to delete". In that case the "re-run `cdkd bootstrap`"
hint is withheld, because re-bootstrapping would write a second marker with
default names and the next teardown would destroy that storage while the
existing marker's survived.

The listing needs `s3:ListBucket` on the state bucket. Without it a plain
`--destroy` still proceeds and warns that the check could not be made, while
`--include-state-bucket` refuses outright (`STATE_BUCKET_MARKER_SCAN_FAILED`) —
there, the listing is the only thing preventing sibling markers from being
deleted along with the bucket.

### Deleting the state bucket

The **state bucket is kept by default**; it is the account's source of truth.
`--include-state-bucket` opts it into the teardown, and even then the deletion is
refused while:

- **any stack state exists**, under any `--state-prefix` — the guard lists the
  whole bucket. Destroy every stack first; there is no `--force` override; or
- **any other region still has a bootstrap marker** in the bucket. Tear those
  regions down first: deleting their markers with the bucket would silently flip
  them back to legacy mode.

"Other" is decided case-insensitively, so a region whose marker was written under
a different spelling of its own name is not mistaken for a second region. The
refusal still NAMES each one by the spelling its marker key actually uses,
because that is the spelling `cdkd bootstrap --destroy --region <r>` needs in
order to find it. The same refusal covers a marker for THIS region under another
spelling: the teardown deletes one marker key, so deleting the state bucket while
a sibling is still in it would remove that record while the asset storage it
names survives, nameless.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The requested storage exists (create), or is gone (teardown). Includes the idempotent no-op cases. |
| `1` | Hard error — the refusals below, plus auth and AWS failures. |

| Refusal | When |
| --- | --- |
| `ASSET_STORAGE_NAME_CONFLICT` | Re-bootstrapping a region with `--asset-bucket` / `--container-repo` names that differ from the ones its marker records. |
| `ASSET_STORAGE_FOREIGN_REGION_BUCKET` | The named asset bucket is owned by this account but lives in another region. |
| `ASSET_STORAGE_FOREIGN_BUCKET` | The named asset bucket is owned by another account, or access to it is denied. |
| `INVALID_ASSET_STORAGE_NAME` | An `--asset-bucket` / `--container-repo` name fails the validation rules above. |
| `INVALID_OPTIONS` | Contradictory flags: `--asset-bucket` / `--container-repo` with `--destroy` or `--no-assets`, or `--include-state-bucket` without `--destroy`. |
| `ASSET_STORAGE_IN_USE` | Teardown: a deployed stack's state still references the region's asset storage. `--force` overrides. |
| `STATE_BUCKET_MARKER_SCAN_FAILED` | `--destroy --include-state-bucket` could not list the state bucket, so sibling markers cannot be checked. |
| `STATE_BUCKET_NOT_EMPTY` | `--include-state-bucket` with stack state still in the bucket. |
| `STATE_BUCKET_HOLDS_MARKERS` / `STATE_BUCKET_HOLDS_SIBLING_MARKERS` | `--include-state-bucket` while another region — or another spelling of this one — still has a bootstrap marker. |
| `NON_INTERACTIVE_CONFIRM` | The teardown confirmation was reached on a non-interactive stdin. Pass `-y` / `--yes`. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Getting Started](getting-started.md) — where bootstrap fits in a first run
- [`cdkd gc`](cli-gc.md) — collecting the storage this command creates
- [State Management](state-management.md) — what lives in the state bucket
- [`cdkd publish-assets`](cli-publish-assets.md) — publishing assets without deploying
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
