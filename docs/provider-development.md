---
title: Provider Development
description: "How to add a cdkd SDK provider: a walkthrough of a real one, from the first file through registration, tests and the integration fixture."
---

# cdkd Provider Development Guide

A **provider** is the class that makes the AWS calls for a resource type. cdkd
has two kinds. An **SDK provider** is written by hand for one service and calls
that service's SDK client directly. The **Cloud Control provider** is generic
and handles the types nobody has written an SDK provider for.

Adding an SDK provider for a commonly used type makes deploys of that type
faster, because the provider's calls return without polling. An SDK provider
can also handle what the generic route cannot, such as retries for IAM
propagation, or a type Cloud Control does not support.

This page walks through one small SDK provider from the first file to the pull
request. Read [Architecture](architecture.md) first if you have not seen how
the deploy engine calls a provider.

## In this section

- [Import and drift support for a provider](provider-development-import-and-drift.md)
  shows the two optional methods, `import` and `readCurrentState`.
- [Testing and shipping a provider](provider-development-testing.md) covers
  the schema check, the unit tests, the integration fixture and the
  documentation rows a new provider needs.
- [Provider reference](provider-development-reference.md) lists every member
  of the `ResourceProvider` interface and the rules every provider obeys, and
  has the fixes for the common problems.
- [Provider implementation rules](provider-rules.md) is the complete rulebook,
  with the reasoning and the code for each rule.
- [Provider Development internals](provider-development-internals.md) covers
  the less common return fields and methods.

## How a resource reaches your provider

`ProviderRegistry` chooses a provider for each resource on each deploy. Your
SDK provider is chosen when the resource's type is registered to it and it
handles every property the template sets.

```text diagram=contrib-provider-routing
              Resource in the template
                         |
                         v
                 ProviderRegistry
                         |
        +----------------+-----------------+
        |                |                 |
        v                v                 v
Custom resource     SDK provider      Cloud Control
provider                              provider

Custom::* types     the type is       no SDK provider, or
                    registered and    the template sets a
                    every property    property the SDK
                    is handled        provider does not handle
```

Two consequences follow for a provider author:

- Your provider only sees a resource whose top-level properties are all in the
  provider's `handledProperties` set. A template that sets any other property
  is sent through Cloud Control instead, so that the property is not silently
  dropped.
- State records which route created each resource. A resource that state
  records as created through Cloud Control normally stays on Cloud Control
  after you add an SDK provider for its type.

[Provisioning Layers](provisioning-layers.md) has the full order of the
decision.

## Before you write code

Open the CloudFormation resource reference and the AWS SDK documentation for
the type, and answer five questions:

1. Does a provider already exist? Check
   `src/provisioning/register-providers.ts`, because a type is registered once.
2. Which SDK client do you need, and which calls create, update, delete and
   describe the resource? Those calls are the body of the provider.
3. What does CloudFormation use as the physical id, the value `Ref` returns?
   Your `create` must return the same thing.
4. Which attributes does `Fn::GetAtt` expose? Your `create` and `update`
   return them.
5. Which properties are marked "Update requires: Replacement"? An update to
   one of those must not be sent as an in-place change.

## Provider Implementation Examples

