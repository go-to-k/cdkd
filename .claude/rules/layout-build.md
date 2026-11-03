---
description: cdkd build-time surface (src/version.ts, Vite+ config)
paths:
  - 'src/version.ts'
  - 'vite.config.ts'
---

# Build config and version

- **vite.config.ts** — Vite+ config for build, test, lint, format, tasks.
- **src/version.ts** — the build-time version (`getCdkdVersion()`, injected by
  tsdown's `define`, with the `DEV_VERSION_SENTINEL` fallback where the define
  has not run) plus `isVersionOnlyInvocation()`, the predicate behind
  `index.ts`'s `--version` fast path
  ([#2002](https://github.com/go-to-k/cdkd/issues/2002)).

  It sits at the top of `src/` and has **no imports on purpose**: `index.ts`
  answers a bare `--version` from it BEFORE `await import('./program.js')`, and
  any import here puts a module graph back on that path — the loader compiling
  the externalised `@aws-sdk/*` packages every command module pulls in.

  The predicate is deliberately narrower than "the argv contains a version
  flag": it requires the argv to be EXACTLY one flag, so it does not DEPEND on
  commander's precedence and is not a second spelling of commander's parse. What
  it refuses falls through to that parse, so refusing too much costs only the
  slow path. The branch
  is fenced by `tests/unit/cli/version.test.ts`, which stubs the command-tree
  chunk with a throwing module: the size bound and the predicate's own unit
  tests both stay GREEN when the branch is deleted.

  `deployment-events-store.ts` RE-EXPORTS `getCdkdVersion` rather than
  re-deriving it.
