---
description: cdkd S3 state schema - StackState v1-v15 and per-field semantics
paths:
  - 'src/state/**'
  - 'src/types/state.ts'
---

# State Schema

The S3 state record is the user contract: **migration must be transparent** — a reader tolerates every older shape and the user does nothing on upgrade.

```typescript
interface StackState {
  version: 1 | 2 | ... | 15;      // each bump is its fields' `vN+`
  stackName: string;
  region?: string;      // required on v2+ (the S3 key); on READ the KEY wins and a disagreeing body warns
  resources: Record<string, ResourceState>;
  outputs: Record<string, unknown>; // see `outputs` below
  imports?: StateImportEntry[];   // v4+: Fn::ImportValue refs; block the producer's destroy
  outputReads?: StateOutputReadEntry[]; // v8+: Fn::GetStackOutput refs; see below
  exportNames?: string[];         // v9+: see below
  skippedOutputs?: Record<string, string>; // no bump
  orphans?: StackOrphanRecord[];  // no bump: rollback-orphaned Retain resources (the discarded ResourceState verbatim); re-adopted on legacy stacks only
  supersededResources?: SupersededResourceRecord[]; // no bump: a replacement's old resource whose delete was deferred (its ResourceState verbatim, scrubbed as orphans are); retried by every deploy's cleanup, deleted by destroy, dropped once a record holds its id (#5111)
  conditionVerdicts?: Record<string, { verdict: boolean; fingerprint: string }>; // no bump: see below
  parentStack?: string;           // v6+: nested-stack CHILD records only (undefined = top-level); child key is cdkd/{parentStack}~{parentLogicalId}/{region}/state.json
  parentLogicalId?: string;       // v6+: the child's AWS::CloudFormation::Stack logical id in the parent
  parentRegion?: string;          // v6+: = `region`
  outputReferenceProvenance?: Record<string, Record<string, ReferenceProvenance>>; // v12+: key -> token
  stackInstanceId?: string;       // v13+: this lifetime's id; absent = legacy, forever
  retiredNameGenerations?: Record<string, number>; // v13+: logical id -> generation it left at
  pendingMovesOut?: PendingMoveOut[]; // no bump: an unfinished `cdkd refactor` move out (ids only); deploy/destroy refuse while present (#5212)
  terminationProtection?: true; // no bump: each deploy writes it from synth (root only); destroy / state destroy refuse while present (#5238)
  lastModified: number;
}

// sourceRegion is load-bearing (the producer's state key); REDACTED fields may hold a {{resolve:}} expression a MATCH must handle
interface StateImportEntry { sourceStack: string; sourceRegion: string; exportName: string /* REDACTED */ }
interface StateOutputReadEntry { sourceStack: string /* REDACTED */; sourceRegion: string; outputName: string /* Outputs.<Name>, NOT Export.Name; REDACTED */ }

interface ResourceState {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;          // resolved values cdkd SENT (a narrowed or silently dropped property is absent)
  observedProperties?: Record<string, unknown>; // v3+: AWS-current snapshot (drift baseline)
  attributes?: Record<string, unknown>;         // for Fn::GetAtt resolution
  dependencies?: string[];                      // for deletion order
  metadata?: Record<string, unknown>;
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate';      // v5+
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'; // v5+
  provisionedBy?: 'sdk' | 'cc-api';         // v7+: routing layer (absent = pre-v7 = SDK-managed; NOT pinned — routing re-decides)
  observedBaselineRefused?: true;           // v10+: import refused a baseline; no writer may synthesize one from `properties`
  observedBaselineRefusalReason?: 'unverifiable-parameter' | 'incomplete-resolution'; // no bump: only the first survives an in-place UPDATE
  noEchoLeaves?: (string | number)[][];     // v11+: coordinates in `properties` stored `***` for a NoEcho parameter / declared-NoEcho GetAtt
  noEchoAttributeNames?: string[];          // v11+: own `attributes` declared NoEcho, each stored `***`
  referenceProvenance?: Record<string, ReferenceProvenance>; // v12+: token -> { region?, versions?, readVersions? }
  noEchoExactEchoLeaves?: string[][];       // no bump: `noEchoLeaves` echoed exactly (#4656)
  secretNamedAttributes?: string[];         // no bump: nested-stack row's `Outputs.<Key>` holding a child's secret-derived name (#3869)
  acceptedCreateOnlyDrops?: string[];       // no bump: create-only keys in `properties` the SDK route was told to drop (#2790)
  constructPath?: string;                   // no bump: display only; `redactStateForPersist` stamps it (#4607)
  maskedPropertyFingerprints?: Record<string, string>; // no bump: per property held as `***`, sha256 of template text (#4451)
  maskedPropertyInputFingerprints?: Record<string, string>; // no bump: non-secret inputs resolved, bound to that hash (#4543)
  nameGeneration?: number;                  // v13+: absent = 0
  nameGenerationHigh?: number;              // v13+: set by a rollback
  unsettledProperties?: string[];           // v14+: names a failed update had started changing (#5380)
  unsettledItems?: Record<string, string[]>; // v15+: item names its ACCEPTED calls added, per path under an unsettled name (#5498)
}
```

