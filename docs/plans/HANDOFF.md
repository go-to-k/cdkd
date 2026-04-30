# Region/State Refactor — Merge Handoff

Working session-state document for the agent (or user) picking up the
merge phase of this rollout. **Once all listed PRs are merged, delete
this file** — it is intentionally session-scoped and should not live
on `main` long-term.

The design discussion that produced this rollout is preserved in
`docs/plans/README.md` and the per-PR plan files (`01-`...`07-`,
`99-`); read those for *why*. This document is *what's left to do and
how*.

## Snapshot

- **Date snapshotted**: 2026-04-30
- **Git base**: `main` at `6b1133d` (PR #56 merged)
- **Open PRs**: 7 (see table below)
- **markgate state on main**: `check`, `docs`, `verify-pr`,
  `integ-destroy` all fresh as of branch creation. Each merge
  invalidates them in scope-specific ways — re-set per the per-PR
  recipe.

## Already done

- [x] PR #56 — `docs(plans): add multi-PR rollout plan` (merged
      2026-04-30 via squash). All plan files (`docs/plans/01-`...
      `07-`, `99-`, `README.md`) are on `main`.
- [x] `/run-integ basic` clean run (deploy + destroy of S3 + SSM
      Document, 0 errors / 0 orphans). This established the baseline
      `integ-destroy` marker.

## Outstanding PRs — recommended merge order

| Order | PR | Title | Base | integ-destroy scope? | Stacked? |
|---|---|---|---|---|---|
| 1 | #57 | `feat(state): region-prefixed state key (collection model extension)` | `main` | **YES** | no |
| 2 | #61 | `feat(provisioning): verify region match before idempotent NotFound on delete` | `main` | **YES** | no |
| 3 | #60 | `feat(state): dynamic state-bucket region resolution + UnknownError normalization` | `main` | no | no |
| 4 | #62 | `feat(state): default bucket name without region` | `feat/dynamic-region-resolution` → `main` after #60 | no | **YES — on #60** |
| 5 | #63 | `refactor(cli): consolidate --region to bootstrap-only` | `feat/dynamic-region-resolution` → `main` after #60 | no | **YES — on #60** |
| 6 | #58 | `feat(cli): cdkd state destroy command (CDK-app-free destroy)` | `main` | **YES** | no |
| 7 | #59 | `feat(cli): hide state bucket from default output, add cdkd state info` | `main` | no | no |

`integ-destroy scope: YES` means the PR touches files in
`.markgate.yml`'s `integ-destroy.include` set:
`src/provisioning/providers/**`, `src/cli/commands/destroy.ts`,
`src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`,
`src/analyzer/implicit-delete-deps.ts`,
`src/analyzer/lambda-vpc-deps.ts`. These PRs require a fresh
`/run-integ <test>` run to set the `integ-destroy` marker before
`gh pr merge` is allowed.

## Per-PR merge recipe

For each PR in order, perform:

```bash
# 1. Pull latest main
git switch main
git pull --ff-only

# 2. Switch to the PR branch (worktree-locked branches: see "Worktree
#    cleanup" below — easiest to clean up first, then pull fresh)
gh pr checkout <PR-number>

# 3. Rebase if main moved since PR was opened
#    (most likely needed for #62, #63 after #60 merges)
git rebase origin/main      # or origin/feat/dynamic-region-resolution for stacked PRs while #60 is open
git push --force-with-lease # if rebase happened

# 4. Run /verify-pr — full PR readiness checklist
#    (this also runs typecheck/lint/build/tests + sets check + docs markers)
#    For the live-test step, use the actual PR's user-visible behavior.

# 5. For integ-destroy-scope PRs only: run /run-integ
#    Pick a test that exercises the change. `basic` (S3 + SSM) is the
#    minimum; `lambda` or `bench-cdk-sample` is more thorough for
#    deletion-related changes.
/run-integ <test>
# /run-integ sets the integ-destroy marker on success.

# 6. Confirm all 4 markers fresh
mise exec -- markgate verify check
mise exec -- markgate verify docs
mise exec -- markgate verify verify-pr
mise exec -- markgate verify integ-destroy

# 7. Merge with squash + delete branch
gh pr merge <PR-number> --squash --delete-branch

# 8. Pull merged main locally; verify regression-free
git switch main
git pull --ff-only
pnpm run build && pnpm run typecheck && pnpm run lint && npx vitest --run
```

