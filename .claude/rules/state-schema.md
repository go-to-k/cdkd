---
description: cdkd S3 state schema - StackState v1-v12 and per-field semantics
paths:
  - 'src/state/**'
  - 'src/types/state.ts'
---

# State Schema

The S3 state record is the user contract: **migration must be transparent** — a reader tolerates every older shape and the user does nothing on upgrade.

```typescript
interface StackState {
  // bumps: 2 region-prefixed key, 3 observedProperties, 4 imports, 5 deletion/updateReplace policy, 6 parent* (nested stacks), 7 provisionedBy, 8 outputReads, 9 exportNames, 10 observedBaselineRefused, 11 noEchoLeaves/noEchoAttributeNames, 12 referenceProvenance
  version: 1 | 2 | ... | 12;
  stackName: string;
  region?: string;      // required on v2+ (the S3 key); on READ the KEY wins and a disagreeing body warns
  resources: Record<string, ResourceState>;
  outputs: Record<string, unknown>; // resolved Output values — NOT coerced to string
  imports?: StateImportEntry[];   // v4+: Fn::ImportValue refs; drive the destroy-time strong-reference refusal
  outputReads?: StateOutputReadEntry[]; // v8+: Fn::GetStackOutput refs; informational, no destroy refusal
  exportNames?: string[];         // v9+: which `outputs` keys are Export.Name aliases — the ONLY names Fn::ImportValue may bind to; undefined = not known, [] = exports nothing
  skippedOutputs?: Record<string, string>; // no bump
  orphans?: StackOrphanRecord[];  // no bump: rollback-orphaned Retain resources the next deploy re-adopts, carrying the discarded ResourceState verbatim
  conditionVerdicts?: Record<string, { verdict: boolean; fingerprint: string }>; // no bump: deployed verdicts of secret-fed conditions, for `cdkd diff`
  parentStack?: string;           // v6+: nested-stack CHILD records only (undefined = top-level); child key is cdkd/{parentStack}~{parentLogicalId}/{region}/state.json
  parentLogicalId?: string;       // v6+: the child's AWS::CloudFormation::Stack logical id in the parent
  parentRegion?: string;          // v6+: parent's region (equals `region` until cross-region nested stacks ship)
  outputReferenceProvenance?: Record<string, Record<string, ReferenceProvenance>>; // v12+: key -> token
  lastModified: number;
}

interface StateImportEntry {
  sourceStack: string;   // producer stack whose Output was imported
  sourceRegion: string;  // producer's region (load-bearing for state-key lookup)
  exportName: string;    // Export.Name; REDACTED, so it may hold a {{resolve:}} expression
}

interface StateOutputReadEntry {
  sourceStack: string;   // producer stack; REDACTED, so a MATCH on it must handle an expression
  sourceRegion: string;  // producer's region
  outputName: string;    // Outputs.<Name>, NOT Export.Name; REDACTED
}

interface ResourceState {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;          // resolved values cdkd SENT (a narrowed or silently dropped property is absent)
  observedProperties?: Record<string, unknown>; // AWS-current snapshot at deploy time (drift baseline)
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
  acceptedCreateOnlyDrops?: string[];       // no bump: create-only keys in `properties` the SDK route was told to drop (#2790)
  constructPath?: string;                   // no bump: display only; stamped in `redactStateForPersist` on every deploy save (#4607)
  maskedPropertyFingerprints?: Record<string, string>; // no bump: per property held as `***`, sha256 of template text (#4451)
  maskedPropertyInputFingerprints?: Record<string, string>; // no bump: non-secret inputs resolved, bound to that hash (#4543)
}
```

`acceptedCreateOnlyDrops` is EVIDENCE, read only through `acceptedCreateOnlyDropsOf` (malformed = absent = none): the #2790 refusal fires only for a key it names, since an imported or pre-v7 record holds create-only keys AWS does hold. An SDK-route create or replacement rebuilds it, an in-place update only carries entries still in `properties` (`acceptedCreateOnlyDropsField`), Cloud Control clears it, a spreading writer keeps it.

Neither field hashes a secret-derived value (a confirm oracle). The input field is SEPARATE so an older binary (text field only) still sends template edits; an input entry whose `+sha256:` half differs from the text entry is stale and is re-baselined without sending. A template literal equal to a `NoEcho` value or a resolved needle gets `REFUSED_FINGERPRINT` (no hash). Helpers: `src/deployment/masked-property-fingerprints.ts`; the save rebuilds both only for a bag `propertiesToRecord` wrote this deploy; absent keeps the pre-#4451 comparison.

