# ALB listener rule update

Exercises `AWS::ElasticLoadBalancingV2::ListenerRule`, which cdkd updates
through Cloud Control (Refs #6663). One internet-facing ALB in a two-AZ VPC
with public subnets only (no NAT gateway), a listener with a fixed-response
default action, and two rules: RuleA with a path and an HTTP header condition, RuleB with a host
and a path condition. CDK synthesizes both in the `PathPatternConfig` /
`HostHeaderConfig` / `HttpHeaderConfig` form.

Cloud Control's read model carries each such condition twice (the legacy
`Values` too), and `ModifyRule` refuses both spellings together, so before the
fix any update that did not change the conditions failed.

`verify.sh` deploys, then redeploys with `CDKD_TEST_UPDATE=true` (RuleA's
message body and RuleB's priority change, the conditions do not) and checks
both reached AWS with the conditions intact. It then changes RuleA's action
and priority out of band, runs `cdkd drift` (both reported) and
`cdkd drift --revert`, and checks the live rule is back and `cdkd drift` is
clean. It then destroys the stack and checks that the load balancer, VPC and state
are gone.

Build the repository first. The maintainer runs this fixture via `/run-integ
alb-listener-rule-update`, with `STATE_BUCKET` and `AWS_REGION` set. It
deploys real AWS resources and is not run as part of the local unit checks.
