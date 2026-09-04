---
description: cdkd secret-redaction layout notes (dynamic-reference redaction, masking retry loggers, region classification, cdkd scrub)
paths:
  - 'src/deployment/secret-redaction.ts'
  - 'src/deployment/masking-retry-logger.ts'
  - 'src/deployment/secret-region-classification.ts'
  - 'src/cli/commands/scrub.ts'
  - 'src/provisioning/masked-retry-logger.ts'
---

# Key Files and Directories - secret redaction and masking

Rest of the deployment layer: [layout-deployment.md](layout-deployment.md).

Index of every area: [code-layout.md](code-layout.md).

## Important Files

- **src/deployment/secret-redaction.ts** - Secret redaction for resolved
  dynamic references (GHSA fix). A LEAF module (imports nothing).
  - **Secret-ness is decided by the RESOLVER, and by TYPE rather than by
    spelling**: every `{{resolve:secretsmanager:...}}`, plus a
    `{{resolve:ssm:...}}` whose parameter turns out to be a `SecureString`
    (issue #1901 — a `String` / `StringList` parameter is public config and
    stays RESOLVED in state, or every parameter-backed property would become a
    perpetual spurious UPDATE). The verdict is DISCOVERED off the same
    `GetParameter` response that carries the value and remembered per
    expression in `recordedSecretExpressions` (issue #1910; process-global,
    cleared by `resetAccountInfoCache`) so the cache-hit and
    `skipDynamicReferences` arms can act on it without a second lookup.
  - **`cachedDynamicReferences` lives on the RESOLVER INSTANCE** (one per
    stack, each with its own region — issue #1933), so a cache hit can only be
    a value this stack resolved in this region; module scope once resolved one
    region's secret into another region's resource and left a second stack's
    secrets map empty so `cdkd scrub --all` reported it clean. The verdict
    store keeps the wider lifetime (safe: an inherited verdict can only make a
    reference be treated AS a secret), and each cache entry carries the
    verdict that produced it, so another stack retracting the memo cannot stop
    this one redacting its own region's secret.
  - **Region-pinned lookups** (issue #1957): the resolver's `clientsForRegion`
    builds region-pinned clients (`AwsClients.withRegion`, which carries the
    ambient profile / credentials and overrides only the region) unless the ambient
    clients are PROVEN to already point at the resolver's region — "unknown"
    means SCOPE, not skip (failing open on the `~/.aws/config`-only case left
    the disclosure reachable). PROVEN means EXPLICITLY CONFIGURED
    (`AwsClients.configuredRegion`); asking one client is the wrong question —
    the service getters are LAZY, each memoizing its own region at its own
    instant while `deploy.ts`'s `switchRegion` mutates `AWS_REGION`, so no
    single member can answer for the bag (asking the SDK's `config.region()`
    was removed rather than refined). A template-derived region (`Fn::GetAZs`)
    is additionally gated by `isClientSafeRegion`.
  - On the diff / no-op path the type lookup passes `WithDecryption: false`, so
    a `SecureString` comes back as its encrypted blob — never substituted,
    never cached — and the comparison stays expression-vs-expression.
  - Owns `RecordedSecretValues` (a `Map<plaintextValue, expression>` the
    resolver populates per pass), `redactSecretsForState(bag, secrets, source?)`
    (deep-clone replacing each secret value — whole-value or embedded substring
    — with its unresolved expression; identity return when no secrets),
    `scrubResourceRecord(record, secrets)` (redacts one `ResourceState`'s
    `properties` / `attributes` / `observedProperties`, shared by the deploy
    save choke point and `cdkd scrub`), and `maskSecretsInText(text, secrets)`
    (secret value → `***` for log / error output).
  - **`maskSecretsInError(error, secrets)`** (issue #2038) is the object-level
    twin: a CLONE of EVERY link in the error's `cause` CHAIN, each with its
    own masked `message` — `formatError` renders
    `Caused by: <cause.message>` and `handleError` logs the error OBJECT, so
    no string-site masking can close that sink. **The CHAIN, not just the top
    link**: a provider wrapping an AWS failure in a generic sentence leaves
    the plaintext ONE link down, where a top-level-only mask hits its
    identity-return and hands back an unsafe object — the contract is that
    the returned error is safe to render; the identity-return means "nothing
    ANYWHERE in the chain changed". Each link's clone copies the prototype
    and every own property DESCRIPTOR (symbols included) so
    `markNonRetryable`'s non-enumerable marker, `$metadata` / `Code` and
    `name` survive for the retry classifiers (`isMarkedNonRetryable` /
    `isThrottlingError` / `isTransientServerError`) and
    `extractDeploymentEventError` (`Object.assign` would drop the marker);
    `message` and `cause` are deliberately NOT copied (both re-defined per
    link; copying a NON-CONFIGURABLE original would make the re-definition
    throw). `cause` is rewired to the clone map in a SECOND pass (what makes
    a CYCLIC chain terminate), with a visited-set and depth cap
    (`ERROR_CAUSE_MASK_MAX_DEPTH` 20); a link beyond the cap keeps its
    original unmasked message; a non-`Error` `cause` keeps its descriptor
    verbatim. `extractDeploymentEventError` needs no change (copies only the
    top link's `message`; walks only for `$metadata.requestId` / `Code`).
  - **Redaction is BOTH path-based and value-based, and the split is
    load-bearing** (issues #1904 / #1900). The optional SOURCE bag still
    carries unresolved expressions; wherever the source leaf is a
    `{{resolve:...}}` string, that string is persisted VERBATIM. Position is
    what the value map structurally cannot supply: keyed by plaintext, two
    expressions resolving to the SAME value collapse (last write wins) and
    every site is rewritten to the survivor — a permanent spurious UPDATE
    (#1904). The value scan stays for every leaf the source cannot position
    (diverged shape, missing key, a leaf that merely EMBEDS a secret, a
    cross-stack leaf the source does not literally spell).
  - **`positionByIntrinsicSkeleton`** (issue #1916) positions `Fn::Join` /
    `Fn::Sub` source leaves — the DOMINANT CDK shape
    (`secret.secretValueFromJson(...)` renders the ARN as a `Ref`, so every
    L2-reached secret is a join): literal parts escaped, non-literal parts
    wildcarded (`[^}]*`, cannot cross a token terminator), matched against the
    recorded secret expressions. Persists a match only when THREE conditions
    hold: the bag leaf's WHOLE value is a recorded secret plaintext (an
    embedded secret keeps going to the substring scan), EXACTLY ONE candidate
    matches, and the match is not DEMONSTRABLY another value's expression per
    the pass's own map (fence against bag/source misalignment). Every refusal
    degrades to the value scan, so no case gets worse. Deliberately NO
    `isKnownSecretExpression` test on this arm: candidates come only from
    proven-secret stores, so the test could never answer `false`, and an
    unfalsifiable guard fences nothing.
  - **`positionByCrossStackSource`** (issue #2059, consulted BEFORE the
    skeleton pass) handles `Fn::ImportValue` / `Fn::GetStackOutput` source
    leaves. Extending the skeleton could not work (measured and refuted
    twice): neither intrinsic carries any text about its expression, so a
    pure-wildcard skeleton matches ZERO candidates and always refuses. What
    closes it is an ASSOCIATION: `reresolveCrossStackValue` — the only point
    holding BOTH the consumer's source leaf and the producer's stored token —
    records `canonicalKey -> expression` into `recordedCrossStackExpressions`
    (homed HERE for the same no-cycle reason; cleared by
    `resetAccountInfoCache`).
  - `crossStackSourceKey` is computed by BOTH sides over the RAW intrinsic —
    `Fn::ImportValue <exportName>`; `Fn::GetStackOutput <stackName>
    <outputName> <region> <roleArn>`; `Fn::GetAtt <logicalId> <attr>` for a
    nested stack's `Outputs.<Key>` (#2055 review); the one-placeholder
    `Fn::Sub` (#2270); and `Ref <param>` (#2291 — without a key it fell to the
    value scan and collapsed a rotating secret's `:AWSCURRENT` /
    `:AWSPREVIOUS` outputs) — NUL-separated (`:` occurs in real export
    names), so writer key and persist-path key are byte-identical BY
    CONSTRUCTION. Deriving the writer's key from the RESOLVED names is NOT
    equivalent (the persist path holds only the unresolved leaf). A slot that
    is itself an intrinsic yields no key and REFUSES.
  - **THE KEY IS NOT UNIQUE PER PRODUCER**: the `Fn::ImportValue` key carries
    no region segment and a `Fn::GetStackOutput` omitting `Region` keys it
    empty, so one `cdkd deploy --all` puts two stacks in two regions on ONE
    key. What makes the store safe is SCOPE, not uniqueness: the associations
    live in a `WeakMap` keyed by the pass's own `recordedSecretValues` bag, so
    another pass's entry cannot be REACHED (also bounding the plaintexts to
    the pass that fetched them). Plaintext PAIRING alone was insufficient — it
    refuses a foreign entry only when the plaintexts DIFFER, and a
    multi-region replica or shared API key makes them coincide, re-certifying
    a foreign association `resolveReplayProps` / `drift --revert` then
    re-resolved as the OTHER region's reference. The pairing is KEPT
    (belt-and-braces, and the only guard inside ONE pass against bag/source
    MISALIGNMENT); a key recorded against a different (expression, plaintext)
    PAIR is POISONED rather than overwritten, either half differing being
    enough. A caller handing a different bag than it resolved with
    (`cdkd state refresh-observed`, empty by construction) finds nothing and
    falls back to the value scan.
  - `recordCrossStackExpression` refuses an `expression` that is not a whole
    `{{resolve:...}}` token: both payload parameters are `string`, the reader
    RETURNS `expression` to be persisted, so a swapped call would write a
    SECRET into `state.json` — the shape test narrows that as far as a shape
    test reaches (#1917: a plaintext can look like a token). The arm keeps
    skeleton condition 1 (whole-value recorded plaintext) and condition 3 (an
    association THIS PASS can see resolved to a DIFFERENT plaintext is refused
    — over a shared `plaintextIndexOf`; condition 2 compares what the WRITER
    recorded, condition 3 what this pass holds, and they can disagree); a
    LOOKUP needs no "exactly one".
  - The recording seam is gated on TWO tests. (1) Presence in
    `recordedSecretValues` proves the pass resolved the token to a usable
    needle — what stops a `skipDynamicReferences` comparison resolve (which
    leaves a known secret UNRESOLVED) from recording the token as its own
    "plaintext" and POISONING the key for a deploy resolve REUSING THE SAME
    BAG. (2) `isSecretExpressionByVerdictOrSpelling` is the test about THIS
    token — `secretsmanager` by spelling, or an `ssm` reference this process
    PROVED `SecureString`, a verdict a definitive public answer RETRACTS — so
    a producer output holding a public reference is never associated. The
    retraction holds for the consumer's OWN region only (`pinSecretVerdict`
    returns early for a producer-region GUEST), so the predicate over-ACCEPTS
    a producer-region public parameter — bounded to a spurious UPDATE, never a
    plaintext (closing it means keying the verdict store by region); the one
    shape it misses, a cross-REGION ssm `SecureString`, costs only a refusal.
    It certifies POSITION for exactly two spellings, never a widening of what
    the value scan may assume — the #1915 fences are untouched.
  - **Which source leaves may be persisted is gated by PROVENANCE, via
    `PathSourceRules`, and all THREE rules are load-bearing.**
    - `descendArrays` follows the BAG's provenance: a bag produced BY resolving
      the source (`TEMPLATE_DERIVED_RULES` / `STATE_DERIVED_RULES`) is walked
      POSITIONALLY (resolution preserves structure), while an AWS readback may
      be REORDERED (the reason `drift-normalize.ts` exists) — positional
      descent would write an expression onto the WRONG element and leave the
      real secret in plaintext. Since issue #1915 every kind FIRST tries a
      KEYED descent pairing elements by an identity field (`Name` / `Key`)
      with uniqueness required on BOTH sides; a key that is not really an
      identity fails uniqueness and refuses the WHOLE array rather than
      mis-pairing; an unpaired element falls to the value scan. That is what
      reaches a secret nested in an ECS
      `ContainerDefinitions[].Environment[]` on the UNCHANGED-resource path,
      where the value scan has no needles (#1900). Keyed runs BEFORE
      positional; an element it does not pair takes its POSITIONAL partner
      when positional would have been exact for the whole array (keying must
      never pre-empt an exact descent), and two well-keyed lists with
      DISJOINT identities fall through to positional the same way. Keyed is
      preferred because `descendArrays` rests on an assumption the module
      cannot enforce (every `effectiveProperties` producer TODAY preserves
      length and order). Two shapes fail closed: an array whose IDENTITY
      FIELD itself holds a secret, and an array of ARRAYS.
    - `trustAnyExpression` follows the SOURCE's provenance: a template carries
      PUBLIC ssm expressions too, and persisting one would re-introduce the
      perpetual UPDATE #1901 prevents — so from a TEMPLATE source a leaf is
      substituted only when it is a KNOWN secret (`{{resolve:secretsmanager:`
      by definition, or a recorded ssm `SecureString`), while a STATE source
      holds no public expressions and is trusted wholesale. The definitional
      arm is what makes the fix work: when two expressions share a resolved
      value the map keeps only the last, so asking it about the LOSING
      expression answers 'no' for exactly the pair being separated.
    - `sourceIsSameGeneration` (issue #1917 + review) answers whether the
      SOURCE describes the same GENERATION of the resource the BAG does, for
      one shape: a bag leaf ALREADY a complete `{{resolve:...}}` token (a
      previously-persisted expression, or a plaintext that LOOKS like one).
      TRUE for exactly the two STATE-sourced constants whose source is that
      record's own persisted bag — `STATE_DERIVED_RULES` and
      `STATE_SOURCED_READBACK_RULES`. Every TEMPLATE-sourced constant is
      FALSE, INCLUDING `TEMPLATE_DERIVED_RULES` — the review's correction:
      `redactStateForPersist` walks EVERY record while
      `perResourceTemplateProps` is populated BEFORE the provider call, so a
      resource that merely ENTERED the create/update arm hands today's
      template to a record still on the PREVIOUS generation (reachable via
      intermediate `saveStateAfterResource`, the pre/post-rollback saves, and
      Ctrl-C) — a same-generation claim there rewrote a rolled-back
      `:AWSPREVIOUS` onto the template's `:AWSCURRENT`, so a failed rotation
      read as applied and drift could not see it. A refusal FALLS BACK to a
      WHOLE-VALUE redaction, not the leaf untouched: a token-shaped PLAINTEXT
      the pass resolved is a value-map key and is still rewritten, while a
      previous generation's EXPRESSION is not a key and survives.
      `secrets.has(bag)` is the wrong test — the hazard is GENERATION SKEW,
      which no value test can see. Two references sharing one token-shaped
      resolved value leave the refused leaf on the SURVIVOR's expression (the
      #1910 class, not a disclosure).
  - **The substring arm spares complete tokens** (issue #1935): ONE predicate
    over the whole leaf — replace every recorded-plaintext match EXCEPT one
    lying STRICTLY INSIDE a complete `{{resolve:...}}` span (contained and
    shorter). A match coextensive with a span is still replaced (the #1917
    token-shaped plaintext), as is one that CONTAINS or STRADDLES a span.
    Expressing it as two rules (replace whole spans; value-scan between spans)
    was tried and REGRESSED: a straddling plaintext belonged to neither half
    and persisted in the clear, and splitting the leaf broke
    `buildNeedleRegex`'s longest-first PRECEDENCE (holds only within one
    scan). Residual: an UNTERMINATED `{{resolve:` opener forms no span, so a
    needle after it is still replaced. One fix in the SHARED arm, so every
    `PathSourceRules` constant and every sourceless walk (the journal's
    `previousState`, `attributes`, `redactByPath`'s four fallbacks) inherits
    it.
  - `STATE_SOURCED_CROSS_GENERATION_RULES` exists because a caller can know
    something the derivation cannot: `cdkd scrub` threads it into
    `scrubResourceRecord` for its `observedProperties` walk — scrub
    repositions `properties` onto TODAY's template FIRST, so the fallback
    source has already moved a generation; it keeps `trustAnyExpression`
    (state holds no public expressions — what cleans a legacy PLAINTEXT
    baseline) but drops the generation claim, or the drift baseline would be
    rewritten onto a reference the stack may never have deployed and
    `cdkd drift --revert` would push it to AWS.
  - **Every writer passes a position source** (issue #1910): the rollback
    JOURNAL (`DeployEngine.redactOperationsForJournal`); the stack OUTPUTS
    (positioned by `DeployEngine.outputsTemplateSource`, consumed by all three
    outputs-redaction sites through one `redactOutputs` helper — which since
    issue #1943 passes `TEMPLATE_SOURCED_RULES` rather than the default: two
    of the three sites hand it a bag that is NOT this generation's, so
    `descendArrays` is a claim the site cannot make; reachable because
    `TemplateOutput.Value` is `unknown` and a list-valued output puts an array
    on both sides; the `cdkd scrub` twin still passes the default — issue
    #2099); `cdkd scrub`; `cdkd import`'s `resolveImportedProperties`; a FIFTH
    the issue did not list — `rollback-executor.ts`'s `redactRollbackRecord`
    (reachable only through a replay) — and a SIXTH a caller-search could not
    see: `cdkd state refresh-observed` (`src/cli/commands/state.ts`), which
    reached this module along NO path at all (issue #1926). Its readback is
    the DECRYPTED value for any resource deployed from a secret reference and
    its secrets map is EMPTY by construction — the #1900 shape: the PATH pass
    carries it alone, positioned against the record's own `properties` under
    `STATE_SOURCED_READBACK_RULES`, inheriting #1915's keyed array descent.
  - **`refuseUncertifiedReadbackPositions`** closes the MIXED-leaf row
    (`postgres://u:{{resolve:...}}@h`, an `Fn::Join` around
    `secretValueFromJson`) on every empty-map readback path — the path pass
    certifies only WHOLE-TOKEN source leaves, and a mixed leaf fell to a value
    scan with no needles. It lives inside `redactSecretsForState`, so every
    caller inherits it with no call-site change: `cdkd state refresh-observed`
    and — why it belongs in the module — a plain `cdkd deploy`, whose
    `drainObservedCaptures` baseline reaches the persist choke point with the
    same empty-map / state-source configuration. `cdkd scrub` is NOT an
    inheritor (its observed walk passes
    `STATE_SOURCED_CROSS_GENERATION_RULES`, which the gate excludes by
    design). Gated on `trustAnyExpression && !descendArrays &&
    sourceIsSameGeneration` — the third conjunct took a measurement: without
    it the pass also selected the cross-generation rules and rewrote a scrub
    baseline holding the DEPLOYED `:AWSPREVIOUS` onto the template's edited
    `:AWSCURRENT` (the #1917 hazard, which `--revert` applies to AWS). It
    refuses only what POSITION justifies and descends per identity-keyed
    element so a mixed leaf inside a paired element is reached.
  - A MIXED leaf embedding a plain `{{resolve:ssm:` token splits on whether a
    SECRETS MAP exists (forced by the `secrets-dynamic-ref` integ after every
    unit assertion passed without it): with a map, absence from the verdict
    store is real evidence the parameter is PUBLIC and the resolved value is
    kept; with an EMPTY map nothing could have been recorded, and reading
    absence as "public" persisted a DECRYPTED SecureString. Failing closed is
    the whole-token arm's own premise: a public `String` is stored RESOLVED
    (#1901), so a token SURVIVING in a persisted bag is a SecureString by
    construction. Issue #2036 tracks the price (still OPEN; PR #2415 withdrew
    a process-global proven-public store — see its JSDoc).
  - Of the FOUR residual rows once listed here, TWO close CONDITIONALLY:
    `unkeyedArrayPairsByAnchors` licenses a POSITIONAL walk under FOUR
    conditions — index counts match (arrays) or every SOURCE key is present in
    the bag (objects: source-key CONTAINMENT since #2012; a MISSING source key
    still refuses); every position whose SOURCE spells no dynamic reference is
    deep-equal on both sides (the *anchors*); every reference-bearing ELEMENT
    carries its own distinguishing anchor (`isUniquelyKeyedBy`'s bar) or,
    being a bare reference, leans on the array's literal FRAME; and no two
    share an ORDER-INSENSITIVE anchor signature (the last two are the #2012
    review's, each a measured misattribution on
    `AWS::AmazonMQ::Broker.Users`). A position AWS did not rewrite is evidence
    the containers are the same element (a REORDERED list stops matching and
    is refused). The other two rows (an UNPAIRED element beside a paired one;
    an observed KEY the source does not carry) close by DERIVED NEEDLES
    (issue #2012): `deriveReadbackNeedles` learns pairs from certified
    positions, scanned over the RAW bag, MERGED by `preferPositionDecisions`
    where a MARK tree says no pass decided (either naive order fabricates a
    baseline) — see its JSDoc.
  - The journal is the consequential writer: `resolveReplayProps` RE-RESOLVES
    it against AWS, so a leaf collapsed onto a sibling's expression ships the
    WRONG secret version to the live resource. Two sides of one op take
    DIFFERENT sources: `properties` / `attemptedProperties` are this deploy's
    desired bags and take the TEMPLATE bag; `previousState` was read back from
    STATE and positions itself via `scrubResourceRecord` with no source (the
    #1900 fallback).
  - The ssm/ssm collapse half is closed by the module-level
    `recordedSecretExpressions` SET (`recordSecretExpression` /
    `forgetSecretExpression` / `isRecordedSecretExpression` /
    `clearRecordedSecretExpressions`) — the resolver's SecureString verdict
    store, homed HERE so `isKnownSecretExpression` can consult it with no
    caller threading (the reverse import edge would close a cycle; this module
    is the LEAF). Since issue #1916 the set holds EVERY secret expression, not
    only the ssm ones — it is ALSO the skeleton pass's candidate list, and a
    list holding only the ssm half cannot name the losing member of a
    collapsed secretsmanager/secretsmanager pair. Recording is gated on the
    SPELLING rather than the resolver's `isSecret`: an `ssm` reference whose
    `Type` came back unclassifiable is secret for THAT resolution but must
    stay unpinned so the next pass re-asks AWS (#1901) — such a pair still
    falls back to the value scan.
  - The path pass ALSO runs with an EMPTY secrets map — the whole point for an
    UNCHANGED resource (never resolved this deploy, no `perResourceSecrets`
    entry, and an observed-capture refresh echoing a secret would persist
    plaintext, #1900); `scrubResourceRecord` redacts `observedProperties`
    against the record's OWN already-redacted `properties` when no template
    bag was supplied. The source bag is captured by
    `DeployEngine.perResourceTemplateProps` at the two sites that populate
    `perResourceSecrets`. Over-redaction on the value path is harmless and the
    safe direction.
  - Consumed by `IntrinsicFunctionResolver` (records secrets + secret
    EXPRESSIONS + the cross-stack associations, masks Join/Sub debug logs),
    `DeployEngine.withParentInfo` (the single state-persist choke point) + its
    rollback-journal and stack-outputs writers, `rollback-executor.ts`'s
    `redactRollbackRecord`, `cdkd import`'s `resolveImportedProperties`, and
    `src/cli/commands/scrub.ts`.
- **The MASK-ONLY needle class** (issue #2274) is the third kind of entry a
  `RecordedSecretValues` bag can hold, and the first with NO expression behind
  it: a Lambda-backed custom resource's handler declares its response `Data`
  sensitive with cfn-response `NoEcho: true`, the value is HANDLER-GENERATED,
  so what is persisted is `SECRET_MASK`.
  - `recordMaskOnlyValue` records `plaintext -> SECRET_MASK` in the SAME map,
    so every persistence reader (`scrubResourceRecord`'s three fields, the
    rollback journal, the outputs bag, `maskSecretsInText`) is covered by code
    that already walks it. The SENTINEL VALUE is the marker — no side table
    (an earlier `WeakMap` was removed after a mutation probe showed its extra
    conjunct unfenceable AND wrong-pointing). Scope needs none either: the MAP
    is already per-pass — the property PR #2415 was forced back to after
    review found a process-wide positive store is itself a cross-stack
    disclosure (#2425).
  - `recordMaskOnlyValuesIn` is the whole-`Data` twin, taking an `excluded`
    set — the whole string leaves of the resource's own resolved template
    properties, via `wholeStringLeavesOf` — so a handler echoing
    `event.ResourceProperties` into `Data` cannot mask cdkd's OWN
    `ServiceToken` out of the record `CustomResourceProvider.delete` reads it
    from.
  - `carriesSecretMask` is the whole-leaf RECOGNITION test, UNBOUNDED in depth
    with a visited-set for cycles: an earlier depth cap was ASYMMETRIC with
    the unbounded walk that WRITES the mask, so a deep mask persisted and read
    as clean.
  - A mask-only needle must clear `MIN_NEEDLE_LENGTH`, which the expression
    class does not — an expression pair came from a POSITION cdkd resolved, a
    bare plaintext has none, and `Data: { Ready: "true" }` would otherwise
    mask every leaf whose whole value is `"true"`.
  - **The one place the classes must differ is the SUBSTRING arm**: the
    persist walk builds its regex from `substringNeedlesOf` (every plaintext
    MINUS the mask class), so a mask only ever takes a leaf WHOLE — an inline
    `***` cannot be told from a user's own literal, so nothing downstream
    could recognise it and `drift --revert` / `resolveReplayProps` would push
    the corrupted string to AWS (the #1498 / #1501 class). `maskSecretsInText`
    is NOT narrowed the same way (its output is a log line or an event,
    nothing reads it back as a value); the embedded-value residual is #2453.
    Full argument in the module's JSDoc.
- **The mask-only channel's CROSS-DEPLOY cost is guarded rather than hidden.**
  `ResourceState` carries no durable `NoEcho` flag (#2449), so a later deploy
  reads `***` back.
  - `ResolverContext.redactedAttributeReads` is the bag the resolver pushes
    such a read into — `noteAttributeSecrecy` for `Fn::GetAtt`,
    `reresolveCrossStackValue` for `Fn::ImportValue` / `Fn::GetStackOutput` /
    a nested stack's `Outputs.<Key>` — and
    `DeployEngine.refuseRedactedAttributeReads` fails the resource rather than
    sending the mask. It RECORDS rather than throws because the DIFF pass
    resolves the same leaf: a throw would fail every later deploy of such a
    stack, while recording leaves `***` against `***`, a clean NO_CHANGE.
  - Other consumers: `drift.ts` (`preserveLiveValuesAtMaskedLeaves` REGISTERS
    `liveValue -> SECRET_MASK` for what it moves — the masked POSITION is the
    proof the value is secret; without it the moved plaintext reached
    `observedProperties`, the retry logger and the AWS error text unmasked;
    plus the `secretBearing` third disjunct on `carriesSecretMask` rather
    than whole-value equality, because `calculateResourceDrift` does not
    descend arrays and a mask under one surfaces as a change on the ANCESTOR
    — `collectSecretMaskPaths` seeds those positions into their OWN set,
    apart from `secretPaths`, whose EXACT-leaf reading licenses DROPPING an
    absent-in-AWS change); `rollback-executor.ts`
    (`refuseMaskedReplayBaseline`, written side only); `export.ts` (a record
    holding the mask joins the per-resource `blocked` list).
  - **The CROSS-STACK half is a RECOVERY, not a refusal**: every cross-stack
    route reads the producer's persisted `state.outputs`, so a masked output
    would refuse a consumer template that deployed before this feature.
    `recordRecoverableMaskedOutput` / `recoverMaskedOutput` remember
    `stack + region + output key -> plaintext` for the PROCESS, written by
    `DeployEngine.rememberRecoverableMaskedOutputs` right after
    `redactOutputs`, read by `reresolveCrossStackValue` and
    `NestedStackProvider.readChildOutputsAsAttributes`. A hit is re-registered
    as a mask-only needle in the CONSUMER's bag (wire value right, consumer's
    record still persists `***`); a miss refuses. The key is a COORDINATE,
    never a bare plaintext (the shape PR #2415 had to withdraw, #2425). The
    nested-stack provider reports recovered outputs PER ATTRIBUTE
    (`ResourceCreateResult.noEchoAttributeNames`), never whole-bag, or one
    sensitive child output would mask every ordinary sibling into the parent's
    record.

- **src/deployment/masking-retry-logger.ts** - The masking `RetryLogger` every
  `withRetry` caller that holds a RESOLVED secret bag threads (issues #1914 /
  #2018 / #2038). `retry.ts` interpolates the AWS message VERBATIM into the
  per-attempt `debug` line and the give-up `warn` summary, and an AWS
  validation error routinely quotes the offending property VALUE back — where
  the payload was resolved from a `{{resolve:...}}` reference, that value
  provably IS the secret and the logger must mask the CONCATENATED string.
  `warn` matters more than `debug` (the summary prints at DEFAULT verbosity),
  which is why `RetryLogger.warn` is OPTIONAL — a required `warn` would have
  been silently satisfied by a raw `logger.warn`. A separate module rather
  than a home in `secret-redaction.ts` (a documented no-import LEAF, while
  this needs `RetryLogger` from `retry.ts`); it gives the three EAGER callers
  — `rollback-executor.ts` (three `withRetry` sites), `drift.ts`'s revert, and
  the deploy engine's two `--replace` re-create sites via
  `DeployEngine.maskingRetryLoggerFor` — ONE definition.
  `DeployEngine.maskingRetryLogger` keeps a LAZY variant, resolving the bag
  per line out of `perResourceSecrets`, because its generic `withRetry`
  wrapper is reached from call sites that hold no bag (DELETE, the
  observed-capture drain, the Outputs pass); every site that DOES hold one
  binds it eagerly.

- **src/cli/commands/scrub.ts** - `cdkd scrub [STACK...]`, the permanent STATE
  SECRET-HYGIENE command (clean + audit). Its full entry — the two
  output-repair passes, the cross-stack pre-pass and its three outcomes, the
  refusals and the exit codes — moved to [layout-scrub.md](layout-scrub.md),
  whose `paths:` glob is the one file it describes.

- **src/deployment/secret-region-classification.ts** - the ONE answer to
  "which region must answer for this `{{resolve:...}}` reference", shared by
  `cdkd deploy`'s resolver, `cdkd scrub`, `cdkd drift` and the rollback
  replay. `classifyReplaySecretRegion` returns `local` (the stack's own
  region: every non-secret service, every same-region ARN, and every
  name-form reference with no foreign producer region on record),
  `named-region` (the SECRET_ID is an `arn:` naming a different region —
  route to a resolver pinned there) or `ambiguous` (name form AND a foreign
  producer region on record — refuse). `producerRegionsFromState` derives the
  evidence from `state.imports[].sourceRegion` +
  `state.outputReads[].sourceRegion`. Extracted from `rollback-executor.ts`
  by issue #2134 because the dependency DIRECTION had to flip (the resolver
  needs this answer and `rollback-executor.ts` imports the resolver).
  Deliberately a LEAF (only runtime dependency: `canonicalizeRegion`) and NOT
  a general region-utilities module — a second spelling of this decision is
  how two commands come to disagree about whether a secret reference is safe
  to resolve locally. `rollback-executor.ts` re-exports every name, so the
  four existing importers are unaffected. **A consumer that supplies the
  evidence owes TWO things, and the second is easy to miss**: it must pass
  `ResolverContext.producerRegions`, AND it must let the resulting refusal
  survive its own error handling — `cdkd scrub` (the only supplier) wraps
  each resolution pass in a best-effort `catch`, so it re-raises
  `DynamicReferenceRegionAmbiguousError` by cause-chain walk at all three
  sites; swallowed, the refusal produces exactly the silent success it exists
  to prevent. Conversely a REGION-PINNED sibling must NOT inherit the
  evidence (`siblingContext` in the resolver strips it): `producerRegions`
  describes the CONSUMER's reads, and a sibling classifies with its own
  region standing in for the consumer, so inheriting it makes a reference
  whose origin cdkd has already proven verdict `ambiguous`.

- **src/provisioning/masked-retry-logger.ts** - The `RetryLogger` a provider
  hands to `withRetry` when its payload carries template-derived values
  (issue #2050). Two exports: `createMaskedRetryLogger(logger, maskSecrets)`
  (routes BOTH `debug` and `warn` through the masker) and
  `maskerOrIdentity(maskSecrets)`. Exists because `retry.ts` interpolates the
  AWS error message verbatim into its `debug` line AND the give-up `warn`
  summary (default verbosity) — an exhausted retry on a resolved
  `{{resolve:secretsmanager:...}}` value used to disclose the plaintext. A
  provider receives the masking CAPABILITY (`CreateContext.maskSecrets` /
  `UpdateContext.maskSecrets`, a `(msg: string) => string`), never the
  `RecordedSecretValues` bag, so this module is a LEAF taking only a type-only
  import (same constraint as `src/provisioning/nested-stack-messages.ts`).
  Absent masker means identity, matching the `SecretMaskingContext` contract,
  so the import path and `drift --revert` are unaffected. **One module rather
  than one factory per provider**: two providers grew byte-identical private
  copies and `drift.ts` a third hand-rolled one — exactly how two files come
  to answer differently about the same request. Masking the retry logger is
  NOT sufficient on its own — `withRetry` rethrows the RAW error, and a
  NON-retryable rejection emits no retry log at all, so each provider must
  also mask `error.message` where it wraps the failure in a
  `ProvisioningError` (printed at ERROR, i.e. default verbosity). Mask the
  raw `error.message`, not the assembled sentence (only the raw value reaches
  `maskSecretsInText`'s whole-value arm), and thread `cause` UNMASKED so
  `isRetryableTransientError`'s `$metadata` walk still classifies.
