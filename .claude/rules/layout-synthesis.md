---
description: cdkd synthesis layer (CDK app execution, assembly parsing, macros, annotations)
paths:
  - 'src/synthesis/**'
---

# Layout - synthesis

Self-implemented. **app-executor.ts** runs the CDK app as a subprocess with
`CDK_OUTDIR` / `CDK_CONTEXT_JSON` / `CDK_DEFAULT_REGION`; **assembly-reader.ts**
parses `manifest.json`; **context-providers/** resolves missing context.

- **`displaySafe` is the DEFAULT at every render of an assembly-, manifest- or
  template-derived value, in thrown messages AND in ordinary `logger.info` /
  `debug` lines** ([#3479](https://github.com/go-to-k/cdkd/issues/3479)) — not a
  judgement per message: an "only where untrusted" boundary is not
  decidable per message, and the helper neither quotes nor truncates, so it is
  the identity on every legitimate value. Adopted in `synthesizer.ts`,
  `macro-expander.ts` and `src/synthesis/context-providers/index.ts` (where the
  `provider` / `key` LOOKUP stays raw and the provider failure text takes
  `displayAwsMessage`, since a lookup argument echoed back makes the LENGTH
  attacker-chosen too). **Not yet everywhere**: the lookup arguments inside
  `context-providers/*-provider.ts` and `stack-messages.ts`'s annotation display
  are open rows on that issue. A joined list sanitizes per ELEMENT so the
  separator stays byte-exact; `displaySafe` replaces globally, so that is a
  formatting rule, not a safety one.
- **assembly-reader.ts** renders EVERY assembly-derived value — a manifest key,
  a `stackName`, a template key, a `Metadata['aws:asset:path']`, a
  `directoryName`-derived path, a `readFileSync` / `JSON.parse` failure text —
  through `displaySafe`, in thrown messages AND log lines
  ([#3277](https://github.com/go-to-k/cdkd/issues/3277)). Synthesis is the first
  layer the CLI reaches, so on a hand-modified assembly these ARE the lines a
  user is asked to trust, and `formatError` sanitizes and bounds only an
  error's `cause`, never the message a thrower builds.
  The split is by what the value IS, not by where it came from: a PATH or
  free-form text takes `displaySafe`, which must leave a legitimate asset path
  untruncated and unquoted; an IDENTIFIER interpolated into prose takes
  `displayIdent`, because there the denylist's tolerance of quotes, spaces and
  C1 bytes lets a crafted value write a cdkd-sounding clause or erase the line
  with `ESC [ 2 K`. Today that second class is a Stage's path and the
  stack names listed after `Available:`
  ([#3482](https://github.com/go-to-k/cdkd/issues/3482)); `describeStack` in
  `src/cli/stack-matcher.ts` applies the same rule to the same values for every
  other command. `stack-messages.ts`'s side-file refusal follows the
  same rule; its annotation DISPLAY does not YET — an open residual on
  [#3479](https://github.com/go-to-k/cdkd/issues/3479), blocked on a helper that
  preserves newlines, NOT a settled decision: that prose is the user's own app's
  only when an app ran, which `-a <dir>` skips.
- Every path those two build from the manifest — `directoryName`,
  `templateFile`, an asset-manifest `file`, `Metadata['aws:asset:path']`,
  `additionalMetadataFile` — goes through `resolveAssemblyPath`
  ([layout-utils.md](layout-utils.md),
  [#3489](https://github.com/go-to-k/cdkd/issues/3489)) BEFORE the read, keeping
  its own refusal distinct from the absolute-path tripwire beside it.
- **failed-stages.ts** - `stageLoadError` / `StageLoadError` (a Stage whose own
  manifest cannot be read), `renderStagePath` and `stageScopedError` (the
  re-raise that names the Stage, marked so only the innermost one is named). A
  Stage path is rendered through `renderStagePath` (`displayIdent`, capped at
  `STACK_REF_MAX_CODE_POINTS` so a deep path is not cut), never `displaySafe`:
  it is interpolated into prose, where a denylist's tolerance of quotes and
  spaces is a spoof surface.
- **Nothing is tolerated while reading a Stage** (`cdk:cloud-assembly`). A
  Stage whose own `manifest.json` cannot be read throws `stageLoadError`, FATAL
  for every command as in the AWS CDK CLI
  ([#3507](https://github.com/go-to-k/cdkd/issues/3507)): tolerating it once
  (#3482) let `--all`, bare and wildcard runs act on the stacks that loaded and
  exit 0. Its reason is BUILT here — an errno `code`, `invalid JSON` or
  `unreadable`, plus the rendered directory — never the caught text, which
  embeds a path carrying the assembly-chosen `directoryName` twice, nor a
  `JSON.parse` snippet, which echoes the file's own bytes. Every refusal raised
  under a Stage propagates, re-raised with the INNERMOST Stage named.
  `destroy` rethrows a `StageLoadError` instead of taking its synth-failure
  state fallback (#3839), and `scrub` maps it to a refusal (exit 2,
  `SCRUB_STAGE_LOAD_FAILED`), never `--fail`'s exit 1.
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
  ([docs/_contents/design/463-cfn-macros.md](../../docs/_contents/design/463-cfn-macros.md)). A
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
  WINS over ignoreErrors. Wired into `synth` (the SELECTED stacks — the whole
  app when no name is given, go-to-k/cdkd#3550) and `deploy` (final
  selection, before macro expansion and any AWS mutation) only.
