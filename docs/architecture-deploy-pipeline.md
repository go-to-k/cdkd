---
title: The deploy pipeline
description: "What cdkd deploy does at each stage: resolving configuration, synthesizing the CDK app, publishing assets, diffing a stack against its state, and running the changes."
---

# The deploy pipeline

This page follows one `cdkd deploy` through its five stages and names the
module that owns each one. Read [Architecture](architecture.md) first for the
overview and the diagram of the whole run.

```bash
cdkd deploy MyStack
```

| Stage | What happens | Layer |
| --- | --- | --- |
| 1 | [Resolve the configuration](#stage-1-resolve-the-configuration) | CLI |
| 2 | [Synthesize the CDK app](#stage-2-synthesize-the-cdk-app) | Synthesis |
| 3 | [Schedule assets and stacks](#stage-3-schedule-assets-and-stacks) | Deployment |
| 4 | [Publish the assets](#stage-4-publish-the-assets) | Assets |
| 5 | [Deploy each stack](#stage-5-deploy-each-stack) | State, Analysis, Deployment, Provisioning |

## Stage 1: resolve the configuration

The CLI needs two values before anything else can run: the command that runs
the CDK app, and the S3 bucket that holds cdkd's state. Each value is looked up
in several places, and the first place that has it wins.

| Value | Looked up in, in order |
| --- | --- |
| App command | `--app`, the `CDKD_APP` environment variable, `cdk.json` |
| State bucket | `--state-bucket`, the environment, `cdk.json`, then the default `cdkd-state-{accountId}` |

Synthesis does not need the state bucket, so cdkd resolves the bucket while
synthesis is running. The stages on this page are the logical order.

## Stage 2: synthesize the CDK app

Synthesis turns the CDK app into CloudFormation templates. cdkd does not use
the CDK CLI or the CDK toolkit libraries for it. The app itself, through
`aws-cdk-lib`, generates the templates. cdkd runs the app, reads what the app
wrote, and answers the app's questions about the AWS account.

```text diagram=synthesis-flow
1. User CDK App (--app option, CDKD_APP env var, or cdk.json "app" field)
   ↓
2. AppExecutor.execute() via child_process.spawn()
   ↓  (with CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION/ACCOUNT env vars)
3. Output to cdk.out/ directory
   - manifest.json
   - {StackName}.template.json
   - {StackName}.assets.json
   ↓
4. AssemblyReader parses manifest.json
   ↓
5. Check for missing context → resolve via providers → re-synthesize if needed
   ↓
6. Return final assembly with stacks and asset manifests
```

### Running the app

`AppExecutor` (`src/synthesis/app-executor.ts`) starts the app as a child
process. It passes the app what it needs through four environment variables:

| Variable | Value |
| --- | --- |
| `CDK_OUTDIR` | The output directory, `cdk.out` by default |
| `CDK_CONTEXT_JSON` | The merged context, serialized |
| `CDK_DEFAULT_REGION` | The AWS region |
| `CDK_DEFAULT_ACCOUNT` | The AWS account id |

The context in `CDK_CONTEXT_JSON` is merged from five sources. When two
sources set the same key, the source lower in this table wins.

| Order | Source |
| --- | --- |
| 1 | CDK defaults (`aws:cdk:enable-path-metadata`, `aws:cdk:enable-asset-metadata`, `aws:cdk:version-reporting`, `aws:cdk:bundling-stacks`) |
| 2 | `~/.cdk.json`, the `context` field |
| 3 | `cdk.json`, the `context` field |
| 4 | `cdk.context.json`, the cached lookup results, reloaded on each loop iteration |
| 5 | `-c key=value` on the command line |

When `--app` names an existing directory, cdkd treats the directory as a cloud
assembly that is already synthesized and does not run the app.

### Reading the cloud assembly

The app writes its output, the cloud assembly, to `cdk.out/`. `AssemblyReader`
(`src/synthesis/assembly-reader.ts`) parses `cdk.out/manifest.json` and finds
four things for each stack:

- the template, `{StackName}.template.json`,
- the asset manifest, `{StackName}.assets.json`,
- the stacks this stack depends on,
- the CDK annotations (`Annotations.addError`, `addWarning`, `addInfo`).

`synth` and `deploy` print the warnings. They refuse to continue when a
selected stack carries an error annotation.

### Context lookups run the app again

A construct such as `Vpc.fromLookup()` needs a value from the AWS account, and
the app cannot fetch it. So the app records the missing key in the manifest
and exits. `Synthesizer` (`src/synthesis/synthesizer.ts`) looks the value up
through the AWS SDK, saves the answer to `cdk.context.json`, and runs the app
again. The loop ends when the manifest reports nothing missing.

```text diagram=synthesizer-loop
1. Execute CDK app (AppExecutor)
   ↓
2. Read cloud assembly (AssemblyReader)
   ↓
3. Check for missing context in manifest
   ↓  (if missing context found)
4. Resolve missing context via ContextProviderRegistry
   ↓
5. Save resolved context to cdk.context.json (ContextStore)
   ↓
6. Re-execute CDK app with updated context → go to step 1
   ↓  (if no missing context)
7. Return final assembly with stacks and asset manifests
```

The next diagram shows the same loop by the module that performs each step:

```text diagram=context-loop
┌───────────────────────┐
│ Synthesizer           │
│ synthesize()          │
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│ AppExecutor           │
│ spawn(cdkApp)         │◄──────────────────────┐
│ env: CDK_OUTDIR,      │                       │
│   CDK_CONTEXT_JSON,   │                       │
│   CDK_DEFAULT_REGION  │                       │
└──────────┬────────────┘                       │
           │                                    │
           ▼                                    │
┌───────────────────────┐                       │
│ AssemblyReader        │                       │
│ read manifest.json    │                       │
└──────────┬────────────┘                       │
           │                                    │
           ▼                                    │
┌───────────────────────┐     ┌─────────────────┴───────┐
│ Missing context?      │─Yes→│ ContextProviderRegistry │
│ (check manifest       │     │ resolve(key, props)     │
│  missing entries)     │     │ (all CDK provider types │
└──────────┬────────────┘     │  supported — see        │
           │ No               │  context-providers/)    │
           ▼                  │                         │
┌───────────────────────┐     │                         │
│ Return final assembly │     └─────────────┬───────────┘
└───────────────────────┘                   │
                                            ▼
                              ┌─────────────────────────┐
                              │ ContextStore             │
                              │ save to cdk.context.json │
                              └─────────────┬───────────┘
                                            │
                                            │ (re-synthesize)
                                            └───────────────┘
```

Every CDK context provider type is supported. The implementations are in
`src/synthesis/context-providers/`.

## Stage 3: schedule assets and stacks

A stack cannot deploy before its assets exist, and it cannot deploy before the
stacks it depends on. `WorkGraph` (`src/deployment/work-graph.ts`) handles both
rules with one graph. Every asset and every stack is a node, and a node becomes
ready when all of its dependencies have completed.

```text diagram=contrib-work-graph
asset-build       Docker image build             4 at a time
     |                                           (Docker assets only)
     v
asset-publish     S3 upload or ECR push          8 at a time
     |                                           (a file asset starts here)
     v
stack             DeployEngine, for one stack    4 at a time
     |
     v
stack             a stack that depends on it
```

There are three node types, and each has its own concurrency limit:

| Node type | Work | Limit | Flag |
| --- | --- | --- | --- |
| `asset-build` | Build a Docker image | 4 | `--image-build-concurrency` |
| `asset-publish` | Upload a file to S3 or push an image to ECR | 8 | `--asset-publish-concurrency` |
| `stack` | Deploy one stack | 4 | `--stack-concurrency` |

A file asset has one node, `asset-publish`. A Docker asset has two, because the
image is built before it is pushed. A stack waits for all of its assets and for
the stacks CDK says it depends on. When a node fails, the nodes downstream of
it are skipped.

## Stage 4: publish the assets

Each asset node is run by a publisher in `src/assets/`:

- `FileAssetPublisher` checks for the object with `HeadObject` and skips the
  upload when the object exists.
- `DockerAssetPublisher` builds the image and pushes it.

A third class, `AssetPublisher`, is the orchestrator behind the standalone
`cdkd publish-assets` command. `deploy` does not use it, because `deploy`
drives the individual asset nodes through the work graph.

### Where assets are stored

Assets go to one of two sets of locations. cdkd decides per region, from
whether `cdkd bootstrap` has written its bootstrap marker for that region.

| | cdkd-assets mode | Legacy mode |
| --- | --- | --- |
| Used when | The region has the marker | The region has no marker |
| S3 bucket | `cdkd-assets-${AccountId}-${Region}` | `cdk-hnb659fds-assets-${AccountId}-${Region}` |
| ECR repository | `cdkd-container-assets-${AccountId}-${Region}` | `cdk-hnb659fds-container-assets-${AccountId}-${Region}` |

A synthesized template refers to the CDK bootstrap locations, which are the
legacy ones. In cdkd-assets mode cdkd rewrites those references to the cdkd
locations. The rewrite rules are in
[Architecture internals](architecture-internals.md#asset-storage).

## Stage 5: deploy each stack

`DeployEngine` deploys one stack. Its code is in
`src/deployment/deploy-engine.ts` and the modules in `deploy-engine/`. For each
stack it does nine things in order:

1. Acquire the stack lock.
2. Load the stack's state from S3.
3. Parse the template and drop the resources whose `Condition` is false.
4. Build the dependency graph.
5. Diff the template against the state. Each resource becomes `CREATE`,
   `UPDATE`, `DELETE` or `NO_CHANGE`.
6. Print the plan. With `--dry-run`, stop here.
7. Run the creates and updates in dependency order, then the deletes in
   reverse dependency order.
8. Resolve the template's `Outputs`.
9. Save the state and release the lock.

State is also saved after each resource completes. A crash in the middle of a
deploy therefore leaves a state file that matches what is in AWS.

### Which resources depend on which

The dependency graph (`src/analyzer/dag-builder.ts`) has an edge wherever one
resource names another in the template. Three things create an edge:

- a `DependsOn` attribute,
- a `Ref`,
- an `Fn::GetAtt`.

The graph also has two kinds of edge that the template does not state:

- An IAM policy attached to a custom resource's handler role gets an edge to
  the custom resource. Without it, the handler could be invoked before the
  policy exists. The edge is left out when the custom resource already comes
  before that policy, as with several `AwsCustomResource`s that share one handler
  and run in a chain: each waits for its own policy and the earlier ones, never
  for a later one.
- A Lambda function in a VPC gets edges from its subnets and security groups.
  On delete the function then goes first, and its network interfaces have time
  to detach.

### The order resources run in

A resource starts as soon as all of its own dependencies have completed. It
does not wait for unrelated resources at the same depth of the graph. This
event-driven dispatch is in `src/deployment/dag-executor.ts`.

`--concurrency` (default 20) caps the number of operations in flight. When more
resources are ready than the cap allows, the one with the most transitive
dependents starts first. A slow chain, such as an Elastic IP followed by a NAT
gateway, therefore starts early.

One exception orders resources the graph leaves unordered. When two resources
in the deploy write the same inline policy name on the same IAM role, group or
user, one waits for the other. Examples are two `AWS::IAM::Policy` resources
swapping names, and a policy renamed away from a name a new policy takes.
Without the wait, each could remove the name the other had just written. This
ordering is decided before anything runs. It applies only to those resources,
and to IAM resources whose policy name or principal cdkd cannot read before
resolving it, which it treats as possibly the same. An `AWS::IAM::RolePolicy`,
`UserPolicy` or `GroupPolicy` always waits for the other resource. Cloud
Control refuses to create a policy name the principal still holds, and the
other resource may be the one releasing it. When such a policy is replaced,
deleting its old name leaves that name in place if another resource of the
deploy has already written it there.

The log line `DAG: <n> levels` reports the depth of the graph. Levels are not
used to schedule anything.

### When a resource fails

When one operation fails, the resources downstream of the failed one are
skipped. Operations that are already in flight finish, and nothing new starts.
The engine then rolls back what this run changed, unless the deploy ran with
`--no-rollback`. [Roll Back a Failed Deploy](rollback.md) describes what a rollback undoes.

### How the diff decides what changed

`DiffCalculator` (`src/analyzer/diff-calculator.ts`) compares each resource's
properties in state with the same resource in the template. Three rules matter
when you change anything near it:

- State holds resolved values and the template holds intrinsic functions such
  as `Ref`. So the template side is resolved against the current state before
  the two are compared.
- Only the keys the template declares are compared. An extra key in state is a
  value AWS added, so it does not count as a change.
- Some properties cannot be updated in place. A change to one of them makes
  the change a replacement: the new resource is created and the old one is
  deleted. Replacing a stateful resource requires
  `--force-stateful-recreation`.

A replacement gives the resource a new physical id. The resources that refer to
it must receive the new id, so the diff promotes them from `NO_CHANGE` to
`UPDATE`. The promotion rules, and the separate diff of the `Outputs` section,
are in
[Architecture internals](architecture-internals.md#how-the-diff-compares-state-with-a-template).

### What an update sends to AWS

The two kinds of provider update a resource differently. An SDK provider's
`update()` calls the service's own update APIs. On the Cloud Control route,
cdkd generates a JSON Patch (RFC 6902) from the old and the new properties and
calls `UpdateResource` with it:

```text diagram=deploy-update
... (Same until Synthesis)
         │
         ▼
┌──────────────────┐
│ Analysis Layer   │
│ - Diff Calc      │
│   Current State  │
│   vs Template    │
│   → UPDATE       │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────┐
│ Provisioning Layer       │
│ - JSON Patch Generator   │
│   oldProps → newProps    │
│ - Cloud Control API      │
│   UpdateResource()       │
└──────────────────────────┘
```

[Providers and intrinsic functions](architecture-provisioning.md) describes the
two kinds of provider.

## Related

- [Architecture](architecture.md): the layers and the overview of a deploy
- [Destroy, state and locking](architecture-destroy-and-state.md)
- [Providers and intrinsic functions](architecture-provisioning.md)
- [Architecture internals](architecture-internals.md): the detailed rules
  behind the diff and asset storage
- [Roll Back a Failed Deploy](rollback.md)
