---
description: Diff-side and record-side folds, empty collections, UpdateContext, retiring a failed create's remnant
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - diff/record folds, empty collections, `UpdateContext`

Preceded by [provider-property-fidelity.md](provider-property-fidelity.md).

## Folds

- **A DIFF-side fold must not name its member in a spread-and-patch literal.** `gen-nested-key-coverage` reads `{ ...out, LifecycleConfiguration: folded }` as a whole-blob HAND-OFF and wildcard-credits everything beneath that path, silently switching the write pass off. Use a COMPUTED key: `{ ...properties, [key]: folded }`.
- **A recording fold needs its `canonicalizeDesiredProperties` twin**, re-asked per site: a never-emitted SPELLING has no fault to fix and emits no warning, so without the twin an unchanged template redeploys forever. Share ONE helper with the applier so state and template cannot fold to different keys, and key the fold off the DECLARED shape, not off a refusal.
- **Resolve a twin's defaults by PRESENCE, never `??`.** The default belongs to a key the template OMITTED, and folding both sides makes them agree. A key DECLARED with a malformed value is the opposite case: the provider warns and substitutes, and `cdkd diff` must keep reporting until the template is fixed. `??` reads a declared `null` as absent, folds the two together, and the warning STOPS.
- **Underneath that: MIRROR WHAT THE WIRE DOES, per member.** A DECLARED-but-unfoldable container is left completely alone — no patch, key NOT dropped — because the applier SKIPS it and the retained previous value would otherwise compare equal. A member whose wire read silently COERCES must fold that coercion. Presence is right only where the wire REFUSES and WARNS.
- **Do not HAND-ROLL the mirror**: `configStringRefusal` and its siblings are PURE and importable, so the fold runs the applier's own predicate. Both error directions are defects, so pin the whole shape table, both arms, in one test.

## Empty collections

- **An EMPTY COLLECTION is not a removal intent, and the skip that absorbs it still records the PREVIOUS value.** CloudFormation REFUSES an update to `{ Rules: [] }` and the live configuration survives, so it is an INVALID template, not a removal — which also rules out making the arm a Delete. ANNOUNCE the skip, and keep it a warning rather than a throw so the `drift --revert` round-trip through `update()` keeps working. On the CREATE path the same guard records the OPPOSITE answer: `readLifecycle` / `readCors` always emit the empty placeholder for an unconfigured bucket, so the declared empty collection already equals the readback and the fold must override NOTHING. Before importing a "drop the key" answer, ask what the readback emits for the UNCONFIGURED resource.
- **Sibling arms that NORMALIZE the empty collection away reach a DELETE.** `emptyListConfigToUndefined` collapses declared-but-empty and ABSENT into one `undefined`, and only the second is a removal. Split them with a predicate scoped to the MEASURED shape (`declaresEmptyCollection`), not by asking whether the fold erased it — it also erases a bare `{}`, which IS a removal. Do NOT remove the fold: `readCurrentState` always emits the placeholder, so both sides must normalize for empty-vs-empty to compare EQUAL.

## `UpdateContext`

Optional; an `update()` that does not read it needs no change. Its fields assert something about the CALLER and must not be merged:

- `desiredFromAwsReadback` — set only by `drift --revert`, where `{Rules: []}` means "restore the unset state" while the same bag from a template means "a collapsed array, do not touch". It is named for what it ASSERTS: the rollback revert arms are state-borne too, but their desired bag is a TEMPLATE recorded earlier, so widening this to `stateBorne` would delete a live configuration during a rollback.
- `replayingState` — set by the rollback executor's two revert arms ([#3141](https://github.com/go-to-k/cdkd/issues/3141)). It asserts only that the desired bag is a cdkd STATE record, licensing the `CreateContext.replayingState` refusal downgrade and nothing about the values' provenance.
- Both it and `CreateContext` extend `SecretMaskingContext`, on a shared base: a masker present on one path and absent on the other is a fix with a hole.

**Normalize BOTH comparison sides** — a record written before the narrowing still carries every key, so a one-sided pass flips the difference into a REMOVAL — and **wire `cdkd diff` too**, or a preview forecasts a change the deploy never makes. `makeCanonicalizePropertiesFn` (`src/provisioning/canonicalize-properties.ts`) is the one builder both commands use.

**A create-side pre-flight refusal forbids re-creating inside `update()`.** The five providers that call their own `create()` from `update()` pass no `CreateContext`, and the properties they forward ARE a state record during a rollback replay — so the refusal would fire on a replay undetectably.

## Retiring what a FAILING create already materialized

For a create shaped `<one call that materializes the resource>` then `<a wait>`, the wait can fail with the resource ALIVE and nothing recorded: invisible to `cdkd state show`, unreachable by `cdkd destroy`, re-created by the next deploy ([#2169](https://github.com/go-to-k/cdkd/issues/2169)). Delete it in the provider's own `catch` and re-throw the ORIGINAL error. Track the id from the AWS RESPONSE so a failure BEFORE the call deletes nothing (`ProvisioningError.physicalId` is NOT that signal — it is usually the INTENDED name); append the survivor and the manual retire command when the cleanup itself fails, degrading the message rather than replacing it; prove the delete is SAFE for that service; and release the idempotency token only when the cleanup SUCCEEDED, since on a failed cleanup the survivor is what a retry should be handed. Do NOT record the remnant in state instead: the recorded properties ARE the template's, so the next deploy diffs `NO_CHANGE` and exits 0 over something unusable. This covers the replacement path for free, since `update()` re-creates via the same `create()`.
