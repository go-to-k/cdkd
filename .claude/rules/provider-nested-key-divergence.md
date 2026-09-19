---
description: Nested CFn to SDK key divergences and the nested-key critic
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - nested CFn to SDK key divergences

Generator: [layout-scripts.md](layout-scripts.md).

## Fix the WHOLE blob, not the reported key

A filed silent-drop bug names the key someone noticed; its sibling is often the WIDER breakage.

- Enumerate the CFn side MECHANICALLY: `aws-cdk-lib`'s generated `convertCfn<Type><Prop>PropertyToCloudFormation` functions, or the fixture's `nestedPropertyPaths` capture. Never by eye.
- Enumerate the SDK side from the schema serde aliases (`@aws-sdk/client-*/dist-cjs/schemas/schemas_0.js`), not only the `.d.ts` members: the aliases are what the serializer iterates, so "`_ARN` exists, `_Arn` does not" is decisive.
- Fix EVERY divergence in the same change, and state the count compared, so a reviewer can tell a full diff from a spot-check.

## What membership proves

For a provider that FORWARDS a config blob, membership makes the key-SPELLING class non-regressing. For one building a FRESH SDK object it proves nothing: a member the mapper never names is dropped while the `same-spelling` bucket stays silent. Such a target also sets `freshObjectMapper: true`, turning on the WRITE-EVIDENCE pass: each would-be `same-spelling` key must appear as a WRITTEN SDK member (`x: …`, `{ x }`, `sdk.x = …`, compound assignment, `defineProperty`) or land in the CI-blocking `no-write-evidence` bucket; reads, `readCurrentState`'s reverse map and a literal built only to be DIFFED do not count. Opt in by MEASURING: where the forced-on run shows a REAL drop, hold it back until the provider fix lands in the same change ([#1807](https://github.com/go-to-k/cdkd/issues/1807)).

## What the write pass credits

- **A whole sub-blob handed to a GENERIC converter**, at that path and below. GENERIC means the callee names NO member, in its body OR in any callee it reaches — transitively, which refuses a delegating guard; a converter that FILTERS, RENAMES or PICKs names nothing and is credited anyway. The credit is bounded to the BLOB, not the enclosing scope, and a blob read off an AWS RESPONSE and re-sent is not a hand-off: the taint root is the desired property bag.
- **The BUILDER idiom** — a local binding whose INITIALIZER is an object literal, populated by `out.Foo = …` onto THAT binding and reaching a write. Refused for `const out = makeThing()`, a `let out;` seeded later, or a reassigned binding; resolved by DECLARATION identity through BLOCK scopes, not bare name; bounded to the builder.
- Evidence is PATH-SCOPED at FULL DEPTH: a terminal member is checked against the scope its parent chain maps to. The chain matches case-INSENSITIVELY, one level at a time; the terminal member matches exactly, being the only proof of delivery. A genuine RENAME needs a `segmentRenames` entry, staleness-fenced: `--check` fails when the un-renamed chain resolves or the CFn segment disappears, but NOT when the provider stops writing the member — that is the divergence the map exposes.

Measured bounds: a duplicate name at the SAME PATH still vouches, since the index unions across write SITES (hand-off points likewise), so a member dropped on ONE code path is not fenced; and resolution is best-effort and bare-name, so an unfollowable hop flags CORRECT code.

## Allow-listing

`NESTED_KEY_ALLOW_LIST` entries silence the key and shape passes only; clearing a `no-write-evidence` verdict needs `passes: ['write', ...]`, since a key-pass rationale says nothing about whether the provider writes a member it demonstrably has. Entries match PATH-first, terminal-name-second. Naming a CFn key's literal does not clear the KEY pass either: that needs a real SDK member written at the resolved parent chain, or a `terminalRenames` entry resolving on the write side. Where a real conversion is invisible to the walk, use a `passes: ['key']` entry naming the write site — never decoy literals.
