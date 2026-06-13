# conditions-update-2

Integration test for the **harder CloudFormation-Conditions-on-UPDATE
semantics** that the sibling `conditions-and-if` fixture does NOT cover.
`conditions-and-if` surfaced bug #840 — a resource whose `Condition:` flipped
`true -> false` on redeploy was never deleted. The #840 fix
(`TemplateParser.filterResourcesByCondition`) prunes condition-false resources
from the effective template before the diff. This fixture asserts the remaining
condition-on-UPDATE corner cases, each a distinct way the prune step can still
be wrong.

Stack: `CdkdConditionsUpdate2Example`.

## What it exercises

### Cheap resources (no NAT / no VPC)
- 4x `AWS::SSM::Parameter`, 2x `AWS::SQS::Queue`.

### 1. Resource MOVES conditions on update
- `MoverParam` — `Condition: IsPhaseA`. PRESENT in phase a, condition-false in
  phase b -> must be **DELETED** (the #840 flip-to-false case, re-asserted).
- `AppearParam` — `Condition: IsPhaseB`. The reverse: ABSENT in phase a,
  **CREATED** on the phase-b redeploy (absent -> present).

### 2. Fn::If -> AWS::NoValue removing a nested property block on UPDATE
- `WorkQueue.RedrivePolicy` — `Fn::If(IsPhaseA, { ... }, AWS::NoValue)`. The
  nested JSON block (DLQ target + `maxReceiveCount`) is SET in phase a and
  REMOVED in phase b. The queue is NOT replaced (same physical id), so this is
  the in-place `provider.update()` dropping a whole nested block — not the
  create-time omission `conditions-and-if`'s SNS `DisplayName` covered.

### 3. Condition-gated OUTPUT
- `MoverParamName` output — `condition: IsPhaseA`. Present in cdkd state outputs
  in phase a, absent in phase b. Asserted by reading the cdkd state file
  `outputs` map directly.

### 4. DependsOn referencing a condition-EXCLUDED resource
- `KeeperParam` (always present) `DependsOn MoverParam`. In phase b `MoverParam`
  is pruned, so the `DependsOn` dangles — cdkd must DROP it (like CloudFormation)
  and still deploy/update `KeeperParam`.

### 5. Ref to a condition-excluded resource inside a condition-false resource
- `RefHolderParam` (`Condition: IsPhaseA`) has a `Value` that `Ref`s
  `MoverParam` (also `Condition: IsPhaseA`). In phase b BOTH are pruned together,
  so the surviving template carries no dangling `Ref` — assert no crash.

## Driving both phases

cdkd has no deploy-time `--parameter` flag — parameters resolve from the
template `Default`. The `Phase` `CfnParameter` default is read from CDK context
(`-c phase=a|b`) at synth time, so flipping the context between the two
`cdkd deploy` runs flips every condition. The same stack is redeployed in place.

## Run

```bash
# from repo root
vp run build
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 \
  tests/integration/conditions-update-2/verify.sh
```

Or via the skill: `/run-integ conditions-update-2`.

## Phases (verify.sh)

1. **Phase A — `-c phase=a`**: `MoverParam`/`RefHolderParam` PRESENT,
   `AppearParam` ABSENT, `WorkQueue` `RedrivePolicy` SET, `MoverParamName`
   output PRESENT.
2. **Phase B — `-c phase=b` (redeploy in place)**: `MoverParam`/`RefHolderParam`
   DELETED, `AppearParam` CREATED, `WorkQueue` `RedrivePolicy` GONE (same queue),
   `MoverParamName` output ABSENT, `KeeperParam` still up + updated (dangling
   `DependsOn` dropped).
3. **Phase C — destroy + clean**: all AWS resources gone, state file gone.
