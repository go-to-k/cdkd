/**
 * go-to-k/cdkd#4339: a refusal's pasted command, and the update-path lines,
 * named a resource by its RECORDED physical id. When the name came from a
 * secret that has since been ROTATED under an unchanged `{{resolve:...}}`
 * reference, that id is the PRE-rotation value, which this deploy's masker
 * never resolved (it holds only the new value), so it printed in plaintext.
 *
 * Each site is driven with the rotation: the record keeps the reference, the
 * desired side carries the NEW resolved value, the physical id carries the
 * OLD one, and the masker knows only the new one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, debugSpy, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

function sdkClientMock(clientName: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [clientName]: vi.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-auto-scaling', sdkClientMock('AutoScalingClient'));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', sdkClientMock('ElasticLoadBalancingV2Client'));
vi.mock('@aws-sdk/client-s3vectors', sdkClientMock('S3VectorsClient'));
vi.mock('@aws-sdk/client-rds', sdkClientMock('RDSClient'));
vi.mock('@aws-sdk/client-kinesis', sdkClientMock('KinesisClient'));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };
  return {
    getAwsClients: () => ({ iam: client, cloudWatchLogs: client, sts: client, dynamoDB: client }),
  };
});

vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { hasRedactedCause } from '../../../src/deployment/retryable-errors.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import { UNNAMEABLE_ID_CLAUSE } from '../../../src/provisioning/replacement-protection-advice.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import type { UpdateContext } from '../../../src/types/resource.js';

/** The pre-rotation value the physical id carries, and the value it rotated to. */
const OLD = 'old-rotated-name';
const NEW = 'new-resolved-name';
const OLD_PATH = '/old-rotated-path/';
const NEW_PATH = '/new-resolved-path/';
const REF = '{{resolve:secretsmanager:name-secret:SecretString:name}}';

/**
 * This deploy's masker: it resolved only the NEW values, from the same
 * reference the record keeps (the rotation changed the secret, not the
 * reference).
 */
const context: UpdateContext = {
  maskSecrets: createSecretMasker(
    new Map([
      [NEW, REF],
      [NEW_PATH, REF],
    ])
  ),
};

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

