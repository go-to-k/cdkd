# apigw-stage-throttling

Regression integ for issue #963: a REST API whose Stage carries
`MethodSettings` (synthesized by CDK's `deployOptions.throttlingRateLimit` /
`throttlingBurstLimit` — also `metricsEnabled` / `loggingLevel` /
`dataTraceEnabled`) routes the Stage through Cloud Control (#614 silent-drop
routing), which stores the compound `<restApiId>|<stageName>` physical id.

Pre-fix, `Ref` on the Stage resolved to that compound id, poisoning the
CDK-generated Lambda Permission `SourceArn`
(`arn:...:execute-api:...:<apiId>/<apiId>|test/GET/hello`), so API Gateway
could not invoke the Lambda and the deployed API returned
`{"message": "Internal server error"}` on every request — while `cdkd deploy`
reported success.

## What verify.sh asserts

1. The Stage really took the CC route (`provisionedBy == cc-api`, compound
   physical id) — guards the fixture against silently losing the #963 path if
   the SDK provider later gains `MethodSettings` support.
2. The Lambda resource policy `SourceArn` carries the bare stage name (no
   compound id) — the direct `Ref`-resolution assertion.
3. `GET /hello` returns the Lambda body — the functional check a green deploy
   summary cannot substitute for.
4. UPDATE phase (`CDKD_TEST_UPDATE=true`): adds `/items` (new Resource +
   Method + hash-suffixed replacement Deployment) and changes the throttling
   limits; the new route must serve, the updated limits must read back, and
   the old Deployment must be deleted.
5. Clean destroy (REST API gone, state gone).

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
