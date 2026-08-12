# lambda-url-authtype-replay

Real-AWS coverage for the `AWS::Lambda::Url` `AuthType` warn arms
(issue [#1654](https://github.com/go-to-k/cdkd/issues/1654) and the review
follow-up that added the create-path replay warning).

```bash
/run-integ lambda-url-authtype-replay
```

## What it covers

The `AuthType` guard warns and SUBSTITUTES rather than throwing
(issue [#1551](https://github.com/go-to-k/cdkd/issues/1551)): a rollback replay
and `cdkd drift --revert` both feed a cdkd STATE record in as the desired bag,
so a hard refusal there would leave the function URL un-rollbackable. Because
the deploy then SUCCEEDS, the engine records a bag for a call that was
substituted or never made — and before #1654 that bag was the MALFORMED desired
one, so state disagreed with what `readCurrentState` reads back off
`GetFunctionUrlConfig`. That is permanent phantom drift: re-reported by every
`cdkd drift`, and re-triggered by `drift --revert`, which calls `update()`
again.

| Phase | Setup | Asserts |
| --- | --- | --- |
| 1 | Baseline deploy, `AuthType: AWS_IAM` | state and the live URL both say `AWS_IAM` |
| 2 | `AUTHTYPE_JUNK=true` — the template renders `AuthType` as a malformed value | the deploy WARNS (does not fail); the PREVIOUS `AuthType` is what went on the wire and what state records; **the live URL is still IAM-guarded**; the unchanged template then diffs clean against the recorded value |
| 3 | State's `AuthType` hand-patched to `""`, then `AUTHTYPE_JUNK=true` again | `AuthType` is OMITTED from the update and DROPPED from state (not recorded as `NONE`, which would describe a public URL); **the live URL is still IAM-guarded** |
| 4 | `URL_TARGET=b INJECT_FAIL=true … --no-rollback`, then `cdkd rollback --force` | the reverse-replacement replay of a record with no `AuthType` ANNOUNCES that it cannot vouch for the auth type and is defaulting to a PUBLIC `NONE`; the URL really is `NONE` afterwards |
| 5 | An ordinary corrected deploy | `AWS_IAM` is restored in state and on AWS |
| 6 | `cdkd destroy --force` | URL, both functions, state and the rollback journal are all gone |

The load-bearing assertions are the LIVE ones. A regression in this area is a
public endpoint, so every phase re-reads the auth type from AWS rather than
trusting the state record.

**Why the convergence check is `cdkd diff` and not `cdkd drift`.** `drift`
prefers the `observedProperties` baseline — a live `GetFunctionUrlConfig`
snapshot taken at the end of every successful deploy and auto-refreshed for
records that lack one — so it compares AWS against AWS and reports this
resource clean whether or not the recording is fixed. A drift-based assertion
here would be a vacuous pass. The field `effectiveProperties` writes is
`properties`, and `properties` is the PREVIOUS side of the next DEPLOY's diff,
so that is what phase 2 inspects.

## Why a dedicated fixture

`cloudfront-function-url` also creates an `AWS::Lambda::Url`, but with
`AuthType: NONE`, and its subject is the `Lambda::Permission`
`InvokedViaFunctionUrl` backfill. Extending it would blur what it tests.

## Notes for the next reader

- The malformed `AuthType` is rendered as a non-empty **array** via
  `addPropertyOverride`. An `Fn::Join` over a pseudo-parameter — the trick the
  `dynamodb-globaltable` fixture uses for its malformed blocks — resolves to a
  non-empty STRING, which the guard ACCEPTS (it checks the SHAPE, not enum
  membership), so it would never fire. `''` and `{}` risk being pruned during
  synth, which would turn the phase into a silent no-op.
- `TargetFunctionArn` is create-only on `AWS::Lambda::Url`, which is what makes
  phase 4's replacement possible. `AWS::Lambda::Url` is not in
  `STATEFUL_TYPES`, so no `--force-stateful-recreation` is needed.
- Phase 3 produces phase 4's precondition on purpose: the OMITTED arm's drop
  and the hazard the replay warning covers are the same story, and running them
  adjacently keeps that visible.
