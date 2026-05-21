# Cross-Stack References

cdkd supports two cross-stack reference mechanisms with deliberately
different semantics:

| Intrinsic | Strength | Behavior on producer destroy | Use when |
|---|---|---|---|
| `Fn::ImportValue` | **strong** | Refuse with `StackHasActiveImportsError` | You want CloudFormation parity — the producer must be protected as long as consumers reference it |
| `Fn::GetStackOutput` (cdkd-specific) | weak | Proceeds; consumer's next resolve fails | You want the producer to be deletable independently of consumers (cross-region / cross-stage / staging) |

This doc covers the design and implementation of strong-reference
enforcement and the supporting performance optimizations (persistent
exports index). For the user-facing CLI behavior, see [README.md] and
[docs/cli-reference.md](cli-reference.md).

[README.md]: ../README.md

---

## Why strong references

CloudFormation's `Fn::ImportValue` is a strong reference:

```text
$ aws cloudformation delete-stack --stack-name Producer
An error occurred (ValidationError): Export Producer:BucketArn cannot
be deleted as it is in use by stack Consumer.
```

Until [Issue #343], cdkd silently allowed producer destruction even
when consumers referenced its outputs. The consumer's next deploy
would then fail at resolve time with `export 'BucketArn' not found in
any stack`. This violated user expectations and was inconsistent with
CloudFormation's safety model.

[Issue #343]: https://github.com/go-to-k/cdkd/issues/343

cdkd now matches CFn: `cdkd destroy <producer>` refuses with a clear
error that names every consumer still referencing the producer.

### Why no `--force` escape hatch

CloudFormation does not provide one and cdkd intentionally matches
that. If you want a producer that can be destroyed independently of
consumers, use `Fn::GetStackOutput` (cdkd-specific weak reference) at
template-authoring time instead of bolting on an after-the-fact
override. See the "Resolving a refused destroy" section below for the
two valid recovery paths.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  Source of truth: per-stack state.json                       │
│  s3://{bucket}/{prefix}/{stackName}/{region}/state.json      │
│                                                              │
│   {                                                          │
│     "version": 4,                                            │
│     "stackName": "Consumer",                                 │
│     "region": "us-east-1",                                   │
│     "resources": { ... },                                    │
│     "outputs": { "ConsumerEndpoint": "..." },                │
│     "imports": [                                             │
│       { "sourceStack": "Producer",                           │
│         "sourceRegion": "us-east-1",                         │
│         "exportName": "BucketArn" }                          │
│     ],                                                       │
│     "lastModified": 1234567890                               │
│   }                                                          │
└─────────────────────────────────────────────────────────────┘
                          ▲
                          │ (canonical, atomic per-stack writes)
                          │
┌─────────────────────────────────────────────────────────────┐
│  Derived view: per-region exports index                      │
│  s3://{bucket}/{prefix}/_index/{region}/exports.json         │
│                                                              │
│   {                                                          │
│     "indexVersion": 1,                                       │
│     "region": "us-east-1",                                   │
│     "exports": {                                             │
│       "BucketArn": {                                         │
│         "value": "arn:aws:s3:::my-bucket",                   │
│         "producerStack": "Producer",                         │
│         "producerRegion": "us-east-1"                        │
│       }                                                      │
│     },                                                       │
│     "lastModified": 1234567890                               │
│   }                                                          │
└─────────────────────────────────────────────────────────────┘
```

### Roles

- **`state.json` (per-stack)** is the canonical source of truth for
  outputs and imports. Always written / read with optimistic locking.
  Strong-reference safety checks read from here directly.

- **`exports.json` (per-region, index)** is a derived view used only as
  a performance hint for `Fn::ImportValue` resolution. Resolves in O(1)
  per lookup. Rebuildable from state.json at any time.

The asymmetry matches user priorities: deploy speed must be fast
(perf-hot via index), destroy correctness must be safe (canonical scan
without index trust).

### Two consumers of the exports index

| Caller | Trust the index? | Why |
|---|---|---|
| `IntrinsicFunctionResolver.resolveImportValue` | **Yes**, with state.json fallback on miss | Deploy hot path; stale index just degrades to scan-once-and-patch |
| `runDestroyForStack` strong-ref check | **No**, always scan state.json | Safety boundary; a stale index could let a destructive destroy through |

The index is therefore **not load-bearing for correctness** — it can
disappear entirely without affecting cdkd's safety guarantees, only
its performance.

---

## State schema v4

[`src/types/state.ts`](../src/types/state.ts) bumps the schema from
v3 to v4 to add the optional `imports?` field:

```typescript
export interface StackState {
  version: 1 | 2 | 3 | 4;
  stackName: string;
  region?: string;
  resources: Record<string, ResourceState>;
  outputs: Record<string, unknown>;
  imports?: StateImportEntry[];   // NEW in v4
  lastModified: number;
}

export interface StateImportEntry {
  sourceStack: string;
  sourceRegion: string;
  exportName: string;
}
```

### Migration: v3 → v4

| Reader → State | Behavior |
|---|---|
| v4 cdkd → v3 state | `imports` is undefined → treated as empty. Works transparently. |
| v4 cdkd → v4 state | Full v4 semantics. |
| v3 cdkd → v3 state | Unchanged. |
| v3 cdkd → v4 state | `Upgrade cdkd` error (matches every prior schema bump). |

Migration is **fully transparent for forward upgrades**: the next
deploy of a stack rewrites it as v4 automatically.

### Gradual strong-reference activation

A consumer deployed under v3 has no `imports[]` field. After upgrading
to v4 cdkd:

1. Producer destroy attempts before the consumer is re-deployed see
   no `imports[]` for that consumer → strong-ref check finds nothing
   → producer destroy proceeds (= pre-PR behavior, no regression).
2. Once the consumer is re-deployed under v4, its `imports[]` is
   populated.
3. Subsequent producer destroy attempts correctly refuse.

This means the enforcement activates **gradually as consumers are
re-deployed**, with no explicit migration step from the user.

---

## Resolver flow: `Fn::ImportValue`

```text
resolveImportValue(exportName):
  if exportIndex:
    entry = await exportIndex.lookup(exportName)
    if entry and entry.producerStack != context.stackName:
      recordImport(exportName, entry.producerStack, entry.producerRegion)
      return entry.value                                ← O(1) hot path
    // else fall through to scan (cache miss or self-ref)

  allStacks = await stateBackend.listStacks()          ← O(N) cold path
  for ref in allStacks:
    if ref.stackName == context.stackName: continue
    state = await stateBackend.getState(ref.stackName, ref.region)
    if state.outputs[exportName]:
      value = state.outputs[exportName]
      if exportIndex:
        exportIndex.patchEntry(exportName, ...)        ← write-through
      recordImport(exportName, ref.stackName, ref.region)
      return value

  throw "export not found"
```

`recordImport` pushes a `StateImportEntry` into the resolver context's
`recordedImports` bag — the DeployEngine reads this after resource
provisioning and persists it to `state.imports`.

### Why `Fn::GetStackOutput` does NOT recordImport

Weak-reference by design. The producer stays deletable independently;
recording the consumer's reference would defeat that.

---

## Exports index lifecycle

Implemented in [`src/state/export-index-store.ts`](../src/state/export-index-store.ts).

### Triggers

| Operation | Trigger | Cost |
|---|---|---|
| Initial build | First `lookup()` call after the index file is absent (404) | 1 `listStacks` + N parallel `getState`, persisted as 1 PUT |
| Patch on miss | `lookup()` miss → fallback scan succeeds → patches single entry | 1 PUT |
| Update for stack | After successful deploy save | 1 PUT (read-modify-write with If-Match) |
| Remove for stack | After successful destroy | 1 PUT (read-modify-write with If-Match) |
| Rebuild on corruption | Index file JSON parse fails | Same as initial build |

There is **no periodic rebuild, defrag, or vacuum**. The only events
that trigger a full rebuild are the absence or corruption of the
index file — both essentially one-time events.

### Concurrency: optimistic locking

Two concurrent deploys (`--stack-concurrency > 1`) might both attempt
to write the index after their respective state saves. Each writer
uses `S3 PutObject` with `If-Match` against the etag observed at
read-time:

1. Reader A: GET → etag=X
2. Reader B: GET → etag=X
3. A: PutObject IfMatch=X → etag=Y, succeeds
4. B: PutObject IfMatch=X → **412 Precondition Failed**
5. B: re-reads (etag=Y), applies its update, PutObject IfMatch=Y → etag=Z

Up to 5 retries with exponential backoff. After exhaustion the writer
logs a warning and continues — the canonical `state.json` is
unaffected, and the index self-heals on the next operation (next
deploy of any stack, or the next `lookup()` miss-and-patch).

### Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Index file absent | `lookup()` 404 | Auto-rebuild on first access |
| Index file corrupt (JSON parse) | `lookup()` errors | Auto-rebuild on first access |
| Index stale (post-deploy update failed) | `lookup()` returns stale or missing entry | Fallback scan retrieves correct value, patches entry incrementally |
| Index drift from out-of-band edit (`aws s3 cp` against `state.json` directly) | `lookup()` may return stale value | Next deploy of any affected stack repopulates correctly |

The drift case (out-of-band edits) is an accepted limitation;
production cdkd usage does not modify `state.json` directly.

---

## Strong-reference scan at destroy

Implemented in [`src/cli/commands/destroy-runner.ts`](../src/cli/commands/destroy-runner.ts)
via `scanActiveConsumers`. Steps:

1. Only fires when the producing stack's `state.outputs` is non-empty
   (export-less stacks short-circuit, saving the scan entirely).
2. `stateBackend.listStacks()` to enumerate all stacks in the bucket.
3. Parallel `getState` for each (excluding the producer itself).
4. Filter each consumer's `imports[]` for entries matching
   `(sourceStack=producerStack, sourceRegion=producerRegion)`.
5. If any match, throw `StackHasActiveImportsError` with the full
   consumer list.

The scan is intentionally **not** delegated to the exports index —
the index does not store the consumer-side reverse mapping
(`ListImports` equivalent), and trusting a potentially-stale index
here would risk allowing a destructive destroy. Destroy is also
not the perf-critical path; the user-visible UX trade-off accepts
the O(N) scan cost at destroy time.

---

## Resolving a refused destroy

When `cdkd destroy <producer>` refuses with `StackHasActiveImportsError`,
the user has two valid resolution paths:

### Path 1 — destroy the consumer first

```bash
cdkd destroy ConsumerStack
cdkd destroy ProducerStack    # now succeeds
```

This is the CFn-style answer: respect the dependency by destroying
top-down.

### Path 2 — remove the `Fn::ImportValue` reference, redeploy consumer

```typescript
// Before
new lambda.Function(this, 'Handler', {
  environment: {
    BUCKET_ARN: cdk.Fn.importValue('BucketArn'),
  },
});

// After: inline the value, or refactor to a different reference scheme
new lambda.Function(this, 'Handler', {
  environment: {
    BUCKET_ARN: 'arn:aws:s3:::known-bucket',
  },
});
```

Redeploy the consumer (its `state.imports[]` no longer contains the
producer reference), then retry the producer destroy.

### What about `cdkd state orphan`?

`cdkd state orphan <consumer>` is **not** an intended escape hatch
for this error. It removes the consumer's state record entirely
(including all its resources from cdkd's bookkeeping), which is
disproportionate to the goal of "break a single reference."

If you find yourself reaching for `state orphan` to bypass the
strong-reference check, you probably want Path 1 (destroy the
consumer) or Path 2 (remove the reference) instead. cdkd does not
document `state orphan` as an escape hatch from this error because
it is a sledgehammer for a precise problem.

---

## Performance characteristics

Workload: `Fn::ImportValue` resolution during `cdkd deploy` /
`cdkd diff` at varying scale (N = number of stacks in the bucket).

### Cold-start (first invocation after binary upgrade)

| N (stacks) | Pre-#343 (no index) | Post-#343 (rebuild required) |
|---|---|---|
| 10 | ~200ms × K imports | ~200ms (one-time rebuild) |
| 50 | ~1s × K imports | ~500ms |
| 200 | ~5s × K imports | ~2s |
| 1000 | ~25s × K imports | ~8s |

Where K is the number of `Fn::ImportValue` references in the template.
Pre-#343 paid K×N because each import re-scanned the bucket.

### Warm (index file already exists)

| N (stacks) | Cold-start of new cdkd process | Per-resolve cost |
|---|---|---|
| Any | 1 GET of index file (~100-300ms) | 0ms (in-memory hit after first lookup) |

Subsequent cdkd invocations against the same state bucket pay only
the single index GET, regardless of N.

### Destroy (strong-ref scan)

| N (stacks) | Wall time |
|---|---|
| 10 | ~200ms |
| 200 | ~1-3s |
| 1000 | ~5-10s |

Linear with N. Acceptable because destroy is not the perf-critical
path and is dominated by AWS-side resource deletion latency anyway.

---

## Cross-region `Fn::ImportValue` (opt-in)

`Fn::ImportValue` is **same-region by construction** on CloudFormation,
and cdkd preserves that as the default. The per-region exports index
file lives at `s3://{bucket}/cdkd/_index/{region}/exports.json` — one
file per region, with the consumer's deploy region picking which file
the resolver consults.

A multi-region CDK app where the consumer lives in `us-east-1` but the
producer is deployed to `us-west-2` therefore fails by default: the
consumer's `us-east-1` index has no entry for the export name, and the
fallback state.json scan also stays region-scoped. The user gets a
clear "export not found" error pointing at the same-region constraint.

For users who deliberately want this cdkd-specific extension, the
deploy CLI accepts an opt-in flag that lists additional regions to
consult on miss:

```bash
cdkd deploy --import-value-cross-region us-west-2,eu-west-1
```

Equivalent inputs:

- Env var: `CDKD_IMPORT_VALUE_CROSS_REGION=us-west-2,eu-west-1`
- `cdk.json`:
  - String form: `"context": { "cdkd": { "importValueCrossRegion": "us-west-2,eu-west-1" } }`
  - Array form: `"context": { "cdkd": { "importValueCrossRegion": ["us-west-2", "eu-west-1"] } }`

Resolution priority (highest wins): CLI flag > env var > `cdk.json`
> default `[]` (off).

### Behavior when opted in

The resolver tries the **same-region index + state.json scan first**.
Only when both miss does it consult each configured foreign region's
index in turn. The consumer's own region is stripped from the resolved
list at parse time (listing it would be a no-op and would trip the
ambiguity check below).

### Ambiguity policy

If more than one configured foreign region resolves the same export
name, the resolver throws with a clear message naming each region and
producer stack, and points at two valid resolutions:

1. Remove the duplicate from `--import-value-cross-region` to pick a
   single source of truth.
2. Switch the consumer to `Fn::GetStackOutput`, which encodes the
   producer region explicitly and is the recommended pattern for
   cross-region wiring in general.

cdkd refuses to pick a region silently — picking the "first match"
silently across resolver invocations would produce non-deterministic
behavior depending on Map iteration order, and picking the same one
deterministically would still surprise the second consumer.

### Defensive degradation

A foreign-region index lookup that throws (IAM `AccessDenied`,
malformed file, transient S3 error, etc.) is logged at WARN and the
resolver keeps walking the remaining regions — same shape as the
same-region `lookup` error path. The user sees a clear log line per
skipped region so they can diagnose the root cause without losing the
deploy.

### Strong-reference bookkeeping across regions

The producer's actual region is recorded in `state.imports[].sourceRegion`
on the consumer (schema v4 unchanged — the field already existed). So
when the user runs `cdkd destroy` on the producer, the strong-reference
scan finds the consumer's `imports[]` entry whose `sourceRegion`
points at the producer's region, regardless of whether the original
deploy resolved same-region or cross-region.

### Scope and limitations

- **Same-account only.** Both regions must live in the same AWS
  account (cdkd uses one S3 state bucket per account). Cross-account
  `Fn::ImportValue` is tracked under [#449] and out of scope here.
- **Off by default.** Opting in is a deliberate departure from CFn —
  team-mates running the same CDK app must opt in independently.
- **Same-account ambiguity is per-deploy.** The resolver evaluates
  each `Fn::ImportValue` independently, so two consumers in the same
  app can resolve the same export name from two regions if they have
  different `--import-value-cross-region` lists — the ambiguity check
  only fires within ONE resolve. This matches the per-stack
  configuration semantics for every other deploy option.

[#449]: https://github.com/go-to-k/cdkd/issues/449

## Comparison with CloudFormation

| Feature | CFn | cdkd (this design) |
|---|---|---|
| `Fn::ImportValue` resolves to producer's Output | ✓ | ✓ (via index or state.json scan) |
| Producer destroy refused while consumer imports | ✓ | ✓ (`StackHasActiveImportsError`) |
| `--force` to override strong-ref | ✗ | ✗ (deliberately) |
| Index for fast `ListExports` lookup | ✓ (internal) | ✓ (`_index/{region}/exports.json`) |
| Weak cross-stack reference alternative | ✗ | ✓ (`Fn::GetStackOutput`) |
| Cross-region weak reference | ✗ (same region only) | ✓ (`Fn::GetStackOutput`) |
| Cross-region `Fn::ImportValue` | ✗ | ✓ (opt-in via `--import-value-cross-region`) |
| Cross-account exports | via shared bootstrap | ✗ (not yet implemented) |

The departures from CFn (`Fn::GetStackOutput` weak-ref, opt-in
cross-region `Fn::ImportValue`) are cdkd-specific extensions. The
strong-reference behavior is faithful to CFn.

---

## References

- Issue: [#343 — Fn::ImportValue strong reference][#343]
- Schema: [`src/types/state.ts`](../src/types/state.ts)
- Index store: [`src/state/export-index-store.ts`](../src/state/export-index-store.ts)
- Resolver: [`src/deployment/intrinsic-function-resolver.ts`](../src/deployment/intrinsic-function-resolver.ts)
- Destroy scan: [`src/cli/commands/destroy-runner.ts`](../src/cli/commands/destroy-runner.ts)
- Error class: [`src/utils/error-handler.ts`](../src/utils/error-handler.ts)

[#343]: https://github.com/go-to-k/cdkd/issues/343
