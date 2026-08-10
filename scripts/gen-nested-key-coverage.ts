/**
 * Codegen + CI critic: nested CFn->SDK key-divergence coverage matrix.
 *
 * THE GAP THIS CLOSES (issue #1373)
 * ---------------------------------
 * The AWS SDK v3 serializer silently drops unknown keys, so any SDK provider
 * that forwards a nested CFn config blob converts key spellings by hand — and
 * every key the conversion misses is a WRITE-SIDE SILENT DROP that no existing
 * check catches. The pre-flight `property-coverage` check compares TOP-LEVEL
 * property names only, so a handled blob like `DistributionConfig` passes
 * while its interior diverges.
 *
 * The class has recurred at least 4 times, each found by a live failure or a
 * live template read rather than by tooling:
 *   - ECS nested-object casing (#1165 / #1167)
 *   - API Gateway v2 (#1160 family)
 *   - CloudWatch AnomalyDetector `MetricTimeZone` -> `MetricTimezone` (#1304)
 *   - CloudFront Distribution, FIVE keys (#1370 / PR #1372), two of which sat
 *     in an already-"fixed" provider invisible to review
 * This critic makes the key-spelling bucket of the class non-regressing.
 *
 * HOW THE ANALYSIS WORKS
 * ----------------------
 * For each declared TARGET (a provider that forwards nested CFn config):
 *   1. CFn side: the schema fixture's `nestedProperties` capture
 *      (tests/fixtures/cfn-schemas/<type>.json, refreshed by
 *      `node scripts/refresh-cfn-schemas.mjs`) lists every nested property
 *      name reachable beneath each top-level property. Only the provider's
 *      OWN `handledProperties` top-levels are audited — unhandled top-levels
 *      are already rejected pre-flight by `property-coverage`. The audited
 *      unit is the PATH `TopLevelProperty.NestedKey` (issue #1448), not a
 *      de-duplicated bare name: `ServiceRole` beneath `BuildBatchConfig` and
 *      `ServiceRole` beneath anything else are different facts.
 *   2. SDK side: every property name declared in the SDK client's model
 *      typings (`node_modules/@aws-sdk/client-<svc>/dist-types/models/`),
 *      parsed via the TypeScript Compiler API.
 *   3. Provider side: every string literal in the provider source (AST-level,
 *      so comments do not count), excluding the reverse map's body
 *      ({@link REVERSE_MAP_FUNCTION_PREFIXES}). A key the provider names
 *      explicitly on the FORWARD path is evidence it converts / special-cases
 *      that key somewhere.
 *
 * A CFn nested key is a FLAGGED divergence when its spelling (after the
 * target's declared key style — `exact` for PascalCase SDK models like
 * CloudFront / CloudWatch / API GW v2, `lower-first` for camelCase models
 * like ECS) matches NO SDK member AND the provider source never names it.
 * Two flagged buckets, both CI-blocking:
 *   - case-divergence — a case-insensitive SDK match exists (`AcmCertificateArn`
 *     vs `ACMCertificateArn`). The highest-signal bucket: it would have caught
 *     all five CloudFront keys' class plus `MetricTimeZone`.
 *   - no-sdk-member  — no SDK member matches at all (`IPV6Enabled`, whose SDK
 *     member is `IsIPV6Enabled`).
 * An allow-list records deliberate pass-throughs with a one-line rationale.
 *
 * THE SHAPE PASS (issue #1378)
 * ----------------------------
 * Shape-level divergences share a spelling with a real SDK member, so the
 * key pass cannot see them. A second pass over the fixtures'
 * `definitionShapes` capture (per-definition member -> terminal type kind)
 * audits two such classes, both CI-blocking when neither provider-named nor
 * allow-listed:
 *   - array-vs-wrapper          — CFn declares a bare array where every
 *     same-spelled SDK member is a `{Quantity, Items}` wrapper reference
 *     (the CloudFront idiom). Mechanizes the previously hand-maintained
 *     QUANTITY_ITEM_FIELDS class: a NEW array member AWS adds to
 *     DistributionConfig now flags until the provider wraps it.
 *   - definition-member-missing — a CFn definition's member that same-spells
 *     an SDK member SOMEWHERE but is missing from the same-named SDK
 *     interface (renamed or relocated — `CachedMethods` sibling-vs-nested,
 *     `GeoRestriction.Locations`, the legacy `S3Origin`).
 * Provider evidence for shapes is the DOT-SEGMENT-EXPANDED literal set (the
 * `'ForwardedValues.Headers'` path idiom names both segments); the key pass
 * keeps the strict, unexpanded set. Members with no same-spelled SDK member
 * anywhere stay the key pass's domain — the passes never double-report a
 * key-reachability finding as a shape finding. CFn definitions with no
 * same-named SDK interface are skipped and surfaced as a visible count.
 *
 * THE WRITE-EVIDENCE PASS (issue #1432)
 * -------------------------------------
 * `same-spelling` is the critic's silent bucket: the SDK model has a member at
 * the derived spelling, so nothing is reported. That is sound for a provider
 * that FORWARDS a config blob (the serializer carries the key through), and
 * UNSOUND for one that builds a FRESH SDK object naming each member — an
 * unnamed sub-key is dropped even though the spelling matches perfectly.
 *
 * `AWS::CodeBuild::Project` `BuildBatchConfig.BatchReportMode` is the measured
 * case (#1386 / #1432): CFn declares it, `@aws-sdk/client-codebuild` declares
 * `batchReportMode`, and `CodeBuildProvider.mapProperties` rebuilt
 * `buildBatchConfig` naming only four of the five members. The key pass
 * classified it `same-spelling` and stayed silent — and STILL did with every
 * occurrence of `batchReportMode` renamed away, which is what proved the gap
 * structural rather than a tuning miss.
 *
 * So for a target that declares {@link NestedKeyTarget.freshObjectMapper}, a
 * would-be `same-spelling` key must ALSO carry WRITE evidence: its SDK-side
 * spelling must appear as a WRITTEN member name — an object-literal property
 * (`batchReportMode: ...`), a shorthand property, an assignment target
 * (`sdk.batchReportMode = ...` / `sdk['batchReportMode'] = ...`, including the
 * compound `??=` / `||=` / `+=` forms), or an
 * `Object.defineProperty(sdk, 'batchReportMode', ...)` call. Otherwise it lands
 * in the CI-blocking `no-write-evidence` bucket.
 *
 * A literal built only to be DIFFED is not delivery: an object whose only
 * consumer is a comparison or a measurement
 * (`JSON.stringify({ batchReportMode: x }) !== JSON.stringify(prev)`, the
 * change-detection idiom of a diff-heavy `update()`) names its members without
 * sending any of them, so it contributes no evidence. The sibling critic
 * `gen-handled-property-wiring` encodes the same rule on the READ side; this is
 * its write-side twin ({@link feedsOnlyComparison}).
 *
 * READS DO NOT COUNT, AND `readCurrentState` IS EXCLUDED
 * ------------------------------------------------------
 * Requiring a WRITE rather than a mention is what scopes evidence to the
 * mapping direction: `readCurrentState`'s reverse map READS the SDK member
 * (`result['BatchReportMode'] = desc.batchReportMode`), and a read is not a
 * property-assignment name, so it cannot vouch for the write side.
 *
 * That is not sufficient on its own for an `exact`-style target, where the CFn
 * and SDK spellings are identical: there the reverse map's CFn-spelled WRITE
 * (`result['CorsConfiguration'] = ...`) WOULD vouch for the forward mapper.
 * That is #1393 item 2 — the file-global heuristic clearing a genuine
 * divergence — reappearing one bucket over, so the collector skips the bodies
 * of {@link REVERSE_MAP_FUNCTION_PREFIXES}. Measured on the real
 * tree, the exclusion withdraws 8 names from `s3-bucket-provider.ts`
 * (`BucketName`, `BucketEncryption`, `CorsConfiguration`, `LoggingConfiguration`
 * and the four `*Configurations` plurals), 71 from `codebuild-provider.ts`, and
 * 42 from `ecs-provider.ts` (via `readCurrentStateService` /
 * `readCurrentStateTaskDefinition`, which only the PREFIX match reaches) —
 * exactly the names a reverse map invents.
 *
 * THE WHOLE-BLOB HAND-OFF WALK (issue #1445)
 * ------------------------------------------
 * The pass's largest blind spot was a provider that hands a whole sub-blob to a
 * GENERIC KEY CONVERTER: one call delivers every member under it and there is
 * no per-member write to find. `ECSProvider.convertLinuxParameters` is the
 * clean demonstration —
 *
 *     private convertLinuxParameters(config?: Record<string, unknown>) {
 *       if (!config) return undefined;
 *       return pascalToCamelCaseKeys(config) as LinuxParameters;
 *     }
 *
 * — which delivers `Capabilities` / `Devices` / `Tmpfs` / `Swappiness` /
 * `MaxSwap` / `SharedMemorySize` / `InitProcessEnabled` and everything beneath
 * them, all correctly wired and all invisible to a per-member write search.
 *
 * {@link collectWriteEvidence} now follows that hand-off, in the three steps the
 * #1404 taint walk uses one level up:
 *   SEED      — a value read off the DESIRED property bag
 *               ({@link HANDOFF_BAG_PARAM_NAMES}, declaration-scoped taint, so a
 *               config read back off `GetDistributionConfig` is NOT a seed).
 *   PROPAGATE — the seed handed WHOLE to a callee, through `?:` / `??` / `||`
 *               arms, `const` bindings, spread-only literals, and `this.f(…)` /
 *               free-function / SIBLING-MODULE calls (`pascalToCamelCaseKeys`
 *               lives in `agentcore-case-convert.ts`, so cross-module
 *               resolution is load-bearing, not a nicety).
 *   DELIVERY  — the callee RETURNS the blob rather than measuring it, and the
 *               value is WRITTEN. A converted blob whose only consumer is a
 *               diff is refused by the same {@link feedsOnlyComparison} rule
 *               the literal walk uses.
 *
 * GENERIC vs SPECIFIC is the whole job, and the test is deliberately crude: a
 * callee is generic only when it NAMES NO MEMBER — no object-literal property
 * (including the computed-but-literal `{ ['Foo']: v }`), no shorthand, no
 * `o.Foo = …` / `o['Foo'] = …` — anywhere in its body OR in any callee it can
 * reach. `pascalToCamelCaseKeys` qualifies (its only write is the computed
 * `result[camelKey] = …`); `convertContainerDefinitions` (45 named members),
 * `convertLoadBalancers` (4) and `CloudFrontDistributionProvider.convertToSdkFormat`
 * (a spread-and-patch naming 30+) do not, and every member under THEM keeps
 * having to prove itself write by write.
 *
 * The TRANSITIVE part is load-bearing, not tidiness. With a body-local test the
 * DELEGATING GUARD `convertLog(cfg) { if (!cfg) return cfg; return this.buildLog(cfg); }`
 * passes — `convertLog` names nothing, and the delivery test is existential, so
 * the `return cfg` arm alone satisfies it — while `buildLog` does the real,
 * member-naming work. That is a silent clear on a CI-blocking bucket, so
 * {@link namesOwnMember} descends into resolvable callees. (The delivery test
 * cannot be tightened to `.every` as the alternative fix:
 * `pascalToCamelCaseKeys` returns `result`, a binding to an empty literal, so
 * requiring every return to deliver rejects the tree's one real converter.)
 *
 * Read the test as exactly what it says — "names no member" — and NOT as "can
 * only emit keys it read". A converter that names nothing and still drops or
 * renames keys passes; see known bound (5).
 *
 * The credit is then bounded to the blob: {@link expandGenericHandoffScopes}
 * expands each hand-off point through the SDK model's own reference graph
 * ({@link reachableSdkMemberNames}), so `linuxParameters` credits exactly the
 * members of `LinuxParameters` and its descendants. Crediting the whole
 * ENCLOSING scope instead would have been the rubber stamp: `ContainerDefinitions`
 * carries both that hand-off AND `convertPortMappings`, whose missing
 * `containerPortRange` is a REAL silent drop the walk must keep reporting.
 *
 * WHY THE PASS IS OPT-IN PER TARGET, AND WHICH TARGETS ARE IN
 * -----------------------------------------------------------
 * Measured against the real tree. Counts are would-be `same-spelling` key PATHS
 * with no scoped write evidence, BEFORE the hand-off walk (the #1448 numbers)
 * and AFTER it:
 *
 *   target                             before   after   status
 *   AWS::CodeBuild::Project             0 / 90   0 / 90  opted in (#1432)
 *   AWS::ApiGatewayV2::Api              6 /  6   0 /  6  OPTED IN (#1445)
 *   AWS::ApiGatewayV2::Stage            5 /  5   0 /  5  OPTED IN (#1445)
 *   AWS::ApiGatewayV2::Authorizer       2 /  2   0 /  2  OPTED IN (#1445)
 *   AWS::ApiGatewayV2::Integration      0 /  0   0 /  0  OPTED IN (#1445)
 *   AWS::ApiGatewayV2::Route            0 /  0   0 /  0  OPTED IN (#1445)
 *   AWS::ECS::TaskDefinition           25 / 115  0 / 115 OPTED IN (#1472)
 *   AWS::ECS::Service                  44 /  54  0 /  54 OPTED IN (#1473)
 *   AWS::CloudWatch::AnomalyDetector   29 /  29  3 /  29 out — see (B)
 *   AWS::S3::Bucket                   106 / 125 104 / 125 out — see (B)/(C)
 *   AWS::CloudFront::Distribution     110 / 112 110 / 112 out — see (D)
 *                                     -------   -------
 *                                        327      217
 *
 * The RECORDED, MEASURED reasons the remaining targets cannot opt in — none
 * of them "add an allow-list entry", which is what the issue forbids:
 *
 * (A) [RESOLVED by issues #1472 / #1473] ECS's six residuals were REAL SILENT
 *     DROPS found BY this walk: `ContainerDefinitions.ContainerPortRange` (SDK
 *     `PortMapping.containerPortRange`, which `convertPortMappings` never
 *     wrote) and `LoadBalancers.{AdvancedConfiguration, AlternateTargetGroupArn,
 *     ProductionListenerRule, RoleArn, TestListenerRule}` (SDK
 *     `LoadBalancer.advancedConfiguration` and its members — the blue/green
 *     deployment block `convertLoadBalancers` never converted). Both are now
 *     written by the provider (the port range explicitly, the blue/green block
 *     via the shared `pascalToCamelCaseKeys` hand-off), so both ECS targets
 *     measure 0 and are opted in. The pre-fix counts stay in the table as the
 *     record that the walk, not a hand audit, surfaced them (44 unmeasurable
 *     paths collapsed to 5 real ones on Service, 25 to 1 on TaskDefinition).
 *
 * (B) The BUILDER IDIOM (`const out: any = {}; out.Foo = …; return out;`) is a
 *     per-member write the SCOPE index cannot see: `resolveLiterals` resolves
 *     the identifier to the EMPTY literal it was declared with, and the later
 *     `out.Foo = …` assignments are property-access writes no literal walk
 *     visits. `CloudWatchAnomalyDetectorProvider.buildPutParams` builds
 *     `Configuration` exactly that way, which is all three of its residuals
 *     (`ExcludedTimeRanges` / `StartTime` / `EndTime` ARE written, just not
 *     where the scope index looks), and `S3BucketProvider` uses it in
 *     `applyWebsiteConfiguration` / `applyObjectLockConfiguration` /
 *     `applyReplicationConfiguration`. This is a DIFFERENT mechanism from the
 *     hand-off — per-member writes in the wrong place, not a blob with no writes
 *     at all — so it is tracked separately in issue #1474 rather than folded in
 *     here.
 *
 * (C) S3's remainder past (B) is genuine per-member re-shaping across a dozen
 *     `apply*Configuration` helpers, each of which names members and therefore
 *     has to keep proving them. It is not measurable as "N confirmed drops"
 *     until (B) lands and the residual is re-measured.
 *
 * (D) `CloudFrontDistributionProvider.convertToSdkFormat` is a SPREAD-AND-PATCH
 *     forwarder: `const result = { ...config }` delivers every member, then ~30
 *     named patches rename / wrap specific keys. The genericity test rejects it
 *     on those names — correctly, by its own rule — so all 110 stay
 *     unmeasurable. Recognizing "a spread of the SEED inside an otherwise
 *     member-naming function" is a third recognizer, tracked in issue #1475.
 *     Deliberately not done here: it is the shape most likely to become a rubber
 *     stamp, since it would credit 110 of 112 paths in one step.
 *
 * The counts under (B) / (C) / (D) remain UNMEASURABLE rather than vouched-for —
 * not a list of 217 confirmed silent drops, and not a clean bill of health.
 *
 * WRITE EVIDENCE IS PATH-SCOPED (issue #1448)
 * -------------------------------------------
 * As shipped in #1432 the evidence was a flat set of names for the whole
 * provider FILE, so a member written ANYWHERE vouched for every CFn key with
 * that spelling. Measured on `codebuild-provider.ts` at the time: 11 of the 55
 * same-spelling keys had more than one write site — `Type` (9), `Location` (5),
 * `Name` (5), `ComputeType`, `EncryptionDisabled`, `SecurityGroupIds`,
 * `ServiceRole`, `SourceIdentifier`, `SourceVersion`, `Status`, `Value` (2
 * each) — so deleting the forward write of any ONE of them stayed silent, and
 * the pass really only fenced the 44 uniquely-named members.
 *
 * `BuildBatchConfig.ServiceRole` was the sharpest case: the SIBLING of the
 * member that motivated #1432, cleared by the unrelated top-level
 * `serviceRole:` write.
 *
 * The root cause was the flat KEY model, not the pass, so both sides moved:
 *   - CFn side — the audited unit is now the PATH `Top.NestedKey`
 *     ({@link nestedKeyPathsForTarget}), so top-level `ServiceRole` and
 *     `BuildBatchConfig.ServiceRole` stop being the same audited key.
 *   - Provider side — {@link collectWriteEvidence} indexes each written member
 *     name to every member written BENEATH the value it is written with,
 *     resolving `this.mapSource(source)` calls, `const`/`let` bindings, `?:` /
 *     `??` arms, array elements and `.map(cb)` callbacks the way the #1404 taint
 *     walk resolves its forwards. `buildBatchConfig` therefore scopes to exactly
 *     the seven members of the literal it is assigned.
 *
 * A path's terminal member is checked against the scope its TOP-LEVEL maps to.
 * Deleting `serviceRole:` from the `buildBatchConfig` literal of the real
 * provider now exits 1 naming `BuildBatchConfig.ServiceRole` (asserted by a
 * spawned `--check` against a scratch copy of the real tree), while the
 * name-global set still contains `serviceRole` — which is what makes the fix
 * measurable rather than asserted.
 *
 * WHAT PATH-SCOPING AND THE HAND-OFF WALK DO **NOT** CLOSE — MEASURED, NOT PREDICTED
 * -----------------------------------------------------------------------------------
 * Bounds (1) and (2) below are tracked in issue #1464 (they need a per-PATH
 * fixture capture, not a critic change); (3) / (4) / (5) / (6) / (7) are
 * recorded, not tracked. The provider-shape blind spots the hand-off walk does
 * NOT recognize (builder idiom, spread-and-patch) are separate and are recorded
 * with their counts in the opt-in section above, under (B) and (D).
 *
 * Scoping NARROWS the duplicate-name class; it does not close it. Read this
 * before writing "membership makes X non-regressing" anywhere: the bullet
 * #1448 replaced made exactly that over-promise one level up, and the same
 * mistake is available one level down.
 *
 * (1) DUPLICATE NAME INSIDE THE SAME TOP-LEVEL still vouches. The fixture's
 *     `nestedProperties` capture is FLATTENED per top-level, so
 *     `Environment.Type` and `Environment.EnvironmentVariables[].Type` are the
 *     SAME audited path, and the scope index is flattened to match. Both of
 *     these are real, and both stay silent on the only opted-in target —
 *     verified by deleting the line from a scratch copy of the real
 *     `codebuild-provider.ts` and running `--check`:
 *       - `environment: { type: … }` deleted -> exit 0, because
 *         `environmentVariables[].type` is also under `environment`.
 *       - `source: { type: … }` deleted (in `mapSource`) -> exit 0, because
 *         `auth.type` is also under `source`.
 *     Both are genuine silent drops. Closing this needs a per-PATH fixture
 *     capture (`nestedPropertyPaths` in `scripts/refresh-cfn-schemas.mjs` plus
 *     an AWS re-capture of every fixture), which is a bigger change than the
 *     critic and is NOT done here.
 *
 * (2) SCOPES ARE KEYED BY NAME AND UNIONED ACROSS WRITE SITES. `record()` merges
 *     every write of the same member name, so two unrelated `environment: { … }`
 *     literals in different methods contribute to one `environment` scope, and a
 *     write that only ever appears NESTED (`logsConfig: { cloudWatchLogs: { … } }`)
 *     still creates a top-level-looking `cloudWatchLogs` scope. This is the
 *     name-global weakness reappearing one level down. Keeping per-SITE sets
 *     would not help the positive test (a key is cleared if ANY site covers it,
 *     which is the union), so the honest fix is the same per-path capture as (1).
 *
 *     HAND-OFF POINTS ARE UNIONED THE SAME WAY (issue #1445), and it is
 *     measurable: `ApiGatewayV2Provider` forwards `DefaultRouteSettings` whole
 *     at TWO sites (create and update). Deleting only the create-side forward
 *     from a scratch copy of the real provider exits **0** — the update-side
 *     forward still vouches — and deleting BOTH exits 1 naming all five
 *     `DefaultRouteSettings.*` paths. A provider that stops forwarding on ONE
 *     path is therefore not fenced.
 *
 * (3) VALUE RESOLUTION IS BEST-EFFORT AND BARE-NAME. Same-file callables and
 *     property initializers are indexed by NAME, so `this.mapSource(…)` and a
 *     free `mapSource(…)` resolve to the same declaration (a `receiver.mapSource(…)`
 *     on some OTHER object deliberately does not — that would be a false clear
 *     on a CI-blocking bucket). Identifier bindings are searched in the nearest
 *     function scope, which is descended FULLY — so two disjoint `if` branches
 *     binding the same name are unioned — and then OUTWARD without descending
 *     into sibling functions, with a PARAMETER of the nearest scope stopping the
 *     climb entirely. And a hop the walk cannot follow yields NO literals, which
 *     flags CORRECT code; that direction is the dangerous one, which is why
 *     {@link unwrapExpression} peels `await` and the climb reaches module
 *     scope at all.
 *
 * (4) THE REVERSE-MAP EXCLUSION IS PREFIX-ONLY. A reverse SDK->CFn helper named
 *     by SUFFIX rather than prefix — `ecs-provider.ts`'s `volumesToCfn` /
 *     `containerDefinitionsToCfn`, `s3-bucket-provider.ts`'s `metricsSdkToCfn`
 *     — is NOT skipped by {@link REVERSE_MAP_FUNCTION_PREFIXES}, so its
 *     CFn-spelled writes land in the evidence. No live impact: the only opted-in
 *     target keeps its whole reverse map inside `readCurrentState`, and the
 *     suffix providers are not opted in. Widening the match is deliberately NOT
 *     done here — it would withdraw names from the LITERAL set too (the
 *     `provider-handled` bucket) on targets nobody has measured for it.
 *
 * (5) THE GENERICITY TEST IS "NAMES NO MEMBER", NOT "PRESERVES EVERY KEY"
 *     (issue #1445). It is TRANSITIVE through resolvable callees, which closes
 *     the delegating guard described above — but three shapes name nothing and
 *     still fail to deliver everything, and all three would be credited:
 *       - FILTERING — `for (const [k, v] of entries) { if (DROP.has(k)) continue; out[k] = v; }`
 *       - RENAME-MAP — `out[MAP[k] ?? k] = v` (a key the map renames to an SDK
 *         spelling the CFn side never had still counts as delivered)
 *       - PICK — `for (const k of KEEP) out[k] = blob[k]`
 *     NO such shape is a hand-off callee in the tree today, so this is a bound
 *     rather than a live false clear — but it is one edit away:
 *     `glue-provider.ts`'s `renameRecordKeys(entry, renames, numericKeys, booleanKeys)`
 *     is exactly the rename-map shape (all writes computed, zero member names),
 *     and it would be credited the moment a Glue target opted in. Closing it
 *     needs the walk to model the converter's KEY SET, not just its member
 *     names — a materially bigger analysis than this one.
 *     The two SAFE directions are also crude and are left that way:
 *     `{ ...blob, Extra: 1 }` DOES deliver `blob` but is rejected for naming
 *     `Extra` (the target keeps flagging, visibly), and a helper that names
 *     nothing but returns a SCALAR (`toDate(r['EndTime'])`) is accepted as a
 *     converter but is inert, because a scalar expands to NOTHING in
 *     {@link reachableSdkMemberNames} and so credits only a name that was
 *     already a recorded write.
 *
 * (6) THE SDK EXPANSION IS BARE-NAME AND UNIONED. `reachableSdkMemberNames`
 *     looks the hand-off point up as a member name across EVERY interface in the
 *     client model and unions the reference targets, so two unrelated interfaces
 *     declaring the same member name expand together — and the result can be
 *     enormous: `Items` reaches 217 members in the CloudFront model, and `Items`
 *     IS a registered hand-off point there.
 *
 *     What bounds that is NOT the expansion and NOT "only a handed-off name is
 *     expanded" — it is {@link classifyTarget} looking a scope up only by the
 *     audited path's CFn TOP-LEVEL property name. An over-broad expansion hung
 *     off `Items` is never consulted, because no audited top-level is called
 *     `Items`. A hand-off point whose name DOES collide with an audited
 *     top-level is the case to watch.
 *
 *     The point is registered under the WRITE name and ALSO under the SEED's own
 *     CFn key (in both spellings), because the two disagree often enough to
 *     matter: `ECSProvider` writes `placementStrategy` for CFn's
 *     `PlacementStrategies`, and keying only by the write name left
 *     `PlacementStrategies.Type` / `.Field` with no scope at all.
 *
 * (7) CROSS-MODULE RESOLUTION IS SAME-DIRECTORY ONLY. The hand-off walk reads a
 *     sibling module (`./agentcore-case-convert.js`) so the tree's one real
 *     generic converter is resolvable; a package import, a parent-directory
 *     path, a namespace import and a re-export are all unresolvable and
 *     therefore NOT credited. The imported module's own body is also not
 *     taint-propagated — only its parameters are, from the calls seen in the
 *     provider file — which is sufficient for a converter whose first guard arm
 *     returns the parameter outright and insufficient for one that only returns
 *     through its own recursion.
 *
 * Each of (1) and (2) is pinned by a test, so the bound is a recorded fact
 * rather than a surprise for the next reader.
 *
 * WHAT THE CRITIC STILL DOES NOT DO
 * ---------------------------------
 * The "provider names the key" test is deliberately loose — a literal
 * mentioned for an unrelated reason counts as handled (false-negative
 * direction; the matrix keeps every verdict visible for review). Scalar
 * type-kind mismatches (string-vs-number) are not audited — providers
 * coerce per key and the SDK serializer tolerates most of them.
 *
 * OFFLINE-ONLY (NO AWS)
 * ---------------------
 * Reads fixtures + provider sources + installed SDK typings. Writes
 * `docs/_generated/nested-key-coverage.{json,md}`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-nested-key-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-nested-key-coverage.ts --check  # fail on a divergence
 *   node --experimental-strip-types scripts/gen-nested-key-coverage.ts --help   # usage
 *
 * Any unrecognized flag (and any positional argument) is REJECTED with usage on
 * stderr and exit 1, the same guard `refresh-cfn-schemas.mjs` carries: without
 * it a typo like `--chekc` falls through to the WRITER path, rewriting the
 * committed matrix and exiting 0.
 *
 * `--providers-dir=<path>` is a TEST SEAM (issue #1448): it points the provider
 * walk at a scratch COPY of `src/provisioning/providers`, so the unit tests can
 * inject a regression into REAL provider source and assert the shipped exit
 * code — the repo's checker rule that a CI-blocking fence must be proven to
 * fire against real code, not only against synthetic fixtures.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 — TS7 no longer ships the
// stable JS compiler API (see the note in gen-property-coverage.ts).
import ts from 'typescript-v6';
// Same-directory `.ts` import: Node 24 native type-stripping resolves imports
// literally when run via `node scripts/gen-nested-key-coverage.ts`.
import { parseProviderSource } from './gen-property-coverage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/nested-key-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/nested-key-coverage.md');

/**
 * Parser-regression floor for the SDK side: a client model parse that
 * collapses below this member count fails LOUDLY in both write and check mode
 * instead of producing a vacuously green matrix (per the repo's checker rules
 * — a checker must not be able to pass because its input parser broke). Every
 * audited SDK client model declares hundreds of members, so this floor is far
 * below any legitimate value. The CFn-side floor is per-target
 * ({@link NestedKeyTarget.minNestedKeys}) because legitimate counts range
 * from 119 (CloudFront `DistributionConfig`) down to 0 (API GW v2
 * `Integration`, whose handled top-levels are scalars and free-form maps).
 */
