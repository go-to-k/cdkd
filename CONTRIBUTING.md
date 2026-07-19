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
vp run test

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
3. Run `vp run check && vp run test && vp run build`
4. Commit with a descriptive message
5. Open a Pull Request

## Adding a New SDK Provider

See [docs/provider-development.md](docs/provider-development.md) for a step-by-step guide.

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
