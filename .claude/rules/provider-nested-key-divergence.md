---
description: Fixing a nested CFn to SDK key divergence in a provider - diff the whole blob, not the reported key
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - nested CFn to SDK key divergences

The generator that measures this coverage is documented in [layout-scripts.md](layout-scripts.md).

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

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
  targets, both `AWS::ECS::*` targets, `AWS::CloudWatch::AnomalyDetector`,
  `AWS::CloudFront::Distribution` (issue #1475, via the spread-and-patch
  recognizer) and all three `AWS::AppSync::*` targets (`GraphQLApi` at issue
  #609, opted in at 0 with the type's config blobs; `DataSource` + `Resolver`
  at issue #1597, once their schema fixtures were re-captured with the
  `definitionShapes` / `nestedPropertyPaths` sections the generator requires —
  `Resolver` measured 0 on the first run, `DataSource` measured 10 and needed
  the `HttpConfig.AuthorizationConfig` + `DynamoDBConfig.DeltaSyncConfig` /
  `.Versioned` forwards the opt-in exposed) are in; `AWS::S3::Bucket` carries a
  recorded, measured reason it is not. `AWS::Glue::Database` joined at issue
  #1807, and it is the one worth reading for the SHAPE of the deferral this
  rule prescribes: its forced-on measurement (11 paths) was a REAL drop, so the
  opt-in was held back — pinned by name in a calibration test rather than
  silenced by 11 allow-list entries — until the provider fix could land in the
  same change, which is what forced `buildDatabaseInput` to name every member
  of `TargetDatabase` / `FederatedDatabase` / `CreateTableDefaultPermissions`
  individually instead of casting the blocks through verbatim. The other six
  Glue targets stay key-pass-only, their forced-on residuals having been
  verified false positives.
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
  (issue #1520 — the structural half split out of #1495, whose silent-drop half
  is fixed), where its effect on the LITERAL set can be measured on the target
  it affects. A `readCurrentState*`-named helper nested in a builder's
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
     hand-off wildcard is one of the 18 legitimate blob members (6
     `CorsConfiguration.*` + 5 `DefaultRouteSettings.*` + 2
     `JwtConfiguration.*` + 2 `AccessLogSettings.*` + 1 `RequestParameters.*`,
     plus `TlsConfig.*` and `ResponseParameters.*` from the issue #609
     `::Integration` backfill), none by a stray root. The count was 13 when
     this was first measured and moved with each of the two #609 batches —
     re-measure it rather than trusting the number. Suppression follows a
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
  6. **The SPREAD-AND-PATCH forwarder is CLOSED by issue
     [#1475](https://github.com/go-to-k/cdkd/issues/1475)** (it sat here as the
     last unrecognized shape; the BUILDER idiom beside it was closed by issue
     [#1474](https://github.com/go-to-k/cdkd/issues/1474) — see the builder
     bullet above, bounds under known bound (8)). A literal spreading a
     BAG-DERIVED seed (`const result = { ...config }`) inside an otherwise
     member-naming function registers a hand-off at its write path, BOUNDED by
     the keys the function `delete`s off the binding (resolved through the
     `Object.entries(TABLE)` / literal-array loop shapes; an unresolvable
     delete key refuses the whole registration, fail-closed) — which is what
     opted `AWS::CloudFront::Distribution` in at 0 findings (162 -> 0, two
     `Tags.*` paths allow-listed as written one SDK wrapper level below the
     CFn chain). What it deliberately does NOT exclude is known bound (9) in
     the script header: an OVERWRITTEN member stays credited through the
     spread, and the spread delivers the seed's spelling verbatim.
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
- **Naming a CFn key's literal is no longer enough to clear the key pass on a
  write-evidence target (issue #1393 item 2).** A key with no same-spelled SDK
  member needs the literal PLUS scoped delivery proof: a genuine SDK member
  written at the resolved parent chain whose case-folded name equals the key,
  or a `terminalRenames` entry that resolves on the write side. When a
  conversion is real but invisible to the write walk (a computed-key rename
  loop, a destructured helper return), declare a `passes: ['key']` allow-list
  entry with the write site named in the rationale — do NOT scatter decoy
  literals to appease the critic.
