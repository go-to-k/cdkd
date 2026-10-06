/**
 * go-to-k/cdkd#4612: the delete of a proven failed create's journal entry
 * (`failedCreateOrphan`) clears each queue its id names only while that
 * queue's live policy is the attempted document. SetQueueAttributes replaces
 * a policy, so any other content is a later writer's: left, and named.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockRegion = vi.fn(() => Promise.resolve('us-east-1'));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => mockRegion() } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  QUEUE_POLICY_MISMATCH_LEFT_REASON,
  QUEUE_POLICY_NOT_COMPARED_LEFT_REASON,
  QUEUE_POLICY_UNREADABLE_SKIP_REASON,
  QUEUE_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON,
  SQSQueuePolicyProvider,
} from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';

const warn = getLogger().child('SQSQueuePolicyProvider').warn as ReturnType<typeof vi.fn>;
const warnings = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');

const TYPE = 'AWS::SQS::QueuePolicy';
const Q1 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-1';
const Q2 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-2';
const Q3 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-3';
const DOC = { Version: '2012-10-17', Statement: [{ Sid: 'Failed', Effect: 'Allow' }] };
// The same document as SQS hands it back: other key order, no whitespace.
const DOC_LIVE = '{"Statement":[{"Effect":"Allow","Sid":"Failed"}],"Version":"2012-10-17"}';
const OTHER = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'LaterWriter' }] });

function routeAws(policies: Record<string, string>): void {
  mockSend.mockImplementation((command: { input: { QueueUrl?: string } }) => {
    if (command instanceof GetQueueAttributesCommand) {
      const policy = policies[command.input.QueueUrl ?? ''];
      if (policy === 'gone') {
        return Promise.reject(Object.assign(new Error('gone'), { name: 'QueueDoesNotExist' }));
      }
      if (policy === 'denied') {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
      }
      return Promise.resolve({ Attributes: policy === undefined ? {} : { Policy: policy } });
    }
    return Promise.resolve({});
  });
}

function cleared(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof SetQueueAttributesCommand)
    .map((c) => (c[0] as SetQueueAttributesCommand).input.QueueUrl);
}

const attempted = { Queues: [Q1, Q2, Q3], PolicyDocument: DOC };
type Ctx = { resolveAttemptedProperties?: () => Promise<Record<string, unknown> | undefined> };
const orphanDelete = (
  id: string,
  props: Record<string, unknown> | undefined = attempted,
  extra: Ctx = {}
) =>
  new SQSQueuePolicyProvider().delete('Failed', id, TYPE, props, {
    expectedRegion: 'us-east-1',
    failedCreateOrphan: true,
    ...extra,
  });

describe('SQSQueuePolicyProvider: a failed create orphan is cleared by content (go-to-k/cdkd#4612)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockReset();
    mockRegion.mockImplementation(() => Promise.resolve('us-east-1'));
    warn.mockClear();
  });

  it('clears each queue still carrying the attempted document, compared canonically', async () => {
    routeAws({ [Q1]: DOC_LIVE, [Q2]: JSON.stringify(DOC) });
    await expect(orphanDelete(`${Q1},${Q2}`)).resolves.toBeUndefined();
    expect(cleared()).toEqual([Q1, Q2]);
    // Only the queues the id names are read: never the attempted list's rest.
    const reads = mockSend.mock.calls
      .filter((c) => c[0] instanceof GetQueueAttributesCommand)
      .map((c) => (c[0] as GetQueueAttributesCommand).input.QueueUrl);
    expect(reads).toEqual([Q1, Q2]);
  });

  it('leaves a queue carrying another policy, naming it without asserting a cause, and reports leftInPlace', async () => {
    routeAws({ [Q1]: OTHER, [Q2]: DOC_LIVE });
    await expect(orphanDelete(`${Q1},${Q2}`)).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: QUEUE_POLICY_MISMATCH_LEFT_REASON,
    });
    expect(cleared()).toEqual([Q2]);
    expect(warnings()).toContain(
      `Queue ${Q1} carries a policy that does not match the document Failed attempted (a later write, or AWS stored it in another form), so it is not cleared; if it still grants what Failed declared, remove it manually.`
    );
  });

  it('a one-queue id names that queue only, never the attempted list', async () => {
    routeAws({ [Q1]: DOC_LIVE, [Q2]: DOC_LIVE, [Q3]: DOC_LIVE });
    await orphanDelete(Q1);
    expect(cleared()).toEqual([Q1]);
  });

  it('a queue that reads back with no policy is cleared anyway (a stale read right after the write)', async () => {
    routeAws({});
    await expect(orphanDelete(`${Q1},${Q2}`)).resolves.toBeUndefined();
    expect(cleared()).toEqual([Q1, Q2]);
    expect(warnings()).toBe('');
  });

  it('a gone queue is left once the client is proven in the recorded region', async () => {
    routeAws({ [Q2]: 'gone' });
    await expect(orphanDelete(Q2)).resolves.toBeUndefined();
    expect(mockRegion).toHaveBeenCalled();
    expect(cleared()).toEqual([]);
  });

  it('a gone queue read through a client in another region is refused, not read as gone', async () => {
    routeAws({ [Q1]: 'gone' });
    mockRegion.mockImplementation(() => Promise.resolve('eu-west-1'));
    await expect(orphanDelete(Q1)).rejects.toThrow(/Refusing to treat NotFound/);
  });

  it('an unreadable queue is left and the delete reports skipped (entry kept); readable ones still clear', async () => {
    routeAws({ [Q1]: 'denied', [Q2]: DOC_LIVE });
    await expect(orphanDelete(`${Q1},${Q2}`)).resolves.toEqual({
      outcome: 'skipped',
      reason: QUEUE_POLICY_UNREADABLE_SKIP_REASON,
    });
    expect(cleared()).toEqual([Q2]);
    expect(warnings()).toContain(`Could not read the policy of queue ${Q1}`);
  });

  it('re-resolves a redacted document before comparing, and clears on a match', async () => {
    routeAws({ [Q1]: DOC_LIVE });
    const redacted = {
      Queues: [Q1],
      PolicyDocument: { ...DOC, Statement: [{ Sid: '{{resolve:secretsmanager:s:SecretString:sid}}', Effect: 'Allow' }] },
    };
    const resolve = vi.fn(async () => attempted);
    await expect(orphanDelete(Q1, redacted, { resolveAttemptedProperties: resolve })).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledOnce();
    expect(cleared()).toEqual([Q1]);
  });

  it.each([
    ['throttling', Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })],
    ['expired credentials', Object.assign(new Error('expired'), { name: 'ExpiredTokenException' })],
    ['access denied', Object.assign(new Error('denied'), { name: 'AccessDeniedException' })],
    ['a KMS failure', Object.assign(new Error('kms'), { name: 'KMSAccessDeniedException' })],
    ['an unnamed error', new Error('something else')],
    ['an ambiguous region', Object.assign(new Error('refused'), { name: 'CdkdError', code: 'ROLLBACK_SECRET_REGION_AMBIGUOUS' })],
  ])('a resolution failure not known to be permanent (%s) is skipped before any read (entry kept)', async (_what, error) => {
    routeAws({ [Q1]: DOC_LIVE });
    const resolve = vi.fn(async () => {
      throw error;
    });
    await expect(orphanDelete(Q1, attempted, { resolveAttemptedProperties: resolve })).resolves.toEqual({
      outcome: 'skipped',
      reason: QUEUE_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
    // The error's NAME only, never its message.
    expect(warnings()).toContain(`could not be resolved (${error.name})`);
    expect(warnings()).not.toContain(error.message);
    // No manual way out is offered: removing the journal drops every other entry.
    expect(warnings()).not.toContain('rollback-journal.json');
  });

  it.each([
    ['secret not found', Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })],
    ['parameter not found', Object.assign(new Error('not found'), { name: 'ParameterNotFound' })],
    ['the resolver refusing a value', new Error("Dynamic reference: secret 's' does not contain a SecretString value")],
    ['a token-scan refusal', Object.assign(new Error('refused'), { name: 'CdkdError', code: 'ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH' })],
    ['a wrapped not-found', Object.assign(new Error('wrap'), { cause: Object.assign(new Error('nf'), { name: 'ParameterNotFound' }) })],
  ])('a resolution failure known to be permanent (%s) settles the entry: nothing cleared, every queue named', async (_what, error) => {
    routeAws({ [Q1]: DOC_LIVE, [Q2]: DOC_LIVE });
    const resolve = vi.fn(async () => {
      throw error;
    });
    await expect(orphanDelete(`${Q1},${Q2}`, attempted, { resolveAttemptedProperties: resolve })).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: QUEUE_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toContain('a secret it references does not exist or cannot be used');
    expect(warnings()).toContain(`${Q1}, ${Q2}.`);
  });

  it('a live policy SQS stored in an IAM-equivalent spelling still matches and is cleared', async () => {
    const written = {
      Version: '2012-10-17',
      Statement: { Sid: 'Raw', Effect: 'Allow', Principal: { AWS: '123456789012' }, Action: ['sqs:SendMessage'], Resource: 'arn:aws:sqs:us-east-1:123456789012:queue-1' },
    };
    const stored = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Sid: 'Raw', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:root' }, Action: 'sqs:SendMessage', Resource: ['arn:aws:sqs:us-east-1:123456789012:queue-1'] }],
    });
    routeAws({ [Q1]: stored });
    await expect(orphanDelete(Q1, { PolicyDocument: written })).resolves.toBeUndefined();
    expect(cleared()).toEqual([Q1]);
  });

  it.each([
    ['a reference', '{{resolve:ssm-secure:p}}'],
    ['the state mask', '***'],
  ])('a document still holding %s settles the entry with nothing cleared', async (_what, leaf) => {
    routeAws({ [Q1]: DOC_LIVE });
    const bag = { Queues: [Q1], PolicyDocument: { ...DOC, Statement: [{ Sid: leaf }] } };
    await expect(orphanDelete(Q1, bag)).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: QUEUE_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    // A string document is read as JSON too.
    await expect(orphanDelete(Q1, { PolicyDocument: JSON.stringify(bag.PolicyDocument) })).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: QUEUE_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toContain('its policy document still holds a secret reference or masked value');
  });

  it.each([
    ['no PolicyDocument', { Queues: [Q1] }],
    ['an empty string document', { PolicyDocument: '' }],
    ['no bag at all', undefined],
  ])('%s settles the entry with nothing cleared, never reported a plain delete', async (_what, bag) => {
    routeAws({ [Q1]: DOC_LIVE });
    const result = new SQSQueuePolicyProvider().delete('Failed', Q1, TYPE, bag, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    await expect(result).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: QUEUE_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toContain('no policy document it attempted is recorded');
  });

  it('a queue a QueuePolicy of this deploy wrote is left unread, warned, and reported leftInPlace', async () => {
    routeAws({ [Q1]: DOC_LIVE, [Q2]: DOC_LIVE });
    const result = new SQSQueuePolicyProvider().delete('Failed', `${Q1},${Q2}`, TYPE, attempted, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
      writtenThisRun: [
        // Holds Q1 through its written set only.
        { resourceType: TYPE, physicalId: Q3, attributes: { 'cdkd:WrittenQueues': `${Q3},${Q1}` } },
        // Another type naming Q2 (the queue's own record) does not count.
        { resourceType: 'AWS::SQS::Queue', physicalId: Q2, attributes: {} },
      ],
    });
    await expect(result).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: QUEUE_POLICY_MISMATCH_LEFT_REASON,
    });
    expect(cleared()).toEqual([Q2]);
    const reads = mockSend.mock.calls
      .filter((c) => c[0] instanceof GetQueueAttributesCommand)
      .map((c) => (c[0] as GetQueueAttributesCommand).input.QueueUrl);
    expect(reads).toEqual([Q2]);
    expect(warnings()).toContain(`Queue ${Q1} was written by a QueuePolicy of this deploy, so it is not cleared`);
  });

  it('a queue this deploy listed in Queues counts too', async () => {
    routeAws({ [Q1]: DOC_LIVE });
    const result = new SQSQueuePolicyProvider().delete('Failed', Q1, TYPE, attempted, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
      writtenThisRun: [{ resourceType: TYPE, physicalId: Q3, attributes: {}, properties: { Queues: [Q3, Q1] } }],
    });
    await expect(result).resolves.toEqual({ outcome: 'deleted', leftInPlace: QUEUE_POLICY_MISMATCH_LEFT_REASON });
    expect(cleared()).toEqual([]);
  });

  it('a failed clear is thrown as a ProvisioningError naming the entry', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof GetQueueAttributesCommand) {
        return Promise.resolve({ Attributes: { Policy: DOC_LIVE } });
      }
      return Promise.reject(Object.assign(new Error('throttled'), { name: 'Throttling' }));
    });
    const err = await orphanDelete(Q1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toBe('Failed to delete SQS queue policy Failed: throttled');
    expect((err as ProvisioningError).physicalId).toBe(Q1);
  });

  it('an id naming no queue is refused before any call', async () => {
    routeAws({});
    await expect(orphanDelete(',')).rejects.toThrow(ProvisioningError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("control: without the flag a comma-joined id is cleared by name, as a record's delete", async () => {
    routeAws({ [Q1]: OTHER, [Q2]: OTHER });
    await new SQSQueuePolicyProvider().delete('Failed', `${Q1},${Q2}`, TYPE, attempted, {
      expectedRegion: 'us-east-1',
    });
    expect(cleared()).toEqual([Q1, Q2]);
  });
});