function fakeAws(answers: Record<string, (input: Record<string, unknown>) => unknown> = {}): void {
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const answer = answers[commandName(command)];
    if (answer) return answer(command.input);
    return {};
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

const lines = (spy: typeof debugSpy): string[] => spy.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  fakeAws();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AutoScalingGroup', () => {
  const rotated = () =>
    new ASGProvider().update(
      'Asg',
      OLD,
      'AWS::AutoScaling::AutoScalingGroup',
      { AutoScalingGroupName: NEW, MinSize: '0', MaxSize: '1' },
      {
        AutoScalingGroupName: REF,
        MinSize: '0',
        MaxSize: '1',
        DeletionProtection: 'prevent-all-deletion',
      },
      context
    );

  it('the refusal withholds the pasted command naming the pre-rotation name', async () => {
    const error = await thrown(rotated());
    expect(error.message).toContain('AutoScalingGroupName is immutable');
    expect(error.message).not.toContain(OLD);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
  });

  it('the updating line masks the pre-rotation name', async () => {
    await thrown(rotated());
    const updating = lines(debugSpy).find((l) => l.startsWith('Updating AutoScalingGroup'));
    expect(updating).toBeDefined();
    expect(updating).not.toContain(OLD);
  });

  it('the RECORDED reference alone is the witness: a plain desired name still masks the old one', async () => {
    const error = await thrown(
      new ASGProvider().update(
        'Asg',
        OLD,
        'AWS::AutoScaling::AutoScalingGroup',
        { AutoScalingGroupName: 'plain-desired-name', MinSize: '0', MaxSize: '1' },
        {
          AutoScalingGroupName: REF,
          MinSize: '0',
          MaxSize: '1',
          DeletionProtection: 'prevent-all-deletion',
        },
        context
      )
    );
    expect(error.message).not.toContain(OLD);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
    const updating = lines(debugSpy).find((l) => l.startsWith('Updating AutoScalingGroup'));
    expect(updating).toBeDefined();
    expect(updating).not.toContain(OLD);
  });

  it('a rollback replay: the post-update ARN read failure line masks the old name', async () => {
    fakeAws({
      DescribeAutoScalingGroupsCommand: () => {
        throw new Error('throttled');
      },
    });
    await new ASGProvider().update(
      'Asg',
      OLD,
      'AWS::AutoScaling::AutoScalingGroup',
      { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '2' },
      { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '1' },
      context
    );
    const failed = lines(debugSpy).find((l) => l.startsWith('DescribeAutoScalingGroups('));
    expect(failed).toBeDefined();
    expect(failed).not.toContain(OLD);
  });

  it('a rollback replay: the target-group convergence warning masks the old name', async () => {
    vi.useFakeTimers();
    fakeAws({
      DescribeAutoScalingGroupsCommand: () => ({ AutoScalingGroups: [{ TargetGroupARNs: [] }] }),
    });
    const update = new ASGProvider().update(
      'Asg',
      OLD,
      'AWS::AutoScaling::AutoScalingGroup',
      { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '1', TargetGroupARNs: ['arn:tg-1'] },
      { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '1', TargetGroupARNs: [] },
      context
    );
    await vi.advanceTimersByTimeAsync(40_000);
    await update;
    const warn = lines(warnSpy).find((l) => l.includes('did not converge'));
    expect(warn).toBeDefined();
    expect(warn).not.toContain(OLD);
  });

  it('a rollback replay (both sides recorded): an AWS failure quoting the old name is masked', async () => {
    const awsFailure = new Error(`AutoScalingGroup ${OLD} is busy`);
    mockSend.mockRejectedValue(awsFailure);
    const error = await thrown(
      new ASGProvider().update(
        'Asg',
        OLD,
        'AWS::AutoScaling::AutoScalingGroup',
        { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '2' },
        { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '1' },
        context
      )
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).not.toContain(OLD);
    expect(hasRedactedCause(error)).toBe(true);
  });
});

describe('ELBv2', () => {
  const lbArn = (name: string) =>
    `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/${name}/50dc6c495c0c9188`;

  it('LoadBalancer: the refusal withholds the pasted command naming the pre-rotation ARN', async () => {
    const error = await thrown(
      new ELBv2Provider().update(
        'Lb',
        lbArn(OLD),
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: NEW, SecurityGroups: ['sg-1'] },
        {
          Name: REF,
          SecurityGroups: ['sg-1'],
          LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
        },
        context
      )
    );
    expect(error.message).toContain('ELBv2 LoadBalancer Name / Type / Scheme are immutable');
    expect(error.message).not.toContain(OLD);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
  });

  it('LoadBalancer: an AWS failure quoting the old ARN is masked in the thrown error', async () => {
    fakeAws({
      ModifyLoadBalancerAttributesCommand: () => {
        throw new Error(`One or more load balancers not found: ${lbArn(OLD)}`);
      },
    });
    const error = await thrown(
      new ELBv2Provider().update(
        'Lb',
        lbArn(OLD),
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        {
          Name: REF,
          LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '120' }],
        },
        {
          Name: REF,
          LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
        },
        context
      )
    );
    expect(error.message).toContain('Failed to update ELBv2 resource Lb');
    expect(error.message).not.toContain(OLD);
  });

  it('LoadBalancer: the guard keeps the deploy masker, so the old name is no "resolved" value', async () => {
    // A desired `Scheme` spelling the recorded (pre-rotation) name is not one
    // this deploy resolved: the masker arm must not exempt it.
    const error = await thrown(
      new ELBv2Provider().update(
        'Lb',
        lbArn(OLD),
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: OLD, Scheme: OLD, SecurityGroups: ['sg-2'] },
        { Name: REF, Scheme: REF, SecurityGroups: ['sg-1'] },
        context
      )
    );
    expect(error.message).toContain('ELBv2 LoadBalancer Name / Type / Scheme are immutable');
  });

  it('LoadBalancer: an unrotated plain name still gets the command', async () => {
    const error = await thrown(
      new ELBv2Provider().update(
        'Lb',
        lbArn('plain-lb'),
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: 'renamed-lb', SecurityGroups: ['sg-1'] },
        {
          Name: 'plain-lb',
          SecurityGroups: ['sg-1'],
          LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
        },
        context
      )
    );
    expect(error.message).toContain(`--load-balancer-arn ${lbArn('plain-lb')}`);
  });

  it('TargetGroup: the updating and tag lines mask the pre-rotation name its ARN carries', async () => {
    const tgArn = `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${OLD}/73e2d6bc24d8a067`;
    fakeAws({
      DescribeTargetGroupsCommand: () => ({ TargetGroups: [{ TargetGroupArn: tgArn }] }),
      DescribeTargetGroupAttributesCommand: () => ({ Attributes: [] }),
      DescribeTargetHealthCommand: () => ({ TargetHealthDescriptions: [] }),
    });
    await new ELBv2Provider().update(
      'Tg',
      tgArn,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      { Name: NEW, Tags: [{ Key: 'k', Value: '2' }] },
      { Name: REF, Tags: [{ Key: 'k', Value: '1' }] },
      context
    );
    const debug = lines(debugSpy);
    const updating = debug.find((l) => l.startsWith('Updating TargetGroup'));
    const tagLine = debug.find((l) => l.includes('tag(s)'));
    expect(updating).toBeDefined();
    expect(tagLine).toBeDefined();
    expect(updating).not.toContain(OLD);
    expect(tagLine).not.toContain(OLD);
  });
});

