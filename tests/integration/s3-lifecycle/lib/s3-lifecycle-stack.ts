import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * An S3 bucket with lifecycle rules — a daily pattern. The fixture mixes a
 * prefix-scoped rule (CFn emits a top-level `Prefix`, the deprecated "V1" form)
 * with a rule that has NO prefix and NO filter (an
 * AbortIncompleteMultipartUpload-only rule). S3 forbids mixing V1 (top-level
 * `Prefix`) and V2 (`Filter`) rules in a single PutBucketLifecycleConfiguration
 * call ("Filter element can only be used in Lifecycle V2"). CloudFormation
 * normalizes this transparently; cdkd must too, or both CREATE and UPDATE fail.
 *
 *   covers: AWS::S3::Bucket
 *
 * Phase 1 creates the bucket with the prefix rule + the abort-only rule (this
 * alone reproduces the V1/V2 mix bug on CREATE). Phase 2 (CDKD_TEST_UPDATE=true)
 * shortens the GLACIER transition + adds a Filter-based rule (ObjectSizeGreaterThan),
 * which must be an in-place PutBucketLifecycleConfiguration UPDATE (not a bucket
 * replacement).
 */
export class S3LifecycleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const rules: s3.LifecycleRule[] = [
      {
        id: 'archive',
        enabled: true,
        prefix: 'logs/',
        transitions: [
          {
            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
            transitionAfter: cdk.Duration.days(30),
          },
          {
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(update ? 60 : 90),
          },
        ],
        expiration: cdk.Duration.days(update ? 365 : 730),
        noncurrentVersionExpiration: cdk.Duration.days(30),
        // CFn spells this day count `TransitionInDays`, while the SDK member is
        // `NoncurrentDays`. cdkd read only the SDK spelling, so every CDK
        // `noncurrentVersionTransitions` reached AWS without a schedule
        // (issue #1388). Standard L2, i.e. the path every current user takes.
        // Must be SHORTER than `noncurrentVersionExpiration` above: S3 rejects
        // the config outright when a noncurrent transition is not strictly
        // before the noncurrent expiration. That rejection is itself proof the
        // value now reaches AWS -- pre-fix the day count was `undefined`, so
        // S3 had nothing to compare and the whole schedule was silently lost.
        noncurrentVersionTransitions: [
          {
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(15),
          },
        ],
      },
      // Tag-scoped rule (issue #1424). `tagFilters` synthesizes to a RULE-level
      // `TagFilters`, which cdkd did not read — the rule gathered no scope at
      // all and fell through to the catch-all `Filter: { Prefix: '' }`, so this
      // expiration would have applied to EVERY object in the bucket. Two tags
      // on purpose: the SDK's `Tag` member holds one, so this must land as
      // `Filter.And.Tags`.
      {
        id: 'tag-scoped',
        enabled: true,
        tagFilters: { env: 'prod', team: 'core' },
        expiration: cdk.Duration.days(400),
      },
      // No prefix, no filter -> needs the empty V2 Filter S3 requires. Mixed with
      // the prefix rule above, this is what trips the V1/V2 mix bug.
      {
        id: 'abort-mpu',
        enabled: true,
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      },
    ];

    if (update) {
      // A rule with an explicit size Filter (V2). All three rules must end up in
      // V2 Filter form on the wire.
      rules.push({
        id: 'big-objects',
        enabled: true,
        objectSizeGreaterThan: 1024 * 1024,
        expiration: cdk.Duration.days(180),
      });
    }

    // No objects are ever written, so a plain DESTROY removal policy suffices —
    // autoDeleteObjects (a Custom Resource + Lambda) is intentionally avoided to
    // keep the fixture to a single S3 resource.
    new s3.Bucket(this, 'Bucket', {
      bucketName: `cdkd-lifecycle-test-${cdk.Stack.of(this).account}`,
      versioned: true,
      lifecycleRules: rules,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // L1 on purpose: the CFn schema still accepts the LEGACY SINGULAR action
    // forms (`Transition`, `NoncurrentVersionTransition`) and the scalar
    // `NoncurrentVersionExpirationInDays`, plus a rule-level
    // `ExpiredObjectDeleteMarker` — none of which the L2 `LifecycleRule` can
    // emit. Hand-written / imported / `cdkd import --migrate-from-cloudformation`
    // templates carry these shapes, and cdkd dropped all four (issue #1388 /
    // #1424). A rule whose ONLY action is the delete-marker cleanup is the
    // sharpest case: dropped, it becomes an action-less rule that S3 rejects
    // outright.
    new s3.CfnBucket(this, 'LegacyBucket', {
      bucketName: `cdkd-lifecycle-legacy-${cdk.Stack.of(this).account}`,
      versioningConfiguration: { status: 'Enabled' },
      // Issue #1430, same class as the lifecycle shapes below: a CFn spelling
      // with no SDK member behind it. CFn's `EventBridgeConfiguration` carries
      // a REQUIRED boolean, while the SDK's block is an EMPTY structure whose
      // PRESENCE enables delivery — so the boolean has nothing to map onto and
      // has to be translated into presence/absence. cdkd emitted the SDK block
      // whenever the CFn block existed, so this `false` came up with
      // EventBridge notifications ON: the inverse of the template.
      //
      // Ground truth is a real CloudFormation A/B of this exact shape (stack
      // Cdkd1430EbProbe, us-east-1, 2026-08-10): `false` -> no EventBridge
      // block; `true` -> `{}`. `EbEnabledBucket` below is the `true` half, and
      // it is what keeps the `false` assertion from passing vacuously.
      //
      // L1 is required, not a stylistic choice: the L2's `eventBridgeEnabled`
      // routes through a Custom::S3BucketNotifications custom resource, which
      // never reaches `S3BucketProvider`'s own NotificationConfiguration path.
      // The two buckets SWAP their booleans in UPDATE mode. Without that the
      // notification block is byte-identical across phases, `diffSubConfig`
      // short-circuits on JSON equality, and `applyNotificationConfiguration`
      // is never invoked in phase 2 — so a phase-2 assertion would be a
      // persistence re-read masquerading as UPDATE-path coverage. Swapping
      // exercises the `true -> false` flip (the user-visible scenario this fix
      // creates) and the `false -> true` direction in one deploy.
      notificationConfiguration: { eventBridgeConfiguration: { eventBridgeEnabled: update } },
      lifecycleConfiguration: {
        rules: [
          {
            id: 'legacy-singular',
            status: 'Enabled',
            prefix: 'archive/',
            transition: { storageClass: 'GLACIER', transitionInDays: 90 },
            noncurrentVersionTransition: { storageClass: 'GLACIER', transitionInDays: 30 },
            noncurrentVersionExpirationInDays: 365,
          },
          {
            id: 'legacy-delete-marker',
            status: 'Enabled',
            prefix: 'markers/',
            expiredObjectDeleteMarker: true,
          },
        ],
      },
    });

    // The other half of the issue #1430 pair, carrying the INVERSE of
    // LegacyBucket in both phases. Two buckets rather than one because the
    // values are mutually exclusive per bucket, and because asserting only the
    // `false` side would pass just as happily if cdkd stopped applying
    // NotificationConfiguration altogether — whichever bucket is currently
    // `true` is the vacuity guard for the one that is `false`.
    new s3.CfnBucket(this, 'EbEnabledBucket', {
      bucketName: `cdkd-lifecycle-ebtrue-${cdk.Stack.of(this).account}`,
      notificationConfiguration: { eventBridgeConfiguration: { eventBridgeEnabled: !update } },
    });

    // Issue #1748: the TOLERATED key spellings, which no L2 and no typed L1
    // prop can emit — cdkd accepts them on the desired side while
    // `readCurrentState` emits only the CFn one, so a record written in the
    // tolerated spelling can never match the readback.
    //
    // Raw `addPropertyOverride` on purpose (the memory rule an L1 validator
    // refuses the shape): `CfnBucket`'s typed props declare `topicArn` nowhere
    // and `transitionInDays` only, so the tolerated spellings are unreachable
    // through the construct API and this is the only way a fixture can carry
    // the population the fix exists for. A hand-written / imported /
    // `cdkd import --migrate-from-cloudformation` template carries them.
    const topic = new sns.Topic(this, 'NotifyTopic', {
      topicName: `cdkd-lifecycle-notify-${cdk.Stack.of(this).account}`,
    });
    // S3 VALIDATES the destination when the notification configuration is PUT
    // (it publishes a test event), so the topic policy has to exist FIRST —
    // hence an explicit TopicPolicy plus a DependsOn below rather than
    // `addToResourcePolicy`, whose policy resource the bucket does not
    // reference and which cdkd's DAG therefore has no edge to order against.
    const topicPolicy = new sns.TopicPolicy(this, 'NotifyTopicPolicy', {
      topics: [topic],
      policyDocument: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
            actions: ['sns:Publish'],
            resources: [topic.topicArn],
            conditions: {
              StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
            },
          }),
        ],
      }),
    });

    const aliasBucket = new s3.CfnBucket(this, 'AliasSpellingBucket', {
      bucketName: `cdkd-lifecycle-alias-${cdk.Stack.of(this).account}`,
      // NoncurrentVersionTransitions require a versioned bucket.
      versioningConfiguration: { status: 'Enabled' },
    });
    aliasBucket.node.addDependency(topicPolicy);
    // `TopicArn` + `Event`: the applier reads `t['Topic'] ?? t['TopicArn']`
    // while `readNotification` emits `Topic`, and CFn declares the event as the
    // SCALAR `Event` while the SDK member is the LIST `Events`. Both halves are
    // in this one item.
    aliasBucket.addPropertyOverride('NotificationConfiguration.TopicConfigurations', [
      { Id: 'alias-topic', TopicArn: topic.topicArn, Event: 's3:ObjectCreated:*' },
    ]);
    // `Days` / `NoncurrentDays`: the applier reads
    // `t['TransitionInDays'] ?? t['Days']` and
    // `nvt['TransitionInDays'] ?? nvt['NoncurrentDays']`, while `readLifecycle`
    // emits `TransitionInDays` for both. The day count CHANGES in UPDATE mode
    // so phase 2 exercises the update-path fold rather than re-reading a
    // persisted phase-1 value.
    // Issue #1751: a CFn STRING boolean. CloudFormation is stringly typed and
    // cdkd is not, so `Enabled: 'false'` is a legitimate hand-written /
    // imported declaration — the wire must send the COERCED boolean and the
    // record must hold the coerced value, since `inventorySdkToCfn` reads
    // `IsEnabled` back as a boolean. Unreachable through the typed L1 prop
    // (`enabled` is `boolean | IResolvable`), hence the override.
    //
    // Disabled on purpose: an ENABLED inventory writes a daily report into the
    // destination, and this fixture is torn down long before one is generated —
    // but `false` is also the value the #1751 guard exists to protect, since
    // the pre-fix `?? true` default would have flipped exactly this to ON.
    aliasBucket.addPropertyOverride('InventoryConfigurations', [
      {
        Id: 'alias-inventory',
        Enabled: 'false',
        IncludedObjectVersions: 'All',
        ScheduleFrequency: 'Daily',
        Destination: {
          BucketArn: `arn:aws:s3:::cdkd-lifecycle-alias-${cdk.Stack.of(this).account}`,
          Format: 'CSV',
          Prefix: 'inv/',
        },
      },
    ]);
    aliasBucket.addPropertyOverride('LifecycleConfiguration.Rules', [
      {
        Id: 'alias-transitions',
        Status: 'Enabled',
        Prefix: 'alias/',
        Transitions: [{ Days: update ? 60 : 90, StorageClass: 'GLACIER' }],
        NoncurrentVersionTransitions: [{ NoncurrentDays: 15, StorageClass: 'GLACIER' }],
      },
    ]);
  }
}