export const MIN_SDK_MEMBERS_PER_CLIENT = 50;

/**
 * Parser-regression floor for the WRITE-EVIDENCE collector (issue #1432),
 * applied only to targets that opt into the pass. It exists to turn a COLLAPSED
 * parse into one legible error instead of 55 bogus divergences, so it is
 * deliberately set below the smallest legitimate yield rather than near the
 * current one.
 *
 * Measured yields after the reverse-map exclusion:
 * `ecs-provider.ts` 231, `s3-bucket-provider.ts` 160, `codebuild-provider.ts`
 * 82 (the only opted-in target today), `apigatewayv2-provider.ts` 46,
 * `cloudfront-distribution-provider.ts` 64,
 * `cloudwatch-anomaly-detector-provider.ts` **17**. That last one is why the
 * DEFAULT is 10 rather than a value tuned to CodeBuild: a floor of 30 would
 * throw "parser regression?" on a perfectly correct parse the moment the
 * smallest provider opts in (#1445). Each opted-in target then tightens it with
 * {@link NestedKeyTarget.minWrittenMembers}, mirroring
 * {@link NestedKeyTarget.minNestedKeys} — issue #1448.
 */
export const MIN_WRITTEN_MEMBERS_PER_PROVIDER = 10;

/**
 * How a target's CFn nested key spelling maps onto its SDK model spelling
 * when the two agree:
 *   - exact       — the SDK model uses CFn-style PascalCase (CloudFront,
 *                   CloudWatch, API Gateway v2): an unconverted key must match
 *                   an SDK member verbatim.
 *   - lower-first — the SDK model is camelCase (ECS): providers convert
 *                   PascalCase->camelCase per key, so the "same spelling"
 *                   test lowercases the first character before matching.
 */
export type KeyStyle = 'exact' | 'lower-first';

export interface NestedKeyTarget {
  /** CFn resource type whose nested keys are audited. */
  readonly resourceType: string;
  /** Provider source file (basename under src/provisioning/providers/). */
  readonly providerFile: string;
  /** SDK client package whose model typings define the wire member names. */
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  /**
   * CFn-side parser-regression floor: the MINIMUM nested-key PATH count this
   * target is known to yield. A yield below it means the fixture capture or
   * the provider's `handledProperties` parse regressed — fail loudly rather
   * than report a vacuously clean target. Set from the observed count, rounded
   * down generously (schemas only grow).
   *
   * RE-CALIBRATED to the path unit by #1448 — the audited unit changed from a
   * de-duplicated name to a `Top.Key` path, so every yield grew (CodeBuild
   * 57 -> 93, S3 115 -> 155, CloudWatch AnomalyDetector 21 -> 30) while the
   * floors stayed at their name-era values. Leaving them would have been the
   * same miscalibration this issue fixed on the write side: a floor that no
   * longer fences anything.
   */
  readonly minNestedKeys: number;
  /**
   * Opt into the WRITE-EVIDENCE pass (issue #1432): this provider builds FRESH
   * SDK objects naming each member, so a matching spelling in the SDK model is
   * NOT evidence the value is delivered. See the pass's section in the file
   * header for why this is per-target rather than tree-wide, and #1445 for what
   * the remaining targets need before they can set it.
   */
  readonly freshObjectMapper?: boolean;
  /**
   * Per-target tightening of {@link MIN_WRITTEN_MEMBERS_PER_PROVIDER}. Set from
   * the observed yield at opt-in, rounded down generously. Only meaningful
   * alongside {@link freshObjectMapper}.
   */
  readonly minWrittenMembers?: number;
  /**
   * Parser-regression floor for the write SCOPE index (issue #1448), needed
   * separately from {@link minWrittenMembers} because the two collector outputs
   * regress independently: a break in the VALUE resolution (the
   * `this.mapSource(...)` / binding / `.map(cb)` walk) leaves every write NAME
   * collected and every scope EMPTY, which flags every same-spelling key while
   * the name floor sits comfortably clear.
   *
   * Deliberately per-target with NO module-wide default: measured non-empty
   * scope counts on the real tree span two orders of magnitude
   * (`s3-bucket-provider.ts` 51, `ecs-provider.ts` 34, `codebuild-provider.ts`
   * 23, `cloudfront-distribution-provider.ts` 21,
   * `cloudwatch-anomaly-detector-provider.ts` 2, `apigatewayv2-provider.ts` 1),
   * because a provider that forwards blobs through a generic converter builds
   * almost no scoped literals. Any shared floor high enough to fence CodeBuild
   * would throw "parser regression?" on a perfectly correct parse the moment
   * API Gateway v2 opts in — the miscalibration the #1449 review caught in
   * {@link MIN_WRITTEN_MEMBERS_PER_PROVIDER}. So the target that opts in
   * declares the floor from its own measurement.
   */
  readonly minWriteScopes?: number;
  /**
   * Parser-regression floor for the WHOLE-BLOB HAND-OFF walk (issue #1445):
   * the minimum number of BLOB-CARRYING hand-off points the provider is known
   * to yield — points that expand to at least one SDK member
   * ({@link countExpandingHandoffPoints}). Counting RAW points instead is
   * vacuous; the measured reason is on that function.
   *
   * Declared only by a target whose opt-in DEPENDS on the walk — a target that
   * reaches 0 findings on per-member writes alone (CodeBuild) must NOT declare
   * it, or a genuinely hand-off-free provider would fail its own floor. The
   * hygiene test derives "walk-dependent" by re-classifying with the hand-off
   * points removed, so this stays a measurement rather than a judgement call.
   */
  readonly minHandoffPoints?: number;
}

/**
 * The write-collector floors shared by the five `apigatewayv2-provider.ts`
 * targets (issue #1445). Measured at opt-in: 46 written member names, 1
 * non-empty write scope, 3 BLOB-CARRYING hand-off points (35 raw).
 *
 * `minWriteScopes: 1` FENCES NOTHING on this target and is recorded as such
 * rather than left looking meaningful. The provider forwards whole blobs, so it
 * builds almost no per-member literals, and its single non-empty scope is
 * `attributes` -> `{ ApiId, ApiEndpoint, IntegrationId, RouteId, AuthorizerId }`
 * — a cdkd-internal `ResourceCreateResult` field that no audited path is ever
 * looked up against. The floor exists only because the hygiene test requires
 * every opted-in target to declare it; the value is the honest measurement.
 * (This is exactly the spread {@link NestedKeyTarget.minWriteScopes}'s
 * "no module-wide default" note predicted, now realized.)
 *
 * What actually fences this target is {@link NestedKeyTarget.minHandoffPoints},
 * and it is deliberately 1 against a measured 3 — NOT the usual "round the
 * measurement down". The three points are `CorsConfiguration` /
 * `DefaultRouteSettings` / `JwtConfiguration`, one per audited blob top-level,
 * so a floor AT the measurement makes every legitimate PROVIDER-side change
 * (the provider stops forwarding one blob and starts naming its members) abort
 * with "parser regression?" instead of reporting the divergences that change
 * actually causes. Measured: with the floor at 3, all three hand-off probes
 * stopped reaching the classifier.
 *
 * The failure this floor exists for is the walk COLLAPSING — every write name
 * collected, every scope populated, zero blobs recognized — and that mode
 * yields 0. So 1 is the threshold that discriminates, and the raw-vs-expanding
 * counting change is what makes 1 meaningful: under raw counting the collapsed
 * walk still reported 32 inert scalar points.
 */
const API_GATEWAY_V2_WRITE_FLOORS = {
  minWrittenMembers: 30,
  minWriteScopes: 1,
  minHandoffPoints: 1,
} as const;

/**
 * The audited targets: SDK providers that forward nested CFn config blobs.
 *
 * Start-set per issue #1373 — the four provider families where this bug class
 * has actually fired. When a new provider forwards a nested blob, add it here
 * (the first run then IS the audit of that provider).
 */
