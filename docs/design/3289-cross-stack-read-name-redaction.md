---
title: "Design: redacting the cross-stack read names"
unlisted: true
---

# Redacting the cross-stack read names (issue go-to-k/cdkd#3289)

`state.imports[]` and `state.outputReads[]` carry names the resolver took from
the TEMPLATE, and both lists rode `DeployEngine.redactStateForPersist`'s
`...state` spread untouched. An `Fn::ImportValue` / `Fn::GetStackOutput` whose
name an `Fn::Sub` assembled around a resolved `{{resolve:secretsmanager:...}}`
— or a `SecureString` ssm reference — wrote that plaintext into `state.json`
and kept it there.

## Which fields, and why it is not symmetric

The issue as filed named `imports[].sourceStack` / `sourceRegion`. That is not
what the code does, and the difference decides the fix.

| field | template-derived? | redacted |
|---|---|---|
| `imports[].exportName` | yes — `resolveValue` on the `Fn::ImportValue` argument | **yes** |
| `imports[].sourceStack` / `sourceRegion` | no — `recordImport` takes them from the exports index entry or the state scan, i.e. the PRODUCER's own record | no |
| `outputReads[].outputName` | yes | **yes** |
| `outputReads[].sourceStack` | yes | **yes** |
| `outputReads[].sourceRegion` | yes, but passes `isClientSafeRegion` before it can be recorded, and `producerRegionsFromState` reads it STRUCTURALLY to decide which region may answer for a secret reference | no |

Redacting `imports[].sourceStack` would be over-redaction with a cost: it is
the key `scanActiveConsumers` matches on for the destroy-blocking strong-ref
check, and rewriting it on a coincidence (another stack's secret happening to
equal this producer's name) would break that refusal.

## Why the redaction sits at persist, not at record time

`crossStackReadsForPartialSave` / `unionCrossStackReads` dedup on
`${sourceStack}\0${canonicalizeRegion(sourceRegion)}\0${name}`. Changing a
value mid-run makes the union write BOTH spellings of the same entry, and the
union never drops.

## What the union does ACROSS deploys, measured

An earlier revision of this file said a plaintext entry an older binary
persisted "out-ranks" this run's redacted one. That is wrong, and the three
cases behave differently enough that guessing was never going to land:

| `previous` (persisted) | does this deploy re-resolve the reference? | outcome |
|---|---|---|
| plaintext, older binary | yes, and the secret's VALUE is unchanged | keys MATCH (both sides normalize to the same string), union dedups, the persist redaction rewrites it — **self-repairs** |
| plaintext, older binary | yes, but the secret has since ROTATED | this run's needle is the NEW value, so the old name normalizes to itself: keys disagree, the union keeps both, and only the new one is redacted — **the OLD plaintext survives beside a redacted twin** |
| redacted | yes | keys agree only BECAUSE of `normalizeName`; without it the two spellings key differently, both survive, and the persist redaction makes them byte-identical **duplicates** |
| plaintext, older binary | **no** — the resource is unchanged, or the reference is gone | this run holds no needle for it — **the plaintext survives** |

Row 2 is why `crossStackReadsForPartialSave` takes a `normalizeName`: the
identity key is computed on the REDACTED spelling while the entry is STORED
verbatim, the same compare-normalized / store-verbatim split the function
already makes for the region. A duplicate row is not cosmetic — it doubles an
entry in the destroy refusal and in the recreate prompt.

Rows 3 and 4 are the real residual, and they are what `cdkd scrub` is owed for
(go-to-k/cdkd#3337). The population is narrower than "everything written before
this fix" — a record whose reference is re-resolved to the SAME value repairs
itself — but it is wider than "never re-resolved again": a rotated secret leaves
its old plaintext behind, and scrub cannot reach that one either, since scrub's
needles are also the CURRENT value. Closing the rotation case needs something
that recognises a stale plaintext without holding it, which is a different
instrument from the value scan; it is stated as open rather than designed here.

## The needle bag is the UNION of this deploy's secrets

`perResourceSecrets` is keyed by logical id and `outputSecrets` holds the
outputs pass — correct scoping for a resource RECORD, where a resource's own
secrets redact that resource. A cross-stack read entry carries no logical id,
so it has nothing to be scoped by: the reference may have sat in any resource's
property or in a `CfnOutput`'s Value. `allRecordedSecrets` unions them.

Over-redaction here is the safe direction and is bounded the way the value scan
always is by `MIN_NEEDLE_LENGTH`.

## The reader consequence, and why it is not a silent degradation

`outputReads[].sourceStack` is both a redacted field and the literal key
`findDownstreamConsumers` compares against, so a redacted entry can never match
a live stack name. That function's result feeds `promptRecreateConfirm` — a
DATA-LOSS `[y/N]` prompt listing the consumers a recreate will strand.

A consumer vanishing from that list is a worse failure than one named
imprecisely, so an entry whose region matches and whose name is unresolvable is
reported with `producerUnresolvable: true` and a line saying cdkd cannot name
the producer and that it may or may not be this stack. The row asserts that
cdkd cannot RULE OUT the dependency, never that it holds.

The region conjunct is load-bearing: without it, every recreate in the account
would carry every such consumer, which is noise rather than a warning.

## No schema bump

`StateImportEntry` / `StateOutputReadEntry` keep all three `string` fields;
only values change, so `integ-schema-migration-gate.sh` (which activates on a
diff touching the version literal in `src/types/state.ts`) does not fire.
Precedent: `orphans`, and the go-to-k/cdkd#1934 change that began persisting
expressions in place of plaintext, both shipped without a bump.

The consequence to know: a reader cannot tell a redacted record from a
plaintext one by `version`. The discriminator is the value's own spelling,
which is what `producerNameIsUnresolved` tests — the same rule
`.claude/rules/state-schema.md` states for `exportNames`.
