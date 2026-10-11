---
title: Testing
description: "How to run and write cdkd's unit tests, what the real-AWS integration tests are, who runs them, and how to add a fixture."
---

# How to Test cdkd

cdkd has two kinds of tests. Every change needs the first. Some changes need
the second, and the maintainer can run those for you.

| | Unit tests | Integration tests |
| --- | --- | --- |
| Where | `tests/unit/` | `tests/integration/<name>/` |
| What runs | Vitest, with the AWS SDK mocked | A CDK app deployed to a real AWS account, then destroyed |
| Needs | Nothing beyond the toolchain | AWS credentials. Some also need Docker. |
| Cost | None | Real AWS charges |
| Run by | You, and CI on every pull request | You if you want to; otherwise the maintainer before merging |

Which changes need an integration test is in
[Contributing](contributing.md#when-is-an-integration-test-needed-and-which-one).

## Unit tests

### Run them

```bash
vp test run                                        # the whole suite, once
vp test run tests/unit/analyzer/dag-builder.test.ts  # one file
vp test run property-coverage                      # files whose path matches
vp run test:watch                                  # rerun on change
vp run test:coverage                               # with a coverage report
vp test --ui                                       # the Vitest UI
```

Prefer `vp test run` over `vp run test` when you want the verdict: it calls
Vitest directly, with no task runner in between.

### Write one

A test file mirrors the source file it covers: `src/analyzer/dag-builder.ts`
is tested in `tests/unit/analyzer/dag-builder.test.ts`. Add tests in the same
commit as the change, for a bug fix as well as for a feature.

```ts
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns RESOURCE_NOT_FOUND when DescribeDBSubnetGroups lists no group', async () => {
    mockSend.mockResolvedValueOnce({ DBSubnetGroups: [] });

    const provider = new DocDBSubnetGroupProvider();
    const result = await provider.readCurrentState('my-sg', 'Sg', 'AWS::DocDB::DBSubnetGroup');

    expect(result).toBe(RESOURCE_NOT_FOUND);
  });
});
```

Import the test API from `'vite-plus/test'`. A bare `'vitest'` import resolves
locally but fails `vp run typecheck:test`.

Which module to mock depends on where the code under test gets its AWS client:

| The code | Mock |
| --- | --- |
| Builds its own client (`new DocDBClient(...)`) | The SDK package: `vi.mock('@aws-sdk/client-docdb', ...)` |
| Calls `getAwsClients()` | `src/utils/aws-clients.js` |

### What the suite enforces

The test setup in `tests/setup.ts` fails a test for these, even when its
assertions pass:

| Rule | What you see | What to do |
| --- | --- | --- |
| No real AWS calls | The test fails with a message naming the SDK package that made the call | Mock that package. A `vi.mock` with a misspelled package name does nothing, so copy the name from the message. |
| A passing run prints nothing | Output a test wrote to stdout or stderr is shown only when the test fails | Mock the logger, or assert on the output |
| A `mock...Once` value is used by the test that queued it | Fails under `vp run test:once-leak`, which CI runs | Queue only what the code path consumes. `vi.clearAllMocks()` does not empty the queue. |
| Temporary files stay in the run's own directory | `os.tmpdir()` points at a per-run directory that is removed afterwards | Use `os.tmpdir()` as usual |

A test that spawns a process declares its own timeout, since the default of 5
seconds is sized for in-process tests.

The second and third rules are written up with examples in
[Integration fixture conventions](integ-fixture-conventions.md#unit-tests-prime-exactly-what-the-code-path-consumes).

## Integration tests

Each directory under `tests/integration/` is a **fixture**: a small CDK app
that uses the resource types or the cdkd feature under test. There are several
hundred. Most carry a `verify.sh` script that runs the whole cycle and checks
the results against AWS:

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

   With a `verify.sh`, which installs the fixture's dependencies itself:

   ```bash
   AWS_REGION=us-east-1 bash tests/integration/drift-revert/verify.sh
   ```

   Without one, deploy and destroy by hand:

   ```bash
   cd tests/integration/basic
   vp install
   BUCKET="cdkd-state-$(aws sts get-caller-identity --query Account --output text)"
   node ../../../dist/cli.js deploy --region us-east-1 --state-bucket "$BUCKET" --verbose
   node ../../../dist/cli.js destroy --region us-east-1 --state-bucket "$BUCKET" --force
   ```

   Pass `--all` to both commands when the app has more than one stack.

4. Check that nothing is left behind

   ```bash
   aws s3 ls "s3://$BUCKET/cdkd/CdkdBasicExample/" --recursive | grep -v '/deployments/'
   ```

   No output means the stack's state is gone. Objects under `deployments/` are
   the stack's event history, which a destroy keeps.
:::

A `verify.sh` typically reads `AWS_REGION` and `STATE_BUCKET` from the
environment and falls back to `us-east-1` and `cdkd-state-<accountId>`. Read
the header comment of a fixture's `verify.sh` before running it. It lists the
steps, and names any region or account requirement.

> [!WARNING]
> A run that is killed part-way can leave resources that keep costing money.
> `verify.sh` destroys the stack from its exit trap, but confirm in the AWS
> console or with the AWS CLI that the resources are gone. If the destroy
> failed, delete what is left before you run the fixture again: cdkd's diff
> does not see resources that are missing from state, and the next deploy
> collides with them.

Most `local-*` fixtures need only Docker and create nothing in AWS.
`local-invoke-from-state` is the exception: it deploys real resources.

### Write an integration fixture

Add a fixture when your change adds behavior no existing fixture covers. Before
writing one, search for the resource type under `tests/integration/*/lib`. An
existing fixture that already deploys it is often the better place for a new
assertion.

Copy a recent fixture, such as `tests/integration/dynamodb-gsi-update/`. A
fixture has these files:

```text
tests/integration/sqs-queue-tags/
├── cdk.json            # { "app": "node bin/app.ts" }
├── package.json        # "type": "module"; aws-cdk-lib and constructs
├── tsconfig.json       # copied from the fixture you started from
├── bin/app.ts          # creates the stack, named Cdkd<Name>Example
├── lib/sqs-queue-tags-stack.ts
└── verify.sh           # deploy, assert, destroy, assert
```

The app runs through Node's type stripping (`node bin/app.ts`), so the fixture
is ESM and its relative imports carry the `.ts` extension.

Keep the stack small: the resource under test and what it requires. In the
stack class's doc comment, add one `covers:` line per resource type the
fixture is meant to cover. The coverage report reads them:

```ts
/**
 * covers: AWS::SQS::Queue
 */
export class SqsQueueTagsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new sqs.Queue(this, 'Queue', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
```

Give every stateful construct an explicit removal policy, so destroy removes
it.

A `verify.sh` has rules of its own, and most are enforced by a checker that
fails CI. The ones that matter most:

| Rule | Why |
| --- | --- |
| Install the three signal traps exactly as written in the conventions | `trap cleanup EXIT INT TERM` lets an interrupted script resume and report a pass |
| Decide "gone" from a not-found error, never from any failed probe | A throttled or unauthenticated probe would read as "deleted" |
| Assert the baseline before asserting a change | "The value is absent" also passes when the value never reached AWS |
| Sort both sides when comparing a list read back from AWS | AWS does not preserve the order you sent |
| Sweep the state bucket's object versions on the success path | The state bucket is versioned, and leftover versions accumulate |

The full set, with the code to copy, is in
[Integration fixture conventions](integ-fixture-conventions.md).

After adding a fixture, regenerate the coverage reports and commit them:

```bash
vp run gen:all-matrices
```

### Test modes: update, removal and failure injection

A fixture's stack can read three environment variables, so one fixture can
exercise more than a create and a delete. `verify.sh` redeploys with the
variable set.

| Variable | The stack then | It tests |
| --- | --- | --- |
| `CDKD_TEST_UPDATE=true` | Changes a property | An in-place update |
| `CDKD_TEST_REMOVAL=true` | Omits a property the baseline set | That the removed property is reset in AWS |
| `CDKD_TEST_FAIL=true` | Adds a resource AWS rejects | That the resources already created are rolled back |

The `basic` fixture supports the update and failure modes:

```bash
cd tests/integration/basic

# Create, then update: the second deploy adds a tag to the bucket.
node ../../../dist/cli.js deploy --region us-east-1 --state-bucket "$BUCKET"
CDKD_TEST_UPDATE=true node ../../../dist/cli.js deploy --region us-east-1 --state-bucket "$BUCKET"
# Changes: 0 to create, 1 to update, 0 to delete

# Failure injection: an SQS queue with an out-of-range MessageRetentionPeriod
# fails, and the resources created beside it are rolled back.
CDKD_TEST_FAIL=true node ../../../dist/cli.js deploy --region us-east-1 --state-bucket "$BUCKET"
```

#### Removal testing (`CDKD_TEST_REMOVAL`)

CloudFormation resets a property that is removed from the template to its
default. Most AWS update APIs read a missing field as "no change". A provider
that passes properties straight through keeps the old value in AWS, reports
success and drops the field from state, and `cdkd diff` then reports no
changes. Only a redeploy whose template lacks the property reaches that code,
and a changed value never does. This variable produces that template.

Two conventions keep a removal phase from passing for the wrong reason:

- **Assert the baseline first.** Check that the property is set in AWS before
  the removal deploy, then that it is reset after.
- **Keep a sibling that is not removed,** when the property is a collection
  such as a tag list or an attribute map. Give the sibling a value that differs
  from AWS's default. Otherwise a provider that cleared everything would pass.

To find the fixtures that use the variable:

```bash
grep -rl CDKD_TEST_REMOVAL tests/integration/*/lib/*.ts tests/integration/*/verify.sh
```

`tests/integration/route53/` is the reference. The cases where these
conventions need care, including a fixture that asserts the opposite (that AWS
retains the value), are in
[Testing internals](testing-internals.md#cdkd-test-removal-choosing-what-to-retain).

### Fixtures worth knowing

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

`ls tests/integration/` lists them all.
[Testing internals](testing-internals.md) records what the rollback, drift and
other multi-phase fixtures assert, and why each is built the way it is.

## Try your build against your own CDK app

For a change you want to see working outside the fixtures, run the built CLI
from any CDK app's directory:

```bash
CDKD=/path/to/cdkd/dist/cli.js

node "$CDKD" diff MyStack                # what would change
node "$CDKD" deploy MyStack --dry-run    # the plan, without applying it
node "$CDKD" deploy MyStack --verbose    # deploy, with debug logging
node "$CDKD" state show MyStack          # what cdkd recorded
node "$CDKD" destroy MyStack --force     # delete without the confirmation prompt
```

`--app` and `--state-bucket` can be left out when `cdk.json` or the environment
provides them.

## Generated coverage reports

Four committed files report what the fixtures cover and when they ran. CI
reruns each task and fails when the committed copy differs.

| Report | Shows | Regenerate with |
| --- | --- | --- |
| [Integration test coverage](integ-coverage.md) | Each registered SDK provider type and the fixtures that deploy it | `vp run integ-coverage` |
| [CLI flag coverage](cli-flag-coverage.md) | Each CLI flag and the fixtures whose `verify.sh` passes it | `vp run cli-flag-coverage` |
| [Scenario coverage](scenario-coverage.md) | Each named real-AWS regression scenario and the fixtures tagged with it | `vp run scenario-coverage` |
| [Integ-run ledger](_generated/integ-last-run.tsv) | When each fixture last ran, and the result | `vp run integ-ledger-normalize` |

`vp run gen:all-matrices` runs all of them.

A new provider type is expected to arrive with a fixture that deploys it. The
integration coverage report counts a fixture for a type when the fixture's
source contains the type string, which is why a `covers:` comment works, or
constructs the type's `Cfn<Type>` class.

A fixture declares the scenarios it exercises in a `.scenarios.json` file
beside its `verify.sh`:

```json
{
  "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"]
}
```

The ledger is run history, so it is never edited by hand. The normalize task
only sorts it and keeps one row per fixture. The details of each report are in
[Testing internals](testing-internals.md#coverage-matrices-what-ci-enforces).

## Related

- [Integration fixture conventions](integ-fixture-conventions.md): the rules a
  `verify.sh` follows
- [Testing internals](testing-internals.md): what individual fixtures assert
- [Provider Development](provider-development.md): writing the provider a
  fixture exercises
- [Contributing Guide](contributing.md): the toolchain, and which test a pull
  request needs
- [Troubleshooting](troubleshooting.md): a symptom-first index for a failing
  run
