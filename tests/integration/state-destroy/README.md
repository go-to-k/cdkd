# State Destroy Integration Test

Verifies that `cdkd state destroy` can clean up a stack from any working
directory **without** the CDK app being available — i.e., the command path
that PR 6 introduces.

## Resources

- **AWS::S3::Bucket** — single bucket, no dependencies. The point of this
  test is the command surface, not the destroy provider.

## Test scenario (manual / CI)

The flow that exercises the new command:

1. Deploy normally from this directory:

   ```bash
   export AWS_REGION="us-east-1"

   node ../../../dist/cli.js bootstrap --region "${AWS_REGION}"

   node ../../../dist/cli.js deploy \
     --app "npx ts-node --prefer-ts-exts bin/app.ts" \
     --region "${AWS_REGION}"
   ```

2. Switch to a directory that has **no CDK app** (no `cdk.json`, no
   `bin/app.ts`):

   ```bash
   cd "$(mktemp -d)"
   ```

3. Run the new command — note: no `--app`, no synth.

   ```bash
   node /path/to/cdkd/dist/cli.js state destroy CdkdStateDestroyExample -y \
     --region "${AWS_REGION}"
   ```

4. Verify cleanup:

   ```bash
   # No state record:
   node /path/to/cdkd/dist/cli.js state list --region "${AWS_REGION}"

   # No leftover bucket: name will be a CDK-derived prefix
   # (cdkdstatedestroyexample-statedestroybucket...).
   aws s3 ls | grep cdkdstatedestroyexample
   ```

The destroy must succeed without complaining about missing `--app`, missing
`cdk.json`, or missing synth output.

## Comparison to `cdkd state rm`

`cdkd state rm CdkdStateDestroyExample` would leave the S3 bucket alive and
just forget about it from cdkd's view. This test ensures `state destroy`
deletes the bucket too.
