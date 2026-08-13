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
 *   1. CFn side: the schema fixture's `nestedPropertyPaths` capture
 *      (tests/fixtures/cfn-schemas/<type>.json, refreshed by
 *      `node scripts/refresh-cfn-schemas.mjs`) lists every nested property
 *      CHAIN reachable beneath each top-level property. Only the provider's
 *      OWN `handledProperties` top-levels are audited — unhandled top-levels
 *      are already rejected pre-flight by `property-coverage`. The audited
 *      unit is the FULL PATH `Top.A.B` (issue #1464, deepening #1448's
 *      two-segment `Top.Key`), not a de-duplicated bare name: `ServiceRole`
 *      beneath `BuildBatchConfig` and `ServiceRole` beneath anything else are
 *      different facts, and so are `Environment.Type` and
 *      `Environment.EnvironmentVariables.Type`. Arrays are transparent — a
 *      list of `EnvironmentVariable` contributes
 *      `Environment.EnvironmentVariables.Name`, matching the write side, where
 *      `envs.map((v) => ({ name: … }))` puts `name` exactly one level down.
 *      The FLATTENED `nestedProperties` capture is still emitted alongside it
 *      and still feeds the per-target `minNestedKeys` calibration story; the
 *      key pass no longer reads it.
 *   2. SDK side: every property name declared in the SDK client's model
 *      typings (`node_modules/@aws-sdk/client-<svc>/dist-types/models/`),
 *      parsed via the TypeScript Compiler API.
 *   3. Provider side: every string literal in the provider source (AST-level,
 *      so comments do not count), excluding the reverse map's body
 *      ({@link REVERSE_MAP_FUNCTION_PREFIXES}). A key the provider names
 *      explicitly on the FORWARD path is evidence it converts / special-cases
 *      that key somewhere — but for a write-evidence target the literal is
 *      trusted only WITH scoped delivery proof (issue #1393 item 2, below).
 *
 * A CFn nested key is a FLAGGED divergence when its spelling (after the
 * target's declared key style — `exact` for PascalCase SDK models like
 * CloudFront / CloudWatch / API GW v2, `lower-first` for camelCase models
 * like ECS) matches NO SDK member AND the provider does not demonstrably
 * convert it. Through issue #1393 the conversion evidence was the FILE-GLOBAL
 * literal alone, and that heuristic was measured rescuing broken write paths
 * (a key named legitimately by a reverse map or an unrelated top-level
 * vouched for every same-spelled occurrence anywhere in the file — the
 * pre-#1426 S3 lifecycle defects sat exactly there) and masking
 * case-divergences. For a {@link NestedKeyTarget.freshObjectMapper} target
 * the literal now also needs one of (see the branch in
 * {@link classifyTarget} for the full reasoning):
 *   - a genuine SDK member, written at the RESOLVED parent scope, whose
 *     case-folded name equals the audited key; or
 *   - a declared {@link NestedKeyTarget.terminalRenames} entry that resolves
 *     on the write side (`ExposedHeaders` -> `ExposeHeaders`); conversions
 *     real but invisible to the write walk carry `passes: ['key']`
 *     allow-list entries instead.
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
 * tree AT THE ORIGINAL `readCurrentState`-only exclusion, it withdrew 8 names
 * from `s3-bucket-provider.ts` (`BucketName`, `BucketEncryption`,
 * `CorsConfiguration`, `LoggingConfiguration` and the four `*Configurations`
 * plurals), 71 from `codebuild-provider.ts`, and 42 from `ecs-provider.ts`
 * (via `readCurrentStateService` / `readCurrentStateTaskDefinition`, which
 * only the PREFIX match reaches) — exactly the names a reverse map invents.
 * Issue #1520 widened the exclusion to the whole `read*` / `*ToCfn` reverse
 * families; the measured literal-set delta of THAT step is recorded on the
 * constant itself.
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
 * The credit is then bounded to the blob. As shipped in #1445 that bound came
 * from the SDK model's own reference graph ({@link reachableSdkMemberNames}),
 * because a flat scope could not express "beneath". Since #1464 the write index
 * is PATH-keyed, so the bound is a PATH-PREFIX test ({@link isHandoffCovered}):
 * a hand-off recorded at `containerDefinitions.linuxParameters` credits exactly
 * the paths at or beneath it. Crediting the whole ENCLOSING scope instead would
 * have been the rubber stamp — `ContainerDefinitions` carries both that hand-off
 * AND `convertPortMappings`, whose missing `containerPortRange` is a REAL silent
 * drop the walk must keep reporting — and the prefix test is strictly tighter
 * than the model fold was (it also drops the fold's bare-name union, where an
 * `Items` hand-off reached 217 unrelated CloudFront members).
 * {@link reachableSdkMemberNames} now serves only
 * {@link countExpandingHandoffPoints}, the parser-regression floor.
 *
 * THE BUILDER IDIOM (issue #1474)
 * -------------------------------
 * The third recognizer, and the narrowest. A provider that assembles a sub-blob
 * by MUTATION —
 *
 *     const mapped: AnomalyDetectorConfiguration = {};
 *     if (configuration['MetricTimeZone'] !== undefined) mapped.MetricTimezone = …;
 *     if (ranges !== undefined) mapped.ExcludedTimeRanges = ranges.map(…);
 *     params.Configuration = mapped;
 *
 * — names every member it delivers, per member, on the forward path. The
 * evidence the pass wants EXISTS; only its AST location differs from a
 * literal's. {@link resolveLiterals} resolves `mapped` to the EMPTY literal it
 * was declared with and stops, so `Configuration` scoped to nothing and all
 * three of its children landed in `no-write-evidence`. That is a FALSE
 * POSITIVE, and it is why `AWS::CloudWatch::AnomalyDetector` could not opt in.
 *
 * A BUILDER is recognized as: a local binding whose initializer is an OBJECT
 * LITERAL (empty or partial), populated afterwards by property / element-access
 * assignments onto THAT BINDING, and reaching a write. The three halves are
 * each load-bearing:
 *   - The LITERAL initializer is what makes the object's identity known. A
 *     `const out = makeThing()` or a `let out;` seeded later is refused: the
 *     object may be someone else's, and a write onto it is not attributable.
 *   - DECLARATION IDENTITY, never the bare name ({@link builderAssignmentChain}).
 *     An unrelated `out` in a sibling method resolves to its own declaration
 *     and vouches for nothing — the bare-name weakness recorded as known bound
 *     (3) is deliberately not inherited here.
 *   - The credit is bounded to the BUILDER, not to the enclosing scope. That
 *     bound is the same one #1445's review proved load-bearing: a whole-scope
 *     credit would have hidden `ContainerPortRange`, and a sibling object
 *     mutated in the same function is exactly that trap one recognizer over.
 * Delivery is the CALLER's question and stays there: {@link walkBuilderAt} runs
 * only from {@link recordAt}, which runs only where a WRITE takes the value, and
 * the write sites are already filtered by {@link feedsOnlyComparison} /
 * {@link isComparisonOnlyLiteral}. A builder that is never handed to a write —
 * or handed only to a diff — is therefore never reached at all.
 *
 * The credit lands at the SAME path a literal would have got, at full depth: an
 * assignment chain `out.Rule.DefaultRetention = { Mode }` opens the intermediate
 * scopes on the way down rather than flattening onto the builder's path.
 *
 * Recognizing the shape is MONOTONE — it only ever adds scoped members — so no
 * target gained a finding; measured, the tree's total residual fell 290 -> 260.
 *
 * THE SPREAD-AND-PATCH FORWARDER (issue #1475)
 * --------------------------------------------
 * The fourth recognizer, and the one the genericity test structurally cannot
 * host. `CloudFrontDistributionProvider.convertToSdkFormat` is —
 *
 *     const result = { ...config };          // <- delivers EVERY member verbatim
 *     if (result['Comment'] == null) result['Comment'] = '';
 *     for (const [cfnKey, sdkKey] of Object.entries(TOP_LEVEL_CFN_TO_SDK)) {
 *       result[sdkKey] = result[cfnKey];
 *       delete result[cfnKey];               // <- the spread no longer vouches here
 *     }
 *     …                                      // ~30 more named patches
 *     return result;
 *
 * — a function that names 30+ members, so {@link isGenericConverter} rejects it
 * (correctly, by its own rule), while the SPREAD alone delivers everything the
 * patches never touch. {@link registerSpreadHandoff} credits exactly that: a
 * literal that spreads a BAG-DERIVED seed (the #1445 taint root — a config read
 * back off `GetDistributionConfig` still measures as nothing) registers the
 * write path as a hand-off scope, BOUNDED by an exclusion set
 * ({@link ProviderWriteEvidence.handoffExclusions}): the first-segment keys the
 * function `delete`s off the seeded binding. Without the exclusion, a rename
 * that writes the WRONG SDK key would be vouched for by the very spread it just
 * removed the key from. Delete keys are resolved through the one computed shape
 * the tree uses — `for (const [cfnKey, sdkKey] of Object.entries(TABLE))` /
 * `for (const k of TABLE)` over a LITERAL table — and a delete whose key set
 * cannot be bounded refuses the WHOLE registration, fail-closed. A binding
 * REASSIGNED as a whole is refused for the builder's reason. The same rule now
 * also guards the ORIGINAL spread-only forward: {@link deliversWholeBlob}
 * refuses a binding that has deletes on it, handing the site to the bounded
 * registration instead of a full wildcard that would ignore the deletes — and
 * refuses a VERBATIM member forward whose subtree the root binding deletes
 * into (`delete config['VC']['Id']` then `{ VC: config['VC'] }`), where no
 * literal remains to carry a bounded credit at all. Deletes on the RESOLUTION
 * CHAIN between a write and its seed literal (a helper-returned seed whose
 * RECEIVING binding is deleted from) travel via the chain-source walk in
 * {@link registerSpreadHandoff}.
 *
 * What is deliberately NOT excluded is recorded as known bound (9): a member
 * the patches OVERWRITE stays credited through the enclosing spread, and the
 * spread delivers the seed's spelling VERBATIM. The issue's own model — "every
 * key the template carries reaches AWS through the spread; the named patches
 * only rename / wrap specific keys" — is what the recognizer encodes, and the
 * two-sided fence (delete exclusions + the key pass judging every non-SDK
 * spelling at full strictness) is what keeps it from being the rubber stamp
 * the issue warned it could become: deleting the `IPV6Enabled -> IsIPV6Enabled`
 * rename from the real provider still exits non-zero, via the key pass
 * (`case-divergence` — the literal evidence disappears with the map entry and
 * the installed model's `Ipv6Enabled` is the near-miss), and that fence is
 * pinned by a real-code probe.
 *
 * WHY THE PASS IS OPT-IN PER TARGET, AND WHICH TARGETS ARE IN
 * -----------------------------------------------------------
 * Measured against the real tree. Counts are would-be `same-spelling` key PATHS
 * with no scoped write evidence, at the four recognizer stages: BEFORE the
 * hand-off walk, after it, after the BUILDER recognizer (#1474), and after the
 * SPREAD-AND-PATCH recognizer (#1475). RE-MEASURED
 * for #1464 — the audited unit is now the FULL chain, so both the denominators and
 * the residuals moved, and the #1448/#1445 numbers are kept in brackets so the
 * shift is visible rather than asserted:
 *
 *   target                             before      walk     +builder   +spread   status
 *   AWS::CodeBuild::Project             0 /  95   0 /  95    0 /  95    0 /  95  opted in (#1432)   [0/90 -> 0/90]
 *   AWS::ApiGatewayV2::Api              6 /   6   0 /   6    0 /   6    0 /   6  OPTED IN (#1445)   [6/6 -> 0/6]
 *   AWS::ApiGatewayV2::Stage            5 /   5   0 /   5    0 /   5    0 /   5  OPTED IN (#1445)   [5/5 -> 0/5]
 *   AWS::ApiGatewayV2::Authorizer       2 /   2   0 /   2    0 /   2    0 /   2  OPTED IN (#1445)   [2/2 -> 0/2]
 *   AWS::ApiGatewayV2::Integration      0 /   0   0 /   0    0 /   0    0 /   0  OPTED IN (#1445)   [0/0 -> 0/0]
 *   AWS::ApiGatewayV2::Route            0 /   0   0 /   0    0 /   0    0 /   0  OPTED IN (#1445)   [0/0 -> 0/0]
 *   AWS::ECS::TaskDefinition           30 / 136   0 / 136    0 / 136    0 / 136  OPTED IN (#1472)   [25/115 -> 1/115]
 *   AWS::ECS::Service                  45 /  56   0 /  56    0 /  56    0 /  56  OPTED IN (#1473)   [44/54 -> 5/54]
 *   AWS::CloudWatch::AnomalyDetector   30 /  30   3 /  30    0 /  30    0 /  30  OPTED IN (#1474)   [29/29 -> 3/29]
 *   AWS::S3::Bucket                   130 / 152 125 / 152   98 / 152   81 / 152  OPTED IN (#1540)   [#1520 renames: 81 -> 50; #1540 hops + scoped/terminal renames: 50 -> 0]
 *   AWS::CloudFront::Distribution     162 / 162 162 / 162  162 / 162    0 / 162  OPTED IN (#1475)   [110/112 -> 110/112]
 *   AWS::AppSync::GraphQLApi            0 /  33   0 /  33    0 /  33    0 /  33  OPTED IN (#609)
 *   AWS::AppSync::DataSource           10 /  27  10 /  27   10 /  27   10 /  27  OPTED IN (#1597) [all 10 FIXED in the provider, now 0/27]
 *   AWS::AppSync::Resolver              0 /   9   0 /   9    0 /   9    0 /   9  OPTED IN (#1597)
 *   AWS::Lambda::EventSourceMapping     0 /  37   0 /  37    0 /  37    0 /  37  key pass only (#1393 item 3)
 *                                     -------   -------    -------    -------
 *                                        410       290        260         81
 *
 * The `AWS::Lambda::EventSourceMapping` row (issue #1393 item 3) is flat for a
 * different reason, and it is NOT opted into the write-evidence pass — so its
 * denominator is the TOTAL audited path count (37), not the write-audited
 * subset the opted-in rows use. It is excluded from the stage totals for the
 * same reason the AppSync rows are: no stage moves it. The
 * provider forwards each config blob VERBATIM (`params.X = properties['X'] as
 * <SdkType>`) rather than hand-building an SDK object, so the top-level member
 * write already vouches for every path beneath it and the pass has nothing to
 * find — 0/37 even when forced on, which is the measurement the calibration
 * test pins. For a verbatim forwarder the KEY pass is the whole audit: a
 * CFn-side member the SDK spells differently rides the cast to AWS as an
 * unknown key with no code change to notice it.
 *
 * The three AppSync rows joined AFTER the four recognizer stages, so their
 * columns are flat (no stage moves them) and they — like the EventSourceMapping
 * row above, four excluded rows in total — are excluded from the stage totals
 * above. Flat does NOT mean zero, and the split is the point:
 * `GraphQLApi` and `Resolver` measured 0 on their first run because the #609
 * backfill had already wired every member (31 of GraphQLApi's 33 paths are
 * same-spelling WITH scoped write evidence; its 2 `Tags.*` paths are
 * allow-listed, since AppSync models tags as a flat Record<string, string>
 * rather than CFn's [{Key, Value}] list), while `DataSource` measured 10 —
 * two nested silent-drop families the opt-in itself uncovered, fixed in the
 * provider by #1597, so the type now measures 0/27.
 *
 * CloudFront's 162 -> 0 is 160 spread/scope-covered plus 2 allow-listed with
 * `passes: ['write']` (`Tags.Key` / `Tags.Value` — genuinely written by
 * `toSdkTags`, but one SDK wrapper level below the CFn transparent-array
 * chain; see their entries). S3's column values are the HISTORICAL stage
 * measurements; its road from 81 to the #1540 opt-in at 0 is the bracket
 * note and reason (C).
 *
 * The RECORDED, MEASURED reasons the remaining targets cannot opt in — none
 * of them "add an allow-list entry", which is what the issue forbids:
 *
 * (A) [RESOLVED by issues #1472 / #1473] ECS's six residuals were REAL SILENT
 *     DROPS found BY this walk: `ContainerDefinitions.PortMappings.ContainerPortRange`
 *     (SDK `PortMapping.containerPortRange`, which `convertPortMappings` never
 *     wrote) and `LoadBalancers.AdvancedConfiguration` plus its four members
 *     `{AlternateTargetGroupArn, ProductionListenerRule, RoleArn,
 *     TestListenerRule}` (SDK `LoadBalancer.advancedConfiguration` — the
 *     blue/green deployment block `convertLoadBalancers` never converted). Both
 *     are now written by the provider (the port range explicitly, the
 *     blue/green block via the shared `pascalToCamelCaseKeys` hand-off), so both
 *     ECS targets measure 0 and are opted in. The pre-fix counts stay in the
 *     table as the record that the walk, not a hand audit, surfaced them.
 *
 *     #1464 briefly RE-BROKE that opt-in and then closed the cause. Deepening
 *     the audited unit to the full chain made
 *     `ProxyConfiguration.ProxyConfigurationProperties.{Name,Value}` report
 *     `no-write-evidence` on `AWS::ECS::TaskDefinition` — a FALSE positive, since
 *     `convertProxyConfiguration` writes both; the CFn segment
 *     `ProxyConfigurationProperties` is simply the SDK's `properties`, a RENAME
 *     the case-insensitive parent match cannot absorb. That is what
 *     {@link NestedKeyTarget.segmentRenames} is for, and the entry is
 *     staleness-fenced ({@link findStaleSegmentRenames}) so it cannot rot into
 *     an inert exception. Allow-listing it was refused: the entry would have
 *     silenced a CI-blocking bucket for a reason unrelated to delivery.
 *
 * (B) [RESOLVED by issue #1474] The BUILDER IDIOM
 *     (`const out: any = {}; out.Foo = …; return out;`) was a per-member write
 *     the SCOPE index could not see. `CloudWatchAnomalyDetectorProvider.
 *     buildPutParams` builds `Configuration` exactly that way, which was all
 *     three of its residuals (`ExcludedTimeRanges` / `StartTime` / `EndTime`
 *     were written all along, just not where the scope index looked), so that
 *     target measures 0 and is opted in. `S3BucketProvider` uses the same idiom
 *     in `applyWebsiteConfiguration` / `applyObjectLockConfiguration` /
 *     `applyReplicationConfiguration`, which is the 125 -> 98 half of its
 *     residual. The pre-fix counts stay in the table as the record that these
 *     were FALSE POSITIVES, not drops.
 *
 * (C) S3's residual, RE-MEASURED after issue #1495 closed the silent-drop half.
 *     The split that mattered was "is the terminal member written ANYWHERE in
 *     the file?", and as of #1474 it was 78 written-somewhere + **20 never
 *     written at all** — CONFIRMED write-side silent drops, the shape this
 *     whole pass exists to find. #1495 wired every one of the 20
 *     (`LoggingConfiguration.TargetObjectKeyFormat`, the four
 *     `ReplicationConfiguration.Rules.Destination` blocks
 *     `AccessControlTranslation` / `EncryptionConfiguration` / `Metrics` /
 *     `ReplicationTime`, `Rules.SourceSelectionCriteria`,
 *     `LifecycleConfiguration.TransitionDefaultMinimumObjectSize`, and
 *     `BucketEncryption…BlockedEncryptionTypes`), taking the residual
 *     **98 -> 81 and the never-written count 20 -> 0**. The pinned test is
 *     INVERTED accordingly: an empty never-written set is now the assertion,
 *     so a re-drop fails by name.
 *
 *     Only 13 of the 20 cleared the BUCKET, which is the informative part: the
 *     other 7 are written and still fail to resolve at the audited chain, for
 *     the same three structural reasons the surviving 81 have —
 *       - a CFn segment the SDK RENAMES (CFn `LoggingConfiguration` is the
 *         SDK's `BucketLoggingStatus.LoggingEnabled`;
 *         `WebsiteConfiguration.RoutingRules.RedirectRule` is `Redirect`,
 *         `.RoutingRuleCondition` is `Condition`);
 *       - an SDK-only WRAPPER segment (CFn's
 *         `BucketEncryption.ServerSideEncryptionConfiguration` LIST is the
 *         SDK's `ServerSideEncryptionConfiguration.Rules`);
 *       - a member CFn nests that the SDK HOISTS onto the request
 *         (`TransitionDefaultMinimumObjectSize` sits on
 *         `PutBucketLifecycleConfigurationRequest`, not inside
 *         `LifecycleConfiguration`);
 *       - a per-item PUT API whose SDK top-level is SINGULAR where CFn's is
 *         plural (`AnalyticsConfigurations` -> `AnalyticsConfiguration`, same
 *         for Inventory / Metrics / IntelligentTiering).
 *     All four are what {@link NestedKeyTarget.segmentRenames} exists for.
 *     Issue #1520 DECLARED them ({@link S3_BUCKET_SEGMENT_RENAMES}: the
 *     Logging wrapper, the Website Redirect/Condition pair, the encryption
 *     wrapper chain + ApplyServerSideEncryptionByDefault, the four
 *     plural->singular per-item PUT tops) and widened the reverse-map
 *     exclusion, which moved the OPT-IN-FORCED residual 81 -> 50.
 *
 *     [RESOLVED by issue #1540] The remaining 50 fell to 0 through four
 *     measured mechanisms, each closing one recorded family:
 *       - the BUILDER-BEHIND-BINDING hop in {@link resolveBuilders}: a
 *         builder returned from a `.map()` callback held in a plain binding
 *         (`const rules = cfg.Rules.map((r) => { const sdkRule = {…}; … })`)
 *         now credits its mutations — lifecycle 19 -> 4 on that alone;
 *       - the FOR-OF taint hop: the element of a bag-derived array is bag
 *         data, so the per-item config loops' verbatim `Tags: tagFilters`
 *         forwards register as whole-blob hand-offs and wildcard-credit
 *         `TagFilters.Key` / `.Value` (Analytics / Metrics /
 *         IntelligentTiering);
 *       - SCOPED segment-rename keys (`'Parent.Segment'`): Notification's
 *         `S3Key.Rules` -> `FilterRules` and the destination wrappers
 *         (`DataExport.Destination` / `InventoryConfigurations.Destination`
 *         -> `Destination.S3BucketDestination`) without corrupting
 *         `LifecycleConfiguration.Rules` / `ReplicationConfiguration.Rules.
 *         Destination` — the collision class that blocked bare-name entries;
 *       - TERMINAL renames / relocations ({@link
 *         NestedKeyTarget.terminalRenames}, full-path-keyed,
 *         staleness-fenced): `Enabled` -> `IsEnabled`, the config-level
 *         `Prefix` / `AccessPointArn` -> `Filter.*` relocations, the
 *         encryption LIST -> `Rules`, and lifecycle's rule-level
 *         `ExpiredObjectDeleteMarker` / size constraints.
 *     Three shapes remain inexpressible BY DESIGN and carry reviewed
 *     `passes: ['write']` allow-list entries: the request-level
 *     `TransitionDefaultMinimumObjectSize` hoist and the two lifecycle
 *     `TagFilters` members forwarded through a destructured member of the
 *     `lifecycleRuleScope` helper's returned literal (member-level taint
 *     through a returned literal is a materially bigger analysis — the same
 *     wrapper-level class as CloudFront's `Tags.Key` / `Tags.Value`).
 *     The `Destination.BucketArn` / `BucketAccountId` terminals needed NO
 *     entry — the bag-derived member forwards register seed-key ALIASES
 *     (`registerSeedKeyHandoffs`) that cover the CFn spellings, and the
 *     staleness fence rejected the hand-authored entries as dead weight
 *     (measured, the fence's first live catch).
 *
 * (D) [RESOLVED by issue #1475] `CloudFrontDistributionProvider.convertToSdkFormat`
 *     is a SPREAD-AND-PATCH forwarder: `const result = { ...config }` delivers
 *     every member, then ~30 named patches rename / wrap specific keys. The
 *     genericity test rejects it on those names — correctly, by its own rule —
 *     so all 162 stayed unmeasurable until the fourth recognizer (THE
 *     SPREAD-AND-PATCH FORWARDER section below) credited the spread itself,
 *     bounded by the `delete result[cfnKey]` exclusions. The target is opted
 *     in at 0 findings; the pre-fix counts stay in the table as the record of
 *     what the shape hid.
 *
 * The counts under (B) / (C) / (D) — (C) being the one still open — remain
 * UNMEASURABLE rather than vouched-for where they stand: not a list of
 * confirmed silent drops, and not a clean bill of health.
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
 *   - CFn side — the audited unit became the PATH `Top.NestedKey`
 *     ({@link nestedKeyPathsForTarget}), so top-level `ServiceRole` and
 *     `BuildBatchConfig.ServiceRole` stopped being the same audited key.
 *   - Provider side — {@link collectWriteEvidence} indexed each written member
 *     name to every member written BENEATH the value it is written with,
 *     resolving `this.mapSource(source)` calls, `const`/`let` bindings, `?:` /
 *     `??` arms, array elements and `.map(cb)` callbacks the way the #1404 taint
 *     walk resolves its forwards.
 *
 * Deleting `serviceRole:` from the `buildBatchConfig` literal of the real
 * provider exits 1 naming `BuildBatchConfig.ServiceRole` (asserted by a
 * spawned `--check` against a scratch copy of the real tree), while the
 * name-global set still contains `serviceRole` — which is what makes the fix
 * measurable rather than asserted.
 *
 * ...AND SCOPED AT FULL DEPTH (issue #1464)
 * ------------------------------------------
 * #1448 stopped one level short, and it stopped there because of the FIXTURE,
 * not the critic: the `nestedProperties` capture is a flattened transitive
 * closure per top-level property, so `Environment.Type` and
 * `Environment.EnvironmentVariables.Type` were literally the same audited path
 * and the write index was flattened to match. Measured then: deleting either
 * one's write from a scratch copy of the real `codebuild-provider.ts` exited 0,
 * cleared by its cousin.
 *
 * The fixture now carries `nestedPropertyPaths` — the full `$ref`-resolved,
 * cycle-guarded chain per top-level ({@link extractNestedPropertyPaths} in
 * `scripts/refresh-cfn-schemas.mjs`) — and the write index is keyed by the
 * matching write PATH. So:
 *   - a path's terminal member is checked against the scope its FULL PARENT
 *     CHAIN maps to, not merely its top level;
 *   - a WHOLE-BLOB HAND-OFF credits by path PREFIX, which is both tighter and
 *     simpler than the #1445 fold through the SDK model;
 *   - a write that only ever appears LEXICALLY NESTED no longer opens a
 *     root-level scope of its own — including inside a `.map(v => ({ … }))`
 *     callback, which {@link resolveLiterals} follows and the suppression walk
 *     therefore has to follow too;
 *   - a segment the provider RENAMES rather than re-cases is declared per
 *     target ({@link NestedKeyTarget.segmentRenames}) and staleness-fenced.
 *
 * Measured on the real tree (spawned `--check` against scratch copies):
 *   - `environment: { type: … }` deleted -> exit 1 naming `Environment.Type`,
 *     with `Environment.EnvironmentVariables.Type` still clean;
 *   - `environmentVariables[].type` deleted -> exit 1 naming
 *     `Environment.EnvironmentVariables.Type`, with `Environment.Type` still
 *     clean.
 * The #1448 note also listed `source: { type: … }`; deleting THAT alone still
 * exits 0, and the reason changed — `mapSource`'s guard arm
 * `return { type: 'NO_SOURCE' }` is a genuine second write of `type` under
 * `source`, so "the provider never writes it" would be false. Deleting both
 * arms exits 1 naming `Source.Type` and `SecondarySources.Type`, which is what
 * distinguishes "a real second write" from the cousin-vouching this closed.
 *
 * The audited unit grew with the depth: 587 -> 703 paths across the 11 targets,
 * so every `minNestedKeys` floor was re-calibrated (see that field's doc), as
 * was ECS's `minWriteScopes` (34 -> 58 non-empty scopes: path keys split one
 * flattened scope into one per depth).
 *
 * WHAT THE FOUR RECOGNIZERS DO **NOT** CLOSE — MEASURED, NOT PREDICTED
 * -----------------------------------------------------------------------------------
 * All of the bounds below are RECORDED, not tracked — the two that were tracked
 * (issue #1464's per-PATH capture) are closed above, and what is left of them is
 * restated as (1) and (2) at their new, much smaller scope. The spread-and-patch
 * shape that sat here as the last unrecognized one is CLOSED by issue #1475 —
 * see the section above and its bounds under (9).
 *
 * Depth-scoping NARROWS the duplicate-name class further; it does not make it
 * vanish. Read this before writing "membership makes X non-regressing"
 * anywhere: the bullet #1448 replaced made exactly that over-promise one level
 * up, #1448's own replacement made it one level down, and the same mistake is
 * available again.
 *
 * (1) A DUPLICATE NAME AT THE **SAME PATH** still vouches, because the write
 *     index unions across write SITES. Two `environment: { … }` literals in
 *     different methods both contribute to the one `environment` scope, so a
 *     provider that stops writing a member on ONE code path is not fenced.
 *     Keeping per-site sets would not change the positive test — a key is
 *     cleared when ANY site covers it, which IS the union — so this is
 *     intrinsic to the question being asked, not a shortcut.
 *
 *     HAND-OFF POINTS ARE UNIONED THE SAME WAY (issue #1445), and it is
 *     measurable: `ApiGatewayV2Provider` forwards `DefaultRouteSettings` whole
 *     at TWO sites (create and update). Deleting only the create-side forward
 *     from a scratch copy of the real provider exits **0** — the update-side
 *     forward still vouches — and deleting BOTH exits 1 naming all five
 *     `DefaultRouteSettings.*` paths.
 *
 * (2) A LITERAL REACHED ONLY BY INDIRECTION STILL OPENS A ROOT SCOPE. Root
 *     suppression is LEXICAL: a property assignment nested inside another object
 *     literal is recorded only under its parent's path, but a literal that
 *     reaches the write through a helper's `return` or a `const` binding has no
 *     object-literal ancestor, so its members are ALSO recorded at depth 1.
 *     `mapSource`'s returned literal therefore yields both `source.type` (via the
 *     descent from `source: this.mapSource(source)`) and a bare `type` root.
 *     Harmless unless a nested member name COLLIDES with an audited top-level
 *     property of the same type — measured on the tree today: across the six
 *     opted-in targets, every path cleared by a hand-off wildcard is one of the
 *     13 API Gateway v2 blob members (6 `CorsConfiguration.*` + 5
 *     `DefaultRouteSettings.*` + 2 `JwtConfiguration.*`) or one of the ECS
 *     generic-converter blobs, and none is cleared by a stray root.
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
 * (4) [RESOLVED by issue #1520] THE REVERSE-MAP EXCLUSION WAS PREFIX-ONLY
 *     (`readCurrentState`). Two reverse-helper families escaped it and their
 *     CFn-spelled writes landed in the evidence: suffix-named helpers
 *     (`ecs-provider.ts`'s `volumesToCfn` / `containerDefinitionsToCfn`,
 *     `s3-bucket-provider.ts`'s `metricsSdkToCfn`) and the `read<Block>`
 *     builder-idiom family #1495 added (`readEncryption` / `readLifecycle` /
 *     `readLogging` / `readReplication`), which the #1474 BUILDER recognizer
 *     turned from empty seeds into fully populated scopes (S3's non-empty
 *     scope count 85 -> 144 came from exactly that). Measured on a variant of
 *     `s3-bucket-provider.ts` with the entire WRITE half deleted: all 17
 *     #1495 members still reported "written" — reverse-only credit on an
 *     `exact`-style target, the direction this bound warned would bite.
 *     {@link REVERSE_MAP_FUNCTION_PREFIXES} now matches the `read` prefix and
 *     the `*ToCfn` suffix; the measured literal-set cost of the widening (one
 *     key, `CorsConfiguration.CorsRules`) is recorded on that constant and
 *     carried by a reviewed allow-list entry.
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
 *     One safe direction is also crude and is left that way: a helper that
 *     names nothing but returns a SCALAR (`toDate(r['EndTime'])`) is accepted
 *     as a converter but is inert, because a scalar has no audited path
 *     BENEATH it and so the wildcard credits only the name that was already
 *     recorded. (`{ ...blob, Extra: 1 }` used to be the other crude-safe
 *     refusal here — the GENERICITY test still rejects a callee that names
 *     `Extra`, but the LITERAL itself is now credited by the #1475 spread
 *     recognizer, bounded per bound (9).)
 *
 * (6) THE PARENT CHAIN IS MATCHED CASE-INSENSITIVELY, THE TERMINAL MEMBER IS
 *     NOT ({@link normalizeWritePath}). A CFn->SDK segment spelling is routinely
 *     not the mechanical first-letter flip (`EFSVolumeConfiguration` ->
 *     `efsVolumeConfiguration`), and the critic has no per-segment style, so an
 *     exact parent match reported 16 members `ecs-provider.ts` demonstrably DOES
 *     write. The relaxation is bounded three ways: the terminal spelling — the
 *     only thing that proves delivery — is compared verbatim in BOTH the scope
 *     test and the SELF case of {@link isHandoffCovered}; the fold is applied
 *     one LEVEL at a time while descending the write index, never as a global
 *     lowercase union (which would merge the member sets of the 80 unrelated
 *     `name` / `Name`-style scope pairs `ecs-provider.ts` carries); and the
 *     divergent segment is itself an audited path judged at full strictness.
 *     A genuine RENAME is out of scope for the fold by construction and needs
 *     {@link NestedKeyTarget.segmentRenames}, which is staleness-fenced.
 *
 *     The hand-off wildcard is registered under the WRITE path and ALSO under
 *     the SEED's own CFn key as a SIBLING path (in both spellings), because the
 *     two disagree often enough to matter: `ECSProvider` writes
 *     `placementStrategy` for CFn's `PlacementStrategies`, and keying only by
 *     the write name left `PlacementStrategies.Type` / `.Field` with no scope at
 *     all.
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
 * (8) THE BUILDER RECOGNIZER IS SEED-LITERAL-ONLY AND FLOW-INSENSITIVE
 *     (issue #1474). Four shapes it deliberately refuses, all in the
 *     UNDER-crediting (flags correct code, loud) direction:
 *       - `const out = makeThing(); out.Foo = …` — a non-literal initializer.
 *         The object's identity is unknown, so a write onto it is not
 *         attributable to this file. `let out; out = {}; out.Foo = …` is
 *         refused for the same reason (the DECLARATION carries no literal),
 *         even though {@link resolveLiterals} does resolve that binding.
 *       - `let out = {}; out.Foo = 1; out = opaque(props);` — a binding
 *         REASSIGNED as a whole. Refused outright rather than ordered, because
 *         crediting the seed's members for a value that is no longer the seed
 *         is the false-CLEAR direction ({@link builderDeclarationOf}).
 *       - `out[k] = v` — a computed key names a VARIABLE, the same strictness
 *         {@link elementAccessName} applies everywhere else.
 *       - `Object.defineProperty(out, 'Foo', …)` onto a builder. The top-level
 *         walk records it as a root write; it is NOT credited under the
 *         builder's path. No provider does this today.
 *     And one in the OVER-crediting direction, shared with bound (1): the walk
 *     is FLOW-INSENSITIVE. It collects every assignment onto the binding
 *     anywhere in the binding's scope and never orders them against the
 *     delivery or against each other, so an assignment textually AFTER the
 *     delivery (`send({ Cfg: out }); out.Foo = 1;`) still credits `Cfg.Foo`,
 *     a member written on only ONE of two `if` arms counts for both, and a
 *     member `delete out.Foo`d before delivery counts as written. That is the
 *     same union residue (1) describes, at statement granularity; no provider
 *     in the tree writes to — or deletes from — a builder after handing it off.
 *     Ordering the walk would need a control-flow model, which is a materially
 *     bigger analysis than this one and buys nothing measurable today.
 *
 * (9) THE SPREAD RECOGNIZER EXCLUDES DELETES, NOT OVERWRITES, AND DELIVERS THE
 *     SEED'S SPELLING VERBATIM (issue #1475). Three bounds, deliberate:
 *       - An OVERWRITTEN member stays credited through the enclosing spread:
 *         `result['Logging'] = reshape(result['Logging'])` replaces the
 *         member, and a reshape that drops a sub-key is masked by the
 *         wildcard. That is the issue's own model ("the named patches only
 *         rename / wrap specific keys") and the statement-granularity twin of
 *         bounds (1) / (8) — the overwrite IS a write of the member, judged by
 *         the same flow-insensitive union everything else uses. The DELETE
 *         case is different in kind, not degree: after `delete result[k]` the
 *         member reaches AWS not at the wrong shape but NOT AT ALL, so it is
 *         excluded ({@link ProviderWriteEvidence.handoffExclusions}), and an
 *         unresolvable delete key refuses the whole registration fail-closed.
 *       - The exclusion is FIRST-SEGMENT wholesale: `delete result['A']['B']`
 *         excludes `A` entirely — over-excluding flags correct code (loud),
 *         under-excluding silences a real drop. Deletes are followed through
 *         the spread SOURCE's binding chain, PARAMETER deletes included
 *         (`const a = { ...config }; delete a['K']; { ...a }` carries `K`,
 *         and `delete config['K']` before a verbatim forward refuses the full
 *         hand-off — both #1475-review catches), but the scan is
 *         BINDING-ROOTED, not alias-aware: a delete through a SECOND binding
 *         to the same object (`const vc = result['VC']; delete vc['K'];`
 *         while `{ ...result['VC'] }` is spread) mutates the shared object
 *         invisibly — and a CALL EDGE is an alias the same way, in both
 *         directions (a caller that deletes then PASSES the binding to the
 *         helper whose literal spreads its parameter, and a
 *         `this.strip(result)` helper that deletes off its own parameter):
 *         the delete scan never crosses a call boundary. Both directions are
 *         pre-existing on the FULL hand-off path too, so the recognizer
 *         narrows the class rather than opening it. True alias analysis is a
 *         materially bigger job; no provider in the tree aliases — or passes
 *         to a deleting callee — a blob it spreads.
 *       - The spread delivers the seed's keys VERBATIM, so the credit is only
 *         sound where the CFn and SDK spellings agree — which the audited
 *         verdicts already encode: a same-spelling key IS the agreement, and
 *         every diverging spelling is judged by the key pass at full
 *         strictness. (The pre-existing spread-only forward in
 *         {@link deliversWholeBlob} has always had this property; the
 *         recognizer extends it, not the exposure.) A `delete` inside a
 *         GENERIC converter's own body remains bound (5)'s territory — a
 *         filtering converter names nothing and is still credited.
 *
 * Each of (1), (2), (8) and (9) is pinned by a test, so the bound is a recorded fact
 * rather than a surprise for the next reader — and the two bounds #1464 CLOSED
 * are pinned by their inverted twins (the same probes, now asserting the
 * divergence), so the closure cannot silently regress either.
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
 * `ecs-provider.ts` 233, `s3-bucket-provider.ts` 160, `codebuild-provider.ts`
 * 82, `apigatewayv2-provider.ts` 46, `cloudfront-distribution-provider.ts` 64,
 * `cloudwatch-anomaly-detector-provider.ts` **17**. (The BUILDER recognizer
 * moved none of them: an `out.Foo = …` assignment was always in the NAME set —
 * it was the SCOPE index that could not see it.) That last one is why the
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
   * RE-CALIBRATED TWICE, for the same reason both times — the audited UNIT
   * changed under the floors, so leaving them would have left a fence that no
   * longer fences anything:
   *   - #1448 moved from a de-duplicated NAME to a 2-segment `Top.Key` path
   *     (CodeBuild 57 -> 93, S3 115 -> 155, CloudWatch AnomalyDetector 21 -> 30);
   *   - #1464 moved from that to the FULL chain `Top.A.B` (CloudFront 121 -> 173,
   *     S3 155 -> 190, ECS TaskDefinition 121 -> 142, CodeBuild 93 -> 98, ECS
   *     Service 54 -> 56, CloudWatch AnomalyDetector 30 -> 31; the five API
   *     Gateway v2 targets are flat and did not move).
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
   * (`s3-bucket-provider.ts` 144, `ecs-provider.ts` 70, `codebuild-provider.ts`
   * 32, `cloudfront-distribution-provider.ts` 51,
   * `cloudwatch-anomaly-detector-provider.ts` 4, `apigatewayv2-provider.ts` 1).
   * FOUR of those moved with #1474's BUILDER recognizer, which opens the scopes
   * a mutated binding populates: S3 85 -> 144, ECS 58 -> 70, CloudFront
   * 23 -> 51, CloudWatch 2 -> 4. CodeBuild's 32 and API Gateway v2's 1 are
   * unchanged by it — CodeBuild measures 32 with the recognizer and 32 without,
   * its 23 -> 32 having come from #1464's path keys.
   * The spread is what forces the per-target declaration,
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
  /**
   * CFn-segment -> SDK-member renames for the INTERMEDIATE segments of an
   * audited path (issue #1464 review).
   *
   * The parent chain is otherwise matched case-insensitively, which covers the
   * `EFSVolumeConfiguration` -> `efsVolumeConfiguration` family but not a
   * genuine RENAME. Measured on `ecs-provider.ts`: CFn
   * `ProxyConfiguration.ProxyConfigurationProperties` is the SDK's
   * `ProxyConfiguration.properties`, so `…ProxyConfigurationProperties.Name` /
   * `.Value` reported `no-write-evidence` although `convertProxyConfiguration`
   * writes both — a FALSE POSITIVE that blocked the ECS opt-in. Declaring the
   * rename here is the honest fix; an allow-list entry would silence a
   * CI-blocking bucket for a reason that has nothing to do with delivery.
   *
   * Applies to NON-TERMINAL segments only. The terminal IS the audited key and
   * must keep being judged by the key pass at full strictness — a rename there
   * would be the pass rubber-stamping its own question.
   *
   * STALENESS-FENCED like {@link NESTED_KEY_ALLOW_LIST}: an entry that stops
   * doing work fails `--check` in BOTH modes and must be removed. "Doing work"
   * is measured, not assumed — {@link findStaleSegmentRenames} reports an entry
   * whose UN-RENAMED chain resolves in the write index (the SDK renamed the
   * member back), or whose CFn segment no longer appears in any audited path
   * (AWS dropped the property). A provider that simply stops WRITING the member
   * is deliberately NOT stale: that finding must reach the operator as the
   * divergence it is.
   */
  readonly segmentRenames?: Readonly<Record<string, string>>;
  /**
   * TERMINAL renames for audited paths (issue #1540), keyed by the FULL CFn
   * path. The value's LAST dotted part is the SDK member spelling the provider
   * actually writes; any earlier parts are scope insertions appended to the
   * (already renamed) parent chain. Three shapes, all measured on
   * `s3-bucket-provider.ts`:
   *   - a pure terminal rename: CFn `InventoryConfigurations.Enabled` is the
   *     SDK's `IsEnabled`;
   *   - a relocation: CFn puts `Prefix` at the config level, the SDK nests it
   *     under `Filter` (`'MetricsConfigurations.Prefix': 'Filter.Prefix'`);
   *   - both at once: CFn `…Destination.BucketArn` is the SDK's `Bucket`.
   *
   * {@link NestedKeyTarget.segmentRenames} deliberately never touches the
   * terminal ("the terminal IS the audited key"), and that stays true — this
   * map does not weaken the judgment, it REDIRECTS it: the renamed member is
   * still required to be scope-written verbatim at the (extended) chain, so a
   * provider that stops writing `IsEnabled` still fails by name. What the map
   * adds is the DECLARED CFn->SDK correspondence the case fold cannot express,
   * per path so one entry can never leak onto a same-named sibling.
   *
   * STALENESS-FENCED exactly like segmentRenames ({@link
   * findStaleTerminalRenames}): an entry whose UN-renamed terminal resolves is
   * dead weight and fails `--check`; an entry whose renamed terminal ALSO
   * fails to resolve keeps reporting the divergence rather than masking it.
   */
  readonly terminalRenames?: Readonly<Record<string, string>>;
}

/**
 * The write-collector floors shared by the five `apigatewayv2-provider.ts`
 * targets (issue #1445). Measured at opt-in and re-measured after #1464 made
 * the scope index path-keyed: 46 written member names, 1 non-empty write scope,
 * 3 BLOB-CARRYING hand-off points (69 raw hand-off PATHS, counted as 35 raw
 * NAMES before #1464 re-keyed them).
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
  // 30 -> 40 with the issue #609 `::Integration` backfill: the ten wired
  // properties raised the file's written-member yield from ~60 to 67, and the
  // hygiene band requires the floor to stay at or above half the measurement.
  minWrittenMembers: 40,
  minWriteScopes: 1,
  minHandoffPoints: 1,
} as const;

/**
 * Shared by the THREE AppSync targets, because both collector outputs are
 * per-FILE, not per-type: `GraphQLApi` / `DataSource` / `Resolver` are all
 * served by `appsync-provider.ts`, so a per-target floor would be three
 * spellings of the same measurement drifting apart on every backfill.
 *
 * Measured when issue #1597 opted the two remaining types in: 115 written
 * member names, 33 non-empty write scopes under the generator's own
 * reverse-map-excluding scoping (204 / 64 under the calibration test's
 * `['readCurrentState']`-only exclusion) — up from the 105 / 26 the
 * `GraphQLApi` entry recorded at ITS opt-in, because the DeltaSync /
 * AuthorizationConfig mappers this batch added write into the same file.
 *
 * `minWrittenMembers` is 105 rather than the `GraphQLApi` entry's old 100
 * because the hygiene band (>= half the calibration-scoped yield) now floors
 * it at 102 — the old value had drifted under the band as the file grew, and
 * a floor below the band fences nothing. No `minHandoffPoints`: the provider
 * hands off no blob generically, so the walk is not load-bearing for any of
 * the three.
 */
const APPSYNC_WRITE_FLOORS = {
  minWrittenMembers: 105,
  minWriteScopes: 24,
} as const;

/**
 * The one intermediate-segment RENAME in the tree (issue #1464 review).
 *
 * `ECSProvider.convertProxyConfiguration` maps the CFn key
 * `ProxyConfigurationProperties` onto the SDK's `properties` (a
 * `KeyValuePair[]`) — the provider says so in its own JSDoc, and
 * `proxyConfigurationToCfn` performs the inverse on the read side. Without the
 * rename the two children of a member the provider demonstrably WRITES report
 * `no-write-evidence`, which is the false positive that blocked the ECS opt-in
 * once #1464 deepened the audited unit.
 *
 * Declared on `AWS::ECS::TaskDefinition` ONLY, even though `AWS::ECS::Service`
 * shares the provider file: `ProxyConfiguration` is a TaskDefinition property,
 * so a Service copy would have no audited path to act on and
 * {@link findStaleSegmentRenames} would (correctly) report it as dead weight.
 * The map is per TARGET, not per provider file, for exactly that reason.
 */
const ECS_TASK_DEFINITION_SEGMENT_RENAMES = {
  ProxyConfigurationProperties: 'properties',
} as const;

/**
 * ECS TaskDefinition TERMINAL renames (issue #1393 item 2). The segment
 * rename above bridges `ProxyConfigurationProperties` when it is an
 * INTERMEDIATE segment (`….ProxyConfigurationProperties.Name`); when the
 * blob itself is the audited terminal the correspondence must be declared
 * here — `convertProxyConfiguration` writes the SDK's `properties`.
 */
const ECS_TASK_DEFINITION_TERMINAL_RENAMES = {
  'ProxyConfiguration.ProxyConfigurationProperties': 'properties',
} as const;

/**
 * CloudFront Distribution TERMINAL renames (issue #1393 item 2) — the
 * acronym-casing conversions `convertToSdkFormat` / `convertOrigin` perform.
 * The top-level / ViewerCertificate members are renamed by COMPUTED-KEY
 * loops over `TOP_LEVEL_CFN_TO_SDK` / `VIEWER_CERTIFICATE_CFN_TO_SDK`
 * (`result[sdkKey] = result[cfnKey]`), so the write walk sees no literal
 * member name; the declared entries resolve through the spread-and-patch
 * hand-off (issue #1475) whose exclusion sets the recognizer takes from
 * those same rename maps. The two origin-level entries are literal
 * element-access writes (`result['CustomHeaders'] = …`) and resolve
 * against the write index directly.
 */
const CLOUDFRONT_DISTRIBUTION_TERMINAL_RENAMES = {
  'DistributionConfig.IPV6Enabled': 'IsIPV6Enabled',
  'DistributionConfig.ViewerCertificate.AcmCertificateArn': 'ACMCertificateArn',
  'DistributionConfig.ViewerCertificate.IamCertificateId': 'IAMCertificateId',
  'DistributionConfig.ViewerCertificate.SslSupportMethod': 'SSLSupportMethod',
  'DistributionConfig.Origins.OriginCustomHeaders': 'CustomHeaders',
  'DistributionConfig.Origins.CustomOriginConfig.OriginSSLProtocols': 'OriginSslProtocols',
} as const;

/**
 * The S3 structural renames (issue #1520) — the four causes reason (C)
 * recorded, each one a CFn segment whose SDK counterpart the per-level case
 * fold cannot absorb:
 *
 *   - A CFn segment the SDK RENAMES, including an SDK-only WRAPPER level the
 *     CFn shape flattens (dotted value): CFn `LoggingConfiguration` is the
 *     SDK's `BucketLoggingStatus.LoggingEnabled` (PutBucketLogging);
 *     `WebsiteConfiguration.RoutingRules.RedirectRule` is `Redirect` and
 *     `.RoutingRuleCondition` is `Condition` (PutBucketWebsite).
 *   - An SDK-only wrapper around a CFn LIST: CFn
 *     `BucketEncryption.ServerSideEncryptionConfiguration` (a list) is the
 *     SDK's `ServerSideEncryptionConfiguration.Rules` (PutBucketEncryption) —
 *     expressed as two chained single-segment renames.
 *   - A per-item PUT API whose SDK top-level is SINGULAR where CFn's is
 *     plural: `AnalyticsConfigurations` -> `AnalyticsConfiguration`
 *     (PutBucketAnalyticsConfiguration), same for Inventory / Metrics /
 *     IntelligentTiering.
 *
 * The fourth recorded cause — `TransitionDefaultMinimumObjectSize`, a member
 * CFn nests inside `LifecycleConfiguration` that the SDK HOISTS onto
 * `PutBucketLifecycleConfigurationRequest` — is a TERMINAL, and terminals are
 * deliberately out of a rename's reach (the terminal IS the audited key), so
 * it carries a `passes: ['write']` allow-list entry instead; see it in
 * {@link NESTED_KEY_ALLOW_LIST}.
 */
const S3_BUCKET_SEGMENT_RENAMES = {
  LoggingConfiguration: 'BucketLoggingStatus.LoggingEnabled',
  RedirectRule: 'Redirect',
  RoutingRuleCondition: 'Condition',
  BucketEncryption: 'ServerSideEncryptionConfiguration',
  ServerSideEncryptionConfiguration: 'Rules',
  ServerSideEncryptionByDefault: 'ApplyServerSideEncryptionByDefault',
  AnalyticsConfigurations: 'AnalyticsConfiguration',
  InventoryConfigurations: 'InventoryConfiguration',
  MetricsConfigurations: 'MetricsConfiguration',
  IntelligentTieringConfigurations: 'IntelligentTieringConfiguration',
  // --- issue #1540: SCOPED entries ('Parent.Segment', matched on the ORIGINAL
  // CFn spellings) for segments whose bare name would leak onto an unrelated
  // family. ---
  // Notification: CFn `LambdaConfigurations` is the SDK's
  // `LambdaFunctionConfigurations` (bare — the name is unique to
  // notification); `Filter.S3Key` is `Key` (bare, unique); the `Rules` list
  // under S3Key is the SDK's `FilterRules` — scoped, because bare `Rules`
  // would corrupt `LifecycleConfiguration.Rules` and
  // `ReplicationConfiguration.Rules`.
  LambdaConfigurations: 'LambdaFunctionConfigurations',
  S3Key: 'Key',
  'S3Key.Rules': 'FilterRules',
  // Lifecycle: the legacy SINGULAR forms the CFn schema still accepts are
  // written through the plural SDK members (`mergeLegacySingular`). Scoped so
  // the entries can never leak beyond the lifecycle rule.
  'Rules.Transition': 'Transitions',
  'Rules.NoncurrentVersionTransition': 'NoncurrentVersionTransitions',
  // Per-item config families + lifecycle rules: CFn `TagFilters` at the
  // config/rule level is the SDK's `Tags` under `Filter.And` (the provider
  // forwards the array verbatim there — the write registers as a whole-blob
  // hand-off, so the members beneath are wildcard-credited). Scoped per
  // family; replication's tag filter lives under an explicit CFn `Filter`
  // and resolves without an entry.
  'AnalyticsConfigurations.TagFilters': 'Filter.And.Tags',
  'IntelligentTieringConfigurations.TagFilters': 'Filter.And.Tags',
  'MetricsConfigurations.TagFilters': 'Filter.And.Tags',
  'Rules.TagFilters': 'Filter.And.Tags',
  // Analytics / Inventory destinations: CFn flattens the SDK's
  // `S3BucketDestination` wrapper level. Scoped because bare `Destination`
  // would corrupt `ReplicationConfiguration.Rules.Destination`.
  'DataExport.Destination': 'Destination.S3BucketDestination',
  'InventoryConfigurations.Destination': 'Destination.S3BucketDestination',
} as const;

/**
 * The S3 terminal renames / relocations (issue #1540) — see
 * {@link NestedKeyTarget.terminalRenames} for the mechanism and its fences.
 * Every value is verified against the provider's actual write site.
 */
const S3_BUCKET_TERMINAL_RENAMES = {
  // PutBucketInventoryConfiguration: `IsEnabled: (config['Enabled'] …)` and
  // `Filter: config['Prefix'] ? { Prefix … } : undefined`. The destination's
  // `BucketArn` -> `Bucket` / `BucketAccountId` -> `AccountId` terminals need
  // NO entry: the provider forwards them as bag-derived member accesses
  // (`Bucket: (s3Dest['BucketArn'] ?? …)`), which register a whole-blob
  // hand-off whose SEED-KEY ALIAS (`registerSeedKeyHandoffs`) already covers
  // the CFn spelling at the renamed chain — an entry there is dead weight the
  // staleness fence rejects, measured, not assumed.
  'InventoryConfigurations.Enabled': 'IsEnabled',
  'InventoryConfigurations.Prefix': 'Filter.Prefix',
  // PutBucketAnalyticsConfiguration: the config-level Prefix lands under
  // `Filter{,.And}` (single-condition branch writes `Filter = { Prefix }`);
  // the destination's `BucketArn` is alias-covered as above.
  'AnalyticsConfigurations.Prefix': 'Filter.Prefix',
  // PutBucketMetricsConfiguration / PutBucketIntelligentTieringConfiguration:
  // same Filter relocation for the config-level scope members.
  'MetricsConfigurations.Prefix': 'Filter.Prefix',
  'MetricsConfigurations.AccessPointArn': 'Filter.AccessPointArn',
  'IntelligentTieringConfigurations.Prefix': 'Filter.Prefix',
  // PutBucketEncryption: CFn's `ServerSideEncryptionConfiguration` LIST is the
  // SDK's `Rules` member of the same-named wrapper (the parent chain already
  // renames `BucketEncryption` onto that wrapper).
  'BucketEncryption.ServerSideEncryptionConfiguration': 'Rules',
  // Lifecycle rule-level members the SDK nests: the rule-level delete-marker
  // flag is written into `Expiration` (both branches), and the rule-level
  // size constraints land under `Filter{,.And}`.
  'LifecycleConfiguration.Rules.ExpiredObjectDeleteMarker': 'Expiration.ExpiredObjectDeleteMarker',
  'LifecycleConfiguration.Rules.ObjectSizeGreaterThan': 'Filter.ObjectSizeGreaterThan',
  'LifecycleConfiguration.Rules.ObjectSizeLessThan': 'Filter.ObjectSizeLessThan',
  // Notification: the `Rules` LIST itself (members are covered via the
  // scoped segment rename above).
  'NotificationConfiguration.LambdaConfigurations.Filter.S3Key.Rules': 'FilterRules',
  'NotificationConfiguration.QueueConfigurations.Filter.S3Key.Rules': 'FilterRules',
  'NotificationConfiguration.TopicConfigurations.Filter.S3Key.Rules': 'FilterRules',
  // --- issue #1393 item 2: the SAME correspondences the segment-rename map
  // already declares for INTERMEDIATE positions, now needed at TERMINAL
  // position too — the scoped literal rule no longer lets a file-global
  // literal vouch for these. Every value is verified against the provider's
  // actual write site (applyXxx / normalizeLifecycleRules /
  // applyNotificationConfiguration / applyWebsiteConfiguration). ---
  // PutBucketAccelerateConfiguration: `Status: config['AccelerationStatus']`.
  'AccelerateConfiguration.AccelerationStatus': 'Status',
  // PutBucketEncryption: `ApplyServerSideEncryptionByDefault: byDefault …`.
  'BucketEncryption.ServerSideEncryptionConfiguration.ServerSideEncryptionByDefault':
    'ApplyServerSideEncryptionByDefault',
  // PutBucketCors: `ExposeHeaders: rule['ExposedHeaders']`,
  // `MaxAgeSeconds: rule['MaxAge']`.
  'CorsConfiguration.CorsRules.ExposedHeaders': 'ExposeHeaders',
  'CorsConfiguration.CorsRules.MaxAge': 'MaxAgeSeconds',
  // PutBucketInventoryConfiguration: `Schedule: { Frequency:
  // config['ScheduleFrequency'] … }` (an SDK-only wrapper level).
  'InventoryConfigurations.ScheduleFrequency': 'Schedule.Frequency',
  // Lifecycle rule-level date/day members the SDK nests one level down
  // (`sdkRule.Expiration = { Days | Date }`,
  // `sdkRule.NoncurrentVersionExpiration = { NoncurrentDays }`), the legacy
  // SINGULAR blobs written through the plural members
  // (`mergeLegacySingular`), and the per-transition member renames
  // (`toSdkTransition` / `toSdkNvt`).
  'LifecycleConfiguration.Rules.ExpirationDate': 'Expiration.Date',
  'LifecycleConfiguration.Rules.ExpirationInDays': 'Expiration.Days',
  'LifecycleConfiguration.Rules.NoncurrentVersionExpirationInDays':
    'NoncurrentVersionExpiration.NoncurrentDays',
  'LifecycleConfiguration.Rules.NoncurrentVersionTransition': 'NoncurrentVersionTransitions',
  'LifecycleConfiguration.Rules.NoncurrentVersionTransition.TransitionInDays': 'NoncurrentDays',
  'LifecycleConfiguration.Rules.NoncurrentVersionTransitions.TransitionInDays': 'NoncurrentDays',
  'LifecycleConfiguration.Rules.Transition': 'Transitions',
  'LifecycleConfiguration.Rules.Transition.TransitionDate': 'Date',
  'LifecycleConfiguration.Rules.Transition.TransitionInDays': 'Days',
  'LifecycleConfiguration.Rules.Transitions.TransitionDate': 'Date',
  'LifecycleConfiguration.Rules.Transitions.TransitionInDays': 'Days',
  // PutBucketLogging: `TargetBucket: destinationBucket`, `TargetPrefix: …`
  // (the parent chain already renames onto BucketLoggingStatus.LoggingEnabled).
  'LoggingConfiguration.DestinationBucketName': 'TargetBucket',
  'LoggingConfiguration.LogFilePrefix': 'TargetPrefix',
  // PutBucketNotificationConfiguration: the config-array member itself
  // (`cfg.LambdaFunctionConfigurations = lambdas.map(…)`), the per-config
  // legacy singular `Event` written through `Events: [t['Event']]`, the
  // `Filter.S3Key` -> `Key` wrapper, and the ARN member renames.
  'NotificationConfiguration.LambdaConfigurations': 'LambdaFunctionConfigurations',
  'NotificationConfiguration.LambdaConfigurations.Event': 'Events',
  'NotificationConfiguration.LambdaConfigurations.Filter.S3Key': 'Key',
  'NotificationConfiguration.LambdaConfigurations.Function': 'LambdaFunctionArn',
  'NotificationConfiguration.QueueConfigurations.Event': 'Events',
  'NotificationConfiguration.QueueConfigurations.Filter.S3Key': 'Key',
  'NotificationConfiguration.QueueConfigurations.Queue': 'QueueArn',
  'NotificationConfiguration.TopicConfigurations.Event': 'Events',
  'NotificationConfiguration.TopicConfigurations.Filter.S3Key': 'Key',
  'NotificationConfiguration.TopicConfigurations.Topic': 'TopicArn',
  // PutBucketReplication: CFn `TagFilter` (single) is the SDK's `Tag`;
  // `And.TagFilters` is the SDK's `Tags`.
  'ReplicationConfiguration.Rules.Filter.TagFilter': 'Tag',
  'ReplicationConfiguration.Rules.Filter.And.TagFilters': 'Tags',
  // Per-item config families: the `TagFilters` ARRAY itself, forwarded
  // verbatim under the SDK's `Filter.And.Tags` (the members beneath are
  // covered by the scoped segment renames above; lifecycle's array is the
  // destructured-`lifecycleRuleScope` shape and carries an allow-list entry instead).
  'AnalyticsConfigurations.TagFilters': 'Filter.And.Tags',
  'IntelligentTieringConfigurations.TagFilters': 'Filter.And.Tags',
  'MetricsConfigurations.TagFilters': 'Filter.And.Tags',
  // PutBucketWebsite: the per-routing-rule blobs are written as the SDK's
  // `Redirect` / `Condition` (same correspondence the segment-rename map
  // declares for their interiors).
  'WebsiteConfiguration.RoutingRules.RedirectRule': 'Redirect',
  'WebsiteConfiguration.RoutingRules.RoutingRuleCondition': 'Condition',
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
    // Opted into the WRITE-EVIDENCE pass by issue #1475, once the
    // SPREAD-AND-PATCH recognizer landed. `convertToSdkFormat` seeds
    // `const result = { ...config }` off the tainted parameter and patches
    // ~30 named members around it; the spread delivers everything the patches
    // never touch, bounded by the `delete result[cfnKey]` exclusions the
    // recognizer resolves from TOP_LEVEL_CFN_TO_SDK. Measured at 0 findings:
    // 173 audited paths, 171 spread/scope-covered, 2 allow-listed
    // (`Tags.Key` / `Tags.Value` — written one SDK wrapper level below the
    // CFn chain, see their entries). Floors measured at opt-in: 64 written
    // names, 51 non-empty scopes, 14 expanding hand-off points
    // (`minHandoffPoints` deliberately 1, not 14 — see the API GW v2 floors
    // note for why a floor AT the measurement is the wrong fence).
    resourceType: 'AWS::CloudFront::Distribution',
    providerFile: 'cloudfront-distribution-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudfront',
    keyStyle: 'exact',
    minNestedKeys: 155,
    freshObjectMapper: true,
    minWrittenMembers: 40,
    minWriteScopes: 25,
    minHandoffPoints: 1,
    terminalRenames: CLOUDFRONT_DISTRIBUTION_TERMINAL_RENAMES,
  },
  {
    // Opted into the WRITE-EVIDENCE pass by issue #1474, once the BUILDER
    // recognizer landed. `buildPutParams` assembles `Configuration` as
    // `const mapped: AnomalyDetectorConfiguration = {}` populated by
    // `mapped.MetricTimezone = …` / `mapped.ExcludedTimeRanges = …`, so its
    // three residual paths (`Configuration.ExcludedTimeRanges` and that
    // array's `StartTime` / `EndTime`) were written all along and simply
    // invisible to a literal walk. Measured at 0 findings with the recognizer.
    resourceType: 'AWS::CloudWatch::AnomalyDetector',
    providerFile: 'cloudwatch-anomaly-detector-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudwatch',
    keyStyle: 'exact',
    minNestedKeys: 27,
    freshObjectMapper: true,
    // Measured at opt-in: 17 written member names (unchanged by the
    // recognizer — a builder assignment was always in the NAME set, it was the
    // SCOPE that could not see it), 4 non-empty write scopes (2 before the
    // recognizer: `Configuration` and `Configuration.ExcludedTimeRanges` were
    // both empty), 4 expanding hand-off points.
    minWrittenMembers: 12,
    // 2, and NOT the 3 the #1474 review proposed — the proposal was to make
    // this floor able to detect the BUILDER recognizer collapsing, and it
    // MEASURES as unable to, for a reason no floor value fixes. All three
    // states were counted on this provider:
    //     recognizer working, real provider          4 non-empty scopes
    //     recognizer COLLAPSED, real provider        2
    //     recognizer working, one real write deleted 2
    // The collapse and the genuine provider regression are the SAME number,
    // because the recognizer's entire contribution here is the single
    // `mapped.ExcludedTimeRanges = …` assignment (it opens `Configuration`
    // and `Configuration.ExcludedTimeRanges`). So a floor of 3 fires on BOTH:
    // it would turn "the provider stopped writing ExcludedTimeRanges" into
    // "parser regression?", which is exactly the miscalibration
    // {@link NestedKeyTarget.minHandoffPoints} records for API Gateway v2 —
    // a floor at the measurement makes every legitimate provider-side change
    // abort instead of reporting the divergence it really causes.
    // A recognizer collapse is NOT silent at 2: it re-surfaces the three
    // `Configuration.*` paths as `no-write-evidence`, so the shipped `--check`
    // fails CI naming them, the `reproduces the measured opt-in table` test
    // fails, and both real-code probes fail. Those are the instruments that
    // actually fence the recognizer; this floor fences the SCOPE-INDEX
    // collapse it was built for, which yields 0.
    minWriteScopes: 2,
    // Walk-dependent: with the hand-off points stripped, 27 of the 30
    // same-spelling paths flip to `no-write-evidence` (the whole
    // `SingleMetricAnomalyDetector` / `MetricMathAnomalyDetector` /
    // `MetricCharacteristics` / `Dimensions` forward), so the walk's own floor
    // is required. Deliberately 1 against a measured 4, for the reason spelled
    // out on {@link API_GATEWAY_V2_WRITE_FLOORS}: the four points are one per
    // audited blob top-level, a floor AT the measurement turns any legitimate
    // provider change into "parser regression?", and the collapse mode this
    // floor exists for yields 0.
    minHandoffPoints: 1,
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
    minNestedKeys: 4,
    freshObjectMapper: true,
    ...API_GATEWAY_V2_WRITE_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Integration',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    // 0 -> 3 with the issue #609 silent-drop backfill, which added the type's
    // only two nested blobs (`ResponseParameters` / `TlsConfig`) to
    // handledProperties; before it, the target audited nothing. 3, not the
    // measured 4: the hygiene band requires STRICT headroom so that AWS
    // dropping one schema property reports the missing path instead of
    // aborting as a fixture-capture regression.
    minNestedKeys: 3,
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
    // Opted in by the issue #609 backfill that wired the type's 13 remaining
    // silent-drop properties. Five of them are nested config blobs
    // (`UserPoolConfig` / `OpenIDConnectConfig` / `LambdaAuthorizerConfig` /
    // `AdditionalAuthenticationProviders` / `EnhancedMetricsConfig`), and the
    // provider builds FRESH SDK objects naming each member — the exact shape
    // `same-spelling` is silent for, hence `freshObjectMapper: true`. The
    // service also carries two irregular members the mechanical first-letter
    // flip gets WRONG (`IatTTL`/`AuthTTL` -> `iatTTL`/`authTTL`, not `iatTtl`),
    // which is precisely what this target fences. Measured at opt-in: 33
    // audited paths, 31 same-spelling with write evidence, 2 allow-listed
    // (`Tags.Key` / `Tags.Value` — CFn's tag LIST is an SDK `Record<string,
    // string>`, so neither member exists on the SDK side at all).
    // Re-measured after the #609 Resolver/DataSource batch wired the same
    // file's remaining 12 properties: 105 written member names / 26 non-empty
    // write scopes under the generator's own reverse-map-excluding scoping
    // (184 / 50 under the calibration test's `['readCurrentState']`-only
    // exclusion) — the Resolver/DataSource mappers write into the same
    // provider file the collector parses, so both yields grew; the two types
    // themselves are NOT targets yet — their schema fixtures pre-date the
    // definitionShapes / nestedPropertyPaths captures and need a re-capture
    // first (tracked in issue #1597, together with the HttpConfig
    // .AuthorizationConfig nested drop the blocked opt-in would catch). No
    // `minHandoffPoints`: the
    // provider hands off no blob generically, so the walk is not load-bearing
    // here. The two remaining AppSync types are now targets of their own
    // (issue #1597 re-captured their fixtures); the write floors moved to
    // {@link APPSYNC_WRITE_FLOORS} because all three share one provider file.
    resourceType: 'AWS::AppSync::GraphQLApi',
    providerFile: 'appsync-provider.ts',
    sdkClientPackage: '@aws-sdk/client-appsync',
    keyStyle: 'lower-first',
    minNestedKeys: 28,
    freshObjectMapper: true,
    ...APPSYNC_WRITE_FLOORS,
  },
  {
    // Opted in by issue #1597, once `scripts/refresh-cfn-schemas.mjs`
    // re-captured this type's fixture with the `definitionShapes` /
    // `nestedPropertyPaths` sections the generator requires (the old capture
    // pre-dated both, which is what BLOCKED the opt-in in the #609 backfill).
    //
    // The opt-in immediately found TWO nested silent-drop families, both
    // invisible to top-level property coverage because their containers
    // (`HttpConfig` / `DynamoDBConfig`) are handled properties:
    //   - `HttpConfig.AuthorizationConfig` (+ `.AuthorizationType` /
    //     `.AwsIamConfig.SigningRegion` / `.SigningServiceName`) — the drop
    //     the issue named; an IAM-signed HTTP data source reached AWS
    //     UNSIGNED.
    //   - `DynamoDBConfig.DeltaSyncConfig` (+ `.BaseTableTTL` /
    //     `.DeltaSyncTableName` / `.DeltaSyncTableTTL`) and
    //     `DynamoDBConfig.Versioned` — NOT in the issue; found by the critic
    //     itself, which is the point of the opt-in.
    // Both are fixed in `applyDataSourceConfig` / `readDataSource`, so this
    // target measures 0 findings across 27 audited paths.
    resourceType: 'AWS::AppSync::DataSource',
    providerFile: 'appsync-provider.ts',
    sdkClientPackage: '@aws-sdk/client-appsync',
    keyStyle: 'lower-first',
    minNestedKeys: 24,
    freshObjectMapper: true,
    ...APPSYNC_WRITE_FLOORS,
  },
  {
    // Opted in by issue #1597 alongside `DataSource`, same fixture re-capture.
    // Measured CLEAN on the first run — 9 audited paths (`CachingConfig` /
    // `PipelineConfig` / `Runtime` / `SyncConfig` incl.
    // `LambdaConflictHandlerConfig.LambdaConflictHandlerArn`), 0 findings —
    // because the #609 Resolver backfill wired every member through
    // `toSdkCachingConfig` / `toSdkSyncConfig` / `applyResolverConfig`. The
    // target still earns its place: it is what keeps the NEXT Resolver
    // property from being added as a top-level forward with its nested
    // members dropped.
    resourceType: 'AWS::AppSync::Resolver',
    providerFile: 'appsync-provider.ts',
    sdkClientPackage: '@aws-sdk/client-appsync',
    keyStyle: 'lower-first',
    minNestedKeys: 8,
    freshObjectMapper: true,
    ...APPSYNC_WRITE_FLOORS,
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
    minNestedKeys: 110,
    freshObjectMapper: true,
    // Measured on opt-in (#1472/#1473), re-measured after #1464 re-keyed the
    // scope index by PATH, and again after the #609 Service-property backfill
    // (which added ~58 audited nested paths under ServiceConnectConfiguration
    // / VolumeConfigurations / VpcLatticeConfigurations / Monitoring /
    // DeploymentController / ForceNewDeployment plus 5 generic whole-blob
    // hand-offs): nested keys 114, written 166, non-empty scopes 53,
    // expanding hand-off points 26 (the LinuxParameters-family generic
    // conversions both ECS targets clear through). Floors are set just below
    // those measurements.
    minWrittenMembers: 160,
    minWriteScopes: 50,
    minHandoffPoints: 24,
  },
  {
    // Opted in by issue #1472 alongside AWS::ECS::Service above (same
    // provider file, same measured yields — so its write floors move in step
    // with the Service target's; last re-measured with the #609 backfill).
    resourceType: 'AWS::ECS::TaskDefinition',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 125,
    freshObjectMapper: true,
    minWrittenMembers: 160,
    minWriteScopes: 50,
    minHandoffPoints: 24,
    segmentRenames: ECS_TASK_DEFINITION_SEGMENT_RENAMES,
    terminalRenames: ECS_TASK_DEFINITION_TERMINAL_RENAMES,
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
    minNestedKeys: 88,
    // Issue #1432: the fresh-object shape this target was added FOR is exactly
    // the one `same-spelling` cannot vouch for, and the #1386 sweep still
    // missed `BuildBatchConfig.BatchReportMode` under it. Measured at 0
    // findings today (55 same-spelling keys, all hand-named), so the opt-in
    // costs no allow-list entries and makes that fix non-regressing. Still 0
    // after #1448 made the evidence PATH-SCOPED (90 same-spelling paths), and
    // still 0 after #1464 took the scoping to FULL DEPTH (93 same-spelling
    // paths) — the deepening moved which write clears which path, not whether
    // the provider covers them.
    freshObjectMapper: true,
    // Measured: 82 written member names, 32 non-empty write scopes (23 before
    // #1464 — path keys split a flattened scope into one per depth).
    minWrittenMembers: 60,
    minWriteScopes: 20,
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
    // `readCurrentState`'s reverse map — so the then-file-global literal
    // heuristic classified both `provider-handled` no matter how broken the
    // WRITE path was. Item 2 of #1393 closed that: the literal now needs
    // scoped write evidence (or a resolving terminal rename), so the
    // per-family `TagFilters` / `TransitionInDays` paths are write-verified
    // and their strip-probes exist in the unit test; only the lifecycle
    // `TagFilters` array (destructured-`lifecycleRuleScope`, walker-invisible) stays
    // allow-list-gated. Rule-level `ExpiredObjectDeleteMarker`
    // is not reachable either — the shape pass matches CFn definitions to
    // same-named SDK interfaces, and `@aws-sdk/client-s3` spells it
    // `LifecycleRule`, so CFn's `Rule` sits in `unmatchedDefinitions` and the
    // whole lifecycle-rule blob is shape-unaudited.
    resourceType: 'AWS::S3::Bucket',
    providerFile: 's3-bucket-provider.ts',
    sdkClientPackage: '@aws-sdk/client-s3',
    keyStyle: 'exact',
    minNestedKeys: 170,
    // OPTED IN by issue #1540, which closed the 50-path residual #1520
    // recorded: the builder-behind-binding hop in `resolveBuilders` (lifecycle
    // 19 -> 4), the for-of taint hop (the per-item config loops' verbatim
    // `Tags` forwards register as hand-offs), SCOPED segment-rename keys
    // (notification / legacy-singular / per-family TagFilters / destination
    // wrappers), and TERMINAL renames ({@link S3_BUCKET_TERMINAL_RENAMES}).
    // Measured at 0 findings; the three shapes no mechanism can express carry
    // reviewed `passes: ['write']` allow-list entries (the request-level
    // `TransitionDefaultMinimumObjectSize` hoist and the two
    // destructured-`lifecycleRuleScope` lifecycle `TagFilters` members).
    freshObjectMapper: true,
    // Measured at opt-in (#1540): 157 written member names, 156 non-empty
    // write scopes, rounded down generously per the field docs.
    minWrittenMembers: 120,
    minWriteScopes: 110,
    // Deliberately 1, not the measured raw count — see the API GW v2 floors
    // note for why a floor AT the measurement is the wrong fence. S3's opt-in
    // DEPENDS on the walk (the TagFilters wildcard credits and the
    // destination seed-key aliases), so the floor is declared.
    minHandoffPoints: 1,
    segmentRenames: S3_BUCKET_SEGMENT_RENAMES,
    terminalRenames: S3_BUCKET_TERMINAL_RENAMES,
  },
  {
    // Opted in by issue #1393 item 3, after
    // `node scripts/refresh-cfn-schemas.mjs AWS::Lambda::EventSourceMapping`
    // re-captured the fixture with the `definitionShapes` /
    // `nestedPropertyPaths` sections the generator requires (the old capture
    // pre-dated both, the same blocker the AppSync opt-ins hit).
    //
    // This target is a FENCE, not a bug hunt, and #1393's own first comment
    // says so: the #1384 defect it grew out of (`Endpoints` is a map keyed by
    // an ENUM value, so there is no `KafkaBootstrapServers` member to miss)
    // is structurally invisible to a critic that compares model member NAMES,
    // and opting in does not close that class. What the opt-in DOES fence is
    // the provider's eight other forwarded blobs —
    // `SelfManagedKafkaEventSourceConfig`, `AmazonManagedKafkaEventSourceConfig`,
    // `DocumentDBEventSourceConfig`, `ScalingConfig`, `DestinationConfig`,
    // `LoggingConfig`, `MetricsConfig`, `ProvisionedPollerConfig` — every one
    // of which the provider forwards VERBATIM (`params.X = properties['X'] as
    // <SdkType>`), so a CFn-side member the SDK spells differently reaches AWS
    // as an unknown key with no code change to notice it.
    //
    // Measured at opt-in: 37 audited paths, 34 same-spelling, 1 explicitly
    // handled (`SelfManagedEventSource.Endpoints.KafkaBootstrapServers`), 2
    // allow-listed (`Tags.Key` / `Tags.Value` — see their entries), 0 blocking
    // findings.
    //
    // NOT a `freshObjectMapper`: the write-evidence pass asks "does the
    // provider WRITE the SDK member", which only means something where the
    // provider hand-builds the SDK object. Here the blobs are cast
    // pass-throughs, so the key pass IS the audit and a write floor would
    // fence nothing.
    resourceType: 'AWS::Lambda::EventSourceMapping',
    providerFile: 'lambda-eventsource-provider.ts',
    sdkClientPackage: '@aws-sdk/client-lambda',
    keyStyle: 'exact',
    minNestedKeys: 30,
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
    allowKey('AWS::ECS::Service', 'ForceNewDeployment.EnableForceNewDeployment'),
    {
      rationale:
        'CFn-only rollout-trigger member with NO per-member SDK counterpart: the ECS SDK ' +
        'models the whole ForceNewDeployment block as the single top-level boolean ' +
        '`forceNewDeployment` on UpdateService. ECSProvider.resolveForceNewDeployment ' +
        'translates {EnableForceNewDeployment: true} OR a ForceNewDeploymentNonce change ' +
        'into `forceNewDeployment: true` (issue #609) — a shape collapse neither the key ' +
        'pass (no same-spelled member exists) nor the write pass (the write is a ' +
        'different, top-level member) can express.',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::ECS::Service', 'ForceNewDeployment.ForceNewDeploymentNonce'),
    {
      rationale:
        'Same single-boolean collapse as ForceNewDeployment.EnableForceNewDeployment: ' +
        'the nonce has no SDK member of its own — a nonce CHANGE is what ' +
        'resolveForceNewDeployment turns into `forceNewDeployment: true` (issue #609).',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'Tags.Key'),
    {
      rationale:
        'Written by toSdkTags on the forward path (`.map(([Key, Value]) => ({ Key, Value }))`), ' +
        'but one wrapper level below the audited chain: the SDK Tags shape is the ' +
        '{ Items: Tag[] } wrapper, so the write scope is Tags.Items while the CFn ' +
        'transparent-array chain is Tags.Key. A wrapper-level insertion is neither a ' +
        'case fold nor a segmentRename, so the write pass cannot see it.',
      passes: ['write'],
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'Tags.Value'),
    {
      rationale:
        'Same wrapper-level insertion as Tags.Key: written by toSdkTags beneath the ' +
        'SDK { Items: Tag[] } wrapper (scope Tags.Items), one level below the CFn chain.',
      passes: ['write'],
    },
  ],
  [
    allowKey('AWS::ApiGatewayV2::Integration', 'ResponseParameters.ResponseParameters.Destination'),
    {
      rationale:
        "CFn models ResponseParameters as { '<statusCode>': { ResponseParameters: " +
        "[{ Destination, Source }] } } while CreateIntegration / UpdateIntegration take the " +
        "FLATTENED { '<statusCode>': { '<Destination>': '<Source>' } } — Destination becomes a " +
        'MAP KEY, so no `Destination` member exists anywhere in the SDK model to spell-match or ' +
        'to write. `toSdkResponseParameters` performs the fold (and `toCfnResponseParameters` ' +
        'the inverse for readCurrentState); both are pinned by unit tests, because a computed ' +
        'key is exactly what the write pass cannot credit. Same list-to-map shape difference as ' +
        'the AppSync GraphQLApi Tags.Key entry below (issue #609).',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::ApiGatewayV2::Integration', 'ResponseParameters.ResponseParameters.Source'),
    {
      rationale:
        'Same list-to-map fold as the Destination sibling: the CFn [{ Destination, Source }] ' +
        'list becomes the SDK\'s flat { "<Destination>": "<Source>" } map, so Source is a map ' +
        'VALUE and has no SDK member of its own (issue #609).',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::AppSync::GraphQLApi', 'Tags.Key'),
    {
      rationale:
        "AppSync models tags as a flat Record<string, string> (`tags`), not as CFn's " +
        '[{Key, Value}] list — the provider folds the list into that map on create ' +
        '(`tagMap[tag.Key] = tag.Value`) and diffs it via TagResource / UntagResource ' +
        'on update. There is therefore no `Key` member anywhere in the SDK model to ' +
        'spell-match or to write, which is a SHAPE difference the key and write passes ' +
        'cannot express, not a dropped key.',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::AppSync::GraphQLApi', 'Tags.Value'),
    {
      rationale:
        'Same list-to-map fold as Tags.Key: the CFn tag list becomes the SDK `tags` ' +
        'Record<string, string>, so no `Value` member exists on the SDK side.',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::Lambda::EventSourceMapping', 'Tags.Key'),
    {
      rationale:
        "Same list-to-map fold as the AppSync entries: Lambda models an event source " +
        "mapping's tags as a flat Record<string, string> (`Tags`), not as CFn's " +
        '[{Key, Value}] list, and the provider folds the list into that map on create ' +
        '(`Object.fromEntries(cfnTags.map((t) => [t.Key, t.Value]))`). No `Key` member ' +
        'exists anywhere in the SDK model to spell-match. ' +
        'READ THE VERDICT WITH CARE: the key pass reports this as `case-divergence` ' +
        '("SDK has KEY") rather than `no-sdk-member`, because the member index also ' +
        "carries enum const-object keys and `@aws-sdk/client-lambda`'s " +
        '`KafkaSchemaValidationAttribute` declares `KEY` / `VALUE` — a Kafka ' +
        'schema-validation attribute with nothing to do with tagging. A case fold ' +
        'would NOT fix this key; there is no member to fold onto.',
      passes: ['key', 'shape', 'write'],
    },
  ],
  [
    allowKey('AWS::Lambda::EventSourceMapping', 'Tags.Value'),
    {
      rationale:
        'Same list-to-map fold as Tags.Key, and the same spurious enum near-miss — ' +
        '`VALUE` is the other `KafkaSchemaValidationAttribute` member, not a tag ' +
        'member the provider could write.',
      passes: ['key', 'shape', 'write'],
    },
  ],
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
    allowKey('AWS::CloudFront::Distribution', 'DistributionConfig.CustomOrigin.OriginSSLProtocols'),
    {
      rationale:
        'Member of the legacy pre-2012 CustomOrigin block (LegacyCustomOrigin definition), ' +
        'unreachable from a modern template — same family as the CustomOrigin / DNSName ' +
        'entries. Path-scoped so it can never leak onto the MODERN ' +
        'Origins.CustomOriginConfig.OriginSSLProtocols, which carries a verified terminal ' +
        'rename instead (issue #1393).',
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
  [
    allowKey('AWS::S3::Bucket', 'LifecycleConfiguration.TransitionDefaultMinimumObjectSize'),
    {
      rationale:
        'Written by applyLifecycleConfiguration DIRECTLY on the ' +
        'PutBucketLifecycleConfigurationRequest (the SDK hoists it out of ' +
        '`LifecycleConfiguration`, where CFn nests it), so the audited chain ' +
        'can never resolve: a terminal rename redirects WITHIN the config ' +
        'object and cannot express a request-level hoist. Delivery is proven ' +
        'by the s3-replication-and-filter integ read-back (issue #1495) and ' +
        'the write is pinned by name in the #1495 write-evidence unit test ' +
        '(issues #1520 / #1540).',
      passes: ['write'],
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'LifecycleConfiguration.Rules.TagFilters.Key'),
    {
      rationale:
        'Forwarded verbatim into `Filter{,.And}.Tags` by ' +
        'applyLifecycleConfiguration, but through a chain the hand-off taint ' +
        'walk deliberately does not cross: the array reaches the write as a ' +
        'DESTRUCTURED member of the `lifecycleRuleScope` helper\'s returned ' +
        'literal (module-level since issue #1755, in-method `gatherScope` ' +
        'before it — the shape is unchanged), and member-level taint through a ' +
        'returned literal is a ' +
        'materially bigger analysis (issue #1540; same wrapper-level class as ' +
        'the CloudFront `Tags.Key` / `Tags.Value` entries). The equivalent ' +
        'per-item-config forwards (Analytics / Metrics / IntelligentTiering) ' +
        'ARE wildcard-credited via the for-of taint hop.',
      passes: ['write'],
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'LifecycleConfiguration.Rules.TagFilters.Value'),
    {
      rationale:
        'Same destructured-`lifecycleRuleScope` forward as the sibling ' +
        '`LifecycleConfiguration.Rules.TagFilters.Key` entry (issue #1540).',
      passes: ['write'],
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled'),
    {
      rationale:
        'Presence-encoded: the SDK EventBridgeConfiguration is an EMPTY struct, so the CFn ' +
        'boolean has no member to map onto — applyNotificationConfiguration writes ' +
        '`EventBridgeConfiguration: {}` when the COERCED boolean is true and omits the block ' +
        'when it is false, REFUSING any value coerceCfnBoolean cannot read (issue #1759). ' +
        'There is no write the terminal-rename mechanism could redirect to (issue #1393).',
      passes: ['key'],
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'LifecycleConfiguration.Rules.TagFilters'),
    {
      rationale:
        'Forwarded verbatim into `Filter{,.And}.Tags` by applyLifecycleConfiguration through ' +
        'the destructured-`lifecycleRuleScope` shape the hand-off taint walk deliberately does not ' +
        'cross — same class as the `LifecycleConfiguration.Rules.TagFilters.Key` / `.Value` ' +
        'write-pass entries, here for the ARRAY itself on the key pass (issue #1393). The ' +
        'per-item config families (Analytics / Metrics / IntelligentTiering) resolve via ' +
        'declared terminal renames and need no entry.',
      passes: ['key'],
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'CorsConfiguration.CorsRules'),
    {
      rationale:
        'Delivered by applyCorsConfiguration, which reads the CFn key via typed ' +
        'property access (`corsConfig.CorsRules.map(...)`) and writes the SDK ' +
        'spelling `CORSRules` — the literal walk deliberately counts neither a ' +
        'property ACCESS nor a type-literal member, and the only literal mention ' +
        'of the CFn spelling is `readCors`, excluded as a reverse map by the ' +
        '#1520 widening. Key pass only; the members BENEATH it need no entry — ' +
        'the per-level case fold resolves `CorsConfiguration.CorsRules` onto the ' +
        'written `CORSConfiguration.CORSRules` scope, so they stay write-audited ' +
        '(issue #1520).',
      passes: ['key'],
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
  /**
   * {@link NestedKeyTarget.segmentRenames} entries that DID work on this run.
   * Consumed by {@link findStaleSegmentRenames} — an entry the classifier never
   * needed must be removed, the same discipline the allow-list carries.
   */
  readonly usedSegmentRenames: readonly string[];
  /** Same contract for {@link NestedKeyTarget.terminalRenames} (issue #1540). */
  readonly usedTerminalRenames: readonly string[];
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
 * letter), so `readCurrentStatelessThing` is not swallowed by the `read`
 * prefix.
 *
 * WIDENED BY ISSUE #1520, in both directions the module header's bound (4)
 * and the #1520 measurement recorded:
 *   - the prefix is now `read` rather than `readCurrentState`. Issue #1495
 *     added CFn-spelled read-back writes inside `readEncryption` /
 *     `readLifecycle` / `readLogging` / `readReplication` — builder-idiom
 *     reverse helpers the old prefix did not cover, whose writes therefore
 *     landed in `evidence.written` and over-credited the write pass (measured:
 *     a variant of `s3-bucket-provider.ts` with the entire WRITE half deleted
 *     still reported all 17 #1495 members "written"). `apigatewayv2-provider.ts`'s
 *     `readApi` / `readStage` / `readIntegration` / `readRoute` /
 *     `readAuthorizer` are the same family.
 *   - a `*ToCfn` SUFFIX entry now matches too (`volumesToCfn` /
 *     `containerDefinitionsToCfn` / `metricsSdkToCfn` / `sdkNotifFilterToCfn`
 *     — reverse helpers named by suffix, previously bound (4)'s recorded gap).
 *     A suffix entry is spelled `*ToCfn` in the matcher list and requires a
 *     non-empty stem.
 *
 * Measured effect of the #1520 widening on the real tree (both passes, all
 * targets): the WRITE-pass residual of every target is unchanged (S3 stays at
 * its pre-rename 81) — on today's HEAD no write-pass path was credited ONLY by
 * a reverse-map write, so the widening's value there is the FENCE it restores:
 * with the reverse bodies excluded, deleting the #1495 write half makes the
 * checker name those members again (the #1495-HEAD state where the read-back
 * hunks alone kept all 17 reported "written" is exactly what this closes; the
 * RED-direction probe in the unit test pins it). The LITERAL-set withdrawal
 * moves exactly ONE key into a blocking bucket:
 * `CorsConfiguration.CorsRules` (case-divergence, SDK `CORSRules`) — its CFn
 * spelling was named only by `readCors`, while the forward conversion reads it
 * via property access (`corsConfig.CorsRules`), which the literal walk
 * deliberately does not count. That one carries a reviewed allow-list entry;
 * see it in {@link NESTED_KEY_ALLOW_LIST}.
 */
export const REVERSE_MAP_FUNCTION_PREFIXES: readonly string[] = ['read', '*ToCfn'];

/**
 * Does `name` match one of `matchers`? A `*Suffix` entry matches a name that
 * ENDS with `Suffix` on a non-empty stem; any other entry is a prefix that
 * must sit at a word boundary (the whole name, or followed by an uppercase
 * letter).
 */
const matchesFunctionPrefix = (name: string, matchers: readonly string[]): boolean =>
  matchers.some((p) =>
    p.startsWith('*')
      ? name.length > p.length - 1 && name.endsWith(p.slice(1))
      : name === p || (name.startsWith(p) && /[A-Z]/.test(name.charAt(p.length)))
  );

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
  /**
   * The NAME-GLOBAL write set — every member name written anywhere in the file.
   * Consulted only by {@link NestedKeyTarget.minWrittenMembers}; the
   * classification uses {@link scopes} / {@link handoffScopes}.
   */
  readonly written: ReadonlySet<string>;
  /**
   * WRITE PATH -> the member names written DIRECTLY beneath it (issue #1464).
   *
   * The key is a dotted chain of written member names in the provider's own
   * (SDK) spelling, so `environment` and `environment.environmentVariables` are
   * different scopes carrying different `type` members. Through #1448 the key
   * was a bare NAME and the value was the flattened transitive closure beneath
   * it, which is precisely why a member could vouch for its same-named cousin
   * one level down.
   *
   * Only a NON-NESTED write opens a root scope: a literal that is lexically
   * inside another object literal is recorded at its parent's path and nowhere
   * else, so `logsConfig: { cloudWatchLogs: { … } }` no longer creates a
   * top-level-looking `cloudWatchLogs` scope.
   */
  readonly scopes: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * WRITE PATHS delivered WHOLE (issue #1445, re-keyed by #1464): the value
   * written at this path is a sub-blob handed to a GENERIC key converter (or
   * forwarded verbatim), so everything AT OR BENEATH the path reaches AWS with
   * no per-member write to find.
   *
   * A path-prefix test is what credits the interior — `containerDefinitions.
   * linuxParameters` covers `containerDefinitions.linuxParameters.capabilities.
   * add` — and it replaces the #1445 fold through the SDK model's reference
   * graph. That fold existed only because a flat scope could not express
   * "beneath"; it also carried the bare-name union bound (an `Items` hand-off
   * reaching 217 CloudFront members), which the prefix test does not have.
   * {@link reachableSdkMemberNames} survives for the parser-regression floor
   * alone ({@link countExpandingHandoffPoints}).
   */
  readonly handoffScopes: ReadonlySet<string>;
  /**
   * Per-hand-off EXCLUSIONS for a SPREAD-AND-PATCH forwarder (issue #1475): a
   * {@link handoffScopes} entry registered from `const result = { ...config }`
   * — a literal spreading a bag-derived SEED inside an otherwise member-naming
   * function — delivers every seed member verbatim EXCEPT the keys the
   * function subsequently `delete`s off the binding. The value is the
   * lowercased first-segment names the wildcard must NOT vouch for; a scope
   * with no entry here (or an empty set) is an ordinary full hand-off.
   *
   * Optional so hand-built evidence objects in tests stay valid; absent means
   * "no exclusions anywhere".
   */
  readonly handoffExclusions?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The evidence a target that has NOT opted into the pass is classified with. */
export const EMPTY_WRITE_EVIDENCE: ProviderWriteEvidence = {
  written: new Set<string>(),
  scopes: new Map<string, ReadonlySet<string>>(),
  handoffScopes: new Set<string>(),
  handoffExclusions: new Map<string, ReadonlySet<string>>(),
};

/**
 * Is a path delivered by a WHOLE-BLOB HAND-OFF? Two distinct questions, and they
 * are answered with DIFFERENT strictness on purpose (issue #1464 review):
 *
 *  - ANCESTOR DELIVERY — some prefix of `parentPath` was handed off whole, so
 *    the terminal is delivered by the converter and has no written spelling to
 *    compare at all. The chain is matched case-INSENSITIVELY, the same
 *    relaxation the scope lookup uses and for the same reason
 *    ({@link normalizeWritePath}).
 *  - SELF DELIVERY — the path ITSELF is the hand-off. Here the last segment IS
 *    a written member name, so it is compared VERBATIM. Folding it would be a
 *    false clear on a CI-blocking bucket: a wildcard spelled `…CORSRules.ID`
 *    would otherwise vouch for an audited `….Id`, which is exactly the
 *    divergence the pass exists to report.
 *
 * The `.` guard on the ancestor test is load-bearing: a plain `startsWith`
 * would let a hand-off of `Cache` vouch for `CacheBehaviors.*`.
 */
export const isHandoffCovered = (
  handoffScopes: ReadonlySet<string>,
  parentPath: string,
  terminal?: string,
  // SPREAD-AND-PATCH exclusions (issue #1475): when the matched scope carries
  // an exclusion set, the FIRST segment beyond the scope decides — a deleted
  // key (and everything beneath it) is not delivered by the spread. A segment
  // the walk cannot determine (no terminal supplied) fails CLOSED.
  exclusions?: ReadonlyMap<string, ReadonlySet<string>>
): boolean => {
  const needle = normalizeWritePath(parentPath);
  for (const scope of handoffScopes) {
    const folded = normalizeWritePath(scope);
    if (needle.length > 0 && (needle === folded || needle.startsWith(`${folded}.`))) {
      const excluded = exclusions?.get(scope);
      if (excluded === undefined || excluded.size === 0) return true;
      const firstBeyond =
        needle === folded
          ? terminal?.toLowerCase()
          : needle.slice(folded.length + 1).split('.')[0]!;
      if (firstBeyond !== undefined && !excluded.has(firstBeyond)) return true;
      continue;
    }
    if (terminal === undefined) continue;
    const cut = scope.lastIndexOf('.');
    const scopeParent = cut === -1 ? '' : scope.slice(0, cut);
    const scopeTerminal = cut === -1 ? scope : scope.slice(cut + 1);
    if (scopeTerminal === terminal && normalizeWritePath(scopeParent) === needle) return true;
  }
  return false;
};

/**
 * The case-folded form a write PATH SEGMENT is matched by.
 *
 * The TERMINAL member is always compared EXACTLY — an exact spelling is the
 * only thing that proves delivery, and relaxing it would gut the pass. The
 * PARENT CHAIN is matched case-insensitively, because an intermediate segment's
 * CFn->SDK spelling is routinely NOT the mechanical first-letter flip and the
 * critic has no per-segment style to apply. Measured on
 * `ecs-provider.ts` when the full-depth match first ran (issue #1464): CFn
 * `EFSVolumeConfiguration` is SDK `efsVolumeConfiguration` (not
 * `eFSVolumeConfiguration`), `FSxWindowsFileServerVolumeConfiguration` is
 * `fsxWindowsFileServerVolumeConfiguration`, and `S3FilesVolumeConfiguration`
 * is `s3filesVolumeConfiguration` — all three carrying an explicit provider
 * comment saying so. A case-SENSITIVE parent match reported 16 members those
 * helpers demonstrably DO write, i.e. exactly the allow-list-bait the issue
 * forbids.
 *
 * The relaxation cannot manufacture a clear on its own, in three ways. The
 * divergent segment is itself an audited path, judged by the key pass at full
 * strictness (`Volumes.EFSVolumeConfiguration` lands in `provider-handled` only
 * because the provider names the CFn spelling). The fold is applied SEGMENT BY
 * SEGMENT while descending the write index ({@link classifyTarget}), never as a
 * global lowercase union of the whole index — so `a.Name`'s members are matched
 * against `a`'s own children, and the 80 unrelated `name` / `Name` pairs a
 * whole-file fold merges on `ecs-provider.ts` stay apart. And a spelling
 * difference that is NOT a case difference is out of scope by construction: for
 * that there is {@link NestedKeyTarget.segmentRenames}.
 */
export const normalizeWritePath = (path: string): string => path.toLowerCase();

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
 * can evaluate to, and the walk DESCENDS: the literal's direct members land in
 * that write's PATH, and each of those members' own values is recorded one
 * segment deeper (issue #1464). `environment` therefore scopes to
 * `{ type, computeType, image, environmentVariables, … }` and
 * `environment.environmentVariables` to `{ name, value, type }` — two different
 * `type` facts, where #1448 flattened both into one. Resolution mirrors the
 * `gen-handled-property-wiring` (#1404) taint walk's reach — same-file
 * `this.method(...)` and free-function calls, `const`/`let` bindings, `?:` /
 * `??` / `||` arms, array elements and `.map(cb)` callbacks — because
 * CodeBuild's `source: this.mapSource(source)` and `buildBatchConfig` (a `let`
 * bound to a literal, delivered as a shorthand property) are both that shape.
 *
 * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped
 * entirely, and a literal that {@link feedsOnlyComparison} contributes nothing.
 *
 * A write whose value is a BUILDER (issue #1474) — a local binding seeded with
 * an object literal and populated afterwards by `out.Foo = …` /
 * `out['Foo'] = …` assignments — has its assigned members credited at the same
 * path a literal's own members get, via {@link resolveBuilders} and
 * {@link walkBuilderAt}. The identity of the binding is what bounds the credit;
 * see the module header's BUILDER section and bound (8).
 *
 * A write whose value is a WHOLE-BLOB HAND-OFF into a generic key converter
 * (issue #1445) has no per-member literal to walk, so it is recorded separately
 * as a hand-off PATH — see {@link ProviderWriteEvidence.handoffScopes} and
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
  const handoffScopes = new Set<string>();
  const handoffExclusions = new Map<string, Set<string>>();

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

  /**
   * A scope boundary for a `const` / `let` binding. FUNCTION scope is not
   * enough: `const` is BLOCK-scoped, and treating a whole function as one
   * namespace is what let two same-named builders in different `if` arms
   * collapse onto one declaration (issue #1474 review).
   */
  const isBindingScope = (n: ts.Node): boolean =>
    ts.isSourceFile(n) ||
    ts.isBlock(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseBlock(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isCatchClause(n) ||
    ts.isFunctionLike(n);

  /**
   * A variable of this name declared DIRECTLY in `scope` — never one owned by
   * a nested block or function, which has its own namespace.
   */
  const declaredDirectlyIn = (scope: ts.Node, name: string): ts.VariableDeclaration | undefined => {
    let found: ts.VariableDeclaration | undefined;
    const visit = (n: ts.Node): void => {
      if (found !== undefined) return;
      if (isBindingScope(n)) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
        found = n;
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(scope, visit);
    return found;
  };

  /**
   * The declaration a plain identifier resolves to, searched lexically OUTWARD
   * from the reference through its enclosing BINDING scopes.
   *
   * Through #1474 this searched the nearest FUNCTION scope and descended fully
   * into nested functions, taking the first textual match — which meant the
   * bare-name weakness of known bound (3) reached inside a single function in
   * two measurable ways (found by the #1474 review, neither live in the tree
   * but both one edit away):
   *   - two `const cfg = {}` builders in different `if` arms collapsed onto the
   *     first declaration, so their member sets MERGED and each vouched for the
   *     other's blob — the false-CLEAR direction on a CI-blocking bucket;
   *   - a `const cfg` inside a nested arrow declared textually FIRST captured
   *     the enclosing function's own `cfg`, inverting both verdicts (the outer
   *     member falsely flagged, the inner one falsely cleared).
   * Walking outward block by block is the accurate lexical model and closes
   * both; the shapes are pinned by tests. It cannot under-resolve a valid
   * `const` / `let` either, since a reference outside the declaring block is a
   * compile error — the only thing the old full descent additionally reached
   * was a `var`, which no provider in the tree uses.
   */
  function declarationOf(id: ts.Identifier): ts.Node | undefined {
    for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
      if (!isBindingScope(scope)) continue;
      const declared = declaredDirectlyIn(scope, id.text);
      if (declared !== undefined) return declared;
      if (ts.isFunctionLike(scope)) {
        const parameter = scope.parameters.find(
          (p) => ts.isIdentifier(p.name) && p.name.text === id.text
        );
        if (parameter !== undefined) return parameter;
      }
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
   * at a resolvable call site, an array-callback parameter iterating bag
   * data, and a `for (const x of bag)` loop variable (issue #1540 — the
   * statement-form twin of the callback hop). Three iterations settle the
   * real tree; the loop is bounded anyway.
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
        } else if (
          ts.isForOfStatement(n) &&
          ts.isVariableDeclarationList(n.initializer) &&
          isBagDerived(n.expression, new Set())
        ) {
          // `for (const config of configs)` — the element of a bag-derived
          // array is bag data, the statement-form twin of the `.map((element)
          // => …)` callback hop below (issue #1540). Without it every
          // per-item S3 config loop (`applyMetricsConfigurations` etc.) broke
          // the taint chain at the loop variable, so a verbatim
          // `Tags: tagFilters` forward inside the loop never registered as a
          // whole-blob hand-off.
          for (const d of n.initializer.declarations) {
            if (!tainted.has(d)) {
              tainted.add(d);
              changed = true;
            }
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
      // A member whose SUBTREE the function deletes into is not delivered
      // whole (issue #1475 review): `delete config['VC']['Id']` mutates the
      // very object `config['VC']` then forwards. Deletes on the root binding
      // are recorded by FIRST segment, so the accessed member's name showing
      // up there refuses the forward — loud, since no literal remains to
      // register a bounded credit for an opaque access.
      let rootExpr: ts.Node = e;
      let firstSegment: string | undefined;
      while (ts.isElementAccessExpression(rootExpr) || ts.isPropertyAccessExpression(rootExpr)) {
        firstSegment = ts.isPropertyAccessExpression(rootExpr)
          ? rootExpr.name.text
          : elementAccessName(unwrapExpression(rootExpr.argumentExpression));
        rootExpr = unwrapExpression(rootExpr.expression);
      }
      if (ts.isIdentifier(rootExpr)) {
        const rootDeclaration = declarationOf(rootExpr);
        if (
          rootDeclaration !== undefined &&
          (ts.isVariableDeclaration(rootDeclaration) || ts.isParameter(rootDeclaration))
        ) {
          const rootDeletes = deleteExclusionsOf(rootDeclaration);
          if (rootDeletes === undefined) return false;
          if (rootDeletes.size > 0) {
            if (firstSegment === undefined) return false;
            if (rootDeletes.has(firstSegment.toLowerCase())) return false;
          }
        }
      }
      const key = ts.isElementAccessExpression(e)
        ? elementAccessName(e.argumentExpression)
        : e.name.text;
      if (key !== undefined) seedKeys?.add(key);
      return true;
    }
    if (ts.isIdentifier(e)) {
      // A binding — or a PARAMETER — the function `delete`s keys off does NOT
      // deliver the whole blob (issue #1475, its review for the parameter
      // half): refusing here hands the site to the BOUNDED spread
      // registration in `walkLiteralAt`, which carries the deleted keys as
      // exclusions. Without this, `const vc = { ...bag }; delete vc[k];`
      // registered a FULL hand-off (and `delete config['X']` before a
      // verbatim forward was invisible entirely) and the exclusion fence
      // never fired.
      const declaration = declarationOf(e);
      if (
        declaration !== undefined &&
        (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
      ) {
        const deletes = deleteExclusionsOf(declaration);
        if (deletes === undefined || deletes.size > 0) return false;
      }
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

  // ---- THE BUILDER IDIOM (issue #1474). A local binding seeded with a FRESH
  // object literal and then populated by property assignments is a per-member
  // write the literal walk cannot see: `resolveLiterals` resolves the
  // identifier to the (empty or partial) seed and stops, while the members are
  // written onto the binding afterwards. The three helpers below recognize the
  // shape; `walkBuilderAt` credits it at the SAME path the literal case gets.

  /**
   * The declaration `id` resolves to, when that declaration is a BUILDER SEED:
   * a variable initialized with an OBJECT LITERAL.
   *
   * The literal initializer is what makes the object's identity KNOWN — the
   * binding holds an object this file created, so an assignment onto the
   * binding is a write of a member this file delivers. Every other
   * initializer shape (`const out = makeThing()`, `let out;` assigned later,
   * a PARAMETER — which {@link declarationOf} can also return) is refused:
   * the object may be someone else's, and crediting members written onto it
   * would be crediting a write we cannot attribute. Under-crediting flags
   * correct code (loud); over-crediting silences a real drop (silent).
   *
   * A binding REASSIGNED as a whole (`let out = {}; out.Foo = 1;
   * out = opaque(props);`) is refused for the same reason and was NOT until
   * the #1474 review caught it: only the initializer was inspected, so the
   * seed's members were credited even though the value actually delivered is
   * the opaque one. That is the false-CLEAR direction, so the whole binding is
   * dropped rather than the walk trying to order the two.
   */
  const reassignedBindings = new Map<ts.VariableDeclaration, boolean>();
  const isWhollyReassigned = (declaration: ts.VariableDeclaration): boolean => {
    const cached = reassignedBindings.get(declaration);
    if (cached !== undefined) return cached;
    if (!ts.isIdentifier(declaration.name)) return false;
    const name = declaration.name.text;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (
        ts.isBinaryExpression(n) &&
        isWriteAssignment(n.operatorToken.kind) &&
        ts.isIdentifier(n.left) &&
        n.left.text === name &&
        declarationOf(n.left) === declaration
      ) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(enclosingScope(declaration));
    reassignedBindings.set(declaration, found);
    return found;
  };

  const builderDeclarationOf = (id: ts.Identifier): ts.VariableDeclaration | undefined => {
    const declaration = declarationOf(id);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
    if (declaration.initializer === undefined) return undefined;
    const seed = unwrapExpression(declaration.initializer);
    if (!ts.isObjectLiteralExpression(seed)) return undefined;
    return isWhollyReassigned(declaration) ? undefined : declaration;
  };

  /**
   * The member CHAIN an assignment target walks from a builder binding
   * (`out.Foo = v` -> `['Foo']`, `out['A'].B = v` -> `['A', 'B']`), or
   * `undefined` when the target is not rooted at `declaration`.
   *
   * The root test is DECLARATION IDENTITY, never the bare name: an unrelated
   * local also called `out` in a sibling method resolves to its OWN
   * declaration and contributes nothing here. That is the bare-name weakness
   * recorded as known bound (3) in the module header, deliberately not
   * inherited by this recognizer.
   *
   * A computed key that is not a literal (`out[k] = v`) yields nothing, the
   * same strictness {@link elementAccessName} applies everywhere else: `k`
   * names a VARIABLE, not a member.
   */
  const builderAssignmentChain = (
    lhs: ts.Node,
    declaration: ts.VariableDeclaration
  ): string[] | undefined => {
    const segments: string[] = [];
    let current: ts.Node = lhs;
    for (;;) {
      const e = unwrapExpression(current);
      if (ts.isPropertyAccessExpression(e)) {
        segments.unshift(e.name.text);
        current = e.expression;
        continue;
      }
      if (ts.isElementAccessExpression(e)) {
        const name = elementAccessName(unwrapExpression(e.argumentExpression));
        if (name === undefined) return undefined;
        segments.unshift(name);
        current = e.expression;
        continue;
      }
      if (!ts.isIdentifier(e) || segments.length === 0) return undefined;
      return declarationOf(e) === declaration ? segments : undefined;
    }
  };

  const builderMemberCache = new Map<
    ts.VariableDeclaration,
    Array<{ chain: string[]; value: ts.Node }>
  >();
  /**
   * Every member assigned onto a builder binding, searched in the binding's
   * OWN declaration scope and descended fully — an `if` arm, a loop body and a
   * callback are all legitimate places to populate a builder, and the identity
   * test above is what keeps the full descent safe.
   *
   * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped here too: a
   * reverse SDK->CFn helper nested inside the builder's scope must not vouch
   * for the forward direction, exactly as in the main walk.
   */
  const builderMembers = (
    declaration: ts.VariableDeclaration
  ): Array<{ chain: string[]; value: ts.Node }> => {
    const cached = builderMemberCache.get(declaration);
    if (cached !== undefined) return cached;
    const members: Array<{ chain: string[]; value: ts.Node }> = [];
    // Registered BEFORE the walk so a self-referential builder cannot re-enter.
    builderMemberCache.set(declaration, members);
    const visitScope = (n: ts.Node, excluded: boolean): void => {
      let inExcluded = excluded;
      if (!inExcluded) {
        const name = declaredFunctionName(n);
        if (name !== undefined && isExcludedName(name)) inExcluded = true;
      }
      if (!inExcluded && ts.isBinaryExpression(n) && isWriteAssignment(n.operatorToken.kind)) {
        const chain = builderAssignmentChain(n.left, declaration);
        if (chain !== undefined) members.push({ chain, value: n.right });
      }
      ts.forEachChild(n, (child) => visitScope(child, inExcluded));
    };
    visitScope(enclosingScope(declaration), false);
    return members;
  };

  /**
   * The BUILDERS a value expression can evaluate to — the builder twin of
   * {@link resolveLiterals}, following the same hops for the same reasons
   * (`?:` / `??` arms, array elements, `.map(cb)` callbacks, and a same-file
   * callee's returns, which is how `Configuration: buildPutParams(props)`
   * reaches a builder declared inside `buildPutParams`).
   *
   * Kept SEPARATE from {@link resolveLiterals} rather than folded into it: that
   * function's identifier branch resolves by BARE NAME across enclosing scopes,
   * and the builder credit must not inherit that looseness.
   *
   * An OBJECT LITERAL deliberately yields nothing here — `{ ...out }` is
   * handled by {@link walkLiteralAt}'s spread branch, which merges the
   * builder's members at the literal's own path, so a `return { ...out, Extra: 1 }`
   * credits both halves at one level.
   */
  const resolveBuilders = (expr: ts.Node, seen: Set<ts.Node>): ts.VariableDeclaration[] => {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return [];
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const declaration = builderDeclarationOf(e);
      if (declaration !== undefined) return [declaration];
      // Issue #1540: a builder can sit BEHIND a plain binding — `const rules =
      // cfg.Rules.map((r) => { const sdkRule = { … }; sdkRule.X = …; return
      // sdkRule; })` delivered as `Rules: rules`. The identifier itself is not
      // a builder (its initializer is no literal seed), but the value it HOLDS
      // may resolve to one, and {@link resolveLiterals} already makes exactly
      // this hop for the seed's members — so refusing it here split one value
      // into "seed credited, mutations lost" (measured on the real
      // `s3-bucket-provider.ts` lifecycle mapper: `LifecycleConfiguration.Rules`
      // carried only the seed's `ID`/`Status`/`Prefix`). The hop keeps the
      // recognizer's strictness: declaration IDENTITY via `declarationOf`
      // (never bare-name), and a wholly-reassigned binding stays refused for
      // the same false-CLEAR reason `builderDeclarationOf` refuses it.
      const plain = declarationOf(e);
      if (
        plain !== undefined &&
        ts.isVariableDeclaration(plain) &&
        plain.initializer !== undefined &&
        !isWhollyReassigned(plain)
      ) {
        return resolveBuilders(plain.initializer, seen);
      }
      return [];
    }
    if (ts.isConditionalExpression(e)) {
      return [...resolveBuilders(e.whenTrue, seen), ...resolveBuilders(e.whenFalse, seen)];
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return [...resolveBuilders(e.left, seen), ...resolveBuilders(e.right, seen)];
      }
      return [];
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap((el) => resolveBuilders(el, seen));
    }
    if (ts.isSpreadElement(e)) return resolveBuilders(e.expression, seen);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      return returnedExpressions(e).flatMap((r) => resolveBuilders(r, seen));
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (CALLBACK_RETURNING_METHODS.has(callee.name.text)) {
          return e.arguments.flatMap((a) => resolveBuilders(a, seen));
        }
        if (RECEIVER_PRESERVING_METHODS.has(callee.name.text)) {
          return resolveBuilders(callee.expression, seen);
        }
        if (RECEIVER_AND_ARGUMENT_METHODS.has(callee.name.text)) {
          return [
            ...resolveBuilders(callee.expression, seen),
            ...e.arguments.flatMap((a) => resolveBuilders(a, seen)),
          ];
        }
      }
      const name = resolvableCalleeName(e);
      if (name === undefined) return [];
      return (callables.get(name) ?? []).flatMap((fn) =>
        returnedExpressions(fn).flatMap((r) => resolveBuilders(r, seen))
      );
    }
    return [];
  };

  // ---- THE SPREAD-AND-PATCH FORWARDER (issue #1475). A literal that SPREADS
  // a bag-derived seed (`const result = { ...config }` where `config` carries
  // the taint root) delivers every seed member VERBATIM at the literal's write
  // path — inside an otherwise member-naming function, which is exactly what
  // the genericity test (correctly, by its own rule) rejects. The named
  // patches around the spread are already credited by the literal / builder
  // walks; what was missing is the wildcard for the members the patches never
  // touch. The wildcard is BOUNDED: a key the function subsequently `delete`s
  // off the binding is NOT delivered (a rename that writes the WRONG SDK key
  // would otherwise be vouched for by the spread it just removed the key
  // from), and a delete whose key set cannot be resolved refuses the whole
  // registration — fail CLOSED, the same direction every other refusal here
  // takes. See the module header's bound (9) for what is deliberately NOT
  // excluded (overwritten members, verbatim spelling).

  /**
   * The literal names a computed KEY expression can take, resolved through the
   * one shape the real tree uses: a `for (const k of TABLE)` /
   * `for (const [k, v] of Object.entries(TABLE))` /
   * `for (const k of Object.keys(TABLE))` loop over a LITERAL table. Returns
   * `undefined` when the key cannot be bounded — the caller fails CLOSED.
   */
  const literalObjectOf = (expr: ts.Node): ts.ObjectLiteralExpression | undefined => {
    const e = unwrapExpression(expr);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (!ts.isIdentifier(e)) return undefined;
    const declaration = declarationOf(e);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      // A reassigned table no longer holds its initial literal — resolving it
      // anyway would under-exclude off stale keys (#1475 review).
      isWhollyReassigned(declaration)
    ) {
      return undefined;
    }
    const init = unwrapExpression(declaration.initializer);
    return ts.isObjectLiteralExpression(init) ? init : undefined;
  };
  const literalKeysOfObject = (lit: ts.ObjectLiteralExpression): string[] | undefined => {
    const keys: string[] = [];
    for (const p of lit.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const name = propertyName(p.name);
      if (name === undefined) return undefined;
      keys.push(name);
    }
    return keys;
  };
  const literalValuesOfObject = (lit: ts.ObjectLiteralExpression): string[] | undefined => {
    const values: string[] = [];
    for (const p of lit.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const v = unwrapExpression(p.initializer);
      if (!ts.isStringLiteral(v) && !ts.isNoSubstitutionTemplateLiteral(v)) return undefined;
      values.push(v.text);
    }
    return values;
  };
  const loopKeyNames = (
    declaration: ts.VariableDeclaration,
    elementIndex: number | undefined
  ): string[] | undefined => {
    const list = declaration.parent;
    if (list === undefined || !ts.isVariableDeclarationList(list)) return undefined;
    const forOf = list.parent;
    if (forOf === undefined || !ts.isForOfStatement(forOf)) return undefined;
    const iterated = unwrapExpression(forOf.expression);
    if (ts.isArrayLiteralExpression(iterated)) {
      if (elementIndex !== undefined) return undefined;
      const names: string[] = [];
      for (const el of iterated.elements) {
        const e = unwrapExpression(el);
        if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) return undefined;
        names.push(e.text);
      }
      return names;
    }
    if (ts.isIdentifier(iterated)) {
      // `for (const k of TABLE)` where TABLE is a const string array. A
      // reassigned TABLE is refused for literalObjectOf's reason.
      if (elementIndex !== undefined) return undefined;
      const decl = declarationOf(iterated);
      if (
        decl === undefined ||
        !ts.isVariableDeclaration(decl) ||
        decl.initializer === undefined ||
        isWhollyReassigned(decl)
      ) {
        return undefined;
      }
      const init = unwrapExpression(decl.initializer);
      if (!ts.isArrayLiteralExpression(init)) return undefined;
      const names: string[] = [];
      for (const el of init.elements) {
        const e = unwrapExpression(el);
        if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) return undefined;
        names.push(e.text);
      }
      return names;
    }
    if (!ts.isCallExpression(iterated)) return undefined;
    const callee = unwrapExpression(iterated.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'Object' ||
      iterated.arguments.length !== 1
    ) {
      return undefined;
    }
    const table = literalObjectOf(iterated.arguments[0]!);
    if (table === undefined) return undefined;
    if (callee.name.text === 'keys') {
      return elementIndex === undefined ? literalKeysOfObject(table) : undefined;
    }
    if (callee.name.text === 'entries') {
      if (elementIndex === 0) return literalKeysOfObject(table);
      if (elementIndex === 1) return literalValuesOfObject(table);
      return undefined;
    }
    return undefined;
  };
  const computedKeyNames = (expr: ts.Node): string[] | undefined => {
    const e = unwrapExpression(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
    if (!ts.isIdentifier(e)) return undefined;
    // Resolve the identifier to a loop binding — plain (`const k of …`) or an
    // array-destructured element (`const [k, v] of Object.entries(…)`), which
    // `declarationOf` cannot see (it matches Identifier names only).
    for (let scope: ts.Node | undefined = e.parent; scope !== undefined; scope = scope.parent) {
      if (!isBindingScope(scope)) continue;
      let found: { declaration: ts.VariableDeclaration; elementIndex?: number } | undefined;
      const visit = (n: ts.Node): void => {
        if (found !== undefined) return;
        if (isBindingScope(n)) return;
        if (ts.isVariableDeclaration(n)) {
          if (ts.isIdentifier(n.name) && n.name.text === e.text) {
            found = { declaration: n };
            return;
          }
          if (ts.isArrayBindingPattern(n.name)) {
            n.name.elements.forEach((el, i) => {
              if (
                found === undefined &&
                ts.isBindingElement(el) &&
                ts.isIdentifier(el.name) &&
                el.name.text === e.text
              ) {
                found = { declaration: n, elementIndex: i };
              }
            });
            if (found !== undefined) return;
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(scope, visit);
      if (found !== undefined) return loopKeyNames(found.declaration, found.elementIndex);
    }
    return undefined;
  };

  /**
   * The keys `delete` removes from `declaration`'s binding, LOWERCASED for the
   * exclusion compare, or `undefined` when any delete's key cannot be bounded
   * (fail CLOSED — the spread must not be credited at all). A delete through a
   * longer chain (`delete result['A']['B']`) excludes its FIRST segment
   * wholesale: over-excluding flags correct code (loud), under-excluding
   * silences a real drop. Deletes are collected across the WHOLE scope,
   * excluded (reverse-map) function bodies included — a delete anywhere
   * removes the key from the delivered object, so skipping any body would be
   * the fail-OPEN direction.
   */
  const deleteExclusionCache = new Map<
    ts.VariableDeclaration | ts.ParameterDeclaration,
    Set<string> | undefined
  >();
  const deleteExclusionsOf = (
    declaration: ts.VariableDeclaration | ts.ParameterDeclaration
  ): Set<string> | undefined => {
    if (deleteExclusionCache.has(declaration)) return deleteExclusionCache.get(declaration);
    const excluded = new Set<string>();
    let unresolvable = false;
    const visit = (n: ts.Node): void => {
      if (unresolvable) return;
      if (ts.isDeleteExpression(n)) {
        let current: ts.Node = unwrapExpression(n.expression);
        const accesses: Array<ts.PropertyAccessExpression | ts.ElementAccessExpression> = [];
        while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          accesses.unshift(current);
          current = unwrapExpression(current.expression);
        }
        if (
          ts.isIdentifier(current) &&
          accesses.length > 0 &&
          declarationOf(current) === declaration
        ) {
          const first = accesses[0]!;
          const names = ts.isPropertyAccessExpression(first)
            ? [first.name.text]
            : computedKeyNames(first.argumentExpression);
          if (names === undefined) {
            unresolvable = true;
            return;
          }
          for (const name of names) excluded.add(name.toLowerCase());
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(enclosingScope(declaration));
    const result = unresolvable ? undefined : excluded;
    deleteExclusionCache.set(declaration, result);
    return result;
  };

  /**
   * The delete exclusions carried by a spread SOURCE, followed through the
   * binding chain (issue #1475 review): `{ ...a }` where
   * `const a = { ...config }; delete a['K'];` must carry `K`, and so must a
   * spread of a PARAMETER the function `delete`s off, an accessed member
   * whose root binding deletes into its subtree, and a call whose returned
   * binding was deleted from. Every unhandled shape returns `undefined` and
   * the caller refuses the registration — fail closed, since a chain the walk
   * cannot follow may be hiding a delete.
   */
  const spreadSourceExclusions = (expr: ts.Node, seen: Set<ts.Node>): Set<string> | undefined => {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return undefined;
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const declaration = declarationOf(e);
      if (declaration === undefined) return undefined;
      if (ts.isParameter(declaration)) return deleteExclusionsOf(declaration);
      if (!ts.isVariableDeclaration(declaration)) return undefined;
      if (isWhollyReassigned(declaration)) return undefined;
      const own = deleteExclusionsOf(declaration);
      if (own === undefined || declaration.initializer === undefined) return own;
      const chained = spreadSourceExclusions(declaration.initializer, seen);
      if (chained === undefined) return undefined;
      const out = new Set(own);
      for (const k of chained) out.add(k);
      return out;
    }
    if (ts.isObjectLiteralExpression(e)) {
      // A seed literal in the chain: only its BAG-DERIVED spreads carry
      // deletes onward; named members are overrides (bound 9).
      const out = new Set<string>();
      for (const p of e.properties) {
        if (!ts.isSpreadAssignment(p) || !isBagDerived(p.expression, new Set())) continue;
        const inner = spreadSourceExclusions(p.expression, seen);
        if (inner === undefined) return undefined;
        for (const k of inner) out.add(k);
      }
      return out;
    }
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      // `{ ...result['ViewerCertificate'] }` — deletes on the ROOT binding are
      // recorded by FIRST segment, so any delete under the accessed member
      // surfaces as that member's name; refuse then (what remains beneath it
      // cannot be bounded). A root with no deletes contributes nothing.
      let current: ts.Node = e;
      let firstSegment: string | undefined;
      while (ts.isElementAccessExpression(current) || ts.isPropertyAccessExpression(current)) {
        firstSegment = ts.isPropertyAccessExpression(current)
          ? current.name.text
          : elementAccessName(unwrapExpression(current.argumentExpression));
        current = unwrapExpression(current.expression);
      }
      if (!ts.isIdentifier(current)) return undefined;
      const root = declarationOf(current);
      if (root === undefined) return undefined;
      if (!ts.isParameter(root) && !ts.isVariableDeclaration(root)) return undefined;
      const rootDeletes = deleteExclusionsOf(root);
      if (rootDeletes === undefined) return undefined;
      if (rootDeletes.size === 0) return new Set<string>();
      if (firstSegment === undefined) return undefined;
      return rootDeletes.has(firstSegment.toLowerCase()) ? undefined : new Set<string>();
    }
    if (ts.isCallExpression(e)) {
      // Mirror {@link resolveLiterals}' call reach: `.map(cb)` delivers the
      // callbacks' returns, `.filter(...)` its receiver — the chain has to
      // follow the same hops or every registration those hops feed refuses.
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (CALLBACK_RETURNING_METHODS.has(callee.name.text)) {
          const out = new Set<string>();
          for (const a of e.arguments) {
            const fn = unwrapExpression(a);
            if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
            for (const r of returnedExpressions(fn)) {
              const inner = spreadSourceExclusions(r, seen);
              if (inner === undefined) return undefined;
              for (const k of inner) out.add(k);
            }
          }
          return out;
        }
        if (RECEIVER_PRESERVING_METHODS.has(callee.name.text)) {
          return spreadSourceExclusions(callee.expression, seen);
        }
      }
      // `{ ...this.toSdk(x) }` — deletes on the callee's returned binding
      // travel with the returned value.
      const name = resolvableCalleeName(e);
      if (name === undefined) return undefined;
      const fns = handoffCallables.get(name) ?? [];
      if (fns.length === 0) return undefined;
      const out = new Set<string>();
      for (const fn of fns) {
        for (const r of returnedExpressions(fn)) {
          const inner = spreadSourceExclusions(r, seen);
          if (inner === undefined) return undefined;
          for (const k of inner) out.add(k);
        }
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(e)) {
      const out = new Set<string>();
      for (const el of e.elements) {
        const inner = spreadSourceExclusions(el, seen);
        if (inner === undefined) return undefined;
        for (const k of inner) out.add(k);
      }
      return out;
    }
    if (ts.isSpreadElement(e)) return spreadSourceExclusions(e.expression, seen);
    if (ts.isConditionalExpression(e) || ts.isBinaryExpression(e)) {
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
        e.operatorToken.kind !== ts.SyntaxKind.BarBarToken &&
        e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return undefined;
      }
      const arms = (
        ts.isConditionalExpression(e) ? [e.whenTrue, e.whenFalse] : [e.left, e.right]
      ).filter((a) => !isNullishExpression(a));
      const out = new Set<string>();
      for (const arm of arms) {
        const inner = spreadSourceExclusions(arm, seen);
        if (inner === undefined) return undefined;
        for (const k of inner) out.add(k);
      }
      return out;
    }
    return undefined;
  };

  /**
   * Register the spread of a bag-derived seed as a BOUNDED hand-off at `path`
   * (issue #1475). Refusals, each fail-CLOSED: a non-bag seed (the taint root
   * — a config read back off AWS must not measure as a hand-off), a binding
   * REASSIGNED as a whole or seeded by LATE ASSIGNMENT (the delivered value
   * may not be the seed / its deletes are invisible from the literal), an
   * unresolvable `delete` key, and a spread SOURCE chain the walk cannot
   * follow ({@link spreadSourceExclusions}). Exclusions union across the
   * literal's bag spreads AND the holder binding's own deletes. Two
   * registrations at the same path union their coverage, so exclusion sets
   * INTERSECT; a FULL hand-off at the path supersedes every exclusion.
   */
  const registerSpreadHandoff = (
    path: string,
    lit: ts.ObjectLiteralExpression,
    chainSource?: ts.Node
  ): void => {
    let excluded: Set<string> | undefined;
    for (const p of lit.properties) {
      if (!ts.isSpreadAssignment(p)) continue;
      if (!isBagDerived(p.expression, new Set())) continue;
      const sourceExcluded = spreadSourceExclusions(p.expression, new Set());
      if (sourceExcluded === undefined) return;
      if (excluded === undefined) excluded = new Set<string>();
      for (const k of sourceExcluded) excluded.add(k);
    }
    if (excluded === undefined) return; // no bag-derived spread in this literal
    // Deletes on the RESOLUTION CHAIN between the write and this literal
    // (issue #1475 review): `const r = this.seed(cfg); delete r['K'];` and the
    // `?:`-arm seed both reach here with a holder that is not the deleted
    // binding — the chain walk is what sees those. An unfollowable chain
    // refuses, fail-closed.
    if (chainSource !== undefined && unwrapExpression(chainSource) !== lit) {
      const chainExcluded = spreadSourceExclusions(chainSource, new Set());
      if (chainExcluded === undefined) return;
      for (const k of chainExcluded) excluded.add(k);
    }
    const holder = climbOutOfWrappers(lit).parent;
    if (holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
      if (isWhollyReassigned(holder)) return;
      const holderDeletes = deleteExclusionsOf(holder);
      if (holderDeletes === undefined) return;
      for (const k of holderDeletes) excluded.add(k);
    } else if (
      holder !== undefined &&
      ts.isBinaryExpression(holder) &&
      isWriteAssignment(holder.operatorToken.kind)
    ) {
      // The literal seeds a binding by ASSIGNMENT (`let x; x = { ...bag }`),
      // which `isWhollyReassigned` classifies as a whole reassignment on the
      // declaration — refuse outright, same as the builder does. A delete on
      // that binding would otherwise be invisible from here (the holder is
      // the assignment, not the declaration), and refusing is the loud
      // direction.
      return;
    }
    const existing = handoffExclusions.get(path);
    if (handoffScopes.has(path) && existing === undefined) return; // full hand-off wins
    if (existing !== undefined) {
      const merged = new Set([...existing].filter((k) => excluded!.has(k)));
      if (merged.size === 0) handoffExclusions.delete(path);
      else handoffExclusions.set(path, merged);
    } else if (excluded.size > 0) {
      handoffExclusions.set(path, excluded);
    }
    handoffScopes.add(path);
  };

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
   * The longest write path the recorder will build. CFn nested paths bottom out
   * at 7 segments on the deepest audited type (`AWS::ECS::Service`), so this is
   * far past any legitimate lookup; it exists because a self-referential value
   * (`const a = { b: a }`) would otherwise descend forever — `resolveLiterals`
   * guards cycles WITHIN one call, not across the recursive descent.
   */
  const MAX_WRITE_PATH_SEGMENTS = 12;

  const addScopeMember = (path: string, member: string): void => {
    const scope = scopes.get(path) ?? new Set<string>();
    scope.add(member);
    scopes.set(path, scope);
  };

  /** The path with its LAST segment replaced — used for the CFn-spelling alias. */
  const siblingPath = (path: string, segment: string): string => {
    const cut = path.lastIndexOf('.');
    return cut === -1 ? segment : `${path.slice(0, cut + 1)}${segment}`;
  };

  /**
   * Register the CFn-spelled ALIASES of a hand-off path.
   *
   * The write path's last segment is the SDK spelling; the audited path's is the
   * CFn one, and the two do not always agree — `ECSProvider` writes
   * `placementStrategy` for CFn's `PlacementStrategies`, so recording only the
   * write path leaves `PlacementStrategies.Type` / `.Field` uncovered on a
   * target that forwards the whole array. The SEED's own key IS the CFn
   * spelling, so it is registered as a sibling path too, in both the `exact` and
   * `lower-first` renderings (the collector does not know the target's style).
   */
  const registerSeedKeyHandoffs = (path: string, seedKeys: ReadonlySet<string>): void => {
    for (const key of seedKeys) {
      // Alias paths never carry a spread-exclusion entry and never clear one:
      // a stale entry at an alias path could only OVER-exclude (loud), and no
      // shape in the tree produces one (#1475 review nit, recorded).
      handoffScopes.add(siblingPath(path, key));
      handoffScopes.add(siblingPath(path, lowerFirst(key)));
    }
  };

  /**
   * Guard for the recursive descent: one (path, literal) pair is walked once.
   * Keyed by pair rather than by literal alone because the SAME literal legally
   * appears at two paths (a shared helper's return delivered to two members).
   *
   * The guard makes SPREAD-EXCLUSION precision traversal-order-dependent in
   * the LOUD direction only (#1475 review): the same seed literal reached at
   * one path via two chains with different deletes registers with the FIRST
   * chain's exclusions. A clean second site either rescues coverage through
   * its FULL hand-off in `recordAt` (a generic-converter seed) or, when it
   * cannot, leaves an over-exclusion that flags a delivered key — never a
   * false clear, since the kept registration always corresponds to a real
   * site whose chain was fully computed.
   */
  const walkedAtPath = new Set<string>();
  let literalIdSeq = 0;
  const literalIds = new WeakMap<ts.Node, number>();
  const literalId = (node: ts.Node): number => {
    let id = literalIds.get(node);
    if (id === undefined) {
      id = ++literalIdSeq;
      literalIds.set(node, id);
    }
    return id;
  };

  /**
   * Record one write AT A PATH, and descend into the value so every member
   * beneath it lands under ITS OWN path rather than being flattened into the
   * ancestor's scope (issue #1464). `environment.environmentVariables.type` and
   * `environment.type` are therefore separate facts, which is the whole point.
   *
   * Two write sites of the SAME path are still UNIONED, and deliberately: the
   * positive test asks whether ANY site delivers the member, so per-site sets
   * would change nothing. That residue is what is left of the #1448 bound (2) —
   * see the module header.
   */
  const recordAt = (path: string, name: string, value: ts.Node | undefined): void => {
    written.add(name);
    if (!scopes.has(path)) scopes.set(path, new Set<string>());
    if (value === undefined) return;
    if (path.split('.').length >= MAX_WRITE_PATH_SEGMENTS) return;
    // A write whose OWN value is the hand-off (`CorsConfiguration:
    // properties['CorsConfiguration']`) delivers everything at or beneath this
    // path, so the path itself becomes the wildcard.
    const handoff = isWholeBlobHandoff(value);
    if (handoff !== undefined) {
      handoffScopes.add(path);
      // A FULL hand-off (generic converter / verbatim forward) delivers every
      // member, so it supersedes any bounded SPREAD registration at the path.
      handoffExclusions.delete(path);
      registerSeedKeyHandoffs(path, handoff.seedKeys);
    }
    // The write VALUE is the spread recognizer's CHAIN SOURCE (issue #1475
    // review): a literal can reach this write through bindings whose deletes
    // the literal's own holder cannot see (`const r = this.seed(cfg);
    // delete r['K'];` — the seed literal's holder is the callee's return).
    for (const literal of resolveLiterals(value, new Set())) walkLiteralAt(path, literal, value);
    // The BUILDER twin (issue #1474): the value can also be a binding the file
    // populated by assignment after seeding it with a literal, in which case
    // the seed walked just above carries none of the members.
    for (const builder of resolveBuilders(value, new Set())) walkBuilderAt(path, builder);
  };

  /**
   * Every member ASSIGNED onto a builder binding is written at `path` — the
   * same crediting {@link walkLiteralAt} gives a literal's own members, at the
   * same path, so `Configuration: mapped` scopes exactly what
   * `Configuration: { … }` would have (issue #1474).
   *
   * A chain longer than one segment (`out.A.B = v`) opens the intermediate
   * scopes on the way down, so the credit lands at `path.A.B` rather than
   * being flattened onto `path` — the depth-scoping #1464 established.
   *
   * DELIVERY is the caller's question, not this function's: `recordAt` runs
   * only where a WRITE takes the value, and the write sites are already
   * filtered by {@link feedsOnlyComparison} / {@link isComparisonOnlyLiteral}.
   * A builder that is never handed to a write — or handed only to a diff — is
   * therefore never reached, which is the "not a rubber stamp" half of the
   * recognizer and is pinned by its own tests.
   */
  function walkBuilderAt(path: string, declaration: ts.VariableDeclaration): void {
    const guard = `${path}#builder${literalId(declaration)}`;
    if (walkedAtPath.has(guard)) return;
    walkedAtPath.add(guard);
    if (path.split('.').length >= MAX_WRITE_PATH_SEGMENTS) return;
    for (const { chain, value } of builderMembers(declaration)) {
      let parent = path;
      for (const segment of chain.slice(0, -1)) {
        addScopeMember(parent, segment);
        parent = `${parent}.${segment}`;
        if (!scopes.has(parent)) scopes.set(parent, new Set<string>());
      }
      const terminal = chain[chain.length - 1]!;
      addScopeMember(parent, terminal);
      recordAt(`${parent}.${terminal}`, terminal, value);
    }
  }

  /**
   * Every member of `lit` is written directly at `path`. `chainSource` is the
   * expression the literal was RESOLVED FROM (the write's value, or a spread's
   * own expression one level up) — the spread registration walks its binding
   * chain for deletes the literal's holder cannot see (issue #1475 review).
   */
  function walkLiteralAt(path: string, lit: ts.ObjectLiteralExpression, chainSource?: ts.Node): void {
    const guard = `${path}#${literalId(lit)}`;
    if (walkedAtPath.has(guard)) return;
    walkedAtPath.add(guard);
    if (isComparisonOnlyLiteral(lit)) return;
    registerSpreadHandoff(path, lit, chainSource);
    for (const p of lit.properties) {
      if (ts.isPropertyAssignment(p)) {
        const name = propertyName(p.name);
        if (name === undefined) continue;
        addScopeMember(path, name);
        recordAt(`${path}.${name}`, name, p.initializer);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        addScopeMember(path, p.name.text);
        recordAt(`${path}.${p.name.text}`, p.name.text, p.name);
      } else if (ts.isSpreadAssignment(p)) {
        // A spread merges the source's members AT THIS LEVEL — including a
        // BUILDER's (`return { ...out, Extra: 1 }`), issue #1474.
        for (const child of resolveLiterals(p.expression, new Set())) {
          walkLiteralAt(path, child, p.expression);
        }
        for (const builder of resolveBuilders(p.expression, new Set())) {
          walkBuilderAt(path, builder);
        }
      }
    }
  }

  /** A write that opens a ROOT scope — see {@link isLexicallyNestedWrite}. */
  const record = (name: string, value: ts.Node | undefined): void => {
    recordAt(name, name, value);
  };

  /**
   * Is this write lexically INSIDE another object literal, so that its own path
   * is already recorded by the enclosing write's descent?
   *
   * Through #1448 every property assignment in the file opened a ROOT scope, so
   * a member that only ever appears nested (`logsConfig: { cloudWatchLogs: { … } }`)
   * still produced a top-level-looking `cloudWatchLogs` scope that a CFn
   * top-level of that spelling would then be checked against — the second half
   * of that release's known bound (2). Suppressing the nested root closes it:
   * the member IS recorded, at `logsConfig.cloudWatchLogs`, which is where the
   * audited path looks for it.
   *
   * Only the LEXICAL nesting is suppressed. A literal reached through a binding
   * or a helper's return still opens a root of its own (its properties have no
   * object-literal ancestor), and is ALSO recorded under the caller's path by
   * the descent — the residual, harmless direction.
   *
   * The ancestor walk is a WHITELIST of hops rather than "any enclosing object
   * literal", because suppression is only safe where {@link resolveLiterals}
   * can make the SAME hop in the other direction. It cannot cross an OPAQUE
   * call: `{ body: JSON.stringify({ batchReportMode: 1 }) }` has an enclosing
   * literal, but nothing resolves `JSON.stringify(…)`, so suppressing the inner
   * root would lose the write entirely — the false-POSITIVE direction on a
   * CI-blocking bucket.
   *
   * It CAN cross a callback of {@link CALLBACK_RETURNING_METHODS}, and must:
   * `defs.map((d) => ({ name: … }))` is the dominant shape in these providers,
   * `resolveLiterals` follows it, and leaving it out kept every such literal
   * opening stray depth-1 roots (measured on the synthetic probes: `name`,
   * `nested`, `nested.deep`, `type`) while the header claimed the bound closed.
   * A callback of any OTHER method (`forEach`, an unresolvable helper) is NOT
   * crossed, so its literals still root — the conservative direction.
   */
  const isCallbackReturningCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(unwrapExpression(node.expression)) &&
    CALLBACK_RETURNING_METHODS.has(
      (unwrapExpression(node.expression) as ts.PropertyAccessExpression).name.text
    );

  const NESTING_PASSTHROUGH_KINDS = (n: ts.Node): boolean =>
    ts.isObjectLiteralExpression(n) ||
    ts.isPropertyAssignment(n) ||
    ts.isArrayLiteralExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSpreadAssignment(n) ||
    ts.isSpreadElement(n) ||
    ts.isConditionalExpression(n) ||
    ts.isReturnStatement(n) ||
    ts.isBlock(n) ||
    ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parent !== undefined &&
      isCallbackReturningCall(n.parent) &&
      (n.parent as ts.CallExpression).arguments.some((a) => unwrapExpression(a) === n)) ||
    isCallbackReturningCall(n) ||
    (ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken));

  const isLexicallyNestedWrite = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node.parent?.parent; n !== undefined; n = n.parent) {
      if (ts.isObjectLiteralExpression(n)) return true;
      if (!NESTING_PASSTHROUGH_KINDS(n)) return false;
    }
    return false;
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
          !isLexicallyNestedWrite(node) &&
          !suppressedLiterals.has(node.parent) &&
          !isComparisonOnlyLiteral(node.parent)
        ) {
          record(name, node.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        if (
          !isDestructuringTarget(node) &&
          !isLexicallyNestedWrite(node) &&
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
  return { written, scopes, handoffScopes, handoffExclusions };
}

/**
 * Every SDK member name reachable BENEATH an SDK member, following the model's
 * own reference graph (issue #1445).
 *
 * Through #1445 this turned a hand-off POINT into a CREDIT SET, because the CFn
 * side could not answer "what lives beneath this?" — the fixture's
 * `nestedProperties` capture was FLATTENED per top-level, so it knew
 * `ContainerDefinitions.Add` existed but not that `Add` lives under
 * `LinuxParameters`. The `nestedPropertyPaths` capture (#1464) answers it
 * directly, and the credit is a path-prefix test, so this function is no longer
 * on the classification path.
 *
 * What it still does is back {@link countExpandingHandoffPoints}, the
 * parser-regression floor: "does this hand-off point carry a SUB-BLOB, or is it
 * an inert scalar forward?" is exactly a question about the SDK model.
 *
 * The starting member is looked up by BARE NAME across every interface in the
 * client model, so two unrelated interfaces declaring the same member name are
 * UNIONED. That over-counts in the floor's SAFE direction (a floor is a
 * lower bound on how much the walk still sees) and no longer affects any
 * verdict.
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
 * How many distinct hand-off POINTS — the terminal segments of
 * {@link ProviderWriteEvidence.handoffScopes} — actually EXPAND to at least one
 * SDK member.
 *
 * Since #1464 the credit itself is a PATH-PREFIX test that never consults the
 * SDK model, so this function exists purely as the parser-regression floor
 * behind {@link NestedKeyTarget.minHandoffPoints}: it answers "did the walk
 * still recognize a BLOB-carrying forward?", which is the failure mode the
 * floor exists for.
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
  const points = new Set(
    [...evidence.handoffScopes].map((path) => path.slice(path.lastIndexOf('.') + 1))
  );
  let expanding = 0;
  for (const point of points) {
    if (reachableSdkMemberNames(point, sdkInterfaces).size > 0) expanding++;
  }
  return expanding;
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
 * The write test is PATH-SCOPED AT FULL DEPTH (issues #1448 / #1464): the
 * path's terminal member must be written at the write path its PARENT CHAIN
 * maps to — every segment styled — or sit beneath a WHOLE-BLOB HAND-OFF.
 * `BuildBatchConfig.ServiceRole` therefore has to be written under
 * `buildBatchConfig`, and `Environment.EnvironmentVariables.Type` under
 * `environment.environmentVariables`, where `Environment.Type`'s own write does
 * not reach it.
 */
export function classifyTarget(
  target: NestedKeyTarget,
  nestedKeyPaths: readonly NestedKeyPath[],
  sdkMembers: ReadonlySet<string>,
  providerLiterals: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST,
  writeEvidence: ProviderWriteEvidence = EMPTY_WRITE_EVIDENCE,
  // OUT-param: the {@link NestedKeyTarget.segmentRenames} entries that actually
  // did work on this run, so `findStaleSegmentRenames` can force the removal of
  // one that stopped. An out-param rather than a second return value because
  // every existing caller (and every unit probe) wants only the verdicts.
  usedSegmentRenames?: Set<string>,
  // Same contract for {@link NestedKeyTarget.terminalRenames} (issue #1540).
  usedTerminalRenames?: Set<string>
): NestedKeyClassification[] {
  const sdkLower = new Map<string, string>();
  for (const m of sdkMembers) {
    if (!sdkLower.has(m.toLowerCase())) sdkLower.set(m.toLowerCase(), m);
  }
  const styled = (s: string): string => (target.keyStyle === 'lower-first' ? lowerFirst(s) : s);
  const renames = target.segmentRenames ?? {};

  // ---- The write index as a TREE, so the case-fold is applied per LEVEL
  // rather than as a global lowercase union of every path in the file.
  // A whole-file fold merges the member sets of unrelated same-spelled scopes
  // (measured: 80 `name`/`Name`-style collision groups on `ecs-provider.ts`);
  // descending level by level matches `a.Name` only against `a`'s OWN children.
  const childrenOf = new Map<string, string[]>();
  for (const [path, members] of writeEvidence.scopes) {
    const list = childrenOf.get(path) ?? [];
    for (const m of members) list.push(m);
    childrenOf.set(path, list);
  }
  const rootScopes = [...writeEvidence.scopes.keys()].filter((k) => !k.includes('.'));
  const matchesSegment = (candidate: string, wanted: string): boolean =>
    candidate === wanted || candidate.toLowerCase() === wanted.toLowerCase();
  /**
   * Every CONCRETE write path the (already styled / renamed) chain resolves to.
   * Exact match first, case-insensitive fallback, one level at a time.
   */
  const resolveWritePaths = (chain: readonly string[]): string[] => {
    if (chain.length === 0) return [];
    let level = rootScopes.filter((r) => matchesSegment(r, chain[0]!));
    for (let i = 1; i < chain.length; i++) {
      const next: string[] = [];
      for (const parent of level) {
        for (const child of childrenOf.get(parent) ?? []) {
          if (matchesSegment(child, chain[i]!)) next.push(`${parent}.${child}`);
        }
      }
      level = next;
      if (level.length === 0) break;
    }
    return level;
  };
  const chainResolves = (chain: readonly string[]): boolean =>
    chain.length === 0 || resolveWritePaths(chain).length > 0;

  const out: NestedKeyClassification[] = [];
  const seenPaths = new Set<string>();
  const sorted = [...nestedKeyPaths].sort((a, b) => a.path.localeCompare(b.path));
  for (const { path, key, segments, topLevelProperty } of sorted) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    const expected = styled(key);
    let bucket: Bucket;
    let sdkNearMiss: string | undefined;
    let rationale: string | undefined;
    let allowMatchKey: string | undefined;
    // Chain machinery shared by BOTH branches below (hoisted by issue #1393
    // item 2 — the no-SDK-member branch now consults the same write index).
    // Non-terminal segments carry the target's declared RENAMES; the terminal
    // never does (it IS the audited key — see `segmentRenames`; a DECLARED
    // terminal correspondence is `terminalRenames`' separate, path-keyed
    // job). A rename value may be DOTTED (`LoggingConfiguration` ->
    // `BucketLoggingStatus.LoggingEnabled` — an SDK-only wrapper level the
    // CFn shape flattens), so the chain is flattened one write-index level
    // per dotted part (issue #1520). A key may be SCOPED by the segment's
    // immediate CFn parent (`'S3Key.Rules': 'FilterRules'`, issue #1540) —
    // matched on the ORIGINAL CFn spellings, winning over a bare-name entry
    // — so one rename can never leak onto a same-named segment elsewhere
    // (`LifecycleConfiguration.Rules` stays untouched by the notification
    // entry above).
    const renameKeyAt = (i: number): string | undefined => {
      if (i > 0 && renames[`${segments[i - 1]}.${segments[i]}`] !== undefined) {
        return `${segments[i - 1]}.${segments[i]}`;
      }
      return renames[segments[i]!] !== undefined ? segments[i]! : undefined;
    };
    const parentChain = segments.slice(0, -1).flatMap((seg, i) => {
      const renameKey = renameKeyAt(i);
      return (renameKey === undefined ? styled(seg) : renames[renameKey]!).split('.');
    });
    const parentPaths = resolveWritePaths(parentChain);
    const terminalEntry = (target.terminalRenames ?? {})[path];
    // TERMINAL rename / relocation (issue #1540): redirect the judgment to
    // the declared SDK spelling — still verbatim, still scope-checked, at
    // the parent chain extended by the entry's scope-insertion parts.
    const resolveRenamedTerminal = (): boolean => {
      if (terminalEntry === undefined) return false;
      const parts = terminalEntry.split('.');
      const renamedTerminal = parts[parts.length - 1]!;
      const extendedChain = [...parentChain, ...parts.slice(0, -1)];
      return (
        resolveWritePaths(extendedChain).some(
          (p) => writeEvidence.scopes.get(p)?.has(renamedTerminal) ?? false
        ) ||
        isHandoffCovered(
          writeEvidence.handoffScopes,
          extendedChain.join('.'),
          renamedTerminal,
          writeEvidence.handoffExclusions
        )
      );
    };
    // Record which segment renames still EARN their place. The test is stated
    // as its negation so it cannot MASK a real finding: an entry goes unused
    // only when the UN-RENAMED chain resolves — i.e. the SDK (or the provider)
    // renamed the member back and the map is now redundant. When NEITHER
    // chain resolves the provider is simply not writing the member; the
    // entry is still the right bridge, and the run must report that
    // divergence rather than a stale-map error on top of it.
    const recordUsedSegmentRenames = (): void => {
      if (usedSegmentRenames === undefined) return;
      for (let i = 0; i < segments.length - 1; i++) {
        const renameKey = renameKeyAt(i);
        if (renameKey === undefined) continue;
        const plain = segments.slice(0, i + 1).map((seg) => styled(seg));
        if (!chainResolves(plain)) usedSegmentRenames.add(renameKey);
      }
    };
    if (sdkMembers.has(expected)) {
      // WRITE-EVIDENCE pass (issues #1432 / #1448 / #1464). A matching SDK
      // spelling only proves delivery for a provider that FORWARDS the blob; a
      // fresh-object mapper has to name the member IN THE RIGHT PLACE — and
      // "the right place" is the FULL parent chain, not just the top level.
      // Deliberately NOT rescued by `providerLiterals`: the CFn spelling
      // appearing somewhere in the file is the loose heuristic this pass exists
      // to stop trusting.
      const coveredPlain =
        parentPaths.some((p) => writeEvidence.scopes.get(p)?.has(expected) ?? false) ||
        isHandoffCovered(
          writeEvidence.handoffScopes,
          parentChain.join('.'),
          expected,
          writeEvidence.handoffExclusions
        );
      const coveredRenamed = coveredPlain ? false : resolveRenamedTerminal();
      const covered = coveredPlain || coveredRenamed;
      recordUsedSegmentRenames();
      // Same negation for terminal entries: unused only when the PLAIN
      // terminal already resolves (the map is redundant); a still-unresolved
      // renamed terminal keeps both the entry and the reported divergence.
      if (usedTerminalRenames !== undefined && terminalEntry !== undefined && !coveredPlain) {
        usedTerminalRenames.add(path);
      }
      if (target.freshObjectMapper === true && !covered) {
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
    } else {
      // No SDK member at the styled spelling: the provider must CONVERT the
      // key, and a string literal somewhere in the file used to be the whole
      // proof it does. That heuristic is FILE-GLOBAL, and issue #1393 (item 2)
      // measured it rescuing broken write paths: a key named legitimately at
      // one place (a reverse map, an unrelated top-level) vouched for every
      // same-spelled occurrence anywhere in the file — the pre-#1426
      // s3-bucket-provider lifecycle defects sat exactly there, and the
      // rescue ALSO masked case-divergences (item 1: a literal outranked the
      // near-miss check below).
      //
      // For a write-evidence target the literal is therefore only trusted
      // WITH scoped delivery proof, either of:
      //   - a genuine SDK member, written at the RESOLVED parent scope, whose
      //     case-folded name equals the audited key (the case-fold class:
      //     CFn `EFSVolumeConfiguration` written as SDK
      //     `efsVolumeConfiguration`). The member check is load-bearing — a
      //     provider writing a case-mangled NON-member at the right scope is
      //     the bug itself, not evidence;
      //   - a declared {@link NestedKeyTarget.terminalRenames} entry that
      //     resolves (the non-case renames: `ExposedHeaders` ->
      //     `ExposeHeaders`), judged by the same write-side test the
      //     same-spelling branch applies.
      // A whole-blob HAND-OFF is deliberately NOT accepted here: a verbatim
      // forward delivers the CFn spelling, which by this branch's premise
      // matches no SDK member, so the serializer drops it on the wire — the
      // hand-off can vouch for a same-spelling interior, never for a
      // divergent one. Conversions real but invisible to the write walk
      // (computed-key rename loops, destructured helper returns) carry
      // `passes: ['key']` allow-list entries instead, per the
      // `CorsConfiguration.CorsRules` precedent.
      //
      // A target WITHOUT the write-evidence opt-in keeps the file-global
      // rescue: there is no scope index to check against, and inventing one
      // from nothing would flag every key of a legitimately blob-forwarding
      // provider.
      //
      // This path is LIVE, not a future-target fallback: since issue #1393
      // item 3, `AWS::Lambda::EventSourceMapping` is a target that
      // deliberately does not opt in (its blobs are verbatim casts, so the
      // write pass measures 0/37 — see its entry in NESTED_KEY_TARGETS), and
      // its ONE `provider-handled` verdict
      // (`SelfManagedEventSource.Endpoints.KafkaBootstrapServers`) rests on
      // exactly this rescue — under a FORCED opt-in the same key reports
      // `no-sdk-member`. That is the intended reading for a #1384-class key
      // (a map keyed by an enum value has no member to write), but it means
      // the loose path's known weakness applies to that target: a future
      // nested member sharing the name of any PascalCase literal already in
      // the provider file would be rescued without per-key evidence. Scope it
      // by opting the target in, or by a path-scoped allow-list entry, if
      // that ever stops being acceptable.
      const near = sdkLower.get(key.toLowerCase());
      const allowed = lookupAllowEntry(allowList, target.resourceType, path, key, 'key');
      let literalRescued: boolean;
      if (target.freshObjectMapper === true) {
        const ciWrittenSdkMember = parentPaths.some((p) =>
          [...(writeEvidence.scopes.get(p) ?? [])].some(
            (m) => m.toLowerCase() === key.toLowerCase() && sdkMembers.has(m)
          )
        );
        // Same stale-fence negation as the same-spelling branch: a terminal
        // entry is unused only when the UN-renamed evidence already suffices.
        if (usedTerminalRenames !== undefined && terminalEntry !== undefined && !ciWrittenSdkMember) {
          usedTerminalRenames.add(path);
        }
        recordUsedSegmentRenames();
        literalRescued =
          providerLiterals.has(key) && (ciWrittenSdkMember || resolveRenamedTerminal());
      } else {
        literalRescued = providerLiterals.has(key);
      }
      if (literalRescued) {
        bucket = 'provider-handled';
      } else if (allowed) {
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
 * One audited unit: a FULL nested CFn key chain, rooted at the handled
 * top-level property (issues #1448 / #1464).
 *
 * Through #1448 the fixture only offered the FLATTENED per-top-level capture,
 * so `path` was a two-segment `Top.Member` even for a member living three
 * levels down — and `Environment.Type` and
 * `Environment.EnvironmentVariables.Type` were literally the same audited unit,
 * each vouching for the other. The `nestedPropertyPaths` capture (#1464) keeps
 * the chain, so `segments` is the real depth and the write side is scoped to
 * match.
 */
export interface NestedKeyPath {
  /** Handled top-level CFn property the key is reachable beneath. */
  readonly topLevelProperty: string;
  /** The nested key's own name — the LAST segment. */
  readonly key: string;
  /** `Top.A.B` — the audited unit, `segments` joined. */
  readonly path: string;
  /** The full chain, top-level first. Arrays are transparent (no `[]` marker). */
  readonly segments: readonly string[];
}

/**
 * The nested CFn key PATHS audited for a target: the fixture's
 * `nestedPropertyPaths` entries for the top-level properties THIS PROVIDER
 * handles on the type. Unhandled top-levels are pre-flight-rejected by
 * `property-coverage`, so their interiors are unreachable through this
 * provider by construction.
 *
 * Reads the PER-PATH capture (#1464). The flattened `nestedProperties` stays in
 * the fixture — the shape pass and the `minNestedKeys` floors of targets that
 * have not migrated are calibrated against it — but the key pass no longer
 * consults it.
 */
export function nestedKeyPathsForTarget(
  fixture: {
    nestedPropertyPaths?: Record<string, string[]>;
  },
  handledTopLevel: ReadonlySet<string>
): NestedKeyPath[] {
  const nested = fixture.nestedPropertyPaths ?? {};
  const out = new Map<string, NestedKeyPath>();
  for (const [topLevelProperty, chains] of Object.entries(nested)) {
    if (!handledTopLevel.has(topLevelProperty)) continue;
    for (const chain of chains) {
      const segments = [topLevelProperty, ...chain.split('.')];
      const path = segments.join('.');
      const key = segments[segments.length - 1]!;
      if (!out.has(path)) out.set(path, { topLevelProperty, key, path, segments });
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

/**
 * {@link NestedKeyTarget.segmentRenames} entries that no longer do any work —
 * the staleness fence {@link NESTED_KEY_ALLOW_LIST} has, applied to the rename
 * map so it cannot rot into a set of inert exceptions.
 *
 * "Does work" is the classifier's own measurement, not a re-derivation, and it
 * is deliberately stated as a NEGATION so the fence cannot mask a real finding:
 * an entry goes unused exactly when the UN-RENAMED chain resolves in the write
 * index, or when the CFn segment no longer appears in any audited path at all.
 * Both ways it can go dead are therefore caught — an SDK bump that renames the
 * member back, and an AWS schema change that drops the property. What is NOT
 * treated as stale is "neither chain resolves": that is the provider failing to
 * write the member, and the run must report THAT divergence rather than a
 * stale-map error standing in front of it.
 */
export function findStaleSegmentRenames(
  report: NestedKeyCoverageReport,
  targetList: readonly NestedKeyTarget[] = NESTED_KEY_TARGETS
): string[] {
  const usedByType = new Map(report.targets.map((t) => [t.resourceType, new Set(t.usedSegmentRenames)]));
  const stale: string[] = [];
  for (const target of targetList) {
    const used = usedByType.get(target.resourceType);
    if (used === undefined) continue; // not in this report
    for (const segment of Object.keys(target.segmentRenames ?? {})) {
      if (!used.has(segment)) stale.push(`${target.resourceType}#${segment}`);
    }
  }
  return stale.sort();
}

/**
 * {@link NestedKeyTarget.terminalRenames} entries that no longer do any work —
 * the terminal twin of {@link findStaleSegmentRenames}, same semantics: an
 * entry is stale when the UN-renamed terminal already resolves (redundant) or
 * its path is no longer audited; a still-unresolved RENAMED terminal is NOT
 * stale, because the run must keep reporting that divergence (issue #1540).
 */
export function findStaleTerminalRenames(
  report: NestedKeyCoverageReport,
  targetList: readonly NestedKeyTarget[] = NESTED_KEY_TARGETS
): string[] {
  const usedByType = new Map(
    report.targets.map((t) => [t.resourceType, new Set(t.usedTerminalRenames)])
  );
  const stale: string[] = [];
  for (const target of targetList) {
    const used = usedByType.get(target.resourceType);
    if (used === undefined) continue; // not in this report
    for (const path of Object.keys(target.terminalRenames ?? {})) {
      if (!used.has(path)) stale.push(`${target.resourceType}#${path}`);
    }
  }
  return stale.sort();
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
  providersDir: string = PROVIDERS_DIR,
  // Test seam (issue #1464): point the FIXTURE walk at a scratch copy, so the
  // "this fixture was never re-captured" throw is provable in the RED
  // direction without hand-editing a committed fixture. Never exposed on the
  // CLI — a partially-captured fixture tree is an operator mistake, not a mode.
  fixtureDir: string = FIXTURE_DIR
): NestedKeyCoverageReport {
  const sdkMembersByPackage = new Map<string, Set<string>>();
  const sdkInterfacesByPackage = new Map<string, Map<string, Map<string, SdkMemberType>>>();
  const literalsByFile = new Map<string, Set<string>>();
  const writtenByFile = new Map<string, ProviderWriteEvidence>();
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
    const fixturePath = join(fixtureDir, fixtureFilename(target.resourceType));
    if (!existsSync(fixturePath)) {
      throw new Error(
        `missing CFn schema fixture for ${target.resourceType} — run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\``
      );
    }
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      nestedPropertyPaths?: Record<string, string[]>;
      definitionShapes?: Record<string, Record<string, string>>;
    };
    // The refresher omits `nestedPropertyPaths` entirely for a type with zero
    // nested names, so absence is only an error when the target expects a
    // non-zero yield — for a `minNestedKeys: 0` target it just means
    // "nothing to audit".
    if (!fixture.nestedPropertyPaths && target.minNestedKeys > 0) {
      throw new Error(
        `fixture for ${target.resourceType} has no nestedPropertyPaths capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1464)'
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

    const shapeResult = classifyTargetShapes(
      target,
      fixture.definitionShapes,
      sdkInterfaces,
      literals
    );

    const usedSegmentRenames = new Set<string>();
    const usedTerminalRenames = new Set<string>();
    const entries = classifyTarget(
      target,
      nestedKeys,
      sdkMembers,
      literals,
      NESTED_KEY_ALLOW_LIST,
      written,
      usedSegmentRenames,
      usedTerminalRenames
    );

    targets.push({
      resourceType: target.resourceType,
      providerFile: target.providerFile,
      sdkClientPackage: target.sdkClientPackage,
      keyStyle: target.keyStyle,
      freshObjectMapper: target.freshObjectMapper === true,
      nestedKeyCount: nestedKeys.length,
      entries,
      shapeEntries: shapeResult.entries,
      shapeCleanCount: shapeResult.cleanCount,
      unmatchedDefinitions: shapeResult.unmatchedDefinitions,
      usedSegmentRenames: [...usedSegmentRenames].sort(),
      usedTerminalRenames: [...usedTerminalRenames].sort(),
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

  // Same discipline for the segment-rename map (issue #1464 review): an entry
  // that stopped doing work is an inert exception, and the only way to keep a
  // narrow escape hatch narrow is to make it fail when it is no longer needed.
  const staleRenames = findStaleSegmentRenames(report);
  if (staleRenames.length > 0) {
    process.stderr.write(
      'nested-key-coverage: FAIL — stale segmentRenames entr(ies) no longer resolve anything ' +
        'the un-renamed chain does not. Remove them from scripts/gen-nested-key-coverage.ts:\n' +
        staleRenames.map((k) => `  ${k}\n`).join('')
    );
    process.exit(1);
  }

  const staleTerminals = findStaleTerminalRenames(report);
  if (staleTerminals.length > 0) {
    process.stderr.write(
      'nested-key-coverage: FAIL — stale terminalRenames entr(ies): the un-renamed terminal ' +
        'already resolves (or the path is no longer write-audited), so the entry is dead ' +
        'weight. Remove them from scripts/gen-nested-key-coverage.ts:\n' +
        staleTerminals.map((k) => `  ${k}\n`).join('')
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
