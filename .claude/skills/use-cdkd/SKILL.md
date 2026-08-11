---
name: use-cdkd
description: Build the current cdkd checkout and use it from another CDK project. Use when testing this checkout's dist/cli.js against a CDK app, linking cdkd globally via pnpm, or handing out copy-pasteable commands for local testing.
---

<!--
  This file is the REPO-INTERNAL contributor skill: it covers building and
  linking the current checkout. The end-user deployment guidance lives in the
  DISTRIBUTED skill at plugins/cdkd-skills/skills/cdkd/SKILL.md (installed by
  users via `/plugin install cdkd-skills@cdkd`, `gh skill`, or `npx skills`).
  The two files ship together: when cdkd CLI behavior changes, update the
  distributed file AND bump the `version` fields in
  plugins/cdkd-skills/.claude-plugin/plugin.json and
  .claude-plugin/marketplace.json in the same PR.
-->

# Use the Current cdkd Checkout

Build the current checkout and use it from another CDK project for testing. For everything that happens AFTER the binary is chosen — deployment boundary, preview, wait modes, verification, destructive-operation guards — read and follow [plugins/cdkd-skills/skills/cdkd/SKILL.md](../../../plugins/cdkd-skills/skills/cdkd/SKILL.md); it applies identically whether the binary is a built checkout or a published release.

## Build the checkout

From the cdkd repository root, build the CLI:

```bash
vp run build
```

If the checkout has not been set up, follow [CONTRIBUTING.md](../../../CONTRIBUTING.md) first: trust and install the pinned mise tools, run `vp env install`, and run `vp install`. Use the repository-pinned development runtime instead of replacing the build command.

Resolve and report the absolute CLI path:

```bash
echo "$(pwd)/dist/cli.js"
```

## Invoke it from another project

Prefer direct invocation for one-off testing because it does not modify the user's shell or global packages:

```bash
node /absolute/path/to/cdkd/dist/cli.js --version
```

When the user explicitly wants `cdkd` available globally, offer the repository's pnpm link workflow:

```bash
pnpm setup
# Open a new shell, or reload the shell configuration that pnpm updated.
pnpm link --global
cdkd --version
```

Run `pnpm setup` only when needed; it updates shell configuration. Rebuilding with `vp run build` updates the linked binary without re-linking. To remove the link, run `pnpm unlink --global @go-to-k/cdkd` or `pnpm rm --global @go-to-k/cdkd`.

When giving commands for another CDK project, make them copy-pasteable and use either `cdkd` or the real absolute `node .../dist/cli.js` path consistently. If the user wants a published release instead of this checkout, follow the install section of the distributed skill linked above.
