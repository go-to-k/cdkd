---
description: cdkd codegen and audit scripts, their docs/_generated outputs, CI critics
paths:
  - 'scripts/**'
  - 'docs/_generated/**'
---

# Key Files and Directories - scripts and docs/_generated

Every area: [code-layout.md](code-layout.md).

## Important Files

- **scripts/gen-enrichment-coverage.ts** + **docs/_generated/enrichment-coverage.{json,md}** - CC-API enrichment-coverage matrix + critic (`gen:enrichment-coverage` / `audit:enrichment-coverage:check`). BLOCKS only on `unenriched-computed`, a gap on a pure-CC type; a readOnly `primaryIdentifier` prop is not one.

- **scripts/gen-sdk-attr-coverage.ts** + **docs/_generated/sdk-attr-coverage.{json,md}** - SDK-provider ARN/URL attribute-coverage matrix + critic (`gen:sdk-attr-coverage` / `audit:sdk-attr-coverage:check`) for the GetAtt-key class, an ARN recorded under a non-CFn key. Detail: [sdk-attr-coverage-critic.md](sdk-attr-coverage-critic.md).

- **scripts/gen-update-wrap-coverage.ts** + **docs/_generated/update-wrap-coverage.{json,md}** - SDK-provider `update()` error-wrapping matrix + critic (`gen:update-wrap-coverage` / `audit:update-wrap-coverage:check`), BLOCKING on `gap`, `unguarded-wrap`, `unresolved-callee`. A wrapping `catch` that can capture a control-flow typed error MUST re-throw the CAUGHT BINDING, nothing else.

