---
description: What the no-change deploy path persists for Outputs when one did not resolve
paths:
  - 'src/deployment/no-change-outputs-merge.ts'
---

# `no-change-outputs-merge.ts`

Issue [#2771](https://github.com/go-to-k/cdkd/issues/2771).
`mergeNoChangeOutputs` has three rules: a key that RESOLVED writes its value; a
key that FAILED keeps its stored value (plus its literal export alias, only if
the previous record published it) or stays absent; a key this pass did not
produce is REMOVED. An all-or-nothing keep blocked every resolvable sibling of a
failing output.

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
live here so `outputs-diff.ts`'s exoneration and this refusal read ONE
predicate. That exoneration is BAG-level on purpose: every non-deploy state
rewrite drops `skippedOutputs` while keeping the bag.
