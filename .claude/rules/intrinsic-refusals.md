---
description: 'The deliberate-refusal class that propagates out of Fn::Sub, its throw sites, and which of them mark it non-retryable'
paths:
  - 'src/deployment/intrinsic-function-resolver.ts'
  - 'src/utils/error-handler.ts'
  - 'src/deployment/secret-region-classification.ts'
  - 'src/cli/commands/scrub.ts'
  - 'src/cli/commands/drift.ts'
---

# Intrinsic-resolution refusals

Split out of [architecture.md](architecture.md) (item 4, "Intrinsic Function
Resolution"), whose glob is `src/**/*.ts`, so this was loaded on every `src/`
touch. The five globs above: the resolver RAISES the refusals; `error-handler.ts`
DEFINES the class and its subclass;
`secret-region-classification.ts`'s `#2692` note weighs the same
base-class-vs-subclass choice from the over-refusal side; and `scrub.ts` /
`drift.ts` BRANCH, on the subclass and on the base class (`#2482`) respectively
— so the body's "ONE other consumer branches" is as of `#2133` and predates
`drift.ts`.

`src/deployment/retryable-errors.ts` DEFINES `markNonRetryable`, which the
resolver calls at its throw sites, and it is NOT globbed — for the same COST
reason as `deploy-engine.ts` below, but reached the other way round. It was in
the glob list until go-to-k/cdkd#3236 made it a budgeted row of its own, with
`cloud-control-wait.md` globbed at it ALONE, leaving that row a few KB under its
73,500 B cap — less than this file's size, against a payload that sheds only the
3,671 B the bullet took out of `architecture.md`. So adding the path put the row
OVER, and the fence said so in the right words: "this is your own delta, not a
collision". The answer is to drop the path, never to raise a cap that just
fired.

NO BYTE FIGURES IN THAT PARAGRAPH, deliberately. Every payload on a globbed path
is a function of THIS FILE's size, so a figure written here is invalidated by the
next edit to the file it sits in — including the edit that corrects it. That is
not hypothetical: it happened three rounds running on go-to-k/cdkd#3298, the last
time inside the very commit that was fixing the previous two. The live numbers
belong to `tests/unit/scripts/rule-file-payload.test.ts`, which is NOT a rule
file and so does not move any payload when it is edited; its `DARK_DETECTORS`
case and per-row bands assert them on every run. Put the DECISION here and the
ARITHMETIC there.

What makes the drop safe is the same mitigation `deploy-engine.ts` relies on:
`layout-deployment.md` carries the `markNonRetryable` / `isMarkedNonRetryable`
cause-walk summary (including that this class stays UNMARKED) on every
`src/deployment/**` path, and this file is one.

`src/deployment/deploy-engine.ts` is NOT globbed for a COST reason, not because
it does not care: its budgeted row's cap headroom is smaller than this file (see
the note above on why no figure is quoted here). What
makes that safe is that all three things the body states about it are written at
the throw site in that file: the re-wrap of an output-resolution failure with
`cause` threaded so the non-retryable marker survives, the child
`DeployEngine.deploy()` -> `NestedStackProvider.create` -> parent `withRetry`
path, and the per-output catch that prints `Failed to resolve output` and exits
0 — the last being the laundering arm, so it is the one that most needed to stay
reachable. And
[layout-deployment.md](layout-deployment.md) carries the `markNonRetryable` /
`isMarkedNonRetryable` cause-walk summary (including that this class stays
UNMARKED) on every `src/deployment/**` path.

The bullet below is ONE line of 3,963 B against the 4,000 B `MAX_LINE_BYTES` in
`tests/unit/scripts/rule-file-payload.test.ts`, and the repo-wide count of lines
over that bound sits at its ratchet (6 of 6, and the ratchet only goes DOWN). So
the next clause added to it must REFLOW it into paragraphs rather than append —
go-to-k/cdkd#3276 appended one clause to it and it now sits 37 B under the bound.

