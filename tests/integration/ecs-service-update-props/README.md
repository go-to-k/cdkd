# ECS Service UPDATE-props Example (issue #975)

An integration test that verifies `EnableECSManagedTags` and `PropagateTags`
changes on an SDK-routed `AWS::ECS::Service` reach AWS via
`ECSProvider.updateService()`.

## Background

Before the #975 fix, `updateService()` never mapped `EnableECSManagedTags`,
`PropagateTags`, `LoadBalancers`, or `ServiceRegistries` into
`UpdateServiceCommand`. All four are in the provider's `handledProperties`
allow-list, so the resource stayed SDK-routed and `cdkd diff` correctly
detected a change — but deploy went green and state.json recorded the NEW
value while AWS silently kept the OLD value (a poisoned-state silent drop,
same class as #951 / #952).

This fixture is deliberately plain (no `ServiceConnectConfiguration` /
`VolumeConfigurations`) so the Service stays on cdkd's **SDK** provider path.
The sibling `ecs-fargate` fixture's Service routes via **Cloud Control**
(those two properties are silent-drops that flip it to the #614 CC fallback),
so it would NOT exercise the `updateService()` code path the #975 fix touches.

## Resources

- **VPC**: Minimal VPC with 1 AZ and a public subnet (no NAT gateway)
- **ECS Cluster**: plain Fargate cluster (no Cloud Map / Service Connect)
- **Fargate Task Definition**: single container using a public ECR image
- **Fargate Service**: `desiredCount: 0` (no containers run), plain (SDK-routed)
- **CloudWatch Log Group**: container log streaming (`RemovalPolicy.DESTROY`)

## Phases (verify.sh)

1. **Phase 1 (base)**: deploy with `EnableECSManagedTags: false`,
   `PropagateTags: NONE`; assert `describe-services` shows both, and assert the
   Service is SDK-routed (`provisionedBy != cc-api`) so the test can't pass for
   the wrong reason.
2. **Phase 2 (update)**: redeploy with `CDKD_TEST_UPDATE=true` flipping to
   `enableECSManagedTags: true` / `propagateTags: TASK_DEFINITION`; assert both
   reach AWS.
3. **Phase 3 (destroy)**: destroy and assert the state file is gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```

Or via the skill: `/run-integ ecs-service-update-props`.