export const NESTED_KEY_TARGETS: readonly NestedKeyTarget[] = [
  {
    resourceType: 'AWS::CloudFront::Distribution',
    providerFile: 'cloudfront-distribution-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudfront',
    keyStyle: 'exact',
    minNestedKeys: 110,
  },
  {
    resourceType: 'AWS::CloudWatch::AnomalyDetector',
    providerFile: 'cloudwatch-anomaly-detector-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudwatch',
    keyStyle: 'exact',
    minNestedKeys: 25,
  },
  // The five API Gateway v2 targets opted into the WRITE-EVIDENCE pass with
  // issue #1445, once the whole-blob hand-off walk landed. `ApiGatewayV2Provider`
  // forwards `CorsConfiguration` / `DefaultRouteSettings` / `JwtConfiguration`
  // VERBATIM off the property bag (the CFn and SDK spellings are identical on
  // this service), so all 13 of its would-be `same-spelling` paths were
  // unmeasurable before the walk and measure at 0 findings after it. The floors
  // are per-file and therefore identical across the five.
  {
    resourceType: 'AWS::ApiGatewayV2::Api',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 5,
    freshObjectMapper: true,
    ...API_GATEWAY_V2_WRITE_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Stage',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 5,
    freshObjectMapper: true,
    ...API_GATEWAY_V2_WRITE_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Integration',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 0,
    freshObjectMapper: true,
    ...API_GATEWAY_V2_WRITE_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Route',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 0,
    freshObjectMapper: true,
    ...API_GATEWAY_V2_WRITE_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Authorizer',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 2,
    freshObjectMapper: true,
    ...API_GATEWAY_V2_WRITE_FLOORS,
  },
  {
    // Opted in by issues #1472 / #1473: the two REAL silent drops the #1445
    // hand-off walk uncovered (PortMappings[].ContainerPortRange and the
    // LoadBalancers[].AdvancedConfiguration blue/green block) are fixed in
    // the provider, so both ECS targets measure 0 no-write-evidence — see
    // the header table.
    resourceType: 'AWS::ECS::Service',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 45,
    freshObjectMapper: true,
    // Measured on opt-in (#1472/#1473): written 233, non-empty scopes 34,
    // expanding hand-off points 21 (the LinuxParameters-family generic
    // conversions both ECS targets clear through).
    minWrittenMembers: 120,
    minWriteScopes: 25,
    minHandoffPoints: 10,
  },
  {
    // Opted in by issue #1472 alongside AWS::ECS::Service above (same
    // provider file, same measured yields).
    resourceType: 'AWS::ECS::TaskDefinition',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 105,
    freshObjectMapper: true,
    minWrittenMembers: 120,
    minWriteScopes: 25,
    minHandoffPoints: 10,
  },
  {
    // Added by issue #1386. The provider rebuilds Source / Environment / Cache /
    // BuildBatchConfig as FRESH SDK objects, which is exactly the forwarding
    // shape this critic exists to audit. Bringing it under the critic is the
    // durable form of that fix: the hand sweep for #1386 still missed
    // `BuildBatchConfig.BatchReportMode`, which this pass catches mechanically.
    resourceType: 'AWS::CodeBuild::Project',
    providerFile: 'codebuild-provider.ts',
    sdkClientPackage: '@aws-sdk/client-codebuild',
    keyStyle: 'lower-first',
    minNestedKeys: 80,
    // Issue #1432: the fresh-object shape this target was added FOR is exactly
    // the one `same-spelling` cannot vouch for, and the #1386 sweep still
    // missed `BuildBatchConfig.BatchReportMode` under it. Measured at 0
    // findings today (55 same-spelling keys, all hand-named), so the opt-in
    // costs no allow-list entries and makes that fix non-regressing. Still 0
    // after #1448 made the evidence PATH-SCOPED (90 same-spelling paths).
    freshObjectMapper: true,
    // Measured: 82 written member names, 23 non-empty write scopes.
    minWrittenMembers: 60,
    minWriteScopes: 15,
  },
  {
    // Added by issue #1430. `S3BucketProvider` declares a dozen nested config
    // blobs (lifecycle, CORS, replication, notifications, encryption,
    // inventory, analytics, metrics, intelligent-tiering, object-lock,
    // website routing) in `handledProperties` and re-shapes each for the SDK —
    // the forwarding shape this critic exists to audit. It was NOT a target
    // when the #1388 / #1424 lifecycle defects were fixed by hand in PR #1426.
    //
    // WHAT THIS TARGET WOULD ACTUALLY HAVE CAUGHT, measured rather than
    // predicted: running this critic against the REAL pre-#1426 provider
    // (`git show 768cd44b^:…/s3-bucket-provider.ts`) flags exactly three
    // lifecycle keys as `no-sdk-member` — `Transition`,
    // `NoncurrentVersionTransition` and `NoncurrentVersionExpirationInDays`,
    // i.e. the LEGACY SINGULAR FORMS defect.
    //
    // Issue #1430 predicted a different three, and it was wrong on all of
    // them. `TagFilters` (16 literal occurrences pre-#1426) and
    // `TransitionInDays` (2) were already named elsewhere in the file — by
    // `readCurrentState`'s reverse map — so the file-global literal heuristic
    // classifies both `provider-handled` no matter how broken the WRITE path
    // is. That is exactly the blind spot tracked as item 2 of #1393, and it is
    // why the strip-probes in the unit test use only single-occurrence keys: a
    // probe that deletes EVERY occurrence of a 16-site literal tests a
    // regression shape that cannot occur. Rule-level `ExpiredObjectDeleteMarker`
    // is not reachable either — the shape pass matches CFn definitions to
    // same-named SDK interfaces, and `@aws-sdk/client-s3` spells it
    // `LifecycleRule`, so CFn's `Rule` sits in `unmatchedDefinitions` and the
    // whole lifecycle-rule blob is shape-unaudited.
    resourceType: 'AWS::S3::Bucket',
    providerFile: 's3-bucket-provider.ts',
    sdkClientPackage: '@aws-sdk/client-s3',
    keyStyle: 'exact',
    minNestedKeys: 140,
  },
];

/**
 * Which pass an allow-list entry is allowed to silence (issue #1448).
 *   - `key`   — the key pass's `case-divergence` / `no-sdk-member` verdicts.
 *   - `shape` — both shape-pass verdicts.
 *   - `write` — the write-evidence pass's `no-write-evidence` verdict.
 */
export type AllowPass = 'key' | 'shape' | 'write';

/**
 * The passes an entry silences when it does not say. Preserves the DELIBERATE
 * #1378 cross-pass sharing between the key and shape passes — every audited
 * failure mode of a key judged pass-through-safe is the same decision.
 *
 * `write` is deliberately NOT in the default. The #1378 decision predates the
 * write-evidence pass, and the two questions are unrelated: "this key is a
 * legacy member with no modern SDK equivalent" says nothing about whether the
 * provider WRITES a member it demonstrably has. Without this split, one entry
 * rationale'd for a SHAPE verdict silently clears a future `no-write-evidence`
 * on the same key — one entry silencing three blocking buckets.
 */
const DEFAULT_ALLOW_PASSES: readonly AllowPass[] = ['key', 'shape'];

export interface AllowListEntry {
  readonly rationale: string;
  /** Defaults to {@link DEFAULT_ALLOW_PASSES}; opt into `write` explicitly. */
  readonly passes?: readonly AllowPass[];
}

/** Does this entry silence `pass`? */
export const allowEntryApplies = (entry: AllowListEntry, pass: AllowPass): boolean =>
  (entry.passes ?? DEFAULT_ALLOW_PASSES).includes(pass);

/** Allow-list key: `ResourceType#NestedKey` via {@link allowKey}. */
export const allowKey = (resourceType: string, nestedKey: string): string =>
  `${resourceType}#${nestedKey}`;

/**
 * Look an entry up for a PATH-shaped audited key (issue #1448). A path-precise
 * entry (`AWS::CodeBuild::Project#BuildBatchConfig.ServiceRole`) wins; a
 * terminal-name entry (`…#ServiceRole`) is the fallback, so the pre-path
 * entries stay valid and one decision can still cover a key reachable beneath
 * several top-levels. Returns the MATCHED key too, so staleness is exact.
 */
export function lookupAllowEntry(
  allowList: ReadonlyMap<string, AllowListEntry>,
  resourceType: string,
  path: string,
  terminalKey: string,
  pass: AllowPass
): { key: string; entry: AllowListEntry } | undefined {
  for (const candidate of path === terminalKey ? [path] : [path, terminalKey]) {
    const key = allowKey(resourceType, candidate);
    const entry = allowList.get(key);
    if (entry !== undefined && allowEntryApplies(entry, pass)) return { key, entry };
  }
  return undefined;
}

/**
 * Deliberate pass-throughs the critic must not fail on. Each entry is a
 * reviewable decision with a one-line rationale, same shape as
 * `UPDATE_WRAP_ALLOW_LIST`. Entries are scoped per (type, key) — an entry
 * for one key can never silence a divergence on a DIFFERENT key of the same
 * type. DELIBERATE cross-pass sharing (issue #1378): one entry silences the
 * key pass AND both shape passes for that key — every audited failure mode
 * of a key the maintainer has judged pass-through-safe (legacy members,
 * dedicated side-channel handling) is the same decision, and a per-pass key
 * would triple the entries for no reviewable difference.
 *
 * The WRITE-EVIDENCE pass is outside that sharing and needs an explicit
 * `passes: ['write', ...]` (issue #1448) — see {@link AllowPass}. Keys are
 * matched path-first, terminal-name-second ({@link lookupAllowEntry}), so an
 * entry can be scoped to one `Top.Key` path or left to cover the key wherever
 * it is reachable.
 */
export const NESTED_KEY_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  [
    allowKey('AWS::CloudFront::Distribution', 'CNAMEs'),
    {
      rationale:
        'Legacy pre-2012 DistributionConfig member (alias of Aliases); the modern ' +
        'CreateDistribution/UpdateDistribution API has no equivalent member and CDK ' +
        'never synthesizes it.',
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'CustomOrigin'),
    {
      rationale:
        'Legacy pre-2012 single-origin form (LegacyCustomOrigin definition); superseded ' +
        'by Origins[] and absent from the modern API. CDK never synthesizes it.',
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'DNSName'),
    {
      rationale:
        'Member of the legacy CustomOrigin / S3Origin blocks only (LegacyCustomOrigin / ' +
        'LegacyS3Origin definitions); unreachable from a modern template.',
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'S3Origin'),
    {
      rationale:
        'Legacy pre-2012 single-origin form (LegacyS3Origin definition), sibling of ' +
        'CustomOrigin; superseded by Origins[]. Invisible to the KEY pass because the ' +
        'StreamingDistribution API still has a same-spelled S3Origin member — the ' +
        'definition pass (issue #1378) is what catches it.',
    },
  ],
  [
    allowKey('AWS::CodeBuild::Project', 'HostKernel'),
    {
      rationale:
        'Declared in the CFn registry schema but has NO member anywhere in the ' +
        'installed @aws-sdk/client-codebuild dist-types tree, so there is nothing to ' +
        'map it onto until an SDK bump adds one (issue #1386). Naming it in the ' +
        'provider would be a false claim of support. Remove this entry once the SDK ' +
        'ships the member, at which point the key becomes genuinely mappable.',
    },
  ],
  // The three S3 Metadata-Tables members below are the FIRST real instance of
  // the unreachable-definition false positive `classifyTargetShapes` documents:
  // the shape pass audits the whole `definitionShapes` map rather than pruning
  // to definitions reachable from the provider's handled top-levels. All three
  // live only under `MetadataConfiguration` / `MetadataTableConfiguration`,
  // which `S3BucketProvider` does NOT declare in `handledProperties` — both are
  // recorded as silent-drop ("not yet implemented by cdkd") in
  // property-coverage, so a template using them is pre-flight-rejected and
  // auto-routed through Cloud Control, which forwards the property map whole.
  // There is therefore no SDK forwarding path that could drop these members.
  // Remove these entries if the provider ever implements those top-levels, at
  // which point the divergence becomes real and must be converted by hand.
  [
    allowKey('AWS::S3::Bucket', 'TableName'),
    {
      rationale:
        'Member of the JournalTableConfiguration / InventoryTableConfiguration definitions, ' +
        'reachable only from the MetadataConfiguration / MetadataTableConfiguration ' +
        'top-levels the provider declares as silent-drop (Cloud-Control-routed), so no ' +
        'SDK forwarding path exists to drop it (issue #1430).',
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'TableArn'),
    {
      rationale:
        'Member of the S3TablesDestination / JournalTableConfiguration / ' +
        'InventoryTableConfiguration definitions, reachable only from the ' +
        'MetadataConfiguration / MetadataTableConfiguration top-levels the provider ' +
        'declares as silent-drop (Cloud-Control-routed), so no SDK forwarding path ' +
        'exists to drop it (issue #1430).',
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'TableNamespace'),
    {
      rationale:
        'Member of the S3TablesDestination definition, reachable only from the ' +
        'MetadataTableConfiguration top-level the provider declares as silent-drop ' +
        '(Cloud-Control-routed), so no SDK forwarding path exists to drop it ' +
        '(issue #1430).',
    },
  ],
]);

export type Bucket =
  | 'same-spelling'
  | 'provider-handled'
  | 'allow-listed'
  | 'case-divergence'
  | 'no-sdk-member'
  /**
   * WRITE-EVIDENCE pass (issue #1432), reachable only for a
   * {@link NestedKeyTarget.freshObjectMapper} target: the SDK model HAS a
   * member at the derived spelling, but the provider never writes it, so a
   * fresh-object mapper drops the value despite the spellings agreeing.
   * BLOCKS CI.
   */
  | 'no-write-evidence';

export interface NestedKeyClassification {
  readonly resourceType: string;
  /**
   * The audited unit: a PATH `TopLevelProperty.NestedKey` (issue #1448). It was
   * a bare de-duplicated NAME through #1432, which made top-level `ServiceRole`
   * and `BuildBatchConfig.ServiceRole` literally the same audited key.
   */
  readonly nestedKey: string;
  /** The path's first segment — the provider-handled top-level property. */
  readonly topLevelProperty: string;
  /** The path's last segment — the CFn member name itself. */
  readonly terminalKey: string;
  readonly bucket: Bucket;
  /**
   * For case-divergence: the SDK member the key case-insensitively matches.
   * For no-write-evidence: the EXACT-match SDK member the provider never
   * writes (issue #1432).
   */
  readonly sdkNearMiss?: string;
  readonly rationale?: string;
  /** For allow-listed: the allow-list key that matched (path or terminal). */
  readonly allowMatchKey?: string;
}

/**
 * SHAPE-pass buckets (issue #1378). Only non-trivial verdicts become entries;
 * shape-clean pairs are counted in the summary, not listed.
 *   - provider-handled           — the provider names the key (dot-segment
 *                                  expanded literals), so the re-shaping is
 *                                  assumed done somewhere.
 *   - allow-listed               — deliberate pass-through with a rationale.
 *   - array-vs-wrapper           — CFn declares a bare array; every same-named
 *                                  SDK member is a `{Quantity, Items}` wrapper
 *                                  reference. Unconverted, the SDK serializer
 *                                  drops the bare array. BLOCKS CI.
 *   - definition-member-missing  — the CFn definition's member same-spells an
 *                                  SDK member SOMEWHERE, but the same-named SDK
 *                                  interface lacks it (renamed or relocated —
 *                                  the CloudFront `CachedMethods`
 *                                  sibling-vs-nested class). BLOCKS CI.
 *   - ambiguous                  — CFn shape is 'mixed' or the SDK side has
 *                                  conflicting kinds; visible, non-blocking.
 */
export type ShapeBucket =
  | 'provider-handled'
  | 'allow-listed'
  | 'array-vs-wrapper'
  | 'definition-member-missing'
  | 'ambiguous';

export interface NestedShapeClassification {
  readonly resourceType: string;
  readonly nestedKey: string;
  /** The CFn definition the verdict came from ('#top' = top-level block). */
  readonly definition: string;
  readonly pass: 'wrapper' | 'definition';
  readonly bucket: ShapeBucket;
  /** Human-oriented detail (e.g. the wrapper interface name). */
  readonly sdkDetail?: string;
  readonly rationale?: string;
  /** For allow-listed: the allow-list key that matched. */
  readonly allowMatchKey?: string;
}

export interface TargetReport {
  readonly resourceType: string;
  readonly providerFile: string;
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  /** Opted into the write-evidence pass (issue #1432). */
  readonly freshObjectMapper: boolean;
  readonly nestedKeyCount: number;
  readonly entries: readonly NestedKeyClassification[];
  /** Shape-pass verdicts (only non-trivial ones — see {@link ShapeBucket}). */
  readonly shapeEntries: readonly NestedShapeClassification[];
  /** CFn array members whose same-named SDK member is a bare array (clean). */
  readonly shapeCleanCount: number;
  /** CFn definitions with no same-named SDK interface (skipped, visible). */
  readonly unmatchedDefinitions: readonly string[];
}

export interface NestedKeyCoverageReport {
  readonly summary: {
    readonly targetCount: number;
    readonly nestedKeyCount: number;
    readonly sameSpelling: number;
    readonly providerHandled: number;
    readonly allowListed: number;
    readonly caseDivergence: number;
    readonly noSdkMember: number;
    readonly noWriteEvidence: number;
    /** Targets opted into the write-evidence pass (issue #1432). */
    readonly freshObjectTargets: number;
    readonly shapeClean: number;
    readonly shapeHandled: number;
    readonly shapeAllowListed: number;
    readonly arrayVsWrapper: number;
    readonly definitionMemberMissing: number;
    readonly shapeAmbiguous: number;
  };
  readonly targets: readonly TargetReport[];
}

/** `AWS::CloudFront::Distribution` -> `AWS-CloudFront-Distribution.json`. */
const fixtureFilename = (type: string): string => type.replace(/::/g, '-') + '.json';

export const lowerFirst = (s: string): string =>
  s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);

/**
 * Collect every property name declared in the SDK client's model typings.
 *
 * The set is deliberately a SUPERSET of the request shapes the provider
 * actually sends (response/summary shapes included): a CFn key matching ANY
 * SDK member spelling is treated as reachable. That is the false-NEGATIVE
 * direction — this critic exists to catch keys with no matching spelling
 * anywhere, which is exactly the silent-drop signature.
 */
