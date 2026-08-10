---
description: ResourceProvider interface, Provider Registry, Custom Resources, and adding a new SDK Provider
paths:
  - 'src/provisioning/**'
---

# Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>, context?: CreateContext): Promise<ResourceCreateResult>;
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}
```

`create`'s `context` (issue #1463) is the sibling of `delete`'s: optional,
so most providers need no change, and it carries exactly one field today.
`context.replayingState` is `true` when the properties come from a cdkd
STATE record rather than the template — set ONLY by the rollback executor's
reverse-replacement arm (`rollback-executor.ts`), which revives the OLD
resource from `previousState.properties`. A provider PRE-FLIGHT REFUSAL
(see [docs/provider-development.md](../../docs/provider-development.md) §1a)
MUST downgrade to a warning when it is set: the user cannot edit a state
record from the template, so refusing would leave the old resource
unrestorable with only a hand-edit of `state.json` as a remedy. It licenses
NOTHING else — it says nothing about the properties' content, is not a
dry-run signal, and must not relax data-safety guards or the validation that
protects the AWS call itself. Absent / `false` = an ordinary template-path
create (`cdkd deploy`, the replacement / `--replace` / `--recreate-via-*`
creates), where the refusal stands. `GlueProvider`'s
`enforceIcebergTableInputAbsent` is the only consumer today; the full contract
is on `CreateContext` in `src/types/resource.ts` (NOT in `region-check.ts`
where `DeleteContext` lives — that type belongs there because its
`expectedRegion` feeds `assertRegionMatch`; a one-line pointer sits next to
`DeleteContext` so a reader looking for one finds the other).

**A create-side pre-flight refusal forbids re-creating inside `update()`.**
Several providers call `this.create(logicalId, resourceType, properties)` from
their own `update()` (ACM certificate, IAM managed policy, IAM role, Lambda
permission, SNS subscription). Those internal re-creates CANNOT receive a
context — `update()` has no context parameter — and the `properties` they
forward ARE a state record during a rollback replay (`rollback-executor.ts`'s
`revert` arm calls `provider.update(..., previousState.properties, ...)`, as
does `drift --revert`). So a provider that both refuses on create AND
re-creates inside `update()` would fire that refusal on a replay with no way
to detect it. None of the five does today (required-field validation only,
which correctly stays a hard error), so this is a constraint on the next
provider rather than a description of the current tree.

The `context.expectedRegion` parameter on `delete` is the region recorded
in the stack state when the resource was created. Providers MUST verify
the AWS client's region against `context.expectedRegion` (via the shared
`assertRegionMatch()` helper in `src/provisioning/region-check.ts`)
before treating a `*NotFound` error as idempotent delete success — see
"DELETE idempotency" below and [docs/provider-development.md](../../docs/provider-development.md).

`context.forceDataDelete` (issue #1340) is explicit user consent to destroy
the DATA a resource still contains — set ONLY by the deploy engine's
replacement / recreate delete sites when `--force-stateful-recreation` was
passed, never by plain `cdkd destroy`. Providers whose delete API fails by
default on contained data (S3 bucket / S3 Express directory bucket
auto-empty, ECR `force: true`) MUST
gate that force-cleanup on this flag OR a template-borne opt-in (CDK's
`aws-cdk:auto-delete-objects` / `aws-cdk:auto-delete-images` tags,
`EmptyOnDelete: true` — shared helpers in
`src/provisioning/data-delete-intent.ts`), and otherwise surface AWS's
not-empty error like CloudFormation's DELETE_FAILED. Do NOT add
unconditional force-cleanup to a new provider's delete — verify CFn's
actual delete behavior by live A/B first (CFn hard-deletes more than
folklore says: SecretsManager no-recovery-window and IAM role
force-detach are PARITY, verified 2026-08-02).

`context.finalSnapshotIdentifier` (issue #1352) means the resource's
`DeletionPolicy` is `Snapshot`: the provider MUST create a final snapshot
under that identifier as part of the delete — the atomic-parameter types
(RDS DBInstance / DBCluster, Neptune / DocDB clusters, ElastiCache
CacheCluster) flip their delete call from `SkipFinalSnapshot: true` to the
API's final-snapshot form. The delete call sites only pass the field for
types in `ATOMIC_FINAL_SNAPSHOT_TYPES`
(`src/provisioning/final-snapshot.ts`) on the SDK route; the
`PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume, Redshift Cluster, ElastiCache
ReplicationGroup — issue #1353) are snapshotted engine-side pre-delete via
`createPreDeleteFinalSnapshot`, and any other Snapshot-tagged shape
(cc-api routing included) is refused before any delete. The call sites are
`cdkd destroy` / `cdkd state destroy` (`destroy-runner.ts`), the deploy
engine's DELETE + replacement / recreate deletes
(`prepareFinalSnapshotForDelete`), and — since issue #1358 — the rollback of
a CREATE (`rollback-executor.ts`'s `delete-with-final-snapshot` action,
driving both the automatic post-failure rollback and `cdkd rollback`), plus
the FAILED in-flight CREATE's delete under `cdkd rollback --revert-failed`
(`delete-failed-create-with-final-snapshot`, issue #1362 — same matrix, same
refusals). When
adding final-snapshot support for a new type, extend the sets there — never
make a provider silently ignore the field.

