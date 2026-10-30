# refactor-command

Real-AWS integ for `cdkd refactor` (issue
[#5201](https://github.com/go-to-k/cdkd/issues/5201)): renamed construct ids
keep their AWS resources instead of being replaced.

Stack: `CdkdRefactorCommandExample`. The whole run uses the non-default state
prefix `cdkd-integ-refactor`.

## What it exercises

Generation "a" (default) and generation "b" (`CDKD_TEST_UPDATE=true`) differ
only in construct ids:

| Resource | Generation a | Generation b | Why |
| --- | --- | --- | --- |
| DynamoDB table (explicit name, holds a data item) | `Legacy/Table` | `Storage/Data` | A stateful resource moved under a renamed parent |
| SQS queue (cdkd-generated name) | `Queue` | `WorkQueue` | A generated physical name that embeds the OLD logical id |
| Two identical SNS topics | `TopicX`, `TopicY` | `AlertsX`, `AlertsY` | Look-alikes the detection must refuse to guess |
| SSM parameter referencing all of them | `Wiring` | `Wiring` | A kept resource whose references must resolve unchanged |

`verify.sh` asserts that, under generation "b":

1. `cdkd diff --fail-on=destructive` reports the replacement a plain deploy
   would make.
2. `cdkd refactor --dry-run` refuses on the ambiguous topics, and the state
   object's ETag is unchanged.
3. With `--override-file` naming the topics, `--dry-run` plans all four
   renames, prints no warning, and writes nothing.
4. `cdkd refactor --yes --override-file` renames four records; the new logical
   ids carry the old physical ids and no old logical id remains.
5. `cdkd diff --fail` reports no change.
6. `cdkd deploy` keeps every physical id, the queue's creation timestamp, the
   table's data item and the SSM parameter's `Version`.
7. `cdkd destroy` removes everything, and no state record ever appears under
   the default `cdkd/` prefix.

## Run

```bash
/run-integ refactor-command
```
