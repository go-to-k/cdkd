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

Membership runs the SHAPE pass over the type's CFn definitions: a bare array the SDK models as a `{Quantity, Items}` wrapper (`array-vs-wrapper`), or a member missing from the SDK interface a request carries for its definition (`definition-member-missing`), blocks CI unless the provider names the CFn spelling or an allow-list entry carries a rationale. Whether each nested member actually reaches the wire — misspelled, misplaced or never written — is the sdk-wire harness's question (`tests/unit/provisioning/sdk-wire-*.ts`), not this critic's; the key and write passes that used to infer it from source text were retired by [#3723](https://github.com/go-to-k/cdkd/issues/3723).

## What the hand-off walk decides

A literal rescues a `definition-member-missing` only as evidence of a CONVERSION, so it is withdrawn when an instance of the definition is handed WHOLE to a GENERIC converter and another definition explains the literal (PR #4324). GENERIC means the callee names NO member, in its body OR in any callee it reaches; a converter that FILTERS, RENAMES or PICKs names nothing and is credited anyway. The taint root is the desired property bag, so a blob read off an AWS RESPONSE and re-sent is not a hand-off. Paths map onto write paths case-INSENSITIVELY per level; a genuine RENAME needs a `segmentRenames` entry, staleness-fenced: `--check` fails when the un-renamed chain resolves or the CFn segment disappears.

## Allow-listing

`NESTED_KEY_ALLOW_LIST` entries are keyed `Type#Member` and silence both shape sub-passes for that member. An entry that stops matching fails `--check`. Never add decoy literals to clear a verdict.
