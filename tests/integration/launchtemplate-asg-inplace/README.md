# launchtemplate-asg-inplace

Regression integ for two bugs:

- **Issue #985**: an in-place UPDATE that changes a `Fn::GetAtt`-consumed
  derived attribute must propagate to a dependent that the diff would
  otherwise classify `NO_CHANGE`, in the SAME deploy.
- **Issue #1160** (ASG batch): a property REMOVED from the template must be
  reset to its CFn default on UPDATE — `UpdateAutoScalingGroup` has merge
  semantics (absent = unchanged), so pre-fix the old live value silently
  survived the removal.

The fixture is a VPC + `ec2.LaunchTemplate` + `autoscaling.AutoScalingGroup`.
CDK renders the ASG's `LaunchTemplate.Version` as
`Fn::GetAtt [Lt, LatestVersionNumber]`. Toggling `CDKD_TEST_UPDATE=true` changes
only the LaunchTemplate's `instanceType` (t3.micro -> t3.small), which bumps the
LaunchTemplate's computed `LatestVersionNumber` from 1 to 2.

Pre-fix (#985), the ASG's raw template did not change and the diff-time
resolution saw the pre-update version "1", so the ASG was classified
`NO_CHANGE` and stayed pinned at version "1" — it only caught up on the NEXT
deploy (one deploy behind).

For the #1160 leg, phases 1-2 set non-default `HealthCheckGracePeriod` (90) /
`MaxInstanceLifetime` (604800) / `TerminationPolicies` (`['OldestInstance']`)
on the ASG; toggling `CDKD_TEST_REMOVAL=true` keeps the phase-2 instance type
and drops those three properties from the template.

`desiredCapacity` / `min` / `max` are all 0 so no EC2 instances launch — the
deploy is cheap and the destroy is fast (no instance teardown wait).

## What verify.sh asserts

1. Phase 1: the LaunchTemplate is at version 1, the ASG's live
   `LaunchTemplate.Version` (`aws autoscaling describe-auto-scaling-groups`) is
   "1", and the three non-default ASG properties are live.
2. UPDATE phase (`CDKD_TEST_UPDATE=true`, changes only `instanceType`): the
   LaunchTemplate advances to version 2 AND the ASG's live
   `LaunchTemplate.Version` is "2" in the same deploy — NOT "1" (the #985
   one-deploy-behind symptom). The three non-default ASG properties pass
   through unchanged (kept fields are never spuriously reset).
3. REMOVAL phase (`CDKD_TEST_REMOVAL=true`, drops the three ASG properties):
   the live values return to the CFn defaults — `HealthCheckGracePeriod` 0,
   `MaxInstanceLifetime` cleared, `TerminationPolicies` `['Default']` (the
   issue #1160 assertion).
4. Clean destroy (ASG gone, LaunchTemplate gone, state gone).

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
