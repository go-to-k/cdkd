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
2. The records a refactor KILLED mid-move leaves are written by hand. Both
   moves are listed in `_refactor/pending.json`; the table as right after that
   first write (the source neither marks nor drops it), the queue as after the
   destination write (the source marks and still holds it, the destination
   holds it too). `cdkd deploy` of either stack refuses with nothing created,
   `cdkd destroy` of the source refuses, `cdkd diff` of both exits 3, and the
   table and its item are untouched.
3. `cdkd refactor --all --yes` finishes both moves: the destination holds them
   under the same physical ids, and the source holds neither and records no
   unfinished move.
4. `cdkd deploy --all` keeps both physical ids, the queue's creation
   timestamp, the table's data item and the parameter's `Version` (the
   import resolves to the same values).
5. `cdkd diff --all --fail` reports no change.
6. `cdkd destroy --all` removes everything and both state records.

## Run

```bash
/run-integ refactor-move
```
