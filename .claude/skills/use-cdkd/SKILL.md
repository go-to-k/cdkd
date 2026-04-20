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

4. **Remind the user**:
   - `--region` is optional if `AWS_REGION` or `CDK_DEFAULT_REGION` is set
   - `--state-bucket` auto-resolves to `cdkd-state-{accountId}-{region}` if omitted
   - Custom bucket can be set via `--state-bucket` flag, `CDKD_STATE_BUCKET` env var, or `context.cdkd.stateBucket` in cdk.json (priority: CLI > env > cdk.json)
   - Run `bootstrap` first to create the state bucket (use `--state-bucket` to use a custom name)
   - `--app` falls back to `cdk.json`'s `app` field
   - Add `--verbose` for detailed logs