## `exportNames` (v9+)

`outputs` is keyed by output NAME, and an output carrying `Export:` is ADDITIONALLY aliased under its export name in the same bag (`src/deployment/outputs-export-alias.ts`).

Every reader goes through ONE predicate, `importableOutputKeys(state)` (`src/types/state.ts`): `exportNames` intersected with the bag when present, every key when not. The FIELD is the discriminator, not `version`: `undefined` = NOT KNOWN (the legacy rule, so no cross-stack reference breaks on upgrade), `[]` = KNOWN to export nothing. A save that RE-RESOLVES outputs writes the set, `[]` included (unlike `imports` / `outputReads`); one that CARRIES a bag spreads `exportNamesCarriedFrom(previous)`.

## `conditionVerdicts` (no bump)

A deploy's verdict for each condition `cdkd diff` cannot evaluate (its closure reaches a secret-fed parameter). Each entry's `fingerprint` hashes the condition's definitions and the parameter inputs they read, a secret-fed one as its `{{resolve:...}}` expression; the diff reuses the verdict ONLY on an equal fingerprint and otherwise takes FALSE. Writer, reader and the fingerprint's input all live in `src/deployment/condition-verdicts.ts`: change one side there or not at all. Absent or malformed means no record (`readRecordedConditionVerdicts`). A spreading writer may carry it: none changes a definition or an input.

## `outputs`

Values are `unknown`, NOT `string`: a LIST `Fn::GetAtt` persists a JSON **array**; narrow before use. Without `--strict-getatt` an unresolvable output is `undefined`, dropped from the JSON: absence means "not resolved", and a no-change save keeps the old value.

## `deletionPolicy` / `updateReplacePolicy` (v5+)

Recorded so an attribute-only flip diffs as an UPDATE refreshing the record with no provider call.

Destroy reads them through `shouldRetainResource(deletionPolicy)`: `cdkd destroy` takes `state.deletionPolicy ?? template...DeletionPolicy`; template-less `cdkd state destroy` reads state only, so pre-v5 state there deletes every resource.

`Snapshot` is honored outside `shouldRetainResource` by final-snapshot gating at both sites (type sets in `src/provisioning/final-snapshot.ts`, [provider-delete-path.md](provider-delete-path.md)); an uncovered shape is refused, `--skip-final-snapshot` opts out. `UpdateReplacePolicy: Snapshot` is honored on replacement / recreate deletes.

## `provisionedBy` (v7+)

`'sdk'` (direct synchronous SDK calls) or `'cc-api'` (Cloud Control, async polling). An absent field means SDK-managed then, but does NOT pin routing: rule 2 gates on a RECORDED `'cc-api'`, so an absent field re-enters the matrix.

Routing matrix (`ProviderRegistry.getProviderFor`):

1. Custom Resources (`Custom::*`, `AWS::CloudFormation::CustomResource`) -> Custom Resource provider, `'sdk'`.
2. Recorded `'cc-api'` (sticky) -> Cloud Control, UNLESS `wouldReturnToSdkProvider` lets it leave: rules 3-7 decide, flipping to `'sdk'`.
3. SDK Provider, no silent-drop property after the `--allow-unsupported-properties` filter -> SDK Provider.
4. SDK Provider, a silent-drop property NOT in the allow set -> Cloud Control.
5. SDK Provider, every silent-drop property allowed -> SDK Provider (warn).
6. No SDK Provider, Cloud Control supports the type -> Cloud Control.
7. `--allow-unsupported-types` -> Cloud Control.

**Sticky by default**: no SDK Provider backfill moves a `'cc-api'` resource back. Exemptions, `--pin-cc-api`: [provisioning-sticky-routing.md](provisioning-sticky-routing.md). `--recreate-via-cc-api` / `--recreate-via-sdk-provider` migrate by destroy + recreate.

## `outputReads` (v8+)

The `imports` sibling for `Fn::GetStackOutput`: one entry per successful **same-account** resolution (cross-region included, cross-account `RoleArn` reads never), omitted when empty. **Informational only** — no destroy-time refusal. `undefined` reads as "no consumers known".

## `observedBaselineRefused` (v10+)

`cdkd import` DECLINED to capture an `observedProperties` baseline here, so no writer that refreshes observed state (deploy auto-refresh, `state refresh-observed`, `drift --accept` / `--revert`) may synthesize one from `properties`. `undefined` = NOT refused (every pre-v10 record). AUTHORITY: the field's JSDoc in `src/types/state.ts`.

