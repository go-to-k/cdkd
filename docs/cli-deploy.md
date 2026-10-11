---
title: "Deploy: waits & concurrency"
description: "Every cdkd deploy flag and where it is documented, plus the concurrency flags, the wait modes, the per-resource-type wait table and the stack lock."
---

# Deploy: waits & concurrency

`cdkd deploy` creates or updates the stacks of a CDK app. This page lists every
deploy flag and documents two things you can tune: how many operations run at
once, and how long cdkd waits before it calls a resource done. It also covers
the stack lock and the cases where a deploy refuses to start.

```bash
cdkd deploy MyStack                    # default waits, default concurrency
cdkd deploy --all                      # every top-level stack
cdkd deploy MyStack --no-wait          # skip the stabilization waits
cdkd deploy MyStack --full-wait        # also wait everywhere CloudFormation waits
cdkd deploy MyStack --concurrency 20   # more parallel resource operations
cdkd deploy --all --stack-concurrency 8   # more stacks at once
```

## Options

The flags this page documents:

| Flag | Default | Description |
| --- | --- | --- |
| `--concurrency <number>` | `10` | Maximum concurrent resource operations per stack. |
| `--stack-concurrency <number>` | `4` | Maximum concurrent stack deployments. |
| `--asset-publish-concurrency <number>` | `8` | Maximum concurrent asset publishes (S3 uploads and ECR pushes). |
| `--image-build-concurrency <number>` | `4` | Maximum concurrent Docker image builds. |
| `--no-wait` | off | Skip the stabilization waits cdkd performs by default. |
| `--full-wait` | off | Also wait everywhere CloudFormation waits. |

`--no-wait` and `--full-wait` cannot be combined; cdkd rejects the pair before
any AWS call. Both apply to the whole run and cannot be scoped to one resource
type. `cdkd destroy` accepts neither.

### Every other `cdkd deploy` flag

