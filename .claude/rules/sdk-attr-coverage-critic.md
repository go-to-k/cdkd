---
description: SDK-provider ARN/URL attribute-coverage critic
paths:
  - 'scripts/gen-sdk-attr-coverage.ts'
  - 'tests/unit/scripts/gen-sdk-attr-coverage.test.ts'
  - 'docs/_generated/sdk-attr-coverage.json'
  - 'docs/_generated/sdk-attr-coverage.md'
---

# sdk-attr-coverage critic

`vp run gen:sdk-attr-coverage` builds the matrix; `vp run audit:sdk-attr-coverage:check` fails CI on drift AND on an unresolvable `Arn` / `Url` attribute ([#1187](https://github.com/go-to-k/cdkd/issues/1187)). Family: [layout-scripts.md](layout-scripts.md).

- **Why it matters**: a cross-resource `Fn::GetAtt` reads `resource.attributes[<CFnName>]` in `IntrinsicFunctionResolver.constructAttribute` and never calls `getAttribute`, so an ARN under a non-CFn key HARD-FAILS the resolver's shape guard.
- An `Arn` / `Url` read-only attribute is a `gap` iff NEITHER cached NOR `constructAttribute`-handled NOR allow-listed. Only those suffixes hard-fail the guard; the rest warn and fall back. Stored keys pool per FILE, so a `buildAttributes()` helper counts — but a `case '<Attr>':` label in `getAttribute` is deliberately NOT collected.
- **`primaryIdentifier` is deliberately NOT consulted** (unlike `gen-enrichment-coverage.ts`, whose subject IS the CC path). It names the CC identifier, while every type here is Tier 1 with a physical id minted by its own SDK provider — often a different value or a `|`-joined composite. Consulting it silently retires guards when AWS flips an identifier to an ARN.
- **`SDK_ATTR_ALLOW_LIST` is EMPTY, and that is its green state.** `classifyType` reads `cachedKeys` BEFORE the list, so an entry left behind after its gap is fixed goes inert while the matrix still shows a carve-out — delete it to verify. A new entry needs a rationale and an issue.
- Cache ONLY the ARN AWS returned — never a constructed ARN-shaped fallback, never an imported id (which may be a literal like `PendingConfirmation`, turning the resolver's loud refusal into a silent wrong value).
