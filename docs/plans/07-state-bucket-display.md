# PR 7: Hide state bucket from default output + `cdkd state info`

**Status**: planned
**Branch**: `feat/state-bucket-display`
**Depends on**: none
**Breaking change**: no (output cosmetic + new subcommand)
**Parallel with**: PR 1, 2, 3, 6

## Goal

Two related changes to keep account IDs out of routine cdkd output (so
screenshots and logs don't accidentally leak them) while still letting
users inspect bucket info on demand:

1. Remove the `State bucket: cdkd-state-{accountId}-{region}` banner from
   `cdkd deploy`, `cdkd destroy`, and other commands' default output.
   Move it to `--verbose` debug logging.
2. Add a new `cdkd state info` subcommand that explicitly prints bucket
   info when the user wants it.

## Background

Today `cdkd deploy` starts with:

```
$ cdkd deploy
State bucket: cdkd-state-123456789012-us-east-1
Synthesizing CDK app...
```

The first line includes the AWS account ID. That's fine for a developer
running locally, but creates accidental disclosure risk:

- Screenshots in bug reports / blog posts / Slack.
- CI logs that get archived publicly.

Removing it from default output addresses the leak. But "what's my state
bucket?" is still a reasonable question. `cdkd state info` becomes the
explicit answer.

## Scope

### In scope

- Suppress the `State bucket: ...` banner from default output across:
  - `cdkd deploy`
  - `cdkd destroy`
  - `cdkd diff`
  - `cdkd state list`
  - `cdkd state show`
  - `cdkd state resources`
  - `cdkd state rm`
  - `cdkd state destroy` (PR 6, if landed first)
  - `cdkd force-unlock`
- Move the same info to a `logger.debug` line so `--verbose` still shows
  it.
- Add `cdkd state info` subcommand:
  - Displays bucket name, region, source (cli flag / env / cdk.json /
    default), schema version, stack count.
  - Accepts `--state-bucket`, `--state-prefix`, `--profile` like other
    state subcommands.
  - `--json` for machine-readable output.

### Out of scope

- Restructuring how the bucket is resolved (PR 3 / PR 4 territory).
- Hiding the account ID *inside* error messages (out of scope; cdkd
  errors should still be debuggable).

## Design

### Suppressing the banner

Today the banner is emitted by each command's setup code with `logger.info`.
Change those call sites to `logger.debug`. With the default log level
(`info`), the banner disappears; `--verbose` (which sets the level to
`debug`) still shows it.

### `cdkd state info`

```
$ cdkd state info
State bucket:    cdkd-state-123456789012
Region:          us-east-1 (auto-detected via GetBucketLocation)
Source:          default (account ID from STS)
Schema version:  2
Stacks:          5

$ cdkd state info --state-bucket cdkd-state-test
State bucket:    cdkd-state-test
Region:          us-east-1 (auto-detected via GetBucketLocation)
Source:          --state-bucket flag
Schema version:  2
Stacks:          1

$ cdkd state info --json
{
  "bucket": "cdkd-state-123456789012",
  "region": "us-east-1",
  "regionSource": "auto-detected",
  "bucketSource": "default",
  "schemaVersion": 2,
  "stackCount": 5
}
```

#### "Source" field semantics

| Source | Meaning |
|---|---|
| `--state-bucket flag` | User passed `--state-bucket` on the command line |
| `CDKD_STATE_BUCKET env` | Env var resolved the bucket |
| `cdk.json (context.cdkd.stateBucket)` | cdk.json context resolved it |
| `default` | Fell through to the default name from STS account ID |
| `default (legacy)` | Fell through to the legacy name (post-PR 4) |

#### Stack count

Counts state files at `cdkd/{stackName}/{region}/state.json` (new layout).
After PR 1 lands, also includes legacy-layout files.

## Implementation steps

1. Find every `logger.info('State bucket: ...')` / equivalent and change
   to `logger.debug`. Confirm no tests depended on it being on stdout.
2. Add `cdkd state info` subcommand in `src/cli/commands/state.ts`.
3. Implement source-resolution introspection so the `Source` field can
   distinguish CLI flag vs env vs cdk.json vs default.
4. Implement schema-version detection (read first state file or fall back
   to "unknown" on empty bucket).
5. Add unit tests.
6. Integration test
   `tests/integration/state-info-command/` — small fixture with one
   stack, verify output structure and `--json` shape.
7. Update help text.

## Tests

### Unit

- `tests/unit/cli/state-info.test.ts`:
  - default bucket source vs explicit `--state-bucket` source.
  - empty bucket (`stackCount: 0`, `schemaVersion: "unknown"`).
  - mixed legacy + new layout (after PR 1, if applicable in test order).
  - `--json` shape stability.

### Integration

- `tests/integration/state-info-command/` — basic happy path.

## Compatibility verification (Pre-merge checklist)

- [ ] `pnpm run build`
- [ ] `pnpm test`
- [ ] `cdkd deploy MyStack` — no `State bucket:` line in stdout.
- [ ] `cdkd deploy MyStack --verbose` — `State bucket:` appears in debug
      logs.
- [ ] `cdkd state info` — clear, complete output.
- [ ] `cdkd state info --json` — valid JSON.
- [ ] `cdkd state info --state-bucket some-bucket` — uses that bucket
      and reports `Source: --state-bucket flag`.

## Documentation updates

- `CLAUDE.md` — note that bucket info is no longer in default output;
  point users to `cdkd state info`.
- `README.md` — quick-start: `cdkd state info` for inspection.

## References

- Banner emission lives in each command's setup; grep for
  `State bucket:`.
- `cdkd state list` already loads bucket info for its own purposes —
  reuse that path for `state info`.

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