export function collectSdkMemberNames(modelsDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(modelsDir).sort()) {
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(modelsDir, file), 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertySignature(node)) {
        if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
          names.add(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return names;
}

/** The declared type kind of one SDK interface member. */
export interface SdkMemberType {
  readonly kind: 'array' | 'ref' | 'scalar';
  /**
   * The referenced type name — for kind 'ref' the member's own type, and for
   * kind 'array' the ELEMENT type when it is a bare reference (`Tmpfs[]` ->
   * `Tmpfs`, `Array<Device>` -> `Device`).
   *
   * The array case was added by issue #1445: {@link reachableSdkMemberNames}
   * walks this graph to enumerate the members beneath a blob handed WHOLE to a
   * generic converter, and `LinuxParameters.tmpfs` / `.devices` are arrays — a
   * ref-only graph would stop at the array edge and leave `ContainerPath` /
   * `MountOptions` / `HostPath` uncredited. The shape pass is unaffected: every
   * one of its `refName` tests is guarded by `kind === 'ref'`.
   */
  readonly refName?: string;
}

/**
 * Collect every INTERFACE in the SDK client's model typings with its members'
 * declared type kinds. `X | undefined` unions are unwrapped; `Y[]` and
 * `Array<Y>` classify 'array' (carrying the element's reference name when it
 * has one); a bare type reference classifies 'ref' with the referenced name;
 * everything else 'scalar'.
 *
 * Consumed by the shape pass: a member whose type is a reference to an
 * interface that itself declares a `Quantity` member is a `{Quantity, Items}`
 * WRAPPER — the CloudFront idiom where the CFn template carries a bare array.
 */
export function collectSdkInterfaces(modelsDir: string): Map<string, Map<string, SdkMemberType>> {
  const interfaces = new Map<string, Map<string, SdkMemberType>>();

  const classifyType = (typeNode: ts.TypeNode | undefined): SdkMemberType => {
    if (!typeNode) return { kind: 'scalar' };
    let node: ts.TypeNode = typeNode;
    if (ts.isUnionTypeNode(node)) {
      const nonNullish = node.types.filter(
        (t) =>
          !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) &&
          t.kind !== ts.SyntaxKind.UndefinedKeyword
      );
      if (nonNullish.length !== 1) return { kind: 'scalar' };
      node = nonNullish[0]!;
    }
    if (ts.isArrayTypeNode(node)) {
      const element = node.elementType;
      return ts.isTypeReferenceNode(element) && ts.isIdentifier(element.typeName)
        ? { kind: 'array', refName: element.typeName.text }
        : { kind: 'array' };
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text === 'Array') {
        const element = node.typeArguments?.[0];
        return element !== undefined &&
          ts.isTypeReferenceNode(element) &&
          ts.isIdentifier(element.typeName)
          ? { kind: 'array', refName: element.typeName.text }
          : { kind: 'array' };
      }
      return { kind: 'ref', refName: node.typeName.text };
    }
    return { kind: 'scalar' };
  };

  for (const file of readdirSync(modelsDir).sort()) {
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(modelsDir, file), 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        const members =
          interfaces.get(node.name.text) ?? new Map<string, SdkMemberType>();
        for (const member of node.members) {
          if (
            ts.isPropertySignature(member) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
          ) {
            members.set(member.name.text, classifyType(member.type));
          }
        }
        interfaces.set(node.name.text, members);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return interfaces;
}

/**
 * Interface names that are `{Quantity, Items}` wrappers: they declare a
 * `Quantity` member. (`Items` alone is not required — `TrustedSigners` /
 * `TrustedKeyGroups` wrappers make `Items` optional but always carry
 * `Quantity`.)
 */
export function wrapperInterfaceNames(
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): Set<string> {
  const wrappers = new Set<string>();
  for (const [name, members] of interfaces) {
    if (members.has('Quantity')) wrappers.add(name);
  }
  return wrappers;
}

/**
 * Expand dotted literals into their segments: a provider that names a nested
 * conversion path as `'ForwardedValues.Headers'` (the CloudFront
 * `applyQuantityAtPath` idiom) has named BOTH keys for shape-handling
 * purposes. Kept SEPARATE from the key pass's literal set — the key pass
 * stays strict (a dotted path is not evidence of a key RENAME).
 */
export function expandLiteralSegments(literals: ReadonlySet<string>): Set<string> {
  const out = new Set(literals);
  // Only key-path-SHAPED literals expand (`Parent.Child` with PascalCase
  // segments — CFn property names are PascalCase) — an error message or a
  // filename like `'index.html'` must not credit its dot-segments as
  // handling evidence.
  const keyPath = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)+$/;
  for (const lit of literals) {
    if (keyPath.test(lit)) {
      for (const segment of lit.split('.')) {
        out.add(segment);
      }
    }
  }
  return out;
}

/**
 * Function-name PREFIXES whose bodies every evidence collector in this file
 * skips: the SDK->CFn REVERSE map (issue #1432, widened to the key / shape
 * passes by #1448).
 *
 * `readCurrentState` reads the SDK member and writes the CFn spelling. For a
 * `lower-first` target its writes can never collide with an SDK member name,
 * but for an `exact` target the two spellings are identical, so its
 * `result['CorsConfiguration'] = ...` would vouch for a forward mapper that
 * never names the member — #1393 item 2 reappearing one bucket over. Excluding
 * the body is what keeps the evidence direction-scoped.
 *
 * The same argument applies to the LITERAL set behind the `provider-handled`
 * verdict: a CFn key mentioned only by the reverse map is evidence the provider
 * can READ it back, not that the forward mapper converts it (issue #1448
 * comment item 2 — the asymmetry of excluding the reverse map from the write
 * pass but not from the key pass). Measured on the real tree, applying the
 * exclusion to the literal set moves NO key into a blocking bucket in either
 * the key or the shape pass, so the tightening is free today and fences the
 * next reverse-map-only mention.
 *
 * PREFIX rather than exact match, because the reverse map is routinely split
 * per sub-resource: `apigateway-provider.ts` declares
 * `readCurrentStateAuthorizer` / `...Resource` / `...Deployment` / `...Stage` /
 * `...Account` / `...Method`, none of which an exact-name set would catch.
 *
 * A prefix must be followed by a WORD BOUNDARY (end of name, or an uppercase
 * letter), so `readCurrentStatelessThing` is not swallowed by the
 * `readCurrentState` prefix.
 *
 * Measured withdrawal from the WRITE set on the real tree: 8 names from
 * `s3-bucket-provider.ts`, 71 from `codebuild-provider.ts`, 42 from
 * `ecs-provider.ts`. The ECS number is what the earlier EXACT-name match missed
 * entirely — its reverse map is split into `readCurrentStateService` /
 * `readCurrentStateTaskDefinition`.
 */
export const REVERSE_MAP_FUNCTION_PREFIXES: readonly string[] = ['readCurrentState'];

/**
 * Does `name` match one of `prefixes` at a word boundary (the whole name, or
 * the prefix followed by an uppercase letter)?
 */
const matchesFunctionPrefix = (name: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => name === p || (name.startsWith(p) && /[A-Z]/.test(name.charAt(p.length))));

/** The declared name of a function-ish node, when it is a plain identifier. */
const declaredFunctionName = (node: ts.Node): string | undefined => {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
};

/**
 * Collect every string literal in the provider source, AST-level (so a key
 * named only in a comment does NOT count as handled). Covers conversion-map
 * keys (`AcmCertificateArn: 'ACMCertificateArn'` — the property NAME is an
 * identifier, but the paired SDK spelling and every element-access site are
 * literals), element accesses (`config['OriginSSLProtocols']`), and
 * conversion-list entries (`['Origins', 'CacheBehaviors']`).
 *
 * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped, for the reason
 * documented there.
 */
export function collectStringLiterals(
  sourceText: string,
  fileName = 'provider.ts',
  excludedFunctionPrefixes: readonly string[] = REVERSE_MAP_FUNCTION_PREFIXES
): Set<string> {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const literals = new Set<string>();
  const visit = (node: ts.Node, excluded: boolean): void => {
    let inExcluded = excluded;
    if (!inExcluded) {
      const name = declaredFunctionName(node);
      if (name !== undefined && matchesFunctionPrefix(name, excludedFunctionPrefixes)) {
        inExcluded = true;
      }
    }
    if (!inExcluded) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literals.add(node.text);
      }
      // Object-literal property NAMES are identifiers, not literals — but a
      // conversion map keyed by CFn spelling (`AcmCertificateArn: '...'`) is
      // exactly the "provider names this key" evidence we want.
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        literals.add(node.name.text);
      }
    }
    ts.forEachChild(node, (child) => visit(child, inExcluded));
  };
  visit(sf, false);
  return literals;
}

/**
 * Peel `(x)` / `x as T` / `x satisfies T` / `x!` / `await x` off a value
 * expression.
 *
 * `await` matters in the FALSE-POSITIVE direction: an un-peeled
 * `source: await this.mapSource(x)` resolves to zero literals, which flags every
 * path under that top-level with the misleading "the provider never writes it"
 * on CORRECT code. No opted-in provider awaits a mapper today; the peel is here
 * so the first one that does is not punished for it.
 */
function unwrapExpression(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAwaitExpression(current)) current = current.expression;
    else return current;
  }
}

/** Climb OUT of the same wrappers, so a node's real consumer is visible. */
function climbOutOfWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Callees that only INSPECT or SERIALIZE their argument, so passing a value to
 * one decides nothing — what the RESULT feeds does.
 */
const isPureInspectionCallee = (callee: ts.Expression): boolean => {
  if (ts.isIdentifier(callee)) return ['String', 'Number', 'Boolean'].includes(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const target = `${callee.expression.text}.${callee.name.text}`;
  return [
    'JSON.stringify',
    'Object.keys',
    'Object.entries',
    'Object.values',
    'Array.isArray',
  ].includes(target);
};

/**
 * DIFF IS NOT DELIVERY (issue #1448).
 *
 * Does this value flow ONLY into a comparison / measurement — never into a
 * request, an escaping variable, or a non-inspecting call argument? An object
 * literal built purely to be serialized and compared
 * (`JSON.stringify({ batchReportMode: x }) !== JSON.stringify(prev)`, the
 * change-detection idiom of a diff-heavy `update()`) names its members without
 * DELIVERING any of them, so crediting it as write evidence is exactly the
 * false clear this pass exists to stop.
 *
 * The sibling critic `gen-handled-property-wiring` encodes the same rule on the
 * READ side; this is its write-side twin, deliberately fail-closed the same way
 * (bare truthiness, `!`, `typeof` and `.length` all count as inert).
 */
export function feedsOnlyComparison(value: ts.Node): boolean {
  const top = climbOutOfWrappers(value);
  const parent = top.parent;
  if (parent === undefined) return false;
  if (ts.isTypeOfExpression(parent)) return feedsOnlyComparison(parent);
  if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'length') {
    return feedsOnlyComparison(parent);
  }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((a) => a === top) &&
    isPureInspectionCallee(parent.expression)
  ) {
    return feedsOnlyComparison(parent);
  }
  if (ts.isBinaryExpression(parent)) {
    return COMPARISON_OPERATORS.has(parent.operatorToken.kind);
  }
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
    return parent.expression === top;
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === top;
  return false;
}

/**
 * {@link feedsOnlyComparison}, applied to the OUTERMOST literal a value sits
 * inside. `JSON.stringify({ outer: { inner: 1 } })` compared against a previous
 * render is comparison-only for `inner` too, even though `inner`'s own parent
 * chain stops at a PropertyAssignment — without the climb the nested half of a
 * diff literal would still be credited.
 */
export function isComparisonOnlyLiteral(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = climbOutOfWrappers(current).parent;
    if (
      parent !== undefined &&
      (ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        ts.isArrayLiteralExpression(parent))
    ) {
      current = parent;
      continue;
    }
    return feedsOnlyComparison(current);
  }
}

/**
 * PATH-SCOPED write evidence for one provider file (issue #1448).
 *
 * - `written` — every member name written ANYWHERE in the file. Name-global,
 *   and therefore only strong enough to fence a UNIQUELY-named member; kept as
 *   the parser-regression floor's input and as the `#top` scope's stand-in.
 * - `scopes` — the fix: written member name -> every member name written
 *   ANYWHERE BENEATH the value that name is written with. `buildBatchConfig`
 *   maps to the seven members of the literal `buildBatchConfig` is assigned,
 *   so `BuildBatchConfig.ServiceRole` is checked against THAT set rather than
 *   against the file-global one that the unrelated top-level `serviceRole:`
 *   write also lands in. Keyed by NAME and flattened to any depth, with the
 *   bounds that implies — see the module header's known-bounds section.
 */
export interface ProviderWriteEvidence {
  readonly written: ReadonlySet<string>;
  readonly scopes: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * WHOLE-BLOB HAND-OFF points (issue #1445): scope name -> every member name
   * at or beneath that scope whose written VALUE is a whole sub-blob delivered
   * through a GENERIC key converter (or verbatim), so the members underneath it
   * are delivered with no per-member write to find.
   *
   * `containerDefinitions` maps to `{ linuxParameters, repositoryCredentials,
   * systemControls, extraHosts, restartPolicy, resourceRequirements }`, and the
   * top-level `CorsConfiguration` maps to `{ CorsConfiguration }` (a scope whose
   * OWN value is the hand-off). The set is deliberately just NAMES: expanding a
   * name into the members beneath it needs the SDK model, which this collector
   * does not read — {@link expandGenericHandoffScopes} does that fold.
   */
  readonly handoffPoints: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The evidence a target that has NOT opted into the pass is classified with. */
export const EMPTY_WRITE_EVIDENCE: ProviderWriteEvidence = {
  written: new Set<string>(),
  scopes: new Map<string, ReadonlySet<string>>(),
  handoffPoints: new Map<string, ReadonlySet<string>>(),
};

/**
 * Parameter names that hold the DESIRED-state CFn property bag — the origin
 * every WHOLE-BLOB HAND-OFF has to trace back to (issue #1445). Same list, and
 * the same reasoning, as `gen-handled-property-wiring`'s
 * `PROPERTY_BAG_PARAM_NAMES`: the bag reaches a private helper by call edge, but
 * seeding by NAME keeps the entry points observable.
 *
 * `previousProperties` is deliberately absent, exactly as it is there: a blob
 * read off the PREVIOUS bag participates in change detection and proves nothing
 * about delivery. And without the taint root at all, `DistributionConfig:
 * config` on `CloudFrontDistributionProvider`'s disable-then-delete path — a
 * whole config read straight off `GetDistributionConfig` and sent back —
 * measured as a hand-off and cleared 108 of CloudFront's 110 findings. That is
 * the rubber stamp this critic must not become.
 */
export const HANDOFF_BAG_PARAM_NAMES: ReadonlySet<string> = new Set([
  'properties',
  'props',
  'newProperties',
  'currentProperties',
  'desiredProperties',
  'resourceProperties',
]);

/**
 * `undefined` / `null` written as an expression — the arm of a
 * `blob ? convert(blob) : undefined` guard that carries no blob and must not
 * disqualify the other arm from being a whole-blob hand-off (issue #1445).
 */
const isNullishExpression = (node: ts.Node): boolean => {
  const e = unwrapExpression(node);
  return (
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined')
  );
};

/** Array methods whose callback's RETURN value is the delivered element. */
const CALLBACK_RETURNING_METHODS: ReadonlySet<string> = new Set(['map', 'flatMap', 'reduce']);

/**
 * Array methods that deliver an element (or a subset) of the RECEIVER, so the
 * literals to resolve are the receiver's, not the callback's. `filter` / `find`
 * were briefly in {@link CALLBACK_RETURNING_METHODS}, which is wrong twice
 * over: their callback returns a PREDICATE (so nothing resolves), and the value
 * actually delivered comes from the array being filtered.
 */
const RECEIVER_PRESERVING_METHODS: ReadonlySet<string> = new Set([
  'filter',
  'find',
  'slice',
  'sort',
  'toSorted',
  'reverse',
  'toReversed',
  'at',
]);

/**
 * Array methods that deliver elements of the receiver AND of every argument.
 * Resolving only the receiver would UNDER-credit `base.concat([{ extra: 1 }])`,
 * which flags correct code.
 */
const RECEIVER_AND_ARGUMENT_METHODS: ReadonlySet<string> = new Set(['concat']);

/**
 * Array methods whose callback's FIRST parameter is an element of the receiver.
 * Used by the hand-off walk's taint pass (issue #1445): the `def` of
 * `defs.map((def) => …)` is bag data exactly when `defs` is.
 */
const ARRAY_ELEMENT_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map',
  'flatMap',
  'filter',
  'find',
  'forEach',
  'some',
  'every',
]);

/**
 * Collect PATH-SCOPED write evidence, AST-level.
 *
 * A write is an object-literal property name (`batchReportMode: value`), a
 * shorthand property (`{ batchReportMode }`), an assignment target
 * (`sdk.batchReportMode = ...` / `sdk['batchReportMode'] = ...` — including the
 * compound forms `??=` / `||=` / `+=`, which are still writes), or an
 * `Object.defineProperty(sdk, 'batchReportMode', { ... })` call. A READ
 * (`desc.batchReportMode` in a non-assignment position) deliberately does NOT
 * count — that asymmetry is what scopes the evidence to the CFn->SDK mapping
 * direction rather than the reverse map.
 *
 * For each write, the VALUE expression is resolved to the object literals it
 * can evaluate to, and every member name reachable beneath them is recorded as
 * that name's SCOPE. Resolution mirrors the `gen-handled-property-wiring`
 * (#1404) taint walk's reach — same-file `this.method(...)` and free-function
 * calls, `const`/`let` bindings, `?:` / `??` / `||` arms, array elements and
 * `.map(cb)` callbacks — because CodeBuild's `source: this.mapSource(source)`
 * and `buildBatchConfig` (a `let` bound to a literal, delivered as a shorthand
 * property) are both that shape.
 *
 * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped
 * entirely, and a literal that {@link feedsOnlyComparison} contributes nothing.
 *
 * A write whose value is a WHOLE-BLOB HAND-OFF into a generic key converter
 * (issue #1445) has no per-member literal to walk, so it is recorded separately
 * as a hand-off POINT — see {@link ProviderWriteEvidence.handoffPoints} and
 * {@link isWholeBlobHandoff}. `resolveImportSource` lets the hand-off walk
 * follow a converter imported from a SIBLING module (`pascalToCamelCaseKeys`
 * lives in `agentcore-case-convert.ts`, not in any provider): without it the
 * only real generic converter in the tree is unresolvable, and an unresolvable
 * callee is deliberately NOT credited.
 */
