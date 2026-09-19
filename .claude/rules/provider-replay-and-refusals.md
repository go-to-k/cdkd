---
description: Provider replay context, pre-flight refusals, effectiveProperties
paths:
  - 'src/provisioning/providers/**'
---

# Provider replay context, pre-flight refusals, `effectiveProperties`

See also [provider-property-fidelity.md](provider-property-fidelity.md).

## `replayingState`

`CreateContext.replayingState` = the properties came from a cdkd STATE record, not the template; set ONLY by `rollback-executor.ts`'s reverse-replacement arm, and `UpdateContext.replayingState` by its two revert arms. `drift --revert` sets `desiredFromAwsReadback` instead. Absent / `false` = a template-path create.

A pre-flight refusal ([docs/provider-rules.md](../../docs/provider-rules.md)) MUST downgrade to a warning when it is set: the user cannot edit a state record from the template. It licenses nothing else — not a dry-run signal, and no relaxing of data-safety guards or input validation. Two exceptions, stated AT the refusal: AWS rejects the combination 100% of the time (issue [#1975](https://github.com/go-to-k/cdkd/issues/1975)), so the replay could not have succeeded; or every downgrade would report SUCCESS over an unreadable resource.

Prefer the shared `replayWarn(logger, context)` (`config-shape.ts`) over a hand-written refusal, and `configStringRefusal(...)` for a per-ITEM read, which SKIPs instead of defaulting onto a LIVE resource. A malformed OBJECT block reads as EMPTY, which is not always inert (S3 replication `Filter: {}` means "replicate EVERY object"). A provider declaring no `context` parameter silently ignores the argument: no type error, just a refusal still firing on a replay.

## Update-path downgrades

The create downgrade does not apply: a CREATE DEFAULT would land on a LIVE resource. Choose per site — keep the PREVIOUS value, SKIP the block, SUPPRESS the diff, or WARN and keep pre-refusal behavior where a throw would strand a half-applied change. Record whatever is kept or narrowed via `effectiveProperties`, or it becomes the next deploy's previous side and permanent phantom drift. Split on ABSENCE, not usability: an ABSENT recorded previous DROPS the key, a present-but-unusable one records the LIVE reading. A state-borne PREVIOUS side downgrades UNCONDITIONALLY.

## Baselines from the live read

Junk state from a warn-and-continue update becomes the next update's previous side, so seed the baseline from the provider's live read whenever the recorded previous is present-but-unusable. Do not seed an ABSENT previous blindly — gate on the DESIRED side DECLARING the property: omitted, both sides normalize to the type default and consulting AWS manufactures a change; declared, comparing against the type default suppresses a real flip. Where a live read has a documented ABSENCE semantic, encode it instead of a create default.

Take IDENTITY from the live read unconditionally; take VALUES only when:

- it is not an AWS default for a mode the resource is not in (`ProvisionedThroughput: {0,0}` under PAY_PER_REQUEST) — gate on the live MODE; existence is mode-independent where values are not;
- nothing else OWNS the number (an autoscaled capacity) — detect the owner from the TEMPLATE;
- the comparator can tell them apart — `deepEqual` is `JSON.stringify` and readback order is not guaranteed, so SPREAD the desired entry and override only the members you vouch for.

Fail OPEN on any unresolvable shape. The absent-field RESET derives from the PREVIOUS side, so an identity-only baseline disables every removal.

## `attributes` and `effectiveProperties`

`attributes` REPLACES the record (`result.attributes ?? (wasReplaced ? undefined : current)`), so a partial map ERASES every key it omits: gate a HEAL of a cdkd-COMPUTED value on EVERY member being in hand. A member a live read-back reports UNASSIGNED is replaced on purpose.

`effectiveProperties` (`ResourceCreateResult` / `ResourceUpdateResult`) records what the provider actually SENT, and only where the narrowing is DELIBERATE and already announced by a warn arm. AWS defaults and computed values belong in `observedProperties`; in `properties` they drift the DESIRED baseline and disable absent-field removal. It REPLACES the desired bag wholesale, so it must be COMPLETE — absent means "record the desired properties", `{}` is legitimate.

Every `update()` caller honours it (deploy, `drift --revert`, both rollback revert arms), as does the reverse-replacement `create()`, where returning none keeps `previousState.properties`.

## `canonicalizeDesiredProperties`

`effectiveProperties` alone breaks the next deploy: STATE describes what AWS holds, the template still declares the dropped keys, and the next diff reads them as a user ADD — a REPLACEMENT for a create-only key, or a delete-and-recreate on every deploy without `DescribeType`. Narrow BOTH sides identically via `ResourceProvider.canonicalizeDesiredProperties(resourceType, properties)`: pure, synchronous, applied by `DiffCalculator`, sharing ONE helper with the provisioning path.
