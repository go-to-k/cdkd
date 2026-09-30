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
| Exports index | `ExportIndexStore.writeIndex`, `src/state/export-index-store.ts:599` | values from `redactOutputs`; keys never redacted | yes, value and key |
| Rollback journal | `appendRollbackJournalSegment`, `s3-state-backend.ts:1124`, from `deploy-engine.ts:6000` | `redactOperationsForJournal`, `deploy-engine.ts:2550` | yes |
| Nested journal `previousOutputs` | copied from the previous state | none (a copy) | when that state held it |
| `deployments/*.jsonl` events | deploy `deploy-engine.ts:6452`; rollback `src/cli/commands/rollback.ts:907`; destroy `src/cli/commands/destroy-runner.ts:2091` | deploy: `maskSecretsInEvent` (`:6470`) masks `error.message` and `reason`; rollback masks with the re-resolved journal bag (`rollback-executor.ts:222`); destroy: none | `physicalId`; a rollback or destroy message quoting the value |
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
| `outputs` values | `***` via the outputs position source (`outputsTemplateSource`), plus the value arm | `redactOutputs` |
| exports index values | inherits `redactOutputs` (`deploy-engine.ts:4543`, `:4750`) | unchanged callers |
| `outputs` alias keys, `exportNames` | none: the alias is refused (section 5) | `resolveOutputs` |
| `imports[]` / `outputReads[]` names | `***` via the value arm | `redactCrossStackReads` |
| rollback journal `properties` / `attemptedProperties` | both arms (the journal already positions by the template bag, `deploy-engine.ts:2563`) | `redactOperationsForJournal` |
| rollback journal `previousState` | carries the record, marker included (`scrubResourceRecord`, `:2596`) | unchanged |
| `orphans[*].state` | carries the record | unchanged |
| `deployments/*.jsonl` | unchanged: the map entry now masks `error.message` / `reason` without the log-only set | `maskSecretsInEvent` |
| `physicalId` | none (see below) | provider |

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
4. **Migration witness.** A leaf that `noEchoParameterLeaves` does not name,
   and that still holds a non-mask value, is a pre-v11 plaintext. It is the
   exact value last sent, so it is compared directly and needs no readback.
   This makes the migration deploy skip an unchanged resource.

`cdkd diff` takes steps 1 and 2 with the same helpers. It has no readback, so a
promoted reader renders as `~ (NoEcho parameter, compared on deploy)` and does
not count toward `--fail`. Its printing masker (#4126) is unchanged.

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
| `not-readable` (write-only, or no `readCurrentState`) | UPDATE: the value is re-sent on every deploy | see question 1 |
| `read-failed` | UPDATE | the resource fails with a retry message; no replacement on a transient error |

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
  `noEchoParameter` bucket. It prints the path only. Like `unresolvedToken`
  (`docs/cli-drift.md`, the reason table), it does not affect the exit code,
  because no re-run can clear it. The AWS side is never printed:
  `redactDriftValue` (`drift.ts:2195`) already masks a secret-bearing path.
- **`--accept`.** `acceptRefusalReason` (`drift.ts:2252`) already refuses a
  masked path. Other paths of the same resource are still accepted. The
  baseline writer masks every marked coordinate of what it writes, so a live
  plaintext never enters `observedProperties`.
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
  the masked record. It substitutes the live value at each marked coordinate,
  and records it as a mask-only needle in the op's bag. So the provider masker,
  the events and the re-redacted record all mask it: this closes the #4043
  rollback-events item. The leaf is left exactly as AWS holds it.
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
- **Nested children.** A child's `NoEcho`-served output reaches the parent row
  through `noEchoAttributeNames` (`nested-stack-provider.ts:275`), as a
  custom-resource value does now.

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
  `:62`). The resource is left in place and the record is kept. A parameter
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
  called with the name's own recording bag (`deploy-engine.ts:10613`). That
  bag's map entries are the name's own. Its log-only set is SHARED with the
  whole outputs pass (`shareLogOnlyValues`, `deploy-engine.ts:10517`), so it
  cannot be counted wholesale: one output reading a `NoEcho` value would
  refuse every export name.
  - **Phase A** adds the log-only needles to the bounded containment scan
    (`secretsPresentIn`) only. A name equal to a value is refused at any
    length. A name embedding one is refused at 4 or more characters.
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
   - An unchanged resource that the diff did not promote has no needles in
     `perResourceSecrets`. For that case, `redactStateForPersist`
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
The only new refusals are these: an out-of-process consumer of a
parameter-served output (question 2), a create-only leaf AWS cannot confirm
(question 1), and a rollback re-create with no live resource.

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