Register Provider for each resource type in Provider Registry:

```typescript
const registry = ProviderRegistry.getInstance();
registry.register('AWS::IAM::Role', new IAMRoleProvider());
```

## Custom Resources

- Supports Lambda-backed Custom Resources
- Create/Update/Delete lifecycle
- ResponseURL uses S3 pre-signed URL for cfn-response handlers
- **Response-bucket region correction (issue #1195).** The response bucket is cdkd's STATE bucket, which can live in a different region from the deploy region (account-scoped region-free default bucket). Before the first response-bucket S3 operation (placeholder `PutObject` + `ResponseURL` presign in `generateResponseURL`), `ensureResponseClient()` lazily resolves the bucket's actual region via the shared `rebuildClientForBucketRegion` helper (#827) and swaps in a region-corrected client — a pre-signed URL's host is region-specific, so signing with the deploy region against a foreign-region bucket 301s (`PermanentRedirect`). `setResponseBucket(bucket)` deliberately takes NO region parameter (issue #1202): correction always starts from the shared `AwsClients.s3` client, so `--profile` / static credentials carry into both the `GetBucketLocation` probe and the rebuilt client, and every call site (deploy / destroy / drift / state / rollback) is corrected the same lazy way.
- CDK Provider framework: isCompleteHandler/onEventHandler async pattern detection
- Async CRUD with polling (max 1hr), pre-signed URL validity 2hr
- Sets `disableOuterRetry = true` on the `ResourceProvider` interface so the deploy engine's outer `withRetry` loop does NOT re-invoke `provider.create()` on transient SDK errors. Each invocation derives a fresh pre-signed S3 URL and RequestId via `prepareInvocation()`; an outer retry would strand the first attempt's Lambda response at an S3 key nobody polls. Internal exponential-backoff polling on the response key handles eventual consistency on its own.
- **Transient IAM-authorization retry (CR-internal).** Because cdkd's fast SDK path attaches a backing Lambda's execution-role inline policy and invokes the function ~1s later, the function can cold-start before IAM propagates the policy to its assumed-role session — caching stale, policy-less credentials for the warm container's life. The CDK Provider framework's first invoke / `waitUntilFunctionActive` (`lambda:GetFunction`) then 403s ("not authorized to perform" / "not in the state functionActive") and the custom resource FAILs. CloudFormation never hits this because its deployment latency lets IAM settle; cdkd does NOT, so `invokeCustomResourceWithRetry()` re-invokes (default 2 retries; `CDKD_CR_AUTHZ_MAX_RETRIES`, 0 disables) when the FAILED reason matches the NARROW IAM-authz signal set (`CR_TRANSIENT_AUTHZ_SIGNALS` — `not authorized to perform` / `no identity-based policy allows` / `not in the state functionActive` / `cannot be assumed` / `is unable to assume`; generic timeouts / handler bugs are deliberately NOT retried). Each retry derives a fresh pre-signed URL/RequestId AND recycles the backing function's execution environment via a no-op `UpdateFunctionConfiguration` (so the next cold start re-assumes the role with the now-propagated policy — a plain re-invoke would reuse the same warm container's stale creds). This is the CR-path analogue of the IAM-propagation retry `withRetry` already applies to every other resource (the CR path opts out of `withRetry` via `disableOuterRetry`, so it retries internally instead). Verified end-to-end via the `custom-resource-provider` integ.
- Implements `getMinResourceTimeoutMs()` returning `asyncResponseTimeoutMs` (default 1h) so the deploy engine's per-resource deadline auto-lifts to the polling cap for CR resources only — Custom-Resource-heavy stacks no longer need `--resource-timeout 1h`. A user-supplied `--resource-timeout AWS::CloudFormation::CustomResource=<DURATION>` per-type override still wins as the explicit escape hatch.
- **Delete fail-fast when the backing Lambda is gone (issue #804).** `delete()` issues a single `GetFunction` pre-check before preparing the invocation; a definitive `ResourceNotFoundException` logs a warning and treats the Custom Resource as already deleted (warn-and-continue is the delete path's existing policy). Without it, a re-run after an interrupted / partially-failed destroy entered `waitForBackingLambdaReady`, whose SDK waiters classify `ResourceNotFoundException` as RETRY and poll `GetFunction` for the full 10-minute `maxWaitTime`. Inconclusive pre-check errors (throttle, IAM) fall through to the normal invoke path; SNS-backed tokens skip the pre-check; create / update never pre-check (they must fail loudly against a missing function).
- Implemented in `CustomResourceProvider`

## Reading a field off an AWS response: type != populated

An AWS SDK v3 response TYPE declaring a field does NOT mean the API you called
populates it. The models are shared across operations, so a `List*` summary can
declare `Tags?: Tag[]` and never carry tags. AWS documents the exception on the
COMMAND, not the model:

> IAM resource-listing operations return a subset of the available attributes
> for the resource. For example, this operation does not return tags, even
> though they are an attribute of the returned object. To view all of the
> information for an instance profile, see GetInstanceProfile.

`iam-instance-profile-provider` carried exactly this defect until PR #1127:
`import()` read tags off the `ListInstanceProfiles` summary, which typechecked
and always saw `undefined`. Because a tag-walk non-match is not an error, the
walk simply never matched and `cdkd import` reported the resource as
**not-found** — a silent wrong answer, not a crash. The provider's unit tests
hand-fed inline `Tags` and so agreed with the bug.

**When consuming a field from a `List*` / `Describe*` response:**

- Read the command doc
  (`node_modules/@aws-sdk/client-*/dist-types/commands/<Op>Command.d.ts`), not
  just the model in `models/models_*.d.ts`. Types prove SHAPE; only the command
  doc (or a live call against a populated account) proves POPULATION.
- Prefer a per-candidate `Get*` when the list form is documented as a subset.
  The extra call is the correct cost.
- A live probe that comes back empty because the account has no such resource is
  **inconclusive**, not confirmation.
- Ask of any test: "would this still pass if the API returned nothing for this
  field?" If yes, it pins your assumption, not the behavior.

## Never infer a default from a possibly-malformed value

`(config['Status'] as string) || 'Suspended'` reads correctly and is wrong: when
`config` is a STRING / array / unresolved intrinsic rather than the object the
template was supposed to carry, the index yields `undefined` and the `||`
substitutes the default — frequently the OPPOSITE of what the template declared,
with no error anywhere. `VersioningConfiguration: 'Enabled'` on an
`AWS::S3::Bucket` turned versioning OFF on a live bucket (issue #1471); the shape
was measured at 16 sites across 5 providers.

Use `src/provisioning/config-shape.ts` instead of hand-writing the guard:

```ts
// nested container (may itself be malformed)
const status = readConfigString(
  versioningConfig, 'Status', 'Suspended', 'AWS::S3::Bucket VersioningConfiguration'
);
// top-level field — keep the properties['X'] read at the call site
const scope = requireConfigString(properties['Scope'], 'REGIONAL', 'AWS::WAFv2::WebACL Scope');
```

Three things about it are non-obvious and each was forced by the real tree:

- **Guard the DESIRED side only.** `previousProperties` comes from cdkd STATE,
  not the user's template. Refusing a malformed value recorded there by an older
  binary makes the stack permanently undeployable — editing the template does not
  help, because the previous side stays malformed until a deploy succeeds. An
  earlier attempt guarded both sides and had to be reverted.
- **Validate the FIELD, not just the container.** `{ Status: null }` and
  `{ Status: '' }` both pass a `typeof === 'object'` check and still fall through
  to the default. An ABSENT key must keep defaulting, though — `{}` legitimately
  means Suspended.
- **Cover the CREATE path.** A truthiness gate (`if (versioningConfig)`) lets a
  truthy-but-malformed value through on create only, so create and update
  disagree; use `!= null` so both refuse it. Same rationale as the
  OwnershipControls / BucketEncryption gates.

Pre-flight template validation is NOT the right layer for the field rules: at
pre-flight time intrinsics are unresolved, so a legitimate `Fn::If`-valued block
is an object whose inner key does not exist yet and a field check would reject
valid templates.

## Fixing ONE nested-key divergence: diff the WHOLE blob, not the reported key

A filed silent-drop bug names the key someone happened to notice. Fixing only
that key leaves its siblings broken, and the sibling is often the WIDER
breakage — the reported key may be the rarer shape.

Issue #1389 reported `ByteMatchStatement.SearchStringBase64` (CFn-only, no SDK
member) on `AWS::WAFv2::WebACL`. A reviewer extracted **all 154** CFn keys in the
`CfnWebACL` tree from `aws-cdk-lib`'s `convertCfnWebACL*PropertyToCloudFormation`
renderers and diffed them against the SDK schema member-name set. That found a
second divergence the issue never mentioned: CFn spells the reference-statement
ARN `Arn` while `IPSetReferenceStatement` / `RegexPatternSetReferenceStatement` /
`RuleGroupReferenceStatement` all declare it `ARN` **and mark it required** — so
every WebACL using a reference statement failed `CreateWebACL`, base64 or not.
That is a far more common template shape than the base64 search string.

**Before fixing a nested-key divergence:**

- Enumerate the CFn side MECHANICALLY, from `aws-cdk-lib`'s generated
  `convertCfn<Type><Prop>PropertyToCloudFormation` functions or the registry
  schema's `nestedPropertyPaths` capture (or its flattened `nestedProperties`
  sibling) — not by reading the type by eye.