`acceptedCreateOnlyDrops` is EVIDENCE, read only via `acceptedCreateOnlyDropsOf` (malformed = none): the #2790 refusal fires only for a key it names (an imported or pre-v7 record holds create-only keys AWS holds). A create, replacement or rollback re-create rebuilds it, an in-place update carries what `properties` keeps (`acceptedCreateOnlyDropsEvidence`), CC clears it, other spreading writers keep it.

Neither field hashes a secret-derived value. The input field is SEPARATE so an older binary still sends template edits; an input entry whose `+sha256:` half differs from the text entry is stale and is re-baselined without sending. A template literal equal to a `NoEcho` value or a resolved needle gets `REFUSED_FINGERPRINT` (no hash). Helpers: `src/deployment/masked-property-fingerprints.ts`; the save rebuilds both only for a bag `propertiesToRecord` wrote this deploy; absent keeps the pre-#4451 comparison.

`secretNamedAttributes` (#3869) is PRINT-ONLY attribute KEYS, read by `secretNameNeedlesOf`, rewritten by each create or update of the row; absent = not known.

## `exportNames` (v9+)

`outputs` is keyed by output NAME, and an output carrying `Export:` is ADDITIONALLY aliased under its export name in the same bag (`src/deployment/outputs-export-alias.ts`).

Every reader goes through ONE predicate, `importableOutputKeys(state)` (`src/types/state.ts`): `exportNames` intersected with the bag when present, every key when not. The FIELD is the discriminator, not `version`: `undefined` = NOT KNOWN (the legacy rule), `[]` = KNOWN to export nothing. A save that RE-RESOLVES outputs writes the set, `[]` included (unlike `imports` / `outputReads`); one that CARRIES a bag spreads `exportNamesCarriedFrom(previous)`.

## `stackInstanceId` and name generations (v13+, #5064)

Minted only at a stack's FIRST state write (first deploy: written ahead to the `stack-instance.json` sibling before any create, reused on a re-run; `cdkd import` creating the record). Absent = legacy forever. Writers spread `stackInstanceIdCarriedFrom` (`stack-instance-id-carriers.test.ts`), which carries `retiredNameGenerations` and `supersededResources` too; read via `stackInstanceIdOf`. Never logged.

Id stacks only: the generated-name suffix hashes the generation (`src/state/name-generation.ts`), a pure function of the record: a replacement creates at `nextNameGeneration`, a re-added id at retired + 1. Every path whose record leaves the stack retires its generation (`retiredNameGenerationsAfter` / `retiredAfterRollback`), a rollback's taken-back CREATE included. An id `StackScope` needs `nameGenerationsOf`'s map. Read via `nameGenerationOf` / `retiredNameGenerationsOf` (malformed, or a successor past a safe integer = refuse); writers spread `nameGenerationCarriedFrom` / `nameGenerationField`.

## `conditionVerdicts` (no bump)

A deploy's verdict for each condition `cdkd diff` cannot evaluate (its closure reaches a secret-fed parameter). Each entry's `fingerprint` hashes the condition's definitions and the parameter inputs they read, a secret-fed one as its `{{resolve:...}}` expression; the diff reuses the verdict ONLY on an equal fingerprint, else takes FALSE. Writer, reader and the fingerprint's input live in `src/deployment/condition-verdicts.ts`: change them together. Absent or malformed means no record (`readRecordedConditionVerdicts`). Spreading writers carry it.

## `outputs`

Values are `unknown`, NOT `string`: a LIST `Fn::GetAtt` persists a JSON **array**. Without `--strict-getatt` an unresolvable output is dropped: absence means "not resolved", and a no-change save keeps the old value.

## `deletionPolicy` / `updateReplacePolicy` (v5+)

Recorded so an attribute-only flip diffs as an UPDATE with no provider call.

Destroy reads them through `shouldRetainResource(deletionPolicy)`: `cdkd destroy` takes `state.deletionPolicy ?? template...DeletionPolicy`; template-less `cdkd state destroy` reads state only (pre-v5 state there deletes every resource).

`Snapshot` is honored outside `shouldRetainResource` by final-snapshot gating at both sites (`src/provisioning/final-snapshot.ts`, [provider-delete-path.md](provider-delete-path.md)); an uncovered shape refuses, `--skip-final-snapshot` opts out. `UpdateReplacePolicy: Snapshot` applies to replacement / recreate deletes.

## `provisionedBy` (v7+)

`'sdk'` (synchronous SDK calls) or `'cc-api'` (Cloud Control). Absent means SDK-managed then, but does NOT pin routing: rule 2 gates on a RECORDED `'cc-api'`, so absent re-enters the matrix.

Routing matrix (`ProviderRegistry.getProviderFor`):

1. `Custom::*`, `AWS::CloudFormation::CustomResource` -> Custom Resource provider, `'sdk'`.
2. Recorded `'cc-api'` (sticky) -> Cloud Control, UNLESS `wouldReturnToSdkProvider` lets it leave: rules 3-7 decide, flipping to `'sdk'`.
3. SDK Provider, no silent-drop property after the `--allow-unsupported-properties` filter -> SDK Provider.
4. SDK Provider, a silent-drop property NOT in the allow set -> Cloud Control.
5. SDK Provider, every silent-drop property allowed -> SDK Provider (warn).
6. No SDK Provider, Cloud Control supports the type -> Cloud Control.
7. `--allow-unsupported-types` -> Cloud Control.

**Sticky by default**: no SDK Provider backfill moves a `'cc-api'` resource back. Exemptions, `--pin-cc-api`: [provisioning-sticky-routing.md](provisioning-sticky-routing.md). `--recreate-via-*` migrate by destroy + recreate.

## `outputReads` (v8+)

The `imports` sibling for `Fn::GetStackOutput`: one entry per successful **same-account** resolution (cross-region included, cross-account `RoleArn` never), omitted when empty. **Informational only** — no destroy refusal. `undefined` = "no consumers known".

## `observedBaselineRefused` (v10+)

`cdkd import` DECLINED an `observedProperties` baseline here, so no observed-state writer (deploy auto-refresh, `state refresh-observed`, `drift --accept` / `--revert`) may synthesize one from `properties`. `undefined` = NOT refused. AUTHORITY: the field's JSDoc in `src/types/state.ts`.

`observedBaselineRefusalReason` (no bump, #3462) never appears without the marker. `'unverifiable-parameter'`: the resource depends on a parameter not provably deployed at the `Default` both `cdkd import` and `cdkd deploy` bind, so the in-place UPDATE rebuild in `updateInPlace` carries both fields and takes NO readback, whatever changed. Only a replacement / CREATE clears them, a re-import that HAD a deployed-parameter source ARM 4 did not name, or `state refresh-observed --accept-refused` judged against `--template` (#3466); `buildStackState` carries both across a re-import on an unchanged physical id. Other arms record `'incomplete-resolution'`. ABSENT (an older binary's, #3468) is read FAIL CLOSED through `resourcesNamingDeclaredParameter` (`src/analyzer/parameter-dependence.ts`, "yes" on an unreadable template): `stampReasonlessParameterRefusals` stamps it at deploy start, before any readback, `buildStackState` carries it; a definition naming no declared parameter clears on UPDATE. "Is a baseline refused?" tests the marker alone; the pair goes through `hasUnverifiableParameterRefusal`, a template-less REMEDY through `refusedBaselineRemedy` (#3465).

## `noEchoLeaves` / `noEchoAttributeNames` (v11+)

Written at every deploy save by `applyNoEchoPersist` (`src/deployment/deploy-engine/noecho.ts`); coordinates are segment arrays, never a value. A record the deploy WROTE is recomputed, one it did not keeps its field plus witness-confirmed leaves (#4831), one with NONE (pre-v11) takes today's template positions. A non-mask stored leaf where today masks is the MIGRATION WITNESS (`witnessNormalize`): `version` certifies no redaction. `noEchoAttributeNames` comes from the DECLARATION (never which attributes hold `***`), unioned with earlier still-masked names. Spreading writers carry both. `noEchoExactEchoLeaves` (#4656) is echo behaviour: set only by a readback handed `***` there, never cleared by `differs`, kept while in `noEchoLeaves`; reset by a create-only replacement, dropped on an update's fallback.

## `referenceProvenance` / `outputReferenceProvenance` (v12+)

Per `{{resolve:` token: region, version ids (never a value), READ-route `readVersions` (the upstream record's `versions`). Absent = not known (v11 path), `{}` = known; read via `reference-provenance-record.ts` only (malformed = absent) by `recorded-reference-routes.ts` (#4847; a pinned plaintext is never `recordResolvedPair`ed) and #4852's `read-provenance-promotion.ts` / `read-provenance-moved.ts` (`readVersions` ⊄ upstream `versions`; none = no verdict). A WRITTEN record takes this pass's entries (in place, a create-only token unions previous `versions`, cap 8); an unwritten one keeps its field unwalked (`perResourceSecrets` outlives skips). v11 records gain it once (`provenance-capture.ts`). Token-free: O(1), `token-free-state.ts`.

## `unsettledProperties` (v14+, #5380)

Top-level property NAMES only, read via `unsettledPropertiesOf` (malformed = none). Written only by the deploy's failure path from `UpdateContext.markUnsettled` marks (`execute.ts`), unioned. The next deploy forces each name changed (diff, both no-change skips, `changedProperties`) and hands it as `UpdateContext.unsettledProperties`; the update's rebuilt record clears it, as do `recordAfterRollbackUpdate` (whose two rollback callers pass the names as `unsettledProperties`) and `drift --accept` / `--revert`, which keep a name `ResourceProvider.unsettledInTransition` reports still changing. Spreading writers carry it.

## `unsettledItems` (v15+, #5498)

Per member path (closed vocabulary: `GlobalSecondaryIndexes`, `Tags`, `DesiredShardLevelMetrics`, `Replicas`, `Replicas[<region>].Tags` with the Region checked against AWS's shape), the item names (index name, tag key, metric) a failed update's calls were ACCEPTED for adding: `UpdateContext.markAttempted(path, items)` right after the send resolves, never before it or for a call that throws. Read via `unsettledItemsOf` only, which keeps a path only under a name in `unsettledProperties` (items ⊆ unsettled) and drops an entry over 255 chars, a path over 100 entries, and any malformed field. Written only by `recordUnsettledMarks` (`execute.ts`, unioned via `withUnsettledItems`); a rebuilt record carries only the still-unsettled names' items (`unsettledItemsField`), `withoutUnsettledProperties` strips both fields. The next deploy hands them as `UpdateContext.unsettledItems` and to `readUnsettled`'s 7th parameter: a live item named here EXACTLY joins the previous side, so the template's omission removes it (live ∩ attempted ∖ template). Secret-derived names are rewritten on persist (`scrubResourceRecord` value scan, the `NoEcho` persist arm by value) and by `cdkd scrub`; a name containing `{{resolve:` or `***` never matches (`isUsableAttemptedName`), so its item is kept.

## `observedProperties` (v3+)

Set on each create / update by a fire-and-forget `readCurrentState`, drained before the final save; `cdkd import` sets it synchronously. Drift compares it, else `properties`.

## Rollback journal (NOT part of the state schema)

`rollback-journal.json` is a **sibling** of `state.json` under the same key prefix with its own `journalVersion`. Written when a deploy ends without a completed rollback (`--no-rollback` failure, SIGINT, before an automatic rollback): one `segment` per failed attempt, a verbatim `CompletedOperation[]` (UPDATE ops carry the ADDITIVE `previousResourceType`, #2668, and replacements `nameGeneration`) plus ADDITIVE `failedOperations` (each failed op's `previousState`, resolved `attemptedProperties`), and a provider-proven CREATE orphan's `physicalIdRecoveredFromError` + `deletionPolicy` (#1710) (no bump; an older classifier skips the op). `cdkd rollback` consumes it, `--revert-failed` replays `failedOperations`; it is popped per replayed segment and deleted on the next successful deploy (kept reduced while an orphan delete fails, #4600), clean rollback or destroy. A NESTED child's success instead APPENDS a `nested-pending-parent` segment (ADDITIVE reason and `previousOutputs`, no bump) that its parent's revert replays by `runId`; the ROOT's success deletes every descendant journal (#3754). Unknown `journalVersion`: error.

**Secret redaction.** Its `properties` / `attemptedProperties` / `previousState` take `state.json`'s redaction (a public `String` / `StringList` ssm value stays resolved). The replay RE-RESOLVES them before `create()` / `update()` and re-redacts the rebuilt record.
