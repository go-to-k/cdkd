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
rewrite — with a **strictly transparent upgrade**: existing cdkd users see
zero behavior change until they explicitly re-run `cdkd bootstrap` on the new
version.

Grounded against (a) the `cdk gc` implementation in `aws/aws-cdk-cli`
(`garbage-collector.ts`, checked 2026-07-14), (b) CDK 2.x
`DefaultStackSynthesizer` naming/synthesis output and the
`AppStagingSynthesizer` (alpha) staging model, and (c) the existing cdkd
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
  referenced by that stack is structurally out of gc's reach. This scopes the
  hazard precisely: **only default-bootstrap-shaped destinations are at
  risk** — user-chosen storage (custom `fileAssetsBucketName`,
  `AppStagingSynthesizer` staging stacks) is never touched by `cdk gc`
  (see §8).

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

## 3. Naming — and why NOT the state bucket

```
S3  : cdkd-assets-{accountId}-{region}
ECR : cdkd-container-assets-{accountId}-{region}
```

Assets deliberately do **not** live in the state bucket
(`cdkd-state-{accountId}`), even under a prefix:

1. **Region constraint.** Lambda requires the code bucket to be in the
   function's region — the same reason CDK's asset bucket is per-region. The
   state bucket is account-scoped and single-region by design (it went
   region-free in the `state migrate` work); a stack deployed to any region
   other than the state bucket's would not be able to load Lambda code from
   it. Asset storage must therefore be per-region, which already rules out
   "state bucket + `assets/` prefix" as a general answer.
2. **Versioning mismatch.** The state bucket has versioning enabled
   (deliberate: state recovery). Assets are immutable content-addressed
   blobs — versioning them is pure storage waste, and versioning is a
   bucket-wide switch.
3. **Lifecycle isolation.** A future `cdkd gc` (§11) and any lifecycle
   policies operate on asset storage; keeping them off the state bucket means
   no rule can ever expire a `state.json` / lock / exports-index key.
4. **Blast radius.** Asset storage can be deleted and re-bootstrapped freely
   (contents are reproducible from source); state cannot.

ECR repo names don't strictly need the account/region suffix (repos are
account+region scoped by ARN), but the CDK-parallel shape keeps the rewrite
uniform and the names self-describing.

## 4. Transparent upgrade & mode detection

**Hard requirement: upgrading the cdkd binary alone changes nothing.** The
new behavior activates only when the user re-runs `cdkd bootstrap` with the
new version, per `(account, region)`.

### 4.1 Mechanism: bootstrap marker in the state bucket

`cdkd bootstrap` (new version) writes a marker object to the state bucket:

```
s3://cdkd-state-{accountId}/cdkd-bootstrap/{region}.json
{ "assetBucket": "cdkd-assets-...", "containerRepo": "cdkd-container-assets-...",
  "assetSupportVersion": 1, "createdAt": ... }
```

Deploy-time mode selection (one GetObject against a bucket every deploy
already reads; the result is cached for the process lifetime):

| Marker for deploy region | Mode |
| --- | --- |
| absent | **legacy** — publish to the `assets.json` destinations verbatim, no rewrite. Byte-identical to today's behavior. A one-shot `logger.info` mentions the `cdk gc` hazard and the `cdkd bootstrap` opt-in (info, not warn — existing users are not doing anything wrong). |
| present | **cdkd-assets** — redirect + rewrite (§6, §7). |
| present but bucket/repo missing (user deleted them) | hard error naming the missing resource and the `cdkd bootstrap --region <r>` fix. Never silently fall back — that would flip-flop stack properties between deploys. |

Why a marker instead of `HeadBucket` on the conventional name: the marker
records **explicit user intent** (they ran the new bootstrap), is immune to
name-squatting/coincidence, costs one read on a bucket we already touch, and
gives future custom-name support (`--asset-bucket`) a natural home.
`cdkd state info` surfaces it.

### 4.2 Safety properties

- **No state schema bump.** Deployed properties simply contain different
  literal strings (cdkd names vs CDK names). v8 remains current.
- **Old binary rollback is safe.** An old cdkd ignores the marker, publishes
  to CDK bootstrap destinations, deploys unrewritten templates → the next
  update repoints properties back to CDK names. Both storages hold the same
  content-addressed objects; nothing breaks in either direction.
