---
description: src/utils/own-keys.ts — the own-key / plain-prototype rule every rebuild or membership walk over a JSON.parse'd bag applies (drift.ts and the analyzer-side drift canonicalizers)
paths:
  - 'src/utils/own-keys.ts'
  - 'src/analyzer/drift-normalize.ts'
  - 'src/analyzer/drift-principal-normalize.ts'
  - 'src/analyzer/cc-api-strip.ts'
---

# src/utils/own-keys.ts

Rest of `src/utils/`: [layout-utils.md](layout-utils.md). The drift comparison chain these helpers serve: [layout-drift.md](layout-drift.md).

- **src/utils/own-keys.ts** - `hasOwnKey` / `ownValue` / `defineOwnKey` / `hasPlainPrototype` / `nullPrototypeRecord`, the ONE spelling of the own-key rule every rebuild or membership walk over a `JSON.parse`d bag applies (issue [#3121](https://github.com/go-to-k/cdkd/issues/3121); extracted from `src/cli/commands/drift.ts`, where PR #3124 swept issue #2899's class). A LEAF with no imports, and it must stay one: a value import from a module other suites `vi.mock` reds those suites with a missing-export failure, which is why `secret-redaction.ts` keeps its own `hasPlainPrototype` copy. Consumers: `drift.ts` (`getAtPath` / `setAtPath`, the preserve walks, `mergeUntemplatedValue`, `deepEqualUnordered`) and the analyzer-side comparison canonicalizers (`drift-normalize.ts`, `drift-principal-normalize.ts`, `cc-api-strip.ts`), which rebuild onto `nullPrototypeRecord()` and return a non-plain value (`Date`, `Uint8Array`) by identity — a `{}` literal rebuild assigns an own `__proto__` key as the prototype (dropped on BOTH comparison sides, so the drift was invisible) and `Object.entries(new Date())` is `[]` (flattened to `{}` before the comparator). `in` membership is the same class one operator over: `constructor` answers `true` through the prototype chain.
