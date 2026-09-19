---
description: cdkd S3 state schema - StackState v1-v10 and per-field semantics
paths:
  - 'src/state/**'
  - 'src/types/state.ts'
---

# State Schema

The S3 state record is the user contract: **migration must be transparent** — a reader tolerates every older shape and the user does nothing on upgrade.

```typescript
interface StackState {
  // bumps: 2 region-prefixed key, 3 observedProperties, 4 imports, 5 deletion/updateReplace policy, 6 parent* (nested stacks), 7 provisionedBy, 8 outputReads, 9 exportNames, 10 observedBaselineRefused
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  stackName: string;
  region?: string;      // required on v2+ (the S3 key); on READ the KEY wins and a disagreeing body warns
  resources: Record<string, ResourceState>;
  outputs: Record<string, unknown>; // resolved Output values — NOT coerced to string
  imports?: StateImportEntry[];   // v4+: Fn::ImportValue refs; drive the destroy-time strong-reference refusal
  outputReads?: StateOutputReadEntry[]; // v8+: Fn::GetStackOutput refs; informational, no destroy refusal
  exportNames?: string[];         // v9+: which `outputs` keys are Export.Name aliases — the ONLY names Fn::ImportValue may bind to; undefined = not known, [] = exports nothing
  skippedOutputs?: Record<string, string>; // no bump
  orphans?: StackOrphanRecord[];  // no bump: rollback-orphaned Retain resources the next deploy re-adopts, carrying the discarded ResourceState verbatim
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
}
```

## `exportNames` (v9+)

`outputs` is keyed by output NAME, and an output carrying `Export:` is ADDITIONALLY aliased under its export name in the same bag (`src/deployment/outputs-export-alias.ts`) — so before v9 nothing said which keys were exports.

Every reader goes through ONE predicate, `importableOutputKeys(state)` in `src/types/state.ts`: `exportNames` intersected with the bag when the record carries it, every key when it does not. The discriminator is the FIELD, not `version` — `undefined` means NOT KNOWN and keeps the legacy rule so no cross-stack reference breaks on upgrade; `[]` means KNOWN to export nothing. A save that RE-RESOLVES outputs writes the set, `[]` included — unlike `imports` / `outputReads`, an empty array is NOT omitted. A save that CARRIES a bag forward spreads `exportNamesCarriedFrom(previous)`.

## `outputs`

Values are `unknown`, NOT `string`: `resolveOutputs` persists whatever the intrinsic resolver produced, so an `Fn::GetAtt` CloudFormation defines as a LIST persists a JSON **array**. Narrow before use; a type or doc spelling this `Record<string, string>` is wrong. An unresolvable output is stored as `undefined` and drops out of the JSON, so absence means "not resolved" and a no-change save keeps its old value.

## `deletionPolicy` / `updateReplacePolicy` (v5+)

The CFn template attributes recorded at deploy time, so the next `deploy` / `diff` detects attribute-only flips that have no AWS API impact: `DiffCalculator` walks both, an UPDATE fires when only they change, and the engine refreshes the record without calling a provider.

Destroy paths read them through `shouldRetainResource(deletionPolicy)`. `cdkd destroy` uses `state.deletionPolicy ?? template.Resources[<id>].DeletionPolicy`, so state wins and the template is a fallback; `cdkd state destroy` is template-less and reads state only, so pre-v5 state there deletes every resource until a redeploy populates it.

`Snapshot` is honored outside `shouldRetainResource` (which covers only the Retain variants), by final-snapshot gating at those two sites: the type sets are in `src/provisioning/final-snapshot.ts` (see [provider-delete-path.md](provider-delete-path.md)), a shape neither covers is refused, and `--skip-final-snapshot` is the opt-out. `UpdateReplacePolicy: Snapshot` is honored on the engine's replacement / recreate deletes.

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

The `imports` sibling for the weak-reference `Fn::GetStackOutput`: one entry per successful **same-account** resolution, omitted from JSON when empty. Unlike `imports` it is **informational only** — no destroy-time refusal, so the producer stays deletable independently of consumers. Cross-account `RoleArn` reads push NO entries (a match key would need a `sourceAccountId`); same-account cross-region reads ARE recorded. `undefined` reads as "no consumers known".

## `observedBaselineRefused` (v10+)

`cdkd import` DECLINED to capture an `observedProperties` baseline here, so no writer that refreshes observed state (deploy auto-refresh, `state refresh-observed`, `drift --accept` / `--revert`) may synthesize one from `properties`. `undefined` means NOT refused, which is every pre-v10 record and what those writers already assumed, so v9 -> v10 needs no migration code. The AUTHORITY is the field's JSDoc in `src/types/state.ts`.

## `observedProperties` (v3+)

Populated on each successful create / update by a fire-and-forget `provider.readCurrentState`, the in-flight set drained just before the final save so the critical path does not block; `cdkd import` populates it synchronously, so the first `cdkd drift` has a real baseline rather than template intent. It is the drift comparator's preferred baseline; an older record, or a provider without `readCurrentState`, leaves it `undefined` and the comparator falls back to `properties`. `--no-capture-observed-state` disables the capture.

## Rollback journal (NOT part of the state schema)

`rollback-journal.json` is a **sibling** of `state.json` under the same key prefix and carries its own `journalVersion` (from `1`), so old binaries reading state are unaffected. The engine writes it whenever a deploy ends without a completed rollback (`--no-rollback` failure, SIGINT, or before an automatic rollback), holding one `segment` per failed attempt: a verbatim `CompletedOperation[]`, (each UPDATE op carrying the ADDITIVE `previousResourceType`, the old half's routing type, [#2668](https://github.com/go-to-k/cdkd/issues/2668)), plus an ADDITIVE optional `failedOperations` list with each failed op's pre-op `previousState` and intrinsic-resolved `attemptedProperties` (no bump; old binaries ignore it). `cdkd rollback` consumes it, `--revert-failed` replays `failedOperations`, and it is segment-popped per replayed segment and deleted on the next successful deploy, clean rollback or destroy. An unknown `journalVersion` is a hard error asking the user to upgrade.

**Secret redaction.** The persisted operations carry `properties` / `attemptedProperties` / `previousState`, which the engine runs through the SAME secret-dynamic-reference redaction as `state.json` before writing: every `{{resolve:secretsmanager:...}}`, plus a `{{resolve:ssm:...}}` whose parameter is a `SecureString` (a `String` / `StringList` one is public config and stays resolved). The replay executor RE-RESOLVES those expressions before `create()` / `update()` — the literal token would corrupt the resource — and re-redacts the rebuilt record.
