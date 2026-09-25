---
description: CLI configuration resolution, options precedence, stack-name matching, concurrency / timeout flags
paths:
  - 'src/cli/**'
---

# CLI Configuration Resolution

Implemented in `src/cli/config-loader.ts`; option parsing in
`src/cli/options.ts`.

## Option resolution

- **`--app` / `-a`** — optional: `CDKD_APP`, then `cdk.json`'s `"app"`. Accepts a
  shell command or a path to a pre-synthesized assembly directory; given a
  directory, synthesis is skipped and the manifest is read directly.
- **`--state-bucket`** — optional: `CDKD_STATE_BUCKET`, then `cdk.json`
  `context.cdkd.stateBucket`. `cdkd publish-assets` accepts it too (it reads the
  per-region asset-storage bootstrap marker to pick legacy vs cdkd-assets
  destinations; no state writes).
- **`--use-cdk-bootstrap-assets`** (deploy / diff / import / publish-assets) —
  pins legacy asset destinations for one invocation even when the region's
  bootstrap marker exists; per-app pin via `cdk.json`
  `context.cdkd.useCdkBootstrapAssets`. CLI `true` wins, then the cdk.json
  boolean, default `false`; there is no `--no-` negation form.
- **`--region`** — on `cdkd bootstrap` it picks the region of the new state
  bucket AND of the cdkd-owned asset storage, and under `bootstrap --destroy`
  which region's asset storage to tear down. On every other command it is
  DEPRECATED but still honored: a hidden `deprecatedRegionOption` that warns
  once and IS the highest-precedence region source
  (`options.region || AWS_REGION || 'us-east-1'`), injected into
  `process.env.AWS_REGION` by deploy / destroy / import / export / orphan so the
  synth subprocess inherits it. **It is NOT a no-op** — do not "clean up" a
  fixture's `--region`. The state-bucket S3 client still auto-detects the
  bucket's region via `GetBucketLocation`, independent of the flag.
- **`--context` / `-c`** — repeatable `key=value`, merged over cdk.json context.
- **`-y` / `--yes`** is global; `cdkd destroy` also takes `-f` / `--force` with
  the same effect there.

## Stack selection

Stack names are POSITIONAL (`cdkd deploy MyStack`), a single stack is
auto-detected, `--all` targets all stacks (for `destroy`, only those the current
app synthesizes), and wildcards work (`cdkd deploy 'My*'`). Both forms are
accepted, CDK-CLI parity: a pattern containing `/` matches the hierarchical
DISPLAY PATH, one without matches the PHYSICAL name — so `'MyStage/*'` works.
For `destroy`, display-path matching needs synth to succeed, because state alone
carries physical names. Implemented in `src/cli/stack-matcher.ts`.

## stdout is a PAYLOAD on some commands

`cdkd list`, `cdkd synth`, `cdkd state list`, `cdkd local invoke` and
`local invoke-agentcore` call `reserveStdoutForPayload()` unconditionally at
entry and send all logger prose to stderr — **`--json` picks the payload's
ENCODING, not whether stdout is one**. The discriminator is a line-oriented
RECORD SET versus a formatted human VIEW: `state resources` / `state show` /
`state info` keep their `--json` gate, while `state list --long` / `--tree` are
views swept along by a reservation taken before the mode is known. `cdkd deploy`
and the long-running `local start-*` servers deliberately keep human stdout. On
the two `local invoke*` commands the reservation covers cdkd's logger only —
`streamLogs`' container pipe and cdk-local's separate logger still reach stdout,
so their payload is the LAST stdout line, not the whole stream. Contract in
`docs/cli-reference.md`, "Output streams: when stdout is a payload".

## Concurrency and per-resource deadlines

- `--concurrency` (resource ops, 10), `--stack-concurrency` (4),
  `--asset-publish-concurrency` (8), `--image-build-concurrency` (4).
