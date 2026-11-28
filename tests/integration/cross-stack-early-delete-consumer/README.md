# cross-stack-early-delete-consumer

`cdkd deploy` of a producer and its consumer in one run, where the producer
renames a Lambda function that has a `currentVersion` and an alias whose ARN
the consumer imports. The rename replaces the function and the alias and
removes the old version, which the old alias still points at. The consumer
then fails and rolls back
([#7204](https://github.com/go-to-k/cdkd/issues/7204)).

A producer normally deletes such an old alias before the removed version
([#6977](https://github.com/go-to-k/cdkd/issues/6977)). Here the consumer's
records name the old alias, so the producer keeps it for the cleanup that
waits for the consumer ([#7012](https://github.com/go-to-k/cdkd/issues/7012)).
The removed version stays as well, and the rolled-back consumer names a live
alias. The next deploys delete both.

Run: `/run-integ cross-stack-early-delete-consumer`
