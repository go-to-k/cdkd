# rollback-command integration test

End-to-end real-AWS validation for the standalone `cdkd rollback` command
(issue [#1183](https://github.com/go-to-k/cdkd/issues/1183)) — reverting a
failed `--no-rollback` / interrupted deploy back to its pre-deploy state via
the persisted rollback journal.

Run it with `/run-integ rollback-command` (never invoke `cdkd deploy` /
`cdkd rollback` / `cdkd destroy` by hand — the skill encodes deploy + rollback
+ destroy + orphan verification in one block).

## What it exercises

- **Phase 1 (update + create rollback)**: deploy v1 clean → deploy v2
  (`MARKER_VALUE=v2` + a new `Extra` param + injected SQS failure) under
  `--no-rollback` → assert a `rollback-journal.json` was written and the
  completed ops landed on AWS (Marker=v2, Extra exists) → `cdkd rollback
  --force` → assert Marker reverted to v1, Extra deleted, journal gone, state
  back to the v1 resource set, and `cdkd events` shows a `rollback` run =
  `SUCCEEDED`.
- **Phase R (reverse-replacement, issue
  [#1199](https://github.com/go-to-k/cdkd/issues/1199))**: deploy with
  `REPLACE_SUFFIX=b` (+ injected create failure) under `--no-rollback
  --force-stateful-recreation` — the create-only SSM parameter Name change
  REPLACES `ReplaceParam` (old `-replace-a` deleted, new `-replace-b`
  created) before the deploy fails → `cdkd rollback --force` REVERSES the
  replacement: `-replace-a` re-created, `-replace-b` deleted, journal gone,
  exit 0.
- **Phase F (`--revert-failed`, issue
  [#1198](https://github.com/go-to-k/cdkd/issues/1198))**: deploy with
  `MARKER_VALUE=vF` + `INJECT_UPDATE_FAIL=true` under `--no-rollback` — the
  Marker update completes, then `RevertQueue`'s UPDATE fails (out-of-range
  `messageRetentionPeriod`) → assert the journal segment carries
  `failedOperations[]` with the pre-op state (retention 3600) AND the
  attempted properties (9999999) → `cdkd rollback --force --revert-failed`
  → Marker back to v1, the failed queue force-reverted to retention 3600,
  journal gone, exit 0.
- **Phase 2 (initialDeploy path)**: first-ever failing `--no-rollback` deploy
  of a second stack → `cdkd rollback --force` deletes the created parameter AND
  removes `state.json` entirely.
- **Phase 3**: destroy stack 1 clean, 0 orphans.

## Failure injection

Both stacks add an `AWS::SQS::Queue` with an out-of-range
`messageRetentionPeriod` (valid range `[60, 1209600]`) when `INJECT_FAIL=true`,
wired to depend on every other resource so those complete first — guaranteeing
the rollback journal records real work. `INJECT_UPDATE_FAIL=true` instead
flips the always-present `RevertQueue`'s retention to the out-of-range value so
the failure lands on an UPDATE (the `--revert-failed` target). See
`lib/rollback-command-stack.ts` for the env-gated resource set
(`MARKER_VALUE` / `WITH_EXTRA` / `REPLACE_SUFFIX` / `INJECT_FAIL` /
`INJECT_UPDATE_FAIL`).
