# cdkd-owned asset storage (`cdk gc` survival) — Design

Tracking: [#1002](https://github.com/go-to-k/cdkd/issues/1002)
Status: **Design only — no code change in the same PR.**

cdkd currently publishes S3 file assets and ECR image assets to the **CDK
bootstrap** resources, exactly as the synthesized `*.assets.json` instructs.
Because `cdk gc` decides "in use" by scanning **CloudFormation stack
templates** in the environment — and cdkd-deployed stacks have no CFn stack —
every cdkd-published asset is classified isolated and deleted. This document
designs the fix: cdkd-owned asset storage created by `cdkd bootstrap`,
publish-time destination redirection, and a deterministic template-reference
rewrite.

Grounded against (a) the `cdk gc` implementation in `aws/aws-cdk-cli`
(`garbage-collector.ts`, checked 2026-07-14), (b) CDK 2.x
`DefaultStackSynthesizer` naming/synthesis output, and (c) the existing cdkd
asset pipeline (`src/assets/**`, WorkGraph asset nodes).

---

## 1. Problem & threat model

### 1.1 `cdk gc` facts (verified in source)

- In-use detection builds an `ActiveAssetCache` from `ListStacks` +
  `GetTemplate` over the CFn stacks of the environment, then partitions
  bucket objects / repo images by whether their hash appears in any template.
- Isolation is recorded with tags `aws-cdk:isolated` (S3) / `aws-cdk.isolated`
  (ECR, colon invalid there) carrying a timestamp; `--rollback-buffer-days`
  (default **0**) is the only grace mechanism.
- **There is no protection / do-not-delete tag.** Tagging cdkd's assets to
  opt out is a dead end today.
- gc discovers the bucket/repo from the **bootstrap stack**
  (`--bootstrap-stack-name`, default `CDKToolkit`) outputs. Storage not
  referenced by that stack is structurally out of gc's reach.

### 1.2 Impact of an asset deletion

| Asset kind | Blast radius |
| --- | --- |
| ECR image used by ECS | Every new task launch (scale-out / replacement / daemon restart) fails to pull. Running service degrades on the next scheduling event. |
| ECR image used by Lambda | Existing function keeps invoking (Lambda holds an internal copy), but updates / rollbacks that re-resolve the image fail. |
| S3 ZIP (Lambda code) | Next `cdkd deploy` re-uploads (HeadObject miss → publish), so deploy self-heals; but a deploy from another machine racing gc can create-fail. |
| S3 file assets read at runtime (`s3.Asset` URLs in env vars, SFN `DefinitionS3Location`, BucketDeployment sources) | Immediate runtime breakage. |

## 2. Options considered

### 2.1 Option A — dummy CFn stack embedding live hashes: rejected

Works mechanically (gc substring-scans template bodies), but: reintroduces a
CloudFormation dependency into the tool whose purpose is bypassing CFn; needs
a dummy-stack update on every deploy and a sync on destroy; races gc in the
publish→update window; the template size ceiling caps protectable hashes; a
ghost stack confuses users and other tooling.

### 2.2 Option B — protection tag: not possible

Verified above — no such semantics exist in gc. Proposing one upstream is a
complementary follow-up (defense-in-depth for mixed cdk/cdkd environments),
not something cdkd can depend on.

### 2.3 Option C — user-side custom synthesizer: documented workaround only

`new DefaultStackSynthesizer({ fileAssetsBucketName: ..., imageAssetsRepositoryName: ... })`
solves the problem with zero cdkd code (synth output already points at
non-bootstrap storage). Rejected as the default because it violates the
"zero changes to the CDK app" principle, breaks dev(cdkd)/prod(CDK CLI)
dual-use of one app unless stage-switched, and pushes storage management onto
the user. Gets one paragraph in docs as an escape hatch that works today.

### 2.4 Option D — cdkd-owned asset storage: **chosen**

`cdkd bootstrap` creates a cdkd asset bucket + ECR repo; publish redirects to
them; template references are rewritten. gc never touches them (§1.1 last
bullet). The rest of this document details option D.

## 3. Naming

```
S3  : cdkd-assets-{accountId}-{region}
ECR : cdkd-container-assets-{accountId}-{region}
```

- The asset bucket is **per-region by necessity**: Lambda requires the code
  bucket to be in the function's region (the same reason CDK's asset bucket
  is per-region). This intentionally diverges from the state bucket, which
  went region-free (`cdkd-state-{accountId}`).
- ECR repo names don't strictly need the account/region suffix (repos are
  account+region scoped by ARN), but keeping the CDK-parallel shape makes the
  prefix-substitution rewrite (§6) uniform and the names self-describing.

### 3.1 The prefix-substitution insight

CDK bootstrap names and cdkd names differ **only in a literal prefix**; the
`-${AWS::AccountId}-${AWS::Region}` suffix structure is identical:

```
cdk-hnb659fds-assets-…            → cdkd-assets-…
cdk-hnb659fds-container-assets-…  → cdkd-container-assets-…
```

So one string-level substitution works identically on:

- unresolved `Fn::Sub` bodies (`cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}`),
- `Fn::Join` part lists (CDK 2.x emits the repo prefix as a contiguous
  literal part: `…dkr.ecr…/cdk-hnb659fds-container-assets-` + Ref parts),
- already-resolved literals.

The prefixes are **not hardcoded**: they are derived per stack from its own
`*.assets.json` destinations (`bucketName` / `repositoryName` in placeholder
form), so custom bootstrap qualifiers (`cdk-<qualifier>-…`) work automatically.

## 4. `cdkd bootstrap` changes (`src/cli/commands/bootstrap.ts`)

In addition to the state bucket, create in `--region`:

