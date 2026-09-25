---
description: cdkd provisioning layout - registry, helpers, pre-flight tables, providers
paths:
  - 'src/provisioning/**'
---

# Key Files and Directories - src/provisioning

Provider contract: [providers.md](providers.md). Deletes: [provider-delete-path.md](provider-delete-path.md). Index: [code-layout.md](code-layout.md).

## Important Files

- **register-providers.ts** - Which types HAVE an SDK provider (`provider-registry.ts` decides which one RUNS a resource; do not confuse them).

- **provider-registry.ts** - The ROUTING decision, in order: Custom Resource -> CR provider; a `provisionedBy: 'cc-api'` record -> Cloud Control, STICKY unless `wouldReturnToSdkProvider` says otherwise (one spelling, shared with `cdkd diff`; per-type escapes in `STICKY_CC_MIGRATION_EXEMPT` — issue [#2719](https://github.com/go-to-k/cdkd/issues/2719)); an SDK provider with no silent-drop property -> that one; a silent drop -> Cloud Control, unless `NON_PROVISIONABLE` or `disableCcApiFallback` refuse it pre-flight. **DELETE logic as much as create logic**, hence in the `integ-destroy` gate scope.

- **import-helpers.ts** - `resolveExplicitPhysicalId` + `normalizeAwsTagsToCfn` for `import()`. The normalizer strips `aws:`-prefixed tags, which would fire false drift; deliberately no `aws:cdk:path` tag walk, since AWS rejects `aws:` tag writes.

- **data-delete-intent.ts** - The CDK auto-delete tag keys. S3 auto-empties, and ECR sends `force: true`, ONLY with the tag, `EmptyOnDelete: true`, or `DeleteContext.forceDataDelete` — set only by the engine's replacement / recreate deletes under `--force-stateful-recreation`.

- **region-check.ts** - `DeleteContext` + `assertRegionMatch()`: THREE outcomes (region unset or empty -> no-op; match -> silent; mismatch or unresolvable client region -> non-retryable refusal). Pre-flight phases exist because physical ids are usually NAMES shared across regions: a wrong-region call hits the WRONG resource.

- **config-shape.ts** - Shape guards for reading CFn config blocks, which otherwise substitute a default — often the OPPOSITE of the declared intent — for a malformed container (issue [#1471](https://github.com/go-to-k/cdkd/issues/1471)). **A guard behind a TRUTHINESS gate is skipped by a FALSY malformed container: the gate must be `!= null`.** `onUnusable` (warn + default) is for UPDATE-path sites ONLY, since a rollback replays `update()` with a STATE record as the desired bag.

- **attribute-map.ts** - `definedAttributes(entries)` DROPS every `undefined` / `null`, because **an attribute cdkd could not read back must be ABSENT**: the resolver serves any stored value, so a recorded `''` shadows the live-read arms forever. An empty string AWS ITSELF reported is KEPT. A LEAF (issue [#3077](https://github.com/go-to-k/cdkd/issues/3077)).

- **ec2-instance-state.ts** - `isSettledInstanceState(stateName)`: `pending` and NO state are unsettled, everything else is settled. Shared by the provider and the resolver's live arm, which must not disagree. A LEAF.

- **composite-id.ts** - Refusal guard for COMPOSITE physicalIds (issue [#1672](https://github.com/go-to-k/cdkd/issues/1672)). The separator is unescaped, so a segment containing one yields the wrong ARITY yet passes every guard: the deploy SUCCEEDS, then destroy deletes the wrong one. `packCompositeId` is the ACTION (throws, or warns-and-packs while replaying state); `compositeIdSeparatorRefusal` is the bare PREDICATE for `import()` paths that warn-and-SKIP.

- **nested-stack-messages.ts** - What `NestedStackProvider.delete` THROWS on child-destroy errors. **Must stay a LEAF — no imports, ever**: importing it back from the provider closes a cycle through `destroy-runner.ts`. A builder, not a literal: both callers classify failures by MESSAGE and read already-deleted phrases as idempotent success, DROPPING the state row.

- **replacement-protection-advice.ts** - What a provider says INSTEAD of a bare "re-deploy with `--replace`" for a protection-flagged resource (issue [#2610](https://github.com/go-to-k/cdkd/issues/2610)): the advised DELETE runs from the deploy engine, which never sets `DeleteContext.removeProtection`, so AWS refuses it. Callers owe `evidence` naming the BAG they read, and a `disable.command` changing nothing but the flag.

- **final-snapshot.ts** - `DeletionPolicy` / `UpdateReplacePolicy: Snapshot`. ATOMIC types thread `DeleteContext.finalSnapshotIdentifier` and flip `SkipFinalSnapshot` — SDK route ONLY, and `CloudControlProvider.delete` fail-closes on the field. **The atomic and pre-delete sets must stay DISJOINT**: atomic is tested first, so a type in both never reaches the pre-delete snapshot.

- **emr-configuration.ts** - CFn -> SDK converters for `AWS::EMR::*` nested config blobs (`ConfigurationProperties` / `StepProperties` -> `Properties`). Pure key renames, but the SDK v3 serializer DROPS unknown members, so without them an EMR application configuration silently vanishes.

- **dynamodb-warm-throughput.ts** - Numeric-member rules shared by both DynamoDB providers. `coerceWarmThroughput`'s `spec` presence IS the sendability predicate, so write-side and drift-side cannot answer differently; `isWarmThroughputDecrease` fails OPEN on a mixed or unreadable live block, since AWS rejects an `UpdateTable` that LOWERS warm throughput.

- **dynamodb-contributor-insights.ts** - ONE reader for the table-level and per-index `ContributorInsightsSpecification`. The per-index block is NOT an SDK `GlobalSecondaryIndex` member: it goes through `UpdateContributorInsights` + `IndexName`, and its read-back is GATED on the desired entry declaring it, since it sits in an array entry compared by exact key set (issue [#1782](https://github.com/go-to-k/cdkd/issues/1782)).

- **dynamodb-stream-members.ts** - `StreamSpecification.ResourcePolicy` / `.Tags` are NOT SDK `StreamSpecification` members: they go to the STREAM arn, and a `StreamViewType` change mints a NEW one, so they are re-applied to the re-read `LatestStreamArn`. The plan's ORDER is a contract (policy delete first, put last), and an unreadable member is REFUSED on a template-path update too: it is an access grant (issue [#3458](https://github.com/go-to-k/cdkd/issues/3458)).

- **dynamodb-index-busy-delete.ts** - The index-busy `DeleteTable` rule BOTH DynamoDB providers read; it is TRANSIENT. The classifier is keyed on the MESSAGE, since AWS reports a plain `ResourceInUseException` for terminal conflicts too. The settle poll warns and RETURNS on timeout, because a throw would STRAND the resource, and **it runs PER RETRY**, so the budget is PER CALLING TYPE.

- **remove-protection-types.ts** - The ONE list both `--remove-protection` help strings render from (SDK types, then the CC registry). `remove-protection-types.test.ts` binds it to the provider files that read `removeProtection`, in both directions ([#2660](https://github.com/go-to-k/cdkd/issues/2660)).

- **ec2-termination-protection.ts** - Shared `--remove-protection` helper for `AWS::EC2::Instance`. The modify WRITE lags the delete READ, so both routes flip protection off AND retry the delete. A CC-routed ASG cannot `ForceDelete`, so `CloudControlProvider.delete` delegates that case to `ASGProvider.delete`.

- **ec2-volume-delete.ts** - `CloudControlProvider.delete` deletes EVERY `AWS::EC2::Volume` with EC2 `DeleteVolume`, never `DeleteResource`: the registry handler can snapshot the volume itself and then hang (issue [#3455](https://github.com/go-to-k/cdkd/issues/3455)). Its region check runs OUTSIDE the delete `try`, and its timeout is a marked abandoned wait, because the already-deleted arm matches substrings of the logical id.

- **unsupported-types.ts** + **.generated.ts** - Pre-flight unsupported-type rejection. The generated half ships the Tier 3 set (`NON_PROVISIONABLE`), codegen'd from the provider-coverage JSON; CI fails on drift. `--allow-unsupported-types` routes named types through CC.

- **property-coverage.ts** + **.generated.ts** - Property-level REPORTING and routing, NOT a rejection; the generated per-type `{ handled, silentDrop }` map is built offline from the committed schema fixtures (CI fails on drift). `--allow-unsupported-properties` opts named entries back INTO the drop, keeping the SDK path. **An accepted drop is not RECORDED either** (issue [#2750](https://github.com/go-to-k/cdkd/issues/2750)): the allow set is per `<Type>:<Prop>` but the ROUTE is per RESOURCE, so ONE un-allowed drop routes the whole resource through CC and nothing is dropped. Both narrowings must KEEP an un-allowed drop, and neither removes a CREATE-ONLY drop, which would become an ADDITION next deploy — a replacement of a resource nobody touched. A property in NEITHER map (unrecognized) ROUTES like a drop unless read-only, allow-listed, on a type with no CC route, or held unchanged by the state record — that baseline is what keeps an existing deployment on its route, so every existing-resource caller threads the record's bag, and the narrowings stay schema-known only ([design](../../docs/design/3713-route-unrecognized-properties.md)).

- **mutually-exclusive-properties.ts** - Pre-flight rejection of property COMBINATIONS AWS accepts only one of, reachable nowhere else: once the resource exists the diff says `NO_CHANGE` forever. **The presence predicate is load-bearing**: pre-flight runs BEFORE intrinsic resolution, so a key behind an unresolved intrinsic counts as UNKNOWN, never declared.

- **nested-required.ts** + **.generated.ts** - Pre-flight rejection of a PRESENT nested block missing a schema-`required` member (issue [#1802](https://github.com/go-to-k/cdkd/issues/1802)). **A schema `required` list is not evidence CloudFormation enforces it**: `CFN_ENFORCED_TYPES` holds only types MEASURED to refuse, so a type joins it by measurement, never by reading its schema.

- **interrupt-watch.ts** - The ONE SIGINT watch every bounded wait here uses, plus `InterruptedWaitError` and the cause-chain classifier (NO depth ceiling — the chain grows one error per nested-stack level). ONE error type: a bare `Error` from a provider reads as a resource failure and triggers an automatic ROLLBACK on Ctrl-C. ONE STICKY latch, cleared only by a COMMAND scope and armed only inside it — never on `process.listenerCount('SIGINT') > 0`, which a concurrent waiter's listener would arm permanently.
  - **A lock-holding command must release BEFORE unregistering its SIGINT handler.** `destroy-runner.ts` re-syncs `result.interrupted` GATED on `statePreserved`: **a stack whose state was deleted never reports `interrupted`**. Each signal has ONE owner: PER-STACK is `result.interrupted`, PER-RUN is the watch, and the exit code ORs in `stoppedEarly`.

- **describe-type.ts** - Shared `cloudformation:DescribeType` with THROTTLE-ONLY retry, for the write-only / read-only / create-only resolvers and `export.ts`, whose fallbacks would turn a throttle into a real failure. Every call takes a slot of ONE process-wide limiter (`DESCRIBE_TYPE_MAX_IN_FLIGHT`, issue [#3718](https://github.com/go-to-k/cdkd/issues/3718)); a prefetch is BACKGROUND, so an awaited lookup never queues behind one. **Resolve the client when SCHEDULING, never inside the task**: a queued task starts inside whichever task finished, in THAT task's per-stack AWS scope. `hasNoRegistrySchema()` is the ONE list of types with no registry entry, for which DescribeType can only fail.

- **write-only-properties.ts** - Resolves the registry schema's `writeOnlyProperties`, caching **only SUCCESSFUL lookups**. `CloudControlProvider.update` strips them from the PREVIOUS side before patch generation: read handlers cannot return them, so one absent from the patch is dropped on every UPDATE.

- **read-only-properties.ts** - For `CloudControlProvider.import`'s attribute narrowing (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)). **The RETURN TYPE is the point of the module**: `undefined` means "could not find out" and an empty set means "declares no attributes", so returning `new Set()` on failure re-opens the disclosure.

- **cc-import-identifier.ts** - Completes the bare CloudFormation id `CloudControlProvider.import()` receives into the `|`-joined Cloud Control identifier for a COMPOSITE `primaryIdentifier`, read from the live schema (issue [#3672](https://github.com/go-to-k/cdkd/issues/3672)). The completed value is also what gets RECORDED. It REFUSES rather than guesses when the template cannot supply exactly the other fields.

- **slow-cc-operation-timeouts.ts** - Per-(resourceType, operation) wall-clock timeout FLOORS, and the SINGLE source for the CC poll cap and both outer deadlines, so they cannot drift.

- **resource-timeout-registry.ts** - Registry of the resolved `--resource-timeout` input: per-type override > explicit global > `undefined`. **The compile-time 30m default deliberately does NOT leak in**: only an explicit user value may lift an inner waiter's floor.

- **create-only-properties.ts** - Create-only resolution for REPLACEMENT detection, compared at PATH granularity so a nested entry forces replacement only when the value AT that path changed. **The fallback is only as good as the registry schema**: some types declare NO `createOnlyProperties` though AWS rejects the update (`AWS::EC2::Volume`, issue [#1356](https://github.com/go-to-k/cdkd/issues/1356)), so they need a hand-authored `ReplacementRulesRegistry` entry, plus a `STATEFUL_TYPES` one if data-bearing. A FAILED lookup resolves the committed `create-only-snapshot.generated.ts` (the fixtures' `createOnlyPropertyPaths`, parsed by the same `create-only-paths.ts` leaf as the live schema) and is NOT cached, so the live answer wins once it returns. **A prefetch's owner must `cancel()` it when its diff is done**, on every path: an unawaited background lookup in a throttle backoff otherwise holds the command open.

- **stateful-types.ts** - The data-loss guard list and its verdict helpers (issue [#615](https://github.com/go-to-k/cdkd/issues/615)): a wrong edit here silently DELETEs + CREATEs a user's data. Its two mechanical LOWER BOUNDS miss the residual — a delete that destroys data with no opt-in — so such entries are hand-added with the reason AT the entry. Conditional reasons stay HEDGED — `renderStatefulReason` renders where no probe ran.

## SDK Providers

SDK Providers live in `src/provisioning/providers/`, registered in `register-providers.ts`; Cloud Control is the fallback for types without one. Full list: [docs/supported-resources.md](../../docs/supported-resources.md).
