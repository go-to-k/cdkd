---
description: cdkd scrub - the permanent state secret-hygiene command (clean + audit)
paths:
  - 'src/cli/commands/scrub.ts'
---

# `cdkd scrub` — src/cli/commands/scrub.ts

The redaction machinery this command drives:
[layout-deployment-secrets.md](layout-deployment-secrets.md). Exit codes and
every exit-1 arm live in [docs/cli-scrub.md](../../docs/cli-scrub.md), which is
the ONE copy — do not restate them here.

`cdkd scrub [STACK...]` is the permanent state secret-hygiene command (clean +
audit), not incident-only tooling. It rewrites persisted state so a resolved
secret dynamic reference is stored as its `{{resolve:...}}` expression WITHOUT a
deploy, and `--dry-run --fail` is positioned as a standing CI gate. A normal
`cdkd deploy` already scrubs as a side effect; this cleans up state written by an
older cdkd. **Scrubbing does not un-expose an already-leaked secret — a value
ever stored in plaintext must be ROTATED.**

- **Its redaction set is NOT a second list to maintain.** It re-resolves through
  the same `IntrinsicFunctionResolver` and reads the same `recordedSecretValues`
  bag the deploy path redacts from, inheriting every class the resolver
  classifies.
- **Unlike the `cdkd state ...` family it NEEDS the CDK app (`--app`)**: state
  records the resolved value with no marker of which values are secrets — only
  the template carries the references. It synthesizes, re-resolves each
  resource's properties into a fresh secrets map (the resolved output is
  discarded), scrubs every state record against it and saves under the stack
  lock. No AWS create/update/delete.

## The OUTPUTS bag is repaired in two passes

1. A stored key today's template can still NAME (a declared output, or an
   `Export.Name` this run could FULLY compute) takes the POSITIONED pass, gated
   on the declared-output secrets map being non-empty. A name that did not fully
   resolve is deliberately EXCLUDED from the accounted set, because the deploy
   engine's alias write guards only on `typeof exportName !== 'string'` — a
   warn-and-kept `${Foo}` really is written as a state key, so accounting for it
   would exclude it from pass 2.
2. `redactUnaccountedOutputs` repairs every OTHER stored key by VALUE MATCH
   alone, against the union of the outputs map and every resource's, filtered to
   `secret-redaction.ts`'s exported `MIN_NEEDLE_LENGTH`. This is the only place
   those two bags are joined — they are separate precisely so one resource's
   secret cannot rewrite another's coinciding literal, **so the resource walk
   must never see the union**. Each such key is scanned ONCE, from the STORED
   value rather than pass 1's output: re-scanning an already-positioned MIXED
   leaf splices a union needle INTO the expression pass 1 just inserted
   (`{{resolve:secretsmanager:{{resolve:ssm:/app/env}}/db:...}}`). An ACCOUNTED
   key is never scanned against the union.

**Nothing is rewritten unless its value genuinely MATCHES a recorded
plaintext.** `state.outputs` is re-applied VERBATIM to consumer stacks (by
`src/state/export-index-store.ts` and by `Fn::ImportValue` / `Fn::GetStackOutput`
in the resolver), so a FABRICATED redaction would ship a literal `{{resolve:...}}`
token into a consumer's own AWS call. An unrecoverable needle leaves the value
untouched and invents or removes no key. Residual: a declared output whose
template value no longer resolves a secret but whose stored value is a stale
plaintext is not repaired — a redeploy rewrites it.

## Cross-stack reads

Every resolve context comes from ONE factory that supplies `stateBackend` (a
MEMOIZING read view, so the pre-pass and the main resolution share one
`listStacks` / `getState` per stack) and deliberately NO `exportIndex` — that
scan arm PATCHES the index, a write at a point in the run nothing chose and
reachable under `--dry-run`. The index write is its own step in `scrubCommand`
instead.

`makeCrossStackPrePass` resolves each cross-stack node ALONE, outside the
per-item best-effort catch, mirroring the resolver's own intrinsic PRECEDENCE and
`Fn::If`'s selected branch only. Three outcomes:

- a read that FAILED for a user-fixable reason → refuse the stack,
  `SCRUB_CROSS_STACK_READ_UNRESOLVED`;
- a read that SUCCEEDED while the PRODUCER's own state record still stores the
  plaintext → refuse, `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` (there is no
  expression to write: scrub the producer first, and for a chain every stack in
  it, head first);
