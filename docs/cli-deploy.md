---
title: cdkd deploy
description: "What cdkd deploy does, every cdkd deploy flag and where it is explained, the concurrency flags, and how long a deploy waits for each resource type."
---

# cdkd deploy

`cdkd deploy` creates or updates the stacks of a CDK app. This page is the
entry to the deploy pages: it lists every deploy flag with a link to where the
flag is explained. It also covers the two settings people tune most, which are
how many operations run at once and how long cdkd waits before it treats a
resource as done.

```bash
# default waits, default concurrency
cdkd deploy MyStack

# every top-level stack
cdkd deploy --all

# skip the stabilization waits
cdkd deploy MyStack --no-wait

# also wait everywhere CloudFormation waits
cdkd deploy MyStack --full-wait

# more parallel resource operations
cdkd deploy MyStack --concurrency 20

# more stacks at once
cdkd deploy --all --stack-concurrency 8
```

## What a deploy does

A deploy synthesizes the CDK app and publishes the file and container assets
its stacks use. For each stack, it compares the synthesized template with the
state cdkd recorded on the previous deploy, and then creates, updates or
deletes the resources that differ. Resources that do not depend on each other
are handled in parallel.

cdkd holds a lock on the stack while it works, so that two runs cannot change
the same stack at once. If a resource fails, cdkd rolls back what the deploy
had done to that stack, unless you pass `--no-rollback`.

## Options

Run `cdkd deploy --help` for the same list in the terminal. The flags are
grouped here by what they control.

### Which stacks to deploy