| Flag | Default | Description | Documented on |
| --- | --- | --- | --- |
| `[stacks...]`, `--stack <name>` | the only stack | Stacks to deploy: CDK display paths with wildcards, or exact physical names. | [Selecting stacks](cli-list.md#selecting-stacks) |
| `--all` | `false` | Deploy every top-level stack. | [Selecting stacks](cli-list.md#selecting-stacks) |
| `-e`, `--exclusively` | `false` | Deploy only the requested stacks, without their dependencies. | this table |
| `--dry-run` | `false` | Show the changes without applying them. | this table |
| `--skip-assets` | `false` | Skip asset publishing. | this table |
| `--no-rollback` | rollback on | Leave a failed deploy in place and skip the automatic rollback. | [Rollback](rollback.md) |
| `--require-approval <level>` | `never` | Ask before `any-change` or `destructive` changes. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--no-auto-asset-storage` | auto-create on | Do not create cdkd asset storage on the first deploy into a region. | [`cdkd bootstrap`](cli-bootstrap.md#auto-create-on-first-deploy) |
| `--use-cdk-bootstrap-assets` | `false` | Publish to the CDK bootstrap bucket and repository. | [`cdkd bootstrap`](cli-bootstrap.md#asset-destinations-after-opt-in-cdkd-assets-mode) |
| `--no-capture-observed-state` | capture on | Skip recording the drift baseline. | [Deploy: tuning](cli-deploy-tuning.md#no-capture-observed-state) |
| `--prefix-user-supplied-names` | `false` | Prefix declared physical names with the stack name. | [Deploy: tuning](cli-deploy-tuning.md#prefix-user-supplied-names) |
| `--no-aggressive-vpc-parallel` | relaxation on | Keep CDK's defensive VPC route ordering. | [Deploy: tuning](cli-deploy-tuning.md#no-aggressive-vpc-parallel) |
| `--resource-warn-after <duration>`, `--resource-timeout <duration>` | `5m`, `30m` | Warn about, or abort, one slow resource operation. | [Deploy: tuning](cli-deploy-tuning.md#per-resource-timeout) |
| `--strict`, `--ignore-errors` | `false` | Fail on CDK warning annotations, or never fail on annotations. | [Deploy: tuning](cli-deploy-tuning.md#cdk-annotation-messages) |
| `--allow-unsupported-types <types>` | | Attempt types cdkd reports unsupported through Cloud Control. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--prefer-sdk-route <entries>` | | Keep a resource on the SDK provider when a property would route it to Cloud Control. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--recreate-via-cc-api <logicalId>`, `--recreate-via-sdk-provider <logicalId>` | | Destroy and recreate one resource on the other provisioning route. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--pin-cc-api <logicalId>` | | Keep one resource on the Cloud Control route. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--replace` | `false` | Replace a resource whose in-place update AWS rejects. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--force-stateful-recreation` | `false` | Confirm a data-losing replacement of a stateful resource. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--strict-getatt` | `false` | Fail on an `Fn::GetAtt` cdkd cannot construct, or an Output it cannot resolve. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--no-cfn-fallback` | fallback on | Do not look up cross-stack references in CloudFormation. | [Deploy: safety & compatibility flags](cli-deploy-safety.md) |
| `--allow-unaddressed` | `false` | Exit `0` when the deploy left a resource unaddressed. | [Deploy: safety & compatibility flags](cli-deploy-safety.md#allow-unaddressed-deploy) |
| `--skip-final-snapshot` | `false` | Delete `DeletionPolicy: Snapshot` resources without the final snapshot. | [Destroy flags & guards](cli-destroy.md) |
| `-a`, `--app`, `--output`, `-c`, `--context` | | Where the CDK app is and how it is synthesized. | [CLI Reference](cli-reference.md#options-every-command-takes) |
| `--state-bucket`, `--state-prefix` | | Where state is stored. | [CLI Reference](cli-reference.md#options-every-command-takes) |
| `--profile`, `--role-arn`, `-y`, `--yes`, `--verbose` | | Shared by every command. | [CLI Reference](cli-reference.md#options-every-command-takes) |

## Wait modes

cdkd accepts the same templates as CloudFormation, but it does not wait for the
same things. What counts as done is decided per resource type, in one of three
modes:

| Mode | What it waits for | Use it when |
| --- | --- | --- |
| `--no-wait` | Nothing beyond the AWS API call returning. | Nothing runs next and nothing is waiting on completion, such as a preview environment. |
| default | Only waits a later step of the same deploy needs, or that can surface a real failure. | Ordinary use. |
| `--full-wait` | Everywhere CloudFormation waits. | A smoke test, a DNS cutover or a follow-on job runs as soon as the deploy returns. |

Choose by whether anything downstream needs the resource to be serving, not by
where the deploy runs. Cutting billed CI minutes is a good reason to use
`--no-wait` in CI.

## Wait behaviour by resource type

These are the types whose behaviour differs between the modes. The flags do not
affect any other type. Some of those still wait in every mode: a DynamoDB
table, an EFS file system and an EMR cluster, among others, wait for their own
readiness on create because their provider needs the result.

| Resource type | `--no-wait` | Default | `--full-wait` | CloudFormation | Terraform |
| --- | --- | --- | --- | --- | --- |
| `AWS::CloudFront::Distribution` | same as default | Return after the create / update call | Wait for `Deployed` (3-15 min) | Waits | Waits (`wait_for_deployment`, default true) |
| `AWS::ECS::Service` | same as default | Return after `CreateService` / `UpdateService` | Wait for steady state | Waits for steady state | Does not wait (`wait_for_steady_state`, default false) |
| `AWS::CertificateManager::Certificate` | Return while `PENDING_VALIDATION` | Wait for `ISSUED` | same as default | Waits | Does not wait (waiting is a separate `aws_acm_certificate_validation` resource) |
| `AWS::RDS::DBCluster` / `DBInstance` | Return after the create call | Wait for `available` (5-10 min) | same as default | Waits | Waits |
| `AWS::DocDB::DBCluster` / `DBInstance` | Return after the create call | Wait for `available` (5-10 min) | same as default | Waits | Waits |
| `AWS::Neptune::DBCluster` / `DBInstance` | Return after the create call | Wait for `available` (5-10 min) | same as default | Waits | Waits |
| `AWS::ElastiCache::CacheCluster` etc. | Return after the create call | Wait for `available` | same as default | Waits | Waits |
| `AWS::EC2::NatGateway` | Return while `pending` | Wait for `available` (1-2 min) | same as default | Waits | Waits |
| `AWS::EC2::Instance` | Return while `pending`; a public address not yet assigned is omitted from state and re-read from AWS when referenced | Wait for `running` (30-60 s) | same as default | Waits | Waits |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | Return while `provisioning`; `DNSName` 503s until active | Wait for `active` (90-180 s) | same as default | Waits | Waits |
| `AWS::Lambda::MicrovmImage` | Return while `CREATING`; the image ARN resolves first, so outputs still work | Wait for `CREATED` | same as default | Waits | n/a |

For CloudFront and `AWS::Lambda::MicrovmImage`, only the SDK provider returns
early. A resource of either type routed through the Cloud Control API waits for
the CloudFormation handler's terminal state whatever the flag.

### CloudFront and ACM

A CloudFront distribution's `Fn::GetAtt` values (`Id`, `DomainName`) are final
in the create or update response, so nothing in the deploy needs `Deployed`.

An ACM certificate is the opposite case. A certificate that is not issued makes
a downstream CloudFront or load balancer create fail, so the default waits for
`ISSUED`.

When that wait runs out, cdkd deletes the certificate it requested, so repeated
attempts do not accumulate certificates. ACM reuses a domain's validation CNAME
across certificates, so records you add after the failure validate the retry.
Use `--no-wait` to keep a `PENDING_VALIDATION` certificate instead; see
[Troubleshooting](troubleshooting.md).

## What `--no-wait` skips, and what it does not

```bash
cdkd deploy MyStack --no-wait
```

The resource is fully functional once AWS finishes in the background. Four
cases need care before then:

| Resource | What `--no-wait` changes |
| --- | --- |
| NAT gateway | Routes that need only the gateway ID proceed while it is `pending`. |
| EC2 instance | The check that the `IamInstanceProfile` attached is skipped, with a warning naming the instance. |
| Elastic IP whose `InstanceId` is an instance of the same deploy | Create allocates the address and skips the association. Update attempts it and warns if AWS rejects it. |
| Load balancer with a capacity reservation | The `DescribeCapacityReservation` poll is skipped along with the `active` wait. |

The NAT gateway case is safe when nothing in the deploy needs NAT-routed
egress, such as a Lambda invoked during the deploy that reaches the internet.

Both Elastic IP warnings print the exact `aws ec2 associate-address` command to
run once the instance is up. Repointing an Elastic IP at an instance that is
already running still works.

The EC2 check is skipped because `RunInstances` attaches an instance profile
asynchronously and can finish with none attached when the profile was created
moments earlier. AWS rejects the association on a `pending` instance, so cdkd
cannot verify it without waiting. To verify afterwards:

```bash
aws ec2 describe-iam-instance-profile-associations \
  --filters Name=instance-id,Values=<instance-id>
```

The capacity-reservation poll applies when the template sets
`MinimumLoadBalancerCapacity` with
`EnableCapacityReservationProvisionStabilize: true`. In the default mode cdkd
polls until every zone reports `provisioned`, for about ten minutes at most. A
timeout warns and continues, and a `failed` zone is an error.

### The wait `--no-wait` never skips

A Lambda-backed `AWS::CloudFormation::CustomResource` waits for its backing
Lambda to be `Active` with `LastUpdateStatus: Successful` just before cdkd
invokes it. Without that wait the invoke fails with `The function is currently
in the following state: Pending`.

The wait belongs to that invoke only. An ordinary Lambda create or update
returns as soon as the SDK call returns, so a VPC Lambda nothing invokes does
not hold the deploy for its 5-10 minute ENI attach.

### Destroy always waits

`cdkd destroy` has no wait flags, and these waits run on every destroy:

| Resource | Wait | Why |
| --- | --- | --- |
| NAT gateway | Until `deleted` | A gateway still `deleting` blocks the subnet, internet gateway and VPC deletes with `DependencyViolation`. |
| CloudFront distribution | Disable, then wait | The CloudFront API requires it before a delete. |
| Kinesis stream, Firehose delivery stream | Until the stream is gone | The name stays taken while `DELETING`, so a redeploy right after would fail with `already exists`. |

The Kinesis and Firehose wait warns and moves on if it runs out. RDS and
ElastiCache deletes do not wait, because nothing in a destroy depends on them.

## What `--full-wait` adds

```bash
cdkd deploy MyStack --full-wait
```

Two types are affected.

### `AWS::ECS::Service`: steady state

By default cdkd returns once `CreateService` or `UpdateService` is accepted and
prints the command to wait manually:

```text
aws ecs wait services-stable --cluster <cluster> --services <service>
```

Nothing later in the deploy needs a steady service: `Fn::GetAtt` yields `Name`
and `ServiceArn`, both valid at once. cdkd does not check the rollout on this
path, because right after `CreateService` a healthy service and a failing one
look the same.

Under `--full-wait`, done means stable and rolled out:

| Step | Limit | When it runs out |
| --- | --- | --- |
| Wait for steady state | 600 seconds | The deploy fails. |
| Poll the primary deployment's `rolloutState` to `COMPLETED` | About two minutes | cdkd warns and continues. |

A service that needs longer than 600 seconds, because of a large task count, a
slow image pull or a long health-check grace period, can raise the limit:

```bash
cdkd deploy MyStack --full-wait --resource-timeout AWS::ECS::Service=20m
```

[`--resource-timeout`](cli-deploy-tuning.md#per-resource-timeout) only raises
this limit, never lowers it.

When a service never stabilizes on create, cdkd tries to delete the service it
created before failing, so the next deploy does not collide on the name. The
failure message carries the `aws ecs list-tasks --desired-status STOPPED` and
`describe-tasks` commands to see why the tasks stopped. Stopped tasks stay
visible for about an hour after the service is deleted.

### `AWS::CloudFront::Distribution`: `Deployed`

By default cdkd prints the command to wait manually:

```text
aws cloudfront wait distribution-deployed --id <distribution-id>
```

Under `--full-wait` cdkd waits about 20 minutes, or longer with an explicit
`--resource-timeout AWS::CloudFront::Distribution=40m`. As with ECS, the flag
only raises the limit.

A CloudFront wait that runs out does not fail the deploy. A distribution still
`InProgress` is slow, not broken, and failing would make the automatic rollback
disable and delete a healthy distribution. cdkd warns with the manual wait
command and continues.

## What the stack lock covers, and when a second deploy can start

A stack lock covers one stack in one region. cdkd holds it while it works on
that stack, and a multi-stack run releases each stack's lock as that stack
finishes.

```text diagram=cli-stack-lock
  $ cdkd deploy MyStack
          |
          v
    Take the lock  <----------------------------+  try again
          |                                     |
          +--------------------+                |
          | free, or expired   | held by another run
          v                    v                |
  Work on the stack       Wait 2 seconds -------+
  (lock renewed)               |
          |                    | still held after 3 retries
          v                    v
  Release the lock           Fail
  (work finished)        (names the holder)
```

The lock is released when the work finishes, not when the resources finish
provisioning. So a second `cdkd deploy` on the same stack can start while
resources the first one created are still coming up.

That is true in every wait mode. `--no-wait` widens the window and
`--full-wait` narrows it, but the default mode already returns before a
CloudFront distribution is `Deployed` or an ECS service is steady, and no mode
waits for a VPC Lambda's ENI attach.

A deploy that finds the lock held does not queue. It retries three times, two
seconds apart, and then fails, naming the holder when it can read the lock. If
the lock disappears between attempts, the deploy tries again at once, up to
three extra times.

### What a second deploy started too early runs into

An update against a resource that is still provisioning is likely to fail, and
the failure rolls that deploy back. cdkd does not wait for a resource to become
available before it updates it.

cdkd retries an operation only for transient errors:

| Retried | Not retried |
| --- | --- |
| Throttling, HTTP 429 included | Any other rejection |
| HTTP 500, 502, 503 and 504 | A transient error that outlasts the backoff |
| AWS messages matching a fixed list of transient patterns | |

The backoff lasts roughly 47 to 64 seconds for one operation, and up to about
ten minutes where a replacement nests one retry inside another. Nested stacks
and custom resources handle their own transient errors.

[Rollback](rollback.md) then reverts what the second deploy had done, while the
first deploy's resources keep coming up. It deletes what that deploy created
and undoes its updates, with two limits:

- `DeletionPolicy` decides what survives the delete, per the table under
  [`cdkd rollback`](cli-rollback.md#deletionpolicy-on-a-rolled-back-create).
- A resource the second deploy had already deleted cannot be brought back.

`--no-rollback` leaves the partial deploy in place.

#### A second deploy with no changes

A second deploy whose template produces no diff updates nothing, so it avoids
that rejection. A resource a rollback left in AWS is adopted back before the
diff runs, when the template still declares it with the same type and leaves
the physical name for cdkd to derive. The adoption adds no diff entry.

Such a deploy still resolves the stack's Outputs again. An attribute the first
deploy did not have yet is read from AWS at that point:

| Attribute | Still not available | Available by then |
| --- | --- | --- |
| `PublicIp` / `PublicDnsName` of a `--no-wait` EC2 instance | cdkd refuses to resolve the reference. Nothing is cached. | The real value, cached for the rest of the deploy. |
| `Endpoint.Address` / `Endpoint.Port` of a `--no-wait` RDS, DocDB or Neptune `DBInstance` | Resolves to the instance identifier, with a warning. Nothing is recorded. | The real endpoint, recorded in state. |

What the EC2 refusal does depends on where the reference is:

| Reference in | Result |
| --- | --- |
| A resource property | That resource fails. |
| An Output | cdkd warns and skips the Output. The next deploy resolves it again. |
| An Output, under `--strict-getatt` | The deploy fails. |

The database fallback also fails under `--strict-getatt`. A
`DescribeInstances` call that fails gets the same EC2 refusal, naming the error
class; `--verbose` shows the AWS text.

A running instance with no public address, as in a private subnet, is a
different case. Both attributes resolve to the empty string, which is what
CloudFormation reports. See
["Cannot resolve" a GetAtt on a resource an older cdkd deployed](troubleshooting.md#cannot-resolve-a-getatt-on-a-resource-an-older-cdkd-deployed).

An Output cdkd cannot resolve on a no-change deploy keeps its previously stored
value, and cdkd warns naming the Output. The Outputs that did resolve are
saved. [Deploy internals](cli-deploy-internals.md#outputs-a-no-change-deploy-cannot-resolve)
has the rules for the Output's export name.

What the second deploy reads depends on how the first one ended. A deploy that
succeeded wrote its final state, physical IDs included, before it released the
lock. One that failed or was interrupted wrote what it could.

### The lock does not guarantee exclusion

A lock can change hands while its holder is still working:

| How | What happens |
| --- | --- |
| Renewals fail until the TTL lapses | Another process can take the lock. |
| [`cdkd force-unlock`](cli-force-unlock.md) | Removes the lock, live holder included. |
| `cdkd state orphan --force` without `--resource` | Force-releases the lock before dropping the state record. |

A holder that notices warns and does not delete a lock it no longer owns. Past
that point two processes can be writing one stack's state.

A lock can also outlive its command: after a second {kbd:ctrl+c}, a `SIGKILL`,
or a release cdkd refuses because it cannot confirm the lock is still its own.
Such a lock lapses once its TTL passes, and `cdkd force-unlock` clears it
immediately.

## A damaged state record refuses the deploy

A state record that was hand-edited or truncated can hold the wrong kind of
value where cdkd expects a map or a list. `cdkd deploy` refuses such a record
with `STATE_RESOURCES_MALFORMED` and exit `1`. Nothing is provisioned and no
state is written for that stack.

| Part of the record | Refused when it is | Accepted |
| --- | --- | --- |
| `resources` map | Not an object, or absent | An empty `{}` |
| One record in `resources` | Not an object, or an object with no `resourceType` | |
| A resource's `properties` map | Not an object, or absent | An empty `{}` |
| `outputs` map | Not an object | An absent field |
| `orphans` list | Not a list, or a list holding a record cdkd cannot read | An absent field |

To recover:

::: steps
1. Inspect the record

   ```bash
   cdkd state show MyStack --stack-region us-east-1 --json
   ```

2. Preview the rest of the stack

   [`cdkd diff`](cli-diff.md) does not refuse. It reads each damaged part as
   empty, warns, and still prints a preview. On the stack you named it exits
   `3`, because the deploy would refuse.

   ```bash
   cdkd diff MyStack
   ```

3. Repair or remove the record, then deploy again
:::

Details per part:

- **`resources`, one resource record, `properties`.** `--dry-run` refuses too,
  because its plan comes from the same comparison. The refusal names the
  resource records it could not read, up to five and then a count. The same
  check runs before the lock when `--recreate-via-cc-api` or
  `--recreate-via-sdk-provider` names a resource.
- **`outputs`.** The refusal also covers a nested stack's child record, whose
  outputs the parent stores as its own `Outputs.<Key>` attributes.
- **`orphans`.** This list records the `DeletionPolicy: Retain` resources a
  rollback left standing, so the next deploy can adopt them back. A record in
  it is unreadable when it is not an object, has no string `logicalId` or
  shares it with another record, or has no readable `state` with a non-empty
  string `physicalId` and object `properties` and `attributes` maps.

State Management has the per-command tables:
[`resources`](state-management.md#when-resources-is-not-an-object),
[`properties`](state-management.md#when-a-resource-properties-map-is-not-an-object),
[`outputs`](state-management.md#when-outputs-is-not-an-object),
[`orphans`](state-management.md#when-orphans-is-not-a-list) and
[one `orphans` record](state-management.md#when-one-orphans-record-cannot-be-read).
[Deploy internals](cli-deploy-internals.md#why-a-damaged-record-is-refused-and-not-repaired)
explains why cdkd refuses these records and does not read them as empty.

## A changed custom-resource ServiceToken

A custom resource's `ServiceToken` cannot change in place. CloudFormation
refuses the update (`Modifying service token is not allowed`), and so does
`cdkd deploy`. Sent as an update, the change would reach only the new handler,
and the old handler would never get a delete for what it created.

To move a custom resource to another handler, give it a new logical id. In CDK
that is a new construct id:

```ts
// Before: new CustomResource(this, 'Seed', { serviceToken: oldProvider.serviceToken });
new CustomResource(this, 'SeedV2', { serviceToken: newProvider.serviceToken });
```

The deploy then creates the new resource through the new handler and deletes
the old one through its old handler. `overrideLogicalId` on the resource's
`CfnResource` does the same.

When the refusal happens depends on what cdkd can compare:

| Recorded and new token | What happens |
| --- | --- |
| Two different ARNs | Refused before anything is provisioned, `--dry-run` included. No handler is called and state is unchanged. |
| The token reads a resource this deploy creates or replaces | Refused once that resource exists, before the handler is invoked. The deploy fails and rolls back. |
| The recorded token is missing, the mask `***`, or a `{{resolve:...}}` reference | cdkd cannot compare, so a deploy whose template changes the token is refused. |
| The token comes from a `NoEcho` parameter | Recorded only as `***`, so a new parameter value is not detected and the update goes to whichever handler it names. |

A `Ref` or `Fn::GetAtt` whose ARN did not change is not a change.

Notes on those rows:

- **Second row.** A renamed backing Lambda, or a switch to a new provider, is
  this case. cdkd has already deleted a replaced backing Lambda by then, and
  the rollback creates it again from its record. If that fails or lands under
  another name, the custom resource's record names a function that no longer
  exists.
- **Third row.** If the handler did not change, put the ARN of the handler that
  created the resource back as `ServiceToken` in `state.json`, then deploy
  again. Use the ARN it was last deployed with, not the one the template names
  now.
- **Fourth row.** Feed `ServiceToken` from a plain value to have such a change
  refused.

No flag overrides the refusal. A `--recreate-via-cc-api` target is not refused,
because it already deletes the old resource through the recorded token and
creates the new one through the template's.

## A skipped custom-resource delete

A deploy deletes a custom resource when it leaves the template, is replaced, or
is rolled back. cdkd skips that delete, as `cdkd destroy` does, when:

- the handler answers `FAILED`;
- the invoke does not complete; or
- the recorded `ServiceToken` is the mask `***` or a `{{resolve:...}}`
  reference.

What follows depends on why the resource was being deleted:

| Situation | Result |
| --- | --- |
| Removed from the template | The record is kept and the deploy exits `2`. |
| Replaced delete-first, or rolled back | The resource usually fails and the record is kept. |
| The other copy already exists | The skip only warns, and the surviving copy is no longer tracked. Tear it down by hand. |

The third row covers a replacement that created the new resource first, and a
rollback that created the old one again first.

For a resource removed from the template, the next `cdkd deploy` sends the
delete again. Fix the handler, or put the provider's ARN back as `ServiceToken`
in `state.json`, and deploy again. If the handler's Lambda function is gone by then, that deploy
drops the record with a warning, and you tear down what the handler managed by
hand. `--allow-unaddressed` lets a deploy exit `0` in the meantime;
`cdkd rollback` has no such flag.

To give up on the delete and stop tracking a resource removed from the
template, drop only its record:

```bash
cdkd state orphan MyStack --stack-region us-east-1 --resource SeedResource
```

See [one resource's record](cli-state.md#removing-one-resource-from-the-record).

> [!CAUTION]
> Do not run `cdkd state orphan MyStack` without `--resource` here. It drops
> the record of every resource in the stack, so the next deploy creates them
> all again or collides with them. The whole-stack form is the remedy only on
> [`cdkd destroy`](cli-destroy.md), where the other records are already gone.

A `ServiceToken` that is not a string, such as a leaked intrinsic, is handled
differently:

| Operation | Reads the token from | Fix |
| --- | --- | --- |
| Create or update | The template | Fix the template and deploy again. Do not drop the record. |
| Rollback | The recorded value | Fix the template and deploy again. Do not drop the record. |
| Delete | The state record | Restore the ARN in `state.json`, or drop only that record with `--resource`. |

Dropping the record of a resource the template still declares makes the next
deploy send the handler a new create.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every resource was deployed. |
| `1` | Hard error: bad arguments (including `--no-wait` with `--full-wait`), an auth failure, a synthesis crash, a refused state record, or a resource failure the automatic rollback then handled. |
| `2` | Resources were left unaddressed: a skipped delete, or a replacement whose predecessor survives. State is kept, and running again usually clears it. `--allow-unaddressed` restores `0`. |

An ECS service that never stabilizes under `--full-wait` fails the deploy, so
it exits non-zero rather than `2`. A CloudFront wait that runs out does not fail the deploy. The
table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [Wait Modes](wait-modes.md): the same choice, summarized for a first read
- [Deploy: tuning](cli-deploy-tuning.md): timeouts, name prefixing, the drift baseline
- [Deploy: safety & compatibility flags](cli-deploy-safety.md): the guards and their escape hatches
- [Rollback](rollback.md): what the automatic rollback reverts when a deploy fails
- [State Management](state-management.md): the lock's layout, TTL and renewal
- [Benchmarks](benchmarks.md): what the wait modes cost in wall-clock time
