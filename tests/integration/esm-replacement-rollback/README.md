# esm-replacement-rollback

A deploy that replaces a Lambda `EventSourceMapping` (its SQS queue is renamed)
and then fails rolls back by deleting the new mapping seconds after it was
created, while Lambda still reports it `Creating`. The delete must wait for the
mapping to settle rather than fail with `ResourceInUseException`, so the
rollback leaves one mapping, on the restored queue, recorded in state, and the
next deploy does not collide
([#7011](https://github.com/go-to-k/cdkd/issues/7011)).

Run: `/run-integ esm-replacement-rollback`