[Selecting stacks](cli-list.md#selecting-stacks) explains how names and
patterns are matched.

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]`, `--stack <name>` | the only stack | Stacks to deploy: CDK display paths with wildcards, or exact physical names. |
| `--all` | `false` | Deploy every top-level stack. |
| `-e`, `--exclusively` | `false` | Deploy only the requested stacks, without their dependencies. |

### Concurrency and waits

These six flags are explained on this page.

| Flag | Default | Description |
| --- | --- | --- |
| `--concurrency <number>` | `10` | Maximum concurrent resource operations per stack. |
| `--stack-concurrency <number>` | `4` | Maximum concurrent stack deployments. |
| `--asset-publish-concurrency <number>` | `8` | Maximum concurrent asset publishes (S3 uploads and ECR pushes). |
| `--image-build-concurrency <number>` | `4` | Maximum concurrent Docker image builds. |
| `--no-wait` | off | Skip the stabilization waits cdkd performs by default. See [Wait modes](#wait-modes). |
| `--full-wait` | off | Also wait everywhere CloudFormation waits. See [Wait modes](#wait-modes). |

### What the run changes

| Flag | Default | Description |
| --- | --- | --- |
| `--dry-run` | `false` | Show the changes without applying them. |
| `--skip-assets` | `false` | Skip asset publishing. |
| `--no-rollback` | rollback on | Leave a failed deploy in place and skip the automatic rollback. See [Roll Back a Failed Deploy](rollback.md). |
| `--require-approval <level>` | `never` | Ask before `any-change` or `destructive` changes. See [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md). |

### Assets

| Flag | Default | Description |
| --- | --- | --- |
| `--no-auto-asset-storage` | auto-create on | Do not create cdkd asset storage on the first deploy into a region. See [Auto-create on first deploy](cli-bootstrap.md#auto-create-on-first-deploy). |
| `--use-cdk-bootstrap-assets` | `false` | Publish to the CDK bootstrap bucket and repository. See [Keeping CDK bootstrap destinations](cli-bootstrap.md#keeping-cdk-bootstrap-destinations). |

### Tuning

| Flag | Default | Description |
| --- | --- | --- |
| `--resource-warn-after <duration>` | `5m` | Warn about one slow resource operation. See [Per-resource timeout](cli-deploy-tuning.md#per-resource-timeout). |
| `--resource-timeout <duration>` | `30m` | Abort one slow resource operation. See [Per-resource timeout](cli-deploy-tuning.md#per-resource-timeout). |
| `--prefix-user-supplied-names` | `false` | Prefix declared physical names with the stack name. See [`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names). |
| `--no-capture-observed-state` | capture on | Skip recording the drift baseline. See [`--no-capture-observed-state`](cli-deploy-tuning.md#no-capture-observed-state). |
| `--no-aggressive-vpc-parallel` | relaxation on | Keep CDK's defensive VPC route ordering. See [`--no-aggressive-vpc-parallel`](cli-deploy-tuning.md#no-aggressive-vpc-parallel). |
| `--strict`, `--ignore-errors` | `false` | Fail on CDK warning annotations, or never fail on annotations. See [CDK annotation messages](cli-deploy-tuning.md#cdk-annotation-messages). |

### Safety and compatibility

[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) explains every
flag in this group, except `--skip-final-snapshot`, which is on
[cdkd destroy](cli-destroy.md).

| Flag | Default | Description |
| --- | --- | --- |
| `--replace` | `false` | Replace a resource whose in-place update AWS rejects. |
| `--force-stateful-recreation` | `false` | Confirm a data-losing replacement of a stateful resource. |
| `--recreate-via-cc-api <logicalId>`, `--recreate-via-sdk-provider <logicalId>` | | Destroy and recreate one resource on the other provisioning route. |
| `--pin-cc-api <logicalId>` | | Keep one resource on the Cloud Control route. |
| `--prefer-sdk-route <entries>` | | Keep a resource on the SDK provider when a property would route it to Cloud Control. |
| `--allow-unsupported-types <types>` | | Attempt types cdkd reports unsupported through Cloud Control. |
| `--strict-getatt` | `false` | Fail on an `Fn::GetAtt` cdkd cannot construct, or an Output it cannot resolve. |
| `--no-cfn-fallback` | fallback on | Do not look up cross-stack references in CloudFormation. |
| `--allow-unaddressed` | `false` | Exit `0` when the deploy left a resource unaddressed. |
| `--skip-final-snapshot` | `false` | Delete `DeletionPolicy: Snapshot` resources without the final snapshot. |

### Shared with other commands

The [CLI Reference](cli-reference.md#options-every-command-takes) explains
these.

| Flag | Description |
| --- | --- |
| `-a`, `--app`, `--output`, `-c`, `--context` | Where the CDK app is and how it is synthesized. |
| `--state-bucket`, `--state-prefix` | Where state is stored. |
| `--profile`, `--role-arn`, `-y`, `--yes`, `--verbose` | Shared by every command. |

## Wait modes

Many AWS resources keep working after the API call that creates them returns.
A NAT gateway stays `pending` for a minute or two, and a CloudFront
distribution takes 3 to 15 minutes to report `Deployed`. A wait mode decides
how much of that cdkd sits through before it calls the resource done.

```bash
cdkd deploy MyStack               # default
cdkd deploy MyStack --no-wait     # return as early as possible
cdkd deploy MyStack --full-wait   # wait as long as CloudFormation would
```

| Mode | What cdkd waits for |
| --- | --- |
| `--no-wait` | Nothing beyond the AWS API call returning. |
| default | Only what a later step of the same deploy needs, or what can surface a real failure. |
| `--full-wait` | Everything CloudFormation waits for. |

To choose, ask whether anything after the deploy needs the resource to be
serving:

- Use the default for ordinary work.
- Use `--no-wait` when nothing runs next and nothing is waiting on completion,
  such as a preview environment. Cutting billed CI minutes is a good reason to
  use it in CI.
- Use `--full-wait` when a smoke test, a DNS cutover or a follow-on job runs
  as soon as the deploy returns.

`--no-wait` and `--full-wait` cannot be combined, and cdkd rejects the pair
before any AWS call. Both apply to the whole run and cannot be limited to one
resource type. `cdkd destroy` accepts neither.

## Wait behaviour by resource type

The table lists every resource type whose behaviour differs between the modes.
The two flags do not affect any other type. The last two columns show what
CloudFormation and Terraform do, for comparison.

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
| `AWS::EC2::Instance` | Return while `pending` | Wait for `running` (30-60 s) | same as default | Waits | Waits |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | Return while `provisioning` | Wait for `active` (90-180 s) | same as default | Waits | Waits |
| `AWS::Lambda::MicrovmImage` | Return while `CREATING` | Wait for `CREATED` | same as default | Waits | n/a |

[cdkd deploy: wait mode details](cli-deploy-waits.md) explains what each early
return leaves unfinished, and what `--full-wait` does when a wait runs out.

### Edge cases

- **Types that are not in the table can still wait.** A DynamoDB table, an EFS
  file system and an EMR cluster, among others, wait for their own readiness
  on create in every mode, because cdkd needs the result.
- **CloudFront and `AWS::Lambda::MicrovmImage` through Cloud Control.** cdkd
  provisions common resource types by calling the service's own API, and the
  rest through the AWS Cloud Control API. The early return in the table
  applies only to the first route. A resource of either type that is routed
  through Cloud Control waits for its final state whatever the flag.

## The same stack name under another state prefix

A stack name is one deployment per account and region, as in CloudFormation.
A deploy enforces that in two places, and refuses when a check fails:

- **Before a create under a generated name.** For a queue, topic, log group,
  alarm, EventBridge rule, S3 bucket, ECS cluster, load balancer, target
  group or state machine, the deploy looks the name up first. If a resource
  holds the name and nothing this stack records names it, that create is
  refused with `GENERATED_NAME_HELD`. See
  [Name check before a create](state-store-name-check.md).
- **Against the stack registry.** A first deploy claims the stack's marker in
  the state bucket, and refuses when the marker names another prefix. A later
  deploy reads the marker only when its plan deletes or replaces a resource,
  or adds or updates a nested stack. See
  [Stack registry](state-store-registry.md).

An ordinary redeploy pays for neither check: it looks no name up and makes no
registry request.

When the deploy fails, its automatic rollback keeps a resource it created,
and does not delete it, if another prefix holds the stack or the check cannot
run. [One stack name per account and region](state-store.md#one-stack-name-per-account-and-region)
explains why.

## In this section

- [cdkd deploy: wait mode details](cli-deploy-waits.md): what `--no-wait` leaves
  unfinished for each resource type, what `--full-wait` adds, and the waits a
  destroy always performs.
- [cdkd deploy: the stack lock](cli-deploy-lock.md): what the lock covers, why a
  second deploy can start while resources are still coming up, and what that
  deploy runs into.
- [cdkd deploy: a damaged state record](cli-deploy-damaged-state.md): why a deploy
  refuses with `STATE_RESOURCES_MALFORMED`, and how to recover.
- [cdkd deploy: custom resources](cli-deploy-custom-resources.md): a changed
  `ServiceToken`, and a custom-resource delete that cdkd skipped.
- [cdkd deploy: tuning](cli-deploy-tuning.md): timeouts, resource names, the drift
  baseline and CDK annotations.
- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): replacements
  and the guards around them.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every resource was deployed. |
| `1` | The deploy failed. |
| `2` | The stack deployed, but resources were left unaddressed. |

Exit `1` covers bad arguments (including `--no-wait` with `--full-wait`), an
auth failure, a synthesis crash, a refused state record, and a resource
failure that the automatic rollback then handled.

Exit `2` means a delete was skipped, a replacement's old resource survives,
or a replacement was refused because another state prefix records the stack
(or that check could not run). cdkd keeps the state, and running the deploy again usually clears
the code. `--allow-unaddressed` turns this exit into `0`.

Under `--full-wait`, an ECS service that never stabilizes fails the deploy, so
the deploy exits with a failure code and not with `2`. A CloudFront wait that runs out does not
fail the deploy. [Exit codes](cli-reference-exit-codes.md) has the table for
every command.

## Related

- [Choose a Wait Mode](wait-modes.md): the same choice, summarized for a first read
- [Roll Back a Failed Deploy](rollback.md): what the automatic rollback reverts when a deploy fails
- [State Store](state-management.md): the lock's layout, TTL and renewal
- [Benchmarks](benchmarks.md): what the wait modes cost in wall-clock time