The example is `DocDBSubnetGroupProvider`, which serves
`AWS::DocDB::DBSubnetGroup`. It is one of the smallest providers in the tree,
and it has every part a provider needs. The code below is taken from
[`src/provisioning/providers/docdb-subnet-group-provider.ts`](https://github.com/go-to-k/cdkd/blob/main/src/provisioning/providers/docdb-subnet-group-provider.ts),
shortened where marked.

The walkthrough has eight steps. Steps 1 to 6 make a working provider. Step 7
adds two optional methods, and step 8 is the tests and the bookkeeping a pull
request needs.

For a larger provider that manages sub-resources, read `iam-role-provider.ts`.
It attaches managed policies and writes inline policies on create, diffs them
on update, and removes them before it deletes the role.

### 1. Create the file and the client

Name the file `src/provisioning/providers/{service}-{resource}-provider.ts`,
for example `docdb-subnet-group-provider.ts` or `lambda-function-provider.ts`.
The class implements `ResourceProvider` and owns one SDK client:

```ts
import { DocDBClient /* and the commands */ } from '@aws-sdk/client-docdb';
import { getLogger } from '../../utils/logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { assertRegionMatch } from '../region-check.js';
import type { ResourceProvider, UpdateContext } from '../../types/resource.js';

export class DocDBSubnetGroupProvider implements ResourceProvider {
  private docdbClient?: DocDBClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('DocDBSubnetGroupProvider');

  private getClient(): DocDBClient {
    if (!this.docdbClient) {
      this.docdbClient = new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.docdbClient;
  }
}
```

There are two ways to get a client:

- `getAwsClients()` from `src/utils/aws-clients.ts` has shared clients for the
  most used services (`.s3`, `.iam`, `.lambda` and others). Use a shared client
  when one exists.
- Otherwise build the client yourself, lazily, as the example does. Spread
  `ambientClientDefaults()` first, because that call carries the active
  profile and credentials.

Read the region through `ambientRegion()`, never from `process.env.AWS_REGION`.
`cdkd deploy` runs stacks in several regions at once. The environment variable
belongs to the whole process, while `ambientRegion()` follows the stack that
is being deployed.

If the SDK package is not yet a dependency, add it with
`vp add @aws-sdk/client-<service>`.

### 2. Declare the properties you handle

`handledProperties` maps each resource type to the set of top-level properties
your provider sends to AWS:

```ts
handledProperties = new Map<string, ReadonlySet<string>>([
  [
    'AWS::DocDB::DBSubnetGroup',
    new Set([
      'DBSubnetGroupName',
      'DBSubnetGroupDescription',
      'SubnetIds',
      'Tags',
    ]),
  ],
]);
```

List a property only when `create` and `update` both send it to AWS. The
registry reads this set to decide whether a resource can come to your provider.
A unit test also compares the set with the type's CloudFormation schema. Step 8
comes back to it.

### 3. `create`

`create` receives the resolved properties, makes the resource, and returns its
physical id and its attributes.

```ts
async create(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): Promise<ResourceCreateResult> {
  this.logger.debug(safeMsg`Creating DocDB DBSubnetGroup ${logicalId}`);
  // A malformed Tags value is refused before any call.
  const tags = refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId
  );

  const dbSubnetGroupName =
    (properties['DBSubnetGroupName'] as string | undefined) ||
    generateResourceName(logicalId, { maxLength: 255, lowercase: true });

  try {
    await this.getCreateClient().send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: dbSubnetGroupName,
        DBSubnetGroupDescription:
          (properties['DBSubnetGroupDescription'] as string) ||
          `Subnet group for ${logicalId}`,
        SubnetIds: properties['SubnetIds'] as string[],
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    return {
      physicalId: dbSubnetGroupName,
      attributes: { DBSubnetGroupName: dbSubnetGroupName },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProvisioningError(
      `Failed to create DocDB DBSubnetGroup ${logicalId}: ${message}`,
      resourceType,
      logicalId,
      dbSubnetGroupName,
      cause
    );
  }
}
```

Five things in this method apply to every provider:

- **The name.** When the template gives no name, `generateResourceName`
  (`src/provisioning/resource-name.ts`) builds `{StackName}-{LogicalId}-{Hash}`
  and cuts it to the service's length limit.
- **The physical id.** Return what CloudFormation's `Ref` returns for the
  type. For a subnet group that is its name.
- **The attributes.** Return each attribute a template can read with
  `Fn::GetAtt`.
- **The error.** Put every AWS call inside a `try`, and rethrow a failure as
  `ProvisioningError` with the type, the logical id, the physical id and the
  original error as the cause. The user then sees which resource failed.
- **The log line.** `safeMsg` keeps a value from the template on one line, so
  the value cannot forge a log row.

When an attribute's value can be missing, build the map with
`definedAttributes` (`src/provisioning/attribute-map.ts`). It leaves the key
out instead of storing an empty string.

You do not need a retry loop in `create` for transient errors. The deploy
engine already retries a provider call that fails with one, such as an IAM
role that has not propagated yet. If you do add a `withRetry` call of your
own, it must pass an interrupt watch so that {kbd:ctrl+c} stops the wait. See
[A retry loop inside a provider must honor Ctrl-C](provider-development-reference.md#a-retry-loop-inside-a-provider-must-honor-ctrl-c).

If the create API of your type hands back an existing resource of the same
name, the provider needs two more methods. See
[A create that adopts an existing name](provider-development-reference.md#a-create-that-adopts-an-existing-name).

### 4. `update`

`update` receives the new properties and the previous ones, and changes the
existing resource in place.

```ts
async update(
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    physicalId
  );

  try {
    const subnetIds = properties['SubnetIds'] as string[] | undefined;
    const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
    await this.getClient().send(
      new ModifyDBSubnetGroupCommand({
        DBSubnetGroupName: physicalId,
        DBSubnetGroupDescription: clearOnUpdateRemoval(
          properties['DBSubnetGroupDescription'] as string | undefined,
          previousProperties['DBSubnetGroupDescription'] as string | undefined,
          `Subnet group for ${logicalId}`
        ),
        ...(sendSubnetIds && { SubnetIds: subnetIds }),
      })
    );

    // ... apply the tag diff between previousProperties and properties ...

    return {
      physicalId,
      wasReplaced: false,
      attributes: { DBSubnetGroupName: physicalId },
    };
  } catch (error) {
    // ... rethrow as ProvisioningError, as in create ...
  }
}
```

`assertRegionMatch` runs before any AWS call. `context.expectedRegion` is the
region cdkd recorded in state, and a client in another region would send the
update to a resource of the same name that cdkd does not manage. Declare the
`context` parameter even when your `update` sends nothing:
`scripts/check-provider-update-context.ts` fails on a provider that leaves it
out.

The call to `clearOnUpdateRemoval` is the part that is easy to miss. Suppose a
user sets `DBSubnetGroupDescription`, deploys, then deletes the property from
the template and deploys again. CloudFormation would reset the description to
its default. Most AWS update APIs treat a missing field as "leave it alone",
so a provider that passes properties straight through keeps the old description
in AWS while state says it is gone.

`clearOnUpdateRemoval(newValue, previousValue, clearValue)` handles the three
cases:

| The property | It returns |
| --- | --- |
| Has a new value | The new value |
| Was set before and is now absent | The clear value |
| Was never set | `undefined` |

Check every optional property your `update` sends. The per-field checklist is
in
[Update removal semantics](provider-rules.md#update-removal-semantics-clear-on-removal).

`update` handles in-place changes only. When a create-only property changes,
the diff classifies the change as a replacement. The engine then calls your
`create` for the new resource and your `delete` for the old one.

### 5. `delete`

`delete` removes the resource. Deleting a resource that is already gone
succeeds.

```ts
async delete(
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  try {
    await this.getClient().send(
      new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: physicalId })
    );
  } catch (error) {
    if (isDocDBNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(
        clientRegion,
        context?.expectedRegion,
        resourceType,
        logicalId,
        physicalId
      );
      return;
    }
    // ... rethrow as ProvisioningError ...
  }
}
```

Before you treat "not found" as success, call `assertRegionMatch`
(`src/provisioning/region-check.ts`), as the example does.

> [!WARNING]
> A destroy that runs against the wrong region gets "not found" for every
> resource. Without the region check, cdkd would remove them all from state
> and leave the real resources running in the other region.

Returning normally from `delete` tells the engine that the resource is gone.
If your `delete` decides to make no AWS call, return
`{ outcome: 'skipped', reason }` instead. `cdkd destroy` then keeps the state
record and reports the skip. See
[Reporting a skipped delete](provider-rules.md#reporting-a-skipped-delete).

### 6. Register the provider

Registration takes one line in each of two files. First re-export the class
from `src/provisioning/provider-classes.ts`:

```ts
export {
  DocDBSubnetGroupProvider,
} from './providers/docdb-subnet-group-provider.js';
```

Then open `registerAllProviders()` in
`src/provisioning/register-providers.ts`. Add the class to the
`const { ... } = classes` destructure and register the type:

```ts
registry.register('AWS::DocDB::DBSubnetGroup', new DocDBSubnetGroupProvider());
```

Do not import the provider module anywhere else. A provider module loads its
`@aws-sdk/client-*` package, so a static import would put that client on the
startup path of every command. `provider-classes.ts` is loaded on demand, and a
unit test fails on a static import.

A provider that serves several types registers one instance for all of them:

```ts
const docdbProvider = new DocDBProvider();
registry.register('AWS::DocDB::DBCluster', docdbProvider);
registry.register('AWS::DocDB::DBInstance', docdbProvider);
```

### 7. Add import and drift support (optional)

The provider can now deploy and destroy the type. Two optional methods connect
it to two more commands:

- `import` lets `cdkd import` adopt a resource that already exists in AWS.
- `readCurrentState` lets `cdkd drift` compare the resource in AWS with state.

[Import and drift support for a provider](provider-development-import-and-drift.md)
shows both methods for this provider.

### 8. Test it and finish the pull request

The provider now works, but a pull request needs four more things. Each one is
a section of [Testing and shipping a provider](provider-development-testing.md):

1. Fetch the type's CloudFormation schema, and account for every property in
   it. The `property-coverage` unit test fails until you do.
2. Write unit tests for each method, with the SDK client mocked.
3. Add an integration fixture that deploys and destroys the type in real AWS.
4. List the type in the supported-resources tables, regenerate the coverage
   matrix, and add a changelog entry.

Then run the checks, and go through
[the rules every provider obeys](provider-development-reference.md#rules-every-provider-obeys):

```bash
vp run check && vp test run && vp run build
```

If the provider does not behave as you expect, see
[When something does not work](provider-development-reference.md#when-something-does-not-work).

## Related

- [Import and drift support for a provider](provider-development-import-and-drift.md)
- [Testing and shipping a provider](provider-development-testing.md)
- [Provider reference](provider-development-reference.md): the interface
  members and the rules checklist
- [Provider implementation rules](provider-rules.md): the complete rulebook
- [Provider Development internals](provider-development-internals.md): the
  less common return fields and methods
- [Integration fixture conventions](integ-fixture-conventions.md): the rules
  the fixture for your provider follows
- [Supported Resources](supported-resources.md): the types that have a
  provider today
- [CloudFormation resource reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
