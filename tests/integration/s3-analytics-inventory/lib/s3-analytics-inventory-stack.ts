import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * cdkd S3 analytics + inventory DESTINATION integ (issue #1493 items 2/3).
 *
 * Both `applyAnalyticsConfigurations` and `applyInventoryConfigurations` pick
 * between two accepted destination shapes by probing member presence. Before
 * the fix a `Destination` that was a string / array / unresolved intrinsic
 * indexed every probe to `undefined` and the whole block was omitted from the
 * Put — the configuration deployed with no destination and no error anywhere.
 * The fix refuses that on the create path and warns on the update path, and
 * widened the branch probe to include `Bucket` (the readers already accepted
 * `BucketArn ?? Bucket`, so a `{ Bucket }`-only block previously dropped).
 *
 * Nothing in the integ tree exercised either configuration at all, so this
 * fixture is the live proof that the rewritten branch selection still delivers
 * a real destination to AWS — on CREATE and, via the per-id diff path where
 * the warn callback is wired, on UPDATE.
 *
 * L1 `CfnBucket` is used so the exact CFn property shapes are under test.
 *
 * SHAPE SCOPE: only the CFn FLATTENED form (`Destination: { BucketArn, Format,
 * ... }`) is covered live, because it is the only one a CDK template can
 * express — `S3BucketDestination` is the SDK spelling cdkd additionally accepts
 * for state records and hand-written templates, and aws-cdk-lib's L1 renderer
 * silently DROPS a member it does not declare, so synthesizing it would need an
 * `addPropertyOverride` whose output no user ever writes. That branch stays
 * unit-covered in `s3-bucket-provider-destination-shape.test.ts`.
 *
 * ALSO the live coverage for the warn-and-SUBSTITUTE arms of issue #1670 —
 * see the `malformed` mode below.
 *
 * Phases:
 *   1. Deploy: analytics + inventory both pointing at the report bucket.
 *      Assert both configurations reached AWS with the declared destination.
 *   2. Re-deploy with CDKD_TEST_UPDATE=malformed-substitute: three fields are
 *      blanked, so the UPDATE path warns and SENDS the default. Assert the
 *      state record holds the SUBSTITUTED value (issue #1670).
 *   3. Assert convergence via `cdkd diff`, with a negative twin.
 *   4. Hand-patch the state record malformed and redeploy: the PREVIOUS side
 *      is not guarded, so the stack stays deployable.
 *   5. Re-deploy with CDKD_TEST_UPDATE=true: same destination bucket, changed
 *      prefix + format on both. This runs the per-id diff path
 *      (`diffArrayConfigById` -> the appliers with the warn callback wired).
 *      Assert the readback shows the new values.
 *   6. Destroy; assert both buckets are gone.
 */
export class S3AnalyticsInventoryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 5 changes the destination PREFIX and FORMAT, never the shape and
    // never whether a configuration exists — this fixture only ever updates,
    // so no declaration disappears between steps (the #1543 mode-gating trap).
    const updateMode = process.env['CDKD_TEST_UPDATE'] ?? '';
    const updated = updateMode === 'true';

    // Issue #1670: the warn-and-SUBSTITUTE mode. Three fields the provider
    // reads through `readSubstitutedConfigString` are blanked — a BLANK STRING
    // is what an unresolved intrinsic or a hand-written L1 template produces,
    // it is exactly what `configStringRefusal` refuses, and it needs no cast to
    // express in TypeScript. On the UPDATE path (where `applySubConfigDiffs`
    // wires the warn callback unconditionally) each read WARNS and SENDS its
    // default instead: `V_1` for the schema version, `CSV` for both formats.
    //
    // The mode deliberately leaves `updated` FALSE, so every other value stays
    // at its phase-1 setting. That makes the substituted result byte-identical
    // to the phase-1 template, which is what lets phase 3 assert convergence as
    // a plain equality — the recorded bag must equal what a CORRECT template
    // declares. Changing this mode to ride on the phase-5 values would break
    // that: the inventory format substitutes to `CSV` while phase 5 declares
    // `ORC`, so the two would legitimately differ forever.
    //
    // aws-cdk-lib's CloudFormation-Validate pass DOES notice the blanks
    // (`W3030: '   ' is not one of ['CSV', 'ORC', 'Parquet']`), and that is
    // fine as long as it stays a WARNING: this fixture's cdk.json sets no
    // feature flags, so `@aws-cdk/core:validateAgainstDefaultRules` is off and
    // synth succeeds, and cdkd only fails a run on warning annotations under
    // `--strict`, which verify.sh does not pass. Measured, not assumed —
    // `app.synth()` under this mode exits 0. Turning that flag on for this
    // fixture, or adding `--strict` to its verify.sh, would break phase 2.
    //
    // Not covered here: the fourth substitution arm, the inventory
    // `ScheduleFrequency` -> `Schedule.Frequency` fall-through. The CFn schema
    // declares no `Schedule` member (`tests/fixtures/cfn-schemas/AWS-S3-Bucket.json`)
    // and aws-cdk-lib's L1 renderer drops a member it does not declare, so no
    // CDK template can carry the second source. It stays unit-covered in
    // `tests/unit/provisioning/s3-bucket-provider-substituted-properties.test.ts`.
    const malformed = updateMode.includes('malformed-substitute');
    const BLANK = '   ';

    const account = cdk.Stack.of(this).account;

    const reportBucketName = `cdkd-ai-reports-${account}`;
    const sourceBucketName = `cdkd-ai-source-${account}`;
    const reportBucketArn = `arn:aws:s3:::${reportBucketName}`;

    const reportBucket = new s3.CfnBucket(this, 'ReportBucket', {
      bucketName: reportBucketName,
    });
    reportBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // S3 REFUSES `PutBucketAnalyticsConfiguration` / `PutBucketInventoryConfiguration`
    // when the destination bucket's policy does not let the analytics/inventory
    // service write the reports — the call fails with `InvalidArgument:
    // Destination bucket policy is not configured`. So the policy is part of
    // the fixture, not incidental setup.
    const reportPolicy = new s3.CfnBucketPolicy(this, 'ReportBucketPolicy', {
      bucket: reportBucket.ref,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowS3AnalyticsAndInventoryReports',
            Effect: 'Allow',
            Principal: { Service: 's3.amazonaws.com' },
            Action: 's3:PutObject',
            Resource: `${reportBucketArn}/*`,
            Condition: {
              ArnLike: { 'aws:SourceArn': `arn:aws:s3:::${sourceBucketName}` },
              StringEquals: {
                'aws:SourceAccount': account,
                's3:x-amz-acl': 'bucket-owner-full-control',
              },
            },
          },
        ],
      },
    });

    const sourceBucket = new s3.CfnBucket(this, 'SourceBucket', {
      bucketName: sourceBucketName,

      // FLATTENED destination shape — what the CFn schema declares, and the
      // branch `resolveS3BucketDestination` picks via `BucketArn`.
      analyticsConfigurations: [
        {
          id: 'daily-analytics',
          storageClassAnalysis: {
            dataExport: {
              // Blanked by the #1670 mode: warns, sends `V_1`, and the state
              // record must then hold `V_1` rather than the blank.
              outputSchemaVersion: malformed ? BLANK : 'V_1',
              destination: {
                bucketArn: reportBucketArn,
                format: malformed ? BLANK : 'CSV',
                prefix: updated ? 'analytics-v2/' : 'analytics-v1/',
              },
            },
          },
        },
      ],

      inventoryConfigurations: [
        {
          id: 'daily-inventory',
          destination: {
            bucketArn: reportBucketArn,
            // Phase 5 flips the format too, so the UPDATE exercises the
            // `readConfigString(s3Dest, 'Format', 'CSV', destPath)` read whose
            // reported path item 3 corrected — not just the prefix pass-through.
            // The #1670 mode blanks it instead, so the same read takes its
            // warn-and-SUBSTITUTE arm and `CSV` is what reaches AWS.
            format: malformed ? BLANK : updated ? 'ORC' : 'CSV',
            prefix: updated ? 'inventory-v2/' : 'inventory-v1/',
          },
          enabled: true,
          includedObjectVersions: 'All',
          scheduleFrequency: 'Daily',
        },
      ],
    });
    sourceBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The destination policy must exist BEFORE the source bucket's
    // configurations are PUT, or S3 rejects them.
    sourceBucket.addResourceDependency(reportPolicy);

    // Issue #1718 item 1: a DECLARED-but-EMPTY lifecycle / CORS collection on
    // the CREATE path. `applyAllSubConfigsForCreate` skips the Put for it — the
    // same guard the update path has — and used to skip in SILENCE, so a fresh
    // bucket came up without the configuration its template declared and
    // nothing said so. This bucket is the live proof that the skip now
    // ANNOUNCES itself, and that the record still converges with the readback
    // (`readLifecycle` / `readCors` emit the same empty placeholder for an
    // unconfigured bucket, which is why the right answer is to override
    // nothing rather than to drop the key).
    //
    // Declared UNCONDITIONALLY, never under a `CDKD_TEST_UPDATE` token: a
    // mode-gated resource disappears in every later step that omits the token
    // (the #1543 trap), and this fixture deploys five more times after phase 1.
    //
    // The empty arrays survive synthesis — `CfnBucket` declares both members,
    // so the L1 renderer emits them rather than dropping them the way it drops
    // an UNdeclared one (which is why the nested destination spelling below has
    // to be seeded into STATE instead of into the template).
    const emptyCollectionBucketName = `cdkd-ai-empty-${account}`;
    const emptyCollectionBucket = new s3.CfnBucket(this, 'EmptyCollectionBucket', {
      bucketName: emptyCollectionBucketName,
      lifecycleConfiguration: { rules: [] },
      corsConfiguration: { corsRules: [] },
    });
    emptyCollectionBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'SourceBucketName', { value: sourceBucketName });
    new cdk.CfnOutput(this, 'ReportBucketName', { value: reportBucketName });
    new cdk.CfnOutput(this, 'EmptyCollectionBucketName', {
      value: emptyCollectionBucketName,
    });
  }
}
