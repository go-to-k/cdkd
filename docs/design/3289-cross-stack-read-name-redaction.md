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
value mid-run makes the union write BOTH spellings of the same entry, and its
first-seen-wins merge keeps whichever arrived first.

That same property is the reason a repair pass is still owed: a plaintext entry
an older binary persisted out-ranks this run's redacted one, so the deploy-side
fix does not clean an existing record. `cdkd scrub` is where that belongs.

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
