---
description: ResourceProvider interface, Provider Registry, Custom Resources, and adding a new SDK Provider
paths:
  - 'src/provisioning/**'
---

# Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>): Promise<ResourceCreateResult>;
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}
```

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
  schema's `nestedProperties` capture — not by reading the type by eye.
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
  Measure before setting it: a provider that hands a whole sub-blob to a
  GENERIC key converter (`pascalToCamelCaseKeys(config)`) delivers every key
  under it with no write to find, and the pass cannot see that yet (issue
  #1445). That is why only `AWS::CodeBuild::Project` opts in today — the
  measured counts for every target are in the script's file header.
- **Write evidence is PATH-SCOPED (issue #1448), and the bound it replaced is
  worth knowing.** As shipped in #1432 the evidence was a flat per-FILE set of
  member names and the audited unit was a key NAME, so a member written
  ANYWHERE vouched for every key of that spelling — 11 of CodeBuild's 55
  same-spelling keys had more than one write site, and
  `BuildBatchConfig.ServiceRole` (the sibling of the member that motivated
  #1432) stayed silent when dropped because the unrelated top-level
  `serviceRole` write covered it.
  Both sides moved in #1448: the audited unit is now the PATH
  `TopLevelProperty.NestedKey`, and each written name is indexed to the members
  written BENEATH the value it is written with (`collectWriteEvidence`,
  resolving `this.mapSource(x)` calls, `const` / `let` bindings, `?:` / `??`
  arms and `.map(cb)` callbacks — the same reach as the #1404 taint walk). A
  path's terminal member is checked against the scope its top-level maps to, so
  the `BuildBatchConfig.ServiceRole` deletion now exits 1.
- **The pass still has a measured BOUND — do not repeat the over-promise this
  bullet exists to correct.** Path-scoping NARROWS the duplicate-name class; it
  does not close it, and the residual is NOT only #1445's generic converter.
  1. **A duplicate name inside the SAME top-level still vouches.** The fixture's
     `nestedProperties` capture is flattened per top-level, so `Environment.Type`
     and `Environment.EnvironmentVariables[].Type` are the SAME audited path, and
     the write scope is flattened to match. Measured on the only opted-in target,
     by deleting the line from a scratch copy of the real `codebuild-provider.ts`
     and running `--check`: deleting `environment: { type: … }` exits **0**
     (`environmentVariables[].type` covers it), and deleting
     `source: { type: … }` in `mapSource` exits **0** (`auth.type` covers it).
     Both are genuine silent drops. Closing this needs a per-PATH fixture
     capture (`refresh-cfn-schemas.mjs` + an AWS re-capture), not a critic
     change — tracked in issue
     [#1464](https://github.com/go-to-k/cdkd/issues/1464).
  2. **Scopes are keyed by NAME and unioned across write sites.** Two unrelated
     `environment: { … }` literals in different methods share one `environment`
     scope, and a name that only ever appears nested still gets a scope a
     same-spelled TOP-LEVEL property would be checked against.
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
  4. **The reverse-map exclusion is PREFIX-only**, so a suffix-named reverse
     helper (`volumesToCfn`, `metricsSdkToCfn`) is not skipped. No live impact —
     the only opted-in target keeps its reverse map inside `readCurrentState` —
     but widening the match would also withdraw names from the LITERAL set on
     targets nobody has measured for it, so it is deliberately not done.
  Both (1) and (2) are pinned by tests, and the full measured statement lives in
  the script's file header. What ALSO remains outside the fence is a blob handed
  WHOLE to a generic converter: the scope index cannot see inside it, so those
  keys are unmeasurable rather than vouched-for, and that is what keeps the other
  targets from opting in (issue #1445). For all of the above, a hand diff of the
  WHOLE blob (the first bullet in this section) is still the thing that catches a
  dropped sub-key.
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
