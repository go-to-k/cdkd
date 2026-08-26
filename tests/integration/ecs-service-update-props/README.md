# ECS Service UPDATE-props Example (issues #975 + #1160)

An integration test that verifies `AWS::ECS::Service` property changes reach
AWS via `ECSProvider.updateService()` for two silent-drop classes: a CHANGED
field (#975) and a REMOVED field (#1160).

## Background

Before the #975 fix, `updateService()` never mapped `EnableECSManagedTags`,
`PropagateTags`, `LoadBalancers`, or `ServiceRegistries` into
`UpdateServiceCommand`. All four are in the provider's `handledProperties`
allow-list, so the resource stayed SDK-routed and `cdkd diff` correctly
detected a change — but deploy went green and state.json recorded the NEW
value while AWS silently kept the OLD value (a poisoned-state silent drop,
same class as #951 / #952).

The #1160 fix closes the mirror-image case: a field REMOVED from the template.
`UpdateService` uses merge semantics (an absent input field means "no change"),
so `updateService()` passing `undefined` for a dropped field silently kept the
old live value. The provider now resets each removed field to its
CloudFormation default (live-probed 2026-07-22): `PlatformVersion` -> `LATEST`,
`HealthCheckGracePeriodSeconds` -> `0`, `PropagateTags` -> `NONE`,
`EnableECSManagedTags` / `EnableExecuteCommand` -> `false`, and
`CapacityProviderStrategy` / `PlacementConstraints` / `PlacementStrategies` ->
empty array. Removing the WHOLE `DeploymentConfiguration` deliberately resets
NOTHING — that was live-probed as CloudFormation parity (PR #1805), so a reset
there would be the divergence. One level DOWN is different: dropping an
OPTIONAL member of a still-declared `DeploymentCircuitBreaker`
(`ResetOnHealthyTask`, `ThresholdConfiguration`) IS a removal CloudFormation
applies, and the provider now resets those two to their AWS defaults
(`true` / `{BOUNDED_PERCENT, 50}`) — issue #1861, exercised by phases 2 and 2c
below.

The #609 Service-property backfill emptied the `AWS::ECS::Service`
silent-drop set (AvailabilityZoneRebalancing / DeploymentController /
ForceNewDeployment / Monitoring / Role / ServiceConnectConfiguration /
VolumeConfigurations / VpcLatticeConfigurations are now handled by
`ECSProvider`), so every Service is SDK-routed. This fixture live-covers the
cheap members (see Phases below); the sibling `ecs-fargate` fixture covers
the SDK-routed delivery of `ServiceConnectConfiguration` +
`VolumeConfigurations`. The `provisionedBy != cc-api` guard remains so a
future silent-drop regression can't flip the route back and make the test
pass for the wrong reason.

### Not exercised live (#609) — unit-pinned instead

The following stay unit-only (exact SDK wire spellings + both update
polarities pinned in
`tests/unit/provisioning/ecs-service-config-props.test.ts`), because each
needs expensive/out-of-scope infrastructure this fixture deliberately avoids:

- **PlacementStrategies** — needs an EC2 launch type (container instances);
  already wired pre-#609 (issue #613 alias handling).
- **VpcLatticeConfigurations** — needs VPC Lattice target-group plumbing +
  an infrastructure role.
- **DeploymentController: CODE_DEPLOY** — needs CodeDeploy application /
  deployment-group plumbing; the explicit `{Type: ECS}` form IS live-covered
  here.
- **Role** — needs a classic ELB setup (legacy service role); create-only
  pass-through + replacement classification are unit-pinned.
- **Monitoring read-back** — `DescribeServices` returns no `monitoring`
  member, so only CreateService ACCEPTANCE is live-provable (done here: a
  mis-flipped required member like `metricNames` would fail the deploy).

## Resources

- **VPC**: Minimal VPC with 1 AZ and a public subnet (no NAT gateway)
- **ECS Cluster**: plain Fargate cluster (no Cloud Map / Service Connect)
- **Fargate Task Definition**: single container using a public ECR image
- **Fargate Service**: `desiredCount: 0` (no containers run), plain (SDK-routed)
- **CloudWatch Log Group**: container log streaming (`RemovalPolicy.DESTROY`)

## Phases (verify.sh)

1. **Phase 1 (base)**: deploy with `EnableECSManagedTags: false`,
   `PropagateTags: NONE`, `PlatformVersion: 1.4.0`,
   `HealthCheckGracePeriodSeconds: 30`, plus the #609 members
   `AvailabilityZoneRebalancing: ENABLED`, `DeploymentController: {Type: ECS}`,
   `Monitoring` (60s default resolution) and a `ForceNewDeployment` nonce
   (all via the L1 escape hatch); assert `describe-services` shows them
   (`availabilityZoneRebalancing=ENABLED`; the controller may legitimately be
   omitted for the ECS default per the API docs), assert the deploy-time
   `observedProperties` captured `AvailabilityZoneRebalancing` +
   `DeploymentController.Type=ECS` (the reader's fallback), assert
   `cdkd drift` reports no phantom drift on any #609 member, and assert the
   Service is SDK-routed (`provisionedBy != cc-api`) so the test can't pass
   for the wrong reason.
2. **Phase 2 (update)**: redeploy with `CDKD_TEST_UPDATE=true` flipping to
   `enableECSManagedTags: true` / `propagateTags: TASK_DEFINITION` (#975) AND
   dropping `PlatformVersion` / `HealthCheckGracePeriodSeconds` (#1160); assert
   the #975 changes reach AWS AND the #1160 removals reset to `LATEST` / `0`.
3. **Phase 2b (force-nonce)**: redeploy with
   `CDKD_TEST_UPDATE=true,force-nonce` — the template is identical to phase 2
   except the `ForceNewDeployment.ForceNewDeploymentNonce` bump; assert a
   fresh rollout appeared (`deployments[0].id` changed), proving the
   object-to-`forceNewDeployment: true` translation (#609).
4. **Phase 2c (never-declared arm, #1861)**: the two optional
   `DeploymentCircuitBreaker` members have been undeclared since phase 2, so
   set them OUT OF BAND via `aws ecs update-service`
   (`resetOnHealthyTask: false`, `thresholdConfiguration: {COUNT, 9}`), assert
   that write landed, then redeploy with
   `CDKD_TEST_UPDATE=true,force-nonce,cb-rollback` — identical to phase 2b
   except `DeploymentCircuitBreaker.Rollback` flips back on, so the ONLY
   property change is inside the block. Assert the flip applied, then assert
   the out-of-band values SURVIVED. This is the arm that DISCRIMINATES the
   previous-present / current-absent removal rule from "re-serialize the
   struct whenever its declared content changed": both fit phase 2, only the
   removal rule fits this. Clobbering the members here would be a divergence
   in the opposite direction, destroying a value CloudFormation preserves.
5. **Phase 3 (destroy)**: destroy and assert the state file is gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```

Or via the skill: `/run-integ ecs-service-update-props`.
