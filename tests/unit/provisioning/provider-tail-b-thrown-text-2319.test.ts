import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { FirehoseClient } from '@aws-sdk/client-firehose';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { KinesisClient } from '@aws-sdk/client-kinesis';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { S3Client } from '@aws-sdk/client-s3';

const { mockSend, debug } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debug: vi.fn(),
}));

// Every client a provider in this slice reads from `getAwsClients()` routes to
// `mockSend`; the ones a provider constructs itself are stubbed on their
// prototype below.
vi.mock('../../../src/utils/aws-clients.js', () => {
  const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };
  return { getAwsClients: () => new Proxy({}, { get: () => client }) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { CloudWatchAlarmProvider } from '../../../src/provisioning/providers/cloudwatch-alarm-provider.js';
import { CloudWatchAnomalyDetectorProvider } from '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';
import { CloudFrontOACProvider } from '../../../src/provisioning/providers/cloudfront-oac-provider.js';
import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';
import { AgentCoreEvaluatorProvider } from '../../../src/provisioning/providers/agentcore-evaluator-provider.js';
import { AgentCoreBrowserProvider } from '../../../src/provisioning/providers/agentcore-browser-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { awsSdkError } from '../_aws-sdk-error.js';

type Sendable = { send: (...args: unknown[]) => unknown };
for (const C of [
  ElasticLoadBalancingV2Client,
  FirehoseClient,
  S3VectorsClient,
  KinesisClient,
  CloudFrontClient,
  S3Client,
]) {
  vi.spyOn(C.prototype as unknown as Sendable, 'send').mockImplementation(
    (...args: unknown[]) => mockSend(...args) as unknown
  );
}

// create() runs outside a withStackScope scope here, so the stack-scoped
// create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

// go-to-k/cdkd#2319: a provider's create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const DENIED =
  'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y';
const denied = (): Error => {
  const error = awsSdkError(DENIED, 'AccessDenied');
  Object.assign(error, { $fault: 'client' });
  return error;
};
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const ctx = { maskSecrets: mask };
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const FH = 'AWS::KinesisFirehose::DeliveryStream';
const ALARM = 'AWS::CloudWatch::Alarm';
const AD = 'AWS::CloudWatch::AnomalyDetector';
const OAC = 'AWS::CloudFront::OriginAccessControl';
const DIR = 'AWS::S3Express::DirectoryBucket';
const RUNTIME = 'AWS::BedrockAgentCore::Runtime';
const EVALUATOR = 'AWS::BedrockAgentCore::Evaluator';
const BROWSER = 'AWS::BedrockAgentCore::Browser';
const VB = 'AWS::S3Vectors::VectorBucket';
const CONSUMER = 'AWS::Kinesis::StreamConsumer';

const ALARM_PROPS = {
  AlarmName: 'a',
  MetricName: 'm',
  Namespace: 'n',
  Statistic: 'Average',
  Period: 60,
  EvaluationPeriods: 1,
  Threshold: 1,
  ComparisonOperator: 'GreaterThanThreshold',
};
const AD_PROPS = { Namespace: 'n', MetricName: 'm', Stat: 'Average' };
const OAC_PROPS = {
  OriginAccessControlConfig: {
    Name: 'oac',
    OriginAccessControlOriginType: 's3',
    SigningBehavior: 'always',
    SigningProtocol: 'sigv4',
  },
};
const VB_PROPS = { VectorBucketName: 'vb' };
const CONSUMER_PROPS = {
  ConsumerName: 'c',
  StreamARN: 'arn:aws:kinesis:us-east-1:111122223333:stream/s',
};
const CONSUMER_ARN =
  'arn:aws:kinesis:us-east-1:111122223333:stream/s/consumer/c:1700000000';

const FH_PROPS = { DeliveryStreamName: 'fh', DeliveryStreamType: 'DirectPut' };
const FH_PROPS_NEW = { ...FH_PROPS, Tags: [{ Key: 'k', Value: 'v' }] };
const DIR_NAME = 'b--use1-az4--x-s3';
const DIR_PROPS = {
  BucketName: DIR_NAME,
  DataRedundancy: 'SingleAvailabilityZone',
  LocationName: 'use1-az4',
};
const DIR_PROPS_NEW = { ...DIR_PROPS, Tags: [{ Key: 'k', Value: 'v' }] };
const RUNTIME_PROPS = {
  AgentRuntimeName: 'rt',
  RoleArn: 'arn:aws:iam::111122223333:role/r',
  AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: 'u' } },
  NetworkConfiguration: { NetworkMode: 'PUBLIC' },
};
const RUNTIME_PROPS_NEW = { ...RUNTIME_PROPS, Description: 'd' };
const EVALUATOR_PROPS = { EvaluatorName: 'ev', Level: 'TRACE', EvaluatorConfig: {} };
const EVALUATOR_PROPS_NEW = { ...EVALUATOR_PROPS, Description: 'd' };