- **Per-region opt-in.** An account deploying to 3 regions can migrate one
  region at a time.
- **Per-app opt-out.** `--use-cdk-bootstrap-assets` (deploy flag +
  `cdk.json` `context.cdkd.useCdkBootstrapAssets`) pins legacy mode for one
  app even after bootstrap — for apps deployed via both CFn and cdkd during
  a migration window.
- New accounts bootstrapped with the new version get cdkd-assets mode from
  day one; `cdkd bootstrap --no-assets` creates only the state bucket
  (explicit opt-out for users who want to keep CDK storage, e.g. option C
  users).

## 5. `cdkd bootstrap` changes (`src/cli/commands/bootstrap.ts`)

In addition to the state bucket, create in `--region`:

1. **Asset bucket** `cdkd-assets-{accountId}-{region}`:
   - No versioning (content-addressed immutable objects).
   - Encryption AES-256 + BucketKey, same deny-external-account bucket
     policy as the state bucket.
2. **ECR repo** `cdkd-container-assets-{accountId}-{region}`:
   - `imageTagMutability: IMMUTABLE` (tags are content hashes; CDK bootstrap
     uses IMMUTABLE too).
   - No lifecycle policy in v1 (§11 follow-up `cdkd gc`).
3. **Marker write** (§4.1) — last, only after both resources exist.

Idempotent like the state-bucket path (exists → reconfigure only under
`--force`). `--no-assets` skips 1–3. Bootstrap output states loudly that
asset mode is now ON for the region and what the first deploy will do (§9).

**Bucket-squatting defense.** The bucket name is predictable (the same
weakness as CDK's bootstrap bucket — see the 2024 upstream advisory on
predictable bootstrap bucket names). Two layers:

- Bootstrap distinguishes `BucketAlreadyOwnedByYou` (fine, idempotent) from
  owned-elsewhere (hard error naming the conflict; never adopt a bucket this
  account does not own).
- Every S3 call against the asset bucket (`HeadObject` existence check,
  `PutObject` upload) passes `ExpectedBucketOwner: accountId`, so even a
  DNS-style hijack or a marker pointing at a since-recreated foreign bucket
  can never leak assets cross-account. (Cheap: we always know the account id
  at publish time.)

## 6. Publish-time redirection (`src/assets/**`, WorkGraph)

The publishers already publish to whatever `assets.json` `destinations`
declare — they never assumed a naming convention. Change: build an
**asset-location mapping table** once per deploy (accountId + region known):

```
for each file asset destination d:
  if isDefaultBootstrapShape(d.bucketName):        // §8 scope rule
    map[flatten(d.bucketName)] = cdkdAssetBucket   // objectKey unchanged
for each docker asset destination d:
  if isDefaultBootstrapShape(d.repositoryName):
    map[flatten(d.repositoryName)] = cdkdContainerRepo  // imageTag unchanged
```

`flatten(...)` resolves the `${AWS::AccountId}` / `${AWS::Region}` /
`${AWS::Partition}` placeholders — deploy-time constants. The publishers and
the template rewrite (§7) consume the **same table**, so they cannot diverge.
`objectKey` / `imageTag` (content hashes, including any
`DefaultStackSynthesizer.bucketPrefix` baked into `objectKey`) are kept
unchanged — the existence-check/skip logic (`HeadObject` / `DescribeImages`)
works as-is per storage, and key prefixes flow through untouched.
`dest.assumeRoleArn` stays ignored (already the case). The standalone
`cdkd publish-assets` command gets the same table.

## 7. Template reference rewrite (analyzer entry)

A dedicated pass over the parsed template, per stack, before DAG build:

1. Take the §6 mapping table (source names in both placeholder form and
   flattened literal form).
2. Deep-walk the template. On every string node — including `Fn::Sub`
   template strings — substring-replace both forms. For `Fn::Join`, first
   **fold pseudo-parameter-only segments**: any run of parts consisting of
   string literals and `{Ref: AWS::AccountId|AWS::Region|AWS::Partition|AWS::URLSuffix}`
   is partially evaluated to a literal (all are deploy-time constants), then
   replaced. Joins containing real resource refs are left alone — synthesizer
   output never splits an asset location across a resource ref.
   Matching is **boundary-aware**: a source name only matches when followed
   by end-of-string or a URI delimiter (`/`, `:`, `.`, `"`, whitespace), so a
   user resource whose name merely starts with the bootstrap bucket name
   (e.g. `cdk-hnb659fds-assets-<acct>-<region>-backup`) is never corrupted.