- a read cdkd DECLINES BY DESIGN → an unremediable FINDING, not a whole-stack
  refusal (no re-run could clear it, and refusing would strand every other secret
  in the stack). Matched on `CrossAccountSecretRefusalError`, the SUBCLASS,
  **never on `IntrinsicResolutionRefusalError`**: most of that base class's throw
  sites are user-fixable and are reachable here, so matching it downgrades a
  fixable refusal to a finding and lets scrub exit 0 over surviving plaintext.

**The producer-plaintext discriminator is a DIRECT READ of the producer's stored
value**: read `state.outputs[<the key the read matched>]` on the producer named
by the pre-pass's own `recordedImports` / `recordedOutputReads` entry and test
`carriesDynamicReference` on THAT. Inferring it from the consumer's side does not
work — `reresolveCrossStackValue` resolves a stored expression to plaintext, so
the healthy case and the unscrubbed-producer case both arrive holding one, and a
needle-count test misreads a COMPOSITE export (`postgres://u:{{resolve:...}}@h`)
and a non-string value. Pick the recorded entry by the intrinsic's OWN family
(`Fn::GetStackOutput` reads `recordedOutputReads`) and with `.at(-1)`, since a
read nested in the ARGUMENT is recorded first and may be in the other bag.

The producer's TEMPLATE is still HALF the discriminator and cannot be dropped:
from the consumer's side a stored bucket name and a stored password are both bare
strings. Its verdict is four-valued (`declared` / `widened` / `chained` / `no`) so
the refusal never asserts more than was checked; a `chained` verdict names the
stack that does declare it. The chain walk follows a matched output's
`Fn::ImportValue` / `Fn::GetStackOutput` into the next producer through an
export-name index, terminates by never revisiting a `(stack, export)` pair (a
depth cap would return `no` for a long chain — the silent success it exists to
kill), and WIDENS at the direct producer only.

A CONDITION-SUPPRESSED output is resolved for its needles but cannot refuse, and
the `canRefuse` test runs ahead of the by-design branch so it records no finding
either. Suppression is decided by the condition AND by state: `conditions` comes
from template parameter DEFAULTS and degrades to `{}`, so a key present in
`state.outputs` proves the deploy wrote that output whatever this run concluded.

`orderScrubTargets` sorts a multi-stack run producer-before-consumer
(`dependencyNames` + `inferCrossStackStackDeps`) and runs AFTER
`expandMacrosForStacks`, so a macro-introduced `Fn::ImportValue` is visible to
the sort.

## Exports-index repair

`scrubCommand` builds one `ExportIndexStore` per REGION it touched (the index key
embeds the region) and runs one pass per scrubbed stack, AFTER `scrubStack`
returned. `planExportIndexRepair` decides per entry:

- **Ownership from `entry.producerStack` / `producerRegion`, never from the
  NAME** — a pre-v9 record makes every output key importable, so an entry can be
  keyed by a plain output name.
- **Convergence**: when `state.outputs[<entry name>]` carries `{{resolve:` and
  the entry's value differs (compared through `JSON.stringify`, since a
  list-valued `Fn::GetAtt` Output persists an array), `patchEntry` rewrites the
  entry to the state value. It changes the VALUE only, adding and removing no
  name. It is NOT a byte match against scrub's plaintext map: that map is built
  by LIVE RESOLUTION, so after a rotation it holds the current value while the
  entry holds the legacy one — exactly the entry a match would miss. The bag
  compared is the POST-scrub one, so `--dry-run` audits what a real run would
  write.
- Three reported-not-written cases: an entry `patchEntry` returned `false` for,
  or a region whose index could not be read, raises
  `SCRUB_EXPORT_INDEX_INCOMPLETE` (exit 2) rather than warning — a swallowed
  failure leaves the value in a region-wide object readable with `s3:GetObject`
  alone, and the convergence rule makes a re-run write only the remainder; an
  owned entry whose name is ABSENT from `state.outputs` is warned and left; and
  an entry whose producer this run did not scrub is reported as COVERAGE and
  never reddens `--fail` (one bucket and region are shared by several apps).
- `readPersistedEntries` is a GET only, with no missing/corrupt REBUILD, because
  `--dry-run` writes nothing; `patchEntry` returns a boolean because
  `runWithRetry` swallows a failed write.
