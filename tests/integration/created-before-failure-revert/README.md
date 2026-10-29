# created-before-failure-revert integration test

End-to-end real-AWS validation for issue
[#4583](https://github.com/go-to-k/cdkd/issues/4583): when an SDK provider's
`create()` fails AFTER its create call returned, the resource it made is
journaled with its physical id (`physicalIdRecoveredFromError: true`) so
`cdkd rollback --revert-failed` can delete it — unless the provider's own
catch already deleted it, in which case nothing is journaled for the rollback
to delete.

Run it with `/run-integ created-before-failure-revert` (never invoke
`cdkd deploy` / `cdkd rollback` by hand — the skill pairs the run with the
orphan verification).

## What it exercises

One stack per arm, each deployed on its own with `--no-rollback` so the
failed deploy's rollback journal survives. They are separate stacks because a
failing resource interrupts its in-flight siblings: in one stack, the first
failure would decide whether the other arm's create ever ran.

- **Phase E — `CdkdCreatedBeforeFailureRevertEcrExample`** (a provider that does
  not delete what it made): an `AWS::ECR::Repository` with an explicit name and
  a lifecycle policy whose rule has an unknown `tagStatus`. `CreateRepository`
  succeeds and ECR rejects `PutLifecyclePolicy`. Asserts the repository exists
  without a lifecycle policy, state has no record of it, and the journal's
  failed op carries the repository name with `physicalIdRecoveredFromError:
  true`; then `cdkd rollback --force --revert-failed` exits 2: the ECR
  provider journals no creation identity, so the rollback keeps the repository
  and warns naming it (go-to-k/cdkd#4658). It removes the journal and
  `state.json`, and the fixture deletes the repository itself.
- **Phase S — `CdkdCreatedBeforeFailureRevertSnsExample`** (a provider that
  deletes what it made, and the delete succeeds): an `AWS::SNS::Topic` with an
  explicit name and a `DataProtectionPolicy` lacking its required members.
  `CreateTopic` succeeds, SNS rejects `SetTopicAttributes`, and the provider
  deletes the topic (`--verbose` shows its "Cleaned up partially-created SNS
  topic Topic" line). Asserts the topic is gone and the journal's failed op
  carries neither a physical id nor `physicalIdRecoveredFromError`; then
  `cdkd rollback --force --revert-failed` deletes nothing — it skips the
  id-less failed CREATE with a warning and so exits 2 — and removes the journal
  and `state.json`.
- **Phase K — `CdkdCreatedBeforeFailureRevertKinesisExample`** (the deadline
  drops the provider's marked error, go-to-k/cdkd#5511): an
  `AWS::Kinesis::Stream` with an explicit name, deployed under
  `--resource-timeout AWS::Kinesis::Stream=2s`. `CreateStream` returns and the
  deadline fires inside the provider's ACTIVE wait. Asserts the stream exists,
  state has no record of it, and the journal's failed op carries the stream
  name with `physicalIdRecoveredFromError: true` and a creation identity, all
  from the id the provider reported to the engine's created-resource sink.
  Once the stream is ACTIVE, `cdkd rollback --force --revert-failed` exits 0
  and deletes it, `describe-stream-summary` answers not found, and the journal
  and `state.json` are gone.

## Cleanup

The EXIT trap, and a sweep at the start of every run, delete the repositories,
the topic and the stream by name and remove both stacks' state prefixes. After a run
killed with SIGKILL, delete by hand the ECR repository
`cdkdcreatedbeforefailurerevertecrexample-orphan-repo`, the SNS topic
`CdkdCreatedBeforeFailureRevertSnsExample-topic` and the Kinesis stream
`CdkdCreatedBeforeFailureRevertKinesisExample-deadline-stream`, or simply run
the fixture again.