After every merge, the next PR's branch may need rebasing onto the
new `main`. For independent PRs this is usually clean; for stacked
PRs (#62, #63) GitHub auto-retargets the base after #60 merges, but
local rebase still produces the cleanest history.

## Per-PR design notes (from the agents that authored each PR)

These are surface-level "watch out for X" notes captured at PR-create
time. They are **not** review findings — review still required.

### PR #57 (state key region prefix)

- New CLI flag is `--stack-region`, not `--region`, on `state`
  subcommands. This avoids collision with the global `--region`
  defined in `commonOptions`.
- `LEGACY_KEY_DEPTH = 2` / `NEW_KEY_DEPTH = 3` constants in
  `s3-state-backend.ts` distinguish layouts unambiguously in
  `listStacks`.
- `tryGetLegacy` refuses to return a legacy state whose embedded
  region differs from the requested region — this is the actual
  silent-failure prevention.
- `destroy.ts` multi-region resolution: prefers synth region; falls
  back to single-state when only one exists; refuses (with
  actionable error) when multiple regions exist and no synth region
  matches.
- Pre-existing `stacks/` references in
  `docs/state-management.md` (line 656+) and
  `docs/troubleshooting.md` were NOT cleaned up — flagged as
  pre-existing drift unrelated to this PR. Worth a follow-up
  doc-only PR.
- Integration tests `legacy-state-migration` and
  `multi-region-same-stack` were scaffolded but NOT run against
  real AWS by the authoring agent. Run at least one as part of
  `/run-integ`.

### PR #61 (DELETE region verification)

- New `context: { expectedRegion?: string }` parameter on
  `ResourceProvider.delete`. Signature change is in
  `src/provisioning/types.ts`; all 51 SDK providers + the
  Cloud Control provider were updated.
- `expectedRegion?: string | undefined` (not just `?:`) intentionally
  — TypeScript's `exactOptionalPropertyTypes: true` rejects callers
  that pass `undefined` directly.
- `custom-resource-provider` accepts `context` but does NOT call
  `assertRegionMatch` — the underlying Lambda invocation does not
  surface a managed-resource `*NotFound` to act on; the Lambda's
  region is encoded in the ServiceToken ARN regardless.
- `iam-policy-provider` uses an `onNotFound` closure to factor the
  region check across 4 per-target loops without flattening their
  structure. Verify this reads as intended.
- Real-AWS reproduction of the original silent-failure scenario was
  explicitly skipped (impractical without two regions and live
  resources). Unit-level coverage hits the same code path.

### PR #60 (dynamic region resolution + UnknownError)

- New `src/utils/aws-region-resolver.ts::resolveBucketRegion()` uses
  `GetBucketLocation` (GET, has body — not subject to the AWS SDK v3
  empty-body HEAD glitch).
- Per-bucket cache stores `Promise<string>` (single-flight) so
  concurrent callers collapse to one API call.
- `resolveBucketRegion` deliberately never throws — returns
  `fallbackRegion` (or `us-east-1`) on any error so the actionable
  downstream `normalizeAwsError` message wins.
- `S3StateBackend.ensureClientForBucket()` rebuilds the state-bucket
  S3 client to the resolved region. Provisioning clients
  (Cloud Control, Lambda, IAM, etc.) are intentionally untouched.
- New `S3ClientOptions` interface inside
  `s3-state-backend.ts` rather than reusing
  `AwsClientConfig` from `aws-clients.ts` — this avoids a
  state→cli-utils dependency the layered architecture forbids.
- `normalizeAwsError` and `resolveBucketRegion` were added to
  `src/index.ts` public exports.
- Cross-region E2E deploy/destroy (real AWS) was not run. `state list`
  was live-tested. The fixture directory
  `tests/integration/cross-region-state-bucket/` is scaffolded.

### PR #62 (default state bucket name — region-free) — STACKED on #60

- Lookup chain: explicit value → probe new name (`HeadBucket`) → on
  404 fall back to legacy `cdkd-state-{acc}-{region}` with a
  deprecation warning → throw "run cdkd bootstrap" if neither.
- 301 / 403 are treated as "exists" in the probe (plan was silent
  here). 301 = bucket in another region; 403 = bucket exists but no
  `s3:ListBucket`. Treating both as "exists" prevents the legacy
  fallback from masquerading a real cross-region or permissions
  error as a missing bucket.
- BC fallback branches carry `// TODO(remove-bc-after-1.x):` markers
  — see PR 99 (`docs/plans/99-future-bc-removal.md`) for the
  removal plan.
- `scripts/verify-bc.sh PR-4` operates on source text, not `dist/`
  (cdkd bundles into a single file).
- Integration test `legacy-bucket-name-fallback` was scaffolded but
  not executed end-to-end (would conflict with parallel integ runs
  via account-wide bucket inventory).

### PR #63 (--region flag cleanup) — STACKED on #60

- Uses `Option.hideHelp()` on `deprecatedRegionOption` so the flag
  remains parsable but is invisible in `--help`.
- `warnIfDeprecatedRegion(options)` invoked inside
  `setupStateBackend()` so all four `state` subcommands inherit the
  warning from the shared bootstrap path (DRY).
- `vi.spyOn` did not reliably intercept `process.stderr.write` in
  vitest under output capture; the test helpers use direct
  `process.stderr.write` replacement instead. Authoring agent
  saved a memory file
  (`~/.claude/projects/-Users-goto-github-cdkd/memory/vitest_stderr_capture.md`)
  capturing this — verify and either keep or remove. (This was
  intentional but worth knowing.)
- The empty-string branch in `warnIfDeprecatedRegion` (`region: ''`)
  intentionally still warns: Commander only assigns the property
  when the user actually passed the flag.

### PR #58 (cdkd state destroy)

- Refactor: per-stack destroy lifecycle hoisted from
  `cdkd destroy` into
  `src/cli/commands/destroy-runner.ts::runDestroyForStack`. Both
  `cdkd destroy` and `cdkd state destroy` consume it.
- Existing `cdkd destroy` behavior is preserved byte-for-byte (same
  emoji log markers, same flow). The "no emojis" rule applies to
  *new* content; behavior preservation in a refactor wins.
- `runDestroyForStack` takes a pre-loaded `StackState` (caller does
  the `getState`/`listStacks`) — `cdkd state destroy` needs to
  consult `state.region` for the `--region` filter before invoking
  the runner.
- `--region` filter on `cdkd state destroy`: filters by comparing
  against `state.region` and skipping mismatches with a warning.
  When PR 1 (#57) lands and adds per-region keys, the same filter
  drops to the right shard with no code change.
- `--all` confirmation: single batch prompt up-front, no per-stack
  prompt afterward (with `--yes`, both are skipped).
- Strict missing-stack handling: `cdkd state destroy MyTypo --yes`
  errors with "No state found for stack(s)..." instead of silently
  skipping. For a destructive command without synth as a
  typo-catcher, this is intentional.
- `docs/plans/` files were intentionally NOT shipped with this PR
  (they belong to #56, now merged).

### PR #59 (state info + hide bucket display)

- Banner demoted from `logger.info` to `logger.debug` in the single
  resolver helper (`resolveStateBucketWithDefault`), so it disappears
  across deploy/destroy/diff/force-unlock and all state subcommands
  at once but reappears under `--verbose`.
- New `state info` reports bucket name, auto-detected region
  (`GetBucketLocation`), source label
  (`cli-flag` / `env` / `cdk.json` / `default`), schema version,
  stack count.
- Stack count handles both legacy
  (`<prefix>/<stack>/state.json`) AND new
  (`<prefix>/<stack>/<region>/state.json`) layouts so it works
  regardless of whether PR #57 has merged yet.
- New `resolveStateBucketWithSource` /
  `resolveStateBucketWithDefaultAndSource` siblings; original
  resolver signatures untouched (drop-in compatible for existing
  call sites).
- `default-legacy` source label deferred — applies after PR 4 (#62)
  lands; out of scope here.
- Not touching deletion logic, so `integ-destroy` marker is NOT
  invalidated by this PR.

## Worktree cleanup

The agents that authored these PRs left `git worktree` directories
under `.claude/worktrees/agent-*`. They are locked. Easy cleanup:

```bash
for wt in $(ls .claude/worktrees/ | grep ^agent-); do
  git worktree unlock .claude/worktrees/$wt 2>/dev/null || true
  git worktree remove --force .claude/worktrees/$wt 2>/dev/null || true
done
git worktree prune
```

Safe to run before, between, or after the merges.

## Operating-rules reminders (from CLAUDE.md)

These bite if you forget:

1. **Never commit/push to `main`.** Branch gate hook blocks it.
2. **Use `git commit -F <file>` for messages.** Heredoc-style
   `git commit -m "$(cat <<'EOF' ... EOF)"` is blocked by hook —
   shell quote tracking miscounts.
3. **`gh pr edit --title` / `--body` is broken** (silent failure on
   GraphQL Projects-classic deprecation). Use:
   ```bash
   gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title=... -F body=@<file>
   ```
4. **Don't bypass markgate.** Don't run `markgate set integ-destroy`
   manually — `/run-integ` is the only legit setter and it requires
   a clean destroy.
5. **All committed files in English.**
6. **For UI-or-CLI changes, the `/verify-pr` live-test step is
   required** — actually run the command path against fixture or
   real input. Tests passing ≠ feature working.

## Final cleanup PR (after all 7 merges)

Open one small PR that:

- Deletes `docs/plans/HANDOFF.md` (this file).
- Optionally: cleans up the pre-existing `stacks/` references in
  `docs/state-management.md` and `docs/troubleshooting.md` flagged
  by the PR #57 agent (or just keep as a separate PR).
- Optionally: closes the GitHub issue tracking PR 99 if one was
  opened.

This signals the rollout is closed.

## Subagent invocation hint

If handing off to a subagent in the same session via the `Agent`
tool, use:

- `subagent_type: general-purpose`
- `model: opus` (Opus 4.7 — required by the user's preference for
  this work)
- `isolation: worktree` (auto-managed)

Prompt template (one self-contained string):

```
Read /Users/goto/github/cdkd/docs/plans/HANDOFF.md fully before doing
anything. It contains the snapshot, per-PR design notes, the merge
recipe, and the rules. Then merge PR #57 first, following the per-PR
recipe verbatim. After it merges, repeat for #61, then #60, then #62
(rebase onto new main first), then #63 (rebase), then #58, then #59.

For each PR, the live-test step in /verify-pr must exercise the
PR's actual user-visible behavior — run the relevant cdkd command
against real or fixture input.

Stop and report if any PR's checks fail or if a merge produces a
regression on the post-merge `pnpm run build && pnpm run typecheck
&& pnpm run lint && npx vitest --run`.

Do NOT skip /run-integ on integ-destroy-scope PRs (#57, #61, #58).
Do NOT bypass markgate gates. Do NOT push to main directly.

When all 7 PRs are merged, open a final cleanup PR that deletes
docs/plans/HANDOFF.md and report the URLs of the 7 squashed merge
commits and the cleanup PR.
```

Sequential — don't try to merge PRs in parallel. The markgate gates
serialize anyway, and stacked PRs (#62, #63) need #60 merged first.
