# Orphan Resource Integration Test

Verifies `cdkd orphan <constructPath>` (per-resource orphan, mirrors
upstream `cdk orphan --unstable=orphan`) end-to-end against real AWS.

PR #100 reworked `cdkd orphan` to operate per-resource: the rewriter
fetches every `Fn::GetAtt` it has to substitute via
`provider.getAttribute(...)` and rewrites every sibling `Ref` /
`Fn::GetAtt` / `Fn::Sub` site to a literal string before removing the
target from state. Unit tests cover the algorithm
(`tests/unit/analyzer/orphan-rewriter.test.ts`); this integ test
exercises the load-bearing real-AWS assertions that unit tests can't:

- Live `provider.getAttribute(...)` calls actually return real AWS values.
- Sibling resources' `Ref` / `Fn::GetAtt` are rewritten to literal strings
  (not left as intrinsic objects pointing at the now-missing orphan).
- The orphaned AWS resource really survives — `cdkd orphan` only
  removes the cdkd state record.
- The orphan is reversible via `cdkd import` — re-importing the bucket
  by physical id puts it back under cdkd's management.

## Resources

Two resources, with one explicit cross-reference:

- **AWS::S3::Bucket** (`MyBucket`) — the orphan target.
- **AWS::Lambda::Function** (`Handler`) — `BUCKET_NAME` env var is
  `bucket.bucketName`, which CDK emits as `{Ref: MyBucket}`. This is
  the reference the orphan rewriter has to substitute.

The Bucket has `RemovalPolicy.RETAIN` so a wrong-order `cdkd destroy`
(without orphaning first) doesn't accidentally delete it; the integ
flow below still cleans the bucket up explicitly at the end.

## Test scenario

Run with `/run-integ orphan-resource`. The expected flow:

1. **Deploy**

   ```bash
   node ../../../dist/cli.js deploy --region us-east-1 --verbose
   ```

   `cdkd state resources CdkdOrphanResourceExample` should list both
   `MyBucket` and `Handler`. The Lambda's `BUCKET_NAME` env var in
   state should still be `{Ref: MyBucket}` (intrinsic form).

2. **Orphan the bucket**

   The construct path matches the CDK `aws:cdk:path` tag in the synthesized
   template (CDK appends `/Resource` for L1/L2 resource constructs):

   ```bash
   node ../../../dist/cli.js orphan \
     'CdkdOrphanResourceExample/MyBucket/Resource' --yes
   ```

   Expected output (rewrite audit):

   ```text
   Orphaning 1 resource(s): MyBucketF68F3FF0
   Applied 1 rewrite(s):
     [property] Handler<hash>.Properties.Environment.Variables.BUCKET_NAME: {"Ref":"MyBucketF68F3FF0"} → "<physical-bucket-name>"
   ```

   (The `F68F3FF0`-style suffixes are CDK-generated; the `Handler` logical
   ID gets a similar suffix.)

3. **Verify**

   - `cdkd state resources CdkdOrphanResourceExample` lists ONLY `Handler`.
   - The Lambda's `BUCKET_NAME` env var in state is now a literal string
     (the real bucket name), not `{Ref: MyBucket}`.
   - `aws s3api head-bucket --bucket <bucket-name>` succeeds — the
     bucket is still there.

4. **Re-import (optional, proves orphan is reversible)**

   ```bash
   node ../../../dist/cli.js import CdkdOrphanResourceExample \
     --resource MyBucket=<physical-bucket-name> --yes
   ```

   `cdkd state resources` should once again list both resources.
   (Skip this step if you want to test the destroy-only path.)

5. **Destroy**

   ```bash
   node ../../../dist/cli.js destroy CdkdOrphanResourceExample --force
   ```

   - If step 4 was skipped: only `Handler` is in state, so destroy
     deletes only the function. The bucket is untracked. Clean it up
     manually:

     ```bash
     aws s3 rb s3://<physical-bucket-name>
     ```

   - If step 4 ran: destroy will skip the bucket (RemovalPolicy=RETAIN)
     and delete the function. Clean up the bucket the same way.

6. **Verify zero orphans** — `cdkd state list` shows no
   `CdkdOrphanResourceExample` row, and
   `aws s3api list-buckets --query 'Buckets[?starts_with(Name, \`cdkdorphanresourceexample\`)]'`
   returns empty.

## Comparison

| Command                                                 | What it does                                                                              |
|---------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `cdkd orphan CdkdOrphanResourceExample/MyBucket`        | Per-resource: rewrites siblings, removes one resource from state, AWS resource stays.     |
| `cdkd state orphan CdkdOrphanResourceExample`           | Whole-stack: removes the entire state record, AWS resources stay (no rewriting needed).   |
| `cdkd destroy CdkdOrphanResourceExample`                | Whole-stack: deletes AWS resources AND the state record.                                  |
| `cdkd state destroy CdkdOrphanResourceExample`          | Same as `cdkd destroy`, but no CDK app required.                                          |
