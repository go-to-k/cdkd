---
title: Testing and shipping a provider
description: "What a new cdkd SDK provider needs before its pull request can merge: the schema property check, unit tests, an integration fixture, and the documentation rows."
---

# Testing and shipping a provider

Once a provider is written and registered, four things stand between it and a
mergeable pull request. This page takes them in the order you do them, and
continues the walkthrough in
[Provider Development](provider-development.md#provider-implementation-examples)
with the same provider, `DocDBSubnetGroupProvider`.

| Step | Why |
| --- | --- |
| [Classify every schema property](#fetch-the-schema-and-classify-every-property) | A unit test fails until you do |
| [Write unit tests](#write-unit-tests) | CI runs them on every pull request |
| [Add an integration fixture](#add-an-integration-fixture) | Unit tests mock AWS |
| [Add the documentation rows](#add-the-documentation-rows) | CI checks them |

## Fetch the schema and classify every property

A unit test named `property-coverage` compares each provider's
`handledProperties` with the type's CloudFormation schema. Its purpose is to
make you decide about every property the type has, so that none is forgotten.
The test fails until the schema fixture for your type exists, so fetch the
fixture first:

```bash
node scripts/refresh-cfn-schemas.mjs --only-missing   # needs AWS credentials
vp test run property-coverage
```

The first command calls `cloudformation:DescribeType` for the newly registered
type and writes `tests/fixtures/cfn-schemas/AWS-DocDB-DBSubnetGroup.json`. If
you have no credentials, `vp run gen:cfn-schemas-from-zip` works without them,
but it captures every registered type from AWS's public schema bundle.

The test then lists each schema property you have not accounted for. Every
property goes in one of two places:

- `handledProperties`, when `create` and `update` send it to AWS,
- `unhandledByDesign` with a one-line reason, when you deliberately do not
  send it.

The full workflow is in
[`handledProperties` against the CFn schema](provider-rules.md#handledproperties-against-the-cfn-schema).

## Write unit tests

Put the tests in `tests/unit/provisioning/`. The provider builds its own
client, so the test replaces the SDK package with a mock and checks the
commands the provider sends. [Testing](testing.md#write-one) shows the complete
test file for this provider, with the mock. One test from it looks like this:

```ts
it('returns RESOURCE_NOT_FOUND when the group is gone', async () => {
  mockSend.mockRejectedValueOnce(
    Object.assign(new Error('DBSubnetGroup my-sg not found'), {
      name: 'DBSubnetGroupNotFoundFault',
    })
  );

  const result = await provider.readCurrentState(
    'my-sg',
    'Sg',
    'AWS::DocDB::DBSubnetGroup'
  );

  expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(
    DescribeDBSubnetGroupsCommand
  );
  expect(result).toBe(RESOURCE_NOT_FOUND);
});
```

A provider that takes its client from `getAwsClients()` mocks
`src/utils/aws-clients.js` instead of the SDK package.

Cover at least these cases:

| Method | Cases |
| --- | --- |
| `create` | The command sent, the physical id and the attributes returned |
| `update` | The command sent; a property removed from the template is reset |
| `delete` | The command sent; "not found" is success; "not found" in the wrong region throws |
| `import` | An explicit id that exists; a name from the template; a resource that is not found returns `null` |
| `readCurrentState` | The property shape; `RESOURCE_NOT_FOUND` when gone; the round trip through `update` |

The round-trip test feeds the result of `readCurrentState` back into `update`,
because that is what `cdkd drift --revert` does. The test is required for any
provider with `readCurrentState`. Its shape is in
[Read-update round-trip test](provider-rules.md#read-update-round-trip-test-mandatory-for-any-provider-with-readcurrentstate).

## Add an integration fixture

Unit tests mock AWS, so they cannot show that the real calls work. A new
provider also needs a fixture under `tests/integration/` that deploys and
destroys the type in a real account.
[Writing an integration fixture](testing-integration-fixtures.md#write-an-integration-fixture)
shows how to write one.

You do not have to run the fixture yourself. The maintainer runs it before
merging.

## Add the documentation rows

Three pieces of bookkeeping remain, and CI checks each of them:

- List the type as supported in
  [Supported Resources](supported-resources.md) and in the table in
  [Import](import.md). A unit test matches the exact type string.
- Regenerate the coverage matrix with `vp run integ-coverage`, and commit the
  result.
- Add a changelog entry, one file under `changelog.d/entries/`.

## Before you open the pull request

Run the checks CI runs, and go through
[the rules every provider obeys](provider-development-reference.md#rules-every-provider-obeys):

```bash
vp run check && vp test run && vp run build
```

## Related

- [Provider Development](provider-development.md): the walkthrough this page
  continues
- [Testing](testing.md): running the suite, and the mocking rules
- [Integration fixture conventions](integ-fixture-conventions.md): the rules
  the fixture for your provider follows
- [Contributing Guide](contributing.md): what a pull request needs to merge
