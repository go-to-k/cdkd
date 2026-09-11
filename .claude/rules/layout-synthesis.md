---
description: cdkd layout notes for the synthesis layer (CDK app execution, Cloud Assembly parsing, macros, annotations)
paths:
  - 'src/synthesis/**'
---

# Key Files and Directories - synthesis

Split out of the former `layout-misc.md`, whose six globs made every
`src/synthesis` / `src/state` / `src/assets` / `src/types` edit load all four
areas' notes. Each file here carries a glob as narrow as its content.

Index of every area: [code-layout.md](code-layout.md).

## Core Directory

- **src/synthesis/** - CDK app synthesis (self-implemented: subprocess execution, Cloud Assembly parsing, context providers)

## Important Files

- **src/synthesis/** - CDK app synthesis (self-implemented: subprocess execution, Cloud Assembly parsing, context providers)

- **src/synthesis/app-executor.ts** - Executes CDK app as subprocess with proper env vars (CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION, etc.)

- **src/synthesis/assembly-reader.ts** - Reads and parses Cloud Assembly manifest.json directly

- **src/synthesis/synthesizer.ts** - Orchestrates synthesis with context provider loop. After the loop settles, routes any template that {@link containsMacro} flags through `src/synthesis/macro-expander.ts` BEFORE returning to the analyzer / provisioner pipeline (Issue #463). Since issue #1150 the pass is selection-aware: `SynthesisOptions.deferMacroExpansion` skips it inside `synthesize()`, and the now-public `expandMacrosForStacks(stacks, options)` is invoked by `deploy` / `diff` AFTER stack selection with only the stacks they will consume (a macro-carrying sibling outside the selection never triggers a CFn round-trip); `list` and `destroy` defer and never expand (names come from the manifest, destroy works off cdkd state). Macro region resolution falls back to the AWS SDK default chain (`resolveSdkDefaultRegion` - shared config profile region etc.) before hard-erroring (issue #1149), and the STS hop for the default state bucket only runs when a selected stack actually carries a macro.

- **src/synthesis/macro-detector.ts** - Pure-functional `containsMacro(template)` / `enumerateMacros(template)` helpers (Issue #463). Detect top-level `Transform: [...]` AND nested `Fn::Transform: {...}` blocks anywhere under `Resources` / `Outputs` / `Mappings` / `Conditions` / `Rules`. Skip `Metadata` keys at any depth (CFn does not expand transforms inside metadata). Tolerate malformed inputs without throwing so the rest of the synthesis pipeline surfaces the malformed-template error.

- **src/synthesis/macro-expander.ts** - CloudFormation macro round-trip helper (Issue #463 Phase 2; design at [docs/design/463-cfn-macros.md](../../docs/design/463-cfn-macros.md)). Issues a transient `CreateChangeSet --change-set-type CREATE` (which auto-creates the stack in `REVIEW_IN_PROGRESS`, no prior `cdkd-macro-expand-*` stack needed — Q1 empirically verified 2026-05-23), waits for `ChangeSetStatus: CREATE_COMPLETE`, fetches `GetTemplate --template-stage Processed` (returns the post-expansion template; the SDK types the field as `string | undefined` but the wire shape may be a parsed object — the helper handles both), and cleans up via `DeleteChangeSet` + `DeleteStack` in a `finally` block (both NotFound-tolerant). For templates that declare `Parameters` without `Default`, passes synthetic placeholder values (CFn rejects `CreateChangeSet` otherwise; the values do NOT leak into the Processed-stage template — `Ref: <param>` survives intact for cdkd's own resolver). Inline `TemplateBody` for templates <= 51,200 bytes; uploads to the cdkd state bucket and submits `TemplateURL` for (51,200, 1 MB]; refuses outright above 1 MB. Multi-stage macros (an expanded template that still contains a macro) hard-error with a clear pointer at the design's "out of scope for v1" note. Throws `MacroExpansionError` (exit code 2) on every failure mode. Intermittent `AWS::EarlyValidation::*` hook rejections of the transient changeset (issue #1151) are retried up to 3 attempts with a fresh transient stack name and 2s/4s backoff (`retryDelays.sleep` is the test seam) before the error surfaces.

- **src/synthesis/stack-messages.ts** - CDK annotation-message handling (issues #1228 / #1230). `collectStackMessages(assemblyDir, artifact)` gathers `aws:cdk:error` / `aws:cdk:warning` / `aws:cdk:info` entries from the artifact's inline `metadata` AND its `additionalMetadataFile` side file (`<artifactId>.metadata.json` — the layout current aws-cdk-lib uses instead of inlining; unreadable or wrong-shape referenced side file throws, fail-closed) into `StackInfo.messages`. `processStackMessages(stacks, logger, options?)` is the CDK-CLI-parity gate: logs every message at its level (`[Error|Warning|Info at /path] …`), throws `SynthesisError('Found errors')` when any given stack carries an error annotation; `StackMessageOptions.strict` (the `--strict` flag) additionally throws `SynthesisError('Found warnings (--strict mode)')` on warnings, `ignoreErrors` (`--ignore-errors`) displays-but-never-throws, strict wins over ignoreErrors (CDK CLI failAt precedence). Wired into `synth` (all stacks) and `deploy` (final selection, before macro expansion / AWS mutations) via the shared `annotationMessageOptions` in `src/cli/options.ts`; other synth-driven commands intentionally unaffected.

- **src/synthesis/context-providers/** - Context providers (see `src/synthesis/context-providers/` for full list) for missing context resolution
