# importvalue-chain — 3-stack Fn::ImportValue chain integ test

A failure-seeking integration test for **transitive** `Fn::ImportValue`
chains, the exports index, strong-reference tracking, and deploy/destroy
ordering across more than two stacks.

## The chain

```text
  Stack A (CdkdImportChainA)          Stack B (CdkdImportChainB)          Stack C (CdkdImportChainC)
  ┌──────────────────────┐           ┌────────────────────────────┐     ┌────────────────────────┐
  │ SNS Topic            │           │ imports ChainTopicArn ─────┐│     │ imports ChainDerivedValue
  │ exports ChainTopicArn│──────────▶│  (stored in SSM Param)     ││     │  (stored in SSM Param) │
  └──────────────────────┘           │ DERIVES a value (Fn::Sub)  ◀┘     │                        │
                                      │ re-exports ChainDerivedValue│────▶│                        │
                                      └────────────────────────────┘     └────────────────────────┘
```

- **A** is a pure producer: an SNS Topic whose ARN is exported as
  `ChainTopicArn`.
- **B** is the piece the existing fixtures lack — it BOTH **imports**
  `ChainTopicArn` from A AND **re-exports** a derived value
  (`derived::<topicArn>::from-b`, via `Fn::Sub`) as `ChainDerivedValue`.
- **C** is a pure consumer that imports `ChainDerivedValue` from B.

So C's value transitively depends on A's export through B.

Resources are intentionally cheap (SNS + SSM only — no VPC, no Lambda) so
the test runs fast.

## What this fixture exercises (and how it differs from the others)

| Fixture | Shape | Focus |
|---|---|---|
| `cross-stack-references` | 1 producer + 1 consumer | `Fn::ImportValue` vs `Fn::GetStackOutput` side by side |
| `import-value-strong-ref` | 1 producer + 1 consumer | strong-ref refusal + schema v3→v4 migration story |
| **`importvalue-chain`** (this) | **3-stack A→B→C, middle re-exports** | **transitive chain resolution, chained strong-ref protection, deploy/destroy ordering, error path** |

`verify.sh` asserts:

1. **Deploy chain** — `deploy --all` orders A→B→C; B's SSM Parameter holds
   A's real SNS topic ARN; C's SSM Parameter holds B's derived value, and
   the embedded ARN equals the value B imported (full transitive chain); the
   exports index carries BOTH `ChainTopicArn` and `ChainDerivedValue`.
2. **Error path** — deploying C alone against a fresh state prefix (no
   producers) fails with a clear "export not found" error naming
   `ChainDerivedValue` (cdkd does not silently resolve a dangling token);
   `deploy --all` on the same fresh prefix then correctly orders the chain.
3. **Chained strong-ref protection** — destroying B while C imports it is
   refused (names C + `ChainDerivedValue`); destroying A while B imports it
   is refused (names B + `ChainTopicArn`).
4. **Ordered teardown** — destroy C → B → A; each succeeds once its consumer
   is gone; state is gone for all 3, the named SSM Parameters + SNS topic are
   gone from AWS, and the exports index is purged of both exports.

## Running

```bash
/run-integ importvalue-chain
# or, directly:
bash tests/integration/importvalue-chain/verify.sh
```

`verify.sh` is BSD/macOS-portable, captures the real exit code at each step,
and prints an explicit `All importvalue-chain smoke tests passed` line on
success. A trap cleans up both the main and the fresh-prefix state on any
exit.
