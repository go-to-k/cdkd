---
description: the rollback replay-CREATE bag and CC fallback-name fill
paths:
  - 'src/deployment/rollback-executor.ts'
---

# The replay-CREATE bag

Both arms live in `replaySingle`'s `reverse-replacement` branch: create-first,
and the delete-new-first fallback the name-collision catch routes to.
**`effectiveProperties` is honoured**
([#1682](https://github.com/go-to-k/cdkd/issues/1682)): `create()` gets
`previousState.properties`; a RETURNED bag replaces the record's `properties`
wholesale, reporting none keeps it. Do not re-narrow that result type.

**When the ROUTING DECISION is `cc-api`, both arms run the bag through
`applyDefaultNameForFallback`**
([#3199](https://github.com/go-to-k/cdkd/issues/3199)), filling a
`FALLBACK_NAME_RULES` name the recorded bag leaves unset exactly as
`preparePropertiesForCcApi` does at the engine's three create sites;
otherwise the replay is a FOURTH create site sending no name and AWS mints a
random one. The arm is picked by a CHANGED PHYSICAL ID (or a changed `Type`,
where the fill keys on the OLD type), so a create-only edit
on a type whose id is NOT its name lands here nameless; a handler REJECTING a
nameless create then fails the replay, and the delete-new-first arm has already
dropped it.

Decisions:

- **The gate reads the registry's RETURNED `provisionedBy`**, not
  `previousState.provisionedBy`: the hint is absent on a pre-v7 record and a
  provider-less type routes to CC anyway.
- **An SDK route is untouched**: the provider mints the name.
- **The fill lands ONLY on the bag handed to `create()`, never on
  `resolvedPrevProps`**; the record is rebuilt from `prevRecord`, so "a recorded
  bag never holds a generated name" survives.

Both entry points bind `withStackName`, making the replayed name EQUAL the
forward create's: `generateResourceName` reads it from `AsyncLocalStorage`.
