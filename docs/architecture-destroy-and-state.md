---
title: Destroy, state and locking
description: "What cdkd destroy does step by step, where cdkd keeps a stack's state in S3, what the state file records, and how the stack lock works."
---

# Destroy, state and locking

`cdkd destroy` works from the state file alone, so this page covers the two
together: what a destroy does, where state is stored and what it records, and
how the lock keeps two commands from changing the same stack at once.
[Architecture](architecture.md) has the overview.

## What `cdkd destroy` does

```bash
cdkd destroy MyStack
```

A destroy reads the stack's state and deletes every resource recorded there,
dependents first. It does not need the template, because the state file
already records which resources exist and which resources each one depends on.

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

The order comes from two sources:

- **The recorded dependencies.** Each resource in state lists the logical ids
  it depends on. cdkd rebuilds the dependency graph from those lists and walks
  it in reverse, so a resource is deleted before the resources it depends on.
- **Rules by resource type.** AWS enforces some delete orders that no
  reference in the template expresses. For example, a Lambda function in a VPC
  leaves a network interface in its subnet for some time after the function is
  deleted, so every subnet is deleted after every Lambda function. These rules
  are in `src/analyzer/implicit-delete-deps.ts`.

Each delete goes through the provider for that resource. The delete phase of a
deploy applies the same type rules.

## Where state is stored

State lives in one S3 bucket. cdkd uses no DynamoDB table. Each stack has its
own prefix for each region:

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

The `cdkd/` segment is the default value of `--state-prefix`. Because the
region is part of the path, the same stack name in two regions has two
independent state files.

## What the state file records

`state.json` holds one record for each resource in the stack. A record has
five parts:

- the physical id, which is the id AWS knows the resource by,
- the resource type,
- the resolved properties,
- the attributes that `Fn::GetAtt` reads,
- the logical ids the resource depends on.

The full schema and its version history are in
[State Management](state-management.md).

## How the stack lock works

A command that changes a stack first takes the stack's lock, so that two
commands cannot change the same stack at the same time. The lock is the S3
object `lock.json`, and cdkd writes it with conditional requests. S3 itself
refuses the request when the condition does not hold, which is why no separate
lock service is needed. The code is in `src/state/lock-manager.ts`.

| Step | Request | Succeeds only when |
| --- | --- | --- |
| Acquire | `PutObject` with `If-None-Match: *` | No lock exists |
| Renew | `PutObject` with `If-Match: <etag>` | This process still holds the lock |
| Release | `DeleteObject` with `If-Match: <etag>` | The lock is this process's own |

A lock carries an expiry time 30 minutes ahead, and a running command keeps
renewing its lock in the background. If a command dies without releasing its
lock, the lock expires, and the next command to acquire the lock clears it.

To clear a stuck lock by hand, run
[`cdkd force-unlock`](cli-force-unlock.md).

## Related

- [Architecture](architecture.md): the layers and the overview of a deploy
- [The deploy pipeline](architecture-deploy-pipeline.md)
- [State Management](state-management.md): the state schema
- [Rollback](rollback.md)
