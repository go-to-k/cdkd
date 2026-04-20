---
name: use-cdkd
description: Build cdkd and show ready-to-use commands for other CDK projects. Copy-paste the output into another project's terminal.
---

# Use cdkd in Other Projects

Build cdkd and output commands that can be pasted into another CDK project's terminal.

## Steps

1. **Build cdkd**:

   ```bash
   pnpm run build
   ```

2. **Get the absolute path to the CLI**:

   ```bash
   echo "$(pwd)/dist/cli.js"
   ```

3. **Output the commands** for the user to copy-paste. Use the absolute path.

   ### Option A: Global install via pnpm link (recommended — use `cdkd` as a global command)

   First-time setup (run once in the cdkd repo root):

   ```bash
   # Configure pnpm global bin directory (first time only; adds PATH to shell rc)
   pnpm setup

   # Reload shell so PNPM_HOME is on PATH
   source ~/.zshrc   # or ~/.bashrc

   # Register cdkd globally (run from the cdkd repo root)
   pnpm link --global
   ```

   After linking, `cdkd` is available as a global command from any directory.

   #### Default (auto-resolves bucket: `cdkd-state-{accountId}-{region}`)

   ```bash
   # Bootstrap
   cdkd bootstrap

   # Synth / Diff / Deploy / Destroy
   cdkd synth
   cdkd diff
   cdkd deploy
   cdkd deploy -c KEY=VALUE
   cdkd deploy --verbose
   cdkd deploy --no-wait
   cdkd destroy --force
   ```

   #### Custom state bucket

   ```bash
   # Bootstrap
   cdkd bootstrap --state-bucket my-custom-cdkd-state-bucket

   # Deploy (--state-bucket flag)
   cdkd deploy --state-bucket my-custom-cdkd-state-bucket

   # Deploy (CDKD_STATE_BUCKET env var)
   CDKD_STATE_BUCKET=my-custom-cdkd-state-bucket cdkd deploy

   # Destroy
   cdkd destroy --state-bucket my-custom-cdkd-state-bucket --force
   ```

   To unlink later: `pnpm unlink --global cdkd` (from anywhere) or `pnpm rm --global cdkd`.

   Note: `pnpm link --global` points to the current `dist/cli.js`, so re-running `pnpm run build` in the cdkd repo picks up changes automatically — no re-link needed.

   ### Option B: Direct `node` invocation (no install needed)

   ### Default (auto-resolves bucket: `cdkd-state-{accountId}-{region}`)

   ```
   # Bootstrap
   node /path/to/cdkd/dist/cli.js bootstrap

   # Synth
   node /path/to/cdkd/dist/cli.js synth

   # Diff
   node /path/to/cdkd/dist/cli.js diff

   # Deploy
   node /path/to/cdkd/dist/cli.js deploy

   # Deploy (with context)
   node /path/to/cdkd/dist/cli.js deploy -c KEY=VALUE

   # Deploy (verbose)
   node /path/to/cdkd/dist/cli.js deploy --verbose

   # Deploy (no wait - don't wait for resource stabilization)
   node /path/to/cdkd/dist/cli.js deploy --no-wait

   # Destroy
   node /path/to/cdkd/dist/cli.js destroy --force
   ```

   ### Custom state bucket

   ```
   # Bootstrap
   node /path/to/cdkd/dist/cli.js bootstrap --state-bucket my-custom-cdkd-state-bucket

   # Deploy (--state-bucket flag)
   node /path/to/cdkd/dist/cli.js deploy --state-bucket my-custom-cdkd-state-bucket

   # Deploy (CDKD_STATE_BUCKET env var)
   CDKD_STATE_BUCKET=my-custom-cdkd-state-bucket node /path/to/cdkd/dist/cli.js deploy

   # Destroy
   node /path/to/cdkd/dist/cli.js destroy --state-bucket my-custom-cdkd-state-bucket --force
   ```

   (If globally linked via Option A, replace `node /path/to/cdkd/dist/cli.js` with `cdkd` in any of the above.)

4. **Remind the user**:
   - `pnpm setup` + `pnpm link --global` is a one-time setup; after that just use `cdkd` anywhere
   - `pnpm setup` writes `PNPM_HOME` to your shell rc — open a new shell or `source` the rc before `pnpm link --global`
   - Re-building cdkd (`pnpm run build`) automatically updates the linked global binary
   - `--region` is optional if `AWS_REGION` or `CDK_DEFAULT_REGION` is set
   - `--state-bucket` auto-resolves to `cdkd-state-{accountId}-{region}` if omitted
   - Custom bucket can be set via `--state-bucket` flag, `CDKD_STATE_BUCKET` env var, or `context.cdkd.stateBucket` in cdk.json (priority: CLI > env > cdk.json)
   - Run `bootstrap` first to create the state bucket (use `--state-bucket` to use a custom name)
   - `--app` falls back to `cdk.json`'s `app` field
   - Add `--verbose` for detailed logs
