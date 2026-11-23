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
records the three first updates, then:

1. **Two SIGINTs** (a force-quit, as a cancelled CI job sends): the deploy
   exits `130` and leaves `rollback-journal.json` whose newest segment is
   `interrupted` and lists the three completed updates.
2. **One SIGHUP** (a closed terminal): the deploy exits `129` with the same
   journal, which also lists the in-flight custom resource as a failed
   operation.

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
prefix, where nothing reads them.
