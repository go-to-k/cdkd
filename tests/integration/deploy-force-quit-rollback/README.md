# deploy-force-quit-rollback

Integration test for the rollback journal a force-quit or a closed terminal
writes mid-deploy (issue
[#6894](https://github.com/go-to-k/cdkd/issues/6894)).

## Setup

- `Marker` (SSM parameter), `Queue` (SQS queue) and `Fn` (Lambda function):
  `FIXTURE_VERSION=v2` changes the parameter value, the queue's visibility
  timeout and a function environment variable, so a v2 deploy updates all
  three first.
- `Gate`, a Lambda-backed custom resource that reads all three. Its inline
  handler sleeps 90 s on `Update` before it PUTs its response to
  `ResponseURL`, which holds the deploy mid-operation.
- `After` (SSM parameter) and `AfterQueue` (SQS queue) depend on `Gate`, so an
  interrupted deploy never reaches them.

## Behavior under test

From a clean v1 stack, a v2 deploy runs in the background until state.json
records the three first updates and the custom resource's handler has logged
the start of its update, then:

1. **Two SIGINTs** (a force-quit, as a cancelled CI job sends): the deploy
   exits `130`, prints the `cdkd force-unlock` and `cdkd rollback` commands,
   and leaves `rollback-journal.json` whose newest segment is `interrupted`,
   lists the three completed updates, and lists the in-flight custom resource
   as a failed operation.
2. **A closed terminal**: the deploy runs on a pseudo-terminal (`script`),
   which the arm kills. The kernel delivers `SIGHUP`, every later write to the
   terminal fails with `EIO`, and the deploy must still write the same
   journal. Its exit code is not readable there, so the journal is the
   assertion.

After each, `cdkd force-unlock` releases the lock the force-quit leaves, and
`cdkd rollback --force` puts the parameter, the queue and the function back to
v1 and deletes the journal. The run ends with a destroy and an orphan check.

Before the fix, both arms exited with no journal, and `cdkd rollback` answered
`Nothing to roll back`.

## Run

```bash
/run-integ deploy-force-quit-rollback
```

The two 90-second custom-resource updates keep running in Lambda after the
deploy exits; their late responses land under cdkd's custom-resource response
prefix, where nothing reads them. The run waits the last one out before it
sweeps the stack's Lambda log groups and asserts none is left.
