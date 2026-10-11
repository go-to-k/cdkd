---
title: Providers and intrinsic functions
description: "How a cdkd resource operation reaches AWS through an SDK provider or the Cloud Control API, and how Ref, Fn::GetAtt and the other intrinsic functions are resolved to values first."
---

# Providers and intrinsic functions

Before cdkd can create a resource, two things happen to it. The intrinsic
functions in its properties, such as `Ref`, are replaced by real values. Then a
provider, the class that makes the AWS calls for that resource type, receives
those values. This page covers both, starting with the provider.
[Architecture](architecture.md) has the overview.

## Every AWS call goes through a provider

Every operation on a resource goes through a provider. The deploy engine calls
the provider through the `ResourceProvider` interface in
`src/types/resource.ts`, and the provider makes the AWS calls. The interface
requires three methods:

| Method | Returns |
| --- | --- |
| `create(logicalId, resourceType, properties, context?)` | The physical id and the attributes |
| `update(logicalId, physicalId, resourceType, properties, previousProperties, context?)` | The physical id, the attributes, and whether the resource was replaced |
| `delete(logicalId, physicalId, resourceType, properties?, context?)` | Nothing, or a report that the delete was skipped |

The physical id is the id AWS knows the resource by, such as a bucket name or
an ARN. The attributes are the values a template reads with `Fn::GetAtt`. cdkd
saves both in state, so later resources and later deploys can refer to them.

## SDK providers and the Cloud Control provider

There are two kinds of provider. An SDK provider is written by hand for one
service and calls that service's API directly. The Cloud Control provider is a
single generic class that calls the AWS Cloud Control API, which can manage
many resource types through one set of operations.

| | SDK provider | Cloud Control provider |
| --- | --- | --- |
| Where | Classes in `src/provisioning/providers/` | `src/provisioning/cloud-control-provider.ts` |
| Calls | The service's own SDK client | `CreateResource`, `UpdateResource`, `DeleteResource`, `GetResource` |
| Speed | Synchronous calls, no polling | Asynchronous, polled until done |
| Covers | The properties someone wired | Every property in the type's CloudFormation schema |

The trade-off is speed against coverage. An SDK provider is faster, but it
only sends the properties its author handled. Cloud Control is slower, but it
accepts every property the type's CloudFormation schema defines.

## How a provider is chosen

`ProviderRegistry` (`src/provisioning/provider-registry.ts`) picks the provider
for each resource on each deploy. It prefers a registered SDK provider, and it
uses Cloud Control in two cases:

- the resource type has no SDK provider,
- the template sets a property that the SDK provider does not handle.

The second case exists so that a property is never dropped without notice.
`Custom::*` resources are the exception to both rules. They always go to the
custom resource provider.

[Provisioning Layers](provisioning-layers.md) has the complete order of the
decision. To add or change an SDK provider, read
[Provider Development](provider-development.md).

## Intrinsic functions

A template rarely holds final values. A Lambda function's `Role` property, for
example, is usually `{ "Fn::GetAtt": ["MyRole", "Arn"] }`, and the ARN does not
exist until the role is created. `IntrinsicFunctionResolver` turns each such
expression into a concrete value before the properties reach a provider. The
diff uses the same resolver.

The resolver is in `src/deployment/intrinsic-function-resolver.ts`, and its
method groups are in `intrinsic-resolver/`. It supports these functions:

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

An intrinsic function outside this table, such as `Fn::ToJsonString`, fails the
deploy with an error. cdkd does not pass an unresolved expression to a
provider.

### Pseudo parameters

All seven pseudo parameters are supported: `AWS::AccountId`, `AWS::Region`,
`AWS::Partition`, `AWS::StackId`, `AWS::StackName`, `AWS::URLSuffix` and
`AWS::NoValue`. The partition and the URL suffix are derived from the region.

### Cross-stack references

`Fn::ImportValue` looks for the export in cdkd's state first. When no cdkd
stack produces the export, the resolver falls back to CloudFormation's
`ListExports`, so a cdkd stack can import a value from a stack that
CloudFormation deployed. `--no-cfn-fallback` turns the fallback off.
[Cross-stack reference internals](cross-stack-internals.md) covers it.

### Dynamic references

A dynamic reference is a string such as `{{resolve:secretsmanager:...}}` or
`{{resolve:ssm:...}}` that stands for a value stored in Secrets Manager or
Systems Manager. cdkd resolves the reference for the AWS call.

When the reference points at a secret, the resolved value should not be written
to state. So before cdkd saves state, it puts the unresolved `{{resolve:...}}`
expression back at every position where it can confirm that the value came
from the reference. The positions it cannot confirm keep the value, and they
are listed in
[Architecture internals](architecture-internals.md#secrets-and-noecho-values-in-state).

## Related

- [Architecture](architecture.md): the layers and the overview of a deploy
- [The deploy pipeline](architecture-deploy-pipeline.md)
- [Provisioning Layers](provisioning-layers.md): the order of the provider
  decision
- [Provider Development](provider-development.md): writing an SDK provider
- [AWS Cloud Control API Reference](https://docs.aws.amazon.com/cloudcontrolapi/latest/APIReference/Welcome.html)
