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
- **Phase 2 (initialDeploy path)**: first-ever failing `--no-rollback` deploy
  of a second stack → `cdkd rollback --force` deletes the created parameter AND
  removes `state.json` entirely.
- **Phase 3**: destroy stack 1 clean, 0 orphans.

## Failure injection

Both stacks add an `AWS::SQS::Queue` with an out-of-range
`messageRetentionPeriod` (valid range `[60, 1209600]`) when `INJECT_FAIL=true`,
wired to depend on every other resource so those complete first — guaranteeing
the rollback journal records real work. See
`lib/rollback-command-stack.ts` for the env-gated resource set
(`MARKER_VALUE` / `WITH_EXTRA` / `INJECT_FAIL`).