- Enumerate the SDK side from the schema serde aliases
  (`node_modules/@aws-sdk/client-*/dist-cjs/schemas/schemas_0.js`) as well as the
  `.d.ts` members: the aliases are what the serializer actually iterates, so
  "`_ARN = "ARN"` exists and `_Arn` does not" is the decisive evidence.
- Diff the two sets and fix EVERY divergence in the same change. Report the
  count you compared, so a reviewer can tell a full diff from a spot-check.
- Prefer adding the type to `NESTED_KEY_TARGETS` (see step 4 below) over relying
  on this being done by hand next time — the mechanical critic is the durable
  form of this rule.
- **Know what membership does and does not guarantee.** For a provider that
  FORWARDS a config blob, membership makes the key-spelling class
  non-regressing. For one that builds a FRESH SDK object naming each member,
  a matching spelling proves nothing: the critic's `same-spelling` bucket is
  silent, and a member the mapper never names is dropped anyway. That is issue
  #1432, found on `AWS::CodeBuild::Project` `BuildBatchConfig.BatchReportMode`
  — CFn declares it, the SDK declares `batchReportMode`, the provider named
  four of five members, and the critic stayed silent even with every
  occurrence of the SDK spelling renamed away.
  So a fresh-object provider must ALSO set `freshObjectMapper: true` on its
  target, which turns on the WRITE-EVIDENCE pass: each would-be
  `same-spelling` key then has to appear as a WRITTEN SDK member
  (`batchReportMode: ...`, `{ batchReportMode }`, `sdk.batchReportMode = ...`,
  the compound `??=` / `||=` / `+=` forms, or
  `Object.defineProperty(sdk, 'batchReportMode', ...)`) or it lands in the
  CI-blocking `no-write-evidence` bucket. Reads do not count,
  `readCurrentState`'s reverse map is excluded, and a literal built only to be
  DIFFED (`JSON.stringify({ … }) !== JSON.stringify(prev)`) is not delivery —
  so the evidence is scoped to the CFn->SDK direction.
  Measure before setting it. The opt-in set is decided by measurement, never
  by prediction, and the full before/after table lives in the script's file
  header. Today `AWS::CodeBuild::Project`, the five `AWS::ApiGatewayV2::*`
  targets, both `AWS::ECS::*` targets and
  `AWS::CloudWatch::AnomalyDetector` are in; `AWS::S3::Bucket` and
  `AWS::CloudFront::Distribution` each carry a recorded, measured reason they
  are not.
