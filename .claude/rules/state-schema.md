---
description: cdkd S3 state schema - StackState v1-v11 and per-field semantics
paths:
  - 'src/state/**'
  - 'src/types/state.ts'
---

# State Schema

The S3 state record is the user contract: **migration must be transparent** — a reader tolerates every older shape and the user does nothing on upgrade.

```typescript
interface StackState {
  // bumps: 2 region-prefixed key, 3 observedProperties, 4 imports, 5 deletion/updateReplace policy, 6 parent* (nested stacks), 7 provisionedBy, 8 outputReads, 9 exportNames, 10 observedBaselineRefused, 11 noEchoLeaves/noEchoAttributeNames
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
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

Every reader goes through ONE predicate, `importableOutputKeys(state)` in `src/types/state.ts`: `exportNames` intersected with the bag when the record carries it, every key when it does not. The discriminator is the FIELD, not `version` — `undefined` means NOT KNOWN and keeps the legacy rule so no cross-stack reference breaks on upgrade; `[]` means KNOWN to export nothing. A save that RE-RESOLVES outputs writes the set, `[]` included — unlike `imports` / `outputReads`, an empty array is NOT omitted. A save that CARRIES a bag forward spreads `exportNamesCarriedFrom(previous)`.

## `conditionVerdicts` (no bump)

The verdict a deploy computed for each condition `cdkd diff` reads but cannot evaluate, because its closure reaches a secret-fed parameter. Each entry's `fingerprint` hashes the condition's definitions and the parameter inputs they read, a secret-fed one as its `{{resolve:...}}` expression; the diff reuses the verdict ONLY on an equal fingerprint and otherwise takes FALSE. Writer, reader and the fingerprint's input all live in `src/deployment/condition-verdicts.ts`: change one side there or not at all. Absent or malformed means no record (`readRecordedConditionVerdicts`). A spreading writer may carry it: none changes a definition or an input.

## `outputs`

Values are `unknown`, NOT `string`: a LIST `Fn::GetAtt` persists a JSON **array**; narrow before use. Without `--strict-getatt` an unresolvable output is stored as `undefined` and drops out of the JSON, so absence means "not resolved" and a no-change save keeps its old value.

## `deletionPolicy` / `updateReplacePolicy` (v5+)

Recorded at deploy time so an attribute-only flip diffs as an UPDATE that refreshes the record without calling a provider.

Destroy reads them through `shouldRetainResource(deletionPolicy)`: `cdkd destroy` takes `state.deletionPolicy ?? template...DeletionPolicy`; template-less `cdkd state destroy` reads state only, so pre-v5 state there deletes every resource.

`Snapshot` is honored outside `shouldRetainResource` by final-snapshot gating at both sites (type sets in `src/provisioning/final-snapshot.ts`, [provider-delete-path.md](provider-delete-path.md)); an uncovered shape is refused, `--skip-final-snapshot` opts out. `UpdateReplacePolicy: Snapshot` is honored on replacement / recreate deletes.

## `provisionedBy` (v7+)

`'sdk'` (direct synchronous SDK calls) or `'cc-api'` (Cloud Control, async polling). An absent field means SDK-managed then, but does NOT pin routing: rule 2 gates on a RECORDED `'cc-api'`, so an absent field re-enters the matrix.

Routing matrix (`ProviderRegistry.getProviderFor`):

1. Custom Resources (`Custom::*`, `AWS::CloudFormation::CustomResource`) -> Custom Resource provider, recorded `'sdk'`.
2. Recorded `'cc-api'` (sticky) -> Cloud Control, UNLESS `wouldReturnToSdkProvider` says it may leave, in which case rules 3-7 decide and it flips to `'sdk'`.
3. SDK Provider registered, no silent-drop properties after the `--allow-unsupported-properties` filter -> SDK Provider.
4. SDK Provider registered, a silent-drop property NOT in the allow set -> Cloud Control.
5. SDK Provider registered, every silent-drop property in it -> SDK Provider (warn).
6. No SDK Provider, Cloud Control supports the type -> Cloud Control.
7. `--allow-unsupported-types` -> Cloud Control.

The field is **sticky by default**: an SDK Provider backfill does not migrate a `'cc-api'` resource back. Exemptions and `--pin-cc-api`: [provisioning-sticky-routing.md](provisioning-sticky-routing.md). User-initiated migration is `--recreate-via-cc-api` / `--recreate-via-sdk-provider` (destroy + recreate).

## `outputReads` (v8+)

The `imports` sibling for `Fn::GetStackOutput`: one entry per successful **same-account** resolution (cross-region included, cross-account `RoleArn` reads never), omitted when empty. **Informational only** — no destroy-time refusal. `undefined` reads as "no consumers known".

## `observedBaselineRefused` (v10+)

`cdkd import` DECLINED to capture an `observedProperties` baseline here, so no writer that refreshes observed state (deploy auto-refresh, `state refresh-observed`, `drift --accept` / `--revert`) may synthesize one from `properties`. `undefined` = NOT refused (every pre-v10 record). AUTHORITY: the field's JSDoc in `src/types/state.ts`.

`observedBaselineRefusalReason` (optional, no bump, [#3462](https://github.com/go-to-k/cdkd/issues/3462)) is never present without the marker. `'unverifiable-parameter'` means the resource depends on a template parameter not provably deployed at the `Default` both `cdkd import` and `cdkd deploy` bind, so a deploy holds no more evidence than the import did: the in-place UPDATE rebuild in `updateInPlace` carries both fields and takes NO readback, whatever changed. Only a replacement / CREATE clears them, or an import that re-imported the row while it HAD a deployed-parameter source and ARM 4 did not name it; `buildStackState` carries both across a re-import on an unchanged physical id. Every writer records a reason (`'incomplete-resolution'` for the other arms; no reader branches on it). ABSENT means an older binary's record of unknown class ([#3468](https://github.com/go-to-k/cdkd/issues/3468)) and is read FAIL CLOSED through `resourcesNamingDeclaredParameter` (`src/analyzer/parameter-dependence.ts`, "yes" on an unreadable template): `stampReasonlessParameterRefusals` stamps it at deploy start, before any readback, and `buildStackState` carries it; a definition naming no declared parameter clears on UPDATE as before. Readers asking "is a baseline refused?" test the marker alone; the pair goes through `hasUnverifiableParameterRefusal`, a template-less REMEDY through `refusedBaselineRemedy` (#3465).

## `noEchoLeaves` / `noEchoAttributeNames` (v11+)

Written at every deploy save by `applyNoEchoPersist` (`src/deployment/deploy-engine/noecho.ts`); coordinates are segment arrays, never a value. A record the deploy WROTE is recomputed, one it did not keeps its field, one with NONE (pre-v11) takes today's template positions. ABSENT = not known: a non-mask stored leaf there is the MIGRATION WITNESS (`witnessNormalize`), so `version` never certifies redaction. `noEchoAttributeNames` comes from the DECLARATION, never from which attributes hold `***`, unioned with earlier names still masked. Spreading writers carry both. `noEchoExactEchoLeaves` (#4656) is echo behaviour, never value: set only by a readback handed `***` there, never cleared by `differs`, kept while in `noEchoLeaves`, reset by a create or replacement.

## `observedProperties` (v3+)

Populated on each successful create / update by a fire-and-forget `provider.readCurrentState`, the in-flight set drained just before the final save so the critical path does not block; `cdkd import` populates it synchronously. The drift comparator prefers it, falling back to `properties` when it is `undefined`. `--no-capture-observed-state` disables the capture.

## Rollback journal (NOT part of the state schema)

`rollback-journal.json` is a **sibling** of `state.json` under the same key prefix with its own `journalVersion` (from `1`). The engine writes it whenever a deploy ends without a completed rollback (`--no-rollback` failure, SIGINT, or before an automatic rollback): one `segment` per failed attempt, a verbatim `CompletedOperation[]` (UPDATE ops carry the ADDITIVE `previousResourceType`, [#2668](https://github.com/go-to-k/cdkd/issues/2668)) plus an ADDITIVE optional `failedOperations` list with each failed op's `previousState` and resolved `attemptedProperties`, and a provider-proven CREATE orphan's `physicalIdRecoveredFromError` + `deletionPolicy` ([#1710](https://github.com/go-to-k/cdkd/issues/1710)) (no bump; an older binary's classifier skips the op). `cdkd rollback` consumes it, `--revert-failed` replays `failedOperations`; it is popped per replayed segment and deleted on the next successful deploy (kept reduced while an orphan delete fails, #4600), clean rollback or destroy. A NESTED child's success instead APPENDS a `nested-pending-parent` segment (ADDITIVE reason and `previousOutputs`, no bump) that its parent's revert replays by `runId`; the ROOT's success deletes every descendant journal ([#3754](https://github.com/go-to-k/cdkd/issues/3754)). An unknown `journalVersion` is a hard error.

**Secret redaction.** The persisted operations carry `properties` / `attemptedProperties` / `previousState`, run through the SAME secret-dynamic-reference redaction as `state.json` before writing: every `{{resolve:secretsmanager:...}}`, plus a `{{resolve:ssm:...}}` of a `SecureString` (a `String` / `StringList` stays resolved). The replay executor RE-RESOLVES them before `create()` / `update()` (the literal token would corrupt the resource) and re-redacts the rebuilt record.
