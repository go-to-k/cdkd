---
description: cdkd synthesis layer (CDK app execution, assembly parsing, macros, annotations)
paths:
  - 'src/synthesis/**'
---

# Layout - synthesis

Self-implemented. **app-executor.ts** runs the CDK app as a subprocess with
`CDK_OUTDIR` / `CDK_CONTEXT_JSON` / `CDK_DEFAULT_REGION`; **assembly-reader.ts**
parses `manifest.json`; **context-providers/** resolves missing context.

- **synthesizer.ts** orchestrates the context-provider loop, then routes any
  template `containsMacro` flags through `macro-expander.ts` BEFORE the analyzer
  / provisioner pipeline. The pass is SELECTION-AWARE: `deferMacroExpansion`
  skips it inside `synthesize()`, and `expandMacrosForStacks` runs from `deploy`
  / `diff` AFTER selection over only the stacks they consume, so a
  macro-carrying sibling outside the selection never triggers a CFn round-trip;
  `list` and `destroy` never expand. The STS hop for the default state bucket
  runs only when a SELECTED stack carries a macro.
- **macro-detector.ts** — pure `containsMacro` / `enumerateMacros`: top-level
  `Transform: [...]` AND nested `Fn::Transform: {...}` anywhere under
  `Resources` / `Outputs` / `Mappings` / `Conditions` / `Rules`, SKIPPING
  `Metadata` at any depth (CFn does not expand transforms there) and tolerating
  malformed input so the malformed-template error surfaces downstream.
- **macro-expander.ts** — the CFn round-trip
  ([docs/design/463-cfn-macros.md](../../docs/design/463-cfn-macros.md)). A
  transient `CreateChangeSet --change-set-type CREATE` auto-creates the stack in
  `REVIEW_IN_PROGRESS`; `GetTemplate --template-stage Processed` is typed
  `string | undefined` but may arrive parsed — handle both; cleanup runs in a
  NotFound-tolerant `finally`. `Parameters` without `Default` get synthetic
  placeholders, which do NOT leak into the Processed template. Inline up to
  51,200 bytes, `TemplateURL` up to 1 MB, refusal above; a still-macro-carrying
  expansion hard-errors.
- **stack-messages.ts** — `collectStackMessages` gathers `aws:cdk:error` /
  `warning` / `info` from the artifact's inline `metadata` AND its
  `additionalMetadataFile` side file; an unreadable or wrong-shape side file
  THROWS, fail-closed. `processStackMessages` throws on an error annotation,
  `--strict` also throws on warnings, `--ignore-errors` never throws, and strict
  WINS over ignoreErrors. Wired into `synth` (all stacks) and `deploy` (final
  selection, before macro expansion and any AWS mutation) only.
