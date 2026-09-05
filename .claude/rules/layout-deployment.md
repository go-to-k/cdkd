---
description: cdkd deployment layer layout (DeployEngine, WorkGraph, DAG executor, retry/rollback, delete outcomes)
paths:
  - 'src/deployment/**'
---

# Key Files and Directories - src/deployment

Secret redaction / masking / `cdkd scrub`: [layout-deployment-secrets.md](layout-deployment-secrets.md).

Index of every area: [code-layout.md](code-layout.md).

## Core Directories

- **src/deployment/** - DeployEngine (orchestration), WorkGraph (DAG-based asset+deploy scheduling)

## Important Files

- **src/deployment/outputs-export-alias.ts** - Key-space rules for the
  stack-OUTPUTS bag + their user-facing messages (issue #1919). `state.outputs`
  is keyed by output NAME and an `Export:`-carrying output is ALSO aliased
  under its export name in the SAME bag, beside a parallel bag of unresolved
  template values used as the redaction POSITION source (#1910) — when the two
  disagree about a key, `redactByPath` persists another output's
  `{{resolve:...}}` reference as this one's value. ONE module because FOUR
  writers apply the rules: `DeployEngine.resolveOutputs` (both bags),
  `cdkd scrub` (rebuilds the source bag from the template), and
  `src/analyzer/outputs-diff.ts`, which PREVIEWS the persisted bag (divergence
  shows as a phantom diff row + permanently red `cdkd diff --fail`). **Deploy
  and scrub deliberately do NOT share every rule** (scrub's bag was written by
  an earlier binary, so it over-approximates). Owns
  `isOutputSuppressedByCondition` / `collectPublishedOutputNames` (deploy: a
  condition-suppressed output publishes no value, writes no source, and does
  NOT reserve its name — reserving would drop a WORKING export over an
  unrelated false condition), `collectDeclaredOutputNames` (scrub: conditions
  ignored — a missed collision writes a wrong-secret reference; an
  over-approximated one costs only a warning + one key redacted by value),
  `isExportAliasCollision` (an export under the output's OWN name is not one;
  two outputs sharing one export name is a different, deliberately unguarded
  class), `exportNameSecretExposure` (an intrinsic `Export.Name` can resolve
  to secret PLAINTEXT and a KEY is never redacted — detected from the name's
  OWN resolution map, which is exact; a containment scan was wrong in both
  directions), `stateKeySecretExposure` (scrub's KEY-side containment scan,
  bounded at four characters so a degenerate short secret cannot fail the
  `--dry-run --fail` gate repo-wide), and five message builders.
  `maskEveryOccurrence` is local and threshold-free precisely because
  `maskSecretsInText` is not (feeding a detected-but-unmaskable name to that
  helper printed the secret under a `masked:` label); the refusal message
  omits the name entirely if masking left it unchanged. NOT import-free (takes
  `secret-redaction.ts`). Known residual: an ssm reference whose `Type` came
  back unclassifiable is never pinned (#1901), so a later cache hit can
  substitute that plaintext into a name with nothing recorded and the refusal
  cannot fire.

- **src/deployment/dag-executor.ts** - Generic event-driven DAG dispatcher
  (schedules each resource as soon as its deps complete; no level barriers)
- **src/deployment/delete-outcome.ts** - Shared `ResourceDeleteResult`
  helpers: the skip pair (`deleteSkipReason` / `deleteSkippedMessage`, issue
  #1762) and the suppressed-guard pair (`withIndeterminateGuard` /
  `deleteIndeterminateGuards`, issue #2301). Detail — including why it must
  stay an import-free LEAF — in [delete-outcome.md](delete-outcome.md).
- **src/deployment/rollback-executor.ts** - Reusable rollback engine (issue
  #1183), extracted from `DeployEngine` so the in-process automatic rollback
  AND `cdkd rollback` drive identical semantics.
  - Owns `CompletedOperation` / `FailedOperation`, `replayRollback`
    (UPDATE/DELETE reverse-completion-order, then CREATE deletions
    dependency-sorted; best-effort per-op), `classifyRollbackOp` /
    `planRollback` (pure classification for the plan preview; each item
    carries `effectiveProvisionedBy` so the preview consults the SAME
    `finalSnapshotMechanism` matrix the replay runs and labels a Snapshot
    delete that will be REFUSED, issue #1366), `classifyFailedOp` /
    `planFailedOps` / `replayFailedOperations` (issue #1198 —
    `--revert-failed`; its delete of a provisioned-but-failed CREATE honors
    the CURRENT record's `DeletionPolicy` through the same matrix —
    `orphan-failed-create-retain` /
    `delete-failed-create-with-final-snapshot` / plain
    `delete-failed-create`, issue #1362), and `sortRollbackCreates`.
  - A replacement op (`previousState.physicalId !== op.physicalId`) is
    reverted by REVERSING the replacement (issue #1199): re-create the old
    resource from `previousState` via its recorded `provisionedBy` route,
    then delete the new one (create-first; name collision falls back to
    delete-new-first + bounded name-release retry). BOTH create arms pass
    `CreateContext.replayingState: true` (issue #1463, via the shared
    `REPLAYING_STATE_CREATE_CONTEXT` constant so they cannot drift) — the
    only create sites that can DECLARE a state replay, so a provider
    PRE-FLIGHT REFUSAL must downgrade to a warning there (the user cannot
    edit a state record from CDK code); `GlueProvider`'s
    `enforceIcebergTableInputAbsent` is the only consumer. The deploy
    engine's five create sites are TEMPLATE-driven, never set the flag, and
    keep the refusal; they DO pass a context since issue #1932 — the three
    EXTERNAL callers (`deploy-engine.ts`, `rollback-executor.ts`,
    `drift --revert`) thread `maskSecrets` at every create/update site (the
    five providers that re-create inside their own `update()` do NOT), so
    fences read the context's KEY SET, not the call's arity.
  - The replay-CREATE HONORS the provider's `effectiveProperties` (issue
    #1682): the bag handed to `create()` IS `previousState.properties`, so a
    returned bag replaces the record's `properties` wholesale and reporting
    none keeps the previous bag. Pre-#1682 the arm's narrow local result type
    dropped a substituted bag — do not re-narrow it. Real-AWS net:
    `tests/integration/rollback-replay-effective-props/`.
  - The providers that re-create inside their own `update()` (ACM
    certificate / IAM managed policy / IAM role / Lambda permission / SNS
    subscription) forward a STATE record on a replay but CANNOT receive a
    `CreateContext` (update's context carries no `replayingState`) — the
    constraint lands on providers: one with a create-side pre-flight refusal
    must not re-create inside `update()`.
  - Under `UpdateReplacePolicy: Retain` (old resource orphaned): delete the
    new one and re-adopt the old (`reverse-replacement-readopt`). The stateful
    warn does NOT fire on this arm — it is on the plain `reverse-replacement`
    arm — and its wording is scoped: the old data is NOT RECOVERED BY THIS
    ROLLBACK, never "unrecoverable", which would be a claim about AWS this repo
    has not measured.
  - The rolled-back CREATE's CURRENT record `DeletionPolicy` governs its
    delete (CFn semantics): `Retain` ORPHANS (dropped from state, left in
    AWS); `Snapshot` routes to `delete-with-final-snapshot` (snapshot THEN
    delete through the same mechanism matrix as
    `prepareFinalSnapshotForDelete`: atomic delete parameter on the SDK
    route, `createPreDeleteFinalSnapshot` for `PRE_DELETE_SNAPSHOT_TYPES`,
    refusal-as-per-op-failure for a cc-api-routed atomic type) unless
    `RollbackExecutorContext.skipFinalSnapshot`
    (`cdkd rollback --skip-final-snapshot`) opts into the data loss — issue
    #1358, which fixed `Snapshot` orphaning alongside `Retain`;
    `RetainExceptOnCreate` / absent / `Delete` delete plainly. Replay is
    idempotent (skips already-reverted / physical-id-mismatched / absent).
  - Depends only on `ProviderRegistry` + region + logger + optional event
    recorder / per-op state-save hook / `finalSnapshotClients` /
    `skipFinalSnapshot` — NOT on `DagBuilder` / `DiffCalculator` / the
    synthesizer / `ExportIndexStore`.
  - **A replayed `{{resolve:...}}` reference is resolved by the region it
    NAMES, not by the stack's** (issue #2057): a cross-region cross-stack
    read records the PRODUCER's spelling into the CONSUMER's state (#1934),
    and that spelling carries no region. `classifyReplaySecretRegion`
    verdicts: `named-region` (ARN naming another region — per-region-cached
    resolver from `ReplayResolvers`), `ambiguous` (region-less AND a foreign
    producer region on record — throws `ROLLBACK_SECRET_REGION_AMBIGUOUS`
    BEFORE any lookup), `local` (everything else). Evidence:
    `RollbackExecutorContext.importedProducerRegions`, built by the exported
    `producerRegionsFromState` from `imports[].sourceRegion` +
    `outputReads[].sourceRegion`. BOTH callers pass it: `cdkd rollback` from
    `baseState`, and `DeployEngine.rollbackExecutorContext` from
    `crossStackReadsForPartialSave` — the UNION of the pre-deploy snapshot
    with this session's recorded reads, load-bearing because a journal exists
    only after a FAILED deploy and the snapshot alone never records the read
    the failing deploy INTRODUCED (the refusal was inert on exactly the
    deploy that needs it).
  - `producerRegionsFromState` / `classifyReplaySecretRegion` are EXPORTED
    because `drift.ts` consumes both verbatim (issue #2108).
    `ReplayResolvers` is deliberately NOT exported (~20 lines of caching, no
    decision in it); drift's structural twin is fenced by
    `tests/unit/cli/drift-leaf-region-walk-mirrors-replay.test.ts`, which
    READS this file and asserts the two leaf walks are the SAME PROGRAM
    modulo an identifier-alias map and the two `throw` texts — one positive
    condition, since the shared control flow has no shared symbol for a type
    error to hang on.
  - `scrub.ts` consumes both exports through its own `ScrubResolvers` twin
    (issue #2109), refusing a region-less reference with
    `SCRUB_SECRET_REGION_AMBIGUOUS` when state records a foreign producer
    region — raised OUTSIDE scrub's per-item `catch { logger.debug }`
    (swallowed, it is exactly the silent success over a plaintext state file
    the issue forbids).
  - The `Fn::ImportValue` route was unreachable from scrub until issue
    #2133: no resolve context passed `stateBackend`, the throw landed in the
    best-effort `catch`, and the leaf's plaintext never became a needle. All
    four contexts now come from ONE factory inside `scrubStack` (a fifth
    cannot be written without the wiring — how the first four came to lack
    it). `exportIndex` stays deliberately absent: the `state.json` scan
    fallback is equally correct, and supplying it would let the scan arm call
    `exportIndex.patchEntry` — an S3 WRITE from a command that performs no
    AWS mutation, `--dry-run` included.
  - An unresolvable cross-stack read is lifted OUT of the best-effort catch
    by a pre-pass (`resolveCrossStackReads`, over all three bags) refusing
    with `SCRUB_CROSS_STACK_READ_UNRESOLVED` — the catch keeps swallowing
    everything else (it exists for "a `Ref` to a resource not in state";
    making it refuse would break partial scrubbing). The pre-pass does NOT
    rewrite the bag (a resolved reference-shaped value cannot be
    re-interpreted by the stack's own resolver) and walks `Fn::If`
    selected-branch-only, like `resolveIf` — a conditional import of an
    undeployed producer cannot refuse the whole stack.
  - `producerPublishesSecretExpression` makes the SAME branch selection
    through ONE shared `selectTakenConditionalBranches`, feeding both its
    literal `{{resolve:` scan and `collectReExportHops` (issue #2150): the
    scan used to see BOTH arms via `JSON.stringify`, so a secret expression
    in the UNTAKEN arm produced an UNCLEARABLE
    `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` refusal with no bypass flag. One
    selection site is deliberate: a per-site copy inside
    `collectReExportHops` was measurably invisible to the suite.
  - A reference the intrinsics ASSEMBLE cannot be classified by the raw-leaf
    token scan (`[^}]+` cannot cross an `Fn::Sub` placeholder's `}`).
    `isAssembledSecretReference` uses two tests because the three assembled
    shapes fail two ways (measured): a mid-string `Fn::Sub` placeholder and
    an `Fn::Join` split yield ZERO tokens (caught by a COUNT), a TRAILING
    placeholder yields one short token per opening (caught by a whole token
    still containing `${`). The COUNT counts openings followed by a SECRET
    SERVICE (`secretsmanager:` / `ssm:` / `ssm-secure:`), not the bare
    `{{resolve:` — the bare opening made any leaf that merely MENTIONS the
    syntax (a description, an IAM policy, UserData) permanently unscrubbable
    in a cross-region stack.
  - **A detected leaf is DEFERRED, not refused** (issue #2157): returned BY
    IDENTITY so the PRIMARY resolver classifies it once `resolveSub` /
    `resolveJoin` have assembled it. The pre-#2134 refusal
    (`SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE`) only ever OVER-refused and
    disagreed with `classifyReplaySecretRegion` (which verdicts an ARN-form
    token `named-region` whatever evidence it holds); #2134's post-assembly
    classification buys the same safety property (a reference whose region
    cannot be established is never resolved in the stack's own region) over
    strictly MORE information. The pre-pass arms only when the RAW leaf
    carries a `{{resolve:` opening — a leaf whose opening is CONTRIBUTED by
    a `Ref` / parameter `Default` / `Fn::FindInMap`, or an `Fn::Join`
    splitting BEFORE the service name, reaches the same resolver-side
    classification.
  - Every error ESCAPING `scrubStack` runs through `maskSecretsInError` at
    that boundary (`formatError` and the top-level `console.error` render the
    error OBJECT and its cause chain) — which also lets `--all` print each
    failure's chain without a secrets map of its own. Every scrub refusal is
    `exitCode = 2` (`1` is `--fail`'s "plaintext found"). Under `--all` a
    refusal is caught PER STACK; the final error NAMES the failed stacks and
    stops there (each reason was already logged at `error` level).
- **src/deployment/resource-secrets-scope.ts** - Carries a parent's resolved
  secret PAIRS into a nested child's engine: `withCurrentResourceSecrets` /
  `getCurrentResourceSecrets`, an `AsyncLocalStorage` bound around a provider
  CREATE/UPDATE call, read by `NestedStackProvider` (handed on as
  `DeployEngineOptions.inheritedSecrets`) and by
  `SecretsManagerSecretProvider.asPersisted` (issue #2472) (issue #1903). A
  nested stack breaks the redaction chain: the PARENT resolves the child's
  `Parameters` and hands already-resolved PLAINTEXT while the child's
  template carries `{Ref: <ParamName>}`, so the child's `perResourceSecrets`
  came out EMPTY and its `state.json` persisted the decrypted secret; the
  path pass cannot help from the CHILD alone (its source leaf is `{Ref:...}`,
  not a `{{resolve:...}}` string), hence a SEED rather than a second source
  bag. **`AsyncLocalStorage` rather than a `CreateContext` field**: exactly
  ONE provider needs the pairs, and per [providers.md](providers.md) putting
  a plaintext-keyed bag on the shared context makes every one of the ~130
  providers a place `[...secrets.keys()]` can leak from; a masking function
  cannot substitute (seeding needs the PAIRS). **Its own LEAF module**: both
  binders need it (the deploy engine AND `rollback-executor.ts`, whose replay
  arms re-resolve the journal to plaintext and drive the same providers,
  issue #2086) and `deploy-engine.ts` already imports `rollback-executor.ts`,
  so homing it there would cycle. Bound around the provider call at SIX
  deploy-engine sites (two main + four replacement re-creates) and FOUR
  rollback-executor sites (both branches of `updateWithRollbackRetry` — the
  choke point for all four rollback update arms — plus the two
  reverse-replacement replay-CREATEs), so no route silently skips the seed;
  scoped per resource and per retry attempt (`--concurrency`-safe). ABSENT
  reads as `undefined` — the pre-#1903 behaviour for every other caller, but
  NOT for the rollback executor, where restoring pre-fix behaviour is a hole,
  not a baseline. **A provider reading it MUST NOT enumerate or log its
  KEYS** — secret plaintext; the only sanctioned use is handing the map on as
  a redaction seed.
- **`DeployEngineOptions.inheritedSecrets` (in `src/deployment/deploy-engine.ts`)**
  - What the child engine does with the seed: `buildResolverContext` puts it
  on the resolver context, and
  `IntrinsicFunctionResolver.recordInheritedParameterSecrets` copies a pair
  into the context's `recordedSecretValues` at the moment a `{Ref: <Param>}`
  resolves to a value carrying that plaintext — whole-value at any length, or
  a substring at/above `MIN_NEEDLE_LENGTH`, mirroring
  `redactSecretsForState`'s two arms. **RECORDED AT RESOLUTION TIME, NOT
  PRE-SEEDED** (issue #2087): pre-loading every child resource's map spliced
  the expression into an UNRELATED resource's literal that merely contained
  the plaintext as a substring (`my-production-bucket` vs secret
  `production`) — a perpetual UPDATE, or a perpetual REPLACEMENT on a
  create-only property; resolution-time recording reproduces the parent's
  per-logical-id scoping. **The diff half is COUPLED**: `diff-recursive.ts`'s
  `resolveChildStackParameters` sets `skipDynamicReferences: true`, correct
  ONLY because the child state now holds the expression (alone it compares
  expression-vs-plaintext — a spurious perpetual change). Inside the child
  engine the DIFF resolver context binds a REDACTED parameter bag
  (`redactParametersForDiff`) while the PROVISIONING and
  CONDITION-EVALUATION contexts keep real values (those reach AWS, and an
  expression inside `Fn::Equals` would flip a condition); the recursive diff
  keeps a redacted child input parameter UNCOERCED and disables
  condition-pruning, because a verdict computed over an expression is not the
  one deploy will reach.
- **src/deployment/work-graph.ts** - WorkGraph DAG orchestrator for asset
  publishing and stack deployment
- **src/deployment/retryable-errors.ts** - Shared transient-error classifier
  (HTTP 429/503, transient SERVER statuses, message-pattern table for
  propagation delays). Consumed by `withRetry` (`src/deployment/retry.ts`).
  - The message table is three composed parts —
    `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS`, the exported
    `NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS`, and a private remainder — folded
    into the one exported `RETRYABLE_ERROR_MESSAGE_PATTERNS`: retryability
    has ONE source of truth, `isIamPropagationError(message)` selects the
    DENSE cadence, and a misfiled pattern changes cadence, never
    retryability.
  - `isThrottlingError(error)`: bounded `.cause` walk (depth 5) for
    throttling NAMES and `RETRYABLE_HTTP_STATUS_CODES`.
    `isTransientServerError(error)` (issue #2026): the same walk against
    `TRANSIENT_SERVER_ERROR_STATUS_CODES` (500/502/503/504, mirroring
    `@smithy/service-error-classification`). **A SEPARATE set — do not widen
    `RETRYABLE_HTTP_STATUS_CODES`**: seven `isRetryable` sites across four files (`describe-type.ts`,
    `dynamodb-globaltable-provider.ts` x4, `export.ts`,
    `intrinsic-function-resolver.ts`): four
    files pass `isThrottlingError` as a NARROW throttle-only classifier
    (`describe-type.ts` says so outright) and three more call it directly —
    widening would silently make every one "retry throttles AND server
    errors" (`drift.ts` would report "cannot compare" for a read that merely
    500'd). 501 stays terminal. `isRetryableTransientError` consults the
    marker, throttle walk, server-status walk, then messages — server-status
    BEFORE messages because it alone works when the response carried NO
    message (measured: SQS answered HTTP 500 with an empty body; the SDK
    substituted `UnknownError`).
  - `retryClassificationText(error)` (issue #2302): a THIRD bounded `.cause`
    walk on the shared `MAX_CAUSE_CHAIN_DEPTH` (text never read deeper than
    a marker is seen). OPT-IN: returns the top-level message unless a link
    carries `markRedactedCause` — always reading the chain re-classifies
    every wrapper omitting its cause's text (18 audited sites; decisive:
    `deploy-engine.ts`'s UNMARKED per-resource wrap). Redaction otherwise
    empties what the table matches (`not authorized to perform` and
    `conflicting conditional operation` both flipped non-retryable). TWO
    readers — `retry.ts`, and `destroy-runner.ts`'s delete loop, which calls
    `provider.delete` DIRECTLY (`dynamodb-delete-budget.ts` stays on
    `message`; nothing redacts there). Never log or throw the join.
  - `describeRetryClassificationSignals` / `formatRetryClassificationSignals`
    render what the classifier SAW (`[name=... http=... requestId=...]`) for
    the give-up line. Returns on the first link whose `$metadata` carries a
    NUMERIC status — returning on any `$metadata` object reported no `http=`
    for the real SDK network-error shape (`{attempts, totalRetryDelay}`
    wrapping a 500), contradicting the classifier that retried. With no
    status anywhere the name falls back to the deepest link BELOW depth 0 (a
    `ProvisioningError`'s name describes cdkd, not the service); a link
    carrying `$metadata` is named at any depth. `noMetadata` is false
    whenever any `$metadata` was seen, keeping "a status cdkd does not
    retry" distinct from "never reached error deserialization".
  - `isNameCollisionError(message)` (issue #1207): shared by the deploy
    engine's replacement create-first detection / `--replace` delete-first
    retry and the rollback executor's reverse-replacement path; NOT in the
    transient table (a collision is only retryable where the old name holder
    was just deleted). Accepts BOTH spellings — Lambda raises the SINGULAR
    `Function already exist:`, so a plural-only pattern left every
    `AWS::Lambda::Function` off the collision path (#1625) — and a
    lookbehind refuses negated/modal forms ("does NOT already exist"), whose
    consequence here is a DELETION.
  - `isNameCooldownError(message)` (issue #1206): a same-name re-creation
    cooldown — separate from the collision matcher because a cooldown at a
    create-first site must not trigger delete-new-first. Its spellings are
    ALSO composed into `RETRYABLE_ERROR_MESSAGE_PATTERNS` since #2116, so a
    cooldown is retryable on the ORDINARY create path (a fresh `cdkd deploy`
    after `cdkd destroy` has no idea a prior run deleted anything; pre-#2116
    a destroy-then-redeploy of any `custom_resources.Provider` stack failed
    hard). Five spellings: two SQS, two Step Functions, S3's `conflicting
    conditional operation`. ELBv2's `DuplicateLoadBalancerName` and
    DynamoDB's create-side refusal were swept OUT — AWS raises both for a
    resource that merely EXISTS, so recognising them turns a terminal
    collision into a wasted retry budget.
  - `isRecreateRetryableError(message)` (collision OR cooldown): the retry
    filter for the delete-then-re-create sites — the `--replace`
    delete-first fallback, the `--recreate-via-cc-api` /
    `--recreate-via-sdk-provider` destroy-then-create path (issue #1214),
    and the rollback executor's delete-new-first — paired with a
    maxRetries-8 / 10s-cap schedule ≈ 64s total sleep covering the full 60s
    cooldown window; the initial create-first attempt also retries the
    cooldown alone. The outer loops remain for the late name RELEASE the
    inner default classifier rejects (the inner loop now rides the 64s
    grid), the two compounding to ~640s inside the 30-minute deadline.
  - `isUpdateUnsupportedError(error, logicalId)` (issue #2520): the deploy
    engine's update-failure REPLACEMENT trigger — "this type has no UPDATE
    handler at all", not "this update was rejected". Another bounded `.cause`
    walk on the shared `MAX_CAUSE_CHAIN_DEPTH`, matching the exception NAME
    `UnsupportedActionException`, and the async `ccErrorCode` of the same name
    ONLY when `ccOperation === 'UPDATE'` — that arm is unmeasured, so it is
    kept narrow: a CREATE or DELETE sub-operation reporting the same code says
    nothing about whether the type has an UPDATE handler. The sync NAME arm
    carries no such anchor, and the reason is audited in the function's own doc
    comment rather than restated here.
    The walk is needed because `CloudControlProvider.handleError` interpolates
    `err.message` only and AWS's own text never repeats the name — which is why
    the pre-#2520 predicate's `message.includes('UnsupportedActionException')`
    half matched nothing cdkd produces. AWS's prose (`does not support UPDATE`)
    stays a TOP-LEVEL-only fallback: the two directions are asymmetric, since
    missing the signal fails the deploy while matching too broadly REPLACES a
    resource nobody asked to replace. **The `logicalId` anchor is what keeps
    the walk from being wider than the message read it replaced** —
    `NestedStackProvider.update` runs a whole child deploy inside the PARENT's
    `provider.update()`, so a child resource's Cloud Control rejection is
    reachable down the parent's chain, and an unanchored walk would replace the
    entire child stack; the walk stops at the first link naming another
    resource (`ProvisioningError` and `ResourceUpdateNotSupportedError` both
    carry `logicalId`). `NotUpdatable` is deliberately NOT matched — it reports
    "this patch is not applicable", which cdkd already routes through
    property-driven replacement — and neither is `TypeNotFoundException`,
    which `handleError` wraps into the same sentence.
  - `markNonRetryable(error)` (issue #1778): stamps a non-enumerable
    `Symbol.for('cdkd.nonRetryable')`; `isMarkedNonRetryable` walks the
    bounded `.cause` chain, consulted BEFORE any message heuristic —
    classifiers match by SUBSTRING, so a cdkd-authored refusal interpolating
    user-controlled text can hit a retryable pattern and burn the full
    schedule on a path that cannot succeed (an ordinary composite CDK
    logical id sufficed against `DependencyViolation`, #1838; the
    name-cooldown error CODES widened the hazard under #2116). **Two marking
    spellings, not stylistic**: mark at the `throw` when only this raising
    is non-retryable (`sns-subscription-provider.ts`'s abort); mark in the
    CONSTRUCTOR when the class is a refusal in EVERY case
    (`ResourceUpdateNotSupportedError` in `src/utils/error-handler.ts`,
    raised by ~20 providers inside the retried `update()` — a per-site
    marker is one forgotten call from re-opening the hole). Hence
    `error-handler.ts` imports from this zero-import graph leaf — the edge
    cannot cycle. **Marking is NOT the default for a deliberate refusal**:
    `IntrinsicResolutionRefusalError` stays unmarked (its fabricated-account
    arm is genuinely time-dependent — `getAccountInfo` caches a fabricated
    answer for 10s so a later attempt can heal); `ProvisioningError` /
    `CdkdError` stay unmarked (they wrap RELAYED AWS failures). The test is
    "can this succeed on a retry", not "did cdkd author it".
- **src/deployment/retry.ts** - Retry helper used by DeployEngine.
  - THREE schedules, picked per attempt from the error class: generic
    1s → 2s → 4s → 8s cap over 8 retries (47s total sleep) for throttling
    and long state transitions; DENSE 0.25s → 0.5s → 1s → 2s → 2s ... over
    26 retries (47.75s, `IAM_PROPAGATION_{INITIAL_DELAY_MS,MAX_DELAY_MS,
    MAX_RETRIES}`) for the IAM-propagation class; LONGER 2s → 4s → 8s →
    10s ... over the generic 8 retries (64s, `NAME_COOLDOWN_*`, issue #2116)
    for the name-cooldown class — the generic 47s cannot ride out the
    longest window in its class (SQS's own message NAMES 60 seconds). The
    cooldown numbers are the delete-then-re-create sites' budget adopted
    verbatim; only the DELAY grid differs (retry COUNT stays 8, unlike the
    dense IAM grid, which needed its own ceiling).
  - All special grids apply ONLY on the default schedule: any explicit
    `maxRetries` / `initialDelayMs` / `maxDelayMs` / `isRetryable` means the
    caller owns the cadence verbatim (the DELETE path's 3 x 5s,
    `describe-type.ts`'s throttle-only retry).
  - Dense-grid rationale: cdkd creates an IAM entity and consumes it ~1-3s
    later, so propagation resolves in single-digit seconds — the generic
    4s/8s steps overshoot (measured: ~10.2s of a 25.9s deploy burned in
    backoff) while throttling genuinely wants exponential backoff. The dense
    budget is deliberately >= the generic one; the class is re-evaluated per
    attempt (a throttle mid-propagation backs off exponentially).
  - The three nested sites compound: `deploy-engine.ts`'s two
    `--replace`/recreate sites and the rollback executor's
    reverse-replacement wrap a default-schedule `withRetry` in an outer loop
    — total sleep on a cooldown measures ~487s → ~640s, inside the 30-minute
    per-resource `withResourceDeadline`.
  - **The propagation retry REPORTS itself (issue #2018)**: a give-up emits
    ONE `warn` line naming retries spent and propagation backoff consumed;
    each per-attempt `debug` line carries the running total INCLUDING the
    wait it announces (prints before the sleep). **The exhaustion note keys
    on the loop's own exit condition (`sawPropagation && attempt >=
    attemptLimit`), NOT the retry count** — a throttle mid-sequence consumes
    an attempt without advancing the counter, and a count-keyed test
    reported a genuine exhaustion as "something else ended it". The seconds
    count PROPAGATION backoff only (comparable against the 47.75s budget).
    `warn` rather than `debug` is load-bearing: an exhausted retry rethrows
    the RAW AWS error, so at default verbosity a 47.75s retry and a build
    with no retry printed byte-identical output. An exhausted cooldown
    sequence reports the same way, with its own per-class conjunct
    (`nameCooldownRetries >= maxRetries && attempt >= attemptLimit`) — keyed
    on the loop exit alone it reported a single 2s cooldown retry as "the
    full name-cooldown budget".
  - THREE counters (issue #2026 added `serverErrorRetries`), all
    reporting-only, advancing only AFTER a wait completes (an interrupt
    cannot inflate the summary). The give-up line joins the kinds actually
    spent with ` and `; a propagation-only sequence renders byte-identically
    to #2018's shape. `serverErrorRetries` is gated on the caller NOT having
    supplied its own `isRetryable` (`RETRYABLE_HTTP_STATUS_CODES` already
    contains 503, and counting there printed a default-level `warn` on
    graceful-degradation paths that previously printed nothing). The warn is
    wrapped in `try/catch` — it fires immediately before the rethrow, and a
    throwing logger must not REPLACE the error the summary explains. The
    give-up line also carries the classifier's inputs
    (`[name=... http=... requestId=...]`, issue #2026) — when the message
    degenerates, the bracket is the whole diagnosis.
  - `RetryLogger.warn` is OPTIONAL, and not merely so bare `{ debug }`
    callers keep compiling: `drift.ts`'s revert deliberately threads a
    MASKING logger (issue #1914 — the summary interpolates the AWS message,
    which there can quote a resolved secret), so a required `warn` would have
    been silently satisfied by an unmasked `logger.warn`. Do NOT restate that
    every production caller threads a real `Logger` — an earlier revision
    did, and it was false for exactly that caller.
