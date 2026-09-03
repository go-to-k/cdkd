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

# Build, test, check
vp run build
vp test run
vp run check
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

## Integration Tests

Integration tests deploy and destroy **real AWS resources**, and you are
never required to run them yourself — say so in your PR and the maintainer
runs the required ones before merging. Which verification a PR needs (and
the full policy) is in
[docs/contributing.md](docs/contributing.md#running-integration-tests).

## License

Apache 2.0