describe('IAM ManagedPolicy: a rotated secret-derived Path replaces the policy', () => {
  const POLICY_DOC = { Version: '2012-10-17', Statement: [] };
  const replace = (oldPath: string, newPath: string) => {
    const oldArn = `arn:aws:iam::123456789012:policy${oldPath}Pol`;
    fakeAws({
      CreatePolicyCommand: () => ({
        Policy: { Arn: `arn:aws:iam::123456789012:policy${newPath}Pol`, PolicyName: 'Pol' },
      }),
    });
    // The document changes too: an unchanged reference alone diffs as no
    // change, so the engine reaches update() only for another property.
    return new IAMManagedPolicyProvider().update(
      'Policy',
      oldArn,
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: 'Pol', PolicyDocument: { ...POLICY_DOC, v: 2 }, Path: newPath },
      { ManagedPolicyName: 'Pol', PolicyDocument: POLICY_DOC, Path: REF },
      context
    );
  };

  it('the replacing line and the inner delete lines mask the pre-rotation path', async () => {
    const result = await replace(OLD_PATH, NEW_PATH);
    expect(result.wasReplaced).toBe(true);
    const debug = lines(debugSpy);
    const replacing = debug.find((l) => l.includes('replacing managed policy'));
    const deleting = debug.find((l) => l.startsWith('Deleting IAM managed policy'));
    expect(replacing).toBeDefined();
    expect(deleting).toBeDefined();
    expect(replacing).not.toContain(OLD_PATH);
    expect(deleting).not.toContain(OLD_PATH);
  });

  it('the inner delete failure quoting the old ARN is masked in the partial outcome', async () => {
    fakeAws({
      CreatePolicyCommand: () => ({
        Policy: { Arn: `arn:aws:iam::123456789012:policy${NEW_PATH}Pol`, PolicyName: 'Pol' },
      }),
      DeletePolicyCommand: () => {
        throw new Error(`Policy arn:aws:iam::123456789012:policy${OLD_PATH}Pol is in use`);
      },
    });
    const result = await new IAMManagedPolicyProvider().update(
      'Policy',
      `arn:aws:iam::123456789012:policy${OLD_PATH}Pol`,
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: 'Pol', PolicyDocument: { ...POLICY_DOC, v: 2 }, Path: NEW_PATH },
      { ManagedPolicyName: 'Pol', PolicyDocument: POLICY_DOC, Path: REF },
      context
    );
    expect(result.outcome).toBe('partial');
    expect(result.reason).not.toContain(OLD_PATH);
    const warnings = lines(warnSpy).filter((l) => l.includes('old managed policy'));
    expect(warnings.length).toBeGreaterThan(0);
    for (const line of warnings) expect(line).not.toContain(OLD_PATH);
  });

  it('delete() with a masker: its own failure wrap masks and stamps the old path', async () => {
    const oldArn = `arn:aws:iam::123456789012:policy${OLD_PATH}Pol`;
    fakeAws({
      DeletePolicyCommand: () => {
        throw new Error(`Policy ${oldArn} is in use`);
      },
    });
    const mask = (text: string) => text.split(OLD_PATH).join('***');
    const error = await thrown(
      new IAMManagedPolicyProvider().delete(
        'Policy',
        oldArn,
        'AWS::IAM::ManagedPolicy',
        undefined,
        undefined,
        mask
      )
    );
    expect(error.message).toContain('Failed to delete IAM managed policy Policy');
    expect(error.message).not.toContain(OLD_PATH);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('delete() with a masker: the already-gone line masks the old path', async () => {
    const oldArn = `arn:aws:iam::123456789012:policy${OLD_PATH}Pol`;
    const { NoSuchEntityException } = await import('@aws-sdk/client-iam');
    fakeAws({
      GetPolicyCommand: () => {
        throw new NoSuchEntityException({ message: 'gone', $metadata: {} });
      },
    });
    const mask = (text: string) => text.split(OLD_PATH).join('***');
    await new IAMManagedPolicyProvider().delete(
      'Policy',
      oldArn,
      'AWS::IAM::ManagedPolicy',
      undefined,
      undefined,
      mask
    );
    const gone = lines(debugSpy).find((l) => l.includes('does not exist, skipping deletion'));
    expect(gone).toBeDefined();
    expect(gone).not.toContain(OLD_PATH);
  });

  it('a root path is no needle: the lines keep their slashes', async () => {
    await replace('/', NEW_PATH);
    const deleting = lines(debugSpy).find((l) => l.startsWith('Deleting IAM managed policy'));
    expect(deleting).toContain('arn:aws:iam::123456789012:policy/Pol');
  });
});

