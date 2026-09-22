---
description: src/utils/own-keys.ts — the own-key / plain-prototype rule every rebuild or membership walk over a JSON.parse'd bag applies (drift.ts and the analyzer-side drift canonicalizers)
paths:
  - 'src/utils/own-keys.ts'
  - 'src/analyzer/drift-normalize.ts'
  - 'src/analyzer/drift-principal-normalize.ts'
  - 'src/analyzer/cc-api-strip.ts'
  - 'src/synthesis/assembly-reader.ts'
  - 'src/provisioning/providers/nested-stack-provider.ts'
---

# src/utils/own-keys.ts

Rest of `src/utils/`: [layout-utils.md](layout-utils.md). The drift comparison chain these helpers serve: [layout-drift.md](layout-drift.md).

- **src/utils/own-keys.ts** - `hasOwnKey` / `ownValue` / `defineOwnKey` / `hasPlainPrototype` / `nullPrototypeRecord`, the ONE spelling of the own-key rule every rebuild or membership walk over a `JSON.parse`d bag applies (issue [#3121](https://github.com/go-to-k/cdkd/issues/3121); extracted from `src/cli/commands/drift.ts`, where PR #3124 swept issue #2899's class). A LEAF with no imports, and it must stay one: a value import from a module other suites `vi.mock` reds those suites with a missing-export failure, which is why `secret-redaction.ts` keeps its own `hasPlainPrototype` copy. Consumers: `drift.ts` (`getAtPath` / `setAtPath`, the preserve walks, `mergeUntemplatedValue`, `deepEqualUnordered`) and the analyzer-side comparison canonicalizers (`drift-normalize.ts`, `drift-principal-normalize.ts`, `cc-api-strip.ts`), which rebuild onto `nullPrototypeRecord()` and return a non-plain value (`Date`, `Uint8Array`) by identity — a `{}` literal rebuild assigns an own `__proto__` key as the prototype (dropped on BOTH comparison sides, so the drift was invisible) and `Object.entries(new Date())` is `[]` (flattened to `{}` before the comparator). `in` membership is the same class one operator over: `constructor` answers `true` through the prototype chain.
- **The nested-template indexes are the other consumer family** (issue [#3480](https://github.com/go-to-k/cdkd/issues/3480)): five walks map a template logical id to a child template's path (`AssemblyReader.extractStackInfo`, `indexNestedChildTemplates`, `indexNestedTemplatePaths`, `indexGrandchildTemplatePaths`, `NestedStackProvider.indexGrandchildTemplates`), and each builds a prototype-less container — four through `nullPrototypeRecord()`, the provider through a raw `Object.create(null)` — as does every `??` fallback for a stack with no indexable row. **`defineOwnKey` is NOT interchangeable here.** It closes the dropped `__proto__` row and leaves the other half: SIX readers test membership with `if (!index[id])`, where an INHERITED `Object.prototype` member is truthy for a never-indexed id named `toString` / `valueOf`, so a refusal that exists to fire is skipped — `grep -rniE 'nestedTemplate[sP][a-z]*\[|childTemplatePath' src/` answers which, rather than a list here that goes stale. The character class is load-bearing, and the example that proves it is `nodeNestedTemplatePaths[` (`export.ts`, the `buildPerStackImportNodes` reader), which a plain `nestedTemplates\[` misses entirely — do not trim it to that. (`parentNestedTemplates[` is NOT the example: the plain pattern matches it as a substring.) The split to apply: `defineOwnKey` writes into an object someone else owns; a walk building its OWN container takes `nullPrototypeRecord()`.
