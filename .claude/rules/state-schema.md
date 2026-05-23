---
description: cdkd S3 state schema (StackState v1-v5 interface, observedProperties / deletionPolicy semantics)
paths:
  - 'src/state/**'
  - 'src/types/state.ts'
---

# State Schema

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5; // 1 = legacy, 2 = region-prefixed, 3 = +observedProperties, 4 = +imports[], 5 = +deletionPolicy/updateReplacePolicy
  stackName: string;
  region?: string;      // Required on version >= 2 (load-bearing for the S3 key)
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  imports?: StateImportEntry[]; // v4+: Fn::ImportValue refs recorded for strong-reference destroy refusal
  lastModified: number;
}

interface StateImportEntry {
  sourceStack: string;   // The producer stack whose Output was imported
  sourceRegion: string;  // The producer's region (load-bearing for state-key lookup)
  exportName: string;    // The CloudFormation Output's Export.Name
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
