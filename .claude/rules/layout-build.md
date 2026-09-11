---
description: cdkd layout notes for the build-time surface (src/version.ts and the Vite+ config)
paths:
  - 'src/version.ts'
  - 'vite.config.ts'
---

# Key Files and Directories - build config and version

Split out of the former `layout-misc.md`, whose six globs made every
edit under any one of four src layers load all four.

Index of every area: [code-layout.md](code-layout.md).

## Important Files

- **src/version.ts** - The build-time cdkd version (`getCdkdVersion()`, injected by tsdown's `define` from package.json, with the `DEV_VERSION_SENTINEL` fallback for vitest and `node --experimental-strip-types` where the define has not run) plus `isVersionOnlyInvocation()`, the predicate behind `src/cli/index.ts`'s `--version` fast path (issue [#2002](https://github.com/go-to-k/cdkd/issues/2002)). It sits at the top of `src/` and has **no imports on purpose**: `index.ts` answers a bare `--version` from it BEFORE `await import('./program.js')`, and any import here would put a module graph back on that path. The graph is what costs — measured 2026-08-25 on Node 24.15, `cdkd --version` was ~1020 ms of which ~48 ms was Node startup and ~3 ms `buildProgram()`, the rest being the loader resolving, reading and compiling the externalised `@aws-sdk/*` packages every command module pulls in (`deps.neverBundle` in `vite.config.ts` keeps them out of the bundle). After the fast path the same invocation is ~47 ms and the built entry chunk is 2.5 KB instead of 4.1 MB. The predicate is deliberately narrower than "the argv contains a version flag": it requires the argv to be EXACTLY one flag. The reason is CONSERVATISM, not a measured disagreement — against commander 12.1.0, `cdkd -c --version` / `cdkd deploy -c --version` / `cdkd --profile -V` all print the version and exit 0, so commander gives a standalone version flag priority rather than consuming it as an option value (an earlier version of this note asserted the opposite and was wrong). The narrow rule still holds because it does not DEPEND on that precedence, which is commander's behaviour and can change across a major, and because a wider rule would be a second spelling of commander's parse. Everything it refuses falls through to the unchanged commander parse, so refusing too much costs only the slow path. The branch itself is fenced by the wiring test in `tests/unit/cli/version.test.ts`, which stubs the command-tree chunk with a module that throws — the entry-chunk size bound and the predicate's own unit tests both stay GREEN when the branch is deleted, which is why that third fence exists. `src/state/deployment-events-store.ts` re-exports `getCdkdVersion` rather than re-deriving it; before this the `typeof __CDKD_VERSION__` guard was spelled three times, in two different forms.

- **vite.config.ts** - Vite+ configuration for build, test, lint, format, and tasks
