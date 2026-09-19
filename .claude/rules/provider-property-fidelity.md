---
description: Provider property fidelity on the wire
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - property fidelity on the wire

See also [provider-diff-record-folds.md](provider-diff-record-folds.md).

## What belongs in `effectiveProperties`

A SUBSTITUTED value is the same class as a dropped key, and it arrives both from a warn-and-default arm and from a value the guard accepts by design (`coerceNumber` stringifies an unquoted `IpProtocol: -1`, so state holds a number and the readback a string). Audit every arm that can put a value on the wire differing from the declared one, not only those that log.

The bar is "matches what AWS HOLDS", not "lossless" — AWS stores a declared `IpProtocol: 6` as `tcp`. What decides is whether the post-mapping value is knowable AT SEND TIME. Knowable (a closed, documented set such as Kinesis `ALL`): expand ON THE WIRE via one helper shared with `canonicalizeDesiredProperties`, and record what you sent. Not knowable: fix the READBACK, canonicalizing both comparison sides and the identity lookup below.

A guard over such a field has THREE answers: `absent` (a template REMOVAL that clears the live set), `usable`, and `unusable` (which must NOT). Let each caller pick the action rather than flattening early, and do not let a partial read leak past the refusal — filtering an unresolved intrinsic out of a MIXED array sends a list nobody declared.

## Skip vs substitute

`canonicalizeDesiredProperties` is scoped to a NARROWING, a pure function of the desired bag. Do NOT apply it to a warn-and-SKIP: it would drop the malformed block from the desired side and derive a REMOVAL of live config.

- **UPDATE**: retain the PREVIOUS value; the Put never ran. Dropping the key would leave a later template that REMOVES the block deriving no removal.
- **replay-CREATE**: DROP the key when the arm SKIPPED; record the SUBSTITUTED value, in the CFn shape, when the call went OUT. Ask whether the call went out, not whether it was a create.
- **A MODE substitution** drops more than one key: record the substituted mode and STRIP the members that mode cannot send, read per member off your own `readCurrentState` under the NEW mode, never by name-shape. On UPDATE, split members against the KEPT mode — an unsendable one keeps the previous value, dropped when that is unusable or absent.
- **An OMIT can leave the call INVALID.** Prune everything DOWNSTREAM that referenced the omitted thing, and the effective bag to match, failing OPEN when the referencing side is unreadable.
- **Per-item appliers**: the skip unit is one ITEM — substitute the previous item of the same `Id` IN PLACE, or drop it when it was an ADD. Preserve the DESIRED order, since `DiffCalculator` compares arrays positionally.

Report the skip EXPLICITLY from the applier rather than by wrapping `onUnusable`, which SKIP-class guards and warn-and-DEFAULT reads share; a warn-and-SUBSTITUTE arm records what it SENT, per ITEM.

## Retaining and dropping

Validate the PREVIOUS value with the SAME predicate the desired side runs — a STATE record can hold `null`, `''` or a bare string. Drop the key when both sides are unusable, and COPY it rather than aliasing the previous bag.

Dropping can MOVE a hazard: an absent key is not malformed, so the next reader's guard stays silent and its DEFAULT applies — a dropped Lambda URL `AuthType` re-creates as a PUBLIC `NONE`. Make the reading path ANNOUNCE the defaulted absence.

## Never-emitted keys

Where the DESIRED side accepts more than one spelling but `readCurrentState` emits one, a record in the other spelling can never match the readback — permanent drift with nothing to warn about. Key the normalization off the DECLARED shape, not off a refusal arm, and REMOVE the key rather than setting it to `undefined`, which survives `structuredClone` and any `Object.keys` walk. The class is per TYPE: every key read off a desired-side bag counts, `(a['X'] ?? a['Y'])` aliases included. Assert a recorded bag against what `readCurrentState` emits for the configuration just sent, never a hand-written literal.

The `!isPlainObject(x)` arm of a boolean gate hides a destructive default: `coerceCfnBoolean` answers `undefined` for `null`, `'yes'` or an intrinsic, and `undefined !== false` ENABLES delivery for every unreadable value. Use `configBooleanRefusal`, and take the SKIP unit from the API — under a full-replace Put, skipping one family DELETES the others.
