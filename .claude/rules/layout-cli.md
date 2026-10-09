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
- `cdkd orphan <constructPath>...` and `cdkd state orphan <stack> --resource
  <id>` are per-resource and rewrite every sibling `Ref` / `Fn::GetAtt` /
  `Fn::Sub` / dependency; bare `cdkd state orphan <stack>...` drops the whole
  record. All delete ONLY cdkd state — the AWS resources stay.

## Important files

- **src/cli/config-loader.ts** - config resolution (cdk.json, env vars for
  `--app` and `--state-bucket`).
- **src/cli/stack-matcher.ts** - shared stack-name matcher for deploy / diff /
  destroy / list / synth, CDK-compatible
  ([#4474](https://github.com/go-to-k/cdkd/issues/4474)): a pattern is matched
  against the hierarchical id with `pathGlobMatches` (`*` within a segment,
  `**` across), plus the EXACT physical name as a cdkd extension — never a glob
  over it, or `'*'` would reach every Stage's stacks — and consulted only when
  no id matches. `partitionTopLevel` is what deploy / destroy / diff `--all`
  selects (stacks without a `stagePath`); publish-assets and scrub `--all` keep
  every stack (CDK's ALL_STACKS; scrub is a secret gate).
  `renderNoStackMatch` owns the empty-selection message for deploy / diff /
  list / publish-assets / scrub / import / export / synth. Each of the first
  seven also throws it on a ZERO-stack assembly BEFORE its branch chain, which
  otherwise answers `Multiple stacks found: .`. A Stage that failed to load
  never reaches selection: synthesis fails for every command, as in the AWS CDK
  CLI, so do NOT add selection-time tolerance or refusals for it
  ([#3507](https://github.com/go-to-k/cdkd/issues/3507)). A partly-unmatched
  selection stays silent except in `destroy`, which warns per unmatched
  pattern (`renderUnmatchedPatternsWarning`) — both CDK parity — and, for a
  name in state that is not a stack of this app, with `renderNotInAppWarning`
  whenever something else matched (the by-name nested-child refusal runs only
  when nothing did, so a filter there would drop the name silently).
  **`synth` reaches the same message by a different route and has no branch
  chain to sit before** ([#3550](https://github.com/go-to-k/cdkd/issues/3550)):
  its selection is unconditional, so a zero-stack assembly and a pattern
  matching nothing are one empty-selection check. `synth` is also the one
  consumer whose selection does NOT narrow synthesis — it runs after, matching
  `cdk`, and narrows only stdout, annotations and the `--verbose` dump.
  `describeStack` renders both names through `displayIdent`, which is right for
  the PROSE it serves and wrong for a PAYLOAD: **`list.ts` deliberately does not
  route through it** ([#3479](https://github.com/go-to-k/cdkd/issues/3479)) —
  its display id puts `displayName` FIRST, and `displayIdent` would quote a
  legitimate `My Stack` into a stream a shell loop reads, so `formatDisplayId`
  sanitizes locally with `displaySafe`. `toLongRecord` does too:
  `yaml` does not escape DEL, C1, `U+2028` or the bidi overrides, so the
  encoder is not the boundary for the `--long` / `--show-dependencies`
  payloads; the `--json` arm goes through `stringifyJsonPayload`
  ([#4045](https://github.com/go-to-k/cdkd/issues/4045)), which escapes only
  what `displaySafe` leaves. Two
  residuals, both on that issue's open helper-choice row: a control-only name
  sanitizes to EMPTY, which reads as absent; and sanitizing is MANY-TO-ONE, so
  two distinct manifest entries can emit one identical record — a `jq` select on
  `name` can return two accounts for what reads as one stack. Selection is
  unaffected (`matchStacks` matches the RAW name).
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
  Split from `index.ts`, whose import runs `main()`.
- **src/cli/pipe-close-handler.ts** - `installPipeCloseHandler()` exits 0 on
  EPIPE when a downstream consumer closes the pipe early; non-EPIPE stream
  errors re-throw. Its own module so it stays unit-testable.
- **src/cli/run-cli.ts** - `runCli(main)`, the ONE top-level runner: a `main()`
  rejection prints `Fatal error:` and exits 1, and a `beforeExit` with `main()`
  still PENDING (the event loop drained under an await) exits 70, replacing
  any code the command set, with a message instead of Node's silent 0
  ([#3939](https://github.com/go-to-k/cdkd/issues/3939)).
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
  [docs/_contents/deployment-events.md](../../docs/_contents/deployment-events.md).
- **src/cli/commands/rollback.ts** - `cdkd rollback [STACK]`
  ([#1183](https://github.com/go-to-k/cdkd/issues/1183)): synth-free revert after
  a failed `--no-rollback` or interrupted deploy. Replays
  `rollback-journal.json` newest-first through `rollback-executor.ts`, saving
  state per op and popping each clean segment; a first-ever deploy's segment
  emptying state deletes `state.json`. `--revert-failed` replays the journaled
  `failedOperations` BEFORE its completed ops (a failed CREATE is deleted only
  when a state record matches, or as a provider-proven orphan (#1710) no later
  entry or record owns; then per its `DeletionPolicy`); it is off by default,
  but `isJournaledOrphan` ops replay without it: no path may drop their only
  record unacted (#4584). Exits 0 clean, 2 partial, 1 hard error.
  Each segment replays inside `withNestedRevertRun(segment.runId)`, so a nested
  row reverts from its child's journal with no templates, and a popped segment
  drops the child segments of its run (#3754); run without a stack, a child
  journal its parent's covers is not offered.
- **src/cli/commands/rollback-drop-failed.ts** - `--drop-failed` (#4633): the
  one confirmed exception, drops one orphan entry; never AWS.
- **src/cli/commands/refused-baseline-remedy.ts** - a refused import baseline's
  remedy text; see [state-schema.md](state-schema.md).
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
  `src/state/state-prefix.ts`) — a drifted prefix sweeps nothing and exits 0.
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
