# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**cdkd** (CDK Direct) is an experimental project that deploys AWS CDK applications directly via AWS SDK/Cloud Control API without going through CloudFormation. It aims to eliminate CloudFormation overhead and achieve faster deployments.

**Important Notes**:

- For dev/test workflows only — early in development, not yet production-ready
- Complements the AWS CDK CLI rather than replacing it (use CDK CLI in production for full CloudFormation tooling)
- Bidirectional CloudFormation migration via `cdkd import --migrate-from-cloudformation` / `cdkd export`

## Architecture

cdkd has a 7-layer system architecture: **CLI → Synthesis → Assets → Analysis → State + Deployment → Provisioning**. Key architectural decisions: hybrid SDK Providers + Cloud Control API fallback, S3-based state with optimistic locking (no DynamoDB), event-driven DAG execution (no level barriers), full CloudFormation intrinsic function resolution. The full diagram and design rationale (including the `Fn::GetStackOutput` cross-region / `RoleArn` cross-account semantics) live in [.claude/rules/architecture.md](.claude/rules/architecture.md), auto-loaded when working on `src/`.

The directory-by-directory walk and per-file purpose notes live in [.claude/rules/code-layout.md](.claude/rules/code-layout.md).

## Build and Test Commands

```bash
# Build (using Vite+ / tsdown)
vp run build

# Watch mode (for development)
vp run dev

# Test (using Vitest)
vp run test
vp test --ui             # UI mode
vp run test:coverage     # Coverage

# Lint/Format
vp run lint
vp run lint:fix
vp run format
vp run format:check

# Type check
vp run typecheck
```

## State Schema

