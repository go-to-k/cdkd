# cross-stack-replace-consumer-rollback

`cdkd deploy` of a producer and its consumer in one run, where the producer
REPLACES an exported queue (renamed) and the consumer (a Lambda function whose
environment imports the queue URL, an SQS event source mapping and the IAM
grant on the queue) then fails and rolls back
([#7012](https://github.com/go-to-k/cdkd/issues/7012)).

The producer holds the delete of its old queue until the consumer has
deployed. The consumer fails, so the old queue is kept, recorded in the
producer's state, and the rolled-back consumer's environment names a queue
that exists. A deploy of the producer alone keeps the old queue while the
consumer still names it ([#7017](https://github.com/go-to-k/cdkd/issues/7017)).
The next deploy of both stacks succeeds and deletes the old queue.

Run: `/run-integ cross-stack-replace-consumer-rollback`
