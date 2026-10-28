import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';

// cdkd Kinesis StreamMode-switch integ probe.
//
// Phase 1 (base): PROVISIONED, 1 shard, two explicit shard-level metrics,
//                 MaxRecordSizeInKiB 2048.
// Phase 2 (CDKD_TEST_UPDATE=true): ON_DEMAND, metrics switched to the `ALL`
//                 shorthand, MaxRecordSizeInKiB 4096, RecordDistributionStrategy
//                 AUTO.
// Phase 2c (+ CDKD_TEST_REMOVAL=true): the second, always-ON_DEMAND stream
//                 drops its RecordDistributionStrategy (created as AUTO), and
//                 the first stream drops its MaxRecordSizeInKiB (4096).
//
// The Phase 2 property changes are the issue #609 backfill of
// `DesiredShardLevelMetrics` + `MaxRecordSizeInKiB`. Both are asserted against
// AWS (not just cdkd state) in verify.sh, per this repo's rule that a backfill
// integ must prove the property reached AWS. `ALL` is the interesting case: AWS
// EXPANDS it into seven metric names and never stores the literal, so cdkd
// expands it on the wire, records the expanded list via `effectiveProperties`,
// and narrows both diff sides through `canonicalizeDesiredProperties` — the
// fixture asserts the resulting `cdkd diff` is clean, which is what proves the
// two halves agree.
//
// CFn applies a StreamModeDetails change in place via UpdateStreamMode. cdkd's
// kinesis-provider.update() previously had no UpdateStreamMode call, so the
// switch was silently dropped: the deploy reported success while AWS kept the
// old mode (and the next diff saw no change, so it could never self-heal). The
// fix wires UpdateStreamMode into update(); this fixture proves the switch
// actually reaches AWS.
export class KinesisStreamModeSwitchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const toOnDemand = process.env.CDKD_TEST_UPDATE === 'true';

    // AWS rate-limits StreamMode switches per stream NAME (a few per rolling
    // 24h window), so verify.sh hands each run a unique name to keep the test
    // repeatable; fall back to a fixed name for a one-off manual deploy.
    const streamName = process.env.CDKD_KINESIS_STREAM_NAME ?? 'cdkd-kinesis-mode-switch-test';

    const stream = new kinesis.Stream(this, 'Stream', {
      streamName,
      streamMode: toOnDemand ? kinesis.StreamMode.ON_DEMAND : kinesis.StreamMode.PROVISIONED,
      ...(toOnDemand ? {} : { shardCount: 1 }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Issue #609 backfill coverage. Neither property is exposed on the L2, so
    // they are set on the L1 child. These are VALID values (unlike the
    // malformed-shape probes elsewhere in the tree), so the L1 accepts them
    // directly and no `addPropertyOverride` escape is needed.
    const cfnStream = stream.node.defaultChild as kinesis.CfnStream;
    // Phase 1 lists two metrics explicitly; Phase 2 switches to the `ALL`
    // shorthand, which AWS expands to seven names server-side.
    cfnStream.desiredShardLevelMetrics = toOnDemand
      ? ['ALL']
      : ['IncomingBytes', 'OutgoingBytes'];
    // go-to-k/cdkd#1160 REMOVAL path: CDKD_TEST_REMOVAL drops the Phase 2 size,
    // and CloudFormation resets a removed MaxRecordSizeInKiB to 1024 (CFn A/B),
    // so cdkd must send that reset.
    if (process.env.CDKD_TEST_REMOVAL !== 'true') {
      cfnStream.maxRecordSizeInKiB = toOnDemand ? 4096 : 2048;
    }
    // go-to-k/cdkd#2762 UPDATE path: `RecordDistributionStrategy` is ON_DEMAND
    // only, so it arrives with the Phase 2 mode switch and must be sent AFTER
    // UpdateStreamMode. Kept under CDKD_TEST_REMOVAL: it is the retained
    // sibling of the removal below.
    if (toOnDemand) cfnStream.recordDistributionStrategy = 'AUTO';

    // go-to-k/cdkd#2762 CREATE + REMOVAL path: an ON_DEMAND stream created with
    // `AUTO` (on `CreateStream` itself). CDKD_TEST_REMOVAL drops the property,
    // and CloudFormation resets a removed strategy to `USER_PARTITION_KEY`
    // (CFn A/B), so cdkd must too.
    const strategyStream = new kinesis.Stream(this, 'StrategyStream', {
      streamName: `${streamName}-rds`,
      streamMode: kinesis.StreamMode.ON_DEMAND,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    if (process.env.CDKD_TEST_REMOVAL !== 'true') {
      (strategyStream.node.defaultChild as kinesis.CfnStream).recordDistributionStrategy = 'AUTO';
    }
    // go-to-k/cdkd#5487: CDKD_TEST_RETENTION=48 raises the retention period,
    // which verify.sh's Phase 2d cuts short with a per-type deadline.
    if (process.env.CDKD_TEST_RETENTION === '48') {
      (strategyStream.node.defaultChild as kinesis.CfnStream).retentionPeriodHours = 48;
    }
  }
}
