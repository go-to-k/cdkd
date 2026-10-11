---
title: Writing an integration fixture
description: "How to add a cdkd integration fixture: the files it needs, the rules its verify.sh follows, the test modes for updates, removals and failures, and the coverage reports to regenerate."
---

# Writing an integration fixture

A fixture is a small CDK app under `tests/integration/` that cdkd deploys to a
real AWS account and destroys again. This page shows how to add one.
[Testing](testing.md#run-an-integration-test) shows how to run one.

Add a fixture when your change adds behavior that no existing fixture covers.
Search first for the resource type under `tests/integration/*/lib`. An existing
fixture that already deploys the type is often the better place for a new
assertion.

## Write an integration fixture

Copy a recent fixture, such as `tests/integration/dynamodb-gsi-update/`, and
rename it. A fixture has these files:

```text
tests/integration/sqs-queue-tags/
├── cdk.json            # { "app": "node bin/app.ts" }
├── package.json        # "type": "module"; aws-cdk-lib and constructs
├── tsconfig.json       # copied from the fixture you started from
├── bin/app.ts          # creates the stack, named Cdkd<Name>Example
├── lib/sqs-queue-tags-stack.ts
└── verify.sh           # deploy, assert, destroy, assert
```

The app runs through Node's type stripping (`node bin/app.ts`). That is why the
fixture is ESM and its relative imports carry the `.ts` extension.

### The stack

Keep the stack small: the resource under test and what that resource requires.

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

Two details in this example are required:

- The doc comment has one `covers:` line for each resource type the fixture is
  meant to cover. The coverage report reads those lines.
- Every stateful construct has an explicit removal policy, so that destroy
  removes it.

### The `verify.sh` script

`verify.sh` deploys the stack, checks the resources in AWS, destroys the stack,
and checks that nothing is left. A checker that fails CI enforces most of the
rules for the script. These five matter most:

- **Install the three signal traps exactly as the conventions write them.**
  The shorter form, `trap cleanup EXIT INT TERM`, lets an interrupted script
  resume and report a pass.
- **Decide "gone" from a not-found error.** Any other failed probe proves
  nothing, because a throttled or unauthenticated probe would also read as
  "deleted".
- **Assert the baseline before you assert a change.** "The value is absent"
  also passes when the value never reached AWS.
- **Sort both sides when you compare a list read back from AWS.** AWS does not
  preserve the order you sent.
- **Sweep the state bucket's object versions on the success path.** The state
  bucket is versioned, so leftover versions accumulate.

The full set of rules, with the code to copy, is in
[Integration fixture conventions](integ-fixture-conventions.md).

### Regenerate the coverage reports

After you add a fixture, regenerate the coverage reports and commit them:

```bash
vp run gen:all-matrices
```

[Generated coverage reports](#generated-coverage-reports) explains what each
report shows.

## Test modes: update, removal and failure injection

A plain fixture only tests a create and a delete. To test more with the same
fixture, the stack reads an environment variable and changes what it
synthesizes. `verify.sh` then deploys a second time with the variable set.

| Variable | The stack then | It tests |
| --- | --- | --- |
| `CDKD_TEST_UPDATE=true` | Changes a property | An in-place update |
| `CDKD_TEST_REMOVAL=true` | Omits a property the baseline set | That the property is reset in AWS |
| `CDKD_TEST_FAIL=true` | Adds a resource AWS rejects | That created resources are rolled back |

The `basic` fixture supports the update and failure modes:

```bash
cd tests/integration/basic

# Create, then update: the second deploy adds a tag to the bucket.
node ../../../dist/cli.js deploy --region us-east-1 --state-bucket "$BUCKET"
CDKD_TEST_UPDATE=true node ../../../dist/cli.js deploy \
  --region us-east-1 --state-bucket "$BUCKET"
# Changes: 0 to create, 1 to update, 0 to delete

# Failure injection: an SQS queue with an out-of-range MessageRetentionPeriod
# fails, and the resources created beside it are rolled back.
CDKD_TEST_FAIL=true node ../../../dist/cli.js deploy \
  --region us-east-1 --state-bucket "$BUCKET"
```

### Removal testing (`CDKD_TEST_REMOVAL`)

The removal mode exists to catch one specific provider bug. Suppose a user sets
a property, deploys, deletes the property from the template, and deploys again.
CloudFormation resets a removed property to its default. Most AWS update APIs
read a missing field as "no change". So a provider that passes properties
straight through keeps the old value in AWS, reports success, and drops the
field from state. After that, `cdkd diff` reports no changes.

A deploy that changes the value never reaches that code. Only a second deploy
whose template lacks the property does, and `CDKD_TEST_REMOVAL` produces that
template.

Two conventions keep a removal phase from passing for the wrong reason:

- **Assert the baseline first.** Check that the property is set in AWS before
  the removal deploy, and that it is reset after.
- **Keep a sibling that is not removed** when the property is a collection,
  such as a tag list or an attribute map. Give the sibling a value that
  differs from AWS's default. Otherwise a provider that cleared everything
  would pass.

`tests/integration/route53/` is the reference fixture. To find the others that
use the variable:

```bash
grep -rl CDKD_TEST_REMOVAL \
  tests/integration/*/lib/*.ts tests/integration/*/verify.sh
```

Some cases need more care, including a fixture that asserts the opposite, that
AWS retains the value. They are in
[Testing internals](testing-internals.md#cdkd-test-removal-choosing-what-to-retain).

## Generated coverage reports

Four committed files report what the fixtures cover and when they ran. CI
reruns each task and fails when the committed copy differs, so regenerate them
whenever you add or change a fixture.

| Report | Shows | Regenerate with |
| --- | --- | --- |
| [Integration test coverage](integ-coverage.md) | Each registered SDK provider type and the fixtures that deploy it | `vp run integ-coverage` |
| [CLI flag coverage](cli-flag-coverage.md) | Each CLI flag and the fixtures whose `verify.sh` passes it | `vp run cli-flag-coverage` |
| [Scenario coverage](scenario-coverage.md) | Each named regression scenario and the fixtures tagged with it | `vp run scenario-coverage` |
| [Integ-run ledger](_generated/integ-last-run.tsv) | When each fixture last ran, and the result | `vp run integ-ledger-normalize` |

`vp run gen:all-matrices` runs all four tasks.

### How a fixture is counted for a resource type

A new provider type is expected to arrive with a fixture that deploys it. The
integration coverage report counts a fixture for a type in two cases:

- the fixture's source contains the type string, which is why a `covers:`
  comment works,
- the fixture constructs the type's `Cfn<Type>` class.

### How a fixture declares its scenarios

A scenario is a named regression case that needs real AWS to reproduce. A
fixture lists the scenarios it exercises in a `.scenarios.json` file beside its
`verify.sh`:

```json
{
  "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"]
}
```

### The ledger is never edited by hand

The integ-run ledger is run history. The normalize task only sorts it and keeps
one row for each fixture. The details of each report are in
[Testing internals](testing-internals.md#coverage-matrices-what-ci-enforces).

## Related

- [Testing](testing.md): running unit and integration tests
- [Integration fixture conventions](integ-fixture-conventions.md): the rules a
  `verify.sh` follows
- [Testing internals](testing-internals.md): what individual fixtures assert
- [Provider Development](provider-development.md): writing the provider a
  fixture exercises