describe('Logs LogGroup', () => {
  const classChange = (physicalId: string, previousName: string) =>
    new LogsLogGroupProvider().update(
      'Lg',
      physicalId,
      'AWS::Logs::LogGroup',
      { LogGroupName: NEW, LogGroupClass: 'INFREQUENT_ACCESS' },
      { LogGroupName: previousName, LogGroupClass: 'STANDARD', DeletionProtectionEnabled: true },
      context
    );

  it('the class refusal withholds the pasted command naming the pre-rotation name', async () => {
    const error = await thrown(classChange(OLD, REF));
    expect(error.message).toContain('cannot be changed after creation');
    expect(error.message).not.toContain(OLD);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
  });

  it('an unrotated secret-derived name is withheld too (the command had no masker at all)', async () => {
    const error = await thrown(classChange(NEW, REF));
    expect(error.message).not.toContain(NEW);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
  });

  it('the updating line masks the pre-rotation name', async () => {
    await thrown(classChange(OLD, REF));
    const updating = lines(debugSpy).find((l) => l.startsWith('Updating log group'));
    expect(updating).toBeDefined();
    expect(updating).not.toContain(OLD);
  });

  it('the RECORDED reference alone is the witness: a plain desired name still masks the old one', async () => {
    const error = await thrown(
      new LogsLogGroupProvider().update(
        'Lg',
        OLD,
        'AWS::Logs::LogGroup',
        { LogGroupName: 'plain-desired-group', LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupName: REF, LogGroupClass: 'STANDARD', DeletionProtectionEnabled: true },
        context
      )
    );
    expect(error.message).not.toContain(OLD);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
  });

  it('the KMS, field-index and tag lines mask the pre-rotation name', async () => {
    await new LogsLogGroupProvider().update(
      'Lg',
      OLD,
      'AWS::Logs::LogGroup',
      {
        LogGroupName: NEW,
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k2',
        FieldIndexPolicies: [{ Fields: ['a'] }, { Fields: ['b'] }],
        Tags: [{ Key: 'k', Value: '2' }],
      },
      {
        LogGroupName: REF,
        KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k1',
        Tags: [{ Key: 'k', Value: '1' }],
      },
      context
    );
    const debug = lines(debugSpy);
    for (const needle of ['KMS key association', 'FieldIndexPolicies', 'Updated tags for log group']) {
      const line = debug.find((l) => l.includes(needle));
      expect(line, needle).toBeDefined();
      expect(line, needle).not.toContain(OLD);
    }
  });

  it('a plain name still gets the command', async () => {
    const error = await thrown(
      new LogsLogGroupProvider().update(
        'Lg',
        'plain-group',
        'AWS::Logs::LogGroup',
        { LogGroupName: 'plain-group', LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupName: 'plain-group', LogGroupClass: 'STANDARD', DeletionProtectionEnabled: true },
        context
      )
    );
    expect(error.message).toContain('--log-group-identifier plain-group');
  });
});