`observedBaselineRefusalReason` (no bump, #3462) never appears without the marker. `'unverifiable-parameter'`: the resource depends on a parameter not provably deployed at the `Default` both `cdkd import` and `cdkd deploy` bind, so the in-place UPDATE rebuild in `updateInPlace` carries both fields and takes NO readback, whatever changed. Only a replacement / CREATE clears them, a re-import that HAD a deployed-parameter source ARM 4 did not name, or `state refresh-observed --accept-refused` judged against `--template` (#3466); `buildStackState` carries both across a re-import on an unchanged physical id. Other arms record `'incomplete-resolution'`. ABSENT (an older binary's, #3468) is read FAIL CLOSED through `resourcesNamingDeclaredParameter` (`src/analyzer/parameter-dependence.ts`, "yes" on an unreadable template): `stampReasonlessParameterRefusals` stamps it at deploy start, before any readback, `buildStackState` carries it; a definition naming no declared parameter clears on UPDATE. "Is a baseline refused?" tests the marker alone; the pair goes through `hasUnverifiableParameterRefusal`, a template-less REMEDY through `refusedBaselineRemedy` (#3465).

## `noEchoLeaves` / `noEchoAttributeNames` (v11+)

Written at every deploy save by `applyNoEchoPersist` (`src/deployment/deploy-engine/noecho.ts`); coordinates are segment arrays, never a value. A record the deploy WROTE is recomputed, one it did not keeps its field plus witness-confirmed leaves (#4831), one with NONE (pre-v11) takes today's template positions. A non-mask stored leaf where today masks is the MIGRATION WITNESS (`witnessNormalize`): `version` certifies no redaction. `noEchoAttributeNames` comes from the DECLARATION (never which attributes hold `***`), unioned with earlier still-masked names. Spreading writers carry both. `noEchoExactEchoLeaves` (#4656) is echo behaviour: set only by a readback handed `***` there, never cleared by `differs`, kept while in `noEchoLeaves`; reset by a create-only replacement, dropped on an update's fallback.

## `referenceProvenance` / `outputReferenceProvenance` (v12+)

Per `{{resolve:` token: region, version ids (never a value), READ-route `readVersions`. Absent = not known (readers keep the v11 path), `{}` = known. Read via `reference-provenance-record.ts` only (malformed = absent). Read (#4847) by `recorded-reference-routes.ts` (a pinned plaintext is never `recordResolvedPair`ed) and `resolverForRecordedRegion`. A record WRITTEN this run takes this pass's entries (in place, a create-only token unions previous `versions`, cap 8); an unwritten one keeps its field unwalked (`perResourceSecrets` outlives skips). v11 records gain it once via `provenance-capture.ts` (sends nothing). Token-free: O(1), `token-free-state.ts`.

## `observedProperties` (v3+)

Set on each create / update by a fire-and-forget `readCurrentState`, drained before the final save; `cdkd import` sets it synchronously. Drift compares it, else `properties`. `--no-capture-observed-state` disables the capture.

## Rollback journal (NOT part of the state schema)

`rollback-journal.json` is a **sibling** of `state.json` under the same key prefix with its own `journalVersion`. Written when a deploy ends without a completed rollback (`--no-rollback` failure, SIGINT, before an automatic rollback): one `segment` per failed attempt, a verbatim `CompletedOperation[]` (UPDATE ops carry the ADDITIVE `previousResourceType`, #2668) plus ADDITIVE `failedOperations` (each failed op's `previousState`, resolved `attemptedProperties`), and a provider-proven CREATE orphan's `physicalIdRecoveredFromError` + `deletionPolicy` (#1710) (no bump; an older classifier skips the op). `cdkd rollback` consumes it, `--revert-failed` replays `failedOperations`; it is popped per replayed segment and deleted on the next successful deploy (kept reduced while an orphan delete fails, #4600), clean rollback or destroy. A NESTED child's success instead APPENDS a `nested-pending-parent` segment (ADDITIVE reason and `previousOutputs`, no bump) that its parent's revert replays by `runId`; the ROOT's success deletes every descendant journal (#3754). Unknown `journalVersion`: error.

**Secret redaction.** Its `properties` / `attemptedProperties` / `previousState` take the SAME redaction as `state.json` (a public `String` / `StringList` ssm value stays resolved). The replay RE-RESOLVES them before `create()` / `update()` (the token would corrupt the resource) and re-redacts the rebuilt record.
