---
description: isPasteableIdent — the one rule for a value cdkd interpolates into a command it tells an operator to RUN, its three consumers, and its stricter logical-id sibling
paths:
  - 'src/utils/display-safe.ts'
  - 'src/cli/commands/state-file-keys.ts'
  - 'src/cli/commands/gc.ts'
---

# A value cdkd tells an operator to PASTE

Rest of `src/utils/`: [layout-utils.md](layout-utils.md). The `cdkd gc` /
`cdkd bootstrap --destroy` family this started in:
[layout-cli.md](layout-cli.md). Index of every area:
[code-layout.md](code-layout.md).

`src/deployment/deploy-engine.ts` is not in the glob above:
`maskedRecordRemedyFor`'s two arms say at the site why the command is withheld
and why sanitizing the id in place would be wrong.

## The descriptor, and what it does NOT make safe

The `stack (region)` descriptor renders through `displayIdent`
([#3179](https://github.com/go-to-k/cdkd/issues/3179)), and the SPLIT is
available structurally as `parseStateKey`, so no caller re-parses the rendered
form.

`displayIdent` is not enough for a value going into a COMMAND. Every character
of `--state-bucket=attacker` is a plain identifier character, so it renders
BARE and is still an option once the operator strips the advisory quotes. Nor
is quoting the alternative: quoting answers the shell-metacharacter question
and none of the option case. The answer for a value failing the test is
REFUSAL — name the value, withhold the command.

## Where it lives

`isPasteableIdent` and `PASTEABLE_STATE_IDENT` live in `src/utils/display-safe.ts`,
the leaf both `src/cli/` and `src/deployment/` import, beside the `displayIdent`
round-trip that is half of the rule. Do not re-spell the predicate in a
consumer; `state-file-keys.ts` re-exports the name. It is the repo's rule for a
PASTEABLE value generally — `PASTEABLE_STATE_IDENT`'s name is narrower than its
job — so an edit tightening it must check every caller
(`grep -rl isPasteableIdent src`), deploy-path error messages included. Its cap
is `STACK_REF_MAX_CODE_POINTS`, looser than a profile name needs and harmless,
since every character it admits is already plain.

## The STRICTER sibling, and why it is not this one

`rollback-executor.ts` keeps a private `PASTEABLE_LOGICAL_ID`
(`/^[A-Za-z0-9]{1,255}$/`) for `cdkd rollback --orphan <id>`: CloudFormation's
own logical-id charset, which admits nothing a shell treats specially.

**That rule is WRONG for the import remedy.** cdkd validates no logical-id
charset and never hands the template to CloudFormation, so a HYPHENATED id
(`My-Table`) is legitimate and the command must still be emitted for it
([#2847](https://github.com/go-to-k/cdkd/issues/2847); pinned by
`masked-record-remedy-shapes.test.ts`). `isPasteableIdent`'s allow-list
(`[A-Za-z0-9][A-Za-z0-9~_.-]*`) is the one calibrated for cdkd's own id space:
medial `~` / `_` / `.` / `-` admitted, a LEADING one refused, because the
leading position is where the option and tilde-expansion shapes live.

Do not unify the two. The narrower rule is right where it applies, and the
wider one is right where cdkd's acceptance is wider than CloudFormation's.
