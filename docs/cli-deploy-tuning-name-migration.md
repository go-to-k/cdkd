---
title: "cdkd deploy: names prefixed before v0.94.0"
description: "Why the first cdkd deploy on v0.94.0 or later proposes to replace resources whose declared names an older cdkd prefixed with the stack name, and the three ways to handle it."
---

# cdkd deploy: names prefixed before v0.94.0

If a stack was first deployed with a cdkd older than v0.94.0, the first deploy
on v0.94.0 or later can propose to replace some of its resources. This page
explains why, and gives the three ways to handle it.

Changed in v0.94.0: cdkd uses a name you declared in CDK code as written.
Earlier versions put the stack name in front of it for these types: IAM Role,
User, Group, InstanceProfile and ManagedPolicy, and ELBv2 LoadBalancer and
TargetGroup.

## Why the deploy proposes replacements

Take this role in a stack named `MyStack`:

```ts
new iam.Role(this, 'DeployRole', {
  roleName: 'my-role',
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
```

An older cdkd created it as `MyStack-my-role`. On v0.94.0 or later the same
template means `my-role`. A name cannot change in place, so cdkd proposes to
replace the role. The same applies to every affected resource in the stack.

## Three ways to handle it

The options are listed from the most conservative to the least.

| Option | Effect |
| --- | --- |
| Pass [`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names) for that stack | Nothing in AWS changes. |
| Accept the replacement | One replacement per affected resource, after the prompt below. |
| Remove the explicit `roleName`, `userName` and so on from your CDK code | Also one replacement, and CDK generates a stable name from then on. |

To keep the old names without passing the flag on every deploy, set it in
`cdk.json`:

```json
{
  "context": {
    "cdkd": { "prefixUserSuppliedNames": true }
  }
}
```

## The confirmation prompt

Before it calls AWS to change anything, `cdkd deploy` lists the resources
that would be replaced and asks:

```text
WARNING: --no-prefix-user-supplied-names will REPLACE 2 resource(s) whose
AWS physical name is still prefixed with the stack name:
  - MyRole (AWS::IAM::Role): from MyStack-my-role to my-role
  - MyLb (AWS::ElasticLoadBalancingV2::LoadBalancer): from MyStack-my-lb to my-lb
These resources will be REPLACED because the new naming convention drops
the stack-name prefix.

Continue? (y/N):
```

The prompt defaults to no. If you decline, the deploy exits and nothing is
modified. Pass `-y` / `--yes` to confirm the prompt in CI. Without it, cdkd
refuses a run that has no terminal.

The stack lock is held while the prompt is open, and declining releases it.

## Which resources are listed

A resource is listed only when its physical name is exactly the prefixed form
of the name you declared.

- A name that you built from the stack name yourself, such as
  `` roleName: `${this.stackName}-role` ``, was already used as written. It is
  not listed.
- The check does nothing on a first deploy, on a stack that never used the
  prefix, or when `--prefix-user-supplied-names` is set.

## Related

- [cdkd deploy: tuning](cli-deploy-tuning.md#prefix-user-supplied-names): the flag and where to set it
- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): the other guards around replacements
