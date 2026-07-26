---
description: cdkd synthesis layer (CDK app subprocess execution, Cloud Assembly parsing, context providers)
paths:
  - 'src/synthesis/**'
---

# Synthesis

- Synthesis orchestration (no external CDK toolkit dependencies; CDK app itself generates templates)
- `AppExecutor` runs CDK app as subprocess with env vars (CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION, etc.)
- `AssemblyReader` parses Cloud Assembly manifest.json directly (recursively traverses nested assemblies for CDK Stage support). Each `StackInfo` carries `messages` — the stack's CDK annotation messages (`Annotations.addError` / `addWarning` / `addInfo`), collected by `stack-messages.ts`'s `collectStackMessages` from BOTH on-disk layouts: the artifact's inline `metadata` field (older aws-cdk-lib) AND the `<artifactId>.metadata.json` side file referenced by `additionalMetadataFile` (current aws-cdk-lib). A referenced-but-unreadable side file throws (fail-closed — silently continuing could hide an error annotation that must block deploy).
- `stack-messages.ts` also owns `processStackMessages(stacks, logger, options?)` — CDK CLI parity for annotations (issues #1228 / #1230): logs every message at its level (`[Error|Warning|Info at /path] …`), then throws `SynthesisError('Found errors')` when any stack carries an error annotation. `StackMessageOptions` mirrors the CDK CLI's failAt resolution: `strict` (the `--strict` flag) additionally throws `SynthesisError('Found warnings (--strict mode)')` on any warning (errors win when both exist); `ignoreErrors` (the `--ignore-errors` flag) displays but never throws; strict overrides ignoreErrors when both are set. Called by `synth` (all stacks) and `deploy` (selection-aware: after the final target-stack set incl. auto-included dependencies, before macro expansion / any AWS mutation — an error in a non-selected sibling does not block the deploy, mirroring #1150); both commands register the shared `annotationMessageOptions` pair from `src/cli/options.ts`. `diff` / `list` / other synth-driven commands deliberately do NOT fail on error annotations (upstream `cdk diff` does not either).
- `Synthesizer` orchestrates synthesis with context provider loop for missing context resolution
- Context providers: see `src/synthesis/context-providers/` for full list (in `src/synthesis/context-providers/`)
- `ContextStore` manages cdk.context.json read/write
