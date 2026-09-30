---
title: "Design: redacting NoEcho parameter values in persisted state"
unlisted: true
---

# Redacting NoEcho parameter values in persisted state

Issue [#4043](https://github.com/go-to-k/cdkd/issues/4043): the persistence
half of [#1998](https://github.com/go-to-k/cdkd/issues/1998). The maintainer
chose direction 2 on the issue: a `NoEcho: true` template parameter's value is
redacted in everything cdkd persists or publishes, not only in its logs. A
comparison that needs the value reads it back from AWS or re-resolves it from
the current parameters. It never stores the value, or anything derived from it.

This page is the design only. Every `file:line` below refers to `main` at
`428ce7347`.

## Background: where the value comes from and where it goes today

A top-level `cdkd deploy` passes no parameter overrides. `resolveParameters`
(`src/deployment/intrinsic-function-resolver.ts:3655`) binds each parameter to
its `Default`, or resolves an SSM-typed parameter. A user value exists only for
a nested child, whose values the parent's `AWS::CloudFormation::Stack` row
supplies. The same function is how `cdkd diff`
(`src/cli/commands/diff-recursive.ts:1211`), `cdkd import`
(`src/cli/commands/import.ts:2230`) and `cdkd scrub`
(`src/cli/commands/scrub.ts:5993`) bind parameters. So every command that holds
the template can bind the value that a top-level deploy would use.

When a `Ref` serves a `NoEcho` parameter (`resolveRef`,
`intrinsic-function-resolver.ts:4852`, recording at `:4908`), or an `Fn::Sub`
variable does (`:8410`), the resolver calls `recordNoEchoParameterValue`
(`:4632`). That calls `recordLogOnlyParameterValue`
(`src/deployment/secret-redaction.ts:1102`). The value goes into the
`logOnlyValuesOf` side set (`secret-redaction.ts:1006`). It never reaches the
`RecordedSecretValues` map. The side set's own doc (`secret-redaction.ts:970-1005`)
states the #1998 contract: nothing that persists reads it. `redactSecretsForState`
(`:7432`) and `scrubResourceRecord` (`:7808`) walk the map alone, so every
persisted copy below is plaintext.

## 1. Every persisted surface that holds the value today

All eight deploy saves go through `withParentInfo`
(`src/deployment/deploy-engine.ts:3028`) and `redactStateForPersist` (`:2782`).
They write through `S3StateBackend.saveState`
(`src/state/s3-state-backend.ts:532`).

| Surface | Write site | Redaction before the write | Plaintext today |
| --- | --- | --- | --- |
| `resources[*].properties` | `redactStateForPersist`, `deploy-engine.ts:2792` | `scrubResourceRecord`, map only | yes |
| `resources[*].observedProperties` | same save; readback installed by `drainObservedCaptures` | `scrubResourceRecord`, map only | yes, when AWS echoes it |
| `resources[*].attributes` | same save; provider `result.attributes` | `scrubResourceRecord`, map only | yes, when a provider echoes it |
| `resources[*].physicalId` | same save | none, by design | yes, when the value names the resource |
| `outputs` values | `outputs[outputKey] = resolved`, `deploy-engine.ts:10451` | `redactOutputs`, `deploy-engine.ts:1985` | yes |
| `outputs` alias KEY and `exportNames` | `deploy-engine.ts:10640`, `:10645` | refusal `exportNameSecretExposure` reads the map only (`outputs-export-alias.ts:666`) | yes |
| `orphans[*].state` | `redactStateForPersist`, `deploy-engine.ts:2852` | `scrubResourceRecord`, map only | yes |
| `imports[].exportName`, `outputReads[]` names | resolver records; redacted at `deploy-engine.ts:2935` | `redactSecretsForState`, map only | yes, when a name embeds it |
| Exports index | `ExportIndexStore.writeIndex`, `src/state/export-index-store.ts:592` | values from `redactOutputs`; keys never redacted | yes, value and key |
| Rollback journal | `appendRollbackJournalSegment`, `s3-state-backend.ts:1124`, from `deploy-engine.ts:6000` | `redactOperationsForJournal`, `deploy-engine.ts:2550` | yes |
| Nested journal `previousOutputs` | copied from the previous state | none (a copy) | when that state held it |
| `deployments/*.jsonl` events | deploy `deploy-engine.ts:6452`; rollback `src/cli/commands/rollback.ts:907`; destroy `src/cli/commands/destroy-runner.ts:2091` | deploy: `maskSecretsInEvent` (`:6470`) masks `error.message` and `reason`; rollback masks `error.message` with the op masker (`rollback-executor.ts:249-261`) and persists `reason` raw; destroy: none | `physicalId`; a rollback or destroy message quoting the value |
| `cdkd state refresh-observed` | `src/cli/commands/state.ts:3986` | position walk with an empty map (`state.ts:3952`) | yes |
| `cdkd drift --accept` / `--revert` | `src/cli/commands/drift.ts:3930`, `:6391` | `redactSecretsForState`, map only | yes |
| `cdkd import` | `import.ts:2413` (properties), `:2523` (attributes), `:3450` (observed) | map only | yes (the bound `Default`) |
| `cdkd scrub` | `scrub.ts:7232` and siblings | map only | yes; scrub cannot see it either |
| `cdkd rollback` restore | `redactRollbackRecord`, `src/deployment/rollback-executor.ts:2610` | `scrubResourceRecord`, map only | carries what the journal held |

Not affected:

- `skippedOutputs` stores digests. A `NoEcho` `Default` is hashed as a constant
  (`withNoEchoDefaultsMasked`, `src/analyzer/skipped-outputs.ts:229`).
- The lock file, asset manifests and synth output. These hold no resolved
  values.

## 2. Decisions

1. **The marker is the existing whole-leaf mask `***`** (`SECRET_MASK`,
   `secret-redaction.ts:56`). The mask-only class is reused. A `NoEcho`
   parameter's value becomes a FRESH mask-only needle of the pass that resolved
   it, in addition to the log-only needle it is today.
2. **A second, POSITIONAL arm masks by template position.** It is not bounded
   by the value's length. It also covers number and boolean leaves.
3. **State schema v11 adds `ResourceState.noEchoParameterLeaves`.** This is the
   durable record of which leaves stand for a parameter. Readers that hold no
   template need it (`cdkd drift`, `cdkd rollback`, `cdkd export`, observed
   writers). The bump also locks out older binaries, which would replace a
   resource on `***` vs plaintext.
4. **The comparison is an AWS readback, generalized from #3729.** It is used on
   every path that carries a fresh parameter leaf, not only on replacement
   ceilings. A pre-v11 record's own plaintext is the witness for its one
   migration deploy.
5. **`Export.Name` embedding a `NoEcho` value is refused.** This is the #1919
   rule: the alias is not published, and the deploy warns.
6. **Migration is transparent.** It happens on the next `cdkd deploy` or
   `cdkd scrub` of each stack. No user action is needed, and reading never
   rewrites.

## 3. The redaction marker, per surface

### 3.1 Two arms, one sentinel

**Value arm.** `recordNoEchoParameterValue` keeps its log-only recording. It
also calls `recordFreshNoEchoValuesIn` (`secret-redaction.ts:897`) over the
same spellings. That writes `plaintext -> ***` into the map through
`recordMaskOnlyValue` (`:665`), marks the value FRESH (`freshNoEchoValuesOf`,
`:830`), and marks it as a containment needle. So a leaf that EMBEDS the value
is flattened whole (#2453). This is the arm that already serves a
custom-resource `NoEcho` value and a recovered cross-stack output. So
`carriesFreshNoEchoValue` (`:1254`), `freshNoEchoLeafPositions` (`:1295`),
`carryFreshNoEchoMark` (`:941`) and the readers of `carriesSecretMask` (`:800`)
see a parameter value with no new predicate. It still does not fit in three
places:

- **The length floor.** `recordMaskOnlyValue` refuses a plaintext shorter than
  `MIN_NEEDLE_LENGTH` (`secret-redaction.ts:666`, constant `4` at `:3221`),
  because a bare needle masks every equal leaf in the record. A 1-3 character
  `NoEcho` value would stay in the clear. The positional arm closes this at
  template positions.
- **Non-string leaves.** The map is string-keyed. A `Number` or
  `List<Number>` parameter reaches a leaf as a number, and the value arm never
  matches it.
- **Keys.** The walk rewrites values, never keys. The `Export.Name` alias
  (section 5) and a physical id cannot be masked.

**Positional arm.** This arm is new, and it lives in `redactSecretsForState`'s
path walk (`secret-redaction.ts:7432`). The walk already receives the template
bag as its position source. At a source position whose intrinsic READS a
`NoEcho` parameter, the persisted leaf becomes `***`. That is a bare
`{Ref: P}`, or an `Fn::Sub` / `Fn::Join` / `Fn::If` / `Fn::Select` whose subtree
references `P`.

- A scalar leaf of any type becomes `***`.
- A list-valued leaf (`CommaDelimitedList`, `List<Number>`) becomes a list of
  `***`, one per element, so array shape survives for `equalModuloMask`.
- The arm writes each masked coordinate into `noEchoParameterLeaves`.
- **The arm also marks each coordinate FRESH, by position.** Freshness today
  is value-keyed and string-only: `freshNoEchoValuesOf` is a
  `Set<string>` per bag (`secret-redaction.ts:830`), `FreshNoEchoLeaf.plaintext`
  is a `string` (`:1274-1277`), and `liveHoldsFreshLeaves` fails any non-string
  node (`deploy-engine.ts:1012`). A leaf only this arm masks (a `Number`, a
  `List<Number>`, a value under 4 characters) would otherwise compare `***`
  with `***` and take the first no-change skip, so a changed value would never
  reach AWS. So the pass bag gains a coordinate set beside
  `freshNoEchoValuesOf`, which `carriesFreshNoEchoValue` and
  `freshNoEchoLeafPositions` consult too. `FreshNoEchoLeaf.plaintext` becomes
  the resolved leaf of any type, and `liveHoldsFreshLeaves` compares it with
  `keyOrderFreeJson`.

The arm needs no value, so it also serves `cdkd scrub` and a template-only
migration. The value arm stays the backstop for flows the template cannot
position: an attribute a provider echoes, an observed readback, and a
cross-stack or nested hop.

### 3.2 `ResourceState.noEchoParameterLeaves` (schema v11)

```typescript
interface ResourceState {
  // ...v10 fields...
  /** v11+: coordinates within `properties` persisted as `***` because a NoEcho template parameter served them. */
  noEchoParameterLeaves?: (string | number)[][];
}
```

- **Coordinates are segment arrays, not dotted strings.** A dotted key is legal
  in a property bag, and `pathCrossesDottedKey` (`secret-redaction.ts:5524`)
  exists because dotted paths are ambiguous.
- **Absent means none is known.** This is every pre-v11 record. A reader then
  treats a `***` exactly as today, as the custom-resource class.
- **The leaves name positions, not values or parameter names.** Nothing in the
  field is derived from the value.
- **Every writer that rebuilds `properties` from a template recomputes it.**
  That is deploy, import and scrub. Every writer that carries a record forward
  keeps it: rollback restore, orphan, a destroy partial snapshot, and a failed
  deploy's partial save.

### 3.3 Per surface

| Surface | Marker | Written by |
| --- | --- | --- |
| `properties` | `***` at every positioned leaf, plus value-arm leaves | both arms |
| `observedProperties` | `***` at every coordinate `noEchoParameterLeaves` names, plus value-arm leaves | every observed writer (deploy capture, import, refresh-observed, drift) |
| `attributes` | value arm only | the deploy's `scrubResourceRecord` |
| a same-stack `Fn::GetAtt` consumer's `properties` | `***` via the value arm, once the producer declares the attribute (below) | both arms |
| `outputs` values | `***` via the outputs position source (`outputsTemplateSource`), plus the value arm | `redactOutputs` |
| exports index values | inherits `redactOutputs` (`deploy-engine.ts:4543`, `:4750`) | unchanged callers |
| `outputs` alias keys, `exportNames` | none: the alias is refused (section 5) | `resolveOutputs` |
| `imports[]` / `outputReads[]` names | `***` via the value arm | `redactCrossStackReads` |
| rollback journal `properties` / `attemptedProperties` | both arms (the journal already positions by the template bag, `deploy-engine.ts:2563`) | `redactOperationsForJournal` |
| rollback journal `previousState` | carries the record, marker included (`scrubResourceRecord`, `:2596`) | unchanged |
| `orphans[*].state` | carries the record | unchanged |
| `deployments/*.jsonl` | unchanged: the map entry now masks `error.message` / `reason` without the log-only set | `maskSecretsInEvent` |
| `physicalId` | none (see below) | provider |

**An echoed attribute must reach its consumers as fresh.** A provider can echo
the value into an attribute: `AWS::SSM::Parameter` returns `attributes.Value`
(`src/provisioning/providers/ssm-parameter-provider.ts:430-432`), and the
fixture's `NoEchoConsumer` is that producer. The in-memory record keeps the
real attribute for same-run reads. `noteAttributeSecrecy`
(`intrinsic-function-resolver.ts:5681`) registers a fresh needle in a
CONSUMER's bag only for an attribute listed in `noEchoAttributeResources`
(`:5684-5697`), which today only custom resources and nested stacks fill. Left
alone, a consumer of `Fn::GetAtt NoEchoConsumer.Value` would persist the
plaintext on its first deploy, then read the producer's persisted `***` and be
refused by `refuseRedactedAttributeReads` (`deploy-engine.ts:2462`) on every
later one. So at the producer's create or update site, an attribute whose leaf
equals or embeds a fresh `NoEcho` needle of the producer's bag is added to
`noEchoAttributeResources` for that logical id, the existing #2274 mechanism.
That covers the run in which the producer is created or updated. On a LATER
deploy the producer is `held` and skipped, so its record holds
`attributes.Value = '***'`, and the consumer's `Fn::GetAtt` would be refused
again. The #1852 heal cannot help. It runs only for an attribute the record
LACKS or holds as a stale placeholder
(`intrinsic-function-resolver.ts:6017-6024`), and `mergeHealedAttributes`
never overwrites a recorded key (`src/deployment/stale-attribute-heal.ts:169-190`).

So a `held` producer serves the declared attributes through a SIDE map for
this run:

- **Source.** The #1852 read primitive, `provider.import({ knownPhysicalId })`
  (`deploy-engine.ts:2703-2712`). It is read-only, memoized per record per
  deploy, and it returns the ATTRIBUTE map. The `held` readback
  (`readCurrentState`, `src/types/resource.ts:1142-1148`) returns properties,
  whose keys coincide with attribute names only by accident (SSM `Value`, but
  not an SNS `TopicArn`).
- **Served only where it matches.** A declared attribute is served only when
  the imported value equals or embeds a fresh needle of the producer's bag.
  Otherwise the consumer is refused.
- **Never in the record.** The resolver's `Fn::GetAtt` reads the side map the
  way it reads the `attributeHealer` channel (`ResolverContext.attributeHealer`,
  `intrinsic-function-resolver.ts:1667`). It never goes through
  `healedAttributes` / `withHealedAttributes`, which the persist merge reads
  (`deploy-engine.ts:2801`). So `stateResources[producer].attributes` is never
  written by this path. This matters for a `Number` or 1-3 character value,
  which the value arm would not re-mask on the way out.
- **Fresh in the consumer.** Each served value is registered as a fresh needle
  in the consumer's bag, so the consumer's record persists `***`.

A producer whose type has no `import`, or whose value does not match, cannot
serve them, so its same-stack consumers are refused, as a custom-resource
`NO_CHANGE` consumer is today (`nested-stack-provider.ts:810-816`). That
refusal and an out-of-process consumer's are listed with the new refusals in
section 6.

**`physicalId` stays in the clear.** It is the handle every later call
addresses the resource by, and AWS publishes it (ARN, name). A value used to
NAME a resource is disclosed by AWS itself. The deploy warns once per resource
whose physical id embeds a `NoEcho` value. It does not refuse, because
CloudFormation accepts the same template.

**Floor residual.** A value shorter than 4 characters that reaches state other
than through a template position stays in the clear. That covers an echoed
attribute, an observed readback of an unmarked coordinate, and a cross-stack
hop. This is the documented bound of the mask-only class, unchanged.

## 4. How every reader keeps working when it reads `***`

The shared model: the record says only that a parameter served the leaf. The
value is either in THIS process (the deploy resolved it), or in AWS (a
readback). A reader that has neither refuses at that position. It never guesses
and never sends `***`.

### 4.1 The diff and the no-change skip

**Today.** The UPDATE arm's first skip (`deploy-engine.ts:7202-7220`) compares
REDACTED bags. It refuses any bag for which `carriesFreshNoEchoValue` is true
(`:7163`). The diff calculator has no mask awareness: `***` equals `***`, and
never equals a plaintext (`diff-calculator.ts:1349-1439`).

**Change.** The diff must compare what the persist side would write, or every
masked resource diffs as UPDATE forever. `cdkd diff` has the same gap
(`diff-recursive.ts:1561`, plaintext parameters, no promotion).

1. The diff resolver context redacts each resolved property through the same
   walk the persist side runs. Both arms apply, with the parameter values
   registered as fresh mask-only needles. A positioned leaf then diffs `***`
   against `***`. The nested-child precedent is `redactParametersForDiff`
   (`deploy-engine.ts:1840`, wired at `:4159`). It redacts the parameter bag
   instead of the resolved property, which cannot flatten an embedding leaf.
   The resolved-property form is the one that matches the persist side.
2. `calculateDiff`'s `freshParameters` (`diff-calculator.ts:261-268`) is today
   passed only by a nested child (`deploy-engine.ts:4222`, from
   `freshNoEchoParameters`, `:1807`). It becomes EVERY `NoEcho: true`
   parameter, at every level. Arm 5 (`diff-calculator.ts:1136-1148`) then
   promotes each reader to a speculative UPDATE, so the engine re-resolves it
   and decides.
3. In the engine, the resolved bag carries a fresh leaf, so the first skip is
   not taken (unchanged). Then comes the readback (section 4.2). The second
   skip (`deploy-engine.ts:7370-7393`) applies when AWS holds every fresh leaf
   and nothing else moved. Its gate becomes "every fresh leaf is confirmed
   held", not "a ceiling was lowered".
4. **Migration witness.** A leaf at a position the positional arm names,
   in a record that carries no `noEchoParameterLeaves`, and that still holds a
   non-mask value, is a pre-v11 plaintext. It is the exact value last sent, so
   it is compared directly and needs no readback. The witness must sit BEFORE
   anything classifies the leaf as moved, or the migration deploy replaces a
   create-only reader:
   - In the diff, `compareProperties` (`diff-calculator.ts:1389-1415`) would
     see `***` against the recorded plaintext and set `requiresReplacement`.
     For a witness leaf, the diff compares the RESOLVED value against the
     recorded plaintext instead. It redacts only the stored copy.
   - In the engine, the ceiling block's `moved` test
     (`deploy-engine.ts:7291-7293`) keeps a replacement on `***` vs plaintext
     (`:7308-7310`). A witness leaf is resolved there first: equal means
     `held`, different means `differs`, and the verdict table in section 4.2
     applies.

   This makes the migration deploy skip an unchanged resource, and never
   replace one because of the migration.

`cdkd diff` takes steps 1, 2 and 4 with the same helpers. It has no readback,
so a promoted reader that is not a witness renders as
`~ (NoEcho parameter, compared on deploy)` and does not count toward `--fail`.
A witness leaf is compared exactly, so an unmigrated stack diffs as it does
today. Its printing masker (#4126) is unchanged.

### 4.2 Update vs replace

**Readback, generalized.** `readReaderForFreshNoEchoCeiling`
(`deploy-engine.ts:3063`) today reads a resource only for a create-only path
under a replacement ceiling (`:7276-7353`). It hands the provider the RECORD's
masked `properties`, is capped by a timeout, and persists nothing. Its safety
properties are kept verbatim. The change is that it runs once per resource
whose resolved bag carries a fresh parameter leaf, whatever the path's
replacement class. The comparison stays `liveHoldsFreshLeaves`
(`deploy-engine.ts:999`), which is strict equality at every position.

Verdicts for a leaf a parameter served:

| Verdict | Updatable path | Create-only path |
| --- | --- | --- |
| `held` | nothing to send; skip if nothing else moved | lowered to in place, as #3729 |
| `differs` | UPDATE | REPLACEMENT |
| `not-readable` (write-only, or no `readCurrentState`) | UPDATE: the value is re-sent on every deploy (question 5) | see question 1 |
| `read-failed` | UPDATE | the resource fails with a retry message; no replacement on a transient error |

A nested stack's `AWS::CloudFormation::Stack` row is one `not-readable`
reader: it carries the value at `properties.Parameters.<P>`, and
`NestedStackProvider` has no `readCurrentState`. So its child engine re-runs
on every deploy, and the child decides per resource with its own readbacks.

A custom-resource leaf (the #3729 population) keeps its current verdict table.
The two classes are told apart by the source: the positional arm, or a
`NoEcho` parameter name in the pass's fresh set. A write-only create-only
property raises no ceiling for a promoted reader
(`diff-calculator.ts:752-786`). So such a path reaches the engine as an
in-place change, and question 1 decides what the engine sends.

### 4.3 `cdkd drift`, `--accept` and `--revert`

`cdkd drift` reads state only and never synthesizes (`docs/cli-drift.md`).
Today a `***` baseline leaf against the live plaintext reads as drift. The
comparator has no mask logic, and `partitionUncertifiedBaselineChanges`
(`drift.ts:2122-2147`) exempts only the #2852 fail-closed class
(`isUncertifiedBaselineMaskPosition`, `secret-redaction.ts:5570`). Without a
change, every migrated stack would drift forever.

- **Report.** A change at a coordinate `noEchoParameterLeaves` names, where the
  two sides are equal modulo the mask (`equalModuloMask`), is split into a new
  `noEchoParameter` bucket. It prints the path only. `equalModuloMask`
  accepts a mask only against a STRING live value
  (`src/analyzer/drift-calculator.ts:338`), so at a marked coordinate the
  bucket also takes a number, boolean or list live value. Like `unresolvedToken`
  (`docs/cli-drift.md`, the reason table), it does not affect the exit code,
  because no re-run can clear it. The AWS side is never printed:
  `redactDriftValue` (`drift.ts:2195`) already masks a secret-bearing path.
- **`--accept`.** `acceptRefusalReason` (`drift.ts:2252`) already refuses a
  masked path. Other paths of the same resource are still accepted. The
  baseline writer masks every marked coordinate of what it writes, so a live
  plaintext never enters `observedProperties`.
- **The `--revert` baseline writer** (`drift.ts:6391`) masks every marked
  coordinate the same way. Its bag holds a live value only when that value is
  a string of 4 or more characters (`drift.ts:5318`).
- **`--revert`.** A bucketed position is not drift, so it is not reverted.
  `preserveLiveValuesAtMaskedLeaves` (`drift.ts:5297`) keeps AWS's value at
  every `***` leaf of the send bag and registers it as a mask-only needle
  (`:5318`). That is already correct for a marked leaf.

### 4.4 Rollback replay

Today `refuseMaskedReplayBaseline` (`rollback-executor.ts:2294`) throws
`ROLLBACK_REDACTED_BASELINE` on any written bag that carries `***`
(`:3423` reverse-replacement re-create, `:4306` revert, `:4878` revert-failed).
`resolveReplayProps` (`:2218`) re-resolves only `{{resolve:...}}` leaves.

- **Marked leaf of an existing resource** (revert and revert-failed). This
  applies in process and in `cdkd rollback` alike. The replay reads the
  resource back with the #3729 helper shape: routed by the record, and handed
  the masked record. It substitutes the live value at each marked coordinate.
  A live value that is absent, or that itself carries the mask (a provider
  echoing the masked record it was handed, the reason
  `deploy-engine.ts:3049-3054` hands it that record), is `not-readable` and
  keeps `ROLLBACK_REDACTED_BASELINE`. So `***` is never substituted. Each
  substituted value is recorded as a mask-only needle in the op's bag, AND as a
  log-only needle (`recordLogOnlyParameterValue`, no length floor, every
  printed spelling), so a short or numeric value is masked in lines and events
  too. The provider masker,
  the re-redacted record and an event's `error.message`
  (`maskedRollbackEventError`, `rollback-executor.ts:249-261`) then mask it.
  An event's `reason` / `survivorReason` is persisted RAW (the note above
  `rollback-executor.ts:295`). Phase C routes both through the same op masker
  before `ctx.recordEvent`, which closes the #4043 rollback-events item. The
  leaf is left exactly as AWS holds it.
  - A parameter change made by the reverted op is therefore not reverted.
    The next deploy with the old value restores it.
  - An unreadable leaf keeps the refusal, with a parameter-specific remedy.
- **A resource the replay must re-CREATE** (reverse-replacement). There is no
  live resource to read. Out of process there are no parameters either. The
  refusal stays, with a parameter-specific remedy: re-deploy.
- **An unmarked `***`** is the custom-resource class, unchanged.

### 4.5 `cdkd import`

`cdkd import` binds `Default`s (`import.ts:2230`) through the same resolver, so
it records the fresh needle and the persist walk positions it. The imported
`properties` hold `***` and the marker. The observed capture
(`import.ts:3450`, an empty map with `STATE_SOURCED_BASELINE_RULES`) masks the
marked coordinates. A `NoEcho` parameter is already never provable against a
CloudFormation-deployed value (`divergentParameterNames`,
`src/cli/commands/import-deployed-parameters.ts:233-240`), so that refusal is
unchanged.

### 4.6 `cdkd scrub`

Scrub resolves with template `Default`s (`scrub.ts:5993`), so it records the
same needles. It gains the positional arm, which needs no value, and one
migration rule. At a template position that reads a `NoEcho` parameter, the
record's OWN stored plaintext becomes a value-arm needle for that record's
`observedProperties` and `attributes`. This covers a stack deployed under an
older `Default`. Scrub is also the migration path for a stack that is never
redeployed. `--dry-run --fail` reports an unmasked `NoEcho` leaf as a finding.

### 4.7 Cross-stack reads and exports

An output served by a `NoEcho` parameter persists `***`, and the exports index
inherits it through `redactOutputs`.

- **In process.** `rememberRecoverableMaskedOutputs` (`deploy-engine.ts:1915`)
  already remembers the plaintext for every `***` output of this run.
  `reresolveCrossStackValue` (`intrinsic-function-resolver.ts:9163`, mask arm
  at `:9225`) recovers it for a consumer in the same `cdkd deploy`, and
  registers it fresh in the consumer's bag.
- **Out of process.** A consumer deployed by an earlier or a separate run is
  refused as a `cross-stack` redacted read. This is today's behavior for a
  custom-resource `NoEcho` output. It is a new refusal for parameter-served
  outputs (question 2).
- **Nested children, output direction.** A child's `NoEcho`-served output
  reaches the parent row through `noEchoAttributeNames`
  (`nested-stack-provider.ts:275`), as a custom-resource value does now.
- **Nested children, log-only carry.** The child's
  `recordInheritedParameterSecrets` already carries the parent's log-only
  needles (`carryLogOnlyValuesCarriedBy`, `intrinsic-function-resolver.ts:4579`),
  and the parent passes its bag on `hasMaskableValues`
  (`nested-stack-provider.ts:769`).
- **Nested children, parameter direction.** The parent's row passes the value
  in its `Parameters` property, which the parent's record masks by position.
  The child receives the parent's bag as `inheritedSecrets`. Once the value is
  a fresh mask-only map entry there, `recordInheritedParameterSecrets`
  (`intrinsic-function-resolver.ts:4567`) records it into each consuming child
  resource's bag, and `carryFreshNoEchoMark` (`secret-redaction.ts:941`) keeps
  it fresh. A CDK-synthesized child's parameter declaration never says
  `NoEcho`, so that child has no positional arm. A hand-authored child that
  declares `NoEcho: true` gets one. An inherited value
  shorter than 4 characters therefore stays in the clear in the child's
  record: the floor residual of section 3.3.

### 4.8 Other readers of `***`

- **`cdkd export`** blocks every record whose `properties` carry `***`
  (`src/cli/commands/export.ts:5100`). CloudFormation receives a `NoEcho`
  parameter's value through its own parameter
  (`resolveTemplateParameters`, `export.ts:5921`). So a record whose only
  masks sit at marked coordinates is let through, as long as the identifier
  resolution (`export.ts:5291`) and the pre-delete entry (`:5157`) do not read
  a marked coordinate. One that does keeps the block.
- **Delete addresses.** `isRedactedRecordedValue`
  (`src/provisioning/redacted-delete-address.ts:22`) makes a provider skip a
  delete whose address property is redacted (`redactedDeleteAddressSkip`,
  `:62`). The resource is left in place and the record is kept. The runner
  then exits 2, on a deploy that removes the resource too, unless
  `--allow-unaddressed` (`.claude/rules/provider-delete-path.md`). A parameter
  that feeds a delete address newly reaches that skip (question 3).
- **`masked-baseline-recapture.ts:68-75`** skips a record whose `properties`
  carry `***`. That is correct for a marked leaf, because the value is not
  recapturable from `properties`.

## 5. `Export.Name`

**Decision: refuse the alias, as the #1919 rule refuses a secret-bearing
name.** Masking a key is not possible. A consumer's `Fn::ImportValue` binds the
exact name, so `***` would be a different export, and two masked names would
collide. Publishing it would put the value in `state.json`, `exportNames` and
the bucket-wide exports index, which any stack's reader can list.

- `exportNameSecretExposure` (`src/deployment/outputs-export-alias.ts:666`) is
  called with two bags (`deploy-engine.ts:10613`): the name's own recording
  bag `nameSecrets`, counted wholesale, and the pass map as
  `recordedThisPass`, scanned by bounded containment (`secretsPresentIn`,
  `outputs-export-alias.ts:518`). `nameSecrets`'s map entries are the name's
  own. Its log-only set is SHARED with the
  whole outputs pass (`shareLogOnlyValues`, `deploy-engine.ts:10517`), so it
  cannot be counted wholesale: one output reading a `NoEcho` value would
  refuse every export name.
  - **Phase A** adds the log-only needles to the containment test only. The
    set is module-private (`secret-redaction.ts:1006`), but
    `printingCorpusOf` (`:1126`) returns the map plus each log-only needle as
    an entry. Phase A hands that corpus to `secretsPresentIn`
    (`outputs-export-alias.ts:518`) as a second containment corpus. So the
    log-only needles get the same canonical and detection haystacks
    (`secretScanHaystacks`, `:523-551`) a secret gets today, and the fold
    #4173 adds. A raw `maskSecretsInText` comparison would miss a value
    spelled with compatibility or invisible characters, the #2874 / #4001
    class. That scan's floor is the one wanted: a name equal to a value is
    refused at any length, and a name embedding one at 4 or more characters. It deliberately reverses the #4049 rule that a
    publication verdict never reads log-only needles
    (`.claude/rules/layout-deployment-secrets.md`, and the side-set doc at
    `secret-redaction.ts:991-995`). Phase A updates the rule file. The doc
    comment is in a file #4130 holds, so Phase B updates it.
  - **Phase B** makes the value a map entry of the name's own bag. Its
    wholesale arm then refuses it, still from 4 characters, because the
    mask-only floor applies.
- **The positional twin (Phase B).** A name whose `Export.Name` intrinsic
  references a `NoEcho` parameter is refused, whatever the value's length. It
  needs the raw intrinsic and the template's `Parameters`, which only the
  engine's outputs pass holds.
- The existing skip-and-warn applies (`secretBearingExportNameWarning`). The
  deploy succeeds, the alias is not published, and the next exports-index
  update drops a previously published entry.
- The residual note at `outputs-export-alias.ts:119-128` is replaced.
- **The containment scan is pass-wide from Phase A on.** The corpus
  `printingCorpusOf(nameSecrets)` holds the log-only set the whole outputs pass
  shares (`deploy-engine.ts:10517`), so it sees every `NoEcho` value ANY
  output of the pass read. Phase B sees the same set through the map. A name that merely contains one at 4 or more characters is refused. For
  a low-entropy value (`prod`), that refuses ordinary names. This is the same
  bound #1919 accepted for secrets, and the warning names the output.
- **A stack that is never redeployed** keeps a published alias in `outputs`,
  `exportNames` and the exports index. `cdkd scrub` cannot rewrite a key
  (`.claude/rules/layout-scrub.md`). It reports the key, and the remedy is a
  redeploy.

This is a behavior change: a consumer of such an export stops resolving.
CloudFormation publishes the name, so this is a deliberate parity divergence,
the same one #1919 took.

## 6. Schema v11 and transparent migration

**It is a bump.** `STATE_SCHEMA_VERSION_CURRENT` goes from 10 to 11
(`src/types/state.ts:148`, readable list at `:156`). The reason is the same as
v10's (`state.ts:124-139`): an older binary would ignore the new meaning.

- A v10 binary reading a masked record compares its plaintext desired value
  against `***`.
- On a create-only path, the diff classifies that as a replacement
  (`diff-calculator.ts:1391-1415`). The v10 binary has no fresh mark for a
  parameter, so it takes no readback.
- The bump makes it fail with the existing "Upgrade cdkd" error
  (`s3-state-backend.ts:1720-1737`) instead of replacing the resource.

The trade v10 names applies here too. `saveState` stamps the current version
unconditionally (`s3-state-backend.ts:545`), so every stack a v11 binary writes
refuses older binaries.

**v11 does not certify "redacted".** A write that holds no template stamps v11
over a record that may still hold plaintext. That is `refresh-observed`,
`drift --accept`, `orphan`, a destroy partial snapshot, or a rollback restore.
So readers never infer redaction from `version`. They read
`noEchoParameterLeaves`, and absence means "treat as today".

**Migration, per record, with no user action:**

1. **Read.** A v10 record is read unchanged. Reading never rewrites (the
   `schema-v9-to-v10-migration` contract).
2. **First `cdkd deploy`** of the stack under v11:
   - Readers of a `NoEcho` parameter are promoted (section 4.1).
   - Each is compared against its own recorded plaintext: the witness, so no
     readback is needed.
   - The final save masks by both arms and writes `noEchoParameterLeaves`.
   - A record this deploy did not resolve has no needles in
     `perResourceSecrets`. That covers a resource a failed deploy never
     reached, and a partial save. For that case, `redactStateForPersist`
     (`deploy-engine.ts:2782`) gains the positional arm over EVERY record,
     driven by the deploy's template. So a record the deploy did not touch is
     migrated too.
3. **`cdkd scrub`** migrates a stack without deploying it (section 4.6).
4. **Outputs, the exports index and `exportNames`** are rewritten by the same
   deploy's outputs pass. A refused alias drops out of `exportNames`, and the
   index update (`export-index-store.ts:353`) removes its entry.
5. **The rollback journal** needs no version bump. An older binary replaying a
   v11 journal sees `***` and refuses with `ROLLBACK_REDACTED_BASELINE`, which
   fails closed.

**No loss of the ability to deploy.** Every step above either keeps the
resource as it is (a witness, or `held`) or updates it with the value in hand.
The only new refusals are these:

- an out-of-process consumer of a parameter-served output (question 2);
- a create-only leaf whose readback FAILED (`read-failed` in section 4.2),
  which fails the resource with a retry message rather than replacing it;
- a `Fn::GetAtt` consumer of an attribute that echoes the value, when the
  producer was deployed in another run, or has no readback and is unchanged
  in this one (section 3.3); the remedy is to update the producer in the same
  run as the consumer;
- a hand-authored nested child that declares a parameter `Number`, or a
  comma-bearing `CommaDelimitedList`, and receives a parent's `NoEcho` value:
  once that value is a map entry, `refuseCoercedInheritedSecret`
  (`intrinsic-function-resolver.ts:4681`) refuses it;
- a rollback re-create with no live resource.

The costs that are not refusals are named by questions 1 and 5: a create-only
write-only leaf whose change is not detected, and an updatable write-only leaf
re-sent on every deploy.

**Noncurrent S3 versions** of `state.json` keep the old plaintext. Migration
does not purge them (question 4). A value ever stored in the clear must be
rotated, as `docs/cli-scrub.md` already says for secrets.

**Gates.**

- `integ-schema-migration`: the bump edits `src/types/state.ts`. It needs a
  clean `schema-v10-to-v11-migration` run (`.markgate.yml`, gate
  `integ-schema-migration`).
- `integ-destroy`: Phase B edits `src/deployment/deploy-engine.ts`, and Phase C
  edits `src/deployment/rollback-executor.ts`. Both are in that gate's scope.

## 7. Phasing

Open PRs hold files this work must edit:

- #4130 holds `src/deployment/secret-redaction.ts` and
  `src/deployment/intrinsic-function-resolver.ts`. Phase B waits for it.
- #4173 holds `src/deployment/outputs-export-alias.ts` and
  `docs/cli-scrub.md`. Phase A waits for it, and so does Phase C's
  `docs/cli-scrub.md` edit.
- #4140, named on the issue as holding `src/deployment/deploy-engine.ts`, has
  merged. Phase B builds on it, and on #4169. The `deploy-engine.ts` and
  `diff-recursive.ts` line numbers in this page are at `428ce7347`, before
  those merges.

| Phase | Scope | Files |
| --- | --- | --- |
| A | Refuse an `Export.Name` equal to or embedding a `NoEcho` value, from the log-only set | `src/deployment/outputs-export-alias.ts`, `.claude/rules/layout-deployment-secrets.md` (the publication-verdict rule), the `noecho-parameter-masking` fixture, unit tests, a changelog entry |
| B | Both arms, `noEchoParameterLeaves`, the v11 bump and migration, the diff and `cdkd diff` promotion, the generalized readback | `secret-redaction.ts`, `intrinsic-function-resolver.ts`, `deploy-engine.ts`, `diff-calculator.ts`, `diff-recursive.ts`, `src/types/state.ts`, `.claude/rules/state-schema.md`, `.claude/rules/layout-deployment-secrets.md`, `docs/state-management.md`, new `schema-v10-to-v11-migration` fixture |
| C | Readers without a template: rollback replay readback, drift bucket and writers, import and refresh-observed coordinate masking, scrub migration rule, `cdkd export` allowance | `rollback-executor.ts`, `src/cli/commands/rollback.ts`, `drift.ts`, `state.ts` (CLI), `import.ts`, `scrub.ts`, `export.ts`, `docs/cli-drift.md`, `docs/cli-rollback.md`, `docs/cli-scrub.md` |

**Phase B also flips every map reader the log-only doc kept blind**
(`secret-redaction.ts:986-1000`). Each is re-audited in B:

- The resolver's `maskNeedlesForLog` detector
  (the wrapper at `intrinsic-function-resolver.ts:11759`; its detector body
  at `:11776-11789` calls `maskRecordedSecretsInText`). `Fn::Base64` over text
  embedding the value now records a derived needle, which is wanted. The
  unsupported-service arm can newly refuse a leaf embedding both the value and
  an unsupported `{{resolve:` token.
- `stateKeySecretExposure` in `cdkd scrub --dry-run --fail` now flags a key
  holding the value.
- The export-name containment scan (section 5).

B cannot be split. Once one leaf persists `***`, the diff, the skip, the
readback and the bump must all hold, or a deploy updates or replaces the
resource forever.

B alone is fail-closed:

- rollback of a marked leaf refuses;
- `cdkd export` blocks the record;
- drift reports the leaf as drift, with both sides masked.

C removes those refusals. C touches no file B needs, so it can run as parallel
lanes once B merges.

## 8. Tests and integ plan

### Unit (per phase, each red on the pre-change tree)

- **A.** `exportNameSecretExposure` over a bag holding only a `NoEcho` needle
  refuses a name equal to a value of any length, and a name embedding a value
  of 4 or more characters. A name that does not contain a needle another
  output recorded into the shared log-only set is not refused. An ordinary parameter in the
  same name still publishes. **B** adds the positional twin: a 1-3 character
  embedded value is refused by position.
- **B, arms.** Cover each case:
  - a `Ref`, an embedding `Fn::Sub`, a `Number`, a `CommaDelimitedList`, and a
    3-character value by position persist `***` and name each coordinate;
  - a same-valued literal elsewhere in the record is untouched by the
    positional arm;
  - the value arm still flattens an echoed attribute of 4 or more characters.
- **B, readers.** Cover each case:
  - an unchanged value, readable: skipped, with no provider call;
  - a changed value: UPDATE;
  - write-only updatable: UPDATE;
  - create-only `differs`: REPLACEMENT;
  - `read-failed` on create-only: no replacement;
  - pre-v11 witness equal: skipped with NO readback call;
  - pre-v11 witness different: UPDATE;
  - pre-v11 witness equal on a CREATE-ONLY path: no replacement, and no
    provider call;
  - a `Number` value rotated: UPDATE issued (the position-keyed fresh mark);
  - a 3-character value rotated: UPDATE issued;
  - a same-stack `Fn::GetAtt` consumer of an echoed attribute persists `***`,
    and is not refused on the next deploy when the producer's readback is
    `held`; with a NUMBER echoed attribute, the persisted producer record
    still holds `***` (or nothing) at that key after the `held` deploy, which a
    string case cannot discriminate because the value arm re-masks a string;
  - the same consumer of a `not-readable` producer is refused on the next
    deploy with the remedy.
- **B, migration.** A v10 fixture record gets `version: 11`, `***` at every
  positioned leaf, and the marker. An untouched resource's record is migrated
  by the save-time positional pass. A v10 binary's refusal message is pinned
  through `STATE_SCHEMA_VERSIONS_READABLE`.
- **C.** Cover each case:
  - rollback revert substitutes the live value and masks it in the event,
    `reason` included, for a 3-character and a numeric value too;
  - a readback that returns `***` is `not-readable`, never substituted;
  - an unreadable leaf refuses with the parameter remedy;
  - drift buckets a marked leaf, exit code unchanged;
  - `--accept` never writes the live plaintext;
  - refresh-observed masks marked coordinates;
  - scrub migrates a stack deployed under an older `Default`.

### Integ (real AWS, through `/run-integ`)

**`noecho-parameter-masking` (extend).** It already deploys a `NoEcho` token
into an SSM parameter and a create-only SNS `TopicName`. The discriminating
assertions:

- **Flipped in Phase A.** The `NoEchoAliasProbe` output's `Export.Name` IS a
  `NoEcho` value, and Phase 1 asserts the export-alias COLLISION warning for it
  today. Once the exposure arm fires first (`deploy-engine.ts:10613-10631`),
  the collision warning is never reached. Phase A flips the assertion to the
  secret-bearing-name warning and to the alias being absent from `outputs`,
  `exportNames` and the exports index.
- **Flipped in Phase B.** Phase 1 asserts today that `state.json` holds the value in the
  clear. It becomes: no state blob, no object version written after the
  migration, and no exports-index version holds the token. Every positioned
  leaf is `***`, and `noEchoParameterLeaves` names it.
- **Redeploy, same value.** SSM `Value` is readable, so there is no update:
  AWS's `LastModifiedDate` is unchanged across the redeploy. This fails if the
  readback is skipped, because the resource would update every deploy. The
  `TopicName` is not replaced: the topic ARN is unchanged.
- **A same-stack `Fn::GetAtt NoEchoConsumer.Value` consumer (new).** Its
  record holds `***`, and the redeploy is not refused.
- **Redeploy, new value.** The SSM parameter holds the new value on AWS, and
  state still holds `***`.
- **`cdkd diff --fail`** exits 0 on an unchanged value.
- **`cdkd drift`** exits 0 and lists the leaf in the `noEchoParameter` bucket.
- **Phase C.** Inject a failure after the SSM update, then run
  `cdkd rollback`: the parameter keeps the value AWS holds, and no
  `deployments/*.jsonl` object carries the token.
- **Negative control.** An ordinary parameter beside it stays in the clear.

**`custom-resource-noecho-nested` (extend).** Add a `NoEcho` PARAMETER to
`CdkdCrNoEchoParamExample`, passed to the nested child and exported to the
consumer. The assertions:

- The in-process recovery serves the consumer in one `deploy --all`.
- A separate `cdkd deploy` of the consumer alone is refused as a `cross-stack`
  redacted read (question 2's default).
- The child's record masks the inherited value, through
  `carryFreshNoEchoMark`.

**`schema-v10-to-v11-migration` (new).**

- Deploy under the last v10 binary. `state.json` has `version: 10` and holds
  the plaintext.
- The v11 binary reads it (`state show`) without rewriting.
- The next `cdkd deploy` writes `version: 11`, `***` and the marker, and makes
  NO provider update for the unchanged resource. This is the witness path.
- The fixture includes a create-only property fed by the parameter. Its
  physical id is unchanged across the migration deploy, so the migration never
  replaces a resource.
- The v10 binary then fails with "Upgrade cdkd".
- Destroy is clean.
- The run sweeps every object version, because the pre-migration versions hold
  the token.

## 9. Open questions for the maintainer

Each question has a recommended default. The design above assumes the
default.

1. **A create-only property AWS never returns (write-only), fed by a `NoEcho`
   parameter.** An example is `AWS::DirectoryService::SimpleAD.Password`. No
   readback can confirm it. #3729 keeps the replacement on every uncertainty,
   which for a parameter would replace the resource on every deploy.
   **Recommended: do not replace; warn each deploy that a change to that value
   is not detected, and name `--recreate-via-cc-api` /
   `--recreate-via-sdk-provider` as the way to apply one.** The alternative,
   keeping #3729's rule, replaces or fails (stateful types) on every deploy.
2. **An output served by a `NoEcho` parameter, read by a consumer in another
   `cdkd` run.** **Recommended: persist `***` and refuse at the consumer**, as a
   custom-resource `NoEcho` output is today, with the remedy "deploy producer
   and consumer in one `cdkd deploy`". The alternative refuses such an output at
   the producer.
3. **A `NoEcho` parameter feeding a property a provider deletes by** (for
   example a Route 53 record value). **Recommended: keep the existing fail-safe
   skip** (`redactedDeleteAddressSkip`: the resource is left in place, the
   record is kept, and every destroy, and every deploy that removes the
   resource, exits 2 until it is cleaned up by hand, unless
   `--allow-unaddressed`). A deploy-time delete does hold the template, so a
   re-resolved address confirmed by a readback is a possible later refinement. The alternative
   re-resolves the address from today's template, but a changed parameter
   would then address the wrong record, and a "not found" reads as already
   deleted.
4. **Noncurrent S3 versions of `state.json` holding the old plaintext after
   migration.** **Recommended: do not purge.** Those versions are the state
   recovery path, and the scrub docs already say a value ever stored in the
   clear must be rotated. The alternative purges them per migrated key, with
   the noncurrent-version purge `src/state/s3-noncurrent-version-purge.ts`
   already implements.
5. **An UPDATABLE property AWS never returns, fed by a `NoEcho` parameter.**
   This is the commonest use of `NoEcho`: `AWS::RDS::DBInstance.MasterUserPassword`,
   `AWS::IAM::User.LoginProfile.Password`,
   `AWS::SecretsManager::Secret.SecretString`. The readback answers
   `not-readable`, so nothing can confirm the value unchanged, and the engine
   sends an UPDATE on every deploy, a no-op deploy included. CloudFormation
   compares its stored parameter values and sends nothing.
   **Recommended: accept the re-send, and log one info line per resource
   saying why it updated.** The value always reaches AWS, so a changed password
   is never missed. The alternative skips the re-send and warns that a change
   is not detected, as question 1 recommends for the create-only twin. That
   trades a mutating API call per deploy for a silently kept old password.

## Rejected alternatives

- **A salted hash beside the mask**, to compare without AWS. It is a confirm
  oracle for a low-entropy value. #3729 rejected it for the same reason, and
  so does `skippedOutputs` for a `NoEcho` `Default`.
- **A keyed MAC (KMS `GenerateMac`).** It needs a customer-managed key in every
  bootstrapped account, and still leaks equality across stacks under one key.
- **Persisting a parameter reference** (for example `{{cdkd:param:P}}`) in
  place of the value. `***` vs reference equality would hide every change of
  the parameter's value, which CloudFormation does apply.
- **Keeping the value log-only (direction 1).** This is what the maintainer
  decided against.