export function collectWriteEvidence(
  sourceText: string,
  fileName = 'provider.ts',
  excludedFunctionPrefixes: readonly string[] = REVERSE_MAP_FUNCTION_PREFIXES,
  resolveImportSource?: (specifier: string) => string | undefined
): ProviderWriteEvidence {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const written = new Set<string>();
  const scopes = new Map<string, Set<string>>();
  const handoffPoints = new Map<string, Set<string>>();

  /**
   * The written name of an object-literal property. An Identifier IS the name
   * here (`{ batchReportMode: … }`), and a computed name (`{ [k]: … }`) is a
   * `ComputedPropertyName`, which yields nothing.
   */
  const propertyName = (node: ts.Node): string | undefined =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : undefined;
  /**
   * The written name of an element access. Deliberately STRICTER than
   * {@link propertyName}: in `sdk[k] = v` the argument is an Identifier naming
   * a VARIABLE, not a member, so crediting it would let a local called `type`
   * or `name` vouch for an SDK member of that name — a false clear on a
   * CI-blocking bucket. Only a literal key counts.
   */
  const elementAccessName = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
  /**
   * A DESTRUCTURING ASSIGNMENT target (`({ batchReportMode } = desc)`) parses
   * as an object literal on the `left` of an `=`, so its members look like
   * property assignments while being READS off the right-hand side — the same
   * false-credit class as the element-access variable key above. (The
   * DECLARATION form, `const { x } = desc`, is an `ObjectBindingPattern` and
   * never reaches this branch.)
   */
  const isDestructuringTarget = (node: ts.Node): boolean => {
    // Walk to the OUTERMOST pattern node: a destructuring target nests
    // (`({ outer: { batchReportMode } } = desc)`), can sit inside an array
    // pattern (`[{ batchReportMode }] = arr`), and can carry a default
    // (`({ batchReportMode = 1 } = desc)`, whose member is a BinaryExpression
    // the walk passes straight through). A depth-1 check misses all three.
    let current: ts.Node | undefined = node.parent;
    let root: ts.Node | undefined;
    while (
      current !== undefined &&
      (ts.isObjectLiteralExpression(current) ||
        ts.isArrayLiteralExpression(current) ||
        ts.isPropertyAssignment(current) ||
        ts.isShorthandPropertyAssignment(current) ||
        ts.isSpreadAssignment(current) ||
        ts.isSpreadElement(current))
    ) {
      if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
        root = current;
      }
      current = current.parent;
    }
    if (root === undefined || current === undefined) return false;
    // `= ` assignment, or the binding position of a `for (… of …)` loop.
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      current.left === root
    ) {
      return true;
    }
    return ts.isForOfStatement(current) && current.initializer === root;
  };

  const isExcludedName = (n: string): boolean =>
    matchesFunctionPrefix(n, excludedFunctionPrefixes);

  // ---- Same-file callable index, so `source: this.mapSource(source)` can be
  // followed into `mapSource`'s returned literal. Excluded (reverse-map)
  // functions are left OUT of the index: a same-named helper on the read side
  // must never vouch for the write side.
  const callables = new Map<string, ts.Node[]>();
  /** Non-function property / variable initializers, for `this.blob` hops. */
  const initializers = new Map<string, ts.Node[]>();
  const indexCallable = (name: string, fn: ts.Node): void => {
    if (isExcludedName(name)) return;
    const list = callables.get(name) ?? [];
    list.push(fn);
    callables.set(name, list);
  };
  const indexInitializer = (name: string, init: ts.Node): void => {
    if (isExcludedName(name)) return;
    const list = initializers.get(name) ?? [];
    list.push(init);
    initializers.set(name, list);
  };
  const indexVisit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      indexCallable(node.name.text, node);
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      indexCallable(node.name.text, node);
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        indexCallable(node.name.text, init);
      } else if (ts.isPropertyDeclaration(node)) {
        indexInitializer(node.name.text, init);
      }
    }
    ts.forEachChild(node, indexVisit);
  };
  indexVisit(sf);

  /**
   * Callables the WHOLE-BLOB HAND-OFF walk may descend into (issue #1445):
   * every same-file callable, PLUS free functions imported by name from a
   * SIBLING module. The two indexes are kept apart on purpose — widening the
   * general {@link resolveLiterals} index to imported modules would change the
   * scope sets of every already-opted-in target, which is a different change
   * with a different blast radius. The hand-off walk only ever ASKS whether a
   * callee names members of its own, so importing that answer is safe.
   */
  const handoffCallables = new Map<string, ts.Node[]>(
    [...callables].map(([name, fns]) => [name, [...fns]])
  );
  if (resolveImportSource !== undefined) {
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly === true) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      const importedSource = resolveImportSource(stmt.moduleSpecifier.text);
      if (importedSource === undefined) continue;
      const importedSf = ts.createSourceFile(
        stmt.moduleSpecifier.text,
        importedSource,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS
      );
      const exported = new Map<string, ts.Node>();
      for (const s of importedSf.statements) {
        if (ts.isFunctionDeclaration(s) && s.name !== undefined) {
          exported.set(s.name.text, s);
        } else if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
            const init = unwrapExpression(d.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              exported.set(d.name.text, init);
            }
          }
        }
      }
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const fn = exported.get((element.propertyName ?? element.name).text);
        if (fn === undefined) continue;
        const local = element.name.text;
        if (isExcludedName(local)) continue;
        const list = handoffCallables.get(local) ?? [];
        list.push(fn);
        handoffCallables.set(local, list);
      }
    }
  }

  /**
   * Is `name` a PARAMETER of `scope`? A parameter shadows every outer binding,
   * so the outward climb must not start — otherwise a parameter named `cfg`
   * resolves to an unrelated method's `const cfg = { … }`.
   */
  const isBoundAsParameter = (scope: ts.Node, name: string): boolean => {
    if (!ts.isFunctionLike(scope)) return false;
    return scope.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
  };

  /** The nearest enclosing function body / source file — the binding scope. */
  const enclosingScope = (node: ts.Node): ts.Node => {
    for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
      if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return n;
    }
    return sf;
  };

  /** Every expression a function can RETURN (concise arrow body included). */
  const returnedExpressions = (fn: ts.Node): ts.Expression[] => {
    const body = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (body === undefined) return [];
    if (!ts.isBlock(body)) return [body as ts.Expression];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      // Do not descend into a NESTED function — its returns are its own.
      if (n !== body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    visit(body);
    return out;
  };

  /**
   * The object literals a value expression can evaluate to. `seen` guards the
   * cycles a `const a = b; const b = a;` pair (or a recursive helper) would
   * otherwise spin on.
   */
  const resolveLiterals = (
    expr: ts.Node,
    seen: Set<ts.Node>
  ): ts.ObjectLiteralExpression[] => {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return [];
    seen.add(e);
    if (ts.isObjectLiteralExpression(e)) return [e];
    if (ts.isConditionalExpression(e)) {
      return [...resolveLiterals(e.whenTrue, seen), ...resolveLiterals(e.whenFalse, seen)];
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return [...resolveLiterals(e.left, seen), ...resolveLiterals(e.right, seen)];
      }
      return [];
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap((el) => resolveLiterals(el, seen));
    }
    if (ts.isSpreadElement(e)) return resolveLiterals(e.expression, seen);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      return returnedExpressions(e).flatMap((r) => resolveLiterals(r, seen));
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        // `xs.map((x) => ({ … }))` delivers the CALLBACK's literal.
        if (CALLBACK_RETURNING_METHODS.has(callee.name.text)) {
          return e.arguments.flatMap((a) => resolveLiterals(a, seen));
        }
        // `xs.filter(p)` delivers an element of the RECEIVER.
        if (RECEIVER_PRESERVING_METHODS.has(callee.name.text)) {
          return resolveLiterals(callee.expression, seen);
        }
        // `xs.concat(ys)` delivers elements of BOTH.
        if (RECEIVER_AND_ARGUMENT_METHODS.has(callee.name.text)) {
          return [
            ...resolveLiterals(callee.expression, seen),
            ...e.arguments.flatMap((a) => resolveLiterals(a, seen)),
          ];
        }
      }
      // Same-file callable, resolved by NAME. Restricted to `this.helper(…)`
      // and a bare `helper(…)`: an earlier revision resolved ANY
      // `receiver.helper(…)`, so an unrelated `client.mapSource(x)` would have
      // been credited with the provider's own `mapSource` literal.
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword
          ? callee.name.text
          : undefined;
      if (name === undefined) return [];
      return (callables.get(name) ?? []).flatMap((fn) =>
        returnedExpressions(fn).flatMap((r) => resolveLiterals(r, seen))
      );
    }
    // `this.someBlob` / `Helpers.DEFAULTS` — a property or module constant
    // holding a literal. Same bare-name index as the callable resolution.
    if (ts.isPropertyAccessExpression(e)) {
      return (initializers.get(e.name.text) ?? []).flatMap((init) =>
        resolveLiterals(init, seen)
      );
    }
    if (ts.isIdentifier(e)) {
      // Nearest enclosing function first, then outward — an outer-scope
      // `const DEFAULTS = { … }` used inside a method is a real shape, and not
      // finding it flags CORRECT code.
      //
      // Two limits keep the climb from reaching into unrelated code. A name
      // bound as a PARAMETER of the nearest scope shadows everything outside
      // it, so the climb never starts. And an OUTER scope is searched WITHOUT
      // descending into its nested functions, so a `const cfg = { … }` in a
      // sibling method cannot resolve another method's `cfg`; only bindings
      // lexically visible from here do. The nearest scope itself IS descended
      // fully, because `let buildBatchConfig` assigned inside an `if` block is
      // the real shape this walk exists for — which also means two disjoint
      // `if` branches binding the same name are unioned (false-NEGATIVE
      // direction; see the module header's known-bounds section).
      const nearest = enclosingScope(e);
      if (isBoundAsParameter(nearest, e.text)) return [];
      for (let scope: ts.Node | undefined = nearest; scope; ) {
        const descendIntoFunctions = scope === nearest;
        const out: ts.ObjectLiteralExpression[] = [];
        const visit = (n: ts.Node): void => {
          if (!descendIntoFunctions && n !== scope && ts.isFunctionLike(n)) return;
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === e.text &&
            n.initializer !== undefined
          ) {
            out.push(...resolveLiterals(n.initializer, seen));
          } else if (
            ts.isBinaryExpression(n) &&
            isWriteAssignment(n.operatorToken.kind) &&
            ts.isIdentifier(n.left) &&
            n.left.text === e.text
          ) {
            out.push(...resolveLiterals(n.right, seen));
          }
          ts.forEachChild(n, visit);
        };
        visit(scope);
        if (out.length > 0) return out;
        scope = ts.isSourceFile(scope) ? undefined : enclosingScope(scope);
      }
      return [];
    }
    return [];
  };

  /**
   * The name of a callee the hand-off walk can resolve — a bare `helper(…)` or
   * a `this.helper(…)`, never a `receiver.helper(…)` on some other object (the
   * same restriction {@link resolveLiterals} carries, and for the same reason:
   * borrowing an unrelated object's same-named method is a false clear).
   */
  const resolvableCalleeName = (call: ts.CallExpression): string | undefined => {
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    return ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword
      ? callee.name.text
      : undefined;
  };

  /**
   * {@link propertyName}, plus the COMPUTED-but-literal form `{ ['Foo']: v }`.
   * Used only by {@link namesOwnMember}, where missing it would let a converter
   * name members through a spelling the write collector ignores; the write set
   * itself deliberately stays on the stricter {@link propertyName}.
   */
  const memberNameOfPropertyName = (node: ts.Node): string | undefined => {
    if (ts.isComputedPropertyName(node)) return elementAccessName(node.expression);
    return propertyName(node);
  };

  /** Memo for the ORDER-INDEPENDENT half of {@link isGenericConverter}. */
  const namesMemberCache = new Map<ts.Node, boolean>();

  // ---- PROPERTY-BAG TAINT, the ROOT of the whole-blob hand-off walk (#1445).
  // Declaration-scoped, never bare-name: `cloudfront-distribution-provider.ts`
  // binds the template's config AND the AWS-returned one to identifiers that
  // share the name `config` in different methods, so a name-keyed taint set
  // would credit the delete path's `GetDistributionConfig` echo.

  /** The declaration a plain identifier resolves to, searched lexically. */
  function declarationOf(id: ts.Identifier): ts.Node | undefined {
    const nearest = enclosingScope(id);
    for (let scope: ts.Node | undefined = nearest; scope; ) {
      if (ts.isFunctionLike(scope)) {
        const parameter = scope.parameters.find(
          (p) => ts.isIdentifier(p.name) && p.name.text === id.text
        );
        if (parameter !== undefined) return parameter;
      }
      const descendIntoFunctions = scope === nearest;
      let found: ts.Node | undefined;
      const visit = (n: ts.Node): void => {
        if (found !== undefined) return;
        if (!descendIntoFunctions && n !== scope && ts.isFunctionLike(n)) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text) {
          found = n;
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(scope);
      if (found !== undefined) return found;
      scope = ts.isSourceFile(scope) ? undefined : enclosingScope(scope);
    }
    return undefined;
  }

  const tainted = new Set<ts.Node>();

  /** Does this expression carry data that came out of the property bag? */
  function isBagDerived(expr: ts.Node, seen: Set<ts.Node>): boolean {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const declaration = declarationOf(e);
      return declaration !== undefined && tainted.has(declaration);
    }
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      return isBagDerived(e.expression, seen);
    }
    if (ts.isConditionalExpression(e)) {
      return isBagDerived(e.whenTrue, seen) || isBagDerived(e.whenFalse, seen);
    }
    if (ts.isBinaryExpression(e)) {
      return isBagDerived(e.left, seen) || isBagDerived(e.right, seen);
    }
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.some(
        (p) => ts.isSpreadAssignment(p) && isBagDerived(p.expression, seen)
      );
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.some((el) => isBagDerived(el, seen));
    }
    if (ts.isSpreadElement(e)) return isBagDerived(e.expression, seen);
    if (ts.isCallExpression(e)) {
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee) && isBagDerived(callee.expression, seen)) {
        return true; // `bag.map(...)` / `bag.filter(...)` — still bag data.
      }
      const name = resolvableCalleeName(e);
      if (name === undefined) return false;
      return (handoffCallables.get(name) ?? []).some((fn) =>
        returnedExpressions(fn).some((r) => isBagDerived(r, seen))
      );
    }
    return false;
  }

  /**
   * Taint the property-bag parameters, then propagate to fixpoint: a binding
   * initialized (or assigned) from bag data, a callee parameter handed bag data
   * at a resolvable call site, and an array-callback parameter iterating bag
   * data. Three iterations settle the real tree; the loop is bounded anyway.
   */
  const seedTaint = (): void => {
    const collectRoots = (n: ts.Node): void => {
      if (
        ts.isParameter(n) &&
        ts.isIdentifier(n.name) &&
        HANDOFF_BAG_PARAM_NAMES.has(n.name.text)
      ) {
        tainted.add(n);
      }
      ts.forEachChild(n, collectRoots);
    };
    collectRoots(sf);

    const taintParameter = (fn: ts.Node, index: number): boolean => {
      const params = (fn as ts.SignatureDeclaration).parameters;
      const parameter = params?.[index];
      if (parameter === undefined || tainted.has(parameter)) return false;
      tainted.add(parameter);
      return true;
    };

    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const propagate = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          n.initializer !== undefined &&
          !tainted.has(n) &&
          isBagDerived(n.initializer, new Set())
        ) {
          tainted.add(n);
          changed = true;
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          isBagDerived(n.right, new Set())
        ) {
          const declaration = declarationOf(n.left);
          if (declaration !== undefined && !tainted.has(declaration)) {
            tainted.add(declaration);
            changed = true;
          }
        } else if (ts.isCallExpression(n)) {
          const callee = unwrapExpression(n.expression);
          // `bag.map((element) => …)` taints the callback's element parameter.
          if (
            ts.isPropertyAccessExpression(callee) &&
            ARRAY_ELEMENT_CALLBACK_METHODS.has(callee.name.text) &&
            isBagDerived(callee.expression, new Set())
          ) {
            for (const argument of n.arguments) {
              const fn = unwrapExpression(argument);
              if (
                (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
                taintParameter(fn, 0)
              ) {
                changed = true;
              }
            }
          }
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) &&
                callee.expression.kind === ts.SyntaxKind.ThisKeyword
              ? callee.name.text
              : undefined;
          if (name !== undefined) {
            const fns = handoffCallables.get(name) ?? [];
            n.arguments.forEach((argument, index) => {
              if (!isBagDerived(argument, new Set())) return;
              for (const fn of fns) {
                if (taintParameter(fn, index)) changed = true;
              }
            });
          }
        }
        ts.forEachChild(n, propagate);
      };
      propagate(sf);
      if (!changed) break;
    }
  };
  seedTaint();

  /**
   * Does this function NAME a member — anywhere in its body, OR inside any
   * callee it can reach? A generic key converter is mechanical: every key it
   * emits came from the input, so it writes only through COMPUTED names
   * (`result[camelKey] = …`). One fixed member name (an object-literal
   * property including a computed-but-literal `{ ['Foo']: v }`, a shorthand, or
   * an `o.Foo = …` / `o['Foo'] = …` assignment) means per-member re-shaping,
   * which is exactly what has to keep proving itself write by write.
   *
   * TRANSITIVE, not body-local, and that is load-bearing rather than tidy. A
   * body-local test accepts the DELEGATING GUARD —
   *
   *     private convertLog(cfg?: Record<string, unknown>) {
   *       if (!cfg) return cfg;          // <- an existential delivery test passes HERE
   *       return this.buildLog(cfg);     // <- while the real work names members
   *     }
   *
   * — because `convertLog` itself names nothing and one of its returns is the
   * parameter outright. That is a silent clear on a CI-blocking bucket, so the
   * check descends into `buildLog`. (The delivery test cannot be tightened to
   * `.every` instead: `pascalToCamelCaseKeys` returns `result`, a binding to an
   * empty literal, so requiring EVERY return to deliver rejects the one real
   * generic converter in the tree.)
   *
   * Deliberately fail-CLOSED and deliberately crude in the other direction too:
   * `{ ...blob, Extra: 1 }` still delivers `blob` whole, but naming `Extra`
   * disqualifies the function. The cost of that is a target that keeps flagging
   * (visible); the cost of the opposite is a silent clear.
   *
   * What it does NOT catch is a converter that names nothing AND still drops or
   * renames keys — a filtering `if (DROP.has(key)) continue`, a rename-map
   * `out[MAP[key] ?? key] = v`, a `pick(blob, KEEP)`. See known bound (5) in the
   * module header: no such shape is a hand-off callee in the tree today, and the
   * honest statement is "names no member", NOT "can only emit keys it read".
   */
  function namesOwnMember(fn: ts.Node, seenFns: Set<ts.Node> = new Set()): boolean {
    if (seenFns.has(fn)) return false; // recursion: judged by its other paths
    seenFns.add(fn);
    const body = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (body === undefined) return false;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isPropertyAssignment(n) && memberNameOfPropertyName(n.name) !== undefined) {
        found = true;
      } else if (ts.isShorthandPropertyAssignment(n)) found = true;
      else if (ts.isBinaryExpression(n) && isWriteAssignment(n.operatorToken.kind)) {
        if (ts.isPropertyAccessExpression(n.left)) found = true;
        else if (
          ts.isElementAccessExpression(n.left) &&
          elementAccessName(n.left.argumentExpression) !== undefined
        ) {
          found = true;
        }
      } else if (ts.isCallExpression(n)) {
        const name = resolvableCalleeName(n);
        if (
          name !== undefined &&
          (handoffCallables.get(name) ?? []).some((callee) => namesOwnMember(callee, seenFns))
        ) {
          found = true;
        }
      }
      if (!found) ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  }

  const genericConverterCache = new Map<ts.Node, boolean>();
  /**
   * Is this function a GENERIC KEY CONVERTER — a mechanical whole-object
   * transform that (a) names no member of its own or of anything it calls, and
   * (b) actually RETURNS its input blob (possibly through another generic
   * converter), rather than only measuring or comparing it?
   *
   * `pascalToCamelCaseKeys` passes on both counts: it writes only
   * `result[camelKey]`, and its guard arm `return value` returns the parameter
   * outright. `ECSProvider.convertLinuxParameters` passes because its single
   * return is `pascalToCamelCaseKeys(config)` — and, under the transitive (a),
   * only because that callee names nothing either. `convertContainerDefinitions`
   * (45 named members) and `CloudFrontDistributionProvider.convertToSdkFormat`
   * (a spread-and-patch that names 30+) both fail (a) directly; a converter that
   * delegates the naming to a helper fails it transitively.
   */
  function isGenericConverter(fn: ts.Node, seen: Set<ts.Node>): boolean {
    const cached = genericConverterCache.get(fn);
    if (cached !== undefined) return cached;
    if (seen.has(fn)) return true; // a recursive converter: judged by its other arms
    seen.add(fn);
    const params = (fn as ts.SignatureDeclaration).parameters;
    // (a) is cached on its own: it depends only on the function and the callable
    // index, so unlike the composite verdict it is order-INDEPENDENT.
    let names = namesMemberCache.get(fn);
    if (names === undefined) {
      names = params === undefined || params.length === 0 || namesOwnMember(fn);
      namesMemberCache.set(fn, names);
    }
    if (names) {
      genericConverterCache.set(fn, false);
      return false;
    }
    // (b) is NOT cached: `deliversWholeBlob` consults the caller-shared `seen`
    // cycle guard, so a `false` here can be an artifact of the traversal order
    // rather than a property of `fn`. Caching it would make the verdict
    // order-dependent; recomputing is cheap because (a) already rejected the
    // large converters.
    const verdict = returnedExpressions(fn).some((r) => deliversWholeBlob(r, seen));
    if (verdict) genericConverterCache.set(fn, true);
    return verdict;
  }

  /**
   * Does this expression deliver a WHOLE BLOB — a value read off the property
   * bag (or a converter's own parameter) that reaches the write with no member
   * of it named along the way?
   *
   * SEED     — a BAG-DERIVED element / property access (`def['LinuxParameters']`),
   *            an identifier bound to one, or a bag-tainted PARAMETER (which is
   *            what makes a converter body's `config` a seed rather than an
   *            unresolvable identifier). Bag-derivation is the load-bearing half:
   *            without it a whole config read back off `GetDistributionConfig`
   *            and re-sent looks identical to a template forward.
   * PROPAGATE— `?:` / `??` / `||` / `&&` arms, a spread-only object literal,
   *            and a call handing the seed WHOLE to a same-file or
   *            sibling-module callee that {@link isGenericConverter} accepts.
   * DELIVERY — the caller records this only where a WRITE takes the value, so
   *            reaching here already means the value is written somewhere; a
   *            value that only feeds a comparison is refused by the caller's
   *            {@link feedsOnlyComparison} guard.
   *
   * Every unhandled shape returns false. An UNRESOLVABLE callee is therefore
   * not credited — the false-clear direction is the dangerous one for a
   * CI-blocking bucket, and it is why `resolveImportSource` exists at all.
   */
  function deliversWholeBlob(expr: ts.Node, seen: Set<ts.Node>, seedKeys?: Set<string>): boolean {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      if (!isBagDerived(e, new Set())) return false;
      const key = ts.isElementAccessExpression(e)
        ? elementAccessName(e.argumentExpression)
        : e.name.text;
      if (key !== undefined) seedKeys?.add(key);
      return true;
    }
    if (ts.isIdentifier(e)) {
      const nearest = enclosingScope(e);
      if (isBoundAsParameter(nearest, e.text)) return isBagDerived(e, new Set());
      const bindings = identifierBindings(e);
      return (
        bindings.length > 0 && bindings.every((b) => deliversWholeBlob(b, seen, seedKeys))
      );
    }
    if (ts.isConditionalExpression(e)) {
      const arms = [e.whenTrue, e.whenFalse].filter((a) => !isNullishExpression(a));
      return arms.length > 0 && arms.every((a) => deliversWholeBlob(a, seen, seedKeys));
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
        return deliversWholeBlob(e.right, seen, seedKeys);
      }
      if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) {
        const arms = [e.left, e.right].filter((a) => !isNullishExpression(a));
        return arms.length > 0 && arms.every((a) => deliversWholeBlob(a, seen, seedKeys));
      }
      return false;
    }
    if (ts.isObjectLiteralExpression(e)) {
      // `{ ...blob }` — a spread-ONLY literal re-delivers every member.
      return (
        e.properties.length > 0 &&
        e.properties.every(
          (p) => ts.isSpreadAssignment(p) && deliversWholeBlob(p.expression, seen, seedKeys)
        )
      );
    }
    if (ts.isCallExpression(e)) {
      const name = resolvableCalleeName(e);
      if (name === undefined) return false;
      const fns = handoffCallables.get(name) ?? [];
      if (fns.length === 0) return false;
      return (
        fns.every((fn) => isGenericConverter(fn, seen)) &&
        e.arguments.some((a) => deliversWholeBlob(a, seen, seedKeys))
      );
    }
    return false;
  }

  /**
   * Every VALUE a plain identifier can hold. Mirrors {@link resolveLiterals}'s
   * identifier branch — nearest function scope descended fully, then outward
   * without entering sibling functions — with one deliberate difference: it
   * stops at the first scope carrying a BINDING, where `resolveLiterals` climbs
   * past a binding that yields no object literal. For a hand-off a binding to a
   * NON-literal (`const single = properties['X']`) is the interesting case, so
   * climbing past it would resolve the name against an unrelated outer one.
   */
  function identifierBindings(id: ts.Identifier): ts.Node[] {
    const nearest = enclosingScope(id);
    for (let scope: ts.Node | undefined = nearest; scope; ) {
      const descendIntoFunctions = scope === nearest;
      const out: ts.Node[] = [];
      const visit = (n: ts.Node): void => {
        if (!descendIntoFunctions && n !== scope && ts.isFunctionLike(n)) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === id.text &&
          n.initializer !== undefined
        ) {
          out.push(n.initializer);
        } else if (
          ts.isBinaryExpression(n) &&
          isWriteAssignment(n.operatorToken.kind) &&
          ts.isIdentifier(n.left) &&
          n.left.text === id.text
        ) {
          out.push(n.right);
        }
        ts.forEachChild(n, visit);
      };
      visit(scope);
      if (out.length > 0) return out;
      scope = ts.isSourceFile(scope) ? undefined : enclosingScope(scope);
    }
    return [];
  }

  /**
   * Is this expression a WHOLE-BLOB HAND-OFF worth recording (issue #1445)?
   * `feedsOnlyComparison` is re-applied here for the same reason the literal
   * walk applies it: a converted blob whose only consumer is a diff delivers
   * nothing.
   */
  function isWholeBlobHandoff(value: ts.Node): { seedKeys: Set<string> } | undefined {
    if (feedsOnlyComparison(value)) return undefined;
    const seedKeys = new Set<string>();
    return deliversWholeBlob(value, new Set(), seedKeys) ? { seedKeys } : undefined;
  }

  /**
   * Register a hand-off point under every scope name it can be looked up by.
   *
   * The write NAME is the SDK spelling; the audited path's top level is the CFn
   * spelling, and the two do not always agree — `ECSProvider` writes
   * `placementStrategy` for CFn's `PlacementStrategies`, so keying only by the
   * write name leaves `PlacementStrategies.Type` / `.Field` with no scope at all
   * on a target that forwards the whole array. The SEED's own key IS the CFn
   * spelling, so it is registered too (in both the `exact` and `lower-first`
   * renderings, since the collector does not know the target's key style).
   */
  const registerHandoff = (scopeName: string, point: string): void => {
    const points = handoffPoints.get(scopeName) ?? new Set<string>();
    points.add(point);
    handoffPoints.set(scopeName, points);
  };
  const registerSeedKeyHandoffs = (point: string, seedKeys: ReadonlySet<string>): void => {
    for (const key of seedKeys) {
      registerHandoff(key, point);
      registerHandoff(lowerFirst(key), point);
    }
  };

  /**
   * Every member name written anywhere beneath these literals, plus the
   * WHOLE-BLOB HAND-OFF points found among them (issue #1445).
   */
  const subtreeMemberNames = (
    literals: readonly ts.ObjectLiteralExpression[]
  ): { members: Set<string>; handoffs: Set<string> } => {
    const out = new Set<string>();
    const handoffs = new Set<string>();
    const visited = new Set<ts.Node>();
    const walk = (lit: ts.ObjectLiteralExpression): void => {
      if (visited.has(lit)) return;
      visited.add(lit);
      if (isComparisonOnlyLiteral(lit)) return;
      for (const p of lit.properties) {
        if (ts.isPropertyAssignment(p)) {
          const name = propertyName(p.name);
          if (name !== undefined) {
            out.add(name);
            const handoff = isWholeBlobHandoff(p.initializer);
            if (handoff !== undefined) {
              handoffs.add(name);
              registerSeedKeyHandoffs(name, handoff.seedKeys);
            }
          }
          for (const child of resolveLiterals(p.initializer, new Set())) walk(child);
        } else if (ts.isShorthandPropertyAssignment(p)) {
          out.add(p.name.text);
          const handoff = isWholeBlobHandoff(p.name);
          if (handoff !== undefined) {
            handoffs.add(p.name.text);
            registerSeedKeyHandoffs(p.name.text, handoff.seedKeys);
          }
          for (const child of resolveLiterals(p.name, new Set())) walk(child);
        } else if (ts.isSpreadAssignment(p)) {
          // A spread merges the source's members AT THIS LEVEL.
          for (const child of resolveLiterals(p.expression, new Set())) walk(child);
        }
      }
    };
    for (const lit of literals) walk(lit);
    return { members: out, handoffs };
  };

  /**
   * Record one write, and merge the members reachable beneath its value into
   * that name's scope.
   *
   * The merge is deliberate but IS a bound (see the module header's
   * known-bounds section, item 2): scopes are keyed by member NAME and unioned
   * across every write site sharing it, so two unrelated `environment: { … }`
   * literals contribute to one `environment` scope, and a name that only ever
   * appears NESTED still gets a scope of its own. Keeping per-site sets would
   * not change the positive test — a key is cleared when ANY site covers it,
   * which is the union.
   */
  const record = (name: string, value: ts.Node | undefined): void => {
    written.add(name);
    const scope = scopes.get(name) ?? new Set<string>();
    if (value !== undefined) {
      // A write whose OWN value is the hand-off (`CorsConfiguration:
      // properties['CorsConfiguration']`) makes the scope its own hand-off
      // point — the audited paths beneath that top-level are exactly the
      // members of the blob it forwards.
      const handoff = isWholeBlobHandoff(value);
      if (handoff !== undefined) {
        registerHandoff(name, name);
        registerSeedKeyHandoffs(name, handoff.seedKeys);
      }
      const { members, handoffs } = subtreeMemberNames(resolveLiterals(value, new Set()));
      for (const m of members) scope.add(m);
      for (const h of handoffs) registerHandoff(name, h);
    }
    scopes.set(name, scope);
  };

  /**
   * `Object.defineProperty(sdk, 'batchReportMode', { value: … })` IS a write of
   * `batchReportMode` — but the DESCRIPTOR literal's own keys are not writes of
   * anything: crediting them would put `value` / `get` / `set` / `writable`
   * into the set, and `value` is a real CodeBuild member (`Value`). So the
   * descriptor literal is suppressed and only its `value:` payload is walked as
   * the named member's scope.
   */
  const suppressedLiterals = new Set<ts.Node>();
  const definePropertyWrite = (
    node: ts.CallExpression
  ): { name: string; value: ts.Node | undefined; descriptor: ts.Node | undefined } | undefined => {
    const callee = unwrapExpression(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'Object' ||
      callee.name.text !== 'defineProperty' ||
      node.arguments.length < 2
    ) {
      return undefined;
    }
    const name = elementAccessName(unwrapExpression(node.arguments[1]!));
    if (name === undefined) return undefined;
    const descriptor =
      node.arguments.length > 2 ? unwrapExpression(node.arguments[2]!) : undefined;
    let value: ts.Node | undefined;
    if (descriptor !== undefined && ts.isObjectLiteralExpression(descriptor)) {
      for (const p of descriptor.properties) {
        if (ts.isPropertyAssignment(p) && propertyName(p.name) === 'value') value = p.initializer;
      }
    }
    return { name, value, descriptor };
  };

  const visit = (node: ts.Node, excluded: boolean): void => {
    let inExcluded = excluded;
    if (!inExcluded) {
      const name = declaredFunctionName(node);
      if (name !== undefined && isExcludedName(name)) inExcluded = true;
    }
    if (!inExcluded) {
      if (ts.isPropertyAssignment(node)) {
        const name = propertyName(node.name);
        if (
          name !== undefined &&
          !isDestructuringTarget(node) &&
          !suppressedLiterals.has(node.parent) &&
          !isComparisonOnlyLiteral(node.parent)
        ) {
          record(name, node.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        if (
          !isDestructuringTarget(node) &&
          !suppressedLiterals.has(node.parent) &&
          !isComparisonOnlyLiteral(node.parent)
        ) {
          record(node.name.text, node.name);
        }
      } else if (ts.isBinaryExpression(node) && isWriteAssignment(node.operatorToken.kind)) {
        const lhs = node.left;
        if (ts.isPropertyAccessExpression(lhs)) {
          record(lhs.name.text, node.right);
        } else if (ts.isElementAccessExpression(lhs)) {
          const name = elementAccessName(lhs.argumentExpression);
          if (name !== undefined) record(name, node.right);
        }
      } else if (ts.isCallExpression(node)) {
        const defined = definePropertyWrite(node);
        if (defined !== undefined) {
          if (defined.descriptor !== undefined) suppressedLiterals.add(defined.descriptor);
          record(defined.name, defined.value);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inExcluded));
  };
  visit(sf, false);
  return { written, scopes, handoffPoints };
}

/**
 * Every SDK member name reachable BENEATH an SDK member, following the model's
 * own reference graph (issue #1445).
 *
 * This is what turns a hand-off POINT into a credit set: the provider source
 * says `linuxParameters` receives a whole blob through a generic converter, and
 * the SDK model says `LinuxParameters` carries `capabilities` / `devices` /
 * `tmpfs` / … and those carry `add` / `hostPath` / `mountOptions` / …. The CFn
 * side cannot answer this — the fixture's `nestedProperties` capture is
 * FLATTENED per top-level, so it knows `ContainerDefinitions.Add` exists but not
 * that `Add` lives under `LinuxParameters`.
 *
 * The starting member is looked up by BARE NAME across every interface in the
 * client model, so two unrelated interfaces declaring the same member name are
 * UNIONED. That is the same bare-name bound the rest of this collector carries
 * (module header, known-bounds item 3), and it is bounded in practice: only a
 * name the provider actually hands a whole blob to is ever expanded, and a
 * scalar member expands to nothing at all.
 */
export function reachableSdkMemberNames(
  memberName: string,
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  for (const members of interfaces.values()) {
    const type = members.get(memberName);
    if (type?.refName !== undefined) queue.push(type.refName);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const members = interfaces.get(name);
    if (members === undefined) continue;
    for (const [member, type] of members) {
      out.add(member);
      if (type.refName !== undefined) queue.push(type.refName);
    }
  }
  return out;
}

/**
 * Fold the WHOLE-BLOB HAND-OFF points into the write scopes (issue #1445), so
 * `classifyTarget` keeps its single question: "is the path's terminal member in
 * the scope its top-level maps to?".
 *
 * Kept OUT of {@link collectWriteEvidence} because the two halves have
 * different inputs and regress independently: the collector reads only the
 * provider source (and answers "what is handed off whole?"), while the
 * expansion reads only the SDK model (and answers "what lives beneath it?").
 */
/**
 * How many distinct hand-off points actually EXPAND to at least one SDK member
 * — the only ones that can clear an audited path.
 *
 * The raw point count is the wrong fence and was measured to be vacuous: on
 * `apigatewayv2-provider.ts` the walk records 35 points, but 32 of them are
 * inert scalar forwards (`Name`, `ApiId`, `StageName`, …) whose SDK member is a
 * string. Only `CorsConfiguration` / `DefaultRouteSettings` / `JwtConfiguration`
 * carry a sub-blob, so a regression that broke exactly the blob recognition
 * would leave ~32 raw points standing and sail past a floor of 20 while CI
 * emitted the 13 bogus divergences the floor exists to prevent.
 */
export function countExpandingHandoffPoints(
  evidence: ProviderWriteEvidence,
  sdkInterfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): number {
  const points = new Set([...evidence.handoffPoints.values()].flatMap((set) => [...set]));
  let expanding = 0;
  for (const point of points) {
    if (reachableSdkMemberNames(point, sdkInterfaces).size > 0) expanding++;
  }
  return expanding;
}

export function expandGenericHandoffScopes(
  evidence: ProviderWriteEvidence,
  sdkInterfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): ProviderWriteEvidence {
  if (evidence.handoffPoints.size === 0) return evidence;
  const memo = new Map<string, Set<string>>();
  const reachable = (name: string): Set<string> => {
    let hit = memo.get(name);
    if (hit === undefined) {
      hit = reachableSdkMemberNames(name, sdkInterfaces);
      memo.set(name, hit);
    }
    return hit;
  };
  const scopes = new Map<string, Set<string>>();
  for (const [name, members] of evidence.scopes) scopes.set(name, new Set(members));
  for (const [scopeName, points] of evidence.handoffPoints) {
    const scope = scopes.get(scopeName) ?? new Set<string>();
    for (const point of points) {
      scope.add(point);
      for (const member of reachable(point)) scope.add(member);
    }
    scopes.set(scopeName, scope);
  }
  return { written: evidence.written, scopes, handoffPoints: evidence.handoffPoints };
}

/**
 * Assignment operators that WRITE their left-hand side. `sdk.x = v` is the
 * common form, but `??=` / `||=` / `&&=` / `+=` are writes too — an opted-in
 * provider refactored into one of them would otherwise fail CI with the
 * MISLEADING "the provider never writes it" (issue #1448 comment item 1).
 * `FirstAssignment`..`LastAssignment` is the compiler's own token range for
 * exactly this set.
 */
function isWriteAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * The NAME-GLOBAL write set — every member name written anywhere in the file.
 *
 * TEST-ONLY since #1448: `loadReport` reads `ProviderWriteEvidence.written`
 * directly for the name floor, and the classification consults
 * {@link ProviderWriteEvidence.scopes}. Kept exported because the unit tests
 * assert per-SHAPE recognition and the reverse-map withdrawal counts against
 * it, and because it is the set every "would the OLD evidence have caught
 * this?" probe compares against.
 */
export function collectWrittenMemberNames(
  sourceText: string,
  fileName = 'provider.ts',
  excludedFunctionPrefixes: readonly string[] = REVERSE_MAP_FUNCTION_PREFIXES
): Set<string> {
  return new Set(collectWriteEvidence(sourceText, fileName, excludedFunctionPrefixes).written);
}

/**
 * Classify one target's nested key PATHS. Pure + exported for unit tests.
 *
 * `writeEvidence` is consulted only for a {@link NestedKeyTarget.freshObjectMapper}
 * target (issue #1432); the default empty evidence makes every same-spelling
 * key flag, so callers that opt a target in MUST pass it.
 *
 * The write test is SCOPED (issue #1448): the path's terminal member must be
 * written beneath the write scope its TOP-LEVEL maps to, not merely somewhere
 * in the file. `BuildBatchConfig.ServiceRole` therefore has to be written under
 * `buildBatchConfig`; the unrelated top-level `serviceRole:` write no longer
 * vouches for it.
 */
export function classifyTarget(
  target: NestedKeyTarget,
  nestedKeyPaths: readonly NestedKeyPath[],
  sdkMembers: ReadonlySet<string>,
  providerLiterals: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST,
  writeEvidence: ProviderWriteEvidence = EMPTY_WRITE_EVIDENCE
): NestedKeyClassification[] {
  const sdkLower = new Map<string, string>();
  for (const m of sdkMembers) {
    if (!sdkLower.has(m.toLowerCase())) sdkLower.set(m.toLowerCase(), m);
  }
  const styled = (s: string): string => (target.keyStyle === 'lower-first' ? lowerFirst(s) : s);
  const out: NestedKeyClassification[] = [];
  const seenPaths = new Set<string>();
  const sorted = [...nestedKeyPaths].sort((a, b) => a.path.localeCompare(b.path));
  for (const { path, topLevelProperty, key } of sorted) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    const expected = styled(key);
    let bucket: Bucket;
    let sdkNearMiss: string | undefined;
    let rationale: string | undefined;
    let allowMatchKey: string | undefined;
    if (sdkMembers.has(expected)) {
      // WRITE-EVIDENCE pass (issue #1432 / #1448). A matching SDK spelling only
      // proves delivery for a provider that FORWARDS the blob; a fresh-object
      // mapper has to name the member IN THE RIGHT PLACE. Deliberately NOT
      // rescued by `providerLiterals` — the CFn spelling appearing somewhere in
      // the file is the loose heuristic this pass exists to stop trusting.
      const scope = writeEvidence.scopes.get(styled(topLevelProperty));
      if (target.freshObjectMapper === true && !(scope?.has(expected) ?? false)) {
        sdkNearMiss = expected;
        const allowed = lookupAllowEntry(allowList, target.resourceType, path, key, 'write');
        if (allowed) {
          bucket = 'allow-listed';
          rationale = allowed.entry.rationale;
          allowMatchKey = allowed.key;
        } else {
          bucket = 'no-write-evidence';
        }
      } else {
        bucket = 'same-spelling';
      }
    } else if (providerLiterals.has(key)) {
      bucket = 'provider-handled';
    } else {
      const near = sdkLower.get(key.toLowerCase());
      const allowed = lookupAllowEntry(allowList, target.resourceType, path, key, 'key');
      if (allowed) {
        bucket = 'allow-listed';
        rationale = allowed.entry.rationale;
        allowMatchKey = allowed.key;
        sdkNearMiss = near;
      } else if (near !== undefined) {
        bucket = 'case-divergence';
        sdkNearMiss = near;
      } else {
        bucket = 'no-sdk-member';
      }
    }
    out.push({
      resourceType: target.resourceType,
      nestedKey: path,
      topLevelProperty,
      terminalKey: key,
      bucket,
      ...(sdkNearMiss !== undefined ? { sdkNearMiss } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(allowMatchKey !== undefined ? { allowMatchKey } : {}),
    });
  }
  return out;
}

export interface ShapePassResult {
  readonly entries: NestedShapeClassification[];
  readonly cleanCount: number;
  readonly unmatchedDefinitions: string[];
}

/**
 * SHAPE pass (issue #1378): audits divergences the key-spelling pass is blind
 * to because the spelling exists SOMEWHERE in the SDK model.
 *
 * Two sub-passes over the fixture's `definitionShapes` capture:
 *   - WRAPPER: a CFn member declared `array` whose same-spelled SDK members
 *     are all `{Quantity, Items}` wrapper references (none is a bare array) —
 *     the provider must wrap it or the serializer drops it.
 *   - DEFINITION: for each CFn definition with a same-named SDK interface,
 *     a member that same-spells an SDK member globally but is MISSING from
 *     that interface (renamed or relocated — `CachedMethods`). Members with
 *     no same-spelled SDK member anywhere are the KEY pass's domain and are
 *     skipped here, so the two passes never double-report.
 *
 * Deliberately scoped to definitions REACHABLE from the provider's handled
 * top-levels? No — the whole definitionShapes map is audited: definitions are
 * shared sub-shapes and reachability pruning would re-derive the nested walk
 * for marginal gain; an unreachable definition's divergence is at worst a
 * false positive to allow-list, and none exists in the current targets.
 */
export function classifyTargetShapes(
  target: NestedKeyTarget,
  definitionShapes: Readonly<Record<string, Record<string, string>>>,
  sdkInterfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>,
  providerLiterals: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): ShapePassResult {
  const wrappers = wrapperInterfaceNames(sdkInterfaces);
  const shapeLiterals = expandLiteralSegments(providerLiterals);

  // Global SDK member index: styled name -> every declared kind.
  const globalKinds = new Map<string, SdkMemberType[]>();
  for (const members of sdkInterfaces.values()) {
    for (const [name, type] of members) {
      const list = globalKinds.get(name) ?? [];
      list.push(type);
      globalKinds.set(name, list);
    }
  }

  const styled = (key: string): string =>
    target.keyStyle === 'lower-first' ? lowerFirst(key) : key;

  const entries: NestedShapeClassification[] = [];
  let cleanCount = 0;
  const unmatchedDefinitions: string[] = [];
  // The wrapper verdict is per KEY (deduped across definitions, like the key
  // pass); the definition verdict is per (definition, key).
  const wrapperSeen = new Set<string>();

  const resolveAudited = (
    key: string,
    definition: string,
    pass: 'wrapper' | 'definition',
    blockingBucket: ShapeBucket,
    sdkDetail: string | undefined
  ): void => {
    const allowed = lookupAllowEntry(allowList, target.resourceType, key, key, 'shape');
    let bucket: ShapeBucket;
    let rationale: string | undefined;
    let allowMatchKey: string | undefined;
    if (shapeLiterals.has(key)) {
      bucket = 'provider-handled';
    } else if (allowed) {
      bucket = 'allow-listed';
      rationale = allowed.entry.rationale;
      allowMatchKey = allowed.key;
    } else {
      bucket = blockingBucket;
    }
    entries.push({
      resourceType: target.resourceType,
      nestedKey: key,
      definition,
      pass,
      bucket,
      ...(sdkDetail !== undefined ? { sdkDetail } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(allowMatchKey !== undefined ? { allowMatchKey } : {}),
    });
  };

  for (const [defName, members] of Object.entries(definitionShapes)) {
    const sdkIface = defName === '#top' ? undefined : sdkInterfaces.get(defName);
    if (defName !== '#top' && !sdkIface) unmatchedDefinitions.push(defName);

    for (const [key, shape] of Object.entries(members)) {
      const kinds = globalKinds.get(styled(key));

      // A 'mixed' CFn shape (conflicting oneOf arms, array-form `type`)
      // cannot be shape-judged — surface it as ambiguous (visible,
      // non-blocking) rather than silently skipping.
      if (shape === 'mixed' && kinds && !wrapperSeen.has(key)) {
        wrapperSeen.add(key);
        entries.push({
          resourceType: target.resourceType,
          nestedKey: key,
          definition: defName,
          pass: 'wrapper',
          bucket: shapeLiterals.has(key) ? 'provider-handled' : 'ambiguous',
        });
      }

      // WRAPPER sub-pass (per key, deduped).
      if (shape === 'array' && kinds && !wrapperSeen.has(key)) {
        wrapperSeen.add(key);
        // Deliberately ANY-array (response shapes included), not
        // request-interface-scoped: the false-negative direction, matching
        // the key pass's superset philosophy.
        if (kinds.some((k) => k.kind === 'array')) {
          cleanCount++;
        } else {
          const wrapperRef = kinds.find(
            (k) => k.kind === 'ref' && k.refName !== undefined && wrappers.has(k.refName)
          );
          if (wrapperRef) {
            resolveAudited(
              key,
              defName,
              'wrapper',
              'array-vs-wrapper',
              `SDK wraps it as \`${wrapperRef.refName}\` ({ Quantity, Items })`
            );
          } else {
            // Array on the CFn side, neither array nor wrapper on the SDK
            // side — cannot be auto-judged. A provider that names the key is
            // credited (CloudFront `Tags` — SDK `{ Items }`, no Quantity —
            // handled by the dedicated tag path); otherwise visible as
            // ambiguous, never blocking.
            entries.push({
              resourceType: target.resourceType,
              nestedKey: key,
              definition: defName,
              pass: 'wrapper',
              bucket: shapeLiterals.has(key) ? 'provider-handled' : 'ambiguous',
            });
          }
        }
      }

      // DEFINITION sub-pass (per definition + key).
      if (sdkIface && kinds && !sdkIface.has(styled(key))) {
        resolveAudited(
          key,
          defName,
          'definition',
          'definition-member-missing',
          `SDK interface \`${defName}\` has no \`${styled(key)}\` member`
        );
      }
    }
  }

  return { entries, cleanCount, unmatchedDefinitions: unmatchedDefinitions.sort() };
}

/**
 * One audited unit: a nested CFn key together with the handled TOP-LEVEL
 * property it is reachable beneath (issue #1448).
 *
 * The fixture's `nestedProperties` capture is per top-level property and
 * flattens the whole reachable interior, so `path` is a two-segment
 * `Top.Member` rather than the full chain — `BuildBatchConfig.ComputeTypesAllowed`
 * for a member that actually lives one level deeper, under `Restrictions`.
 * That is the granularity the CFn side offers, and it is exactly the
 * granularity the write side is scoped at (every member written ANYWHERE
 * beneath `buildBatchConfig`), so the two line up.
 */
export interface NestedKeyPath {
  /** Handled top-level CFn property the key is reachable beneath. */
  readonly topLevelProperty: string;
  /** The nested key's own name. */
  readonly key: string;
  /** `TopLevelProperty.Key` — the audited unit. */
  readonly path: string;
}

/**
 * The nested CFn key PATHS audited for a target: the fixture's
 * `nestedProperties` entries for the top-level properties THIS PROVIDER
 * handles on the type. Unhandled top-levels are pre-flight-rejected by
 * `property-coverage`, so their interiors are unreachable through this
 * provider by construction.
 *
 * Was a de-duplicated set of bare NAMES through #1432; see {@link NestedKeyPath}
 * for why the audited unit had to become a path.
 */
export function nestedKeyPathsForTarget(
  fixture: {
    nestedProperties?: Record<string, string[]>;
  },
  handledTopLevel: ReadonlySet<string>
): NestedKeyPath[] {
  const nested = fixture.nestedProperties ?? {};
  const out = new Map<string, NestedKeyPath>();
  for (const [topLevelProperty, names] of Object.entries(nested)) {
    if (!handledTopLevel.has(topLevelProperty)) continue;
    for (const key of names) {
      const path = `${topLevelProperty}.${key}`;
      if (!out.has(path)) out.set(path, { topLevelProperty, key, path });
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildReport(targets: readonly TargetReport[]): NestedKeyCoverageReport {
  const sorted = [...targets].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const all = sorted.flatMap((t) => t.entries);
  const allShapes = sorted.flatMap((t) => t.shapeEntries);
  const count = (b: Bucket): number => all.filter((e) => e.bucket === b).length;
  const countShape = (b: ShapeBucket): number =>
    allShapes.filter((e) => e.bucket === b).length;
  return {
    summary: {
      targetCount: sorted.length,
      nestedKeyCount: all.length,
      sameSpelling: count('same-spelling'),
      providerHandled: count('provider-handled'),
      allowListed: count('allow-listed'),
      caseDivergence: count('case-divergence'),
      noSdkMember: count('no-sdk-member'),
      noWriteEvidence: count('no-write-evidence'),
      freshObjectTargets: sorted.filter((t) => t.freshObjectMapper === true).length,
      shapeClean: sorted.reduce((n, t) => n + t.shapeCleanCount, 0),
      shapeHandled: countShape('provider-handled'),
      shapeAllowListed: countShape('allow-listed'),
      arrayVsWrapper: countShape('array-vs-wrapper'),
      definitionMemberMissing: countShape('definition-member-missing'),
      shapeAmbiguous: countShape('ambiguous'),
    },
    targets: sorted,
  };
}

/** A blocking finding from either pass, normalized for reporting. */
export interface Divergence {
  readonly resourceType: string;
  readonly nestedKey: string;
  readonly bucket: Bucket | ShapeBucket;
  readonly detail?: string;
}

export function findDivergences(report: NestedKeyCoverageReport): readonly Divergence[] {
  const keyDivergences: Divergence[] = report.targets
    .flatMap((t) => t.entries)
    .filter(
      (e) =>
        e.bucket === 'case-divergence' ||
        e.bucket === 'no-sdk-member' ||
        e.bucket === 'no-write-evidence'
    )
    .map((e) => ({
      resourceType: e.resourceType,
      nestedKey: e.nestedKey,
      bucket: e.bucket,
      ...(e.sdkNearMiss !== undefined
        ? {
            detail:
              e.bucket === 'no-write-evidence'
                ? `SDK has \`${e.sdkNearMiss}\`, but the provider never writes it`
                : `SDK has \`${e.sdkNearMiss}\``,
          }
        : {}),
    }));
  const shapeDivergences: Divergence[] = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'array-vs-wrapper' || e.bucket === 'definition-member-missing')
    .map((e) => ({
      resourceType: e.resourceType,
      nestedKey: e.nestedKey,
      bucket: e.bucket,
      ...(e.sdkDetail !== undefined ? { detail: e.sdkDetail } : {}),
    }));
  return [...keyDivergences, ...shapeDivergences];
}

/**
 * Allow-list entries that no longer match any audited key — must be pruned.
 *
 * Uses the MATCHED allow key recorded on each allow-listed verdict rather than
 * re-deriving it from `nestedKey`: since #1448 the key pass's audited unit is a
 * PATH, so a terminal-name entry (`…#DNSName`) that legitimately silenced
 * `Origins.DNSName` would otherwise be reported stale.
 */
export function findStaleAllowListEntries(
  report: NestedKeyCoverageReport,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): string[] {
  const used = new Set(
    [
      ...report.targets.flatMap((t) => t.entries),
      ...report.targets.flatMap((t) => t.shapeEntries),
    ]
      .filter((e) => e.bucket === 'allow-listed')
      .map((e) => e.allowMatchKey ?? allowKey(e.resourceType, e.nestedKey))
  );
  return [...allowList.keys()].filter((k) => !used.has(k)).sort();
}

function renderMarkdown(report: NestedKeyCoverageReport): string {
  const lines: string[] = [];
  lines.push('# Nested CFn->SDK key-divergence coverage matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/gen-nested-key-coverage.ts — DO NOT EDIT BY HAND. -->'
  );
  lines.push('<!-- Regenerate: `vp run gen:nested-key-coverage`. -->');
  lines.push('');
  lines.push(
    'For every SDK provider that forwards a nested CFn config blob, diffs the ' +
      "blob's nested property names (from the CFn registry schema fixtures) " +
      "against the SDK client's model member names. A CFn key with no " +
      'same-spelling SDK member and no explicit mention in the provider source ' +
      'is a WRITE-SIDE SILENT DROP (the #1370 class): the SDK serializer drops ' +
      'unknown keys, so the templated value never reaches AWS.'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Audited targets: **${report.summary.targetCount}**`);
  lines.push(`- Nested CFn key paths audited: **${report.summary.nestedKeyCount}**`);
  lines.push(`- Same spelling in SDK model: **${report.summary.sameSpelling}**`);
  lines.push(`- Explicitly handled in provider: **${report.summary.providerHandled}**`);
  lines.push(`- Allow-listed pass-throughs (does NOT block CI): **${report.summary.allowListed}**`);
  lines.push(`- **Case divergences (blocks CI): ${report.summary.caseDivergence}**`);
  lines.push(`- **No SDK member (blocks CI): ${report.summary.noSdkMember}**`);
  lines.push(
    `- Write-evidence pass — fresh-object targets audited: **${report.summary.freshObjectTargets}**`
  );
  lines.push(`- **No write evidence (blocks CI): ${report.summary.noWriteEvidence}**`);
  lines.push(`- Shape pass — bare-array pairs clean: **${report.summary.shapeClean}**`);
  lines.push(`- Shape pass — explicitly handled in provider: **${report.summary.shapeHandled}**`);
  lines.push(
    `- Shape pass — allow-listed (does NOT block CI): **${report.summary.shapeAllowListed}**`
  );
  lines.push(`- **Array-vs-wrapper divergences (blocks CI): ${report.summary.arrayVsWrapper}**`);
  lines.push(
    `- **Definition-member-missing divergences (blocks CI): ${report.summary.definitionMemberMissing}**`
  );
  lines.push(`- Shape pass — ambiguous (visible, non-blocking): **${report.summary.shapeAmbiguous}**`);
  lines.push('');

  const divergences = findDivergences(report);
  if (divergences.length > 0) {
    lines.push('## Divergences — BLOCKS CI');
    lines.push('');
    lines.push(
      'Each key below is templated by CFn but never reaches AWS: either it maps ' +
        'to no SDK member at all, or (for a fresh-object target) the SDK member ' +
        'exists and the provider never writes it. Add the CFn->SDK conversion to ' +
        'the provider (naming the CFn spelling, and WRITING the SDK member), or ' +
        'add a `NESTED_KEY_ALLOW_LIST` entry with a rationale in ' +
        'scripts/gen-nested-key-coverage.ts.'
    );
    lines.push('');
    // Key-pass rows carry a `Top.Key` PATH; shape-pass rows carry a bare
    // definition member (the shape pass is per definition, not per path).
    lines.push('| Resource type | CFn nested key / path | Bucket | SDK detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of divergences) {
      lines.push(
        `| \`${d.resourceType}\` | \`${d.nestedKey}\` | ${d.bucket} | ${d.detail ?? '—'} |`
      );
    }
    lines.push('');
  } else {
    lines.push('## Divergences');
    lines.push('');
    lines.push(
      'None. Every audited nested CFn key either matches an SDK member spelling ' +
        'or is explicitly named by its provider — and on a fresh-object target, ' +
        'its SDK member is also WRITTEN somewhere in the provider.'
    );
    lines.push('');
  }

  const allowListed = [
    ...report.targets.flatMap((t) => t.entries).filter((e) => e.bucket === 'allow-listed'),
    ...report.targets.flatMap((t) => t.shapeEntries).filter((e) => e.bucket === 'allow-listed'),
  ];
  if (allowListed.length > 0) {
    lines.push('## Allow-listed pass-throughs');
    lines.push('');
    lines.push('| Resource type | CFn nested key / path | Rationale |');
    lines.push('| --- | --- | --- |');
    for (const e of allowListed) {
      lines.push(`| \`${e.resourceType}\` | \`${e.nestedKey}\` | ${e.rationale ?? ''} |`);
    }
    lines.push('');
  }

  lines.push('## Per-provider handled keys');
  lines.push('');
  lines.push(
    'Keys with no same-spelling SDK member that the provider explicitly names ' +
      '(conversion maps / special-case handling). Listed so a rename in the ' +
      'provider that orphans one of these is visible in the diff.'
  );
  lines.push('');
  lines.push('| Resource type | CFn nested key path |');
  lines.push('| --- | --- |');
  for (const t of report.targets) {
    for (const e of t.entries) {
      if (e.bucket === 'provider-handled') {
        lines.push(`| \`${e.resourceType}\` | \`${e.nestedKey}\` |`);
      }
    }
  }
  lines.push('');

  const shapeHandled = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'provider-handled');
  if (shapeHandled.length > 0) {
    lines.push('## Shape pass — provider-handled re-shapings');
    lines.push('');
    lines.push(
      'CFn members whose SHAPE diverges from the same-spelled SDK member ' +
        '(bare array vs `{Quantity, Items}` wrapper, or missing from the ' +
        'same-named SDK interface) that the provider explicitly names. A ' +
        'provider rename that orphans one of these is visible in the diff.'
    );
    lines.push('');
    lines.push('| Resource type | CFn definition | Member | Pass | SDK detail |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const e of shapeHandled) {
      lines.push(
        `| \`${e.resourceType}\` | \`${e.definition}\` | \`${e.nestedKey}\` | ${e.pass} | ${
          e.sdkDetail ?? '—'
        } |`
      );
    }
    lines.push('');
  }

  const ambiguous = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'ambiguous');
  if (ambiguous.length > 0) {
    lines.push('## Shape pass — ambiguous (non-blocking)');
    lines.push('');
    lines.push('| Resource type | CFn definition | Member |');
    lines.push('| --- | --- | --- |');
    for (const e of ambiguous) {
      lines.push(`| \`${e.resourceType}\` | \`${e.definition}\` | \`${e.nestedKey}\` |`);
    }
    lines.push('');
  }

  lines.push('## Audited targets');
  lines.push('');
  lines.push(
    '| Resource type | Provider | SDK client | Key style | Fresh-object | Nested key paths | Unmatched definitions |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of report.targets) {
    lines.push(
      `| \`${t.resourceType}\` | \`${t.providerFile}\` | \`${t.sdkClientPackage}\` | ` +
        `${t.keyStyle} | ${t.freshObjectMapper ? 'yes' : 'no'} | ${t.nestedKeyCount} | ` +
        `${t.unmatchedDefinitions.length} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

/** Default SDK-model directory for a client package. Overridable in tests. */
export const defaultModelsDir = (sdkClientPackage: string): string =>
  resolve(repoRoot, 'node_modules', sdkClientPackage, 'dist-types/models');

export function loadReport(
  targetList: readonly NestedKeyTarget[] = NESTED_KEY_TARGETS,
  // Injection point so the two SDK-parse floors below are provable in the
  // RED direction (the repo's checker rules: a CI-blocking fence must be
  // shown to fire) — the member and interface parses are SEPARATE visitors
  // over the same files, so either can regress alone.
  resolveModelsDir: (sdkClientPackage: string) => string = defaultModelsDir,
  // Test seam (issue #1448): point the walk at a scratch COPY of the providers
  // tree so the SHIPPED `--check` exit path — and the write-collector floor,
  // which nothing else can reach — are provable against REAL provider code
  // carrying an injected regression, with `src/` untouched.
  providersDir: string = PROVIDERS_DIR
): NestedKeyCoverageReport {
  const sdkMembersByPackage = new Map<string, Set<string>>();
  const sdkInterfacesByPackage = new Map<string, Map<string, Map<string, SdkMemberType>>>();
  const literalsByFile = new Map<string, Set<string>>();
  const writtenByFile = new Map<string, ProviderWriteEvidence>();
  const expandedByFile = new Map<string, ProviderWriteEvidence>();
  const handledByFile = new Map<string, Map<string, Set<string>>>();

  /**
   * Source resolver for the WHOLE-BLOB HAND-OFF walk (issue #1445). Scoped to
   * SIBLING modules of the provider — `./agentcore-case-convert.js`, where the
   * tree's one real generic converter lives — and deliberately not to package
   * imports or parent directories: the walk only needs "does this callee name
   * members of its own?", and widening the resolver would pull the whole
   * `src/` graph into a per-file parse for no measured gain. Honors
   * `providersDir`, so a `--providers-dir=` scratch copy resolves its OWN
   * sibling and a regression injected there is seen.
   */
  const importSourceCache = new Map<string, string | undefined>();
  const resolveImportSource = (specifier: string): string | undefined => {
    if (!specifier.startsWith('./')) return undefined;
    const base = specifier.slice(2).replace(/\.js$/, '');
    if (base.length === 0 || base.includes('/')) return undefined;
    const path = join(providersDir, `${base}.ts`);
    if (!importSourceCache.has(path)) {
      importSourceCache.set(path, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    }
    return importSourceCache.get(path);
  };

  const targets: TargetReport[] = [];
  for (const target of targetList) {
    const fixturePath = join(FIXTURE_DIR, fixtureFilename(target.resourceType));
    if (!existsSync(fixturePath)) {
      throw new Error(
        `missing CFn schema fixture for ${target.resourceType} — run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\``
      );
    }
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      nestedProperties?: Record<string, string[]>;
      definitionShapes?: Record<string, Record<string, string>>;
    };
    // The refresher omits `nestedProperties` entirely for a type with zero
    // nested names, so absence is only an error when the target expects a
    // non-zero yield — for a `minNestedKeys: 0` target it just means
    // "nothing to audit".
    if (!fixture.nestedProperties && target.minNestedKeys > 0) {
      throw new Error(
        `fixture for ${target.resourceType} has no nestedProperties capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1373)'
      );
    }
    if (!fixture.definitionShapes) {
      throw new Error(
        `fixture for ${target.resourceType} has no definitionShapes capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1378)'
      );
    }

    let sdkMembers = sdkMembersByPackage.get(target.sdkClientPackage);
    let sdkInterfaces = sdkInterfacesByPackage.get(target.sdkClientPackage);
    if (!sdkMembers || !sdkInterfaces) {
      const modelsDir = resolveModelsDir(target.sdkClientPackage);
      if (!existsSync(modelsDir)) {
        throw new Error(`missing SDK model typings dir: ${modelsDir}`);
      }
      sdkMembers = collectSdkMemberNames(modelsDir);
      if (sdkMembers.size < MIN_SDK_MEMBERS_PER_CLIENT) {
        throw new Error(
          `SDK member parse for ${target.sdkClientPackage} collapsed to ` +
            `${sdkMembers.size} names (< ${MIN_SDK_MEMBERS_PER_CLIENT}) — parser regression?`
        );
      }
      sdkInterfaces = collectSdkInterfaces(modelsDir);
      // The interface parse shares the member floor: interfaces carry the
      // same PropertySignatures, so a collapse below the floor is the same
      // parser regression.
      const interfaceMemberCount = [...sdkInterfaces.values()].reduce((n, m) => n + m.size, 0);
      if (interfaceMemberCount < MIN_SDK_MEMBERS_PER_CLIENT) {
        throw new Error(
          `SDK interface parse for ${target.sdkClientPackage} collapsed to ` +
            `${interfaceMemberCount} members (< ${MIN_SDK_MEMBERS_PER_CLIENT}) — parser regression?`
        );
      }
      sdkMembersByPackage.set(target.sdkClientPackage, sdkMembers);
      sdkInterfacesByPackage.set(target.sdkClientPackage, sdkInterfaces);
    }

    const providerPath = join(providersDir, target.providerFile);
    let literals = literalsByFile.get(target.providerFile);
    let written = writtenByFile.get(target.providerFile);
    let handled = handledByFile.get(target.providerFile);
    if (!literals || !written || !handled) {
      const source = readFileSync(providerPath, 'utf8');
      literals = collectStringLiterals(source, target.providerFile);
      written = collectWriteEvidence(
        source,
        target.providerFile,
        REVERSE_MAP_FUNCTION_PREFIXES,
        resolveImportSource
      );
      handled = parseProviderSource(source, providerPath).handled;
      literalsByFile.set(target.providerFile, literals);
      writtenByFile.set(target.providerFile, written);
      handledByFile.set(target.providerFile, handled);
    }
    const handledTopLevel = handled.get(target.resourceType);
    if (!handledTopLevel || handledTopLevel.size === 0) {
      throw new Error(
        `${target.providerFile} declares no handledProperties for ${target.resourceType} — ` +
          'target table out of date?'
      );
    }

    // Write-collector regression floors (issues #1432 / #1448). A collapsed
    // parse would fail in the LOUD direction — every same-spelling key flags —
    // but as dozens of bogus divergences rather than one legible error, so name
    // the real cause. Only opted-in targets consult the evidence, so only they
    // need the floors. TWO floors, because the collector now has two outputs
    // that regress independently: the NAME set (a broken write-shape visitor)
    // and the SCOPE index (a broken value resolution, which would leave every
    // name collected and every scope empty).
    if (target.freshObjectMapper === true) {
      const nameFloor = target.minWrittenMembers ?? MIN_WRITTEN_MEMBERS_PER_PROVIDER;
      if (written.written.size < nameFloor) {
        throw new Error(
          `written-member parse for ${target.providerFile} collapsed to ` +
            `${written.written.size} names (< ${nameFloor}) — parser regression?`
        );
      }
      if (target.minWriteScopes !== undefined) {
        const populatedScopes = [...written.scopes.values()].filter((s) => s.size > 0).length;
        if (populatedScopes < target.minWriteScopes) {
          throw new Error(
            `write-scope resolution for ${target.providerFile} collapsed to ` +
              `${populatedScopes} non-empty scopes (< ${target.minWriteScopes}) — ` +
              'parser regression?'
          );
        }
      }
      // THIRD floor (issue #1445): the hand-off walk regresses independently of
      // both sets above — a broken import resolution or genericity test leaves
      // every NAME collected and every SCOPE populated while silently finding
      // zero hand-offs, which flags a correct provider by the dozen instead of
      // naming the cause. Only a target whose opt-in DEPENDS on the walk
      // declares it, and it counts EXPANDING points only (see
      // {@link countExpandingHandoffPoints} for why the raw count is vacuous).
      if (target.minHandoffPoints !== undefined) {
        const points = countExpandingHandoffPoints(written, sdkInterfaces);
        if (points < target.minHandoffPoints) {
          throw new Error(
            `whole-blob hand-off walk for ${target.providerFile} collapsed to ` +
              `${points} blob-carrying hand-off point(s) (< ${target.minHandoffPoints}) — ` +
              'parser regression?'
          );
        }
      }
    }

    const nestedKeys = nestedKeyPathsForTarget(fixture, handledTopLevel);
    if (nestedKeys.length < target.minNestedKeys) {
      throw new Error(
        `${target.resourceType} yielded only ${nestedKeys.length} nested keys ` +
          `(< ${target.minNestedKeys}) — fixture capture or handledProperties regression?`
      );
    }

    // Fold the hand-off points into the scopes with THIS target's SDK model
    // (issue #1445). Keyed by (provider file, SDK package) rather than by file
    // alone: every target sharing a file shares its package today, but the fold
    // is only valid for the model it was computed against.
    const expansionKey = `${target.providerFile} | ${target.sdkClientPackage}`;
    let expandedWriteEvidence = expandedByFile.get(expansionKey);
    if (expandedWriteEvidence === undefined) {
      expandedWriteEvidence = expandGenericHandoffScopes(written, sdkInterfaces);
      expandedByFile.set(expansionKey, expandedWriteEvidence);
    }

    const shapeResult = classifyTargetShapes(
      target,
      fixture.definitionShapes,
      sdkInterfaces,
      literals
    );

    targets.push({
      resourceType: target.resourceType,
      providerFile: target.providerFile,
      sdkClientPackage: target.sdkClientPackage,
      keyStyle: target.keyStyle,
      freshObjectMapper: target.freshObjectMapper === true,
      nestedKeyCount: nestedKeys.length,
      entries: classifyTarget(
        target,
        nestedKeys,
        sdkMembers,
        literals,
        NESTED_KEY_ALLOW_LIST,
        expandedWriteEvidence
      ),
      shapeEntries: shapeResult.entries,
      shapeCleanCount: shapeResult.cleanCount,
      unmatchedDefinitions: shapeResult.unmatchedDefinitions,
    });
  }
  return buildReport(targets);
}

