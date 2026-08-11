# Lambda DurableConfig replacement execution (issue #1625)

Covers the `AWS::Lambda::Function` REPLACEMENT path being **executed**, not
just classified.

`tests/unit/analyzer/replacement-rules-lambda-609-props.test.ts` pins the
classification (`DurableConfig` is a presence TOGGLE, `TenancyConfig` is
create-only), and `tests/integration/lambda-config-field-removal` deliberately
keeps both properties present in BOTH of its phases — its functions are pinned
to fixed names, so a mid-run replacement would turn its property assertions into
a name-collision test of something else. This fixture is the deferral that
scoping call implies.

## Resources

- **AWS::Lambda::Function** — one function, **unnamed** (no `functionName`), with
  `DurableConfig` applied as an L1 override in the baseline phase only
- **AWS::IAM::Role** — the L2's execution role

## What the first live run established

Two things, both of which changed the shape of the assertions:

1. **An unnamed Lambda collides exactly like a pinned one.** cdkd generates the
   physical name deterministically (`{stackName}-{logicalId}` via
   `generateResourceName`), so the replacement's create-first attempt lands on
   the name the OLD function still holds, and the physical id is IDENTICAL on
   both sides. Issue #1625's suggested "assert the physical id changed" is
   therefore not available; the proof used instead is the pair of end states —
   the collision refusal in phase 2 (a silently-skipped update would have
   reported success) and phase 3's function carrying the new properties with no
   durable config.
2. **AWS spells the collision singular** — `ResourceConflictException: Function
   already exist: <name>`. `isNameCollisionError` matched only `already exists`,
   so no Lambda could take the collision path at all: the raw SDK error escaped
   instead of cdkd's actionable message, and `cdkd deploy --replace`'s
   delete-first fallback never fired, leaving the replacement unperformable by
   any flag. The matcher fix ships with this fixture; phase 2 is what regresses
   if it ever narrows again.

## Phases

| Phase | Env / flags | What it proves |
| --- | --- | --- |
| 1 | — | the function is created WITH `DurableConfig`, SDK-routed |
| 2 | `CDKD_TEST_REMOVAL=true` | the deploy REFUSES with cdkd's actionable replacement-collision error (naming `--replace`), and the live function is untouched |
| 3 | `CDKD_TEST_REMOVAL=true` + `--replace` | the delete-first fallback executes: durable config gone, new description applied, state row still points at the function |
| 4 | — | destroy leaves no function and no state |

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-{accountId} bash verify.sh
```

Or via the skill: `/run-integ lambda-durable-replacement`.
