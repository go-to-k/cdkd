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

- **import-helpers.ts** - `resolveExplicitPhysicalId` + `normalizeAwsTagsToCfn` for `import()`. The normalizer strips `aws:`-prefixed tags (false drift); no `aws:cdk:path` tag walk, since AWS rejects `aws:` tag writes.

- **data-delete-intent.ts** - The CDK auto-delete tag keys. S3 auto-empties, and ECR sends `force: true`, ONLY with the tag, `EmptyOnDelete: true`, or `DeleteContext.forceDataDelete` — set only by the engine's replacement / recreate deletes under `--force-stateful-recreation`.

- **region-check.ts** - `DeleteContext` + `assertRegionMatch()`: THREE outcomes (region unset or empty -> no-op; match -> silent; mismatch or unresolvable client region -> non-retryable refusal). Pre-flight phases exist because physical ids are usually NAMES shared across regions: a wrong-region call hits the WRONG resource.

- **config-shape.ts** - Shape guards for reading CFn config blocks, which otherwise substitute a default — often the OPPOSITE of the declared intent — for a malformed container (issue [#1471](https://github.com/go-to-k/cdkd/issues/1471)). **A guard behind a TRUTHINESS gate is skipped by a FALSY malformed container: the gate must be `!= null`.** `onUnusable` (warn + default) is for UPDATE-path sites ONLY, since a rollback replays `update()` with a STATE record as the desired bag.

- **attribute-map.ts** - `definedAttributes(entries)` DROPS every `undefined` / `null`, because **an attribute cdkd could not read back must be ABSENT**: the resolver serves any stored value, so a recorded `''` shadows the live-read arms forever. An empty string AWS ITSELF reported is KEPT. A LEAF (issue [#3077](https://github.com/go-to-k/cdkd/issues/3077)).

- **auxiliary-failure.ts** - `markAuxiliaryFailure`: a failing AUXILIARY write inside a provider's `create()` is anchored to a logical id no template can spell, so the name-collision classifier never credits it to the resource ([name-collision-classification.md](name-collision-classification.md), [#3826](https://github.com/go-to-k/cdkd/issues/3826)); `isAuxiliaryFailure` is what `withRetry` latches on to carry the mark forward ([#3972](https://github.com/go-to-k/cdkd/issues/3972)). A LEAF.

- **ec2-instance-state.ts** - `isSettledInstanceState(stateName)`: `pending` and NO state are unsettled, everything else is settled. Shared by the provider and the resolver's live arm, which must not disagree. A LEAF.

- **iam-policy-targets.ts** - every IAM principal list is read here ([#3878](https://github.com/go-to-k/cdkd/issues/3878), [#3906](https://github.com/go-to-k/cdkd/issues/3906)). Malformed is refused before ANY call; only a secret-derived RECORDED list on a ManagedPolicy / InstanceProfile / User `Groups` UPDATE is read from IAM. `IAM::Policy` and every create refuse it. A LEAF.

- **redacted-delete-address.ts** - A delete ADDRESSING a resource through a recorded property must not send cdkd's own redaction (`***` or a `{{resolve:...}}` expression) to AWS ([#3952](https://github.com/go-to-k/cdkd/issues/3952)): an unknown name often answers not-found, which the idempotent arm reads as DELETED. Fall back to an unredacted source first; else `redactedDeleteAddressSkip`. A delete-then-create caller must ABORT on that skip. `CustomResourceProvider` keeps its own ServiceToken arms.

- **composite-id.ts** - Refusal guard for COMPOSITE physicalIds (issue [#1672](https://github.com/go-to-k/cdkd/issues/1672)). The separator is unescaped, so a segment containing one yields the wrong ARITY yet passes every guard: the deploy SUCCEEDS, then destroy deletes the wrong one. `packCompositeId` is the ACTION (throws, or warns-and-packs while replaying state); `compositeIdSeparatorRefusal` is the bare PREDICATE for `import()` paths that warn-and-SKIP. A type whose every reader ANCHORS on a recorded segment via `segmentAfterAnchor` (without one, the decode sites read only the exact arity and skip the rest) need not pack through here at all: `AWS::Glue::Table` builds `<db>|<table>` directly, `|` allowed in both ([#3892](https://github.com/go-to-k/cdkd/issues/3892)).

- **nested-stack-messages.ts** - What `NestedStackProvider.delete` THROWS on child-destroy errors. **Must stay a LEAF — no imports, ever**: importing it back from the provider closes a cycle through `destroy-runner.ts`. A builder, not a literal: both callers classify failures by MESSAGE and read already-deleted phrases as idempotent success, DROPPING the state row.

- **replacement-protection-advice.ts** - What a provider says INSTEAD of a bare "re-deploy with `--replace`" for a protection-flagged resource (issue [#2610](https://github.com/go-to-k/cdkd/issues/2610)): the deploy engine's DELETE never sets `DeleteContext.removeProtection`, so AWS refuses it. Callers owe `evidence` naming the BAG they read, and a `disable.command` changing nothing but the flag. Also the gate provider sites route a pasteable `aws ...` command's values through: `renderDisableCommand`, or the tagged `pasteableAwsCommand` for several values ([#3136](https://github.com/go-to-k/cdkd/issues/3136)).

- **final-snapshot.ts** - `DeletionPolicy` / `UpdateReplacePolicy: Snapshot`. ATOMIC types thread `DeleteContext.finalSnapshotIdentifier` — SDK route ONLY; `CloudControlProvider.delete` fail-closes on it, and under an EXPLICIT `deletionPolicy: 'Delete'` hands an RDS cluster or instance to `RDSProvider.delete` pinned to the CC client's region ([#3993](https://github.com/go-to-k/cdkd/issues/3993)). `effectiveDeletionPolicy` applies CloudFormation's ABSENT default (`Snapshot` for an RDS cluster or standalone instance) where a DeletionPolicy is CONSUMED, never where it is recorded — `cdkd diff` compares the record to the template ([#4030](https://github.com/go-to-k/cdkd/issues/4030)). **The atomic and pre-delete sets must stay DISJOINT**: atomic is tested first.

- **emr-configuration.ts** - CFn -> SDK converters for `AWS::EMR::*` nested config blobs (`ConfigurationProperties` / `StepProperties` -> `Properties`). Pure key renames, but the SDK v3 serializer DROPS unknown members.

- **dynamodb-warm-throughput.ts** - Numeric-member rules shared by both DynamoDB providers. `coerceWarmThroughput`'s `spec` presence IS the sendability predicate, so write-side and drift-side cannot answer differently; `isWarmThroughputDecrease` fails OPEN on a mixed or unreadable live block, since AWS rejects an `UpdateTable` that LOWERS warm throughput.

- **dynamodb-contributor-insights.ts** - ONE reader for the table-level and per-index `ContributorInsightsSpecification`. The per-index block is NOT an SDK `GlobalSecondaryIndex` member: it goes through `UpdateContributorInsights` + `IndexName`, and its read-back is GATED on the desired entry declaring it, since it sits in an array entry compared by exact key set (issue [#1782](https://github.com/go-to-k/cdkd/issues/1782)).

- **dynamodb-stream-members.ts** - `StreamSpecification.ResourcePolicy` / `.Tags` are NOT SDK `StreamSpecification` members: they go to the STREAM arn, and a `StreamViewType` change mints a NEW one, so they are re-applied to the re-read `LatestStreamArn`. The plan's ORDER is a contract (policy delete first, put last), and an unreadable member is REFUSED on a template-path update too: it is an access grant (issue [#3458](https://github.com/go-to-k/cdkd/issues/3458)).

- **dynamodb-index-busy-delete.ts** - The index-busy `DeleteTable` rule BOTH DynamoDB providers read; it is TRANSIENT. The classifier is keyed on the MESSAGE, since AWS reports a plain `ResourceInUseException` for terminal conflicts too. The settle poll warns and RETURNS on timeout, because a throw would STRAND the resource, and **it runs PER RETRY**, so the budget is PER CALLING TYPE.

- **remove-protection-types.ts** - The ONE list both `--remove-protection` help strings render from (SDK types, then the CC registry). `remove-protection-types.test.ts` binds it to the provider files that read `removeProtection`, in both directions ([#2660](https://github.com/go-to-k/cdkd/issues/2660)).

- **providers/deletion-protection-compensation.ts** - Undoes a `--remove-protection` flip whose delete then failed TERMINALLY ([#2204](https://github.com/go-to-k/cdkd/issues/2204)). A new flip site wraps its delete in `deleteWithProtectionCompensation`, flips through `observeThenDisableProtection` (a pre-flip readback, never state) and sets `flip.deleteAccepted` once AWS takes the delete; otherwise a failed destroy leaves the guard silently stripped.

- **ec2-termination-protection.ts** - Shared `--remove-protection` helper for `AWS::EC2::Instance`: the modify WRITE lags the delete READ, so both routes flip protection off AND retry the delete. A CC-routed protected ASG is delegated to `ASGProvider.delete`.

- **ec2-volume-delete.ts** - `CloudControlProvider.delete` deletes EVERY `AWS::EC2::Volume` with EC2 `DeleteVolume`, never `DeleteResource`: the registry handler can snapshot the volume itself and then hang (issue [#3455](https://github.com/go-to-k/cdkd/issues/3455)). Its region check runs OUTSIDE the delete `try`, and its timeout is a marked abandoned wait, because the already-deleted arm matches substrings of the logical id.

- **delete-gone-wait.ts** - The post-delete wait for a service that holds a NAME while `DELETING` and refuses a same-name create with its live-resource error (Kinesis, Firehose; issue [#3872](https://github.com/go-to-k/cdkd/issues/3872)). The delete was ACCEPTED, so a cap, Ctrl-C or unreadable status warns and RETURNS; only a caller-named TERMINAL status (Firehose `DELETING_FAILED`) throws (marked abandoned, keeping the state record) — never on a first read alone.

- **unsupported-types.ts** + **.generated.ts** - Pre-flight unsupported-type rejection. The generated half ships the Tier 3 set (`NON_PROVISIONABLE`), codegen'd from the provider-coverage JSON. `--allow-unsupported-types` routes named types through CC. Hand-written `SDK_PROVIDER_NON_PROVISIONABLE_TYPES` lists the REGISTERED `NON_PROVISIONABLE` types the audit drops from Tier 3; the CC auto-route reads both, per TYPE, via `hasNoCloudControlHandlers` (#3871).

- **property-coverage.ts** + **.generated.ts** - Property-level REPORTING and routing, NOT a rejection; the generated per-type `{ handled, silentDrop }` map is built offline from the committed schema fixtures (CI fails on drift). `--allow-unsupported-properties` opts named entries back INTO the drop, keeping the SDK path. **An accepted drop is not RECORDED either** (issue [#2750](https://github.com/go-to-k/cdkd/issues/2750)): the allow set is per `<Type>:<Prop>` but the ROUTE is per RESOURCE, so ONE un-allowed drop routes the whole resource through CC and nothing is dropped. Both narrowings must KEEP an un-allowed drop, and neither removes a CREATE-ONLY drop, which would become an ADDITION next deploy — a replacement of a resource nobody touched. A property in NEITHER map (unrecognized) ROUTES like a drop unless read-only, allow-listed, on a type with no CC route, or held unchanged by the state record — that baseline is what keeps an existing deployment on its route, so every existing-resource caller threads the record's bag, and the narrowings stay schema-known only ([design](../../docs/design/3713-route-unrecognized-properties.md)).

- **mutually-exclusive-properties.ts** - Pre-flight rejection of property COMBINATIONS AWS accepts only one of, reachable nowhere else: once the resource exists the diff says `NO_CHANGE` forever. **The presence predicate is load-bearing**: pre-flight runs BEFORE intrinsic resolution, so a key behind an unresolved intrinsic counts as UNKNOWN, never declared.

- **custom-resource-secure-references.ts** - Pre-flight refusal of a SECURE dynamic reference (`secretsmanager` / `ssm-secure`) anywhere in a custom resource's properties, intrinsic parts included (a token SPLIT across `Fn::Join` parts or spelled with a `${...}` in `Fn::Sub` counts by its opener), which CloudFormation does not support ([#3976](https://github.com/go-to-k/cdkd/issues/3976)). A plain `ssm` reference stays accepted. Template path only, so a rollback replay never reaches it.

- **nested-required.ts** + **.generated.ts** - Pre-flight rejection of a PRESENT nested block missing a schema-`required` member (issue [#1802](https://github.com/go-to-k/cdkd/issues/1802)). **A schema `required` list is not evidence CloudFormation enforces it**: `CFN_ENFORCED_TYPES` holds only types MEASURED to refuse, so a type joins it by measurement, never by reading its schema.

- **interrupt-watch.ts** - The ONE SIGINT watch every bounded wait here uses, plus `InterruptedWaitError` and the cause-chain classifier (NO depth ceiling — the chain grows one error per nested-stack level). ONE error type: a bare `Error` from a provider reads as a resource failure and triggers an automatic ROLLBACK on Ctrl-C. ONE STICKY latch, cleared only by a COMMAND scope and armed only inside it — never on `process.listenerCount('SIGINT') > 0`, which a concurrent waiter's listener would arm permanently.
  - **A lock-holding command must release BEFORE unregistering its SIGINT handler.** `destroy-runner.ts` re-syncs `result.interrupted` GATED on `statePreserved`: **a stack whose state was deleted never reports `interrupted`**. Each signal has ONE owner: PER-STACK is `result.interrupted`, PER-RUN is the watch, and the exit code ORs in `stoppedEarly`.

- **describe-type.ts** - Shared `cloudformation:DescribeType` with THROTTLE-ONLY retry, for the write-only / read-only / create-only resolvers and `export.ts`, whose fallbacks would turn a throttle into a real failure. Every call takes a slot of ONE process-wide limiter (`DESCRIBE_TYPE_MAX_IN_FLIGHT`, issue [#3718](https://github.com/go-to-k/cdkd/issues/3718)); a prefetch is BACKGROUND, so an awaited lookup never queues behind one. **Resolve the client when SCHEDULING, never inside the task**: a queued task starts inside whichever task finished, in THAT task's per-stack AWS scope. `hasNoRegistrySchema()` is the ONE list of types with no registry entry, for which DescribeType can only fail.

- **write-only-properties.ts** - Resolves the registry schema's `writeOnlyProperties`, caching **only SUCCESSFUL lookups**. `CloudControlProvider.update` strips them from the PREVIOUS side before patch generation: read handlers cannot return them, so one absent from the patch is dropped on every UPDATE. `tryGetTopLevelWriteOnlyProperties` is the variant for a caller that must tell "none" from "unknown" — the diff's synthetic create-only fallback ([#3803](https://github.com/go-to-k/cdkd/issues/3803)), which FAILS CLOSED on `undefined`. It warns nothing, and reads only SETTLED successes, never the other variant's in-flight promise, whose failure resolves to an empty set.

- **read-only-properties.ts** - For `CloudControlProvider.import`'s attribute narrowing (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)). **The RETURN TYPE is the point of the module**: `undefined` means "could not find out" and an empty set means "declares no attributes", so returning `new Set()` on failure re-opens the disclosure.

- **cc-import-identifier.ts** - Completes the bare CloudFormation id `CloudControlProvider.import()` receives into the `|`-joined Cloud Control identifier for a COMPOSITE `primaryIdentifier`, read from the live schema (issue [#3672](https://github.com/go-to-k/cdkd/issues/3672)). The completed value is also what gets RECORDED. It REFUSES rather than guesses when the template cannot supply exactly the other fields.

- **slow-cc-operation-timeouts.ts** - Per-(resourceType, operation) wall-clock timeout FLOORS, and the SINGLE source for the CC poll cap and both outer deadlines, so they cannot drift.

- **resource-timeout-registry.ts** - Registry of the resolved `--resource-timeout` input: per-type override > explicit global > `undefined`. **The compile-time 30m default deliberately does NOT leak in**: only an explicit user value may lift an inner waiter's floor.

- **create-only-properties.ts** - Create-only resolution for REPLACEMENT detection, compared at PATH granularity so a nested entry forces replacement only when the value AT that path changed. **The fallback is only as good as the registry schema**: some types declare NO `createOnlyProperties` though AWS rejects the update (`AWS::EC2::Volume`, issue [#1356](https://github.com/go-to-k/cdkd/issues/1356)), so they need a hand-authored `ReplacementRulesRegistry` entry, plus a `STATEFUL_TYPES` one if data-bearing. A FAILED lookup resolves the committed `create-only-snapshot.generated.ts` (the fixtures' `createOnlyPropertyPaths`, parsed by the same `create-only-paths.ts` leaf as the live schema) and is NOT cached, so the live answer wins once it returns. **A prefetch's owner must `cancel()` it when its diff is done**, on every path: an in-flight request holds the event loop until it answers, and an uncancelled prefetch competes with the deploy's own write-only lookups for the account's DescribeType quota.

- **stateful-types.ts** - The data-loss guard list and its verdict helpers (issue [#615](https://github.com/go-to-k/cdkd/issues/615)): a wrong edit here silently DELETEs + CREATEs a user's data. Its two mechanical LOWER BOUNDS miss the residual — a delete that destroys data with no opt-in — so such entries are hand-added with the reason AT the entry. Conditional reasons stay HEDGED — `renderStatefulReason` renders where no probe ran.

## SDK Providers

SDK Providers live in `src/provisioning/providers/`; Cloud Control is the fallback for types without one. Full list: [docs/supported-resources.md](../../docs/supported-resources.md).
