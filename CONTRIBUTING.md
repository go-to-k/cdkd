# Contributing to cdkd

Thank you for your interest in contributing to cdkd!

## Development Setup

This repo pins developer tooling via [mise](https://mise.jdx.dev/). `mise install` fetches [markgate](https://github.com/go-to-k/markgate), which the commit-gate hook depends on. If you prefer not to use mise, install markgate by any means (Homebrew, `go install`, release binary) and skip that step.

```bash
# Clone the repository
git clone https://github.com/go-to-k/cdkd.git
cd cdkd

# Install pinned developer tools (markgate, etc.)
mise install

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint:fix

# Format
npm run format
```

## Project Structure

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run typecheck && npm run lint && npm run build && npm test`
4. Commit with a descriptive message
5. Open a Pull Request

## Adding a New SDK Provider

See [docs/provider-development.md](docs/provider-development.md) for a step-by-step guide.

## Adding Integration Tests

Add new examples under `tests/integration/`. See existing examples for patterns.

## Code Style

- TypeScript with strict mode
- ESM modules (`.js` extension in imports)
- Prettier for formatting
- ESLint for linting

## License

Apache 2.0
