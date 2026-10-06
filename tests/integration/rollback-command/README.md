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
- **Phase O (a create that succeeded at AWS and then failed, issue
  [#1710](https://github.com/go-to-k/cdkd/issues/1710))**: deploy with
  `INJECT_ORPHAN_CREATE=true` under `--no-rollback` — `OrphanStream`'s
  `CreateStream` succeeds, then AWS rejects its retention follow-up (9000
  hours, above the 8760 maximum) → assert the stream exists, state has no
  record of it, and the journal's failed op carries the stream name with
  `physicalIdRecoveredFromError: true` → `cdkd rollback --force
  --revert-failed` → the stream is gone, journal gone, exit 0. Then the default
  paths ([#4584](https://github.com/go-to-k/cdkd/issues/4584)): the same deploy
  with the automatic rollback deletes the stream; with `ORPHAN_RETAIN=true`
  (`DeletionPolicy: Retain`) it keeps it; and after `--no-rollback`, a plain
  `cdkd rollback --force` deletes it. A later successful deploy
  ([#4600](https://github.com/go-to-k/cdkd/issues/4600)): after `--no-rollback`,
  a deploy without `INJECT_ORPHAN_CREATE` (a changes deploy) succeeds and deletes
  the stream, with `ORPHAN_RETAIN=true` (a no-change deploy) keeps it, and a
  fix-forward keeping `OrphanStream` under another name (`ORPHAN_FIX_FORWARD=true`)
  exits 2 and names the first stream without deleting it (the fixture deletes
  it). Each asserts the journal gone.
- **Phase S (a skipped op on the automatic path, issue
  [#3338](https://github.com/go-to-k/cdkd/issues/3338))**: deploy with
  `WITH_SKIP_PAIR=true` (a `SkipBucket` holding one object, no
  `autoDeleteObjects`, and a `SkipDoomed` parameter depending on it) → deploy
  without the pair and WITH the automatic rollback: `SkipDoomed`'s DELETE
  completes, `SkipBucket`'s fails, and the rollback cannot undo the completed
  DELETE → assert the run's `ROLLBACK_RESOURCE_SKIPPED` event for `SkipDoomed`
  and that the journal kept the full `auto-rollback-started` segment → `cdkd
  rollback --force` exits 2, records the skip again and clears the journal →
  empty the bucket and deploy plainly to converge.
- **Phase 2 (initialDeploy path)**: first-ever failing `--no-rollback` deploy
  of a second stack → `cdkd rollback --force` deletes the created parameter AND
  removes `state.json` entirely.
- **Phase 3**: a `--no-rollback` `INJECT_ORPHAN_CREATE` deploy leaves the
  stream recorded only in the journal; destroy stack 1 clean, the stream
  deleted ([#4584](https://github.com/go-to-k/cdkd/issues/4584)), 0 orphans.

## Failure injection

Both stacks add an `AWS::SQS::Queue` with an out-of-range
`messageRetentionPeriod` (valid range `[60, 1209600]`) when `INJECT_FAIL=true`,
wired to depend on every other resource so those complete first — guaranteeing
the rollback journal records real work. `INJECT_UPDATE_FAIL=true` instead
flips the always-present `RevertQueue`'s retention to the out-of-range value so
the failure lands on an UPDATE (the `--revert-failed` target). See
`lib/rollback-command-stack.ts` for the env-gated resource set
(`MARKER_VALUE` / `WITH_EXTRA` / `REPLACE_SUFFIX` / `INJECT_FAIL` / `INJECT_ORPHAN_CREATE` /
`INJECT_UPDATE_FAIL` / `WITH_SKIP_PAIR`).
