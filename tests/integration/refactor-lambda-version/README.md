# refactor-lambda-version

Real-AWS integ for issue
[#6097](https://github.com/go-to-k/cdkd/issues/6097): a resource that
references something the next deploy changes is a NEW resource, so
`cdkd refactor` never renames the old record into its place, and `cdkd diff`
never suggests it.

Stack: `CdkdRefactorLambdaVersionExample`.

| Resource | Generation a | Generation b (`CDKD_TEST_UPDATE=true`) |
| --- | --- | --- |
| Lambda function `cdkd-refactor-lambda-version-fn` | returns `code: 'a'` | returns `code: 'b'` |
| `fn.currentVersion` + alias `live` | version N | a new logical id, version N+1 |
| REST API with a mock `GET /` | responds `{"code": "a"}` | responds `{"code": "b"}` |
| The API's deployment (stage `live`) | deployment D1 | a new logical id, deployment D2 |

Before the fix, `cdkd diff` marked the old version and the old deployment
`(moved to ..., run 'cdkd refactor' to keep it)`. Following that advice left the
alias on version N and the stage on D1, serving the old code with exit 0.

## Phases

1. Deploy generation "a"; record the alias version N and the stage's deployment.
2. Under generation "b":
   1. `cdkd diff` shows both removals with no `moved to` hint.
   2. `cdkd refactor --dry-run` reports `Not refactored: ... it references ...`
      for both; `cdkd refactor --yes` writes nothing (state ETag unchanged).
   3. `cdkd deploy` moves the alias to version N+1, which returns `code: 'b'`,
      and points the stage at a new deployment.
3. Destroy; the function, the API and the state record are gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<account> AWS_REGION=us-east-1 ./verify.sh
```
