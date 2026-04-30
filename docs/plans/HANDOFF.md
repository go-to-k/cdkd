# Region/State Refactor — Merge Handoff

This is a **temporary, session-scoped** document for the agent (or
person) picking up the merge phase of the cdkd region/state refactor.
It is intentionally self-contained — read this and you have
everything you need to ship the remaining 7 PRs to `main` without
chat-scroll archaeology.

After all 7 listed PRs are merged, a final cleanup PR deletes this
file. The durable design record stays in `docs/plans/README.md` and
the per-PR plan files (`01-`...`07-`, `99-`).

---

## 0. About this document and PR #64

- This document is the **head** of this PR (#64). Reading the PR is
  enough — no other context required.
- **Merge this PR** (#64). HANDOFF.md belongs on `main` for the
  duration of the rollout so anyone (different terminal, different
  machine, fresh chat) can find it via `cat docs/plans/HANDOFF.md`.
- **Final cleanup PR** removes HANDOFF.md after the 7 listed PRs are
  merged. That PR may also clean up the pre-existing `stacks/` doc
  drift flagged by the PR #57 agent (separate concern, optional).

---

## 1. Why this rollout exists

Three classes of bugs and UX issues surfaced together. They share one
underlying cause: cdkd's collection model (one S3 bucket per account)
plus CDK's per-stack `env.region` interact in subtle ways.

### 1.1 Silent state corruption on `env.region` change

A real incident: a stack with `env.region = us-west-2` was deployed,
then the user changed `env.region` to `us-east-1` and re-ran
`cdkd deploy`. cdkd overwrote the recorded region in `state.json`,
losing track of the original region's resources. A subsequent
`cdkd destroy` ran against `us-east-1` clients, hit
`ResourceNotFoundException` for each resource (because the resources
were actually in `us-west-2`), and treated the errors as idempotent
delete success. The `us-west-2` Lambda / S3 bucket / SQS queue / SNS
topic were silently orphaned.

This is the headliner. PR #57 (region-prefixed state key) and PR #61
(DELETE region verification) are the two-pronged fix.

### 1.2 `UnknownError` from S3 HeadBucket

When the CLI's profile region differs from the state bucket's region,
the AWS SDK v3 fails to handle the cross-region HEAD redirect cleanly
(empty body + 301). Users see:

```
StateError: Failed to verify state bucket 'X': UnknownError
Caused by: UnknownError
```

…which is uninformative. PR #60 fixes both by resolving bucket region
dynamically and normalizing the synthetic Unknown into actionable
messages keyed off `$metadata.httpStatusCode`.

### 1.3 Team sharing breaks across profile regions

The default state bucket name embeds the CLI's profile region:
`cdkd-state-{accountId}-{region}`. Two teammates with different
profile regions look up different bucket names and end up with split
state — they cannot share a stack without one of them aligning
profile regions.

PR #62 fixes this by removing region from the default name
(`cdkd-state-{accountId}`), with a legacy fallback for existing users.

### 1.4 Design choice: collection model + region-prefixed key

We considered three models and picked the third:

- **Approach 1 (CDK-aligned)**: state in per-region buckets,
  `cdkd-state-{acc}-{region}` × N. Loses cdkd's killer feature
  (account-wide `state list`).
- **Approach 2 (status quo + dynamic resolution)**: keep one bucket,
  prevent `env.region` change at deploy time with an error. Simpler
  but more user-hostile.
- **Approach 3 (chosen)**: one bucket, but add region to the state
  key (`cdkd/{stack}/{region}/state.json`). Same `stackName`
  deployed to two regions becomes two independent state files.
  CDK-compatible behavior (旧 region のリソースは追跡可能) +
  cdkd-style aggregation.

The PRs implement Approach 3 plus the team-sharing fix (region-free
default bucket name) and the UnknownError fix.

---

## 2. Snapshot

- **Date**: 2026-04-30
- **Git base**: `main` at `6b1133d` (PR #56 merged)
- **Open PRs**: 7 implementation PRs + 1 handoff (this PR, #64)
- **markgate state on main as of `6b1133d`**: `check`, `docs`,
  `verify-pr`, `integ-destroy` all fresh.
- **`/run-integ basic`**: clean run done — established baseline
  `integ-destroy` marker before PR #56 merged.

---

## 3. The 7 outstanding PRs

Read-once table; per-PR detail follows.

| Order | PR | Title | Impact | integ-destroy scope? | Stacked? |
|---|---|---|---|---|---|
| 1 | #57 | State key region prefix | **HIGH** | YES | no |
| 2 | #61 | DELETE region verification | **HIGH** | YES | no |
| 3 | #60 | Dynamic region resolution + UnknownError | MEDIUM | no | no |
| 4 | #62 | Default bucket name (region-free) | MEDIUM | no | YES — on #60 |
| 5 | #63 | `--region` flag cleanup | LOW | no | YES — on #60 |
| 6 | #58 | `cdkd state destroy` | MEDIUM | YES | no |
| 7 | #59 | Hide bucket banner + `state info` | LOW | no | no |

`integ-destroy scope: YES` = PR touches files in
`.markgate.yml`'s `integ-destroy.include` set
(`src/provisioning/providers/**`, `src/cli/commands/destroy.ts`,
`src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`,
`src/analyzer/implicit-delete-deps.ts`,
`src/analyzer/lambda-vpc-deps.ts`). These PRs require a fresh
`/run-integ <test>` before `gh pr merge` is allowed.

---

## 4. Per-PR briefing

Each PR's section: **what / why / impact / review focus / author
notes**.

### 4.1 PR #57 — Region-prefixed state key

- **Branch**: `feat/state-region-key`
- **What**: Changes the S3 state key from `cdkd/{stack}/state.json`
  to `cdkd/{stack}/{region}/state.json` (and the parallel lock key).
  Bumps `state.json.version` from 1 to 2. Legacy keys remain
  readable; the next write auto-migrates and removes the legacy key.
  An older cdkd binary fails clearly on `version: 2` instead of
  silently mishandling.
- **Why**: This is the **root-cause fix** for the silent state
  corruption in §1.1. With per-region keys, an `env.region` change
  creates a new key instead of overwriting; the old region's state
  (and the resources it tracks) survives.
- **Impact**: **HIGH**. Touches the core state backend, every
  command that reads/writes state, and the lock layer. ~37 files,
  including `src/state/`, `src/cli/commands/{deploy,destroy,diff,
  force-unlock,state}.ts`, `src/deployment/deploy-engine.ts`,
  `src/deployment/intrinsic-function-resolver.ts`.
- **Review focus**:
  - **Migration write path** is the highest-risk slice. Read
    `s3-state-backend.ts` `tryGetLegacy` + `saveState`'s
    `migrateLegacy` flag end-to-end. The legacy region gate (refuses
    to return a legacy state whose embedded region differs from the
    requested region) is the actual silent-failure prevention.
  - **Multi-region same-name semantics** (`cdkd state list` shows
    one row per `(stackName, region)`; `state show / resources / rm`
    accept `--stack-region` for disambiguation; `cdkd destroy`
    chooses the right region from synth + state intersection).
  - **Lock key change**: every locker / unlocker should be
    consistent with the new path. `force-unlock` walks all regions
    found in `listStacks` for the named stack.
  - **`Fn::ImportValue`** uses each state ref's region directly with
    a fallback for legacy.
- **Author design notes**:
  - The state CLI flag is `--stack-region`, not `--region`, to avoid
    collision with the (deprecated) global `--region`.
  - `LEGACY_KEY_DEPTH = 2` / `NEW_KEY_DEPTH = 3` constants drive
    layout discrimination in `listStacks`.
  - Pre-existing `stacks/` doc drift (referencing the old layout) in
    `docs/state-management.md:656+` and
    `docs/troubleshooting.md` was NOT cleaned up by this PR; flagged
    for follow-up.
  - Integration tests `tests/integration/legacy-state-migration/`
    and `tests/integration/multi-region-same-stack/` are scaffolded
    but the authoring agent did not run them against real AWS. Run
    at least one as part of `/run-integ` for this PR.

### 4.2 PR #61 — DELETE region verification

- **Branch**: `feat/delete-region-check`
- **What**: Adds `context: { expectedRegion?: string }` to
  `ResourceProvider.delete`. Before any provider treats a
  `*NotFound` error as idempotent delete success, it now asserts
  the AWS client's region matches `state.region`. Mismatch throws
  `ProvisioningError`. Applied to all 51 SDK providers + the
  Cloud Control fallback.
- **Why**: Defense-in-depth for §1.1. Even if the state somehow ends
  up with a region mismatch (PR #57 prevents this on env.region
  change, but other paths could conceivably lead there), DELETE
  cannot silently succeed when it's pointed at the wrong region.
- **Impact**: **HIGH**. Touches every SDK provider's delete code
  path. New shared helper `src/provisioning/region-check.ts`.
- **Review focus**:
  - **Region check in every provider's `delete`**: 51 providers is
    a lot of surface; a single skipped provider would re-open the
    silent-failure hole.
  - **`custom-resource-provider`** intentionally does NOT call
    `assertRegionMatch`. Verify the reasoning: the underlying
    Lambda invocation does not surface a managed-resource
    `*NotFound` to act on; the Lambda's region is encoded in the
    ServiceToken ARN regardless of cdkd's client region.
  - **`iam-policy-provider`** uses an `onNotFound` closure across
    4 per-target loops. Read once to confirm structure preserved.
  - **TypeScript signature**:
    `expectedRegion?: string | undefined` (not just `?:`) — the
    callers (DeployEngine / destroy.ts) pass `state.region` which
    is already `string | undefined`, and
    `exactOptionalPropertyTypes: true` rejects `?:` here.
  - **Mock test setup**: 18 existing provider tests had to add
    `config.region` to their mock S3 clients; verify none was
    missed.
- **Author design notes**:
  - 6 new region-check unit tests + 4 CC-provider tests + 3 Lambda
    region-mismatch cases. Full suite 781/781 passing.
  - Real-AWS reproduction of the original silent-failure was
    skipped (impractical without two regions and live resources);
    unit-level coverage hits the same code path.

### 4.3 PR #60 — Dynamic region resolution + UnknownError normalization

- **Branch**: `feat/dynamic-region-resolution`
- **What**: New `src/utils/aws-region-resolver.ts::resolveBucketRegion()`
  uses `GetBucketLocation` (GET, has body — bypasses the empty-body
  HEAD glitch). `S3StateBackend` rebuilds its S3 client to the
  resolved region before any operation. New
  `normalizeAwsError(err, ctx)` in `src/utils/error-handler.ts`
  rewrites `Unknown` / `UnknownError` based on
  `$metadata.httpStatusCode` (301/403/404/other).
- **Why**: §1.2. Profile region ≠ bucket region currently produces a
  useless `UnknownError`; users have to figure out it's a region
  mismatch. After this PR, cdkd handles it transparently.
- **Impact**: **MEDIUM**. Localized to state-bucket plumbing.
  Provisioning clients are intentionally untouched.
- **Review focus**:
  - **Single-flight cache correctness**: the cache stores
    `Promise<string>`, not `string`, so concurrent callers for the
    same bucket collapse to one API call. This matters under
    parallel deploy.
  - **Error normalization mapping completeness**: all 4 status code
    branches (301/403/404/other) covered with actionable text.
  - **State backend client rebuild idempotency**: `ensureClientForBucket()`
    must be safe to call on every public method.
  - **Layered architecture invariant**: new `S3ClientOptions`
    interface inside `s3-state-backend.ts` (not reusing
    `AwsClientConfig`) to avoid a state→cli-utils dependency.
  - **Public exports**: `resolveBucketRegion` and `normalizeAwsError`
    are added to `src/index.ts` — confirm intentional.
- **Author design notes**:
  - `resolveBucketRegion` deliberately never throws — returns
    `fallbackRegion` (or `us-east-1`) on any error, so the
    actionable downstream `normalizeAwsError` message wins instead
    of being masked by a noisy GetBucketLocation failure.
  - Live-tested cross-region `state list` (real us-west-2 bucket
    from us-east-1 client). Cross-region E2E deploy/destroy not
    run.

### 4.4 PR #62 — Default bucket name without region (stacked on #60)

- **Branch**: `feat/state-bucket-naming`
- **Base**: `feat/dynamic-region-resolution` (will auto-retarget to
  `main` when #60 merges).
- **What**: Default state bucket name becomes
  `cdkd-state-{accountId}` (no region). Lookup chain: explicit value
  → probe new name → on 404 fall back to legacy
  `cdkd-state-{accountId}-{region}` with a deprecation warning →
  throw "run cdkd bootstrap" if neither. `bootstrap` creates the new
  shape by default.
- **Why**: §1.3. Two teammates with different profile regions now
  look up the same bucket name and share state without coordination.
- **Impact**: **MEDIUM**. Changes the bucket-name default; legacy
  users keep working via the fallback (auto-detected, with a
  warning).
- **Review focus**:
  - **Lookup chain order**: explicit beats env beats cdk.json beats
    default (new) beats legacy.
  - **301 / 403 in the probe**: treated as "exists" (plan was
    silent here). 301 = bucket in another region; 403 = no
    `s3:ListBucket`. Treating both as "exists" prevents the legacy
    fallback from masking a real cross-region or permissions
    error.
  - **`// TODO(remove-bc-after-1.x):` markers** at every legacy
    branch — these are removed in PR 99 (a future minor release).
  - **`scripts/verify-bc.sh PR-4`** operates on source text, not
    `dist/` (cdkd bundles into a single file); confirm this is OK
    for the intended use.
- **Author design notes**:
  - 9 new lookup-chain unit tests; integration test
    `tests/integration/legacy-bucket-name-fallback/` scaffolded
    but not executed end-to-end.
  - Plan files (`docs/plans/04-state-bucket-naming.md`,
    `README.md`) shipped in this PR — duplicate of PR #56's
    content. Will harmonize on merge (no conflict; same content).

### 4.5 PR #63 — `--region` flag cleanup (stacked on #60)

- **Branch**: `feat/region-flag-cleanup`
- **Base**: `feat/dynamic-region-resolution` (will auto-retarget to
  `main` when #60 merges).
- **What**: `--region` removed from `commonOptions`. Bootstrap
  re-adds it explicitly. Other commands keep the flag parseable
  (so existing scripts don't break) but emit a deprecation warning
  to stderr and ignore the value.
- **Why**: After PRs 3 + 4, `--region` has no useful role outside
  bootstrap. Keeping it overloaded encourages users to specify the
  wrong thing.
- **Impact**: **LOW** (deprecation only — no behavior break).
- **Review focus**:
  - **Existing scripts that pass `--region` still work** (just
    warn). Confirm the warning is informational, not a hard error.
  - **`bootstrap` retains `--region`** with reworded `--help`
    description (creating a new bucket needs to know where).
  - **`Option.hideHelp()`** on the deprecated flag keeps it
    parseable but invisible in `--help` — cleanest deprecation UX.
- **Author design notes**:
  - `warnIfDeprecatedRegion` invoked from `setupStateBackend()`
    so all four `state` subcommands inherit the warning from a
    single call site.
  - `vi.spyOn(process.stderr, 'write')` did not reliably intercept
    in vitest; tests use direct `process.stderr.write` replacement.
    The agent saved a memory file
    (`~/.claude/projects/.../memory/vitest_stderr_capture.md`) —
    verify and either keep or remove.

### 4.6 PR #58 — `cdkd state destroy`

- **Branch**: `feat/state-destroy-command`
- **What**: New subcommand `cdkd state destroy <stack>...` that
  destroys a stack's AWS resources and removes its state record
  **without requiring the CDK app**. Reads state from S3, deletes
  resources in reverse dependency order using the same provider
  registry as `cdkd destroy`. Confirmation prompt by default;
  `--yes` / `-y` to skip; `--all` to wipe the bucket.
- **Why**: Cleanup gap. `cdkd destroy` requires synth (so requires
  the CDK app sources). `cdkd state rm` only forgets the state
  record without deleting AWS resources. The new command does the
  full destroy from any directory given access to the state bucket.
- **Impact**: **MEDIUM**. New command + a refactor that hoists
  per-stack destroy lifecycle into `src/cli/commands/destroy-runner.ts`.
- **Review focus**:
  - **`destroy-runner.ts` extraction**: `cdkd destroy` and
    `cdkd state destroy` both call `runDestroyForStack`. The
    existing `cdkd destroy` behavior must remain byte-equivalent
    (same emoji log markers, same flow).
  - **Help text** clearly contrasts with `cdkd state rm`:
    > For removing only the state record (keeping AWS resources
    > intact), use 'cdkd state rm'.
  - **Strict missing-stack handling**: `cdkd state destroy MyTypo
    --yes` errors with "No state found for stack(s)..." instead of
    silently skipping. For a destructive command without synth as
    a typo-catcher, this is intentional — confirm.
  - **`--all` confirmation**: single batch prompt up-front (no
    per-stack prompts). With `--yes`, both are skipped.
- **Author design notes**:
  - `runDestroyForStack` takes a pre-loaded `StackState` (caller
    does `getState`/`listStacks`); enables the `--region` filter.
  - Existing emoji markers preserved in the runner (rule of
    "behavior preservation in a refactor wins" over the global
    "no emojis" rule).
  - Integration test `tests/integration/state-destroy/` scaffolded
    but not run end-to-end.

### 4.7 PR #59 — Hide state bucket banner + `cdkd state info`

- **Branch**: `feat/state-info-and-hide-bucket`
- **What**: Demotes the
  `State bucket: cdkd-state-{accountId}-{region}` banner from
  `logger.info` to `logger.debug` across every command (deploy,
  destroy, diff, force-unlock, all `state` subcommands). Adds a
  new `cdkd state info` subcommand that explicitly prints bucket
  info on demand: name, auto-detected region (via
  `GetBucketLocation`), source label
  (`cli-flag` / `env` / `cdk.json` / `default`), schema version,
  stack count.
- **Why**: Account ID screenshot leak prevention. The banner used
  to expose the AWS account ID in every command's first line of
  output, which is a recurring leak vector for blog posts / Slack
  / CI logs.
- **Impact**: **LOW**. Cosmetic + new subcommand. No behavior
  change.
- **Review focus**:
  - **Banner demotion is everywhere**: confirm no command was
    missed (deploy/destroy/diff/state list/show/resources/rm/
    force-unlock + `state destroy` if PR #58 merges first).
  - **`state info` source detection accuracy**: distinguishes
    cli-flag vs env vs cdk.json vs default.
  - **Stack count** handles **both** legacy
    (`<prefix>/<stack>/state.json`) AND new
    (`<prefix>/<stack>/<region>/state.json`) layouts so it works
    regardless of whether PR #57 has merged yet.
- **Author design notes**:
  - Added new `resolveStateBucketWithSource` and
    `resolveStateBucketWithDefaultAndSource` siblings; original
    resolver signatures untouched (drop-in compatible for
    existing 7 call sites).
  - `default-legacy` source label deferred — applies after PR #62
    lands; out of scope here.
  - Not in `integ-destroy` scope.

---

## 5. Five things to keep in mind (top callouts)

1. **PR #57 and #61 fix a real silent-failure bug.** CI passing is
   necessary but not sufficient. The `/verify-pr` live-test step
   should exercise an actual destroy on a real bucket; `/run-integ`
   should be a non-trivial test (not just `basic`) for these two.
   The bug they fix is exactly the kind that hides until production.

2. **Stacked PRs (#62, #63) need attention after #60 merges.**
   GitHub will auto-retarget their base from
   `feat/dynamic-region-resolution` to `main`, but a local rebase
   may still be cleaner before final merge. Check `git diff
   origin/main...HEAD` after #60 merges and rebase if the diff
   shows unrelated content from #60.

3. **Backwards-compat code is intentionally kept.** Both PR #57
   (legacy state key fallback) and PR #62 (legacy bucket name
   fallback) ship `// TODO(remove-bc-after-1.x):` markers. These
   are removed in PR 99 (a future minor release) plus a final
   `cdkd state migrate` command. **Do not preempt** — the BC
   path is what makes the rollout transparent for existing users.

4. **PR #64 (this PR) merges normally; final cleanup PR removes
   HANDOFF.md.** Don't close #64 unmerged. The handoff is
   referenced from `main` during the rollout window so it's
   discoverable across terminals / fresh sessions.

5. **Don't try to merge multiple PRs in parallel.** The markgate
   gates serialize anyway, and stacked PRs need #60 done first.
   Sequential is the supported path.

---

## 6. Per-PR merge recipe

For each PR in the order from §3, run this:

```bash
# 1. Pull latest main
git switch main
git pull --ff-only

# 2. Switch to the PR branch (or check out fresh)
gh pr checkout <PR-number>

# 3. Rebase if main moved since PR was opened
#    (especially #62/#63 after #60 merges)
git rebase origin/main      # or origin/feat/dynamic-region-resolution
                            # for stacked PRs while #60 is open
git push --force-with-lease # if rebase happened

# 4. Run /verify-pr — full PR readiness checklist
#    Sets `check`, `docs`, and (on completion) `verify-pr` markers.
#    The live-test step must exercise the PR's actual user-visible
#    behavior — not just unit tests.

# 5. integ-destroy-scope PRs only (#57, #61, #58):
/run-integ <test>           # `basic` is the floor; `lambda` or
                            # `bench-cdk-sample` for the silent-
                            # failure-fix PRs (#57, #61)
                            # Sets `integ-destroy` marker on
                            # 0-error / 0-orphan completion.

# 6. Confirm all 4 markers fresh
mise exec -- markgate verify check
mise exec -- markgate verify docs
mise exec -- markgate verify verify-pr
mise exec -- markgate verify integ-destroy
# (markgate is at /Users/goto/.local/share/mise/installs/go/.../bin/markgate
#  if `mise exec` runs into snapshot issues.)

# 7. Merge
gh pr merge <PR-number> --squash --delete-branch

# 8. Pull merged main locally and run a regression sweep
git switch main
git pull --ff-only
pnpm run build && pnpm run typecheck && pnpm run lint && \
  npx vitest --run
```

---

## 7. Operating-rule reminders (from CLAUDE.md and the rollout owner)

These bite if forgotten:

### From CLAUDE.md (repo-wide)

1. **No commits/pushes to `main`.** `branch-gate.sh` blocks it.
2. **`git commit -F <file>` for messages.** Heredoc style
   (`-m "$(cat <<'EOF' ... EOF)"`) is blocked by hook — outer-shell
   quote tracking miscounts.
3. **`gh pr edit --title` / `--body` is broken** (silent failure on
   GraphQL Projects-classic deprecation). Use:
   ```bash
   gh api -X PATCH repos/<owner>/<repo>/pulls/<N> \
     -f title="..." -F body=@<file>
   ```
4. **Don't bypass markgate.** `/run-integ` is the only legit setter
   of `integ-destroy`. Setting markers manually defeats the gate.
5. **Committed files are English-only** (this is OSS).
6. **Tests passing ≠ feature working.** The `/verify-pr` live-test
   step is non-negotiable for user-visible changes.

### From the rollout owner (specific to this work)

7. **If you spawn a subagent, it MUST use Opus 4.7.** Pass
   `model: "opus"` on every `Agent` tool invocation. Never silently
   fall back to Sonnet / Haiku — the rollout owner explicitly
   requires Opus 4.7 quality on this work.
8. **Parallelizable tasks run in `git worktree`s.** Use Agent's
   `isolation: "worktree"` for subagents, or `git worktree add` for
   manual parallel work. **However**, the merge phase itself is
   inherently sequential (markgate gates serialize, stacked PRs
   need their base merged first) — see §5 callout 5. Worktree
   parallelism applies to any post-merge implementation work
   (cleanup PR, fixes, etc.) that may come up.
9. **Open PRs but don't merge without confirming.** The rollout
   owner reviews each PR before merge. Default to `gh pr create`
   only; let the owner decide on `gh pr merge`. Exception: this
   document was written under explicit instruction "1個ずつマージ
   していこう" — proceeding with merges is sanctioned for this
   rollout.

---

## 8. Worktree cleanup

The agents that authored these PRs left locked worktrees under
`.claude/worktrees/agent-*`. Safe cleanup:

```bash
for wt in $(ls .claude/worktrees/ 2>/dev/null | grep ^agent-); do
  git worktree unlock .claude/worktrees/$wt 2>/dev/null || true
  git worktree remove --force .claude/worktrees/$wt 2>/dev/null || true
done
git worktree prune
```

Run anytime — before, between, or after merges.

---

## 9. Final cleanup PR (after all 7 merges)

Open one small PR that:

- **Deletes `docs/plans/HANDOFF.md`** (this file).
- **Optional**: cleans up the pre-existing `stacks/` references in
  `docs/state-management.md` and `docs/troubleshooting.md` flagged
  by the PR #57 agent. Keeps as a separate concern if preferred.
- **Optional**: closes the GitHub issue tracking PR 99 if one was
  opened.

This signals the rollout is complete.

---

## 10. Subagent invocation hint

If picking this up via the `Agent` tool inside the same Claude
session, use:

- `subagent_type: general-purpose`
- `model: opus` (Opus 4.7 — the user's preference for this work)
- `isolation: worktree` (auto-managed)

Prompt template (one self-contained string):

```
Read /Users/goto/github/cdkd/docs/plans/HANDOFF.md fully before doing
anything. It contains the rollout's why, the per-PR briefs, the
merge recipe, and the rules. Then merge the 7 outstanding PRs in
the order listed in §3, following the per-PR recipe in §6 verbatim.

For PRs in `integ-destroy` scope (#57, #61, #58), run /run-integ
with a non-trivial test (`lambda` or `bench-cdk-sample` for the
silent-failure-fix PRs).

After each merge, run the regression sweep
(`pnpm run build && pnpm run typecheck && pnpm run lint &&
npx vitest --run`) on the post-merge `main` and stop if anything
breaks.

Do NOT bypass markgate gates. Do NOT push to main directly. Do
NOT merge multiple PRs in parallel.

When all 7 are merged, open the final cleanup PR (§9) deleting
`docs/plans/HANDOFF.md`. Report the URLs of the 7 squashed merge
commits and the cleanup PR.
```

If a fresh chat session is picking this up instead of an Agent
subagent, the same prompt works — the human just runs it as their
first message.
