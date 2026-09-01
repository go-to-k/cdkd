# Contributing to cdkd

Thank you for your interest in contributing to cdkd!

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

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `vp run check && vp test run && vp run build`
4. Commit with a descriptive message
5. Open a Pull Request

## Adding a New SDK Provider

See [docs/provider-development.md](docs/provider-development.md) for a step-by-step guide.

## Integration Tests

Integration tests under `tests/integration/` deploy and destroy **real AWS
resources**, so running them incurs real AWS charges. CI does not run them.

**You are not required to run them.** If your change needs integration
coverage (see the table below), just say so in your PR — the maintainer runs
the required tests before merging, at no cost to you. The maintainer's merge
gates physically block merging until the required integration run has passed,
so coverage is guaranteed either way; asking is never a burden.

You are welcome to run them yourself against your own AWS account if you
prefer — see [docs/testing.md](docs/testing.md) for per-test instructions.
Most `local-*` tests are the exception on cost: they need only a local
Docker daemon and touch no AWS resources (`local-invoke-from-state` is the
one exception — it also deploys and destroys real AWS resources).

### When is an integration test needed, and which one?

Which verification a PR needs is derived mechanically from the paths it
touches. The path lists are the gate scopes in
[`.markgate.yml`](.markgate.yml) — the maintainer's merge gates read exactly
those, so the file is the source of truth. In summary:

| Your PR touches | Required verification (gate) |
| --- | --- |
| Deletion logic — `src/provisioning/providers/**`, destroy commands, rollback / retry code | An integration test that completes deploy **and destroy** cleanly (`integ-destroy`) |
| Cross-cutting deploy/destroy code — `src/deployment/deploy-engine.ts`, `src/analyzer/dag-builder.ts`, intrinsic resolution, provider registration | A broad multi-resource test in addition to any feature-specific one (`integ-broad`; the test-name set is listed in `.markgate.yml`) |
| Local execution — `src/local/**`, `src/cli/commands/local-*.ts` | A `local-*` test — Docker-based, most need no AWS account (`integ-local`) |
| A state schema version bump in `src/types/state.ts` | The `schema-v<N>-to-v<N+1>-migration` round-trip test (`integ-schema-migration`) |
| None of the above | No integration test — unit tests and CI are enough |

When in doubt, open the PR and ask; the maintainer will pick and run the
right tests.

## Adding Integration Tests

Add new examples under `tests/integration/`. See existing examples for patterns.

## Code Style

- TypeScript with strict mode, checked by the native TypeScript 7 compiler (`tsc`)
- ESM modules (`.js` extension in imports)
- Node native type stripping for TypeScript runners (`node app.ts`)
- Vite+ tasks in `vite.config.ts`
- Oxfmt for formatting
- Oxlint for linting, including type-aware checks

## License

Apache 2.0