- **A whole sub-blob handed to a GENERIC key converter is credited (issue
  #1445).** `ECSProvider.convertLinuxParameters` is
  `return pascalToCamelCaseKeys(config)` — one call delivers `Capabilities` /
  `Devices` / `Tmpfs` / `Swappiness` and everything beneath them, correctly
  wired and with no per-member write to find. `collectWriteEvidence` follows
  that hand-off: a value read off the DESIRED property bag
  (`HANDOFF_BAG_PARAM_NAMES`, declaration-scoped taint) that reaches a WRITE
  without any member of it being named — through `?:` / `??` arms, `const`
  bindings, spread-only literals, and `this.f(…)` / free-function /
  sibling-module calls — is a hand-off PATH, and everything AT OR BENEATH that
  path is credited (`isHandoffCovered`'s prefix test since #1464; #1445 shipped
  it as a fold through the SDK model's reference graph, which a flat scope
  needed and a path-keyed one does not).
  Two halves of that are what keep it from becoming a rubber stamp, and both
  are worth knowing before you rely on it:
  - A callee counts as GENERIC only when it names NO member — anywhere in its
    body OR in any callee it can reach. `convertLoadBalancers` names four, so
    every member of the blob it builds still has to prove itself, which is how
    the pass found that `LoadBalancers.AdvancedConfiguration` was silently
    dropped (fixed in #1473; both ECS targets are opted in since). The TRANSITIVE part is what refuses a DELEGATING GUARD
    (`convertLog(cfg) { if (!cfg) return cfg; return this.buildLog(cfg); }`),
    which a body-local test would accept.
    Read the rule as exactly "names no member", NOT as "can only emit keys it
    read": a converter that FILTERS, RENAMES via a map, or PICKs a key list
    names nothing and is still credited — recorded as known bound (5).
  - The credit is bounded to the BLOB, not to the enclosing scope.
    `ContainerDefinitions` carries the `LinuxParameters` hand-off AND
    `convertPortMappings`; crediting the whole scope would have hidden the
    missing `containerPortRange`.
  A blob read back off an AWS response and re-sent (CloudFront's
  disable-then-delete path) is NOT a hand-off — that is what the property-bag
  taint root is for, and without it 108 of CloudFront's 110 findings cleared
  falsely.
- **The BUILDER idiom is credited too (issue #1474).** A sub-blob assembled by
  MUTATION — `const mapped = {}; mapped.MetricTimezone = …;
  mapped.ExcludedTimeRanges = …; params.Configuration = mapped;` — names every
  member it delivers, per member, on the forward path; only the AST location
  differs from a literal's, so `resolveLiterals` stopped at the empty seed and
  every child of `Configuration` reported `no-write-evidence` falsely. That was
  all three of `AWS::CloudWatch::AnomalyDetector`'s residuals, and it is why
  that target can now opt in at 0. A BUILDER is a local binding whose
  INITIALIZER is an object literal (empty or partial), populated afterwards by
  `out.Foo = …` / `out['Foo'] = …` assignments onto THAT BINDING, and reaching
  a write; the credit lands at the same path a literal would have got, at full
  depth (`out.Rule.DefaultRetention = { Mode }` opens the intermediate scopes
  rather than flattening). Three things keep it from being a rubber stamp:
  the literal initializer (so the object's identity is this file's — a
  `const out = makeThing()`, a `let out;` seeded later, and a binding
  REASSIGNED as a whole are all refused); DECLARATION IDENTITY rather than the
  bare name; and the credit bounded to the BUILDER, never the enclosing
  scope — the `ContainerPortRange` trap one recognizer over. Delivery stays the
  caller's question: the builder walk only runs from a write site, which the
  `feedsOnlyComparison` rule has already filtered, so a builder that is never
  handed to a write, or handed only to a diff, is never credited. Recognizing
  the shape is MONOTONE (it only adds scoped members), so no target gained a
  finding; the tree's residual fell 290 -> 260 and `AWS::S3::Bucket`'s
  125 -> 98.
  **"Declaration identity" required fixing `declarationOf` itself**, and the
  gap was live in this recognizer before the #1474 review caught it: that
  helper searched the nearest FUNCTION scope and descended fully into nested
  functions, returning the FIRST textual match, so the bare-name weakness of
  known bound (3) reached INSIDE a single function. Two same-named `const cfg`
  builders in different `if` arms collapsed onto one declaration and MERGED
  their member sets (each vouching for the other's blob — false CLEAR), and a
  `const cfg` inside a nested arrow declared textually first captured the
  enclosing function's own `cfg` (outer member falsely flagged, inner falsely
  cleared). `const` / `let` are BLOCK-scoped, so `declarationOf` now resolves
  outward through BLOCK scopes, which is both the accurate model and the fix;
  it cannot under-resolve a valid binding either, since a reference outside the
  declaring block is a compile error. Both shapes are pinned by tests. The
  sibling-METHOD case worked from the start — it is the intra-function one that
  did not, which is why "we already have a test for same-named bindings" was
  not evidence.
  **The recognizer WIDENS known bound (4)** (prefix-only reverse-map
  exclusion), measured: a reverse SDK->CFn helper that is NOT named
  `readCurrentState*` and uses the builder idiom previously contributed only
  its empty seed and now contributes a populated SCOPE —
  `s3-bucket-provider.ts`'s `readLifecycle` (`const out = {}` filled with
  CFn-spelled `out['Id']` / `out['Status']`) and `ecs-provider.ts`'s
  `volumesToCfn` are exactly that, and S3's non-empty scope count jumped
  85 -> 144 partly on their strength. No effect on today's verdicts (S3 is not
  opted in; ECS is `lower-first`, so a CFn-spelled terminal misses the exact
  compare) — but S3 is `exact`-style, where a CFn-spelled reverse write vouches
  for the forward mapper verbatim, so widening
  `REVERSE_MAP_FUNCTION_PREFIXES` to a suffix match belongs to the S3 opt-in
  (issue #1495), where its effect on the LITERAL set can be measured on the
  target it affects. A `readCurrentState*`-named helper nested in a builder's
  scope IS skipped today, and that branch — the only builder refusal in the
  over-crediting direction — is pinned by a test with a non-reverse-named
  control.
- **Write evidence is PATH-SCOPED (issue #1448), and the bound it replaced is
  worth knowing.** As shipped in #1432 the evidence was a flat per-FILE set of
  member names and the audited unit was a key NAME, so a member written
  ANYWHERE vouched for every key of that spelling — 11 of CodeBuild's 55
  same-spelling keys had more than one write site, and
  `BuildBatchConfig.ServiceRole` (the sibling of the member that motivated
  #1432) stayed silent when dropped because the unrelated top-level
  `serviceRole` write covered it.
  Both sides moved in #1448: the audited unit became the PATH
  `TopLevelProperty.NestedKey`, and each written name was indexed to the members
  written BENEATH the value it is written with (`collectWriteEvidence`,
  resolving `this.mapSource(x)` calls, `const` / `let` bindings, `?:` / `??`
  arms and `.map(cb)` callbacks — the same reach as the #1404 taint walk), so
  the `BuildBatchConfig.ServiceRole` deletion exits 1.
- **...and scoped at FULL DEPTH since issue #1464.** #1448 stopped one level
  short because of the FIXTURE: `nestedProperties` is a flattened transitive
  closure per top-level, so `Environment.Type` and
  `Environment.EnvironmentVariables.Type` were literally the same audited path
  and each vouched for the other. The fixture now also carries
  `nestedPropertyPaths` (full `$ref`-resolved, cycle-guarded chains,
  `extractNestedPropertyPaths` in `scripts/refresh-cfn-schemas.mjs`; arrays are
  transparent), and the write index is keyed by the matching write PATH. Three
  consequences: a terminal member is checked against the scope its FULL PARENT
  CHAIN maps to; a whole-blob hand-off credits by path PREFIX (tighter than the
  #1445 fold through the SDK model, which is now only a parser floor); and a
  write that only ever appears LEXICALLY nested no longer opens a root scope.
  Measured against the real `codebuild-provider.ts` via `--providers-dir=`:
  deleting `environment: { type: … }` exits **1** naming `Environment.Type`
  with the cousin clean, and deleting `environmentVariables[].type` exits **1**
  naming `Environment.EnvironmentVariables.Type` with the cousin clean.
  The audited unit grew 587 -> 703 paths, so every `minNestedKeys` floor was
  re-calibrated, as was ECS's `minWriteScopes` (34 -> 58 non-empty scopes; 70
  after #1474's builder recognizer opened the scopes a mutated binding
  populates — the declared floor is a lower bound, so it did not need moving).
  **Two SEGMENT-SPELLING mechanisms sit under the full-depth match, and they are
  not interchangeable.** A CASE difference on an intermediate segment is
  absorbed: the parent chain is matched case-insensitively (the terminal member
  is not — it is the only thing that proves delivery), because a CFn->SDK
  segment spelling is routinely not the mechanical first-letter flip
  (`EFSVolumeConfiguration` -> `efsVolumeConfiguration`) and an exact parent
  match reported 16 members `ecs-provider.ts` demonstrably does write. The fold
  is applied one LEVEL at a time while descending the write index, never as a
  global lowercase union — that would merge the member sets of the 80 unrelated
  `name` / `Name`-style scope pairs the same file carries. A genuine RENAME is
  out of the fold's reach and needs an explicit
  `segmentRenames` entry on the target (`ProxyConfigurationProperties` ->
  `properties`, the one in the tree), which is STALENESS-FENCED exactly like
  `NESTED_KEY_ALLOW_LIST`: `--check` fails when the un-renamed chain starts
  resolving (the SDK renamed it back) or the CFn segment disappears. It does NOT
  fail when the provider merely stops writing the member — that is the
  divergence the map exists to make reachable, and a stale-map error standing in
  front of it would hide a real silent drop behind a tooling complaint.
- **The pass still has a measured BOUND — do not repeat the over-promise this
  bullet exists to correct.** Depth-scoping NARROWS the duplicate-name class
  further; it does not make it vanish, and the residual is NOT only #1445's
  generic converter.
  1. **A duplicate name at the SAME PATH still vouches**, because the write index
     unions across write SITES. Two `environment: { … }` literals in different
     methods both feed the one `environment` scope, so a provider that stops
     writing a member on ONE code path is not fenced. Per-site sets would not
     change the answer — a key is cleared when ANY site covers it, which IS the
     union.
     Hand-off points are unioned the same way, and it is measurable:
     `ApiGatewayV2Provider` forwards `DefaultRouteSettings` whole at two sites
     (create + update), and deleting only ONE of them leaves `--check` at exit
     0.
  2. **A literal reached only by INDIRECTION still opens a root scope.** Root
     suppression is lexical, so a literal returned by a helper (or bound to a
     `const`) has no object-literal ancestor and its members are recorded at
     depth 1 as well as under the caller's path. Harmless unless a nested member
     name collides with an audited TOP-LEVEL property of the same type —
     measured today: on the API Gateway v2 targets every path cleared by a
     hand-off wildcard is one of the 13 legitimate blob members (6
     `CorsConfiguration.*` + 5 `DefaultRouteSettings.*` + 2
     `JwtConfiguration.*`), none by a stray root. Suppression follows a
     `.map(v => ({ … }))` callback, because `resolveLiterals` does; it does NOT
     follow an opaque call such as `JSON.stringify({ … })`, because nothing
     resolves that in the other direction and suppressing there would LOSE the
     write.
  3. **Value resolution is best-effort and bare-name.** Same-file callables and
     property initializers are indexed by NAME, so `this.mapSource(…)` and a
     free `mapSource(…)` resolve to the same declaration while a
     `receiver.mapSource(…)` on some other object deliberately does not.
     Identifier bindings are searched in the nearest function scope (descended
     FULLY, so two disjoint `if` branches binding the same name are unioned),
     then OUTWARD without descending into sibling functions, with a PARAMETER of
     the nearest scope stopping the climb. A hop it cannot follow yields no
     literals and flags CORRECT code, which is why it peels `await` and climbs
     to the module scope at all.
     The #1445 SDK-side expansion was bare-name the same way (`Items` reached
     217 members in the CloudFront model); since #1464 the hand-off credit is a
     path-prefix test that never consults the SDK model, and the expansion
     survives only as the `minHandoffPoints` parser floor.
  4. **The reverse-map exclusion is PREFIX-only**, so a suffix-named reverse
     helper (`volumesToCfn`, `metricsSdkToCfn`) is not skipped. No live impact —
     the only opted-in target keeps its reverse map inside `readCurrentState` —
     but widening the match would also withdraw names from the LITERAL set on
     targets nobody has measured for it, so it is deliberately not done.
  5. **The genericity test means "names no member", not "preserves every
     key".** It is transitive through resolvable callees, which closes the
     delegating guard — but a FILTERING (`if (DROP.has(k)) continue`),
     RENAME-MAP (`out[MAP[k] ?? k] = v`) or PICK (`for (const k of KEEP)`)
     converter names nothing and is credited anyway. No such shape is a
     hand-off callee today, but `glue-provider.ts`'s `renameRecordKeys` is
     exactly the rename-map shape and would be credited the moment a Glue
     target opted in. Closing it needs the walk to model the converter's KEY
     SET, not just its member names.
  6. **One provider SHAPE the three recognizers still do not cover**, measured
     on the real tree and tracked: the SPREAD-AND-PATCH forwarder
     (`const result = { ...config }` plus ~30 named patches, which the
     genericity test rejects on those names; CloudFront 162 — issue
     [#1475](https://github.com/go-to-k/cdkd/issues/1475)). The BUILDER idiom
     that sat here alongside it is CLOSED by issue
     [#1474](https://github.com/go-to-k/cdkd/issues/1474) — see the builder
     bullet above; the bounds it left behind are known bound (8) in the script
     header (seed-literal-only, computed keys refused, flow-insensitive).
  7. **An intermediate segment the provider RENAMES leaves its children
     unresolvable** (new with #1464). Case differences are absorbed; a rename is
     not — CFn `ProxyConfiguration.ProxyConfigurationProperties` is the SDK's
     `ProxyConfiguration.properties`, so
     `ProxyConfiguration.ProxyConfigurationProperties.{Name,Value}` report
     `no-write-evidence` although `convertProxyConfiguration` writes both. Two
     occurrences in the tree, both on `AWS::ECS::TaskDefinition`, both pinned by
     a test rather than allow-listed. The direction is the SAFE one (a loud
     false positive, never a silent clear), but it has to be resolved before
     that target opts in.
  Bounds (1) and (2) are pinned by tests, and so are the two bounds #1464 CLOSED
  (the same probes, inverted into fences). The full measured statement lives in
  the script's file header. For all of the above, a hand diff of the WHOLE blob
  (the first bullet in this section) is still the thing that catches a dropped
  sub-key.
- **Allow-listing a nested key does NOT silence the write pass by default.**
  `NESTED_KEY_ALLOW_LIST` entries silence the key and shape passes (the
  deliberate #1378 cross-pass sharing); an entry must say
  `passes: ['write', ...]` to clear a `no-write-evidence` verdict, because "this
  key is a legacy member with no modern SDK equivalent" says nothing about
  whether the provider writes a member it demonstrably has. Entries are matched
  PATH-first, terminal-name-second, so `…#BuildBatchConfig.ServiceRole` scopes a
  decision to one path while `…#ServiceRole` covers the key wherever it is
  reachable.

## Adding a New SDK Provider

1. Create new file in `src/provisioning/providers/`
2. Implement `ResourceProvider` interface
3. Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function
4. Refresh the CFn schema fixture for the new type: `node scripts/refresh-cfn-schemas.mjs --only-missing` (requires AWS credentials with `cloudformation:DescribeType`). Then classify every unaccounted property into `handledProperties` (if `create()`/`update()` wires the field) or `unhandledByDesign` (with a one-line rationale) so the new `property-coverage` test stays green — see [docs/provider-development.md](../../docs/provider-development.md) §3c. If the provider FORWARDS a nested config blob (a `handledProperties` entry whose value is a nested object/array the provider re-shapes for the SDK), ALSO add it to `NESTED_KEY_TARGETS` in `scripts/gen-nested-key-coverage.ts` — the critic's first run audits every nested key spelling against the SDK model (the #1370 silent-drop class, issue #1373). If the provider builds FRESH SDK objects naming each member rather than forwarding the blob, set `freshObjectMapper: true` too, after measuring the finding count — see the "Know what membership does and does not guarantee" bullet above (issue #1432).
5. Write tests
6. Add the resource type to [docs/supported-resources.md](../../docs/supported-resources.md) (deploy/manage capability table) AND to [docs/import.md](../../docs/import.md) (import-side coverage: auto-lookup vs override-only vs sub-resource)
7. **If the provider gates a stabilization wait on `process.env['CDKD_NO_WAIT']`** (i.e. `--no-wait` skips a multi-minute poll for this type), add the resource type to the `--no-wait` docs in ALL of: the `--no-wait` table + intro in [docs/cli-reference.md](../../docs/cli-reference.md), the `--no-wait` feature bullet in [README.md](../../README.md), and the `noWaitOption` help string + JSDoc in [src/cli/options.ts](../../src/cli/options.ts). Enforced by `tests/unit/provisioning/no-wait-doc-coverage.test.ts` (fails CI if a `CDKD_NO_WAIT`-honoring provider has no handled type in the cli-reference table). The `AWS::Lambda::MicrovmImage` provider shipped honoring `--no-wait` but missed this list — the test is the backstop.

   The same 4-site rule applies to the opposite end of the axis,
   `process.env['CDKD_FULL_WAIT']` (`--full-wait`, issue
   [#1275](https://github.com/go-to-k/cdkd/issues/1275)): a provider that
   waits ONLY under `--full-wait` belongs in the same wait-semantics table AND
   in the `--full-wait` section of
   [docs/cli-reference.md](../../docs/cli-reference.md). Enforced by
   `tests/unit/provisioning/full-wait-doc-coverage.test.ts` (added when
   `AWS::CloudFront::Distribution` joined `AWS::ECS::Service` as the second
   such type, issue [#1282](https://github.com/go-to-k/cdkd/issues/1282)).

   Before adding EITHER kind of wait, settle the completion definition per
   [docs/cli-reference.md](../../docs/cli-reference.md)'s wait-semantics rule:
   where CloudFormation and Terraform agree, match them; where they disagree,
   the default takes the dev/test-friendly side and `--full-wait` opts into the
   CloudFormation one. A default may take the fast side even where BOTH
   engines wait, but only under the 3-condition fast-side clause (issue
   #1282, recorded in the cli-reference wait-semantics intro): (a) no
   in-deploy consumer of the waited-for state, (b) no failure signal in the
   wait, and (c) the comparison tool has both modes so the benchmark can
   report two like-for-like rows. Record the divergence in the table rather
   than leaving it implicit in provider code.

See [docs/provider-development.md](../../docs/provider-development.md) for details.
