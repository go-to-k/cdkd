---
description: cdkd S3 state schema (StackState v1-v8 interface, observedProperties / deletionPolicy / parentStack / provisionedBy / outputReads semantics)
paths:
  - 'src/state/**'
  - 'src/types/state.ts'
---

# State Schema

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties, 4 = +imports[], 5 = +deletionPolicy/updateReplacePolicy, 6 = +parentStack/parentLogicalId/parentRegion (nested-stack adoption), 7 = +provisionedBy on ResourceState (CC API greenfield fallback, #614), 8 = +outputReads[] (Fn::GetStackOutput downstream-consumer enumeration, #668)
  stackName: string;
  region?: string;      // Required on version >= 2 (load-bearing for the S3 key)
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  imports?: StateImportEntry[]; // v4+: Fn::ImportValue refs recorded for strong-reference destroy refusal
  outputReads?: StateOutputReadEntry[]; // v8+: Fn::GetStackOutput refs (informational; NO destroy-time refusal — weak reference by design)
  parentStack?: string;        // v6+: populated on nested-stack child state records (undefined on top-level)
  parentLogicalId?: string;    // v6+: child's AWS::CloudFormation::Stack logical id in the parent's template
  parentRegion?: string;       // v6+: parent's region (always equals `region` until cross-region nested stacks ship)
  lastModified: number;
}

interface StateImportEntry {
  sourceStack: string;   // The producer stack whose Output was imported
  sourceRegion: string;  // The producer's region (load-bearing for state-key lookup)
  exportName: string;    // The CloudFormation Output's Export.Name
}

interface StateOutputReadEntry {
  sourceStack: string;   // The producer stack whose Output was read via Fn::GetStackOutput
  sourceRegion: string;  // The producer's region (load-bearing for state-key lookup)
  outputName: string;    // The producer's template Outputs.<Name> (NOT Export.Name — Fn::GetStackOutput does not require an Export)
}