describe('DynamoDB GlobalTable (already paired by #2177; pinned here)', () => {
  it('the TableName refusal withholds the pasted command naming the pre-rotation name', async () => {
    const error = await thrown(
      new DynamoDBGlobalTableProvider().update(
        'Gt',
        OLD,
        'AWS::DynamoDB::GlobalTable',
        {
          TableName: NEW,
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }],
        },
        {
          TableName: REF,
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }],
        },
        context
      )
    );
    expect(error.message).toContain('TableName');
    expect(error.message).not.toContain(OLD);
    expect(error.message).toContain(UNNAMEABLE_ID_CLAUSE);
  });
});

describe('S3 Vectors VectorBucket', () => {
  it('the create-only refusal masks the pre-rotation bucket name', async () => {
    const error = await thrown(
      new S3VectorsProvider().update(
        'Vb',
        OLD,
        'AWS::S3Vectors::VectorBucket',
        { VectorBucketName: NEW },
        { VectorBucketName: REF },
        context
      )
    );
    expect(error.message).toContain("'VectorBucketName' is immutable");
    expect(error.message).not.toContain(OLD);
  });

  it('a rollback replay: an ARN-lookup failure quoting the old name is masked and stamped', async () => {
    fakeAws({
      GetVectorBucketCommand: () => {
        throw new Error(`Vector bucket ${OLD} is busy`);
      },
    });
    const error = await thrown(
      new S3VectorsProvider().update(
        'Vb',
        OLD,
        'AWS::S3Vectors::VectorBucket',
        { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '2' }] },
        { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '1' }] },
        context
      )
    );
    expect(error.message).toContain('Failed to resolve ARN for S3 VectorBucket Vb');
    expect(error.message).not.toContain(OLD);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('a rollback replay: a tag failure and the missing-ARN refusal mask the old name', async () => {
    fakeAws({
      GetVectorBucketCommand: () => ({ vectorBucket: { vectorBucketArn: `arn:aws:s3vectors:us-east-1:123456789012:bucket/${OLD}` } }),
      TagResourceCommand: () => {
        throw new Error(`Tagging ${OLD} failed`);
      },
    });
    const tagged = await thrown(
      new S3VectorsProvider().update(
        'Vb',
        OLD,
        'AWS::S3Vectors::VectorBucket',
        { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '2' }] },
        { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '1' }] },
        context
      )
    );
    expect(tagged.message).toContain('Failed to update tags for S3 VectorBucket Vb');
    expect(tagged.message).not.toContain(OLD);
    fakeAws({ GetVectorBucketCommand: () => ({ vectorBucket: {} }) });
    const noArn = await thrown(
      new S3VectorsProvider().update(
        'Vb',
        OLD,
        'AWS::S3Vectors::VectorBucket',
        { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '2' }] },
        { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '1' }] },
        context
      )
    );
    expect(noArn.message).toContain('Could not resolve ARN for S3 VectorBucket Vb');
    expect(noArn.message).not.toContain(OLD);
  });

  it('a rollback replay: the updated-tags line masks the old name', async () => {
    fakeAws({
      GetVectorBucketCommand: () => ({ vectorBucket: { vectorBucketArn: 'arn:aws:s3vectors:us-east-1:123456789012:bucket/x' } }),
    });
    await new S3VectorsProvider().update(
      'Vb',
      OLD,
      'AWS::S3Vectors::VectorBucket',
      { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '2' }] },
      { VectorBucketName: REF, Tags: [{ Key: 'k', Value: '1' }] },
      context
    );
    const line = lines(debugSpy).find((l) => l.startsWith('Updated tags for S3 VectorBucket'));
    expect(line).toBeDefined();
    expect(line).not.toContain(OLD);
  });
});

