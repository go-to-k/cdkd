---
description: cdkd synthesis behaviour (app subprocess, assembly parsing, context)
paths:
  - 'src/synthesis/**'
---

# Synthesis

No external CDK toolkit dependency — the CDK app generates the templates.
Per-module notes: [layout-synthesis.md](layout-synthesis.md).

- **`AppExecutor.guessExecutable` reads only the FIRST token** of the `app`
  command. A bare `.js` entrypoint (quoted or not, with or without trailing
  args) is run as `"<node>" "bin/app.js" …`; everything else — a command that
  already names its runner (`node bin/app.js`, `npx tsx bin/app.js`) and every
  `.ts` entrypoint — goes to the shell verbatim.
  Testing the WHOLE string for a `.js` suffix also matched a command carrying
  its own runner and rewrote token 0 into `"node" "node" bin/app.js`, failing
  every `cdk init --language javascript` app with `MODULE_NOT_FOUND`. This
  mirrors upstream `guessExecutable`, which prefixes an interpreter only when
  the referenced token is a real file on disk.
- `AssemblyReader` parses `manifest.json` directly and recurses into nested
  assemblies for CDK Stage support. Each `StackInfo` carries `messages`, the
  stack's CDK annotations, collected from BOTH on-disk layouts (inline
  `metadata` and the `additionalMetadataFile` side file); an unreadable side
  file THROWS, since continuing could hide an error annotation that must block
  the deploy.
- `Synthesizer` drives the context-provider loop; `ContextStore` reads and
  writes `cdk.context.json`.
