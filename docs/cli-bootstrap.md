---
title: cdkd bootstrap
description: "Provision the cdkd state bucket and per-region cdkd-owned asset storage with cdkd bootstrap."
---

## `cdkd bootstrap`

One-time per-account setup (plus once per additional region for asset
storage). Creates:

1. The S3 **state bucket** (`cdkd-state-{accountId}`, or `--state-bucket
   <name>`) — versioned, AES-256 encrypted, account-only bucket policy.
2. cdkd-owned **asset storage** for `--region`: the asset bucket
   (default name `cdkd-assets-{accountId}-{region}`; AES-256, account-only
   policy, no versioning — assets are immutable content-addressed blobs) and
   the container-asset ECR repo (default name
   `cdkd-container-assets-{accountId}-{region}`; immutable tags), plus the
   per-region bootstrap **marker**
   `s3://{stateBucket}/cdkd-bootstrap/{region}.json` that opts the region
   into cdkd-assets mode. Why: `cdk gc` decides "in use" by scanning
   CloudFormation stack templates — cdkd-deployed stacks have no CFn stack,
   so assets published to the CDK bootstrap bucket/repo look isolated to gc
   and get deleted. cdkd-owned storage is structurally out of gc's reach.
   See [docs/design/1002-cdkd-asset-storage.md](design/1002-cdkd-asset-storage.md).

Flags:

- `--no-assets` — skip step 2 (no asset bucket / ECR repo / marker).
  Explicit opt-out for users who keep CDK bootstrap storage or use a custom
  synthesizer with their own asset destinations. Deploys in the region stay
  in legacy mode (publish to the `assets.json` destinations verbatim).
- `--asset-bucket <name>` / `--container-repo <name>` — custom names for
  the asset bucket / container-asset ECR repo instead of the defaults above.
  The escape hatch when the predictable default S3 name is squatted by
  another account (S3 names are global), and the compliance knob for
  org-wide naming policies (ECR repo names are account-scoped, so the ECR
  half is purely for naming policy). The names are validated before any AWS
  call (S3: 3-63 lowercase letters / digits / dots / hyphens, starting and
  ending with a letter or digit; ECR: 2-256 lowercase letters / digits with
  single `.` `_` `-` `/` separators), written into the bootstrap marker, and
  every consumer (deploy redirect / rewrite, publish, verification,
  `state info`, teardown) reads them from the marker from then on. A plain
  re-run of `cdkd bootstrap` keeps the marker's existing (custom) names.
  Re-bootstrapping a region with names that DIFFER from its marker is a hard
  error (`ASSET_STORAGE_NAME_CONFLICT`) — changing names would strand the
  existing storage and its published assets, so run
  `cdkd bootstrap --destroy --region <r>` first, then re-bootstrap with the
  new names. Rejected in combination with `--no-assets` (which skips the
  asset storage the flags name) and with `--destroy` (teardown reads the
  names from the marker). The deploy-time auto-create always
  uses the default names — custom names require the explicit
  `cdkd bootstrap`. Custom bucket names get the same squatting defense as
  the defaults (owned-elsewhere hard refusal, `ExpectedBucketOwner` on every
  call).
