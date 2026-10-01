---
description: cdkd analyzer layer layout (DAG builder, template parser, Outputs diff)
paths:
  - 'src/analyzer/**'
---

# Key Files and Directories - src/analyzer

DAG builder, template parser, intrinsic-function resolution. The `drift-*`
normalizers live with `cdkd drift` ([layout-drift.md](layout-drift.md)); index
of every area: [code-layout.md](code-layout.md).

- **diff-calculator.ts** — the state-vs-template change calculation. Its refusal
  over a resource record whose `properties` map cannot be read:
  [state-malformed-properties.md](state-malformed-properties.md).
- **skipped-outputs.ts** — the `skippedOutputs` record; see its doc comment.

## `outputs-diff.ts`

The diff-side `Outputs` resolution and comparison behind `cdkd diff`'s Outputs
section (issue [#1921](https://github.com/go-to-k/cdkd/issues/1921)) — the
preview half of the Outputs-only persist `cdkd deploy` does.

- `resolveTemplateOutputs` builds the exact bag shape
  `DeployEngine.resolveOutputs` writes to `StackState.outputs`: a condition-false
  output is SKIPPED, and an `Export.Name` is stored as a SECOND key holding the
  same value (what `Fn::ImportValue` resolves against).
- Values resolve into the `outputsPass` bag, then each `Export.Name` into a bag
  sharing its log-only set, in declaration order after every value: the
  deploy's pass 2, whose needles decide the `NoEcho` alias refusal (#4043).
  Never the resource pass's `diffSecrets`, which holds every `NoEcho` value up
  front and would refuse an alias the deploy publishes; it reaches these
  resolutions only as the print-only `printingSecrets`.
- It reads the STORED bag for two decisions: the `skippedOutputs` record, and a
  LITERAL `Export.Name` in a stack resolving a secret. Deploy refuses a name
  CONTAINING a resolved plaintext; the preview never substitutes one, so it
  cannot evaluate that predicate. State holding the alias KEY is proof a
  previous deploy evaluated it over the same name, so the preview republishes
  that key with TODAY's value (the stored VALUE is not evidence). An ABSENT key
  records no verdict and keeps the old behaviour of suppressing the delta.
- **`isUnresolvedValue` is deliberately WIDER than the deploy side's
  `v === undefined`**, because this resolver fails in more ways: `undefined`, a
  SYMBOL (a top-level `Fn::If` selecting `Ref: AWS::NoValue`), a surviving
  intrinsic OBJECT, and — ONLY for a value whose raw template source contained
  an `Fn::Sub` (`templateUsesSub`) — an unsubstituted `${...}` STRING, which
  `resolveSub` warns about and keeps. Each of the first three would otherwise be
  a PERMANENT phantom with `--fail` exiting 1 forever. The `Fn::Sub` SCOPING is
  what keeps the last one safe: applied to every string it would match an IAM
  policy's `${aws:username}` or a UserData `${VAR}` and suppress the section for
  that stack forever.
- Failed keys come back as `failedKeys` because this resolver DROPS them while
  deploy keeps them as `undefined`; without the list every failure reads as a
  phantom REMOVE.
- `computeOutputsDiff` compares bag KEY by bag KEY — the `outputMapsEqual`
  predicate deploy gates its persist on. Its caller, `computeStackDiff`
  (`diff-recursive.ts`), previews the no-change merge through
  `mergeNoChangeOutputs` when the resource diff is empty and its other
  conditions hold, and WARNS when a delta was suppressed, which disambiguates
  "no Outputs section" between unchanged and uncomputable.

### Withholding legacy secret plaintext

This is the first path that DISPLAYS a stored output value, and `cdkd diff` runs
in CI. THREE signals, each concluding something different:

1. The desired side is still a SECRET-BEARING dynamic reference while the stored
   side is not, AND `secretSourceKeys` (keys the TEMPLATE declares as such, over
   every declared output including condition-skipped ones). Both are needed; a
   hit means the record was written by a pre-GHSA binary, so the withholding is
   RECORD-level.
2. `templateHasSecretDynamicReference`, armed by `diff-recursive.ts` from the
   PARENT's template, for a removed nested child whose whole bag becomes REMOVEs
   against an empty template.
3. A stored key in neither `declaredKeys` nor the resolved bag has its value
   withheld — a REFUSAL, not a detection, since a plaintext is indistinguishable
   from an ordinary string there. Gated by `templateHasSecretReference` (does
   the template still prove a secret reference ANYWHERE, `Resources` included)
   and EXONERATED when any stored value is itself a plain `ssm` secret
   expression — in the shape the per-key veto below accepts, never on a
   substring hit (#4101). Only a plain `ssm` token proves the bag redacted: it
   is stored only after #1901, while a `secretsmanager` / `ssm-secure` one
   proves only post-GHSA, and a binary between the two stored a `SecureString`
   plaintext beside it (#4108). Not the state schema version either: a
   non-deploy rewrite restamps it while keeping the old bag. This arm
   withholds PER KEY, because it claims only that one key is undecidable.

On RAW template text, "secret-bearing" is only the spellings that are secret regardless of target:
`{{resolve:secretsmanager:` and `{{resolve:ssm-secure:`. A plain
`{{resolve:ssm:` is EXCLUDED there — a `String` parameter is public and
legitimately persisted resolved, and the verdict is record-wide. On RESOLVED
text (signal 1's desired side, and an intrinsic `Export.Name`'s alias refusal)
a surviving plain `ssm` token counts too: the skip pass keeps one only for a
`SecureString` (#4056). The STORED-text readers — signal 1's per-key veto and the #1948 exoneration
(both `storedSecretTokenIsExpression`), and the no-change merge's carried-value
check in `diff-recursive.ts` — accept a secret token of any spelling (the
exoneration: a plain `ssm` one only, see above) only as one
whole token (for the veto and exoneration, where the desired side is one whole
token too or has no string), or under exactly the desired side's literal parts
(not the carried check); never on a substring hit, which a pre-#1901 deploy
wrote beside a plaintext (#4101). A stored value failing that shape is also
withheld PER KEY on its own (`ownValueHidesSecret`), declared or not, whatever
the record verdict, the exoneration or `templateHasSecretReference` say (a
container by any string leaf; one whole token never, it has no room for one): a
declared key's template value may have turned public, leaving pass 1 no
desired-side signal, and a `cdkd scrub` residual can exonerate the record.

Outputs ROW names print only `secretSafeKeyDisplay`'s verdict (#4015): an
older binary could store an `Export.Name` holding a secret. The diff fetches
none. Its corpus: the proving keys' values (the whole bag when the merge
FORCES the verdict), plus, for an unaccountable name only, unaccountable values
and `secretSpanInStoredKey`. A removed non-alphanumeric ALIAS (listed in
`exportNames` when recorded) is withheld in a secret-referencing stack; other
names (debug lines, warnings) are control-stripped.

**A deliberate SECOND implementation, not shared code**: extracting the
deploy-side block would edit `src/deployment/deploy-engine.ts` and pull a
diff-only fix into the `integ-destroy` gate scope.
`tests/unit/analyzer/outputs-diff.test.ts` pays for that with an anti-drift
fence that READS the engine and watches the DEFINITION of deploy's
failure signal rather than the line consuming it.
- **parameter-dependence.ts** - which resources of a RAW template depend on which template parameters ([#2854](https://github.com/go-to-k/cdkd/issues/2854)). Two consumers must agree: `cdkd import`'s ARM 4 and `cdkd deploy`'s fail-closed reading of a reason-less `observedBaselineRefused` marker (`resourcesNamingDeclaredParameter`, [#3468](https://github.com/go-to-k/cdkd/issues/3468)). An `Fn::` key outside `KNOWN_INTRINSICS` is UNCLASSIFIABLE and refuses; a new resolver intrinsic must be added there.