Two open PRs hold files this work must edit:

- #4130 holds `src/deployment/secret-redaction.ts` and
  `src/deployment/intrinsic-function-resolver.ts`.
- #4140 holds `src/deployment/deploy-engine.ts`.

Phases B and C wait for both to merge. Phase A waits for neither.

| Phase | Scope | Files |
| --- | --- | --- |
| A | Refuse an `Export.Name` equal to or embedding a `NoEcho` value, from the log-only set | `src/deployment/outputs-export-alias.ts`, `.claude/rules/layout-deployment-secrets.md` (the publication-verdict rule), the `noecho-parameter-masking` fixture, unit tests, a changelog entry |
| B | Both arms, `noEchoParameterLeaves`, the v11 bump and migration, the diff and `cdkd diff` promotion, the generalized readback | `secret-redaction.ts`, `intrinsic-function-resolver.ts`, `deploy-engine.ts`, `diff-calculator.ts`, `diff-recursive.ts`, `src/types/state.ts`, `.claude/rules/state-schema.md`, `.claude/rules/layout-deployment-secrets.md`, `docs/state-management.md`, new `schema-v10-to-v11-migration` fixture |
| C | Readers without a template: rollback replay readback, drift bucket and writers, import and refresh-observed coordinate masking, scrub migration rule, `cdkd export` allowance | `rollback-executor.ts`, `src/cli/commands/rollback.ts`, `drift.ts`, `state.ts` (CLI), `import.ts`, `scrub.ts`, `export.ts`, `docs/cli-drift.md`, `docs/cli-rollback.md`, `docs/cli-scrub.md` |

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
  of 4 or more characters. A needle another output recorded into the shared
  log-only set does not refuse an unrelated name. An ordinary parameter in the
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
  - pre-v11 witness different: UPDATE.
- **B, migration.** A v10 fixture record gets `version: 11`, `***` at every
  positioned leaf, and the marker. An untouched resource's record is migrated
  by the save-time positional pass. A v10 binary's refusal message is pinned
  through `STATE_SCHEMA_VERSIONS_READABLE`.
- **C.** Cover each case:
  - rollback revert substitutes the live value and masks it in the event;
  - an unreadable leaf refuses with the parameter remedy;
  - drift buckets a marked leaf, exit code unchanged;
  - `--accept` never writes the live plaintext;
  - refresh-observed masks marked coordinates;
  - scrub migrates a stack deployed under an older `Default`.

### Integ (real AWS, through `/run-integ`)

**`noecho-parameter-masking` (extend).** It already deploys a `NoEcho` token
into an SSM parameter and a create-only SNS `TopicName`. The discriminating
assertions:

- **Flipped.** Phase 1 asserts today that `state.json` holds the value in the
  clear. It becomes: no state blob, no object version written after the
  migration, and no exports-index version holds the token. Every positioned
  leaf is `***`, and `noEchoParameterLeaves` names it.
- **Redeploy, same value.** SSM `Value` is readable, so there is no update:
  AWS's `LastModifiedDate` is unchanged across the redeploy. This fails if the
  readback is skipped, because the resource would update every deploy. The
  `TopicName` is not replaced: the topic ARN is unchanged.
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
   record is kept, and `destroy` exits non-zero). The alternative
   re-resolves the address from today's template, but a changed parameter
   would then address the wrong record, and a "not found" reads as already
   deleted.
4. **Noncurrent S3 versions of `state.json` holding the old plaintext after
   migration.** **Recommended: do not purge.** Those versions are the state
   recovery path, and the scrub docs already say a value ever stored in the
   clear must be rotated. The alternative purges them per migrated key, with
   the noncurrent-version purge `src/state/s3-noncurrent-version-purge.ts`
   already implements.

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