- `--resource-warn-after` (default `5m`) and `--resource-timeout` (default
  `30m`) on deploy / destroy / state destroy. Both are REPEATABLE and take
  either form: a bare `<duration>` sets the global default, `<TYPE>=<duration>`
  adds a per-type override. Resolution per call:
  `perTypeMs[resourceType] ?? max(provider.getMinResourceTimeoutMs?.(), slowCcOperationTimeoutMs(type, op), globalMs) ?? compileTimeDefault`
  — a per-type CLI override always wins; otherwise the deadline is lifted for
  that type by whichever is larger of the provider's self-reported minimum (the
  Custom Resource provider reports its 1h polling cap) and the known-slow-type
  floor in `src/provisioning/slow-cc-operation-timeouts.ts`, which ALSO lifts
  `CloudControlProvider`'s internal poll cap so a CC-routed slow DELETE is not
  aborted mid-delete.
  The warn timer mutates the live renderer's task label in place; the hard timer
  throws `ResourceTimeoutError`, wrapped as `ProvisioningError` at the same site
  as any other provider failure, so rollback and state preservation run
  unchanged. Rejected at parse time: zero, negative, missing or unknown unit, a
  malformed `TYPE`, and `warn >= timeout` (globally and per type). Cancellation
  is `Promise.race`-style — the provider call keeps running after the timer
  fires. Helper `src/deployment/resource-deadline.ts`.

## Confirmation prompts

**Every MUTATING confirmation prompt REFUSES a non-interactive stdin** rather
than hanging on a question an EOF stdin can never settle
([#2275](https://github.com/go-to-k/cdkd/issues/2275)). The sites route through
one helper, `confirmOrRefuse` in
[src/cli/commands/confirm-prompt.ts](../../src/cli/commands/confirm-prompt.ts),
which throws `CdkdError` with code `NON_INTERACTIVE_CONFIRM` (exit 1) BEFORE
`readline.createInterface`. Each call site sits INSIDE its command's `--yes` /
`--force` short-circuit, so a flagged run never consults stdin, and supplies its
own refusal message naming that command's flag. `promptYesNo` in the same module
is the deliberate default-YES carve-out (`deploy.ts` short-circuits on a non-TTY
before reaching it); `destroy-runner.ts` and `state destroy --all` keep their own
inline guards. `tests/unit/cli/readline-prompt-population.test.ts` fences the
POPULATION: every `readline.createInterface` in `src/` must be listed with a
reason, so a new unguarded copy cannot be written.

## The two unsupported-* escape hatches

- **`--allow-unsupported-types <types>`** (deploy + destroy) — cdkd rejects Tier
  3 (`ProvisioningType: NON_PROVISIONABLE`) types in a pre-flight, from the
  generated `src/provisioning/unsupported-types.generated.ts`. The flag is
  comma-separated and repeatable, PER TYPE so each is named explicitly; listed
  types join `ProviderRegistry.allowedUnsupportedTypes` and are routed through
  Cloud Control optimistically. It exists for a cached-Tier-3 type AWS has since
  made provisionable. Destroy threads it through
  `DestroyRunnerContext.allowUnsupportedTypes`, so a stack deployed with the flag
  stays destroyable.
- **`--allow-unsupported-properties <entries>`** (deploy only) — the
  property-level analogue over the generated
  `src/provisioning/property-coverage.generated.ts`. A silent-drop property
  ([#614](https://github.com/go-to-k/cdkd/issues/614)) REPORTS rather than rejects and auto-routes that resource through Cloud
  Control; each `<ResourceType>:<PropertyName>` token opts back INTO the drop,
  keeping the resource on the SDK route — and the property is then not written to
  the STATE record either, so removing the flag lets the auto-route deliver it
  (except a create-only one). The check runs AFTER `validateResourceTypes`, and
  is a no-op for a Tier 2 / Custom / unknown type. Properties absent from the CFn
  schema (`addPropertyOverride` escape hatches, typos) and read-only properties
  pass through silently.
