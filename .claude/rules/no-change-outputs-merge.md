---
description: What the no-change deploy path persists for Outputs when one did not resolve
paths:
  - 'src/deployment/no-change-outputs-merge.ts'
---

# `no-change-outputs-merge.ts`

Issue [#2771](https://github.com/go-to-k/cdkd/issues/2771).
`mergeNoChangeOutputs` has three rules: a key that RESOLVED writes its value; a
key that FAILED keeps its stored value (plus its literal export alias, only if
the previous record published it AND `refusesCarriedAlias`, the alias pass's
verdict, passes it, #4657) or stays absent; a key this pass did not produce is
REMOVED. Not all-or-nothing: that blocks every resolvable sibling.

Two shapes still keep the whole previous bag (`kind: 'kept'`): a failed output
WITH a stored value whose `Export.Name` is INTRINSIC, since its alias key cannot
be named and rule 3 would drop a live export; and a merge carrying a value into
a bag it gives its FIRST secret-bearing expression, which `computeOutputsDiff`
reads as proof the WHOLE bag is redacted.

The engine re-runs that second check on the bag AS THE SAVE REDACTS IT, first
removing every carried key from `outputsTemplateSource`: positioning a carried
value by today's template persists a reference it never came from. A kept bag
sets `outputsSourceUsable` false.

A LEAF module: `isSecretBearingReferenceString` / `bagHoldsSecretExpression`
live here for this refusal and the deploy engine. `outputs-diff.ts`'s #1948
exoneration no longer reads `bagHoldsSecretExpression`: its substring spelling
test let a stored `{{resolve:secretsmanager:A}}-<plaintext>` exonerate its own
record (#4101), so the diff reads its own whole-token / literal-shape rule,
limited to a plain `ssm` token (#4108). `bagHoldsSecretExpression` itself counts
a plain `ssm` token too (#4108), so the merge refuses to write a SecureString's
first token beside a carried pre-#1901 plaintext.
The exoneration stays BAG-level: non-deploy rewrites drop `skippedOutputs`.
