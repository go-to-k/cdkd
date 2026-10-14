# rollback-cross-region-secret

Real-AWS regression net for issue
[#2057](https://github.com/go-to-k/cdkd/issues/2057): a rollback replay must
not re-resolve a REGION-AMBIGUOUS `{{resolve:...}}` secret reference against
the consumer stack's own region.

Run it with `/run-integ rollback-cross-region-secret` — never invoke
`cdkd deploy` / `cdkd rollback` / `cdkd destroy` by hand, since the skill
encodes deploy + rollback + destroy + orphan verification as one block.

## Background

Since issue [#1934](https://github.com/go-to-k/cdkd/issues/1934) a cross-stack
consumer re-resolves a redacted producer value in the **producer's** region
(`reresolveCrossStackValue` / `resolverForProducerRegion`) — correct, because a
Secrets Manager secret or an SSM `SecureString` of the same NAME in two regions
is two independent values. The resolved plaintext is then recorded into the
consumer's `recordedSecretValues`, so the consumer's `state.json` persists the
**producer's** spelling of the expression. That is the right thing to persist,
and it carries no region.

`replayRollback` rebuilds its resolver from `ctx.region` alone. So a rollback of
that consumer used to re-resolve the producer's reference LOCALLY and write
whatever a same-named secret holds in the consumer's region onto a LIVE
resource — silently, on the recovery path. The fix refuses the replay instead,
because nothing on hand can establish where a region-less expression came from
("a named region binds; never substitute a guess", issue #1957).

## v12 records and pre-v12 records

Since state schema v12 ([#4847](https://github.com/go-to-k/cdkd/issues/4847))
each record also carries `referenceProvenance`: per token, the region that
resolved it. The rollback replay, `cdkd drift` and `cdkd scrub` resolve a
region-less token in that recorded region, so on a record a v12 binary wrote
the producer's reference is resolved in `us-west-2` and nothing refuses. A
record without the field (written before v12) keeps the old reading, and the
refusal is still the behaviour for it.

`verify.sh` therefore covers both. The positive phases run on the records as
this binary writes them, and each names its pre-#4847 red line (the refusal).
The refusal phases run after the script rewrites the consumer's `state.json`
in S3 with every `referenceProvenance` / `outputReferenceProvenance` removed
— premise first (the field is there), then write, then read back (gone, every
token kept) — which is exactly a pre-v12 record. Which record to strip, and
when, follows from what the replay reads: the desired side is the journal's
`previousState`, copied from the state before the failing deploy (arm A strips
before that deploy), and the previous side is the record the failing deploy
writes (arm B strips after it).

## Why the two regions must hold DIFFERENT values

The same SecureString NAME is seeded in `us-west-2` and `us-east-1` with
different values. A fixture that seeded one value — or the same value twice —
could not distinguish a correct resolution from a wrong-region one, and every
assertion would pass whether or not the fix is present. Both the "still
correct" and the "must not be the other region's" halves are asserted
explicitly.

## Why SSM SecureString rather than Secrets Manager

- cdkd treats an `ssm` reference to a `SecureString` exactly like a
  `secretsmanager` one — redacted into state, re-resolved on replay (issue
  [#1901](https://github.com/go-to-k/cdkd/issues/1901)).
- An SSM parameter has **no deletion cooldown**, so repeated integ runs cannot
  collide on the name. A Secrets Manager secret force-deleted at teardown can
  still refuse a same-name create for a while.
- A BARE parameter name is region-less, which is the exact shape that cannot be
  disambiguated from the expression alone — the arm this fixture exists for.
  (An earlier version of this file claimed an `ssm` reference "can never be an
  ARN". That is FALSE for cdkd: `resolveSSMReference` rebuilds the parameter
  name as `parts.slice(1).join(':')`, so a full ARN survives the colon split and
  reaches `GetParameter` intact. That form carries its own region and takes the
  `named-region` arm instead; it is covered by
  `tests/unit/deployment/rollback-executor-cross-region-secret.test.ts`, whose
  assertion target is the constructor region of the client that answered. The
  fixture uses the bare-name form deliberately, not because the ARN form cannot
  occur.)

CloudFormation cannot create a `SecureString`, so `verify.sh` seeds it out of
band and asserts the type came back `SecureString` in BOTH regions before
deploying anything — a parameter that silently came back `String` would resolve
and pass every value assertion while redacting nothing.

## Architecture

Two stacks in one CDK app, pinned to different regions via `env.region`:

1. **CdkdRbXregionProducer** (`us-west-2`)
   - `ProducerProbe`, an ordinary SSM `String` parameter.
   - `CfnOutput` `SharedSecret`, whose value is
     `{{resolve:ssm:/cdkd/rollback-xregion/shared-secret}}`. cdkd resolves it in
     `us-west-2` and persists the output REDACTED (PR #1899), so
     `state.outputs.SharedSecret` holds the expression.

2. **CdkdRbXregionConsumer** (`us-east-1`)
   - `SecretEcho`, an SSM `String` parameter whose `Value` is
     `Fn::GetStackOutput` of the producer's `SharedSecret` with an explicit
     `Region: us-west-2`. Its `Description` carries `MARKER_VALUE`, which is
     what makes the v2 deploy an UPDATE of this resource.
   - `FailingQueue`, an SQS queue with an out-of-range
     `messageRetentionPeriod` (valid range `[60, 1209600]`), added only when
     `INJECT_FAIL=true` and depending on `SecretEcho` so the echo UPDATE
     completes first. Same injection idiom as
     `tests/integration/rollback-command`.

`SSMParameterProvider.update` re-sends `Value` on every `PutParameter`
(`Overwrite: true`), which is why a wrong-region resolution here is a wrong
**write** rather than only a wrong log line.

## What `verify.sh` asserts

0. Seed the shared name as a `SecureString` in both regions with different
   values; assert both types are really `SecureString`.
1. Deploy the producer in `us-west-2`; assert `state.outputs.SharedSecret` is
   the EXPRESSION and no plaintext is in the state file.
2. Deploy the consumer v1 in `us-east-1`; assert
   - the live echo parameter carries the **producer** region's value (the
     #1934 cross-region read — if this regresses, the fixture says so
     explicitly rather than failing obscurely later),
   - the consumer's state record for it (selected by the parameter's real AWS
     NAME, not by logical id) holds the region-LESS expression and neither
     plaintext,
   - `state.outputReads[]` records `sourceRegion: us-west-2` — the evidence the
     refusals key on.
   - 2p: the `SecretEcho` record names `us-west-2` for the token and
     `LocalSecretEcho` (the same token string, resolved by the consumer
     itself) names `us-east-1`.
   - **v12 records** — 2e: `cdkd drift` exits 0 with `SecretEcho` compared and
     clean; 2f: `cdkd scrub` exits 0 without a region refusal; 2g: with Value
     and Description tampered, drift reports both, and `drift --revert` exits 0
     and writes the producer region's value.
   - 2s strips the consumer's provenance. **Pre-v12 records** — 2b/2b2/2c:
     drift marks `SecretEcho` `notCompared` and exits 2, and `--revert`
     refuses (`refused to re-resolve`), writes nothing and exits 2; 2d:
     `cdkd scrub` refuses the region-ambiguous literal and leaves state
     byte-identical, while the producer scrubs normally.
3. Deploy the consumer v2 (`MARKER_VALUE=v2 INJECT_FAIL=true --no-rollback`)
   from the still-stripped state; assert it FAILED, a journal exists, the
   journal carries exactly one `UPDATE` op for the echo parameter whose
   journaled previous `Value` is the region-less expression and whose
   `previousState` carries no provenance, and the v2 UPDATE really landed
   (`Description` is `v2`). Without that op the rollback would have nothing to
   replay and phase 4 would pass vacuously.
4. `cdkd rollback --force`; assert
   - exit code **2** (partial — one op refused, journal kept),
   - the refusal names the reference and BOTH regions,
   - no plaintext appears in the rollback output,
   - **the load-bearing assertion**: the live echo parameter STILL holds the
     producer region's value, and is not the consumer region's,
   - the revert did not apply (`Description` is still `v2`) and the journal is
     preserved for a re-run.
5. Destroy the consumer. 5b — **arm A on v12 records**: deploy v1, fail v2
   (the journaled `previousState` names `us-west-2`), and `cdkd rollback`
   exits 0, restores the v1 `Description` with the producer region's value
   live, and drops the journal. 5c destroys the consumer again, so arm B
   starts from a stack that has never read across a region.
6. **ARM B — the reachable case.** Deploy the consumer with `WITH_XREGION`
   unset, so its `Value` is a plain local literal and `state.outputReads` is
   empty (asserted). Then run ONE deploy that both INTRODUCES the cross-region
   read and fails. Assert
   - the echo UPDATE completed, so the live parameter now holds the producer's
     secret and there is something to roll back,
   - **the FAILED deploy persisted the read it just made** — `outputReads[]`
     names `us-west-2`. This is the arm-B discriminator, and before the union
     fix it came back empty: every non-success save wrote the PRE-deploy
     snapshot, and a rollback journal exists ONLY after a failed deploy, so the
     refusal had no evidence to fire on precisely when it mattered,
   - 6s strips the record that deploy wrote (the token is on the replay's
     previous side here), and `cdkd rollback --force` exits 2 and refuses,
     and the live value is unchanged (neither reverted to the literal nor
     overwritten with the consumer region's secret),
   - 6d puts the provenance back and replays the SAME journal: `cdkd rollback`
     exits 0 and restores the literal.
7. Destroy both stacks, delete the seeded parameters in both regions, and
   assert every AWS resource, both state files, and the injected queue (which
   must never have been created) are gone — with tri-state gone probes, so a
   throttle / auth failure cannot read as "gone".

## Why BOTH arms

They fail on different defects, and arm A cannot substitute for arm B.

Arm A (phases 2-4, and 5b on v12 records) establishes the cross-region read
with a **successful** deploy and only then fails one, so the producer region is
already on record when the rollback runs. It proves the refusal mechanism
works on a pre-v12 record. Pre-#2057 it fails at the value assertion: the
rollback "succeeds" and overwrites the live parameter with the consumer
region's secret.

Arm B (phase 6) introduces the read **in the failing deploy itself**, which is
the shape a real first cross-region deploy takes. A green arm A coexisted with
a fix that was completely inert on that shape, and only arm B reds it — so if
one of the two is ever dropped, drop arm A.

## Teardown

`cleanup` is armed as `EXIT` plus signal traps (`INT` -> 130, `TERM` -> 143)
with `rc` seeded to 0 before arming, so a signal cannot make an unset variable
read as success and skip teardown. A `cleaned` guard makes it idempotent — the
signal traps call `cleanup` and then `exit`, which re-fires `EXIT`, and without
the guard every signalled run would tear down twice and race itself.

Cleanup destroys both stacks (each against its OWN region), then falls back to
direct AWS deletes for the echo / probe / seeded parameters and the injected
queue in case `destroy` is what broke, then removes the `cdkd/<stack>/` prefixes
(state, lock, journal and events sidecars — events deliberately survive
`destroy`, and this run leaves a journal behind on purpose).

## Run

```bash
/run-integ rollback-cross-region-secret
```

`STATE_BUCKET` is required. The regions are PINNED (`us-west-2` producer,
`us-east-1` consumer) regardless of `AWS_REGION`, because the CDK app pins
`env.region` per stack; each cdkd invocation is prefixed with the matching
`AWS_REGION`.