const USAGE =
  'Usage: node scripts/gen-nested-key-coverage.ts [--check] [--providers-dir=<path>]\n' +
  '  --check               fail on a divergence instead of writing the matrix\n' +
  '  --providers-dir=<p>   TEST SEAM: audit a scratch copy of the providers tree\n' +
  '                        (requires --check; the writer path must only ever\n' +
  '                        render docs/_generated from src/)\n';

function main(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  // An unrecognized flag must NOT silently fall through to the WRITER path:
  // `--chekc` would rewrite the committed matrix and exit 0, and the SPACE form
  // `--providers-dir /tmp` would slip past the `--providers-dir=` prefix test
  // below. Same guard shape (and same reason) as `refresh-cfn-schemas.mjs`.
  const unknown = argv.filter(
    (a) => a.startsWith('-') && a !== '--check' && !a.startsWith('--providers-dir=')
  );
  if (unknown.length > 0) {
    process.stderr.write(`Unknown flag(s): ${unknown.join(', ')}\n${USAGE}`);
    process.exit(1);
  }
  // Nothing else is positional either — a bare argument is almost certainly a
  // mistyped flag or a path meant for `--providers-dir=`.
  const stray = argv.filter((a) => !a.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`Unexpected argument(s): ${stray.join(', ')}\n${USAGE}`);
    process.exit(1);
  }
  const checkMode = argv.includes('--check');
  // Test seam: point the provider walk at a scratch copy of the tree so the
  // shipped exit path can be exercised against a REAL provider file carrying an
  // injected regression, without ever mutating `src/` on disk (issue #1448).
  const dirFlag = argv.find((a) => a.startsWith('--providers-dir='));
  if (dirFlag !== undefined && !checkMode) {
    // The WRITER path would render the committed matrix from a scratch tree,
    // silently rewriting docs/_generated from code that is not `src/`.
    throw new Error('--providers-dir= is a --check-only test seam; refusing to write the matrix');
  }
  const report = loadReport(
    NESTED_KEY_TARGETS,
    defaultModelsDir,
    dirFlag ? resolve(dirFlag.slice('--providers-dir='.length)) : PROVIDERS_DIR
  );

  const stale = findStaleAllowListEntries(report);
  if (stale.length > 0) {
    process.stderr.write(
      'nested-key-coverage: FAIL — stale NESTED_KEY_ALLOW_LIST entr(ies) match no audited ' +
        'divergence. Remove them from scripts/gen-nested-key-coverage.ts:\n' +
        stale.map((k) => `  ${k}\n`).join('')
    );
    process.exit(1);
  }

  if (checkMode) {
    const divergences = findDivergences(report);
    if (divergences.length > 0) {
      process.stderr.write(
        'nested-key-coverage: FAIL — nested CFn->SDK key divergence(s) detected.\n' +
          'These template keys never reach AWS. Either they match NO member of the\n' +
          'SDK request shape, so the serializer drops them (the #1370 CloudFront /\n' +
          '#1304 MetricTimeZone class), or — for a fresh-object target — the SDK\n' +
          'member exists and the provider never WRITES it (the #1386 CodeBuild\n' +
          'BatchReportMode class, issue #1432). Add the CFn->SDK conversion to the\n' +
          'provider (naming the CFn spelling, and writing the SDK member), or add a\n' +
          'NESTED_KEY_ALLOW_LIST entry with a rationale in\n' +
          'scripts/gen-nested-key-coverage.ts.\n\n'
      );
      for (const d of divergences) {
        const detail = d.detail ? ` (${d.detail})` : '';
        process.stderr.write(`  ${d.resourceType}: ${d.nestedKey} [${d.bucket}]${detail}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `nested-key-coverage: OK — ${report.summary.nestedKeyCount} nested key paths across ` +
        `${report.summary.targetCount} targets, 0 divergences ` +
        `(${report.summary.sameSpelling} same-spelling, ` +
        `${report.summary.providerHandled} provider-handled` +
        (report.summary.allowListed > 0 ? `, ${report.summary.allowListed} allow-listed` : '') +
        `); write-evidence pass 0 divergences across ` +
        `${report.summary.freshObjectTargets} fresh-object target(s); ` +
        `shape pass 0 divergences (${report.summary.shapeClean} clean, ` +
        `${report.summary.shapeHandled} provider-handled` +
        (report.summary.shapeAllowListed > 0
          ? `, ${report.summary.shapeAllowListed} allow-listed`
          : '') +
        (report.summary.shapeAmbiguous > 0
          ? `, ${report.summary.shapeAmbiguous} ambiguous`
          : '') +
        ').\n'
    );
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `nested-key-coverage: wrote nested-key-coverage.{json,md} — ` +
      `${report.summary.nestedKeyCount} nested key paths, ` +
      `${report.summary.caseDivergence} case divergence(s), ` +
      `${report.summary.noSdkMember} no-sdk-member key(s), ` +
      `${report.summary.noWriteEvidence} no-write-evidence key(s), ` +
      `${report.summary.arrayVsWrapper} array-vs-wrapper, ` +
      `${report.summary.definitionMemberMissing} definition-member-missing.\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nested-key-coverage: failed — ${message}\n`);
    process.exit(1);
  }
}
