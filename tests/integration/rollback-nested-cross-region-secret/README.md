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

## v12 records and pre-v12 records

Since state schema v12 ([#4847](https://github.com/go-to-k/cdkd/issues/4847))
each record carries `referenceProvenance`: per token, the region that resolved
it. The child's `SecretEcho` record gets `us-west-2` for the parent-supplied
token (the nested inherited provenance is recorded on the read route), and so
does the parent's `Child` row. The rollback replay and `cdkd drift` resolve a
region-less token in that recorded region, so on records a v12 binary wrote
nothing refuses. A record without the field (written before v12) keeps the old
reading, and the refusal is still the behaviour for it.

`verify.sh` covers both: positive phases on the records as this binary writes
them, each naming its pre-#4847 red line (the refusal), and refusal phases
after rewriting the parent's and the child's `state.json` in S3 without the
field — premise first (the field is there), then write, then read back (gone,
every token kept). The strip happens before the failing deploy, because each
replay refuses on its journal's `previousState`, which is copied from the
state as it stood before that deploy.

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
  child's evidence alone cannot explain the reference. 2p: the parent's
  `Child` row and the child's `SecretEcho` record both name `us-west-2`.
- **Drift, v12** (phase 2b): with the child's echo tampered (Value and
  Description), `cdkd drift` on the CHILD reports both drifted and
  `--revert` exits 0 and writes the producer's value.
- **Drift, pre-v12** (phases 2s + 2d, go-to-k/cdkd#4213): on the stripped
  child record, `cdkd drift --revert` refuses on the parent's regions
  (`producer region(s) on record: us-west-2`, exit 2) and writes nothing.
  Before #4213 drift read only the child's own reads and wrote the consumer
  region's secret, so this arm discriminates.
- **Arm A** (phases 3s-4): on stripped records, a `--no-rollback` failure,
  then `cdkd rollback` of the parent; the nested row's revert refuses (exit
  2), and the live echo still holds the producer's value with the v2
  `Description`. Phase 5b repeats it on v12 records: the rollback exits 0 and
  restores the v1 `Description` with the producer's value.
- **Arm B** (phase 6): the same failure under the deploy's automatic
  rollback. On v12 records (6a2) the revert completes; on stripped records
  (6a3 + 6b) it refuses and the live value is untouched.
- **Arm C** (phase 6c): a failure INSIDE the child (`INJECT_CHILD_FAIL=true`),
  so the child engine's own automatic rollback reverts the echo with the
  parent engine's handed-down regions. On v12 records it completes; on
  stripped records (6c2) it refuses and the value is untouched.

**Only arm C discriminates #4174.** Run against the pre-#4174 binary, arms A
and B still pass: the parent's revert of the `Child` row re-resolves the row's
own `Parameters.SharedValue`, which holds the same region-less expression, and
the parent's own evidence refuses it before the child's journal replay runs.
They stay as regression nets (no nested revert writes the wrong region's
value, whichever layer refuses). Arm C fails pre-#4174 at its refusal
assertion. The journal-replay site is exercised past the parent's refusal only
by `tests/unit/deployment/rollback-nested-cross-region-secret.test.ts`, whose
row carries no secret-bearing Parameters.
- Each refusal must name `producer region(s) on record: us-west-2` and must
  not be the incomplete-evidence refusal: a broken hand-down refuses too, but
  on the wrong evidence.
- No plaintext in any state file or command output; teardown sweeps all three
  state prefixes (producer, consumer, child) including object versions.

A direct `cdkd rollback '<parent>~<child>'` (which marks its evidence
incomplete and refuses every region-less secret reference whose record names
no region) is covered by unit
tests only: it is reachable only for a child's own failure segment after the
parent's run has settled, which this fixture does not produce.
