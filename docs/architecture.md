---
title: Architecture
description: "How cdkd is put together: the seven layers, what a deploy and a destroy do step by step, and which source module owns each step."
---

# cdkd Architecture Documentation

cdkd deploys a CDK app without CloudFormation. It runs the app to get a
CloudFormation template, works out what changed since the last deploy, and
calls AWS APIs directly to create, update and delete resources.

This page gives you the model you need before changing the source: the layers,
what a deploy does in order, and which module owns each step. For the detailed
rules inside a step, follow the links to
[Architecture internals](architecture-internals.md).

## The seven layers

Each layer is one directory under `src/` and hands its result to the next.

| Layer | Directory | Owns |
| --- | --- | --- |
| CLI | `src/cli/` | Commands, option parsing, config resolution |
| Synthesis | `src/synthesis/` | Running the CDK app, reading the cloud assembly, context lookups |
| Assets | `src/assets/` | Publishing file assets to S3 and Docker images to ECR |
| Analysis | `src/analyzer/` | Template parsing, the dependency graph, the diff |
| State | `src/state/` | The state file in S3, the stack lock |
| Deployment | `src/deployment/` | Ordering and running resource operations, intrinsic resolution, rollback |
| Provisioning | `src/provisioning/` | The AWS calls: SDK providers, with Cloud Control as the fallback |

```text diagram=layers
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Layer                               │
│  (src/cli/)                                                     │
│  - commands/: deploy, diff, destroy, synth, bootstrap          │
│  - options.ts: CLI option definitions                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                    Synthesis Layer                              │
│  (src/synthesis/)                                               │
│  - app-executor.ts: CDK app execution via child_process        │
│  - assembly-reader.ts: manifest.json/template parser           │
│  - synthesizer.ts: Context provider loop orchestrator          │
│  - context-store.ts: cdk.context.json read/write               │
│  - context-providers/index.ts: Context provider registry       │
│  - context-providers/: Missing context resolution providers    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 │                     │
┌────────────────▼──────┐   ┌─────────▼────────────────────────────┐
│    Assets Layer       │   │      Analysis Layer                  │
│  (src/assets/)        │   │  (src/analyzer/)                     │
│  - file-asset-        │   │  - template-parser.ts: Template parsing│
│    publisher.ts       │   │  - dag-builder.ts: Dependency graph  │
│  - docker-asset-      │   │  - diff-calculator.ts: Diff calculation│
│    publisher.ts       │   │  - intrinsic-function-resolver.ts    │
│  - asset-publisher.ts │   │                                      │
│    (orchestrator)     │   │                                      │
└───────────────────────┘   └──────────┬───────────────────────────┘
                                       │
                            ┌──────────┴──────────┐
                            │                     │
┌───────────────────────────▼─────┐   ┌──────────▼──────────────────┐
│       State Layer               │   │   Deployment Layer          │
│  (src/state/)                   │   │  (src/deployment/)          │
│  - s3-state-backend.ts          │   │  - deploy-engine.ts         │
│  - lock-manager.ts              │   │  - intrinsic-function-      │
│  - State schema (types/state.ts)│   │    resolver.ts              │
└─────────────────────────────────┘   └──────────┬──────────────────┘
                                                 │
                                      ┌──────────▼──────────────────┐
                                      │   Provisioning Layer        │
                                      │  (src/provisioning/)        │
                                      │  - provider-registry.ts     │
                                      │  - cloud-control-provider.ts│
                                      │  - providers/:              │
                                      │    - See src/provisioning/  │
                                      │      providers/ for full    │
                                      │      list                   │
                                      │  - json-patch-generator.ts  │
                                      └─────────────────────────────┘
```

Shared types live in `src/types/`, shared helpers in `src/utils/`, and the
local emulation commands (`cdkd local ...`) in `src/local/`.

## What `cdkd deploy` does

```bash
cdkd deploy MyStack
```

1. **Resolve config.** The CLI resolves the app command (`--app`, then
   `CDKD_APP`, then `cdk.json`) and the state bucket (`--state-bucket`, then
   the environment, then `cdk.json`, then `cdkd-state-{accountId}`).
2. **Synthesize.** cdkd runs the CDK app as a subprocess and reads the cloud
   assembly it writes: one template and one asset manifest per stack.
3. **Schedule.** Every asset and every stack becomes a node in one work graph.
4. **Publish assets.** File assets go to S3 and Docker images to ECR, skipping
   any that are already there.
5. **Deploy each stack.** Take the lock, load state, diff the template against
   state, run the changes in dependency order, save state, release the lock.