- `--force` — reconfigure existing buckets/repo (re-apply encryption /
  policy / tag-immutability). Without it, existing resources are left
  untouched (re-running bootstrap is idempotent and is the supported way to
  opt an existing account's region into asset storage). Under `--destroy`,
  `--force` instead skips the deployed-stack reference scan (see below).
- `--state-bucket <name>` / `--region <region>` — as documented above;
  `--region` on bootstrap is a real (non-deprecated) option.
- `--destroy` — tear down the region's asset storage instead of creating it
  (see "Teardown" below).
- `--include-state-bucket` — with `--destroy` only: also delete the S3 state
  bucket.

Re-running `cdkd bootstrap` on an already-bootstrapped account does NOT
require `--force` to add the asset storage — the state bucket is simply
left as-is and the asset bucket / repo / marker are created. Accounts
bootstrapped by cdkd versions before 0.232.0 need no manual step at all:
the first `cdkd deploy` into each region auto-creates the storage (see
"Auto-create on first deploy" below); the explicit re-run is the
pre-provisioning alternative. Deploys that opt out stay in **legacy mode**
(publish to the CDK bootstrap destinations, byte-identical to older
versions, plus a one-line `cdk gc` notice naming the region) — nothing
breaks by upgrading the binary alone, and downgrading is safe in either
mode (old binaries ignore the marker; both storages hold the same
content-addressed objects).

Relationship with `cdk bootstrap`: cdkd never uses CDK's bootstrap roles
(it deploys with the caller's credentials) and does not resolve the
template's `BootstrapVersion` parameter, so a region never touched by
`cdk bootstrap` works fine. `cdkd export` hands a stack back to the
CloudFormation / CDK CLI world, where `cdk bootstrap` is the CDK CLI's own
prerequisite again.

Bucket-squatting defense: bootstrap refuses to adopt an asset bucket owned
by another account (predictable-name defense), and cdkd's asset-bucket S3
calls pass `ExpectedBucketOwner`. It also refuses a bucket this account owns
that lives in **another region**
(`ASSET_STORAGE_FOREIGN_REGION_BUCKET`): S3 bucket names
are globally unique, so both `BucketAlreadyOwnedByYou` and a cross-region
`HeadBucket` redirect report ACCOUNT ownership rather than the bucket's
region. The default name embeds the region, but `--asset-bucket <name>` is
caller-chosen and region-free, so bootstrapping two regions under one custom
name reaches this. Unlike the STATE bucket — one per account, so bootstrap
re-points its client at the bucket's own region — asset storage is per-region
by design, and `--force` does not license adopting one from elsewhere.
Deleting the asset bucket/repo while the
marker exists makes deploys fail with a re-bootstrap hint — cdkd never
silently falls back to CDK bootstrap storage once a region is opted in.

`cdkd state info` shows which regions are opted in (`Asset storage:` line /
`assetStorage` JSON field).

### Asset destinations after opt-in (cdkd-assets mode)

Once a region's bootstrap marker exists, every asset-consuming command
redirects **default-bootstrap-shaped** destinations
(`cdk-<qualifier>-assets-…` / `cdk-<qualifier>-container-assets-…` for this
account+region — exactly the population `cdk gc` can delete) to the
cdkd-owned storage, and rewrites the matching template references
(`Code.S3Bucket`, `Code.ImageUri`, `s3.Asset` URLs in env vars, nested-stack
`TemplateURL`, …) to the cdkd names. `objectKey` / `imageTag` (content
hashes) are unchanged. User-chosen storage (custom `fileAssetsBucketName` /
`imageAssetsRepositoryName`, `AppStagingSynthesizer` staging buckets) and
cross-region destinations are never touched — `cdk gc` cannot reach those.

Per-command behavior:

| Command | cdkd-assets mode |
| --- | --- |
| `deploy` | redirect publishes + rewrite templates (incl. nested children); a post-resolution audit fails any resource whose resolved properties still name the CDK bootstrap storage |
| `diff` (incl. `--recursive`) | rewrite, so the shown plan matches what deploy will do (incl. the one-time migration diff) |
| `import` | rewrite the template, but record the **pre-rewrite** values in state so the first post-import `cdkd deploy` repoints the live resources |
| `publish-assets` | redirect via the same table (reads the marker from the state bucket; falls back to legacy with an info line when no state bucket resolves) |
| `synth` / `export` | **unrewritten** — synth prints the CDK app's template; export returns the stack to the CFn/cdk-assets world |
| `destroy` / `state *` / `drift` / `events` | state-driven, unchanged |

The first deploy after opting in shows a one-time "everything with assets
updates" diff — an ordinary in-place UPDATE repointing `Code` / `Image` at
cdkd storage (content identical, no replacement). The first deploy after a
`cdkd import` shows the same diff, for the same reason: state deliberately
records the pre-rewrite references, so that deploy is what actually repoints
the imported resources.

`--use-cdk-bootstrap-assets` (on `deploy` / `diff` / `import` /
`publish-assets`) pins legacy destinations for one invocation even after the
region is opted in; `cdk.json` `context.cdkd.useCdkBootstrapAssets: true`
pins it per app — for apps deployed via both CloudFormation and cdkd during
a migration window. The pin also suppresses the legacy-mode `cdk gc` notice.

### Auto-create on first deploy

`cdkd deploy` into a region that has **no** bootstrap marker auto-creates
the per-region asset storage (asset bucket + container-asset ECR repo +
marker — the same `ensureAssetStorage` path `cdkd bootstrap` uses, including
the squatting defense and marker-written-last ordering) instead of falling
back to legacy mode, so `cdkd bootstrap` stays a true once-per-account step.

- Interactive runs are prompted once per region (`[Y/n]`, default yes);
  `--yes` / non-TTY runs create immediately with an info line.
- A declined prompt or a failed creation (e.g. S3/ECR create denied) falls
  back to legacy mode with an actionable warning — a deploy that worked
  before never starts hard-failing.
- Opt out per invocation with `--no-auto-asset-storage`, or per app with
  `cdk.json` `context.cdkd.autoAssetStorage: false`. The
  `--use-cdk-bootstrap-assets` pin also disables it (the marker is never
  read), as does `--dry-run` (a dry run creates nothing). Only `deploy`
  auto-creates — `diff` / `import` / `publish-assets` never create
  resources.

### Teardown (`cdkd bootstrap --destroy`)

`cdkd bootstrap --destroy --region <r>` is the reverse of bootstrap for ONE
region's asset storage — the cdkd equivalent of deleting the CDK CLI's
`CDKToolkit` stack, replacing the manual `aws s3 rb` / `aws ecr
delete-repository` / marker-delete sequence. It:

1. Empties (all versions + delete markers) and deletes the region's **asset
   bucket**, then force-deletes the **container-asset ECR repo**, then
   deletes the region's bootstrap **marker LAST** — the mirror of the
   create side's marker-written-last ordering, so a crash mid-teardown
   leaves the region consistently opted in (deploys hard-error with a
   re-bootstrap hint rather than silently falling back to legacy mode).
2. Reads the asset bucket / repo **names from the marker**, never from the
   naming convention — compatible with custom asset-storage names. A region
   named by `--region` OR by `AWS_REGION` is lower-cased before it reaches any
   AWS client or the marker key, and both spellings of the key are probed, as
   in [`cdkd gc`](cli-gc.md#cdkd-gc-garbage-collect-cdkd-owned-storage) — with a sharper
   consequence here: an unmatched marker made this command report "nothing to
   delete" and exit 0 while the bucket and repo stayed alive. The marker
   deleted in step 1 is the key the marker was actually READ from, so the
   teardown cannot delete the wrong one. A region bootstrapped under MORE than
   one spelling of its name has more than one marker, and the teardown deletes
   exactly one of them: each survivor is reported with a warning naming its own
   key and the `--region` spelling that reaches it (only that spelling does —
   the canonical key is gone by then). Their asset storage is left standing on
   purpose, since two markers can name two different sets of custom names and
   the marker is the only record of them. The same listing runs when NO marker
   is found under either probed spelling, so a region whose only marker carries
   a third spelling is reported rather than dismissed with "nothing to delete";
   in that case the "re-run `cdkd bootstrap`" hint is withheld, because
   re-bootstrapping would write a second marker with DEFAULT names and the next
   teardown would destroy that storage while the existing marker's survives.
   The listing needs `s3:ListBucket` on the state bucket, which a plain
   `--destroy` did not previously require: without it the teardown still
   proceeds and warns that the check could not be made, while
   `--include-state-bucket` refuses outright
   (`STATE_BUCKET_MARKER_SCAN_FAILED`), since there the listing is the only
   thing preventing sibling markers from being deleted with the bucket.
3. Refuses while any deployed stack's state still references the region's
   asset bucket / repo (running Lambdas keep working after deletion, but a
   future re-deploy / rollback of those stacks would break). The scan
   covers every state file in the bucket regardless of the
   `--state-prefix` it was deployed under. `--force` overrides the scan.
4. Prompts for confirmation with the full deletion plan (`y/N`, default
   No); `--yes` / `-y` skips the prompt. A non-TTY stdin without `--yes` is
   a hard error.
5. Is idempotent: already-missing pieces are skipped with info lines
   (mirror of `ensureAssetStorage`), and every S3 call passes
   `ExpectedBucketOwner` (a foreign bucket squatting the name is refused,
   never deleted).

The **state bucket is kept by default** — it is the account's source of
truth. `--include-state-bucket` opts it into the teardown, and even then
the deletion is refused while ANY stack state exists — under any
`--state-prefix`, the guard lists the whole bucket — (destroy every stack
first; there is no `--force` override) or while any OTHER region still has
a bootstrap marker in the bucket (tear those regions down first — deleting
their markers with the bucket would silently flip them back to legacy
mode). "Other" is decided case-insensitively, so a region whose marker was
written under a different spelling of its own name is not mistaken for a
second region — but the refusal NAMES each one by the spelling its marker
key actually uses, because that is the spelling
`cdkd bootstrap --destroy --region <r>` needs in order to find
it. The same refusal covers
a marker for THIS region under another spelling: the teardown deletes one
marker key, so deleting the state bucket while a sibling is still in it would
remove that record while the asset storage it names survives, nameless.

A region with no bootstrap marker is a no-op (nothing to delete); note the
auto-create-on-first-deploy behavior above will re-create the storage on
the next `cdkd deploy` into the region unless you opt out
(`--no-auto-asset-storage` / `context.cdkd.autoAssetStorage: false`).
