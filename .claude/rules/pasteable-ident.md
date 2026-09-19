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

Split out of `layout-cli.md` by go-to-k/cdkd#3432, when adding the third
consumer took `src/cli/commands/scrub.ts`'s budgeted payload row past its cap —
the fence's own prescribed remedy, and the right shape anyway: the rule now
spans three layers and was documented inside one command's bullet.

**`src/deployment/deploy-engine.ts` is deliberately NOT in the glob above**, and
for the COST reason `intrinsic-refusals.md` records about the same file: globbing
it there took that path's budgeted row 592 B over its cap in the very commit that
created this file. What makes the drop safe is that the decision is written at
the site — `maskedRecordRemedyFor`'s two arms each say why the command is
withheld and why sanitizing the id in place would be wrong — and
[layout-deployment.md](layout-deployment.md), which IS globbed there, carries a
one-line pointer here.

## The descriptor, and what it does NOT make safe

Since issue [#3179](https://github.com/go-to-k/cdkd/issues/3179) section C the
`stack (region)` descriptor renders through `displayIdent`, and the SPLIT is
available structurally as `parseStateKey`, so no caller re-parses the rendered
form.

`displayIdent` is not enough for a value going into a COMMAND. Every character
of `--state-bucket=attacker` is a plain identifier character, so it renders
BARE and is still an option once the operator strips the advisory quotes. Nor
is quoting the alternative: quoting answers the shell-metacharacter question
and none of the option case. The answer for a value failing the test is
REFUSAL — name the value, withhold the command.

## Why it moved to `src/utils/display-safe.ts`

The predicate outgrew its family twice.

First (go-to-k/cdkd#3377) `resolveProfileCredentials` in
`src/cli/commands/local-start-api.ts` gated its `aws sso login --profile <name>`
hint on it, because a user-supplied `--profile ~evil` / `-rf` is the same shape
one flag over.

Then a consumer appeared in `src/deployment/` — `DeployEngine.maskedRecordRemedyFor`'s
`cdkd import ... --resource <id>=<physicalId> --force`, which had no guard at
all and rendered a template-supplied logical id raw into a DEFAULT-verbosity
`ProvisioningError` (go-to-k/cdkd#3432's security round). `src/deployment/`
imports nothing from `src/cli/`, and re-spelling a security predicate in the
second consumer is the shape this repo has repeatedly measured going wrong — so
`isPasteableIdent` and `PASTEABLE_STATE_IDENT` moved DOWN to the leaf both
layers already import, beside the `displayIdent` round-trip that is half of the
rule. `state-file-keys.ts` RE-EXPORTS the name, so no existing caller moved.

So it is the repo's answer for a PASTEABLE value generally rather than for a
state-key segment specifically — `PASTEABLE_STATE_IDENT`'s name is narrower
than its job — and an edit tightening either half must now ask what it costs
THREE callers, one of them a deploy-path error message. Its cap is
`STACK_REF_MAX_CODE_POINTS`, looser than a profile name needs and harmless,
since every character it admits is already plain.

## The STRICTER sibling, and why it is not this one

`rollback-executor.ts` keeps a private `PASTEABLE_LOGICAL_ID`
(`/^[A-Za-z0-9]{1,255}$/`) for `cdkd rollback --orphan <id>`: CloudFormation's
own logical-id charset, which admits nothing a shell treats specially.

**That rule is WRONG for the import remedy, and the difference was measured
rather than reasoned.** cdkd validates no logical-id charset and never hands the
template to CloudFormation, so a HYPHENATED id is legitimate — and routing it
correctly was a round-4 blocker on issue
[#2847](https://github.com/go-to-k/cdkd/issues/2847), whose fix
`masked-record-remedy-shapes.test.ts` still pins. Gating that command on
`[A-Za-z0-9]` was written first and withheld the command for `My-Table`,
reddening four of those cases. `isPasteableIdent`'s allow-list
(`[A-Za-z0-9][A-Za-z0-9~_.-]*`) is the one calibrated for cdkd's own id space:
medial `~` / `_` / `.` / `-` admitted, a LEADING one refused, because the
leading position is where the option and tilde-expansion shapes live.

Do not unify the two. The narrower rule is right where it applies, and the
wider one is right where cdkd's acceptance is wider than CloudFormation's.