The state bucket is resolved while synthesis runs, since synthesis does not
need it. The steps above are the logical order.

```text diagram=deploy-create
┌─────────────┐
│ User        │
│ $ cdkd      │
│   deploy    │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ CLI Layer       │
│ config-loader   │  --app (or CDKD_APP / cdk.json), --state-bucket (or env/cdk.json)
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ Synthesis Layer         │
│ AppExecutor             │  Execute CDK app via child_process.spawn()
│ AssemblyReader          │  Parse manifest.json from cdk.out/
│ Synthesizer             │  Context provider loop (resolve missing context)
└────────┬────────────────┘
         │
         │  (per stack, pipelined)
         ▼
┌─────────────────────────┐
│ Assets Layer            │
│ - Publish to S3/ECR     │  File: 8 concurrent, Docker: 4 concurrent
│ - Skip if exists        │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ State Layer             │
│ - Lock Acquire          │
│ - Get State (null)      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Analysis Layer          │
│ - Template Parse        │
│ - DAG Build             │
│ - Diff Calc (all CREATE)│
└────────┬────────────────┘
                  │
                  ▼
         ┌─────────────────────────┐
         │ Deployment Layer        │
         │ - Deploy Engine         │
         │ - Event-driven dispatch │
         └────────┬────────────────┘
                  │
         ┌────────┴─────────┐
         │                  │
         ▼                  ▼
┌─────────────────┐  ┌──────────────────┐
│ SDK Providers   │  │ Cloud Control    │
│ (preferred)     │  │ Provider         │
│ - S3, Lambda    │  │ (fallback)       │
│ - IAM, DynamoDB │  │ - Many types     │
│ - SQS, SNS, etc│  │ - Async polling  │
└────────┬────────┘  └──────────────────┘
         │
         │
         ▼
┌─────────────────────────┐
│ State Layer             │
│ - Resolve Outputs       │
│ - Save State            │
│ - Release Lock          │
└─────────────────────────┘
```

### Synthesis

cdkd does not depend on the CDK CLI or toolkit libraries. The CDK app itself
(`aws-cdk-lib`) generates the template. cdkd runs the app, reads its output and
answers its context lookups.

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

`AppExecutor` (`app-executor.ts`) spawns the app with these environment
variables:

| Variable | Value |
| --- | --- |
| `CDK_OUTDIR` | The output directory, `cdk.out` by default |
| `CDK_CONTEXT_JSON` | The merged context, serialized |
| `CDK_DEFAULT_REGION` | The AWS region |
| `CDK_DEFAULT_ACCOUNT` | The AWS account id |

Context is merged from five sources. A later row overrides an earlier one.

| Order | Source |
| --- | --- |
| 1 | CDK defaults (`aws:cdk:enable-path-metadata`, `aws:cdk:enable-asset-metadata`, `aws:cdk:version-reporting`, `aws:cdk:bundling-stacks`) |
| 2 | `~/.cdk.json`, the `context` field |
| 3 | `cdk.json`, the `context` field |
| 4 | `cdk.context.json`, the cached lookup results, reloaded on each loop iteration |
| 5 | `-c key=value` on the command line |

`AssemblyReader` (`assembly-reader.ts`) parses `cdk.out/manifest.json` to find
the stacks, their templates (`{StackName}.template.json`), their asset
manifests (`{StackName}.assets.json`) and the dependencies between stacks. It
also collects the CDK annotations (`Annotations.addError`, `addWarning`,
`addInfo`) for each stack. `synth` and `deploy` print warnings and refuse to
continue when a selected stack carries an error annotation.

When `--app` names an existing directory, cdkd treats it as an already
synthesized cloud assembly and skips running the app.

### The context provider loop

A construct such as `Vpc.fromLookup()` needs a value from the AWS account. The
app records the missing context key in the manifest and exits. `Synthesizer`
(`synthesizer.ts`) resolves the key through the AWS SDK, saves the answer to
`cdk.context.json`, and runs the app again until nothing is missing.

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

The same loop, by the module that performs each step:

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

### Assets and stacks run as one work graph

`WorkGraph` (`src/deployment/work-graph.ts`) schedules assets and stacks
together. A node becomes ready when all of its dependencies have completed, and
each node type has its own concurrency limit.

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

| Node type | Work | Limit | Flag |
| --- | --- | --- | --- |
| `asset-build` | Build a Docker image | 4 | `--image-build-concurrency` |
| `asset-publish` | Upload a file to S3 or push an image to ECR | 8 | `--asset-publish-concurrency` |
| `stack` | Deploy one stack | 4 | `--stack-concurrency` |