describe('RDS DBProxy / DBProxyEndpoint (a rollback replay: both sides recorded)', () => {
  it('DBProxy: the updating line and an AWS failure quoting the old name are masked', async () => {
    fakeAws({
      ModifyDBProxyCommand: () => {
        throw new Error(`DBProxy ${OLD} is busy`);
      },
    });
    const error = await thrown(
      new RDSDBProxyProvider().update(
        'Proxy',
        OLD,
        'AWS::RDS::DBProxy',
        { DBProxyName: REF, RequireTLS: true },
        { DBProxyName: REF, RequireTLS: false },
        context
      )
    );
    const updating = lines(debugSpy).find((l) => l.startsWith('Updating DBProxy '));
    expect(updating).toBeDefined();
    expect(updating).not.toContain(OLD);
    expect(error.message).toContain('UPDATE failed for Proxy');
    expect(error.message).not.toContain(OLD);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('DBProxy: the tag-lookup failure line masks the old name', async () => {
    fakeAws({
      DescribeDBProxiesCommand: () => {
        throw new Error('throttled');
      },
    });
    await new RDSDBProxyProvider().update(
      'Proxy',
      OLD,
      'AWS::RDS::DBProxy',
      { DBProxyName: REF, Tags: [{ Key: 'k', Value: '2' }] },
      { DBProxyName: REF, Tags: [{ Key: 'k', Value: '1' }] },
      context
    );
    const skipped = [...lines(debugSpy), ...lines(warnSpy)].find((l) =>
      l.startsWith('Skipping tag diff for')
    );
    expect(skipped).toBeDefined();
    expect(skipped).not.toContain(OLD);
  });

  it('DBProxyEndpoint: the updating line and an AWS failure quoting the old name are masked', async () => {
    fakeAws({
      ModifyDBProxyEndpointCommand: () => {
        throw new Error(`DBProxyEndpoint ${OLD} is busy`);
      },
    });
    const error = await thrown(
      new RDSDBProxyEndpointProvider().update(
        'Endpoint',
        OLD,
        'AWS::RDS::DBProxyEndpoint',
        { DBProxyEndpointName: REF, VpcSecurityGroupIds: ['sg-2'] },
        { DBProxyEndpointName: REF, VpcSecurityGroupIds: ['sg-1'] },
        context
      )
    );
    const updating = lines(debugSpy).find((l) => l.startsWith('Updating DBProxyEndpoint '));
    expect(updating).toBeDefined();
    expect(updating).not.toContain(OLD);
    expect(error.message).toContain('UPDATE failed for Endpoint');
    expect(error.message).not.toContain(OLD);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('DBProxyEndpoint: the tag-lookup failure line masks the old name', async () => {
    fakeAws({
      DescribeDBProxyEndpointsCommand: () => {
        throw new Error('throttled');
      },
    });
    await new RDSDBProxyEndpointProvider().update(
      'Endpoint',
      OLD,
      'AWS::RDS::DBProxyEndpoint',
      { DBProxyEndpointName: REF, Tags: [{ Key: 'k', Value: '2' }] },
      { DBProxyEndpointName: REF, Tags: [{ Key: 'k', Value: '1' }] },
      context
    );
    const skipped = [...lines(debugSpy), ...lines(warnSpy)].find((l) =>
      l.startsWith('Skipping tag diff for')
    );
    expect(skipped).toBeDefined();
    expect(skipped).not.toContain(OLD);
  });
});

describe('RDS DBProxy / DBProxyEndpoint tag failures (a rollback replay)', () => {
  for (const [label, make, type, key, describeCommand, arnAnswer] of [
    [
      'DBProxy',
      () => new RDSDBProxyProvider(),
      'AWS::RDS::DBProxy',
      'DBProxyName',
      'DescribeDBProxiesCommand',
      { DBProxies: [{ DBProxyArn: 'arn:aws:rds:us-east-1:123456789012:db-proxy:prx-0123' }] },
    ],
    [
      'DBProxyEndpoint',
      () => new RDSDBProxyEndpointProvider(),
      'AWS::RDS::DBProxyEndpoint',
      'DBProxyEndpointName',
      'DescribeDBProxyEndpointsCommand',
      {
        DBProxyEndpoints: [
          { DBProxyEndpointArn: 'arn:aws:rds:us-east-1:123456789012:db-proxy-endpoint:prx-endpoint-0123' },
        ],
      },
    ],
  ] as const) {
    for (const [verb, command, tags, prevTags] of [
      ['remove', 'RemoveTagsFromResourceCommand', [], [{ Key: 'k', Value: '1' }]],
      ['add', 'AddTagsToResourceCommand', [{ Key: 'k', Value: '1' }], []],
    ] as const) {
      it(`${label}: a ${verb}-tags failure quoting the old name is masked and stamped`, async () => {
        fakeAws({
          [describeCommand]: () => arnAnswer,
          [command]: () => {
            throw new Error(`Resource ${OLD} is busy`);
          },
        });
        const error = await thrown(
          make().update(
            'Res',
            OLD,
            type,
            { [key]: REF, Tags: tags },
            { [key]: REF, Tags: prevTags },
            context
          )
        );
        expect(error.message).toContain(`UPDATE (${verb} tags) failed for Res`);
        expect(error.message).not.toContain(OLD);
        expect(hasRedactedCause(error)).toBe(true);
      });
    }
  }
});

describe('Kinesis StreamConsumer (a rollback replay: both sides recorded)', () => {
  const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/s1';
  const consumerArn = `${STREAM_ARN}/consumer/${OLD}:1700000000`;
  const update = () =>
    new KinesisStreamConsumerProvider().update(
      'Consumer',
      consumerArn,
      'AWS::Kinesis::StreamConsumer',
      { ConsumerName: REF, StreamARN: STREAM_ARN, Tags: [{ Key: 'k', Value: '2' }] },
      {
        ConsumerName: REF,
        StreamARN: STREAM_ARN,
        Tags: [
          { Key: 'k', Value: '1' },
          { Key: 'gone', Value: 'x' },
        ],
      },
      context
    );

  it('the tag lines and the attribute-refresh failure line mask the old name its ARN carries', async () => {
    fakeAws({
      DescribeStreamConsumerCommand: () => {
        throw new Error('throttled');
      },
    });
    await update();
    const debug = lines(debugSpy);
    const tagLines = debug.filter((l) => l.includes('tag(s)'));
    const refresh = debug.find((l) => l.startsWith('DescribeStreamConsumer('));
    expect(tagLines).toHaveLength(2);
    expect(refresh).toBeDefined();
    for (const line of [...tagLines, refresh]) expect(line).not.toContain(OLD);
  });

  it('an AWS failure quoting the consumer ARN is masked and stamped', async () => {
    fakeAws({
      UntagResourceCommand: () => {
        throw new Error(`Consumer ${consumerArn} not found`);
      },
    });
    const error = await thrown(update());
    expect(error.message).toContain('Failed to update Kinesis stream consumer Consumer');
    expect(error.message).not.toContain(OLD);
    expect(hasRedactedCause(error)).toBe(true);
  });
});
