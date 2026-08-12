# rollback-replay-effective-props

Real-AWS regression net for issue
[#1682](https://github.com/go-to-k/cdkd/issues/1682) — the reverse-replacement
replay-CREATE must record the provider's `effectiveProperties`.

## What it covers that no other fixture does

`rollback-failure-injection` rolls back **CREATEs**, which is a different
classification branch (it deletes what was created). The arm #1682 changed is
`reverse-replacement`: the resource was **replaced** before the failure, so
rollback re-creates the OLD one from `previousState.properties`.

That bag is a cdkd **state record**, not a template — so it can carry a
malformed block written by an older binary, and the provider is expected to
warn and **substitute** rather than refuse (the #1544 `replayWarn` downgrade).
Pre-#1682 the engine typed that call's result as `{ physicalId, attributes? }`
and rebuilt the record from `prev.properties`, so the substitution was
announced into a void and the phantom drift it exists to close survived the
rollback.

## Why `AWS::EC2::Route` rather than the `AWS::S3::Bucket` the issue names

Both providers substitute on a state replay. But a bucket's
reverse-replacement re-create has to re-acquire a just-deleted **globally
unique** name, whose release is not immediate — the fixture would be flaky for
a reason unrelated to what it tests. A route's identity is
`<RouteTableId>|<Destination>`, scoped to this stack's own route table, so the
re-create is deterministic.

`EC2Provider.createRoute`'s multi-destination warn arm is gated on exactly the
same `CreateContext.replayingState` flag (the callback is passed only when
`context?.replayingState === true`), so it exercises the identical engine path.

## Phases

| # | Step | Assertion |
|---|------|-----------|
| 1 | Deploy v1 (`DestinationCidrBlock: 0.0.0.0/0`) | state records the one destination key |
| 2 | Doctor state: add `DestinationIpv6CidrBlock: ::/0` | the injection took (else every later assertion is vacuous) |
| 3 | Deploy v2 — create-only destination flip **plus** an injected SQS failure that `DependsOn` the route | deploy exits non-zero **and** the replay-CREATE substitution warning fired (proving the reverse-replacement arm ran) |
| 4 | **The point** | post-rollback record has `DestinationCidrBlock` restored and `DestinationIpv6CidrBlock` **gone** |
| 5 | `cdkd drift` twice | both converge — the user-visible consequence |
| 6 | Destroy | 0 orphans, state gone |

Phase 4 is what fails against a pre-#1682 binary: the record would still carry
the key the provider warned it was dropping and never sent to AWS.

## Running

```bash
/run-integ rollback-replay-effective-props
```

The fixture intentionally creates a failed deploy, so the `EXIT`/`INT`/`TERM`
trap sweeps by the `cdkd:integ-fixture` tag in addition to the state-based
destroy.