A file asset has one node, `asset-publish`. A Docker asset has two. A stack
waits for all of its assets and for the stacks CDK says it depends on. When a
node fails, the nodes downstream of it are skipped.

`FileAssetPublisher` checks for the object with `HeadObject` and skips the
upload when it exists. `DockerAssetPublisher` builds the image and pushes it.
`AssetPublisher` is the orchestrator the standalone `cdkd publish-assets`
command uses; `deploy` drives the individual asset nodes through the work
graph.

Assets go to one of two sets of locations, decided per region:

| Mode | When | S3 bucket | ECR repository |
| --- | --- | --- | --- |
| cdkd-assets | The region has a bootstrap marker written by `cdkd bootstrap` | `cdkd-assets-${AccountId}-${Region}` | `cdkd-container-assets-${AccountId}-${Region}` |
| Legacy | No marker for the region | `cdk-hnb659fds-assets-${AccountId}-${Region}` | `cdk-hnb659fds-container-assets-${AccountId}-${Region}` |

In cdkd-assets mode the template's references to the CDK bootstrap locations
are rewritten to the cdkd ones. The rewrite rules are in
[Architecture internals](architecture-internals.md#asset-storage).

### One stack, from lock to unlock

`DeployEngine` (`src/deployment/deploy-engine.ts` and the mixins in
`deploy-engine/`) deploys one stack:

1. Acquire the stack lock.
2. Load the stack's state from S3.
3. Parse the template and drop the resources whose `Condition` is false.
4. Build the dependency graph.
5. Diff the template against state. Each resource becomes `CREATE`, `UPDATE`,
   `DELETE` or `NO_CHANGE`.
6. Print the plan. With `--dry-run`, stop here.
7. Run the creates and updates in dependency order, then the deletes in
   reverse dependency order.
8. Resolve the template's `Outputs`.
9. Save state and release the lock.

State is also saved after each resource completes, so a crash mid-deploy leaves
a state file that matches what is in AWS.

#### Dependency edges

The dependency graph (`src/analyzer/dag-builder.ts`) has an edge wherever one
resource names another:

- a `DependsOn` attribute,
- a `Ref`,
- an `Fn::GetAtt`.

It also adds edges the template does not state. An IAM policy attached to a
custom resource's handler role gets an edge to the custom resource, so the
handler is not invoked before the policy exists. A Lambda function in a VPC
gets edges from its subnets and security groups, so that on delete the function
goes first and its network interfaces have time to detach.

#### Dispatch order

Dispatch is event-driven (`src/deployment/dag-executor.ts`). A resource starts
as soon as all of its own dependencies have completed. It does not wait
for unrelated resources at the same depth. `--concurrency` (default 10) caps
the operations in flight. Among the resources that are ready, the one with the
most transitive dependents starts first, so a slow chain such as an Elastic IP
followed by a NAT gateway starts early.

The log line `DAG: <n> levels` reports the depth of the graph. Levels are not
used to schedule anything.

#### When a resource fails

The resources downstream of the failed one are skipped, operations already in
flight finish, and nothing new starts. The engine then
rolls back what this run changed, unless the deploy ran with `--no-rollback`.
[Rollback](rollback.md) describes what a rollback undoes.

### How the diff decides

`DiffCalculator` (`src/analyzer/diff-calculator.ts`) compares each resource's
properties in state with the template. Three things about it matter when you
change anything near it:

- State holds resolved values and the template holds intrinsics, so the
  template side is resolved against current state before comparing.
- Only the keys the template declares are compared. Extra keys in state are
  values AWS added.
- A change to a property that cannot be updated in place makes the change a
  replacement: the new resource is created and the old one deleted. Replacing
  a stateful resource requires `--force-stateful-recreation`.

A replacement gives the resource a new physical id, so the resources that
reference it are promoted from `NO_CHANGE` to `UPDATE`. The promotion rules,
and the separate diff of the `Outputs` section, are in
[Architecture internals](architecture-internals.md#how-the-diff-compares-state-with-a-template).

### What an update sends

An SDK provider's `update()` calls the service's own update APIs. On the Cloud
Control route, cdkd generates a JSON Patch (RFC 6902) from the old and new
properties and calls `UpdateResource`:

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

## What `cdkd destroy` does

```bash
cdkd destroy MyStack
```

Destroy does not need the template. It reads the stack's state, rebuilds the
dependency graph from the `dependencies` recorded on each resource, adds the
delete-order edges that depend on resource type
(`src/analyzer/implicit-delete-deps.ts`), and deletes in reverse dependency
order through each resource's provider.

```text diagram=deploy-destroy
┌─────────────┐
│ User        │
│ $ cdkd      │
│   destroy   │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ CLI Layer       │
│ destroy.ts      │  <stackName>, --app, --force, --all (synth-based)
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ State Layer             │
│ - Get State             │
│ - Rebuild DAG from      │
│   state.dependencies    │
│ - Apply implicit type-  │
│   based delete deps     │
│   (analyzer/implicit-   │
│    delete-deps.ts)      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Deployment Layer        │
│ - Reverse Topology Sort │
│   (delete in reverse)   │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Provisioning Layer      │
│ - Provider.delete()     │
│   Execute in reverse    │
│   dependency order      │
└─────────────────────────┘
```

## State and locking

State lives in one S3 bucket, with no DynamoDB table. Each stack has its own
prefix per region:

```text
s3://cdkd-state-123456789012/cdkd/
├── MyStack/
│   └── us-east-1/
│       ├── state.json    # resources, outputs, schema version
│       └── lock.json     # present while a command holds the stack
└── _index/
    └── us-east-1/
        └── exports.json  # export name -> producing stack, for Fn::ImportValue
```

`cdkd` is the default `--state-prefix`. The same stack name in two regions has
two independent state files.

For each resource the state file records the physical id, the resource type,
the resolved properties, the attributes `Fn::GetAtt` reads, and the logical ids
it depends on. The full schema and its version history are in
[State Management](state-management.md).

The lock is an S3 object written with conditional requests
(`src/state/lock-manager.ts`):

| Step | Request | Effect |
| --- | --- | --- |
| Acquire | `PutObject` with `If-None-Match: *` | Succeeds only when no lock exists |
| Renew | `PutObject` with `If-Match: <etag>` | Succeeds only while this process still holds the lock |
| Release | `DeleteObject` with `If-Match: <etag>` | Deletes only this process's lock |

A lock carries an expiry time 30 minutes ahead, and a running command keeps
renewing it in the background. The next command to acquire the lock clears one
that has expired. A lock that is stuck can be cleared with
[`cdkd force-unlock`](cli-force-unlock.md).

## Provisioning: SDK providers and Cloud Control

Every resource operation goes through the `ResourceProvider` interface in
`src/types/resource.ts`. Three methods are required:

| Method | Returns |
| --- | --- |
| `create(logicalId, resourceType, properties, context?)` | The physical id and the attributes |
| `update(logicalId, physicalId, resourceType, properties, previousProperties, context?)` | The physical id, the attributes, and whether the resource was replaced |
| `delete(logicalId, physicalId, resourceType, properties?, context?)` | Nothing, or a report that the delete was skipped |

There are two kinds of provider:

| | SDK provider | Cloud Control provider |
| --- | --- | --- |
| Where | Classes in `src/provisioning/providers/` | `src/provisioning/cloud-control-provider.ts` |
| Calls | The service's own SDK client | `CreateResource`, `UpdateResource`, `DeleteResource`, `GetResource` |
| Speed | Synchronous calls, no polling | Asynchronous, polled until done |
| Covers | The properties someone wired | Every property in the type's CloudFormation schema |

`ProviderRegistry` (`src/provisioning/provider-registry.ts`) picks the provider
for each resource on each deploy. A registered SDK provider is preferred. Cloud
Control handles a type with no SDK provider, and a resource whose template sets
a property the SDK provider does not handle. `Custom::*` resources always go to
the custom resource provider. [Provisioning Layers](provisioning-layers.md) has
the complete order.

To add or change an SDK provider, read
[Provider Development](provider-development.md).

## Intrinsic functions

`IntrinsicFunctionResolver` (`src/deployment/intrinsic-function-resolver.ts`,
with its method groups in `intrinsic-resolver/`) turns template values into
concrete ones before they reach a provider. The diff uses it too.

| Function | Resolves to |
| --- | --- |
| `Ref` | A resource's physical id, a parameter value, or a pseudo parameter |
| `Fn::GetAtt` | A recorded attribute of a resource |
| `Fn::Join`, `Fn::Sub`, `Fn::Select`, `Fn::Split`, `Fn::Base64` | String and list operations |
| `Fn::If`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not` | Conditions |
| `Fn::FindInMap` | A `Mappings` lookup |
| `Fn::GetAZs` | The region's Availability Zones |
| `Fn::Cidr` | CIDR blocks |
| `Fn::ImportValue` | Another stack's export, from cdkd state, then from CloudFormation's `ListExports` |
| `Fn::GetStackOutput` | Another stack's output, across regions or accounts |

An intrinsic outside this list, such as `Fn::ToJsonString`, fails the deploy
with an error instead of being passed to a provider unresolved.

All seven pseudo parameters are supported: `AWS::AccountId`, `AWS::Region`,
`AWS::Partition`, `AWS::StackId`, `AWS::StackName`, `AWS::URLSuffix` and
`AWS::NoValue`. Partition and URL suffix are derived from the region.

The CloudFormation fallback for cross-stack references can be turned off with
`--no-cfn-fallback`. [Cross-stack reference internals](cross-stack-internals.md)
covers it.

Dynamic references (`{{resolve:secretsmanager:...}}`, `{{resolve:ssm:...}}`) are
resolved for the AWS call. A secret-bearing one is stored in state as the
unresolved expression where cdkd can certify the position. The cases it cannot
certify are listed in
[Architecture internals](architecture-internals.md#secrets-and-noecho-values-in-state).

## Where things live

Use this as a map from a task to a file.

| To change | Start in |
| --- | --- |
| A command or a flag | `src/cli/commands/<command>.ts`, `src/cli/options.ts` |
| How `--app` or `--state-bucket` is resolved | `src/cli/config-loader.ts` |
| How the CDK app is run | `src/synthesis/app-executor.ts` |
| A context lookup | `src/synthesis/context-providers/` |
| Asset upload or image push | `src/assets/file-asset-publisher.ts`, `src/assets/docker-asset-publisher.ts` |
| Dependency edges | `src/analyzer/dag-builder.ts` |
| What counts as a change, or as a replacement | `src/analyzer/diff-calculator.ts`, `src/analyzer/replacement-rules.ts` |
| Drift detection | `src/analyzer/drift-calculator.ts` |
| The state file's shape | `src/types/state.ts`, `src/state/s3-state-backend.ts` |
| Locking | `src/state/lock-manager.ts` |
| The order resources run in | `src/deployment/dag-executor.ts` |
| What a deploy does to one resource | `src/deployment/deploy-engine/` |
| Rollback | `src/deployment/rollback-executor.ts` |
| How an intrinsic resolves | `src/deployment/intrinsic-resolver/` |
| Which provider handles a type | `src/provisioning/provider-registry.ts`, `src/provisioning/register-providers.ts` |
| One resource type's AWS calls | `src/provisioning/providers/` |
| Logging, AWS clients, error classes | `src/utils/logger.ts`, `src/utils/aws-clients.ts`, `src/utils/error-handler.ts` |

The CLI entry point is `src/cli/index.ts`.

## Design constraints

These hold across the codebase. A change that breaks one needs a reason.

| Constraint | In practice |
| --- | --- |
| Layers do one job | The CLI parses and prints, analysis plans, deployment orders, provisioning calls AWS. |
| The engine depends on the `ResourceProvider` interface | It never names a concrete provider. Supporting a new type means registering a provider. |
| No `@aws-cdk/*` imports | Synthesis, assembly reading and asset publishing are implemented here. `aws-cdk-lib` is the user's dependency, and a `devDependency` here for tests. |
| State follows AWS | State is saved as each resource completes, so a failed or interrupted run can be rolled back, resumed or destroyed. |
| Speed on the common path | A check added to deploy or destroy must not grow with the number of stacks or resources. |

## What limits deploy speed

1. Asset publishing: uploading Lambda code and pushing images.
2. Cloud Control polling, for types without an SDK provider.
3. Cloud Control rate limits, which are per resource type.
4. Long dependency chains, which cap how much can run in parallel.

Measured comparisons with CloudFormation are in [Benchmarks](benchmarks.md).

## What cdkd does not do

- There are no change sets. A deploy applies its changes. `cdkd diff` and
  `--dry-run` preview them.
- A CloudFormation macro whose output contains another macro is not
  supported. Single-stage macros are expanded through a temporary
  CloudFormation change set.

## Related

- [Architecture internals](architecture-internals.md)
- [State Management](state-management.md)
- [Provisioning Layers](provisioning-layers.md)
- [Provider Development](provider-development.md)
- [Rollback](rollback.md)
- [AWS Cloud Control API Reference](https://docs.aws.amazon.com/cloudcontrolapi/latest/APIReference/Welcome.html)
