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
`InvalidParameterException`. When AWS says the refusal is for deletion
protection, cdkd adds a line under the failure saying so and naming
`--remove-protection`:

```text
✗ Failed to delete UserPool: "ProvisioningError: Failed to delete Cognito User Pool UserPool: InvalidParameterException. ..."
    AWS refused the delete because deletion protection is on for this resource. Re-run the destroy with --remove-protection to turn it off and delete it.
```

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
- **Route 53 resource record set protection.** The flag does not remove it.
  The protection is set outside the template, and no CloudFormation property
  declares it. A protected record set fails its delete, and its state record
  is kept. A hosted zone holding any protection fails its delete too. The
  error says the protection is the cause. Remove the protection with the
  Route 53 `DeleteResourceRecordSetProtections` API, then re-run the destroy.

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

## Auto Scaling groups with running instances

AWS deletes an Auto Scaling group without `ForceDelete` only when the group
is empty. Without `--remove-protection`, when AWS refuses the delete because
the group still has instances, cdkd sets the group's minimum, maximum and
desired capacity to `0`, waits for the instances to terminate, and then
deletes the group. This matches CloudFormation. The instances terminate the
normal way, so termination lifecycle hooks run.

A group that is already empty is deleted with a single call, after the
[identity check](#the-group-must-be-the-one-the-stack-created). The scale-in applies to every delete of a group, a deploy's
replacement and a rollback included. It needs
`autoscaling:DescribeAutoScalingGroups` and
`autoscaling:UpdateAutoScalingGroup` beside
`autoscaling:DeleteAutoScalingGroup`.

cdkd waits up to 15 minutes for the instances to terminate, then up to
15 minutes for the group to be gone. The first wait is cut to what the
[per-resource timeout](cli-deploy-tuning.md#per-resource-timeout) leaves
(30 minutes by default), and cdkd sends no delete once that timeout has run
out.

### When cdkd does not scale the group in

cdkd changes nothing on the group, and the delete fails, in these cases:

- **The group's `DeletionProtection` is `prevent-force-deletion` or
  `prevent-all-deletion`.** cdkd reports the error AWS returned, as before.
  Emptying the group would get round protection that exists to stop its
  instances from being terminated together.
- **The group of that name is not the one the stack created.** See
  [below](#the-group-must-be-the-one-the-stack-created).
- **An instance is protected from scale in, is in `Standby`, or is retained
  (`Terminating:Retained`, held by the group's instance lifecycle policy).**
  Scaling the group to `0` would never terminate it. The error names each such
  instance.
- **The group has a warm pool that is not being deleted.** A delete without
  `ForceDelete` cannot remove it.

With `--remove-protection`, `cdkd destroy` and `cdkd state destroy` delete the
group with `ForceDelete=true` instead, which terminates every instance,
protected or not, and skips termination lifecycle hooks.

### When the delete fails after the scale-in

The delete fails while the group drains, and names the instances left, in
these cases:

- every instance still in the group is protected from scale in, in
  `Standby` or retained (one such instance among others that are still
  terminating is waited for until the 15 minutes run out);
- the group's capacity is raised again while it drains, for example by a
  scheduled action (seen on two reads in a row);
- the 15 minutes or the per-resource timeout run out, for example because a
  termination lifecycle hook still holds an instance.

The group then stays at capacity `0`, and cdkd does not put the old capacity
back. The error states the minimum, maximum and desired capacity the group
had before cdkd scaled it in. Only the first failed delete can state it: a
re-run finds the group already at `0`, so its error has no capacity to
report. Note the values from the first error.

In `cdkd destroy` the group's state record is kept, and a re-run continues
the delete. In a deploy (a replacement that deletes the old group first, or a
group removed from the template) or a rollback, the state record can keep
the old capacity while the live group is at `0`, so a later deploy of the
same template shows no change for it. To bring the group back, run
`cdkd drift --revert` on the stack, which sets the recorded capacity back,
or set the capacity from the error by hand with
`aws autoscaling update-auto-scaling-group`.

### The group must be the one the stack created

When the state record holds the group's ARN, every delete of the group
checks it against the live group of that name first, with or without
`--remove-protection`. If the ARNs differ, the group was deleted and created
again outside cdkd, or the name belongs to a group in another region. cdkd
then changes nothing and the delete fails. With `--remove-protection`, the
check comes before any protection is turned off, and a failed read fails the
attempt instead of deleting by name. When a failed delete would put a
protection back, cdkd checks the group again first and leaves a group that
is no longer the stack's untouched.

The plain delete reads the group once (`DescribeAutoScalingGroups`) for this
check. A record written without an ARN (by an older cdkd) has nothing to
compare, so it keeps deleting the group by name, without the extra read.

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
