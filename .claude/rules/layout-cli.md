---
description: cdkd CLI layer layout (command tree, config/stack matching, events, gc, rollback)
paths:
  - 'src/cli/**'
---

# Key Files and Directories - src/cli

Per-command detail: [layout-cli-diff.md](layout-cli-diff.md) (`cdkd diff`),
[layout-cli-state.md](layout-cli-state.md) (`cdkd state` / `cdkd orphan`),
[layout-cli-import-export.md](layout-cli-import-export.md),
[layout-drift.md](layout-drift.md),
[layout-deployment-secrets.md](layout-deployment-secrets.md) (`cdkd scrub`).
Index of every area: [code-layout.md](code-layout.md).

## The split that decides where a command belongs

- **Top-level commands** (`deploy`, `destroy`, `diff`, `synth`, `list`,
  `import`, `orphan`) require a CDK app — they synthesize a template to know
  what they operate on.
- **`cdkd state ...`**, `cdkd drift`, `cdkd events` and `cdkd rollback` are
  STATE-driven: no synth, so they still work when the CDK app is missing.
  `drift` compares state-recorded properties against each provider's optional
  `readCurrentState` (Cloud Control covers the rest).
- The two `orphan` commands differ in GRANULARITY: `cdkd orphan
  <constructPath>...` is per-resource and rewrites every sibling reference
  (`Ref` / `Fn::GetAtt` / `Fn::Sub` / dependencies) so the next deploy does not
  re-create the orphan; `cdkd state orphan <stack>...` drops the whole state
  record without touching siblings. Both delete ONLY cdkd state — the AWS
  resources stay.

## Important files

- **src/cli/config-loader.ts** - config resolution (cdk.json, env vars for
  `--app` and `--state-bucket`).
