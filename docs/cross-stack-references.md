---
title: Cross-Stack References
description: "cdkd's two cross-stack reference mechanisms — strong Fn::ImportValue and weak Fn::GetStackOutput — and the exports index design behind them."
---

# Cross-Stack References

cdkd supports two cross-stack reference mechanisms with deliberately
different semantics:

| Intrinsic | Strength | Behavior on producer destroy | Use when |
|---|---|---|---|
| `Fn::ImportValue` | **strong** | Refuse with `StackHasActiveImportsError` | You want CloudFormation parity — the producer must be protected as long as consumers reference it |
| `Fn::GetStackOutput` (cdkd-specific) | weak | Proceeds; consumer's next resolve fails | You want the producer to be deletable independently of consumers (cross-region / cross-stage / staging) |

This page covers what each mechanism means for you: which to reach for, what a
refused destroy is telling you, and how to resolve one. The exports index, the
state schema behind it, the resolver's decision flow and the measured cost of
each path are in
[Cross-stack reference internals](cross-stack-internals.md).

---

## Why strong references

CloudFormation's `Fn::ImportValue` is a strong reference:

```text
$ aws cloudformation delete-stack --stack-name Producer
An error occurred (ValidationError): Export Producer:BucketArn cannot
be deleted as it is in use by stack Consumer.
```

cdkd once silently allowed producer destruction even
when consumers referenced its outputs. The consumer's next deploy
would then fail at resolve time with `export 'BucketArn' not found in
any stack`. This violated user expectations and was inconsistent with
CloudFormation's safety model.

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

## CloudFormation fallback (mixed cdkd / CloudFormation estates)

A cdkd-deployed consumer can reference a producer stack that is still
managed by CloudFormation (`cdk deploy` / raw CFn) — the typical
mixed-estate scenario where shared infrastructure stays on the CDK CLI
while app stacks deploy via cdkd:

- **`Fn::ImportValue`**: when the export is in NO cdkd state record,
  the resolver falls back to CloudFormation `ListExports` (paginated) in
  the consumer's region. CloudFormation's own semantic for
  `Fn::ImportValue` IS `ListExports`, so this closes a template
  compatibility gap.
- **`Fn::GetStackOutput`** (same-account only): when the producer has no
  cdkd state record at `cdkd/{StackName}/{Region}/state.json`, the
  resolver falls back to CloudFormation `DescribeStacks` and reads the
  stack's `Outputs` in the target region. The `RoleArn` (cross-account)
  path never takes the fallback — it keeps reading the producer
  account's cdkd state exclusively.

Design points:

- **cdkd-first precedence is inherent.** The fallback only runs after a
  cdkd-state miss, so existing cdkd-to-cdkd references are untouched and
  a name collision between a cdkd export and a CFn export resolves to
  the cdkd one.
- **CFn-sourced resolutions are WEAK references.** They are NOT recorded
  into `state.imports` / `state.outputReads`: cdkd cannot protect a
  producer it does not manage at destroy time, and CloudFormation's own
  export-in-use protection cannot see cdkd consumers. Deleting the CFn
  producer therefore breaks the consumer's NEXT resolve, not the
  producer's delete. No state schema change is involved.
- **Graceful degradation.** A fallback lookup failure (most commonly a
  caller lacking `cloudformation:ListExports` /
  `cloudformation:DescribeStacks`) logs a warning and surfaces the
  original not-found error — without the fallback the deploy would have
  failed with the same error anyway.
- **Opt-out**: `--no-cfn-fallback` (on `deploy` and `diff`) disables the
  fallback entirely for cdkd-state-only semantics — e.g. to keep IAM
  minimal, or to keep an export-name typo failing fast instead of
  accidentally matching an unrelated CloudFormation export in the
  account. The diff resolvers honor the same flag so preview and apply
  resolve identically.
- **Mixed sources need no per-reference configuration.** Resolution is
  per-reference, so one stack can consume some values from cdkd
  producers and others from CFn producers with the same syntax.
- This also relaxes the `cdkd export` leaf-first ordering constraint:
  after a producer is exported to CloudFormation, remaining cdkd
  consumers resolve its outputs via the fallback instead of failing.

---

## Strong-reference scan at destroy

Implemented in [`src/cli/commands/destroy-runner.ts`](https://github.com/go-to-k/cdkd/blob/main/src/cli/commands/destroy-runner.ts)
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
| Reference a producer managed by the OTHER engine | ✗ (CFn cannot read cdkd state) | ✓ (CloudFormation fallback, weak — see above) |

The departures from CFn (`Fn::GetStackOutput` weak-ref, cross-region)
are cdkd-specific extensions. The strong-reference behavior is
faithful to CFn.

---

## References

- Schema: [`src/types/state.ts`](https://github.com/go-to-k/cdkd/blob/main/src/types/state.ts)
- Index store: [`src/state/export-index-store.ts`](https://github.com/go-to-k/cdkd/blob/main/src/state/export-index-store.ts)
- Resolver: [`src/deployment/intrinsic-function-resolver.ts`](https://github.com/go-to-k/cdkd/blob/main/src/deployment/intrinsic-function-resolver.ts)
- Destroy scan: [`src/cli/commands/destroy-runner.ts`](https://github.com/go-to-k/cdkd/blob/main/src/cli/commands/destroy-runner.ts)
- Error class: [`src/utils/error-handler.ts`](https://github.com/go-to-k/cdkd/blob/main/src/utils/error-handler.ts)

## Related

- [Cross-stack reference internals](cross-stack-internals.md) — the exports
  index, the resolver flow, and what each path costs
- [Mixed Estates](mixed-estates.md) — consuming a CloudFormation-managed
  producer
- [Stack Outputs](stack-outputs.md) — declaring the values a consumer imports
- [Destroy flags & guards](cli-destroy.md) — the refusal this page's guard
  produces
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
