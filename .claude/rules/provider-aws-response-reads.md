---
description: Reading AWS responses in a provider
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - reading AWS responses

**A declared response field is not a POPULATED one.** SDK models are shared across operations, so a `List*` summary can declare `Tags?: Tag[]` and never carry them, and a walk that never matches is a silent wrong answer. Only the COMMAND doc or a live call proves population; prefer a per-candidate `Get*` when the list form is a documented subset.

**A read API accepting MORE id forms than the write APIs breaks `import()`** ([#1824](https://github.com/go-to-k/cdkd/issues/1824)): `import()` RECORDS the id it verified, so refuse — before the verification call — any form the WRITE calls reject. Prefer refusing over normalizing, and derive the predicate from the documented constraint.

**Never infer a default from a possibly-malformed value.** `(config['Status'] as string) || 'Suspended'` defaults whenever `config` is a string, array or unresolved intrinsic rather than an object — often the OPPOSITE of the declaration, with no error. `??` is the same bug plus an explicit `null`. Use `src/provisioning/config-shape.ts` (`readConfigString`, `requireConfigString`), not a hand-written guard:

- **Guard the DESIRED side only**: `previousProperties` is a cdkd STATE record, and refusing a malformed value an older binary wrote makes the stack undeployable forever.
- **Validate the FIELD, not just the container** (`{ Status: null }` passes a `typeof === 'object'` test); an ABSENT key keeps defaulting. Gate with `!= null`: `if (config)` admits a truthy-but-malformed value on create only.
- **Throw on CREATE, WARN on UPDATE**: `rollback-executor.ts` replays `update()` with a STATE record as the desired bag, so a refusal there leaves the resource un-rollbackable.
- **Pass `{ coerceNumber: true }` only where a NUMBER is legitimate**: CFn coerces scalars and cdkd does not, so an unquoted YAML `IpProtocol: -1` deploys today. Enum fields take none.
- **A helper the DELETE / diff paths also reach stays unguarded** — guard the create CALL SITE instead; those paths carry state-borne values.
- **A shape-PROBE is the same class**: probing member presence on a malformed bag indexes to `undefined` and sends the request without the block, so probe EVERY member the readers accept.

**Field VALUE rules do not belong in pre-flight; COMBINATION and required-member PRESENCE rules do.** Intrinsics are unresolved there, so a value check would reject a legitimate `Fn::If`-valued block; `nested-required.ts` asks only whether a member KEY is present, skipping any intrinsic on the path; a mutually-exclusive COMBINATION asks only which top-level keys are unconditionally PRESENT (one behind an unresolved intrinsic counts UNKNOWN). It must live there because a provider-side refusal is reachable only on a template-borne CREATE — once the resource exists the diff classifies NO_CHANGE and the invalid template deploys forever. Table: `src/provisioning/mutually-exclusive-properties.ts`; add a rule ONLY for a combination AWS itself rejects — there is no escape hatch.