/**
 * `prime` makes only the site's own call reject, for a site an earlier call in
 * the same method would otherwise wrap first; without it every send rejects.
 */
type Case = {
  wrap: string;
  run: () => Promise<unknown>;
  prime?: (rejection: unknown) => void;
};

function reject(c: Case, rejection: unknown): void {
  if (c.prime) c.prime(rejection);
  else mockSend.mockRejectedValue(rejection);
}

const VB_ARN = 'arn:aws:s3vectors:us-east-1:111122223333:bucket/vb';

const cases: Case[] = [
  {
    wrap: 'Failed to delete LoadBalancer Lb',
    run: () => new ELBv2Provider().delete('Lb', 'arn:lb', LB, {}, ctx),
  },
  {
    wrap: 'Failed to delete TargetGroup Tg',
    run: () => new ELBv2Provider().delete('Tg', 'arn:tg', TG, {}, ctx),
  },
  {
    wrap: 'Failed to delete Listener L',
    run: () => new ELBv2Provider().delete('L', 'arn:l', LISTENER, {}, ctx),
  },
  {
    wrap: 'Failed to create Firehose delivery stream Fh',
    run: () => new FirehoseProvider().create('Fh', FH, FH_PROPS, ctx),
  },
  {
    wrap: 'Failed to update Firehose delivery stream Fh',
    run: () =>
      new FirehoseProvider().update('Fh', 'fh', FH, FH_PROPS_NEW, FH_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete Firehose delivery stream Fh',
    run: () => new FirehoseProvider().delete('Fh', 'fh', FH, {}, ctx),
  },
  {
    wrap: 'Failed to create CloudWatch alarm Al',
    run: () => new CloudWatchAlarmProvider().create('Al', ALARM, ALARM_PROPS, ctx),
  },
  {
    wrap: 'Failed to update CloudWatch alarm Al',
    run: () =>
      new CloudWatchAlarmProvider().update('Al', 'a', ALARM, ALARM_PROPS, ALARM_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete CloudWatch alarm Al',
    run: () => new CloudWatchAlarmProvider().delete('Al', 'a', ALARM, ALARM_PROPS, ctx),
  },
  {
    wrap: 'Failed to create CloudWatch anomaly detector Ad',
    run: () => new CloudWatchAnomalyDetectorProvider().create('Ad', AD, AD_PROPS, ctx),
  },
  {
    wrap: 'Failed to update CloudWatch anomaly detector Ad',
    run: () =>
      new CloudWatchAnomalyDetectorProvider().update('Ad', 'ad', AD, AD_PROPS, AD_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete CloudWatch anomaly detector Ad',
    run: () => new CloudWatchAnomalyDetectorProvider().delete('Ad', 'ad', AD, AD_PROPS, ctx),
  },
  {
    wrap: 'Failed to create CloudFront Origin Access Control Oac',
    run: () => new CloudFrontOACProvider().create('Oac', OAC, OAC_PROPS, ctx),
  },
  {
    wrap: 'Failed to update CloudFront Origin Access Control Oac',
    run: () =>
      new CloudFrontOACProvider().update('Oac', 'E1', OAC, OAC_PROPS, OAC_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete CloudFront Origin Access Control Oac',
    run: () => new CloudFrontOACProvider().delete('Oac', 'E1', OAC, OAC_PROPS, ctx),
  },
  {
    wrap: 'Failed to create S3 Express Directory Bucket Dir',
    run: () => new S3DirectoryBucketProvider().create('Dir', DIR, DIR_PROPS, ctx),
  },
  {
    wrap: 'Failed to update S3 Express Directory Bucket Dir',
    run: () =>
      new S3DirectoryBucketProvider().update('Dir', DIR_NAME, DIR, DIR_PROPS_NEW, DIR_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete S3 Express Directory Bucket Dir',
    run: () =>
      new S3DirectoryBucketProvider().delete('Dir', 'b--use1-az4--x-s3', DIR, {}, ctx),
  },
  {
    wrap: 'Failed to create BedrockAgentCore Runtime Rt',
    run: () => new AgentCoreRuntimeProvider().create('Rt', RUNTIME, RUNTIME_PROPS, ctx),
  },
  {
    wrap: 'Failed to update BedrockAgentCore Runtime Rt',
    run: () =>
      new AgentCoreRuntimeProvider().update('Rt', 'rt-1', RUNTIME, RUNTIME_PROPS_NEW, RUNTIME_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete BedrockAgentCore Runtime Rt',
    run: () => new AgentCoreRuntimeProvider().delete('Rt', 'rt-1', RUNTIME, {}, ctx),
  },
  {
    wrap: 'Failed to create BedrockAgentCore Evaluator Ev',
    run: () => new AgentCoreEvaluatorProvider().create('Ev', EVALUATOR, EVALUATOR_PROPS, ctx),
  },
  {
    wrap: 'Failed to update BedrockAgentCore Evaluator Ev',
    run: () =>
      new AgentCoreEvaluatorProvider().update('Ev', 'ev-1', EVALUATOR, EVALUATOR_PROPS_NEW, EVALUATOR_PROPS, ctx),
  },
  {
    wrap: 'Failed to delete BedrockAgentCore Evaluator Ev',
    run: () => new AgentCoreEvaluatorProvider().delete('Ev', 'ev-1', EVALUATOR, {}, ctx),
  },
  {
    wrap: 'Failed to adopt the AWS-managed default browser for Br',
    run: () => new AgentCoreBrowserProvider().create('Br', BROWSER, {}, ctx),
  },
  {
    wrap: 'Failed to create S3 VectorBucket Vb',
    run: () => new S3VectorsProvider().create('Vb', VB, VB_PROPS, ctx),
  },
  {
    wrap: 'Failed to resolve ARN for S3 VectorBucket Vb (vb) before tag update',
    run: () =>
      new S3VectorsProvider().update('Vb', 'vb', VB, { ...VB_PROPS, Tags: [{ Key: 'k', Value: 'v' }] }, VB_PROPS, ctx),
  },
  {
    wrap: 'Failed to update tags for S3 VectorBucket Vb (vb)',
    run: () =>
      new S3VectorsProvider().update(
        'Vb',
        'vb',
        VB,
        { ...VB_PROPS, Tags: [{ Key: 'k', Value: 'v' }] },
        VB_PROPS,
        ctx
      ),
    // GetVectorBucket resolves the ARN; the tag write is the call that fails.
    prime: (rejection) =>
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetVectorBucketCommand'
          ? Promise.resolve({ vectorBucket: { vectorBucketArn: VB_ARN } })
          : Promise.reject(rejection)
      ),
  },
  {
    wrap: 'Failed to delete S3 VectorBucket Vb',
    run: () => new S3VectorsProvider().delete('Vb', 'vb', VB, VB_PROPS, ctx),
  },
  {
    wrap: 'Failed to register Kinesis stream consumer Co',
    run: () => new KinesisStreamConsumerProvider().create('Co', CONSUMER, CONSUMER_PROPS, ctx),
  },
  {
    wrap: 'Failed to update Kinesis stream consumer Co',
    run: () =>
      new KinesisStreamConsumerProvider().update('Co', CONSUMER_ARN, CONSUMER, { ...CONSUMER_PROPS, Tags: [{ Key: 'k', Value: 'v' }] }, CONSUMER_PROPS, ctx),
  },
  {
    wrap: 'Failed to deregister Kinesis stream consumer Co',
    run: () =>
      new KinesisStreamConsumerProvider().delete('Co', CONSUMER_ARN, CONSUMER, CONSUMER_PROPS, ctx),
  },
];

describe('provider thrown wraps withhold AWS text (#2319)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    reject(c, denied());

    const failure = await caught(c.run());

    expect(failure.message.startsWith(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`)).toBe(true);
    expect(failure.message).not.toContain('111122223333:assumed-role');
    expect(failure.message).not.toContain('not authorized');
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines().some((l) => l.startsWith(`${c.wrap}: ${mask(DENIED)}`))).toBe(true);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    reject(c, new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(cases)('$wrap: a cdkd-authored failure the mask leaves alone is not stamped', async (c) => {
    reject(c, new Error('socket hang up'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each(cases)('$wrap: a non-Error throw is withheld, unstamped', async (c) => {
    reject(c, 'raw s3cr3t value');

    const failure = await caught(c.run());

    expect(failure.message).toContain(
      `${c.wrap}: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // A ConflictException matches no collision pattern by its class, so only the
  // restatement keeps a create-first replacement recognising a taken name.
  it.each(cases)('$wrap: restates an "already exists" the class does not carry', async (c) => {
    reject(c, awsSdkError('A resource named x already exists in 111122223333.', 'ConflictException'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(
      `${c.wrap}: ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('111122223333');
  });

  // RegisterStreamConsumer reports a taken name as ResourceInUseException,
  // whose class matches no collision pattern on its own.
  it('restates an "already exists" from RegisterStreamConsumer', async () => {
    mockSend.mockRejectedValue(
      awsSdkError(
        'Consumer c under stream s already exists for account 111122223333.',
        'ResourceInUseException'
      )
    );

    const failure = await caught(cases.find((c) => c.wrap.startsWith('Failed to register'))!.run());

    expect(failure.message).toBe(
      `Failed to register Kinesis stream consumer Co: ResourceInUseException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('111122223333');
    expect(isNameCollisionErrorFrom(failure, 'Co')).toBe(true);
  });
});
