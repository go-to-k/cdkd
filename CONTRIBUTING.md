# Contributing to cdkd

Thank you for your interest in contributing to cdkd!

The full contributor guide — project structure, PR flow, the
integration-test policy (which verification each PR needs, and why you are
never required to run the AWS-charging tests yourself), and code style —
lives at **[cdkd.dev/contributing](https://cdkd.dev/contributing/)**, next
to the [Architecture](https://cdkd.dev/architecture/),
[Provider Development](https://cdkd.dev/provider-development/), and
[Testing](https://cdkd.dev/testing/) deep dives.

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

## License

Apache 2.0
