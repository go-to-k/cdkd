---
description: What the no-change deploy path persists for the Outputs bag when an output did not resolve — the three merge rules, the two keep-whole refusals, and why the exoneration is bag-level rather than per-key
paths:
  - 'src/deployment/no-change-outputs-merge.ts'
---

# `src/deployment/no-change-outputs-merge.ts`

Pointed at from [layout-deployment-secrets.md](layout-deployment-secrets.md).
Its own satellite because the two paths that would otherwise carry this entry
— `src/deployment/secret-redaction.ts` and `src/cli/commands/scrub.ts` — sit
within a few dozen bytes of their rule budgets on `main` (issue
[#3110](https://github.com/go-to-k/cdkd/issues/3110)); the glob is the ONE
file this describes, so a redaction or scrub edit no longer pays for it.

What the NO-CHANGE deploy path persists for the Outputs bag when an output did
not resolve (issue [#2771](https://github.com/go-to-k/cdkd/issues/2771)).
Three rules in `mergeNoChangeOutputs`: a key that resolved writes its value, a
key that failed keeps its stored value (plus its literal export alias, only
when the previous record published it) or stays absent, and a key this pass
did not produce is removed — replacing the issue #875 all-or-nothing keep,
which blocked every resolvable sibling of one persistently failing output.

Two shapes still keep the whole previous bag (`kind: 'kept'`, reason rendered
by `keptWholeReasonText`): a failed output WITH a stored value whose
`Export.Name` is intrinsic (its published alias key cannot be named, so rule 3
would drop a live export), and a merge that would carry a value into a bag it
gives its FIRST secret-bearing expression — `computeOutputsDiff` reads one such
expression as proof the whole bag is redacted, so the carried value (possibly
pre-GHSA plaintext) would be exonerated. The engine re-runs that second check
on the bag AS THE SAVE REDACTS IT, after the observed-capture drain (the one
`await` between the outputs pass and the save), and removes every carried key
from `outputsTemplateSource` first: `redactByPath` returns a whole-expression
source leaf verbatim, so positioning a carried value by today's template would
persist a reference it never came from. A kept bag sets `outputsSourceUsable`
false for the same reason.

What the no-change path INSTALLS as `state.outputs`, for the `sameGenerationBags`
mark [layout-deployment-secrets.md](layout-deployment-secrets.md) describes:
with every output resolved, the redacted bag `resolveOutputs` returned when the
outputs changed and the previous (unmarked) bag otherwise; with a FAILED output,
either a fresh, unmarked per-key merge of this pass's values with the previous
bag's carried ones or, when that merge refuses, the previous bag kept whole,
unmarked.

A LEAF module (imports one type): `isSecretBearingReferenceString` /
`bagHoldsSecretExpression` live here so `src/analyzer/outputs-diff.ts`'s
exoneration and the merge's refusal read ONE predicate. Not per-key on purpose
— every non-deploy state rewrite (`cdkd import`, `drift --accept`) drops
`skippedOutputs` while keeping the bag, so per-key provenance would lose its
evidence on the first such command. The kept-arm warning keeps its
`!outputMapsEqual(persistedOutputs, resolvedOutputs)` conjunct although both
refusals make it true by construction today: a future refusal that carries
nothing would make the "Outputs changed but" wording wrong without it.
Real-AWS net: `tests/integration/output-never-resolved-diff/` phases 4b / 4c.