3. **Post-resolution audit** (defense in depth): after
   `IntrinsicFunctionResolver` produces final literals, if any resolved
   property value still contains a mapped **source** name, fail the resource
   with a clear "unrewritten asset reference" error naming the logical id and
   property path. This turns any missed shape into a loud pre-provisioning
   error instead of a split-brain deploy (assets in cdkd storage, resource
   pointing at the CDK bucket).

The template's per-resource asset metadata (`Metadata.aws:asset:path` /
`aws:asset:property`, emitted by default by CDK v2 for asset-bearing
resources) is used as a **cross-check anchor** for the audit — it names the
exact property that carries an asset reference — but not as the primary
mechanism, because asset references also appear outside flagged properties
(`s3.Asset` URLs in env vars, SFN definitions, CustomResource props).

Pre-resolution placement is chosen (over rewriting inside the resolver)
because: single call site; state records cdkd names in `properties` /
`observedProperties`, so diff / drift / destroy are self-consistent on later
deploys with **no schema bump**; `cdkd diff` output shows the real (cdkd)
locations. `cdkd synth` output stays **unrewritten** — it prints the CDK
app's template, not cdkd's deployment plan.

**Nested child templates are a separate parse path and MUST get the same
pass.** `NestedStackProvider` (and `diff-recursive.ts` / `export.ts`'s child
readers) load `<Stack>.<Child>.nested.template.json` from `cdk.out` via their
own `readFileSync` — they do not flow through the top-level analyzer entry.
A nested Lambda/ECS asset reference that misses the rewrite would be exactly
the split-brain the audit exists to prevent, so the rewrite helper is applied
at every child-template load site (the child's assets live in the same
assembly-level `assets.json`, so the mapping table is already in hand).
The parent's `TemplateURL` property itself also gets rewritten, harmlessly —
`NestedStackProvider` never dereferences the URL.

### 7.1 Command coverage

The marker read + mapping table + rewrite must behave identically across
every synth-consuming command:

| Command | Behavior in cdkd-assets mode |
| --- | --- |
| `deploy` | redirect + rewrite (this section) |
| `diff` (incl. `--recursive`) | rewrite, so the shown plan matches what deploy will do (incl. the one-time migration diff) |
| `import` | rewrite before writing state, so imported state matches what the next deploy would write (no spurious first-deploy churn) |
| `publish-assets` | redirect via the same table; reads the marker, which adds a state-bucket read to this command — if no state bucket is resolvable, fall back to legacy destinations with an info line |
| `synth` | **unrewritten** — it prints the CDK app's template, not cdkd's deployment plan |
| `export` | **unrewritten** (intentional): the IMPORT changeset template returns to the CFn/cdk-assets world; the first post-export `cdk deploy` republishes to the CDK bootstrap bucket and repoints properties — self-correcting |
| `destroy` / `state *` / `drift` / `events` | state-driven, no template/asset involvement — unchanged |

## 8. Custom synthesizers: scope rule

**All the information needed is already in `assets.json`** — every asset
carries concrete per-destination `bucketName` / `objectKey` /
`repositoryName` / `imageTag` (placeholder form), regardless of synthesizer.
cdkd's publishers have always worked off these. `manifest.json` additionally
names each stack's template asset object key. So no naming heuristics are
required to *find* asset locations; the only question is *which destinations
to redirect*:

| Destination shape | Example | At `cdk gc` risk? | v1 policy |
| --- | --- | --- | --- |
| Default bootstrap, default qualifier | `cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}` | **yes** | redirect |
| Default bootstrap, custom qualifier | `cdk-myqual-assets-…` | **yes** (gc can target any bootstrap stack) | redirect (pattern `cdk-[a-z0-9]+-(container-)?assets-…`) |
| `bucketPrefix` on DefaultStackSynthesizer | affects `objectKey` only | n/a | flows through unchanged (§6 keeps keys) |
| Custom `fileAssetsBucketName` / `imageAssetsRepositoryName` | user-chosen names | no — gc only reads the bootstrap stack's storage | leave verbatim (user made an explicit storage choice) |
| Destination `region` ≠ deploy region (cross-region publishing, e.g. pipeline setups) | any | varies | leave verbatim — cdkd asset storage + marker are per-region; cross-region destinations stay out of scope (matches the existing `assumeRoleArn` stance) |
| `AppStagingSynthesizer` | per-app staging bucket; **one ECR repo per image asset**, with staging-stack lifecycle rules (30-day deploy-time expiry, `imageAssetVersionCount` default 3) | no — gc never sees the staging stack's storage | leave verbatim; the lifecycle-expiry semantics are the user's chosen model and apply equally to CFn deploys |