interface ResourceState {
  physicalId: string;                       // AWS physical ID
  resourceType: string;                     // e.g., "AWS::S3::Bucket"
  properties: Record<string, any>;          // Resolved template intent (what cdkd was asked to deploy)
  observedProperties?: Record<string, any>; // AWS-current snapshot at deploy time (drift baseline)
  attributes: Record<string, any>;          // For Fn::GetAtt resolution
  dependencies: string[];                   // For proper deletion order
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'; // v5+: template attribute recorded at deploy time
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'; // v5+: template attribute recorded at deploy time
  provisionedBy?: 'sdk' | 'cc-api';         // v7+: which provisioning layer owns this resource (absent = SDK legacy default)
}
```

**`deletionPolicy` / `updateReplacePolicy`** (schema v5+) are the CFn template
attributes recorded at deploy time so the next `cdkd deploy` / `cdkd diff` can
detect attribute-only flips that have no AWS API impact but still matter to
cdkd's destroy-time `DeletionPolicy: Retain` skip (and to anyone reading the
diff). Pre-v5, removing `removalPolicy: RemovalPolicy.DESTROY` from a CDK
construct (= `DeletionPolicy` flips from `Delete` to `Retain` in the synth
template) silently surfaced as `No changes detected` because `DiffCalculator`
only compared `Properties`. v5 widens the diff comparator to walk these two
attribute fields too; the UPDATE classification still fires when only these
change, and the deploy engine refreshes the cdkd state record without
calling any provider (there is no per-resource AWS API for either attribute).
The destroy paths consume the recorded value through the shared
`shouldRetainResource(deletionPolicy)` helper in `src/types/state.ts`:
`cdkd destroy` (synth-driven, `DeployEngine` DELETE branch) uses
`state.deletionPolicy ?? template.Resources[<id>].DeletionPolicy` so state
wins and the template stays a back-compat fallback; `cdkd state destroy`
(template-less, `destroy-runner.ts`) reads `state.deletionPolicy` only —
pre-v5 state on `cdkd state destroy` therefore stays at the pre-fix
"delete every resource in state" behavior until a redeploy under v5
populates the field.

**`provisionedBy`** (schema v7+, issue
[#614](https://github.com/go-to-k/cdkd/issues/614)) is the per-resource
provisioning-layer label: `'sdk'` (cdkd's preferred fast path, direct
synchronous AWS SDK calls per resource type) or `'cc-api'` (the Cloud
Control API fallback path, async polling create/update/delete via the
unified CloudControlClient). Pre-#614 every resource was implicitly
SDK-managed; the absent / `undefined` field on v6-and-earlier state
records is treated by the v7 binary as "legacy SDK" (matches pre-#614
behavior). v7 writers always emit the field explicitly so the routing
decision is durable across deploys.

Routing decision matrix (`ProviderRegistry.getProviderFor`, called by
the deploy / drift / destroy / state-show paths):

1. Custom Resources (`Custom::*` / `AWS::CloudFormation::CustomResource`)
   → Custom Resource provider, recorded as `'sdk'`.
2. Existing-state `provisionedBy: 'cc-api'` (sticky) → Cloud Control.
3. SDK Provider registered AND no silent-drop properties (after
   `--allow-unsupported-properties` filter) → SDK Provider.
4. SDK Provider registered AND template uses silent-drop properties
   NOT covered by the allow set → Cloud Control (auto-route, info log).
5. SDK Provider registered AND every silent-drop property IS in the
   allow set → SDK Provider (the user explicitly accepted the silent
   drop, warn log).
6. No SDK Provider AND Cloud Control supports the type → Cloud Control.
7. `--allow-unsupported-types` escape hatch → Cloud Control optimistically.

The field is **sticky**: once a resource is `'cc-api'`, subsequent SDK
Provider backfills (issue #609) do NOT auto-migrate it back. Avoids
physical-ID churn + destroy + recreate cycles on every backfill
release. User-initiated CC → SDK migration lives under #615 (or a
future counterpart). `cdkd destroy` consults the field to pick the
delete path; `cdkd drift` consults it to pick `readCurrentState`;
`cdkd state show` displays `ProvisionedBy: sdk | cc-api | (sdk, legacy default)`
for the absent-field case so users can audit the routing.

**`parentStack` / `parentLogicalId` / `parentRegion`** (schema v6+, issue
[#459](https://github.com/go-to-k/cdkd/issues/459)) are populated on
**nested-stack child state records only** (`AWS::CloudFormation::Stack` →
recursive deploy via `NestedStackProvider`). Top-level stack state files
leave all three undefined and a v6 reader treats absence as "I am a
top-level stack", which is the correct semantics for every state file
written before nested-stack support shipped (= every state file v1..v5
binaries wrote). The child's S3 key uses
`cdkd/{parentStack}~{parentLogicalId}/{region}/state.json` (the `~`
separator avoids ambiguity with CDK Stage's `/`). Recorded so:
(a) `cdkd state list` / `state show` can surface the parent → child
tree, (b) `cdkd destroy <child-only>` can reject with a pointer at the
parent (mirrors CFn's "cannot directly destroy a nested stack" semantic),
(c) a future cross-region nested-stack capability doesn't require
another schema bump (the explicit `parentRegion` field is there now,
even though v1 of the feature always inherits the parent's region —
AWS does not support cross-region nested stacks today). v5 readers see
v6 state as `version: 6` and fail with the existing "Upgrade cdkd"
error; v6 readers tolerate missing fields and degrade to the
top-level-stack default. The v6 prep PR added the type bump alone —
the `NestedStackProvider` that populates these fields lands in the
follow-up.

**`outputReads`** (schema v8+, issue
[#668](https://github.com/go-to-k/cdkd/issues/668)) is the sibling of
`imports` for the weak-reference `Fn::GetStackOutput` intrinsic. The
deploy-side intrinsic resolver pushes one `StateOutputReadEntry` per
successful **same-account** resolution into the consumer's bag, and
the deploy engine persists the bag to `state.outputReads` at save
time (omitted from JSON when empty so the on-the-wire shape stays
identical to v7 for no-`Fn::GetStackOutput` stacks). Consumed by
`findDownstreamConsumers` (in `src/cli/commands/recreate-downstream-consumers.ts`)
to name `Fn::GetStackOutput` consumers in the `--recreate-via-cc-api` /
`--recreate-via-sdk-provider` warn block — alongside the existing v4
`imports[]` walk for `Fn::ImportValue` consumers.

Unlike `imports`, `outputReads` is **informational only**: there is
NO destroy-time refusal for `Fn::GetStackOutput` references. The
producer stays deletable independently of consumers (the intrinsic
is a weak reference by design — see `IntrinsicFunctionResolver`'s
`resolveGetStackOutput` JSDoc).

Cross-account `RoleArn`-based `Fn::GetStackOutput` reads do NOT
push entries here in v8 — the resolver intentionally skips recording
in the cross-account branch because a `sourceAccountId` field would
be required for unambiguous match keys, deferred to a future bump.
Same-account cross-region reads ARE recorded (the consumer's region
is independent of the producer's, and `state.outputReads[].sourceRegion`
captures the producer's region).

Pre-v8 state with `outputReads === undefined` is treated by v8 readers
as "no GetStackOutput consumers known" — `findDownstreamConsumers`
degrades to imports-only enumeration, matching the v4-shipped
behavior. The next deploy under the v8 binary repopulates the field.

**`observedProperties`** is populated on each successful create / update by
calling `provider.readCurrentState` fire-and-forget after the resource flips
to its new state. The deploy critical path does NOT block on these — the
in-flight set is drained right before the final state save so the cost is
~`max(per-resource readCurrentState latency)` ≈ 200-300ms in practice.
`cdkd import` populates the same field synchronously (parallel
`Promise.all` over the imported set) right before the state write, so the
very first `cdkd drift` after adoption has a real AWS-current baseline
instead of the user's template intent. The field is the drift
comparator's preferred baseline; resources written by an older binary or
by a provider without `readCurrentState` keep `observedProperties:
undefined` and the comparator falls back to `properties` (the pre-v3
behavior). Pass `--no-capture-observed-state` (or set `cdk.json
context.cdkd.captureObservedState: false`) to disable the deploy-time
capture and regain the pre-v3 deploy time at the cost of weaker drift
detection.

## Rollback journal (NOT part of the state schema)

The `rollback-journal.json` object (issue
[#1183](https://github.com/go-to-k/cdkd/issues/1183)) is a **sibling** of
`state.json` at `s3://bucket/cdkd/{stackName}/{region}/rollback-journal.json`,
NOT a field inside `StackState`. It carries its own `journalVersion` (starting
at `1`), independent of `StackState.version` — a schema bump is deliberately
avoided so old binaries reading state are unaffected and the
`integ-schema-migration` gate is not triggered. It is written by the deploy
engine whenever a deploy ends without a completed rollback (a `--no-rollback`
failure, a SIGINT interruption, or before an automatic rollback), holds one
`segment` per failed deploy attempt (each a verbatim `CompletedOperation[]`),
and is consumed by the standalone `cdkd rollback` command. Lifecycle: created
on failure, segment-popped per replayed segment, deleted on the next
successful deploy / a clean rollback / `cdkd destroy` / `cdkd state destroy`
(the last two via `S3StateBackend.deleteState`, which sweeps the journal key).
An unknown `journalVersion` on read is a hard error asking the user to upgrade
cdkd (forward-compat guard, mirrors the state-schema handling). Types live in
`src/types/rollback-journal.ts`; the replay executor in
`src/deployment/rollback-executor.ts` (shared with the engine's in-process
automatic rollback).
