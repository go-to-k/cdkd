import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4821: a Cloud Control delete of an `AWS::IAM::RolePolicy` /
 * `GroupPolicy` / `UserPolicy` whose (principal, name) another COMPLETED
 * writer of the deploy claims (`context.inlinePolicyClaimed`) issues no
 * `DeleteResource`; every other case deletes, as before.
 */

const mockCloudControlSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

const DOC = { Version: '2012-10-17', Statement: [] };

function sentCommands(): string[] {
  return mockCloudControlSend.mock.calls.map(
    (call) => (call[0] as { constructor: { name: string } }).constructor.name
  );
}

describe('CloudControlProvider leaves a standalone inline policy name another writer took (go-to-k/cdkd#4821)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlSend.mockReset();
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-1' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });
    provider = new CloudControlProvider();
  });

  it.each([
    ['AWS::IAM::RolePolicy', 'RoleName', 'role'],
    ['AWS::IAM::GroupPolicy', 'GroupName', 'group'],
    ['AWS::IAM::UserPolicy', 'UserName', 'user'],
  ])('a claimed %s is not deleted', async (type, field, kind) => {
    const asked: unknown[] = [];
    const result = await provider.delete(
      'Old',
      'y|p',
      type,
      { PolicyName: 'y', [field]: 'p', PolicyDocument: DOC },
      {
        expectedRegion: 'us-east-1',
        inlinePolicyClaimed: (...q) => {
          asked.push(q);
          return true;
        },
      }
    );
    expect(result).toBeUndefined();
    expect(asked).toEqual([[kind, 'p', 'y']]);
    expect(sentCommands()).not.toContain('DeleteResourceCommand');
  });

  it('an unclaimed one is deleted', async () => {
    await provider.delete(
      'Old',
      'y|p',
      'AWS::IAM::RolePolicy',
      { PolicyName: 'y', RoleName: 'p', PolicyDocument: DOC },
      { expectedRegion: 'us-east-1', inlinePolicyClaimed: () => false }
    );
    expect(sentCommands()).toContain('DeleteResourceCommand');
  });

  it('a physical id naming another policy is deleted though the properties are claimed', async () => {
    await provider.delete(
      'Old',
      'z|p',
      'AWS::IAM::RolePolicy',
      { PolicyName: 'y', RoleName: 'p', PolicyDocument: DOC },
      { expectedRegion: 'us-east-1', inlinePolicyClaimed: () => true }
    );
    expect(sentCommands()).toContain('DeleteResourceCommand');
  });

  it('with no predicate (cdkd destroy) it is deleted', async () => {
    await provider.delete(
      'Old',
      'y|p',
      'AWS::IAM::RolePolicy',
      { PolicyName: 'y', RoleName: 'p', PolicyDocument: DOC },
      { expectedRegion: 'us-east-1' }
    );
    expect(sentCommands()).toContain('DeleteResourceCommand');
  });

  it('a redacted principal is deleted without asking (fail toward the delete)', async () => {
    const ask = vi.fn(() => true);
    await provider.delete(
      'Old',
      'y|p',
      'AWS::IAM::RolePolicy',
      { PolicyName: 'y', RoleName: '***', PolicyDocument: DOC },
      { expectedRegion: 'us-east-1', inlinePolicyClaimed: ask }
    );
    expect(ask).not.toHaveBeenCalled();
    expect(sentCommands()).toContain('DeleteResourceCommand');
  });

  it('another type handed a claiming predicate is still deleted', async () => {
    await provider.delete(
      'Old',
      'some-queue-url',
      'AWS::SQS::Queue',
      { QueueName: 'q' },
      { expectedRegion: 'us-east-1', inlinePolicyClaimed: () => true }
    );
    expect(sentCommands()).toContain('DeleteResourceCommand');
  });
});
