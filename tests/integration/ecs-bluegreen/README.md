# ecs-bluegreen

Real-AWS coverage for ECS Service `LoadBalancers[].AdvancedConfiguration`
(the built-in blue/green deployment shape) — issue #1480, follow-up to the
#1473 silent-drop fix.

## What it proves

- `DeploymentConfiguration.Strategy: BLUE_GREEN` and the whole
  `AdvancedConfiguration` block (AlternateTargetGroupArn /
  ProductionListenerRule / TestListenerRule / RoleArn) reach real AWS via
  cdkd's SDK-routed `ECSProvider.createService()` — asserted by reading the
  service back with `describe-services` and comparing every member against
  the exact resources this run created (from cdkd state outputs, never name
  guesses).
- Clean destroy with 0 orphans across the ALB / target-group / listener-rule
  / infra-role / VPC teardown order.

## Deliberate scope

- `desiredCount: 0` — no task ever launches; the run costs a few minutes of
  an idle internal ALB.
- No UPDATE phase: the UpdateService forward of the same block is pinned by
  unit tests (`ecs-provider.test.ts`, issue #1473); the create-side
  real-AWS reach plus clean teardown is what a fixture uniquely adds
  (decision recorded on issue #1480).
- The `LoadBalancers` block is injected via the L1 escape hatch because the
  ECS L2 does not model `AdvancedConfiguration`; explicit
  `node.addDependency` edges stand in for the references CDK cannot trace
  through the override.

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
