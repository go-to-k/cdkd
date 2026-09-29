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

## The engine subject and the per-provider subjects

`AWS::EC2::Route` is the ENGINE subject: its identity is
`<RouteTableId>|<Destination>`, scoped to this stack's own route table, so the
re-create is deterministic. `EC2Provider.createRoute`'s multi-destination warn
arm is gated on exactly the same `CreateContext.replayingState` flag (the
callback is passed only when `context?.replayingState === true`), so it
exercises the identical engine path.

The GlobalTables and the S3 bucket are the PER-PROVIDER subjects: whether each
provider's replay-CREATE arm answers with a bag `readCurrentState` can match.
Issue [#1706](https://github.com/go-to-k/cdkd/issues/1706) adds two of them:

- **`StreamTable`** (`AWS::DynamoDB::GlobalTable`): the record's
  `StreamSpecification` becomes a string, the replay substitutes and sends the
  `NEW_AND_OLD_IMAGES` default, and the record must hold
  `{StreamViewType: NEW_AND_OLD_IMAGES}` — the CFn shape, with no
  `StreamEnabled`. v1 deploys `KEYS_ONLY` so the live read can tell the
  substituted value from the original.
- **`ReplayBucket`** (`AWS::S3::Bucket`): the record's `VersioningConfiguration`
  becomes a string, the replay skips `PutBucketVersioning`, and the record must
  drop the key. The bucket re-acquires its just-deleted v1 name; S3's
  `conflicting conditional operation` during the name release is waited out by
  the reverse-replacement's name-cooldown retry (issue #2116), whose budget is
  bounded — a slower release would fail phase 3 on this resource's line.

## Phases

| # | Step | Assertion |
|---|------|-----------|
| 1 | Deploy v1 (`DestinationCidrBlock: 0.0.0.0/0`) | state records the one destination key |
| 2 | Doctor state: add `DestinationIpv6CidrBlock: ::/0` to the route; malformed values into each table's record; `StreamSpecification: ""` + `BillingMode: ""` into `StreamTable`'s and `VersioningConfiguration: "Enabled"` into `ReplayBucket`'s | every injection took (else every later assertion is vacuous) |
| 3 | Deploy v2 — create-only flips (route destination, table names, bucket name) **plus** an injected SQS failure that `DependsOn` every subject | deploy exits non-zero, each subject logs its own `replacement reversed` line, and every replay-CREATE downgrade warning fired (proving the arms ran) |
| 4 | **The point** | post-rollback record has `DestinationCidrBlock` restored and `DestinationIpv6CidrBlock` **gone**; the stream table records the substituted view type (composed with the substituted `BillingMode`) and streams with it; the bucket records no versioning and is unversioned |
| 5 | `cdkd drift` twice | both converge — the user-visible consequence |
| 5b | `cdkd diff --json` twice | the v1 template lists the stream table and the bucket; a template describing the live resources lists neither |
| 6 | Destroy | 0 orphans, state gone |

Phase 4 is what fails against a pre-#1682 binary: the record would still carry
the key the provider warned it was dropping and never sent to AWS.

## Opt-in cross-region arm (issue #1741, second instance)

`CDKD_INTEG_MULTI_REGION=1` adds a fourth `AWS::DynamoDB::GlobalTable` whose
second replica (`GT_XR_REPLICA_REGION`, default `eu-west-1`) carries a
per-index read ceiling for `gsi1`. Its record gets the same malformed index
blob as the omit table, so the replay creates a table with no indexes and then
adds the cross-region replica. Before the fix, the override for the index the
create had just omitted was still sent and recorded, although the table has no
such index and the re-created replica holds no override. The arm also depends
on issue #3569: the rollback re-adds the replica while v1's copy in the replica
region can still be deleting.

| # | What the arm adds |
|---|-------------------|
| 1 | the replica's `gsi1` override is live (read back from `DescribeTable`) |
| 2 | only the top-level blob is doctored; the replica override stays recorded |
| 3 | the table took the reverse-replacement arm, and the withdrawal was announced |
| 4 | record: no index block anywhere, both replicas kept, only `pk` defined; live: 0 indexes, replica `ACTIVE`, no override |
| 5 | drift counts one more resource, and the local replica is compared too (issue #3573: the readback used to drop it) |
| 6 | both table names gone, in the deploy region and in the replica region |

Replicas take minutes to create and delete, so the arm takes the run from
~3 min to ~12-20 min; `/run-integ`'s default watchdog is enough.

## Running

```bash
/run-integ rollback-replay-effective-props
# with the cross-region arm:
CDKD_INTEG_MULTI_REGION=1 /run-integ rollback-replay-effective-props
```

The fixture intentionally creates a failed deploy, so the `EXIT`/`INT`/`TERM`
trap sweeps by the `cdkd:integ-fixture` tag in addition to the state-based
destroy.
