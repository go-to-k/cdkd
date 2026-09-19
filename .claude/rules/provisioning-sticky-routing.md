---
description: The sticky cc-api routing rule and the SDK flip-back
paths:
  - 'src/provisioning/provider-registry.ts'
---

# The sticky `provisionedBy: 'cc-api'` rule

Rule 2 of `ProviderRegistry.getProviderFor` keeps a resource recorded
`provisionedBy: 'cc-api'` on Cloud Control, so a coverage backfill cannot
replace resources auto-routed before it landed.
`STICKY_CC_MIGRATION_EXEMPT` is the escape, keyed by type. Each entry must
satisfy: **the SDK provider addresses the resource by the SAME physicalId Cloud
Control stored.** It is EMPIRICAL and false in
general, so each entry names an integ fixture that saw it live, and
`sticky-exempt-registry.test.ts` rejects one whose fixture has no ledger row. Comparing ids is NOT sufficient (a user-named resource keeps
its id across a replacement), so the fixture asserts an unmanaged subscription
survives.

`cc-broken` (Cloud Control cannot manage the type) escapes UNCONDITIONALLY, with
`--pin-cc-api` ignored, since a pin re-pins the resource to the handler that
cannot address it. `sdk-coverage` escapes CONDITIONALLY, via
`wouldReturnToSdkProvider`, ONE implementation shared with `cdkd diff`:

1. `forceCcApi` returns false. `--recreate-via-cc-api` sets it, load-bearing: it
   passes `provisionedBy: 'cc-api'` as a HINT the exemption would read back,
   making that request a no-op.
2. **No properties, no flip** — which keeps destroy, rollback deletes and
   observed re-derivation conservative with no special case each; an
   absent RECORDED bag is UNKNOWN, not empty.
3. **BOTH bags free of actionable silent drops.** The desired bag alone fails
   the REMOVAL deploy: a property applied under Cloud Control then dropped from
   the template leaves a clean desired bag, so a desired-only condition sends
   that deploy to the SDK provider, which cannot unset it. Cloud Control clears
   it and the NEXT deploy flips.

Rule 2 FALLS THROUGH to rules 3-7 rather than returning an SDK provider, so an
unregistered type falls back to CC.
