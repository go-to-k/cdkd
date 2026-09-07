---
description: The sticky provisionedBy cc-api routing rule, its two exemption modes, and the per-resource condition that returns a resource to its SDK provider
paths:
  - 'src/provisioning/provider-registry.ts'
---

# The sticky `provisionedBy: 'cc-api'` rule and its exemptions

Split out of [state-schema.md](state-schema.md) (issue
[#2719](https://github.com/go-to-k/cdkd/issues/2719)) when that file's detail
pushed `src/types/state.ts`'s rule budget over its cap. The glob here is the
ONE file this describes, so a state-schema edit no longer pays for it.

`ProviderRegistry.getProviderFor` rule 2 keeps a resource recorded
`provisionedBy: 'cc-api'` on Cloud Control. That default exists to avoid
physical-ID churn: without it, every issue-#609 backfill release would
destroy + recreate resources that were routed to Cloud Control before the
backfill landed.

## The cost the default carries

Sticky-by-default means a backfill speeds up NEW resources only. Every stack
that hit the auto-route earlier keeps paying Cloud Control latency, with no
exit short of `--recreate-via-sdk-provider`, which destroys and recreates.
That is the gap the `'sdk-coverage'` mode closes.

## `STICKY_CC_MIGRATION_EXEMPT`

A table keyed by resource type. Consult the constant, never a list here — its
membership changes. Every entry, in both modes, must satisfy the same hard
requirement:

> **The SDK provider addresses the resource by the SAME physicalId the Cloud
> Control path stored.**

That is condition 2, and it is what makes a flip churn-free. It is an
EMPIRICAL per-type fact — Cloud Control mints its identifier from the schema's
`primaryIdentifier`, the SDK provider stores whatever `create()` returned — and
it is false in general (composite ids, ARN-vs-name divergences). So each entry
names an integ fixture that OBSERVED it on a live resource, and
`tests/unit/provisioning/sticky-exempt-registry.test.ts` refuses an entry whose
fixture does not exist or has no row in the integ ledger. An entry cannot land
before its parity arm has actually run.

**Comparing physical ids is not always sufficient evidence.** A resource with a
user-supplied name keeps its id through a destroy + recreate, so an arm that
only compares ids cannot tell an in-place update from a replacement — which is
the entire claim. `tests/integration/cc-to-sdk-reroute/` attaches an
out-of-band subscription cdkd does not manage and asserts it survives.

## The two modes

- **`'cc-broken'`** — Cloud Control cannot correctly manage the type at all, so
  staying pinned keeps a live bug alive (`AWS::Scheduler::Schedule`, issue
  #961). The escape is UNCONDITIONAL: no property check, and `--pin-cc-api` is
  deliberately ignored, since honoring a pin would re-pin the resource to the
  handler that cannot address it.
- **`'sdk-coverage'`** — Cloud Control manages the type correctly and is merely
  slower; cdkd has since gained full coverage (`AWS::SNS::Topic`, issue #2719).
  The escape is CONDITIONAL, per resource.

## The flip condition, and why each gate is there

One implementation, `wouldReturnToSdkProvider`, shared by rule 2 and `cdkd
diff`'s annotation. They were separate copies for one revision and a mutation
probe caught it: changing "check BOTH bags" to "check the desired one twice" in
the registry copy left the whole suite green, because the only test of that
condition exercised the other copy.

1. Not exempt → false.
2. `'cc-broken'` → true, unconditionally.
3. `forceCcApi` → false. Set by `--pin-cc-api` and, load-bearing, by
   `--recreate-via-cc-api`: that flag passes `provisionedBy: 'cc-api'` as a
   HINT, and without the suppression the exemption would read the hint and
   divert the resource straight back to the SDK provider, turning the user's
   explicit request into a no-op.
4. **No properties, no flip.** A call with no template bag cannot establish
   anything about the resource. This one rule is why destroy, rollback deletes,
   the observed-capture re-derivation and the legacy `getProvider()` are
   conservative without a special case each, and it confines the flip to a
   mutating deploy — the only moment the Cloud Control latency is actually
   paid, so exactly where #609's benefit lives.
5. **An absent RECORDED bag is UNKNOWN, not empty.** A caller holding a state
   record but not passing its bag is indistinguishable here from one with no
   record; guessing "clean" would reopen gate 6 through the one door it exists
   to close.
6. **BOTH bags free of actionable silent drops.** The desired bag alone is not
   enough, because of the REMOVAL deploy: property `P` was applied under Cloud
   Control, then deleted from the template. The desired bag is now clean, so a
   desired-only condition would route THAT deploy to the SDK provider — which
   cannot unset `P` — silently skipping the removal, the exact bug the
   auto-route exists to prevent. Under Cloud Control the same deploy patches
   `P` away, the recorded bag stops carrying it, and the NEXT deploy flips.
   Convergent, one deploy late, never wrong.

Rule 2 FALLS THROUGH to rules 3-7 rather than returning an SDK provider
directly, so the re-route is decided by the same matrix as a fresh resource: a
type whose provider was unregistered between releases degrades to the Cloud
Control route instead of throwing.

## What the user sees

`ProviderRoutingDecision.sdkMigration` marks the TRANSITION — set only on the
deploy that flips, since the record says `'sdk'` from the next write on.
`cdkd diff` renders `[returning to SDK provider]` -- WITHOUT the `via CC
API:` prefix its sibling tokens share, since the resource is leaving Cloud
Control and the combined form said both things at once. Before #2719
that annotation read the state record alone, so an exempt type showed
`[via CC API: sticky]` while routing to the SDK provider — the annotation
stated the opposite of what the deploy would do.

## Adding a type

The step-by-step admission checklist is in
[docs/provider-rules.md](../../docs/provider-rules.md) ("Admitting a type to
the sticky-CC exemption"), where a provider author will already be reading.
