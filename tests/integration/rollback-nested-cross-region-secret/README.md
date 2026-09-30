# rollback-nested-cross-region-secret

Real-AWS regression net for issue
[#4174](https://github.com/go-to-k/cdkd/issues/4174): a nested child's
rollback replay must classify a PARENT-supplied `{{resolve:...}}` reference
with the parent's producer regions. The nested twin of
[`rollback-cross-region-secret`](../rollback-cross-region-secret/README.md)
(issue #2057).

Run it with `/run-integ rollback-nested-cross-region-secret` — never invoke
`cdkd deploy` / `cdkd rollback` / `cdkd destroy` by hand.

## Background

A child receives a parent's cross-region value only as a Parameter. The parent
resolves it in the producer's region, and the child records the parent's
region-less spelling of the expression (`inheritedSecrets`), while the child's
own `outputReads` never name the producer's region. The child's replay used to
classify the reference against those reads alone, answer `local`, and resolve
it against the same-named secret in the consumer's region, writing that value
onto a live resource.

## Architecture

1. **CdkdRbNestedXregionProducer** (`us-west-2`): `ProducerProbe` and the
   `SharedSecret` output, a region-less SSM `SecureString` reference persisted
   redacted.
2. **CdkdRbNestedXregionConsumer** (`us-east-1`): the nested row `Child`
   (logical id pinned, child state key `CdkdRbNestedXregionConsumer~Child`),
   whose `SharedValue` Parameter is `Fn::GetStackOutput` of `SharedSecret` with
   `Region: us-west-2`. In the child, `SecretEcho` (SSM `String`) takes
   `Ref SharedValue`; its `Description` carries `MARKER_VALUE`, so v1 -> v2 is
   an UPDATE inside the child. `FailingQueue` (only with `INJECT_FAIL=true`)
   depends on the `Child` row and fails its create.

The same `SecureString` name is seeded in both regions with different values,
so a wrong-region resolution is observable.

## What `verify.sh` asserts

- Premises (phase 2): the live echo holds the producer's value, the child
  record holds the region-less expression, the PARENT's `outputReads` name
  `us-west-2`, and the CHILD's own reads name no region — the shape where the
  child's evidence alone cannot explain the reference.
- **Drift arm** (phase 2d, go-to-k/cdkd#4213): with the child's echo tampered
  (Value and Description), `cdkd drift --revert` on the CHILD refuses on the
  parent's regions (`producer region(s) on record: us-west-2`, exit 2) and
  writes nothing. Before #4213 drift read only the child's own reads and
  wrote the consumer region's secret, so this arm discriminates.
- **Arm A** (phases 3-4): a `--no-rollback` failure, then `cdkd rollback` of
  the parent; the nested row's revert refuses (exit 2), and the live echo
  still holds the producer's value with the v2 `Description`.
- **Arm B** (phase 6): the same failure under the deploy's automatic rollback;
  the revert refuses and the live value is untouched.
- **Arm C** (phase 6c): a failure INSIDE the child (`INJECT_CHILD_FAIL=true`),
  so the child engine's own automatic rollback reverts the echo with the
  parent engine's handed-down regions; it refuses and the value is untouched.

**Only arm C discriminates.** Run against the pre-#4174 binary, arms A and B
still pass: the parent's revert of the `Child` row re-resolves the row's own
`Parameters.SharedValue`, which holds the same region-less expression, and the
parent's own evidence refuses it before the child's journal replay runs. They
stay as regression nets (no nested revert writes the wrong region's value,
whichever layer refuses). Arm C fails pre-fix at its refusal assertion. The
journal-replay site is exercised past the parent's refusal only by
`tests/unit/deployment/rollback-nested-cross-region-secret.test.ts`, whose row
carries no secret-bearing Parameters.
- Each refusal must name `producer region(s) on record: us-west-2` and must
  not be the incomplete-evidence refusal: a broken hand-down refuses too, but
  on the wrong evidence.
- No plaintext in any state file or command output; teardown sweeps all three
  state prefixes (producer, consumer, child) including object versions.

A direct `cdkd rollback '<parent>~<child>'` (which marks its evidence
incomplete and refuses every region-less secret reference) is covered by unit
tests only: it is reachable only for a child's own failure segment after the
parent's run has settled, which this fixture does not produce.
