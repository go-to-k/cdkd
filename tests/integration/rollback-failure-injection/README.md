# rollback-failure-injection

Integration test fixture for the cdkd **deploy-engine rollback path** on a
RICH multi-resource stack — the deploy-engine rollback regression net.

## Background

When one resource fails mid-deploy, cdkd rolls back the resources it already
created (best-effort, dependency-ordered: CREATE → delete, UPDATE → restore,
DELETE → cannot roll back). The only existing real-AWS rollback coverage is
the trivial `basic` single-SQS `CDKD_TEST_FAIL` injection, which has nothing
for rollback to delete except one queue. This fixture exercises rollback when
**several interdependent siblings have already completed** before the failure
fires, so rollback has real work: tear down a VPC + Subnets + SecurityGroup +
an IAM Role + a Lambda-in-VPC + an SSM Parameter, leaving NO orphans (no
leftover hyperplane ENIs / SGs / the VPC).

It also asserts the issue
[#808](https://github.com/go-to-k/cdkd/issues/808) deployment-events failure
path that the `deployment-events` fixture explicitly left as a follow-up:
`RESOURCE_FAILED` + `ROLLBACK_*` events + `RUN_FINISHED result=FAILED`.

## Fixture

`CdkdRollbackFailureExample` (`lib/rollback-failure-stack.ts`):

- `AWS::EC2::VPC` (1 AZ, 1 NAT GW, public + private subnets) + `AWS::EC2::SecurityGroup`
- `AWS::IAM::Role` (Lambda execution role) + managed-policy attachment
- `AWS::Lambda::Function` deployed in the VPC private subnet
- `AWS::SSM::Parameter` (`CdkdRollbackFailureExample-marker`)

### Self-contained failure injection

Unlike `basic` (which reuses the `CDKD_TEST_FAIL` plumbing), this fixture
defines its OWN failing resource gated on `ROLLBACK_INTEG_FAIL=true`: an SQS
Queue with `messageRetentionPeriod: 9999999` (valid range is `[60, 1209600]`,
so AWS rejects `CreateQueue`). The failing queue is wired to **depend on the
fast siblings** (the IAM Role + SSM Parameter). cdkd's event-driven DAG
dispatches a node only once all its deps finish, so the Role + Parameter are
guaranteed COMPLETE before the queue is even attempted — guaranteeing rollback
has already-created siblings to delete. The slow VPC / Lambda branch runs in
parallel and is also rolled back.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. Install + build cdkd (root) + fixture deps (`pnpm install --ignore-workspace`).
2. **Deploy with `ROLLBACK_INTEG_FAIL=true`** → assert the deploy exits
   **non-zero**.
3. Assert the completed siblings were **rolled back** (queried directly
   against AWS): the SSM Parameter / SecurityGroup / VPC are gone, no failing
   queue lingers, and cdkd state reflects rollback (`state.json` removed, or
   present with `0` resources). No leftover hyperplane ENIs / SGs / VPC.
4. Assert the #808 events captured the failure: `cdkd events ... --format json`
   shows the newest run is a `FAILED` `deploy`; its per-run stream has a
   `RESOURCE_FAILED` for `AWS::SQS::Queue`, `ROLLBACK_STARTED` +
   `ROLLBACK_RESOURCE_SUCCEEDED` events, and `RUN_FINISHED result=FAILED`.
5. **Deploy with the flag OFF** → succeeds (VPC + SSM Parameter created) →
   `cdkd destroy --force` → assert clean (state gone, 0 orphan VPC/SG/SSM).
6. Remove the events sidecar (`aws s3 rm s3://$STATE_BUCKET/cdkd/$STACK/
   --recursive`) so the integ leaves nothing behind.
7. An EXIT trap performs **aggressive** orphan cleanup on the failure path
   (this test intentionally creates a failed deploy): delete the SSM Parameter,
   failing SQS queue, any Lambda / IAM Role tagged with the fixture's
   `aws:cdk:path`, and the VPC + its dependents (ENIs first, then NAT GW / SGs /
   subnets / IGW / route tables / VPC).

```bash
STATE_BUCKET=cdkd-state-<accountId> \
  bash tests/integration/rollback-failure-injection/verify.sh
```

Run it via `/run-integ rollback-failure-injection` like any other fixture.

## The cdkd flags used

```bash
# Phase 1: inject the failure (expect non-zero exit)
ROLLBACK_INTEG_FAIL=true cdkd deploy CdkdRollbackFailureExample --state-bucket "$STATE_BUCKET"

# Read the failure events back
cdkd events CdkdRollbackFailureExample --state-bucket "$STATE_BUCKET" --stack-region "$REGION" --format json
cdkd events CdkdRollbackFailureExample --state-bucket "$STATE_BUCKET" --stack-region "$REGION" --run <runId> --format json

# Phase 2: clean deploy + destroy
cdkd deploy  CdkdRollbackFailureExample --state-bucket "$STATE_BUCKET"
cdkd destroy CdkdRollbackFailureExample --state-bucket "$STATE_BUCKET" --force
```

`--format json` is equivalent to `--json`. `--stack-region` is passed
explicitly for determinism (with it omitted, `cdkd events` auto-discovers the
region from the `deployments/` key listing).
