# update-policy-mutations

Real-AWS integration test for cdkd's **UPDATE-time handling of
CloudFormation template-level attributes that change between deploys** —
`DeletionPolicy`, `UpdateReplacePolicy`, and `DependsOn` mutations, plus
metadata-only no-ops and orphan-on-replace. These update-diff edge cases
are under-tested by the existing fixtures (`update-replace` covers
property mutations; `deletion-policy-retain` covers a single-deploy
Retain skip — neither exercises an attribute that *changes* across two
deploys).

The two deploys are driven by a **CDK context flip** (`-c phase=a` then
`-c phase=b`), read at synth time (`this.node.tryGetContext('phase')`) so
the second deploy synthesizes a mutated template with no source change.

Cheap resources only (S3 / SSM / SNS — no VPC, no Lambda, no Custom
Resources), so each assertion isolates the policy / replacement behavior
from unrelated destroy-path code.

## What it tests

| # | Case | Resource | phase a -> phase b | Assertion |
| --- | --- | --- | --- | --- |
| 1 | `UpdateReplacePolicy: Retain` orphan-on-replace | `RetainReplaceBucket` (`AWS::S3::Bucket`, `RemovalPolicy.RETAIN`) | `BucketName` suffix `-phase-a` -> `-phase-b` (a replacement trigger) | OLD physical bucket still exists on AWS AND new bucket exists |
| 2 | `DeletionPolicy` flip on update | `PolicyFlipParam` (`AWS::SSM::Parameter`) | `RemovalPolicy.DESTROY` -> `RemovalPolicy.RETAIN` (value unchanged) | final destroy (under phase-b state) leaves the parameter on AWS |
| 3 | `DependsOn` add / remove on update | `DependsOnAdd{A,B}` + `DependsOnRemove{A,B}` (`AWS::SNS::Topic`) | add `AddB->AddA`; remove `RemoveB->RemoveA` | update succeeds; both topics keep their physical id (ARN) — DependsOn change does NOT trigger replacement |
| 4 | metadata-only / no-op update | whole stack | identical redeploy | cdkd reports `No changes detected` (no spurious update/replace) |

`BucketName` is in the S3 entry of cdkd's replacement-rules registry
(`src/analyzer/replacement-rules.ts`), so case 1's name change is
guaranteed to be classified as a REPLACEMENT (new physical id). Because
the bucket carries `UpdateReplacePolicy: Retain` (emitted by
`RemovalPolicy.RETAIN`), the OLD physical bucket must be LEFT on AWS — the
orphan-on-replace path in `deploy-engine.ts` (`Retaining old ... -
UpdateReplacePolicy: Retain`).

## Intentional orphans

This test creates orphans **by design** — the Retain-replaced old bucket
(case 1) and the phase-b Retain SSM parameter + phase-b Retain bucket
(case 2 / the current Retain bucket) survive `cdkd destroy`. The
`verify.sh` trap deletes **every** captured / deterministic physical id
(both bucket phases, both SSM parameters) so the test leaves **0
orphans**. The final step asserts 0 leftovers via direct AWS API checks.

## Verify

```bash
export STATE_BUCKET="cdkd-state-<accountId>"
export AWS_REGION="us-east-1"
bash verify.sh
```

`verify.sh` (BSD-portable; captures the real exit code and requires the
explicit `All update-policy-mutations checks passed` line):

1. installs fixture deps + expects the cdkd binary at `../../../dist/cli.js`.
2. **phase a** deploy → captures the SNS topic ARNs from cdkd state +
   asserts the phase-a bucket + both SSM parameters exist.
3. **phase b** deploy → asserts (case 1) the new bucket exists AND the old
   bucket is retained; (case 3) both SNS topics keep their ARNs across the
   DependsOn add/remove.
4. **identical redeploy** → asserts (case 4) `No changes detected`.
5. **destroy** → asserts (case 2) `PolicyFlipParam` survives (phase-b
   Retain), `StableParam` is deleted (Delete policy), the phase-b bucket
   survives (Retain), and cdkd state is cleared.
6. deletes every intentional orphan by id and asserts **0 leftovers**.

Run via the skill: `/run-integ update-policy-mutations`.
