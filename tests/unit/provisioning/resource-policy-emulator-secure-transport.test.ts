import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// The three resource-policy providers send the document through
// serializeResourcePolicy, so under --aws-emulator the enforceSSL Deny is left
// out of what AWS Emulator receives (aws/aws-emulator#369).

const mockSend = vi.fn();
const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sqs: client, s3: client, sns: client }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';
import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';

const ENFORCE_SSL = {
  Action: '*',
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  Effect: 'Deny',
  Principal: { AWS: '*' },
  Resource: '*',
};
const ALLOW = { Action: '*', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Resource: '*' };
const DOC = { Version: '2012-10-17', Statement: [ENFORCE_SSL, ALLOW] };
const SSL_ONLY = { Version: '2012-10-17', Statement: [ENFORCE_SSL] };
const EMULATOR = () => ({ endpoint: 'https://127.0.0.1:9297' });

/** Each command the provider sent: its class name and input. */
function sentCommands(): Array<{ name: string; input: Record<string, unknown> }> {
  return mockSend.mock.calls.map(([command]) => ({
    name: (command as object).constructor.name,
    input: (command as { input: Record<string, unknown> }).input,
  }));
}

/** The policy JSON of every write the provider sent. */
function sentPolicies(): unknown[] {
  return mockSend.mock.calls
    .map(([command]) => command.input as Record<string, unknown>)
    .map((input) =>
      input['Policy'] !== undefined
        ? input['Policy']
        : (input['Attributes'] as Record<string, unknown> | undefined)?.['Policy'] ??
          (input['AttributeName'] === 'Policy' ? input['AttributeValue'] : undefined)
    )
    .filter((policy): policy is string => typeof policy === 'string')
    .map((policy) => JSON.parse(policy));
}

const CASES = [
  {
    type: 'AWS::SQS::QueuePolicy',
    make: () => new SQSQueuePolicyProvider(),
    props: { Queues: ['https://sqs.us-east-1.amazonaws.com/000000000000/q'], PolicyDocument: DOC },
    physicalId: 'https://sqs.us-east-1.amazonaws.com/000000000000/q',
  },
  {
    type: 'AWS::S3::BucketPolicy',
    make: () => new S3BucketPolicyProvider(),
    props: { Bucket: 'b', PolicyDocument: DOC },
    physicalId: 'b',
  },
  {
    type: 'AWS::SNS::TopicPolicy',
    make: () => new SNSTopicPolicyProvider(),
    props: { Topics: ['arn:aws:sns:us-east-1:000000000000:t'], PolicyDocument: DOC },
    physicalId: 'arn:aws:sns:us-east-1:000000000000:t',
  },
] as const;

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

afterEach(() => {
  setAwsEndpointOverrideSource(undefined);
});

describe.each(CASES)('$type', ({ type, make, props, physicalId }) => {
  it('sends the templated document against AWS', async () => {
    await make().create('P', type, { ...props });
    expect(sentPolicies()).toEqual([DOC]);
  });

  it('leaves the enforceSSL Deny out on create under --aws-emulator', async () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9297' }));
    await make().create('P', type, { ...props });
    expect(sentPolicies()).toEqual([{ Version: '2012-10-17', Statement: [ALLOW] }]);
  });

  it('leaves the enforceSSL Deny out on update under --aws-emulator', async () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9297' }));
    await make().update('P', physicalId, type, { ...props }, { ...props });
    expect(sentPolicies()).toEqual([{ Version: '2012-10-17', Statement: [ALLOW] }]);
  });
});

// A queue / bucket / topic with only enforceSSL: the policy left after the drop
// is empty, and the emulator would deny every request under the templated one
// (an SQS -> Lambda event source mapping could not be created).
describe('a policy of only the enforceSSL Deny under --aws-emulator', () => {
  const QUEUE = 'https://sqs.us-east-1.amazonaws.com/000000000000/q';
  const TOPIC = 'arn:aws:sns:us-east-1:000000000000:t';

  it.each(['create', 'update'] as const)('SQS %s clears the queue policy', async (op) => {
    setAwsEndpointOverrideSource(EMULATOR);
    const props = { Queues: [QUEUE], PolicyDocument: SSL_ONLY };
    const provider = new SQSQueuePolicyProvider();
    if (op === 'create') await provider.create('P', 'AWS::SQS::QueuePolicy', props);
    else await provider.update('P', QUEUE, 'AWS::SQS::QueuePolicy', props, { ...props });
    expect(sentCommands()).toEqual([
      { name: 'SetQueueAttributesCommand', input: { QueueUrl: QUEUE, Attributes: { Policy: '' } } },
    ]);
  });

  it.each(['create', 'update'] as const)('SNS %s sets the default topic policy', async (op) => {
    setAwsEndpointOverrideSource(EMULATOR);
    const props = { Topics: [TOPIC], PolicyDocument: SSL_ONLY };
    const provider = new SNSTopicPolicyProvider();
    if (op === 'create') await provider.create('P', 'AWS::SNS::TopicPolicy', props);
    else await provider.update('P', TOPIC, 'AWS::SNS::TopicPolicy', props, { ...props });
    const [policy] = sentPolicies() as Array<{ Id?: string; Statement: unknown[] }>;
    expect(sentPolicies()).toHaveLength(1);
    expect(policy!.Id).toBe('__default_policy_ID');
    expect(JSON.stringify(policy)).not.toContain('aws:SecureTransport');
  });

  it('S3 create sends nothing, leaving the bucket without a policy', async () => {
    setAwsEndpointOverrideSource(EMULATOR);
    const result = await new S3BucketPolicyProvider().create('P', 'AWS::S3::BucketPolicy', {
      Bucket: 'b',
      PolicyDocument: SSL_ONLY,
    });
    expect(result.physicalId).toBe('b');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('S3 update deletes the bucket policy', async () => {
    setAwsEndpointOverrideSource(EMULATOR);
    const props = { Bucket: 'b', PolicyDocument: SSL_ONLY };
    await new S3BucketPolicyProvider().update('P', 'b', 'AWS::S3::BucketPolicy', props, {
      Bucket: 'b',
      PolicyDocument: DOC,
    });
    expect(sentCommands()).toEqual([{ name: 'DeleteBucketPolicyCommand', input: { Bucket: 'b' } }]);
  });
});
