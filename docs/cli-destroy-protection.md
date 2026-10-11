---
title: "cdkd destroy: deletion protection"
description: "How cdkd destroy --remove-protection turns deletion protection off, what it does when that fails, and how to put the protection back."
---

# cdkd destroy: deletion protection

A resource with deletion protection on cannot be deleted until the protection
is turned off. `cdkd destroy` leaves protection alone by default, so AWS
rejects the delete and the destroy exits `2`. With `--remove-protection`, cdkd
turns the protection off and then deletes the resource.

```bash
cdkd destroy MyStack --remove-protection
cdkd state destroy MyStack --remove-protection -y   # without the CDK app
```

The types the flag covers are listed in
[the table on cdkd destroy](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy).
This page covers how the flag behaves and how the protection is put back after
a failed delete.

## What you see without the flag

cdkd sends the delete unchanged and reports the error AWS returns. For RDS and
Cognito that error is `InvalidParameterCombination` or
`InvalidParameterException`.

It makes no difference where the protection was turned on. Protection set in
the console or with the AWS CLI blocks the delete the same way as protection
set in your CDK code.

## How the flag behaves

One `--remove-protection` covers every supported type in the stack. There is
no per-type variant.

cdkd sends the call that turns protection off for every resource of a covered
type, whether or not protection is currently on. AWS accepts the call when the
protection is already off. A Cognito user pool is the exception; see
[below](#cognito-user-pools).

If the call that turns protection off fails, cdkd logs the failure at debug
level and still sends the delete. The delete then reports its own error, which
is the one you see.

### On rollback and deploy

- **`cdkd rollback --remove-protection`** does the same for the resources a
  rollback deletes.
- **A deploy's automatic rollback** never turns protection off.
- **`cdkd deploy` has no such flag.** A deploy that has to replace a protected
  resource fails at the delete, whatever replace flags you passed. Turn the
  protection off first; see
  [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md#deletion-protection-blocks-a-replacement-and-deploy-cannot-clear-it).

### Edge cases

- **A resource a failed deploy created but never recorded.** Such a resource
  is listed only in the rollback journal (see
  [Resources only the rollback journal records](cli-destroy-skipped.md#resources-only-the-rollback-journal-records)).
  The flag reaches it when cdkd can prove it is still the resource the failed
  deploy created. The proof rules are in
  [cdkd destroy internals](cli-destroy-internals.md#behaviour).

## Cognito user pools

Turning protection off on a user pool takes more care than on other types,
because the `UpdateUserPool` call resets every pool setting that the call
leaves out. Self sign-up, Lambda triggers and advanced security are among
them.

So cdkd reads the pool first and sends the pool's own settings back together
with `DeletionProtection='INACTIVE'`. That needs
`cognito-idp:DescribeUserPool` beside `cognito-idp:UpdateUserPool` and
`cognito-idp:DeleteUserPool`.

### Edge cases

- **The pool already reads `INACTIVE`.** cdkd sends no `UpdateUserPool`.
- **AWS refuses the settings on validation.** cdkd warns and turns the
  protection off without the other settings, so that the delete can run.
- **The pool cannot be read, or AWS refuses for another reason.** cdkd leaves
  the protection on and warns. The delete is then refused.
- **The delete fails after the protection was turned off.** cdkd turns the
  protection back on with the pool's own settings.

The remaining cases (an SES email configuration, throttles, a write that
timed out) are in
[cdkd destroy internals](cli-destroy-internals.md#cognito-user-pools).

## Restoring a guard after a failed destroy

When cdkd turned protection off and the delete then failed for good, cdkd
turns the protection back on before it reports the failure. A destroy that did
not happen therefore does not leave a live resource without its protection.

This covers every type in the table, and each instance that an Auto Scaling
group launched.

### When the protection is not put back

- **Protection was already off before the run.** cdkd leaves it off.
- **cdkd could not read the protection before turning it off.** It does not
  know what to put back, so it leaves the resource as it is.
- **AWS accepted the delete and a later wait gave up.** cdkd does not put the
  protection back, because the resource is already being deleted.
- **A Cloud Control delete ended without saying whether the resource is being
  deleted.** cdkd warns and prints the commands to check the resource and to
  put the protection back.
- **`--resource-timeout` fired.** The protection is left off.
- **The call that puts the protection back failed.** A separate `ERROR` line
  names the resource and the command to restore it.

### Permissions for the read

To know what to put back, cdkd reads the protection before it turns it off.
That read needs its own permission beside the ones for the change and the
delete. If the read is refused, the delete still runs, and nothing is put back
if it fails.

| Resource | Read permission |
| --- | --- |
| EC2 instance | `ec2:DescribeInstanceAttribute` |
| Load balancer | `elasticloadbalancing:DescribeLoadBalancerAttributes` |
| Auto Scaling group | `autoscaling:DescribeAutoScalingGroups`, plus `ec2:DescribeInstanceAttribute` for each instance it launched |
| A Cloud Control type | `cloudformation:GetResource`, plus whatever the type's read handler calls |

When putting an instance's protection back fails, cdkd reads the instance
with `ec2:DescribeInstances` to see whether it still exists. With that
permission, an instance that is shutting down or terminated is reported as a
warning. Without it, the failure is reported as an `ERROR`.

### Putting a guard back by hand

```bash
aws dynamodb update-table --table-name <table> --deletion-protection-enabled
aws rds modify-db-cluster --db-cluster-identifier <id> \
  --deletion-protection --apply-immediately
aws rds modify-db-instance --db-instance-identifier <id> \
  --deletion-protection --apply-immediately
aws logs put-log-group-deletion-protection --log-group-identifier <name> \
  --deletion-protection-enabled
aws cognito-idp update-user-pool --user-pool-id <id> \
  --deletion-protection ACTIVE
aws emr modify-cluster-attributes --cluster-id <id> --termination-protected
aws elbv2 modify-load-balancer-attributes --load-balancer-arn <arn> \
  --attributes Key=deletion_protection.enabled,Value=true
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name <name> \
  --deletion-protection <prevent-force-deletion|prevent-all-deletion>
aws ec2 modify-instance-attribute --instance-id <id> --disable-api-termination
aws cloudcontrol update-resource \
  --type-name AWS::DSQL::Cluster --identifier <id> \
  --patch-document '[{"op":"add","path":"/DeletionProtectionEnabled",
    "value":true}]'
aws cloudcontrol update-resource \
  --type-name AWS::VerifiedPermissions::PolicyStore --identifier <id> \
  --patch-document '[{"op":"add","path":"/DeletionProtection",
    "value":{"Mode":"ENABLED"}}]'
```

Adjust the commands for your case:

- **DocDB and Neptune** take the same `modify-db-cluster` /
  `modify-db-instance` form under `aws docdb` / `aws neptune`.
- **The other Cloud Control types** take the DSQL form, with their own
  property from the table and the value `true`.
- **An Auto Scaling group** goes back to the level it had. The line cdkd
  prints names that level.
- **A Cognito user pool** needs its complete configuration sent alongside
  `--deletion-protection`, because `update-user-pool` resets the settings it
  omits.
- **Your profile.** A command cdkd prints carries the run's `--profile`, or a
  `'<role-profile>'` placeholder when the run used `--role-arn`. When you type
  one of the commands above by hand, add your profile, or the command runs
  against your default profile.

## Related

- [cdkd destroy](cli-destroy.md) — the command, its options and the table of covered types
- [cdkd destroy: data guards and final snapshots](cli-destroy-guards.md) — the guards on data
- [cdkd destroy internals](cli-destroy-internals.md#remove-protection) — the exact rules behind this page