So: **redirect only default-bootstrap-shaped destinations** (any qualifier)
— exactly the population exposed to `cdk gc` — and leave user-chosen storage
alone, preserving the transparency principle. The §6 mapping mechanism is
name-agnostic, so a future opt-in flag (`--redirect-all-assets`) could extend
redirection to custom destinations without redesign if demand appears.

## 9. Migration of already-deployed stacks

First deploy after the user re-bootstraps a region:

1. Publish step uploads all manifest assets to the cdkd storage (hash keys
   identical; CDK-bucket copies are simply no longer referenced).
2. The rewrite changes e.g. `Code.S3Bucket` → ordinary property diff →
   in-place UPDATE re-pointing code/image at cdkd storage. Content identical,
   **no replacement** (`Code.*` is update-in-place for Lambda; `Image` is a
   task-definition revision for ECS).

Document that a one-time "everything with assets shows an update" diff is
expected. No state migration, no schema bump. (Not a state-schema change, so
the `integ-schema-migration` gate is not in play; a dedicated migration integ
— deploy on old version → re-bootstrap → deploy on new version → destroy
clean — is still required.)

Known edges (documented, accepted):

- **Rollback of the migration deploy after gc already ran**: rolling back
  repoints e.g. `Code.S3Bucket` to the CDK bucket; if `cdk gc` had already
  deleted those objects (the incident that motivates the migration), that
  rollback step fails and cdkd's normal partial-state handling applies —
  re-running `cdkd deploy` rolls forward. Called out in the migration docs.
- **Mixed binary versions in a team during the migration window**: an old
  binary ignores the marker and repoints properties back to CDK storage on
  its next deploy; the next new-binary deploy repoints them again. Flip-flop
  churn, never breakage (both storages hold the content-addressed objects).
  Docs: upgrade the team/CI binary before re-bootstrapping.
- **IAM**: deploy principals need `s3:*Object` on `cdkd-assets-*` and the
  usual ECR push set on `cdkd-container-assets-*`; least-privilege users must
  extend their policies before re-bootstrapping (docs note + a dedicated
  error hint on AccessDenied at publish time).
- **Partition**: the flattener uses the same partition resolution as today's
  `resolveAssetDestinationValue` (default `aws`); GovCloud/China partitions
  inherit whatever that resolves — no new gap, and the audit catches a wrong
  fold loudly.

## 10. `cdkd local` family

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

## 11. Out of scope (v1) & follow-ups

- **Cross-account / cross-region destinations** (`assumeRoleArn`): already
  ignored today; unchanged.
- **`cdkd gc`** (separate issue): with cdkd-owned storage, cdkd owns the
  lifecycle. A cdkd-native gc can enumerate referenced hashes directly from
  state files (fully-resolved `properties`) — strictly better signal than
  gc's template substring scan.
- **Upstream protection-tag proposal** for `cdk gc` (separate issue,
  defense-in-depth for environments mid-migration and for option-8 rows we
  leave verbatim).
- **`cdkd export` interaction**: the exported stack keeps running (code /
  image already loaded); the next `cdk deploy` republishes assets to the CDK
  bootstrap bucket via cdk-assets and updates references — self-correcting.
  Docs note only.

## 12. Open questions

1. **Marker key layout** — `cdkd-bootstrap/{region}.json` (proposed; outside
   the `cdkd/` state prefix so `state list` key-listing never mistakes it for
   a stack) vs a single `cdkd-bootstrap.json` with a region map (single-key
   read, but concurrent bootstraps in two regions race on last-writer-wins).
   Leaning per-region keys.
2. **Legacy-mode info line** — every deploy vs once per state bucket
   (recorded)? Leaning every deploy at `info` level; it is one line and the
   hazard is real.
3. **Bucket/repo lifecycle defaults** — none in v1; revisit with `cdkd gc`.
