# conditions-and-if

Integration test that SURFACES bugs in cdkd's CloudFormation **Conditions** +
**Fn::If** handling. cdkd must itself evaluate the `Conditions` section, the
resource-level `Condition:` key, and the `Fn::If` / `Fn::Equals` / `Fn::And` /
`Fn::Or` / `Fn::Not` intrinsics — there is no CloudFormation engine underneath
it. This fixture goes beyond the existing `conditions` fixture (which had no
verify.sh and only exercised a single `Fn::And` + one conditionally-created
bucket + an `Fn::If` bucket name).

Stack: `CdkdConditionsIfExample`.

## What it exercises

### Conditions section
- `Fn::Equals` on a `CfnParameter` (`IsPremium`, `IsPrimaryRegion`).
- `Fn::Not` (`IsSecondaryRegion = NOT IsPrimaryRegion`).
- `Fn::And` (`IsPremiumPrimary = IsPremium AND IsPrimaryRegion`).
- `Fn::Or` (`IsPremiumOrSecondary = IsPremium OR IsSecondaryRegion`).

### Cheap resources (no NAT / no VPC)
- 3x `AWS::SSM::Parameter`, 1x `AWS::SNS::Topic`.

### Condition-gated resource creation (`Condition:` key)
- `PremiumOnlyParam` — `Condition: IsPremium`. Created in premium, ABSENT in basic.
- `PremiumPrimaryParam` — `Condition: IsPremiumPrimary` (Fn::And). Created in
  premium+primary, ABSENT otherwise.

### Fn::If inside a resource property
- `TierLabelParam.Value` — `Fn::If(IsPremium, 'tier-is-premium', 'tier-is-basic')`.
  The resolved branch is asserted to have reached AWS.
- SNS topic `Tier` tag value — `Fn::If(IsPremium, 'premium', 'basic')`.
- SNS topic `PremiumOrSecondary` tag value — `Fn::If(IsPremiumOrSecondary, 'yes', 'no')`.

### Fn::If -> AWS::NoValue property omission
- SNS topic `DisplayName` — `Fn::If(IsPremium, 'Premium Notifications', AWS::NoValue)`.
  SET in premium, genuinely ABSENT on AWS in basic.

## Driving both settings

cdkd has no deploy-time `--parameter` flag — parameters resolve from the
template `Default`. The `Tier` `CfnParameter` default is read from CDK context
(`-c tier=premium|basic`) at synth time, so flipping the context between the two
`cdkd deploy` runs flips every condition. The same stack is redeployed in place,
so the verify asserts both the presence (premium) and absence (basic) of the
condition-gated resources and both `Fn::If` branches against real AWS.

## Run

```bash
# from repo root
vp run build
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 \
  tests/integration/conditions-and-if/verify.sh
```

Or via the skill: `/run-integ conditions-and-if`.

## Phases (verify.sh)

1. **Phase 1 — `-c tier=premium`**: gated resources PRESENT, `Fn::If` premium
   branches on AWS, `DisplayName` SET.
2. **Phase 2 — `-c tier=basic` (redeploy in place)**: gated resources now ABSENT,
   `Fn::If` basic branches on AWS, `DisplayName` OMITTED (`AWS::NoValue`).
3. **Phase 3 — destroy + clean**: all AWS resources gone, state file gone.
