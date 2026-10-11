---
title: Contributing
description: How to set up a cdkd development environment, make a change, and know which verification your pull request needs before it merges.
---

# Contributing to cdkd

Issues and pull requests are welcome at
[github.com/go-to-k/cdkd](https://github.com/go-to-k/cdkd). This page takes you
from a fresh clone to a merged pull request. The other three pages in this
group go deeper, in the order most contributors need them:

::: card-grid
::: card 1. Set up and open a PR
This page: the toolchain, the checks to run, and what a PR needs to merge.
:::
::: card 2. Learn the layout
The layers, the deploy pipeline, and where each module lives.
[Architecture](architecture.md)
:::
::: card 3. Write a provider
The most common contribution, start to finish, with the rules a provider
obeys. [Provider Development](provider-development.md)
:::
::: card 4. Test it
Unit tests, and the integration tests that run against real AWS.
[Testing](testing.md)
:::
:::

## Set up the toolchain

You need [mise](https://mise.jdx.dev) and git. mise installs the pinned `vp`
CLI (Vite+), and Vite+ installs the pinned Node.js and pnpm.

```bash
git clone https://github.com/go-to-k/cdkd.git
cd cdkd

mise trust        # required on first checkout and whenever .mise.toml changes
mise install      # installs vp and markgate at the pinned versions
vp env install    # installs the Node.js version in .node-version
vp install        # installs dependencies with the pinned pnpm

vp run build      # writes dist/cli.js
vp test run       # runs the unit tests
```

Developer tasks run on Node.js 24, pinned by `.node-version`. The published
package supports users on Node.js 22.12 and later. Dependencies are installed
with pnpm 12 through Vite+.

`mise install` also installs [markgate](https://github.com/go-to-k/markgate),
which the maintainer's merge gates for integration tests depend on.

## Everyday commands

Every task is registered in `vite.config.ts` and run as `vp run <task>`. There
is no `package.json` `scripts` block.

| Command | What it does |
| --- | --- |
| `vp run build` | Build `dist/`. Rerun after every `src/` change before trying `node dist/cli.js`. |
| `vp run dev` | Rebuild on change. |
| `vp test run` | Run the unit tests once. |
| `vp run typecheck` | Type-check `src/`. |
| `vp run lint:fix` | Lint with Oxlint and apply fixes. |
| `vp run format` | Format with Oxfmt. |
| `vp run check` | Format, lint and type checks, as CI runs them. |
| `vp run test:coverage` | Unit tests with a coverage report. |
| `vp test --ui` | The Vitest UI. |

To try your build against a CDK app, run it from the app's directory:

```bash
node /path/to/cdkd/dist/cli.js diff MyStack
```

### Documentation site commands

The site at [cdkd.dev](https://cdkd.dev) is built from `docs/` with its own
config, `docs/_site/vite.config.ts`.

| Command | What it does |
| --- | --- |
| `vp run docs:dev` | Serve the site locally with reload. |
| `vp run docs:build` | Build the site. |
| `vp run docs:preview` | Serve the built site. |
| `vp run vue:lint` | Lint the site's Vue components. |
| `vp run vue:fmt` | Format them. `vp run vue:fmt:check` only reports. |
| `vp run vue:check` | Strict type check of the site's Vue app. |

## Make a change

::: steps
1. Create a branch from `main`

   ```bash
   git switch -c fix/sqs-queue-tags origin/main
   ```

2. Make the change, with unit tests

   Add or update tests under `tests/unit/` in the same commit, for a bug fix as
   well as for a feature. [Testing](testing.md) shows how.

3. Add a changelog entry if users can see the change

   A change in cdkd's behavior gets one file under `changelog.d/entries/`,
   named `<YYYY-MM-DD>-<issue>-<slug>.md`. Changes to docs, tests, CI and
   tooling get none. The format is described in
   [`changelog.d/_header.md`](https://github.com/go-to-k/cdkd/blob/main/changelog.d/_header.md).

4. Run the checks CI runs

   ```bash
   vp run check && vp test run && vp run build
   ```

   `vp run verify` runs the same three and also type-checks the tests.

5. Open a pull request

   Give it a conventional-commit title, such as
   `fix(sqs): apply tag removal on update`. Say in the description whether the
   change needs an integration test (see below).
:::

### Pull request titles

The title becomes the squash commit, and the release tooling reads its prefix.

| Prefix | Use it when | Effect |
| --- | --- | --- |
| `feat:` | The PR adds behavior under `src/` | Minor release, changelog line |
| `fix:` | The PR fixes behavior under `src/` | Patch release, changelog line |
| `docs:`, `test:`, `chore:`, `refactor:`, `ci:` | Anything else | No release |

CI refuses a `feat:` or `fix:` title on a PR that changes no file under `src/`
and adds no changelog entry.

## What a pull request needs to merge

```text diagram=contrib-pr-flow
Your branch
    |
    v
Local checks        vp run check && vp test run && vp run build
    |
    v
Pull request        conventional-commit title, tests, changelog entry
    |
    +--> CI                   format, lint, types, unit tests, build
    |
    +--> Integration run      only for the paths in the table below;
    |                         the maintainer runs it
    v
Squash merge        by the maintainer, once both are green
```

CI must be green. It runs the format, lint and type checks, the unit tests and
the build. It does not run the integration tests.

The maintainer merges with a squash, so the commits on your branch do not need
to be tidy.

### When is an integration test needed, and which one?

Integration tests under `tests/integration/` deploy and destroy real AWS
resources, so running them costs money. You are not required to run them. Say
in your PR that the change needs one and the maintainer runs it before merging.

Which test a PR needs follows from the paths it touches:

| Your PR touches | Verification |
| --- | --- |
| Deletion logic: `src/provisioning/providers/**`, destroy commands, rollback and retry code | An integration test that completes deploy **and destroy** cleanly. Gated (`integ-destroy`). |
| Cross-cutting deploy and destroy code: `src/deployment/deploy-engine.ts` and its `deploy-engine/*.ts` mixins, `src/analyzer/dag-builder.ts`, intrinsic resolution, provider registration | A broad multi-resource test in addition to any feature-specific one |
| Local execution: `src/local/**`, `src/cli/commands/local-*.ts` | A `local-*` test, which runs in Docker |
| A state schema version bump in `src/types/state.ts` | The `schema-v<N>-to-v<N+1>-migration` round-trip test. Gated (`integ-schema-migration`). |
| None of the above | No integration test. Unit tests and CI are enough. |

A **gated** row cannot merge on green CI alone. A merge gate holds the PR until
the integration run has passed. The path lists for the two gates are the
`integ-destroy` and `integ-schema-migration` scopes in
[`.markgate.yml`](https://github.com/go-to-k/cdkd/blob/main/.markgate.yml). The
other rows are expected of the change and are not blocked on.

Running a test and writing one are separate. If your change adds behavior no
existing fixture covers, such as a new SDK provider, add the fixture in the
same PR. The maintainer can still run it for you.

You can also run the tests against your own AWS account.
[Testing](testing.md#run-an-integration-test) has the commands. Most `local-*`
tests need only a Docker daemon and touch no AWS resources;
`local-invoke-from-state` is the exception and deploys real resources.

When in doubt, open the PR and ask.

## Code style

- TypeScript in strict mode, checked by the native TypeScript 7 compiler (`tsc`).
- ESM modules. Relative imports carry the `.js` extension, in TypeScript too:
  `from './bar.js'`.
- TypeScript runners use Node's native type stripping (`node app.ts`).
- Oxfmt formats and Oxlint lints, including type-aware checks. `vp run check`
  runs both.
- `vp pack` bundles the ESM package through tsdown with a Node 22 runtime
  target.

## Changing the logo

The cdkd symbol is defined once, as vector paths, in
`docs/_site/brand/mark.ts`. An edit there reaches the other copies in three
ways:

| Copy | What to do |
| --- | --- |
| Home page key visual, per-page OG images | Nothing. They draw from `mark.ts` at build time. |
| `docs/_site/public/brand/logo-light.svg`, `logo-dark.svg` | Paste the new paths in by hand. The README and the site header load these. |
| `docs/_site/public/brand/favicon.svg` | Redraw. It is a simplified drawing for 16 to 32 px. |
| `docs/_site/public/favicon.ico` (16, 32 and 48 px), `apple-touch-icon.png` (180 px) | Redraw. They are raster versions of the symbol. |

No test checks the favicon files.
`tests/unit/scripts/docs-site-brand-tokens.test.ts` fails while the two logo
SVGs differ from `mark.ts`, or while their fills differ from the brand colors
in `docs/_site/brand/cdkd.tokens.json`.

## License

Apache 2.0
