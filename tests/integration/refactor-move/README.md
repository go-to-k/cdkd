# refactor-move

Real-AWS integ for `cdkd refactor` moving resources between stacks (issue
[#5202](https://github.com/go-to-k/cdkd/issues/5202)).

Stacks: `CdkdRefactorMoveSource` and `CdkdRefactorMoveDest`. The whole run
uses the non-default state prefix `cdkd-integ-refactor-move`.

## What it exercises

| Resource | Generation a | Generation b (`CDKD_TEST_UPDATE=true`) |
| --- | --- | --- |
| DynamoDB table (explicit name, holds a data item) | Source | Destination |
| SQS queue (cdkd-generated name, embedding the SOURCE stack's name) | Source | Destination |
| SNS topic `Anchor` | Destination | Destination |
| SSM parameter recording the table and the queue | Source, local references | Source, imports from the destination |

`verify.sh` asserts that, under generation "b":

1. `cdkd refactor --all --dry-run` plans both moves and leaves both state
   objects' ETags unchanged.
2. `cdkd refactor --all --yes` moves both records: the destination holds them
   under the same physical ids, and the source holds neither.
3. `cdkd deploy --all` keeps both physical ids, the queue's creation
   timestamp, the table's data item and the parameter's `Version` (the
   import resolves to the same values).
4. `cdkd diff --all --fail` reports no change.
5. `cdkd destroy --all` removes everything and both state records.

## Run

```bash
/run-integ refactor-move
```
