# cdkd PR Roadmap — Region & State Refactor

This directory tracks the rollout plan for a multi-PR refactor that reshapes how
cdkd handles state buckets, stack regions, and a few related UX issues. Each
file is a self-contained implementation plan for one PR — the order below is
the recommended merge order, **not** the required implementation order.

## Why this refactor

Three classes of bugs / UX problems surfaced together and share a single
underlying cause: the current state model assumes "one region = one cdkd
client", but cdkd's collection model (one S3 bucket per account) plus CDK's
per-stack `env.region` conflict in subtle ways.

1. **Silent state corruption on `env.region` change** — Changing a stack's
   `env.region` between deploys overwrites the recorded region in
   `state.json`, leaving the original region's resources untracked. `destroy`
   then runs against the wrong region and produces silent failures (e.g.,
   Lambda `delete-function` returns `ResourceNotFoundException` from the
   wrong region, which is treated as idempotent success).
2. **`UnknownError` from S3 HeadBucket** — When the CLI's profile region and
   the state bucket's region differ, S3 returns a 301 redirect on a HEAD
   request with an empty body. The AWS SDK v3 protocol parser cannot classify
   it and surfaces a synthetic `UnknownError`.
3. **Team sharing breaks across profile regions** — The default state bucket
   name embeds the profile region (`cdkd-state-{accountId}-{region}`). Two
   teammates with different profile regions look up different bucket names
   and end up with split state.

The refactor introduces a region-aware state key layout, dynamic bucket
region resolution, and a region-free default bucket name. Plus a few quality-
of-life additions surfaced in the same discussion (`cdkd state destroy`,
hiding the bucket-name banner from `deploy` output).

## Design summary

| Aspect | Before | After |
|---|---|---|
| State bucket count | 1 per account (region-suffixed name) | 1 per account (region-free name) |
| Default bucket name | `cdkd-state-{accountId}-{region}` | `cdkd-state-{accountId}` |
| State key | `cdkd/{stackName}/state.json` | `cdkd/{stackName}/{region}/state.json` |
| Same `stackName` across regions | One key — second region overwrites first | Independent keys per region |
| `--region` flag | Used by every command (overloaded) | Bootstrap-only |
| Bucket region detection | None — relies on profile region matching | `GetBucketLocation` at startup |
| `UnknownError` handling | Bubbles up verbatim | Normalized via HTTP status code |

## PR list

| # | Title | Depends on | Breaking change | Parallel | Plan |
|---|---|---|---|---|---|
| 1 | State key region prefix (collection model extension) | none | yes (auto-migrated) | ✅ | [01](./01-state-key-region-prefix.md) |
| 2 | DELETE region verification | none | no | ✅ | [02](./02-delete-region-verification.md) |
| 3 | Dynamic region resolution + UnknownError normalization | none | no | ✅ | [03](./03-dynamic-region-resolution.md) |
| 4 | Default state bucket name (region-free) | PR 3 | yes (auto-migrated) | △ (after PR 3) | [04](./04-state-bucket-naming.md) |
| 5 | `--region` flag cleanup | PR 3 | no (deprecation) | △ (after PR 3) | [05](./05-region-flag-cleanup.md) |
| 6 | `cdkd state destroy` command | none | no | ✅ | [06](./06-state-destroy-command.md) |
| 7 | Hide state bucket from deploy output + `cdkd state info` | none | no | ✅ | [07](./07-state-bucket-display.md) |
| 99 | Backwards-compat removal + final migration command (future) | 1, 4 | yes | — | [99](./99-future-bc-removal.md) |

## Operating rules for this rollout

- **Branch naming**: `feat/<short-slug>` for each PR (e.g., `feat/state-region-key`).
- **PR open, no merge**: open all PRs but wait for explicit user approval to
  merge. The user reviews and decides merge order.
- **Parallel worktrees**: PRs 1, 2, 3, 6, 7 are independent — each lives in
  its own `git worktree` so work can proceed concurrently. PRs 4 and 5 wait
  for PR 3 to merge.
- **Subagents**: when subagents drive any of these PRs end-to-end, they MUST
  use Opus 4.7 (`model: "opus"` plus an Opus-tier `subagent_type`). Do not
  fall back to a smaller model silently.
- **Markgate gates**: PRs 1 and 4 are flagged as breaking changes and will
  gate merges on a new `bc-check` markgate marker (see each plan).

## Compatibility strategy

PRs 1 and 4 are user-visible breaking changes. Both are protected by:

1. **Backwards-compat read path** — Old key layouts and old bucket names are
   still readable. The legacy form is detected on read; a warning is logged.
2. **Auto-migration on write** — The next write (deploy / destroy / lock
   acquisition) silently migrates to the new form and removes the legacy
   artifact.
3. **Schema version** — `state.json` carries a `version: number` field
   (already present, set to `1` today). New writes use `version: 2`. Old
   binaries that try to read `version: 2` fail with a clear error rather
   than silently mishandling the new format.
4. **`bc-check` markgate gate** — Each affected PR ships a verification
   script (`scripts/verify-bc.sh`) that checks the migration paths against
   fixtures. The marker is required before `gh pr merge` succeeds.

The legacy read path is **temporary**. PR 99 (future, 1–2 releases later)
removes it and ships a final `cdkd state migrate` command for any users who
never touched their state in the interim.

## Out of scope (explicitly)

The following items came up in discussion and were deliberately deferred:

- **Region failure isolation** — One state bucket means one region's S3
  outage stops all cdkd operations across all stack regions. Accepted as a
  tradeoff of the collection model. Users who need region failure isolation
  should split state with `--state-bucket` per stack group.
- **Data residency / cross-partition (GovCloud, China)** — Not a target use
  case for cdkd. Users with these requirements should use the upstream CDK
  CLI.
- **CFn-style `cdk list` for deployed stacks across all regions** — `cdkd
  state list` already serves this purpose under the collection model and is
  better than CFn at it.

## Cross-cutting documentation updates

Each PR updates docs in its own scope. These three files will see edits
across multiple PRs:

- `README.md` — top-level "Behavior vs CDK" / "Caveats" section
- `CLAUDE.md` — invariants for collection model + region-prefixed keys
- `docs/state-management.md` — bucket layout, key layout, migration plan

## Tracking & follow-ups

- A GitHub issue tracks PR 99 (backwards-compat removal) so it is not
  forgotten.
- Each PR's plan file ends with a "Follow-ups discovered during
  implementation" section that should be updated as work progresses.