State files live at `s3://bucket/cdkd/{stackName}/{region}/state.json` (v2+ region-prefixed key layout, current schema is v8). Nested-stack children land at `s3://bucket/cdkd/{parent}~{NestedStackLogicalId}/{region}/state.json` — written by `NestedStackProvider.create` during `cdkd deploy` (issue [#459](https://github.com/go-to-k/cdkd/issues/459), shipped in PR #548) AND by the recursive `cdkd import --migrate-from-cloudformation` walk (issue [#464](https://github.com/go-to-k/cdkd/issues/464), this PR) — both populate `parentStack` / `parentLogicalId` / `parentRegion` on the child state record per the v6 schema.

```typescript
interface StackState {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  stackName: string;
  region?: string;
  resources: Record<string, ResourceState>;
  outputs: Record<string, string>;
  imports?: StateImportEntry[];
  outputReads?: StateOutputReadEntry[]; // v8+: Fn::GetStackOutput refs (informational, NOT destroy-blocking)
  parentStack?: string;        // v6+: populated on nested-stack child state records (undefined on top-level stacks)
  parentLogicalId?: string;    // v6+: the AWS::CloudFormation::Stack logical id in the parent's template
  parentRegion?: string;       // v6+: parent's region (always equals `region` until cross-region nested stacks ship)
  lastModified: number;
}

interface ResourceState {
  physicalId: string;
  resourceType: string;
  properties: Record<string, any>;
  observedProperties?: Record<string, any>;
  attributes: Record<string, any>;
  dependencies: string[];
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate';
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate';
  provisionedBy?: 'sdk' | 'cc-api'; // v7+: routing layer (absent = SDK legacy default)
}
```

Full per-field semantics (v1-v8 migration story, `observedProperties` / `deletionPolicy` / `parentStack` / `provisionedBy` / `outputReads` notes) in [.claude/rules/state-schema.md](.claude/rules/state-schema.md). End-user docs in [docs/state-management.md](docs/state-management.md).

## Provider Pattern

```typescript
interface ResourceProvider {
  create(logicalId: string, resourceType: string, properties: Record<string, unknown>): Promise<ResourceCreateResult>;
  update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>): Promise<ResourceUpdateResult>;
  delete(logicalId: string, physicalId: string, resourceType: string, properties?: Record<string, unknown>, context?: DeleteContext): Promise<void>;
  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}
```

Register Provider for each resource type in Provider Registry:

```typescript
const registry = ProviderRegistry.getInstance();
registry.register('AWS::IAM::Role', new IAMRoleProvider());
```

Custom Resources handling, region-check helper, and the "Adding a New SDK Provider" steps live in [.claude/rules/providers.md](.claude/rules/providers.md). See [docs/provider-development.md](docs/provider-development.md) for the full provider implementation guide.

## Important Implementation Details

- **ESM Modules**: `package.json` specifies `"type": "module"`. All imports must include `.js` extension (even in TypeScript):

  ```typescript
  import { foo } from './bar.js';  // ✅ Correct
  import { foo } from './bar';     // ❌ Wrong
  ```

- **Build System (Vite+)**: New dev / build tasks (lint, format, audit scripts, codegen, etc.) are registered as Vite+ tasks in `vite.config.ts` and invoked via `vp run <task>`. This is the project convention — prefer it over `package.json` `"scripts"` entries or ad-hoc `node` invocations. `vp pack` builds the ESM package through tsdown with a Node 20 runtime target. The global `vp` CLI is pinned by `.mise.toml`; project Node.js is managed by Vite+ from `.node-version`.

- **CLI Configuration Resolution** (option precedence, stack-name matching, concurrency / timeout flags): see [.claude/rules/cli-internals.md](.claude/rules/cli-internals.md).
- **Synthesis** (CDK app subprocess execution, Cloud Assembly parsing, context providers): see [.claude/rules/synthesis.md](.claude/rules/synthesis.md).
- **Asset Publishing** (S3 file upload with ZIP, ECR Docker image build & push): see [.claude/rules/assets.md](.claude/rules/assets.md).
- **Intrinsic Function Resolution + Dependency Analysis** (DAG building, implicit edges, CDK-defensive DependsOn relaxation): see [.claude/rules/analyzer.md](.claude/rules/analyzer.md).

## Testing

Unit tests under `tests/unit/**` (Vitest, AWS SDK mocked via `vi.mock()`). Integration tests under `tests/integration/**` (real AWS account, `us-east-1`). UPDATE testing via `CDKD_TEST_UPDATE=true` and rollback failure injection via `CDKD_TEST_FAIL=true`. Full guide in [.claude/rules/testing.md](.claude/rules/testing.md) and [docs/testing.md](docs/testing.md).

## Debugging Deploy Flow

1. Use `--verbose` flag
2. Check log level (`src/utils/logger.ts`)
3. Check State file: `aws s3 cp s3://bucket/cdkd/{stackName}/{region}/state.json -`
4. See [docs/troubleshooting.md](docs/troubleshooting.md)

## Detailed Documentation

**Always refer to these documents**:

- **[docs/architecture.md](docs/architecture.md)** - Detailed architecture, deploy flows, design principles, end-to-end pipeline walkthrough
- **[docs/state-management.md](docs/state-management.md)** - S3 state structure, locking mechanism, troubleshooting
- **[docs/cli-reference.md](docs/cli-reference.md)** - CLI flag details (concurrency, --no-wait, per-resource timeout)
- **[docs/supported-resources.md](docs/supported-resources.md)** - Full per-type SDK Provider / Cloud Control coverage table
- **[docs/import.md](docs/import.md)** - `cdkd import` full guide (modes, flags, CFn migration, provider coverage)
- **[docs/provider-development.md](docs/provider-development.md)** - Provider implementation guide, best practices
- **[docs/troubleshooting.md](docs/troubleshooting.md)** - Common issues and solutions
- **[docs/testing.md](docs/testing.md)** - Testing guide, integration test examples
- **[docs/cross-stack-references.md](docs/cross-stack-references.md)** - `Fn::ImportValue` strong reference design, exports index architecture, schema v4 migration
- **[docs/deployment-events.md](docs/deployment-events.md)** - Structured deployment events (`cdkd events`) — CloudFormation `DescribeStackEvents` equivalent, event types, S3 `deployments/` key layout (separate from state.json, no schema bump), best-effort flush, `index.json` semantics (issue #808)

## Known Limitations

- Not yet production-ready — use the AWS CDK CLI for production workloads (see "Important Notes" above)

**Recently Implemented**: per-PR shipped-feature notes moved to
[docs/changelog-cdkd.md](docs/changelog-cdkd.md). Past entries are preserved
there; new entries should go to that file (not back into this CLAUDE.md). The
split is per the official Claude Code memory guidance that a CLAUDE.md should
stay around 200 lines so context-window usage and instruction adherence stay
high.

## Dependencies

### Key Dependencies

- `@aws-sdk/client-*` - AWS SDK v3 (various services)
- `cdk-local` - Local-emulation engine (`--from-cfn-stack` dispatcher + state-source plumbing). cdkd's `src/cli/commands/local-state-source.ts` is a shim that injects the S3-backed `--from-state` factory via `cdk-local`'s `extraStateProviders` hook.
- `graphlib` - DAG construction
- `archiver` - ZIP packaging for file assets
- `chokidar` - File watcher backing `cdkd local start-api --watch` (PR 8c)
- `yaml` - CFn-aware YAML codec for `cdkd export` / `cdkd import --migrate-from-cloudformation` (preserves `!Ref` / `!GetAtt` / `!Sub` shorthand intrinsics on round-trip — see [src/cli/yaml-cfn.ts](src/cli/yaml-cfn.ts))

### Dev Dependencies

- `esbuild` - Build tool
- `vitest` - Testing framework
- `eslint` - Linting
- `prettier` - Formatting
- `typescript` - Type checking

## Node.js Version

- **`package.json` engines**: Node.js >= 20.0.0 (the lower bound users of cdkd must meet).
- **Local dev / CI Node version**: 24.15.0, pinned by `.node-version` (managed by Vite+ / mise).
- **`vp pack` build target**: Node 20 (the runtime cdkd ships to users).
- **TypeScript type stripping**: Node 24 strips type annotations by default, so `node scripts/foo.ts` runs `.ts` files directly — no `tsx` / `ts-node` dev dependency needed. Use this for ad-hoc scripts under `scripts/`; prefer registering longer-lived scripts as Vite+ tasks in `vite.config.ts` (see "Build System" above).

## Workflow Rules

- **When adding new functionality or fixing bugs**: Always add corresponding unit tests. Do not wait to be asked.
- **After modifying source code**: Always run `vp run build` before telling the user to test. The user runs cdkd via `node dist/cli.js`, so source changes without a build have no effect.
- **Self-review before commit (4 axes)**: Once the implementation feels complete, walk these four axes BEFORE running `/check` and committing — the markgate hook checks that tests pass, not that the work is *good*:
  1. **Implementation gaps** — anything in the agreed scope still missing? (e.g. updated `deploy.ts` but forgot the parallel change in `destroy.ts` / `diff.ts`; tests not added; docs not updated)
  2. **Oddities** — anything in the diff strange or inconsistent? (dead code, leftover names from the old shape, error messages that no longer make sense, half-applied refactors)
  3. **Polish opportunities** — small in-scope improvements you noticed and dismissed as "out of scope"? Default to including them in the same PR if they touch the same files and carry no behavior-break risk; defer only when they belong to a genuinely different concern.
  4. **Regression risk** — full test suite run (not just the new tests)? Any renamed/removed exports that other call-sites might depend on? Any behavior change a reviewer might miss in the diff?

  Surface findings out loud (in chat or todos) and fix them before invoking `/check`. The cost of one more pass is small compared to a follow-up PR or a missed regression.
- **Before every commit**: Two markgate gates guard `git commit` via `.claude/hooks/check-gate.sh`. Both must be fresh:
  - `check` — recorded by `/check` (typecheck, lint, build, tests). Scope: `src/**`, `tests/**`, build/test configs (see `.markgate.yml`). Only invalidated by changes in that scope.
  - `docs` — recorded by `/check-docs` (README.md / CLAUDE.md / docs/ / .claude/rules/ consistency with src). Scope: `src/**`, `docs/**`, `README.md`, `CLAUDE.md`, `.claude/rules/**`. Only invalidated by changes in that scope.

  **Run the required skills proactively** before attempting the commit — look at `git status` / `git diff --cached --name-only` and match it against each gate's scope: a tests-only commit only needs `/check`; a docs-only commit only needs `/check-docs` (which now also includes `.claude/rules/**`); a src edit needs both; changes that fall outside both scopes (e.g. `.claude/hooks/**`, `.claude/skills/**`, `.markgate.yml`) need neither. The hook is a safety net, not the primary trigger — if you see "Blocked by check-gate", the message names exactly which skill to re-run, but getting there means you skipped the proactive step. `/verify-pr` refreshes both markers in one shot. Install `vp` and markgate via `mise install` at the repo root (see CONTRIBUTING.md).
- **Before opening or merging any PR**: A third markgate gate, `verify-pr`, guards `gh pr create` and `gh pr merge` via `.claude/hooks/verify-pr-gate.sh`. Declared as `requires: [check, docs]` in `.markgate.yml` (markgate 0.3+ feature) so the gate is fresh **only when both children are fresh AND `/verify-pr` itself has set the parent marker** — `requires` is strict, set-time refusal of the parent when either child is stale, mirroring the skill's own workflow which runs `/check` + `/check-docs` first. Pre-0.3 the scope was a hand-duplicated `include` glob union of `check` + `docs`; the AND-of-children mechanism is the same in spirit but harder to drift from. The skill walks the full checklist — typecheck/lint/build/tests, CI status, working tree, docs consistency, leftover AWS resources, code review (incl. shared-utility caller verification), **live-test of the changed behavior against real or fixture input**, **session retrospective + proposals for new rules / hooks / skills**, and PR title + body freshness vs the diff. So opening or merging a PR whose live behavior was never exercised, or whose retrospective produced no rule proposals for surprises in the session, is **physically blocked** — the hook refuses `gh pr create` / `gh pr merge` until `/verify-pr` is re-run end-to-end. This is the structural enforcement of the "tests passing is not the same as the feature working" + "every recurring surprise should leave a rule behind" lessons.

- **Before merging any PR that touches deletion logic**: A fourth markgate gate, `integ-destroy`, guards `gh pr merge` via `.claude/hooks/integ-destroy-gate.sh`. Scope: `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`, `src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/implicit-delete-deps.ts`, `src/analyzer/lambda-vpc-deps.ts`, plus a **14-day wall-clock TTL** (markgate 0.3+ `ttl` field) — real-AWS behavior drifts even when the repo doesn't (AWS SDK updates, API behavior changes, eventual-consistency tweaks), so a marker that's been clean for two weeks no longer proves the destroy path actually works against today's AWS. Only `/run-integ` sets it (resetting the TTL countdown), and only when the destroy step finished with 0 errors AND the post-destroy AWS state was empty. So a PR whose destroy path has not been verified against real AWS recently is **physically unmergeable** — the hook blocks `gh pr merge` until you run `/run-integ <test>` and it succeeds end-to-end. This is the structural enforcement of the "never merge a PR whose destroy path is unverified" rule below.

- **Before merging any PR that touches cross-cutting deploy/destroy code**: A markgate gate, `integ-broad`, guards `gh pr merge` via `.claude/hooks/integ-broad-gate.sh`. Scope (regex in the hook + duplicated in `.claude/skills/verify-pr/SKILL.md` step 6): `src/deployment/deploy-engine.ts`, `src/deployment/intrinsic-function-resolver.ts`, `src/cli/commands/destroy-runner.ts`, `src/cli/commands/destroy.ts`, `src/cli/commands/deploy.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/template-parser.ts`, `src/provisioning/register-providers.ts`. Plus the same **14-day wall-clock TTL** as `integ-destroy` / `integ-local`. Why a separate gate from `integ-destroy`: the existing `integ-destroy` marker accepts ANY clean real-AWS destroy and flips green even on a 2-stack feature integ (e.g. `import-value-strong-ref`'s S3+SSM fixture). But cross-cutting code changes affect multi-resource VPC / Lambda / Custom-Resource paths a narrow integ never exercises — PR #348 (Issue #343, 2026-05-13) shipped that way and surfaced post-merge as an incident. The `integ-broad` marker is bound to a sentinel file `.markgate-broad-integ-test` that `/run-integ` updates ONLY when the test name is in the broad set (`bench-cdk-sample`, `lambda`, `microservices`, `drift-revert`, `drift-revert-vpc`, `multi-stack-deps`, `multi-resource`, `remove-protection`, `export`) AND the run was clean. So a narrow feature integ legitimately flips `integ-destroy` (it WAS a clean destroy) while leaving `integ-broad` stale — exactly the gradient we want. PRs that touch cross-cutting code physically cannot merge without a broad integ in addition to the feature one. The memory rule `feedback_cross_cutting_needs_broad_integ.md` records the full incident and rationale.

- **Before merging any PR that touches local-execution code**: A markgate gate, `integ-local`, guards `gh pr merge` (and `git merge`) via `.claude/hooks/integ-local-gate.sh`. Scope: `src/local/**`, `src/cli/commands/local-*.ts`, `tests/integration/local-*/**`, plus the same **14-day wall-clock TTL** as `integ-destroy` — Docker base-image behavior (`public.ecr.aws/lambda/*`, RIE binary), `dockerd` semantics, and chokidar / network plumbing drift over time, so a marker that's been clean for two weeks no longer proves today's local code path actually works against today's environment. Only `/run-integ` sets it, and only when (a) the integ test name starts with `local-` (e.g. `local-invoke` / `local-start-api` / `local-run-task` / `local-invoke-container` / `local-invoke-from-state` / `local-invoke-layers` / `local-invoke-{python,ruby,java,dotnet,provided}` / `local-start-api-cors`), (b) the test exited cleanly, AND (c) the post-run `docker ps --filter name=cdkd-local-` / `docker network ls --filter name=cdkd-local-task-` sweep is empty. So a PR whose local code path has not been verified against real Docker recently is **physically unmergeable** — the hook blocks `gh pr merge` / `git merge` until you run `/run-integ local-<test>` and it succeeds end-to-end. The two gates are independent: a non-`local-*` integ run (e.g. `lambda`, `bench-cdk-sample`) refreshes `integ-destroy` but NOT `integ-local`, and vice versa; the `local-invoke-from-state` test (which exercises a real AWS deploy + destroy on top of the Docker run) can refresh BOTH.

- **Before merging any PR that bumps the cdkd state schema version**: A markgate gate, `integ-schema-migration`, guards `gh pr merge` via `.claude/hooks/integ-schema-migration-gate.sh`. Scope: `src/types/state.ts` (the file carrying the `StackState.version` literal type + `STATE_SCHEMA_VERSIONS_READABLE` constant). The hook does a precise second-pass `gh pr diff` grep for actual version-constant additions/deletions (`version: 1 | 2 | 3 | 4 | 5` literal type changes OR `STATE_SCHEMA_VERSION = N` constant changes) so non-bump edits to state.ts (JSDoc, helper additions, comment fixes) pass through with no false-positive activation — only a real schema bump triggers enforcement. **14-day wall-clock TTL** same as integ-destroy / integ-broad / integ-local — AWS-side wire-format behavior + binary auto-migration logic drift over time. Only `/run-integ` sets the marker, and only when (a) the integ test name matches `schema-v<N>-to-v<N+1>-migration` (e.g. `schema-v5-to-v6-migration`), (b) the destroy step finished cleanly with 0 errors AND 0 orphan resources. Closes the structural enforcement gap that memory rule `feedback_schema_version_migration_integ_required.md` documents: cdkd's S3 state schema is the actual user contract (millions of state files live under v1..v5 shapes already shipped), so a vN -> vN+1 bump MUST be transparently auto-migrated by the new binary AND verified by a real-AWS integ test that proves the round-trip: deploy under vN -> swap binary -> read works -> next write upgrades to vN+1 silently -> destroy clean. Unit tests cannot catch wire-format divergences (`undefined` field stripping, key ordering, schema version coercion); only real round-trip does. **Transparent auto-migration is an absolute requirement** — users MUST NOT have to do anything for the upgrade to work (no `cdkd state migrate-schema` command, no env flag, no manual JSON edit; the next read of a vN state file by the vN+1 binary auto-upgrades in memory + the next write persists vN+1 silently). Schema bumps that violate transparent auto-migration are NOT shippable. Independent of other integ gates: a `lambda` / `bench-cdk-sample` run refreshes `integ-destroy` + `integ-broad` but NOT `integ-schema-migration`, and a `schema-vN-to-vNplus1-migration` run refreshes `integ-schema-migration` + `integ-destroy` (the migration integ ends with a clean destroy) but NOT `integ-broad` unless the migration fixture itself is broad-set-shaped.

- **Before merging large / security-sensitive PRs**: A sixth markgate gate, `pr-review`, guards `gh pr merge` via `.claude/hooks/pr-review-gate.sh`. The hook re-applies the `/review-pr` skill's size + bias heuristic to the target PR (`gh pr view <N> --json additions,deletions,changedFiles,files,headRefOid,headRefName`): `loc < 300` OR `fc < 5` → `inline` (pass-through), `300 ≤ loc < 1000` AND `5 ≤ fc < 10` → `1-reviewer`, `loc ≥ 1000` OR `fc ≥ 10` → `3-axis`; up-bias triggers (any path under `src/utils/role-arn.ts` / `src/local/cognito-jwt.ts` / `src/local/lambda-authorizer.ts` / `src/local/docker-runner.ts` / `src/local/docker-image-builder.ts` / `src/local/ecr-puller.ts` / `src/provisioning/providers/**`, OR > 1 `fix:`-prefixed commit on the PR branch) move the tier UP one step (clamped at `3-axis`); down-bias triggers (every path under docs/infra OR every path under `tests/`) move it DOWN one step (clamped at `inline`); when both fire, up wins. For PRs whose final tier is `1-reviewer` or `3-axis`, the marker must be fresh AND bound to the PR's current HEAD sha — set ONLY by `/review-pr` after the recommended reviewers complete and every blocker is addressed. The marker is sha-bound via the gitignored `.markgate-pr-review-sha` sentinel file in the gate's `include:` scope: a new push to the PR invalidates the marker naturally (next `/review-pr` run rewrites the sentinel). `inline`-tier PRs always pass through. Only `gh pr merge` is gated; `gh pr create` is intentionally NOT gated (small PRs should be openable freely). Closes the "sub-agent self-review ≠ independent review" gap surfaced by PR #267 / issue #270 (see memory rule `feedback_subagent_review_not_self_review.md` for the full pattern).

- **Other PreToolUse safety hooks**: Twelve additional one-shot hooks block known foot-guns (`commit-msg-heredoc-gate` / `closes-paren-form-gate` / `gh-pr-edit-deprecation-gate` / `provider-docs-gate` / `pr-body-item-number-gate` / `internal-pr-labels-gate` / `cmd-parse-stub-gate` / `commit-prefix-scope-gate` / `pr-title-prefix-scope-gate` / `integ-coverage-matrix-gate` / `non-english-text-gate` / `state-destroy-force-gate`). Each produces an actionable error with the exact replacement command. Full per-hook details (what each blocks and why, with the originating PR for context) live in [.claude/rules/hooks.md](.claude/rules/hooks.md), which also covers `branch-gate.sh` (block commits / pushes on `main` / `master`), `main-tree-branch-gate.sh` (block feature-branch switches in the main worktree — concurrent agents must use `git worktree add` instead), `post-merge-orphan-push-gate.sh` (block re-creating a deleted-after-merge branch as a fresh orphan ref), and `main-tree-edit-gate.sh` (block editing a tracked file — incl. the committed integ ledger — in the main worktree while on `main`/`master`; do feature work, including `/run-integ` ledger writes, in a `.claude/worktrees/<branch>/` worktree instead).
- **Never commit or push directly to `main`**: All changes must land via a feature branch + PR. Feature work must live in its OWN worktree under `.claude/worktrees/<branch>/` — DO NOT branch in the main worktree (`/Users/goto/pc/github/cdkd` itself). The main tree is a shared resource across parallel agents; the `main-tree-branch-gate.sh` hook physically blocks `git switch -c <branch>` / `git switch <feat>` / `git checkout -b <branch>` etc. in the main tree. Correct invocation: `git worktree add .claude/worktrees/<branch> -b <branch> origin/main && cd .claude/worktrees/<branch>`, do the work, then `git worktree remove .claude/worktrees/<branch>` when done. The `branch-gate.sh` hook ALSO blocks `git commit` / `git push` when the target git working tree is on `main` / `master` (defense-in-depth — main-tree-branch-gate prevents the cause, branch-gate catches the symptom). The `post-merge-orphan-push-gate.sh` hook blocks pushing to a branch whose PR has already merged. See [.claude/rules/hooks.md](.claude/rules/hooks.md) for the per-hook details.
- **Before creating or merging a PR**: Run `/verify-pr` (adds CI status, docs consistency, AWS resource cleanup, code review on top of `/check`)
- **Merge PRs with squash only**: This repo allows only squash merges (`mergeCommitAllowed: false`, `rebaseMergeAllowed: false`, `squashMergeAllowed: true`). Always use `gh pr merge <N> --squash --delete-branch`. Do not offer `--merge` / `--rebase` as alternatives to the user. (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed` confirms.)
- **PR review pattern**: 3 read-only review sub-agents are codified at `.claude/agents/pr-{spec,code,test}-reviewer.md`. The orchestrator (parent session) dispatches all three in parallel against a PR's diff and synthesizes the findings before merge. Use them when reviewing a non-trivial implementation PR — the 3 axes (spec compliance / code quality / test adequacy) catch different classes of issues. Each agent has read-only tools (Read / Glob / Grep / Bash) so they can never accidentally edit; their output is a structured report that the parent uses to decide whether to merge or send fixes back to the implementing agent. **Scale the reviewer count to PR size** — running all 3 on every PR is overkill (~25 min total) and the cost exceeds the catch on small changes. Heuristic: **< 300 LOC (or < 5 files)** spot-check inline by the orchestrator with no sub-agent dispatch; **300-1000 LOC** dispatch 1 reviewer (code-quality is the default single pick); **>= 1000 LOC (or >= 10 files)** dispatch all 3 in parallel. Bias upward (more rigor) for security-sensitive surfaces, multi-agent parallel writes, or new patterns future PRs will follow. Bias downward (less rigor) for mechanical refactors, small hook / skill additions, and tightly-scoped bug fixes referenced in the bug report. The thresholds are heuristics, not hard rules; when in doubt, ask "would I be comfortable spot-checking this in 5 minutes?" — if yes, skip the reviewers.
- **When running integration tests**: Use `/run-integ` with the appropriate test name (e.g., `/run-integ lambda`). **Never bypass the skill** by manually invoking `cdkd deploy` / `cdkd destroy` from a shell — the skill encodes the deploy + destroy + orphan-resource verification in a single block, and skipping any step (e.g. relying on a successful deploy without running destroy) has historically caused us to merge changes whose destroy path was broken. `/run-integ` ALSO records every run (pass or fail) into the committed update-type ledger `docs/_generated/integ-last-run.tsv` (last-run timestamp + result + duration per test) — this is mandatory. Use **`/pick-integ`** (reads that ledger + the recent diff) to choose which integs to run before a release / after a batch of merges — it ranks by staleness (>14d = past the integ-gate TTL) + last result + the code areas a change touches.
- **After running integration tests**: Verify no leftover AWS resources remain (`aws s3 ls s3://cdkd-state-{accountId}/cdkd/` should return empty or error; on accounts that haven't migrated yet, the legacy `cdkd-state-{accountId}-{region}` bucket is still in use — check both). **If the destroy step failed or left orphans, you MUST clean them up via direct AWS API calls before doing anything else** (use `/cleanup` if applicable, otherwise `aws ec2 delete-*` etc.) — leaving orphan resources after an integ run is never acceptable, regardless of whether the test passed.
- **Never merge a PR whose destroy path is unverified**: If a change touches deletion logic (any provider's `delete()`, DAG order on destroy, state cleanup, etc.), the integ test must complete the **destroy** step successfully (not just deploy) before the PR is mergeable. A green CI is necessary but not sufficient — CI does not exercise real-AWS destroy.
- **After fixing documentation or code**: Commit to a feature branch (not `main`) and push immediately. Do not leave uncommitted changes. Before reporting completion to the user, always run `git status` to verify nothing is uncommitted and that you are not on `main`.
- **English-only for committed files**: This is an OSS project. All committed files (source code, shell scripts, hook messages, config files such as `.claude/settings.json`, docs, comments, commit messages, PR titles/bodies) MUST be written in English. Do not use Japanese characters (hiragana, katakana, kanji) in any committed artifact. Conversation with the user in chat may be in Japanese — this rule applies only to files that land in the repository.
