---
title: Import and drift support for a provider
description: "How to implement the two optional ResourceProvider methods, import and readCurrentState, so a resource type works with cdkd import and cdkd drift."
---

# Import and drift support for a provider

A provider with `create`, `update` and `delete` can deploy and destroy its
resource type. Two optional methods connect the type to two more commands:

| Method | Command it serves | Without it |
| --- | --- | --- |
| `import` | `cdkd import` | The user must pass the physical id by hand |
| `readCurrentState` | `cdkd drift` | cdkd reads the resource through Cloud Control |

This page continues the walkthrough in
[Provider Development](provider-development.md#provider-implementation-examples)
with the same provider, `DocDBSubnetGroupProvider`.

## `import`

`import` lets `cdkd import` adopt a resource that already exists in AWS. Its
job is to find the resource's physical id and confirm that the resource is
there. Without the method, the type can only be adopted when the user passes
the physical id with `--resource <logicalId>=<physicalId>`.

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
      if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') {
        return null;
      }
      throw err;
    }
  }
  return null;
}
```

The method has two parts:

1. **Find the id.** `resolveExplicitPhysicalId` returns the `--resource`
   override when there is one, and otherwise the name the template gives in
   the named property. Pass `null` as the second argument for a type that has
   no name property.
2. **Confirm the resource exists.** Make a describe call, and return `null`
   when AWS says the resource is not there. `cdkd import` reads `null` as "not
   deployed yet". It does not treat `null` as a failure.

> [!IMPORTANT]
> Do not look a resource up by an `aws:cdk:path` tag. AWS rejects any tag
> whose key starts with `aws:`, so no resource carries that tag and the lookup
> can never match.

Returning `attributes: {}` is right when the physical id alone answers every
`Ref` and `Fn::GetAtt` for the type. When it does not, see
[What `import` returns](provider-development-internals.md#what-import-returns).

## `readCurrentState`

`readCurrentState` returns what AWS holds now, in the shape of the template's
properties. `cdkd drift` compares that result with state, and reports a
difference as drift.

Without the method, `cdkd drift` falls back to a Cloud Control read of the
resource, and it reports a resource it cannot read as `unsupported`.

```ts
async readCurrentState(
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // ... DescribeDBSubnetGroups; RESOURCE_NOT_FOUND when the group is gone ...

  const result: Record<string, unknown> = {};
  if (sg.DBSubnetGroupName !== undefined) {
    result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
  }
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

Use the same keys `create` accepts. The return value tells `cdkd drift` one of three things:

| Return | Meaning |
| --- | --- |
| An object | This is what AWS holds |
| `RESOURCE_NOT_FOUND` | AWS says the resource does not exist |
| `undefined` | You cannot tell |

Return `RESOURCE_NOT_FOUND` only when AWS says the resource does not exist.

The rules for which properties to emit when AWS returns nothing for them are in
[`readCurrentState()` for drift detection](provider-rules.md#readcurrentstate-for-drift-detection).

A provider with `readCurrentState` also needs a round-trip unit test. See
[Write unit tests](provider-development-testing.md#write-unit-tests).

## Related

- [Provider Development](provider-development.md): the walkthrough this page
  continues
- [Testing and shipping a provider](provider-development-testing.md)
- [Provider reference](provider-development-reference.md)
- [Import](import.md): the command from the user's side
