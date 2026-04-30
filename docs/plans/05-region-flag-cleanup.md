# PR 5: `--region` flag cleanup

**Status**: planned
**Branch**: `feat/region-flag-cleanup`
**Depends on**: PR 3 (dynamic region resolution)
**Breaking change**: no (deprecation only)
**Parallel with**: PR 4 (after PR 3 lands)

## Goal

`--region` (and the parallel `AWS_REGION` reliance) accumulated several
overlapping responsibilities over time:

1. State bucket region selector.
2. Default-name resolver key (`cdkd-state-{acc}-{region}`).
3. Deployment fallback when `env.region` is missing on a stack.

After PR 3 (dynamic region resolution) and PR 4 (region-free default name),
roles 1 and 2 are obsolete. Role 3 is unhealthy — CDK best practice is to
specify `env` on every stack — but `--region` still has one legitimate role:
selecting the region for `cdkd bootstrap` to create a new bucket.

This PR consolidates `--region` to bootstrap-only and deprecates it on every
other command.

## Background

Currently every cdkd command accepts `--region`. After PRs 3 and 4 it does
nothing useful on most commands except shadow `AWS_REGION`. Keeping it
encourages users to specify the wrong thing ("which region does `--region`
mean here?").

## Scope

### In scope

- Remove `--region` from `commonOptions` so it stops being added by default
  to every command.
- Re-add `--region` explicitly to `bootstrap` (creating a new bucket needs
  to know where).
- Detect `--region` usage on other commands and emit a deprecation warning
  ("`--region` has no effect on this command and will be removed; use
  `AWS_REGION` env or your AWS profile instead").
- Update `--help` text to no longer advertise `--region` outside bootstrap.
- Update docs that recommended `--region`.

### Out of scope

- Removing `--region` outright (deprecation period; final removal in PR
  99).
- Re-adding `--region` for niche commands later (not anticipated).

## Design

### Deprecation behavior

When `--region` is passed to a non-bootstrap command:

```
Warning: --region is deprecated for this command and has no effect.
         Use the AWS_REGION environment variable or your AWS profile
         to override the SDK's default region.
```

The flag is *parsed* (so the existing pipeline does not break) but
otherwise ignored.

### Help-text updates

For each affected command (`deploy`, `destroy`, `diff`, `synth`, `list`,
`state` subcommands, `force-unlock`, `publish-assets`):

- `--region` is removed from `--help`.
- Bootstrap's `--region` description is reworded to make its
  bucket-creation role explicit.

## Implementation steps

1. Remove `region` from `commonOptions` in `src/cli/options.ts`.
2. Re-add `--region` in `src/cli/commands/bootstrap.ts` directly.
3. Add a small helper `warnIfDeprecatedRegion(options)` invoked by every
   non-bootstrap command.
4. Update each command's options handling so passing `--region` does not
   crash but does emit the warning.
5. Update `--help` outputs (verify visually).
6. Update unit tests to cover the warning path.
7. Update docs: `README.md`, `docs/state-management.md`,
   `docs/troubleshooting.md`, any reference in `CLAUDE.md`.

## Tests

### Unit

- `tests/unit/cli/options.test.ts` — verify `--region` is not in
  `commonOptions` after change; verify `bootstrap` still has it.
- For each command's test file, add a case asserting deprecation warning
  when `--region` is passed.

### Integration

- Quick smoke test: `cdkd state list --region us-east-1` runs to
  completion and prints the deprecation warning.

## Compatibility verification (Pre-merge checklist)

This PR is non-breaking (deprecation only), but worth manually verifying:

- [ ] `pnpm run build`
- [ ] `pnpm test`
- [ ] `cdkd deploy --region us-east-1 ...` — works, prints deprecation
      warning to stderr.
- [ ] `cdkd state list --region us-west-2` — works, prints warning.
- [ ] `cdkd bootstrap --region us-east-1` — works, no warning.
- [ ] `cdkd bootstrap --help` — `--region` is documented.
- [ ] `cdkd deploy --help` — `--region` is **not** documented.

## Documentation updates

- `README.md` — remove `--region` from the "common options" section (if
  any); keep it in bootstrap usage example.
- `docs/state-management.md` — remove `--region` advice.
- `docs/troubleshooting.md` — replace any `--region` recommendation with
  `AWS_REGION` env or profile.
- `CLAUDE.md` — Configuration Resolution: clarify that `--region` is a
  bootstrap-only option; profile / env handles everything else.

## References

- `src/cli/options.ts` defines `commonOptions`.
- `src/cli/commands/bootstrap.ts` is the only command that legitimately
  needs `--region`.

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
