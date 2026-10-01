---
description: Masking a resolved property value in a provider log line
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - secret masking in provider log lines

A provider's `properties` bag arrives RESOLVED, so a `{{resolve:secretsmanager:...}}` scalar is PLAINTEXT in `create()` / `update()`. `CreateContext` / `UpdateContext` extend `SecretMaskingContext` (`maskSecrets?: (text: string) => string`), threaded by `deploy-engine.ts`, `rollback-executor.ts` and `drift --revert`, each from its own resolution bag ([#1932](https://github.com/go-to-k/cdkd/issues/1932)). A provider re-creating inside its own `update()` forwards at most the masker, never `replayingState`.

- **Apply it to any line interpolating a `properties` value.** `ConsoleLogger` masks every line emitted inside `withCurrentResourceSecrets` with the bound bag ([#2177](https://github.com/go-to-k/cdkd/issues/2177)), but that sink sees only the bag: no derived-name needle, no JSON-escaped spelling, and nothing on a `delete()` path, which binds no bag. A THROWN message is already masked by `DeployEngine`, leaving only the gaps below. One sink set per operation: `createMaskedLogSinks` (`src/provisioning/masked-retry-logger.ts`). A physical name `generateResourceNameWithFallback` REWROTE from a secret matches neither masker arm: add it with `withDerivedNameMasks`. **A derived-name needle list errs toward OVER-masking** (#4141, `idNameSegments`): an exclusion or replacement that only spares an innocent word (a shape test for "AWS-generated", a needle REPLACED rather than added) must never drop a candidate that may be the name.
- **Mask the VALUE before stringifying; the message is a fallback.** A masker matches literal occurrences, and `JSON.stringify` escapes `"`, `\` and newlines out of the finished line. And `maskSecretsInText` scans substrings only at >= `MIN_NEEDLE_LENGTH` (4), so a short secret survives there. Do both: walk the value with `maskDeep` (`src/provisioning/masked-retry-logger.ts`; never hand-roll one), masking every string leaf AND key, then route the message through the masker.
- **`vp run audit:provider-secret-mask:check` (CI) fails a `${JSON.stringify(X)}` interpolated into a message where `X` reaches no masker.** Dataflow-aware; it REFUSES an identity masker: thread the capability or use its `EXEMPT` list. A no-op DECLARED to be the capability is believed, so green proves only that the value reached the declared masker.
- **Read it defensively** (`context?.maskSecrets ?? ((t: string) => t)`); **never cache it on `this`** — providers are SINGLETONS serving concurrent resources.
- **Mask in the OPERATION POLLER, not the arm calling it.** Where a service reports the rejection in `Operation.ErrorMessage`, every arm's catch re-throws a `ProvisioningError` verbatim, so masking in the arm is INERT: mask the raw `ErrorMessage` where it is read, and thread the masker from every create / update caller. DELETE callers stay unthreaded.

The capability is a FUNCTION, not the PLAINTEXT-keyed `RecordedSecretValues` bag: every holder of that bag is a place `[...secrets.keys()]` can leak from. `NestedStackProvider` is the exception: it SEEDS a child `DeployEngine` with the parent's `plaintext -> {{resolve:...}}` map, read via `getCurrentResourceSecrets()` (`src/deployment/resource-secrets-scope.ts`), not by widening `CreateContext`. **Such a reader MUST NOT enumerate or log the KEYS** — they are secret plaintext, usable only as a redaction seed.

What it masks is the CALLER's decision: the dynamic-reference secrets, plus a `NoEcho: true` PARAMETER's value as a LOG-ONLY needle ([#1998](https://github.com/go-to-k/cdkd/issues/1998), [layout-deployment-secrets.md](layout-deployment-secrets.md)).
