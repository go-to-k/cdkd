---
title: Architecture
description: "How cdkd is put together: the seven layers, what a deploy does from start to finish, and which source module owns each step."
---

# cdkd Architecture Documentation

cdkd deploys a CDK app without CloudFormation. It runs the app to get a
CloudFormation template, works out what changed since the last deploy, and
calls AWS APIs directly to create, update and delete resources.

This page gives you the model to hold in your head before you change the
source: the seven layers, and what one `cdkd deploy` does from start to finish.
Each part has its own page with the detail.

## In this section

- [The deploy pipeline](architecture-deploy-pipeline.md) follows a deploy
  through synthesis, asset publishing, the diff and the resource operations.
- [Destroy, state and locking](architecture-destroy-and-state.md) covers what
  `cdkd destroy` does, where state is stored, and how a stack is locked.
- [Providers and intrinsic functions](architecture-provisioning.md) covers how
  a resource operation reaches AWS, and how `Ref` and the `Fn::` functions are
  turned into values.
- [Architecture internals](architecture-internals.md) holds the detailed rules
  behind the diff, secrets in state and asset storage. Read it when you change
  one of those modules.

## The seven layers

The source is organised as seven layers. Each layer is one directory under
`src/`, does one job, and hands its result to the next layer.

| Layer | Directory | Owns |
| --- | --- | --- |
| CLI | `src/cli/` | Commands, option parsing, config resolution |
| Synthesis | `src/synthesis/` | Running the CDK app, reading its output, context lookups |
| Assets | `src/assets/` | Uploading files to S3, pushing images to ECR |
| Analysis | `src/analyzer/` | Template parsing, the dependency graph, the diff |
| State | `src/state/` | The state file in S3, the stack lock |
| Deployment | `src/deployment/` | Ordering and running resource operations, intrinsic resolution, rollback |
| Provisioning | `src/provisioning/` | The AWS calls: SDK providers, with Cloud Control as the fallback |

The diagram shows the same layers with the main files in each:

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

Three directories sit beside the layers. Shared types are in `src/types/`,
shared helpers are in `src/utils/`, and the local emulation commands
(`cdkd local ...`) are in `src/local/`.

## What `cdkd deploy` does

```bash
cdkd deploy MyStack
```

Suppose `MyStack` contains a Lambda function and an SQS queue. The command goes
through five stages, and each stage belongs to one or two layers:

1. **Resolve the configuration.** The CLI works out which command runs the CDK
   app and which S3 bucket holds cdkd's state.
2. **Synthesize.** cdkd runs the CDK app as a subprocess. The app writes a
   directory called the cloud assembly, which holds one CloudFormation
   template and one list of assets for each stack.
3. **Schedule.** Every asset and every stack becomes a node in one graph of
   work, so that a stack starts only after its assets are published.
4. **Publish the assets.** The function's code is uploaded to S3. A Docker
   image would be pushed to ECR. An asset that is already there is skipped.
5. **Deploy the stack.** cdkd locks the stack, loads its state, and compares
   the template with the state. It then runs the changes in dependency order,
   saves the state, and releases the lock.

On the first deploy there is no state, so the comparison marks the function and
the queue as resources to create. On a later deploy the state records what the
last deploy created, and a resource that the comparison finds unchanged is left
alone.

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

The last step of the diagram splits in two because cdkd has two ways to call
AWS. A resource type with a hand-written SDK provider is created through that
service's own API. Any other type goes through the Cloud Control API.
[Providers and intrinsic functions](architecture-provisioning.md) explains how
the choice is made.

[The deploy pipeline](architecture-deploy-pipeline.md) describes each of the
five stages in detail.

## What `cdkd destroy` does

`cdkd destroy MyStack` does not run the diff, because it does not need the
template. It reads the stack's state, works out the order from the
dependencies recorded there, and deletes every resource in reverse dependency
order. [Destroy, state and locking](architecture-destroy-and-state.md) has the
steps.

## Where things live

Use this table to get from a task to the file you start in.

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

Five constraints hold across the codebase. A change that breaks one of them
needs a reason.

- **Each layer does one job.** The CLI parses and prints, analysis plans,
  deployment orders the work, and provisioning calls AWS.
- **The engine depends on the `ResourceProvider` interface.** The engine never
  names a concrete provider, so supporting a new resource type means
  registering a provider.
- **No `@aws-cdk/*` imports.** Synthesis, reading the cloud assembly and
  publishing assets are implemented in this repository. `aws-cdk-lib` is the
  user's dependency, and it is a `devDependency` here for the tests.
- **State follows AWS.** State is saved as each resource completes, so a
  failed or interrupted run can be rolled back, resumed or destroyed.
- **The common path stays fast.** A check added to deploy or destroy must not
  grow with the number of stacks or resources.

## What limits deploy speed

Four things limit how fast a deploy can be:

1. Asset publishing, which uploads Lambda code and pushes images.
2. Cloud Control polling, for resource types that have no SDK provider.
3. Cloud Control rate limits, which apply per resource type.
4. Long dependency chains, which cap how much can run in parallel.

Measured comparisons with CloudFormation are in [Benchmarks](benchmarks.md).

## What cdkd does not do

- cdkd has no change sets. A deploy applies its changes. To preview them, run
  `cdkd diff` or `cdkd deploy --dry-run`.
- A CloudFormation macro whose output contains another macro is not supported.
  A single-stage macro is expanded through a temporary CloudFormation change
  set.

## Related

- [State Management](state-management.md)
- [Provisioning Layers](provisioning-layers.md)
- [Provider Development](provider-development.md)
- [Rollback](rollback.md)
- [AWS Cloud Control API Reference](https://docs.aws.amazon.com/cloudcontrolapi/latest/APIReference/Welcome.html)
