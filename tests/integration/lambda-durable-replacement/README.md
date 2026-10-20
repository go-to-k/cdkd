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

- **AWS::Lambda::Function** — one function with an **explicit, per-run**
  `functionName` (`CDKD_TEST_FN_NAME`, set by `verify.sh`), with
  `DurableConfig` applied as an L1 override in the baseline phase only
- **AWS::IAM::Role** — the L2's execution role

## What the first live run established

Two things, both of which changed the shape of the assertions:

1. **A same-name replacement keeps its physical id.** The replacement's
   create-first attempt lands on the name the OLD function still holds, and the
   physical id is IDENTICAL on both sides. Issue #1625's suggested "assert the
   physical id changed" is therefore not available; the proof used instead is
   the pair of end states — the collision refusal in phase 2 (a
   silently-skipped update would have reported success) and phase 3's function
   carrying the new properties with no durable config.

   The fixture was first written with an **unnamed** function, which collided
   the same way while cdkd generated the same name again. Since
   [#5064](https://github.com/go-to-k/cdkd/issues/5064) phase 2, a replacement of
   an un-named resource on a stack with a stack instance id creates at the next
   name generation — a new name, created first — so nothing collides. The
   function therefore declares its name (fresh per run, so a leftover of an
   interrupted run cannot collide with phase 1), which keeps the same-name
   collision this fixture exercises.
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
| 1 | — | the function is created WITH `DurableConfig`, SDK-routed, under the declared name verbatim |
| 1b | `CDKD_TEST_HELD_NAME=<holder>` + `--replace` | issue #3808: renaming onto a name an out-of-band function holds REFUSES, says another resource holds it, and deletes nothing — managed function and holder both survive |
| 2 | `CDKD_TEST_REMOVAL=true` | the deploy REFUSES with cdkd's actionable replacement-collision error (naming `--replace`), and the live function is untouched |
| 3 | `CDKD_TEST_REMOVAL=true` + `--replace` | the delete-first fallback executes: durable config gone, new description applied, state row still points at the function |
| 4 | — | destroy leaves no function and no state |

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-{accountId} bash verify.sh
```

Or via the skill: `/run-integ lambda-durable-replacement`.
