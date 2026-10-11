---
title: Provider Development
description: "How to add or change a cdkd SDK provider: a walkthrough of a real one from file to registration and tests, then the rules every provider obeys."
---

# cdkd Provider Development Guide

A **provider** is the class that makes the AWS calls for a resource type. cdkd
has two kinds. An **SDK provider** is written by hand for one service and calls
that service's SDK client directly. The **Cloud Control provider** is generic
and handles the types nobody has written an SDK provider for.

An SDK provider's calls return without polling, so adding one for a commonly
used type makes deploys of that type faster. It can also handle what the
generic route cannot, such as retries for IAM propagation or a type Cloud
Control does not support.

This page walks through one small SDK provider from start to finish, then lists
the rules every provider obeys. Read [Architecture](architecture.md) first if
you have not seen how the deploy engine calls a provider.

## How a resource reaches your provider

`ProviderRegistry` chooses a provider for each resource on each deploy.

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

Two consequences for a provider author:

- Your provider only sees a resource whose top-level properties are all in the
  provider's `handledProperties`. A template that sets any other property is
  sent through Cloud Control, so the property is not silently dropped.
- A resource that state records as created through Cloud Control normally stays
  there after you add an SDK provider for its type.

[Provisioning Layers](provisioning-layers.md) has the full order of the
decision.

## Before you write code

Answer these from the CloudFormation resource reference and the AWS SDK
documentation for the type:

| Question | Why you need it |
| --- | --- |
| Does a provider already exist? Check `src/provisioning/register-providers.ts`. | A type is registered once. |
| Which SDK client and which create, update, delete and describe calls? | These are the body of the provider. |
| What does CloudFormation use as the physical id (the `Ref` value)? | Your `create` must return the same thing. |
| Which attributes does `Fn::GetAtt` expose? | Your `create` and `update` return them. |
| Which properties are marked "Update requires: Replacement"? | An update to one must not be sent as an in-place change. |

## Provider Implementation Examples

