---
title: Testing
description: "How to run and write cdkd's unit tests, what the real-AWS integration tests are, who runs them, and how to run one yourself."
---

# How to Test cdkd

cdkd has two kinds of tests. Every change needs unit tests. Some changes also
need an integration test, and the maintainer can run those for you.

| | Unit tests | Integration tests |
| --- | --- | --- |
| Where | `tests/unit/` | `tests/integration/<name>/` |
| What runs | Vitest, with the AWS SDK mocked | A CDK app deployed to real AWS, then destroyed |
| Needs | The toolchain only | AWS credentials, and Docker for some |
| Cost | None | Real AWS charges |
| Run by | You, and CI on every pull request | You, or the maintainer before merging |

[Contributing](contributing.md#when-is-an-integration-test-needed-and-which-one)
says which changes need an integration test.

## In this section

- [Writing an integration fixture](testing-integration-fixtures.md) shows how
  to add a fixture, how one fixture tests an update or a rollback, and how the
  coverage reports are regenerated.
- [Integration fixture conventions](integ-fixture-conventions.md) is the full
  set of rules a `verify.sh` script follows.
- [Testing internals](testing-internals.md) records what individual fixtures
  assert, and why each is built the way it is.

## Unit tests

Unit tests call no AWS service, so they need no credentials. Run them after
every change.

### Run them

```bash
vp test run                                        # the whole suite, once
vp test run tests/unit/analyzer/dag-builder.test.ts  # one file
vp test run property-coverage                      # files whose path matches
vp run test:watch                                  # rerun on change
vp run test:coverage                               # with a coverage report
vp test --ui                                       # the Vitest UI
```

When you want the verdict, prefer `vp test run` over `vp run test`. It calls
Vitest directly, with no task runner in between.

### Write one

A test file mirrors the source file it covers. `src/analyzer/dag-builder.ts`,
for example, is tested in `tests/unit/analyzer/dag-builder.test.ts`. Add the
tests in the same commit as the change, for a bug fix as well as for a feature.

This is a complete test file for one method of a provider. It replaces the SDK
client with a mock, so that the test controls what "AWS" answers:

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

import {
  DocDBSubnetGroupProvider,
} from '../../../src/provisioning/providers/docdb-subnet-group-provider.js';
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
});
```

Import the test API from `'vite-plus/test'`. A bare `'vitest'` import resolves
locally, but it fails `vp run typecheck:test`.

Which module you mock depends on where the code under test gets its AWS client:

| The code | Mock |
| --- | --- |
| Builds its own client (`new DocDBClient(...)`) | The SDK package: `vi.mock('@aws-sdk/client-docdb', ...)` |
| Calls `getAwsClients()` | `src/utils/aws-clients.js` |

### What the suite enforces

The test setup in `tests/setup.ts` enforces four rules. A test that breaks one
fails even when its own assertions pass.

- **No real AWS calls.** A test that reaches a real SDK client fails with a
  message that names the SDK package. Mock that package. A `vi.mock` with a
  misspelled package name does nothing, so copy the name from the message.
- **A passing run prints nothing.** Output that a test writes to stdout or
  stderr is shown only when the test fails. Mock the logger, or assert on the
  output.
- **A `mock...Once` value is used by the test that queued it.** A leftover
  value fails under `vp run test:once-leak`, which CI runs. Queue only what
  the code path consumes, because `vi.clearAllMocks()` does not empty the
  queue.
- **Temporary files stay in the run's own directory.** `os.tmpdir()` points at
  a per-run directory that is removed afterwards, so use `os.tmpdir()` as
  usual.

The default timeout is 5 seconds, which is sized for in-process tests. A test
that spawns a process declares its own timeout.

The second and third rules are written up with examples in
[Integration fixture conventions](integ-fixture-conventions.md#unit-tests-prime-exactly-what-the-code-path-consumes).

## Integration tests

An integration test deploys a small CDK app to a real AWS account with your
build of cdkd, checks the result, and destroys it again.

Each directory under `tests/integration/` is one such app, called a
**fixture**. A fixture uses the resource types or the cdkd feature under test.
There are several hundred. Most carry a `verify.sh` script that runs the whole
cycle and checks the results against AWS:

```text diagram=contrib-integ-run
Build cdkd, install the fixture's dependencies
    |
    v
cdkd deploy                   real resources in the AWS account
    |
    v
Assert against AWS            read each resource back with the AWS CLI
    |
    v
Redeploy in a test mode       optional: update, removal, failure injection
    |
    v
cdkd destroy
    |
    v
