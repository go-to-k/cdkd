# Contributing to cdkd

Thank you for your interest in contributing to cdkd!

The full contributor guide — project structure, PR flow, the
integration-test policy (which verification each PR needs, and why you are
never required to run the AWS-charging tests yourself), and code style —
lives in **[docs/contributing.md](docs/contributing.md)**, next to the
[Architecture](docs/architecture.md),
[Provider Development](docs/provider-development.md), and
[Testing](docs/testing.md) deep dives (rendered at
[cdkd.dev/contributing](https://cdkd.dev/contributing/)).

## Development Setup

This repo uses Vite+ for the JavaScript toolchain and runtime/package-manager
workflows. Developer tasks run on Node.js 24, pinned by `.node-version` and
managed by Vite+, while the package continues to support users on Node.js 20
and later. Dependencies are installed with pnpm 11 through Vite+.

The global `vp` CLI itself is pinned by `.mise.toml` via mise's HTTP backend
against Vite+'s platform CLI tarball. `mise install` also installs
[markgate](https://github.com/go-to-k/markgate), which the commit-gate hook
depends on.

```bash
# Clone the repository
git clone https://github.com/go-to-k/cdkd.git
cd cdkd

# Trust the mise config, then install pinned developer tools (vp, markgate, etc.)
# (mise requires explicit trust on first checkout or whenever .mise.toml changes)
mise trust
mise install

# Install the project Node.js version from .node-version with Vite+
vp env install

# Install dependencies with the pinned pnpm version
vp install

# Build
vp run build

# Run tests
vp test run

# Type check
vp run typecheck

# Lint
vp run lint:fix

# Format
vp run format
```

## Project Structure

See [docs/architecture.md](docs/architecture.md) for the layer-by-layer
walkthrough (also summarized in [CLAUDE.md](CLAUDE.md)).

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `vp run check && vp test run && vp run build`
4. Commit with a descriptive message
5. Open a Pull Request

## Adding a New SDK Provider

See [docs/provider-development.md](docs/provider-development.md) for a
step-by-step guide.

## Adding Integration Tests

Add new examples under `tests/integration/`. See existing examples for patterns.

## Running Integration Tests

Integration tests under `tests/integration/` deploy and destroy **real AWS
resources**, so running them incurs real AWS charges. CI does not run them.

**You are not required to run them.** If your change needs integration
coverage, just say so in your PR — the maintainer runs the required tests
before merging, at no cost to you. The maintainer's merge gates physically
block merging until the required integration run has passed, so coverage is
guaranteed either way; asking is never a burden.

Note this is about *running* the tests, not writing them: if your change adds
behavior no existing fixture covers (e.g. a new SDK provider), you are still
expected to add the fixture in the same PR (see "Adding Integration Tests"
above) — the maintainer can run it for you.

You are welcome to run them yourself against your own AWS account if you
prefer — see [docs/testing.md](docs/testing.md) for per-test instructions.
Most `local-*` tests are the exception on cost: they need only a local
Docker daemon and touch no AWS resources (`local-invoke-from-state` is the
one exception — it also deploys and destroys real AWS resources).

Which verification a PR needs is derived mechanically from the paths it
touches — the per-gate table lives in
[docs/contributing.md](docs/contributing.md#when-is-an-integration-test-needed-and-which-one)
(source of truth: the gate scopes in [`.markgate.yml`](.markgate.yml)).
When in doubt, open the PR and ask; the maintainer will pick and run the
right tests.

## Code Style

- TypeScript with strict mode, checked by the native TypeScript 7 compiler (`tsc`)
- ESM modules (`.js` extension in imports)
- Node native type stripping for TypeScript runners (`node app.ts`)
- Vite+ tasks in `vite.config.ts`
- Oxfmt for formatting
- Oxlint for linting, including type-aware checks

## License

Apache 2.0