The example is `DocDBSubnetGroupProvider`, which serves
`AWS::DocDB::DBSubnetGroup`. It is one of the smallest providers in the tree and
has every part a provider needs. The code below is taken from
[`src/provisioning/providers/docdb-subnet-group-provider.ts`](https://github.com/go-to-k/cdkd/blob/main/src/provisioning/providers/docdb-subnet-group-provider.ts),
shortened where marked.

For a larger provider with sub-resources to manage, read
`iam-role-provider.ts`, which attaches managed policies and writes inline
policies on create, diffs them on update, and removes them before deleting the
role.

### 1. Create the file and the client

Name the file `src/provisioning/providers/{service}-{resource}-provider.ts`,
for example `docdb-subnet-group-provider.ts` or `lambda-function-provider.ts`.

```ts
import { DocDBClient /* and the commands */ } from '@aws-sdk/client-docdb';
import { getLogger } from '../../utils/logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import type { ResourceProvider } from '../../types/resource.js';

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
  most used services (`.s3`, `.iam`, `.lambda` and others). Use one when it
  exists.
- Otherwise build the client yourself, lazily, with `ambientClientDefaults()`
  spread first. That call carries the active profile and credentials.

Read the region through `ambientRegion()`, never from `process.env.AWS_REGION`.
`cdkd deploy` runs stacks in several regions at once, and the environment
variable belongs to the process, while `ambientRegion()` follows the stack
being deployed.

If the SDK package is not yet a dependency, add it with
`vp add @aws-sdk/client-<service>`.

### 2. Declare the properties you handle

```ts
handledProperties = new Map<string, ReadonlySet<string>>([
  [
    'AWS::DocDB::DBSubnetGroup',
    new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
  ],
]);
```

List a property here only when `create` and `update` both send it to AWS. The
registry reads this set to decide whether a resource can come to your provider,
and a unit test compares it with the type's CloudFormation schema (step 9).

### 3. `create`

`create` receives the resolved properties and returns the physical id and the
attributes.

```ts
async create(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): Promise<ResourceCreateResult> {
  this.logger.debug(safeMsg`Creating DocDB DBSubnetGroup ${logicalId}`);
  // A malformed Tags value is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const dbSubnetGroupName =
    (properties['DBSubnetGroupName'] as string | undefined) ||
    generateResourceName(logicalId, { maxLength: 255, lowercase: true });

  try {
    await this.getCreateClient().send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: dbSubnetGroupName,
        DBSubnetGroupDescription:
          (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
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
    throw new ProvisioningError(
      `Failed to create DocDB DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
      resourceType,
      logicalId,
      dbSubnetGroupName,
      cause
    );
  }
}
```

What to copy from it:

| Part | Rule |
| --- | --- |
| The name | When the template gives none, `generateResourceName` (`src/provisioning/resource-name.ts`) builds `{StackName}-{LogicalId}-{Hash}`, cut to the service's length limit. |
| The physical id | It is what CloudFormation's `Ref` returns for the type, here the subnet group name. |
| The attributes | Return each attribute a template can read with `Fn::GetAtt`. |
| The error | Every AWS call is inside a `try`. A failure is rethrown as `ProvisioningError` with the type, logical id, physical id and the original error as the cause. |
| The log line | `safeMsg` keeps a value from the template on one line, so it cannot forge a log row. |

When an attribute's value can be missing, build the map with
`definedAttributes` (`src/provisioning/attribute-map.ts`). It leaves the key out
instead of storing an empty string.

The deploy engine retries a provider call that fails with a transient error,
such as an IAM role that has not propagated yet. You do not need a retry loop
for that in `create`.

### 4. `update`

`update` receives the new properties and the previous ones, and changes the
existing resource in place.

```ts
async update(
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Promise<ResourceUpdateResult> {
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

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

The call to `clearOnUpdateRemoval` is the part that is easy to miss. When a
user deletes a property from their template, CloudFormation resets it to its
default. Most AWS update APIs treat a missing field as "leave it alone". A
provider that passes properties straight through therefore keeps the old value
in AWS while state says it is gone.

`clearOnUpdateRemoval(newValue, previousValue, clearValue)` returns the new
value when there is one, the clear value when the property was set before and
is now absent, and `undefined` when it was never set. Check every optional
property your `update` sends. The per-field checklist is in
[Update removal semantics](provider-rules.md#update-removal-semantics-clear-on-removal).

`update` handles in-place changes only. When a create-only property changes,
the diff classifies the change as a replacement, and the engine calls your
`create` for the new resource and your `delete` for the old one.

### 5. `delete`

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

Deleting a resource that is already gone succeeds. Before treating "not found"
as success, call `assertRegionMatch` (`src/provisioning/region-check.ts`).

> [!WARNING]
> A destroy that runs against the wrong region gets "not found" for every
> resource. Without the region check, cdkd would remove them all from state
> and leave the real resources running in the other region.

Returning normally from `delete` means the resource is gone. If your `delete`
decides to make no AWS call, return `{ outcome: 'skipped', reason }` instead,
so `cdkd destroy` keeps the state record and reports the skip. See
[Reporting a skipped delete](provider-rules.md#reporting-a-skipped-delete).

### 6. `import`

`import` lets `cdkd import` adopt a resource that already exists in AWS. It is
optional. Without it, the type can only be adopted by passing the physical id
with `--resource <logicalId>=<physicalId>`.

```ts
async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
  if (explicit) {
    try {
      await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
      );
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
      throw err;
    }
  }
  return null;
}
```

`resolveExplicitPhysicalId` returns the `--resource` override, or the name the
template gives in the named property. Pass `null` as the second argument for a
type with no name property. Confirm the resource exists with a describe call,
and return `null` when it does not: `cdkd import` reads `null` as "not deployed
yet", not as a failure.

> [!IMPORTANT]
> Do not look a resource up by an `aws:cdk:path` tag. AWS rejects any tag
> whose key starts with `aws:`, so no resource carries that tag and the lookup
> can never match.

`attributes: {}` is right when the physical id alone answers every `Ref` and
`Fn::GetAtt` for the type. When it does not, see
[What `import` returns](provider-development-internals.md#what-import-returns).

### 7. `readCurrentState`

`readCurrentState` returns what AWS holds now, in the shape of the template's
properties. `cdkd drift` compares it with state. It is optional. Without it,
`cdkd drift` falls back to a Cloud Control read of the resource, and reports a
resource it cannot read as `unsupported`.

```ts
async readCurrentState(
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // ... DescribeDBSubnetGroups; RESOURCE_NOT_FOUND when the group is gone ...

  const result: Record<string, unknown> = {};
  if (sg.DBSubnetGroupName !== undefined) result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
  if (sg.DBSubnetGroupDescription !== undefined) {
    result['DBSubnetGroupDescription'] = sg.DBSubnetGroupDescription;
  }
  result['SubnetIds'] = (sg.Subnets ?? [])
    .map((s) => s.SubnetIdentifier)
    .filter((id): id is string => !!id);
  // ... attach Tags ...
  return result;
}
```

Use the same keys `create` accepts. Return `RESOURCE_NOT_FOUND` only when AWS
says the resource does not exist, and `undefined` when you cannot tell. The
rules for which properties to emit when AWS returns nothing for them are in
[`readCurrentState()` for drift detection](provider-rules.md#readcurrentstate-for-drift-detection).

### 8. Register the provider

Two files, one line each. First re-export the class from
`src/provisioning/provider-classes.ts`:

```ts
export { DocDBSubnetGroupProvider } from './providers/docdb-subnet-group-provider.js';
```

Then, in `registerAllProviders()` in
`src/provisioning/register-providers.ts`, add the class to the
`const { ... } = classes` destructure and register the type:

```ts
registry.register('AWS::DocDB::DBSubnetGroup', new DocDBSubnetGroupProvider());
```

Do not import the provider module anywhere else. A provider module loads its
`@aws-sdk/client-*` package, so a static import puts that client on the startup
path of every command. `provider-classes.ts` is loaded on demand, and a unit
test fails on a static import.

A provider that serves several types registers one instance for all of them:

```ts
const docdbProvider = new DocDBProvider();
registry.register('AWS::DocDB::DBCluster', docdbProvider);
registry.register('AWS::DocDB::DBInstance', docdbProvider);
```

### 9. Fetch the schema and classify every property

A unit test, `property-coverage`, compares each provider's `handledProperties`
with the type's CloudFormation schema. It fails until the schema fixture for
your type exists:

```bash
node scripts/refresh-cfn-schemas.mjs --only-missing   # needs AWS credentials
vp test run property-coverage
```

The first command calls `cloudformation:DescribeType` for the newly registered
type and writes `tests/fixtures/cfn-schemas/AWS-DocDB-DBSubnetGroup.json`.
`vp run gen:cfn-schemas-from-zip` needs no credentials but captures every
registered type from AWS's public schema bundle.

The test then lists each schema property you have not accounted for. Put each
one in one of two places:

| Where | When |
| --- | --- |
| `handledProperties` | `create` and `update` send it to AWS |
| `unhandledByDesign`, with a one-line reason | You deliberately do not send it |

The full workflow is in
[`handledProperties` against the CFn schema](provider-rules.md#handledproperties-against-the-cfn-schema).

### 10. Write unit tests

Put the tests in `tests/unit/provisioning/`. Mock the SDK package, because the
provider builds its own client:

```ts
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeDBSubnetGroupsCommand } from '@aws-sdk/client-docdb';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

import { DocDBSubnetGroupProvider } from '../../../src/provisioning/providers/docdb-subnet-group-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

describe('DocDBSubnetGroupProvider.readCurrentState', () => {
  let provider: DocDBSubnetGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DocDBSubnetGroupProvider();
  });

  it('returns RESOURCE_NOT_FOUND when the group is gone', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('DBSubnetGroup my-sg not found'), {
        name: 'DBSubnetGroupNotFoundFault',
      })
    );

    const result = await provider.readCurrentState('my-sg', 'Sg', 'AWS::DocDB::DBSubnetGroup');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDBSubnetGroupsCommand);
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });
});
```

A provider that takes its client from `getAwsClients()` mocks
`src/utils/aws-clients.js` instead.

Cover at least these cases:

| Method | Cases |
| --- | --- |
| `create` | The command sent, the physical id and the attributes returned |
| `update` | The command sent; a property removed from the template is reset |
| `delete` | The command sent; "not found" is success; "not found" in the wrong region throws |
| `import` | An explicit id that exists; a name from the template; a resource that is not found returns `null` |
| `readCurrentState` | The property shape; `RESOURCE_NOT_FOUND` when gone; the round trip through `update` |

The round-trip test feeds the result of `readCurrentState` back into `update`,
which is what `cdkd drift --revert` does. It is required for any provider with
`readCurrentState`, and its shape is in
[Read-update round-trip test](provider-rules.md#read-update-round-trip-test-mandatory-for-any-provider-with-readcurrentstate).

[Testing](testing.md) covers running the suite and the mocking rules.

### 11. Add an integration fixture and the documentation rows

Unit tests mock AWS. A new provider also needs a fixture under
`tests/integration/` that deploys and destroys the type for real.
[Testing](testing.md#write-an-integration-fixture) shows how to write one. You
do not have to run it yourself.

Then finish the bookkeeping CI checks:

| What | Where |
| --- | --- |
| List the type as supported | [Supported Resources](supported-resources.md) and the table in [Import](import.md). A unit test matches the exact type string. |
| Regenerate the coverage matrix | `vp run integ-coverage`, and commit the result |
| Add a changelog entry | One file under `changelog.d/entries/` |

Before opening the pull request:

```bash
vp run check && vp test run && vp run build
```

## The `ResourceProvider` interface

The interface is declared in
[`src/types/resource.ts`](https://github.com/go-to-k/cdkd/blob/main/src/types/resource.ts),
which documents every member. `create`, `update` and `delete` are required.
The rest are optional:

| Member | Implement it when |
| --- | --- |
| `handledProperties` | Always, in practice. It routes resources to you and feeds the coverage test. |
| `unhandledByDesign` | A schema property is deliberately not sent |
| `import` | The type should be adoptable by `cdkd import` without an explicit id |
| `readCurrentState` | The type should take part in `cdkd drift` |
| `getAttribute` | An attribute may need a live read because state does not hold it |
| `removalDefaults`, `removalHandledInUpdate` | A removed property resets to a constant, or `update` already handles the removal |
| `getDriftUnknownPaths`, `getDriftUnorderedPaths`, `canonicalizeDriftProperties`, `canonicalizeDriftPair` | AWS reads a property back differently from how it was sent |
| `canonicalizeDesiredProperties` | The provider sends something narrower than what the template declares |
| `disableCcApiFallback` | Cloud Control cannot manage the type, so an unhandled property must be an error |
| `disableOuterRetry` | A retry by the engine would break per-call state the provider prepares |
| `getMinResourceTimeoutMs` | An operation on the type can outlast the default per-resource timeout |
| `isSameResource`, `resourceIdentity` | A failed create can leave an orphan under a name that can be reused |

`create` and `update` can also return two less common fields,
`effectiveProperties` and `noEchoAttributes`. Those, the canonicalizers and the
orphan identity methods are described in
[Provider Development internals](provider-development-internals.md).

## Rules every provider obeys

The walkthrough shows most of these. The list is the checklist to go through
before you open a pull request. Each rule links to its full statement in
[Provider implementation rules](provider-rules.md).

| Rule | What goes wrong otherwise |
| --- | --- |
| [Wrap every AWS call and rethrow as `ProvisioningError`](provider-rules.md#error-handling), with the original error as the cause | The failure reaches the user without the resource it belongs to |
| [Refuse a malformed value before any call](provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards), and [never infer a default from one](provider-rules.md#never-infer-a-default-from-a-possibly-malformed-value) | A typo deploys as a default nobody chose |
| [Treat "not found" on delete as success only after `assertRegionMatch`](provider-rules.md#idempotency) | A destroy in the wrong region empties state and orphans the resources |
| [Report a delete that made no AWS call as skipped](provider-rules.md#reporting-a-skipped-delete) | State drops a resource that is still running |
| [Reset a property the template removed](provider-rules.md#update-removal-semantics-clear-on-removal) | AWS keeps the old value while `cdkd diff` reports no changes |
| [Do not erase AWS-authored values with a full-replace update](provider-rules.md#full-replace-update-apis-erase-aws-authored-values) | An update deletes configuration AWS or the service added |
| [Send an idempotency token when create mints a server-side id](provider-rules.md#a-create-that-mints-a-server-side-id-needs-an-idempotency-token) | A retried create makes a second resource |
| [Return every `Fn::GetAtt` attribute, and build ARNs from the partition](provider-rules.md#returning-attributes) | References fail, or are wrong outside the `aws` partition |
| [Leave out an attribute you could not read](provider-development-internals.md#never-store-an-empty-string-placeholder-for-an-attribute-you-could-not-read-back). Never store `''` for it. | `Fn::GetAtt` resolves to an empty string |
| [Emit every user-settable property from `readCurrentState`](provider-rules.md#readcurrentstate-for-drift-detection) | A change made in the console is invisible to drift |
| [List every sent property in `handledProperties`](provider-rules.md#handledproperties-against-the-cfn-schema) | The resource is routed to Cloud Control, or a property is dropped |
| Take the region from `ambientRegion()` and credentials from `getAwsClients()` or `ambientClientDefaults()` | A multi-region deploy calls the wrong region |
| Register only in `registerAllProviders`, and never import a provider module statically | Every command loads the SDK client at startup |
| Pass any log line that includes a resolved property value through `context.maskSecrets`, which `create` and `update` receive | A resolved secret is printed |
| [Respect the service's name length and character limits](provider-rules.md#resource-name-constraints) | Create fails for a long stack or logical id |

### A retry loop inside a provider must honor Ctrl-C

The engine checks for an interrupt between operations. `withRetry`
(`src/deployment/retry.ts`) is the only wait that checks during a backoff. A
provider that calls `withRetry` itself must pass it an interrupt watch, or
{kbd:ctrl+c} does nothing until the retries run out:

```ts
const watch = startInterruptWatch(`... ${logicalId}`);
try {
  await withRetry(op, logicalId, {
    logger: this.logger,
    isInterrupted: watch.isInterrupted,
    onInterrupted: watch.onInterrupted,
  });
} finally {
  watch.dispose();
}
```

`startInterruptWatch` is in `src/provisioning/interrupt-watch.ts`.
`vp run audit:withretry-interrupt:check` fails on a `withRetry` call under
`src/provisioning/` that does not pass both options.

### A provider that waits for stabilization

Some creates return before the resource is usable, and the provider polls until
it is. If your provider skips or shortens that wait under `CDKD_NO_WAIT` or
`CDKD_FULL_WAIT`, document it in the wait table in
[`cdkd deploy`](cli-deploy.md) and in the option's help text in
`src/cli/options.ts`.

## Custom resources

`Custom::*` and `AWS::CloudFormation::CustomResource` are served by
`CustomResourceProvider` (`src/provisioning/providers/custom-resource-provider.ts`).
It sends the handler the same request CloudFormation would, with `RequestType`
set to `Create`, `Update` or `Delete`. It takes the physical id from the
response's `PhysicalResourceId` and the attributes from its `Data`.

You do not write a provider for a custom resource type. The handler is the
user's Lambda function.

## When something does not work

### Your provider is not called

The resource went to Cloud Control. Run `cdkd diff MyStack`: a resource routed
there because of a property is annotated `[via CC API: <property>]`. Either the
type is not registered, or the template sets a property missing from
`handledProperties`, or state already records the resource as created through
Cloud Control.

### `Fn::GetAtt` does not resolve

`create` or `update` did not return the attribute. Add it to the `attributes`
map both return, with the name CloudFormation documents.

### An update fails on a property that cannot change

The property is create-only and the diff did not classify the change as a
replacement. The diff reads the type's entry in
`src/analyzer/replacement-rules.ts` first, and falls back to the
`createOnlyProperties` of the type's CloudFormation schema for a property the
entry does not classify. Check both.

## Related

- [Provider implementation rules](provider-rules.md): the complete rulebook
- [Provider Development internals](provider-development-internals.md): the
  less common return fields and methods
- [Integration fixture conventions](integ-fixture-conventions.md): the rules
  the fixture for your provider follows
- [Supported Resources](supported-resources.md): the types that have a
  provider today
- [CloudFormation resource reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
