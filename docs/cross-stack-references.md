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

### `Fn::GetStackOutput` does NOT recordImport — it records to a separate bag

Weak-reference by design. The producer stays deletable independently;
recording the consumer's reference into `recordedImports` would defeat
that (and `state.imports` IS the destroy-time refusal source). However,
schema v8 (issue
[#668](https://github.com/go-to-k/cdkd/issues/668)) adds a SEPARATE
`recordedOutputReads` bag that the resolver pushes into on every
successful **same-account** `Fn::GetStackOutput` resolution. The
DeployEngine persists this bag to `state.outputReads` at save time.

`state.outputReads` is **informational only** — used by
`findDownstreamConsumers` to name `Fn::GetStackOutput` consumers in
the `--recreate-via-cc-api` / `--recreate-via-sdk-provider` warn
block. There is NO destroy-time refusal for these references; the
producer remains deletable independently, matching the v1 weak-ref
contract. Cross-account `RoleArn`-based reads do NOT push entries
into `state.outputReads` in v8 (deferred to a future schema bump
alongside a `sourceAccountId` field).

### Cross-account `Fn::GetStackOutput` (`RoleArn` argument)

`Fn::GetStackOutput` accepts an optional `RoleArn` to read outputs from
a producer stack in a sibling AWS account — the canonical multi-account
pattern (shared-services account exporting platform outputs consumed by
workload accounts).

```json
{
  "Fn::GetStackOutput": {
    "StackName": "PlatformVpc",
    "OutputName": "SharedVpcId",
    "Region": "us-east-1",
    "RoleArn": "arn:aws:iam::111122223333:role/cdkd-state-reader"
  }
}
```

When `RoleArn` is set, cdkd's resolver:

1. **Parses the role ARN** for the producer's account id via
   [`parseIamRoleArn`](../src/utils/role-arn.ts). The regex accepts every
   published AWS partition (`aws`, `aws-us-gov`, `aws-cn`, `aws-iso`,
   `aws-iso-b`) and role-name path shapes including service-linked roles.
   Malformed ARNs / IAM user ARNs / non-12-digit account ids are rejected
   up front with a clear error.
2. **Calls `sts:AssumeRole`** via
   [`assumeRoleForCrossAccountStateRead`](../src/utils/role-arn.ts).
   Credentials are cached per-RoleArn for the deploy lifetime, so a
   stack with many `Fn::GetStackOutput` sites against the same producer
   pays exactly one STS hop. Concurrent first-time callers collapse to
   the same in-flight promise.
3. **Derives the producer's state bucket name** as
   `cdkd-state-{producerAccountId}` (the canonical region-free
   convention since v0.10.0) via
   [`resolveCrossAccountStateBucket`](../src/utils/aws-region-resolver.ts).
   The bucket's actual region is auto-detected via
   `s3:GetBucketLocation` using the assumed credentials.
4. **Reads the producer's state** through a fresh, ephemeral
   `S3StateBackend` pointed at the producer's bucket with the assumed
   credentials. Reuses the full state-parsing + schema-version-tolerance
   machinery (legacy v1 keys, migration warnings, region key layout).
5. **Returns the requested output value**.

#### Constraints

- **`RoleArn` must be a LITERAL string in the template.** `Ref` /
  `Fn::GetAtt` / `Fn::Sub` chains are intentionally rejected at the
  resolver layer: the context isn't guaranteed to have the producer's
  account id available at intrinsic-resolution time, and a typo'd role
  lookup is far worse than a clear template-author-time error. Inline
  the ARN.
- **Producer must be on the canonical region-free bucket layout**
  (`cdkd-state-{accountId}`). Legacy region-suffixed buckets
  (`cdkd-state-{accountId}-{region}`) are not consulted on the
  cross-account read path because account-wide `s3:ListAllMyBuckets` in
  the assumed role would be required to disambiguate, for no
  real-world benefit on long-since-migrated accounts.
- **Assumed credentials are scoped to the state read.** The consumer's
  normal provisioning credentials are untouched — unlike the CLI-wide
  `--role-arn` flag, which writes assumed creds into `AWS_*` env vars
  for every later SDK client. Cross-account `Fn::GetStackOutput` is a
  narrow read-only operation.

#### IAM permissions

The assumed role in the producer account needs:

- `s3:GetBucketLocation` on the producer's state bucket.
- `s3:GetObject` on `cdkd/{stackName}/{region}/state.json` keys for any
  stack the consumer references.

A minimal producer-side policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::cdkd-state-111122223333"
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::cdkd-state-111122223333/cdkd/*"
    }
  ]
}
```

The role's trust policy must allow the consumer account's principal
(or a specific consumer role) to `sts:AssumeRole`. Standard cross-account
trust-policy setup applies.

#### Strong-reference semantics

`Fn::GetStackOutput` is a weak reference, including in the
cross-account case. A `cdkd destroy` against the producer succeeds even
while a consumer in another account holds an outstanding reference —
the next consumer deploy will surface the broken reference. This
matches CFn's behavior for cross-account references (no shared
ListExports across accounts; no strong-reference protection).

#### What's not supported (yet)

- A cross-account integration test (`tests/integration/cross-stack-cross-account/`)
  is gated by `CDKD_INTEG_CROSS_ACCOUNT=1` + `CDKD_PRODUCER_ACCOUNT_ID=<id>` +
  `CDKD_PRODUCER_ROLE_ARN=<arn>` env vars and ships in a follow-up.
- `Fn::ImportValue` does NOT accept a `RoleArn` argument. Cross-account
  strong references are not a CFn-supported pattern — CFn's
  `Fn::ImportValue` is same-account only — so cdkd does not extend
  beyond that. Use `Fn::GetStackOutput` with `RoleArn` for cross-account
  reads.

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

## Comparison with CloudFormation

| Feature | CFn | cdkd (this design) |
|---|---|---|
| `Fn::ImportValue` resolves to producer's Output | ✓ | ✓ (via index or state.json scan) |
| Producer destroy refused while consumer imports | ✓ | ✓ (`StackHasActiveImportsError`) |
| `--force` to override strong-ref | ✗ | ✗ (deliberately) |
| Index for fast `ListExports` lookup | ✓ (internal) | ✓ (`_index/{region}/exports.json`) |
| Weak cross-stack reference alternative | ✗ | ✓ (`Fn::GetStackOutput`) |
| Cross-region exports | ✗ (same region only) | ✓ (`Fn::GetStackOutput`) |
| Cross-account exports | via shared bootstrap | ✓ (`Fn::GetStackOutput` with `RoleArn`) |

The departures from CFn (`Fn::GetStackOutput` weak-ref, cross-region)
are cdkd-specific extensions. The strong-reference behavior is
faithful to CFn.

---

## References

- Issue: [#343 — Fn::ImportValue strong reference][#343]
- Schema: [`src/types/state.ts`](../src/types/state.ts)
- Index store: [`src/state/export-index-store.ts`](../src/state/export-index-store.ts)
- Resolver: [`src/deployment/intrinsic-function-resolver.ts`](../src/deployment/intrinsic-function-resolver.ts)
- Destroy scan: [`src/cli/commands/destroy-runner.ts`](../src/cli/commands/destroy-runner.ts)
- Error class: [`src/utils/error-handler.ts`](../src/utils/error-handler.ts)

[#343]: https://github.com/go-to-k/cdkd/issues/343