- **src/cli/stack-matcher.ts** - shared stack-name matcher for deploy / diff /
  destroy / list; routes a pattern by whether it contains `/` (display path) or
  not (physical name) and returns a deduplicated union. `renderNoStackMatch`
  owns the empty-selection message for deploy / diff / list / publish-assets and
  takes the `SynthesisResult` as a REQUIRED argument, so a Stage that failed to
  load is named rather than reported as "no stacks matching"
  ([#3482](https://github.com/go-to-k/cdkd/issues/3482)) — a REQUIRED member,
  so an ad-hoc `{}` is a compile error; `scrub` and `destroy` still word their
  own. Each of those four also throws it on a ZERO-stack assembly BEFORE its
  branch chain, which otherwise answers `Multiple stacks found: .`.
  `describeStack` renders both names through `displayIdent`, which is right for
  the PROSE it serves and wrong for a PAYLOAD: **`list.ts` deliberately does not
  route through it** ([#3479](https://github.com/go-to-k/cdkd/issues/3479)) —
  its display id puts `displayName` FIRST, and `displayIdent` would quote a
  legitimate `My Stack` into a stream a shell loop reads, so `formatDisplayId`
  sanitizes locally with `displaySafe`. `toLongRecord` does too: measured per
  character, NEITHER `JSON.stringify` nor `yaml` escapes DEL, C1, `U+2028` or the
  bidi overrides, so the encoder is not the boundary for the `--long` /
  `--show-dependencies` payloads. They disagree about C0, which is not what that
  rests on. A
  control-only name still sanitizes to EMPTY there, which reads as absent —
  `UNRENDERABLE`-vs-empty per slot is an open row on
  [#3479](https://github.com/go-to-k/cdkd/issues/3479).
- **src/cli/region-options.ts** - shared region normalization
  ([#2065](https://github.com/go-to-k/cdkd/issues/2065)). `foldRegionOption`
  canonicalizes `--region` AND the `AWS_REGION` / `AWS_DEFAULT_REGION` env vars
  — the env half is what the AWS SDK's own resolution chain reads, which no fold
  at a cdkd read site can reach. `namedCliRegion` answers "which region did the
  user NAME" (`undefined` when none); `rawCliRegion` preserves the spelling for
  the bootstrap marker's second probe alone. `adoptDeprecatedRegionFlag(cmd)`
  serves the four `cdkd local start-*` ENGINE shims whose handler belongs to
  cdk-local: it splices cdk-local's `--region` out, adds cdkd's hidden
  deprecated option, and folds in a `preAction` hook — the only cdkd-owned point
  running BEFORE cdk-local builds an SDK client. `cli-region-fold.test.ts`
  fences the shape across `src/cli/commands/`.
- **src/cli/program.ts** - `buildProgram()` builds the whole Commander tree.
  Split from `index.ts` because importing that file runs `main()` as a side
  effect, so tooling could not read the tree without executing the CLI.
- **src/cli/pipe-close-handler.ts** - `installPipeCloseHandler()` exits 0 on
  EPIPE when a downstream consumer closes the pipe early; non-EPIPE stream
  errors re-throw. Its own module so it stays unit-testable.
- **src/cli/commands/events.ts** (+ `src/state/deployment-events-store.ts`,
  `src/types/deployment-events.ts`) - structured deployment events, cdkd's
  `DescribeStackEvents` equivalent. The store is a buffering JSONL recorder with
  a best-effort async flush that NEVER blocks the run; the reader discovers
  regions by raw key listing so it survives a destroy. S3 layout
  `cdkd/{stack}/{region}/deployments/{runId}.jsonl` + `deployments/index.json`
  (last N runs, last-writer-wins) — a SEPARATE key family from `state.json`, so
  no state-schema bump. **Events carry error + metadata only, never resource
  properties.** Per-resource and rollback events come from `DeployEngine` /
  `rollback-executor.ts` / `destroy-runner.ts`; the run-level RUN_STARTED /
  RUN_FINISHED bracket lives in `deployment-events-run.ts` (`startRunRecorder`
  returns `undefined` under `--dry-run`, so a dry run records nothing). When
  `index.json` is missing or corrupt the reader derives each run's result from
  its own JSONL's last `RUN_FINISHED` and reports `UNKNOWN` for a stream with
  none — never fabricating `FAILED`. Retention has three arms
  ([#885](https://github.com/go-to-k/cdkd/issues/885)): the writer self-bounds at
  `finalize()`, `cdkd events prune <stack>` is the explicit purge, and
  `cdkd destroy --purge-events` runs only after a CLEAN, non-interrupted destroy
  (a failed one keeps its events as post-mortem). Guide:
  [docs/deployment-events.md](../../docs/deployment-events.md).
- **src/cli/commands/rollback.ts** - `cdkd rollback [STACK]`
  ([#1183](https://github.com/go-to-k/cdkd/issues/1183)): synth-free revert after
  a failed `--no-rollback` or interrupted deploy. Replays
  `rollback-journal.json` newest-first through `rollback-executor.ts`, saving
  state after each op and popping each cleanly-replayed segment; when the oldest
  segment was the first-ever deploy and state ends empty, `state.json` is deleted
  too. `--revert-failed` opts into replaying the segment's journaled
  `failedOperations` BEFORE its completed ops (a failed CREATE is deleted only
  when a state record matches, and then under its `DeletionPolicy` — `Retain`
  orphans, `Snapshot` snapshots then deletes unless `--skip-final-snapshot`); it
  is off by default because the failed resource's remote state is unknown. Exit
  codes: 0 clean, 2 partial (journal kept, re-run is idempotent), 1 hard error.
- **src/cli/commands/gc.ts** - `cdkd gc` garbage-collects unreferenced objects /
  images from ONE region's cdkd-owned asset storage, with names read from the
  bootstrap marker rather than the naming convention (CDK bootstrap storage is
  never touched). It scans EVERY state file in the bucket for asset references;
  guards are a lock.json abort, a malformed-state abort, the `--older-than` age
  guard (default 30d, inclusive-KEEP at the boundary) and `ExpectedBucketOwner`
  on every S3 call. It shares `state-file-keys.ts` with `bootstrap-destroy.ts` so
  the two commands' state discovery cannot drift. It also sweeps abandoned
  `custom-resource-responses/{requestId}.json` placeholders; that arm runs BEFORE
  the bootstrap-marker check, because the placeholders live in the STATE bucket,
  which exists whether or not the region opted in to asset storage. The prefix is
  ONE binding shared with the producer (`CUSTOM_RESOURCE_RESPONSE_PREFIX` in
  `src/state/state-prefix.ts`) — a sweeper pointed at a drifted prefix finds
  nothing and exits 0, indistinguishable from a clean bucket.
- **`isPasteableIdent`** (with `parseStateKey` / `displayIdent`) is the repo's
  answer for any value cdkd renders into a command it tells an operator to RUN,
  not just a state-key segment: `--state-bucket=attacker` is plain-identifier
  clean and still an option when pasted. Its second consumer is
  `resolveProfileCredentials` in `local-start-api.ts`, gating an
  `aws sso login --profile <name>` hint, so tightening either half must ask what
  it costs that caller (go-to-k/cdkd#3377).
- **src/cli/commands/synth.ts** - `resolveVerboseTemplatePath` is the ONE place
  cdkd turns an assembly-supplied string into a path it WRITES (`--verbose`
  dumps `<stackName>.template.json`). `stackName` comes from the manifest, so it
  is containment-checked like every read site, **and then `lstat`ed**
  ([#3489](https://github.com/go-to-k/cdkd/issues/3489)). The second check is
  not redundant: `resolveAssemblyPath` is exact only for a path that fully
  resolves, and a file about to be CREATED never does, so the write is the one
  caller relying on that helper's model. `lstat` does not follow the link, so a
  symbolic link here is refused whatever it points at and no shape has to be
  enumerated. Do not relax it to a containment test on the link's target.
- **src/cli/commands/nested-template-preflight.ts** - `cdkd deploy`'s refusal
  of a malformed nested-template tree (#3449). The call stays BEFORE macro
  expansion and the work graph; `NestedStackProvider`'s per-row walk is the
  backstop, not a duplicate. Not in `AssemblyReader`: `diff` owns its refusal.
- **src/cli/commands/pin-cc-api-reachability.ts** - the pure decision behind
  `--pin-cc-api`'s pre-flight: which pinned logical ids match NO stack (an error
  — the flag prints nothing on success, so an id that matched nowhere is
  otherwise invisible) and which match some but not all (normal under `--all`,
  reported ONCE naming the stacks, never once per non-matching stack).
