# PR 6: `cdkd state destroy` command

**Status**: planned
**Branch**: `feat/state-destroy-command`
**Depends on**: none
**Breaking change**: no (new command)
**Parallel with**: PR 1, 2, 3, 7

## Goal

Add a new `cdkd state destroy <stack>` subcommand that deletes a stack's
AWS resources and state record **without requiring the CDK app**. This
makes it possible to clean up a stack from any working directory, given
only the state bucket (or its default).

## Background

`cdkd destroy` requires running inside the CDK app (it synthesizes the
app to discover stacks). That's correct when the app exists, but breaks
the common cleanup flow:

- A teammate destroys a stack from a different machine.
- A CI cleanup job runs after the source repo is gone.
- A user wants to drop a forgotten stack referenced only by name.

`cdkd state rm` already exists but only removes the state record. Users
need a way to also delete the AWS resources tracked in that state — i.e.,
the equivalent of `cdkd destroy` minus the synth dependency.

The naming `cdkd state destroy` mirrors `cdkd destroy` ("the cross-app
version") and contrasts with `cdkd state rm` ("forget without deleting").

## Scope

### In scope

- New subcommand `cdkd state destroy <stack> [stack...]` under the existing
  `state` command group.
- Reads stack state from the state bucket (no synth).
- Deletes resources in reverse dependency order, using the same provider
  registry as `cdkd destroy`.
- Removes the state record after successful deletion.
- Confirmation prompt by default; `--yes` / `-y` to skip.
- `--state-bucket`, `--state-prefix`, `--profile` supported (consistent
  with other `state` subcommands).
- `--region` for narrowing to a specific region key when the stack name
  exists in multiple regions (PR 1 territory).
- `--all` to destroy every stack in the bucket (with confirmation).

### Out of scope

- Synth-driven destroy (already handled by `cdkd destroy`).
- Cross-bucket destroy (one bucket per invocation).
- Concurrent multi-stack destroy across buckets.

## Design

### Command surface

```
cdkd state destroy <stack> [stack...] [options]
cdkd state destroy --all [options]

Options:
  -y, --yes                 Skip confirmation prompt.
      --region <region>     If the stack name resolves to multiple regions
                            in state, scope to one. Optional.
      --state-bucket <b>    Same semantics as cdkd state list.
      --state-prefix <p>    Same.
      --profile <p>         Same.
```

### Internal flow

1. Resolve state bucket (existing helper).
2. Read state for the named stack(s) from S3.
3. For each stack:
   - Acquire lock.
   - Build a destroy graph from state (dependency-reversed).
   - For each resource: invoke provider `delete` (with PR 2's
     `expectedRegion` plumbing).
   - On full success: delete the state file.
   - On partial failure: keep the state file with the surviving
     resources; report errors and exit non-zero.

This reuses the `runDestroyForStack` (or equivalent) function that
`cdkd destroy` already calls. The difference is just the source of
"which stacks" — synth-derived list vs. state-derived list.

### Refactor opportunity

Today's `cdkd destroy` does: synth → for-each-stack → destroy. The "for-
each-stack → destroy" piece can be hoisted into a shared helper consumed
by both `cdkd destroy` and `cdkd state destroy`. This PR pulls the
hoist-and-share refactor along with the new command.

```typescript
// src/cli/commands/destroy-runner.ts (new)
export async function runDestroyForStack(
  stackName: string,
  region: string,
  state: StackState,
  ctx: DestroyContext,
): Promise<DestroyResult> { ... }
```

`destroy.ts` calls it after synth. `state.ts`'s new `destroy` subcommand
calls it after reading state.

### Help text

```
$ cdkd state destroy --help

Destroy a stack's AWS resources and remove its state record without
requiring the CDK app. Use this from any working directory when you
have access to the state bucket.

For removing only the state record (keeping AWS resources intact),
use 'cdkd state rm'.

Examples:
  cdkd state destroy MyStack
  cdkd state destroy MyStack OtherStack
  cdkd state destroy --all -y
  cdkd state destroy MyStack --state-bucket cdkd-state-test
```

## Implementation steps

1. Hoist destroy-per-stack logic into a shared helper
   (`src/cli/commands/destroy-runner.ts` or similar).
2. Update `cdkd destroy` to call the helper.
3. Add `state destroy` subcommand in `src/cli/commands/state.ts`.
4. Wire confirmation, `--yes`, `--all`, `--region` filters.
5. Unit tests for the shared helper and the new subcommand wiring.
6. Integration test
   `tests/integration/state-destroy/`: deploy then call
   `cdkd state destroy <stack>` from a temp dir without CDK app sources.
7. Update help text and docs.

## Tests

### Unit

- `tests/unit/cli/state-destroy.test.ts` — covers wiring, confirmation,
  `--all`, `--region` filter, multi-region disambiguation.

### Integration

- `tests/integration/state-destroy/`:
  1. Deploy a small stack via `cdkd deploy`.
  2. Switch to a temp directory with no CDK app.
  3. `cdkd state destroy MyStack -y` → resources gone, state empty.

## Compatibility verification (Pre-merge checklist)

- [ ] `pnpm run build`
- [ ] `pnpm test`
- [ ] `cdkd state destroy MyStack -y` end-to-end on real AWS.
- [ ] `cdkd state destroy --help` text is clear and references
      `cdkd state rm`.
- [ ] `cdkd destroy MyStack -y` (existing command) still works after the
      refactor — no regression.

## Documentation updates

- `CLAUDE.md` — describe `state destroy` alongside `state rm`; clarify the
  difference (state-record-only vs resources-and-state).
- `README.md` — quick-start examples include the new command.
- `docs/state-management.md` — section on cleanup options.

## References

- Existing `cdkd state rm` lives in `src/cli/commands/state.ts`.
- Existing destroy flow: `src/cli/commands/destroy.ts`.

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