- **A deliberate REFUSAL propagates out of `Fn::Sub` (issue [#1740](https://github.com/go-to-k/cdkd/issues/1740)).** `Fn::Sub`'s `${LogicalId.Attribute}` form resolves through `resolveGetAtt`, and warn-and-keep-the-raw-`${...}` is the deliberate answer for a genuinely unknown variable. It used to answer EVERY failure, so the refusals the resolver raises on purpose there — `guardedPhysicalIdFallback`'s `*Arn` / `*Url` shape hard-fail (the #1103 class), the `--strict-getatt` rejection, `rejectPlaceholderArnAttribute` (#1729), and the fabricated-account guard (#1730) — were laundered into a literal `${Resource.Attribute}` shipped to AWS by a green deploy: the identical reference hard-failed in a resource property and silently degraded inside an `Fn::Sub`. The refusals now throw `IntrinsicResolutionRefusalError` (`src/utils/error-handler.ts`) and the `Fn::Sub` catch re-raises that class, widened by #2270 (declared resource) and #2285 (declared parameter, no `Default`, unbound); an UNDECLARED head keeps it, as does a bound or defaulted parameter, and its warning names the actual cause instead of asserting `not found`. Since issue [#2133](https://github.com/go-to-k/cdkd/issues/2133) ONE other consumer branches, needing a distinction the class cannot make: `cdkd scrub`'s cross-stack pre-pass treats a PERMANENT refusal as an unremediable FINDING (the rest of the stack is still scrubbed, the run exits non-zero) while a USER-FIXABLE one must REFUSE the stack, since a re-run after the fix scrubs it. Exactly one site is permanent — `resolveGetStackOutput`'s cross-account refusal — so it throws the SUBCLASS `CrossAccountSecretRefusalError`, and scrub matches on THAT. Matching the base class downgraded its fixable siblings and let scrub print `No plaintext secrets found` and exit 0 over surviving plaintext. A FURTHER subclass answers a DIFFERENT question scrub asks: `MalformedProducerRecordRefusalError` (#3207) says the cause is ANOTHER stack's damaged record — fixable, but perhaps not by this user — so scrub records a finding instead. **Other throw sites are NOT on that path** and use the class so a refusal is a property of the THROW, not of the one catch that inspects it: both `resolveSplit` refusals (#1874) and `refuseCoercedInheritedSecret`. Reasons differ per site (`error-handler.ts`'s class JSDoc is the authority); the cross-account one DOES need the class, since an `Fn::Sub`-built `StackName` would otherwise launder it. **All but the time-dependent sites `markNonRetryable` at the `throw`** (#1838) — the `Fn::Sub`-reachable ones above (#1103 / `--strict-getatt` / #1729 / #2270 / #2285), both `resolveSplit` refusals, `refuseCoercedInheritedSecret`, the cross-account one and #3207's: each decides from an input a retry cannot change (a persisted state record, an attribute-name suffix, a CLI flag, an already-resolved value's type) while interpolating template-controlled text a SUBSTRING-matching retry classifier reads as transient. The class stays unmarked because the #1730 arm (a fabricated account is cached for 10s) and the #3096 live-read refusals (`refuseUnservedAttribute`) are time-dependent. The retry loop is reachable even though resolution runs outside `withRetry` on the flat path: a child `DeployEngine.deploy()` re-throws through `NestedStackProvider.create`, which the parent wraps in `withRetry`, and under `--strict-getatt` an OUTPUT-resolution failure is re-wrapped by `deploy-engine.ts` — with `cause` threaded, so the marker survives. And the class is no guarantee against a class-AGNOSTIC catch: `evaluateConditions` absorbs any failure per condition and downgrades it to `false`, so a refusal inside a `Conditions` entry is still silently laundered. **Where the intrinsic SITS still decides what the user sees** — a refusal in a resource property fails the resource, while one in a stack Output is caught per-output by `deploy` (`Failed to resolve output`) and the deploy exits 0.
