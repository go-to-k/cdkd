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

3. **Output the commands** for the user to copy-paste. Use the absolute path:

   ```
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

4. **Remind the user**:
   - `--region` is optional if `AWS_REGION` or `CDK_DEFAULT_REGION` is set
   - `--state-bucket` auto-resolves to `cdkd-state-{accountId}-{region}`
   - `--app` falls back to `cdk.json`'s `app` field
   - Add `--verbose` for detailed logs
