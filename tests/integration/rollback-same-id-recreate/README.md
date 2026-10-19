# rollback-same-id-recreate

Regression fixture for issue #5096: `cdkd rollback` of a replacement that
deleted the old resource first and re-created it under the SAME physical id
(`cdkd deploy --replace` on a fixed-name resource whose change is create-only).

## Phase A: the reversal

1. Deploys a fixed-name DynamoDB table with key `pk`.
2. Redeploys with key `id` and an injected failing queue, under
   `--replace --force-stateful-recreation --no-rollback`: the table is deleted
   and re-created under the same name, then the queue fails.
3. `cdkd rollback --force` must restore key `pk` on the LIVE table
   (`describe-table`), record `pk` in state, and clear the journal. Before the
   fix it reverted the table in place, which cannot change a key: AWS kept `id`
   while state said `pk`.

## Phase B: the refusal

1. Changes a fixed-name log group's class (not updatable) the same way; its
   log stream is re-created with it.
2. `cdkd rollback --force` must refuse the log group before deleting anything,
   since deleting it again would take the stream too: the group keeps the new
   class, the stream survives, the journal is kept.
3. The remedy the refusal names, `cdkd deploy --replace
   --force-stateful-recreation` of the previous template, restores the class
   and clears the journal.

Then destroy, with every resource probed gone.

Run with `/run-integ rollback-same-id-recreate`.
