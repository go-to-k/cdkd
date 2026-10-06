# SNS Subscription filterPolicy

An SNS -> SQS subscription with a `filterPolicy` — a daily CDK pattern. The
`AWS::SNS::Subscription` carries a `FilterPolicy` (a nested JSON object) that
cdkd must forward to `SetSubscriptionAttributes` exactly, without
double-stringifying or dropping it.

## What it verifies

1. **FilterPolicy reached AWS intact**: `get-subscription-attributes` returns a
   `FilterPolicy` whose `color` allowlist (`["red","green"]`) and `weight`
   numeric filter (`[{"numeric":[">",10]}]`) match what was synthesized.
2. **A two-queue `QueuePolicy` shrinks, grows and is cleared**
   ([#4594](https://github.com/go-to-k/cdkd/issues/4594)): a standalone
   `sqs.QueuePolicy` names two RETAINED queues. Both carry the policy after
   deploy; a redeploy with `CDKD_TEST_UPDATE=shrink` drops queue B from the
   list and its policy is cleared while queue A keeps it; a redeploy of the
   full list applies it to queue B again.
3. **A failed `QueuePolicy` is removed only from queues still carrying it**
   ([#4612](https://github.com/go-to-k/cdkd/issues/4612)): under
   `--no-rollback`, `CDKD_TEST_UPDATE=overlapfail` adds a `QueuePolicy` over
   two more RETAINED queues, C and D, and a queue that does not exist. It
   writes C and D, fails (after about 47s of retries), and is journaled under
   `C,D`.
   The failed document carries a raw account-id principal, which SQS stores
   as `arn:aws:iam::<id>:root`; the run notes what SQS stored, and the clears
   below prove the IAM-equivalent compare still matches it.
   - (a) A deploy with `CDKD_TEST_UPDATE=overlapown` then writes another
     `QueuePolicy` over C. Its success settle deletes the failed entry: D is
     cleared, C (written by that deploy) keeps the new policy, and the deploy
     exits `2`.
   - (b) The same failure again, now over the record's C, then a write to D
     from outside cdkd. `cdkd rollback --revert-failed` clears C, which
     carries the failed document, leaves D's outside policy, and exits `2`.
   - `overlapownv2` then rewrites C through the record, so the destroy's
     clear of it is observed.
4. **Clean destroy**: the topic, queue and cdkd state are gone afterward, and
   the policy is cleared from the retained queues A, B and C (`verify.sh`
   then deletes all four).

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
