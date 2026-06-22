import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';

// cdkd Kinesis StreamMode-switch integ probe.
//
// Phase 1 (base): PROVISIONED, 1 shard.
// Phase 2 (CDKD_TEST_UPDATE=true): ON_DEMAND.
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

    new kinesis.Stream(this, 'Stream', {
      streamName,
      streamMode: toOnDemand ? kinesis.StreamMode.ON_DEMAND : kinesis.StreamMode.PROVISIONED,
      ...(toOnDemand ? {} : { shardCount: 1 }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