1. **Asset bucket** `cdkd-assets-{accountId}-{region}`:
   - No versioning (content-addressed immutable objects — a new content is a
     new key; versioning only bloats storage).
   - Encryption AES-256 + BucketKey, same as the state bucket.
   - Same deny-external-account bucket policy as the state bucket.
2. **ECR repo** `cdkd-container-assets-{accountId}-{region}`:
   - `imageTagMutability: IMMUTABLE` (tags are content hashes; CDK bootstrap
     uses IMMUTABLE too).
   - No lifecycle policy in v1 (§9 follow-up `cdkd gc`).

Idempotent like the state-bucket path (exists → reconfigure only under
`--force`). `--no-assets` skips both for users who knowingly keep using the
CDK bootstrap storage (open question §10.3).

## 5. Publish-time redirection (`src/assets/**`, WorkGraph)

`FileAssetPublisher.publish` / `DockerAssetPublisher.{publish,push}` and the
WorkGraph asset nodes currently resolve `dest.bucketName` /
`dest.repositoryName` placeholders verbatim. Change: a resolved
`AssetDestinationOverride` (constructed once per deploy from accountId +
region) swaps bucket/repo to the cdkd names, while:

- `objectKey` / `imageTag` (content hashes) are kept **unchanged** — the
  existence-check/skip logic (`HeadObject` / `DescribeImages`) works as-is
  per storage.
- `dest.assumeRoleArn` stays ignored (already the case; cross-account
  publishing remains out of scope, §8).
- The standalone `cdkd publish-assets` command gets the same override.

## 6. Template reference rewrite (analyzer entry)

A dedicated pass over the parsed template, per stack, **before DAG build /
intrinsic resolution**:

1. Build the substitution table from the stack's assets.json destinations:
   placeholder-form CDK bucket/repo names → cdkd names (both reduced to the
   literal prefixes of §3.1).
2. Deep-walk the template; on every string node — including `Fn::Sub`
   template strings and `Fn::Join` string parts — apply the prefix
   substitutions.

Pre-resolution placement is chosen (over rewriting resolved values inside
`IntrinsicFunctionResolver`) because:

- single call site, no scattering across resolver branches;
- state then records cdkd names in `properties` / `observedProperties`, so
  diff / drift / destroy are self-consistent on later deploys with **no
  state-schema bump**;
- `cdkd diff` output shows the real (cdkd) locations.

Covers every embedding shape: Lambda `Code.S3Bucket`/`S3Key`,
`Code.ImageUri`, ECS `ContainerDefinitions[].Image`, `s3.Asset`-derived URLs
in env vars / SFN definitions, CustomResource properties, etc. Nested-stack
`TemplateURL` also gets rewritten, harmlessly — `NestedStackProvider` reads
child templates from `cdk.out` locally and never dereferences the URL.

## 7. Migration of already-deployed stacks

First deploy after upgrade:

1. Publish step uploads all manifest assets to the cdkd storage (hash keys
   identical; CDK-bucket copies are simply no longer referenced).
2. The rewrite changes e.g. `Code.S3Bucket` → ordinary property diff →
   in-place UPDATE re-pointing code/image at cdkd storage. Content identical,
   **no replacement** (`Code.*` is update-in-place for Lambda; `Image` is a
   task-definition revision for ECS).

Document that a one-time "everything with assets shows an update" diff is
expected. No state migration, no schema bump.

## 8. `cdkd local` family

Image-URI detection sites currently match the literal
`cdk-hnb659fds-container-assets-` (`src/local/ecs-task-resolver.ts` and the
`intrinsic-image` helpers now owned by cdk-local):

- must additionally match `cdkd-container-assets-`;
- while there, generalize the hardcoded default qualifier to
  `cdk-[a-z0-9]+-container-assets-` (pre-existing gap for custom qualifiers);
- the cdk-local-owned sites need an upstream PR + version bump (the usual
  shim-inheritance flow).

`local invoke --from-state` reads state that (post-migration) carries cdkd
names — consistent with what the rewrite deployed.

## 9. Out of scope (v1) & follow-ups

- **Cross-account / cross-region destinations** (`assumeRoleArn`): already
  ignored today; unchanged.
- **`cdkd gc`** (separate issue): with cdkd-owned storage, cdkd owns the
  lifecycle. A cdkd-native gc can enumerate referenced hashes directly from
  state files (fully-resolved `properties`) — strictly better signal than
  gc's template substring scan.
- **Upstream protection-tag proposal** for `cdk gc` (separate issue,
  defense-in-depth for environments mid-migration).
- **`cdkd export` interaction**: the exported stack keeps running (code /
  image already loaded); the next `cdk deploy` republishes assets to the CDK
  bootstrap bucket via cdk-assets and updates references — self-correcting.
  Docs note only.

## 10. Open questions

1. **Fallback when asset storage isn't bootstrapped.** Hard error with a
   `cdkd bootstrap --region <r>` hint (explicit, CDK parity) vs auto-fallback
   to the CDK bootstrap destinations with a one-shot warning
   (backward-compatible, but silently reintroduces the gc hazard).
   Leaning: **fallback + warning for a transition period** plus an explicit
   `--use-cdk-bootstrap-assets` / `cdk.json` knob, then flip to hard error in
   a later minor.
2. **Rewrite placement** — §6 recommends pre-resolution; confirm no consumer
   depends on seeing CDK bootstrap names in synth output downstream of the
   analyzer (e.g. `cdkd synth` output should stay **unrewritten**: it prints
   the CDK app's template, not cdkd's deployment plan).
3. **`--no-assets` on bootstrap** — worth the surface, or is the
   `--use-cdk-bootstrap-assets` deploy-side knob enough?
4. **Bucket/repo lifecycle defaults** — none in v1; revisit with `cdkd gc`.
