---
description: Why `cdkd orphan` refuses an unreadable `properties` map
paths:
  - 'src/cli/commands/orphan.ts'
---

# `cdkd orphan` + `properties`

Issue [#3318](https://github.com/go-to-k/cdkd/issues/3318). The THIRD reader of
the per-ENTRY `properties` container; predicate and repair argument:
[state-malformed-properties.md](state-malformed-properties.md).

Here
`rewriteValue` returns a non-object VERBATIM and it is re-assigned via a bare
cast, while `refuseMalformedState` answers about the record ROOT only — so the
container was unguarded on a path that SAVES. **The harm is NOT the laundering
the other refusals describe**, so neither text may be borrowed;
`malformedOrphanResourcePropertiesRefusalMessage`'s JSDoc is authoritative.

**SCOPED to the survivors.** `refuseMalformedResourcePropertiesForOrphan` takes
the ORPHAN SET and subtracts it, so it never names a record this run deletes.
The save cannot persist a record it removes; and, load-bearing, `cdkd orphan
<the damaged resource>` is the way OUT of a torn record, so a record-wide
refusal shuts the command that repairs it
([#3202](https://github.com/go-to-k/cdkd/issues/3202)).

**The exemption is CONDITIONAL and the message must never state it otherwise.**
`orphanLogicalIds` comes from the SYNTHESIZED `aws:cdk:path` index, so an id the
app no longer declares cannot enter the orphan set; the text leads with the
TEMPLATE-FREE ways out (hand repair, `cdkd state orphan <stack>`) and conditions
the third. There is deliberately **no `--force`**: forcing still
leaves a record `cdkd deploy` refuses.

**It scans `state.resources` ONLY**: the rewrite spreads `carriedState`, so a
torn bag under `state.orphans[]` is still saved
([#3344](https://github.com/go-to-k/cdkd/issues/3344); `attributes` is
[#3345](https://github.com/go-to-k/cdkd/issues/3345)).

The guard sits at the LOAD, above `rewriteResourceReferences`, and refuses under
`--dry-run` too: a plausible audit table then a refusal once the flag drops is
worse.