Assert nothing is left        every resource gone, no state for the stack
```

A fixture without `verify.sh` is a smoke test. It passes when deploy and
destroy both succeed.

CI does not run integration tests. The maintainer runs the ones a pull request
needs before merging it, and records each run in
[the integ-run ledger](_generated/integ-last-run.tsv).

### Prerequisites

1. An AWS account you can create and delete resources in
2. The AWS CLI, configured (`aws configure`)
3. Node.js 22.12 or higher
4. cdkd built (`vp run build`)
5. A running Docker daemon, for the `local-*` fixtures and the ones that build
   image assets

### Run an integration test

::: steps
1. Build cdkd

   ```bash
   vp run build
   ```

   A fixture runs `dist/cli.js`, so a source change has no effect until you
   rebuild.

2. Create the state bucket, once per account

   ```bash
   node dist/cli.js bootstrap --region us-east-1
   ```

   This creates `cdkd-state-<accountId>`, the bucket the fixtures use by
   default, and the asset storage for the region.

3. Run the fixture

   A fixture with a `verify.sh` installs its own dependencies, so one command
   runs it:

   ```bash
   AWS_REGION=us-east-1 bash tests/integration/drift-revert/verify.sh
   ```

   For a fixture without one, deploy and destroy by hand:

   ```bash
   cd tests/integration/basic
   vp install
   ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
   BUCKET="cdkd-state-$ACCOUNT"
   node ../../../dist/cli.js deploy --region us-east-1 \
     --state-bucket "$BUCKET" --verbose
   node ../../../dist/cli.js destroy --region us-east-1 \
     --state-bucket "$BUCKET" --force
   ```

   Pass `--all` to both commands when the app has more than one stack.

4. Check that nothing is left behind

   ```bash
   aws s3 ls "s3://$BUCKET/cdkd/CdkdBasicExample/" --recursive \
     | grep -v '/deployments/'
   ```

   No output means the stack's state is gone. Objects under `deployments/` are
   the stack's event history, which a destroy keeps.
:::

Read the header comment of a fixture's `verify.sh` before you run it. The
comment lists the steps, and it names any region or account the fixture
requires. A `verify.sh` typically reads `AWS_REGION` and `STATE_BUCKET` from
the environment, and falls back to `us-east-1` and `cdkd-state-<accountId>`.

> [!WARNING]
> A run that is killed part-way can leave resources that keep costing money.
> `verify.sh` destroys the stack from its exit trap, but confirm in the AWS
> console or with the AWS CLI that the resources are gone. If the destroy
> failed, delete what is left before you run the fixture again: cdkd's diff
> does not see resources that are missing from state, and the next deploy
> collides with them.

Most `local-*` fixtures need only Docker and create nothing in AWS.
`local-invoke-from-state` is the exception, because it deploys real resources.

### Fixtures worth knowing

When you need a fixture for a change, start with one of these:

| To test | Fixture |
| --- | --- |
| A first deploy and destroy | `basic` |
| Many resource types in one stack | `multi-resource`, `lambda` |
| Intrinsic function resolution | `intrinsic-functions`, `intrinsics-torture` |
| Parameters and conditions | `parameters`, `conditions` |
| Cross-stack references | `cross-stack-references` |
| Docker image assets | `docker-image-asset`, `ecr` |
| Context lookups | `vpc-lookup` |
| Custom resources | `custom-resource-provider` |
| Drift detection and revert | `drift-revert` |
| Rollback after a failed deploy | `rollback-failure-injection` |
| IAM propagation races | `iam-propagation-stress` |

`ls tests/integration/` lists them all. When no fixture covers your change,
[write one](testing-integration-fixtures.md).

## Try your build against your own CDK app

To see a change working outside the fixtures, run the built CLI from any CDK
app's directory:

```bash
CDKD=/path/to/cdkd/dist/cli.js

# what would change
node "$CDKD" diff MyStack

# the plan, without applying it
node "$CDKD" deploy MyStack --dry-run

# deploy, with debug logging
node "$CDKD" deploy MyStack --verbose

# what cdkd recorded
node "$CDKD" state show MyStack

# delete without the confirmation prompt
node "$CDKD" destroy MyStack --force
```

You can leave out `--app` and `--state-bucket` when `cdk.json` or the
environment provides them.

## Related

- [Writing an integration fixture](testing-integration-fixtures.md)
- [Integration fixture conventions](integ-fixture-conventions.md): the rules a
  `verify.sh` follows
- [Provider Development](provider-development.md): writing the provider a
  fixture exercises
- [Contributing Guide](contributing.md): the toolchain, and which test a pull
  request needs
- [Troubleshooting](troubleshooting.md): a symptom-first index for a failing
  run