- **scripts/gen-drift-readback-coverage.ts** - Drift readback coverage (#6696, CI `:check`): fails on a handled property its provider's own files never name, a stale baseline row, an unresolved `this.x()`.

- **scripts/{cc-update-measurements,gen-cc-update-measurements}.ts** + **docs/_generated/cc-update-measurements.{json,md}** - Measured Cloud Control update table (#6676; `:check` in CI): a `refuses` row needs exactly one `fix` / `exemption`, and every fix helper's type needs its row. A `clean` row proves only the probed property.

- **scripts/gen-nested-key-coverage.ts** + **docs/_generated/nested-key-coverage.{json,md}** - Nested CFn -> SDK SHAPE-divergence matrix + critic (`gen:nested-key-coverage` / `audit:nested-key-coverage:check`), BLOCKING on `array-vs-wrapper` and `definition-member-missing`. Its hand-off walk only decides which paths a generic converter delivers whole (PR #4324); a member sent misspelled, misplaced or not at all is the sdk-wire harness's (`tests/unit/provisioning/sdk-wire-*.ts`).

- **scripts/audit-stateful-candidates.ts** + **docs/_generated/stateful-candidates.{json,md}** - Tier-2 stateful-candidate derivation, a THIRD lower bound on `STATEFUL_TYPES` (issue [#2553](https://github.com/go-to-k/cdkd/issues/2553)); `:regenerate` calls AWS, `:check` is the offline critic. The other two derive from `providers/**`, blind to tier 2. It PROPOSES a type with a `createOnlyProperties` entry AND a data-bearing signal; one in NEITHER the candidate list nor the `NOT_GUARDED` map FAILS `--check`.

- **scripts/check-integ-capture-shape.ts** - Abort-shaped capture fence for `tests/integration/*/verify.sh` (issue [#3126](https://github.com/go-to-k/cdkd/issues/3126)); the unit test `integ-verify-capture-shape.test.ts` IS the enforcement. Under `pipefail`, `V=$(cmd 2>/dev/null | tail -1)` aborts at the assignment with stderr already discarded; the rule and the correct `capture` form are in [abort-capture.md](abort-capture.md). It also BLOCKS a `verify.sh` without pipefail, where the shape is undefined.

- **scripts/check-source-control-bytes.ts** - Stray-control-byte working-tree sweep; `source-control-bytes.test.ts` IS the enforcement. A raw NUL is valid in a string literal and runtime-identical, so every gate passes, but `grep` / `rg` classify the whole FILE as BINARY and silently skip it at exit 0 while `git grep` is UNAFFECTED. It rejects every C0 byte plus DEL except TAB / LF.

- **scripts/check-docs-error-strings.ts** - Quoted-error fence for `docs/**` (#2757), enforced by `docs-error-strings.test.ts`. A fenced `SomeError: some text` line must satisfy two decidable halves: `SomeError` is a name cdkd assigns, and the message instantiates a real TEMPLATE. **A truncated quotation (`...`) is REFUSED** before the match, since a trailing hole absorbs the dots.

- **scripts/check-provider-error-cause.ts** - Cause-threading critic for `catch` sites across all of `src/` (issues [#2040](https://github.com/go-to-k/cdkd/issues/2040), [#2075](https://github.com/go-to-k/cdkd/issues/2075)), run by `vp run audit:provider-error-cause:check`. cdkd's transient-error classifiers walk `.cause`, so a wrapper NOT threading the caught value makes them INERT for that call. Threading is checked STRUCTURALLY, not by name.
  - A DERIVED cause is refused, except through a `CAUSE_COMPOSERS` entry (`redactedDockerCause`, `redactedAwsCause`, `normalizeAwsError`, `maskSecretsInError`) IMPORTED from its registered module. The critic believes the registration; the RUNTIME twin `cause-composers-classify.test.ts` proves each composer keeps the classifier verdict, and fails on a composer it has no case for.
  - A deliberate omission goes in `EXEMPTIONS` (file + class + enclosing function + EXACT count + reason); a count that stops matching fails in both directions.

- **scripts/check-replaced-delete-deferral.ts** - Early-delete critic (issue [#6713](https://github.com/go-to-k/cdkd/issues/6713)), run by `vp run audit:replaced-delete-deferral:check`. A replaced resource's old copy is deleted only through the cleanup-phase deferral (`deferToCleanupPhase` -> `retryDeferredReplacedDeletes`); every other site that deletes it during a deploy needs an `EXCEPTIONS` entry naming why it cannot defer and how the rollback reports the loss. The script's header defines the class and what is outside it.

- **scripts/check-secret-physical-id-log.ts** - Secret-physical-id critic (issue [#6716](https://github.com/go-to-k/cdkd/issues/6716)); `secret-physical-id-log.test.ts` IS the enforcement. An engine / CLI line rendering a physical id wraps it in `displayPhysicalId(<type>, <id>)`: a bag never holds an id minted this deploy. Schema `P` / `P{String,Substitutions}` pairs need the redaction's `RENDERED_DEFINITION_KEYS` / `DEFINITION_SOURCE_KEYS`.

- **scripts/check-provider-secret-mask.ts** - Pre-stringify secret-mask critic for provider message sites (#2178), run by `vp run audit:provider-secret-mask:check`. [provider-masking.md](provider-masking.md) requires a `properties`-derived value interpolated into a message to be masked BEFORE `JSON.stringify`, which escapes `"` / `\` / newlines so the finished message cannot be recovered.
  - The masker set is DERIVED then grown to a FIXPOINT. **An IDENTITY masker is REFUSED in BOTH positions** — the derivation ROOT and the shared walk's MASKER ARGUMENT, where a root-only refusal is inert; that argument is an ALLOW-LIST, not a deny-list, the set of no-op spellings being unbounded. **BOUND**: a no-op DECLARED to be the capability is still believed, so state the fence as "the value reached something DECLARED to be the project's masker". It checks SHAPE, so it needs the RUNTIME twin `<provider>-masked-warn.test.ts`, whose secret contains a quote and a newline: a plain alphanumeric one passes even with masking AFTER the stringify.
  - **BOUND (#5845)**: the population is `${JSON.stringify(...)}` ONLY; a bare `${x}` is the SINK's job (`currentLogLineMasker()` in `src/utils/log-line-masker.ts`, `DeployEngine`'s thrown-message mask, a provider's masking `warn` wrapper), since it is not escaped. A site whose per-value wrap matters (a short secret) gets a runtime twin: `dynamodb-table-provider-masked-warn.test.ts` pins `src/provisioning/providers/dynamodb-table/update-billing.ts`'s `maskSecrets(n)`.

- **scripts/check-withretry-interrupt.ts** - Interrupt-threading critic for `withRetry` call sites under `src/provisioning/**` (issue [#2053](https://github.com/go-to-k/cdkd/issues/2053)), run by `vp run audit:withretry-interrupt:check`. `withRetry` is the ONLY cdkd wait consulting an interrupt DURING a backoff, so a call omitting `isInterrupted` / `onInterrupted` leaves Ctrl-C dead for its schedule. BOTH must be DIRECT properties of an options OBJECT LITERAL: half a pair is a defect; a conditional spread does not count (absent whenever its guard is falsy).

- **scripts/check-aws-client-defaults.ts** + **tests/aws-client-defaults-allowlist.json** - AWS SDK client construction critic (`vp run audit:aws-client-defaults:check`). Documented in [proxy-support.md](proxy-support.md).

- **scripts/check-local-reachability.ts** - Symbol-level reachability critic for `src/local/**` (#2228), via `vp run audit:local-reachability:check`. Every exported VALUE symbol with a cdkd-authored body must be transitively reachable from a shipped entry point (`pack.entry` in `vite.config.ts`) or carry `@no-live-caller` / `@test-only-export` at its declaration. SYMBOL-level: a live importer does not make its exports live. Biased toward LIVE: a clean run is no proof a symbol executes.

- **scripts/check-provider-update-context.ts** - SDK-provider `UpdateContext` declaration fence (#2613); `provider-update-context.test.ts` enforces it. `context` is OPTIONAL, so a provider omitting it compiles while `assertRegionMatch` never runs for it. Nothing reds, so `OMITS_UPDATE_CONTEXT` records the omitting set BY NAME.
  - The unit is the CLASS, not the file, and membership is `create` + `update` + `delete` being present, not the OPTIONAL `implements ResourceProvider` keyword or `async`. Declaring is STRUCTURAL; every other shape is REFUSED, not bucketed: the 6th parameter must be a plain identifier annotated `UpdateContext`, bound by an import resolving to [src/types/resource.ts](../../src/types/resource.ts). An inherited `update` is left to the RUNTIME half (every registered provider's `update.length` must agree).

- **scripts/check-module-scope-mock-defaults.ts** - Mock-default fence for `tests/unit/**` (#6928), guarding `mockReset: true` in `vite.config.ts`; `module-scope-mock-defaults.test.ts` IS the enforcement (it also fails if the setting is removed), `vp run audit:module-scope-mock-defaults:check` runs it by hand. A setter `mockReset` wipes (`mockImplementation` / `mockReturnValue` / `mockResolvedValue` / ... and every `*Once`) is safe only in a `beforeEach` or a test body; `vi.fn(impl)` survives the reset and is the remedy. Every other site is refused, no allow-list. Class and bounds: the script header; the rule: [testing.md](testing.md).

- **scripts/check-observed-properties-redaction.ts** - `observedProperties` writer critic (#6765); its test IS the enforcement. Each written value must come from the state redaction or a stored bag, followed through helpers, callbacks and escaped containers.

- **scripts/refresh-cfn-schemas.mjs** and its refresh chain. It PRODUCES `tests/fixtures/cfn-schemas/*.json`, the offline oracle every coverage critic and the deploy-time SDK-vs-Cloud-Control routing table are derived from. Full entries — the two capture sources and one fixture shape, the collapse floors, the offline removal classifier, the decision hand-off, and the backfill campaign's generated per-type issues — in [layout-schema-refresh.md](layout-schema-refresh.md).

- **The CI checks on GitHub artifacts** — `scripts/check-pr-title-prefix-scope.ts`, `check-pr-non-english-text.ts` (+ `scripts/non-english-allowlist.txt`), `check-gh-body-english.ts`, `check-issue-classification-labels.ts` and the shared `scripts/gh-subject.ts`, run from `.github/workflows/{pr-title-check,pr-content-checks,issue-conventions}.yml`. Their subject is a GitHub artifact, not `src/`: no `audit:*` task, no `docs/_generated` output. Full entries: [layout-ci-checks.md](layout-ci-checks.md).
