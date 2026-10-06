/**
 * go-to-k/cdkd#4612, the TopicPolicy half: the delete of a proven failed
 * create's journal entry (`failedCreateOrphan`) resets each topic its id
 * names to the default policy only while that topic's live policy is the
 * attempted document. SetTopicAttributes replaces a policy, so any other
 * content (bar the default itself) is left, named, and reported.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetTopicAttributesCommand, SetTopicAttributesCommand } from '@aws-sdk/client-sns';

const mockSend = vi.fn();
const mockRegion = vi.fn(() => Promise.resolve('us-east-1'));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => mockRegion() } },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  SNSTopicPolicyProvider,
  TOPIC_POLICY_MISMATCH_LEFT_REASON,
  TOPIC_POLICY_NOT_COMPARED_LEFT_REASON,
  TOPIC_POLICY_UNREADABLE_SKIP_REASON,
  TOPIC_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON,
  defaultTopicPolicy,
} from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::SNS::TopicPolicy';
const T1 = 'arn:aws:sns:us-east-1:123456789012:topic-1';
const T2 = 'arn:aws:sns:us-east-1:123456789012:topic-2';
const T3 = 'arn:aws:sns:us-east-1:123456789012:topic-3';
const DOC = { Version: '2012-10-17', Statement: [{ Sid: 'Failed', Effect: 'Allow' }] };
const DOC_LIVE = '{"Statement":[{"Effect":"Allow","Sid":"Failed"}],"Version":"2012-10-17"}';
const OTHER = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'LaterWriter' }] });
const warnings = (): string => childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');

function routeSend(policies: Record<string, string | Error | undefined>, setError?: Error): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetTopicAttributesCommand) {
      const p = policies[cmd.input.TopicArn!];
      if (p instanceof Error) return Promise.reject(p);
      return Promise.resolve({ Attributes: p === undefined ? {} : { Policy: p } });
    }
    return setError ? Promise.reject(setError) : Promise.resolve({});
  });
}

const named = (name: string): Error => Object.assign(new Error(name), { name });

function sets(): Array<[string, string]> {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((cmd): cmd is SetTopicAttributesCommand => cmd instanceof SetTopicAttributesCommand)
    .map((cmd) => [cmd.input.TopicArn!, cmd.input.AttributeValue!]);
}

function reads(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((cmd): cmd is GetTopicAttributesCommand => cmd instanceof GetTopicAttributesCommand)
    .map((cmd) => cmd.input.TopicArn!);
}

const attempted = { Topics: [T1, T2, T3], PolicyDocument: DOC };
const del = (id: string, bag: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  new SNSTopicPolicyProvider().delete('Failed', id, TYPE, bag, {
    expectedRegion: 'us-east-1',
    failedCreateOrphan: true,
    ...extra,
  });

describe('SNSTopicPolicyProvider: a failed create orphan is reset by content (go-to-k/cdkd#4612)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockReset();
    mockRegion.mockImplementation(() => Promise.resolve('us-east-1'));
    childLogger.warn.mockClear();
  });

  it('resets each topic still carrying the attempted document to its default, compared canonically', async () => {
    routeSend({ [T1]: DOC_LIVE, [T2]: JSON.stringify(DOC) });
    await expect(del(`${T1},${T2}`, attempted)).resolves.toBeUndefined();
    expect(sets()).toEqual([
      [T1, defaultTopicPolicy(T1)!],
      [T2, defaultTopicPolicy(T2)!],
    ]);
    expect(reads()).toEqual([T1, T2]);
  });

  it('leaves a topic carrying another policy, warning without a cause, and reports leftInPlace', async () => {
    routeSend({ [T1]: OTHER, [T2]: DOC_LIVE });
    await expect(del(`${T1},${T2}`, attempted)).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: TOPIC_POLICY_MISMATCH_LEFT_REASON,
    });
    expect(sets().map(([t]) => t)).toEqual([T2]);
    expect(warnings()).toContain(
      `Topic ${T1} carries a policy that does not match the document Failed attempted (a later write, or AWS stored it in another form), so it is not reset; if it still grants what Failed declared, reset it manually.`
    );
  });

  it('a topic already on its default policy is left silently', async () => {
    routeSend({ [T1]: defaultTopicPolicy(T1)! });
    await expect(del(T1, attempted)).resolves.toBeUndefined();
    expect(sets()).toEqual([]);
    expect(warnings()).toBe('');
  });

  it('a one-topic id names that topic only, never the attempted list', async () => {
    routeSend({ [T1]: DOC_LIVE, [T2]: DOC_LIVE, [T3]: DOC_LIVE });
    await del(T1, attempted);
    expect(reads()).toEqual([T1]);
    expect(sets().map(([t]) => t)).toEqual([T1]);
  });

  it('a gone topic is left once the client is proven in the recorded region', async () => {
    routeSend({ [T1]: named('NotFoundException') });
    await expect(del(T1, attempted)).resolves.toBeUndefined();
    expect(mockRegion).toHaveBeenCalled();
    expect(sets()).toEqual([]);
  });

  it('a gone topic read through a client in another region is refused', async () => {
    routeSend({ [T1]: named('NotFound') });
    mockRegion.mockImplementation(() => Promise.resolve('eu-west-1'));
    await expect(del(T1, attempted)).rejects.toThrow(/Refusing to treat NotFound/);
  });

  it('an unreadable topic is left and the delete reports skipped; readable ones still reset', async () => {
    routeSend({ [T1]: named('AuthorizationError'), [T2]: DOC_LIVE });
    await expect(del(`${T1},${T2}`, attempted)).resolves.toEqual({
      outcome: 'skipped',
      reason: TOPIC_POLICY_UNREADABLE_SKIP_REASON,
    });
    expect(sets().map(([t]) => t)).toEqual([T2]);
    expect(warnings()).toContain(`Could not read the policy of topic ${T1}`);
  });

  it('re-resolves a redacted document before comparing', async () => {
    routeSend({ [T1]: DOC_LIVE });
    const resolve = vi.fn(async () => attempted);
    const redacted = { Topics: [T1], PolicyDocument: { Statement: [{ Sid: '{{resolve:ssm-secure:p}}' }] } };
    await expect(del(T1, redacted, { resolveAttemptedProperties: resolve })).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledOnce();
    expect(sets().map(([t]) => t)).toEqual([T1]);
  });

  it.each([
    ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', name: 'Error' })],
    ['expired credentials', named('ExpiredTokenException')],
    ['access denied', named('AccessDeniedException')],
  ])('a resolution failure not known to be permanent (%s) is skipped before any call (entry kept)', async (_what, error) => {
    routeSend({ [T1]: DOC_LIVE });
    const resolve = vi.fn(async () => {
      throw error;
    });
    await expect(del(T1, attempted, { resolveAttemptedProperties: resolve })).resolves.toEqual({
      outcome: 'skipped',
      reason: TOPIC_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toContain(`could not be resolved (${error.name})`);
  });

  it.each([
    ['secret not found', named('ResourceNotFoundException')],
    ['a token-scan refusal', Object.assign(new Error('refused'), { code: 'ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH' })],
  ])('a resolution failure known to be permanent (%s) settles the entry: nothing reset, every topic named', async (_what, error) => {
    routeSend({ [T1]: DOC_LIVE, [T2]: DOC_LIVE });
    const resolve = vi.fn(async () => {
      throw error;
    });
    await expect(del(`${T1},${T2}`, attempted, { resolveAttemptedProperties: resolve })).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: TOPIC_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toContain(`${T1}, ${T2}.`);
  });

  it('a live policy in an IAM-equivalent spelling still matches and is reset', async () => {
    const written = { Statement: [{ Sid: 'Raw', Principal: { AWS: ['123456789012'] }, Action: 'sns:Publish' }] };
    const stored = JSON.stringify({ Statement: [{ Sid: 'Raw', Principal: { AWS: 'arn:aws:iam::123456789012:root' }, Action: ['sns:Publish'] }] });
    routeSend({ [T1]: stored });
    await expect(del(T1, { PolicyDocument: written })).resolves.toBeUndefined();
    expect(sets().map(([t]) => t)).toEqual([T1]);
  });

  it.each([
    ['a reference', '{{resolve:secretsmanager:s}}'],
    ['the state mask', '***'],
  ])('a document still holding %s settles the entry with nothing reset', async (_what, leaf) => {
    routeSend({ [T1]: DOC_LIVE });
    await expect(del(T1, { PolicyDocument: { Statement: [{ Sid: leaf }] } })).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: TOPIC_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['no PolicyDocument', { Topics: [T1] }],
    ['an empty string document', { PolicyDocument: '' }],
    ['no bag at all', undefined],
  ])('%s settles the entry with nothing reset', async (_what, bag) => {
    routeSend({ [T1]: DOC_LIVE });
    await expect(del(T1, bag)).resolves.toEqual({
      outcome: 'deleted',
      leftInPlace: TOPIC_POLICY_NOT_COMPARED_LEFT_REASON,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a topic that reads back with no policy is reset anyway (a stale read right after the write)', async () => {
    routeSend({});
    await expect(del(T1, attempted)).resolves.toBeUndefined();
    expect(sets()).toEqual([[T1, defaultTopicPolicy(T1)!]]);
  });

  it('a topic a TopicPolicy of this deploy wrote is left unread, warned, and reported', async () => {
    routeSend({ [T1]: DOC_LIVE, [T2]: DOC_LIVE });
    const result = del(`${T1},${T2}`, attempted, {
      writtenThisRun: [
        { resourceType: TYPE, physicalId: `${T3},${T1}`, properties: {} },
        { resourceType: 'AWS::SNS::Topic', physicalId: T2, properties: {} },
      ],
    });
    await expect(result).resolves.toEqual({ outcome: 'deleted', leftInPlace: TOPIC_POLICY_MISMATCH_LEFT_REASON });
    expect(reads()).toEqual([T2]);
    expect(sets().map(([t]) => t)).toEqual([T2]);
    expect(warnings()).toContain(`Topic ${T1} was written by a TopicPolicy of this deploy, so it is not reset`);
  });

  it('a topic this deploy listed in Topics counts too', async () => {
    routeSend({ [T1]: DOC_LIVE });
    await expect(
      del(T1, attempted, { writtenThisRun: [{ resourceType: TYPE, physicalId: 'policy-name', properties: { Topics: [T1] } }] })
    ).resolves.toEqual({ outcome: 'deleted', leftInPlace: TOPIC_POLICY_MISMATCH_LEFT_REASON });
    expect(sets()).toEqual([]);
  });

  it('a failed reset is thrown as a ProvisioningError naming the entry', async () => {
    routeSend({ [T1]: DOC_LIVE }, named('Throttled'));
    const err = await del(T1, attempted).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toBe('Failed to delete SNS topic policy Failed: Throttled');
    expect((err as ProvisioningError).physicalId).toBe(T1);
  });

  it('an id naming no topic is refused before any call, non-retryable', async () => {
    routeSend({});
    const err = await del(',', attempted).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("control: without the flag the id's topics are reset by name, as a record's delete", async () => {
    routeSend({ [T1]: OTHER, [T2]: OTHER });
    await new SNSTopicPolicyProvider().delete('Failed', `${T1},${T2}`, TYPE, attempted, {
      expectedRegion: 'us-east-1',
    });
    expect(sets().map(([t]) => t)).toEqual([T1, T2]);
  });
});
